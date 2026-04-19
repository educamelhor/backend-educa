// modules/agente/educadf/educadf.login.js
// ============================================================================
// FLUXO DE LOGIN NO PORTAL EducaDF
// ============================================================================
// Implementa o login automatizado:
// 1. Navegar para /auth
// 2. Aceitar banner de cookies (se presente)
// 3. Selecionar perfil "Professor"
// 4. Preencher matrícula/CPF + senha
// 5. Clicar "Acessar"
// 6. Verificar sucesso (dashboard carregou)
// ============================================================================

import { LOGIN, TIMING } from './educadf.selectors.js';

/**
 * Resultado de uma tentativa de login.
 * @typedef {Object} LoginResult
 * @property {boolean} ok - Se o login foi bem-sucedido
 * @property {string} message - Mensagem descritiva
 * @property {string|null} screenshotPath - Caminho do screenshot de prova
 * @property {number} durationMs - Duração total do login
 * @property {string|null} errorCode - Código de erro (se houver)
 */

/**
 * Executa o login completo no EducaDF.
 *
 * @param {import('./educadf.browser.js').EducaDFBrowser} session - Sessão Playwright ativa
 * @param {Object} credentials
 * @param {string} credentials.login - Matrícula ou CPF do professor
 * @param {string} credentials.senha - Senha do professor
 * @returns {Promise<LoginResult>}
 */

