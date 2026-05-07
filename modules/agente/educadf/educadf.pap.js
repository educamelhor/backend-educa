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
// Atualizado em: 26/04/2026 — confirmado via screenshots do portal EDUCADF
// ============================================================================
const DISCIPLINA_EDUCADF_MAP = {
  // EDUCA.MELHOR nome (uppercase) → EDUCADF Componente (como aparece no dropdown)
  'PORTUGUES':           'LÍNGUA PORTUGUESA',
  'PORTUGUÊS':           'LÍNGUA PORTUGUESA',
  'LINGUA PORTUGUESA':   'LÍNGUA PORTUGUESA',
  'INGLES':              'LEM/INGLÊS',
  'INGLÊS':              'LEM/INGLÊS',
  'LEM INGLES':          'LEM/INGLÊS',
  'CIENCIAS':            'CIÊNCIAS NATURAIS',
  'CIÊNCIAS':            'CIÊNCIAS NATURAIS',
  'ED FISICA':           'EDUCAÇÃO FÍSICA',
  'ED. FISICA':          'EDUCAÇÃO FÍSICA',
  'EDUCACAO FISICA':     'EDUCAÇÃO FÍSICA',
  'EDUCAÇÃO FÍSICA':     'EDUCAÇÃO FÍSICA',
  'PRATICA ESTUDANTIL':  'PARTE DIVERSIFICADA I',
  'PRÁTICA ESTUDANTIL':  'PARTE DIVERSIFICADA I',
  'GEOMETRIA':           'PARTE DIVERSIFICADA II',
  // Sem correspondente no EDUCA.MELHOR — ignorados pelo agente:
  // 'ENSINO RELIGIOSO'   → não existe
  // 'PARTE DIVERSIFICADA III' → não existe
  // Mantidos iguais (não precisam de mapeamento):
  // ARTES, GEOGRAFIA, HISTÓRIA, MATEMÁTICA
};

/**
 * Converte o nome da disciplina do EDUCA.MELHOR → Componente EDUCADF.
 * Normaliza acentos e espaços antes da lookup para maior robustez.
 * @param {string} disciplina - Nome no EDUCA.MELHOR (ex: 'Português')
 * @returns {string} - Nome no EDUCADF (ex: 'LÍNGUA PORTUGUESA')
 */
function mapearDisciplina(disciplina) {
  if (!disciplina) return disciplina;
  const upper = String(disciplina).trim().toUpperCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // remove acentos para lookup
    .replace(/\.\s*/g, ' ').replace(/\s+/g, ' ').trim(); // 'ED. FÍSICA' → 'ED FISICA'
  // Tenta lookup sem acento, mas devolve o valor mapeado COM acento (como no EDUCADF)
  return DISCIPLINA_EDUCADF_MAP[upper] || DISCIPLINA_EDUCADF_MAP[disciplina.trim().toUpperCase()] || disciplina;
}

// ============================================================================
// MAPEAMENTO DE TURMAS: EDUCA.MELHOR → EDUCADF
// EDUCA.MELHOR: '8º ANO A'  →  EDUCADF: '8º Ano - A'
// ============================================================================

/**
 * Converte o nome da turma do EDUCA.MELHOR para o formato do EDUCADF.
 * Ex: '8º ANO A' → '8º Ano - A' | '6º ANO B' → '6º Ano - B'
 * @param {string} turma - Nome no EDUCA.MELHOR
 * @returns {string} - Nome no formato EDUCADF
 */
