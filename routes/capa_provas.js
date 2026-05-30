// routes/capa_provas.js
import express from 'express';
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import crypto from 'crypto';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fetch from 'node-fetch';

const router = express.Router();

// ── Load themed images at startup ──────────────────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMA_IMAGES = {};
for (const area of ['EXATAS', 'HUMANAS', 'LINGUAGENS', 'NATUREZA', 'GERAL']) {
  try {
    TEMA_IMAGES[area] = readFileSync(
      join(__dirname, '../public/images/capas', `${area.toLowerCase()}.png`)
    );
    console.log(`[CAPA_PROVAS] Imagem ${area} carregada ✅`);
  } catch (e) {
    console.warn(`[CAPA_PROVAS] Imagem ${area} não encontrada:`, e.message);
    TEMA_IMAGES[area] = null;
  }
}

// ── Area definitions ────────────────────────────────────────────────────────
const AREAS = {
  EXATAS:     { label: 'EXATAS',     cor: '#1e40af', corClaro: '#dbeafe', disciplinas: 'Ciências · Matemática · Geometria' },
  HUMANAS:    { label: 'HUMANAS',    cor: '#c2410c', corClaro: '#ffedd5', disciplinas: 'História · Geografia' },
  LINGUAGENS: { label: 'LINGUAGENS', cor: '#7c3aed', corClaro: '#ede9fe', disciplinas: 'Português · Inglês · Artes · Ed. Física' },
  NATUREZA:   { label: 'NATUREZA',   cor: '#15803d', corClaro: '#dcfce7', disciplinas: 'Biologia · Ciências da Natureza' },
  GERAL:      { label: 'GERAL',      cor: '#374151', corClaro: '#f3f4f6', disciplinas: 'Multidisciplinar' },
};

const TEMPLATES = { 1: 'Clássico', 2: 'Moderno', 3: 'Formal', 4: 'Colorido', 5: 'Dark' };

// ── Default instructions per area ───────────────────────────────────────────
const INSTRUCOES_PADRAO = {
  EXATAS: `1. Este CADERNO DE QUESTÕES contém 25 questões dispostas da seguinte maneira:\na) questões de número 1 a 12, relativas à área de Ciências e suas Tecnologias;\nb) questões de número 13 a 22, relativas à área de Matemática e suas Tecnologias;\nc) questões de número 23 a 25, relativas à área de Geometria e suas Tecnologias.\n\n2. Confira se a quantidade e a ordem das questões estão de acordo. Caso o caderno esteja incompleto ou com defeito, comunique ao aplicador da sala.\n\n3. Para cada questão objetiva, são apresentadas 4 opções. Apenas uma responde corretamente à questão.\n\n4. O tempo disponível para estas provas é de 3h00. Reserve tempo suficiente para preencher o CARTÃO-RESPOSTA.\n\n5. Rascunhos e marcações no CADERNO DE QUESTÕES não serão considerados na avaliação.\n\n6. Proibido porte e uso de qualquer aparelho eletrônico ou digital (celular, fone, smartwatch, etc.)\n\n7. Você poderá deixar o local de prova somente após decorrido 1h00 de prova.`,
  HUMANAS: `1. Este CADERNO DE QUESTÕES contém 25 questões numeradas de 01 a 25 dispostas da seguinte maneira:\na) questões de número 01 a 12, relativas à área de História e suas Tecnologias;\nb) questões de número 13 a 25, relativas à área de Geografia e suas Tecnologias.\n\n2. Confira se a quantidade e a ordem das questões estão de acordo. Caso o caderno esteja incompleto ou com defeito, comunique ao aplicador da sala.\n\n3. Para cada questão objetiva, são apresentadas 4 opções. Apenas uma responde corretamente à questão.\n\n4. O tempo disponível para estas provas é de 3h00. Reserve tempo suficiente para preencher o CARTÃO-RESPOSTA.\n\n5. Rascunhos e marcações no CADERNO DE QUESTÕES não serão considerados na avaliação.\n\n6. Proibido porte e uso de qualquer aparelho eletrônico ou digital (celular, fone, smartwatch, etc.)\n\n7. Você poderá deixar o local de prova somente após decorrido 1h00 de prova.`,
  LINGUAGENS: `1. Este CADERNO DE QUESTÕES contém 25 questões numeradas de 01 a 25 dispostas da seguinte maneira:\na) questões de número 01 a 10, relativas à área de Língua Portuguesa;\nb) questões de número 11 a 15, relativas à área de Educação Artística;\nc) questões de número 16 a 20, relativas à área de Língua Inglesa;\nd) questões de número 21 a 25, relativas à área de Educação Física.\n\n2. Confira se a quantidade e a ordem das questões estão de acordo. Caso o caderno esteja incompleto ou com defeito, comunique ao aplicador da sala.\n\n3. Para cada questão objetiva, são apresentadas 4 opções. Apenas uma responde corretamente à questão.\n\n4. O tempo disponível para estas provas é de 3h00. Reserve tempo suficiente para preencher o CARTÃO-RESPOSTA.\n\n5. Rascunhos e marcações no CADERNO DE QUESTÕES não serão considerados na avaliação.\n\n6. Proibido porte e uso de qualquer aparelho eletrônico ou digital (celular, fone, smartwatch, etc.)\n\n7. Você poderá deixar o local de prova somente após decorrido 1h00 de prova.`,
  NATUREZA: `1. Este CADERNO DE QUESTÕES contém 25 questões objetivas de Ciências da Natureza e suas Tecnologias.\n\n2. Confira se a quantidade e a ordem das questões estão de acordo. Caso o caderno esteja incompleto ou com defeito, comunique ao aplicador da sala.\n\n3. Para cada questão objetiva, são apresentadas 4 opções. Apenas uma responde corretamente à questão.\n\n4. O tempo disponível para estas provas é de 3h00. Reserve tempo suficiente para preencher o CARTÃO-RESPOSTA.\n\n5. Rascunhos e marcações no CADERNO DE QUESTÕES não serão considerados na avaliação.\n\n6. Proibido porte e uso de qualquer aparelho eletrônico ou digital (celular, fone, smartwatch, etc.)\n\n7. Você poderá deixar o local de prova somente após decorrido 1h00 de prova.`,
  GERAL: `1. Este CADERNO DE QUESTÕES contém questões de diversas áreas do conhecimento.\n\n2. Confira se a quantidade e a ordem das questões estão de acordo. Caso o caderno esteja incompleto ou com defeito, comunique ao aplicador da sala.\n\n3. Para cada questão objetiva, são apresentadas 4 opções. Apenas uma responde corretamente à questão.\n\n4. O tempo disponível para estas provas é de 3h00. Reserve tempo suficiente para preencher o CARTÃO-RESPOSTA.\n\n5. Rascunhos e marcações no CADERNO DE QUESTÕES não serão considerados na avaliação.\n\n6. Proibido porte e uso de qualquer aparelho eletrônico ou digital (celular, fone, smartwatch, etc.)\n\n7. Você poderá deixar o local de prova somente após decorrido 1h00 de prova.`,
};

