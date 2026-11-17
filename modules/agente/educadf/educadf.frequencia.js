// modules/agente/educadf/educadf.frequencia.js
// ============================================================================
// AGENTE EDUCADF — EXPORTAR FREQUÊNCIA / CHAMADA DIGITAL (ETAPA FREQUÊNCIA)
// ============================================================================
// Fluxo automatizado via Playwright baseado no DOM real do EDUCADF (2026):
//  1. Login via `loginEducaDF` (`https://educadf.se.df.gov.br/auth`)
//  2. Navegação direta para `https://educadf.se.df.gov.br/diario_classe/modulos/calendario`
//  3. Seleção dos filtros na `<app-lombada>` (`Unidade escolar`, `Turma`, `Professor`, `Componente`)
//     e clique em `Filtrar`
//  4. Agrupamento cronológico das aulas confirmadas por Mês (`YYYY-MM`) e Data (`YYYY-MM-DD`)
//  5. Para cada data confirmada:
//     - Navega o FullCalendar (`.fc-prev-button` / `.fc-next-button`) até o mês/ano da aula
//     - Clica no evento real dentro de `[data-date="YYYY-MM-DD"]` (excluindo `.external-event`)
//     - Na gaveta `<ngb-offcanvas-panel>`, garante que a aba `Frequência` esteja ativa
//     - Lê `table#grid-seedf`: cabeçalhos `th.freq-col-horario` e linhas `tbody tr` (`RE` + `Nome`)
//     - Associa cada aula do dia à coluna correspondente do EDUCADF (por horário HH:MM ou ordem)
//     - Clica em `"Marcar todos presentes"` na coluna e ajusta `button.dc-presenca` (`P` ↔ `F`)
//       exatamente conforme os ausentes/presentes lançados no EducaMelhor
//     - Clica em `.dc-barra-acoes button.btn-success` (`Salvar`) e fecha a gaveta
// ============================================================================

import { loginEducaDF } from './educadf.login.js';
import { TIMING } from './educadf.selectors.js';

const DISCIPLINA_EDUCADF_MAP = {
  'PORTUGUES':                  'LÍNGUA PORTUGUESA',
  'PORTUGUÊS':                  'LÍNGUA PORTUGUESA',
  'LINGUA PORTUGUESA':          'LÍNGUA PORTUGUESA',
  'LÍNGUA PORTUGUESA':          'LÍNGUA PORTUGUESA',
  'INGLES':                     'LEM/INGLÊS',
  'INGLÊS':                     'LEM/INGLÊS',
  'LEM INGLES':                 'LEM/INGLÊS',
  'LEM/INGLES':                 'LEM/INGLÊS',
  'LEM/INGLÊS':                 'LEM/INGLÊS',
  'ESPANHOL':                   'LEM/ESPANHOL',
  'LEM ESPANHOL':               'LEM/ESPANHOL',
  'LEM/ESPANHOL':               'LEM/ESPANHOL',
  'CIENCIAS':                   'CIÊNCIAS NATURAIS',
  'CIÊNCIAS':                   'CIÊNCIAS NATURAIS',
  'CIENCIAS NATURAIS':          'CIÊNCIAS NATURAIS',
  'CIÊNCIAS NATURAIS':          'CIÊNCIAS NATURAIS',
  'ED FISICA':                  'EDUCAÇÃO FÍSICA',
  'ED. FISICA':                 'EDUCAÇÃO FÍSICA',
  'EDUCACAO FISICA':            'EDUCAÇÃO FÍSICA',
  'EDUCAÇÃO FÍSICA':            'EDUCAÇÃO FÍSICA',
  'PARTE DIVERSIFICADA I':      'PARTE DIVERSIFICADA I',
  'PRATICA DIVERSIFICADA I':    'PARTE DIVERSIFICADA I',
  'PRÁTICA DIVERSIFICADA I':    'PARTE DIVERSIFICADA I',
  'PRATICAS DIVERSIFICADAS I':  'PARTE DIVERSIFICADA I',
  'PRÁTICAS DIVERSIFICADAS I':  'PARTE DIVERSIFICADA I',
  'PARTE DIVERSIFICADA 1':      'PARTE DIVERSIFICADA I',
  'PD1':                        'PARTE DIVERSIFICADA I',
  'PD 1':                       'PARTE DIVERSIFICADA I',
  'PD I':                       'PARTE DIVERSIFICADA I',
  'PARTE DIVERSIFICADA II':     'PARTE DIVERSIFICADA II',
  'PRATICA DIVERSIFICADA II':   'PARTE DIVERSIFICADA II',
  'PRÁTICA DIVERSIFICADA II':   'PARTE DIVERSIFICADA II',
  'PRATICAS DIVERSIFICADAS II': 'PARTE DIVERSIFICADA II',
  'PRÁTICAS DIVERSIFICADAS II': 'PARTE DIVERSIFICADA II',
  'PARTE DIVERSIFICADA 2':      'PARTE DIVERSIFICADA II',
  'PD2':                        'PARTE DIVERSIFICADA II',
  'PD 2':                       'PARTE DIVERSIFICADA II',
  'PD II':                      'PARTE DIVERSIFICADA II',
  'PARTE DIVERSIFICADA III':    'PARTE DIVERSIFICADA III',
  'PRATICA DIVERSIFICADA III':  'PARTE DIVERSIFICADA III',
  'PRÁTICA DIVERSIFICADA III':  'PARTE DIVERSIFICADA III',
  'PRATICAS DIVERSIFICADAS III':'PARTE DIVERSIFICADA III',
  'PRÁTICAS DIVERSIFICADAS III':'PARTE DIVERSIFICADA III',
  'PARTE DIVERSIFICADA 3':      'PARTE DIVERSIFICADA III',
  'PD3':                        'PARTE DIVERSIFICADA III',
  'PD 3':                       'PARTE DIVERSIFICADA III',
  'PD III':                     'PARTE DIVERSIFICADA III',
  'MATEMATICA':                 'MATEMÁTICA',
  'MATEMÁTICA':                 'MATEMÁTICA',
  'HISTORIA':                   'HISTÓRIA',
  'HISTÓRIA':                   'HISTÓRIA',
  'GEOGRAFIA':                  'GEOGRAFIA',
  'ARTES':                      'ARTES',
  'ARTE':                       'ARTES',
  'ENSINO RELIGIOSO':           'ENSINO RELIGIOSO',
  'BIOLOGIA':                   'BIOLOGIA',
  'FISICA':                     'FÍSICA',
  'FÍSICA':                     'FÍSICA',
  'QUIMICA':                    'QUÍMICA',
  'QUÍMICA':                    'QUÍMICA',
  'FILOSOFIA':                  'FILOSOFIA',
  'SOCIOLOGIA':                 'SOCIOLOGIA',
};

