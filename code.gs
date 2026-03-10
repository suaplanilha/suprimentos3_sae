/**
 * SAE - Suprimentos Engine v2.5
 * Core de processamento de dados para Google Sheets
 */

const APP_ID = typeof __app_id !== 'undefined' ? __app_id : 'suprimentos-sae';
const ALLOW_NEGATIVE_STOCK = false;
const APP_TIMEZONE = Session.getScriptTimeZone() || 'America/Sao_Paulo';
const AUDIT_SHEET_NAME = 'logs_execucao';
const STAGING_SHEET_NAME = 'staging_movimentacao';

const REQUIRED_HEADERS = {
  insumos: ['uuid', 'codigo_ax', 'descricao', 'ponto_ressuprimento'],
  estoque_snapshot: ['uuid', 'insumo_id', 'codigo_ax', 'quantidade_atual', 'tipo_contexto', 'origem_lancamento', 'snapshot_anterior_id', 'status_apuracao', 'criado_em'],
  movimentacao_apurada: ['uuid', 'codigo_ax', 'tipo_movimento', 'quantidade_movimento', 'criado_em'],
  historico_posicao_estoque_mensal: ['uuid', 'insumo_id', 'codigo_ax', 'competencia', 'quantidade_posicao', 'tipo_registro', 'origem', 'observacao', 'criado_em']
};

function doGet() {
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('SAP Suprimentos Pro')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function getDashboardData() {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    _assertSchema(ss);

    const sheetInsumos = ss.getSheetByName('insumos');
    const sheetSnapshot = ss.getSheetByName('estoque_snapshot');
    const sheetMov = ss.getSheetByName('movimentacao_apurada');
    const sheetHist = ss.getSheetByName('historico_posicao_estoque_mensal');

    const insumosRaw = _readSheet(sheetInsumos);
    const movRaw = _readSheet(sheetMov);
    const snapRaw = _readSheet(sheetSnapshot);
    const histRaw = _readSheet(sheetHist);

    const insumosByCodigo = {};
    insumosRaw.forEach(i => { insumosByCodigo[String(i.codigo_ax)] = i; });

    const snapshotsAtuais = _getLatestSnapshotsByCodigo(snapRaw);
    const mediasSaida = _calcularMediasSaidaAvancada(movRaw, histRaw);
    const criticidade = _classificarCriticidade(insumosRaw, mediasSaida);

    const projesp = insumosRaw.map(ins => {
      const codigo = String(ins.codigo_ax);
      const snapshotAtual = snapshotsAtuais[codigo];
      const saldo = snapshotAtual ? parseFloat(snapshotAtual.quantidade_atual || 0) : 0;
      const media = mediasSaida[codigo] || _defaultMediaLayer_();

      const leadTime = parseFloat(ins.lead_time_dias || 15);
      const estoqueSeguranca = parseFloat(ins.estoque_seguranca || (media.diaria30 * 7));
      const pontoPedidoDinamico = Math.ceil((media.diaria90 * leadTime) + estoqueSeguranca);
      const loteEconomico = _calcularLoteEconomico(ins, media);

      const mediaUsada = media.diaria30 > 0 ? media.diaria30 : media.diaria90;
      const diasCobertura = mediaUsada > 0 ? Math.floor(saldo / mediaUsada) : 999;

      const dataPrevista = new Date();
      dataPrevista.setDate(dataPrevista.getDate() + (diasCobertura > 365 ? 365 : diasCobertura));

      return {
        uuid: ins.uuid,
        codigo_ax: codigo,
        descricao: ins.descricao,
        saldo: saldo,
        media_dia: mediaUsada.toFixed(2),
        media_30_dias: media.diaria30.toFixed(2),
        media_90_dias: media.diaria90.toFixed(2),
        yoy_percent: media.yoyPercent,
        dias: diasCobertura,
        data_prevista: diasCobertura === 999 ? 'Estável' : dataPrevista.toLocaleDateString('pt-BR'),
        ponto: parseFloat(ins.ponto_ressuprimento || 0),
        ponto_pedido_dinamico: pontoPedidoDinamico,
        estoque_seguranca: Math.ceil(estoqueSeguranca),
        lead_time_dias: leadTime,
        lote_economico: loteEconomico,
        classe_abc: criticidade[codigo]?.classeABC || 'C',
        risco_ruptura: criticidade[codigo]?.riscoRuptura || 'BAIXO'
      };
    });

    return {
      insumos: insumosRaw,
      projesp: projesp,
      movimentacoes: _formatarMovimentacoes(movRaw, snapshotsAtuais, insumosByCodigo).slice(0, 20),
      historico: _formatarHistorico(histRaw, insumosByCodigo),
      tendencias: _calcularTendenciasMultiAno(histRaw, insumosByCodigo),
      alertas: _gerarAlertas(projesp, 15),
      stats: _calcularStatsGerais(projesp)
    };
  } catch (e) {
    _logEvent('ERROR', 'getDashboardData', { error: e.toString() });
    return { error: e.toString() };
  }
}