// ── Helpers ─────────────────────────────────────────────────────────────────
async function fetchImageBuffer(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const ab = await res.arrayBuffer();
    return Buffer.from(ab);
  } catch { return null; }
}

async function gerarQRBuffer(dados) {
  return QRCode.toBuffer(JSON.stringify(dados), {
    errorCorrectionLevel: 'M', type: 'png', width: 240, margin: 1,
    color: { dark: '#000000', light: '#ffffff' },
  });
}

function hexToRgb(hex) {
  const r = parseInt(hex.slice(1,3),16);
  const g = parseInt(hex.slice(3,5),16);
  const b = parseInt(hex.slice(5,7),16);
  return [r,g,b];
}

// A4 page constants
const A4W = 595.28;
const A4H = 841.89;
const MARGIN = 28;
const IMG_H = 140; // height of themed image strip at bottom

// ─────────────────────────────────────────────────────────────────────────────
// SHARED: Draw the institutional header (same structure as relatorio-disciplinar)
// escola: { nome, apelido, cidade, endereco }
// Logos: logoEsqBuf / logoDirBuf as image buffers (from escola_logos table)
// qrBuf: QR code buffer positioned top-right
// Returns: Y position after the header (including golden separator line)
// ─────────────────────────────────────────────────────────────────────────────
function drawHeader(doc, escola, logoEsqBuf, logoDirBuf, qrBuf, opts = {}) {
  const {
    bgColor = '#ffffff',   // header background
    textColor = '#1e3a5f', // institutional text color
    lineColor = '#b8860b', // golden separator
    lineColor2 = '#1e3a5f',// thin blue line below gold
    logoSize = 88,         // logo width & height
    startY = MARGIN + 4,
  } = opts;

  const headerH = logoSize + 18; // total header height

  // Header background
  doc.rect(0, 0, A4W, headerH + startY).fill(bgColor);

  // Logos — left
  if (logoEsqBuf) {
    doc.image(logoEsqBuf, MARGIN, startY + (logoSize > 60 ? 4 : 8), {
      fit: [logoSize, logoSize],
      align: 'center',
      valign: 'center',
    });
  }

  // QR code — top right
  const qrSize = 82;
  if (qrBuf) {
    doc.image(qrBuf, A4W - MARGIN - qrSize, startY + 4, { width: qrSize, height: qrSize });
  }

  // Logo right — placed left of QR
  if (logoDirBuf) {
    const rightLogoX = qrBuf
      ? A4W - MARGIN - qrSize - logoSize - 6
      : A4W - MARGIN - logoSize;
    doc.image(logoDirBuf, rightLogoX, startY + (logoSize > 60 ? 4 : 8), {
      fit: [logoSize, logoSize],
      align: 'center',
      valign: 'center',
    });
  }

  // Center text block
  const leftEdge  = MARGIN + (logoEsqBuf ? logoSize + 8 : 0);
  const rightEdge = A4W - MARGIN - (qrBuf ? qrSize + 8 : 0) - (logoDirBuf ? logoSize + 8 : 0);
  const textW     = rightEdge - leftEdge;
  const textX     = leftEdge;
  let textY       = startY + 6;

  // Line 1: Secretaria
  const secretaria = escola.secretaria || 'SECRETARIA DE ESTADO DE EDUCAÇÃO DO DISTRITO FEDERAL';
  doc.font('Helvetica-Bold').fontSize(8.5).fillColor(textColor)
     .text(secretaria, textX, textY, { width: textW, align: 'center', lineBreak: false });
  textY += 13;

  // Line 2: Coordenação Regional
  const cidade = escola.cidade ? escola.cidade.toUpperCase() : 'PLANALTINA';
  const coordenacao = escola.coordenacao || `COORDENAÇÃO REGIONAL DE ENSINO DE ${cidade}`;
  doc.font('Helvetica-Bold').fontSize(8).fillColor(textColor)
     .text(coordenacao, textX, textY, { width: textW, align: 'center', lineBreak: false });
  textY += 12;

  // Line 3: School name + apelido
  const apelido = escola.apelido ? ` — ${escola.apelido}` : '';
  const nomeCompleto = `${(escola.nome || 'ESCOLA').toUpperCase()}${apelido}`;
  doc.font('Helvetica-Bold').fontSize(8.5).fillColor(textColor)
     .text(nomeCompleto, textX, textY, { width: textW, align: 'center', lineBreak: false });
  textY += 12;

  // Line 4: Address (smaller, grey)
  if (escola.endereco) {
    doc.font('Helvetica').fontSize(7.5).fillColor('#555555')
       .text(escola.endereco, textX, textY, { width: textW, align: 'center', lineBreak: false });
  }

  // Golden separator line (thick + thin, like relatorio-disciplinar)
  const sepY = startY + logoSize + 6;
  doc.moveTo(MARGIN, sepY).lineTo(A4W - MARGIN, sepY).strokeColor(lineColor).lineWidth(2.5).stroke();
  const sepY2 = sepY + 4;
  doc.moveTo(MARGIN, sepY2).lineTo(A4W - MARGIN, sepY2).strokeColor(lineColor2).lineWidth(0.8).stroke();

  return sepY2 + 6; // Y after header
}

