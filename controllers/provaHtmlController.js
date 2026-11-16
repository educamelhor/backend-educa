// controllers/provaHtmlController.js
// EDUCA.PROVA — Gerador de HTML/PDF via Playwright (compatível com os 7 modelos universais, Smart Media e Modelo 01 Paginado A4)

import pool from '../db.js';
import { ensureProvasSchema, resolveProvaTemplate } from './provasController.js';

// ── Helpers ──────────────────────────────────────────────────────────────────
const escolaFilter = (escola_id) =>
  escola_id ? '(p.escola_id = ? OR p.escola_id IS NULL)' : '1=1';
const escolaParam = (escola_id) => (escola_id ? [escola_id] : []);

function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function txt(text = '') {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function parseJsonObj(raw, fallback = null) {
  if (!raw) return fallback;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return fallback; }
}

function parseAlts(raw) {
  if (Array.isArray(raw)) return raw;
  try { return JSON.parse(raw || '[]'); } catch { return []; }
}

function formatarMarkdownProsaSegura(escapedText = '') {
  return escapedText
    .replace(/\\textbf\{([^}]+)\}/g, '<strong>$1</strong>')
    .replace(/\\emph\{([^}]+)\}/g, '<em>$1</em>')
    .replace(/\*\*([\s\S]+?)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^\s_](?:[\s\S]*?[^\s_])?)__/g, '<u>$1</u>')
    .replace(/\*([^\s*](?:[^*\n]*?[^\s*])?)\*/g, '<em>$1</em>');
}

// Formata markdown editorial (**negrito**, __sublinhado__, *itálico*) mesmo quando contiver $...$ em seu interior!
function ltx(text = '') {
  if (!text) return '';
  const mathTokens = [];
  const masked = String(text || '').replace(/\$\$([\s\S]+?)\$\$|\$([^$\n]+)\$/g, (full, disp) => {
    const token = `@@MATH${mathTokens.length}@@`;
    mathTokens.push(
      disp !== undefined
        ? `<div class="math-block">${txt(full)}</div>`
        : `<span class="math">${txt(full)}</span>`
    );
    return token;
  });

  let html = formatarMarkdownProsaSegura(txt(masked));
  mathTokens.forEach((mathHtml, idx) => {
    html = html.replace(`@@MATH${idx}@@`, () => mathHtml);
  });

  return html
    .replace(/\r?\n*(<div class="math-block">[\s\S]*?<\/div>)\r?\n*/g, '$1')
    .replace(/\r?\n/g, '<br>');
}

function renderFigura(item, maxHeightPx = 240) {
  const midia = parseJsonObj(item.midia_json, null);
  const imgSrc = midia?.url || item.imagem_url || item.imagem_base64;
  if (!imgSrc) return { html: '', posicao: 'entre_enunciado_e_comando' };

  const presetMap = { P: '38%', M: '62%', G: '86%', '100%': '100%' };
  const widthCss = presetMap[midia?.preset] || '62%';
  const align = ['left', 'center', 'right'].includes(midia?.alinhamento) ? midia.alinhamento : 'center';
  const posicao = ['apos_texto_apoio', 'entre_enunciado_e_comando', 'abaixo_comando'].includes(midia?.posicao)
    ? midia.posicao
    : 'entre_enunciado_e_comando';

  const legLimpa = String(midia?.legenda || '').trim();
  const credBruto = String(midia?.credito || '').trim();
  const credEhRodape = /^(?:humanas|linguagens|matem[aá]tica|ci[êe]ncias|exatas)[\s\-–—_/0-9º°ªa-z]*$/i.test(credBruto);
  const credUtil = credBruto && !credEhRodape && !legLimpa.toLowerCase().includes(credBruto.toLowerCase())
    ? `Fonte: ${credBruto}`
    : '';
  const legendaTxt = [legLimpa, credUtil].filter(Boolean).join(' — ');

  const justifyMap = { left: 'flex-start', center: 'center', right: 'flex-end' };
  const html = `
    <figure class="questao-figura" style="display:flex;flex-direction:column;align-items:${justifyMap[align]};margin:5px 0;">
      <img src="${txt(imgSrc)}" alt="Figura da questão" style="width:${widthCss};max-width:100%;height:auto;max-height:${maxHeightPx}px;object-fit:contain;" />
      ${legendaTxt ? `<figcaption class="questao-legenda" style="width:${widthCss};text-align:${align};">${txt(legendaTxt)}</figcaption>` : ''}
    </figure>`;

  return { html, posicao };
}

function renderAlternativas(altsJson, correta, showGabarito = false, estiloAlt = 'maiuscula_parenteses') {
  const alts = parseAlts(altsJson).filter((a) => (a?.texto && String(a.texto).trim()) || a?.imagem_url);
  if (!alts.length) return '';
  return `<div class="alternativas">
    ${alts.map((a, idx) => {
      const letraUp = String(a.letra || String.fromCharCode(65 + idx)).toUpperCase().trim();
      const isCorr = showGabarito && (a.correta || letraUp === correta);
      const rotulo = estiloAlt === 'minuscula_parentese'
        ? `${txt(letraUp.toLowerCase())})`
        : `(${txt(letraUp)})`;
      const altImg = a.imagem_url
        ? `<div class="alt-img-wrap"><img src="${txt(a.imagem_url)}" alt="Alternativa ${txt(letraUp)}" /></div>`
        : '';
      return `<div class="alt${isCorr ? ' correta' : ''}">
        <span class="alt-letra">${rotulo}</span>
        <div class="alt-body">
          ${a.texto ? `<span class="alt-texto">${ltx(a.texto)}</span>` : ''}
          ${altImg}
        </div>
        ${isCorr ? '<span class="corr-mark">✔</span>' : ''}
      </div>`;
    }).join('')}
  </div>`;
}

function renderLinhasResposta(n = 6) {
  const qtd = Math.max(1, Math.min(20, Number(n) || 6));
  return `<div class="linhas-resposta">${Array.from({ length: qtd }, () =>
    '<div class="linha-resp"></div>'
  ).join('')}</div>`;
}

