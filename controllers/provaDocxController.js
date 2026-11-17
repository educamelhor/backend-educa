// controllers/provaDocxController.js
// EDUCA.PROVA — Exportador Nativo Microsoft Word (.docx OpenXML)
// Clona cirurgicamente o Modelo 01 ("9º ANO-EXATAS.docx"):
// - A4 sem cabeçalho institucional (compatível com Capa de Prova separada)
// - Moldura retangular preta 2.25pt nas 4 bordas da página
// - Duas colunas simétricas com linha vertical divisória central (w:cols w:num="2" w:sep="1")
// - Separador visual de cada questão com retângulo sólido colorido (#FF7F00 por padrão) alinhado à direita
// - Rodapé posicionado ESTRITAMENTE FORA (abaixo) da moldura/margem inferior da página
// - Suporte completo aos 7 modelos universais de questão, imagens em alta definição (Sharp) e fórmulas

import zlib from 'zlib';
import sharp from 'sharp';
import pool from '../db.js';
import { ensureProvasSchema, resolveProvaTemplate } from './provasController.js';

const escolaFilter = (escola_id) =>
  escola_id ? '(p.escola_id = ? OR p.escola_id IS NULL)' : '1=1';
const escolaParam = (escola_id) => (escola_id ? [escola_id] : []);

/* ── Compactador PKZIP puro em Node.js (zero dependências externas) ─────────── */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32Buffer(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function buildZipArchive(entries) {
  // entries: Array<{ name: string, data: Buffer | string }>
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(String(entry.name).replace(/\\/g, '/'), 'utf8');
    const rawBuf = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data), 'utf8');
    const crc = crc32Buffer(rawBuf);
    const compBuf = zlib.deflateRawSync(rawBuf, { level: 6 });

    // Local file header (30 bytes + filename)
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0); // signature
    lfh.writeUInt16LE(20, 4);         // version needed (2.0)
    lfh.writeUInt16LE(0x0800, 6);     // UTF-8 filename flag
    lfh.writeUInt16LE(8, 8);          // method: deflate
    lfh.writeUInt16LE(0, 10);         // mod time
    lfh.writeUInt16LE(0x5761, 12);    // mod date
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(compBuf.length, 18);
    lfh.writeUInt32LE(rawBuf.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28);

    localParts.push(lfh, nameBuf, compBuf);

    // Central directory header (46 bytes + filename)
    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0); // signature
    cdh.writeUInt16LE(20, 4);         // version made by
    cdh.writeUInt16LE(20, 6);         // version needed
    cdh.writeUInt16LE(0x0800, 8);     // UTF-8 flag
    cdh.writeUInt16LE(8, 10);         // method: deflate
    cdh.writeUInt16LE(0, 12);         // mod time
    cdh.writeUInt16LE(0x5761, 14);    // mod date
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(compBuf.length, 20);
    cdh.writeUInt32LE(rawBuf.length, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt16LE(0, 30);         // extra len
    cdh.writeUInt16LE(0, 32);         // comment len
    cdh.writeUInt16LE(0, 34);         // disk start
    cdh.writeUInt16LE(0, 36);         // internal attrs
    cdh.writeUInt32LE(0, 38);         // external attrs
    cdh.writeUInt32LE(offset, 42);    // local header offset

    centralParts.push(cdh, nameBuf);
    offset += 30 + nameBuf.length + compBuf.length;
  }

  const centralBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralBuf, eocd]);
}

/* ── Helpers de XML e Matemática p/ WordprocessingML ────────────────────────── */
function escXml(str = '') {
  return String(str || '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function parseJsonSafe(raw, fallback = null) {
  if (!raw) return fallback;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return fallback; }
}

const LATEX_SYMBOLS_MAP = [
  [/\\rightarrow|\\to\b/g, '→'],
  [/\\leftarrow/g, '←'],
  [/\\leftrightarrow/g, '↔'],
  [/\\rightleftharpoons/g, '⇌'],
  [/\\Rightarrow/g, '⇒'],
  [/\\times\b/g, '×'],
  [/\\cdot\b/g, '·'],
  [/\\div\b/g, '÷'],
  [/\\pm\b/g, '±'],
  [/\\leq|\\le\b/g, '≤'],
  [/\\geq|\\ge\b/g, '≥'],
  [/\\neq|\\ne\b/g, '≠'],
  [/\\approx/g, '≈'],
  [/\\infty/g, '∞'],
  [/\\pi\b/g, 'π'],
  [/\\Delta\b/g, 'Δ'],
  [/\\theta\b/g, 'θ'],
  [/\\lambda\b/g, 'λ'],
  [/\\mu\b/g, 'μ'],
  [/\\Omega\b/g, 'Ω'],
  [/\\alpha\b/g, 'α'],
  [/\\beta\b/g, 'β'],
  [/\\gamma\b/g, 'γ'],
  [/\\circ\b/g, '°'],
  [/\\degree\b/g, '°'],
];

/**
 * Converte uma expressão LaTeX inline/display para runs WordprocessingML limpos
 * (com suporte real a sobrescritos x^2, subscritos H_2O, frações e símbolos científicos).
 */