function mapearTurma(turma) {
  if (!turma) return turma;
  // Padrão: 'Nº ANO L' ou 'N ANO L' (onde N = número, L = letra)
  // Converte para: 'Nº Ano - L'
  const match = String(turma).trim().match(/^(\d+)[°º]?\s*ANO\s+([A-Z])$/i);
  if (match) {
    return `${match[1]}º Ano - ${match[2].toUpperCase()}`;
  }
  // Se não bater no padrão, devolve o original (ng-select tem fuzzy interno)
  return turma;
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
// HELPER: Remove backdrops e fecha modais SweetAlert2 do EDUCADF que bloqueiam cliques
// ============================================================================
async function removerBackdrops(page) {
  await page.evaluate(() => {
    // Backdrops Angular
    document.querySelectorAll('ngb-offcanvas-backdrop, .offcanvas-backdrop, .modal-backdrop')
      .forEach(el => el.remove());
    document.body.classList.remove('modal-open', 'offcanvas-open');
    document.body.style.overflow = 'auto';

    // SweetAlert2 — fecha qualquer popup do EDUCADF clicando no botão de confirmação
    const swalConfirm = document.querySelector(
      '.swal2-container button.swal2-confirm, .swal2-container .swal2-actions button:first-child'
    );
    if (swalConfirm) {
      console.log('[educadf.pap] removerBackdrops: fechando swal2 via confirm button');
      swalConfirm.click();
    } else {
      // Se não tem botão confirm, tenta fechar pelo overlay ou qualquer botão
      const swalAny = document.querySelector('.swal2-container .swal2-close, .swal2-container button');
      if (swalAny) swalAny.click();
    }
  }).catch(() => {});
  // Aguarda swal2 sumir do DOM
  await page.waitForSelector('.swal2-container', { state: 'hidden', timeout: 5000 }).catch(() => {});
}

// ============================================================================
// HELPER: Verifica se o bimestre correto está ATIVO no DOM após clicar na aba.
// Retorna true se confirmado, false se outro bimestre está ativo.
// ============================================================================
async function verificarBimestreAtivo(page, bimNumStr) {
  return await page.evaluate((num) => {
    const norm = (s) => String(s)
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/\u00ba/g, 'o').replace(/\u00b0/g, 'o')
      .toUpperCase().replace(/[^A-Z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
    const alvo = `${num}O BIMESTRE`;
    // Busca tab ativa (class .active ou aria-selected=true)
    const ativos = [...document.querySelectorAll(
      '.nav-link.active, [role="tab"][aria-selected="true"], .nav-item.active .nav-link, button.nav-link.active'
    )];
    // Verifica se alguma aba ATIVA contém o texto do bimestre alvo
    const bimestreCorretoAtivo = ativos.some(el => norm(el.textContent || '').includes(alvo));
    // Verifica se alguma aba com bimestre DIFERENTE está ativa (sinal de contaminação)
    const outrosBimestres = ativos.some(el => {
      const t = norm(el.textContent || '');
      return t.includes('BIMESTRE') && !t.includes(alvo);
    });
    return {
      bimestreCorretoAtivo,
      outrosBimestres,
      ativos: ativos.map(el => el.textContent?.trim().substring(0, 40)),
    };
  }, bimNumStr).catch(() => ({ bimestreCorretoAtivo: false, outrosBimestres: false, ativos: [] }));
}

// ============================================================================
// HELPER: Aguarda elmLoader sumir + fecha swal2 antes de prosseguir
// Chame antes de qualquer clique crítico após carregamentos de página
// ============================================================================
async function aguardarSemOverlay(page, descricao = '') {
  const label = descricao ? ` [${descricao}]` : '';

  // 1. Aguarda elmLoader (spinner de carregamento do EDUCADF) desaparecer
  await page.waitForSelector('#elmLoader, [id="elmLoader"]', { state: 'hidden', timeout: 20000 })
    .catch(() => console.warn(`[educadf.pap] aguardarSemOverlay${label}: elmLoader timeout (pode não existir)` ));

  // 2. Verifica e fecha swal2
  const swalPresente = await page.evaluate(() => {
    const container = document.querySelector('.swal2-container');
    if (!container) return false;
    const style = window.getComputedStyle(container);
    return style.display !== 'none' && style.visibility !== 'hidden';
  }).catch(() => false);

  if (swalPresente) {
    console.log(`[educadf.pap] aguardarSemOverlay${label}: swal2 detectado — fechando...`);
    await removerBackdrops(page);
    await page.waitForTimeout(800);
  }

  await page.waitForTimeout(500);
}

// ============================================================================
// HELPER: Detecta erros do próprio portal EDUCADF (servidor fora do ar,
// erro interno, swal2 de falha, páginas de erro HTTP, etc)
// Retorna { erro: true, mensagem: string } ou { erro: false }
// ============================================================================
async function detectarErroPortalEducaDF(page) {
  // Padrões de mensagem de erro do EDUCADF (case-insensitive)
  const PADROES_ERRO_PORTAL = [
    'houve um erro interno',
    'erro interno ao acessar',
    'serviço indisponível',
    'servico indisponivel',
    'servidor indisponível',
    'falha ao carregar',
    'ocorreu um erro',
    'sistema indisponível',
    'não foi possível carregar',
    '500 internal server',
    '503 service',
    'gateway timeout',
    'bad gateway',
  ];

  try {
    const resultado = await page.evaluate((padroes) => {
      // 1. Verifica swal2 visível com mensagem de erro
      const swalContainer = document.querySelector('.swal2-container');
      if (swalContainer) {
        const style = window.getComputedStyle(swalContainer);
        const visivel = style.display !== 'none' && style.visibility !== 'hidden';
        if (visivel) {
          const swalText = (swalContainer.textContent || '').toLowerCase();
          const erroEncontrado = padroes.some(p => swalText.includes(p));
          if (erroEncontrado) {
            return {
              erro: true,
              fonte: 'swal2',
              mensagem: (swalContainer.querySelector('.swal2-content, .swal2-html-container, p')?.textContent || swalText).trim().substring(0, 200),
            };
          }
        }
      }

      // 2. Verifica body/page inteira por mensagens de erro (páginas de erro HTTP)
      const bodyText = (document.body?.textContent || '').toLowerCase();
      const erroNoBody = padroes.some(p => bodyText.includes(p));
      if (erroNoBody) {
        // Tenta extrair a mensagem mais relevante
        const h1 = document.querySelector('h1, h2')?.textContent?.trim() || '';
        const p  = document.querySelector('p')?.textContent?.trim() || '';
        return {
          erro: true,
          fonte: 'body',
          mensagem: (h1 || p || 'Erro detectado na página do EDUCADF').substring(0, 200),
        };
      }

      // 3. Verifica se a URL mudou para página de erro
      const url = window.location.href.toLowerCase();
      if (url.includes('/error') || url.includes('/500') || url.includes('/503') || url.includes('/manutencao')) {
        return { erro: true, fonte: 'url', mensagem: `Página de erro detectada: ${window.location.pathname}` };
      }

      return { erro: false };
    }, PADROES_ERRO_PORTAL);

    if (resultado.erro) {
      console.error(`[educadf.pap] 🛑 PORTAL EDUCADF COM ERRO (fonte: ${resultado.fonte}): "${resultado.mensagem}"`);
      // Tenta fechar o swal2 de erro antes de retornar
      await removerBackdrops(page);
    }
    return resultado;
  } catch (e) {
    console.warn('[educadf.pap] detectarErroPortalEducaDF falhou:', e.message);
    return { erro: false };
  }
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
  const vistoStr = [...seen].join(' | ') || '(sem opções)';
  console.warn(`[educadf.pap]   Opções vistas: ${vistoStr}`);

  // Se o dropdown só mostrou "No items found" = portal sem dados (instabilidade, não ausencia de turma)
  const semDados = [...seen].length === 0 || [...seen].every(
    s => s === '' || s.toLowerCase().includes('no items found') ||
         s.toLowerCase().includes('no items') || s.toLowerCase().includes('nenhum item')
  );
  if (semDados) {
    console.warn('[educadf.pap] 🛑 Dropdown retornou "NO ITEMS FOUND" — possível instabilidade do portal EDUCADF');
    await page.evaluate(() => { window.__educaDFSemDados = true; }).catch(() => {});
  }

  await page.keyboard.press('Escape');
  return false;
}

// ============================================================================
// HELPER: Converte dataStr em objeto Date UTC
// ============================================================================
function parseDateUTC(dataStr) {
  if (!dataStr) return null;
  if (dataStr instanceof Date) return isNaN(dataStr.getTime()) ? null : dataStr;
  const s = String(dataStr).trim();
  const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(s + 'T12:00:00') : new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

const MESES_PT = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
// Nomes completos em pt-BR (usados pelo ngb-datepicker no aria-label dos dias)
const MESES_PT_LONG = ['janeiro','fevereiro','mar\u00e7o','abril','maio','junho',
                       'julho','agosto','setembro','outubro','novembro','dezembro'];

function formatarDataEducaDF(dataStr) {
  // Aceita ISO "2026-04-24", Date object, ou string completa "Fri Apr 24 2026..."
  // Sa\u00edda: "24 Abr, 2026" (formato do picker do EDUCADF)
  const d = parseDateUTC(dataStr);
  if (!d) return '';
  const dia = String(d.getUTCDate()).padStart(2, '0');
  const mes = MESES_PT[d.getUTCMonth()];
  const ano = d.getUTCFullYear();
  return `${dia} ${mes}, ${ano}`;
}

// ============================================================================
// ============================================================================
// HELPER: Altera a data no modal de criação/edição do Procedimento Avaliativo.
//
// ESTRATÉGIA TRIPLA:
//  1. Procura um botão de toggle (ícone calendário) ao lado do input de data
//     e clica nele para abrir o popup ngb-datepicker. Se abrir, navega até
//     o mês/ano correto e clica no dia.
//  2. Se não encontrar botão de toggle, tenta clicar no próprio input.
//  3. Se o popup ngb-datepicker nunca aparece (componente customizado),
//     faz fallback: manipula o input diretamente via JavaScript,
//     disparando InputEvent + change + blur para Angular capturar.
// ============================================================================
async function navegarCalendarioEClicarDia(page, dataStr) {
  const target = parseDateUTC(dataStr);
  if (!target) {
    console.warn('[educadf.pap] navegarCalendarioEClicarDia: data inválida:', dataStr);
    return false;
  }

  const tDay   = target.getUTCDate();
  const tMonth = target.getUTCMonth(); // 0-based
  const tYear  = target.getUTCFullYear();
  const dataFormatada = formatarDataEducaDF(dataStr);
  console.log('[educadf.pap] calendario: navegando para ' + tDay + '/' + (tMonth + 1) + '/' + tYear + ' (formatada: "' + dataFormatada + '")');

  // ── PASSO 1: Diagnóstico — descobre quais elementos de data existem no modal ──
  const diagnostico = await page.evaluate(() => {
    const modal = document.querySelector('ngb-modal-window');
    if (!modal) return { error: 'modal-not-found' };

    const allInputs = [...modal.querySelectorAll('input')];
    const dateInp = allInputs.find(inp => /\d{1,2}\s+\w{3}/.test(inp.value || ''));

    // Procura botões de toggle (ícone calendário) perto do date input
    let toggleBtn = null;
    let toggleInfo = 'nao-encontrado';
    if (dateInp) {
      // Procura no parent (div.input-group) por um botão com ícone de calendário
      const parent = dateInp.closest('.input-group') || dateInp.parentElement;
      if (parent) {
        const buttons = [...parent.querySelectorAll('button, .input-group-append button, .input-group-text')];
        toggleBtn = buttons.find(b => {
          const hasIcon = b.querySelector('i.fa-calendar, i.fa-calendar-alt, .bi-calendar, [class*="calendar"]');
          const isToggle = b.hasAttribute('ngbDatepickerToggle') || b.closest('[ngbDatepickerToggle]');
          return hasIcon || isToggle;
        });
        if (toggleBtn) toggleInfo = 'botao-toggle:' + toggleBtn.tagName + '.' + toggleBtn.className;
        else toggleInfo = 'sem-toggle. Filhos parent: ' + [...parent.children].map(c => c.tagName + '.' + (c.className || '')).join(' | ');
      }
    }

    // Verifica se já existe ngb-datepicker no document
    const dpExists = !!document.querySelector('ngb-datepicker');

    // Procura QUALQUER componente de data no modal
    const dateComponents = [...modal.querySelectorAll('*')].filter(el => {
      const tag = el.tagName.toLowerCase();
      return tag.includes('date') || tag.includes('calendar') || tag.includes('picker');
    }).map(el => el.tagName.toLowerCase()).filter((v, i, a) => a.indexOf(v) === i);

    return {
      dateInputValue: dateInp?.value || 'not-found',
      dateInputType: dateInp?.type || 'unknown',
      dateInputSize: dateInp?.getAttribute('size') || 'null',
      toggleBtn: toggleInfo,
      dpAlreadyExists: dpExists,
      dateComponents: dateComponents.join(', ') || 'nenhum',
    };
  });
  console.log('[educadf.pap] calendario diagnostico:', JSON.stringify(diagnostico));

  // ── PASSO 2: Tenta abrir o popup do datepicker ───────────────────────────
  const popupAberto = await page.evaluate(() => {
    const modal = document.querySelector('ngb-modal-window');
    if (!modal) return 'modal-not-found';

    const allInputs = [...modal.querySelectorAll('input')];
    const dateInp = allInputs.find(inp => /\d{1,2}\s+\w{3}/.test(inp.value || ''));
    if (!dateInp) return 'date-input-not-found';

    // Estratégia A: clicar no botão de toggle (ícone calendário)
    const parent = dateInp.closest('.input-group') || dateInp.parentElement;
    if (parent) {
      // Tenta encontrar o toggle via atributo Angular
      let toggle = parent.querySelector('[ngbDatepickerToggle] button, button[ngbDatepickerToggle]');
      // Tenta via ícone de calendário
      if (!toggle) {
        const allBtns = [...parent.querySelectorAll('button')];
        toggle = allBtns.find(b => {
          const icon = b.querySelector('i, span, svg');
          if (!icon) return false;
          const cls = (icon.className || '') + ' ' + (b.className || '');
          return cls.includes('calendar') || cls.includes('datepicker');
        });
      }
      // Tenta qualquer botão no input-group-append
      if (!toggle) {
        toggle = parent.querySelector('.input-group-append button, .input-group-text');
      }
      if (toggle) {
        toggle.scrollIntoView({ block: 'center' });
        toggle.click();
        toggle.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        return 'toggle-clicado:' + toggle.tagName + '.' + toggle.className;
      }
    }

    // Estratégia B: clicar no próprio input (pode funcionar em alguns setups)
    dateInp.focus();
    dateInp.click();
    dateInp.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    // Estratégia C: simular Escape + re-focus (some datepickers toggle on focus)
    return 'input-clicado:' + dateInp.value;
  });
  console.log('[educadf.pap] calendario: tentativa abertura -> ' + popupAberto);
  await page.waitForTimeout(1000);

  // ── PASSO 3: Verifica se ngb-datepicker apareceu no document ─────────────
  let calPopupOk = false;
  for (let attempt = 0; attempt < 3 && !calPopupOk; attempt++) {
    calPopupOk = await page.evaluate(() => !!document.querySelector('ngb-datepicker'));
    if (!calPopupOk) {
      console.warn('[educadf.pap] calendario: popup nao apareceu (tentativa ' + (attempt+1) + '/3)');
      // Tenta novamente: click do Playwright com force no input ou button
      try {
        const toggle = page.locator('ngb-modal-window .input-group button, ngb-modal-window .input-group-append button').first();
        if (await toggle.count() > 0) {
          await toggle.click({ force: true, timeout: 2000 }).catch(() => {});
        }
      } catch {}
      await page.waitForTimeout(600);
    }
  }

  // ── Se o popup abriu, usa navegação por calendário (estratégia visual) ────
  if (calPopupOk) {
    console.log('[educadf.pap] calendario: popup ngb-datepicker encontrado! Navegando...');
    return await _navegarCalendarioPopup(page, tDay, tMonth, tYear);
  }

  // ── FALLBACK FLATPICKR: O input usa a classe flatpickr-input ──────────────
  // O Flatpickr IGNORA mudanças manuais em input.value — mantém modelo interno.
  // Única forma confiável: usar input._flatpickr.setDate(date, triggerChange).
  console.log('[educadf.pap] calendario: popup ngb-datepicker nao existe — tentando via Flatpickr...');

  const isoDate = `${tYear}-${String(tMonth + 1).padStart(2, '0')}-${String(tDay).padStart(2, '0')}`;
  const fpResult = await page.evaluate(({ isoDate, formatted }) => {
    const modal = document.querySelector('ngb-modal-window');
    if (!modal) return 'modal-not-found';

    // Encontra o input do Flatpickr
    const fpInput = modal.querySelector('.flatpickr-input, input.flatpickr-input');
    if (!fpInput) {
      // Fallback: qualquer input com valor de data
      const allInputs = [...modal.querySelectorAll('input')];
      const dateInp = allInputs.find(inp => /\d{1,2}\s+\w{3}/.test(inp.value || ''));
      if (!dateInp) return 'flatpickr-input-not-found';
    }

    const inp = fpInput || modal.querySelector('input');
    const valorAntigo = inp.value;

    // ── Estratégia 1: API Flatpickr direta ─────────────────────────────────
    const fp = inp._flatpickr;
    if (fp && typeof fp.setDate === 'function') {
      // setDate(date, triggerChange, dateFormat)
      // Usa a data ISO para parsing confiável
      fp.setDate(isoDate, true);
      return 'flatpickr-setDate:' + valorAntigo + ' -> ' + inp.value;
    }

    // ── Estratégia 2: Procura Flatpickr em inputs vizinhos ─────────────────
    // Flatpickr às vezes cria um input hidden e usa o visível como display
    const allFpInputs = [...modal.querySelectorAll('.flatpickr-input')];
    for (const fpi of allFpInputs) {
      const fp2 = fpi._flatpickr;
      if (fp2 && typeof fp2.setDate === 'function') {
        fp2.setDate(isoDate, true);
        return 'flatpickr-setDate-alt:' + valorAntigo + ' -> ' + fpi.value;
      }
    }

    // ── Estratégia 3: Fallback genérico (value + eventos) ──────────────────
    // Se por algum motivo _flatpickr não existir
    inp.focus();
    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, 'value'
    )?.set;
    if (nativeSetter) nativeSetter.call(inp, formatted);
    else inp.value = formatted;

    ['input', 'change', 'blur'].forEach(ev =>
      inp.dispatchEvent(new Event(ev, { bubbles: true, cancelable: true }))
    );
    return 'fallback-value:' + valorAntigo + ' -> ' + inp.value;
  }, { isoDate, formatted: dataFormatada });

  console.log('[educadf.pap] calendario Flatpickr resultado: ' + fpResult);

  // ── Verificação: Tenta também abrir o calendário visual do Flatpickr ─────
  // O Flatpickr cria um div.flatpickr-calendar no body. Se existir, podemos
  // clicar no dia diretamente como backup extra.
  const calClickResult = await page.evaluate(({ dia, mes0, ano }) => {
    const cal = document.querySelector('.flatpickr-calendar.open, .flatpickr-calendar.animate');
    if (!cal) return 'flatpickr-calendar-not-open';

    // Navegar ao mês correto (se necessário)
    const curMonthEl = cal.querySelector('.flatpickr-current-month select.flatpickr-monthDropdown-months, .cur-month');
    const curYearEl = cal.querySelector('.flatpickr-current-month .numInputWrapper input.cur-year, input.cur-year');

    if (curMonthEl && curYearEl) {
      const curMonth = parseInt(curMonthEl.value);
      const curYear = parseInt(curYearEl.value);

      if (curMonth !== mes0 || curYear !== ano) {
        if (curMonthEl.tagName === 'SELECT') {
          curMonthEl.value = String(mes0);
          curMonthEl.dispatchEvent(new Event('change', { bubbles: true }));
        }
        curYearEl.value = String(ano);
        curYearEl.dispatchEvent(new Event('input', { bubbles: true }));
        curYearEl.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }

    // Clicar no dia
    const days = [...cal.querySelectorAll('.flatpickr-day:not(.flatpickr-disabled)')];
    for (const d of days) {
      if (d.textContent.trim() === String(dia) && !d.classList.contains('prevMonthDay') && !d.classList.contains('nextMonthDay')) {
        d.click();
        return 'flatpickr-dia-clicado:' + dia;
      }
    }
    return 'flatpickr-dia-not-found. Disponiveis: ' + days.map(d => d.textContent.trim()).join(',');
  }, { dia: tDay, mes0: tMonth, ano: tYear });

  if (calClickResult !== 'flatpickr-calendar-not-open') {
    console.log('[educadf.pap] calendario Flatpickr visual: ' + calClickResult);
  }

  // ── Verifica valor final ─────────────────────────────────────────────────
  await page.waitForTimeout(500);
  const valorFinal = await page.evaluate(() => {
    const modal = document.querySelector('ngb-modal-window');
    if (!modal) return 'modal-null';
    const fpInp = modal.querySelector('.flatpickr-input') ||
                  [...modal.querySelectorAll('input')].find(inp => /\d{1,2}\s+\w{3}/.test(inp.value || ''));
    return fpInp?.value || 'input-null';
  });
  console.log('[educadf.pap] calendario: valor final do input = "' + valorFinal + '"');

  const sucesso = valorFinal.includes(String(tDay));
  if (sucesso) {
    console.log('[educadf.pap] calendario OK: data atualizada para "' + valorFinal + '"');
  } else {
    console.warn('[educadf.pap] calendario WARN: data pode nao ter atualizado (esperado dia ' + tDay + ', got "' + valorFinal + '")');
  }
  return sucesso;
}

// ── Sub-helper: navega o popup ngb-datepicker e clica no dia ─────────────────
async function _navegarCalendarioPopup(page, tDay, tMonth, tYear) {
  for (let nav = 0; nav < 14; nav++) {
    const calInfo = await page.evaluate((mesesLong) => {
      const cal = document.querySelector('ngb-datepicker');
      if (!cal) return null;

      const selects = [...cal.querySelectorAll('select')];
      if (selects.length >= 2) {
        const mSel = selects.find(s => parseInt(s.value) >= 1 && parseInt(s.value) <= 12);
        const ySel = selects.find(s => parseInt(s.value) > 100);
        if (mSel && ySel) return { month: parseInt(mSel.value) - 1, year: parseInt(ySel.value), mode: 'selects' };
      }

      const header = cal.querySelector('.ngb-dp-month-name');
      if (header) {
        const txt = header.textContent.trim().toLowerCase();
        const parts = txt.split(/\s+/);
        const m = mesesLong.indexOf(parts[0]);
        const y = parseInt(parts[parts.length - 1]);
        if (m >= 0 && !isNaN(y)) return { month: m, year: y, mode: 'header' };
      }
      return null;
    }, MESES_PT_LONG);

    if (!calInfo) { console.warn('[educadf.pap] calendario: popup sumiu'); break; }
    console.log('[educadf.pap] calendario: mes atual ' + (calInfo.month+1) + '/' + calInfo.year + ' (' + calInfo.mode + ')');

    if (calInfo.month === tMonth && calInfo.year === tYear) {
      const clicked = await page.evaluate((day, tY) => {
        const cal = document.querySelector('ngb-datepicker');
        if (!cal) return null;

        const btns = [...cal.querySelectorAll('.ngb-dp-day button:not([disabled])')];
        for (const btn of btns) {
          if (btn.textContent?.trim() === String(day)) {
            btn.scrollIntoView({ block: 'center' });
            btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            return 'dia ' + day + ' clicado';
          }
        }
        const allBtns = [...cal.querySelectorAll('button')];
        for (const btn of allBtns) {
          const label = (btn.getAttribute('aria-label') || '').toLowerCase();
          if (label.includes(String(day)) && label.includes(String(tY))) {
            btn.scrollIntoView({ block: 'center' });
            btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            return 'dia ' + day + ' clicado via aria-label';
          }
        }
        const disp = btns.map(b => b.textContent?.trim()).filter(Boolean).join(',');
        return 'nao-encontrado:[' + disp + ']';
      }, tDay, tYear);

      if (clicked && clicked.startsWith('dia')) {
        console.log('[educadf.pap] calendario via popup OK: ' + clicked);
        await page.waitForTimeout(600);
        return true;
      }
      console.warn('[educadf.pap] calendario popup: ' + clicked);
      break;
    }

    // Navegar mês
    const diff = (tYear - calInfo.year) * 12 + (tMonth - calInfo.month);
    if (calInfo.mode === 'selects') {
      await page.evaluate((m, y) => {
        const cal = document.querySelector('ngb-datepicker');
        const selects = [...(cal?.querySelectorAll('select') || [])];
        const mSel = selects.find(s => parseInt(s.value) >= 1 && parseInt(s.value) <= 12);
        const ySel = selects.find(s => parseInt(s.value) > 100);
        if (mSel) { mSel.value = String(m + 1); mSel.dispatchEvent(new Event('change', { bubbles: true })); }
        if (ySel) { ySel.value = String(y);     ySel.dispatchEvent(new Event('change', { bubbles: true })); }
      }, tMonth, tYear);
    } else {
      const goNext = diff > 0;
      await page.evaluate((goNext) => {
        const cal = document.querySelector('ngb-datepicker');
        if (!cal) return;
        const btns = [...cal.querySelectorAll('button.ngb-dp-arrow-btn')];
        const btn = goNext ? btns[btns.length - 1] : btns[0];
        if (btn) btn.click();
      }, goNext);
    }
    await page.waitForTimeout(500);
  }
  console.warn('[educadf.pap] calendario popup: nao conseguiu clicar no dia ' + tDay + '/' + (tMonth+1) + '/' + tYear);
  return false;
}

// ⚠️  preencherDatePicker() REMOVIDA — digitação via teclado não atualiza o modelo Angular.
// Usar exclusivamente: navegarCalendarioEClicarDia(page, dataStr)

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
    // PASSO 2+3: Navega direto para o Calendário do Diário de Classe via URL.
    // A sidebar Angular tem itens colapsados/submenus que causam timeout.
    // Navegar direto via URL é determinístico e evita depender da sidebar.
    // ══════════════════════════════════════════════════════════════════════
    console.log('[educadf.pap] 2/7 Navegando direto para Diário de Classe → Calendário...');
    await session.navigateTo('https://educadf.se.df.gov.br/diario_classe/modulos/calendario');
    await session.delay(TIMING.navigationDelay);

    // ── ANTES de removerBackdrops: captura erro visível no portal (modal de erro, HTTP 5xx etc) ──
    // Após removerBackdrops o modal é dismissado e a detecção falha
    const erroPortalDetectado = await detectarErroPortalEducaDF(page);
    await removerBackdrops(page);
    await session.screenshot('pap_02_calendario');

    // Lança imediatamente se o portal indicou erro ao carregar o calendário
    if (erroPortalDetectado.erro) {
      throw Object.assign(
        new Error(`EDUCADF está apresentando problemas técnicos: ${erroPortalDetectado.mensagem}. Tente novamente em alguns minutos.`),
        { errorCode: 'PORTAL_INDISPONIVEL' }
      );
    }

    // ══════════════════════════════════════════════════════════════════════
    // PASSO 4: Filtros laterais
    // Ano (2026) e Regional já pré-selecionados.
    // Preencher: Turma/Agrupamento + Professor + Componente
    // IMPORTANTE: Componente deve usar o nome do EDUCADF (mapeado da disciplina)
    // ══════════════════════════════════════════════════════════════════════
    const componenteEducaDF = mapearDisciplina(plano.disciplina);
    const turmaEducaDF      = mapearTurma(plano.turmas);
    console.log(`[educadf.pap] 4/7 Aplicando filtros — Turma: ${plano.turmas} → "${turmaEducaDF}" | Componente: ${plano.disciplina} → "${componenteEducaDF}"`);


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
        // Tenta primeiro com formato EDUCADF, depois com original como fallback
        turmaOk = await selecionarNgSelect(page, ph, turmaEducaDF);
        if (!turmaOk) {
          console.warn(`[educadf.pap] Formato EDUCADF "${turmaEducaDF}" não encontrado — tentando original "${plano.turmas}"`);
          turmaOk = await selecionarNgSelect(page, ph, plano.turmas);
        }
        if (turmaOk) break;
      }
    }
    if (!turmaOk) {
      // Verifica as duas causas possíveis para turma não encontrada:
      // A) Portal mostrou erro antes de carregar (erroPortalDetectado, capturado antes de removerBackdrops)
      // B) Dropdown só mostrou "NO ITEMS FOUND" = portal sem dados (marcado em window.__educaDFSemDados)
      const semDadosPortal = await page.evaluate(() => !!window.__educaDFSemDados).catch(() => false);

      if (erroPortalDetectado?.erro || semDadosPortal) {
        const detalhe = erroPortalDetectado?.mensagem || 'dropdown retornou sem dados';
        throw Object.assign(
          new Error(`EDUCADF não carregou as turmas disponíveis (${detalhe}). O portal está com instabilidade. Tente novamente em alguns minutos.`),
          { errorCode: 'PORTAL_INDISPONIVEL' }
        );
      }

      // Realmente não encontrou a turma (portal estava ok, turma não existe no EDUCADF)
      throw new Error(`Filtro Turma não encontrado para "${plano.turmas}". Verifique se a turma está cadastrada no EDUCADF para este bimestre.`);
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

    // ══════════════════════════════════════════════════════════════════════
    // PASSO 7: Clicar em Filtrar
    // ══════════════════════════════════════════════════════════════════════
    console.log('[educadf.pap] 7/16 Clicando em Filtrar...');
    try {
      await page.locator("button:has-text('Filtrar')").first().click({ timeout: 8000 });
      await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() =>
        console.warn('[educadf.pap] domcontentloaded timeout após Filtrar — continuando...')
      );
    } catch (filtrarErr) {
      console.warn(`[educadf.pap] Botão Filtrar não encontrado ou falhou: ${filtrarErr.message}`);
    }

    // ══════════════════════════════════════════════════════════════════════
    // Após Filtrar, aguarda os eventos do calendário renderizarem.
    // O EDUCADF usa FullCalendar com elementos div/a misturados.
    // Seletor amplo cobre todas as variações de classes fc-* do FullCalendar.
    // ══════════════════════════════════════════════════════════════════════

    // Seletor ultra-amplo: cobre FullCalendar 3, 4, 5 e variações do EDUCADF
    const FC_SELETORES = [
      '.fc-event',
      'a.fc-event',
      'div.fc-event',
      '.fc-daygrid-event',
      '.fc-timegrid-event',
      '.fc-h-event',
      '.fc-v-event',
      '[class*="fc-event"]',
      '.fc-content',
      '.fc-day-grid-event',
      '.fc-time-grid-event',
    ];
    const fcEventSelector = FC_SELETORES.join(', ');

    console.log('[educadf.pap] Aguardando eventos renderizarem no calendário (até 25s)...');

    // Aguarda qualquer seletor fc aparecer
    let eventosDetectados = false;
    for (let tentFc = 1; tentFc <= 3 && !eventosDetectados; tentFc++) {
      try {
        await page.waitForSelector(fcEventSelector, { timeout: 10000 });
        eventosDetectados = true;
        console.log('[educadf.pap] ✅ Eventos detectados no calendário.');
      } catch {
        if (tentFc === 1) {
          // Na 1ª falha: tenta clicar "Hoje" para forçar renderização do mês atual
          console.warn('[educadf.pap] ⚠️  Nenhum evento após 10s. Clicando em "Hoje"...');
          try {
            await page.locator("button:has-text('Hoje'), button:has-text('Today')").first()
              .click({ timeout: 4000 });
            await page.waitForTimeout(2000);
          } catch {}
        } else if (tentFc === 2) {
          // Na 2ª falha: scroll para cima (eventos podem estar fora do viewport)
          console.warn('[educadf.pap] ⚠️  Ainda sem eventos. Tentando scroll...');
          await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
          await page.waitForTimeout(2000);
        }
      }
    }

    // Diagnóstico amplo via JS: conta TODOS os elementos com classe fc-event*
    const diagFC = await page.evaluate((seletores) => {
      const resultados = {};
      let totalGlobal = 0;
      for (const sel of seletores) {
        try {
          const els = [...document.querySelectorAll(sel)];
          resultados[sel] = els.length;
          totalGlobal += els.length;
        } catch { resultados[sel] = -1; }
      }
      // Fallback: busca qualquer elemento com class contendo "fc-event"
      const byClass = [...document.querySelectorAll('*')].filter(el => {
        const cls = el.className || '';
        return typeof cls === 'string' && cls.includes('fc-event');
      });
      resultados['byClass[fc-event]'] = byClass.length;
      // Amostras de texto dos primeiros elementos encontrados
      const amostras = byClass.slice(0, 4).map(el => ({
        tag: el.tagName,
        cls: el.className.substring(0, 60),
        txt: (el.textContent || '').trim().substring(0, 60),
      }));
      return { totalGlobal, resultados, amostras };
    }, FC_SELETORES);

    console.log(`[educadf.pap] Diagnóstico FC: total=${diagFC.totalGlobal} | por selector: ${JSON.stringify(diagFC.resultados)}`);
    if (diagFC.amostras.length) {
      console.log(`[educadf.pap] Amostras: ${JSON.stringify(diagFC.amostras)}`);
    }

    await session.screenshot('pap_04b_pos_filtrar');

    // Total real de eventos encontrados (usando abordagem mais ampla)
    const totalEventosReais = diagFC.totalGlobal > 0
      ? diagFC.totalGlobal
      : (await page.evaluate(() =>
          [...document.querySelectorAll('*')].filter(el =>
            typeof el.className === 'string' && el.className.includes('fc-event')
          ).length
        ).catch(() => 0));

    if (totalEventosReais === 0) {
      throw new Error(
        `Nenhum evento encontrado no calendário EDUCADF após aplicar os filtros para a turma "${plano.turmas}". ` +
        `Turma filtrada corretamente, mas o calendário não retornou aulas. ` +
        `Verifique se existem aulas cadastradas para essa turma no EDUCADF.`
      );
    }

    console.log(`[educadf.pap] ✅ ${totalEventosReais} evento(s) no calendário. Prosseguindo para clique...`);


    // ══════════════════════════════════════════════════════════════════════
    // PASSO 8: Clicar em QUALQUER evento do calendário para abrir o diário.
    // O evento serve apenas como ponto de entrada. O bimestre será selecionado
    // na ABA INTERNA no passo 10.
    // ══════════════════════════════════════════════════════════════════════
    await removerBackdrops(page);
    await session.screenshot('pap_04c_calendario');

    let eventoClicado = false;

    // Tentativa 1: seletores Playwright (fc-event em todas as variações)
    for (const sel of FC_SELETORES) {
      if (eventoClicado) break;
      try {
        const fcEvLoc = page.locator(sel).first();
        const cnt = await fcEvLoc.count().catch(() => 0);
        if (cnt === 0) continue;
        console.log(`[educadf.pap] 8/16 Tentando clicar via Playwright: "${sel}" (${cnt} elementos)...`);
        const txt = (await fcEvLoc.textContent().catch(() => '')) || '';
        await fcEvLoc.scrollIntoViewIfNeeded().catch(() => {});
        await aguardarSemOverlay(page, 'pre-click-evento');
        await fcEvLoc.click({ timeout: 10000 });
        eventoClicado = true;
        console.log(`[educadf.pap] ✅ Evento clicado via "${sel}": "${txt.substring(0, 80)}"`);
      } catch (err) {
        console.warn(`[educadf.pap]   Seletor "${sel}" falhou: ${err.message?.substring(0, 80)}`);
      }
    }

    // Tentativa 2: fallback JS — encontra e clica no primeiro elemento com classe fc-event
    if (!eventoClicado) {
      console.warn('[educadf.pap] ⚠️  Playwright falhou em todos os seletores. Tentando JS dispatchEvent...');
      const jsResult = await page.evaluate(() => {
        const candidatos = [...document.querySelectorAll('*')].filter(el => {
          const cls = el.className || '';
          return typeof cls === 'string' && cls.includes('fc-event') && el.offsetParent !== null;
        });
        if (!candidatos.length) return { ok: false, motivo: 'nenhum elemento fc-event visível' };
        const el = candidatos[0];
        el.scrollIntoView({ block: 'center' });
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        return {
          ok: true,
          tag: el.tagName,
          cls: el.className.substring(0, 60),
          txt: (el.textContent || '').trim().substring(0, 60),
        };
      }).catch(e => ({ ok: false, motivo: e.message }));

      if (jsResult.ok) {
        eventoClicado = true;
        console.log(`[educadf.pap] ✅ Evento clicado via JS: <${jsResult.tag}> "${jsResult.txt}"`);
        await page.waitForTimeout(1000);
      } else {
        console.error(`[educadf.pap] ❌ JS fallback falhou: ${jsResult.motivo}`);
      }
    }

    if (!eventoClicado) {
      throw new Error(
        `Nenhum evento do calendário pôde ser clicado para a turma "${plano.turmas}". ` +
        `Tentados ${FC_SELETORES.length} seletores CSS + fallback JS. ` +
        `Verifique os screenshots para diagnóstico.`
      );
    }

    // Aguarda o diário carregar (exibe abas no topo)
    await session.delay(TIMING.navigationDelay);
    await session.screenshot('pap_05_diario_aula');

    // ══════════════════════════════════════════════════════════════════════
    // PASSO 9: Clicar na aba "Registro de Procedimentos Avaliativos"
    // ══════════════════════════════════════════════════════════════════════
    console.log('[educadf.pap] 9/16 Clicando na aba "Registro de Procedimentos Avaliativos"...');
    await removerBackdrops(page);
    const textosProcedimento = [
      'Registro de Procedimentos Avaliativos',
      'Registro de Procedimento Avaliativos',
      'Registro de Procedimento Avaliativo',
      'Procedimentos Avaliativos',
    ];
    let abaClicada = false;
    await aguardarSemOverlay(page, 'pre-aba-procedimentos');
    for (const texto of textosProcedimento) {
      try {
        const loc = page.locator(`a:has-text('${texto}'), [role="tab"]:has-text('${texto}')`).first();
        if (await loc.count() > 0) {
          await loc.scrollIntoViewIfNeeded().catch(() => {});
          await aguardarSemOverlay(page, `pre-click-aba`);
          await loc.click({ timeout: 15000 });
          abaClicada = true;
          console.log(`[educadf.pap] ✅ Aba clicada: "${texto}"`);
          break;
        }
      } catch (err) {
        console.warn(`[educadf.pap] Aba "${texto}" falhou: ${err.message}`);
      }
    }
    if (!abaClicada) {
      await page.evaluate(() => {
        const el = [...document.querySelectorAll('a,[role="tab"]')].find(l => {
          const t = l.textContent?.toLowerCase() || '';
          return t.includes('procedimento') && t.includes('avaliativo');
        });
        if (el) { el.scrollIntoView(); el.click(); }
      });
      abaClicada = true;
    }
    await session.delay(TIMING.navigationDelay);
    await session.screenshot('pap_06_procedimentos_avaliativos');


    // ══════════════════════════════════════════════════════════════════════
    // PASSO 10: Selecionar o bimestre correto na aba de Procedimentos
    // FLUXO OBRIGATÓRIO: clicar na aba → verificar .active no DOM → retry
    // NUNCA prosseguir se o bimestre errado estiver ativo.
    // ══════════════════════════════════════════════════════════════════════
    const bimNumPAP = String(plano.bimestre || '').replace(/\D/g, '');
    if (!bimNumPAP) {
      return { ok: false, message: `Bimestre inválido no plano: "${plano.bimestre}".`, durationMs: 0 };
    }
    console.log(`[educadf.pap] 10/16 Selecionando ${bimNumPAP}º Bimestre...`);

    // Aguarda os tabs de bimestre aparecerem
    await page.waitForSelector(
      `button:has-text("Bimestre"), a:has-text("Bimestre"), [role="tab"]:has-text("Bimestre")`,
      { timeout: 10000 }
    ).catch(() => console.warn('[educadf.pap] ⚠️  Timeout aguardando tabs de bimestre'));
    await removerBackdrops(page);
    await session.delay(1000);

    const textosAlvo = [
      `${bimNumPAP}º Bimestre`,
      `${bimNumPAP}° Bimestre`,
      `${bimNumPAP}o Bimestre`,
    ];

    // ── Loop principal: até 5 tentativas de clicar + verificar ─────────────
    let bimConfirmado = false;
    for (let tentativa = 1; tentativa <= 5 && !bimConfirmado; tentativa++) {
      console.log(`[educadf.pap] 10/16 Tentativa ${tentativa}/5 — clicando no ${bimNumPAP}º Bimestre...`);

      // Estratégia A: Playwright nativo (mais confiável para Angular)
      if (!bimConfirmado) {
        const tabSels = [
          `button.nav-link`,
          `a.nav-link`,
          `[role="tab"]`,
          `li.nav-item button`,
          `li.nav-item a`,
          `[class*="bimestre"]`,
        ];
        for (const sel of tabSels) {
          if (bimConfirmado) break;
          for (const texto of textosAlvo) {
            if (bimConfirmado) break;
            try {
              const loc = page.locator(sel).filter({ hasText: texto }).first();
              if ((await loc.count().catch(() => 0)) === 0) continue;
              await loc.scrollIntoViewIfNeeded().catch(() => {});
              await loc.click({ timeout: 5000 });
              console.log(`[educadf.pap]   A — clicou: "${texto}" via "${sel}"`);
              break;
            } catch {}
          }
        }
      }

      // Estratégia B: dispatchEvent completo Angular-compatible
      await page.evaluate((num) => {
        const norm = (s) => String(s)
          .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
          .replace(/\u00ba/g, 'o').replace(/\u00b0/g, 'o')
          .toUpperCase().replace(/[^A-Z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
        const alvo = `${num}O BIMESTRE`;
        const candidatos = [...document.querySelectorAll(
          'button.nav-link, a.nav-link, [role="tab"], li.nav-item button, li.nav-item a'
        )];
        const el = candidatos.find(e => norm(e.textContent || '').includes(alvo));
        if (!el) return null;
        el.scrollIntoView({ block: 'center' });
        el.focus();
        const opts = { bubbles: true, cancelable: true, composed: true };
        el.dispatchEvent(new PointerEvent('pointerdown', { ...opts, pointerId: 1 }));
        el.dispatchEvent(new MouseEvent('mousedown', opts));
        el.dispatchEvent(new PointerEvent('pointerup', { ...opts, pointerId: 1 }));
        el.dispatchEvent(new MouseEvent('mouseup', opts));
        el.dispatchEvent(new MouseEvent('click', opts));
        return el.textContent?.trim();
      }, bimNumPAP).catch(() => null);

      // Aguarda Angular re-renderizar (mínimo 2s, mais na primeira tentativa)
      await session.delay(tentativa === 1 ? 3000 : 2000);

      // ── VERIFICAÇÃO CRÍTICA: confirma que o bimestre correto está ATIVO ──
      const verificacao = await verificarBimestreAtivo(page, bimNumPAP);
      console.log(`[educadf.pap]   Verificação bimestre: ${JSON.stringify(verificacao)}`);

      if (verificacao.bimestreCorretoAtivo) {
        bimConfirmado = true;
        console.log(`[educadf.pap] ✅ ${bimNumPAP}º Bimestre CONFIRMADO ATIVO no DOM (tentativa ${tentativa}/5).`);
      } else if (verificacao.outrosBimestres) {
        console.warn(`[educadf.pap] ⚠️  Tentativa ${tentativa}/5: outro bimestre está ativo: ${JSON.stringify(verificacao.ativos)}. Retentando...`);
      } else {
        console.warn(`[educadf.pap] ⚠️  Tentativa ${tentativa}/5: nenhuma aba bimestre ativa detectada. Retentando...`);
      }
    }

    if (!bimConfirmado) {
      // Última verificação: se o bimestre correto está na URL ou no título da página
      const urlCheck = page.url().toLowerCase();
      const pageOk = urlCheck.includes(`bimestre=${bimNumPAP}`) || urlCheck.includes(`bim=${bimNumPAP}`);
      if (!pageOk) {
        await session.screenshot('pap_bimestre_FALHA');
        return {
          ok: false,
          message: `Impossível confirmar ${bimNumPAP}º Bimestre como ativo após 5 tentativas. Outro bimestre pode estar selecionado. Abortando para evitar criação no bimestre errado.`,
          durationMs: Date.now() - startedAt,
        };
      }
    }

    await session.screenshot('pap_06b_bimestre_selecionado');
    console.log(`[educadf.pap] ✅ ${bimNumPAP}º Bimestre selecionado e confirmado. Prosseguindo...`);

    await removerBackdrops(page);
    await session.delay(500);

    // ══════════════════════════════════════════════════════════════════════
    // PASSO 7: Verificar duplicata + Clicar em "+ Criar procedimento avaliativo"
    //
    // IMPORTANTE: A verificação de duplicata deve acontecer ANTES de abrir
    // o modal de criação, com a aba de procedimentos visível e o modal fechado,
    // para que os <th> da tabela sejam leíveis sem interferência do overlay.
    // ══════════════════════════════════════════════════════════════════════

    // Declara nomeAtividade antecipadamente para usar na verificação
    const nomeAtividade = item.atividade || 'Avaliação Bimestral';

    // ── Passo 7.1: Lê os procedimentos já cadastrados na tabela do EDUCADF ──
    console.log(`[educadf.pap] 7.1/8 Verificando se "${nomeAtividade}" já existe na tabela...`);

    const _normNome = (s) => String(s)
      .toUpperCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^A-Z0-9 ]/g, ' ')
      .replace(/\s+/g, ' ').trim();

    const _nomeAlvo = _normNome(nomeAtividade);

    const _procedimentosExistentes = await page.evaluate(() => {
      // Lê todos os <th> visíveis na aba de Registro de Procedimentos Avaliativos.
      // O modal está fechado neste momento — leitura limpa dos cabeçalhos.
      const headers = [...document.querySelectorAll('th, td.column-header')];
      return headers
        .map(h => (h.textContent || '').trim())
        .filter(t => t.length > 1 && t.length < 200);
    });

    console.log(`[educadf.pap] Procedimentos na tabela: ${JSON.stringify(_procedimentosExistentes.slice(0, 10))}`);

    if (_procedimentosExistentes.some(nome => _normNome(nome) === _nomeAlvo)) {
      console.warn(`[educadf.pap] ⚠️  "${nomeAtividade}" já existe no EDUCADF — cancelando para evitar duplicata.`);
      await session.screenshot('pap_ja_existe');
      return {
        ok: false,
        errorCode: 'JA_EXISTE',
        message: `O procedimento "${nomeAtividade}" já está cadastrado no EDUCADF para ${plano.turmas} · ${plano.bimestre}. Nenhuma duplicata foi criada.`,
        durationMs: Date.now() - startedAt,
      };
    }

    console.log(`[educadf.pap] ✅ "${nomeAtividade}" não encontrado — prosseguindo com a criação.`);

    // ── Passo 7.2: Clicar em "+ Criar procedimento avaliativo" ───────────
    console.log('[educadf.pap] 7.2/8 Clicando em "+ Criar procedimento avaliativo"...');

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
    // O ngb-datepicker Angular IGNORA texto digitado via teclado simulado.
    // A única forma confiável é navegar o calendário visual e clicar no dia correto.
    const dataStr = item.data_inicio || item.data;
    console.log(`[educadf.pap] Data do plano: "${dataStr}"`);

    if (dataStr) {
      const dataFormatada = formatarDataEducaDF(dataStr);
      console.log(`[educadf.pap] Data formatada: "${dataFormatada}"`);
      const calOkCriacao = await navegarCalendarioEClicarDia(page, dataStr);
      if (!calOkCriacao) {
        console.warn('[educadf.pap] Data ⚠️: calendário não respondeu — a data pode estar incorreta.');
      } else {
        console.log(`[educadf.pap] Data ✅: "${dataFormatada}" selecionada no calendário.`);
      }
    } else {
      console.warn('[educadf.pap] Data ⚠️: item.data_inicio está vazio.');
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

    // ══════════════════════════════════════════════════════════════════════
    // PASSO 8: Workaround Robustez — Re-editar para forçar a confirmação da data
    // A data digitada no modal de criação às vezes é ignorada pelo Angular.
    // Solução: após salvar, clicar no lápis da coluna criada e corrigir a data.
    // ══════════════════════════════════════════════════════════════════════
    const dataFormatadaWk = formatarDataEducaDF(dataStr);
    console.log(`[educadf.pap] Data para workaround: "${dataFormatadaWk}" (origem: "${dataStr}")`);

    if (ok && dataFormatadaWk) {
      console.log(`[educadf.pap] 8/8 Workaround: Re-editando "${nomeAtividade}" para forçar data "${dataFormatadaWk}"...`);
      await session.delay(4000); // Aguarda tabela atualizar com a nova coluna
      await session.screenshot('pap_08b_antes_edicao');

      try {
        // Clica no botão de lápis dentro do TH que contém o nome da atividade
        const editClicked = await page.evaluate((nome) => {
          const normalize = s => s.toLowerCase().trim();
          const alvo = normalize(nome);
          const headers = [...document.querySelectorAll('th')];
          for (const el of headers) {
            const txt = el.textContent || '';
            if (txt.length < 200 && normalize(txt).includes(alvo)) {
              const btn = el.querySelector(
                'button, a, i.fa-edit, i.fa-pencil, i.fa-pen, [class*="edit"], [class*="pencil"]'
              );
              if (btn) {
                const clickTarget = btn.closest('button, a') || btn;
                clickTarget.scrollIntoView({ block: 'center' });
                clickTarget.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                return `clicou em: ${clickTarget.tagName} / ${clickTarget.className}`;
              }
              // Se achou o TH mas não achou botão dentro, loga quais filhos tem
              return `TH encontrado mas sem botão. Filhos: ${[...el.children].map(c => c.tagName + '.' + c.className).join(', ')}`;
            }
          }
          return null;
        }, nomeAtividade);

        console.log(`[educadf.pap] Workaround edit resultado: ${editClicked}`);

        if (editClicked && editClicked.startsWith('clicou')) {
          // Aguarda modal de edição abrir
          try {
            await page.waitForSelector(
              'text=Editar Instrumento/Procedimento Avaliativo',
              { timeout: 15000 }
            );
          } catch {
            // Tenta seletor genérico do ngb-modal
            await page.waitForSelector('ngb-modal-window', { timeout: 5000 });
          }
          await session.delay(1000);
          await session.screenshot('pap_08c_modal_edicao_aberto');

          // Usa calendário visual — digitar no input NÃO atualiza o modelo Angular
          const calOkEdit = await navegarCalendarioEClicarDia(page, dataStr);
          if (calOkEdit) {
            console.log(`[educadf.pap] Workaround Data Edit ✅: "${dataFormatadaWk}"`);
          } else {
            console.warn('[educadf.pap] ⚠️ Workaround: calendário não respondeu no modal de edição.');
          }

          // Salvar edição
          console.log('[educadf.pap] Salvando workaround...');
          await page.waitForTimeout(500);
          await page.evaluate(() => {
            const btn = document.querySelector(
              'ngb-modal-window button.btn-success, .modal button.btn-success'
            );
            if (btn) {
              btn.scrollIntoView({ block: 'center' });
              btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            }
          });
          await session.delay(3000);
          await session.screenshot('pap_09_pos_salvar_workaround');
          console.log('[educadf.pap] ✅ Workaround concluído!');
        } else {
          console.warn(`[educadf.pap] ⚠️ Workaround: lápis não clicado. Resultado evaluate: ${editClicked}`);
        }
      } catch (wkErr) {
        console.warn(`[educadf.pap] ⚠️ Workaround de edição falhou: ${wkErr.message}`);
        await session.screenshot('pap_08_wk_erro').catch(() => {});
      }
    } else if (!dataFormatadaWk) {
      console.warn(`[educadf.pap] ⚠️ Workaround pulado: não foi possível formatar a data "${dataStr}" para o EDUCADF.`);
    }

    return {
      ok,
      message: ok
        ? `Procedimento "${nomeAtividade}" criado (e revisado para forçar data) no EDUCADF para ${plano.turmas} · ${plano.bimestre}.`
        : `Modal ainda aberto após salvar — verifique os logs de validação.`,
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
      // Propaga o errorCode específico (ex: PORTAL_INDISPONIVEL) se foi definido na throw
      errorCode: err.errorCode || 'PAP_EXPORT_ERROR',
    };
  }
}