function renderCorpoModelo(item, template, showGabarito, estiloAlt = 'maiuscula_parenteses') {
  const est = parseJsonObj(item.estrutura_json, {}) || {};
  const tipo = item.tipo || est.modelo || (template === 'discursiva' ? 'discursiva' : 'objetiva');

  if (tipo === 'afirmativas') {
    const props = Array.isArray(est.proposicoes) ? est.proposicoes : [];
    const propsHtml = props.length ? `
      <div class="proposicoes-romanas">
        ${props.map((p, i) => {
          const rom = txt(p.romano || ['I', 'II', 'III', 'IV', 'V'][i] || String(i + 1));
          return `<div class="prop-item"><strong>${rom}.</strong> <span>${ltx(p.texto || '')}</span></div>`;
        }).join('')}
      </div>` : '';
    const cmdFech = est.comando_fechamento
      ? `<div class="comando-final">${ltx(est.comando_fechamento)}</div>`
      : '';
    return `${propsHtml}${cmdFech}${renderAlternativas(item.alternativas_json, item.correta, showGabarito, estiloAlt)}`;
  }

  if (tipo === 'verdadeiro_falso') {
    const itensVf = Array.isArray(est.itens) ? est.itens : [];
    const submodo = est.submodo || 'direto';
    const itensHtml = itensVf.length ? `
      <div class="vf-lista">
        ${itensVf.map((it) => {
          const gab = showGabarito && submodo === 'direto' ? `<strong>${txt(it.gabarito || 'V')}</strong>` : '&nbsp;&nbsp;&nbsp;';
          return `<div class="vf-item"><span class="vf-box">( ${gab} )</span> <span>${ltx(it.texto || '')}</span></div>`;
        }).join('')}
      </div>` : '';
    const justHtml = submodo === 'direto' && est.exigir_justificativa_falsas
      ? `<div class="vf-just-label">Justifique as afirmativas falsas:</div>${renderLinhasResposta(est.linhas_justificativa || 3)}`
      : '';
    const cmdSeqHtml = submodo === 'sequencia' && item.comando_final
      ? `<div class="comando-final">${ltx(item.comando_final)}</div>`
      : '';
    const seqHtml = submodo === 'sequencia'
      ? renderAlternativas(item.alternativas_json, item.correta, showGabarito, estiloAlt)
      : '';
    return `${itensHtml}${justHtml}${cmdSeqHtml}${seqHtml}`;
  }

  if (tipo === 'associacao') {
    const colA = Array.isArray(est.coluna_a) ? est.coluna_a : [];
    const colB = Array.isArray(est.coluna_b) ? est.coluna_b : [];
    const avgA = colA.length ? colA.reduce((s, x) => s + String(x?.texto || '').length, 0) / colA.length : 25;
    const avgB = colB.length ? colB.reduce((s, x) => s + String(x?.texto || '').length, 0) / colB.length : 45;
    const wA = avgA <= avgB * 0.58 ? '37%' : '46%';
    const wB = avgA <= avgB * 0.58 ? '63%' : '54%';
    const submodo = est.submodo || 'direto';
    const maxRows = Math.max(colA.length, colB.length);
    let rowsHtml = '';
    for (let i = 0; i < maxRows; i++) {
      const a = colA[i];
      const b = colB[i];
      const gabB = showGabarito && submodo === 'direto' && b?.vinculo_codigo
        ? `<strong>${txt(b.vinculo_codigo)}</strong>`
        : '&nbsp;&nbsp;&nbsp;';
      rowsHtml += `<tr>
        <td style="width:${wA};text-align:left;vertical-align:top;">${a ? `<div class="assoc-cell"><strong>(${txt(a.codigo || i + 1)})</strong><span>${ltx(a.texto || '')}</span></div>` : ''}</td>
        <td style="width:${wB};text-align:left;vertical-align:top;">${b ? `<div class="assoc-cell"><span class="vf-box">( ${gabB} )</span><span>${ltx(b.texto || '')}</span></div>` : ''}</td>
      </tr>`;
    }
    const tabHtml = maxRows > 0 ? `
      <table class="assoc-table">
        <thead>
          <tr>
            <th style="width:${wA};text-align:left;">${txt(est.titulo_coluna_a || 'Coluna A')}</th>
            <th style="width:${wB};text-align:left;">${txt(est.titulo_coluna_b || 'Coluna B')}</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>` : '';
    const cmdSeqHtml = submodo === 'sequencia' && item.comando_final
      ? `<div class="comando-final">${ltx(item.comando_final)}</div>`
      : '';
    const seqHtml = submodo === 'sequencia'
      ? renderAlternativas(item.alternativas_json, item.correta, showGabarito, estiloAlt)
      : '';
    return `${tabHtml}${cmdSeqHtml}${seqHtml}`;
  }

  if (tipo === 'lacuna') {
    const submodo = est.submodo || 'direto';
    let bancoHtml = '';
    if (submodo === 'banco_palavras') {
      const palavras = [...(est.lacunas || []), ...(est.distratores_banco || [])].filter(Boolean);
      const ordenadas = [...palavras].sort((a, b) => a.localeCompare(b, 'pt-BR'));
      if (ordenadas.length > 0) {
        bancoHtml = `<div class="banco-palavras"><strong>Banco de palavras:</strong> ${ordenadas.map((p) => `<span class="palavra-chip">${txt(p)}</span>`).join(' · ')}</div>`;
      }
    }
    const altsHtml = submodo === 'alternativas'
      ? renderAlternativas(item.alternativas_json, item.correta, showGabarito, estiloAlt)
      : '';
    return `${bancoHtml}${altsHtml}`;
  }

  if (tipo === 'somatoria') {
    const props = Array.isArray(est.proposicoes) ? est.proposicoes : [];
    const somaGab = showGabarito ? String(est.soma_correta ?? item.correta ?? '').padStart(2, '0') : '&nbsp;&nbsp;&nbsp;&nbsp;';
    return `
      <div class="somatoria-lista">
        ${props.map((p) => {
          const cod = txt(p.codigo || String(p.valor || '').padStart(2, '0'));
          const mark = showGabarito && p.correta ? ' <span class="corr-mark">✔</span>' : '';
          return `<div class="somatoria-item"><strong>(${cod})</strong> <span>${ltx(p.texto || '')}${mark}</span></div>`;
        }).join('')}
      </div>
      <div class="somatoria-box-wrap">
        <span class="somatoria-label">SOMA:</span>
        <span class="somatoria-box">${somaGab}</span>
      </div>`;
  }

  if (tipo === 'discursiva' || template === 'discursiva') {
    const formato = est.formato_espaco || 'linhas';
    const espacoHtml = formato === 'quadro_calculo'
      ? `<div class="quadro-calculo" style="height:${Math.max(80, Math.min(280, Number(est.altura_quadro_px) || 130))}px;"></div>`
      : formato === 'nenhum'
        ? ''
        : renderLinhasResposta(est.linhas_resposta || 6);
    const espelhoHtml = showGabarito && item.resposta_aberta
      ? `<div class="espelho-correcao"><strong>Espelho de Correção:</strong> ${ltx(item.resposta_aberta)}</div>`
      : '';
    return `${espacoHtml}${espelhoHtml}`;
  }

  return renderAlternativas(item.alternativas_json, item.correta, showGabarito, estiloAlt);
}

function formatarEnunciadoPrincipal(item, showGabarito) {
  const raw = item.conteudo_bruto || '';
  if ((item.tipo || '') === 'lacuna') {
    const htmlBase = ltx(raw);
    return htmlBase.replace(/\{\{([^}]+)\}\}/g, (_, resp) => {
      if (showGabarito) {
        return `<span class="lacuna-gab">${txt(resp)}</span>`;
      }
      const len = Math.max(8, Math.min(24, String(resp).length + 4));
      return `<span class="lacuna-blank">${'_'.repeat(len)}</span>`;
    });
  }
  return ltx(raw);
}

function resumirGabaritoProva(item) {
  const est = parseJsonObj(item.estrutura_json, {}) || {};
  const tipo = item.tipo || est.modelo || 'objetiva';
  const alts = parseAlts(item.alternativas_json);
  const altCorreta = alts.find((a) => a.correta)?.letra || item.correta;

  if (tipo === 'verdadeiro_falso' && (est.submodo || 'direto') === 'direto') {
    const seq = (est.itens || []).map((i) => i.gabarito || 'V').join(' - ');
    return seq || altCorreta || '—';
  }
  if (tipo === 'associacao' && (est.submodo || 'direto') === 'direto') {
    const seq = (est.coluna_b || []).map((b) => b.vinculo_codigo || '—').join(' - ');
    return seq || altCorreta || '—';
  }
  if (tipo === 'lacuna' && (est.submodo || 'direto') !== 'alternativas') {
    const matches = [...String(item.conteudo_bruto || '').matchAll(/\{\{([^}]+)\}\}/g)].map((m) => m[1].trim());
    const lacs = matches.length ? matches : (est.lacunas || []);
    return lacs.length ? lacs.join(' / ') : '—';
  }
  if (tipo === 'somatoria') {
    const s = est.soma_correta ?? item.correta;
    return s !== undefined && s !== null && s !== '' ? String(s).padStart(2, '0') : '—';
  }
  if (tipo === 'discursiva') {
    return item.resposta_aberta ? 'Discursiva (ver espelho)' : 'Discursiva';
  }
  return altCorreta || '—';
}

