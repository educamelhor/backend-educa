// modules/agente/educadf/educadf.selectors.js
// ============================================================================
// SELETORES CSS CENTRALIZADOS DO PORTAL EducaDF
// Fonte: mapeamento manual via Playwright (26/03/2026)
// ============================================================================
// REGRA: Toda interação com o EducaDF DEVE usar seletores deste arquivo.
//        Se a SEEDF alterar o portal, basta atualizar aqui.
// ============================================================================

export const EDUCADF_URL = 'https://educadf.se.df.gov.br';

// ============================================================================
// TELA DE LOGIN
// ============================================================================
export const LOGIN = {
  // URL da página de autenticação
  url: `${EDUCADF_URL}/auth`,

  // Banner de cookies "Bem-vindo!" (precisa aceitar antes de interagir)
  // O banner fica fixo no rodapé e pode esconder parte da tela
  cookieBanner: {
    // Contêiner do banner (para saber se está visível)
    container: '.cookies-banner, [class*="cookie"], [class*="lgpd"], [class*="consent"]',
    // Botão "Aceitar" — múltiplos seletores para robustez
    acceptButton: [
      'button:has-text("Aceitar")',              // texto exato
      'button.btn-primary:has-text("Aceitar")',  // com classe
      'a:has-text("Aceitar")',                   // pode ser <a>
      '.btn:has-text("Aceitar")',                // genérico Bootstrap
    ],
  },

  // Seleção de perfil (tela inicial /auth)
  // IMPORTANTE: Cada perfil tem href próprio — mais robusto que texto
  // Professor  = /auth/login?id=1
  // Servidor   = /auth/login?id=2 (ou similar)
  // Gestão    = /auth/login?id=3 (ou similar)
  profileSelector: {
    professor: 'a.profile-card-hit-area[href*="id=1"]',
    servidor:  'a.profile-card-hit-area[href*="id=2"]',
    estudante: 'a.profile-card-hit-area[href*="id=3"]',
    gestao:    'a.profile-card-hit-area[href*="id=3"]',
  },

  // URLs DIRETAS de login por perfil (bypass da tela de seleção)
  // Mais confiável: pula o click no card que pode ser bloqueado por overlays
  loginUrl: {
    professor: `${EDUCADF_URL}/auth/login?id=1`,
    servidor:  `${EDUCADF_URL}/auth/login?id=2`,
    gestao:    `${EDUCADF_URL}/auth/login?id=3`,
  },

  // Formulário de login (após selecionar perfil)
  form: {
    usernameInput:    '#username',
    passwordInput:    '#password-input',
    rememberCheck:    '#auth-remember-check',
    // Botão principal atualizado (mapeado em 26/04/2026)
    submitButton:     'button.login-lam-btn-acessar',
    // Fallbacks em ordem de preferência
    submitButtonAlt:  'button[type="submit"]',
    submitButtonAlt2: 'button.btn-success',
  },

  // Indicadores de estado
  state: {
    // Mensagem de erro de login (se senha errada)
    errorMessage:    '.alert-danger, .text-danger, .error-message, [class*="error"]',
    // Indicador de loading
    spinner:         '.spinner-border, .loading',
    // Sucesso: qualquer elemento significativo que apareça após login bem-sucedido.
    // Cobre o portal do Professor (Angular/app-sidebar) E o portal de Gestão/Servidor (Bootstrap/page-content).
    dashboardLoaded: [
      '.page-content',
      '.vertical-menu',
      'app-sidebar',
      '.main-panel',
      '#main-content',
      '.sidebar-menu',
      'app-root .container-fluid',
      '.card-body h4',
      '[class*="dashboard"]',
      'nav.navbar + *',
    ].join(', '),
  },
};

// ============================================================================
// NAVEGAÇÃO INTERNA (após login)
// ============================================================================
export const NAVIGATION = {
  // Menu lateral
  sidebar: {
    container:    '.vertical-menu, #scrollbar, app-sidebar',
    menuItems:    '.menu-link, .nav-link',
    // Itens específicos (a serem mapeados com acesso professor)
    diarioClasse: 'a:has-text("Diário"), a:has-text("Diário de Classe")',
  },

  // Header
  header: {
    userInfo:   '.header-item .user-name-text',
    schoolInfo: '.header-item .user-name-sub-text',
    logoutBtn:  'a:has-text("Sair"), button:has-text("Sair")',
  },
};

// ============================================================================
// DIÁRIO DE CLASSE — FREQUÊNCIA (Fase 2 - a ser mapeado com acesso professor)
// ============================================================================
export const FREQUENCIA = {
  // Seletores placeholder (serão atualizados com acesso professor)
  selectorTurma:      '[data-turma-select], select.turma-select',
  selectorData:       '[data-date-picker], input[type="date"]',
  tabelaAlunos:       'table.alunos-table, .table-responsive table',
  checkboxPresenca:   'input[type="checkbox"].presenca',
  botaoSalvar:        'button:has-text("Salvar"), button.btn-save',
  confirmacaoSucesso: '.alert-success, .toast-success',
};

// ============================================================================
// DIÁRIO DE CLASSE — CONTEÚDOS (Fase 3 - futuro)
// ============================================================================
export const CONTEUDO = {
  // Placeholder
};

// ============================================================================
// DIÁRIO DE CLASSE — NOTAS (Fase 3 - futuro)
// ============================================================================
export const NOTAS = {
  // Placeholder
};

// ============================================================================
// TIMEOUTS E DELAYS
// ============================================================================
export const TIMING = {
  // Tempo máximo de espera por um elemento aparecer
  defaultTimeout: 30000,

  // Tempo máximo de espera pelo login completar (o portal EDUCADF é lento)
  loginTimeout: 60000,

  // Delay entre ações (respeitar rate limiting do EducaDF)
  actionDelay: 2000,     // 2s entre cliques (portal antigo AngularJS)

  // Delay após o login (aguardar dashboard carregar)
  postLoginDelay: 5000,

  // Delay para navegação SPA (Angular route change)
  navigationDelay: 3000,
};
