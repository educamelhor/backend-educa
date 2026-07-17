// modules/agente/educadf/educadf.browser.js
// ============================================================================
// PLAYWRIGHT — GERENCIAMENTO DO CICLO DE VIDA DO BROWSER
// ============================================================================
// Responsável por:
// - Iniciar/fechar instâncias do Chromium headless
// - Configurar viewport, user-agent, timeouts
// - Capturar screenshots de prova
// - Gerenciar contextos isolados por professor
// ============================================================================

import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { TIMING } from './educadf.selectors.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Pasta para screenshots de prova (auditoria)
const SCREENSHOTS_DIR = path.join(__dirname, '..', '..', '..', 'uploads', 'agente', 'screenshots');

/**
 * Classe que encapsula o ciclo de vida do browser Playwright.
 *
 * Padrão de uso:
 *   const session = new EducaDFBrowser();
 *   await session.launch();
 *   // ... interações ...
 *   await session.close();
 *
 * Ou com helper:
 *   await EducaDFBrowser.withSession(async (session) => {
 *     // ... interações ...
 *   });
 */
export class EducaDFBrowser {
  constructor(opts = {}) {
    /** @type {import('playwright').Browser | null} */
    this.browser = null;

    /** @type {import('playwright').BrowserContext | null} */
    this.context = null;

    /** @type {import('playwright').Page | null} */
    this.page = null;

    // Configurações
    this.headless = opts.headless !== false; // default: headless
    this.slowMo = opts.slowMo || 0;         // delay entre ações (debug)
    this.timeout = opts.timeout || TIMING.defaultTimeout;

    // Metadados (para organizar screenshots)
    this.escolaId = opts.escolaId || 'unknown';
    this.professorId = opts.professorId || 'unknown';
    this.sessionId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // Contadores
    this.screenshotCount = 0;
  }

  // ==========================================================================
  // LIFECYCLE
  // ==========================================================================

  /**
   * Inicia o browser Chromium e cria uma página.
   */
  async launch() {
    console.log(`[EducaDFBrowser] Iniciando sessão ${this.sessionId} (headless: ${this.headless})`);

    this.browser = await chromium.launch({
      headless: this.headless,
      slowMo: this.slowMo,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process',
      ],
    });

    this.context = await this.browser.newContext({
      viewport: { width: 1366, height: 900 },
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      locale: 'pt-BR',
      timezoneId: 'America/Sao_Paulo',
      ignoreHTTPSErrors: true,
    });

    // Timeout global
    this.context.setDefaultTimeout(this.timeout);
    this.context.setDefaultNavigationTimeout(TIMING.loginTimeout);

    this.page = await this.context.newPage();