function converterMathParaRunsXml(latexRaw = '', baseRPr = '') {
  let s = String(latexRaw || '').trim();
  s = s.replace(/\\text\{([^{}]*)\}/g, '$1');
  s = s.replace(/\\mathrm\{([^{}]*)\}/g, '$1');
  s = s.replace(/\\mathbf\{([^{}]*)\}/g, '$1');
  s = s.replace(/\\frac\{([^{}]+)\}\{([^{}]+)\}/g, '($1)/($2)');
  s = s.replace(/\\sqrt\[([^\]]+)\]\{([^{}]+)\}/g, '√($1)($2)');
  s = s.replace(/\\sqrt\{([^{}]+)\}/g, '√($1)');
  for (const [re, sym] of LATEX_SYMBOLS_MAP) {
    s = s.replace(re, sym);
  }
  s = s.replace(/\\([a-zA-Z]+)/g, '$1');

  // Tokeniza subscritos _{...} / _x e sobrescritos ^{...} / ^x
  const runs = [];
  const tokenRe = /(\^\{([^{}]+)\}|\^([A-Za-z0-9+\-]+)|_\{([^{}]+)\}|_([A-Za-z0-9+\-]+))/g;
  let last = 0;
  let m;
  while ((m = tokenRe.exec(s)) !== null) {
    if (m.index > last) {
      runs.push({ text: s.slice(last, m.index), vert: null });
    }
    if (m[2] !== undefined || m[3] !== undefined) {
      runs.push({ text: m[2] ?? m[3], vert: 'superscript' });
    } else {
      runs.push({ text: m[4] ?? m[5], vert: 'subscript' });
    }
    last = m.index + m[0].length;
  }
  if (last < s.length) {
    runs.push({ text: s.slice(last), vert: null });
  }

  return runs
    .filter((r) => r.text)
    .map((r) => {
      const vXml = r.vert ? `<w:vertAlign w:val="${r.vert}"/>` : '';
      return `<w:r><w:rPr>${baseRPr}${vXml}</w:rPr><w:t xml:space="preserve">${escXml(r.text)}</w:t></w:r>`;
    })
    .join('');
}

/**
 * Converte texto com markdown editorial (**negrito**, __sublinhado__, *itálico*) e LaTeX ($...$, $$...$$)
 * em sequência de elementos <w:r> do WordprocessingML.
 */
function textoRicoParaRunsXml(text = '', opts = {}) {
  const { fontHalfPt = 24, bold = false, italic = false, underline = false, color = '000000' } = opts;

  const buildRPr = (b, i, u) => {
    const tags = [
      '<w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="Times New Roman" w:cs="Times New Roman"/>',
      `<w:color w:val="${color}"/>`,
      `<w:sz w:val="${fontHalfPt}"/><w:szCs w:val="${fontHalfPt}"/>`,
    ];
    if (b) tags.push('<w:b/><w:bCs/>');
    if (i) tags.push('<w:i/><w:iCs/>');
    if (u) tags.push('<w:u w:val="single"/>');
    return tags.join('');
  };

  const renderMarkdownSegment = (seg, b, i, u) => {
    if (!seg) return '';
    const mdRe = /\*\*([\s\S]+?)\*\*|__([^\s_](?:[\s\S]*?[^\s_])?)__|\*([^\s*](?:[^*\n]*?[^\s*])?)\*/g;
    let out = '';
    let lastIdx = 0;
    let match;
    while ((match = mdRe.exec(seg)) !== null) {
      if (match.index > lastIdx) {
        const plain = seg.slice(lastIdx, match.index);
        out += `<w:r><w:rPr>${buildRPr(b, i, u)}</w:rPr><w:t xml:space="preserve">${escXml(plain)}</w:t></w:r>`;
      }
      if (match[1] !== undefined) {
        out += renderMarkdownSegment(match[1], true, i, u);
      } else if (match[2] !== undefined) {
        out += renderMarkdownSegment(match[2], b, i, true);
      } else if (match[3] !== undefined) {
        out += renderMarkdownSegment(match[3], b, true, u);
      }
      lastIdx = match.index + match[0].length;
    }
    if (lastIdx < seg.length) {
      const rest = seg.slice(lastIdx);
      out += `<w:r><w:rPr>${buildRPr(b, i, u)}</w:rPr><w:t xml:space="preserve">${escXml(rest)}</w:t></w:r>`;
    }
    return out;
  };

  // Mascara matemática $...$ / $$...$$ primeiro (sem _ nem *) para suportar $...$ dentro de **negrito**
  const mathTokens = [];
  const masked = String(text || '').replace(/\$\$([\s\S]+?)\$\$|\$([^$\n]+)\$/g, (_full, disp, inl) => {
    const id = `@@MATH${mathTokens.length}@@`;
    mathTokens.push({ expr: disp !== undefined ? disp : inl, isDisplay: disp !== undefined });
    return id;
  });

  const expandMathTokens = (plainChunk, b, i, u) => {
    if (!plainChunk) return '';
    const subParts = plainChunk.split(/(@@MATH\d+@@)/g);
    return subParts
      .map((sp) => {
        if (!sp) return '';
        const tm = sp.match(/^@@MATH(\d+)@@$/);
        if (tm) {
          const item = mathTokens[Number(tm[1])];
          if (!item) return '';
          return converterMathParaRunsXml(item.expr, buildRPr(item.isDisplay ? true : b, item.isDisplay ? false : true, u));
        }
        return `<w:r><w:rPr>${buildRPr(b, i, u)}</w:rPr><w:t xml:space="preserve">${escXml(sp)}</w:t></w:r>`;
      })
      .join('');
  };

  const renderMarkdownWithMath = (seg, b, i, u) => {
    if (!seg) return '';
    const mdRe = /\*\*([\s\S]+?)\*\*|__([^\s_](?:[\s\S]*?[^\s_])?)__|\*([^\s*](?:[^*\n]*?[^\s*])?)\*/g;
    let out = '';
    let lastIdx = 0;
    let match;
    while ((match = mdRe.exec(seg)) !== null) {
      if (match.index > lastIdx) {
        out += expandMathTokens(seg.slice(lastIdx, match.index), b, i, u);
      }
      if (match[1] !== undefined) {
        out += renderMarkdownWithMath(match[1], true, i, u);
      } else if (match[2] !== undefined) {
        out += renderMarkdownWithMath(match[2], b, i, true);
      } else if (match[3] !== undefined) {
        out += renderMarkdownWithMath(match[3], b, true, u);
      }
      lastIdx = match.index + match[0].length;
    }
    if (lastIdx < seg.length) {
      out += expandMathTokens(seg.slice(lastIdx), b, i, u);
    }
    return out;
  };

  return renderMarkdownWithMath(masked, bold, italic, underline);
}