function normTexto(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[°ºª]/g, '')
    .replace(/\s*-\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .toUpperCase()
    .trim();
}

function textosCorrespondemSeguros(aNorm, bNorm) {
  if (!aNorm || !bNorm) return false;
  if (aNorm.includes('NO ITEMS') || aNorm.includes('NENHUM ITEM')) return false;
  if (aNorm === bNorm) return true;
  const romanos = /\b(III|II|I|IV|V|1|2|3|4|5|6|7|8|9)\b/g;
  const romA = (aNorm.match(romanos) || []).join(',');
  const romB = (bNorm.match(romanos) || []).join(',');
  if (romA && romB && romA !== romB) return false;
  return aNorm.includes(bNorm) || bNorm.includes(aNorm);
}

function mapearDisciplina(disciplina, disciplinaOficial) {
  if (disciplinaOficial && String(disciplinaOficial).trim() !== '') {
    return String(disciplinaOficial).trim();
  }
  if (!disciplina) return disciplina;
  const upper = String(disciplina)
    .trim()
    .toUpperCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\.\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return DISCIPLINA_EDUCADF_MAP[upper] || DISCIPLINA_EDUCADF_MAP[disciplina.trim().toUpperCase()] || disciplina;
}

function mapearTurma(turma) {
  if (!turma) return turma;
  const matchAno = String(turma).trim().match(/^(\d+)[°ºª]?\s*ANO\s*[-–]?\s*([A-Z0-9]+)$/i);
  if (matchAno) {
    return `${matchAno[1]}º Ano - ${matchAno[2].toUpperCase()}`;
  }
  const matchSerie = String(turma).trim().match(/^(\d+)[°ºª]?\s*S[EÉ]RIE\s*[-–]?\s*([A-Z0-9]+)$/i);
  if (matchSerie) {
    return `${matchSerie[1]}ª Série - ${matchSerie[2].toUpperCase()}`;
  }
  return turma;
}

function gerarCandidatosTurma(dados) {
  const candidatos = [];
  const add = (v) => {
    const s = String(v || '').trim();
    if (s && !candidatos.includes(s)) candidatos.push(s);
  };

  const bimNum = parseInt(String(dados?.bimestre || '').replace(/\D/g, ''), 10) || 0;
  const semGov = Number(dados?.governanca?.semestreNumero);
  const isSegundoSemestre = semGov === 1 || semGov === 2 ? semGov === 2 : bimNum >= 3;

  const oficiais = [
    ...(Array.isArray(dados?.turmasOficiais) ? dados.turmasOficiais : []),
    dados?.turmaOficial,
  ]
    .map((s) => String(s || '').trim())
    .filter(Boolean);

  for (const ofi of oficiais) {
    const mSem = ofi.match(/^(EM[I]?_\d+_[A-Z]+_)([12])(_[A-Z0-9]+)$/i);
    if (mSem) {
      const semAlvo = isSegundoSemestre ? '2' : '1';
      const semOutro = isSegundoSemestre ? '1' : '2';
      add(`${mSem[1]}${semAlvo}${mSem[3]}`);
      add(`${mSem[1]}${semOutro}${mSem[3]}`);
    }
    add(ofi);
  }

  if (dados?.turmas) {
    add(mapearTurma(dados.turmas));
    add(dados.turmas);

    const mEM = String(dados.turmas).trim().match(/^([123])[°ºª]?\s*(?:ANO|S[EÉ]RIE)\s*[-–]?\s*([A-Z0-9]+)$/i);
    if (mEM) {
      const num = mEM[1];
      const letra = mEM[2].toUpperCase();
      add(`${num}ª Série - ${letra}`);
      add(`${num}ª SÉRIE - ${letra}`);
      add(`${num}ª Série ${letra}`);
      add(`${num}º Ano - ${letra}`);
    }
  }

  return candidatos;
}

function turmasCorrespondemEducaDF(candidato, opcaoTexto) {
  const cNorm = normTexto(candidato);
  const oNorm = normTexto(opcaoTexto);
  if (!cNorm || !oNorm) return false;
  if (oNorm.includes('NO ITEMS') || oNorm.includes('NENHUM ITEM')) return false;
  if (cNorm === oNorm) return true;

  const extrairNumLetra = (str) => {
    const mPadrao = str.match(/^(\d+)\s*(?:ANO|SERIE)\s+([A-Z0-9]+)$/);
    if (mPadrao) return { num: mPadrao[1], letra: mPadrao[2], tipo: 'padrao' };
    const mCodigo = str.match(/^EM[I]?_(\d+)_[A-Z]+_[12]_([A-Z0-9]+)$/);
    if (mCodigo) return { num: mCodigo[1], letra: mCodigo[2], tipo: 'codigo' };
    return null;
  };

  const infoC = extrairNumLetra(cNorm);
  const infoO = extrairNumLetra(oNorm);
  if (infoC && infoO) {
    if (infoC.tipo === 'codigo' && infoO.tipo === 'codigo') {
      return cNorm === oNorm;
    }
    return infoC.num === infoO.num && infoC.letra === infoO.letra;
  }

  return textosCorrespondemSeguros(oNorm, cNorm);
}

function nomesCorrespondem(nomeA, nomeB) {
  if (!nomeA || !nomeB) return false;
  const toTokens = (s) =>
    String(s)
      .toUpperCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^A-Z0-9 ]/g, '')
      .split(/\s+/)
      .filter((t) => t.length > 2);

  const tokensA = toTokens(nomeA);
  const tokensB = toTokens(nomeB);
  const matches = tokensA.filter((t) => tokensB.some((tb) => tb.startsWith(t) || t.startsWith(tb)));
  const menor = Math.min(tokensA.length, tokensB.length);
  return menor > 0 && matches.length >= Math.ceil(menor * 0.6);
}

async function removerBackdrops(page) {
  await page
    .evaluate(() => {
      document
        .querySelectorAll('ngb-offcanvas-backdrop, .offcanvas-backdrop, .modal-backdrop')
        .forEach((el) => el.remove());
      document.body.classList.remove('modal-open', 'offcanvas-open');
      document.body.style.overflow = 'auto';

      const swalConfirm = document.querySelector(
        '.swal2-container button.swal2-confirm, .swal2-container .swal2-actions button:first-child'
      );
      if (swalConfirm) swalConfirm.click();
      else {
        const swalAny = document.querySelector('.swal2-container .swal2-close, .swal2-container button');
        if (swalAny) swalAny.click();
      }
    })
    .catch(() => {});
  await page.waitForSelector('.swal2-container', { state: 'hidden', timeout: 4000 }).catch(() => {});
}

