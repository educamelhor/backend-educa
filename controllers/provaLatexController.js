// controllers/provaLatexController.js
// Gera PDF via LaTeX/Tectonic (XeTeX nativo UTF-8) — fidelidade total ao Modelo 01 e aos 7 tipos estruturais
import pool from '../db.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { randomUUID } from 'crypto';
import sharp from 'sharp';
import { ensureProvasSchema, resolveProvaTemplate } from './provasController.js';

const execFileAsync = promisify(execFile);

const escolaFilter = (escola_id) =>
  escola_id ? '(escola_id = ? OR escola_id IS NULL)' : '1=1';
const escolaParam = (escola_id) => (escola_id ? [escola_id] : []);

/* ── Sanitização UTF-8 / XeTeX Blindada ─────────────────────────────────────── */

function normalizarEntradaBruta(raw = '') {
  if (!raw) return '';
  let s = String(raw)
    .replace(/\u00A0/g, ' ')
    .replace(/<(?:b|strong)>([\s\S]*?)<\/(?:b|strong)>/gi, '**$1**')
    .replace(/<(?:i|em)>([\s\S]*?)<\/(?:i|em)>/gi, '*$1*')
    .replace(/<u>([\s\S]*?)<\/u>/gi, '__$1__')
    .replace(/<br\s*\/?>/gi, '\n')
    // Cura escapes acidentais de JSON antes de remover caracteres de controle
    .replace(/\x08(?=(?:eta|egin|inom|ar|oldsymbol))/g, '\\b')
    .replace(/\x0c(?=(?:rac|orall|lat))/g, '\\f')
    .replace(/\x09(?=(?:ext|imes|heta|au\b|an\b|riangle|ilde|frac|herefore))/g, '\\t')
    // Remove controles ASCII inválidos no XeTeX
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

  // Converte aspas retas (inclusive aninhadas) para aspas tipográficas curvas seguras no XeTeX
  s = s.replace(/(^|[\s(\[{—–-])"/g, '$1“').replace(/"/g, '”');
  return s;
}

export function escapeTex(str = '') {
  return normalizarEntradaBruta(str)
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/&/g, '\\&')
    .replace(/%/g, '\\%')
    .replace(/\$/g, '\\$')
    .replace(/#/g, '\\#')
    .replace(/\^/g, '\\textasciicircum{}')
    .replace(/~/g, '\\textasciitilde{}')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/_/g, '\\_')
    .replace(/→/g, '$\\rightarrow$')
    .replace(/←/g, '$\\leftarrow$')
    .replace(/↔/g, '$\\leftrightarrow$')
    .replace(/⇌/g, '$\\rightleftharpoons$')
    .replace(/≥/g, '$\\geq$')
    .replace(/≤/g, '$\\leq$')
    .replace(/≠/g, '$\\neq$')
    .replace(/≈/g, '$\\approx$')
    .replace(/±/g, '$\\pm$')
    .replace(/×/g, '$\\times$')
    .replace(/÷/g, '$\\div$')
    .replace(/°/g, '$^\\circ$')
    .replace(/²/g, '$^2$')
    .replace(/³/g, '$^3$')
    .replace(/¹/g, '$^1$')
    .replace(/⁰/g, '$^0$')
    .replace(/⁴/g, '$^4$')
    .replace(/π/g, '$\\pi$')
    .replace(/λ/g, '$\\lambda$')
    .replace(/Δ/g, '$\\Delta$')
    .replace(/μ/g, '$\\mu$')
    .replace(/Ω/g, '$\\Omega$')
    .replace(/α/g, '$\\alpha$')
    .replace(/β/g, '$\\beta$')
    .replace(/γ/g, '$\\gamma$')
    .replace(/θ/g, '$\\theta$')
    .replace(/∞/g, '$\\infty$')
    .replace(/•/g, '\\textbullet{}');
}

function sanitizarBlocoMath(mathRaw = '') {
  return String(mathRaw)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/"/g, "''")
    .replace(/→/g, '\\rightarrow ')
    .replace(/←/g, '\\leftarrow ')
    .replace(/↔/g, '\\leftrightarrow ')
    .replace(/⇌/g, '\\rightleftharpoons ')
    .replace(/≥/g, '\\geq ')
    .replace(/≤/g, '\\leq ')
    .replace(/≠/g, '\\neq ')
    .replace(/≈/g, '\\approx ')
    .replace(/±/g, '\\pm ')
    .replace(/×/g, '\\times ')
    .replace(/÷/g, '\\div ')
    .replace(/°/g, '^\\circ ')
    .replace(/²/g, '^2')
    .replace(/³/g, '^3')
    .replace(/¹/g, '^1')
    .replace(/π/g, '\\pi ')
    .replace(/λ/g, '\\lambda ')
    .replace(/Δ/g, '\\Delta ')
    .replace(/μ/g, '\\mu ')
    .replace(/Ω/g, '\\Omega ')
    .replace(/α/g, '\\alpha ')
    .replace(/β/g, '\\beta ')
    .replace(/γ/g, '\\gamma ')
    .replace(/θ/g, '\\theta ')
    .replace(/∞/g, '\\infty ');
}

function escapeProsaComMarkdownTex(str = '') {
  const tokens = [];
  let s = normalizarEntradaBruta(str);

  s = s.replace(/\*\*([\s\S]+?)\*\*/g, (_, inner) => {
    const id = `@@MDTOK${tokens.length}@@`;
    const cleanInner = String(inner).replace(/\r?\n+/g, ' ').trim();
    tokens.push(`\\textbf{${escapeTex(cleanInner)}}`);
    return id;
  });

  s = s.replace(/__([^\s_](?:[\s\S]*?[^\s_])?)__/g, (_, inner) => {
    const id = `@@MDTOK${tokens.length}@@`;
    const cleanInner = String(inner).replace(/\r?\n+/g, ' ').trim();
    tokens.push(`\\underline{${escapeTex(cleanInner)}}`);
    return id;
  });

  s = s.replace(/\*([^\s*](?:[^*\n]*?[^\s*])?)\*/g, (_, inner) => {
    const id = `@@MDTOK${tokens.length}@@`;
    const cleanInner = String(inner).replace(/\r?\n+/g, ' ').trim();
    tokens.push(`\\textit{${escapeTex(cleanInner)}}`);
    return id;
  });

  let escaped = escapeTex(s);
  tokens.forEach((rep, idx) => {
    escaped = escaped.replace(`@@MDTOK${idx}@@`, () => rep);
  });
  return escaped;
}

export function textoParaTex(str = '', { inlineOnly = false } = {}) {
  if (!str) return '';
  const mathTokens = [];
  const rawLimpo = String(str).trim();
  if (!rawLimpo) return '';

  const masked = rawLimpo.replace(/\$\$[^$]+\$\$|\$[^$]+\$|\\\[[^\]]+\\\]/g, (m) => {
    const id = `@@MTEX${mathTokens.length}@@`;
    mathTokens.push(sanitizarBlocoMath(m));
    return id;
  });

  const paragrafos = masked
    .split(/\r?\n+/)
    .map((ln) => ln.trim())
    .filter(Boolean)
    .map((ln) => escapeProsaComMarkdownTex(ln));

  let texOut = paragrafos.join(inlineOnly ? ' ' : '\n\n');
  mathTokens.forEach((mTex, idx) => {
    texOut = texOut.replace(`@@MTEX${idx}@@`, () => mTex);
  });
  return texOut;
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

async function salvarImagem(imgSource, jobDir, suffix) {
  if (!imgSource || typeof imgSource !== 'string') return null;

  const src = imgSource.trim();
  const imgPath = path.join(jobDir, `img_${suffix}`);

  if (/^https?:\/\//i.test(src)) {
    try {
      const resp = await fetch(src, { signal: AbortSignal.timeout(15000) });
      if (!resp.ok) {
        console.warn(`[provaLatex] Falha ao baixar imagem (${resp.status}): ${src}`);
        return null;
      }
      const buffer = Buffer.from(await resp.arrayBuffer());
      const jpgPath = `${imgPath}.jpg`;
      await sharp(buffer).rotate().flatten({ background: '#ffffff' }).jpeg({ quality: 92 }).toFile(jpgPath);
      return jpgPath;
    } catch (err) {
      console.warn(`[provaLatex] Erro ao baixar/converter imagem remota (${src}):`, err.message);
      return null;
    }
  }

  const match = src.match(/^data:image\/([a-zA-Z+]+);base64,(.+)$/);
  if (!match) return null;

  const [, tipo, dados] = match;
  try {
    const buffer = Buffer.from(dados, 'base64');
    const jpgOrPng = (tipo === 'svg+xml' || tipo === 'svg') ? `${imgPath}.png` : `${imgPath}.jpg`;
    if (tipo === 'svg+xml' || tipo === 'svg') {
      await sharp(buffer).png().toFile(jpgOrPng);
    } else {
      await sharp(buffer).rotate().flatten({ background: '#ffffff' }).jpeg({ quality: 92 }).toFile(jpgOrPng);
    }
    return jpgOrPng;
  } catch (err) {
    console.warn(`[provaLatex] Erro ao processar imagem base64:`, err.message);
    return null;
  }
}

/* ── Gerador LaTeX de Questões e Caderno ────────────────────────────────────── */

function renderFiguraTex(imgPath, midia, temMuitasAlts) {
  if (!imgPath) return '';
  const imgPathTex = imgPath.replace(/\\/g, '/');
  const presetMap = { P: '0.38\\linewidth', M: '0.62\\linewidth', G: '0.86\\linewidth', '100%': '0.98\\linewidth' };
  const widthTex = presetMap[midia?.preset] || '0.62\\linewidth';
  const maxH = temMuitasAlts ? '4.8cm' : '6.4cm';
  const alignCmd = midia?.alinhamento === 'left'
    ? '\\raggedright'
    : midia?.alinhamento === 'right'
      ? '\\raggedleft'
      : '\\centering';

  const legLimpa = String(midia?.legenda || '').trim();
  const credBruto = String(midia?.credito || '').trim();
  const credEhRodape = /^(?:humanas|linguagens|matem[aá]tica|ci[êe]ncias|exatas)[\s\-–—_/0-9º°ªa-z]*$/i.test(credBruto);
  const credUtil = credBruto && !credEhRodape && !legLimpa.toLowerCase().includes(credBruto.toLowerCase())
    ? `Fonte: ${credBruto}`
    : '';
  const legendaTxt = [legLimpa, credUtil].filter(Boolean).join(' — ');

  let tex = `\\par\\vspace{3pt}{${alignCmd}\\includegraphics[width=${widthTex},height=${maxH},keepaspectratio]{${imgPathTex}}\\par`;
  if (legendaTxt) {
    tex += `{\\footnotesize\\itshape\\color{darkgray} ${escapeTex(legendaTxt)}\\par}`;
  }
  tex += `}\\vspace{3pt}\n\n`;
  return tex;
}

function renderAlternativasTex(alts, altImgMap = {}, estiloAlt = 'minuscula_parentese') {
  if (!alts.length) return '';
  const labelEnum = estiloAlt === 'minuscula_parentese' ? '\\alph*)' : '\\textbf{(\\Alph*)}';

  let tex = `\\begin{enumerate}[label=${labelEnum},leftmargin=*,itemsep=1.5pt,topsep=2pt,parsep=0pt]\n`;
  alts.forEach((a) => {
    const pImg = altImgMap[a.letra];
    const txtAlt = textoParaTex(a.texto || '', { inlineOnly: true });
    const imgInline = pImg
      ? `${txtAlt ? '\\par\\vspace{2pt}' : ''}\\includegraphics[width=0.42\\linewidth,height=2.8cm,keepaspectratio]{${pImg.replace(/\\/g, '/')}}`
      : '';
    tex += `  \\item ${txtAlt || '\\mbox{}'}${imgInline}\n`;
  });
  tex += `\\end{enumerate}\n`;
  return tex;
}

function resumirGabaritoTex(item) {
  const est = parseJsonObj(item.estrutura_json, {}) || {};
  const tipo = item.tipo || est.modelo || 'objetiva';
  const alts = parseAlts(item.alternativas_json);
  const altCorreta = alts.find((a) => a.correta)?.letra || item.correta;

  if (tipo === 'verdadeiro_falso' && (est.submodo || 'direto') === 'direto') {
    return (est.itens || []).map((i) => i.gabarito || 'V').join('-') || altCorreta || '---';
  }
  if (tipo === 'associacao' && (est.submodo || 'direto') === 'direto') {
    return (est.coluna_b || []).map((b) => b.vinculo_codigo || '-').join('-') || altCorreta || '---';
  }
  if (tipo === 'lacuna' && (est.submodo || 'direto') !== 'alternativas') {
    const matches = [...String(item.conteudo_bruto || '').matchAll(/\{\{([^}]+)\}\}/g)].map((m) => m[1].trim());
    const lacs = matches.length ? matches : (est.lacunas || []);
    return lacs.length ? lacs.join(' / ') : '---';
  }
  if (tipo === 'somatoria') {
    const s = est.soma_correta ?? item.correta;
    return s !== undefined && s !== null && s !== '' ? String(s).padStart(2, '0') : '---';
  }
  if (tipo === 'discursiva') return 'Discursiva';
  return altCorreta || '---';
}

function gerarTexQuestao(item, idx, imgBundle, colunas, opts = {}) {
  const { isModelo01 = false, estiloAlt = 'minuscula_parentese' } = opts;
  const alts = parseAlts(item.alternativas_json).filter((a) => (a?.texto && String(a.texto).trim()) || a?.imagem_url);
  const est = parseJsonObj(item.estrutura_json, {}) || {};
  const midia = parseJsonObj(item.midia_json, null);
  const tipo = item.tipo || est.modelo || 'objetiva';
  const posicao = ['apos_texto_apoio', 'entre_enunciado_e_comando', 'abaixo_comando'].includes(midia?.posicao)
    ? midia.posicao
    : 'entre_enunciado_e_comando';

  const num = String(idx + 1).padStart(2, '0');
  const pontos = Number(item.valor_pontos || 1).toFixed(1);
  const regraW = colunas === 2 ? '5.8cm' : '13.5cm';

  let tex = idx > 0 ? `\\filbreak\\vspace{4pt}\\noindent\n` : `\\par\\vspace{2pt}\\noindent\n`;
  const fonteHdr = item.fonte && !item.texto_apoio ? ` {\\small (${escapeTex(item.fonte)})}` : '';
  if (isModelo01) {
    // Clona exatamente "QUESTÃO 01" + retângulo sólido laranja (#FF7F00) até o limite direito da coluna
    tex += `\\leavevmode{\\bfseries QUESTÃO ${num}}${fonteHdr}\\hspace{0.22cm}{\\color{corDestaque}\\leaders\\hrule height 8.6pt depth 2.0pt\\hfill\\kern0pt}\\par\\nopagebreak\\vspace{2pt}\n\n`;
  } else {
    tex += `\\leavevmode{\\bfseries QUESTÃO ${num}}${fonteHdr} {\\color{laranja}\\rule{${regraW}}{0.4pt}} {\\small\\color{gray}(${pontos} pt)}\\par\\nopagebreak\\vspace{2pt}\n\n`;
  }

  if (item.texto_apoio && String(item.texto_apoio).trim()) {
    tex += `{\\par\\leftskip=0.42cm\\small\\itshape ${textoParaTex(item.texto_apoio)}\\par}\n`;
    if (item.fonte) {
      tex += `{\\raggedleft\\footnotesize (${escapeTex(item.fonte)})\\par}\n`;
    }
    tex += `\\vspace{2pt}\n\n`;
  }

  const figTex = renderFiguraTex(imgBundle?.main || null, midia, alts.length > 3);

  if (posicao === 'apos_texto_apoio') tex += figTex;

  if (item.conteudo_bruto && String(item.conteudo_bruto).trim()) {
    if (tipo === 'lacuna') {
      const partes = String(item.conteudo_bruto).split(/(\{\{[^}]+\}\})/g);
      const texLac = partes.map((p) => {
        if (p.startsWith('{{') && p.endsWith('}}')) {
          return '\\underline{\\hspace{2.2cm}}';
        }
        return textoParaTex(p, { inlineOnly: true });
      }).join('');
      tex += `${texLac}\\par\\vspace{2pt}\n\n`;
    } else {
      tex += `${textoParaTex(item.conteudo_bruto)}\\par\\vspace{2pt}\n\n`;
    }
  }

  if (posicao === 'entre_enunciado_e_comando') tex += figTex;

  const comandoPosCorpo = (tipo === 'associacao' || tipo === 'verdadeiro_falso') && (est.submodo || 'direto') === 'sequencia';

  if (item.comando_final && String(item.comando_final).trim() && !comandoPosCorpo) {
    tex += `{\\bfseries ${textoParaTex(item.comando_final)}}\\par\\vspace{2pt}\n\n`;
  }

  if (posicao === 'abaixo_comando') tex += figTex;

  // Renderização por modelo estrutural (sem usar \\ após parágrafos dinâmicos)
  if (tipo === 'afirmativas') {
    const props = Array.isArray(est.proposicoes) ? est.proposicoes : [];
    props.forEach((p, i) => {
      const rom = escapeTex(p.romano || ['I', 'II', 'III', 'IV', 'V'][i] || String(i + 1));
      tex += `\\par\\noindent\\textbf{${rom}.} ${textoParaTex(p.texto || '', { inlineOnly: true })}\\par\\vspace{1.5pt}\n`;
    });
    if (est.comando_fechamento && String(est.comando_fechamento).trim()) {
      tex += `\\par\\vspace{2pt}\\noindent{\\bfseries ${textoParaTex(est.comando_fechamento)}}\\par\\vspace{2pt}\n\n`;
    }
    tex += renderAlternativasTex(alts, imgBundle?.alts || {}, estiloAlt);
  } else if (tipo === 'verdadeiro_falso') {
    const itensVf = Array.isArray(est.itens) ? est.itens : [];
    itensVf.forEach((it) => {
      tex += `\\par\\noindent\\texttt{(\\hspace{0.45cm})} ${textoParaTex(it.texto || '', { inlineOnly: true })}\\par\\vspace{2pt}\n`;
    });
    if ((est.submodo || 'direto') === 'sequencia') {
      if (item.comando_final && String(item.comando_final).trim()) {
        tex += `\\par\\vspace{2pt}\\noindent{\\bfseries ${textoParaTex(item.comando_final)}}\\par\\vspace{2pt}\n\n`;
      }
      tex += renderAlternativasTex(alts, imgBundle?.alts || {}, estiloAlt);
    } else if (est.exigir_justificativa_falsas) {
      const nLin = Math.max(1, Math.min(8, Number(est.linhas_justificativa) || 3));
      tex += `\\par\\vspace{2pt}\\noindent{\\small\\bfseries Justifique as falsas:}\\par\\vspace{2pt}\n`;
      for (let i = 0; i < nLin; i++) {
        tex += `\\noindent\\underline{\\hspace{\\linewidth}}\\par\\vspace{0.16cm}\n`;
      }
    }
  } else if (tipo === 'associacao') {
    const colA = Array.isArray(est.coluna_a) ? est.coluna_a : [];
    const colB = Array.isArray(est.coluna_b) ? est.coluna_b : [];
    const avgA = colA.length ? colA.reduce((s, x) => s + String(x?.texto || '').length, 0) / colA.length : 25;
    const avgB = colB.length ? colB.reduce((s, x) => s + String(x?.texto || '').length, 0) / colB.length : 45;
    const wTexA = avgA <= avgB * 0.58 ? '0.35\\linewidth' : '0.44\\linewidth';
    const wTexB = avgA <= avgB * 0.58 ? '0.55\\linewidth' : '0.46\\linewidth';
    const maxR = Math.max(colA.length, colB.length);
    if (maxR > 0) {
      tex += `\\par\\vspace{2pt}\\noindent\\begin{tabular}{|>{\\raggedright\\arraybackslash}p{${wTexA}}|>{\\raggedright\\arraybackslash}p{${wTexB}}|}\\hline\n`;
      tex += `\\textbf{${escapeTex(est.titulo_coluna_a || 'Coluna A')}} & \\textbf{${escapeTex(est.titulo_coluna_b || 'Coluna B')}} \\\\ \\hline\n`;
      for (let i = 0; i < maxR; i++) {
        const a = colA[i];
        const b = colB[i];
        const cellA = a ? `\\textbf{(${escapeTex(a.codigo || i + 1)})} ${textoParaTex(a.texto || '', { inlineOnly: true })}` : '';
        const cellB = b ? `\\texttt{(\\hspace{0.35cm})} ${textoParaTex(b.texto || '', { inlineOnly: true })}` : '';
        tex += `${cellA} & ${cellB} \\\\ \\hline\n`;
      }
      tex += `\\end{tabular}\\par\\vspace{3pt}\n\n`;
    }
    if ((est.submodo || 'direto') === 'sequencia') {
      if (item.comando_final && String(item.comando_final).trim()) {
        tex += `\\par\\vspace{2pt}\\noindent{\\bfseries ${textoParaTex(item.comando_final)}}\\par\\vspace{2pt}\n\n`;
      }
      tex += renderAlternativasTex(alts, imgBundle?.alts || {}, estiloAlt);
    }
  } else if (tipo === 'lacuna') {
    if ((est.submodo || 'direto') === 'banco_palavras') {
      const banco = [...(est.lacunas || []), ...(est.distratores_banco || [])].filter(Boolean)
        .sort((a, b) => a.localeCompare(b, 'pt-BR'));
      if (banco.length) {
        tex += `\\par\\noindent\\fbox{\\parbox{0.95\\linewidth}{\\small\\textbf{Banco de palavras:} ${banco.map(escapeTex).join(' \\textbullet{} ')}}}\\par\\vspace{3pt}\n\n`;
      }
    } else if (est.submodo === 'alternativas') {
      tex += renderAlternativasTex(alts, imgBundle?.alts || {}, estiloAlt);
    }
  } else if (tipo === 'somatoria') {
    const props = Array.isArray(est.proposicoes) ? est.proposicoes : [];
    props.forEach((p) => {
      const cod = escapeTex(p.codigo || String(p.valor || '').padStart(2, '0'));
      tex += `\\par\\noindent\\textbf{(${cod})} ${textoParaTex(p.texto || '', { inlineOnly: true })}\\par\\vspace{2pt}\n`;
    });
    tex += `{\\raggedleft\\textbf{SOMA:} \\framebox[1.4cm]{\\rule{0pt}{0.45cm}}\\par}\n\n`;
  } else if (tipo === 'discursiva') {
    const formato = est.formato_espaco || 'linhas';
    if (formato === 'quadro_calculo') {
      const altCm = Math.max(2.5, Math.min(7.5, ((Number(est.altura_quadro_px) || 140) / 38))).toFixed(1);
      tex += `\\par\\vspace{0.15cm}\\noindent\\framebox[\\linewidth]{\\rule{0pt}{${altCm}cm}}\\par\n\n`;
    } else if (formato !== 'nenhum') {
      const nLin = Math.max(2, Math.min(18, Number(est.linhas_resposta) || 6));
      tex += `\\par\\vspace{0.18cm}\n`;
      for (let i = 0; i < nLin; i++) {
        tex += `\\noindent\\underline{\\hspace{\\linewidth}}\\par\\vspace{0.18cm}\n`;
      }
    }
  } else {
    tex += renderAlternativasTex(alts, imgBundle?.alts || {}, estiloAlt);
  }

  tex += `\\vspace{0.22cm}\n\n`;
  return tex;
}

