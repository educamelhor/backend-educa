// ============================================================================
// GABARITO OMR — Geração de PDFs para Impressão + Correção Automática
// ============================================================================
// Design otimizado para leitura óptica (OMR):
//   - 4 marcas de registro nos cantos (calibração/alinhamento)
//   - QR Code com ID do aluno (leitura instantânea)
//   - Bolhas grandes e VAZIAS (sem letra dentro)
//   - Letras A-F como cabeçalho de coluna
//   - Espaçamento uniforme e documentado
//   - Instrução: "PREENCHA completamente a bolha"
// ============================================================================

import { Router } from "express";
import PDFDocument from "pdfkit";
import QRCode from "qrcode";
import pool from "../db.js";

const router = Router();

// ─── Constantes do Layout OMR ────────────────────────────────────────────────
// Todas as dimensões em pontos (1pt = 1/72 polegada)
// A4 = 595.28 x 841.89 pt

const MARCA_SIZE = 12;          // Tamanho da marca de registro (quadrado preto)
const MARCA_MARGIN = 24;        // Distância da marca à borda da página
const QR_SIZE = 80;             // Tamanho do QR Code
const BUBBLE_RADIUS = 6.5;     // Raio da bolha (≈ 9mm diâmetro impresso)
const BUBBLE_GAP_X = 32;       // Espaçamento horizontal entre bolhas
const ROW_HEIGHT = 24;          // Altura de cada linha de questão
const COL_GAP = 20;             // Gap entre colunas de questões

// ─── Helpers ─────────────────────────────────────────────────────────────────

function anoLetivoAtual() {
  const hoje = new Date();
  const mes = hoje.getMonth() + 1;
  return mes <= 1 ? hoje.getFullYear() - 1 : hoje.getFullYear();
}

async function buscarAlunosDaTurma(turmaId, escolaId) {
  const anoLetivo = anoLetivoAtual();
  const [rows] = await pool.query(
    `SELECT a.id, a.estudante AS nome, a.codigo AS matricula
     FROM matriculas m
     INNER JOIN alunos a ON a.id = m.aluno_id
     WHERE m.turma_id = ? AND m.escola_id = ? AND m.ano_letivo = ? AND m.status = 'ativo'
     ORDER BY a.estudante ASC`,
    [turmaId, escolaId, anoLetivo]
  );
  return rows;
}

async function buscarTurma(turmaId, escolaId) {
  const [rows] = await pool.query(
    "SELECT id, nome AS turma, turno, serie, ano FROM turmas WHERE id = ? AND escola_id = ?",
    [turmaId, escolaId]
  );
  return rows[0] || null;
}

async function buscarEscola(escolaId) {
  const [rows] = await pool.query(
    "SELECT id, nome, apelido FROM escolas WHERE id = ?",
    [escolaId]
  );
  return rows[0] || { nome: "Escola", apelido: "" };
}

// Gera QR Code como Buffer PNG
async function gerarQRBuffer(dados) {
  return QRCode.toBuffer(JSON.stringify(dados), {
    errorCorrectionLevel: "M",
    type: "png",
    width: QR_SIZE * 3, // 3x para boa resolução
    margin: 1,
    color: { dark: "#000000", light: "#ffffff" },
  });
}

// ─── Geração do PDF OMR ─────────────────────────────────────────────────────