// ─────────────────────────────────────────────────────────────────────────────
// SHARED: Draw the themed image at bottom (centered, no crop)
// ─────────────────────────────────────────────────────────────────────────────
function drawBottomImage(doc, temaBuf, area, opts = {}) {
  if (!temaBuf) return;
  const {
    x = 0,
    w = A4W,
    imgH = IMG_H,
    overlayRgb = null,
    overlayOpacity = 0.18,
  } = opts;

  const imgY = A4H - imgH;

  // Use fit with center/center alignment to avoid cropping
  doc.image(temaBuf, x, imgY, {
    fit: [w, imgH],
    align: 'center',
    valign: 'center',
  });

  // Color tint overlay using fillColor with low opacity simulation
  // (PDFKit doesn't support rgba natively; we use a workaround with fillOpacity)
  if (overlayRgb) {
    const [r, g, b] = overlayRgb;
    doc.save();
    doc.fillOpacity(overlayOpacity);
    doc.rect(x, imgY, w, imgH).fill(`rgb(${r},${g},${b})`);
    doc.restore();
  }
}

// ── PDF Renderers ─────────────────────────────────────────────────────────────

async function renderClassico(doc, capa, escola, logoEsqBuf, logoDirBuf, qrBuf) {
  const area = AREAS[capa.area] || AREAS.GERAL;
  const [r,g,b] = hexToRgb(area.cor);
  const [rl,gl,bl] = hexToRgb(area.corClaro);
  const temaBuf = TEMA_IMAGES[capa.area] || null;

  // Background
  doc.rect(0, 0, A4W, A4H).fill(`rgb(${rl},${gl},${bl})`);
  // Outer border
  doc.rect(MARGIN, MARGIN, A4W-MARGIN*2, A4H-MARGIN*2).lineWidth(3).stroke(`rgb(${r},${g},${b})`);
  doc.rect(MARGIN+4, MARGIN+4, A4W-(MARGIN+4)*2, A4H-(MARGIN+4)*2).lineWidth(1).stroke(`rgb(${r},${g},${b})`);

  // Header
  const afterHeader = drawHeader(doc, escola, logoEsqBuf, logoDirBuf, qrBuf, {
    bgColor: `rgb(${rl},${gl},${bl})`,
    textColor: `rgb(${r},${g},${b})`,
    lineColor: `rgb(${r},${g},${b})`,
    lineColor2: '#888888',
    logoSize: 88,
    startY: MARGIN + 6,
  });

  // Title block
  const titleY = afterHeader + 8;
  doc.font('Helvetica-Bold').fontSize(22).fillColor(`rgb(${r},${g},${b})`)
     .text('PROVÃO DE', MARGIN+8, titleY, { width: A4W-MARGIN*2-16, align: 'center' });
  doc.font('Helvetica-Bold').fontSize(64).fillColor('#111111')
     .text(area.label, MARGIN+8, titleY + 26, { width: A4W-MARGIN*2-16, align: 'center' });
  const serieText = [capa.serie, `${capa.bimestre}º BIMESTRE`].filter(Boolean).join(' - ');
  doc.font('Helvetica-Bold').fontSize(24).fillColor(`rgb(${r},${g},${b})`)
     .text(serieText, MARGIN+8, titleY + 100, { width: A4W-MARGIN*2-16, align: 'center' });

  // Instructions box
  const instrY = titleY + 136;
  const instrBottom = A4H - IMG_H - 12;
  const instrH = instrBottom - instrY;
  doc.rect(MARGIN+8, instrY, A4W-MARGIN*2-16, instrH).fill(`rgb(${rl},${gl},${bl})`);
  doc.rect(MARGIN+8, instrY, A4W-MARGIN*2-16, instrH).lineWidth(1).stroke(`rgb(${r},${g},${b})`);
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#000000')
     .text('LEIA ATENTAMENTE AS INSTRUÇÕES SEGUINTES:', MARGIN+16, instrY+8, { width: A4W-MARGIN*2-32, align: 'center' });
  const instrText = capa.instrucoes || INSTRUCOES_PADRAO[capa.area] || '';
  doc.font('Helvetica').fontSize(8.8).fillColor('#111111')
     .text(instrText, MARGIN+16, instrY+24, { width: A4W-MARGIN*2-32, lineGap:1.5, paragraphGap:3, height: instrH-32 });

  // Bottom image
  drawBottomImage(doc, temaBuf, capa.area, {
    x: MARGIN+8, w: A4W-MARGIN*2-16,
    overlayRgb: [r,g,b], overlayOpacity: 0.15,
  });

  // Footer text
  doc.font('Helvetica').fontSize(7).fillColor('#666666')
     .text(`EDUCA.MELHOR — ${capa.titulo} — ${capa.ano}`, MARGIN+8, A4H - MARGIN - 10, { width: A4W-MARGIN*2-16, align: 'center' });
}

