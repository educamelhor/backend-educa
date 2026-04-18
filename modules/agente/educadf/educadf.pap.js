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
// MAPEAMENTO DE DISCIPLINAS: EDUCA.MELHOR → EDUCADF (Componente)
// Cada escola pode ter nomes diferentes para o mesmo componente.
// Adicione mais entradas conforme necessário.
// ============================================================================
const DISCIPLINA_EDUCADF_MAP = {
  // EDUCA.MELHOR nome (uppercase) → EDUCADF Componente (como aparece no dropdown)
  'GEOMETRIA':     'PARTE DIVERSIFICADA II',
  'PRATICA ESTUDANTIL': 'PARTE DIVERSIFICADA II',
  // MATEMÁTICA, PORTUGUÊS, etc. tendem a manter o mesmo nome
  // Adicione aqui novos mapeamentos conforme descobertos:
};

/**
 * Converte o nome da disciplina do EDUCA.MELHOR para o Componente correspondente no EDUCADF.
 * @param {string} disciplina - Nome no EDUCA.MELHOR (ex: 'Geometria')
 * @returns {string} - Nome no EDUCADF (ex: 'PARTE DIVERSIFICADA II')
 */
function mapearDisciplina(disciplina) {
  if (!disciplina) return disciplina;
  const upper = String(disciplina).trim().toUpperCase();
  return DISCIPLINA_EDUCADF_MAP[upper] || disciplina;
}

/**
 * Comparação fuzzy de nomes de professores:
 * divide em tokens, e verifica se há sobreposição suficiente.
 * Useful para: 'MARIA MACIA REJAINE MATIAS DE ALMEIDA' vs 'MA MACIA REJAINE M DE ALMEIDA'
 */