async function gerarPdfGabarito(res, { escola, descricao, modelo, numQuestoes, numAlternativas, alunos, turma }) {
  const nQ = Number(numQuestoes) || 25;
  const nA = Number(numAlternativas) || 4;
  const letras = "ABCDEFGH".slice(0, nA);
  const nomeEscola = (escola.apelido || escola.nome || "ESCOLA").toUpperCase();
  const nomeTurma = (turma?.turma || "").toUpperCase();

  const doc = new PDFDocument({
    size: "A4",
    margins: { top: 40, bottom: 40, left: 40, right: 40 },
    bufferPages: true,
  });

  const safeTitle = (descricao || "gabarito").replace(/[^a-zA-Z0-9_-]/g, "_");
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${safeTitle}.pdf"`);
  doc.pipe(res);

  for (let i = 0; i < alunos.length; i++) {
    if (i > 0) doc.addPage();
    const aluno = alunos[i];
    const codigo = String(aluno.matricula || aluno.codigo || "000000");
    const nomeAluno = (aluno.nome || aluno.estudante || "—").toUpperCase();

    // Gerar QR Code com dados do aluno
    const qrData = {
      c: codigo,                          // código do aluno
      t: turma?.id || "",                 // ID da turma
      e: escola.id || "",                 // ID da escola
      a: descricao || "AVALIACAO",        // título da avaliação
      q: nQ,                              // total de questões
      n: nA,                              // total de alternativas
    };
    const qrBuffer = await gerarQRBuffer(qrData);

    renderPaginaOMR(doc, {
      nomeEscola,
      descricao: descricao || "AVALIAÇÃO",
      nomeTurma,
      nomeAluno,
      codigoAluno: codigo,
      nQ,
      nA,
      letras,
      modelo,
      qrBuffer,
    });
  }

  doc.end();
}

