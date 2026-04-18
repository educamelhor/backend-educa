// modules/agente/educadf/educadf.pap.js
// ============================================================================
// AGENTE EDUCADF — EXPORTAR PLANO DE AVALIAÇÃO PEDAGÓGICA (PAP)
// ============================================================================
// Fluxo automatizado via Playwright:
//  1. Login (via educadf.login.js) — mesmo fluxo do agente de scraping Python
//  2. Menu lateral: span:"Diário de Classe" → a:"Registro das Informações"
//  3. Filtros: ng-select "Turma/Agrupamento" + ng-select "Professor"
//     (Ano e Regional já vêm pré-selecionados)
//  4. Clicar "Filtrar"
//  5. Tab superior: a:"Registro de Procedimento Avaliativo"
//  6. Botão azul: "Criar procedimento avaliativo"
//  7. Preencher modal "Criar Instrumento/Procedimento Avaliativo":
//       - Nome        → input de texto (required)
//       - Tipo        → ng-select (dropdown Angular)
//       - Data        → date picker customizado (DD Mmm, YYYY)
//       - Observações → textarea
//       - "Atribuir nota" → JÁ VEM MARCADO por padrão, NÃO TOCAR
//  8. Clicar "Salvar"
// ============================================================================
// SELETORES BASEADOS NO CÓDIGO PYTHON QUE JÁ FUNCIONA (educadf.py):
//   - ng-select usa placeholder= como identificador
//   - Dropdowns: .ng-dropdown-panel .ng-option
//   - Botões: button:has-text('texto')
//   - Backdrops: ngb-offcanvas-backdrop / .modal-backdrop
//
// OBSERVAÇÃO MODAL (da screenshot fornecida pelo usuário):
//   Título: "Criar Instrumento/Procedimento Avaliativo"
//   Toggles: Atribuir nota (ON default), Recuperação Contínua, Recuperação Compensatória
//   Sal btn: button.btn-success com texto "Salvar" e ícone de disquete
// ============================================================================

import { loginEducaDF } from './educadf.login.js';
import { TIMING } from './educadf.selectors.js';

// ============================================================================
// HELPER: Remove backdrops que bloqueiam cliques (mesmo padrão do Python)
// ============================================================================
async function removerBackdrops(page) {
  await page.evaluate(() => {
    document.querySelectorAll('ngb-offcanvas-backdrop, .offcanvas-backdrop, .modal-backdrop')
      .forEach(el => el.remove());
    document.body.classList.remove('modal-open', 'offcanvas-open');
    document.body.style.overflow = 'auto';
  }).catch(() => {});
}

