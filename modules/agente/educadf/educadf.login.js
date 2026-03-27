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
    // Dar tempo para o banner aparecer (ele pode ter animação)
    await session.delay(2000);

    // Screenshot para diagnóstico
    await session.screenshot('antes_cookie_banner');

    // Scrollar até o final da página para revelar o botão "Aceitar"
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await session.delay(1000);

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

    // Aguardar animação de dismiss do banner
    await session.delay(1500);

    // Voltar ao topo da página
    await page.evaluate(() => window.scrollTo(0, 0));
    await session.delay(500);

    // Screenshot pós-banner
    await session.screenshot('depois_cookie_banner');

  } catch (err) {
    console.log(`[educadf.login] Banner de cookies ignorado: ${err.message}`);
  }
}
export async function loginEducaDF(session, { login, senha }) {
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
    // PASSO 2: Selecionar perfil "Professor"
    // (ANTES do banner de cookies — o banner aparece na tela do formulário)
    // ====================================================================
    console.log('[educadf.login] 2/5 Selecionando perfil Professor...');

    // Verificar se estamos na tela de seleção de perfil ou já no formulário
    const hasProfileSelector = await session.exists(
      LOGIN.profileSelector.professor,
      5000
    );

    if (hasProfileSelector) {
      await session.safeClick(LOGIN.profileSelector.professor, { delay: 2000 });
      console.log('[educadf.login] Perfil Professor selecionado.');
    } else {
      console.log('[educadf.login] Tela de perfil não encontrada (pode já estar no formulário).');
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

    // Tentar clicar no botão (primeiro pelo texto, depois pelo seletor CSS)
    try {
      await session.safeClick(LOGIN.form.submitButton, { delay: 500 });
    } catch {
      // Fallback: botão por classe CSS
      await session.safeClick(LOGIN.form.submitButtonAlt, { delay: 500 });
    }

    // ====================================================================
    // VERIFICAÇÃO: Login foi bem-sucedido?
    // ====================================================================
    console.log('[educadf.login] Verificando resultado do login...');

    // Aguardar resposta: ou o dashboard aparece (sucesso) ou erro aparece (falha)
    const result = await Promise.race([
      // Sucesso: dashboard carrega
      page
        .waitForSelector(LOGIN.state.dashboardLoaded, {
          timeout: TIMING.loginTimeout,
        })
        .then(() => 'SUCCESS'),

      // Falha: mensagem de erro aparece
      page
        .waitForSelector(LOGIN.state.errorMessage, {
          timeout: TIMING.loginTimeout,
        })
        .then(() => 'ERROR'),

      // Timeout: nenhum dos dois apareceu
      new Promise((resolve) =>
        setTimeout(() => resolve('TIMEOUT'), TIMING.loginTimeout)
      ),
    ]);

    // Aguardar um pouco após o resultado
    await session.delay(TIMING.postLoginDelay);

    // Screenshot do resultado
    const screenshotAfter = await session.screenshot(
      result === 'SUCCESS' ? 'login_sucesso' : 'login_falha'
    );

    if (result === 'SUCCESS') {
      console.log('[educadf.login] ✅ Login bem-sucedido!');
      return {
        ok: true,
        message: 'Login realizado com sucesso no EducaDF.',
        screenshotPath: screenshotAfter,
        durationMs: Date.now() - startedAt,
        errorCode: null,
      };
    }

    if (result === 'ERROR') {
      // Tentar capturar a mensagem de erro
      const errorText = await session.getText(LOGIN.state.errorMessage);
      console.warn(`[educadf.login] ❌ Login falhou: ${errorText}`);
      return {
        ok: false,
        message: `Login falhou: ${errorText || 'Credenciais inválidas.'}`,
        screenshotPath: screenshotAfter,
        durationMs: Date.now() - startedAt,
        errorCode: 'INVALID_CREDENTIALS',
      };
    }

    // TIMEOUT
    console.warn('[educadf.login] ⏱️ Timeout ao aguardar resposta do login.');
    return {
      ok: false,
      message: 'Timeout ao aguardar resposta do login. O portal pode estar lento ou fora do ar.',
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