async function aguardarSemOverlay(page) {
  await page.waitForSelector('#elmLoader, [id="elmLoader"]', { state: 'hidden', timeout: 20000 }).catch(() => {});
  const swalPresente = await page
    .evaluate(() => {
      const container = document.querySelector('.swal2-container');
      if (!container) return false;
      const style = window.getComputedStyle(container);
      return style.display !== 'none' && style.visibility !== 'hidden';
    })
    .catch(() => false);
  if (swalPresente) {
    await removerBackdrops(page);
    await page.waitForTimeout(600);
  }
  await page.waitForTimeout(350);
}

async function detectarErroPortalEducaDF(page) {
  const padroes = [
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
    const res = await page.evaluate((lista) => {
      const swal = document.querySelector('.swal2-container');
      if (swal) {
        const st = window.getComputedStyle(swal);
        if (st.display !== 'none' && st.visibility !== 'hidden') {
          const txt = (swal.textContent || '').toLowerCase();
          if (lista.some((p) => txt.includes(p))) {
            return {
              erro: true,
              mensagem: (
                swal.querySelector('.swal2-content, .swal2-html-container, p')?.textContent || txt
              )
                .trim()
                .substring(0, 200),
            };
          }
        }
      }
      const bodyText = (document.body?.textContent || '').toLowerCase();
      if (lista.some((p) => bodyText.includes(p))) {
        const h1 = document.querySelector('h1, h2')?.textContent?.trim() || '';
        return { erro: true, mensagem: (h1 || 'Erro detectado no portal EDUCADF').substring(0, 200) };
      }
      return { erro: false };
    }, padroes);
    if (res.erro) await removerBackdrops(page);
    return res;
  } catch {
    return { erro: false };
  }
}

async function selecionarLombada(page, labelPart, valorOuCandidatos, timeout = 10000, fuzzyFn = null) {
  const candidatos = [
    ...new Set(
      (Array.isArray(valorOuCandidatos) ? valorOuCandidatos : [valorOuCandidatos])
        .map((v) => String(v || '').trim())
        .filter(Boolean)
    ),
  ];
  if (candidatos.length === 0) return false;

  const btnInfo = await page.evaluate((lbl) => {
    const lblLow = lbl.toLowerCase();
    const btns = [...document.querySelectorAll('button.dc-lombada-botao')];
    const found = btns.find((b) => {
      const aria = (b.getAttribute('aria-label') || '').toLowerCase();
      const tit = (b.querySelector('.dc-lombada-titulo')?.textContent || '').toLowerCase();
      return aria.includes(lblLow) || tit.includes(lblLow);
    });
    if (!found) {
      const openNg = document.querySelector('app-lombada ng-select, .dc-lombada ng-select, ng-select');
      return { foundButton: false, hasOpenNgSelect: !!openNg };
    }
    const valorEl = found.querySelector('.dc-lombada-valor');
    return {
      foundButton: true,
      valorAtual: valorEl?.textContent?.trim() || '',
    };
  }, labelPart);

  if (!btnInfo?.foundButton && !btnInfo?.hasOpenNgSelect) return false;

  if (btnInfo.foundButton) {
    const { valorAtual } = btnInfo;
    if (valorAtual && valorAtual !== 'Escolher') {
      for (const cand of candidatos) {
        const jaOk = fuzzyFn
          ? fuzzyFn(cand, valorAtual)
          : textosCorrespondemSeguros(normTexto(valorAtual), normTexto(cand));
        if (jaOk) {
          console.log(`[educadf.freq] ⚡ Lombada "${labelPart}" já selecionada: "${valorAtual}"`);
          return true;
        }
      }
    }

    await page.evaluate((lbl) => {
      const lblLow = lbl.toLowerCase();
      const btns = [...document.querySelectorAll('button.dc-lombada-botao')];
      const found = btns.find((b) => {
        const aria = (b.getAttribute('aria-label') || '').toLowerCase();
        const tit = (b.querySelector('.dc-lombada-titulo')?.textContent || '').toLowerCase();
        return aria.includes(lblLow) || tit.includes(lblLow);
      });
      if (found) {
        found.scrollIntoViewIfNeeded?.();
        found.click();
      }
    }, labelPart);
  } else {
    await page
      .evaluate(() => {
        const ng = document.querySelector('app-lombada ng-select, .dc-lombada ng-select, ng-select');
        const container = ng?.querySelector('.ng-select-container');
        if (container && !document.querySelector('.ng-dropdown-panel')) container.click();
      })
      .catch(() => {});
  }

  const ngSelect = await page
    .waitForSelector('app-lombada ng-select, .dc-lombada ng-select, ng-select', { timeout: 6000 })
    .catch(() => null);
  await page
    .waitForSelector('.ng-option:not(.ng-option-disabled)', { timeout: Math.min(timeout, 8000) })
    .catch(() => null);
  await page.waitForTimeout(400);

  const encontrarEClicar = async () => {
    const opts = await page.$$('.ng-option:not(.ng-option-disabled)');
    const lidos = [];
    for (const opt of opts) {
      const txt = await opt.textContent().catch(() => '');
      lidos.push({ opt, txt, txtNorm: normTexto(txt) });
    }

    if (lidos.length > 0) {
      await page
        .evaluate(
          ({ lbl, opcoes }) => {
            window.__ultimasOpcoesLombada = window.__ultimasOpcoesLombada || {};
            window.__ultimasOpcoesLombada[lbl] = opcoes;
          },
          { lbl: labelPart, opcoes: lidos.map((i) => i.txt.trim()) }
        )
        .catch(() => {});
    }

    // Passada 1: exato
    for (const cand of candidatos) {
      const candNorm = normTexto(cand);
      for (const item of lidos) {
        if (item.txtNorm === candNorm) {
          await item.opt.click();
          await page.waitForTimeout(600);
          return true;
        }
      }
    }

    // Passada 2: seguro / fuzzy
    for (const cand of candidatos) {
      const candNorm = normTexto(cand);
      for (const item of lidos) {
        const match = fuzzyFn
          ? fuzzyFn(cand, item.txt)
          : textosCorrespondemSeguros(item.txtNorm, candNorm);
        if (match) {
          await item.opt.click();
          await page.waitForTimeout(600);
          return true;
        }
      }
    }
    return false;
  };

  if (await encontrarEClicar()) return true;

  const inp = ngSelect ? await ngSelect.$('input').catch(() => null) : null;
  if (inp) {
    const termosBusca = [
      ...new Set(
        candidatos.flatMap((cand) => {
          const limpo = cand.replace(/[°ºª]/g, '').replace(/\s*-\s*/g, ' ').replace(/\s+/g, ' ').trim();
          const partes = limpo.split(' ').filter(Boolean);
          const curto = partes.length > 2 ? partes.slice(0, 3).join(' ') : limpo;
          return [cand, limpo, curto].filter(Boolean);
        })
      ),
    ];

    for (const termo of termosBusca) {
      await inp.fill('').catch(() => {});
      await inp.fill(termo).catch(() => {});
      await page.waitForTimeout(900);
      if (await encontrarEClicar()) return true;
    }
    await inp.fill('').catch(() => {});
  }

  await page.keyboard.press('Escape').catch(() => {});
  return false;
}