function registrarSaida(codigo_ax, quantidade) {
  return _runWithDocumentLock_('registrarSaida', function () {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    _assertSchema(ss);
    return _registrarSaidaSemLock_(ss, codigo_ax, quantidade, 'FECHAMENTO_DIARIO', 'WEBAPP', 'Lançamento via App');
  });
}

function processBulkInsert(payload) {
  return _runWithDocumentLock_('processBulkInsert', function () {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    _assertSchema(ss);

    const rows = Array.isArray(payload) ? payload : [];
    const staging = _getOrCreateStagingSheet_(ss);
    const insumos = _readSheet(ss.getSheetByName('insumos'));
    const codigosValidos = new Set(insumos.map(i => String(i.codigo_ax)));

    let inserted = 0;
    const rejeicoes = [];
    const stageRows = [];

    rows.forEach((r, idx) => {
      const codigo = String(r.codigo_ax || '').trim();
      const qtd = parseFloat(r.quantidade);
      let status = 'VALIDADO';
      let motivo = '';

      if (!codigo) {
        status = 'REJEITADO';
        motivo = 'Código AX ausente';
      } else if (!codigosValidos.has(codigo)) {
        status = 'REJEITADO';
        motivo = 'Insumo inexistente';
      } else if (!Number.isFinite(qtd) || qtd <= 0) {
        status = 'REJEITADO';
        motivo = 'Quantidade inválida';
      }

      stageRows.push([
        Utilities.getUuid(),
        new Date().toISOString(),
        codigo,
        Number.isFinite(qtd) ? qtd : '',
        status,
        motivo,
        Session.getActiveUser().getEmail()
      ]);

      if (status === 'REJEITADO') {
        rejeicoes.push({ linha: idx + 1, codigo_ax: codigo, motivo: motivo });
        return;
      }

      try {
        _registrarSaidaSemLock_(ss, codigo, qtd, 'FECHAMENTO_DIARIO', 'WEBAPP_BULK', 'Carga em massa');
        inserted++;
      } catch (e) {
        rejeicoes.push({ linha: idx + 1, codigo_ax: codigo, motivo: e.toString() });
      }
    });

    if (stageRows.length > 0) {
      staging.getRange(staging.getLastRow() + 1, 1, stageRows.length, stageRows[0].length).setValues(stageRows);
    }

    const result = {
      success: true,
      totalRecebido: rows.length,
      totalInserido: inserted,
      totalRejeitado: rejeicoes.length,
      rejeicoes: rejeicoes
    };

    _logEvent('INFO', 'processBulkInsert', result);
    return result;
  });
}

