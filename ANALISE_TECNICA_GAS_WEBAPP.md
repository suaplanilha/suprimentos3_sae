# Análise Técnica do Projeto GAS / WebApp (Suprimentos SAE)

## 1) Diagnóstico do estado atual
- O projeto já possui um esqueleto funcional de **Google Apps Script + HTML Service**, com `doGet` servindo uma SPA e duas rotas de backend principais (`getDashboardData` e `registrarSaida`).
- A modelagem de dados em abas está bem definida no conceito (insumos, snapshot, movimentação apurada e histórico mensal).
- A UI está avançada visualmente (dashboard, abas, KPI, tabela de projeção, histórico e lançamentos).
- Porém, hoje existe um **descolamento importante entre frontend e backend**: o frontend está operando com dados mockados/simulados e não consome de fato a resposta real de `google.script.run`.

## 2) O que foi construído (por camada)

### Backend GAS (`code.gs`)
- Entrada webapp com `doGet()` e metadados corretos para viewport e iframe.
- Consolidação de dados no `getDashboardData()`:
  - leitura das abas,
  - cálculo de saldo atual por item,
  - cálculo de média de saída (janela de 30 dias),
  - projeção de cobertura em dias,
  - transformação do histórico mensal para estrutura pivotada,
  - agregação de KPIs gerais.
- Registro operacional no `registrarSaida(codigo_ax, quantidade)` com geração de UUID, trilha de auditoria por usuário e status de apuração pendente.

### Frontend (`index.html`)
- SPA em Vue 3 (Composition API), com navegação por abas:
  - Corrente,
  - Histórico,
  - Movimentação,
  - Lançamentos.
- UX visual robusta com Tailwind e feedback de loading/toast.
- Estrutura de filtros e tabelas pronta para operação.
- Componente de carga em massa já desenhado na interface.

## 3) Pontos fortes técnicos
1. **Arquitetura simples e escalável para fase inicial**: GAS + Sheets reduz fricção de operação.
2. **Organização lógica no backend**: funções auxiliares separadas para leitura, médias, pivot e stats.
3. **Regra de cobertura clara** (saldo / média diária), fácil de explicar ao usuário de almoxarifado.
4. **Auditoria mínima já prevista** em lançamento manual.
5. **UI madura para operação**: visão corrente + histórico + lançamentos em um fluxo coerente.

## 4) Riscos e lacunas críticas (para controle sistêmico real)
1. **Integração real incompleta na UI**: sem bind em `google.script.run`, o sistema não reflete dados reais em produção.
2. **Snapshot atual pode não ser o mais recente por data**: cálculo usa última linha lida por item, sem ordenar explicitamente por `criado_em`.
3. **Sem validações fortes de entrada** no backend (quantidade <= 0, saldo negativo excessivo, tipo numérico inválido).
4. **Dependência de estrutura fixa de cabeçalhos**: `_readSheet` falha silenciosamente se aba estiver vazia ou com cabeçalho alterado.
5. **Movimentações recentes limitadas em memória** com `slice(-20)` sem paginação/consulta orientada a data.
6. **Histórico pivotado sem enriquecimento de descrição** (descrição vazia no backend).
7. **Cálculo de média simples** (total/30) ainda sem sazonalidade, tendência e outliers.
8. **Carga em massa somente visual** no frontend (sem pipeline backend de parsing/validação/apuração).
9. **Sem camada explícita de governança** (locks, idempotência, prevenção de concorrência de escrita).

## 5) Visão de evolução (fullstack GAS para almoxarifado)

### Fase A — Estabilizar o núcleo operacional
- Conectar frontend ao backend real (`google.script.run`) para:
  - carregar dashboard,
  - registrar saída manual,
  - atualizar estado reativo com retorno real.
- Fortalecer validações de domínio:
  - quantidade > 0,
  - item existente,
  - saldo resultante com política explícita (permitir/bloquear negativo),
  - mensagens operacionais claras.
- Tornar cálculo de saldo determinístico:
  - selecionar snapshot mais recente por data/ID,
  - não apenas última ocorrência no array.

### Fase B — Confiabilidade de dados e governança
- Implementar função de verificação de esquema (headers obrigatórios por aba).
- Adicionar trilha de eventos de erro e logs estruturados para auditoria.
- Introduzir controle transacional básico com `LockService` para gravações simultâneas.
- Definir rotina de apuração/fechamento diário (gatilho time-driven).

### Fase C — Inteligência de consumo e projeção
- Evoluir cálculo de média para camadas:
  - média 30 dias,
  - média 90 dias,
  - comparação com mesmo mês do ano anterior.
- Criar projeção de ressuprimento por política de estoque:
  - ponto de pedido dinâmico,
  - estoque de segurança,
  - lead time de fornecedor,
  - lote econômico (se aplicável).
- Classificar criticidade por item (A/B/C + risco de ruptura).

### Fase D — Operação avançada e escala
- Pipeline de carga em massa com staging:
  - upload/parse,
  - validação linha a linha,
  - relatório de rejeição,
  - commit transacional.
- Tela de tendência anual/mensal com comparativo multi-ano e desvios.
- Alertas automáticos (e-mail/Chat) para itens em ruptura e previsão < X dias.

## 6) Leitura como usuário gestor de estoque
Para um gestor de almoxarifado, a base está boa para visualização, mas o sistema ainda precisa fechar o ciclo operacional completo:
- **Entrada de dados real confiável**,
- **Conferência histórica consistente**,
- **Projeção que explique o “quando comprar” com justificativa**,
- **Rastreabilidade para auditoria e decisões de compra**.

Hoje o projeto está em estágio de **MVP visual + núcleo analítico inicial**. Com as evoluções acima, ele pode chegar rapidamente a um nível de **controle sistêmico robusto** para operação diária e planejamento de ressuprimento futuro.

## 7) Prioridade recomendada (ordem prática)
1. Integração real frontend↔GAS.
2. Validação de domínio + consistência de snapshots.
3. Pipeline de carga em massa com validação.
4. Indicadores avançados (90 dias, sazonalidade, comparação anual).
5. Alertas e governança operacional.
