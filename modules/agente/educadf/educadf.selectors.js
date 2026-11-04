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

  // Banner de cookies (precisa aceitar antes de interagir)
  cookieBanner: {
    container: 'app-aviso-cookies, .cookies-banner, [class*="cookie"], [class*="lgpd"], [class*="consent"], .aviso, [aria-label*="cookie" i]',
    acceptButton: [
      'app-aviso-cookies button.aceitar',
      'button.aceitar',
      'button:has-text("Aceitar")',
      'button.btn-primary:has-text("Aceitar")',
      'a:has-text("Aceitar")',
      '.btn:has-text("Aceitar")',
    ],
  },

  // Seleção de perfil (tela inicial /auth)
  profileSelector: {
    professor: 'a.profile-card-hit-area[href*="id=1"], a[href*="id=1"]',
    servidor:  'a.profile-card-hit-area[href*="id=2"], a[href*="id=2"]',
    estudante: 'a.profile-card-hit-area[href*="id=3"], a[href*="id=3"]',
    gestao:    'a.profile-card-hit-area[href*="id=3"], a[href*="id=3"]',
  },

  // URLs DIRETAS de login por perfil (bypass da tela de seleção)
  loginUrl: {
    professor: `${EDUCADF_URL}/auth/login?id=1`,
    servidor:  `${EDUCADF_URL}/auth/login?id=2`,
    gestao:    `${EDUCADF_URL}/auth/login?id=3`,
  },

  // Formulário de login (após selecionar perfil)
  form: {
    usernameInput:    '#login-identificador, input[autocomplete="username"], input[formcontrolname="name"], #username',
    passwordInput:    '#login-senha, input[autocomplete="current-password"], input[formcontrolname="password"], #password-input',
    rememberCheck:    'input[formcontrolname="lembrar"], #auth-remember-check',
    submitButton:     'button.tf__botao, button[type="submit"], button:has-text("Entrar"), button.login-lam-btn-acessar',
    submitButtonAlt:  'button[type="submit"]',
    submitButtonAlt2: 'button.btn-success',
  },

  // Indicadores de estado
  state: {
    errorMessage:    '.tf__falha, [role="alert"], app-aviso-de-erro, .alert-danger, .text-danger, .error-message, [class*="error"]',
    spinner:         '.spinner-border, .loading, [aria-busy="true"]',
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
  // O portal EDUCADF é lento por natureza — 5s é o mínimo seguro após cliques de aba
  navigationDelay: 5000,
};