function executarFechamentoDiario() {
  return _runWithDocumentLock_('executarFechamentoDiario', function () {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    _assertSchema(ss);

    const sheetSnap = ss.getSheetByName('estoque_snapshot');
    const sheetHist = ss.getSheetByName('historico_posicao_estoque_mensal');

    const snapshots = _readSheet(sheetSnap);
    const pendentes = snapshots.filter(s => String(s.status_apuracao || '').toUpperCase() === 'PENDENTE_APURACAO');

    if (pendentes.length === 0) {
      _logEvent('INFO', 'executarFechamentoDiario', { mensagem: 'Nenhum snapshot pendente para apuração.' });
      return { success: true, processados: 0, mensagem: 'Sem pendências para apuração.' };
    }

    const snapshotsMaisRecentes = _getLatestSnapshotsByCodigo(pendentes);
    const competencia = Utilities.formatDate(new Date(), APP_TIMEZONE, 'yyyy-MM-01');

    const histRows = Object.keys(snapshotsMaisRecentes).map(codigo => {
      const snap = snapshotsMaisRecentes[codigo];
      return [
        Utilities.getUuid(),
        snap.insumo_id || '',
        codigo,
        competencia,
        parseFloat(snap.quantidade_atual || 0),
        'FECHAMENTO_DIARIO',
        'webapp',
        'Consolidado automaticamente no fechamento diário.',
        new Date().toISOString()
      ];
    });

    if (histRows.length > 0) {
      sheetHist.getRange(sheetHist.getLastRow() + 1, 1, histRows.length, histRows[0].length).setValues(histRows);
    }

    _atualizarStatusApuracaoSnapshots_(sheetSnap, snapshots, 'PENDENTE_APURACAO', 'APURADO');

    const result = {
      success: true,
      processados: pendentes.length,
      codigosConsolidados: Object.keys(snapshotsMaisRecentes).length,
      competencia: competencia
    };

    _logEvent('INFO', 'executarFechamentoDiario', result);
    return result;
  });
}

function instalarGatilhoFechamentoDiario() {
  const funcName = 'executarFechamentoDiario';
  const triggers = ScriptApp.getProjectTriggers();
  const jaExiste = triggers.some(t => t.getHandlerFunction() === funcName);

  if (!jaExiste) {
    ScriptApp.newTrigger(funcName).timeBased().everyDays(1).atHour(23).create();
    _logEvent('INFO', 'instalarGatilhoFechamentoDiario', { trigger: funcName, status: 'CRIADO' });
  } else {
    _logEvent('INFO', 'instalarGatilhoFechamentoDiario', { trigger: funcName, status: 'JA_EXISTE' });
  }

  return { success: true, trigger: funcName, jaExiste: jaExiste };
}

function removerGatilhoFechamentoDiario() {
  const funcName = 'executarFechamentoDiario';
  let removidos = 0;

  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === funcName) {
      ScriptApp.deleteTrigger(t);
      removidos++;
    }
  });

  _logEvent('INFO', 'removerGatilhoFechamentoDiario', { trigger: funcName, removidos: removidos });
  return { success: true, removidos: removidos };
}

function enviarAlertasAutomaticos(diasLimite, emailsCsv, webhookUrl) {
  return _runWithDocumentLock_('enviarAlertasAutomaticos', function () {
    const data = getDashboardData();
    if (data.error) throw new Error(data.error);

    const limite = Number.isFinite(parseFloat(diasLimite)) ? parseFloat(diasLimite) : 15;
    const alertas = _gerarAlertas(data.projesp || [], limite);

    if (alertas.length === 0) {
      _logEvent('INFO', 'enviarAlertasAutomaticos', { mensagem: 'Sem alertas para enviar.', limite: limite });
      return { success: true, enviados: 0, mensagem: 'Sem alertas para enviar.' };
    }

    const assunto = `[SAP SUP] Alertas de ressuprimento (${alertas.length})`;
    const corpo = alertas
      .map(a => `- ${a.codigo_ax} | ${a.descricao} | Dias: ${a.dias} | Saldo: ${a.saldo} | Ponto dinâmico: ${a.ponto_pedido_dinamico}`)
      .join('\n');

    const emails = String(emailsCsv || '').split(',').map(e => e.trim()).filter(Boolean);
    emails.forEach(email => MailApp.sendEmail(email, assunto, corpo));

    if (webhookUrl) {
      UrlFetchApp.fetch(webhookUrl, {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify({ text: `${assunto}\n${corpo}` }),
        muteHttpExceptions: true
      });
    }

    _logEvent('INFO', 'enviarAlertasAutomaticos', {
      limite: limite,
      alertas: alertas.length,
      emails: emails.length,
      webhook: !!webhookUrl
    });

    return { success: true, enviados: alertas.length, destinatarios: emails.length };
  });
}

