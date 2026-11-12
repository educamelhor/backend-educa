// controllers/provaHtmlController.js
// EDUCA.PROVA — Gerador de HTML/PDF via Playwright (compatível com os 7 modelos universais e Smart Media)

import pool from '../db.js';

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

// Formata expressões LaTeX simples como fallback caso KaTeX não carregue e preserva delimitadores p/ KaTeX
function ltx(text = '') {
  if (!text) return '';
  // Escapa HTML primeiro para nunca corromper spans gerados depois
  let safe = txt(text);
  safe = safe
    .replace(/\\textbf\{([^}]+)\}/g, '<strong>$1</strong>')
    .replace(/\\emph\{([^}]+)\}/g, '<em>$1</em>')
    .replace(/\$\$([^$]+)\$\$/g, '<span class="math-block">$$$$$1$$$$</span>')
    .replace(/\$([^$]+)\$/g, '<span class="math">$$$1$$</span>')
    .replace(/\n/g, '<br>');
  return safe;
}

function renderFigura(item) {
  const midia = parseJsonObj(item.midia_json, null);
  const imgSrc = midia?.url || item.imagem_url || item.imagem_base64;
  if (!imgSrc) return { html: '', posicao: 'entre_enunciado_e_comando' };

  const presetMap = { P: '36%', M: '56%', G: '84%', '100%': '100%' };
  const widthCss = presetMap[midia?.preset] || '58%';
  const align = ['left', 'center', 'right'].includes(midia?.alinhamento) ? midia.alinhamento : 'center';
  const posicao = ['apos_texto_apoio', 'entre_enunciado_e_comando', 'abaixo_comando'].includes(midia?.posicao)
    ? midia.posicao
    : 'entre_enunciado_e_comando';

  const legendaTxt = [midia?.legenda, midia?.credito ? `Fonte: ${midia.credito}` : '']
    .filter(Boolean)
    .join(' — ');

  const justifyMap = { left: 'flex-start', center: 'center', right: 'flex-end' };
  const html = `
    <figure class="questao-figura" style="display:flex;flex-direction:column;align-items:${justifyMap[align]};margin:6px 0;">
      <img src="${txt(imgSrc)}" alt="Figura da questão" style="width:${widthCss};max-width:100%;height:auto;max-height:240px;object-fit:contain;" />
      ${legendaTxt ? `<figcaption class="questao-legenda" style="width:${widthCss};text-align:${align};">${txt(legendaTxt)}</figcaption>` : ''}
    </figure>`;

  return { html, posicao };
}