/* ══════════════════════════════════════════════════════════════════════════════
   MODELO 01 — CADERNO PROVÃO 2 COLUNAS (CLONE FIEL DE "9º ANO-EXATAS.docx")
   - Sem cabeçalho institucional
   - Moldura preta 2.25pt fechada nos 4 lados de cada folha A4
   - Duas colunas simétricas divididas por linha vertical central preta
   - Cada questão separada por "QUESTÃO XX" + retângulo sólido laranja (#FF7F00)
   - Rodapé posicionado ESTRITAMENTE FORA (abaixo) da moldura da página
══════════════════════════════════════════════════════════════════════════════ */
function gerarRodapeExternoPadrao(prova, cfg = {}) {
  const custom = String(cfg.rodape_texto || '').trim();
  if (custom) return custom;
  const partes = [
    String(prova.titulo || prova.disciplina || 'AVALIAÇÃO').trim().toUpperCase(),
    prova.turma ? String(prova.turma).trim().toUpperCase() : '',
    prova.bimestre ? `${prova.bimestre}º BIMESTRE` : '',
  ].filter(Boolean);
  return partes.join(' - ');
}

function buildModelo01CadernoHTML(prova, itensRender, cfg = {}, showGabarito = false) {
  const corDestaque = /^#[0-9A-Fa-f]{6}$/.test(String(cfg.cor_destaque || '').trim())
    ? String(cfg.cor_destaque).trim()
    : '#FF7F00';
  const densidade = ['10pt', '11pt', '12pt'].includes(cfg.densidade_fonte) ? cfg.densidade_fonte : '11pt';
  const fontBody = densidade;
  const fontHeader = densidade === '10pt' ? '10.8pt' : '11.8pt';
  const estiloAlt = cfg.estilo_alternativa || 'minuscula_parentese';
  const mostrarDivisoresDisc = cfg.mostrar_divisores_disciplina ?? true;
  const mostrarMetaQuestao = Boolean(cfg.mostrar_meta_questao);
  const numerarPaginasRodape = Boolean(cfg.numerar_paginas_rodape);
  const fechamentoCaderno = cfg.fechamento_caderno || 'nenhum';
  const rodapeTexto = txt(gerarRodapeExternoPadrao(prova, cfg));
  const totalPts = itensRender.reduce((s, it) => s + Number(it.valor_pontos || 1), 0).toFixed(1);

  const flowBlocks = [];
  let ultimaDisc = '';

  itensRender.forEach((item, idx) => {
    const discUp = String(item.disciplina || '').trim().toUpperCase();
    if (mostrarDivisoresDisc && discUp && discUp !== ultimaDisc) {
      ultimaDisc = discUp;
      flowBlocks.push(
        `<div class="flow-item disc-banner" data-keep-next="1"><span>${txt(discUp)}</span></div>`
      );
    }

    const num = String(idx + 1).padStart(2, '0');
    const est = parseJsonObj(item.estrutura_json, {}) || {};
    const tipo = item.tipo || est.modelo || 'objetiva';
    const comandoPosCorpo = (tipo === 'associacao' || tipo === 'verdadeiro_falso') && (est.submodo || 'direto') === 'sequencia';
    const enunciado = formatarEnunciadoPrincipal(item, showGabarito);
    const comandoFinal = item.comando_final && !comandoPosCorpo
      ? `<div class="comando-final">${ltx(item.comando_final)}</div>`
      : '';
    const { html: figuraHtml, posicao } = renderFigura(item, 210);

    const textoApoio = item.texto_apoio
      ? `<div class="texto-apoio-m01">${ltx(item.texto_apoio)}${item.fonte ? `<div class="fonte-apoio-m01">(${txt(item.fonte)})</div>` : ''}</div>`
      : '';

    const metaInline = mostrarMetaQuestao
      ? `<span class="meta-m01">${Number(item.valor_pontos || 1).toFixed(1)} pt</span>`
      : '';

    flowBlocks.push(`
      <div class="flow-item questao-m01">
        <div class="q-hdr-m01">
          <span class="q-lbl-m01">QUESTÃO ${num}${item.fonte && !item.texto_apoio ? ` <span class="q-fonte-inline">(${txt(item.fonte)})</span>` : ''}</span>
          <span class="q-bar-m01"></span>
          ${metaInline}
        </div>
        ${textoApoio}
        ${posicao === 'apos_texto_apoio' ? figuraHtml : ''}
        <div class="questao-enunciado">${enunciado}</div>
        ${posicao === 'entre_enunciado_e_comando' ? figuraHtml : ''}
        ${comandoFinal}
        ${posicao === 'abaixo_comando' ? figuraHtml : ''}
        ${renderCorpoModelo(item, 'modelo_01_provao', showGabarito, estiloAlt)}
      </div>
    `);
  });

  if (fechamentoCaderno === 'rascunho') {
    flowBlocks.push(`
      <div class="flow-item rascunho-m01">
        <div class="rascunho-title">RASCUNHO</div>
        <div class="rascunho-space"></div>
      </div>
    `);
  } else if (fechamentoCaderno === 'boa_prova') {
    flowBlocks.push(`
      <div class="flow-item boaprova-m01">BOA PROVA!</div>
    `);
  }

  const temBncc = itensRender.some((it) => Boolean(it.habilidade_bncc));
  const gabaritoSheetHtml = showGabarito ? `
    <section class="a4-sheet">
      <div class="a4-frame" style="display:block;overflow:hidden;">
        <div style="text-align:center;font-weight:700;font-size:13pt;text-decoration:underline;margin-bottom:10px;">
          GABARITO OFICIAL — ${txt(prova.titulo || 'AVALIAÇÃO')}
        </div>
        <table class="gabarito-tabela">
          <thead>
            <tr>
              <th>Nº</th><th>Código</th><th>Resposta / Gabarito</th><th>Pts</th><th>Disciplina</th>
              ${temBncc ? '<th>BNCC</th>' : ''}
            </tr>
          </thead>
          <tbody>
            ${itensRender.map((it, i) => `
              <tr>
                <td><strong>${String(i + 1).padStart(2, '0')}</strong></td>
                <td>${txt(it.codigo || `Q-${i + 1}`)}</td>
                <td class="resp-ok">${txt(resumirGabaritoProva(it))}</td>
                <td>${Number(it.valor_pontos || 1).toFixed(1)}</td>
                <td>${txt(it.disciplina || '—')}</td>
                ${temBncc ? `<td>${txt(it.habilidade_bncc || '—')}</td>` : ''}
              </tr>
            `).join('')}
            <tr style="border-top:1.5pt solid #000;font-weight:700;">
              <td colspan="3" style="text-align:right;">TOTAL</td>
              <td>${totalPts}</td>
              <td colspan="${temBncc ? 2 : 1}"></td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="a4-footer-outside">
        <span class="a4-footer-center">${rodapeTexto} — GABARITO</span>
      </div>
    </section>
  ` : '';

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <title>${txt(prova.titulo || 'Prova')}</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css" />
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    @page { size: A4 portrait; margin: 0; }
    html, body {
      width: 210mm;
      margin: 0 auto;
      padding: 0;
      background: #ffffff;
      color: #000000;
      font-family: 'Times New Roman', Times, serif;
      font-size: ${fontBody};
      line-height: 1.36;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }

    /* Cada folha A4 fechada individualmente com moldura preta e rodapé externo fora da margem */
    .a4-sheet {
      width: 210mm;
      height: 296.8mm;
      position: relative;
      background: #ffffff;
      page-break-after: always;
      break-after: page;
      overflow: hidden;
    }
    .a4-sheet:last-of-type {
      page-break-after: auto;
      break-after: auto;
    }

    /* Moldura retangular 2.25pt igual ao w:pgBorders sz="18" do 9º ANO-EXATAS.docx */
    .a4-frame {
      position: absolute;
      top: 8.5mm;
      left: 9.5mm;
      right: 9.5mm;
      bottom: 14mm;
      border: 2.25pt solid #000000;
      padding: 4.5mm 5mm;
      background: #ffffff;
    }

    .a4-cols {
      width: 100%;
      height: 100%;
      display: grid;
      grid-template-columns: minmax(0, 1fr) 0.85pt minmax(0, 1fr);
      column-gap: 5.5mm;
    }
    .a4-col {
      min-width: 0;
      height: 100%;
      overflow: hidden;
    }
    .a4-col-sep {
      width: 0.85pt;
      height: 100%;
      background: #000000;
    }

    /* Rodapé posicionado ESTRITAMENTE FORA (abaixo) da linha inferior da moldura */
    .a4-footer-outside {
      position: absolute;
      left: 9.5mm;
      right: 9.5mm;
      bottom: 4.2mm;
      height: 7.5mm;
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: 'Times New Roman', Times, serif;
      font-size: 11pt;
      color: #000000;
      letter-spacing: 0.02em;
    }
    .a4-footer-center {
      text-align: center;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .a4-footer-pg {
      position: absolute;
      right: 0;
      font-size: 9pt;
      color: #333333;
    }

    /* Sonda de medição com a largura exata de 1 coluna interna: (210 - 19 - 10 - 11 - 0.3) / 2 = ~84.8mm */
    #flow-probe {
      position: absolute;
      left: -9999px;
      top: 0;
      width: 84.8mm;
      visibility: hidden;
      pointer-events: none;
    }

    .disc-banner {
      text-align: center;
      font-weight: 700;
      font-size: ${fontHeader};
      margin: 2px 0 9px;
      letter-spacing: 0.02em;
    }
    .disc-banner span {
      text-decoration: underline;
    }

    .questao-m01 {
      margin-bottom: 11px;
    }
    .q-hdr-m01 {
      display: flex;
      align-items: center;
      gap: 7px;
      margin-bottom: 4px;
    }
    .q-lbl-m01 {
      font-weight: 700;
      font-size: ${fontHeader};
      color: #000000;
      white-space: nowrap;
      flex-shrink: 0;
    }
    .q-fonte-inline {
      font-weight: 400;
      font-size: 9pt;
    }
    .q-bar-m01 {
      flex: 1;
      height: 12pt;
      background: ${corDestaque};
      min-width: 18px;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    .meta-m01 {
      font-size: 8pt;
      color: #333;
      white-space: nowrap;
    }

    .texto-apoio-m01 {
      font-size: calc(${fontBody} - 0.6pt);
      font-style: italic;
      text-align: justify;
      margin: 3px 0 5px;
    }
    .fonte-apoio-m01 {
      font-style: normal;
      font-size: 8pt;
      text-align: right;
      color: #222;
      margin-top: 1px;
    }

    .questao-enunciado {
      font-size: ${fontBody};
      line-height: 1.36;
      text-align: justify;
      margin-bottom: 4px;
    }
    .comando-final {
      font-size: ${fontBody};
      line-height: 1.36;
      text-align: justify;
      margin: 4px 0 5px;
    }
    .math-block {
      display: block;
      text-align: center;
      margin: 5px 0;
      overflow-x: hidden;
    }
    .katex {
      font-size: 1.03em !important;
    }
    .questao-legenda {
      font-size: 7.5pt;
      color: #333;
      margin-top: 2px;
      font-style: italic;
    }

    .alternativas { margin-top: 3px; }
    .alt {
      display: flex;
      gap: 5px;
      padding: 1.5px 0;
      font-size: ${fontBody};
      line-height: 1.34;
      align-items: flex-start;
      text-align: justify;
    }
    .alt-letra {
      font-weight: 400;
      flex-shrink: 0;
      min-width: 18px;
    }
    .alt-body { flex: 1; }
    .alt-img-wrap img { max-width: 135px; max-height: 90px; margin-top: 2px; display: block; }
    .alt.correta { background: #ecfdf5; font-weight: 700; }
    .corr-mark { color: #166534; font-weight: 700; margin-left: 4px; }

    .proposicoes-romanas { margin: 4px 0 5px; font-size: ${fontBody}; }
    .prop-item { margin-bottom: 2.5px; text-align: justify; }
    .vf-lista, .somatoria-lista { margin: 4px 0; font-size: ${fontBody}; }
    .vf-item, .somatoria-item { display: flex; gap: 6px; margin-bottom: 2.5px; align-items: baseline; text-align: justify; }
    .vf-box { font-family: monospace; font-weight: 700; white-space: nowrap; flex-shrink: 0; }
    .vf-just-label { font-size: 9pt; font-weight: 700; margin-top: 4px; }

    .assoc-table { width: 100%; border-collapse: collapse; margin: 4px 0; font-size: 9pt; text-align: left; }
    .assoc-table th, .assoc-table td { border: 0.6pt solid #333; padding: 3px 6px; vertical-align: top; }
    .assoc-table th { background: #f3f4f6; font-size: 8.5pt; }
    .assoc-cell { display: flex; align-items: baseline; gap: 4px; line-height: 1.32; }

    .lacuna-blank { font-weight: 700; letter-spacing: 0.02em; }
    .lacuna-gab { font-weight: 700; color: #166534; text-decoration: underline; }
    .banco-palavras { border: 0.7pt dashed #333; padding: 3px 7px; margin: 4px 0; font-size: 9pt; }

    .somatoria-box-wrap { display: flex; align-items: center; justify-content: flex-end; gap: 6px; margin-top: 4px; }
    .somatoria-label { font-size: 9pt; font-weight: 700; }
    .somatoria-box { border: 1pt solid #000; padding: 1px 10px; font-weight: 700; min-width: 36px; text-align: center; }

    .linhas-resposta { margin-top: 4px; }
    .linha-resp { height: 15px; border-bottom: 0.6pt dotted #666; margin-bottom: 3px; width: 100%; }
    .quadro-calculo { width: 100%; border: 0.8pt solid #333; margin-top: 4px; }
    .espelho-correcao { margin-top: 4px; padding: 4px 7px; background: #f0fdf4; border-left: 2pt solid #166534; font-size: 8.5pt; }

    .rascunho-m01 { margin-top: 12px; text-align: center; }
    .rascunho-title { font-weight: 700; text-decoration: underline; font-size: ${fontHeader}; margin-bottom: 6px; }
    .rascunho-space { height: 110px; }
    .boaprova-m01 { margin-top: 14px; text-align: center; font-weight: 700; font-size: ${fontHeader}; }

    .gabarito-tabela { width: 100%; border-collapse: collapse; font-size: 9.5pt; margin-top: 6px; }
    .gabarito-tabela th { background: #111; color: #fff; padding: 4px 6px; text-align: center; font-size: 8.5pt; }
    .gabarito-tabela td { padding: 3px 6px; border: 0.5pt solid #666; text-align: center; }
    .gabarito-tabela .resp-ok { font-weight: 700; color: #166534; }
  </style>
</head>
<body>
  <div id="flow-probe">${flowBlocks.join('')}</div>
  <div id="pages-root"></div>
  <template id="gabarito-tpl">${gabaritoSheetHtml}</template>

  <script src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/contrib/auto-render.min.js"></script>
  <script>
    (function() {
      var rodapeTexto = ${JSON.stringify(rodapeTexto)};
      var numerarRodape = ${numerarPaginasRodape ? 'true' : 'false'};
      var donePaginate = false;

      function paginarCaderno() {
        if (donePaginate) return;
        donePaginate = true;

        // Mede a altura exata interna disponível numa coluna A4 criando uma folha modelo temporária
        var root = document.getElementById('pages-root');
        var tempSheet = document.createElement('section');
        tempSheet.className = 'a4-sheet';
        tempSheet.innerHTML = '<div class="a4-frame"><div class="a4-cols"><div class="a4-col"></div><div class="a4-col-sep"></div><div class="a4-col"></div></div></div>';
        root.appendChild(tempSheet);
        var colBox = tempSheet.querySelector('.a4-col');
        var maxColH = Math.max(400, colBox.clientHeight - 2);
        var exactColW = colBox.clientWidth;
        root.removeChild(tempSheet);

        var probe = document.getElementById('flow-probe');
        if (exactColW > 50) probe.style.width = exactColW + 'px';

        var nodes = Array.prototype.slice.call(probe.children);
        var items = nodes.map(function(el) {
          var st = window.getComputedStyle(el);
          var mb = parseFloat(st.marginBottom) || 0;
          var mt = parseFloat(st.marginTop) || 0;
          return {
            el: el,
            h: el.offsetHeight + mb + mt,
            keepNext: el.getAttribute('data-keep-next') === '1'
          };
        });

        // Distribui coluna a coluna (Col 0 = pág 1 esq, Col 1 = pág 1 dir, Col 2 = pág 2 esq...)
        var columns = [[]];
        var curH = 0;

        for (var i = 0; i < items.length; i++) {
          var it = items[i];
          var nextH = (it.keepNext && items[i + 1]) ? items[i + 1].h : 0;
          var neededH = it.h + nextH;

          if (columns[columns.length - 1].length > 0 && (curH + neededH > maxColH)) {
            columns.push([]);
            curH = 0;
          }
          columns[columns.length - 1].push(it.el);
          curH += it.h;
        }

        var totalPages = Math.max(1, Math.ceil(columns.length / 2));
        for (var p = 0; p < totalPages; p++) {
          var leftEls = columns[p * 2] || [];
          var rightEls = columns[p * 2 + 1] || [];
          var sheet = document.createElement('section');
          sheet.className = 'a4-sheet';

          var frame = document.createElement('div');
          frame.className = 'a4-frame';
          var colsGrid = document.createElement('div');
          colsGrid.className = 'a4-cols';

          var colL = document.createElement('div');
          colL.className = 'a4-col';
          leftEls.forEach(function(n) { colL.appendChild(n); });

          var sep = document.createElement('div');
          sep.className = 'a4-col-sep';

          var colR = document.createElement('div');
          colR.className = 'a4-col';
          rightEls.forEach(function(n) { colR.appendChild(n); });

          colsGrid.appendChild(colL);
          colsGrid.appendChild(sep);
          colsGrid.appendChild(colR);
          frame.appendChild(colsGrid);

          var ftr = document.createElement('div');
          ftr.className = 'a4-footer-outside';
          var ftrSpan = document.createElement('span');
          ftrSpan.className = 'a4-footer-center';
          ftrSpan.innerHTML = rodapeTexto;
          ftr.appendChild(ftrSpan);

          if (numerarRodape) {
            var pgSpan = document.createElement('span');
            pgSpan.className = 'a4-footer-pg';
            pgSpan.textContent = 'Pág. ' + (p + 1) + '/' + totalPages;
            ftr.appendChild(pgSpan);
          }

          sheet.appendChild(frame);
          sheet.appendChild(ftr);
          root.appendChild(sheet);
        }

        var gabTpl = document.getElementById('gabarito-tpl');
        if (gabTpl && gabTpl.innerHTML.trim()) {
          var tmpWrap = document.createElement('div');
          tmpWrap.innerHTML = gabTpl.innerHTML.trim();
          while (tmpWrap.firstElementChild) {
            root.appendChild(tmpWrap.firstElementChild);
          }
        }
        if (gabTpl && gabTpl.parentNode) gabTpl.parentNode.removeChild(gabTpl);

        probe.parentNode.removeChild(probe);
        document.body.dataset.paginated = 'ready';
      }

      function waitImagesThenPaginate() {
        if (window.renderMathInElement) {
          try {
            window.renderMathInElement(document.body, {
              delimiters: [
                { left: '$$', right: '$$', display: true },
                { left: '$', right: '$', display: false }
              ],
              throwOnError: false
            });
          } catch (e) {}
        }

        var imgs = Array.prototype.slice.call(document.images || []);
        var pending = imgs.filter(function(img) { return !img.complete; });
        if (pending.length === 0) {
          setTimeout(paginarCaderno, 60);
          return;
        }
        var left = pending.length;
        function check() {
          left--;
          if (left <= 0) setTimeout(paginarCaderno, 60);
        }
        pending.forEach(function(img) {
          img.addEventListener('load', check, { once: true });
          img.addEventListener('error', check, { once: true });
        });
        setTimeout(paginarCaderno, 4500);
      }

      if (document.readyState === 'complete') {
        waitImagesThenPaginate();
      } else {
        window.addEventListener('load', waitImagesThenPaginate);
        setTimeout(waitImagesThenPaginate, 3500);
      }
    })();
  </script>
</body>
</html>`;
}

/* ── Modelos Clássicos (compatibilidade retroativa) ─────────────────────────── */
function renderQuestao(item, idx, template, showGabarito) {
  const num = String(idx + 1).padStart(2, '0');
  const est = parseJsonObj(item.estrutura_json, {}) || {};
  const tipo = item.tipo || est.modelo || (template === 'discursiva' ? 'discursiva' : 'objetiva');
  const comandoPosCorpo = (tipo === 'associacao' || tipo === 'verdadeiro_falso') && (est.submodo || 'direto') === 'sequencia';
  const enunciado = formatarEnunciadoPrincipal(item, showGabarito);
  const comandoFinal = item.comando_final && !comandoPosCorpo ? `<div class="comando-final">${ltx(item.comando_final)}</div>` : '';
  const pontos = item.valor_pontos || 1;
  const bncc = item.habilidade_bncc ? `<span class="bncc-tag">${txt(item.habilidade_bncc)}</span>` : '';

  const { html: figuraHtml, posicao } = renderFigura(item);

  const textoApoio = item.texto_apoio
    ? `<blockquote class="texto-apoio">${ltx(item.texto_apoio)}${item.fonte ? `<footer>— ${txt(item.fonte)}</footer>` : ''}</blockquote>`
    : '';

  return `
  <div class="questao" data-nivel="${txt(item.nivel || 'medio')}">
    <div class="questao-header">
      <span class="questao-num">QUESTÃO ${num}${item.fonte && !item.texto_apoio ? ` <span class="fonte-inline">(${txt(item.fonte)})</span>` : ''}</span>
      <span class="questao-meta">
        ${item.disciplina ? `<span class="disc-tag">${txt(item.disciplina)}</span>` : ''}
        ${bncc}
        <span class="pts-tag">${pontos} pt${pontos != 1 ? 's' : ''}</span>
      </span>
    </div>
    ${textoApoio}
    ${posicao === 'apos_texto_apoio' ? figuraHtml : ''}
    <div class="questao-enunciado">${enunciado || '(sem enunciado)'}</div>
    ${posicao === 'entre_enunciado_e_comando' ? figuraHtml : ''}
    ${comandoFinal}
    ${posicao === 'abaixo_comando' ? figuraHtml : ''}
    ${renderCorpoModelo(item, template, showGabarito, 'maiuscula_parenteses')}
  </div>`;
}

function buildCSS(template, margem = '10mm 12mm 14mm') {
  const is2col = template === 'objetiva_2col' || template === 'enem';
  return `
    @import url('https://fonts.googleapis.com/css2?family=Source+Serif+4:ital,wght@0,300;0,400;0,600;0,700;1,400&display=swap');

    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Source Serif 4', 'Times New Roman', serif; font-size: 10.5pt; line-height: 1.52; color: #000; background: #fff; }

    .pagina { width: 210mm; min-height: 297mm; margin: 0 auto; padding: ${margem}; background: #fff; position: relative; border: 1.5pt solid #000; }

    .cabecalho { border: 2px solid #000; padding: 6px 10px; margin-bottom: 6px; }
    .cabecalho-top { display: flex; align-items: center; gap: 10px; margin-bottom: 4px; }
    .cabecalho-logo { width: 52px; height: 52px; display: flex; align-items: center; justify-content: center; border: 1.5px solid #333; font-size: 20px; flex-shrink: 0; }
    .cabecalho-escola { flex: 1; text-align: center; }
    .escola-nome { font-size: 11.5pt; font-weight: 700; text-transform: uppercase; letter-spacing: 0.03em; }
    .escola-sub { font-size: 8.5pt; color: #333; }
    .cabecalho-titulo { text-align: center; font-size: 13pt; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; border-top: 1px solid #000; padding-top: 5px; margin-top: 4px; }
    .cabecalho-campos { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; margin-top: 5px; border-top: 1px solid #ccc; padding-top: 5px; }
    .campo-linha { display: flex; align-items: flex-end; gap: 5px; font-size: 9pt; padding-bottom: 2px; border-bottom: 0.5px solid #555; }
    .campo-full { grid-column: 1 / -1; }
    .campo-label { font-weight: 700; white-space: nowrap; flex-shrink: 0; }

    .instrucoes { border: 1px solid #000; padding: 5px 10px; margin-bottom: 8px; font-size: 8.5pt; }
    .instrucoes strong { font-size: 9pt; }
    .instrucoes ol { margin-left: 18px; margin-top: 3px; }
    .instrucoes li { margin-bottom: 1px; }

    .questoes-grid { ${is2col ? 'column-count: 2; column-gap: 9mm; column-rule: 0.8pt solid #555;' : ''} }

    .questao { break-inside: avoid; margin-bottom: 11px; padding-bottom: 8px; border-bottom: 0.5px dashed #ccc; }
    .questao:last-child { border-bottom: none; }
    .questao-header { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 3px; gap: 6px; }
    .questao-num { font-weight: 700; font-size: 10pt; text-transform: uppercase; letter-spacing: 0.02em; }
    .fonte-inline { font-weight: 600; font-size: 8.5pt; text-transform: none; color: #333; }
    .questao-meta { display: flex; gap: 4px; align-items: center; flex-wrap: wrap; }
    .disc-tag, .bncc-tag, .pts-tag { font-size: 7pt; padding: 1px 5px; border: 0.7pt solid; border-radius: 3px; font-family: sans-serif; }
    .disc-tag { color: #1d4ed8; border-color: #1d4ed8; }
    .bncc-tag { color: #7c3aed; border-color: #7c3aed; }
    .pts-tag  { color: #555; border-color: #999; }

    .questao-enunciado { font-size: 10pt; line-height: 1.55; margin-bottom: 4px; text-align: justify; }
    .math-block { display: block; text-align: center; margin: 6px 0; overflow-x: auto; }
    .comando-final { font-size: 10pt; line-height: 1.5; margin: 4px 0 5px; font-weight: 600; text-align: justify; }
    .texto-apoio { background: #f9f9f9; border-left: 3px solid #555; padding: 5px 8px; margin-bottom: 5px; font-size: 9pt; font-style: italic; color: #222; }
    .texto-apoio footer { font-size: 8pt; font-style: normal; margin-top: 3px; color: #555; }
    .questao-legenda { font-size: 7.5pt; color: #444; margin-top: 2px; font-style: italic; }

    .alternativas { margin-top: 4px; }
    .alt { display: flex; gap: 5px; padding: 2px 0; font-size: 9.8pt; align-items: flex-start; }
    .alt-letra { font-weight: 700; flex-shrink: 0; min-width: 22px; }
    .alt-body { flex: 1; }
    .alt-img-wrap img { max-width: 140px; max-height: 95px; margin-top: 3px; border: 0.5pt solid #ddd; display: block; }
    .alt.correta { background: #f0fdf4; }
    .alt.correta .alt-letra { color: #166534; }
    .corr-mark { color: #166534; font-size: 9pt; flex-shrink: 0; font-weight: 700; }

    .proposicoes-romanas { margin: 4px 0 5px 6px; font-size: 9.6pt; }
    .prop-item { margin-bottom: 2px; text-align: justify; }

    .vf-lista, .somatoria-lista { margin: 4px 0; font-size: 9.6pt; }
    .vf-item, .somatoria-item { display: flex; gap: 6px; margin-bottom: 3px; align-items: baseline; text-align: justify; }
    .vf-box { font-family: monospace; font-weight: 700; white-space: nowrap; flex-shrink: 0; }
    .vf-just-label { font-size: 8.5pt; font-weight: 700; margin-top: 4px; }

    .assoc-table { width: 100%; border-collapse: collapse; margin: 5px 0; font-size: 9pt; text-align: left; }
    .assoc-table th, .assoc-table td { border: 0.6pt solid #666; padding: 4px 7px; vertical-align: top; text-align: left; }
    .assoc-table th { background: #f3f4f6; font-size: 8.5pt; text-transform: uppercase; }
    .assoc-cell { display: flex; align-items: baseline; gap: 5px; text-align: left; line-height: 1.45; }

    .lacuna-blank { font-weight: 700; letter-spacing: 0.03em; }
    .lacuna-gab { font-weight: 700; color: #166534; text-decoration: underline; padding: 0 3px; }
    .banco-palavras { border: 0.8pt dashed #444; padding: 4px 8px; margin: 4px 0; font-size: 9pt; background: #fafafa; border-radius: 3px; }
    .palavra-chip { font-weight: 600; }

    .somatoria-box-wrap { display: flex; align-items: center; justify-content: flex-end; gap: 6px; margin-top: 4px; }
    .somatoria-label { font-size: 8.5pt; font-weight: 700; }
    .somatoria-box { border: 1.2pt solid #000; padding: 2px 10px; font-weight: 700; min-width: 38px; text-align: center; font-size: 10pt; }

    .linhas-resposta { margin-top: 4px; }
    .linha-resp { height: 16px; border-bottom: 0.6pt dotted #888; margin-bottom: 3px; width: 100%; }
    .quadro-calculo { width: 100%; border: 0.8pt solid #555; border-radius: 3px; margin-top: 5px; background: #fff; }
    .espelho-correcao { margin-top: 5px; padding: 4px 8px; background: #f0fdf4; border-left: 2.5pt solid #166534; font-size: 8.5pt; color: #14532d; }

    .gabarito-tabela { width: 100%; border-collapse: collapse; font-size: 9pt; margin-top: 8px; }
    .gabarito-tabela th { background: #333; color: #fff; padding: 4px 6px; text-align: center; font-size: 8.5pt; letter-spacing: 0.04em; text-transform: uppercase; }
    .gabarito-tabela td { padding: 3px 6px; border: 0.5pt solid #ccc; text-align: center; font-size: 8.8pt; }
    .gabarito-tabela tr:nth-child(even) td { background: #f5f5f5; }
    .gabarito-tabela .resp-ok { color: #166534; font-weight: 700; }

    .rodape {
      position: fixed;
      bottom: 0;
      left: 0; right: 0;
      height: 10mm;
      max-height: 10mm;
      padding: 2px 12mm;
      font-size: 6.5pt;
      color: #555;
      border-top: 0.5pt solid #aaa;
      display: flex;
      justify-content: space-between;
      align-items: center;
      background: #fff;
      overflow: hidden;
    }
    .rodape-esq { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 48%; }
    .rodape-dir { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 48%; font-weight: 700; text-align: right; }

    @media print {
      @page { size: A4; margin: ${margem}; }
      body { print-color-adjust: exact; -webkit-print-color-adjust: exact; }
      .pagina { width: 100%; margin: 0; padding: 0; min-height: unset; border: 1.5pt solid #000; }
      .rodape { position: fixed; bottom: 0; }
      .questao { break-inside: avoid; }
      .cabecalho { break-after: avoid; }
    }
  `;
}

// Monta o HTML completo respeitando template_slug e config_json da prova
export function buildProvaHTML(prova, itens, escolaNome = '', showGabarito = false) {
  let cfg = {};
  try {
    const raw = prova.config_json;
    cfg = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : {};
  } catch {}

  const template = resolveProvaTemplate(prova);

  const embaralharAlt   = cfg.embaralhar_alternativas ?? prova.embaralhar_alternativas ?? 0;
  const embaralharQuest = cfg.embaralhar_questoes ?? 0;

  let itensRender = embaralharAlt ? itens.map((it) => {
    const alts = parseAlts(it.alternativas_json);
    if (alts.length > 1 && (it.tipo || 'objetiva') === 'objetiva') {
      const shuffled = shuffleArray(alts).map((a, i) => ({
        ...a, letra: String.fromCharCode(65 + i),
      }));
      return { ...it, alternativas_json: JSON.stringify(shuffled) };
    }
    return it;
  }) : itens;

  if (embaralharQuest) itensRender = shuffleArray(itensRender);

  // Modelo 01 Oficial (Clonado de "9º ANO-EXATAS.docx"): Paginação A4 folha a folha com rodapé externo
  if (template === 'modelo_01_provao') {
    return buildModelo01CadernoHTML(prova, itensRender, cfg, showGabarito);
  }

  const comCabecalho = cfg.com_cabecalho ?? true;
  const comMargem    = cfg.com_margem    ?? true;
  const cabItens     = cfg.cabecalho_itens ?? {};
  const sh           = (k) => cabItens[k] ?? true;
  const rodapeTxt    = cfg.rodape_texto  ?? '';
  const mostrarInstr = (cabItens.cab_instrucoes ?? true) && comCabecalho;
  const margem       = comMargem ? '10mm 12mm 14mm' : '4mm';

  const isEnem    = template === 'enem';
  const disc      = txt(prova.disciplina || '');
  const turma     = txt(prova.turma || '');
  const bimestre  = prova.bimestre ? `${prova.bimestre}º Bimestre` : '';
  const anoLetivo = prova.ano_letivo || new Date().getFullYear();
  const titulo    = txt(prova.titulo || 'Avaliação');
  const escolaTxt = txt(escolaNome || 'EDUCA.MELHOR');
  const totalPts  = itensRender.reduce((s, it) => s + Number(it.valor_pontos || 1), 0).toFixed(1);
  const qtd       = itensRender.length;

  let cabecalhoHtml = '';
  if (comCabecalho) {
    const topoHtml = (sh('cab_logo') || sh('cab_escola')) ? `
      <div class="cabecalho-top">
        ${sh('cab_logo') ? '<div class="cabecalho-logo">🏫</div>' : ''}
        ${sh('cab_escola') ? `<div class="cabecalho-escola"><div class="escola-nome">${escolaTxt}</div><div class="escola-sub">Sistema de Ensino EDUCA.MELHOR</div></div>` : ''}
      </div>` : '';

    const tituloHtml = sh('cab_titulo') ? `<div class="cabecalho-titulo">${titulo}</div>` : '';

    let camposHtml = '';
    if (sh('cab_nome'))     camposHtml += `<div class="campo-linha campo-full"><span class="campo-label">Nome:</span><span style="flex:1"></span></div>`;
    if (sh('cab_disc'))     camposHtml += `<div class="campo-linha"><span class="campo-label">Disciplina:</span>&nbsp;${disc}</div>`;
    if (sh('cab_turma'))    camposHtml += `<div class="campo-linha"><span class="campo-label">Turma:</span>&nbsp;${turma}</div>`;
    const bimAno = [sh('cab_bimestre') && bimestre, sh('cab_ano') && anoLetivo].filter(Boolean).join('  ');
    if (bimAno)             camposHtml += `<div class="campo-linha"><span class="campo-label">${bimAno}</span></div>`;
    if (sh('cab_data'))     camposHtml += `<div class="campo-linha"><span class="campo-label">Data:</span>&nbsp;___/___/______</div>`;
    if (sh('cab_nota'))     camposHtml += `<div class="campo-linha"><span class="campo-label">Nota:</span>&nbsp;___________</div>`;

    const gradeHtml = camposHtml ? `<div class="cabecalho-campos">${camposHtml}</div>` : '';
    cabecalhoHtml = `<div class="cabecalho">${topoHtml}${tituloHtml}${gradeHtml}</div>`;
  }

  const instrHtml = mostrarInstr ? `
  <div class="instrucoes">
    <strong>INSTRUÇÕES:</strong>
    <ol>
      <li>Esta avaliação contém <strong>${qtd} questão(ões)</strong> no total de <strong>${totalPts} ponto(s)</strong>.</li>
      ${isEnem ? '<li>Utilize caneta azul ou preta para marcar as alternativas no gabarito.</li>' : ''}
      <li>Leia cada questão com atenção antes de responder.</li>
      <li>${template === 'discursiva' || template === 'mista' ? 'Responda com letra legível nos espaços indicados.' : 'Assinale apenas uma alternativa correta quando aplicável.'}</li>
    </ol>
  </div>` : '';

  const questoesHtml = itensRender
    .map((item, idx) => renderQuestao(item, idx, template, showGabarito))
    .join('');

  const temBncc = itensRender.some((it) => Boolean(it.habilidade_bncc));
  const gabaritoHtml = showGabarito ? `
  <div style="page-break-before: always; margin-top: 20px;">
    <div class="cabecalho">
      <div class="cabecalho-titulo">GABARITO — ${txt(prova.titulo || 'Avaliação')}</div>
    </div>
    <table class="gabarito-tabela">
      <thead><tr>
        <th>Nº</th><th>Código</th><th>Modelo</th><th>Resposta / Gabarito</th><th>Pts</th><th>Disciplina</th>
        ${temBncc ? '<th>BNCC</th>' : ''}
      </tr></thead>
      <tbody>
        ${itensRender.map((it, idx) => {
          const corr = txt(resumirGabaritoProva(it));
          const cod = txt(it.codigo || `Q-${it.questao_id || idx + 1}`);
          const modLabel = {
            objetiva: 'Múlt. Escolha', afirmativas: 'Afirmativas', verdadeiro_falso: 'V / F',
            associacao: 'Colunas', lacuna: 'Lacunas', discursiva: 'Discursiva', somatoria: 'Somatória',
          }[it.tipo] || txt(it.tipo || 'Objetiva');
          return `<tr>
            <td>${String(idx + 1).padStart(2, '0')}</td>
            <td>${cod}</td>
            <td>${modLabel}</td>
            <td class="resp-ok">${corr}</td>
            <td>${Number(it.valor_pontos || 1).toFixed(1)}</td>
            <td>${txt(it.disciplina || '—')}</td>
            ${temBncc ? `<td>${txt(it.habilidade_bncc || '—')}</td>` : ''}
          </tr>`;
        }).join('')}
        <tr style="border-top:2px solid #333;font-weight:700">
          <td colspan="4" style="text-align:right">TOTAL</td>
          <td>${totalPts}</td>
          <td colspan="${temBncc ? 2 : 1}"></td>
        </tr>
      </tbody>
    </table>
  </div>` : '';

  const rodapeStr = rodapeTxt ? `EDUCA.PROVA · ${txt(rodapeTxt)}` : 'EDUCA.PROVA';
  const rodapeEsq = [escolaTxt, bimestre || anoLetivo].filter(Boolean).join(' — ');
  const rodapeHtml = `
  <div class="rodape">
    <span class="rodape-esq">${rodapeEsq}</span>
    <span class="rodape-dir">${rodapeStr}</span>
  </div>`;

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${titulo}</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css" />
  <style>${buildCSS(template, margem)}</style>
</head>
<body>
  <div class="pagina">
    ${cabecalhoHtml}
    ${instrHtml}
    <div class="questoes-grid">
      ${questoesHtml}
    </div>
    ${gabaritoHtml}
    ${rodapeHtml}
  </div>
  <script src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/contrib/auto-render.min.js"></script>
  <script>
    if (window.renderMathInElement) {
      window.renderMathInElement(document.body, {
        delimiters: [
          { left: '$$', right: '$$', display: true },
          { left: '$', right: '$', display: false }
        ],
        throwOnError: false
      });
    }
  </script>
</body>
</html>`;
}

// ── Buscar prova + itens do banco ──────────────────────────────────────────
async function fetchProvaCompleta(id, escola_id) {
  await ensureProvasSchema();
  const [[prova]] = await pool.query(
    `SELECT * FROM provas p WHERE p.id = ? AND ${escolaFilter(escola_id)}`,
    [id, ...escolaParam(escola_id)]
  );
  if (!prova) return null;
  prova.template_slug = resolveProvaTemplate(prova);

  const [itens] = await pool.query(
    `SELECT pq.id AS item_id, pq.ordem, pq.valor_pontos,
            q.id AS questao_id,
            CONCAT('EMQE-', LPAD(COALESCE(q.numero_q, q.id), 5, '0')) AS codigo,
            q.conteudo_bruto, q.comando_final, q.tipo, q.nivel,
            q.disciplina, q.alternativas_json, q.estrutura_json,
            q.correta, q.resposta_aberta, q.tags,
            q.habilidade_bncc, q.imagem_url, q.imagem_base64, q.midia_json,
            q.texto_apoio, q.fonte
     FROM prova_questoes pq
     JOIN questoes q ON q.id = pq.questao_id
     WHERE pq.prova_id = ?
     ORDER BY pq.ordem ASC`,
    [id]
  );
  return { prova, itens };
}

// ── GET /api/provas/:id/html ── Preview HTML ──────────────────────────────
export async function previewHtml(req, res) {
  const { id } = req.params;
  const { escola_id } = req.user;
  const showGab = req.query.gabarito === '1';
  try {
    const data = await fetchProvaCompleta(id, escola_id);
    if (!data) return res.status(404).json({ message: 'Prova não encontrada.' });

    const escolaNome = req.query.escola || 'EDUCA.MELHOR';
    const html = buildProvaHTML(data.prova, data.itens, escolaNome, showGab);
    res.setHeader('Content-Type', 'text/html; charset=UTF-8');
    res.send(html);
  } catch (err) {
    console.error('previewHtml:', err);
    res.status(500).json({ message: 'Erro ao gerar HTML.', detail: err.message });
  }
}

// ── GET/POST /api/provas/:id/pdf ── Gera PDF via Playwright ────────────────
export async function gerarPdf(req, res) {
  const { id } = req.params;
  const { escola_id } = req.user;
  const showGab = req.query.gabarito === '1';

  let browser = null;
  try {
    const data = await fetchProvaCompleta(id, escola_id);
    if (!data) return res.status(404).json({ message: 'Prova não encontrada.' });

    const template = resolveProvaTemplate(data.prova);
    const isModelo01Paginado = template === 'modelo_01_provao';

    const escolaNome = req.query.escola || 'EDUCA.MELHOR';
    const html = buildProvaHTML(data.prova, data.itens, escolaNome, showGab);

    let cfg = {};
    try { const raw = data.prova.config_json; cfg = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : {}; } catch {}
    const comMargem = cfg.com_margem ?? true;
    const margemPdf = isModelo01Paginado
      ? { top: '0mm', right: '0mm', bottom: '0mm', left: '0mm' }
      : comMargem
        ? { top: '10mm', right: '12mm', bottom: '14mm', left: '12mm' }
        : { top: '4mm', right: '4mm', bottom: '4mm', left: '4mm' };

    const { chromium } = await import('playwright');
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    const page = await browser.newPage();
    try {
      await page.setContent(html, { waitUntil: 'load', timeout: 25_000 });
    } catch {
      await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 15_000 });
    }

    if (isModelo01Paginado) {
      await page.waitForFunction(() => document.body.dataset.paginated === 'ready', { timeout: 15_000 }).catch(() => {});
    }

    const pdfBuffer = await page.pdf({
      format: 'A4',
      preferCSSPageSize: isModelo01Paginado,
      printBackground: true,
      margin: margemPdf,
    });

    const slug = (data.prova.titulo || 'prova')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 40) || 'prova';
    const filename = `${slug}-${Date.now()}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', pdfBuffer.length);
    res.send(pdfBuffer);
  } catch (err) {
    console.error('gerarPdf:', err);
    res.status(500).json({ message: 'Erro ao gerar PDF.', detail: err.message });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}