// Governança
function _assertSchema(ss) {
  Object.keys(REQUIRED_HEADERS).forEach(sheetName => {
    _assertSheetHeaders_(ss, sheetName, REQUIRED_HEADERS[sheetName]);
  });
}

function _assertSheetHeaders_(ss, sheetName, requiredHeaders) {
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) throw new Error(`A aba obrigatória '${sheetName}' não foi encontrada.`);

  const lastColumn = Math.max(sheet.getLastColumn(), requiredHeaders.length);
  const headers = sheet.getRange(1, 1, 1, lastColumn).getValues()[0]
    .map(v => String(v || '').trim())
    .filter(Boolean);

  const missing = requiredHeaders.filter(h => headers.indexOf(h) === -1);
  if (missing.length > 0) {
    throw new Error(`A aba '${sheetName}' está sem colunas obrigatórias: ${missing.join(', ')}.`);
  }
}

function _runWithDocumentLock_(context, fn) {
  const lock = LockService.getDocumentLock();
  try {
    lock.waitLock(30000);
    return fn();
  } catch (e) {
    _logEvent('ERROR', context, { error: e.toString() });
    throw e;
  } finally {
    try {
      lock.releaseLock();
    } catch (e) {
      _logEvent('ERROR', `${context}.releaseLock`, { error: e.toString() });
    }
  }
}

function _logEvent(level, context, payload) {
  const record = {
    timestamp: new Date().toISOString(),
    app_id: APP_ID,
    level: level,
    context: context,
    user: Session.getActiveUser().getEmail() || 'desconhecido',
    payload: payload || {}
  };

  console.log(JSON.stringify(record));

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = _getOrCreateAuditSheet_(ss);
    sheet.appendRow([
      Utilities.getUuid(),
      record.context,
      record.level,
      JSON.stringify({ app_id: record.app_id, payload: record.payload }),
      record.user,
      record.timestamp
    ]);
  } catch (e) {
    console.error(`Falha ao persistir log em planilha: ${e}`);
  }
}

function _getOrCreateAuditSheet_(ss) {
  let sheet = ss.getSheetByName(AUDIT_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(AUDIT_SHEET_NAME);
    sheet.appendRow(['uuid', 'processo', 'status', 'detalhes', 'executado_por', 'executado_em']);
  }
  return sheet;
}

function _getOrCreateStagingSheet_(ss) {
  let sheet = ss.getSheetByName(STAGING_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(STAGING_SHEET_NAME);
    sheet.appendRow(['uuid', 'criado_em', 'codigo_ax', 'quantidade', 'status', 'motivo', 'usuario_email']);
  }
  return sheet;
}

function _registrarSaidaSemLock_(ss, codigo_ax, quantidade, origemTipo, origemCanal, observacao) {
  const sheetSnap = ss.getSheetByName('estoque_snapshot');
  const sheetInsumos = ss.getSheetByName('insumos');

  const codigo = String(codigo_ax || '').trim();
  const qtd = parseFloat(quantidade);

  if (!codigo) throw new Error('Código AX é obrigatório.');
  if (!Number.isFinite(qtd) || qtd <= 0) throw new Error('Quantidade deve ser numérica e maior que zero.');

  const insumos = _readSheet(sheetInsumos);
  const item = insumos.find(i => String(i.codigo_ax) === codigo);
  if (!item) throw new Error('Insumo não encontrado.');

  const snaps = _readSheet(sheetSnap);
  const ultimoSnap = _getLatestSnapshotsByCodigo(snaps)[codigo] || null;
  const saldoAnterior = ultimoSnap ? parseFloat(ultimoSnap.quantidade_atual || 0) : 0;
  const novoSaldo = saldoAnterior - qtd;

  if (!ALLOW_NEGATIVE_STOCK && novoSaldo < 0) {
    throw new Error(`Saldo insuficiente para saída. Saldo atual: ${saldoAnterior}.`);
  }

  sheetSnap.appendRow([
    Utilities.getUuid(),
    item.uuid,
    codigo,
    novoSaldo,
    new Date().toISOString(),
    new Date().toISOString().split('T')[0],
    origemTipo,
    origemCanal,
    Session.getActiveUser().getEmail(),
    observacao || '',
    ultimoSnap ? ultimoSnap.uuid : '',
    'PENDENTE_APURACAO',
    new Date().toISOString()
  ]);

  return {
    success: true,
    message: `Saída de ${qtd} registrada com sucesso para o código ${codigo}.`,
    novoSaldo: novoSaldo
  };
}