async function renderModerno(doc, capa, escola, logoEsqBuf, logoDirBuf, qrBuf) {
  const area = AREAS[capa.area] || AREAS.GERAL;
  const [r,g,b] = hexToRgb(area.cor);
  const temaBuf = TEMA_IMAGES[capa.area] || null;
  const STRIPE = 62; // width of left color stripe

  // === 1. White full-page background FIRST ===
  doc.rect(0, 0, A4W, A4H).fill('#ffffff');

  // === 2. Left color stripe (drawn on top of white) ===
  doc.rect(0, 0, STRIPE, A4H).fill(`rgb(${r},${g},${b})`);

  // === 3. Top accent bar (right of stripe) ===
  doc.rect(STRIPE, 0, A4W - STRIPE, 8).fill(`rgb(${r},${g},${b})`);

  // === 4. Header logos on the stripe ===
  if (logoEsqBuf) {
    doc.image(logoEsqBuf, 4, 14, { fit: [STRIPE - 8, STRIPE - 8], align: 'center', valign: 'center' });
  }

  // QR code — top right
  const qrSize = 82;
  if (qrBuf) {
    doc.image(qrBuf, A4W - MARGIN - qrSize, 10, { width: qrSize, height: qrSize });
  }
  // Logo direita
  if (logoDirBuf) {
    const rightLogoX = qrBuf ? A4W - MARGIN - qrSize - 90 - 6 : A4W - MARGIN - 88;
    doc.image(logoDirBuf, rightLogoX, 12, { fit: [88, 88], align: 'center', valign: 'center' });
  }

  // Institutional text — 4 lines in the center column
  const hx = STRIPE + 10;
  const hw = A4W - hx - MARGIN - (qrBuf ? qrSize + 8 : 0) - (logoDirBuf ? 96 : 0);
  const COR_AZUL = `rgb(${r},${g},${b})`;
  let hty = 14;
  const secretaria = escola.secretaria || 'SECRETARIA DE ESTADO DE EDUCAÇÃO DO DISTRITO FEDERAL';
  doc.font('Helvetica-Bold').fontSize(8).fillColor(COR_AZUL)
     .text(secretaria, hx, hty, { width: hw, align: 'center', lineBreak: false });
  hty += 12;
  const cidade = escola.cidade ? escola.cidade.toUpperCase() : 'PLANALTINA';
  const coord = escola.coordenacao || `COORDENAÇÃO REGIONAL DE ENSINO DE ${cidade}`;
  doc.font('Helvetica-Bold').fontSize(7.5).fillColor(COR_AZUL)
     .text(coord, hx, hty, { width: hw, align: 'center', lineBreak: false });
  hty += 12;
  const apelido = escola.apelido ? ` — ${escola.apelido}` : '';
  doc.font('Helvetica-Bold').fontSize(8.5).fillColor(COR_AZUL)
     .text(`${(escola.nome || 'ESCOLA').toUpperCase()}${apelido}`, hx, hty, { width: hw, align: 'center', lineBreak: false });
  hty += 12;
  if (escola.endereco) {
    doc.font('Helvetica').fontSize(7).fillColor('#555555')
       .text(escola.endereco, hx, hty, { width: hw, align: 'center', lineBreak: false });
  }

  // Golden separator (right of stripe only)
  const sepY = 100;
  doc.moveTo(STRIPE, sepY).lineTo(A4W - MARGIN, sepY).strokeColor('#b8860b').lineWidth(2.5).stroke();
  doc.moveTo(STRIPE, sepY + 4).lineTo(A4W - MARGIN, sepY + 4).strokeColor(COR_AZUL).lineWidth(0.8).stroke();

  // Title block
  const titleY = sepY + 14;
  doc.font('Helvetica-Bold').fontSize(13).fillColor('#888888')
     .text('PROVÃO DE', STRIPE + 10, titleY);
  doc.font('Helvetica-Bold').fontSize(68).fillColor(COR_AZUL)
     .text(area.label, STRIPE + 10, titleY + 16);
  const serieText = [capa.serie, `${capa.bimestre}º BIMESTRE`].filter(Boolean).join(' — ');
  doc.font('Helvetica-Bold').fontSize(22).fillColor('#1a1a1a')
     .text(serieText, STRIPE + 10, titleY + 94);

  // Instructions separator
  const instrSepY = titleY + 128;
  doc.moveTo(STRIPE, instrSepY).lineTo(A4W - MARGIN, instrSepY).strokeColor(COR_AZUL).lineWidth(2).stroke();
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#1a1a1a')
     .text('LEIA ATENTAMENTE AS INSTRUÇÕES:', STRIPE + 10, instrSepY + 8);

  // Instructions text
  const instrText = capa.instrucoes || INSTRUCOES_PADRAO[capa.area] || '';
  const instrBottom = A4H - IMG_H - 12;
  doc.font('Helvetica').fontSize(8.8).fillColor('#222222')
     .text(instrText, STRIPE + 10, instrSepY + 26,
       { width: A4W - STRIPE - MARGIN - 10, lineGap:1.5, paragraphGap:3, height: instrBottom - instrSepY - 30 });

  // Bottom image (starts at x=STRIPE to keep the left stripe clean)
  drawBottomImage(doc, temaBuf, capa.area, {
    x: STRIPE, w: A4W - STRIPE,
    overlayRgb: [r,g,b], overlayOpacity: 0.18,
  });

  // Footer
  doc.font('Helvetica').fontSize(7).fillColor('#999999')
     .text(`EDUCA.MELHOR · ${capa.ano}`, STRIPE + 10, A4H - 12, { width: A4W - STRIPE - MARGIN - 10 });
}