    console.log(`[EducaDFBrowser] Sessão ${this.sessionId} pronta.`);
    return this;
  }

  /**
   * Fecha o browser e libera recursos.
   */
  async close() {
    try {
      if (this.page && !this.page.isClosed()) {
        await this.page.close().catch(() => {});
      }
      if (this.context) {
        await this.context.close().catch(() => {});
      }
      if (this.browser) {
        await this.browser.close().catch(() => {});
      }
      console.log(`[EducaDFBrowser] Sessão ${this.sessionId} encerrada.`);
    } catch (err) {
      console.warn(`[EducaDFBrowser] Erro ao fechar sessão: ${err.message}`);
    } finally {
      this.page = null;
      this.context = null;
      this.browser = null;
    }
  }

  // ==========================================================================
  // SCREENSHOTS DE PROVA (AUDITORIA)
  // ==========================================================================

  /**
   * Captura um screenshot da tela atual.
   *
   * @param {string} label - Rótulo descritivo (ex: 'login_ok', 'antes_salvar')
   * @returns {Promise<string>} Caminho do arquivo salvo
   */
  async screenshot(label = 'captura') {
    if (!this.page) {
      console.warn('[EducaDFBrowser] Página não disponível para screenshot.');
      return null;
    }

    this.screenshotCount++;

    const dir = path.join(
      SCREENSHOTS_DIR,
      String(this.escolaId),
      String(this.professorId),
      this.sessionId
    );

    // Cria diretório se não existir
    fs.mkdirSync(dir, { recursive: true });

    const filename = `${String(this.screenshotCount).padStart(3, '0')}_${label}.png`;
    const filepath = path.join(dir, filename);

    try {
      await this.page.screenshot({
        path: filepath,
        fullPage: false,
      });
      console.log(`[EducaDFBrowser] 📸 Screenshot: ${filename}`);
      return filepath;
    } catch (err) {
      console.warn(`[EducaDFBrowser] Erro ao capturar screenshot: ${err.message}`);
      return null;
    }
  }

  // ==========================================================================
  // HELPERS DE INTERAÇÃO
  // ==========================================================================

  /**
   * Aguarda um tempo fixo (respeitar rate limiting do EducaDF).
   * @param {number} ms - Milissegundos
   */
  async delay(ms = TIMING.actionDelay) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Navega para uma URL e aguarda o carregamento.
   * @param {string} url
   */
  async navigateTo(url) {
    console.log(`[EducaDFBrowser] Navegando para: ${url}`);
    // Usa 'domcontentloaded' em vez de 'networkidle' pois portais Angular/AngularJS
    // fazem polling constante de fundo e NUNCA atingem o estado "networkidle",
    // causando timeout de 20-60s desnecessariamente.
    await this.page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: TIMING.loginTimeout,
    });
    // Damos um delay extra para o Angular terminar de renderizar
    await this.delay(TIMING.navigationDelay);
  }

  /**
   * Clica em um elemento de forma segura (aguarda existir + estar visível).
   * @param {string} selector - Seletor CSS/texto
   * @param {object} opts
   */
  async safeClick(selector, opts = {}) {
    const timeout = opts.timeout || this.timeout;
    try {
      await this.page.waitForSelector(selector, { state: 'visible', timeout });
      await this.page.click(selector);
      await this.delay(opts.delay || TIMING.actionDelay);
    } catch (err) {
      console.warn(`[EducaDFBrowser] safeClick falhou para "${selector}": ${err.message}`);
      throw err;
    }
  }

  /**
   * Preenche um campo de texto de forma segura.
   * @param {string} selector - Seletor do input
   * @param {string} value - Valor a preencher
   * @param {object} opts
   */
  async safeFill(selector, value, opts = {}) {
    const timeout = opts.timeout || this.timeout;
    try {
      await this.page.waitForSelector(selector, { state: 'visible', timeout });
      await this.page.fill(selector, '');  // Limpar primeiro
      await this.page.fill(selector, value);
      await this.delay(opts.delay || 500);
    } catch (err) {
      console.warn(`[EducaDFBrowser] safeFill falhou para "${selector}": ${err.message}`);
      throw err;
    }
  }

  /**
   * Verifica se um elemento existe na página.
   * @param {string} selector
   * @param {number} timeout
   * @returns {Promise<boolean>}
   */
  async exists(selector, timeout = 3000) {
    try {
      await this.page.waitForSelector(selector, { state: 'visible', timeout });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Retorna o texto de um elemento.
   * @param {string} selector
   * @returns {Promise<string|null>}
   */
  async getText(selector) {
    try {
      await this.page.waitForSelector(selector, { state: 'visible', timeout: 5000 });
      return await this.page.textContent(selector);
    } catch {
      return null;
    }
  }

  // ==========================================================================
  // HELPER ESTÁTICO: WITH SESSION
  // ==========================================================================

  /**
   * Abre uma sessão, executa o callback, e fecha automaticamente.
   * Garante cleanup mesmo em caso de erro.
   *
   * @param {function(EducaDFBrowser): Promise<any>} callback
   * @param {object} opts - Opções do construtor
   * @returns {Promise<any>}
   */
  static async withSession(callback, opts = {}) {
    const session = new EducaDFBrowser(opts);
    try {
      await session.launch();
      return await callback(session);
    } finally {
      await session.close();
    }
  }
}

export default EducaDFBrowser;