export function gerarTexCompleto({ prova, itens, cfg = {}, escola = 'EDUCA.MELHOR', colunas = 2, imgBundles = [], comGabarito = false, template = 'modelo_01_provao' }) {
  const isModelo01 = template === 'modelo_01_provao';
  const is2col = isModelo01 || colunas === 2;
  const comCab = isModelo01 ? false : (cfg.com_cabecalho ?? true);
  const comMarg = cfg.com_margem ?? true;
  const rodapeTxt = cfg.rodape_texto || '';
  const cab = cfg.cabecalho_itens ?? {};
  const sh = (k) => cab[k] ?? true;

  const corHexClean = String(cfg.cor_destaque || '#FF7F00').replace(/[^0-9A-Fa-f]/g, '').toUpperCase().slice(0, 6) || 'FF7F00';
  const estiloAlt = isModelo01 ? (cfg.estilo_alternativa || 'minuscula_parentese') : (cfg.estilo_alternativa || 'maiuscula_parenteses');
  const mostrarDivisoresDisc = isModelo01 ? (cfg.mostrar_divisores_disciplina ?? true) : Boolean(cfg.mostrar_divisores_disciplina);
  const fechamentoCaderno = isModelo01 ? (cfg.fechamento_caderno || 'nenhum') : 'nenhum';
  const numerarRodape = Boolean(cfg.numerar_paginas_rodape);
  const densidade = ['10pt', '11pt', '12pt'].includes(cfg.densidade_fonte) ? cfg.densidade_fonte : '11pt';
  const fontPt = densidade === '10pt' ? '10pt' : densidade === '12pt' ? '12pt' : '11pt';
  const linePt = densidade === '10pt' ? '12.4pt' : densidade === '12pt' ? '14.6pt' : '13.6pt';

  const rodapeExternoM01 = rodapeTxt.trim()
    ? rodapeTxt.trim()
    : [
        String(prova.titulo || prova.disciplina || 'AVALIAÇÃO').trim().toUpperCase(),
        prova.turma ? String(prova.turma).trim().toUpperCase() : '',
        prova.bimestre ? `${prova.bimestre}º BIMESTRE` : '',
      ].filter(Boolean).join(' - ');

  const geomOpts = isModelo01
    ? 'a4paper,lmargin=0.95cm,rmargin=0.95cm,tmargin=0.85cm,bmargin=1.38cm,headheight=14pt,footskip=0.72cm'
    : `a4paper,lmargin=${comMarg ? '0.6cm' : '0.4cm'},rmargin=${comMarg ? '0.6cm' : '0.4cm'},tmargin=${comMarg ? '0.6cm' : '0.4cm'},bmargin=${comMarg ? '1.0cm' : '0.5cm'},headheight=14pt`;

  let tex = `\\documentclass{article}\n`;
  tex += `\\usepackage{fontspec}\n`;
  tex += `\\IfFontExistsTF{Liberation Serif}{\\setmainfont{Liberation Serif}}{\\IfFontExistsTF{Times New Roman}{\\setmainfont{Times New Roman}}{}}\n`;
  tex += `\\usepackage[${geomOpts}]{geometry}\n`;
  tex += `\\usepackage{multicol}\n`;
  tex += `\\usepackage{array}\n`;
  tex += `\\usepackage[shortlabels]{enumitem}\n`;
  tex += `\\usepackage{tikz}\n`;
  tex += `\\usetikzlibrary{calc}\n`;
  tex += `\\usepackage{fancyhdr}\n`;
  tex += `\\usepackage{xcolor}\n`;
  tex += `\\usepackage{graphicx}\n`;
  tex += `\\usepackage{amsmath,amssymb,mathtools}\n`;
  tex += `\\setlength{\\parindent}{0pt}\n`;
  tex += `\\setlength{\\parskip}{2pt}\n`;
  tex += `\\widowpenalty=10000\n\\clubpenalty=10000\n`;
  tex += `\\makeatletter\\@ifundefined{l@portuguese}{\\@ifundefined{l@portuges}{}{\\language=\\l@portuges}}{\\language=\\l@portuguese}\\makeatother\n`;
  tex += `\\lefthyphenmin=2\\righthyphenmin=3\n`;

  tex += `\\definecolor{laranja}{HTML}{FF6600}\n`;
  tex += `\\definecolor{corDestaque}{HTML}{${corHexClean}}\n`;
  tex += `\\definecolor{azul}{HTML}{0066FF}\n`;
  tex += `\\definecolor{gray}{HTML}{777777}\n`;
  tex += `\\definecolor{darkgray}{HTML}{444444}\n`;

  tex += `\n\\pagestyle{fancy}\n\\fancyhf{}\n`;
  if (isModelo01) {
    // Moldura preta 2.25pt otimizada (6mm laterais, 5.5mm topo, 10.5mm base) + rodapé externo fora da margem
    const pgNodeTex = numerarRodape
      ? `  \\node[anchor=east] at ($(current page.south east) + (-0.60cm,0.58cm)$) {\\fontsize{9pt}{11pt}\\selectfont Pág. \\thepage};\n`
      : '';
    tex += `\\fancyhead[L]{%\n\\begin{tikzpicture}[overlay, remember picture]\n`;
    tex += `  \\draw[draw=black, line width=2.25pt] ($(current page.north west) + (0.60cm,-0.55cm)$) rectangle ($(current page.south east) + (-0.60cm,1.05cm)$);\n`;
    tex += `  \\node[anchor=center] at ($(current page.south) + (0cm,0.58cm)$) {\\fontsize{10.5pt}{12.5pt}\\selectfont ${escapeTex(rodapeExternoM01)}};\n`;
    tex += pgNodeTex;
    tex += `\\end{tikzpicture}%\n}\n`;
  } else {
    tex += `\\fancyhead[L]{%\n\\begin{tikzpicture}[overlay, remember picture]\n`;
    tex += `  \\draw[draw=black, line width=1.4pt] ($(current page.north west) + (0.6cm,-0.6cm)$) rectangle ($(current page.south east) + (-0.6cm,0.8cm)$);\n`;
    tex += `\\end{tikzpicture}%\n}\n`;
    tex += `\\fancyfoot[C]{\\footnotesize\\color{gray} ${escapeTex(escola)} — EDUCA.PROVA · Pág. \\thepage}\n`;
  }
  tex += `\\renewcommand{\\headrulewidth}{0pt}\n\\renewcommand{\\footrulewidth}{0pt}\n\n`;

  const totalPts = itens.reduce((s, it) => s + Number(it.valor_pontos || 1), 0).toFixed(1);

  tex += `\\begin{document}\n`;
  tex += `\\fontsize{${fontPt}}{${linePt}}\\selectfont\n\n`;

  if (comCab) {
    tex += `{\\centering\n`;
    if (sh('cab_escola')) {
      tex += `  {\\large\\bfseries ${escapeTex(String(escola).toUpperCase())}\\par}\n`;
      tex += `  {\\small Sistema de Ensino EDUCA.MELHOR\\par}\n`;
    }
    if (sh('cab_titulo')) {
      tex += `  \\vspace{3pt}\\rule{\\linewidth}{0.8pt}\\par\\vspace{2pt}\n`;
      tex += `  {\\large\\bfseries ${escapeTex(String(prova.titulo || 'AVALIAÇÃO').toUpperCase())}\\par}\n`;
      tex += `  \\rule{\\linewidth}{0.8pt}\\par\n`;
    }
    tex += `}\\vspace{4pt}\n\n`;

    tex += `\\noindent\\begin{tabular}{|p{0.55\\linewidth}|p{0.22\\linewidth}|p{0.15\\linewidth}|}\\hline\n`;
    tex += `${sh('cab_nome') ? 'Nome:' : ''} & ${sh('cab_turma') ? `Turma: ${escapeTex(prova.turma || '')}` : ''} & ${sh('cab_nota') ? 'Nota:' : ''} \\\\ \\hline\n`;
    const linha2 = [];
    if (sh('cab_disc') && prova.disciplina) linha2.push(`Disciplina: ${escapeTex(prova.disciplina)}`);
    if (sh('cab_bimestre') && prova.bimestre) linha2.push(`${prova.bimestre}º Bimestre`);
    if (sh('cab_ano') && prova.ano_letivo) linha2.push(String(prova.ano_letivo));
    if (sh('cab_data')) linha2.push('Data: \\underline{\\hspace{2.5cm}}');
    tex += `\\multicolumn{3}{|l|}{${linha2.join(' \\quad ')}} \\\\ \\hline\n`;
    tex += `\\end{tabular}\\par\\vspace{4pt}\n\n`;

    if (sh('cab_instrucoes')) {
      tex += `\\noindent\\fbox{\\parbox{0.97\\linewidth}{\\small\\textbf{INSTRUÇÕES:} `;
      tex += `Esta avaliação contém \\textbf{${itens.length} questão(ões)} `;
      tex += `no total de \\textbf{${totalPts} ponto(s)}. `;
      tex += `Leia cada questão com atenção antes de responder.}}\\par\\vspace{0.25cm}\n\n`;
    }
  }

  if (is2col) {
    const envMulticol = isModelo01 ? 'multicols*' : 'multicols';
    tex += `\\setlength{\\columnsep}{0.76cm}\n\\setlength{\\columnseprule}{0.85pt}\n\\begin{${envMulticol}}{2}\n\n`;
  }

  let ultimaDisc = '';
  itens.forEach((item, idx) => {
    const discUp = String(item.disciplina || '').trim().toUpperCase();
    if (mostrarDivisoresDisc && discUp && discUp !== ultimaDisc) {
      ultimaDisc = discUp;
      tex += `\\par\\vspace{2pt}{\\centering\\bfseries\\underline{${escapeTex(discUp)}}\\par}\\nopagebreak\\vspace{3pt}\n\n`;
    }
    tex += gerarTexQuestao(item, idx, imgBundles[idx] || null, is2col ? 2 : 1, { isModelo01, estiloAlt });
  });

  if (fechamentoCaderno === 'rascunho') {
    tex += `\\par\\vspace{0.35cm}{\\centering\\bfseries\\underline{RASCUNHO}\\par}\\vspace{2.5cm}\n\n`;
  } else if (fechamentoCaderno === 'boa_prova') {
    tex += `\\par\\vspace{0.35cm}{\\centering\\bfseries BOA PROVA!\\par}\n\n`;
  }

  if (is2col) {
    const envMulticol = isModelo01 ? 'multicols*' : 'multicols';
    tex += `\\end{${envMulticol}}\n\n`;
  }

  if (comGabarito) {
    tex += `\\newpage\n`;
    tex += `{\\centering\\large\\bfseries \\underline{GABARITO OFICIAL — ${escapeTex(String(prova.titulo || 'AVALIAÇÃO').toUpperCase())}}\\par}\\vspace{0.35cm}\n\n`;
    tex += `{\\centering\n`;
    tex += `\\begin{tabular}{|c|c|p{5.5cm}|c|c|}\\hline\n`;
    tex += `\\textbf{Nº} & \\textbf{Código} & \\textbf{Resposta / Gabarito} & \\textbf{Pts} & \\textbf{Disciplina} \\\\ \\hline\n`;
    itens.forEach((it, i) => {
      const corr = escapeTex(resumirGabaritoTex(it));
      const cod = escapeTex(it.codigo || `Q-${i + 1}`);
      const pts = Number(it.valor_pontos || 1).toFixed(1);
      tex += `${String(i + 1).padStart(2, '0')} & ${cod} & \\textbf{${corr}} & ${pts} & ${escapeTex(it.disciplina || '---')} \\\\ \\hline\n`;
    });
    tex += `\\multicolumn{3}{|r|}{\\textbf{TOTAL}} & ${totalPts} & \\\\ \\hline\n`;
    tex += `\\end{tabular}\\par}\n\n`;
  }

  tex += `\\end{document}\n`;
  return tex;
}