function renderPaginaOMR(doc, opts) {
  const { nomeEscola, descricao, nomeTurma, nomeAluno, codigoAluno, nQ, nA, letras, modelo, qrBuffer } = opts;

  const pageW = doc.page.width;
  const pageH = doc.page.height;
  const mL = doc.page.margins.left;
  const mR = doc.page.margins.right;
  const mT = doc.page.margins.top;
  const contentW = pageW - mL - mR;

  // ═══════════════════════════════════════════════════════════════════════════
  // 1. MARCAS DE REGISTRO (4 cantos) — quadrados pretos sólidos
  // ═══════════════════════════════════════════════════════════════════════════
  const marcas = [
    { x: MARCA_MARGIN, y: MARCA_MARGIN },                                           // Top-left
    { x: pageW - MARCA_MARGIN - MARCA_SIZE, y: MARCA_MARGIN },                      // Top-right
    { x: MARCA_MARGIN, y: pageH - MARCA_MARGIN - MARCA_SIZE },                      // Bottom-left
    { x: pageW - MARCA_MARGIN - MARCA_SIZE, y: pageH - MARCA_MARGIN - MARCA_SIZE }, // Bottom-right
  ];
  marcas.forEach(({ x, y }) => {
    doc.rect(x, y, MARCA_SIZE, MARCA_SIZE).fill("#000000");
  });

  let y = mT + 8;

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. QR CODE (canto superior direito)
  // ═══════════════════════════════════════════════════════════════════════════
  const qrX = pageW - mR - QR_SIZE - 4;
  const qrY = y;
  doc.image(qrBuffer, qrX, qrY, { width: QR_SIZE, height: QR_SIZE });

  // Label do QR
  doc.font("Helvetica").fontSize(5.5).fillColor("#999");
  doc.text("LEITURA AUTOMÁTICA", qrX, qrY + QR_SIZE + 2, { width: QR_SIZE, align: "center" });

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. CABEÇALHO (nome da escola + título)
  // ═══════════════════════════════════════════════════════════════════════════
  const headerW = contentW - QR_SIZE - 20;

  // Nome da escola
  doc.font("Helvetica-Bold").fontSize(13).fillColor("#000");
  doc.text(nomeEscola, mL, y, { width: headerW, align: "left" });
  y += 18;

  // Título da avaliação
  doc.font("Helvetica-Bold").fontSize(10).fillColor("#333");
  doc.text(descricao, mL, y, { width: headerW, align: "left" });
  y += 16;

  // Linha divisória (não invade a área do QR Code)
  const linhaFimX = qrX - 10; // para 10pt antes do QR code
  doc.moveTo(mL, y).lineTo(linhaFimX, y).strokeColor("#000").lineWidth(1).stroke();
  y += 8;

  // ═══════════════════════════════════════════════════════════════════════════
  // 4. DADOS DO ALUNO — Layout em 2 linhas, alinhado em colunas
  // ═══════════════════════════════════════════════════════════════════════════
  const col2X = mL + contentW * 0.55;
  const labelW = 48;

  // Linha 1: ALUNO (esquerda)
  doc.font("Helvetica-Bold").fontSize(8).fillColor("#444");
  doc.text("ALUNO:", mL, y, { continued: false });
  doc.font("Helvetica").fontSize(9).fillColor("#000");
  doc.text(nomeAluno, mL + 42, y, { width: col2X - mL - 50 });
  y += 16;

  // Linha 2: RE (esquerda) + TURMA (direita)
  const linha2Y = y;
  doc.font("Helvetica-Bold").fontSize(8).fillColor("#444");
  doc.text("RE:", mL, linha2Y);
  doc.font("Helvetica-Bold").fontSize(11).fillColor("#000");
  doc.text(codigoAluno, mL + 22, linha2Y - 1);

  doc.font("Helvetica-Bold").fontSize(8).fillColor("#444");
  doc.text("TURMA:", col2X, linha2Y);
  doc.font("Helvetica").fontSize(9).fillColor("#000");
  doc.text(nomeTurma, col2X + 42, linha2Y);
  y += 16;

  // Linha 3: ASSINATURA (esquerda) + DATA (direita)
  const linha3Y = y;

  // Assinatura do estudante
  doc.font("Helvetica-Bold").fontSize(8).fillColor("#444");
  doc.text("ASSINATURA:", mL, linha3Y);
  const assinaturaStartX = mL + 62;
  const assinaturaEndX = col2X - 20;
  // Linha pontilhada para assinatura
  doc.save();
  doc.moveTo(assinaturaStartX, linha3Y + 9)
    .lineTo(assinaturaEndX, linha3Y + 9)
    .dash(2, { space: 2 })
    .strokeColor("#999")
    .lineWidth(0.5)
    .stroke();
  doc.restore(); // restaura estado sem dash para as próximas linhas

  // DATA (direita)
  doc.font("Helvetica-Bold").fontSize(8).fillColor("#444");
  doc.text("DATA:", col2X, linha3Y);
  doc.font("Helvetica").fontSize(9).fillColor("#444");
  doc.text("_____/_____/_________", col2X + 36, linha3Y);
  y += 16;

  // Linha divisória (respeita área do QR Code se ainda estiver na mesma faixa)
  const linha2FimX = y < (qrY + QR_SIZE + 16) ? linhaFimX : (pageW - mR);
  doc.moveTo(mL, y).lineTo(linha2FimX, y).strokeColor("#000").lineWidth(0.5).stroke();
  y += 8;

  // ═══════════════════════════════════════════════════════════════════════════
  // 5. INSTRUÇÕES — usa heightOfString para calcular altura real do texto
  // ═══════════════════════════════════════════════════════════════════════════
  const instrText = "INSTRUÇÕES: PREENCHA completamente a bolha da alternativa correta usando caneta esferográfica AZUL ou PRETA. NÃO rasure. NÃO use lápis.";
  doc.font("Helvetica-Bold").fontSize(7).fillColor("#000");
  const instrH = doc.heightOfString(instrText, { width: contentW, align: "center" });
  doc.text(instrText, mL, y, { width: contentW, align: "center" });
  y += instrH + 6;

  // ── Exemplo visual de preenchimento ──
  // Centralizado horizontalmente na página
  const exemploY = y;
  const centroX = mL + contentW / 2;

  // "Exemplo:   errado →  ○✕    correto →  ●"
  // Posicionar tudo relativo ao centro da página
  const exemploStartX = centroX - 100;

  doc.font("Helvetica").fontSize(6.5).fillColor("#666");
  doc.text("Exemplo:", exemploStartX, exemploY);

  doc.font("Helvetica").fontSize(6.5).fillColor("#666");
  doc.text("errado", exemploStartX + 48, exemploY);

  // Seta errado
  doc.font("Helvetica").fontSize(6.5).fillColor("#666");
  doc.text("→", exemploStartX + 72, exemploY);

  // Bolha errada (com X dentro)
  const exX1 = exemploStartX + 90;
  const exCY = exemploY + 4;
  doc.circle(exX1, exCY, 5).lineWidth(0.8).strokeColor("#000").stroke();
  doc.font("Helvetica").fontSize(5).fillColor("#000");
  doc.text("✕", exX1 - 2.5, exemploY + 1);

  // Espaço e "correto →"
  doc.font("Helvetica").fontSize(6.5).fillColor("#666");
  doc.text("correto", exX1 + 24, exemploY);

  doc.font("Helvetica").fontSize(6.5).fillColor("#666");
  doc.text("→", exX1 + 52, exemploY);

  // Bolha correta (preenchida)
  const exX2 = exX1 + 66;
  doc.circle(exX2, exCY, 5).fill("#000");

  y = exemploY + 16;

  // Linha divisória antes da grade
  doc.moveTo(mL, y).lineTo(pageW - mR, y).strokeColor("#000").lineWidth(0.8).stroke();
  y += 8;

  // ═══════════════════════════════════════════════════════════════════════════
  // 6. GRADE DE BOLHAS OMR
  // ═══════════════════════════════════════════════════════════════════════════
  renderGradeOMR(doc, {
    startX: mL,
    startY: y,
    contentW,
    nQ,
    nA,
    letras,
    pageH,
    mBottom: doc.page.margins.bottom,
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 7. RODAPÉ
  // ═══════════════════════════════════════════════════════════════════════════
  const footerY = pageH - doc.page.margins.bottom - 20;
  doc.moveTo(mL, footerY).lineTo(pageW - mR, footerY).strokeColor("#ccc").lineWidth(0.3).stroke();

  doc.font("Helvetica").fontSize(5.5).fillColor("#aaa");
  doc.text(
    `EDUCA.MELHOR — Sistema de Correção Automática — ${nQ} questões · ${nA} alternativas · Modelo: ${modelo} — Gerado em ${new Date().toLocaleDateString("pt-BR")}`,
    mL, footerY + 4, { width: contentW, align: "center" }
  );
}

function renderGradeOMR(doc, { startX, startY, contentW, nQ, nA, letras, pageH, mBottom }) {
  // ── Constantes internas ──
  const numLabelW = 28;          // espaço para "01", "02"...
  const colPadding = 16;         // padding interno da borda da coluna (8 cada lado)
  const headerH = 18;            // altura do cabeçalho (Nº | A | B | C | D + linha)
  const availableH = pageH - mBottom - 40 - startY;

  // ── Layout adaptativo: encontra a melhor configuração de colunas ──
  // Prioriza o menor número de colunas possível, ajustando bubbleGapX se necessário
  let bubbleGapX = BUBBLE_GAP_X;
  let rowHeight = ROW_HEIGHT;
  let bubbleRadius = BUBBLE_RADIUS;
  let colunas = 1;
  let questoesPorColuna = nQ;
  let found = false;

  for (let c = 1; c <= 6; c++) {
    const rows = Math.ceil(nQ / c);
    const neededH = rows * ROW_HEIGHT + headerH;

    // Gap máximo que cabe nesta configuração de colunas
    const availPerCol = (contentW - (c - 1) * COL_GAP) / c;
    const maxGap = Math.floor((availPerCol - numLabelW - colPadding) / nA);

    if (neededH <= availableH && maxGap >= 18) {
      colunas = c;
      questoesPorColuna = rows;
      bubbleGapX = Math.min(BUBBLE_GAP_X, maxGap);
      found = true;
      break;
    }
  }

  // Fallback: se nenhuma config ideal com ROW_HEIGHT padrão, reduz altura das linhas
  if (!found) {
    for (let c = 1; c <= 6; c++) {
      const availPerCol = (contentW - (c - 1) * COL_GAP) / c;
      const maxGap = Math.floor((availPerCol - numLabelW - colPadding) / nA);

      if (maxGap >= 16) {
        const rows = Math.ceil(nQ / c);
        const rh = Math.floor((availableH - headerH) / rows);

        if (rh >= 14) {
          colunas = c;
          questoesPorColuna = rows;
          bubbleGapX = Math.min(BUBBLE_GAP_X, maxGap);
          rowHeight = rh;
          bubbleRadius = Math.min(BUBBLE_RADIUS, (rowHeight - 6) / 2);
          break;
        }
      }
    }
  }

  // Largura real de cada coluna distribuída na página
  const colWidth = (contentW - (colunas - 1) * COL_GAP) / colunas;

  // Fontes adaptativas — reduz se bolhas estão mais próximas
  const hdrFontSize = bubbleGapX < 26 ? 6 : 7;
  const qFontSize = bubbleGapX < 26 ? 7.5 : 8.5;

  for (let col = 0; col < colunas; col++) {
    const colX = startX + col * (colWidth + COL_GAP);
    let y = startY;

    // ── Cabeçalho da coluna: Nº | A | B | C | D ──
    doc.font("Helvetica-Bold").fontSize(hdrFontSize).fillColor("#000");
    doc.text("Nº", colX, y + 2, { width: numLabelW, align: "center" });

    for (let a = 0; a < nA; a++) {
      const bx = colX + numLabelW + a * bubbleGapX + bubbleGapX / 2;
      doc.text(letras[a], bx - 5, y + 2, { width: 10, align: "center" });
    }

    // Linha abaixo do cabeçalho
    y += 14;
    doc.moveTo(colX, y).lineTo(colX + numLabelW + nA * bubbleGapX + 8, y)
      .strokeColor("#000").lineWidth(0.6).stroke();
    y += 4;

    // ── Questões ──
    const qStart = col * questoesPorColuna + 1;
    const qEnd = Math.min(qStart + questoesPorColuna - 1, nQ);

    for (let q = qStart; q <= qEnd; q++) {
      // Fundo zebrado (para legibilidade)
      if ((q - qStart) % 2 === 0) {
        doc.rect(colX - 2, y - 2, numLabelW + nA * bubbleGapX + 12, rowHeight)
          .fill("#f5f5f5").fillColor("#000");
      }

      // Número da questão (centralizado verticalmente na linha)
      doc.font("Helvetica-Bold").fontSize(qFontSize).fillColor("#000");
      doc.text(String(q).padStart(2, "0"), colX, y + (rowHeight - qFontSize) / 2, { width: numLabelW, align: "center" });

      // Bolhas — círculos VAZIOS, sem texto dentro
      for (let a = 0; a < nA; a++) {
        const cx = colX + numLabelW + a * bubbleGapX + bubbleGapX / 2;
        const cy = y + rowHeight / 2;

        doc.circle(cx, cy, bubbleRadius)
          .lineWidth(1.0)
          .strokeColor("#555")
          .stroke();
      }

      y += rowHeight;
    }

    // Borda da coluna
    const alturaTotal = (qEnd - qStart + 1) * rowHeight + headerH;
    doc.rect(colX - 4, startY - 2, numLabelW + nA * bubbleGapX + 16, alturaTotal + 4)
      .lineWidth(0.8)
      .strokeColor("#000")
      .stroke();
  }
}

// ─── ROTAS ───────────────────────────────────────────────────────────────────

// POST /api/gabarito-pdf/gerar-turma/:turmaId
router.post("/gerar-turma/:turmaId", async (req, res) => {
  try {
    const { turmaId } = req.params;
    const { escola_id } = req.user;
    const { descricao, num_questoes, num_alternativas, modelo } = req.body;

    const turma = await buscarTurma(turmaId, escola_id);
    if (!turma) return res.status(404).json({ error: "Turma não encontrada." });

    const alunos = await buscarAlunosDaTurma(turmaId, escola_id);
    if (alunos.length === 0) return res.status(404).json({ error: "Nenhum aluno ativo nessa turma." });

    const escola = await buscarEscola(escola_id);

    await gerarPdfGabarito(res, {
      escola,
      descricao: descricao || "AVALIAÇÃO",
      modelo: modelo || "padrao",
      numQuestoes: num_questoes || 25,
      numAlternativas: num_alternativas || 4,
      alunos,
      turma,
    });
  } catch (err) {
    console.error("Erro ao gerar gabarito por turma:", err);
    if (!res.headersSent) res.status(500).json({ error: "Erro ao gerar gabarito." });
  }
});

// POST /api/gabarito-pdf/gerar-turno/:turno
router.post("/gerar-turno/:turno", async (req, res) => {
  try {
    const { turno } = req.params;
    const { escola_id } = req.user;
    const { descricao, num_questoes, num_alternativas, modelo } = req.body;
    const anoLetivo = anoLetivoAtual();

    const [turmas] = await pool.query(
      "SELECT id, nome AS turma, turno, serie, ano FROM turmas WHERE turno = ? AND escola_id = ? AND ano = ?",
      [turno, escola_id, anoLetivo]
    );
    if (turmas.length === 0) return res.status(404).json({ error: "Nenhuma turma nesse turno." });

    const escola = await buscarEscola(escola_id);

    let todosAlunos = [];
    for (const t of turmas) {
      const alunos = await buscarAlunosDaTurma(t.id, escola_id);
      todosAlunos.push(...alunos.map((a) => ({ ...a, turmaNome: t.turma })));
    }

    if (todosAlunos.length === 0) return res.status(404).json({ error: "Nenhum aluno ativo nesse turno." });

    await gerarPdfGabarito(res, {
      escola,
      descricao: descricao || "AVALIAÇÃO",
      modelo: modelo || "padrao",
      numQuestoes: num_questoes || 25,
      numAlternativas: num_alternativas || 4,
      alunos: todosAlunos,
      turma: { turma: `Turno ${turno}`, id: null },
    });
  } catch (err) {
    console.error("Erro ao gerar gabarito por turno:", err);
    if (!res.headersSent) res.status(500).json({ error: "Erro ao gerar gabarito." });
  }
});

// POST /api/gabarito-pdf/gerar-individual
router.post("/gerar-individual", async (req, res) => {
  try {
    const { escola_id } = req.user;
    const { aluno_codigo, turma_id, descricao, num_questoes, num_alternativas, modelo } = req.body;

    if (!aluno_codigo) return res.status(400).json({ error: "Código do aluno é obrigatório." });

    const [rows] = await pool.query(
      "SELECT id, estudante AS nome, codigo AS matricula FROM alunos WHERE codigo = ? AND escola_id = ?",
      [aluno_codigo, escola_id]
    );
    if (rows.length === 0) return res.status(404).json({ error: "Aluno não encontrado." });

    const aluno = rows[0];
    const escola = await buscarEscola(escola_id);
    const turma = turma_id ? await buscarTurma(turma_id, escola_id) : { turma: "", id: null };

    await gerarPdfGabarito(res, {
      escola,
      descricao: descricao || "AVALIAÇÃO",
      modelo: modelo || "padrao",
      numQuestoes: num_questoes || 25,
      numAlternativas: num_alternativas || 4,
      alunos: [aluno],
      turma,
    });
  } catch (err) {
    console.error("Erro ao gerar gabarito individual:", err);
    if (!res.headersSent) res.status(500).json({ error: "Erro ao gerar gabarito." });
  }
});

// GET /api/gabarito-pdf/layout-info
// Retorna as constantes de layout para que o serviço Python saiba
// exatamente onde cada bolha está (coordenadas calculáveis)
router.get("/layout-info", (_req, res) => {
  res.json({
    ok: true,
    unidade: "pontos (1pt = 1/72 polegada)",
    pagina: { largura: 595.28, altura: 841.89 },
    marcas: {
      tamanho: MARCA_SIZE,
      margem: MARCA_MARGIN,
      posicoes: {
        topLeft:     { x: MARCA_MARGIN, y: MARCA_MARGIN },
        topRight:    { x: 595.28 - MARCA_MARGIN - MARCA_SIZE, y: MARCA_MARGIN },
        bottomLeft:  { x: MARCA_MARGIN, y: 841.89 - MARCA_MARGIN - MARCA_SIZE },
        bottomRight: { x: 595.28 - MARCA_MARGIN - MARCA_SIZE, y: 841.89 - MARCA_MARGIN - MARCA_SIZE },
      },
    },
    bolhas: {
      raio: BUBBLE_RADIUS,
      gapX: BUBBLE_GAP_X,
      alturaLinha: ROW_HEIGHT,
      gapColunas: COL_GAP,
      numLabelWidth: 28,
    },
    qrCode: {
      tamanho: QR_SIZE,
      posicao: "canto superior direito",
      dados: "JSON com: c (código aluno), t (turma_id), e (escola_id), a (avaliação), q (questões), n (alternativas)",
    },
  });
});

export default router;