async function renderFormal(doc, capa, escola, logoEsqBuf, logoDirBuf, qrBuf) {
  const area = AREAS[capa.area] || AREAS.GERAL;
  const [r,g,b] = hexToRgb(area.cor);
  const temaBuf = TEMA_IMAGES[capa.area] || null;

  doc.rect(0, 0, A4W, A4H).fill('#f9f9f9');
  doc.rect(15, 15, A4W-30, A4H-30).lineWidth(4).stroke(`rgb(${r},${g},${b})`);
  doc.rect(22, 22, A4W-44, A4H-44).lineWidth(1).stroke(`rgb(${r},${g},${b})`);

  // Header box
  doc.rect(22, 22, A4W-44, 104).fill(`rgb(${r},${g},${b})`);

  // Logos large on colored header
  if (logoEsqBuf) doc.image(logoEsqBuf, 30, 28, { fit: [88, 88], align: 'center', valign: 'center' });
  if (qrBuf)      doc.image(qrBuf, A4W - 28 - 82, 24, { width: 82, height: 82 });
  if (logoDirBuf) doc.image(logoDirBuf, A4W - 28 - 82 - 92, 28, { fit: [86, 86], align: 'center', valign: 'center' });

  // Header text (white on colored bg)
  const hx = 30 + 92;
  const hw = A4W - hx - 82 - 92 - 28;
  const secretaria = escola.secretaria || 'SECRETARIA DE ESTADO DE EDUCAÇÃO DO DISTRITO FEDERAL';
  doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#ffffff')
     .text(secretaria, hx, 32, { width: hw, align: 'center', lineBreak: false });
  const cidade = escola.cidade ? escola.cidade.toUpperCase() : 'PLANALTINA';
  const coord = escola.coordenacao || `COORDENAÇÃO REGIONAL DE ENSINO DE ${cidade}`;
  doc.font('Helvetica-Bold').fontSize(7).fillColor('rgba(255,255,255,0.9)')
     .text(coord, hx, 46, { width: hw, align: 'center', lineBreak: false });
  const apelido = escola.apelido ? ` — ${escola.apelido}` : '';
  doc.font('Helvetica-Bold').fontSize(8).fillColor('#ffffff')
     .text(`${(escola.nome || 'ESCOLA').toUpperCase()}${apelido}`, hx, 60, { width: hw, align: 'center', lineBreak: false });
  if (escola.endereco) {
    doc.font('Helvetica').fontSize(7).fillColor('rgba(255,255,255,0.75)')
       .text(escola.endereco, hx, 74, { width: hw, align: 'center', lineBreak: false });
  }

  // Title
  doc.font('Helvetica-Bold').fontSize(18).fillColor(`rgb(${r},${g},${b})`)
     .text('PROVÃO DE', 30, 140, { width: A4W-60, align: 'center' });
  doc.font('Helvetica-Bold').fontSize(60).fillColor('#111111')
     .text(area.label, 30, 160, { width: A4W-60, align: 'center' });
  doc.font('Helvetica-Bold').fontSize(22).fillColor(`rgb(${r},${g},${b})`)
     .text([capa.serie, `${capa.bimestre}º BIMESTRE`].filter(Boolean).join(' - '), 30, 232, { width: A4W-60, align: 'center' });

  doc.rect(30, 270, A4W-60, 2).fill(`rgb(${r},${g},${b})`);
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#000000')
     .text('INSTRUÇÕES AO ESTUDANTE:', 35, 280, { width: A4W-70, align: 'center' });

  const instrText = capa.instrucoes || INSTRUCOES_PADRAO[capa.area] || '';
  const instrBottom = A4H - IMG_H - 18;
  doc.font('Helvetica').fontSize(8.8).fillColor('#111111')
     .text(instrText, 35, 298, { width: A4W-70, lineGap:1.5, paragraphGap:3, height: instrBottom-298 });

  // Bottom image inside border
  drawBottomImage(doc, temaBuf, capa.area, {
    x: 23, w: A4W-46,
    overlayRgb: [r,g,b], overlayOpacity: 0.15,
  });
  doc.font('Helvetica').fontSize(7).fillColor('#aaaaaa')
     .text('EDUCA.MELHOR', 30, A4H-20, { width: A4W-60, align: 'center' });
}