function renderAlternativas(altsJson, correta, showGabarito = false) {
  const alts = parseAlts(altsJson);
  if (!alts.length) return '';
  return `<div class="alternativas">
    ${alts.map(a => {
      const isCorr = showGabarito && (a.correta || a.letra === correta);
      const altImg = a.imagem_url
        ? `<div class="alt-img-wrap"><img src="${txt(a.imagem_url)}" alt="Alternativa ${txt(a.letra)}" /></div>`
        : '';
      return `<div class="alt${isCorr ? ' correta' : ''}">
        <span class="alt-letra">(${txt(a.letra || '?')})</span>
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

function renderCorpoModelo(item, template, showGabarito) {
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
    return `${propsHtml}${cmdFech}${renderAlternativas(item.alternativas_json, item.correta, showGabarito)}`;
  }

  if (tipo === 'verdadeiro_falso') {
    const itensVf = Array.isArray(est.itens) ? est.itens : [];
    const submodo = est.submodo || 'direto';
    const itensHtml = itensVf.length ? `
      <div class="vf-lista">
        ${itensVf.map(it => {
          const gab = showGabarito && submodo === 'direto' ? `<strong>${txt(it.gabarito || 'V')}</strong>` : '&nbsp;&nbsp;&nbsp;';
          return `<div class="vf-item"><span class="vf-box">( ${gab} )</span> <span>${ltx(it.texto || '')}</span></div>`;
        }).join('')}
      </div>` : '';
    const justHtml = submodo === 'direto' && est.exigir_justificativa_falsas
      ? `<div class="vf-just-label">Justifique as afirmativas falsas:</div>${renderLinhasResposta(est.linhas_justificativa || 3)}`
      : '';
    const seqHtml = submodo === 'sequencia'
      ? renderAlternativas(item.alternativas_json, item.correta, showGabarito)
      : '';
    return `${itensHtml}${justHtml}${seqHtml}`;
  }

  if (tipo === 'associacao') {
    const colA = Array.isArray(est.coluna_a) ? est.coluna_a : [];
    const colB = Array.isArray(est.coluna_b) ? est.coluna_b : [];
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
        <td>${a ? `<strong>(${txt(a.codigo || i + 1)})</strong> ${ltx(a.texto || '')}` : ''}</td>
        <td>${b ? `<span class="vf-box">( ${gabB} )</span> ${ltx(b.texto || '')}` : ''}</td>
      </tr>`;
    }
    const tabHtml = maxRows > 0 ? `
      <table class="assoc-table">
        <thead>
          <tr>
            <th>${txt(est.titulo_coluna_a || 'Coluna A')}</th>
            <th>${txt(est.titulo_coluna_b || 'Coluna B')}</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>` : '';
    const seqHtml = submodo === 'sequencia'
      ? renderAlternativas(item.alternativas_json, item.correta, showGabarito)
      : '';
    return `${tabHtml}${seqHtml}`;
  }

  if (tipo === 'lacuna') {
    const submodo = est.submodo || 'direto';
    let bancoHtml = '';
    if (submodo === 'banco_palavras') {
      const palavras = [...(est.lacunas || []), ...(est.distratores_banco || [])].filter(Boolean);
      const ordenadas = [...palavras].sort((a, b) => a.localeCompare(b, 'pt-BR'));
      if (ordenadas.length > 0) {
        bancoHtml = `<div class="banco-palavras"><strong>Banco de palavras:</strong> ${ordenadas.map(p => `<span class="palavra-chip">${txt(p)}</span>`).join(' · ')}</div>`;
      }
    }
    const altsHtml = submodo === 'alternativas'
      ? renderAlternativas(item.alternativas_json, item.correta, showGabarito)
      : '';
    return `${bancoHtml}${altsHtml}`;
  }

  if (tipo === 'somatoria') {
    const props = Array.isArray(est.proposicoes) ? est.proposicoes : [];
    const somaGab = showGabarito ? String(est.soma_correta ?? item.correta ?? '').padStart(2, '0') : '&nbsp;&nbsp;&nbsp;&nbsp;';
    return `
      <div class="somatoria-lista">
        ${props.map(p => {
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

  // Padrão: objetiva
  return renderAlternativas(item.alternativas_json, item.correta, showGabarito);
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
  const altCorreta = alts.find(a => a.correta)?.letra || item.correta;

  if (tipo === 'verdadeiro_falso' && (est.submodo || 'direto') === 'direto') {
    const seq = (est.itens || []).map(i => i.gabarito || 'V').join(' - ');
    return seq || altCorreta || '—';
  }
  if (tipo === 'associacao' && (est.submodo || 'direto') === 'direto') {
    const seq = (est.coluna_b || []).map(b => b.vinculo_codigo || '—').join(' - ');
    return seq || altCorreta || '—';
  }
  if (tipo === 'lacuna' && (est.submodo || 'direto') !== 'alternativas') {
    const matches = [...String(item.conteudo_bruto || '').matchAll(/\{\{([^}]+)\}\}/g)].map(m => m[1].trim());
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

function renderQuestao(item, idx, template, showGabarito) {
  const num = String(idx + 1).padStart(2, '0');
  const enunciado = formatarEnunciadoPrincipal(item, showGabarito);
  const comandoFinal = item.comando_final ? `<div class="comando-final">${ltx(item.comando_final)}</div>` : '';
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
    ${renderCorpoModelo(item, template, showGabarito)}
  </div>`;
}

// CSS com margem configurável
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

    .assoc-table { width: 100%; border-collapse: collapse; margin: 5px 0; font-size: 9pt; }
    .assoc-table th, .assoc-table td { border: 0.6pt solid #666; padding: 3px 6px; vertical-align: top; text-align: left; width: 50%; }
    .assoc-table th { background: #f3f4f6; font-size: 8.5pt; text-transform: uppercase; }

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

// Monta o HTML completo respeitando config_json da prova
export function buildProvaHTML(prova, itens, escolaNome = '', showGabarito = false) {
  const template = prova.template_slug || 'objetiva_2col';

  let cfg = {};
  try {
    const raw = prova.config_json;
    cfg = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : {};
  } catch {}

  const embaralharAlt   = cfg.embaralhar_alternativas ?? prova.embaralhar_alternativas ?? 0;
  const embaralharQuest = cfg.embaralhar_questoes ?? 0;
  const comCabecalho    = cfg.com_cabecalho ?? true;
  const comMargem       = cfg.com_margem    ?? true;
  const cabItens        = cfg.cabecalho_itens ?? {};
  const sh              = (k) => cabItens[k] ?? true;
  const rodapeTxt       = cfg.rodape_texto  ?? '';
  const mostrarInstr    = (cabItens.cab_instrucoes ?? true) && comCabecalho;

  const margem = comMargem ? '10mm 12mm 14mm' : '4mm';

  let itensRender = embaralharAlt ? itens.map(it => {
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

  const temBncc = itensRender.some(it => Boolean(it.habilidade_bncc));
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
  const [[prova]] = await pool.query(
    `SELECT * FROM provas p WHERE p.id = ? AND ${escolaFilter(escola_id)}`,
    [id, ...escolaParam(escola_id)]
  );
  if (!prova) return null;

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

// ── POST /api/provas/:id/pdf ── Gera PDF via Playwright ──────────────────
export async function gerarPdf(req, res) {
  const { id } = req.params;
  const { escola_id } = req.user;
  const showGab = req.query.gabarito === '1';

  let browser = null;
  try {
    const data = await fetchProvaCompleta(id, escola_id);
    if (!data) return res.status(404).json({ message: 'Prova não encontrada.' });

    const escolaNome = req.query.escola || 'EDUCA.MELHOR';
    const html = buildProvaHTML(data.prova, data.itens, escolaNome, showGab);

    let cfg = {};
    try { const raw = data.prova.config_json; cfg = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : {}; } catch {}
    const comMargem = cfg.com_margem ?? true;
    const margemPdf = comMargem
      ? { top: '10mm', right: '12mm', bottom: '14mm', left: '12mm' }
      : { top: '4mm', right: '4mm', bottom: '4mm', left: '4mm' };

    const { chromium } = await import('playwright');
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle', timeout: 30_000 });

    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: margemPdf,
    });

    const slug = (data.prova.titulo || 'prova')
      .toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').slice(0, 40);
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
