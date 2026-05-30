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

// Page size A4 in points
const A4W = 595.28;
const A4H = 841.89;
const MARGIN = 28;

// Height reserved for the themed image at the bottom of each template
const IMG_H = 130;

// ── Template renderers ───────────────────────────────────────────────────────

async function renderClassico(doc, capa, escola, logoEsqBuf, logoDirBuf, qrBuf) {
  const area = AREAS[capa.area] || AREAS.GERAL;
  const [r,g,b] = hexToRgb(area.cor);
  const [rl,gl,bl] = hexToRgb(area.corClaro);
  const temaBuf = TEMA_IMAGES[capa.area] || null;

  // Background
  doc.rect(0, 0, A4W, A4H).fill(`rgb(${rl},${gl},${bl})`);
  // Outer border
  doc.rect(MARGIN, MARGIN, A4W-MARGIN*2, A4H-MARGIN*2).lineWidth(3).stroke(`rgb(${r},${g},${b})`);
  // Inner border
  doc.rect(MARGIN+4, MARGIN+4, A4W-(MARGIN+4)*2, A4H-(MARGIN+4)*2).lineWidth(1).stroke(`rgb(${r},${g},${b})`);

  // Header
  const headerY = MARGIN + 10;
  if (qrBuf)     doc.image(qrBuf,    A4W-MARGIN-10-80, headerY+5, { width:80, height:80 });
  if (logoEsqBuf) doc.image(logoEsqBuf, MARGIN+10, headerY+5, { width:80, height:80, fit:[80,80] });
  const textX = MARGIN + (logoEsqBuf ? 100 : 10);
  const textW = A4W - textX - (qrBuf ? 100 : 10) - MARGIN;
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#000')
     .text(escola.nome || 'ESCOLA', textX, headerY+18, { width: textW, align: 'center' });

  // Separator
  const sepY = MARGIN + 10 + 90;
  doc.moveTo(MARGIN+8, sepY).lineTo(A4W-MARGIN-8, sepY).lineWidth(2).stroke(`rgb(${r},${g},${b})`);

  // Title
  const titleY = sepY + 10;
  doc.font('Helvetica-Bold').fontSize(42).fillColor(`rgb(${r},${g},${b})`)
     .text('PROVÃO DE', MARGIN+8, titleY, { width: A4W-MARGIN*2-16, align: 'center' });
  doc.font('Helvetica-Bold').fontSize(54).fillColor('#000')
     .text(area.label, MARGIN+8, titleY+50, { width: A4W-MARGIN*2-16, align: 'center' });
  const serieText = [capa.serie, `${capa.bimestre}º BIMESTRE`].filter(Boolean).join(' - ');
  doc.font('Helvetica-Bold').fontSize(28).fillColor(`rgb(${r},${g},${b})`)
     .text(serieText, MARGIN+8, titleY+115, { width: A4W-MARGIN*2-16, align: 'center' });

  // Instructions box (shorter to make room for image)
  const instrY = titleY + 155;
  const instrBottom = A4H - MARGIN - 20 - IMG_H - 8;
  const instrH = instrBottom - instrY;
  doc.rect(MARGIN+8, instrY, A4W-MARGIN*2-16, instrH).fill(`rgb(${rl},${gl},${bl})`);
  doc.rect(MARGIN+8, instrY, A4W-MARGIN*2-16, instrH).lineWidth(1).stroke(`rgb(${r},${g},${b})`);
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#000')
     .text('LEIA ATENTAMENTE AS INSTRUÇÕES SEGUINTES:', MARGIN+16, instrY+8, { width: A4W-MARGIN*2-32, align: 'center' });
  const instrText = capa.instrucoes || INSTRUCOES_PADRAO[capa.area] || '';
  doc.font('Helvetica').fontSize(8.8).fillColor('#111')
     .text(instrText, MARGIN+16, instrY+24, { width: A4W-MARGIN*2-32, lineGap:1.5, paragraphGap:3 });

  // Themed image strip at bottom
  if (temaBuf) {
    const imgY = A4H - MARGIN - 20 - IMG_H;
    doc.image(temaBuf, MARGIN+8, imgY, { width: A4W-MARGIN*2-16, height: IMG_H, cover: [A4W-MARGIN*2-16, IMG_H] });
    // Color overlay for branding
    doc.rect(MARGIN+8, imgY, A4W-MARGIN*2-16, IMG_H).opacity(0.18).fill(`rgb(${r},${g},${b})`).opacity(1);
  }
  // Footer
  doc.font('Helvetica').fontSize(7).fillColor('#555')
     .text(`EDUCA.MELHOR — ${capa.titulo} — ${capa.ano}`, MARGIN+8, A4H-MARGIN-12, { width: A4W-MARGIN*2-16, align: 'center' });
}