function hhmmParaMinutos(str) {
  const m = String(str || '').match(/(\d{1,2}):(\d{2})/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * Navega o FullCalendar do EDUCADF até o mês/ano desejado (`anoAlvo`, `mesAlvo` 1..12).
 */
async function navegarFullCalendarParaMesAno(page, session, anoAlvo, mesAlvo) {
  const fcEventSelector = '.fc-event:not(.external-event), .fc-daygrid-event, .fc-timegrid-event';

  for (let passo = 0; passo < 16; passo++) {
    const infoAtual = await page.evaluate(() => {
      const titleEl = document.querySelector('.fc-toolbar-title, .fc-center h2, .fc-toolbar h2');
      if (!titleEl) return null;
      const txt = (titleEl.textContent || '').toLowerCase().trim();
      const meses = {
        janeiro: 1,
        fevereiro: 2,
        março: 3,
        marco: 3,
        abril: 4,
        maio: 5,
        junho: 6,
        julho: 7,
        agosto: 8,
        setembro: 9,
        outubro: 10,
        novembro: 11,
        dezembro: 12,
      };
      let mes = null;
      for (const [nome, num] of Object.entries(meses)) {
        if (txt.includes(nome)) {
          mes = num;
          break;
        }
      }
      const mAno = txt.match(/\b(20\d{2})\b/);
      const ano = mAno ? Number(mAno[1]) : new Date().getFullYear();
      return mes ? { mes, ano, titulo: txt } : null;
    });

    if (!infoAtual) return false;
    if (infoAtual.ano === anoAlvo && infoAtual.mes === mesAlvo) {
      return true;
    }

    const diffMeses = (anoAlvo - infoAtual.ano) * 12 + (mesAlvo - infoAtual.mes);
    const btnSel =
      diffMeses < 0
        ? '.fc-prev-button, .fc-toolbar button[aria-label="prev"], button.fc-prev-button'
        : '.fc-next-button, .fc-toolbar button[aria-label="next"], button.fc-next-button';

    const clicou = await page.evaluate((sel) => {
      const btn = document.querySelector(sel);
      if (btn && !btn.disabled) {
        btn.click();
        return true;
      }
      return false;
    }, btnSel);

    if (!clicou) return false;
    await session.delay(850);
    await page.waitForSelector(fcEventSelector, { timeout: 3000 }).catch(() => {});
  }
  return false;
}

/**
 * Clica no evento de aula dentro da célula exata `[data-date="YYYY-MM-DD"]` no FullCalendar.
 */
async function abrirEventoDaDataNoCalendario(page, dataIso, candidatosTurma, componenteEducaDF, eventoIdx = 0) {
  await aguardarSemOverlay(page);

  const clicou = await page.evaluate(
    ({ iso, candsTurma, compAlvo, evIndex }) => {
      const norm = (s) =>
        String(s || '')
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .toUpperCase()
          .replace(/[^A-Z0-9\s]/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();

      const compNorm = norm(compAlvo);
      const compTkns = compNorm.split(' ').filter((t) => t.length > 1);
      const romanosRe = /\b(III|II|I|IV|V)\b/g;
      const romComp = (compNorm.match(romanosRe) || []).join(',');

      const turmaTokensList = (candsTurma || [])
        .map((c) => norm(c).split(' ').filter((t) => t.length > 0))
        .filter((arr) => arr.length > 0);

      const matchComp = (txt) => {
        const n = norm(txt);
        if (!n || !compNorm) return true;
        const romEv = (n.match(romanosRe) || []).join(',');
        if (romComp && romEv && romComp !== romEv) return false;
        if (n.includes(compNorm)) return true;
        return compTkns.length > 0 && compTkns.every((c) => n.includes(c));
      };

      const matchTurma = (txt) => {
        const n = norm(txt);
        if (!turmaTokensList.length) return true;
        return turmaTokensList.some((tkns) => tkns.every((t) => n.includes(t)));
      };

      // Localiza todas as células ou containers da data exata YYYY-MM-DD
      const cells = [...document.querySelectorAll(`[data-date="${iso}"]`)];
      const eventos = [];
      for (const cell of cells) {
        const evs = [
          ...cell.querySelectorAll(
            'a.fc-event:not(.external-event), .fc-daygrid-event:not(.external-event), .fc-timegrid-event:not(.external-event), .fc-event:not(.external-event)'
          ),
        ];
        for (const ev of evs) {
          if (ev.offsetParent !== null && !eventos.includes(ev)) {
            eventos.push(ev);
          }
        }
      }

      if (eventos.length === 0) {
        return { ok: false, motivo: 'SEM_EVENTO_NA_DATA' };
      }

      // Filtra lista ordenada de eventos candidatos do dia
      const candidatos =
        eventos.filter((ev) => matchTurma(ev.textContent) && matchComp(ev.textContent)).length > 0
          ? eventos.filter((ev) => matchTurma(ev.textContent) && matchComp(ev.textContent))
          : eventos.filter((ev) => matchComp(ev.textContent)).length > 0
          ? eventos.filter((ev) => matchComp(ev.textContent))
          : eventos;

      const escolhido = candidatos[evIndex] || (evIndex === 0 ? candidatos[0] : null);
      if (!escolhido) {
        return { ok: false, motivo: 'INDICE_EVENTO_ESGOTADO', totalEventosCompNoDia: candidatos.length };
      }

      escolhido.scrollIntoView({ block: 'center' });
      escolhido.click();
      return {
        ok: true,
        texto: (escolhido.textContent || '').trim().substring(0, 80),
        totalEventosCompNoDia: candidatos.length,
      };
    },
    { iso: dataIso, candsTurma: candidatosTurma, compAlvo: componenteEducaDF, evIndex: eventoIdx }
  );

  if (!clicou?.ok) {
    return clicou || { ok: false, motivo: 'FALHA_CLICK_EVENTO' };
  }

  // Aguarda a gaveta <ngb-offcanvas-panel> montar no DOM
  const abriuOffcanvas = await page
    .waitForSelector('ngb-offcanvas-panel, app-frequencia-modal, table#grid-seedf', { timeout: 12000 })
    .then(() => true)
    .catch(() => false);

  if (!abriuOffcanvas) {
    return { ok: false, motivo: 'OFFCANVAS_NAO_ABRIU' };
  }

  return { ok: true, texto: clicou.texto, totalEventosCompNoDia: clicou.totalEventosCompNoDia || 1 };
}

/**
 * Associa as aulas confirmadas de um dia (`aulasDoDia`, ordenadas por `ordem`)
 * às colunas de horário (`colunasPortal`: `[{ colIdx, textoHorario, iniMin }]`) da `table#grid-seedf`.
 */
function associarAulasAsColunasPortal(aulasDoDia, colunasPortal) {
  const usadas = new Set();
  const associacoes = [];

  const ordenadas = [...aulasDoDia].sort(
    (a, b) => Number(a.ordem || 1) - Number(b.ordem || 1)
  );

  // Caso 1: Quantidade de aulas confirmadas coincide exatamente com a quantidade de colunas da aula no dia
  if (ordenadas.length === colunasPortal.length) {
    for (let i = 0; i < ordenadas.length; i++) {
      associacoes.push({ aula: ordenadas[i], colPortal: colunasPortal[i] });
    }
    return associacoes;
  }

  // Caso 2: Tenta match por horário de início HH:MM (tolerância de até 25 min)
  for (const aula of ordenadas) {
    const minAula = hhmmParaMinutos(aula.horario);
    let melhorCol = null;
    let menorDiff = 999;

    if (minAula !== null) {
      for (const col of colunasPortal) {
        if (usadas.has(col.colIdx) || col.iniMin === null) continue;
        const diff = Math.abs(col.iniMin - minAula);
        if (diff <= 25 && diff < menorDiff) {
          menorDiff = diff;
          melhorCol = col;
        }
      }
    }

    if (melhorCol) {
      usadas.add(melhorCol.colIdx);
      associacoes.push({ aula, colPortal: melhorCol });
    }
  }

  // Caso 3: Fallback posicional para aulas restantes
  const restantes = ordenadas.filter((a) => !associacoes.some((x) => x.aula === a));
  for (const aula of restantes) {
    const idxPreferido = Math.max(0, Math.min(colunasPortal.length - 1, (Number(aula.ordem) || 1) - 1));
    const colLivre =
      (!usadas.has(idxPreferido) && colunasPortal[idxPreferido]) ||
      colunasPortal.find((c) => !usadas.has(c.colIdx));
    if (colLivre) {
      usadas.add(colLivre.colIdx);
      associacoes.push({ aula, colPortal: colLivre });
    }
  }

  return associacoes;
}

/**
 * Preenche e salva a frequência de um dia (`dataIso`) dentro do `<ngb-offcanvas-panel>` aberto.
 */
async function preencherESalvarFrequenciaDoDia(page, session, dataIso, aulasDoDia) {
  await aguardarSemOverlay(page);

  // 1) Garante que a aba "Frequência" esteja ativa (sem re-clicar se já estiver ativa!)
  await page.evaluate(() => {
    const offcanvas = document.querySelector('ngb-offcanvas-panel') || document;
    const tabs = [...offcanvas.querySelectorAll('a.nav-link, button.nav-link, [role="tab"]')];
    const tabFreq = tabs.find((el) => {
      const t = (el.textContent || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .trim();
      return t === 'frequencia' || t.startsWith('frequencia');
    });
    if (tabFreq) {
      const isAtiva =
        tabFreq.classList.contains('active') || tabFreq.getAttribute('aria-selected') === 'true';
      if (!isAtiva) tabFreq.click();
    }
  });

  // 2) Aguarda `table#grid-seedf` carregar cabeçalhos e linhas de estudantes
  const tabelaOk = await page
    .waitForSelector('ngb-offcanvas-panel table#grid-seedf tbody tr, table.dc-tabela tbody tr', {
      timeout: 12000,
    })
    .then(() => true)
    .catch(() => false);

  if (!tabelaOk) {
    return { ok: false, motivo: 'TABELA_FREQUENCIA_NAO_CARREGOU' };
  }

  await page.waitForTimeout(500);

  // 3) Lê as colunas de horário disponíveis no cabeçalho da tabela
  const colunasRaw = await page.evaluate(() => {
    const offcanvas = document.querySelector('ngb-offcanvas-panel') || document;
    const ths = [...offcanvas.querySelectorAll('table#grid-seedf thead th.freq-col-horario, table.dc-tabela thead th.freq-col-horario')];
    return ths.map((th, idx) => {
      const txtHorario = (th.querySelector('.border-bottom')?.textContent || th.textContent || '').trim();
      return {
        colIdx: idx,
        textoHorario: txtHorario.substring(0, 30),
      };
    });
  });

  if (!colunasRaw || colunasRaw.length === 0) {
    return { ok: false, motivo: 'SEM_COLUNAS_HORARIO_NO_DIARIO' };
  }

  const colunasPortal = colunasRaw.map((c) => ({
    ...c,
    iniMin: hhmmParaMinutos(c.textoHorario),
  }));

  const associacoes = associarAulasAsColunasPortal(aulasDoDia, colunasPortal);
  if (associacoes.length === 0) {
    return { ok: false, motivo: 'NAO_FOI_POSSIVEL_ASSOCIAR_COLUNAS' };
  }

  // 4) Para cada coluna associada, clica primeiro em "Marcar todos presentes" e depois ajusta P/F por aluno
  let totalFaltasMarcadasNoDia = 0;
  let totalAlunosConferidos = 0;

  for (const { aula, colPortal } of associacoes) {
    const colIdx = colPortal.colIdx;

    // 4.1) Clica em "Marcar todos presentes" da coluna `colIdx`
    await page.evaluate((cIdx) => {
      const offcanvas = document.querySelector('ngb-offcanvas-panel') || document;
      const ths = [
        ...offcanvas.querySelectorAll(
          'table#grid-seedf thead th.freq-col-horario, table.dc-tabela thead th.freq-col-horario'
        ),
      ];
      const th = ths[cIdx];
      if (!th) return;
      const btnTodos = [...th.querySelectorAll('button')].find((b) =>
        (b.textContent || '').toLowerCase().includes('marcar todos presentes')
      );
      if (btnTodos && !btnTodos.disabled) {
        btnTodos.click();
      }
    }, colIdx);

    await page.waitForTimeout(450);

    // Prepara conjuntos normalizados de RE e Nome dos alunos que faltaram nesta aula
    const faltasAlunos = Array.isArray(aula.faltas_alunos) ? aula.faltas_alunos : [];
    const resAusentes = faltasAlunos
      .map((a) => String(a.codigo || '').replace(/\D/g, '').replace(/^0+/, ''))
      .filter((s) => s.length >= 3);
    const nomesAusentes = faltasAlunos
      .map((a) => normTexto(a.nome))
      .filter(Boolean);

    // 4.2) Percorre as linhas `tbody tr` e garante `F` para ausentes e `P` para presentes
    const ajusteCol = await page.evaluate(
      ({ cIdx, resFaltas, nomesFaltas }) => {
        const norm = (s) =>
          String(s || '')
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .toUpperCase()
            .replace(/[^A-Z0-9\s]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();

        const setRe = new Set(resFaltas || []);
        const setNomes = new Set(nomesFaltas || []);

        const alunoEstaAusente = (reLimpo, nomeNorm) => {
          if (reLimpo && setRe.has(reLimpo)) return true;
          if (nomeNorm && setNomes.has(nomeNorm)) return true;
          if (nomeNorm) {
            const tkns = nomeNorm.split(' ').filter((t) => t.length > 2);
            if (tkns.length >= 2) {
              for (const nAlvo of setNomes) {
                const tkAlvo = nAlvo.split(' ').filter((t) => t.length > 2);
                if (
                  tkAlvo.length >= 2 &&
                  tkns[0] === tkAlvo[0] &&
                  tkns[tkns.length - 1] === tkAlvo[tkAlvo.length - 1]
                ) {
                  return true;
                }
              }
            }
          }
          return false;
        };

        const offcanvas = document.querySelector('ngb-offcanvas-panel') || document;
        const trs = [
          ...offcanvas.querySelectorAll(
            'table#grid-seedf tbody tr, table.dc-tabela tbody tr'
          ),
        ];

        let faltasAplicadas = 0;
        let linhasLidas = 0;

        for (const tr of trs) {
          const nomeEl = tr.querySelector('.dc-identificacao .fw-semibold, th.dc-col-estudante .fw-semibold');
          const reEl = tr.querySelector('.freq-re');
          // Ignora os spans visually-hidden dentro de .fw-semibold pegando apenas o 1º nó de texto ou limpando avisos
          let nomeBruto = '';
          if (nomeEl) {
            const clone = nomeEl.cloneNode(true);
            clone.querySelectorAll('.visually-hidden, .badge, button, i').forEach((n) => n.remove());
            nomeBruto = clone.textContent || '';
          }
          const nomeNorm = norm(nomeBruto);

          const reTexto = (reEl?.getAttribute('title') || reEl?.textContent || '').trim();
          const mRe = reTexto.match(/RE\s*0*(\d+)/i);
          const reLimpo = mRe ? mRe[1] : '';

          const tds = [...tr.querySelectorAll('td.freq-col-horario')];
          const td = tds[cIdx];
          const btnPresenca = td?.querySelector('button.dc-presenca, button[role="switch"]');
          if (!btnPresenca) continue;

          linhasLidas++;
          const estadoAtual = (
            btnPresenca.getAttribute('data-presenca') ||
            btnPresenca.textContent ||
            ''
          )
            .trim()
            .toUpperCase();

          const deveFaltar = alunoEstaAusente(reLimpo, nomeNorm);

          if (deveFaltar) {
            if (estadoAtual !== 'F') {
              btnPresenca.click();
            }
            faltasAplicadas++;
          } else if (estadoAtual === 'F') {
            // Se havia uma falta antiga salva no EDUCADF e agora o aluno está presente no EducaMelhor, corrige para P
            btnPresenca.click();
          }
        }

        return { faltasAplicadas, linhasLidas };
      },
      { cIdx: colIdx, resFaltas: resAusentes, nomesFaltas: nomesAusentes }
    );

    totalFaltasMarcadasNoDia += ajusteCol?.faltasAplicadas || 0;
    totalAlunosConferidos = Math.max(totalAlunosConferidos, ajusteCol?.linhasLidas || 0);
    await page.waitForTimeout(300);
  }

  // 5) Clica no botão verde "Salvar" no rodapé `.dc-barra-acoes` da gaveta
  let salvouInfo = await page.evaluate(() => {
    const offcanvas = document.querySelector('ngb-offcanvas-panel') || document;
    const btns = [
      ...offcanvas.querySelectorAll(
        '.dc-barra-acoes button.btn-success, app-frequencia-modal button.btn-success, ngb-offcanvas-panel button.btn-success'
      ),
    ];
    const btnSalvar = btns.find((b) => (b.textContent || '').toLowerCase().includes('salvar')) || btns[btns.length - 1];
    if (!btnSalvar) return { clicked: false, exists: false, disabled: false };
    if (btnSalvar.disabled) return { clicked: false, exists: true, disabled: true };
    btnSalvar.scrollIntoView({ block: 'center' });
    btnSalvar.click();
    return { clicked: true, exists: true, disabled: false };
  });

  // Se o botão Salvar estava desabilitado (ex.: re-exportação idempotente onde o Angular mantém form.pristine),
  // força um duplo toggle rápido no 1º switch da coluna para marcar dirty ou aceita idempotência
  if (!salvouInfo.clicked && salvouInfo.exists && salvouInfo.disabled && totalAlunosConferidos > 0) {
    await page
      .evaluate(() => {
        const sw = document.querySelector(
          'ngb-offcanvas-panel table#grid-seedf tbody button.dc-presenca, ngb-offcanvas-panel button[role="switch"]'
        );
        if (sw && !sw.disabled) {
          sw.click();
          sw.click();
        }
      })
      .catch(() => {});
    await page.waitForTimeout(250);
    salvouInfo = await page.evaluate(() => {
      const offcanvas = document.querySelector('ngb-offcanvas-panel') || document;
      const btns = [
        ...offcanvas.querySelectorAll(
          '.dc-barra-acoes button.btn-success, app-frequencia-modal button.btn-success, ngb-offcanvas-panel button.btn-success'
        ),
      ];
      const btnSalvar =
        btns.find((b) => (b.textContent || '').toLowerCase().includes('salvar')) || btns[btns.length - 1];
      if (!btnSalvar) return { clicked: false, exists: false, disabled: false };
      if (btnSalvar.disabled) return { clicked: false, exists: true, disabled: true, idempotente: true };
      btnSalvar.scrollIntoView({ block: 'center' });
      btnSalvar.click();
      return { clicked: true, exists: true, disabled: false };
    });
  }

  if (!salvouInfo.clicked && !salvouInfo.idempotente) {
    return { ok: false, motivo: 'BOTAO_SALVAR_DESABILITADO_OU_AUSENTE' };
  }

  if (salvouInfo.clicked) {
    // Aguarda o salvamento XHR concluir (`aria-busy="false"` e estabilização Angular)
    await page.waitForTimeout(1200);
    await page
      .waitForFunction(
        () => {
          const btn = document.querySelector('ngb-offcanvas-panel .dc-barra-acoes button.btn-success');
          return !btn || btn.getAttribute('aria-busy') !== 'true';
        },
        { timeout: 15000 }
      )
      .catch(() => {});
    await aguardarSemOverlay(page);
    await session.delay(800);
  }

  // 6) Fecha a gaveta `<ngb-offcanvas-panel>` caso ainda esteja aberta para liberar o clique na próxima data
  await page
    .evaluate(() => {
      const offcanvas = document.querySelector('ngb-offcanvas-panel');
      if (!offcanvas) return;
      const btnClose =
        offcanvas.querySelector('button.btn-close[aria-label*="Fechar"]') ||
        offcanvas.querySelector('button.btn-close') ||
        [...offcanvas.querySelectorAll('.dc-barra-acoes button')].find((b) =>
          (b.textContent || '').toLowerCase().includes('fechar')
        );
      if (btnClose) btnClose.click();
    })
    .catch(() => {});

  await page.waitForSelector('ngb-offcanvas-panel', { state: 'hidden', timeout: 6000 }).catch(async () => {
    await page.keyboard.press('Escape').catch(() => {});
    await removerBackdrops(page);
  });

  return {
    ok: true,
    aulasSalvasNoDia: associacoes.map((x) => x.aula.ordem),
    faltasAplicadas: totalFaltasMarcadasNoDia,
    alunosConferidos: totalAlunosConferidos,
  };
}

/**
 * Exporta em lote todas as chamadas confirmadas de uma turma/disciplina/bimestre para o EDUCADF.
 * @param {object} session Instância de `EducaDFBrowser`
 * @param {object} credentials `{ login, senha, perfil }`
 * @param {object} dadosChamada `{ turmas, turno, turmasOficiais, disciplina, disciplinaOficial, bimestre, professorNome, escola, governanca, aulas }`
 * @param {function} [onProgress] Callback opcional chamado a cada data processada
 */
export async function exportarFrequenciaEducaDF(session, credentials, dadosChamada, onProgress = null) {
  const page = session.page;
  const startedAt = Date.now();

  if (!page) {
    return { ok: false, message: 'Sessão do navegador não está ativa.', durationMs: 0 };
  }

  const listaAulas = Array.isArray(dadosChamada?.aulas)
    ? dadosChamada.aulas.filter((a) => a && a.data && a.confirmada !== false)
    : [];

  if (listaAulas.length === 0) {
    return {
      ok: false,
      message: 'Nenhuma aula confirmada encontrada para migrar ao EDUCADF.',
      durationMs: 0,
    };
  }

  // Agrupa aulas por data YYYY-MM-DD em ordem cronológica
  const porDataMap = new Map();
  for (const a of listaAulas) {
    const iso = String(a.data).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) continue;
    if (!porDataMap.has(iso)) porDataMap.set(iso, []);
    porDataMap.get(iso).push(a);
  }
  const datasOrdenadas = Array.from(porDataMap.keys()).sort();

  try {
    // ── PASSO 1: Login no EDUCADF ───────────────────────────────────────────
    if (onProgress) onProgress({ etapa: 'Autenticando no portal EDUCADF...', datasProcessadas: 0, totalDatas: datasOrdenadas.length });
    console.log('[educadf.freq] 1/5 Autenticando no portal EDUCADF...');
    const loginResult = await loginEducaDF(session, credentials);
    if (!loginResult.ok) {
      return {
        ok: false,
        message: `Falha no login do EDUCADF: ${loginResult.message}`,
        errorCode: loginResult.errorCode,
        durationMs: Date.now() - startedAt,
      };
    }
    await removerBackdrops(page);
    await session.delay(TIMING.postLoginDelay);

    // ── PASSO 2: Navegar direto ao Calendário do Diário de Classe ───────────
    if (onProgress) onProgress({ etapa: 'Abrindo Calendário do Diário de Classe...', datasProcessadas: 0, totalDatas: datasOrdenadas.length });
    console.log('[educadf.freq] 2/5 Abrindo Calendário do Diário de Classe...');
    await session.navigateTo('https://educadf.se.df.gov.br/diario_classe/modulos/calendario');
    await session.delay(TIMING.navigationDelay);

    const erroPortal = await detectarErroPortalEducaDF(page);
    await removerBackdrops(page);
    if (erroPortal.erro) {
      throw Object.assign(
        new Error(`EDUCADF está apresentando instabilidade: ${erroPortal.mensagem}`),
        { errorCode: 'PORTAL_INDISPONIVEL' }
      );
    }

    // ── PASSO 3: Selecionar Lombada (Unidade Escolar, Turma, Professor, Componente) + Filtrar ──
    const componenteEducaDF = mapearDisciplina(dadosChamada.disciplina, dadosChamada.disciplinaOficial);
    const candidatosTurma = gerarCandidatosTurma(dadosChamada);

    if (onProgress) {
      onProgress({
        etapa: `Selecionando turma ${dadosChamada.turmas} (${componenteEducaDF})...`,
        datasProcessadas: 0,
        totalDatas: datasOrdenadas.length,
      });
    }

    const isLombada = await page
      .waitForSelector('button.dc-lombada-botao', { timeout: 12000 })
      .then(() => true)
      .catch(() => false);

    if (!isLombada) {
      throw Object.assign(
        new Error('Barra de filtros do Diário de Classe não carregou no EDUCADF. Tente novamente em instantes.'),
        { errorCode: 'PORTAL_INDISPONIVEL' }
      );
    }

    const candidatosEscola = [dadosChamada.escola?.nomeOficial, dadosChamada.escola?.nomeBusca]
      .map((s) => String(s || '').trim())
      .filter(Boolean);
    if (candidatosEscola.length > 0) {
      await selecionarLombada(page, 'Unidade escolar', candidatosEscola, 8000).catch(() => {});
      await page.waitForTimeout(450);
    }

    const turmaOk = await selecionarLombada(
      page,
      'Turma',
      candidatosTurma,
      10000,
      turmasCorrespondemEducaDF
    );
    if (!turmaOk) {
      const opcoesVisiveis = await page
        .evaluate(() => window.__ultimasOpcoesLombada?.['Turma'] || [])
        .catch(() => []);
      const detalhe = opcoesVisiveis.length ? ` (Disponíveis: ${opcoesVisiveis.slice(0, 12).join(', ')})` : '';
      throw new Error(`Turma "${dadosChamada.turmas}" não encontrada no EDUCADF${detalhe}.`);
    }
    await page.waitForTimeout(700);

    if (dadosChamada.professorNome) {
      await selecionarLombada(page, 'Professor', dadosChamada.professorNome, 8000, nomesCorrespondem).catch(() => {});
      await page.waitForTimeout(600);
    }

    if (componenteEducaDF) {
      const compOk = await selecionarLombada(page, 'Componente', componenteEducaDF);
      if (!compOk) {
        await selecionarLombada(page, 'Curricular', componenteEducaDF);
      }
      await page.waitForTimeout(500);
    }

    console.log('[educadf.freq] 3/5 Clicando em Filtrar...');
    await page
      .locator(
        "button.dc-lombada-filtrar, app-button-filtrar button, button.btn-primary:has-text('Filtrar'), button:has-text('Filtrar')"
      )
      .first()
      .click({ timeout: 8000 })
      .catch(() => {});
    await page.waitForTimeout(1500);
    await aguardarSemOverlay(page);

    // ── PASSO 4: Iterar pelas Datas Confirmadas e Lançar Frequência ─────────
    const datasExportadas = [];
    const datasComAviso = [];
    let totalAulasExportadas = 0;

    for (let idx = 0; idx < datasOrdenadas.length; idx++) {
      const dataIso = datasOrdenadas[idx];
      const aulasDoDia = porDataMap.get(dataIso) || [];
      const [anoNum, mesNum, diaNum] = dataIso.split('-').map(Number);
      const dataBr = `${String(diaNum).padStart(2, '0')}/${String(mesNum).padStart(2, '0')}/${anoNum}`;

      if (onProgress) {
        onProgress({
          etapa: `Lançando frequência do dia ${dataBr} (${idx + 1}/${datasOrdenadas.length})...`,
          dataAtual: dataIso,
          datasProcessadas: idx,
          totalDatas: datasOrdenadas.length,
          aulasExportadas: totalAulasExportadas,
        });
      }

      const mesOk = await navegarFullCalendarParaMesAno(page, session, anoNum, mesNum);
      if (!mesOk) {
        datasComAviso.push({
          data: dataIso,
          motivo: `Não foi possível navegar até ${String(mesNum).padStart(2, '0')}/${anoNum} no calendário EDUCADF.`,
        });
        continue;
      }

      const abertura = await abrirEventoDaDataNoCalendario(
        page,
        dataIso,
        candidatosTurma,
        componenteEducaDF,
        0
      );
      if (!abertura.ok) {
        datasComAviso.push({
          data: dataIso,
          motivo:
            abertura.motivo === 'SEM_EVENTO_NA_DATA'
              ? `Sem aula gerada no calendário do EDUCADF na data ${dataBr}.`
              : `Não foi possível abrir o diário do dia ${dataBr} (${abertura.motivo}).`,
        });
        continue;
      }

      const resDia = await preencherESalvarFrequenciaDoDia(page, session, dataIso, aulasDoDia);
      if (resDia.ok) {
        const ordensSalvas = [...(resDia.aulasSalvasNoDia || [])];
        let faltasSalvasNoDia = resDia.faltasAplicadas || 0;

        // Se o EDUCADF separou períodos não-contíguos do mesmo dia em 2 eventos distintos no calendário,
        // processa os eventos adicionais para as aulas restantes do dia
        if (
          ordensSalvas.length < aulasDoDia.length &&
          (abertura.totalEventosCompNoDia || 1) > 1
        ) {
          for (
            let evIdx = 1;
            evIdx < abertura.totalEventosCompNoDia && ordensSalvas.length < aulasDoDia.length;
            evIdx++
          ) {
            const aulasRestantes = aulasDoDia.filter(
              (a) => !ordensSalvas.includes(Number(a.ordem) || 1)
            );
            if (aulasRestantes.length === 0) break;
            const abExtra = await abrirEventoDaDataNoCalendario(
              page,
              dataIso,
              candidatosTurma,
              componenteEducaDF,
              evIdx
            );
            if (!abExtra.ok) break;
            const resExtra = await preencherESalvarFrequenciaDoDia(
              page,
              session,
              dataIso,
              aulasRestantes
            );
            if (resExtra.ok) {
              for (const o of resExtra.aulasSalvasNoDia || []) {
                if (!ordensSalvas.includes(o)) ordensSalvas.push(o);
              }
              faltasSalvasNoDia += resExtra.faltasAplicadas || 0;
            } else {
              await page.keyboard.press('Escape').catch(() => {});
              await removerBackdrops(page);
            }
          }
        }

        datasExportadas.push({
          data: dataIso,
          ordens: ordensSalvas,
          faltasAplicadas: faltasSalvasNoDia,
        });
        totalAulasExportadas += ordensSalvas.length || aulasDoDia.length;
        if (onProgress) {
          onProgress({
            etapa: `✓ Frequência salva em ${dataBr} (${idx + 1}/${datasOrdenadas.length})`,
            dataConcluida: dataIso,
            ordensConcluidas:
              ordensSalvas.length > 0
                ? ordensSalvas
                : aulasDoDia.map((a) => Number(a.ordem) || 1),
            datasProcessadas: idx + 1,
            totalDatas: datasOrdenadas.length,
            aulasExportadas: totalAulasExportadas,
          });
        }
      } else {
        // Garante fechamento do offcanvas em caso de falha parcial no dia
        await page.keyboard.press('Escape').catch(() => {});
        await removerBackdrops(page);
        datasComAviso.push({
          data: dataIso,
          motivo: `Falha ao salvar frequência do dia ${dataBr} (${resDia.motivo}).`,
        });
      }
    }

    const screenshotFinal = await session.screenshot('freq_final_resumo').catch(() => null);
    const sucessoGeral = datasExportadas.length > 0;

    let msgResumo = '';
    if (datasExportadas.length === datasOrdenadas.length) {
      msgResumo = `Frequência migrada com 100% de sucesso para o EDUCADF: ${totalAulasExportadas} aula(s) em ${datasExportadas.length} dia(s) letivo(s)!`;
    } else if (datasExportadas.length > 0) {
      msgResumo = `Migração concluída parcialmente: ${datasExportadas.length} de ${datasOrdenadas.length} dia(s) salvos no EDUCADF (${datasComAviso.length} data(s) sem evento correspondente no portal).`;
    } else {
      const primeiroMotivo = datasComAviso[0]?.motivo || 'Nenhuma data encontrada no calendário do EDUCADF.';
      msgResumo = `Nenhuma aula pôde ser salva no EDUCADF. Detalhe: ${primeiroMotivo}`;
    }

    return {
      ok: sucessoGeral,
      parcial: sucessoGeral && datasComAviso.length > 0,
      message: msgResumo,
      totalDatasSolicitadas: datasOrdenadas.length,
      totalDatasExportadas: datasExportadas.length,
      totalAulasExportadas,
      datasExportadas,
      avisos: datasComAviso,
      screenshotPath: screenshotFinal,
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    console.error('[educadf.freq] Erro na migração de frequência:', err.message);
    const shotErro = await session.screenshot('freq_erro').catch(() => null);
    return {
      ok: false,
      message: err.message || 'Erro inesperado durante a migração de frequência para o EDUCADF.',
      errorCode: err.errorCode || null,
      screenshotPath: shotErro,
      durationMs: Date.now() - startedAt,
    };
  }
}