function paragrafoTextoMultilinhaXml(text = '', opts = {}) {
  const {
    jc = 'both',
    afterTwips = 80,
    beforeTwips = 0,
    lineTwips = 259,
    leftIndTwips = 0,
    keepNext = false,
    ...runOpts
  } = opts;

  const linhas = String(text || '').split(/\r?\n/);
  return linhas
    .map((linha, idx) => {
      const isLast = idx === linhas.length - 1;
      const pPr = [
        `<w:spacing w:before="${idx === 0 ? beforeTwips : 0}" w:after="${isLast ? afterTwips : 40}" w:line="${lineTwips}" w:lineRule="auto"/>`,
        leftIndTwips ? `<w:ind w:left="${leftIndTwips}"/>` : '',
        `<w:jc w:val="${jc}"/>`,
        keepNext ? '<w:keepNext/>' : '',
      ].filter(Boolean).join('');
      return `<w:p><w:pPr>${pPr}</w:pPr>${textoRicoParaRunsXml(linha, runOpts)}</w:p>`;
    })
    .join('');
}

/* ── Download e normalização de imagens das questões para JPEG com dimensões EMU ─ */
async function baixarImagemParaDocx(imgSource, maxWidthMm = 78, preset = 'M') {
  if (!imgSource || typeof imgSource !== 'string') return null;
  const src = imgSource.trim();
  let rawBuffer = null;

  try {
    if (/^https?:\/\//i.test(src)) {
      const resp = await fetch(src, { signal: AbortSignal.timeout(15000) });
      if (!resp.ok) return null;
      rawBuffer = Buffer.from(await resp.arrayBuffer());
    } else {
      const m = src.match(/^data:image\/([a-zA-Z0-9+]+);base64,(.+)$/);
      if (!m) return null;
      rawBuffer = Buffer.from(m[2], 'base64');
    }

    const { data: jpgBuf, info } = await sharp(rawBuffer)
      .rotate()
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 90 })
      .toBuffer({ resolveWithObject: true });

    const presetRatio = { P: 0.45, M: 0.72, G: 0.90, '100%': 0.98 }[preset] || 0.72;
    const targetWidthMm = Math.max(24, maxWidthMm * presetRatio);
    const aspect = (info.height || 100) / Math.max(1, info.width || 100);
    let targetHeightMm = targetWidthMm * aspect;
    const maxHeightMm = 68;
    let finalWidthMm = targetWidthMm;
    if (targetHeightMm > maxHeightMm) {
      const scale = maxHeightMm / targetHeightMm;
      targetHeightMm = maxHeightMm;
      finalWidthMm = targetWidthMm * scale;
    }

    // 1 mm = 36000 EMUs
    const cx = Math.round(finalWidthMm * 36000);
    const cy = Math.round(targetHeightMm * 36000);
    return { buffer: jpgBuf, cx, cy };
  } catch (err) {
    console.warn('[provaDocx] Aviso ao processar imagem:', err.message);
    return null;
  }
}

function renderImagemInlineXml(rId, docPrId, cx, cy, align = 'center', legenda = '') {
  const jcMap = { left: 'left', center: 'center', right: 'right' };
  const jc = jcMap[align] || 'center';
  const imgP = `<w:p>
    <w:pPr><w:spacing w:before="60" w:after="${legenda ? 20 : 80}"/><w:jc w:val="${jc}"/><w:keepNext/></w:pPr>
    <w:r>
      <w:rPr><w:noProof/></w:rPr>
      <w:drawing>
        <wp:inline distT="0" distB="0" distL="0" distR="0">
          <wp:extent cx="${cx}" cy="${cy}"/>
          <wp:effectExtent l="0" t="0" r="0" b="0"/>
          <wp:docPr id="${docPrId}" name="Figura ${docPrId}"/>
          <wp:cNvGraphicFramePr>
            <a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/>
          </wp:cNvGraphicFramePr>
          <a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
            <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
              <pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
                <pic:nvPicPr>
                  <pic:cNvPr id="0" name="Img${docPrId}"/>
                  <pic:cNvPicPr><a:picLocks noChangeAspect="1" noChangeArrowheads="1"/></pic:cNvPicPr>
                </pic:nvPicPr>
                <pic:blipFill>
                  <a:blip r:embed="${rId}"/>
                  <a:stretch><a:fillRect/></a:stretch>
                </pic:blipFill>
                <pic:spPr bwMode="auto">
                  <a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>
                  <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
                  <a:noFill/>
                </pic:spPr>
              </pic:pic>
            </a:graphicData>
          </a:graphic>
        </wp:inline>
      </w:drawing>
    </w:r>
  </w:p>`;

  const legP = legenda
    ? paragrafoTextoMultilinhaXml(legenda, { jc, fontHalfPt: 17, italic: true, color: '444444', afterTwips: 80, lineTwips: 220 })
    : '';

  return imgP + legP;
}