// ⚠️  preencherDatePickerByLocator() REMOVIDA — digitação via teclado não atualiza o modelo Angular.
// Usar exclusivamente: navegarCalendarioEClicarDia(page, dataStr)

// ============================================================================
// EXPORTAR NOTAS — Etapa 2
// ============================================================================
// Fluxo idêntico ao exportarPAPEducaDF até a aba "Registro de Procedimentos
// Avaliativos". A partir daí, localiza a coluna "Prova Bimestral" pelo header
// da tabela e preenche a nota de cada aluno linha a linha.
// ============================================================================

/**
 * @param {import('../educadf.browser.js').EducaDFSession} session
 * @param {{ login: string, senha: string, perfil: string }} credenciais
 * @param {{ turmas:string, disciplina:string, bimestre:string, ano:number,
 *            professorNome:string, nomeColuna:string,
 *            alunos: Array<{ re:string, nome:string, nota:number|null }> }} plano
 */
export async function exportarNotasEducaDF(session, credenciais, plano) {
  const startedAt = Date.now();
  const { page } = session;

  console.log(`\n${'='.repeat(70)}`);
  console.log(`[educadf.notas] INICIANDO exportação de notas`);
  console.log(`  Turma:    ${plano.turmas}`);
  console.log(`  Coluna:   ${plano.nomeColuna}`);
  console.log(`  Alunos:   ${plano.alunos?.length || 0}`);
  console.log(`${'='.repeat(70)}\n`);

  try {
    // ════════════════════════════════════════════════════════════════════
    // PASSOS 1–6: idênticos ao exportarPAPEducaDF
    // (Login → Diário de Classe → Filtros → Filtrar → Calendário → Aba)
    // ════════════════════════════════════════════════════════════════════

    // PASSO 1: Login (mesmo padrão exato da Etapa 1)
    console.log('[educadf.notas] 1/7 Login...');
    const loginResult = await loginEducaDF(session, credenciais);
    if (!loginResult.ok) {
      return { ok: false, message: `Falha no login: ${loginResult.message}`, durationMs: Date.now() - startedAt };
    }
    await session.screenshot('notas_01_login');
    await removerBackdrops(page);
    await session.delay(TIMING.postLoginDelay);

    // PASSO 2: Navega direto para o Calendário (como na Etapa 1)
    console.log('[educadf.notas] 2/7 Navegando direto para Diário de Classe → Calendário...');
    await session.navigateTo('https://educadf.se.df.gov.br/diario_classe/modulos/calendario');
    await session.delay(TIMING.navigationDelay);
    await removerBackdrops(page);
    await session.screenshot('notas_02_calendario');

    // PASSO 3: Filtros — idêntico ao da Etapa 1
    const componenteEducaDF = mapearDisciplina(plano.disciplina);
    console.log(`[educadf.notas] 3/7 Aplicando filtros — Turma: "${plano.turmas}" | Componente: ${componenteEducaDF}`);

    // Aguarda os ng-selects carregarem (Angular pode demorar)
    await page.waitForSelector('ng-select', { timeout: 15000 }).catch(() =>
      console.warn('[educadf.notas] ng-select não apareceu em 15s — tentando assim mesmo...')
    );
    await page.waitForTimeout(1000);

    // ── Turma (OBRIGATÓRIO) — múltiplos placeholders alternativos ──────────
    const placeholdersTurma = ['Turma/Agrupamento', 'Turma', 'Agrupamento', 'Selecione a Turma'];
    let turmaOk = false;
    for (const ph of placeholdersTurma) {
      const exists = (await page.locator(`ng-select[placeholder="${ph}"]`).count()) > 0;
      if (exists) {
        console.log(`[educadf.notas] Filtro Turma encontrado com placeholder: "${ph}"`);
        turmaOk = await selecionarNgSelect(page, ph, plano.turmas);
        if (turmaOk) break;
      }
    }
    if (!turmaOk) {
      throw new Error(`Filtro Turma não encontrado ou não selecionado para "${plano.turmas}". Verifique se a página carregou corretamente.`);
    }
    await page.waitForTimeout(800);

    // ── Professor (não crítico — fuzzy match) ────────────────────────────────
    if (plano.professorNome) {
      const placeholdersProfessor = ['Professor', 'Docente', 'Selecione o Professor', 'Professor/Docente'];
      let profOk = false;
      for (const ph of placeholdersProfessor) {
        const exists = (await page.locator(`ng-select[placeholder="${ph}"]`).count()) > 0;
        if (exists) {
          console.log(`[educadf.notas] Filtro Professor encontrado com placeholder: "${ph}"`);
          profOk = await selecionarNgSelect(page, ph, plano.professorNome, 8000, nomesCorrespondem);
          if (profOk) break;
        }
      }
      if (!profOk) console.warn('[educadf.notas] ⚠️ ng-select Professor não encontrado — continuando sem filtrar professor');
    }
    await page.waitForTimeout(800);

    // ── Componente (não crítico) ───────────────────────────────────────────
    if (componenteEducaDF) {
      const placeholdersComp = ['Componente', 'Componente Curricular', 'Disciplina', 'Matéria'];
      let compOk = false;
      for (const ph of placeholdersComp) {
        const exists = (await page.locator(`ng-select[placeholder="${ph}"]`).count()) > 0;
        if (exists) {
          console.log(`[educadf.notas] Filtro Componente encontrado com placeholder: "${ph}"`);
          compOk = await selecionarNgSelect(page, ph, componenteEducaDF);
          if (compOk) break;
        }
      }
      if (!compOk) console.warn(`[educadf.notas] ⚠️ Componente "${componenteEducaDF}" não selecionado — continuando`);
    }

    await session.screenshot('notas_03_filtros');

    // PASSO 4: Clicar Filtrar (mesmo padrão Etapa 1)
    console.log('[educadf.notas] 4/7 Clicando em Filtrar...');
    try {
      await page.locator("button:has-text('Filtrar')").first().click({ timeout: 8000 });
      await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() =>
        console.warn('[educadf.notas] domcontentloaded timeout após Filtrar — continuando...')
      );
    } catch (filtrarErr) {
      console.warn(`[educadf.notas] Botão Filtrar não encontrado ou falhou: ${filtrarErr.message}`);
    }
    await session.delay(3000);
    await session.screenshot('notas_04_filtrado');

    // Valida turma no calendário
    const normStr = s => String(s).toUpperCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^A-Z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
    const turmaTkns = normStr(plano.turmas).split(' ').filter(t => t.length > 0);

    const calConf = await page.evaluate(tkns => {
      const evs = [...document.querySelectorAll('a.fc-event, .fc-event a, .fc-daygrid-event')];
      if (!evs.length) return { ok: false, motivo: 'nenhum-evento', total: 0 };
      const norm = s => String(s).toUpperCase().normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '').replace(/[^A-Z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
      const ok = evs.some(ev => tkns.every(t => norm(ev.textContent || '').includes(t)));
      return { ok, total: evs.length, motivo: ok ? 'ok' : 'turma-nao-encontrada' };
    }, turmaTkns);

    if (!calConf.ok) {
      throw new Error(
        `Calendário não confirmou a turma "${plano.turmas}" após Filtrar. ` +
        `${calConf.motivo} | ${calConf.total} eventos.`
      );
    }
    console.log(`[educadf.notas] ✅ Turma confirmada no calendário (${calConf.total} eventos).`);

    // PASSO 5: Clicar num evento do calendário
    console.log('[educadf.notas] 5/7 Clicando num evento do calendário...');
    await session.delay(2000);
    await removerBackdrops(page);

    const compNorm  = normStr(mapearDisciplina(plano.disciplina));
    const compTkns  = compNorm.split(' ').filter(t => t.length > 2);
    const bimNum    = String(plano.bimestre || '').replace(/\D/g, '');
    const fcEvs     = page.locator('a.fc-event, .fc-event a, .fc-daygrid-event');
    const total     = await fcEvs.count();

    const okTurmaComp  = txt => { const n = normStr(txt); return turmaTkns.every(t => n.includes(t)) && compTkns.some(c => n.includes(c)); };
    const okSoTurma    = txt => { const n = normStr(txt); return turmaTkns.every(t => n.includes(t)); };

    // Helper: normaliza bimestre — remove ordinais especiais (º/°), acentos
    const normBimN = (s) => String(s)
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/\u00ba/g, 'o').replace(/\u00b0/g, 'o')
      .toUpperCase().replace(/[^A-Z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

    const evtBimOk = (txt) => {
      if (!bimNum) return true;
      const n = normBimN(txt);
      return n.includes(`${bimNum}O BIMESTRE`) ||
             n.includes(`BIMESTRE ${bimNum}`) ||
             n.includes(`${bimNum} BIMESTRE`);
    };

    let eventoClicado = false;

    // ══ PASSO 8 do fluxo: clicar em QUALQUER evento da turma ══════════════
    // O bimestre NÃO é verificado aqui — o calendário já está filtrado pela
    // turma. O bimestre correto será selecionado DENTRO do diário (passo 10).
    // ════════════════════════════════════════════════════════════════════════

    // Tentativa 1: turma + componente (qualquer bimestre)
    for (let i = 0; i < total && !eventoClicado; i++) {
      const ev  = fcEvs.nth(i);
      const txt = (await ev.textContent().catch(() => '')) || '';
      if (!okTurmaComp(txt)) continue;
      try {
        await ev.scrollIntoViewIfNeeded().catch(() => {});
        await ev.click({ timeout: 10000 }); eventoClicado = true;
        console.log(`[educadf.notas] ✅ Evento [turma+comp] clicado: "${txt.substring(0,80)}"`);
      } catch {}
    }
    // Tentativa 2: só turma (componente pode ter nome diferente)
    if (!eventoClicado) {
      console.warn('[educadf.notas] ⚠️  Tentativa só turma...');
      for (let i = 0; i < total && !eventoClicado; i++) {
        const ev  = fcEvs.nth(i);
        const txt = (await ev.textContent().catch(() => '')) || '';
        if (!okSoTurma(txt)) continue;
        try {
          await ev.scrollIntoViewIfNeeded().catch(() => {});
          await ev.click({ timeout: 10000 }); eventoClicado = true;
          console.log(`[educadf.notas] ✅ Evento [só turma] clicado: "${txt.substring(0,80)}"`);
        } catch {}
      }
    }
    // Tentativa 3: primeiro evento visível (calendário já filtrado por turma)
    if (!eventoClicado && total > 0) {
      console.warn('[educadf.notas] ⚠️  Tentativa: primeiro evento visível...');
      try {
        const ev  = fcEvs.nth(0);
        const txt = (await ev.textContent().catch(() => '')) || '';
        await ev.scrollIntoViewIfNeeded().catch(() => {});
        await ev.click({ timeout: 10000 }); eventoClicado = true;
        console.log(`[educadf.notas] ✅ Evento [fallback-primeiro] clicado: "${txt.substring(0,80)}"`);
      } catch (err) {
        console.warn(`[educadf.notas] Clique fallback falhou: ${err.message}`);
      }
    }
    if (!eventoClicado) {
      throw new Error(
        `Nenhum evento encontrado no calendário EDUCADF para a turma "${plano.turmas}". ` +
        `Verifique se o filtro foi aplicado corretamente e se existem eventos visíveis.`
      );
    }

    await session.delay(TIMING.navigationDelay);
    await session.screenshot('notas_05_diario');

    // PASSO 6: Aba "Registro de Procedimentos Avaliativos"
    console.log('[educadf.notas] 6/7 Abrindo aba Registro de Procedimentos Avaliativos...');
    await removerBackdrops(page);

    let abaClicada = false;
    for (const texto of [
      'Registro de Procedimentos Avaliativos',
      'Registro de Procedimento Avaliativos',
      'Registro de Procedimento Avaliativo',
      'Procedimentos Avaliativos',
    ]) {
      try {
        const loc = page.locator(`a:has-text('${texto}'), [role="tab"]:has-text('${texto}')`).first();
        if (await loc.count() > 0) { await loc.click({ timeout: 15000 }); abaClicada = true; break; }
      } catch {}
    }
    if (!abaClicada) {
      const jsClick = await page.evaluate(() => {
        const el = [...document.querySelectorAll('a, [role="tab"]')].find(l => {
          const t = l.textContent?.toLowerCase() || '';
          return t.includes('procedimento') && t.includes('avaliativo');
        });
        if (el) { el.scrollIntoView({ block: 'center' }); el.click(); return el.textContent?.trim(); }
        return null;
      });
      if (jsClick) abaClicada = true;
    }
    if (!abaClicada) throw new Error('Aba "Registro de Procedimentos Avaliativos" não encontrada.');

    await session.delay(TIMING.navigationDelay);
    await removerBackdrops(page);
    await session.screenshot('notas_06_procedimentos');

    // ══════════════════════════════════════════════════════════════════════
    // PASSO 6b: Clicar no botão do bimestre correto (com retry)
    // Botões: [1º Bimestre] [2º Bimestre] [3º Bimestre] [4º Bimestre]
    // OBRIGATÓRIO: falha explícita se não encontrar — nunca continua com bimestre errado.
    // ══════════════════════════════════════════════════════════════════════
    const bimNumNotas = String(plano.bimestre || '').replace(/\D/g, '');
    if (!bimNumNotas) {
      return { ok: false, message: `Bimestre inválido no plano: "${plano.bimestre}". Verifique o cadastro do plano.`, durationMs: 0 };
    }

    console.log(`[educadf.notas] 6b/7 Selecionando ${bimNumNotas}º Bimestre na aba (até 3 tentativas)...`);
    let btnBimClicadoN = null;
    for (let _t = 1; _t <= 3; _t++) {
      btnBimClicadoN = await page.evaluate((num) => {
        const norm = (s) => String(s)
          .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
          .replace(/\u00ba/g, 'o').replace(/\u00b0/g, 'o')
          .toUpperCase().replace(/[^A-Z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
        const alvo = `${num}O BIMESTRE`;
        // Seletor ampliado: inclui [role=tab] e variações de classe do EDUCADF
        const botoes = [...document.querySelectorAll(
          'button, a.btn, .nav-link, li.nav-item a, [role="tab"], [class*="bimestre"], [class*="tab-item"]'
        )];
        const btn = botoes.find(b => norm(b.textContent || '').includes(alvo));
        if (btn) {
          btn.scrollIntoView({ block: 'center' });
          btn.click();
          return btn.textContent?.trim();
        }
        return null;
      }, bimNumNotas);
      if (btnBimClicadoN) break;
      console.warn(`[educadf.notas] ⚠️  Tentativa ${_t}/3: botão "${bimNumNotas}º Bimestre" não encontrado. Aguardando 2s...`);
      await session.delay(2000);
    }

    if (btnBimClicadoN) {
      console.log(`[educadf.notas] ✅ Bimestre selecionado: "${btnBimClicadoN}"`);
      await session.delay(2000); // aguarda React re-renderizar a aba
      await session.screenshot('notas_06b_bimestre_selecionado');
    } else {
      // FALHA CRÍTICA — nunca continua com bimestre errado
      console.error(`[educadf.notas] ❌ FALHA CRÍTICA: botão "${bimNumNotas}º Bimestre" não encontrado após 3 tentativas.`);
      await session.screenshot('notas_06b_bimestre_FALHA');
      return {
        ok: false,
        message: `Não foi possível selecionar o ${bimNumNotas}º Bimestre no EDUCADF após 3 tentativas. Verifique se a aba de procedimentos está carregada corretamente.`,
        durationMs: 0,
      };
    }

    await removerBackdrops(page);

    // ════════════════════════════════════════════════════════════════════
    // PASSO 7 — INSERIR NOTAS NA COLUNA "Prova Bimestral"
    // ════════════════════════════════════════════════════════════════════
    console.log(`\n[educadf.notas] 7/7 Inserindo notas na coluna "${plano.nomeColuna}"...`);

    // 7a. Descobre o índice td da coluna pelo alinhamento VISUAL (bounding rect)
    // ─ A tabela do EDUCADF tem thead com múltiplas linhas (datas + nomes),
    //   então contar <th> globalmente dá índice errado.
    //   Solução: pegar o centro-X do <th> alvo e achar o <td> com posição mais próxima.
    const colunaIdx = await page.evaluate((nomeCol) => {
      const norm = s => String(s).toLowerCase().normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '').trim().replace(/\s+/g, ' ');
      const alvo = norm(nomeCol);

      // 1. Acha o <th> que contém o texto da coluna
      const allThs = [...document.querySelectorAll('table th, thead th')];
      let targetTh = null;

      // Busca exata primeiro, depois parcial
      targetTh = allThs.find(th => norm(th.textContent || '') === alvo);
      if (!targetTh) {
        targetTh = allThs.find(th => norm(th.textContent || '').includes(alvo));
      }
      if (!targetTh) {
        targetTh = allThs.find(th => alvo.includes(norm(th.textContent || '').replace(/[^a-z0-9 ]/g, '').trim()));
      }

      if (!targetTh) {
        return {
          idx: -1,
          motivo: 'th não encontrado',
          disponiveis: allThs.slice(0, 20).map(t => norm(t.textContent || '').substring(0, 40)),
        };
      }

      const thRect   = targetTh.getBoundingClientRect();
      const thCenterX = thRect.left + thRect.width / 2;

      // ───────────────────────────────────────────────────────────────────
      // 2. CRÍTICO: pega a tabela DONA do <th> para calibrar o índice.
      //    ANTES: document.querySelector('table tbody tr') retornava a 1ª linha
      //    do calendário (43 células) → índice errado para turmas com 3+ colunas.
      //    AGORA:  targetTh.closest('table') garante mesma tabela em 100% dos casos.
      // ───────────────────────────────────────────────────────────────────
      const targetTable = targetTh.closest('table');
      if (!targetTable) {
        return { idx: -1, motivo: 'tabela pai do th não encontrada', thFound: targetTh.textContent?.trim() };
      }

      const firstRow = targetTable.querySelector('tbody tr');
      if (!firstRow) {
        return { idx: -1, motivo: 'nenhuma linha de dados na tabela de alunos', thFound: targetTh.textContent?.trim() };
      }

      const tds = [...firstRow.querySelectorAll('td')];
      if (!tds.length) {
        return { idx: -1, motivo: 'nenhuma td na primeira linha', thFound: targetTh.textContent?.trim() };
      }

      // 3. Acha o td cuja posição horizontal está mais próxima do centro do th
      let bestIdx  = -1;
      let bestDist = Infinity;
      const debug  = [];
      for (let i = 0; i < tds.length; i++) {
        const rect    = tds[i].getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const dist    = Math.abs(centerX - thCenterX);
        debug.push({ i, centerX: Math.round(centerX), dist: Math.round(dist) });
        if (dist < bestDist) { bestDist = dist; bestIdx = i; }
      }

      // ─────────────────────────────────────────────────────────────────
      // 4. VALIDAÇÃO CRUZADA: confirma que o th da coluna escolhida bate
      //    com o nome esperado. Proteção dupla contra erro silencioso.
      // ─────────────────────────────────────────────────────────────────
      const allThsInTable = [...targetTable.querySelectorAll('thead th')];
      const tdChosenCX    = tds[bestIdx].getBoundingClientRect().left + tds[bestIdx].getBoundingClientRect().width / 2;
      const confirmTh     = allThsInTable.find(th => {
        const r = th.getBoundingClientRect();
        return Math.abs((r.left + r.width / 2) - tdChosenCX) < 35;
      });
      const confirmNome = confirmTh ? norm(confirmTh.textContent || '') : '';
      const confirmOk   = confirmNome.includes(alvo) || alvo.includes(confirmNome.replace(/[^a-z0-9 ]/g, '').trim());

      return {
        idx:        bestIdx,
        thFound:    targetTh.textContent?.trim(),
        confirmTh:  confirmTh?.textContent?.trim() || '(não confirmado)',
        confirmOk,
        thCenterX:  Math.round(thCenterX),
        tdCount:    tds.length,
        bestDist:   Math.round(bestDist),
        via:        'bounding-rect-same-table',
        debug,
      };
    }, plano.nomeColuna);

    console.log(`[educadf.notas] Coluna "${plano.nomeColuna}" → td[${colunaIdx.idx}] via ${colunaIdx.via || 'global'}`);
    if (colunaIdx.thCenterX !== undefined) {
      console.log(`  thCenterX=${colunaIdx.thCenterX}px | tdCount=${colunaIdx.tdCount} | bestDist=${colunaIdx.bestDist}px`);
      console.log(`  confirmTh="${colunaIdx.confirmTh}" | confirmOk=${colunaIdx.confirmOk}`);
    }

    if (colunaIdx.idx < 0) {
      const dispStr = (colunaIdx.disponiveis || []).join(' | ');
      throw new Error(
        `Coluna "${plano.nomeColuna}" não encontrada na tabela. ` +
        `Motivo: ${colunaIdx.motivo}. ` +
        `Verifique se a Etapa 1 (exportar estrutura) foi realizada. ` +
        `Cabeçalhos disponíveis: ${dispStr}`
      );
    }

    // ── FAIL-SAFE: aborta se a validação cruzada falhar ──────────────────
    // Garante que nunca lançamos notas na coluna errada silenciosamente.
    if (colunaIdx.confirmOk === false) {
      throw new Error(
        `VALIDAÇÃO CRUZADA FALHOU: esperava coluna "${plano.nomeColuna}" ` +
        `mas td[${colunaIdx.idx}] corresponde ao th "${colunaIdx.confirmTh}". ` +
        `Exportação ABORTADA para evitar notas na coluna errada. ` +
        `Revise a estrutura do diário no EDUCADF.`
      );
    }

    await session.screenshot('notas_07a_tabela');

    // ── Diagnóstico da estrutura da tabela (primeiras 3 linhas) ──────────
    const diagnostico = await page.evaluate((colIdx) => {
      const rows = [...document.querySelectorAll('table tbody tr, tbody tr')].slice(0, 3);
      return rows.map(row => {
        const cells = [...row.querySelectorAll('td')];
        return {
          totalCells: cells.length,
          cell0: cells[0]?.textContent?.trim()?.substring(0, 30),
          cell1: cells[1]?.textContent?.trim()?.substring(0, 30),
          cell2: cells[2]?.textContent?.trim()?.substring(0, 40),
          cellAlvo: cells[colIdx]
            ? (cells[colIdx].innerHTML?.substring(0, 80) || '[vazio]')
            : `[colIdx=${colIdx} fora do range]`,
        };
      });
    }, colunaIdx.idx);

    console.log('[educadf.notas] Diagnóstico das primeiras linhas da tabela:');
    diagnostico.forEach((d, i) =>
      console.log(`  Linha ${i}: cells=${d.totalCells} | cell[0]="${d.cell0}" | cell[1]="${d.cell1}" | cell[2]="${d.cell2}" | cell[alvo]="${d.cellAlvo?.substring(0, 60)}"`)
    );

    // 7b. Para cada aluno: Playwright nativo (.fill + Tab) para Angular detectar
    // ─ page.evaluate + dispatchEvent NÃO atualiza NgModel do Angular.
    // ─ Playwright nativo (click + fill + Tab) simula interação real e funciona.
    let totalPreenchidos = 0;
    let totalErros       = 0;
    const alunosNaoEncontrados  = []; // dessincronização: está no EDUCA.MELHOR mas não no EDUCADF
    const alunosDesabilitados   = []; // ausentes: campo bloqueado pelo EDUCADF (sem presença no dia)

    // Pré-carrega todos os REs visíveis na tabela (para diagnóstico rápido)
    const resEducaDF = await page.evaluate(() => {
      const normRE = s => String(s || '').trim().replace(/^0+/, '');
      const rows = [...document.querySelectorAll('table tbody tr, tbody tr')];
      const found = new Set();
      for (const row of rows) {
        const cells = [...row.querySelectorAll('td')];
        if (cells.length >= 4 && cells.length <= 15) {
          // Linhas de alunos têm entre 4 e ~10 células; calendário tem 43+
          cells.slice(0, 2).forEach(c => {
            const t = normRE(c.textContent?.trim() || '');
            if (/^\d{4,7}$/.test(t)) found.add(t);
          });
        }
      }
      return [...found];
    });
    console.log(`[educadf.notas] REs encontrados no EDUCADF: [${resEducaDF.slice(0, 10).join(', ')}${resEducaDF.length > 10 ? '...' : ''}] (${resEducaDF.length} total)`);

    for (const aluno of (plano.alunos || [])) {
      if (aluno.nota === null || aluno.nota === undefined) {
        console.log(`  → [${aluno.re || aluno.nome}] sem nota — pulando`);
        continue;
      }

      const notaStr = String(Number(aluno.nota).toFixed(1)).replace('.', ','); // ex: "3,5"
      const reNorm  = String(aluno.re || '').trim().replace(/^0+/, '');

      // ── Passo 1: encontra a linha no DOM, verifica disabled, retorna uid ─
      const linhaInfo = await page.evaluate(({ re, nome, colIdx }) => {
        const norm   = s => String(s || '').toLowerCase().trim().replace(/\s+/g, ' ');
        const normRE = s => String(s || '').trim().replace(/^0+/, '');
        const reNorm = normRE(re);

        const rows = [...document.querySelectorAll('table tbody tr, tbody tr')];

        for (let rIdx = 0; rIdx < rows.length; rIdx++) {
          const row   = rows[rIdx];
          const cells = [...row.querySelectorAll('td')];
          // Ignora linhas do calendário (muitas células) e cabeçalhos (sem células)
          if (cells.length < 4 || cells.length > 15) continue;

          const reMatch   = reNorm && cells.some(c => normRE(c.textContent?.trim() || '') === reNorm);
          const rowText   = cells.map(c => c.textContent?.trim()).join(' ');
          const nomeMatch = nome && norm(rowText).includes(norm(nome));

          if (!reMatch && !nomeMatch) continue;

          const tdNota = cells[colIdx];
          if (!tdNota) return { ok: false, motivo: `célula ${colIdx} não existe (max=${cells.length})` };

          const input = tdNota.querySelector('input[type="text"], input[type="number"], input');
          if (!input) return { ok: false, motivo: `sem input na célula ${colIdx} (html: ${tdNota.innerHTML?.substring(0, 80)})` };

          // ── Detecta campo desabilitado ANTES de tentar preencher ────────
          // (ex.: aluno estava ausente no dia da avaliação → EDUCADF bloqueia)
          if (input.disabled || input.hasAttribute('disabled')) {
            return {
              ok:       false,
              disabled: true,
              motivo:   'campo desabilitado no EDUCADF (aluno sem presença registrada no dia da avaliação)',
            };
          }

          // Cria atributo temporário para o Playwright localizar o elemento
          const uid = `notas-aluno-${rIdx}-${colIdx}`;
          input.setAttribute('data-notas-uid', uid);
          input.scrollIntoView({ block: 'center' });

          return { ok: true, uid, via: reMatch ? 're-match' : 'nome-match' };
        }

        return { ok: false, motivo: `RE="${reNorm}" não encontrado no EDUCADF` };
      }, { re: aluno.re, nome: aluno.nome, colIdx: colunaIdx.idx });

      if (!linhaInfo.ok) {
        totalErros++;
        if (linhaInfo.disabled) {
          // Campo desabilitado: aluno estava ausente no dia da avaliação
          alunosDesabilitados.push({ nome: aluno.nome, re: aluno.re });
          console.warn(`  🚫 ${aluno.nome} → campo desabilitado (ausente no dia)`);
        } else {
          alunosNaoEncontrados.push({ nome: aluno.nome, re: aluno.re, motivo: linhaInfo.motivo });
          console.warn(`  ⚠️  ${aluno.nome} → ${linhaInfo.motivo}`);
        }
        continue;
      }

      // ── Passo 2: Playwright nativo pressSequentially (keydown+keypress+keyup+input por char) ──
      // fill() apenas dispara 'input' genérico; Angular desta tela precisa de keystrokes reais.
      try {
        const inputLoc = page.locator(`[data-notas-uid="${linhaInfo.uid}"]`);
        await inputLoc.scrollIntoViewIfNeeded().catch(() => {});
        await inputLoc.click({ clickCount: 3 });     // seleciona texto existente
        await inputLoc.pressSequentially(notaStr, { delay: 40 }); // tecla a tecla → Angular detecta
        await page.keyboard.press('Tab');            // blur → trigger change/validation

        // Garante que Angular processou blur + change (segurança extra)
        await page.evaluate((uid) => {
          const el = document.querySelector(`[data-notas-uid="${uid}"]`);
          if (el) {
            el.dispatchEvent(new Event('change', { bubbles: true }));
            el.dispatchEvent(new FocusEvent('blur',  { bubbles: true }));
          }
        }, linhaInfo.uid);

        await page.waitForTimeout(200); // Angular processar

        totalPreenchidos++;
        console.log(`  ✔ ${String(aluno.nome).padEnd(45)} RE=${aluno.re || '?'}  nota=${notaStr}  (${linhaInfo.via})`);
      } catch (e) {
        totalErros++;
        alunosNaoEncontrados.push({ nome: aluno.nome, re: aluno.re, motivo: `Falha ao preencher input: ${e.message?.substring(0, 120)}` });
        console.warn(`  ⚠️  ${aluno.nome} → Falha no fill: ${e.message?.substring(0, 120)}`);
      }
    }

    await session.screenshot('notas_07b_pos_preenchimento');

    // ── 7c. SALVAR — botão verde no canto inferior direito ─────────────────
    // O EDUCADF exige clicar "Salvar" após preencher as notas.
    // Aguardamos Angular processar todos os events antes de clicar.
    console.log('[educadf.notas] Aguardando Angular processar inputs...');
    await session.delay(1500);

    // Rola até o final da página para garantir que o botão esteja visível
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await session.delay(800);
    await session.screenshot('notas_07c_antes_salvar');

    console.log('[educadf.notas] Clicando em SALVAR...');
    let salvarClicado = false;

    // Tentativa 1: Playwright nativo — botão verde "Salvar" (btn-success)
    const seletoresSalvar = [
      "button.btn-success:has-text('Salvar')",
      "button.btn-success:has-text('salvar')",
      "button:has-text('Salvar')",
      "button.btn-success",
    ];

    for (const sel of seletoresSalvar) {
      try {
        const loc = page.locator(sel).last(); // .last() pega o do canto inferior direito
        if (await loc.count() > 0 && await loc.isVisible({ timeout: 3000 })) {
          await loc.scrollIntoViewIfNeeded().catch(() => {});
          await loc.click({ timeout: 10000, force: false });
          salvarClicado = true;
          console.log(`[educadf.notas] ✅ Salvar clicado via: "${sel}"`);
          break;
        }
      } catch (e) {
        console.warn(`  [Salvar] seletor "${sel}" falhou: ${e.message}`);
      }
    }

    // Tentativa 2: JS evaluate com scroll preciso
    if (!salvarClicado) {
      const jsResult = await page.evaluate(() => {
        // Busca todos os botões que contenham "salvar" (case insensitive)
        const todos = [...document.querySelectorAll('button')];
        const btn   = todos.reverse().find(b => {
          // .reverse() para pegar o último (canto inferior direito)
          const t = (b.textContent || '').toLowerCase().trim();
          return (t === 'salvar' || t.startsWith('salvar')) && !b.disabled;
        });
        if (btn) {
          btn.scrollIntoView({ block: 'end', behavior: 'instant' });
          btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          return { ok: true, texto: btn.textContent?.trim() };
        }
        // Fallback: qualquer btn-success visível na parte inferior
        const btsSuc = [...document.querySelectorAll('button.btn-success')].filter(b => !b.disabled);
        if (btsSuc.length) {
          const last = btsSuc[btsSuc.length - 1];
          last.scrollIntoView({ block: 'end', behavior: 'instant' });
          last.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          return { ok: true, texto: last.textContent?.trim(), via: 'btn-success-fallback' };
        }
        return { ok: false };
      });

      if (jsResult.ok) {
        salvarClicado = true;
        console.log(`[educadf.notas] ✅ Salvar clicado via JS evaluate: "${jsResult.texto}" (${jsResult.via || 'texto'})`);
      } else {
        console.warn('[educadf.notas] ⚠️ Botão SALVAR não encontrado por nenhum método.');
      }
    }

    // Aguarda o servidor confirmar o save (rede Angular)
    await session.delay(salvarClicado ? 4000 : 1500);
    await session.screenshot('notas_08_finalizado');

    const ok = totalPreenchidos > 0;
    console.log(`\n[educadf.notas] ✅ Concluído: ${totalPreenchidos} notas preenchidas, ${totalErros} erros.`);

    return {
      ok,
      totalPreenchidos,
      totalErros,
      alunosNaoEncontrados,
      alunosDesabilitados,
      message: ok
        ? `${totalPreenchidos} notas exportadas para EDUCADF — ${plano.turmas} · ${plano.bimestre}.`
        : `Nenhuma nota foi exportada. ${totalErros} erros.`,
      durationMs: Date.now() - startedAt,
    };

  } catch (err) {
    await session.screenshot('notas_erro').catch(() => {});
    console.error(`[educadf.notas] ❌ Erro: ${err.message}`);
    return {
      ok: false,
      message: `Erro durante exportação de notas: ${err.message}`,
      durationMs: Date.now() - startedAt,
      errorCode: err.errorCode || 'NOTAS_EXPORT_ERROR',
    };
  }
}

export default { exportarPAPEducaDF, exportarNotasEducaDF };