async function renderColorido(doc, capa, escola, logoEsqBuf, logoDirBuf, qrBuf) {
  const area = AREAS[capa.area] || AREAS.GERAL;
  const [r,g,b] = hexToRgb(area.cor);
  const [rl,gl,bl] = hexToRgb(area.corClaro);
  const temaBuf = TEMA_IMAGES[capa.area] || null;

  // Two-zone background
  doc.rect(0, 0, A4W, A4H).fill(`rgb(${r},${g},${b})`);
  doc.rect(0, 192, A4W, A4H-192).fill('#ffffff');

  // Header on colored zone
  const afterHeader = drawHeader(doc, escola, logoEsqBuf, logoDirBuf, qrBuf, {
    bgColor: `rgb(${r},${g},${b})`,
    textColor: '#ffffff',
    lineColor: 'rgba(255,255,255,0.7)',
    lineColor2: 'rgba(255,255,255,0.3)',
    logoSize: 88,
    startY: MARGIN - 10,
  });

  // Title on colored zone
  doc.font('Helvetica-Bold').fontSize(15).fillColor(`rgb(${rl},${gl},${bl})`)
     .text('PROVÃO DE', MARGIN, afterHeader + 4, { width: A4W-MARGIN*2, align: 'center' });
  doc.font('Helvetica-Bold').fontSize(62).fillColor('#ffffff')
     .text(area.label, MARGIN, afterHeader + 22, { width: A4W-MARGIN*2, align: 'center' });

  // Series on white zone
  doc.font('Helvetica-Bold').fontSize(26).fillColor(`rgb(${r},${g},${b})`)
     .text([capa.serie, `${capa.bimestre}º BIMESTRE`].filter(Boolean).join(' - '), MARGIN, 200, { width: A4W-MARGIN*2, align: 'center' });

  // Instructions box
  const instrTop = 244;
  const instrBottom = A4H - IMG_H - 10;
  doc.rect(MARGIN, instrTop, A4W-MARGIN*2, instrBottom-instrTop).fill(`rgb(${rl},${gl},${bl})`);
  doc.rect(MARGIN, instrTop, A4W-MARGIN*2, instrBottom-instrTop).lineWidth(1.5).stroke(`rgb(${r},${g},${b})`);
  doc.font('Helvetica-Bold').fontSize(10).fillColor(`rgb(${r},${g},${b})`)
     .text('LEIA ATENTAMENTE AS INSTRUÇÕES SEGUINTES:', MARGIN+10, instrTop+8, { width: A4W-MARGIN*2-20, align: 'center' });
  const instrText = capa.instrucoes || INSTRUCOES_PADRAO[capa.area] || '';
  doc.font('Helvetica').fontSize(8.8).fillColor('#111111')
     .text(instrText, MARGIN+12, instrTop+26, { width: A4W-MARGIN*2-24, lineGap:1.5, paragraphGap:3, height: instrBottom-instrTop-34 });

  // Bottom image (full width)
  drawBottomImage(doc, temaBuf, capa.area, {
    x: 0, w: A4W,
    overlayRgb: [r,g,b], overlayOpacity: 0.2,
  });
}