// ============================================================================
// HELPER: Seleciona opção em ng-select do Angular pelo placeholder e valor
// Baseado DIRETAMENTE na função selecionar_ng_select() do educadf.py
// ============================================================================
async function selecionarNgSelect(page, placeholder, valor, timeout = 8000) {
  console.log(`[educadf.pap] ng-select[placeholder="${placeholder}"] = "${valor}"`);

  const ng = page.locator(`ng-select[placeholder="${placeholder}"]`);
  const found = await ng.count();
  if (!found) {
    console.warn(`[educadf.pap] ng-select[placeholder="${placeholder}"] não encontrado`);
    return false;
  }

  // Normalização para comparação robusta
  // Remove ' - ' (EDUCADF usa '8º ANO - A', EDUCA.MELHOR usa '8º ANO A')
  const normalize = (s) => s.trim().toUpperCase()
    .normalize('NFC')
    .replace(/°/g, 'º')
    .replace(/\s+-\s+/g, ' ')  // '8º ANO - A' → '8º ANO A'
    .replace(/\s+/g, ' ');

  const target = normalize(valor);

  // ── Estratégia 1: Digita e filtra ─────────────────────────────────────────
  await ng.click();
  await page.waitForTimeout(500);

  const inputField = ng.locator("input[type='text']").first();
  const hasSearch = (await inputField.count()) > 0;

  const searchText = valor.substring(0, 25);
  if (hasSearch) {
    await inputField.fill(searchText);
  } else {
    await page.keyboard.type(searchText, { delay: 30 });
  }
  await page.waitForTimeout(1500);

  // Verifica opções visíveis
  const allOpts = page.locator('.ng-dropdown-panel .ng-option');
  const count = await allOpts.count();
  for (let i = 0; i < count; i++) {
    const t = (await allOpts.nth(i).textContent()) || '';
    if (normalize(t) === target || normalize(t).includes(target)) {
      await allOpts.nth(i).click();
      await page.waitForTimeout(800);
      console.log(`[educadf.pap] ✅ ng-select "${placeholder}" → "${valor}" (estratégia 1)`);
      return true;
    }
  }

  // Fecha e tenta estratégia 2: limpa e lista todas as opções
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  await ng.click();
  await page.waitForTimeout(500);

  if (hasSearch) {
    const inp2 = ng.locator("input[type='text']").first();
    if ((await inp2.count()) > 0) await inp2.fill('');
    await page.waitForTimeout(800);
  }

  const panel = page.locator('.ng-dropdown-panel-items');
  if ((await panel.count()) === 0) {
    await page.keyboard.press('Escape');
    return false;
  }

  // Scroll manual (virtual scrolling)
  const seen = new Set();
  let staleCount = 0;

  for (let round = 0; round < 50; round++) {
    const opts = page.locator('.ng-dropdown-panel .ng-option');
    const n = await opts.count();
    for (let i = 0; i < n; i++) {
      const t = (await opts.nth(i).textContent()) || '';
      const tn = normalize(t);
      seen.add(tn);
      if (tn === target || tn.includes(target)) {
        await opts.nth(i).click();
        await page.waitForTimeout(800);
        console.log(`[educadf.pap] ✅ ng-select "${placeholder}" → "${valor}" (scroll round ${round})`);
        return true;
      }
    }
    const prevSize = seen.size;
    await panel.evaluate(el => el.scrollTop += 250);
    await page.waitForTimeout(300);
    if (seen.size === prevSize) {
      staleCount++;
      if (staleCount >= 4) break;
    } else {
      staleCount = 0;
    }
  }

  console.warn(`[educadf.pap] ❌ ng-select "${placeholder}" → "${valor}" não encontrado`);
  await page.keyboard.press('Escape');
  return false;
}

// ============================================================================
// HELPER: Preenche o date picker customizado do EDUCADF
// O portal mostra datas no formato "DD Mmm, YYYY" (ex: "06 Abr, 2026")
// Estratégia: clicar → selecionar tudo → digitar ISO date → Tab para confirmar
// ============================================================================
const MESES_PT = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];

function formatarDataEducaDF(dataStr) {
  // Entrada: "2026-04-06" (ISO) ou Date
  // Saída: "06 Abr, 2026" (formato do picker do EDUCADF)
  if (!dataStr) return '';
  try {
    const d = new Date(dataStr + 'T12:00:00'); // evita problema de timezone
    if (isNaN(d.getTime())) return '';
    const dia  = String(d.getDate()).padStart(2, '0');
    const mes  = MESES_PT[d.getMonth()];
    const ano  = d.getFullYear();
    return `${dia} ${mes}, ${ano}`;
  } catch {
    return '';
  }
}