function gerarRodapePadraoTexto(prova, cfg = {}) {
  const custom = String(cfg.rodape_texto || '').trim();
  if (custom) return custom;
  const partes = [
    String(prova.titulo || prova.disciplina || 'AVALIAÇÃO').trim().toUpperCase(),
    prova.turma ? String(prova.turma).trim().toUpperCase() : '',
    prova.bimestre ? `${prova.bimestre}º BIMESTRE` : '',
  ].filter(Boolean);
  return partes.join(' - ');
}

function resumirGabaritoItem(item) {
  const est = parseJsonSafe(item.estrutura_json, {}) || {};
  const tipo = item.tipo || est.modelo || 'objetiva';
  const alts = parseJsonSafe(item.alternativas_json, []) || [];
  const altCorreta = (Array.isArray(alts) ? alts : []).find((a) => a.correta)?.letra || item.correta;

  if (tipo === 'verdadeiro_falso' && (est.submodo || 'direto') === 'direto') {
    return (est.itens || []).map((i) => i.gabarito || 'V').join(' - ') || altCorreta || '—';
  }
  if (tipo === 'associacao' && (est.submodo || 'direto') === 'direto') {
    return (est.coluna_b || []).map((b) => b.vinculo_codigo || '—').join(' - ') || altCorreta || '—';
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
  if (tipo === 'discursiva') return 'Discursiva';
  return altCorreta || '—';
}

/**
 * Monta o Buffer binário completo de um arquivo .docx válido (Word 2010–365 / Google Docs / LibreOffice)
 * clonando a estrutura do modelo "9º ANO-EXATAS.docx".
 */
export async function buildProvaDocxBuffer(prova, itens, opcoes = {}) {
  const { showGabarito = false, escolaNome = 'EDUCA.MELHOR' } = opcoes;
  const cfg = parseJsonSafe(prova.config_json, {}) || {};
  const template = resolveProvaTemplate(prova);
  const isModelo01 = template === 'modelo_01_provao';
  const is2Col = template !== 'objetiva_1col' && template !== 'discursiva' && template !== 'mista';

  const hexColorClean = String(cfg.cor_destaque || '#FF7F00').replace(/[^0-9A-Fa-f]/g, '').toUpperCase().slice(0, 6) || 'FF7F00';
  const densidade = cfg.densidade_fonte || '11pt';
  const fontHalfPt = densidade === '10pt' ? 20 : densidade === '12pt' ? 24 : 22;
  const headerHalfPt = densidade === '10pt' ? 22 : 24;
  const estiloAlt = isModelo01 ? (cfg.estilo_alternativa || 'minuscula_parentese') : (cfg.estilo_alternativa || 'maiuscula_parenteses');
  const mostrarDivisoresDisc = isModelo01 ? (cfg.mostrar_divisores_disciplina ?? true) : Boolean(cfg.mostrar_divisores_disciplina);
  const fechamentoCaderno = cfg.fechamento_caderno || 'nenhum'; // 'nenhum' | 'rascunho' | 'boa_prova'
  const rodapeFinalTexto = gerarRodapePadraoTexto(prova, cfg);

  // Baixa e processa todas as imagens em paralelo
  const mediaFiles = []; // { filename, buffer }
  const relEntries = [
    { id: 'rIdStyles', type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles', target: 'styles.xml' },
    { id: 'rIdFooter1', type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer', target: 'footer1.xml' },
  ];
  let nextMediaIdx = 1;
  let nextDocPrId = 10;

  const registrarImagem = async (src, maxW, preset) => {
    const imgData = await baixarImagemParaDocx(src, maxW, preset);
    if (!imgData) return null;
    const idx = nextMediaIdx++;
    const filename = `image${idx}.jpg`;
    const rId = `rIdImg${idx}`;
    mediaFiles.push({ filename, buffer: imgData.buffer });
    relEntries.push({
      id: rId,
      type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image',
      target: `media/${filename}`,
    });
    return { rId, cx: imgData.cx, cy: imgData.cy, docPrId: nextDocPrId++ };
  };

  const maxImgW = is2Col ? 78 : 155;
  const itemMediaMap = await Promise.all(
    itens.map(async (it) => {
      const midia = parseJsonSafe(it.midia_json, null);
      const mainSrc = midia?.url || it.imagem_url || it.imagem_base64;
      const mainImg = mainSrc ? await registrarImagem(mainSrc, maxImgW, midia?.preset || 'M') : null;
      const altsArr = parseJsonSafe(it.alternativas_json, []) || [];
      const altImgs = {};
      for (const a of (Array.isArray(altsArr) ? altsArr : [])) {
        if (a?.imagem_url && a?.letra) {
          const regAlt = await registrarImagem(a.imagem_url, is2Col ? 42 : 70, 'P');
          if (regAlt) altImgs[a.letra] = regAlt;
        }
      }
      return { mainImg, altImgs, midia };
    })
  );

  // Monta o corpo XML das questões
  let bodyParts = [];
  let ultimaDisciplina = '';

  // Se for Modelo 02..06 com cabeçalho institucional ativo, renderiza bloco de cabeçalho em largura total antes das colunas
  if (!isModelo01 && (cfg.com_cabecalho ?? true)) {
    const tituloUp = String(prova.titulo || 'AVALIAÇÃO').toUpperCase();
    const escUp = String(escolaNome || 'EDUCA.MELHOR').toUpperCase();
    const infoLinha = [
      prova.disciplina ? `Disciplina: ${prova.disciplina}` : '',
      prova.turma ? `Turma: ${prova.turma}` : '',
      prova.bimestre ? `${prova.bimestre}º Bimestre` : '',
      'Data: ___/___/______',
      'Nota: _________',
    ].filter(Boolean).join('   |   ');

    bodyParts.push(`<w:tbl>
      <w:tblPr>
        <w:tblW w:w="5000" w:type="pct"/>
        <w:tblBorders>
          <w:top w:val="single" w:sz="12" w:space="0" w:color="000000"/>
          <w:left w:val="single" w:sz="12" w:space="0" w:color="000000"/>
          <w:bottom w:val="single" w:sz="12" w:space="0" w:color="000000"/>
          <w:right w:val="single" w:sz="12" w:space="0" w:color="000000"/>
          <w:insideH w:val="single" w:sz="6" w:space="0" w:color="666666"/>
        </w:tblBorders>
        <w:tblCellMar><w:top w:w="70" w:type="dxa"/><w:left w:w="120" w:type="dxa"/><w:bottom w:w="70" w:type="dxa"/><w:right w:w="120" w:type="dxa"/></w:tblCellMar>
      </w:tblPr>
      <w:tr><w:tc><w:p><w:pPr><w:jc w:val="center"/><w:spacing w:after="20"/></w:pPr>${textoRicoParaRunsXml(escUp, { fontHalfPt: 24, bold: true })}</w:p><w:p><w:pPr><w:jc w:val="center"/><w:spacing w:after="20"/></w:pPr>${textoRicoParaRunsXml(tituloUp, { fontHalfPt: 24, bold: true })}</w:p></w:tc></w:tr>
      <w:tr><w:tc><w:p><w:pPr><w:spacing w:after="20"/></w:pPr>${textoRicoParaRunsXml('Nome: ______________________________________________________________________________', { fontHalfPt: 20, bold: true })}</w:p></w:tc></w:tr>
      <w:tr><w:tc><w:p><w:pPr><w:spacing w:after="20"/></w:pPr>${textoRicoParaRunsXml(infoLinha, { fontHalfPt: 19 })}</w:p></w:tc></w:tr>
    </w:tbl>`);

    if (is2Col) {
      bodyParts.push(`<w:p>
        <w:pPr>
          <w:spacing w:before="80" w:after="80"/>
          <w:sectPr>
            <w:footerReference w:type="default" r:id="rIdFooter1"/>
            <w:type w:val="continuous"/>
            <w:pgSz w:w="11906" w:h="16838"/>
            <w:pgMar w:top="482" w:right="539" w:bottom="794" w:left="539" w:header="0" w:footer="198" w:gutter="0"/>
            <w:pgBorders w:offsetFrom="page">
              <w:top w:val="single" w:sz="18" w:space="16" w:color="000000"/>
              <w:left w:val="single" w:sz="18" w:space="17" w:color="000000"/>
              <w:bottom w:val="single" w:sz="18" w:space="29" w:color="000000"/>
              <w:right w:val="single" w:sz="18" w:space="17" w:color="000000"/>
            </w:pgBorders>
            <w:cols w:num="1" w:space="431"/>
          </w:sectPr>
        </w:pPr>
      </w:p>`);
    } else {
      bodyParts.push('<w:p><w:pPr><w:spacing w:after="100"/></w:pPr></w:p>');
    }
  }

  for (let idx = 0; idx < itens.length; idx++) {
    const it = itens[idx];
    const num = String(idx + 1).padStart(2, '0');
    const est = parseJsonSafe(it.estrutura_json, {}) || {};
    const tipo = it.tipo || est.modelo || (template === 'discursiva' ? 'discursiva' : 'objetiva');
    const alts = parseJsonSafe(it.alternativas_json, []) || [];
    const mediaInfo = itemMediaMap[idx] || {};
    const midia = mediaInfo.midia;

    // Divisor automático de disciplina (ex.: CIÊNCIAS / MATEMÁTICA centralizado, negrito e sublinhado)
    const discAtual = String(it.disciplina || '').trim().toUpperCase();
    if (mostrarDivisoresDisc && discAtual && discAtual !== ultimaDisciplina) {
      ultimaDisciplina = discAtual;
      bodyParts.push(
        `<w:p>
          <w:pPr>
            <w:spacing w:before="${idx === 0 ? 0 : 160}" w:after="120" w:line="240" w:lineRule="auto"/>
            <w:jc w:val="center"/>
            <w:keepNext/>
          </w:pPr>
          ${textoRicoParaRunsXml(discAtual, { fontHalfPt: headerHalfPt, bold: true, underline: true })}
        </w:p>`
      );
    }

    // Cabeçalho clonado: QUESTÃO XX + Retângulo sólido laranja (#FF7F00 ou cor da escola) alinhado à direita da coluna
    const rectWidthPt = is2Col ? '175pt' : '395pt';
    const shapeId = `_x0000_s${1026 + idx}`;
    const headerQuestaoXml = `<w:p>
      <w:pPr>
        <w:spacing w:before="${idx === 0 && !ultimaDisciplina ? 0 : 140}" w:after="60" w:line="240" w:lineRule="auto"/>
        <w:jc w:val="left"/>
        <w:keepNext/>
      </w:pPr>
      <w:r>
        <w:rPr><w:noProof/></w:rPr>
        <w:pict>
          <v:shape id="${shapeId}" style="position:absolute;margin-left:0;margin-top:0.8pt;width:${rectWidthPt};height:12.5pt;z-index:${251744256 + idx};visibility:visible;mso-wrap-style:square;mso-position-horizontal:right;mso-position-horizontal-relative:text;mso-position-vertical:absolute;mso-position-vertical-relative:text" coordsize="21600,21600" path="m21600,l,,,21600r21600,l21600,xe" fillcolor="#${hexColorClean}" stroked="f" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
            <v:path arrowok="t"/>
          </v:shape>
        </w:pict>
      </w:r>
      ${textoRicoParaRunsXml(`QUESTÃO ${num} `, { fontHalfPt: headerHalfPt, bold: true })}
    </w:p>`;
    bodyParts.push(headerQuestaoXml);

    // Texto de apoio (se existir)
    if (it.texto_apoio && String(it.texto_apoio).trim()) {
      bodyParts.push(
        paragrafoTextoMultilinhaXml(it.texto_apoio, {
          jc: 'both',
          fontHalfPt: Math.max(18, fontHalfPt - 2),
          italic: true,
          leftIndTwips: 180,
          afterTwips: it.fonte ? 20 : 80,
        })
      );
      if (it.fonte) {
        bodyParts.push(
          paragrafoTextoMultilinhaXml(`(${it.fonte})`, {
            jc: 'right',
            fontHalfPt: Math.max(16, fontHalfPt - 4),
            color: '333333',
            afterTwips: 80,
          })
        );
      }
    }

    const posFig = ['apos_texto_apoio', 'entre_enunciado_e_comando', 'abaixo_comando'].includes(midia?.posicao)
      ? midia.posicao
      : 'entre_enunciado_e_comando';
    const legLimpa = String(midia?.legenda || '').trim();
    const credBruto = String(midia?.credito || '').trim();
    const credEhRodape = /^(?:humanas|linguagens|matem[aá]tica|ci[êe]ncias|exatas)[\s\-–—_/0-9º°ªa-z]*$/i.test(credBruto);
    const credUtil = credBruto && !credEhRodape && !legLimpa.toLowerCase().includes(credBruto.toLowerCase())
      ? `Fonte: ${credBruto}`
      : '';
    const legendaFig = [legLimpa, credUtil].filter(Boolean).join(' — ');

    const blocoFiguraXml = mediaInfo.mainImg
      ? renderImagemInlineXml(
          mediaInfo.mainImg.rId,
          mediaInfo.mainImg.docPrId,
          mediaInfo.mainImg.cx,
          mediaInfo.mainImg.cy,
          midia?.alinhamento || 'center',
          legendaFig
        )
      : '';

    if (posFig === 'apos_texto_apoio' && blocoFiguraXml) bodyParts.push(blocoFiguraXml);

    // Enunciado principal
    let enunciadoTxt = String(it.conteudo_bruto || '');
    if (tipo === 'lacuna') {
      enunciadoTxt = enunciadoTxt.replace(/\{\{([^}]+)\}\}/g, (_, r) =>
        showGabarito ? `**${r}**` : '_'.repeat(Math.max(8, String(r).length + 4))
      );
    }
    if (enunciadoTxt.trim()) {
      bodyParts.push(paragrafoTextoMultilinhaXml(enunciadoTxt, { jc: 'both', fontHalfPt, afterTwips: 80 }));
    }

    if (posFig === 'entre_enunciado_e_comando' && blocoFiguraXml) bodyParts.push(blocoFiguraXml);

    const comandoPosCorpo = (tipo === 'associacao' || tipo === 'verdadeiro_falso') && (est.submodo || 'direto') === 'sequencia';
    if (it.comando_final && !comandoPosCorpo) {
      bodyParts.push(paragrafoTextoMultilinhaXml(it.comando_final, { jc: 'both', fontHalfPt, bold: false, afterTwips: 80 }));
    }

    if (posFig === 'abaixo_comando' && blocoFiguraXml) bodyParts.push(blocoFiguraXml);

    // Helper de alternativas no padrão do DOCX ("a) ..." ou "(A) ...")
    const renderAlternativasDocx = () => {
      const lista = Array.isArray(alts) ? alts.filter((a) => String(a?.texto || '').trim() || a?.imagem_url) : [];
      const corrLetra = resumirGabaritoItem(it);
      for (let aIdx = 0; aIdx < lista.length; aIdx++) {
        const a = lista[aIdx];
        const letraUp = String(a.letra || String.fromCharCode(65 + aIdx)).toUpperCase().trim();
        const rotulo = estiloAlt === 'maiuscula_parenteses'
          ? `(${letraUp}) `
          : `${letraUp.toLowerCase()}) `;
        const isCorr = showGabarito && (a.correta || letraUp === corrLetra);
        const prefixRun = textoRicoParaRunsXml(rotulo, { fontHalfPt, bold: isCorr });
        const bodyRun = textoRicoParaRunsXml(a.texto || '', { fontHalfPt, bold: isCorr });
        const checkRun = isCorr ? textoRicoParaRunsXml('  [CORRETA]', { fontHalfPt: fontHalfPt - 2, bold: true, color: '166534' }) : '';

        bodyParts.push(
          `<w:p>
            <w:pPr><w:spacing w:before="0" w:after="${aIdx === lista.length - 1 ? 100 : 50}" w:line="240" w:lineRule="auto"/><w:jc w:val="both"/></w:pPr>
            ${prefixRun}${bodyRun}${checkRun}
          </w:p>`
        );

        const aImg = mediaInfo.altImgs?.[a.letra];
        if (aImg) {
          bodyParts.push(renderImagemInlineXml(aImg.rId, aImg.docPrId, aImg.cx, aImg.cy, 'left', ''));
        }
      }
    };

    if (tipo === 'afirmativas') {
      const props = Array.isArray(est.proposicoes) ? est.proposicoes : [];
      props.forEach((p, pIdx) => {
        const rom = p.romano || ['I', 'II', 'III', 'IV', 'V'][pIdx] || String(pIdx + 1);
        bodyParts.push(
          paragrafoTextoMultilinhaXml(`**${rom}.** ${p.texto || ''}`, { jc: 'both', fontHalfPt, afterTwips: 50 })
        );
      });
      if (est.comando_fechamento) {
        bodyParts.push(paragrafoTextoMultilinhaXml(est.comando_fechamento, { jc: 'both', fontHalfPt, afterTwips: 60 }));
      }
      renderAlternativasDocx();
    } else if (tipo === 'verdadeiro_falso') {
      const itensVf = Array.isArray(est.itens) ? est.itens : [];
      const submodo = est.submodo || 'direto';
      itensVf.forEach((vf) => {
        const gab = showGabarito && submodo === 'direto' ? vf.gabarito || 'V' : '   ';
        bodyParts.push(
          paragrafoTextoMultilinhaXml(`(${gab}) ${vf.texto || ''}`, { jc: 'both', fontHalfPt, afterTwips: 50 })
        );
      });
      if (submodo === 'sequencia') {
        if (it.comando_final) {
          bodyParts.push(paragrafoTextoMultilinhaXml(it.comando_final, { jc: 'both', fontHalfPt, afterTwips: 60 }));
        }
        renderAlternativasDocx();
      }
    } else if (tipo === 'associacao') {
      const colA = Array.isArray(est.coluna_a) ? est.coluna_a : [];
      const colB = Array.isArray(est.coluna_b) ? est.coluna_b : [];
      const submodo = est.submodo || 'direto';
      colA.forEach((ca, cIdx) => {
        bodyParts.push(
          paragrafoTextoMultilinhaXml(`**(${ca.codigo || cIdx + 1})** ${ca.texto || ''}`, { jc: 'both', fontHalfPt, afterTwips: 35 })
        );
      });
      colB.forEach((cb) => {
        const gab = showGabarito && submodo === 'direto' ? cb.vinculo_codigo || ' ' : '   ';
        bodyParts.push(
          paragrafoTextoMultilinhaXml(`(${gab}) ${cb.texto || ''}`, { jc: 'both', fontHalfPt, afterTwips: 45 })
        );
      });
      if (submodo === 'sequencia') {
        if (it.comando_final) {
          bodyParts.push(paragrafoTextoMultilinhaXml(it.comando_final, { jc: 'both', fontHalfPt, afterTwips: 60 }));
        }
        renderAlternativasDocx();
      }
    } else if (tipo === 'lacuna') {
      if ((est.submodo || 'direto') === 'banco_palavras') {
        const palavras = [...(est.lacunas || []), ...(est.distratores_banco || [])].filter(Boolean);
        if (palavras.length) {
          bodyParts.push(
            paragrafoTextoMultilinhaXml(`**Banco de palavras:** ${palavras.join(' · ')}`, { jc: 'both', fontHalfPt: fontHalfPt - 2, afterTwips: 80 })
          );
        }
      } else if (est.submodo === 'alternativas') {
        renderAlternativasDocx();
      }
    } else if (tipo === 'somatoria') {
      const props = Array.isArray(est.proposicoes) ? est.proposicoes : [];
      props.forEach((p) => {
        const cod = p.codigo || String(p.valor || '').padStart(2, '0');
        bodyParts.push(
          paragrafoTextoMultilinhaXml(`**(${cod})** ${p.texto || ''}`, { jc: 'both', fontHalfPt, afterTwips: 45 })
        );
      });
      const somaVal = showGabarito ? String(est.soma_correta ?? 0).padStart(2, '0') : '______';
      bodyParts.push(paragrafoTextoMultilinhaXml(`**SOMA: [ ${somaVal} ]**`, { jc: 'right', fontHalfPt, afterTwips: 100 }));
    } else if (tipo === 'discursiva') {
      const nLinhas = Math.max(2, Math.min(15, Number(est.linhas_resposta) || 5));
      for (let l = 0; l < nLinhas; l++) {
        bodyParts.push(
          `<w:p><w:pPr><w:pBdr><w:bottom w:val="dotted" w:sz="6" w:space="1" w:color="888888"/></w:pBdr><w:spacing w:before="80" w:after="60"/></w:pPr></w:p>`
        );
      }
      if (showGabarito && it.resposta_aberta) {
        bodyParts.push(
          paragrafoTextoMultilinhaXml(`**Espelho:** ${it.resposta_aberta}`, { jc: 'both', fontHalfPt: fontHalfPt - 2, color: '166534', afterTwips: 100 })
        );
      }
    } else {
      renderAlternativasDocx();
    }
  }

  // Fechamento opcional: RASCUNHO (clonado de P[387] do 9º ANO-EXATAS.docx) ou BOA PROVA!
  if (fechamentoCaderno === 'rascunho') {
    bodyParts.push(
      `<w:p>
        <w:pPr><w:spacing w:before="240" w:after="120"/><w:jc w:val="center"/></w:pPr>
        ${textoRicoParaRunsXml('RASCUNHO', { fontHalfPt: headerHalfPt, bold: true, underline: true })}
      </w:p>`
    );
    for (let r = 0; r < 8; r++) {
      bodyParts.push('<w:p><w:pPr><w:spacing w:before="60" w:after="60"/></w:pPr></w:p>');
    }
  } else if (fechamentoCaderno === 'boa_prova') {
    bodyParts.push(
      `<w:p>
        <w:pPr><w:spacing w:before="240" w:after="120"/><w:jc w:val="center"/></w:pPr>
        ${textoRicoParaRunsXml('BOA PROVA!', { fontHalfPt: headerHalfPt, bold: true })}
      </w:p>`
    );
  }

  // Página separada de Gabarito se solicitado (?gabarito=1)
  if (showGabarito) {
    bodyParts.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>');
    bodyParts.push(
      `<w:p>
        <w:pPr><w:spacing w:before="0" w:after="160"/><w:jc w:val="center"/></w:pPr>
        ${textoRicoParaRunsXml(`GABARITO OFICIAL — ${prova.titulo || 'AVALIAÇÃO'}`, { fontHalfPt: 26, bold: true, underline: true })}
      </w:p>`
    );
    itens.forEach((it, idx) => {
      const num = String(idx + 1).padStart(2, '0');
      const gab = resumirGabaritoItem(it);
      bodyParts.push(
        paragrafoTextoMultilinhaXml(`**Questão ${num}:** ${gab}  *(${it.disciplina || 'Geral'} · ${Number(it.valor_pontos || 1).toFixed(1)} pt)*`, {
          jc: 'left',
          fontHalfPt: 22,
          afterTwips: 50,
        })
      );
    });
  }

  // Propriedades da Seção A4 (margens enxutas 5.5–6 mm para otimização de espaço):
  // - Moldura preta 2.25pt (sz="18") a ~5.6mm topo (16pt), ~6mm laterais (17pt) e ~10.2mm base (29pt)
  // - Margens internas enxutas (top 482 = 8.5mm, left/right 539 = 9.5mm, bottom 794 = 14mm) e rodapé externo a 198 twips (~3.5mm)
  const colsXml = is2Col
    ? '<w:cols w:num="2" w:sep="1" w:space="431"/>'
    : '<w:cols w:num="1" w:space="431"/>';

  const sectPrXml = `<w:sectPr>
    <w:footerReference w:type="default" r:id="rIdFooter1"/>
    <w:pgSz w:w="11906" w:h="16838"/>
    <w:pgMar w:top="482" w:right="539" w:bottom="794" w:left="539" w:header="0" w:footer="198" w:gutter="0"/>
    <w:pgBorders w:offsetFrom="page">
      <w:top w:val="single" w:sz="18" w:space="16" w:color="000000"/>
      <w:left w:val="single" w:sz="18" w:space="17" w:color="000000"/>
      <w:bottom w:val="single" w:sz="18" w:space="29" w:color="000000"/>
      <w:right w:val="single" w:sz="18" w:space="17" w:color="000000"/>
    </w:pgBorders>
    ${colsXml}
    <w:docGrid w:linePitch="360"/>
  </w:sectPr>`;

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
            xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
            xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
            xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
            xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"
            xmlns:v="urn:schemas-microsoft-com:vml"
            xmlns:o="urn:schemas-microsoft-com:office:office">
  <w:body>
    ${bodyParts.join('\n')}
    ${sectPrXml}
  </w:body>
</w:document>`;

  const footer1Xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:p>
    <w:pPr><w:jc w:val="center"/><w:spacing w:before="0" w:after="0" w:line="220" w:lineRule="auto"/></w:pPr>
    ${textoRicoParaRunsXml(rodapeFinalTexto, { fontHalfPt: 22, bold: false })}
  </w:p>
</w:ftr>`;

  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults>
    <w:rPrDefault>
      <w:rPr>
        <w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="Times New Roman" w:cs="Times New Roman"/>
        <w:sz w:val="${fontHalfPt}"/>
        <w:szCs w:val="${fontHalfPt}"/>
        <w:lang w:val="pt-BR" w:eastAsia="pt-BR"/>
      </w:rPr>
    </w:rPrDefault>
    <w:pPrDefault>
      <w:pPr><w:spacing w:after="60" w:line="240" w:lineRule="auto"/></w:pPr>
    </w:pPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal">
    <w:name w:val="Normal"/>
    <w:qFormat/>
  </w:style>
</w:styles>`;

  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="jpg" ContentType="image/jpeg"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>
</Types>`;

  const rootRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

  const docRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${relEntries.map((r) => `<Relationship Id="${r.id}" Type="${r.type}" Target="${r.target}"/>`).join('\n  ')}
</Relationships>`;

  const zipEntries = [
    { name: '[Content_Types].xml', data: contentTypesXml },
    { name: '_rels/.rels', data: rootRelsXml },
    { name: 'word/document.xml', data: documentXml },
    { name: 'word/styles.xml', data: stylesXml },
    { name: 'word/footer1.xml', data: footer1Xml },
    { name: 'word/_rels/document.xml.rels', data: docRelsXml },
    ...mediaFiles.map((m) => ({ name: `word/media/${m.filename}`, data: m.buffer })),
  ];

  return buildZipArchive(zipEntries);
}

/* ── GET /api/provas/:id/docx ──────────────────────────────────────────────── */
export async function gerarDocx(req, res) {
  const { id } = req.params;
  const { escola_id } = req.user || {};
  const showGab = req.query.gabarito === '1';

  try {
    await ensureProvasSchema();
    const [[prova]] = await pool.query(
      `SELECT * FROM provas p WHERE p.id = ? AND ${escolaFilter(escola_id)}`,
      [id, ...escolaParam(escola_id)]
    );
    if (!prova) return res.status(404).json({ message: 'Prova não encontrada.' });

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

    const escolaNome = req.query.escola || 'EDUCA.MELHOR';
    const docxBuffer = await buildProvaDocxBuffer(prova, itens, { showGabarito: showGab, escolaNome });
    const slug = (prova.titulo || 'prova')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 45) || 'prova';

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${slug}.docx"`);
    res.setHeader('Content-Length', docxBuffer.length);
    res.send(docxBuffer);
  } catch (err) {
    console.error('[provaDocx] Erro ao gerar .docx:', err);
    res.status(500).json({ message: 'Erro ao gerar arquivo Word (.docx).', detail: err.message });
  }
}
