// routes/capa_provas.js
import express from 'express';
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import sharp from 'sharp';            // needed for WebP → PNG conversion
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
// IMPORTANT: always use HEX strings for PDFKit colors — never 'rgb(r,g,b)'
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
  EXATAS: `1. Este CADERNO DE QUESTÕES contém 25 questões dispostas da seguinte maneira:\na) questões de número 1 a 12, relativas à área de Ciências e suas Tecnologias;\nb) questões de número 13 a 22, relativas à área de Matemática e suas Tecnologias;\nc) questões de número 23 a 25, relativas à área de Geometria e suas Tecnologias.\n\n2. Confira se a quantidade e a ordem das questões estão de acordo. Caso o caderno esteja incompleto, comunique ao aplicador da sala.\n\n3. Para cada questão objetiva, são apresentadas 4 opções. Apenas uma responde corretamente à questão.\n\n4. O tempo disponível para estas provas é de 3h00. Reserve tempo suficiente para preencher o CARTÃO-RESPOSTA.\n\n5. Rascunhos e marcações no CADERNO DE QUESTÕES não serão considerados na avaliação.\n\n6. Proibido porte e uso de qualquer aparelho eletrônico ou digital (celular, fone, smartwatch, etc.)\n\n7. Você poderá deixar o local de prova somente após decorrido 1h00 de prova.`,
  HUMANAS: `1. Este CADERNO DE QUESTÕES contém 25 questões numeradas de 01 a 25 dispostas da seguinte maneira:\na) questões de número 01 a 12, relativas à área de História e suas Tecnologias;\nb) questões de número 13 a 25, relativas à área de Geografia e suas Tecnologias.\n\n2. Confira se a quantidade e a ordem das questões estão de acordo. Caso o caderno esteja incompleto, comunique ao aplicador da sala.\n\n3. Para cada questão objetiva, são apresentadas 4 opções. Apenas uma responde corretamente à questão.\n\n4. O tempo disponível para estas provas é de 3h00. Reserve tempo suficiente para preencher o CARTÃO-RESPOSTA.\n\n5. Rascunhos e marcações no CADERNO DE QUESTÕES não serão considerados na avaliação.\n\n6. Proibido porte e uso de qualquer aparelho eletrônico ou digital (celular, fone, smartwatch, etc.)\n\n7. Você poderá deixar o local de prova somente após decorrido 1h00 de prova.`,
  LINGUAGENS: `1. Este CADERNO DE QUESTÕES contém 25 questões numeradas de 01 a 25 dispostas da seguinte maneira:\na) questões de número 01 a 10, relativas à área de Língua Portuguesa;\nb) questões de número 11 a 15, relativas à área de Educação Artística;\nc) questões de número 16 a 20, relativas à área de Língua Inglesa;\nd) questões de número 21 a 25, relativas à área de Educação Física.\n\n2. Confira se a quantidade e a ordem das questões estão de acordo. Caso o caderno esteja incompleto, comunique ao aplicador da sala.\n\n3. Para cada questão objetiva, são apresentadas 4 opções. Apenas uma responde corretamente à questão.\n\n4. O tempo disponível para estas provas é de 3h00. Reserve tempo suficiente para preencher o CARTÃO-RESPOSTA.\n\n5. Rascunhos e marcações no CADERNO DE QUESTÕES não serão considerados na avaliação.\n\n6. Proibido porte e uso de qualquer aparelho eletrônico ou digital (celular, fone, smartwatch, etc.)\n\n7. Você poderá deixar o local de prova somente após decorrido 1h00 de prova.`,
  NATUREZA: `1. Este CADERNO DE QUESTÕES contém 25 questões objetivas de Ciências da Natureza e suas Tecnologias.\n\n2. Confira se a quantidade e a ordem das questões estão de acordo. Caso o caderno esteja incompleto, comunique ao aplicador da sala.\n\n3. Para cada questão objetiva, são apresentadas 4 opções. Apenas uma responde corretamente à questão.\n\n4. O tempo disponível para estas provas é de 3h00. Reserve tempo suficiente para preencher o CARTÃO-RESPOSTA.\n\n5. Rascunhos e marcações no CADERNO DE QUESTÕES não serão considerados na avaliação.\n\n6. Proibido porte e uso de qualquer aparelho eletrônico ou digital (celular, fone, smartwatch, etc.)\n\n7. Você poderá deixar o local de prova somente após decorrido 1h00 de prova.`,
  GERAL: `1. Este CADERNO DE QUESTÕES contém questões de diversas áreas do conhecimento.\n\n2. Confira se a quantidade e a ordem das questões estão de acordo. Caso o caderno esteja incompleto, comunique ao aplicador da sala.\n\n3. Para cada questão objetiva, são apresentadas 4 opções. Apenas uma responde corretamente à questão.\n\n4. O tempo disponível para estas provas é de 3h00. Reserve tempo suficiente para preencher o CARTÃO-RESPOSTA.\n\n5. Rascunhos e marcações no CADERNO DE QUESTÕES não serão considerados na avaliação.\n\n6. Proibido porte e uso de qualquer aparelho eletrônico ou digital (celular, fone, smartwatch, etc.)\n\n7. Você poderá deixar o local de prova somente após decorrido 1h00 de prova.`,
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