function _atualizarStatusApuracaoSnapshots_(sheetSnap, snapshots, statusOrigem, statusDestino) {
  if (snapshots.length === 0) return 0;

  const range = sheetSnap.getDataRange();
  const values = range.getValues();
  const headers = values[0].map(h => String(h || '').trim());
  const idxStatus = headers.indexOf('status_apuracao');
  const idxCreated = headers.indexOf('criado_em');
  if (idxStatus === -1) throw new Error('Aba estoque_snapshot sem coluna status_apuracao.');

  let atualizados = 0;
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][idxStatus] || '').toUpperCase() === statusOrigem) {
      values[i][idxStatus] = statusDestino;
      if (idxCreated !== -1) values[i][idxCreated] = values[i][idxCreated] || new Date().toISOString();
      atualizados++;
    }
  }

  if (atualizados > 0) range.setValues(values);
  return atualizados;
}

// Processamento analítico
function _readSheet(sheet) {
  if (!sheet) return [];
  const data = sheet.getDataRange().getValues();
  if (!data || data.length === 0) return [];

  const headers = data.shift();
  if (!headers || headers.length === 0) return [];

  return data.map(row => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = row[i]; });
    return obj;
  });
}

function _getLatestSnapshotsByCodigo(snaps) {
  const latest = {};
  snaps.forEach(s => {
    const codigo = String(s.codigo_ax || '').trim();
    if (!codigo) return;
    if (!latest[codigo] || _isSnapshotMaisRecente(s, latest[codigo])) latest[codigo] = s;
  });
  return latest;
}

function _isSnapshotMaisRecente(a, b) {
  const dataA = new Date(a.data_hora_lancamento_iso || a.criado_em || 0).getTime() || 0;
  const dataB = new Date(b.data_hora_lancamento_iso || b.criado_em || 0).getTime() || 0;
  if (dataA !== dataB) return dataA > dataB;
  return String(a.uuid || '') > String(b.uuid || '');
}

function _defaultMediaLayer_() {
  return { diaria30: 0, diaria90: 0, mensal30: 0, mensal90: 0, yoyPercent: 0 };
}

function _calcularMediasSaidaAvancada(movs, hist) {
  const medias = {};
  const now = new Date();
  const d30 = now.getTime() - (30 * 24 * 60 * 60 * 1000);
  const d90 = now.getTime() - (90 * 24 * 60 * 60 * 1000);

  movs.forEach(m => {
    if (String(m.tipo_movimento || '').toUpperCase() !== 'SAIDA') return;
    const codigo = String(m.codigo_ax || '').trim();
    if (!codigo) return;
    const ts = new Date(m.criado_em || m.data_movimento || 0).getTime();
    if (!ts) return;

    if (!medias[codigo]) medias[codigo] = { total30: 0, total90: 0 };
    const qtd = parseFloat(m.quantidade_movimento || 0);
    if (ts >= d30) medias[codigo].total30 += qtd;
    if (ts >= d90) medias[codigo].total90 += qtd;
  });

  Object.keys(medias).forEach(codigo => {
    medias[codigo].diaria30 = medias[codigo].total30 / 30;
    medias[codigo].diaria90 = medias[codigo].total90 / 90;
    medias[codigo].mensal30 = medias[codigo].total30;
    medias[codigo].mensal90 = medias[codigo].total90 / 3;
    medias[codigo].yoyPercent = _compararMesmoMesAnoAnterior_(codigo, hist);
  });

  return medias;
}