async function renderDark(doc, capa, escola, logoEsqBuf, logoDirBuf, qrBuf) {
  const area = AREAS[capa.area] || AREAS.GERAL;
  const [r,g,b] = hexToRgb(area.cor);
  const temaBuf = TEMA_IMAGES[capa.area] || null;

  doc.rect(0, 0, A4W, A4H).fill('#0f172a');
  doc.rect(0, 0, A4W, 6).fill(`rgb(${r},${g},${b})`);

  // Header
  const afterHeader = drawHeader(doc, escola, logoEsqBuf, logoDirBuf, qrBuf, {
    bgColor: '#0f172a',
    textColor: '#e2e8f0',
    lineColor: `rgb(${r},${g},${b})`,
    lineColor2: '#334155',
    logoSize: 88,
    startY: 10,
  });

  // Title
  doc.font('Helvetica-Bold').fontSize(13).fillColor(`rgb(${r},${g},${b})`)
     .text('PROVÃO DE', MARGIN, afterHeader + 8, { width: A4W-MARGIN*2, align: 'center' });
  doc.font('Helvetica-Bold').fontSize(62).fillColor('#f1f5f9')
     .text(area.label, MARGIN, afterHeader + 26, { width: A4W-MARGIN*2, align: 'center' });
  doc.font('Helvetica-Bold').fontSize(22).fillColor(`rgb(${r},${g},${b})`)
     .text([capa.serie, `${capa.bimestre}º BIMESTRE`].filter(Boolean).join(' — '), MARGIN, afterHeader + 100, { width: A4W-MARGIN*2, align: 'center' });

  // Instructions dark card
  const instrTop = afterHeader + 138;
  const instrBottom = A4H - IMG_H - 10;
  doc.rect(MARGIN, instrTop, A4W-MARGIN*2, instrBottom-instrTop).fill('#1e293b');
  doc.rect(MARGIN, instrTop, A4W-MARGIN*2, instrBottom-instrTop).lineWidth(1).stroke(`rgb(${r},${g},${b})`);
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#e2e8f0')
     .text('LEIA ATENTAMENTE AS INSTRUÇÕES SEGUINTES:', MARGIN+12, instrTop+8, { width: A4W-MARGIN*2-24, align: 'center' });
  const instrText = capa.instrucoes || INSTRUCOES_PADRAO[capa.area] || '';
  doc.font('Helvetica').fontSize(8.8).fillColor('#cbd5e1')
     .text(instrText, MARGIN+12, instrTop+26, { width: A4W-MARGIN*2-24, lineGap:1.5, paragraphGap:3, height: instrBottom-instrTop-34 });

  // Bottom image with dark overlay
  drawBottomImage(doc, temaBuf, capa.area, {
    x: 0, w: A4W,
    overlayRgb: [15, 23, 42], overlayOpacity: 0.5,
  });
  // Accent line above image
  doc.moveTo(0, A4H - IMG_H).lineTo(A4W, A4H - IMG_H).strokeColor(`rgb(${r},${g},${b})`).lineWidth(2).stroke();
}

const RENDERERS = { 1: renderClassico, 2: renderModerno, 3: renderFormal, 4: renderColorido, 5: renderDark };

// ── GET / — List covers ───────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const db = req.db;
  const escolaId = Number(req.user?.escola_id);
  if (!escolaId) return res.status(400).json({ ok: false, message: 'escola_id inválido.' });
  try {
    const [rows] = await db.query(
      'SELECT id, titulo, area, serie, turno, bimestre, ano, template_id, instrucoes, qr_token, criado_em FROM capa_provas WHERE escola_id=? AND ativo=1 ORDER BY criado_em DESC',
      [escolaId]
    );
    return res.json({ ok: true, capas: rows });
  } catch (err) {
    console.error('[CAPA_PROVAS][LIST]', err);
    return res.status(500).json({ ok: false, message: 'Erro ao listar capas.' });
  }
});