// PDFKit only supports JPEG and PNG natively.
// url_thumb images are WebP (sharp .webp() output) — must convert to PNG first.
// url_header images are already PNG — no conversion needed.
async function fetchLogoBuffer(url) {
  if (!url) return null;
  const buf = await fetchImageBuffer(url);
  if (!buf) return null;
  // Detect format by magic bytes
  const isWebP = buf.length > 12 &&
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && // RIFF
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50;  // WEBP
  if (isWebP) {
    try {
      // Convert WebP → PNG so PDFKit can parse it
      return await sharp(buf).png().toBuffer();
    } catch (e) {
      console.warn('[CAPA_PROVAS] WebP→PNG conversion failed:', e.message);
      return null;
    }
  }
  return buf; // JPEG/PNG — already compatible with PDFKit
}

async function gerarQRBuffer(dados) {
  return QRCode.toBuffer(JSON.stringify(dados), {
    errorCorrectionLevel: 'M', type: 'png', width: 240, margin: 1,
    color: { dark: '#000000', light: '#ffffff' },
  });
}

// A4 page constants
const A4W = 595.28;
const A4H = 841.89;
const MARGIN    = 28;
const LOGO_H    = 90;   // target logo HEIGHT — url_thumb(120x80) at height:90 → ~135x90px
const LOGO_ZONE = 138;  // horizontal space allocated per logo in header
const QR_SIZE   = 82;   // QR code size
const HEADER_H  = 145;  // header height — 145px gives room for 2-line school names

// ─────────────────────────────────────────────────────────────────────────────
// SHARED: Draw institutional header identical to Relatório Disciplinar
// All colors must be HEX strings or PDFKit won't render them
// Returns: Y coordinate immediately after the header (after separator lines)
// ─────────────────────────────────────────────────────────────────────────────
function drawInstitucionalHeader(doc, escola, logoEsqBuf, logoDirBuf, qrBuf, opts = {}) {
  const {
    startY     = 4,
    bgColor    = '#ffffff',
    textColor  = '#1e3a5f',
    sepColor1  = '#b8860b',
    sepColor2  = '#1e3a5f',
    logoOffX   = MARGIN,       // X of left logo
    contentX   = MARGIN,       // X start of center text
    pageW      = A4W,
  } = opts;

  // Header background + geometry
  doc.fillColor(bgColor).rect(0, startY, pageW, HEADER_H).fill();
  const contentH = HEADER_H - 16;
  const logoY    = startY + (contentH - LOGO_H) / 2;
  const qrX      = pageW - MARGIN - QR_SIZE;

  // Left logo
  if (logoEsqBuf) {
    doc.image(logoEsqBuf, logoOffX, logoY, { height: LOGO_H });
  }

  // QR code — top-right corner
  if (qrBuf) {
    doc.image(qrBuf, qrX, startY + (contentH - QR_SIZE) / 2,
      { width: QR_SIZE, height: QR_SIZE });
  }

  // Right logo — left of QR
  if (logoDirBuf) {
    const logoRX = qrBuf ? qrX - LOGO_ZONE - 6 : pageW - MARGIN - LOGO_ZONE;
    doc.image(logoDirBuf, logoRX, logoY, { height: LOGO_H });
  }

  // Center text block
  const leftEdge  = contentX + (logoEsqBuf ? LOGO_ZONE + 8 : 0);
  const rightStop = logoDirBuf ? qrX - LOGO_ZONE - 10 : qrX - 4;
  const tw = Math.max(60, rightStop - leftEdge);

  // Start position — vertically centred (estimate 4 lines × 13px = 52px)
  let ty = startY + Math.max(8, (contentH - 52) / 2);

  // Line 1 — Secretaria (clips if too long — lineBreak:false)
  doc.fillColor(textColor).font('Helvetica-Bold').fontSize(8)
     .text('SECRETARIA DE ESTADO DE EDUCAÇÃO DO DISTRITO FEDERAL',
       leftEdge, ty, { width: tw, align: 'center', lineBreak: false });
  ty = doc.y + 1;

  // Line 2 — Coordenação Regional
  const cidade = (escola.cidade || 'PLANALTINA').toUpperCase();
  doc.fillColor(textColor).font('Helvetica-Bold').fontSize(7.5)
     .text(`COORDENAÇÃO REGIONAL DE ENSINO DE ${cidade}`,
       leftEdge, ty, { width: tw, align: 'center', lineBreak: false });
  ty = doc.y + 1;

  // Line 3 — Nome + Apelido — WRAPPING ALLOWED so address never overlaps
  const apelido = escola.apelido ? ` — ${escola.apelido}` : '';
  doc.fillColor(textColor).font('Helvetica-Bold').fontSize(8)
     .text(`${(escola.nome || 'ESCOLA').toUpperCase()}${apelido}`,
       leftEdge, ty, { width: tw, align: 'center' });
  ty = doc.y + 1;  // advances past ALL wrapped lines of school name

  // Line 4 — Endereço — always below line 3, never overlaps
  if (escola.endereco) {
    doc.fillColor('#555555').font('Helvetica').fontSize(7)
       .text(escola.endereco, leftEdge, ty,
         { width: tw, align: 'center', lineBreak: false });
  }

  // Double separator
  const sepY1 = startY + HEADER_H - 10;
  const sepY2 = sepY1 + 4;
  doc.moveTo(MARGIN, sepY1).lineTo(A4W - MARGIN, sepY1)
     .strokeColor(sepColor1).lineWidth(2.5).stroke();
  doc.moveTo(MARGIN, sepY2).lineTo(A4W - MARGIN, sepY2)
     .strokeColor(sepColor2).lineWidth(0.8).stroke();

  return sepY2 + 6;
}