function _compararMesmoMesAnoAnterior_(codigo, hist) {
  const hoje = new Date();
  const anoAtual = hoje.getFullYear();
  const mesAtual = hoje.getMonth();
  let atual = null;
  let anterior = null;

  hist.forEach(h => {
    if (String(h.codigo_ax || '') !== String(codigo)) return;
    const d = new Date(h.competencia || 0);
    if (isNaN(d.getTime())) return;
    if (d.getMonth() !== mesAtual) return;

    const valor = parseFloat(h.quantidade_posicao || 0);
    if (d.getFullYear() === anoAtual) atual = valor;
    if (d.getFullYear() === anoAtual - 1) anterior = valor;
  });

  if (anterior === null || anterior === 0 || atual === null) return 0;
  return Number((((atual - anterior) / anterior) * 100).toFixed(2));
}

function _calcularLoteEconomico(ins, media) {
  const dAnual = (media.diaria90 || media.diaria30 || 0) * 365;
  const custoPedido = parseFloat(ins.custo_pedido || 0);
  const custoArmazenagem = parseFloat(ins.custo_armazenagem_unitaria || 0);

  if (custoPedido > 0 && custoArmazenagem > 0 && dAnual > 0) {
    return Math.ceil(Math.sqrt((2 * dAnual * custoPedido) / custoArmazenagem));
  }

  const leadTime = parseFloat(ins.lead_time_dias || 15);
  return Math.max(1, Math.ceil((media.diaria90 || media.diaria30 || 0) * leadTime));
}

function _classificarCriticidade(insumos, medias) {
  const itens = insumos.map(i => {
    const codigo = String(i.codigo_ax);
    const media = medias[codigo] || _defaultMediaLayer_();
    return {
      codigo: codigo,
      demandaAnual: (media.diaria90 || media.diaria30 || 0) * 365,
      classeABC: String(i.classe_abc || '').toUpperCase()
    };
  }).sort((a, b) => b.demandaAnual - a.demandaAnual);

  const total = itens.reduce((sum, i) => sum + i.demandaAnual, 0) || 1;
  let acumulado = 0;
  const map = {};

  itens.forEach(i => {
    acumulado += i.demandaAnual;
    const perc = acumulado / total;
    const classe = i.classeABC || (perc <= 0.8 ? 'A' : perc <= 0.95 ? 'B' : 'C');
    const risco = classe === 'A' ? 'ALTO' : classe === 'B' ? 'MEDIO' : 'BAIXO';
    map[i.codigo] = { classeABC: classe, riscoRuptura: risco };
  });

  return map;
}

function _gerarAlertas(projesp, diasLimite) {
  const limite = Number.isFinite(parseFloat(diasLimite)) ? parseFloat(diasLimite) : 15;
  return projesp
    .filter(p => p.saldo <= p.ponto_pedido_dinamico || p.dias <= limite)
    .map(p => ({
      codigo_ax: p.codigo_ax,
      descricao: p.descricao,
      dias: p.dias,
      saldo: p.saldo,
      ponto_pedido_dinamico: p.ponto_pedido_dinamico,
      classe_abc: p.classe_abc,
      risco_ruptura: p.risco_ruptura
    }))
    .sort((a, b) => a.dias - b.dias);
}

function _formatarHistorico(hist, insumosByCodigo) {
  const pivot = {};

  hist.forEach(h => {
    const ano = new Date(h.competencia).getFullYear();
    const mes = new Date(h.competencia).getMonth();
    const codigo = String(h.codigo_ax || '').trim();
    const key = `${codigo}_${ano}`;

    if (!pivot[key]) {
      pivot[key] = {
        codigo: codigo,
        descricao: (insumosByCodigo[codigo] && insumosByCodigo[codigo].descricao) || '',
        ano: ano.toString(),
        meses: new Array(12).fill(0)
      };
    }

    pivot[key].meses[mes] = parseFloat(h.quantidade_posicao || 0);
  });

  return Object.values(pivot).map(row => {
    const preenchidos = row.meses.filter(v => v > 0);
    row.media = preenchidos.length > 0 ? preenchidos.reduce((a, b) => a + b, 0) / preenchidos.length : 0;
    return row;
  });
}