async function preencherDatePicker(page, selector, dataStr) {
  const dataFormatada = formatarDataEducaDF(dataStr);
  if (!dataFormatada) {
    console.warn('[educadf.pap] Data inválida ou vazia, pulando campo Data.');
    return false;
  }

  try {
    const input = page.locator(selector).first();
    if ((await input.count()) === 0) return false;

    await input.click();
    await page.waitForTimeout(500);

    // Seleciona todo o conteúdo e substitui
    await page.keyboard.press('Control+A');
    await page.waitForTimeout(200);
    await page.keyboard.type(dataFormatada, { delay: 60 });
    await page.waitForTimeout(400);

    // Pressiona Tab para confirmar o picker
    await page.keyboard.press('Tab');
    await page.waitForTimeout(600);

    console.log(`[educadf.pap] Data: "${dataFormatada}"`);
    return true;
  } catch (err) {
    console.warn(`[educadf.pap] Date picker falhou: ${err.message}`);
    return false;
  }
}

// ============================================================================
// HELPER: Seleciona opção em ng-select DENTRO DO MODAL
// Utilizado para o campo "Tipo" que é um ng-select no modal
// ============================================================================
async function selecionarTipoNoModal(page, valor) {
  if (!valor) return false;
  console.log(`[educadf.pap] Tipo: "${valor}"`);

  // O campo Tipo do modal é um ng-select sem placeholder fixo conhecido.
  // Tenta identificar pelo contexto: é o primeiro ng-select visível no modal.
  try {
    // Localiza ng-select dentro do modal
    const modalNgSelect = page.locator('.modal ng-select, [role="dialog"] ng-select').first();
    if ((await modalNgSelect.count()) === 0) {
      // Fallback: pode ser um <select> nativo
      const nativeSelect = page.locator('.modal select, [role="dialog"] select').first();
      if ((await nativeSelect.count()) > 0) {
        await nativeSelect.selectOption({ label: valor });
        return true;
      }
      return false;
    }

    await modalNgSelect.click();
    await page.waitForTimeout(500);

    // Digita para filtrar
    const inp = modalNgSelect.locator("input[type='text']").first();
    if ((await inp.count()) > 0) {
      await inp.fill(valor.substring(0, 20));
    } else {
      await page.keyboard.type(valor.substring(0, 20), { delay: 40 });
    }
    await page.waitForTimeout(1200);

    // Clica na primeira opção que contenha o texto
    const opts = page.locator('.ng-dropdown-panel .ng-option');
    const n = await opts.count();
    for (let i = 0; i < n; i++) {
      const t = (await opts.nth(i).textContent()) || '';
      if (t.trim().toUpperCase().includes(valor.trim().toUpperCase())) {
        await opts.nth(i).click();
        await page.waitForTimeout(600);
        console.log(`[educadf.pap] ✅ Tipo "${valor}" selecionado`);
        return true;
      }
    }

    // Se não achou, clica na primeira opção disponível (menos ruim do que deixar vazio)
    if (n > 0) {
      const firstText = (await opts.first().textContent()) || '';
      await opts.first().click();
      await page.waitForTimeout(500);
      console.warn(`[educadf.pap] Tipo não encontrado exato, selecionou: "${firstText.trim()}"`);
      return true;
    }

    await page.keyboard.press('Escape');
    return false;
  } catch (err) {
    console.warn(`[educadf.pap] Tipo seleção falhou: ${err.message}`);
    return false;
  }
}

// ============================================================================
// EXPORTAÇÃO PRINCIPAL
// ============================================================================

/**
 * Exporta a estrutura do PAP (item de Avaliação Bimestral) para o EDUCADF.
 *
 * @param {import('./educadf.browser.js').EducaDFBrowser} session
 * @param {Object} credentials - { login, senha, perfil }
 * @param {Object} plano       - Dados do plano EDUCA.MELHOR
 */