function nomesCorrespondem(nomeA, nomeB) {
  if (!nomeA || !nomeB) return false;
  const norm = (s) => String(s)
    .toUpperCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // remove acentos
    .replace(/[^A-Z0-9 ]/g, '')
    .split(/\s+/)
    .filter(t => t.length > 2); // ignora partículas como 'DE', 'DA'

  const tokensA = norm(nomeA);
  const tokensB = norm(nomeB);
  const matches = tokensA.filter(t => tokensB.some(tb => tb.startsWith(t) || t.startsWith(tb)));
  // Considera correspondência se pelo menos 60% dos tokens do nome menor coincidem
  const menor = Math.min(tokensA.length, tokensB.length);
  return menor > 0 && matches.length >= Math.ceil(menor * 0.6);
}

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
async function selecionarNgSelect(page, placeholder, valor, timeout = 8000, fuzzyFn = null) {
  console.log(`[educadf.pap] ng-select[placeholder="${placeholder}"] = "${valor}"`);

  const ng = page.locator(`ng-select[placeholder="${placeholder}"]`);
  const found = await ng.count();
  if (!found) {
    console.warn(`[educadf.pap] ng-select[placeholder="${placeholder}"] não encontrado`);
    return false;
  }

  // Normalização para comparação robusta
  const normalize = (s) => String(s).trim().toUpperCase()
    .normalize('NFC')
    .replace(/°/g, 'º')
    .replace(/\s+-\s+/g, ' ')  // '8º ANO - A' → '8º ANO A'
    .replace(/\s+/g, ' ');

  const target = normalize(valor);

  // Predicado de match — por padrão exato/contains, mas permite fuzzy externo
  const isMatch = (t) => {
    const tn = normalize(t);
    if (tn === target || tn.includes(target) || target.includes(tn)) return true;
    if (fuzzyFn && fuzzyFn(t, valor)) return true;
    return false;
  };

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
    if (isMatch(t)) {
      await allOpts.nth(i).click();
      await page.waitForTimeout(800);
      console.log(`[educadf.pap] ✅ ng-select "${placeholder}" → "${t.trim()}" (estratégia 1)`);
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

  // Scroll manual (virtual scrolling) — loga tudo para diagnóstico
  const seen = new Set();
  let staleCount = 0;

  for (let round = 0; round < 50; round++) {
    const opts = page.locator('.ng-dropdown-panel .ng-option');
    const n = await opts.count();
    for (let i = 0; i < n; i++) {
      const t = (await opts.nth(i).textContent()) || '';
      const tn = normalize(t);
      if (!seen.has(tn)) {
        seen.add(tn);
        console.log(`[educadf.pap]   opção disponível: "${t.trim()}"`);
      }
      if (isMatch(t)) {
        await opts.nth(i).click();
        await page.waitForTimeout(800);
        console.log(`[educadf.pap] ✅ ng-select "${placeholder}" → "${t.trim()}" (scroll round ${round})`);
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
  console.warn(`[educadf.pap]   Opções vistas: ${[...seen].join(' | ')}`);
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
    await page.waitForLoadState('domcontentloaded', { timeout: 30000 });
    await session.delay(TIMING.navigationDelay);
    await removerBackdrops(page);
    await session.screenshot('pap_03_registro_informacoes');

    // ══════════════════════════════════════════════════════════════════════
    // PASSO 4: Filtros laterais
    // Ano (2026) e Regional já pré-selecionados.
    // Preencher: Turma/Agrupamento + Professor + Componente
    // IMPORTANTE: Componente deve usar o nome do EDUCADF (mapeado da disciplina)
    // ══════════════════════════════════════════════════════════════════════
    const componenteEducaDF = mapearDisciplina(plano.disciplina);
    console.log(`[educadf.pap] 4/7 Aplicando filtros — Turma: ${plano.turmas} | Componente: ${componenteEducaDF}`);

    // ── Aguarda os ng-selects da página carregarem (até 15s) ────────────
    await page.waitForSelector('ng-select', { timeout: 15000 }).catch(() =>
      console.warn('[educadf.pap] ng-select não apareceu em 15s — tentando assim mesmo...')
    );
    await page.waitForTimeout(1000);

    // ── Turma (OBRIGATÓRIO): sem turma não prosseguir ─────────────────
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
      // Turma é crítica — sem ela o evento errado pode ser clicado
      throw new Error(`Filtro Turma não encontrado ou não selecionado para "${plano.turmas}". Verifique se a página carregou corretamente.`);
    }
    await page.waitForTimeout(800);

    // ── Professor: usa fuzzy matching pois nomes podem diferir entre sistemas ─
    if (plano.professorNome) {
      const placeholdersProfessor = ['Professor', 'Docente', 'Selecione o Professor', 'Professor/Docente'];
      let profOk = false;
      for (const ph of placeholdersProfessor) {
        const exists = (await page.locator(`ng-select[placeholder="${ph}"]`).count()) > 0;
        if (exists) {
          console.log(`[educadf.pap] Filtro Professor encontrado com placeholder: "${ph}"`);
          profOk = await selecionarNgSelect(page, ph, plano.professorNome, 8000, nomesCorrespondem);
          if (profOk) break;
        }
      }
      if (!profOk) {
        console.warn('[educadf.pap] ⚠️  ng-select Professor não encontrado — continuando sem filtrar professor');
      }
    }
    await page.waitForTimeout(800);

    // ── Componente: usa o nome mapeado do EDUCADF ─────────────────────────────
    if (componenteEducaDF) {
      const placeholdersComp = ['Componente', 'Componente Curricular', 'Disciplina', 'Matéria'];
      let compOk = false;
      for (const ph of placeholdersComp) {
        const exists = (await page.locator(`ng-select[placeholder="${ph}"]`).count()) > 0;
        if (exists) {
          console.log(`[educadf.pap] Filtro Componente encontrado com placeholder: "${ph}"`);
          compOk = await selecionarNgSelect(page, ph, componenteEducaDF);
          if (compOk) break;
        }
      }
      if (!compOk) {
        console.warn(`[educadf.pap] ⚠️  Componente "${componenteEducaDF}" não selecionado — continuando`);
      }
    }

    await session.screenshot('pap_04_filtros');

    // Clicar Filtrar
    console.log('[educadf.pap] Clicando em Filtrar...');
    try {
      await page.locator("button:has-text('Filtrar')").first().click({ timeout: 8000 });
      await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() =>
        console.warn('[educadf.pap] domcontentloaded timeout após Filtrar — continuando...')
      );
    } catch (filtrarErr) {
      console.warn(`[educadf.pap] Botão Filtrar não encontrado ou falhou: ${filtrarErr.message}`);
    }
    await session.delay(3000);
    await session.screenshot('pap_04b_pos_filtrar');

    // ══════════════════════════════════════════════════════════════════════
    // PASSO 5: Clicar num evento do calendário (fc-event)
    // FLUXO CORRETO: após filtrar, o calendário mostra os eventos de aula.
    // Clicar em qualquer evento abre o DIÁRIO DA AULA com as abas:
    //   "Registro de Aula" | "Registro de Frequência" |
    //   "Registro de Procedimentos Avaliativos" | "Observações do Diário" | etc.
    // ══════════════════════════════════════════════════════════════════════
    console.log('[educadf.pap] 5/7 Clicando num evento do calendário para abrir o diário...');

    await session.delay(2000);
    await removerBackdrops(page);
    await session.screenshot('pap_04c_calendario');

    // Helper de normalização para comparar turma/componente com texto do evento
    const normEv = (s) => String(s)
      .toUpperCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // remove acentos
      .replace(/[^A-Z0-9\s]/g, ' ')                     // remove pontuação
      .replace(/\s+/g, ' ').trim();

    const turmaNorm   = normEv(plano.turmas);       // ex: '9 ANO I'
    const compNorm    = normEv(componenteEducaDF);  // ex: 'MATEMATICA'
    const bimestreNum = String(plano.bimestre || '').replace(/[^\d]/g, ''); // '1º Bimestre' → '1'

    // Tokens mínimos que devem aparecer no texto do evento para validar a turma
    // Ex: '9 ANO I' → tokens ['9', 'ANO', 'I']; filtra tokens de 1 char (exceto números de turma)
    const turmaTkns = turmaNorm.split(' ').filter(t => t.length > 0);
    const compTkns  = compNorm.split(' ').filter(t => t.length > 2);

    const eventoCorreto = (txt) => {
      const n = normEv(txt);
      const turmaOkEv = turmaTkns.every(t => n.includes(t));
      const compOkEv  = compTkns.some(c => n.includes(c));
      return turmaOkEv && compOkEv;
    };

    // Busca eventos fc-event 
    const fcEventos = page.locator('a.fc-event, .fc-event a, .fc-daygrid-event');
    const totalFcEventos = await fcEventos.count();
    console.log(`[educadf.pap] Eventos de aula no calendário: ${totalFcEventos} | Buscando Turma="${plano.turmas}" + Componente="${componenteEducaDF}"`);

    let eventoClicado = false;

    for (let i = 0; i < totalFcEventos && !eventoClicado; i++) {
      const ev  = fcEventos.nth(i);
      const txt = (await ev.textContent().catch(() => '')) || '';

      if (!eventoCorreto(txt)) continue; // pula eventos da turma/componente errados

      // Filtra pelo bimestre se disponível (preferência mas não obrigatório)
      const bimestreMatch = !bimestreNum || txt.includes(`${bimestreNum}º BIMESTRE`);
      if (!bimestreMatch) continue;

      try {
        await ev.scrollIntoViewIfNeeded().catch(() => {});
        await ev.click({ timeout: 10000 });
        eventoClicado = true;
        console.log(`[educadf.pap] ✅ Evento correto clicado [${i}]: "${txt.substring(0, 80)}"`);
      } catch (err) {
        console.warn(`[educadf.pap] Clique evento [${i}] falhou: ${err.message}`);
      }
    }

    // Segunda tentativa sem exigir bimestre específico (aceita qualquer evento da turma+componente)
    if (!eventoClicado) {
      for (let i = 0; i < totalFcEventos && !eventoClicado; i++) {
        const ev  = fcEventos.nth(i);
        const txt = (await ev.textContent().catch(() => '')) || '';
        if (!eventoCorreto(txt)) continue;
        try {
          await ev.scrollIntoViewIfNeeded().catch(() => {});
          await ev.click({ timeout: 10000 });
          eventoClicado = true;
          console.log(`[educadf.pap] ✅ Evento (qualquer bimestre) [${i}]: "${txt.substring(0, 80)}"`);
        } catch (err) {
          console.warn(`[educadf.pap] Clique evento [${i}] segunda tentativa falhou: ${err.message}`);
        }
      }
    }

    if (!eventoClicado) {
      // Log diagnóstico dos primeiros eventos encontrados
      console.error(`[educadf.pap] ❌ Nenhum evento com Turma="${plano.turmas}" e Componente="${componenteEducaDF}" encontrado!`);
      for (let i = 0; i < Math.min(totalFcEventos, 8); i++) {
        const txt = (await fcEventos.nth(i).textContent().catch(() => '')) || '';
        console.warn(`  Evento[${i}]: "${txt.substring(0, 80)}"`);
      }
      throw new Error(`Nenhum evento de aula correto encontrado para Turma="${plano.turmas}" e Componente="${componenteEducaDF}". Verifique se os filtros foram aplicados.`);
    }

    // Aguarda o diário carregar (exibe abas no topo)
    await session.delay(TIMING.navigationDelay);
    await session.screenshot('pap_05_diario_aula');

    // ══════════════════════════════════════════════════════════════════════
    // PASSO 6: Clicar na aba "Registro de Procedimentos Avaliativos"
    // A aba aparece no menu horizontal após entrar no diário de aula
    // ══════════════════════════════════════════════════════════════════════
    console.log('[educadf.pap] 6/7 Clicando na aba "Registro de Procedimentos Avaliativos"...');

    await removerBackdrops(page);

    const textosProcedimento = [
      'Registro de Procedimentos Avaliativos',
      'Registro de Procedimento Avaliativos',
      'Registro de Procedimento Avaliativo',
      'Procedimentos Avaliativos',
      'Procedimento Avaliativo',
    ];

    let abaClicada = false;
    for (const texto of textosProcedimento) {
      try {
        const loc = page.locator(`a:has-text('${texto}'), [role="tab"]:has-text('${texto}')`).first();
        if (await loc.count() > 0) {
          console.log(`[educadf.pap] Aba encontrada: "${texto}"`);
          await loc.scrollIntoViewIfNeeded().catch(() => {});
          await loc.click({ timeout: 15000 });
          abaClicada = true;
          break;
        }
      } catch (err) {
        console.warn(`[educadf.pap] Aba "${texto}" falhou: ${err.message}`);
      }
    }

    // Fallback JS
    if (!abaClicada) {
      const jsClicked = await page.evaluate(() => {
        const links = [...document.querySelectorAll('a, [role="tab"]')];
        const el = links.find(l => {
          const txt = l.textContent?.toLowerCase() || '';
          return txt.includes('procedimento') && txt.includes('avaliativo');
        });
        if (el) { el.scrollIntoView({ block: 'center' }); el.click(); return el.textContent?.trim(); }
        return null;
      });
      if (jsClicked) {
        console.log(`[educadf.pap] Aba clicada via JS: "${jsClicked}"`);
        abaClicada = true;
      }
    }

    if (!abaClicada) {
      throw new Error('Aba "Registro de Procedimentos Avaliativos" não encontrada. Verifique se o evento do calendário foi clicado corretamente.');
    }

    await session.delay(TIMING.navigationDelay);
    await session.screenshot('pap_06_procedimentos_avaliativos');

    // ── O bimestre já está correto pois clicamos num evento do bimestre certo no calendário ─
    // Apenas remove o offcanvas backdrop que pode bloquear interações
    await removerBackdrops(page);
    await session.delay(500);

    // ══════════════════════════════════════════════════════════════════════
    // PASSO 7: Clicar em "+ Criar procedimento avaliativo"
    // ══════════════════════════════════════════════════════════════════════
    console.log('[educadf.pap] 7/7 Clicando em "+ Criar procedimento avaliativo"...');

    const textosBotaoCriar = [
      'Criar procedimento avaliativo',
      'Criar Procedimento Avaliativo',
      'Criar Procedimento',
      'Novo Procedimento',
    ];

    let botaoCriarClicado = false;
    for (const texto of textosBotaoCriar) {
      try {
        const loc = page.locator(`button:has-text('${texto}')`).first();
        if (await loc.count() > 0) {
          console.log(`[educadf.pap] Botão Criar encontrado: "${texto}"`);
          await loc.click({ timeout: 20000 });
          botaoCriarClicado = true;
          break;
        }
      } catch (err) {
        console.warn(`[educadf.pap] Botão "${texto}" falhou: ${err.message}`);
      }
    }

    // Fallback JS: qualquer botão azul (btn-primary) visível
    if (!botaoCriarClicado) {
      const jsClicked = await page.evaluate(() => {
        const btns = [...document.querySelectorAll('button.btn-primary, button.btn-success')];
        const el = btns.find(b => b.textContent?.toLowerCase().includes('criar') || b.textContent?.toLowerCase().includes('novo') || b.textContent?.toLowerCase().includes('adicionar'));
        if (el) { el.scrollIntoView({ block: 'center' }); el.click(); return true; }
        return false;
      });
      if (jsClicked) {
        console.log('[educadf.pap] Botão Criar clicado via JS fallback.');
        botaoCriarClicado = true;
      }
    }

    if (!botaoCriarClicado) {
      throw new Error('Botão "Criar procedimento avaliativo" não encontrado na página.');
    }

    // Remove quaisquer backdrops e aguarda o modal abrir
    await removerBackdrops(page);
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

    // — PREENCHE CAMPOS DO MODAL VIA JAVASCRIPT —
    // O ngb-modal-window (aria-modal=true) bloqueia TODOS os clicks do Playwright
    // (click, triple-click, fill, pressSequentially). A única solução é usar
    // page.evaluate() com manipulação DOM nativa que ignora pointer-events.

    const nomeAtividade = item.atividade || 'Avaliação Bimestral';

    // Helper: dispara os eventos que Angular precisa para marcar o campo como válido
    const dispatchAngularOk = async (selector) => {
      await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) return;
        ['input', 'change', 'keyup', 'blur'].forEach(ev =>
          el.dispatchEvent(new Event(ev, { bubbles: true, cancelable: true }))
        );
      }, selector);
    };

    // — Campo: Nome —
    // O input de Nome é o ÚNICO input[type="text"] sem size=1 / maxlength<=5 (que são os date-picker)
    const nomeOk = await page.evaluate((nome) => {
      const modal = document.querySelector('ngb-modal-window');
      if (!modal) return false;
      const inputs = [...modal.querySelectorAll('input')];
      const nomeInp = inputs.find(inp => {
        const t = inp.type || 'text';
        if (t !== 'text' && t !== '') return false;
        const sz = parseInt(inp.getAttribute('size') || '100');
        const ml = parseInt(inp.getAttribute('maxlength') || '9999');
        return sz > 2 && ml > 10; // date-picker parts têm size=1, maxlength=5
      });
      if (!nomeInp) return false;
      // Foca, limpa, preenche e dispara eventos Angular
      nomeInp.focus();
      nomeInp.value = '';
      nomeInp.dispatchEvent(new Event('input', { bubbles: true }));
      nomeInp.value = nome;
      ['input', 'change', 'keyup'].forEach(ev =>
        nomeInp.dispatchEvent(new Event(ev, { bubbles: true }))
      );
      nomeInp.blur();
      nomeInp.dispatchEvent(new Event('blur', { bubbles: true }));
      return true;
    }, nomeAtividade);
    console.log(`[educadf.pap] Nome ${nomeOk ? '✅' : '⚠️'}: "${nomeAtividade}"`);
    await page.waitForTimeout(500);

    // — Campo: Tipo (ng-select no modal) —
    // O ng-select ainda é clicável pois usa Playwright sobre él mesmo (não sobre o input)
    if (item.tipo_avaliacao) {
      await selecionarTipoNoModal(page, item.tipo_avaliacao);
      await page.waitForTimeout(800);
    }

    // — Campo: Data —
    // O date picker do Angular usa múltiplos inputs pequenos (size=1, maxlength=5).
    // Usamos JS para preencher a data no formato correto do plano.
    const dataStr = item.data_inicio || item.data;
    if (dataStr) {
      const dataFormatada = formatarDataEducaDF(dataStr); // ex: "24 Abr, 2026"
      if (dataFormatada) {
        const dataSet = await page.evaluate((dataFmt) => {
          // O date picker do ngb tem 3 inputs: dia, mês, ano
          // Tenta encontrar o campo que contém uma data já preenchida e substituir
          const modal = document.querySelector('ngb-modal-window');
          if (!modal) return false;
          // Tenta o input com valor no formato "DD Mmm, YYYY" ou qualquer input com data
          const allInputs = [...modal.querySelectorAll('input')];
          const dateInp = allInputs.find(inp => {
            const val = inp.value || '';
            return val.match(/\d{1,2}\s+\w{3}/) || /^(data|date)/i.test(inp.placeholder || '');
          });
          if (!dateInp) return false;
          dateInp.focus();
          // Seleciona tudo e digita via execCommand
          document.execCommand('selectAll');
          dateInp.value = dataFmt;
          ['input', 'change', 'blur'].forEach(ev =>
            dateInp.dispatchEvent(new Event(ev, { bubbles: true }))
          );
          return true;
        }, dataFormatada);
        console.log(`[educadf.pap] Data ${dataSet ? '✅' : '⚠️'}: "${dataFormatada}"`);
      }
    }

    // — Campo: Observações —
    if (item.descricao) {
      await page.evaluate((desc) => {
        const modal = document.querySelector('ngb-modal-window');
        if (!modal) return;
        const ta = modal.querySelector('textarea');
        if (!ta) return;
        ta.focus();
        ta.value = desc;
        ['input', 'change', 'blur'].forEach(ev =>
          ta.dispatchEvent(new Event(ev, { bubbles: true }))
        );
      }, item.descricao);
      console.log(`[educadf.pap] Observações: "${item.descricao.substring(0, 60)}"`);
    }

    // Aguarda Angular estabilizar os validadores
    await page.waitForTimeout(1000);
    await session.screenshot('pap_07_modal_preenchido');

    // — Salvar —
    // IMPORTANTE: usa JS click direto pois o ngb-modal-window intercepta pointer events
    // e o Playwright.click() falha com "subtree intercepts pointer events".
    console.log('[educadf.pap] Clicando em Salvar (via JavaScript)...');
    const salvarOk = await page.evaluate(() => {
      const seletores = [
        'ngb-modal-window button[aria-label="Salvar"]',
        'ngb-modal-window button.btn-success',
        '.modal button.btn-success',
        '.modal button[aria-label="Salvar"]',
        '[role="dialog"] button.btn-success',
      ];
      for (const sel of seletores) {
        const btn = document.querySelector(sel);
        if (btn) {
          btn.scrollIntoView({ block: 'center' });
          // dispatchEvent é mais compatível com Angular do que .click() simples
          btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          return sel;
        }
      }
      return null;
    });

    if (salvarOk) {
      console.log(`[educadf.pap] ✅ Salvar clicado via JS: ${salvarOk}`);
    } else {
      // Fallback final: Playwright com force:true (bypassa pointer-event checks)
      console.warn('[educadf.pap] JS não encontrou botão — tentando force click...');
      const btnSalvar = page.locator(
        'ngb-modal-window button.btn-success, .modal button.btn-success'
      ).first();
      await btnSalvar.click({ timeout: 10000, force: true });
      console.log('[educadf.pap] ✅ Salvar clicado via force click.');
    }

    // Aguarda o modal fechar (dá até 3s)
    await session.delay(3000);
    await session.screenshot('pap_08_pos_salvar');

    // ── Verifica erros de validação no modal (diagnóstico) ─────────────────
    const modalAindaAberto = await page.locator('text=Criar Instrumento/Procedimento Avaliativo').isVisible().catch(() => false);
    if (modalAindaAberto) {
      const errosValidacao = await page.evaluate(() => {
        return [...document.querySelectorAll('.invalid-feedback, .text-danger, .form-text.text-danger')]
          .map(e => e.textContent?.trim()).filter(Boolean);
      });
      const camposInvalidos = await page.evaluate(() => {
        return [...document.querySelectorAll('ngb-modal-window .ng-invalid')]
          .map(el => ({ tag: el.tagName, aria: el.getAttribute('aria-label'), placeholder: el.getAttribute('placeholder') }));
      });
      if (errosValidacao.length > 0) console.warn(`[educadf.pap] Erros validação: ${JSON.stringify(errosValidacao)}`);
      if (camposInvalidos.length > 0) console.warn(`[educadf.pap] Campos inválidos ng-invalid: ${JSON.stringify(camposInvalidos)}`);
    }

    // ── Verificar sucesso ──────────────────────────────────────────────
    const alertSucesso = await page.locator('.alert-success, .toast-success, .swal2-success').isVisible().catch(() => false);
    const ok = !modalAindaAberto || alertSucesso;

    console.log(`[educadf.pap] Resultado: modalFechado=${!modalAindaAberto}, alertSucesso=${alertSucesso}`);

    return {
      ok,
      message: ok
        ? `Procedimento "${nomeAtividade}" criado no EDUCADF para ${plano.turmas} · ${plano.bimestre}.`
        : `Modal ainda aberto após salvar — verifique os logs de validação acima.`,
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