/* ── Controller principal ───────────────────────────────────────────────────── */

export async function exportarPdfLatex(req, res) {
  const { id } = req.params;
  const { escola_id } = req.user || {};
  const comGabarito = req.query.gabarito === '1';

  let prova, itens;
  try {
    await ensureProvasSchema();
    const [[p]] = await pool.query(
      `SELECT * FROM provas WHERE id = ? AND ${escolaFilter(escola_id)}`,
      [id, ...escolaParam(escola_id)]
    );
    if (!p) return res.status(404).json({ message: 'Prova não encontrada.' });
    prova = p;

    const [rows] = await pool.query(
      `SELECT pq.valor_pontos, pq.ordem,
              CONCAT('EMQE-', LPAD(COALESCE(q.numero_q, q.id), 5, '0')) AS codigo,
              q.conteudo_bruto, q.comando_final, q.tipo, q.nivel, q.disciplina,
              q.alternativas_json, q.estrutura_json, q.correta, q.resposta_aberta,
              q.imagem_url, q.imagem_base64, q.midia_json,
              q.texto_apoio, q.fonte
       FROM prova_questoes pq
       JOIN questoes q ON q.id = pq.questao_id
       WHERE pq.prova_id = ?
       ORDER BY pq.ordem ASC`,
      [id]
    );
    itens = rows;
  } catch (err) {
    console.error('exportarPdfLatex DB:', err);
    return res.status(500).json({ message: 'Erro ao carregar prova.', detail: err.message });
  }

  const jobId = randomUUID();
  const jobDir = path.join(os.tmpdir(), 'latex-jobs', jobId);
  const cacheDir = process.platform === 'win32'
    ? path.join(os.tmpdir(), 'tectonic-cache')
    : '/tmp/tectonic-cache';

  fs.mkdirSync(jobDir, { recursive: true });
  fs.mkdirSync(cacheDir, { recursive: true });

  try {
    const cfg = parseJsonObj(prova.config_json, {}) || {};
    const escola = req.query.escola || prova.escola_nome || 'EDUCA.MELHOR';
    const template = resolveProvaTemplate(prova);
    const colunas = ['modelo_01_provao', 'objetiva_2col', 'enem'].includes(template) ? 2 : 1;

    const imgBundles = await Promise.all(
      itens.map(async (it, idx) => {
        const midia = parseJsonObj(it.midia_json, null);
        const mainSrc = midia?.url || it.imagem_url || it.imagem_base64;
        const main = await salvarImagem(mainSrc, jobDir, `${idx}_main`);
        const alts = {};
        const altsArr = parseAlts(it.alternativas_json);
        for (const a of altsArr) {
          if (a?.imagem_url && a?.letra) {
            const pAlt = await salvarImagem(a.imagem_url, jobDir, `${idx}_alt_${a.letra}`);
            if (pAlt) alts[a.letra] = pAlt;
          }
        }
        return { main, alts };
      })
    );

    const texContent = gerarTexCompleto({ prova, itens, cfg, escola, colunas, imgBundles, comGabarito, template });
    const texFile = path.join(jobDir, 'prova.tex');
    fs.writeFileSync(texFile, texContent, 'utf-8');

    await execFileAsync('tectonic', [
      texFile,
      '--outdir', jobDir,
      '--keep-logs',
    ], {
      timeout: 90000,
      maxBuffer: 10 * 1024 * 1024,
      env: {
        ...process.env,
        TECTONIC_CACHE_DIR: cacheDir,
      },
    });

    const pdfPath = path.join(jobDir, 'prova.pdf');
    if (!fs.existsSync(pdfPath)) {
      const logPath = path.join(jobDir, 'prova.log');
      const logContent = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf-8').slice(-2000) : 'sem log';
      throw new Error(`PDF não gerado pelo Tectonic. Log: ${logContent}`);
    }

    const pdfBuffer = fs.readFileSync(pdfPath);
    const nomeArq = `${(prova.titulo || 'prova')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '') || 'prova'}-latex.pdf`;

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${nomeArq}"`,
      'Content-Length': pdfBuffer.length,
      'Cache-Control': 'no-store',
    });
    res.end(pdfBuffer);
  } catch (err) {
    const logPath = path.join(jobDir, 'prova.log');
    const logTail = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf-8').slice(-1200) : '';
    const errMsg = [err.stderr, err.message, logTail].filter(Boolean).join(' | ').slice(0, 600);
    console.error('[exportarPdfLatex] Erro Tectonic:', errMsg);
    res.status(500).json({
      message: 'Erro na compilação LaTeX.',
      detail: errMsg.slice(0, 350),
    });
  } finally {
    try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch {}
  }
}