async function renderModerno(doc, capa, escola, logoEsqBuf, logoDirBuf, qrBuf) {
  const area = AREAS[capa.area] || AREAS.GERAL;
  const [r,g,b] = hexToRgb(area.cor);
  const temaBuf = TEMA_IMAGES[capa.area] || null;

  doc.rect(0, 0, A4W, A4H).fill('#ffffff');
  doc.rect(0, 0, 60, A4H).fill(`rgb(${r},${g},${b})`);
  doc.rect(60, 0, A4W-60, 8).fill(`rgb(${r},${g},${b})`);

  if (logoEsqBuf) doc.image(logoEsqBuf, 5, 20, { width:50, height:50, fit:[50,50] });
  if (qrBuf)      doc.image(qrBuf, A4W-95, 15, { width:80, height:80 });
  if (logoDirBuf) doc.image(logoDirBuf, A4W-175, 20, { width:70, height:50, fit:[70,50] });

  doc.font('Helvetica-Bold').fontSize(10).fillColor('#1a1a1a')
     .text(escola.nome || 'ESCOLA', 75, 20, { width: A4W-75-100, align: 'left' });

  doc.rect(60, 105, A4W-60, 3).fill(`rgb(${r},${g},${b})`);
  doc.font('Helvetica-Bold').fontSize(14).fillColor('#666').text('PROVÃO DE', 75, 120);
  doc.font('Helvetica-Bold').fontSize(58).fillColor(`rgb(${r},${g},${b})`).text(area.label, 75, 132);
  const serieText = [capa.serie, `${capa.bimestre}º BIMESTRE`].filter(Boolean).join(' — ');
  doc.font('Helvetica-Bold').fontSize(22).fillColor('#1a1a1a').text(serieText, 75, 205);

  doc.rect(60, 240, A4W-60-MARGIN, 2).fill(`rgb(${r},${g},${b})`);
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#1a1a1a').text('LEIA ATENTAMENTE AS INSTRUÇÕES:', 75, 250);
  const instrText = capa.instrucoes || INSTRUCOES_PADRAO[capa.area] || '';
  // Instructions shorter to leave room for image
  const instrBottom = A4H - IMG_H - 16;
  doc.font('Helvetica').fontSize(8.8).fillColor('#222')
     .text(instrText, 75, 268, { width: A4W-75-MARGIN, lineGap:1.5, paragraphGap:3, height: instrBottom-268 });

  // Themed image at bottom
  if (temaBuf) {
    const imgY = A4H - IMG_H;
    doc.image(temaBuf, 60, imgY, { width: A4W-60, height: IMG_H, cover: [A4W-60, IMG_H] });
    doc.rect(60, imgY, A4W-60, IMG_H).opacity(0.2).fill(`rgb(${r},${g},${b})`).opacity(1);
  }
  doc.font('Helvetica').fontSize(7).fillColor('#aaa')
     .text(`EDUCA.MELHOR · ${capa.ano}`, 75, A4H-12, { width: A4W-75-MARGIN });
}