function _calcularTendenciasMultiAno(hist, insumosByCodigo) {
  const matriz = {};

  hist.forEach(h => {
    const codigo = String(h.codigo_ax || '').trim();
    const d = new Date(h.competencia || 0);
    if (!codigo || isNaN(d.getTime())) return;

    const ano = String(d.getFullYear());
    const mes = d.getMonth();
    const key = `${codigo}_${ano}`;

    if (!matriz[key]) {
      matriz[key] = {
        codigo_ax: codigo,
        descricao: (insumosByCodigo[codigo] && insumosByCodigo[codigo].descricao) || '',
        ano: ano,
        meses: new Array(12).fill(0)
      };
    }

    matriz[key].meses[mes] = parseFloat(h.quantidade_posicao || 0);
  });

  const arr = Object.values(matriz);
  const byCodeYear = {};
  arr.forEach(r => { byCodeYear[`${r.codigo_ax}_${r.ano}`] = r; });

  return arr.map(r => {
    const prev = byCodeYear[`${r.codigo_ax}_${Number(r.ano) - 1}`];
    const totalAno = r.meses.reduce((a, b) => a + b, 0);
    const totalPrev = prev ? prev.meses.reduce((a, b) => a + b, 0) : 0;
    const desvioAnualPercent = totalPrev > 0 ? Number((((totalAno - totalPrev) / totalPrev) * 100).toFixed(2)) : 0;
    return {
      codigo_ax: r.codigo_ax,
      descricao: r.descricao,
      ano: r.ano,
      total_ano: totalAno,
      total_ano_anterior: totalPrev,
      desvio_anual_percent: desvioAnualPercent
    };
  }).sort((a, b) => Number(b.ano) - Number(a.ano));
}

function _formatarMovimentacoes(movRaw, snapshotsAtuais, insumosByCodigo) {
  return movRaw
    .map(m => {
      const codigo = String(m.codigo_ax || '').trim();
      const item = insumosByCodigo[codigo] || {};
      const snapshotAtual = snapshotsAtuais[codigo] || {};
      const saida = parseFloat(m.quantidade_movimento || 0);
      const saldoAtual = parseFloat(snapshotAtual.quantidade_atual || 0);
      const saldoAnterior = m.estoque_anterior !== undefined
        ? parseFloat(m.estoque_anterior || 0)
        : (m.saldo_anterior !== undefined ? parseFloat(m.saldo_anterior || 0) : saldoAtual + saida);

      return {
        uuid: m.uuid || Utilities.getUuid(),
        data: _formatDate(m.criado_em || m.data_movimento || m.data_ref),
        codigo_ax: codigo,
        descricao: item.descricao || m.descricao || '-',
        ponto: parseFloat(item.ponto_ressuprimento || 0),
        anterior: saldoAnterior,
        saida: saida,
        atual: saldoAtual,
        criado_em: m.criado_em || ''
      };
    })
    .sort((a, b) => new Date(b.criado_em || 0) - new Date(a.criado_em || 0));
}

function _formatDate(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString('pt-BR');
}

function _calcularStatsGerais(projesp) {
  let totalMediaDia = 0;
  let itensRessuprir = 0;
  let riscoAlto = 0;

  projesp.forEach(p => {
    totalMediaDia += parseFloat(p.media_dia || 0);
    if (p.saldo <= p.ponto_pedido_dinamico) itensRessuprir++;
    if (String(p.risco_ruptura || '').toUpperCase() === 'ALTO') riscoAlto++;
  });

  return {
    mediaDiaria: totalMediaDia.toFixed(2),
    mediaMensal: (totalMediaDia * 30).toFixed(0),
    itensRessuprir: itensRessuprir,
    itensRiscoAlto: riscoAlto,
    totalAnual: (totalMediaDia * 365).toLocaleString('pt-BR')
  };
}
