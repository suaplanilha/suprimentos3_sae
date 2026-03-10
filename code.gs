/**
 * SAE - Suprimentos Engine v2.5
 * Core de processamento de dados para Google Sheets
 */

const APP_ID = typeof __app_id !== 'undefined' ? __app_id : 'suprimentos-sae';

function doGet() {
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('SAP Suprimentos Pro')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * Função principal que consolida os dados para o Dashboard
 */
function getDashboardData() {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheetInsumos = ss.getSheetByName('insumos');
    const sheetSnapshot = ss.getSheetByName('estoque_snapshot');
    const sheetMov = ss.getSheetByName('movimentacao_apurada');
    const sheetHist = ss.getSheetByName('historico_posicao_estoque_mensal');

    const insumosRaw = _readSheet(sheetInsumos);
    const movRaw = _readSheet(sheetMov);
    const snapRaw = _readSheet(sheetSnapshot);
    const histRaw = _readSheet(sheetHist);

    // 1. Processar Insumos e Saldos Atuais (Baseado no último Snapshot por item)
    const saldosAtuais = {};
    snapRaw.forEach(s => {
      saldosAtuais[s.codigo_ax] = parseFloat(s.quantidade_atual || 0);
    });

    // 2. Calcular Média de Saída Real (Apurada na movimentação)
    const mediasSaida = _calcularMediasSaida(movRaw);

    // 3. Montar Projeção e Dashboard Corrente
    const projesp = insumosRaw.map(ins => {
      const saldo = saldosAtuais[ins.codigo_ax] || 0;
      const mediaDia = mediasSaida[ins.codigo_ax] ? mediasSaida[ins.codigo_ax].diaria : 0;
      const diasCobertura = mediaDia > 0 ? Math.floor(saldo / mediaDia) : 999;
      
      const dataPrevista = new Date();
      dataPrevista.setDate(dataPrevista.getDate() + (diasCobertura > 365 ? 365 : diasCobertura));

      return {
        uuid: ins.uuid,
        codigo_ax: ins.codigo_ax,
        descricao: ins.descricao,
        saldo: saldo,
        media_dia: mediaDia.toFixed(2),
        dias: diasCobertura,
        data_prevista: diasCobertura === 999 ? 'Estável' : dataPrevista.toLocaleDateString('pt-BR'),
        ponto: parseFloat(ins.ponto_ressuprimento || 0)
      };
    });

    return {
      insumos: insumosRaw,
      projesp: projesp,
      movimentacoes: movRaw.slice(-20).reverse(), // Últimas 20
      historico: _formatarHistorico(histRaw),
      stats: _calcularStatsGerais(projesp, mediasSaida)
    };

  } catch (e) {
    return { error: e.toString() };
  }
}

/**
 * Lançamento de Saída (Cria Snapshot)
 */
function registrarSaida(codigo_ax, quantidade) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheetSnap = ss.getSheetByName('estoque_snapshot');
  const sheetInsumos = ss.getSheetByName('insumos');
  
  const insumos = _readSheet(sheetInsumos);
  const item = insumos.find(i => i.codigo_ax == codigo_ax);
  if(!item) throw new Error("Insumo não encontrado.");

  // Busca último saldo
  const snaps = _readSheet(sheetSnap);
  const ultimoSnap = snaps.reverse().find(s => s.codigo_ax == codigo_ax);
  const saldoAnterior = ultimoSnap ? parseFloat(ultimoSnap.quantidade_atual) : 0;
  const novoSaldo = saldoAnterior - parseFloat(quantidade);

  const row = [
    Utilities.getUuid(),
    item.uuid,
    codigo_ax,
    novoSaldo,
    new Date().toISOString(),
    new Date().toISOString().split('T')[0],
    'SAIDA_MANUAL',
    'WEBAPP',
    Session.getActiveUser().getEmail(),
    'Lançamento via App',
    ultimoSnap ? ultimoSnap.uuid : '',
    'PENDENTE_APURACAO',
    new Date().toISOString()
  ];

  sheetSnap.appendRow(row);
  return { success: true, novoSaldo: novoSaldo };
}

// Auxiliares de Processamento
function _readSheet(sheet) {
  const data = sheet.getDataRange().getValues();
  const headers = data.shift();
  return data.map(row => {
    let obj = {};
    headers.forEach((h, i) => obj[h] = row[i]);
    return obj;
  });
}

function _calcularMediasSaida(movs) {
  const medias = {};
  const hoje = new Date();
  const trintaDiasAtras = new Date().setDate(hoje.getDate() - 30);

  movs.filter(m => m.tipo_movimento === 'SAIDA' && new Date(m.criado_em) > trintaDiasAtras)
      .forEach(m => {
        if(!medias[m.codigo_ax]) medias[m.codigo_ax] = { total: 0, count: 0 };
        medias[m.codigo_ax].total += parseFloat(m.quantidade_movimento);
        medias[m.codigo_ax].count++;
      });
  
  Object.keys(medias).forEach(k => {
    medias[k].diaria = medias[k].total / 30;
    medias[k].mensal = medias[k].total;
  });
  return medias;
}

function _formatarHistorico(hist) {
  const pivot = {};
  hist.forEach(h => {
    const ano = new Date(h.competencia).getFullYear();
    const mes = new Date(h.competencia).getMonth();
    const key = `${h.codigo_ax}_${ano}`;
    
    if(!pivot[key]) {
      pivot[key] = { 
        codigo: h.codigo_ax, 
        descricao: '', // Será preenchido no frontend ou via lookup
        ano: ano.toString(), 
        meses: new Array(12).fill(0) 
      };
    }
    pivot[key].meses[mes] = parseFloat(h.quantidade_posicao);
  });
  
  return Object.values(pivot).map(row => {
    const preenchidos = row.meses.filter(v => v > 0);
    row.media = preenchidos.length > 0 ? preenchidos.reduce((a,b) => a+b) / preenchidos.length : 0;
    return row;
  });
}

function _calcularStatsGerais(projesp, medias) {
  let totalMediaDia = 0;
  let itensRessuprir = 0;
  
  projesp.forEach(p => {
    totalMediaDia += parseFloat(p.media_dia);
    if(p.saldo <= p.ponto) itensRessuprir++;
  });

  return {
    mediaDiaria: totalMediaDia.toFixed(2),
    mediaMensal: (totalMediaDia * 30).toFixed(0),
    itensRessuprir: itensRessuprir,
    totalAnual: (totalMediaDia * 365).toLocaleString()
  };
}