export async function exportarPAPEducaDF(session, credentials, plano) {
  const page = session.page;
  const startedAt = Date.now();

  if (!page) return { ok: false, message: 'Sessão do browser não está ativa.', durationMs: 0 };

  const item = plano.item;
  if (!item) return { ok: false, message: 'Nenhum item de Avaliação Bimestral no plano.', durationMs: 0 };

  try {
    // ══════════════════════════════════════════════════════════════════════
    // PASSO 1: Login
    // ══════════════════════════════════════════════════════════════════════
    console.log('[educadf.pap] 1/7 Login...');
    const loginResult = await loginEducaDF(session, credentials);
    if (!loginResult.ok) {
      return { ok: false, message: `Falha no login: ${loginResult.message}`, durationMs: Date.now() - startedAt, errorCode: loginResult.errorCode };
    }
    await session.screenshot('pap_01_pos_login');
    await removerBackdrops(page);
    await session.delay(TIMING.postLoginDelay);

    // ══════════════════════════════════════════════════════════════════════
    // PASSO 2: Menu lateral → "Diário de Classe"
    // Baseado no Python: span:text-is('Matrícula') → aqui é span:"Diário de Classe"
    // ══════════════════════════════════════════════════════════════════════
    console.log('[educadf.pap] 2/7 Clicando em "Diário de Classe" na sidebar...');
    try {
      // Tenta via span (mesmo padrão do Python para "Matrícula")
      await page.locator("span:text-is('Diário de Classe')").first().click({ timeout: 8000 });
    } catch {
      // Fallback: link
      await page.locator("a:has-text('Diário de Classe')").first().click({ timeout: 8000 });
    }
    await session.delay(TIMING.navigationDelay);
    await session.screenshot('pap_02_diario_classe');

    // ══════════════════════════════════════════════════════════════════════
    // PASSO 3: Submenu → "Registro das Informações"
    // ══════════════════════════════════════════════════════════════════════
    console.log('[educadf.pap] 3/7 Clicando em "Registro das Informações"...');
    await page.locator("a:has-text('Registro das Informações')").first().click({ timeout: 8000 });
    await page.waitForLoadState('networkidle', { timeout: 20000 });
    await session.delay(TIMING.navigationDelay);
    await removerBackdrops(page);
    await session.screenshot('pap_03_registro_informacoes');

    // ══════════════════════════════════════════════════════════════════════
    // PASSO 4: Filtros laterais
    // Ano (2026) e Regional já pré-selecionados.
    // Preencher: Turma/Agrupamento + Professor.
    // Componente deixar vazio.
    // ══════════════════════════════════════════════════════════════════════
    console.log(`[educadf.pap] 4/7 Aplicando filtros — Turma: ${plano.turmas}`);

    // ── Turma: tenta variações de placeholder ───────────────────────────────
    // O placeholder exato pode ser: 'Turma/Agrupamento', 'Turma', 'Agrupamento'
    // Descobre qual existe na página e usa esse
    const placeholdersTurma = ['Turma/Agrupamento', 'Turma', 'Agrupamento', 'Selecione a Turma'];
    let turmaOk = false;
    for (const ph of placeholdersTurma) {
      const exists = (await page.locator(`ng-select[placeholder="${ph}"]`).count()) > 0;
      if (exists) {
        console.log(`[educadf.pap] Filtro Turma encontrado com placeholder: "${ph}"`);
        turmaOk = await selecionarNgSelect(page, ph, plano.turmas);
        if (turmaOk) break;
      }
    }
    if (!turmaOk) {
      console.warn('[educadf.pap] ⚠️  Nenhum ng-select de Turma encontrado — continuando sem filtrar turma');
    }
    await page.waitForTimeout(800);

    // ── Professor: tenta variações de placeholder ────────────────────────────
    if (plano.professorNome) {
      const placeholdersProfessor = ['Professor', 'Docente', 'Selecione o Professor', 'Professor/Docente'];
      let profOk = false;
      for (const ph of placeholdersProfessor) {
        const exists = (await page.locator(`ng-select[placeholder="${ph}"]`).count()) > 0;
        if (exists) {
          console.log(`[educadf.pap] Filtro Professor encontrado com placeholder: "${ph}"`);
          profOk = await selecionarNgSelect(page, ph, plano.professorNome);
          if (profOk) break;
        }
      }
      if (!profOk) {
        console.warn('[educadf.pap] ⚠️  ng-select Professor não encontrado — continuando sem filtrar professor');
      }
    }

    await session.screenshot('pap_04_filtros');

    // Clicar Filtrar (tolerante a timeout)
    console.log('[educadf.pap] Clicando em Filtrar...');
    try {
      await page.locator("button:has-text('Filtrar')").first().click({ timeout: 8000 });
      // Aguarda de forma tolerante: tenta networkidle mas não falha se demorar
      await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() =>
        console.warn('[educadf.pap] networkidle timeout após Filtrar — continuando...')
      );
    } catch (filtrarErr) {
      console.warn(`[educadf.pap] Botão Filtrar não encontrado ou falhou: ${filtrarErr.message}`);
    }
    await session.delay(2000);
    await session.screenshot('pap_04b_pos_filtrar');

    // ══════════════════════════════════════════════════════════════════════
    // PASSO 5: Tab/menu superior → "Registro de Procedimento Avaliativo"
    // ══════════════════════════════════════════════════════════════════════
    console.log('[educadf.pap] 5/7 Abrindo aba "Registro de Procedimento Avaliativo"...');
    await page.locator("a:has-text('Registro de Procedimento Avaliativo')").first().click({ timeout: 10000 });
    await session.delay(TIMING.navigationDelay);
    await session.screenshot('pap_05_aba_procedimento');

    // ══════════════════════════════════════════════════════════════════════
    // PASSO 6: Botão "Criar procedimento avaliativo" (azul)
    // ══════════════════════════════════════════════════════════════════════
    console.log('[educadf.pap] 6/7 Clicando em "Criar procedimento avaliativo"...');
    await page.locator("button:has-text('Criar procedimento avaliativo')").first().click({ timeout: 10000 });
    await session.delay(TIMING.actionDelay + 500);
    await session.screenshot('pap_06_modal_aberto');

    // ══════════════════════════════════════════════════════════════════════
    // PASSO 7: Preencher modal "Criar Instrumento/Procedimento Avaliativo"
    //
    // Campos confirmados pela screenshot do usuário:
    //   [Nome]         → input texto required (borda laranja)
    //   [Tipo]         → ng-select (dropdown Angular)
    //   [Data]         → date picker "DD Mmm, YYYY"
    //   [Atribuir nota]→ toggle JÁ ATIVO por padrão → NÃO TOCAR
    //   [Observações]  → textarea
    //   [Salvar]       → button.btn-success
    // ══════════════════════════════════════════════════════════════════════
    console.log('[educadf.pap] 7/7 Preenchendo modal...');

    // Aguarda modal aparecer (título identificador)
    await page.waitForSelector('text=Criar Instrumento/Procedimento Avaliativo', { timeout: TIMING.defaultTimeout });
    await session.delay(500);

    // — Campo: Nome —
    const nomeAtividade = item.atividade || 'Avaliação Bimestral';
    // O campo Nome é o primeiro input visível dentro do modal
    const nomeInput = page.locator(
      '.modal input[type="text"]:visible, [role="dialog"] input[type="text"]:visible'
    ).first();
    await nomeInput.waitFor({ state: 'visible', timeout: 8000 });
    await nomeInput.fill(nomeAtividade);
    console.log(`[educadf.pap] Nome: "${nomeAtividade}"`);
    await page.waitForTimeout(400);

    // — Campo: Tipo (ng-select no modal) —
    if (item.tipo_avaliacao) {
      await selecionarTipoNoModal(page, item.tipo_avaliacao);
      await page.waitForTimeout(500);
    }

    // — Campo: Data (date picker customizado) —
    const dataStr = item.data_inicio || item.data;
    if (dataStr) {
      const dataSel = '.modal input[placeholder], [role="dialog"] input[placeholder]';
      // O inputdo date picker tem placeholder com formato de data
      const dateInputs = page.locator('.modal input, [role="dialog"] input');
      const inputCount = await dateInputs.count();
      // Identifica o input de data: é aquele que contém uma data (não é o Nome)
      for (let i = 0; i < inputCount; i++) {
        const inp = dateInputs.nth(i);
        const val = await inp.inputValue().catch(() => '');
        const placeholder = await inp.getAttribute('placeholder').catch(() => '');
        // O date picker já vem com uma data preenchida ("06 Abr, 2026")
        if (val.match(/\d{2}\s+\w{3},?\s+\d{4}/) || placeholder?.toLowerCase().includes('data')) {
          await preencherDatePickerByLocator(page, inp, dataStr);
          break;
        }
      }
    }

    // — Toggle "Atribuir nota" → JÁ ATIVO, não tocar —
    // Recuperação Contínua e Recuperação Compensatória → NÃO TOCAR

    // — Campo: Observações —
    if (item.descricao) {
      const obs = page.locator('.modal textarea, [role="dialog"] textarea').first();
      if ((await obs.count()) > 0) {
        await obs.fill(item.descricao);
        console.log(`[educadf.pap] Observações: "${item.descricao.substring(0, 60)}${item.descricao.length > 60 ? '...' : ''}"`);
      }
    }

    await session.screenshot('pap_07_modal_preenchido');

    // — Salvar —
    console.log('[educadf.pap] Clicando em Salvar...');
    // Botão Salvar = button.btn-success com texto "Salvar"
    const btnSalvar = page.locator(
      '.modal button.btn-success, .modal button:has-text("Salvar"), [role="dialog"] button.btn-success'
    ).first();
    await btnSalvar.click({ timeout: 8000 });
    await session.delay(TIMING.actionDelay + 1000);
    await session.screenshot('pap_08_pos_salvar');

    // ── Verificar sucesso ──────────────────────────────────────────────
    // O modal some = sucesso. Fallback: verifica alert-success.
    const modalAindaAberto = await page.locator('text=Criar Instrumento/Procedimento Avaliativo').isVisible().catch(() => false);
    const alertSucesso = await page.locator('.alert-success, .toast-success').isVisible().catch(() => false);
    const ok = !modalAindaAberto || alertSucesso;

    console.log(`[educadf.pap] ✅ Resultado: modalFechado=${!modalAindaAberto}, alertSucesso=${alertSucesso}`);

    return {
      ok,
      message: ok
        ? `Procedimento "${nomeAtividade}" criado no EDUCADF para ${plano.turmas} · ${plano.bimestre}.`
        : `Modal ainda aberto após salvar — pode ter ocorrido erro de validação no EDUCADF.`,
      durationMs: Date.now() - startedAt,
    };

  } catch (err) {
    const errorScreenshot = await session.screenshot('pap_erro').catch(() => null);
    console.error(`[educadf.pap] ❌ Erro: ${err.message}`);
    return {
      ok: false,
      message: `Erro durante a exportação: ${err.message}`,
      screenshotPath: errorScreenshot,
      durationMs: Date.now() - startedAt,
      errorCode: 'PAP_EXPORT_ERROR',
    };
  }
}

// ── Helper interno para preencher date picker por locator ──────────────────
async function preencherDatePickerByLocator(page, locator, dataStr) {
  const dataFormatada = formatarDataEducaDF(dataStr);
  if (!dataFormatada) return;
  try {
    await locator.click();
    await page.waitForTimeout(300);
    await page.keyboard.press('Control+A');
    await page.waitForTimeout(150);
    await page.keyboard.type(dataFormatada, { delay: 50 });
    await page.waitForTimeout(400);
    await page.keyboard.press('Tab');
    await page.waitForTimeout(500);
    console.log(`[educadf.pap] Data: "${dataFormatada}"`);
  } catch (err) {
    console.warn(`[educadf.pap] preencherDatePickerByLocator falhou: ${err.message}`);
  }
}

export default { exportarPAPEducaDF };