// ─────────────────────────────────────────────────────────────────────────────
// SHARED: Measure instruction text height using PDFKit's heightOfString
// ─────────────────────────────────────────────────────────────────────────────
function measureInstrHeight(doc, instrText, textWidth) {
  return doc.font('Helvetica').fontSize(8.8)
    .heightOfString(instrText, { width: textWidth, lineGap: 1.5, paragraphGap: 3 });
}

// ─────────────────────────────────────────────────────────────────────────────
// SHARED: Draw themed image filling ALL available space from imgY to bottom
// The image always covers (x, imgY) to (x+w, A4H) — no fixed height
// ─────────────────────────────────────────────────────────────────────────────
function drawBottomImage(doc, temaBuf, x, w, imgY) {
  if (!temaBuf || imgY >= A4H - 10) return;
  const imgH = A4H - imgY;
  if (imgH < 20) return;
  // width: w, height: imgH forces image to fill the exact area (stretches if needed)
  // For panoramic decorative images, slight stretching is visually imperceptible
  doc.image(temaBuf, x, imgY, { width: w, height: imgH });
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEMPLATE 1 — CLÁSSICO
// Fundo suave com bordas duplas na cor da área
// ═══════════════════════════════════════════════════════════════════════════════
async function renderClassico(doc, capa, escola, logoEsqBuf, logoDirBuf, qrBuf) {
  const area = AREAS[capa.area] || AREAS.GERAL;
  const temaBuf = TEMA_IMAGES[capa.area] || null;

  // Page background (light tint of area color)
  doc.fillColor(area.corClaro).rect(0, 0, A4W, A4H).fill();

  // Double border
  doc.strokeColor(area.cor).lineWidth(3)
     .rect(MARGIN, MARGIN, A4W - MARGIN * 2, A4H - MARGIN * 2).stroke();
  doc.strokeColor(area.cor).lineWidth(1)
     .rect(MARGIN + 4, MARGIN + 4, A4W - (MARGIN + 4) * 2, A4H - (MARGIN + 4) * 2).stroke();

  // Header
  const afterHeader = drawInstitucionalHeader(doc, escola, logoEsqBuf, logoDirBuf, qrBuf, {
    startY: MARGIN + 6,
    bgColor: area.corClaro,
    textColor: area.cor,
    sepColor1: area.cor,
    sepColor2: '#666666',
  });

  // Title block
  const titleY = afterHeader + 6;
  doc.fillColor(area.cor).font('Helvetica-Bold').fontSize(20)
     .text('PROVÃO DE', MARGIN + 8, titleY, { width: A4W - MARGIN * 2 - 16, align: 'center' });
  doc.fillColor('#111111').font('Helvetica-Bold').fontSize(64)
     .text(area.label, MARGIN + 8, titleY + 24, { width: A4W - MARGIN * 2 - 16, align: 'center' });
  const serieText = [capa.serie, `${capa.bimestre}º BIMESTRE`].filter(Boolean).join(' - ');
  doc.fillColor(area.cor).font('Helvetica-Bold').fontSize(24)
     .text(serieText, MARGIN + 8, titleY + 98, { width: A4W - MARGIN * 2 - 16, align: 'center' });

  // Instructions block — measure text height first for dynamic sizing
  const instrText = capa.instrucoes || INSTRUCOES_PADRAO[capa.area] || '';
  const instrInnerW = A4W - MARGIN * 2 - 32;
  const instrTextH = measureInstrHeight(doc, instrText, instrInnerW);
  const instrBoxH = instrTextH + 38; // padding: 10 + 24(title) + 4 bottom

  const instrY = titleY + 132;
  doc.fillColor(area.corClaro).rect(MARGIN + 8, instrY, A4W - MARGIN * 2 - 16, instrBoxH).fill();
  doc.strokeColor(area.cor).lineWidth(1)
     .rect(MARGIN + 8, instrY, A4W - MARGIN * 2 - 16, instrBoxH).stroke();
  doc.fillColor('#000000').font('Helvetica-Bold').fontSize(10)
     .text('LEIA ATENTAMENTE AS INSTRUÇÕES SEGUINTES:', MARGIN + 16, instrY + 8,
       { width: instrInnerW, align: 'center' });
  doc.fillColor('#111111').font('Helvetica').fontSize(8.8)
     .text(instrText, MARGIN + 16, instrY + 28, { width: instrInnerW, lineGap: 1.5, paragraphGap: 3 });

  // Themed image fills ALL remaining space below instructions
  const imageStartY = instrY + instrBoxH + 6;
  drawBottomImage(doc, temaBuf, MARGIN + 8, A4W - MARGIN * 2 - 16, imageStartY);

  // Footer
  doc.fillColor('#666666').font('Helvetica').fontSize(7)
     .text(`EDUCA.MELHOR — ${capa.titulo} — ${capa.ano}`, MARGIN + 8, A4H - 14,
       { width: A4W - MARGIN * 2 - 16, align: 'center' });
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEMPLATE 2 — MODERNO
// Faixa lateral colorida + layout clean e bold
// ═══════════════════════════════════════════════════════════════════════════════
async function renderModerno(doc, capa, escola, logoEsqBuf, logoDirBuf, qrBuf) {
  const area = AREAS[capa.area] || AREAS.GERAL;
  const temaBuf = TEMA_IMAGES[capa.area] || null;
  const STRIPE = 62;

  // ── Step 1: White page background ──────────────────────────────────────────
  doc.fillColor('#ffffff').rect(0, 0, A4W, A4H).fill();

  // ── Step 2: Left color stripe (MUST use fillColor then fill separately) ─────
  doc.fillColor(area.cor).rect(0, 0, STRIPE, A4H).fill();

  // ── Step 3: Top accent bar (right portion) ──────────────────────────────────
  doc.fillColor(area.cor).rect(STRIPE, 0, A4W - STRIPE, 8).fill();

  // ── Step 4: Left logo — in the WHITE header area (right of stripe), same height as right logo
  const logoEsqX  = STRIPE + 10;
  const logoEsqY  = (HEADER_H - LOGO_H) / 2;
  if (logoEsqBuf) {
    doc.image(logoEsqBuf, logoEsqX, logoEsqY, { height: LOGO_H });
  }

  // ── Step 5: QR code top-right ─────────────────────────────────────────────────
  const qrX = A4W - MARGIN - QR_SIZE;
  if (qrBuf) {
    doc.image(qrBuf, qrX, (HEADER_H - QR_SIZE) / 2, { width: QR_SIZE, height: QR_SIZE });
  }

  // ── Step 6: Right logo — height:LOGO_H keeps native proportions ────────────────
  if (logoDirBuf) {
    const logoRX = qrBuf ? qrX - LOGO_ZONE - 6 : A4W - MARGIN - LOGO_ZONE;
    doc.image(logoDirBuf, logoRX, (HEADER_H - LOGO_H) / 2, { height: LOGO_H });
  }

  // ── Step 7: Institutional text — between left-logo zone and right-logo zone ────────
  const hx       = STRIPE + 10 + LOGO_ZONE + 8;  // left of logo + logo width + gap
  const rightStop = logoDirBuf ? qrX - LOGO_ZONE - 10 : qrX - 4;
  const hw        = Math.max(50, rightStop - hx);

  // Vertically center 4 lines in header
  let hty = Math.max(10, (HEADER_H - 52) / 2);

  const cidadeM  = (escola.cidade || 'PLANALTINA').toUpperCase();
  const apelidoM = escola.apelido ? ` — ${escola.apelido}` : '';
  doc.fillColor(area.cor).font('Helvetica-Bold').fontSize(8)
     .text('SECRETARIA DE ESTADO DE EDUCAÇÃO DO DISTRITO FEDERAL', hx, hty,
       { width: hw, align: 'center', lineBreak: false });
  hty = doc.y + 1;
  doc.fillColor(area.cor).font('Helvetica-Bold').fontSize(7.5)
     .text(`COORDENAÇÃO REGIONAL DE ENSINO DE ${cidadeM}`, hx, hty,
       { width: hw, align: 'center', lineBreak: false });
  hty = doc.y + 1;
  doc.fillColor(area.cor).font('Helvetica-Bold').fontSize(8)
     .text(`${(escola.nome || 'ESCOLA').toUpperCase()}${apelidoM}`, hx, hty,
       { width: hw, align: 'center' });
  hty = doc.y + 1;
  if (escola.endereco) {
    doc.fillColor('#555555').font('Helvetica').fontSize(7)
       .text(escola.endereco, hx, hty, { width: hw, align: 'center', lineBreak: false });
  }

  // ── Step 8: Double separator (starts after header) ──────────────────────────
  const sepY1 = HEADER_H + 4;
  const sepY2 = sepY1 + 4;
  doc.moveTo(STRIPE, sepY1).lineTo(A4W - MARGIN, sepY1)
     .strokeColor('#b8860b').lineWidth(2.5).stroke();
  doc.moveTo(STRIPE, sepY2).lineTo(A4W - MARGIN, sepY2)
     .strokeColor(area.cor).lineWidth(0.8).stroke();

  // ── Step 9: Title block ──────────────────────────────────────────────────────
  const titleY = sepY2 + 10;
  const titleW = A4W - STRIPE - MARGIN - 10;
  doc.fillColor('#888888').font('Helvetica-Bold').fontSize(14)
     .text('PROVÃO DE', STRIPE + 10, titleY);
  doc.fillColor(area.cor).font('Helvetica-Bold').fontSize(68)
     .text(area.label, STRIPE + 10, titleY + 18);
  const serieText = [capa.serie, `${capa.bimestre}º BIMESTRE`].filter(Boolean).join(' — ');
  doc.fillColor('#1a1a1a').font('Helvetica-Bold').fontSize(22)
     .text(serieText, STRIPE + 10, titleY + 94);

  // ── Step 10: Instructions separator ─────────────────────────────────────────
  const instrSepY = titleY + 128;
  doc.moveTo(STRIPE, instrSepY).lineTo(A4W - MARGIN, instrSepY)
     .strokeColor(area.cor).lineWidth(2).stroke();
  doc.fillColor('#1a1a1a').font('Helvetica-Bold').fontSize(10)
     .text('LEIA ATENTAMENTE AS INSTRUÇÕES:', STRIPE + 10, instrSepY + 8);

  // ── Step 11: Instructions — dynamic height ───────────────────────────────────
  const instrText = capa.instrucoes || INSTRUCOES_PADRAO[capa.area] || '';
  const instrW = A4W - STRIPE - MARGIN - 20;
  const instrTextH = measureInstrHeight(doc, instrText, instrW);
  const instrStartY = instrSepY + 26;
  doc.fillColor('#222222').font('Helvetica').fontSize(8.8)
     .text(instrText, STRIPE + 10, instrStartY, { width: instrW, lineGap: 1.5, paragraphGap: 3 });

  // ── Step 12: Themed image fills ALL remaining space ─────────────────────────
  const imageStartY = instrStartY + instrTextH + 10;
  drawBottomImage(doc, temaBuf, STRIPE, A4W - STRIPE, imageStartY);

  // Footer
  doc.fillColor('#999999').font('Helvetica').fontSize(7)
     .text(`EDUCA.MELHOR · ${capa.ano}`, STRIPE + 10, A4H - 12,
       { width: A4W - STRIPE - MARGIN - 10 });
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEMPLATE 3 — FORMAL
// Bordas duplas + header colorido sólido
// ═══════════════════════════════════════════════════════════════════════════════
async function renderFormal(doc, capa, escola, logoEsqBuf, logoDirBuf, qrBuf) {
  const area = AREAS[capa.area] || AREAS.GERAL;
  const temaBuf = TEMA_IMAGES[capa.area] || null;

  doc.fillColor('#f9f9f9').rect(0, 0, A4W, A4H).fill();
  doc.strokeColor(area.cor).lineWidth(4).rect(15, 15, A4W - 30, A4H - 30).stroke();
  doc.strokeColor(area.cor).lineWidth(1).rect(22, 22, A4W - 44, A4H - 44).stroke();

  // Colored header band — taller to accommodate LOGO_H=90
  const BAND_H = 120;  // logo at y=28, height=90 → ends at y=118; band must contain it
  doc.fillColor(area.cor).rect(22, 22, A4W - 44, BAND_H).fill();

  // Large logos on header band — use LOGO_H height constraint
  // Logo starts at y=28; height=90 → ends at y=118 ≤ band bottom (y=142)
  const logoTopY = 28;
  if (logoEsqBuf)  doc.image(logoEsqBuf,  30, logoTopY, { height: LOGO_H });
  if (qrBuf)       doc.image(qrBuf, A4W - 28 - QR_SIZE, logoTopY + (LOGO_H - QR_SIZE) / 2,
    { width: QR_SIZE, height: QR_SIZE });
  if (logoDirBuf)  doc.image(logoDirBuf, A4W - 28 - QR_SIZE - LOGO_ZONE - 6, logoTopY,
    { height: LOGO_H });

  // Header text — white on colored background, with doc.y tracking
  const hx = 30 + LOGO_ZONE + 8;
  const hw = A4W - hx - QR_SIZE - LOGO_ZONE - 36;
  let hy = logoTopY + 4;  // start text near top of logo zone

  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(7.5)
     .text('SECRETARIA DE ESTADO DE EDUCAÇÃO DO DISTRITO FEDERAL', hx, hy,
       { width: hw, align: 'center', lineBreak: false });
  hy = doc.y + 2;
  const cidade = (escola.cidade || 'PLANALTINA').toUpperCase();
  doc.fillColor('#ffffffcc').font('Helvetica-Bold').fontSize(7)
     .text(`COORDENAÇÃO REGIONAL DE ENSINO DE ${cidade}`, hx, hy,
       { width: hw, align: 'center', lineBreak: false });
  hy = doc.y + 2;
  const apelido = escola.apelido ? ` — ${escola.apelido}` : '';
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(8)
     .text(`${(escola.nome || 'ESCOLA').toUpperCase()}${apelido}`, hx, hy,
       { width: hw, align: 'center' });
  hy = doc.y + 2;
  if (escola.endereco) {
    doc.fillColor('#ffffff99').font('Helvetica').fontSize(7)
       .text(escola.endereco, hx, hy, { width: hw, align: 'center', lineBreak: false });
  }

  // Title block — positioned dynamically after band
  const bandBottom = 22 + BAND_H + 8;  // band bottom + gap
  doc.fillColor(area.cor).font('Helvetica-Bold').fontSize(18)
     .text('PROVÃO DE', 30, bandBottom, { width: A4W - 60, align: 'center' });
  doc.fillColor('#111111').font('Helvetica-Bold').fontSize(60)
     .text(area.label, 30, bandBottom + 22, { width: A4W - 60, align: 'center' });
  doc.fillColor(area.cor).font('Helvetica-Bold').fontSize(22)
     .text([capa.serie, `${capa.bimestre}º BIMESTRE`].filter(Boolean).join(' - '), 30, bandBottom + 94,
       { width: A4W - 60, align: 'center' });

  // Instructions
  const instrBaseY = bandBottom + 128;
  doc.fillColor(area.cor).rect(30, instrBaseY, A4W - 60, 2).fill();
  doc.fillColor('#000000').font('Helvetica-Bold').fontSize(10)
     .text('INSTRUÇÕES AO ESTUDANTE:', 35, instrBaseY + 10, { width: A4W - 70, align: 'center' });
  const instrText = capa.instrucoes || INSTRUCOES_PADRAO[capa.area] || '';
  const instrW = A4W - 70;
  const instrTextH = measureInstrHeight(doc, instrText, instrW);
  doc.fillColor('#111111').font('Helvetica').fontSize(8.8)
     .text(instrText, 35, instrBaseY + 28, { width: instrW, lineGap: 1.5, paragraphGap: 3 });

  // Image fills rest
  const imageStartY = instrBaseY + 28 + instrTextH + 8;
  drawBottomImage(doc, temaBuf, 23, A4W - 46, imageStartY);

  doc.fillColor('#aaaaaa').font('Helvetica').fontSize(7)
     .text('EDUCA.MELHOR', 30, A4H - 20, { width: A4W - 60, align: 'center' });
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEMPLATE 4 — COLORIDO
// Topo na cor sólida da área + zona branca inferior
// ═══════════════════════════════════════════════════════════════════════════════
async function renderColorido(doc, capa, escola, logoEsqBuf, logoDirBuf, qrBuf) {
  const area = AREAS[capa.area] || AREAS.GERAL;
  const temaBuf = TEMA_IMAGES[capa.area] || null;

  // Two-zone background
  doc.fillColor(area.cor).rect(0, 0, A4W, A4H).fill();
  doc.fillColor('#ffffff').rect(0, 192, A4W, A4H - 192).fill();

  // Header on colored zone
  const afterHeader = drawInstitucionalHeader(doc, escola, logoEsqBuf, logoDirBuf, qrBuf, {
    startY: MARGIN - 10,
    bgColor: area.cor,
    textColor: '#ffffff',
    sepColor1: '#ffffff88',
    sepColor2: '#ffffff44',
  });

  // Title on colored zone
  doc.fillColor(area.corClaro).font('Helvetica-Bold').fontSize(15)
     .text('PROVÃO DE', MARGIN, afterHeader + 4, { width: A4W - MARGIN * 2, align: 'center' });
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(62)
     .text(area.label, MARGIN, afterHeader + 22, { width: A4W - MARGIN * 2, align: 'center' });

  // Series on white zone
  doc.fillColor(area.cor).font('Helvetica-Bold').fontSize(26)
     .text([capa.serie, `${capa.bimestre}º BIMESTRE`].filter(Boolean).join(' - '), MARGIN, 200,
       { width: A4W - MARGIN * 2, align: 'center' });

  // Instructions box on white zone
  const instrTop = 244;
  doc.fillColor(area.corClaro).font('Helvetica-Bold').fontSize(10)
     .text('LEIA ATENTAMENTE AS INSTRUÇÕES SEGUINTES:', MARGIN + 10, instrTop + 8,
       { width: A4W - MARGIN * 2 - 20, align: 'center' });
  const instrText = capa.instrucoes || INSTRUCOES_PADRAO[capa.area] || '';
  const instrW = A4W - MARGIN * 2 - 24;
  const instrTextH = measureInstrHeight(doc, instrText, instrW);
  const instrBoxH = instrTextH + 36;

  doc.fillColor(area.corClaro).rect(MARGIN, instrTop, A4W - MARGIN * 2, instrBoxH).fill();
  doc.strokeColor(area.cor).lineWidth(1.5).rect(MARGIN, instrTop, A4W - MARGIN * 2, instrBoxH).stroke();
  doc.fillColor(area.cor).font('Helvetica-Bold').fontSize(10)
     .text('LEIA ATENTAMENTE AS INSTRUÇÕES SEGUINTES:', MARGIN + 10, instrTop + 8,
       { width: instrW + 4, align: 'center' });
  doc.fillColor('#111111').font('Helvetica').fontSize(8.8)
     .text(instrText, MARGIN + 12, instrTop + 28, { width: instrW, lineGap: 1.5, paragraphGap: 3 });

  // Image fills rest
  const imageStartY = instrTop + instrBoxH + 8;
  drawBottomImage(doc, temaBuf, 0, A4W, imageStartY);
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEMPLATE 5 — DARK
// Fundo escuro (#0f172a) com texto claro
// ═══════════════════════════════════════════════════════════════════════════════
async function renderDark(doc, capa, escola, logoEsqBuf, logoDirBuf, qrBuf) {
  const area = AREAS[capa.area] || AREAS.GERAL;
  const temaBuf = TEMA_IMAGES[capa.area] || null;

  doc.fillColor('#0f172a').rect(0, 0, A4W, A4H).fill();
  doc.fillColor(area.cor).rect(0, 0, A4W, 6).fill();

  // Header
  const afterHeader = drawInstitucionalHeader(doc, escola, logoEsqBuf, logoDirBuf, qrBuf, {
    startY: 8,
    bgColor: '#0f172a',
    textColor: '#e2e8f0',
    sepColor1: area.cor,
    sepColor2: '#334155',
  });

  // Title
  doc.fillColor(area.cor).font('Helvetica-Bold').fontSize(13)
     .text('PROVÃO DE', MARGIN, afterHeader + 8, { width: A4W - MARGIN * 2, align: 'center' });
  doc.fillColor('#f1f5f9').font('Helvetica-Bold').fontSize(62)
     .text(area.label, MARGIN, afterHeader + 26, { width: A4W - MARGIN * 2, align: 'center' });
  doc.fillColor(area.cor).font('Helvetica-Bold').fontSize(22)
     .text([capa.serie, `${capa.bimestre}º BIMESTRE`].filter(Boolean).join(' — '), MARGIN, afterHeader + 100,
       { width: A4W - MARGIN * 2, align: 'center' });

  // Instructions dark card
  const instrTop = afterHeader + 140;
  const instrText = capa.instrucoes || INSTRUCOES_PADRAO[capa.area] || '';
  const instrW = A4W - MARGIN * 2 - 24;
  const instrTextH = measureInstrHeight(doc, instrText, instrW);
  const instrBoxH = instrTextH + 36;

  doc.fillColor('#1e293b').rect(MARGIN, instrTop, A4W - MARGIN * 2, instrBoxH).fill();
  doc.strokeColor(area.cor).lineWidth(1).rect(MARGIN, instrTop, A4W - MARGIN * 2, instrBoxH).stroke();
  doc.fillColor('#e2e8f0').font('Helvetica-Bold').fontSize(10)
     .text('LEIA ATENTAMENTE AS INSTRUÇÕES SEGUINTES:', MARGIN + 12, instrTop + 8,
       { width: instrW + 12, align: 'center' });
  doc.fillColor('#cbd5e1').font('Helvetica').fontSize(8.8)
     .text(instrText, MARGIN + 12, instrTop + 28, { width: instrW, lineGap: 1.5, paragraphGap: 3 });

  // Image fills rest
  const imageStartY = instrTop + instrBoxH + 8;
  drawBottomImage(doc, temaBuf, 0, A4W, imageStartY);

  // Accent line above image
  doc.moveTo(0, imageStartY).lineTo(A4W, imageStartY)
     .strokeColor(area.cor).lineWidth(2).stroke();
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

    // Fetch escola data (only confirmed columns)
    let escola = { nome: 'ESCOLA', apelido: '', cidade: 'PLANALTINA', endereco: '' };
    try {
      const [[row]] = await db.query(
        'SELECT nome, apelido, endereco, cidade FROM escolas WHERE id=? LIMIT 1', [escolaId]
      );
      if (row) Object.assign(escola, {
        nome:     row.nome     || 'ESCOLA',
        apelido:  row.apelido  || '',
        cidade:   row.cidade   || 'PLANALTINA',
        endereco: row.endereco || '',
      });
    } catch (e) {
      console.warn('[CAPA_PROVAS][PDF] escola query:', e.message);
    }

    // Logos — prefer url_thumb (120×80, ~1.5:1) over url_header (400×120, ~3.3:1)
    // fetchLogoBuffer auto-converts WebP → PNG so PDFKit can read it
    const [logoRows] = await db.query(
      "SELECT posicao, url_thumb, url_header FROM escola_logos WHERE escola_id=? AND ativo=1 AND posicao IN ('esquerda','direita') LIMIT 2",
      [escolaId]
    );
    const pickUrl = (row) => row?.url_thumb || row?.url_header || null;
    const [logoEsqBuf, logoDirBuf] = await Promise.all([
      fetchLogoBuffer(pickUrl(logoRows.find(l => l.posicao === 'esquerda'))),
      fetchLogoBuffer(pickUrl(logoRows.find(l => l.posicao === 'direita'))),
    ]);

    // QR
    const qrPayload = { tipo: 'capa', p: capa.id, e: escolaId, b: capa.bimestre, an: capa.ano, area: capa.area };
    const qrBuf = await gerarQRBuffer(qrPayload);

    // Render PDF
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