async function renderFormal(doc, capa, escola, logoEsqBuf, logoDirBuf, qrBuf) {
  const area = AREAS[capa.area] || AREAS.GERAL;
  const [r,g,b] = hexToRgb(area.cor);
  const temaBuf = TEMA_IMAGES[capa.area] || null;

  doc.rect(0, 0, A4W, A4H).fill('#f9f9f9');
  doc.rect(15, 15, A4W-30, A4H-30).lineWidth(4).stroke(`rgb(${r},${g},${b})`);
  doc.rect(22, 22, A4W-44, A4H-44).lineWidth(1).stroke(`rgb(${r},${g},${b})`);
  doc.rect(22, 22, A4W-44, 100).fill(`rgb(${r},${g},${b})`);

  if (logoEsqBuf) doc.image(logoEsqBuf, 30, 30, { width:70, height:70, fit:[70,70] });
  if (qrBuf)      doc.image(qrBuf, A4W-105, 25, { width:80, height:80 });
  doc.font('Helvetica-Bold').fontSize(12).fillColor('#fff')
     .text(escola.nome || 'ESCOLA', 110, 40, { width: A4W-220, align: 'center' });

  doc.font('Helvetica-Bold').fontSize(18).fillColor(`rgb(${r},${g},${b})`)
     .text('PROVÃO DE', 30, 140, { width: A4W-60, align: 'center' });
  doc.font('Helvetica-Bold').fontSize(52).fillColor('#111')
     .text(area.label, 30, 160, { width: A4W-60, align: 'center' });
  doc.font('Helvetica-Bold').fontSize(22).fillColor(`rgb(${r},${g},${b})`)
     .text([capa.serie, `${capa.bimestre}º BIMESTRE`].filter(Boolean).join(' - '), 30, 225, { width: A4W-60, align: 'center' });

  doc.rect(30, 260, A4W-60, 2).fill(`rgb(${r},${g},${b})`);
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#000')
     .text('INSTRUÇÕES AO ESTUDANTE:', 35, 270, { width: A4W-70, align: 'center' });
  const instrText = capa.instrucoes || INSTRUCOES_PADRAO[capa.area] || '';
  const instrBottom = A4H - IMG_H - 20;
  doc.font('Helvetica').fontSize(8.8).fillColor('#111')
     .text(instrText, 35, 288, { width: A4W-70, lineGap:1.5, paragraphGap:3, height: instrBottom-288 });

  // Themed image
  if (temaBuf) {
    const imgY = A4H - 15 - IMG_H;
    doc.image(temaBuf, 23, imgY, { width: A4W-46, height: IMG_H, cover: [A4W-46, IMG_H] });
    doc.rect(23, imgY, A4W-46, IMG_H).opacity(0.2).fill(`rgb(${r},${g},${b})`).opacity(1);
  }
  doc.font('Helvetica').fontSize(7).fillColor('#aaa')
     .text('EDUCA.MELHOR', 30, A4H-18, { width: A4W-60, align: 'center' });
}

async function renderColorido(doc, capa, escola, logoEsqBuf, logoDirBuf, qrBuf) {
  const area = AREAS[capa.area] || AREAS.GERAL;
  const [r,g,b] = hexToRgb(area.cor);
  const [rl,gl,bl] = hexToRgb(area.corClaro);
  const temaBuf = TEMA_IMAGES[capa.area] || null;

  doc.rect(0, 0, A4W, A4H).fill(`rgb(${r},${g},${b})`);
  doc.rect(0, 180, A4W, A4H-180).fill('#ffffff');

  if (logoEsqBuf) doc.image(logoEsqBuf, MARGIN, 15, { width:80, height:80, fit:[80,80] });
  if (qrBuf)      doc.image(qrBuf, A4W-MARGIN-85, 15, { width:80, height:80 });
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#fff')
     .text(escola.nome || 'ESCOLA', MARGIN+90, 25, { width: A4W-MARGIN*2-180, align: 'center' });

  doc.font('Helvetica-Bold').fontSize(16).fillColor(`rgb(${rl},${gl},${bl})`)
     .text('PROVÃO DE', MARGIN, 108, { width: A4W-MARGIN*2, align: 'center' });
  doc.font('Helvetica-Bold').fontSize(58).fillColor('#ffffff')
     .text(area.label, MARGIN, 122, { width: A4W-MARGIN*2, align: 'center' });
  doc.font('Helvetica-Bold').fontSize(26).fillColor(`rgb(${r},${g},${b})`)
     .text([capa.serie, `${capa.bimestre}º BIMESTRE`].filter(Boolean).join(' - '), MARGIN, 195, { width: A4W-MARGIN*2, align: 'center' });

  // Instructions box
  const instrBottom = A4H - IMG_H - 8;
  doc.rect(MARGIN, 240, A4W-MARGIN*2, instrBottom-240).fill(`rgb(${rl},${gl},${bl})`);
  doc.rect(MARGIN, 240, A4W-MARGIN*2, instrBottom-240).lineWidth(1.5).stroke(`rgb(${r},${g},${b})`);
  doc.font('Helvetica-Bold').fontSize(10).fillColor(`rgb(${r},${g},${b})`)
     .text('LEIA ATENTAMENTE AS INSTRUÇÕES SEGUINTES:', MARGIN+10, 250, { width: A4W-MARGIN*2-20, align: 'center' });
  const instrText = capa.instrucoes || INSTRUCOES_PADRAO[capa.area] || '';
  doc.font('Helvetica').fontSize(8.8).fillColor('#111')
     .text(instrText, MARGIN+12, 268, { width: A4W-MARGIN*2-24, lineGap:1.5, paragraphGap:3, height: instrBottom-268-10 });

  // Themed image
  if (temaBuf) {
    doc.image(temaBuf, 0, A4H-IMG_H, { width: A4W, height: IMG_H, cover: [A4W, IMG_H] });
    doc.rect(0, A4H-IMG_H, A4W, IMG_H).opacity(0.25).fill(`rgb(${r},${g},${b})`).opacity(1);
  }
}