// ── POST / — Create cover ─────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  const db = req.db;
  const escolaId = Number(req.user?.escola_id);
  const userId = req.user?.id;
  if (!escolaId) return res.status(400).json({ ok: false, message: 'escola_id inválido.' });

  const { titulo, area, serie, turno, bimestre, ano, template_id, instrucoes } = req.body;
  if (!titulo || !area || !bimestre || !ano)
    return res.status(400).json({ ok: false, message: 'titulo, area, bimestre e ano são obrigatórios.' });
  if (!AREAS[area]) return res.status(400).json({ ok: false, message: 'area inválida.' });
  const tid = Number(template_id) || 1;
  if (tid < 1 || tid > 5) return res.status(400).json({ ok: false, message: 'template_id deve ser 1-5.' });

  const [[{ total }]] = await db.query(
    'SELECT COUNT(*) as total FROM capa_provas WHERE escola_id=? AND ativo=1', [escolaId]
  );
  if (total >= 20) return res.status(400).json({ ok: false, message: 'Limite de 20 capas atingido.' });

  const qrToken = crypto.randomBytes(16).toString('hex');
  try {
    const [result] = await db.query(
      `INSERT INTO capa_provas (escola_id, titulo, area, serie, turno, bimestre, ano, template_id, instrucoes, qr_token, criado_por)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [escolaId, titulo.trim(), area, serie||null, turno||null, Number(bimestre), Number(ano), tid, instrucoes||null, qrToken, userId||null]
    );
    return res.status(201).json({ ok: true, id: result.insertId, qr_token: qrToken });
  } catch (err) {
    console.error('[CAPA_PROVAS][CREATE]', err);
    return res.status(500).json({ ok: false, message: 'Erro ao criar capa.' });
  }
});

// ── GET /:id/preview ──────────────────────────────────────────────────────────
router.get('/:id/preview', async (req, res) => {
  const db = req.db;
  const escolaId = Number(req.user?.escola_id);
  const id = Number(req.params.id);
  try {
    const [[capa]] = await db.query(
      'SELECT * FROM capa_provas WHERE id=? AND escola_id=? AND ativo=1 LIMIT 1', [id, escolaId]
    );
    if (!capa) return res.status(404).json({ ok: false, message: 'Capa não encontrada.' });
    const area = AREAS[capa.area] || AREAS.GERAL;
    const qrPayload = { tipo: 'capa', p: capa.id, e: escolaId, b: capa.bimestre, an: capa.ano, area: capa.area };
    return res.json({
      ok: true,
      capa: { ...capa, instrucoes: capa.instrucoes || INSTRUCOES_PADRAO[capa.area] || '' },
      area, qrPayload,
      templateNome: TEMPLATES[capa.template_id] || 'Clássico',
    });
  } catch (err) {
    return res.status(500).json({ ok: false, message: 'Erro ao buscar preview.' });
  }
});

// ── GET /:id/pdf — Generate and stream PDF ────────────────────────────────────
router.get('/:id/pdf', async (req, res) => {
  const db = req.db;
  const escolaId = Number(req.user?.escola_id);
  const id = Number(req.params.id);

  try {
    const [[capa]] = await db.query(
      'SELECT * FROM capa_provas WHERE id=? AND escola_id=? AND ativo=1 LIMIT 1', [id, escolaId]
    );
    if (!capa) return res.status(404).json({ ok: false, message: 'Capa não encontrada.' });

    // Fetch escola data — robust: only use confirmed columns
    let escola = { nome: 'ESCOLA', apelido: '', cidade: '', endereco: '', secretaria: '', coordenacao: '' };
    try {
      const [[row]] = await db.query(
        'SELECT nome, apelido, endereco, cidade, estado FROM escolas WHERE id=? LIMIT 1',
        [escolaId]
      );
      if (row) {
        escola.nome      = row.nome      || 'ESCOLA';
        escola.apelido   = row.apelido   || '';
        escola.cidade    = row.cidade    || 'PLANALTINA';
        escola.endereco  = row.endereco  || '';
      }
    } catch (e) {
      console.warn('[CAPA_PROVAS][PDF] Erro ao buscar escola (não crítico):', e.message);
    }

    // Logos from escola_logos
    const [logoRows] = await db.query(
      "SELECT posicao, url_header FROM escola_logos WHERE escola_id=? AND ativo=1 AND posicao IN ('esquerda','direita') LIMIT 2",
      [escolaId]
    );
    const logoEsqRow = logoRows.find(l => l.posicao === 'esquerda');
    const logoDirRow = logoRows.find(l => l.posicao === 'direita');
    const [logoEsqBuf, logoDirBuf] = await Promise.all([
      logoEsqRow?.url_header ? fetchImageBuffer(logoEsqRow.url_header) : Promise.resolve(null),
      logoDirRow?.url_header ? fetchImageBuffer(logoDirRow.url_header) : Promise.resolve(null),
    ]);

    // QR
    const qrPayload = { tipo: 'capa', p: capa.id, e: escolaId, b: capa.bimestre, an: capa.ano, area: capa.area };
    const qrBuf = await gerarQRBuffer(qrPayload);

    // Create PDF
    const doc = new PDFDocument({ size: 'A4', margin: 0, info: { Title: capa.titulo, Author: 'EDUCA.MELHOR' } });
    const renderer = RENDERERS[capa.template_id] || RENDERERS[1];
    await renderer(doc, capa, escola, logoEsqBuf, logoDirBuf, qrBuf);

    const filename = `capa-${capa.area.toLowerCase()}-${capa.bimestre}bim-${capa.ano}.pdf`
      .replace(/[^a-z0-9\-\.]/gi, '_');

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    doc.pipe(res);
    doc.end();
  } catch (err) {
    console.error('[CAPA_PROVAS][PDF]', err);
    if (!res.headersSent) res.status(500).json({ ok: false, message: 'Erro ao gerar PDF.' });
  }
});

// ── DELETE /:id ───────────────────────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  const db = req.db;
  const escolaId = Number(req.user?.escola_id);
  const id = Number(req.params.id);
  try {
    const [[capa]] = await db.query(
      'SELECT id FROM capa_provas WHERE id=? AND escola_id=? AND ativo=1 LIMIT 1', [id, escolaId]
    );
    if (!capa) return res.status(404).json({ ok: false, message: 'Capa não encontrada.' });
    await db.query('UPDATE capa_provas SET ativo=0 WHERE id=?', [id]);
    return res.json({ ok: true, message: 'Capa removida.' });
  } catch (err) {
    return res.status(500).json({ ok: false, message: 'Erro ao remover capa.' });
  }
});

export default router;