// ============================================================================
// HELPER: Dismiss cookie banner "Bem-vindo!"
// ============================================================================
async function dismissCookieBanner(session, page) {
  try {
    // EDUCADF migrou o banner de cookies para ngb-offcanvas (Angular Bootstrap).
    // O seletor agora deve incluir a tag do backdrop do offcanvas.
    const BANNER_SELECTOR = [
      'ngb-offcanvas-backdrop',
      '.offcanvas-backdrop',
      '.cookies-banner',
      '[class*="cookie"]',
      '[class*="lgpd"]',
      '[class*="consent"]',
    ].join(', ');

    const bannerEl = await page.$(BANNER_SELECTOR).catch(() => null);

    if (!bannerEl) {
      console.log('[educadf.login] Nenhum banner/overlay detectado — pulando dismiss (early exit).');
      return;
    }

    // ─ ngb-offcanvas detectado: fechar via botão close ou Escape ─────────
    const isOffcanvas = await page.$('ngb-offcanvas-backdrop, .offcanvas-backdrop').catch(() => null);
    if (isOffcanvas) {
      console.log('[educadf.login] ngb-offcanvas detectado (cookie consent angular) — fechando...');
      try {
        // Tenta clicar no botão de fechar dentro do offcanvas
        const closeBtn = await page.$(
          'ngb-offcanvas .btn-close, .offcanvas .btn-close, button[aria-label="Close"], button[aria-label="Fechar"]'
        ).catch(() => null);

        if (closeBtn) {
          await closeBtn.click().catch(() => {});
          console.log('[educadf.login] Offcanvas fechado via btn-close.');
        } else {
          // Busca qualquer botão "Aceitar" dentro do offcanvas via JS (bypassa pointer events)
          const aceitoViaJS = await page.evaluate(() => {
            const within = document.querySelector('ngb-offcanvas, .offcanvas');
            const btns = within
              ? [...within.querySelectorAll('button, a, .btn, [role="button"]')]
              : [...document.querySelectorAll('ngb-offcanvas button, .offcanvas button')];
            const aceitar = btns.find(el => {
              const t = (el.textContent ?? '').trim().toLowerCase();
              return t === 'aceitar' || t === 'aceito' || t === 'concordo' || t === 'ok';
            });
            if (aceitar) { aceitar.click(); return true; }
            return false;
          });

          if (!aceitoViaJS) {
            // Último recurso: Escape fecha o offcanvas
            await page.keyboard.press('Escape');
            console.log('[educadf.login] Offcanvas fechado via tecla Escape.');
          }
        }
        await session.delay(600);
        await session.screenshot('depois_offcanvas_fechado');
        return; // offcanvas tratado — não precisa do fluxo de cookie banner tradicional
      } catch (offErr) {
        console.warn('[educadf.login] Erro ao fechar offcanvas:', offErr.message);
      }
    }

    // ─ Banner tradicional (não-offcanvas) ───────────────────────────
    // Banner presente: aguarda animação e tira screenshot
    await session.delay(800);
    await session.screenshot('antes_cookie_banner');

    // Scrollar até o final da página para revelar o botão "Aceitar"
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await session.delay(600);

    // Tentar múltiplos seletores para o botão "Aceitar"
    const selectors = Array.isArray(LOGIN.cookieBanner.acceptButton)
      ? LOGIN.cookieBanner.acceptButton
      : [LOGIN.cookieBanner.acceptButton];

    let clicked = false;

    for (const selector of selectors) {
      try {
        const btn = await page.$(selector);
        if (btn) {
          // Scrollar o botão para a área visível
          await btn.scrollIntoViewIfNeeded().catch(() => {});
          await session.delay(500);

          // Tentar click normal primeiro
          try {
            await btn.click({ timeout: 3000 });
            clicked = true;
            console.log(`[educadf.login] Banner aceito via click normal: "${selector}"`);
            break;
          } catch {
            // Fallback: forçar click via JavaScript (bypassa visibilidade)
            await page.evaluate((el) => el.click(), btn);
            clicked = true;
            console.log(`[educadf.login] Banner aceito via JS click: "${selector}"`);
            break;
          }
        }
      } catch {
        // Tentar próximo seletor
      }
    }

    // Último recurso: buscar QUALQUER botão/link com texto "Aceitar" via JS
    if (!clicked) {
      clicked = await page.evaluate(() => {
        const elements = [...document.querySelectorAll('button, a, .btn, [role="button"]')];
        const aceitar = elements.find((el) => {
          const txt = el.textContent?.trim().toLowerCase();
          return txt === 'aceitar' || txt === 'aceito' || txt === 'concordo';
        });
        if (aceitar) {
          aceitar.scrollIntoView({ block: 'center' });
          aceitar.click();
          return true;
        }
        return false;
      });
      if (clicked) {
        console.log('[educadf.login] Banner aceito via busca JS genérica.');
      }
    }

    if (!clicked) {
      console.log('[educadf.login] Banner de cookies não encontrado (pode já ter sido aceito).');
    }

    // Aguardar animação de dismiss do banner (reduzido de 1500ms)
    await session.delay(800);

    // Voltar ao topo da página
    await page.evaluate(() => window.scrollTo(0, 0));
    await session.delay(500);

    // Screenshot pós-banner
    await session.screenshot('depois_cookie_banner');

  } catch (err) {
    console.log(`[educadf.login] Banner de cookies ignorado: ${err.message}`);
  }
}
export async function loginEducaDF(session, { login, senha, perfil = 'professor' }) {
  const startedAt = Date.now();
  const page = session.page;

  if (!page) {
    return {
      ok: false,
      message: 'Sessão do browser não está ativa.',
      screenshotPath: null,
      durationMs: Date.now() - startedAt,
      errorCode: 'SESSION_NOT_ACTIVE',
    };
  }

  try {
    // ====================================================================
    // PASSO 1: Navegar para a tela de login
    // ====================================================================
    console.log('[educadf.login] 1/5 Navegando para', LOGIN.url);
    await session.navigateTo(LOGIN.url);

    // ====================================================================
    // PASSO 2: Selecionar perfil (Professor, Servidor, Gestão, etc.)
    // (ANTES do banner de cookies — o banner aparece na tela do formulário)
    // ====================================================================
    let selector = LOGIN.profileSelector[perfil] || LOGIN.profileSelector.professor;
    
    // Fallback amigável se o perfil não bater exatamente (ex: 'secretario' -> 'servidor' ou 'gestao')
    if (perfil === 'secretario' || perfil === 'diretor' || perfil === 'vice_diretor') {
        selector = LOGIN.profileSelector.gestao;
    }

    console.log(`[educadf.login] 2/5 Selecionando perfil: ${perfil} (seletor: ${selector})...`);

    // Verificar se estamos na tela de seleção de perfil ou já no formulário
    const hasProfileSelector = await session.exists(selector, 5000);

    if (hasProfileSelector) {
      await session.safeClick(selector, { delay: 2000 });
      console.log(`[educadf.login] Perfil selecionado via seletor: ${selector}`);
    } else {
      console.log('[educadf.login] Tela de seleção de perfil não encontrada ou seletor não bate.');
    }

    // ====================================================================
    // PASSO 3: Aceitar banner de cookies "Bem-vindo!" (se presente)
    // O banner aparece NA TELA DO FORMULÁRIO de login do professor.
    // O botão "Aceitar" fica no rodapé e pode estar fora do viewport.
    // Estratégia: scroll → multiple selectors → JS click fallback
    // ====================================================================
    console.log('[educadf.login] 3/5 Verificando banner de cookies...');
    await dismissCookieBanner(session, page);

    // ====================================================================
    // PASSO 4: Preencher credenciais
    // ====================================================================
    console.log('[educadf.login] 4/5 Preenchendo credenciais...');

    // Aguardar o formulário estar visível
    await page.waitForSelector(LOGIN.form.usernameInput, {
      state: 'visible',
      timeout: TIMING.loginTimeout,
    });

    // Preencher login (matrícula/CPF)
    await session.safeFill(LOGIN.form.usernameInput, login, { delay: 500 });

    // Preencher senha
    await session.safeFill(LOGIN.form.passwordInput, senha, { delay: 500 });

    // Screenshot antes de submeter (prova de preenchimento)
    const screenshotBefore = await session.screenshot('login_preenchido');

    // ====================================================================
    // PASSO 5: Submeter o formulário
    // ====================================================================
    console.log('[educadf.login] 5/5 Clicando "Acessar"...');

    // PRE-FLIGHT: se ainda houver ngb-offcanvas-backdrop (overlay Angular), remove antes de clicar.
    // Este é o motivo principal de falha: o backdrop intercepta pointer events do botão Acessar.
    const backdropAtivo = await page.$('ngb-offcanvas-backdrop, .offcanvas-backdrop').catch(() => null);
    if (backdropAtivo) {
      console.log('[educadf.login] AVISO: ngb-offcanvas-backdrop ainda ativo antes do submit — forçando fechamento...');
      await page.keyboard.press('Escape');
      await session.delay(600);
      // Remove via JS se Escape não fechou (offcanvas pode não responder a Escape)
      await page.evaluate(() => {
        document.querySelectorAll('ngb-offcanvas-backdrop, .offcanvas-backdrop').forEach(el => el.remove());
        document.querySelectorAll('ngb-offcanvas, .offcanvas.show').forEach(el => el.remove());
        document.body.classList.remove('offcanvas-backdrop', 'modal-open');
      });
      await session.delay(300);
    }

    // Tenta clicar no botão via texto → seletor CSS → JS direct click (bypassa pointer events)
    let submitClicked = false;
    try {
      await session.safeClick(LOGIN.form.submitButton, { delay: 500 });
      submitClicked = true;
    } catch {
      try {
        await session.safeClick(LOGIN.form.submitButtonAlt, { delay: 300 });
        submitClicked = true;
      } catch { /* cai no JS click */ }
    }

    if (!submitClicked) {
      // JS click direto: bypassa QUALQUER interceptação de pointer events (offcanvas, modal, backdrop)
      console.log('[educadf.login] safeClick falhou — usando JS click direto no botão Acessar...');
      await page.evaluate(() => {
        const btn = document.querySelector('button.btn-success[type="submit"], button:not([disabled])');
        if (btn) btn.click();
      });
    }

    // ====================================================================
    // VERIFICAÇÃO: Login foi bem-sucedido?
    // Estratégia multicamadas — cobre Professor, Gestão e Servidor:
    //   1. URL saiu de /auth → sucesso universal (qualquer portal)
    //   2. Seletor CSS do dashboard → confirmação extra
    //   3. Mensagem de erro visível → falha definitiva
    //   4. Timeout de 45s (portais de Gestão carregam mais devagar)
    // ====================================================================
    console.log('[educadf.login] Verificando resultado do login...');

    const MAX_WAIT_MS = 45000;

    const result = await Promise.race([
      // ── Sucesso: URL saiu de /auth (universal) ──────────────────────────
      page
        .waitForFunction(
          () => !window.location.href.includes('/auth'),
          { timeout: MAX_WAIT_MS }
        )
        .then(() => 'SUCCESS_URL'),

      // ── Sucesso: seletor CSS do dashboard (específico do portal) ───────
      page
        .waitForSelector(LOGIN.state.dashboardLoaded, { timeout: MAX_WAIT_MS })
        .then(() => 'SUCCESS_CSS'),

      // ── Falha: mensagem de erro aparece ────────────────────────────────
      page
        .waitForSelector(LOGIN.state.errorMessage, { timeout: MAX_WAIT_MS })
        .then(async () => {
          const txt = await page.textContent(LOGIN.state.errorMessage).catch(() => '');
          return txt?.trim() ? 'ERROR' : 'SUCCESS_URL';
        }),

      // ── Timeout absoluto ───────────────────────────────────────────────
      new Promise(resolve => setTimeout(() => resolve('TIMEOUT'), MAX_WAIT_MS)),
    ]);

    await session.delay(1500);
    const isSuccess = result === 'SUCCESS_URL' || result === 'SUCCESS_CSS';
    const screenshotAfter = await session.screenshot(isSuccess ? 'login_sucesso' : 'login_falha');

    if (isSuccess) {
      const urlAtual = page.url().substring(0, 100);
      console.log(`[educadf.login] ✅ Login bem-sucedido! (${result} | url: ${urlAtual})`);
      return {
        ok: true,
        message: 'Login realizado com sucesso no EducaDF.',
        screenshotPath: screenshotAfter,
        durationMs: Date.now() - startedAt,
        errorCode: null,
      };
    }

    if (result === 'ERROR') {
      const errorText = await session.getText(LOGIN.state.errorMessage).catch(() => null);
      console.warn(`[educadf.login] ❌ Login falhou: ${errorText}`);
      return {
        ok: false,
        message: `Login falhou: ${errorText || 'Verifique seu usuário e senha no portal EDUCADF.'}`,
        screenshotPath: screenshotAfter,
        durationMs: Date.now() - startedAt,
        errorCode: 'INVALID_CREDENTIALS',
      };
    }

    // TIMEOUT — informa URL atual para diagnóstico
    const urlTimeout = page.url().substring(0, 100);
    console.warn(`[educadf.login] ⏱️ Timeout. URL atual: ${urlTimeout}`);
    return {
      ok: false,
      message: `Timeout de ${MAX_WAIT_MS / 1000}s. O portal pode estar lento. URL: ${urlTimeout}`,
      screenshotPath: screenshotAfter,
      durationMs: Date.now() - startedAt,
      errorCode: 'LOGIN_TIMEOUT',
    };
  } catch (err) {
    console.error(`[educadf.login] Erro inesperado: ${err.message}`);

    // Tentar tirar screenshot do erro
    const errorScreenshot = await session.screenshot('login_erro').catch(() => null);

    return {
      ok: false,
      message: `Erro durante login: ${err.message}`,
      screenshotPath: errorScreenshot,
      durationMs: Date.now() - startedAt,
      errorCode: 'UNEXPECTED_ERROR',
    };
  }
}

/**
 * Testa se credenciais são válidas (login + logout imediato).
 *
 * @param {import('./educadf.browser.js').EducaDFBrowser} session
 * @param {Object} credentials
 * @returns {Promise<LoginResult>}
 */
export async function testCredentials(session, credentials) {
  const result = await loginEducaDF(session, credentials);

  if (result.ok) {
    // Logout para não manter sessão ativa
    try {
      const { NAVIGATION } = await import('./educadf.selectors.js');
      const hasLogout = await session.exists(NAVIGATION.header.logoutBtn, 5000);
      if (hasLogout) {
        await session.safeClick(NAVIGATION.header.logoutBtn);
        console.log('[educadf.login] Logout realizado após teste de credenciais.');
      }
    } catch {
      // Logout não é bloqueante para o teste
    }
  }

  return result;
}

export default {
  loginEducaDF,
  testCredentials,
};