async function renderDark(doc, capa, escola, logoEsqBuf, logoDirBuf, qrBuf) {
  const area = AREAS[capa.area] || AREAS.GERAL;
  const [r,g,b] = hexToRgb(area.cor);
  const temaBuf = TEMA_IMAGES[capa.area] || null;

  doc.rect(0, 0, A4W, A4H).fill('#0f172a');
  doc.rect(0, 0, A4W, 6).fill(`rgb(${r},${g},${b})`);

  if (logoEsqBuf) doc.image(logoEsqBuf, MARGIN, 18, { width:75, height:75, fit:[75,75] });
  if (qrBuf)      doc.image(qrBuf, A4W-MARGIN-85, 12, { width:82, height:82 });
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#e2e8f0')
     .text(escola.nome || 'ESCOLA', MARGIN+85, 25, { width: A4W-MARGIN*2-170, align: 'center' });

  doc.moveTo(MARGIN, 102).lineTo(A4W-MARGIN, 102).lineWidth(1).stroke(`rgb(${r},${g},${b})`);
  doc.font('Helvetica-Bold').fontSize(14).fillColor(`rgb(${r},${g},${b})`)
     .text('PROVÃO DE', MARGIN, 112, { width: A4W-MARGIN*2, align: 'center' });
  doc.font('Helvetica-Bold').fontSize(54).fillColor('#f1f5f9')
     .text(area.label, MARGIN, 126, { width: A4W-MARGIN*2, align: 'center' });
  doc.font('Helvetica-Bold').fontSize(20).fillColor(`rgb(${r},${g},${b})`)
     .text([capa.serie, `${capa.bimestre}º BIMESTRE`].filter(Boolean).join(' — '), MARGIN, 202, { width: A4W-MARGIN*2, align: 'center' });

  // Instructions dark card
  const instrBottom = A4H - IMG_H - 10;
  doc.rect(MARGIN, 238, A4W-MARGIN*2, instrBottom-238).fill('#1e293b');
  doc.rect(MARGIN, 238, A4W-MARGIN*2, instrBottom-238).lineWidth(1).stroke(`rgb(${r},${g},${b})`);
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#e2e8f0')
     .text('LEIA ATENTAMENTE AS INSTRUÇÕES SEGUINTES:', MARGIN+12, 248, { width: A4W-MARGIN*2-24, align: 'center' });
  const instrText = capa.instrucoes || INSTRUCOES_PADRAO[capa.area] || '';
  doc.font('Helvetica').fontSize(8.8).fillColor('#cbd5e1')
     .text(instrText, MARGIN+12, 266, { width: A4W-MARGIN*2-24, lineGap:1.5, paragraphGap:3, height: instrBottom-266-10 });

  // Themed image with dark overlay
  if (temaBuf) {
    doc.image(temaBuf, 0, A4H-IMG_H, { width: A4W, height: IMG_H, cover: [A4W, IMG_H] });
    doc.rect(0, A4H-IMG_H, A4W, IMG_H).opacity(0.55).fill('#0f172a').opacity(1);
    doc.rect(0, A4H-IMG_H, A4W, 2).fill(`rgb(${r},${g},${b})`);
  }
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

    // Fetch escola name only (no inep column dependency)
    let escolaNome = 'ESCOLA';
    try {
      const [[escolaRow]] = await db.query('SELECT nome FROM escolas WHERE id=? LIMIT 1', [escolaId]);
      if (escolaRow?.nome) escolaNome = escolaRow.nome;
    } catch { /* keep default */ }
    const escola = { nome: escolaNome, subtitulo: '' };

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
