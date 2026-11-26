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
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import sharp from "sharp";
import { normalizarConfigFormato } from "../utils/gabaritoScoring.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SPACES_PUBLIC_BASE = String(
  process.env.SPACES_PUBLIC_BASE || "https://nyc3.digitaloceanspaces.com/educa-melhor-uploads/"
).replace(/\/+$/, "") + "/";

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
    `SELECT a.id, a.estudante AS nome, a.codigo AS matricula,
            a.foto,
            CASE
              WHEN a.foto LIKE 'http%' THEN a.foto
              ELSE CONCAT(?, 'uploads/', COALESCE(e.apelido, CONCAT('escola_', a.escola_id)), '/alunos/', a.codigo, '.jpg')
            END AS foto_url,
            COALESCE(
              (SELECT MAX(CASE WHEN ra.consentimento_imagem = 1 AND ra.ativo = 1 THEN 1 ELSE 0 END)
                 FROM responsaveis_alunos ra
                WHERE ra.aluno_id = a.id AND ra.escola_id = a.escola_id),
              0
            ) AS consentimento_imagem
     FROM matriculas m
     INNER JOIN alunos a ON a.id = m.aluno_id
     LEFT JOIN  escolas e ON e.id = a.escola_id
     WHERE m.turma_id = ? AND m.escola_id = ? AND m.ano_letivo = ? AND m.status = 'ativo'
     ORDER BY a.estudante ASC`,
    [SPACES_PUBLIC_BASE, turmaId, escolaId, anoLetivo]
  );
  // Aplica LGPD: oculta foto se não há consentimento
  return rows.map(a => ({
    ...a,
    foto_url: Number(a.consentimento_imagem) === 1 ? a.foto_url : null,
  }));
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

// ─── Fetch + processo da foto do aluno ──────────────────────────────────────
// Retorna um Buffer JPEG pronto para renderizar no PDF, ou null se falhar.
const FOTO_CACHE = new Map(); // cache em memória por URL (vida útil da requisição do PDF)

async function buscarFotoBuffer(fotoUrl) {
  if (!fotoUrl) return null;

  // Normaliza URL relativa (caminho local do servidor)
  let url = fotoUrl;
  if (!url.startsWith("http")) {
    // Caminho relativo ao servidor — tenta ler do filesystem
    const localPath = path.resolve(__dirname, "..", url.replace(/^\//, ""));
    if (!fs.existsSync(localPath)) return null;
    try {
      const raw = fs.readFileSync(localPath);
      return await sharp(raw)
        .resize(120, 120, { fit: "cover", position: "centre" })
        .jpeg({ quality: 85 })
        .toBuffer();
    } catch {
      return null;
    }
  }

  if (FOTO_CACHE.has(url)) return FOTO_CACHE.get(url);

  try {
    const resp = await fetch(url, { timeout: 6000 });
    if (!resp.ok) return null;
    const raw = Buffer.from(await resp.arrayBuffer());
    const buf = await sharp(raw)
      .resize(120, 120, { fit: "cover", position: "centre" })
      .jpeg({ quality: 85 })
      .toBuffer();
    FOTO_CACHE.set(url, buf);
    return buf;
  } catch {
    return null;
  }
}

// Desenha a foto do aluno no PDF com moldura circular premium
function renderFotoAluno(doc, fotoBuffer, cx, cy, radius) {
  if (!fotoBuffer) return;
  try {
    // Salva o estado gráfico
    doc.save();

    // Clipping circular
    doc.circle(cx, cy, radius).clip();

    // Renderiza a imagem dentro do clip
    const size = radius * 2;
    doc.image(fotoBuffer, cx - radius, cy - radius, { width: size, height: size });

    // Restaura estado antes do clip
    doc.restore();

    // Borda externa do círculo — anel branco
    doc.circle(cx, cy, radius + 1.5)
      .lineWidth(3)
      .strokeColor("#ffffff")
      .stroke();

    // Borda externa do círculo — anel escuro
    doc.circle(cx, cy, radius + 3)
      .lineWidth(1.2)
      .strokeColor("#1a1a2e")
      .stroke();
  } catch (e) {
    // Silencia erros de renderização de foto
    console.warn("[gabaritoPdf] Erro ao renderizar foto:", e.message);
  }
}

// ─── Geração do PDF OMR ─────────────────────────────────────────────────────

async function resolverConfigAvaliacaoPdf(escolaId, body = {}) {
  let {
    formato_questoes,
    questoes_ce,
    penalidade_ce,
    avaliacao_id,
    num_questoes,
    num_alternativas,
  } = body;

  if (avaliacao_id && formato_questoes === undefined) {
    try {
      const [[av]] = await pool.query(
        `SELECT formato_questoes, questoes_ce, penalidade_ce, num_questoes, num_alternativas
         FROM gabarito_avaliacoes WHERE id = ? AND escola_id = ?`,
        [avaliacao_id, escolaId]
      );
      if (av) {
        formato_questoes = av.formato_questoes;
        questoes_ce = av.questoes_ce;
        penalidade_ce = av.penalidade_ce;
        if (!num_questoes) num_questoes = av.num_questoes;
        if (!num_alternativas) num_alternativas = av.num_alternativas;
      }
    } catch { /* fallback silencioso */ }
  }

  return {
    formatoQuestoes: formato_questoes || "multipla_escolha",
    questoesCe: questoes_ce || null,
    penalidadeCe: penalidade_ce || 0,
    avaliacaoId: avaliacao_id || null,
    numQuestoes: num_questoes || 25,
    numAlternativas: num_alternativas || 4,
  };
}

async function gerarPdfGabarito(res, {
  escola,
  descricao,
  modelo,
  numQuestoes,
  numAlternativas,
  formatoQuestoes = "multipla_escolha",
  questoesCe = null,
  penalidadeCe = 0,
  avaliacaoId = null,
  alunos,
  turma,
}) {
  const nQ = Number(numQuestoes) || 25;
  const fmtNorm = normalizarConfigFormato({
    formato_questoes: formatoQuestoes,
    questoes_ce: questoesCe,
    penalidade_ce: penalidadeCe,
    num_questoes: nQ,
  });

  const nA = fmtNorm.formato === "certo_errado" ? 2 : (Number(numAlternativas) || 4);
  const letras = fmtNorm.formato === "certo_errado" ? "CE" : "ABCDEFGH".slice(0, nA);
  const nomeEscola = (escola.apelido || escola.nome || "ESCOLA").toUpperCase();
  // nomeTurma global (fallback) — será sobrescrito por aluno.turmaNome quando disponível
  const nomeTurmaGlobal = (turma?.turma || "").toUpperCase();

  const doc = new PDFDocument({
    size: "A4",
    margins: { top: 40, bottom: 40, left: 40, right: 40 },
    bufferPages: true,
  });

  const safeTitle = (descricao || "gabarito").replace(/[^a-zA-Z0-9_-]/g, "_");
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${safeTitle}.pdf"`);
  doc.pipe(res);

  // Limpa o cache de fotos entre gerações de PDF
  FOTO_CACHE.clear();

  for (let i = 0; i < alunos.length; i++) {
    if (i > 0) doc.addPage();
    const aluno = alunos[i];
    const codigo = String(aluno.matricula || aluno.codigo || "000000");
    const nomeAluno = (aluno.nome || aluno.estudante || "—").toUpperCase();

    // Turma individual do aluno (multi-turma) ou fallback global (turma única)
    const nomeTurma = (aluno.turmaNome || nomeTurmaGlobal).toUpperCase();
    const turmaId = aluno.turma_id || turma?.id || "";

    // Busca foto do aluno (com LGPD: só se tiver consentimento)
    const fotoBuffer = await buscarFotoBuffer(aluno.foto_url || null);

    // Gerar QR Code com dados do aluno + metadados compactos do formato OMR
    const qrData = {
      c: codigo,                                            // código do aluno
      t: turmaId,                                           // ID da turma DO ALUNO
      e: escola.id || "",                                   // ID da escola
      a: String(descricao || "AVALIACAO").slice(0, 36),     // título compacto (preserva baixa densidade do QR)
      q: nQ,                                                // total de questões
      n: nA,                                                // total de colunas de bolhas
      ...(avaliacaoId ? { v: Number(avaliacaoId) } : {}),
      ...(fmtNorm.formato === "certo_errado" ? { f: "CE" } : {}),
      ...(fmtNorm.formato === "mista" ? { f: "M", ce: fmtNorm.ceCompacto } : {}),
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
      formato: fmtNorm.formato,
      ceSet: fmtNorm.ceSet,
      penalidadeAtiva: fmtNorm.penalidadeAtiva,
      qrBuffer,
      fotoBuffer,
    });
  }

  doc.end();
}

function renderPaginaOMR(doc, opts) {
  const {
    nomeEscola, descricao, nomeTurma, nomeAluno, codigoAluno,
    nQ, nA, letras, modelo,
    formato = "multipla_escolha",
    ceSet = new Set(),
    penalidadeAtiva = false,
    qrBuffer, fotoBuffer,
  } = opts;

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
  // 2b. FOTO DO ALUNO — posicionada à esquerda do QR Code, com moldura premium
  // ═══════════════════════════════════════════════════════════════════════════
  const FOTO_RADIUS = 28;  // raio do círculo da foto (pt)
  const fotoAreaW = fotoBuffer ? FOTO_RADIUS * 2 + 16 : 0; // largura reservada para a foto
  const fotoX = qrX - fotoAreaW - 8; // posicionada à esquerda do QR
  const fotoCX = fotoBuffer ? fotoX + FOTO_RADIUS + 4 : 0;
  const fotoCY = qrY + QR_SIZE / 2;  // centralizada verticalmente com o QR

  if (fotoBuffer) {
    renderFotoAluno(doc, fotoBuffer, fotoCX, fotoCY, FOTO_RADIUS);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. CABEÇALHO (nome da escola + título)
  // ═══════════════════════════════════════════════════════════════════════════
  // headerW descontando QR + foto (se houver)
  const headerW = contentW - QR_SIZE - fotoAreaW - 28;

  // Nome da escola
  doc.font("Helvetica-Bold").fontSize(13).fillColor("#000");
  doc.text(nomeEscola, mL, y, { width: headerW, align: "left" });
  y += 18;

  // Título da avaliação
  doc.font("Helvetica-Bold").fontSize(10).fillColor("#333");
  doc.text(descricao, mL, y, { width: headerW, align: "left" });
  y += 16;

  // Linha divisória (não invade a área do QR Code nem da foto)
  const linhaFimX = fotoBuffer ? fotoX - 6 : qrX - 10;
  doc.moveTo(mL, y).lineTo(linhaFimX, y).strokeColor("#000").lineWidth(1).stroke();
  y += 8;

  // ═══════════════════════════════════════════════════════════════════════════
  // 4. DADOS DO ALUNO
  //    Linha 1 — ALUNO (nome completo)
  //    Linha 2 — RE  |  TURMA  |  DATA  (mesma linha)
  //    Linha 3 — ASSINATURA (largura total até foto/QR)
  // ═══════════════════════════════════════════════════════════════════════════

  // Posições das três colunas da linha 2
  const colReX    = mL;           // RE (esquerda)
  const colTurmaX = mL + 118;     // TURMA (meio)
  const colDataX  = mL + 240;     // DATA (direita) — ~1cm mais próximo de TURMA

  // Linha 1: ALUNO
  doc.font("Helvetica-Bold").fontSize(8).fillColor("#444");
  doc.text("ALUNO:", colReX, y, { continued: false });
  doc.font("Helvetica").fontSize(9).fillColor("#000");
  doc.text(nomeAluno, colReX + 42, y, { width: linhaFimX - colReX - 42 });
  y += 16;

  // Linha 2: RE | TURMA | DATA
  const linha2Y = y;

  // RE
  doc.font("Helvetica-Bold").fontSize(8).fillColor("#444");
  doc.text("RE:", colReX, linha2Y);
  doc.font("Helvetica-Bold").fontSize(11).fillColor("#000");
  doc.text(codigoAluno, colReX + 22, linha2Y - 1, { width: colTurmaX - colReX - 26 });

  // TURMA
  doc.font("Helvetica-Bold").fontSize(8).fillColor("#444");
  doc.text("TURMA:", colTurmaX, linha2Y);
  doc.font("Helvetica").fontSize(9).fillColor("#000");
  doc.text(nomeTurma, colTurmaX + 44, linha2Y, {
    width: colDataX - colTurmaX - 48,
    ellipsis: true,
  });

  // DATA — lineBreak: false garante que fica em UMA única linha
  doc.font("Helvetica-Bold").fontSize(8).fillColor("#444");
  doc.text("DATA:", colDataX, linha2Y, { lineBreak: false });
  doc.font("Helvetica").fontSize(9).fillColor("#444");
  doc.text("  __/__/____", colDataX + 34, linha2Y, { lineBreak: false });
  y += 16;

  // Linha 3: ASSINATURA (ocupa largura total até linhaFimX)
  const linha3Y = y;
  doc.font("Helvetica-Bold").fontSize(8).fillColor("#444");
  doc.text("ASSINATURA:", colReX, linha3Y);
  doc.save();
  doc.moveTo(colReX + 62, linha3Y + 9)
    .lineTo(linhaFimX, linha3Y + 9)
    .dash(2, { space: 2 })
    .strokeColor("#999")
    .lineWidth(0.5)
    .stroke();
  doc.restore();
  y += 16;

  // Linha divisória
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
  // Se houver questões C/E, exibe legenda na mesma linha horizontal (preserva startY ≈ 184pt exato para o OMR!)
  const exemploY = y;
  const temCE = ceSet && ceSet.size > 0;
  const centroX = mL + contentW / 2;
  const exemploStartX = temCE ? mL + 8 : (centroX - 100);

  doc.font("Helvetica").fontSize(6.5).fillColor("#666");
  doc.text("Exemplo:", exemploStartX, exemploY, { lineBreak: false });
  doc.text("errado", exemploStartX + 44, exemploY, { lineBreak: false });
  doc.text("→", exemploStartX + 68, exemploY, { lineBreak: false });

  // Bolha errada (com X dentro)
  const exX1 = exemploStartX + 84;
  const exCY = exemploY + 4;
  doc.circle(exX1, exCY, 5).lineWidth(0.8).strokeColor("#000").stroke();
  doc.font("Helvetica").fontSize(5).fillColor("#000");
  doc.text("✕", exX1 - 2.5, exemploY + 1, { lineBreak: false });

  // Espaço e "correto →"
  doc.font("Helvetica").fontSize(6.5).fillColor("#666");
  doc.text("correto", exX1 + 18, exemploY, { lineBreak: false });
  doc.text("→", exX1 + 44, exemploY, { lineBreak: false });

  // Bolha correta (preenchida)
  const exX2 = exX1 + 58;
  doc.circle(exX2, exCY, 5).fill("#000");

  if (temCE) {
    const legendaCE = penalidadeAtiva
      ? "ITENS C/E: C = Certo · E = Errado  |  ATENÇÃO: 1 marcação errada em C/E anula 1 certa (em branco = 0)"
      : "ITENS C/E: C = Certo · E = Errado";
    doc.font("Helvetica-Bold").fontSize(6).fillColor("#222");
    doc.text(legendaCE, exX2 + 16, exemploY + 0.5, {
      width: (pageW - mR) - (exX2 + 16),
      align: "right",
      lineBreak: false,
    });
  }

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
    formato,
    ceSet,
    pageH,
    mBottom: doc.page.margins.bottom,
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 7. RODAPÉ
  // ═══════════════════════════════════════════════════════════════════════════
  const footerY = pageH - doc.page.margins.bottom - 20;
  doc.moveTo(mL, footerY).lineTo(pageW - mR, footerY).strokeColor("#ccc").lineWidth(0.3).stroke();

  const resumoFormato = formato === "certo_errado"
    ? `Certo/Errado (C/E)${penalidadeAtiva ? " · c/ fator de correção" : ""}`
    : formato === "mista"
      ? `Prova Mista (${ceSet.size} C/E + ${nQ - ceSet.size} Múlt. Escolha A-${letras[nA - 1]})${penalidadeAtiva ? " · c/ fator C/E" : ""}`
      : `${nA} alternativas`;

  doc.font("Helvetica").fontSize(5.5).fillColor("#aaa");
  doc.text(
    `EDUCA.MELHOR — Sistema de Correção Automática — ${nQ} questões · ${resumoFormato} · Modelo: ${modelo} — Gerado em ${new Date().toLocaleDateString("pt-BR")}`,
    mL, footerY + 4, { width: contentW, align: "center" }
  );
}

function renderGradeOMR(doc, { startX, startY, contentW, nQ, nA, letras, formato = "multipla_escolha", ceSet = new Set(), pageH, mBottom }) {
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

    const qStart = col * questoesPorColuna + 1;
    const qEnd = Math.min(qStart + questoesPorColuna - 1, nQ);

    // Verificar composição desta coluna (só C/E, só ME ou Mista)
    let countCECol = 0;
    const totalCol = Math.max(0, qEnd - qStart + 1);
    for (let q = qStart; q <= qEnd; q++) {
      if (ceSet && ceSet.has(q)) countCECol++;
    }
    const colSomenteCE = totalCol > 0 && countCECol === totalCol;

    // ── Cabeçalho da coluna: Nº | C | E (se coluna 100% C/E) ou Nº | A | B | C | D ──
    doc.font("Helvetica-Bold").fontSize(hdrFontSize).fillColor("#000");
    doc.text("Nº", colX, y + 2, { width: numLabelW, align: "center" });

    if (colSomenteCE) {
      const letrasCE = "CE";
      for (let a = 0; a < 2; a++) {
        const bx = colX + numLabelW + a * bubbleGapX + bubbleGapX / 2;
        doc.text(letrasCE[a], bx - 5, y + 2, { width: 10, align: "center" });
      }
    } else {
      for (let a = 0; a < nA; a++) {
        const bx = colX + numLabelW + a * bubbleGapX + bubbleGapX / 2;
        doc.text(letras[a], bx - 5, y + 2, { width: 10, align: "center" });
      }
    }

    // Linha abaixo do cabeçalho
    y += 14;
    doc.moveTo(colX, y).lineTo(colX + numLabelW + nA * bubbleGapX + 8, y)
      .strokeColor("#000").lineWidth(0.6).stroke();
    y += 4;

    // ── Questões ──
    for (let q = qStart; q <= qEnd; q++) {
      const isRowCE = formato === "certo_errado" || (ceSet && ceSet.has(q));

      // Fundo zebrado (para legibilidade)
      if ((q - qStart) % 2 === 0) {
        doc.rect(colX - 2, y - 2, numLabelW + nA * bubbleGapX + 12, rowHeight)
          .fill("#f5f5f5").fillColor("#000");
      }

      // Número da questão (centralizado verticalmente na linha)
      doc.font("Helvetica-Bold").fontSize(qFontSize).fillColor("#000");
      doc.text(String(q).padStart(2, "0"), colX, y + (rowHeight - qFontSize) / 2, { width: numLabelW, align: "center" });

      if (isRowCE) {
        // Questão Certo/Errado: APENAS 2 bolhas vazias nas posições matriciais a=0 e a=1
        const letrasCE = ["C", "E"];
        const mostrarRotuloInline = formato === "mista" && !colSomenteCE && bubbleGapX >= 20;
        for (let a = 0; a < 2; a++) {
          const cx = colX + numLabelW + a * bubbleGapX + bubbleGapX / 2;
          const cy = y + rowHeight / 2;

          doc.circle(cx, cy, bubbleRadius)
            .lineWidth(1.0)
            .strokeColor("#555")
            .stroke();

          // Rótulo externo "C" e "E" fora do círculo (preserva interior 100% branco p/ mediana OMR)
          if (mostrarRotuloInline) {
            const lblSize = bubbleGapX >= 26 ? 6.2 : 5.5;
            doc.font("Helvetica-Bold").fontSize(lblSize).fillColor("#333");
            doc.text(letrasCE[a], cx + bubbleRadius + 1.8, cy - lblSize / 2 - 0.3, {
              lineBreak: false,
            });
          }
        }
      } else {
        // Questão Múltipla Escolha: nA bolhas vazias normais
        for (let a = 0; a < nA; a++) {
          const cx = colX + numLabelW + a * bubbleGapX + bubbleGapX / 2;
          const cy = y + rowHeight / 2;

          doc.circle(cx, cy, bubbleRadius)
            .lineWidth(1.0)
            .strokeColor("#555")
            .stroke();
        }
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
    const { descricao, modelo } = req.body;
    const cfg = await resolverConfigAvaliacaoPdf(escola_id, req.body);

    const turma = await buscarTurma(turmaId, escola_id);
    if (!turma) return res.status(404).json({ error: "Turma não encontrada." });

    const alunos = await buscarAlunosDaTurma(turmaId, escola_id);
    if (alunos.length === 0) return res.status(404).json({ error: "Nenhum aluno ativo nessa turma." });

    const escola = await buscarEscola(escola_id);

    await gerarPdfGabarito(res, {
      escola,
      descricao: descricao || "AVALIAÇÃO",
      modelo: modelo || "padrao",
      ...cfg,
      alunos,
      turma,
    });
  } catch (err) {
    console.error("Erro ao gerar gabarito por turma:", err);
    if (!res.headersSent) res.status(500).json({ error: "Erro ao gerar gabarito." });
  }
});

// POST /api/gabarito-pdf/gerar-turmas
// Gera um único PDF com alunos de MÚLTIPLAS turmas selecionadas
router.post("/gerar-turmas", async (req, res) => {
  try {
    const { escola_id } = req.user;
    const { turma_ids, descricao, modelo } = req.body;
    const cfg = await resolverConfigAvaliacaoPdf(escola_id, req.body);

    if (!turma_ids || !Array.isArray(turma_ids) || turma_ids.length === 0) {
      return res.status(400).json({ error: "Selecione pelo menos uma turma." });
    }

    const escola = await buscarEscola(escola_id);
    let todosAlunos = [];

    for (const tId of turma_ids) {
      const turma = await buscarTurma(tId, escola_id);
      if (!turma) continue;

      const alunos = await buscarAlunosDaTurma(tId, escola_id);
      // Cada aluno carrega SUA turma individual (nome + id)
      todosAlunos.push(...alunos.map((a) => ({ ...a, turmaNome: turma.turma, turma_id: turma.id })));
    }

    if (todosAlunos.length === 0) {
      return res.status(404).json({ error: "Nenhum aluno ativo nas turmas selecionadas." });
    }

    await gerarPdfGabarito(res, {
      escola,
      descricao: descricao || "AVALIAÇÃO",
      modelo: modelo || "padrao",
      ...cfg,
      alunos: todosAlunos,
      turma: { turma: "", id: null }, // global vazio; cada aluno tem sua turma
    });
  } catch (err) {
    console.error("Erro ao gerar gabarito por múltiplas turmas:", err);
    if (!res.headersSent) res.status(500).json({ error: "Erro ao gerar gabarito." });
  }
});

// POST /api/gabarito-pdf/gerar-turno/:turno
router.post("/gerar-turno/:turno", async (req, res) => {
  try {
    const { turno } = req.params;
    const { escola_id } = req.user;
    const { descricao, modelo } = req.body;
    const cfg = await resolverConfigAvaliacaoPdf(escola_id, req.body);
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
      todosAlunos.push(...alunos.map((a) => ({ ...a, turmaNome: t.turma, turma_id: t.id })));
    }

    if (todosAlunos.length === 0) return res.status(404).json({ error: "Nenhum aluno ativo nesse turno." });

    await gerarPdfGabarito(res, {
      escola,
      descricao: descricao || "AVALIAÇÃO",
      modelo: modelo || "padrao",
      ...cfg,
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
    const { aluno_codigo, turma_id, descricao, modelo } = req.body;
    const cfg = await resolverConfigAvaliacaoPdf(escola_id, req.body);

    if (!aluno_codigo) return res.status(400).json({ error: "Código do aluno é obrigatório." });

    const [escola, alunoRow] = await Promise.all([
      buscarEscola(escola_id),
      pool.query(
        `SELECT a.id, a.estudante AS nome, a.codigo AS matricula,
                a.foto,
                CASE
                  WHEN a.foto LIKE 'http%' THEN a.foto
                  ELSE CONCAT(?, 'uploads/', COALESCE(e.apelido, CONCAT('escola_', a.escola_id)), '/alunos/', a.codigo, '.jpg')
                END AS foto_url,
                COALESCE(
                  (SELECT MAX(CASE WHEN ra.consentimento_imagem = 1 AND ra.ativo = 1 THEN 1 ELSE 0 END)
                     FROM responsaveis_alunos ra
                    WHERE ra.aluno_id = a.id AND ra.escola_id = a.escola_id),
                  0
                ) AS consentimento_imagem
         FROM alunos a
         LEFT JOIN escolas e ON e.id = a.escola_id
         WHERE a.codigo = ? AND a.escola_id = ?`,
        [SPACES_PUBLIC_BASE, aluno_codigo, escola_id]
      ),
    ]);

    const rows = alunoRow[0];
    if (!rows || rows.length === 0) return res.status(404).json({ error: "Aluno não encontrado." });

    const alunoRaw = rows[0];
    const aluno = {
      ...alunoRaw,
      foto_url: Number(alunoRaw.consentimento_imagem) === 1 ? alunoRaw.foto_url : null,
    };

    const turma = turma_id ? await buscarTurma(turma_id, escola_id) : { turma: "", id: null };

    await gerarPdfGabarito(res, {
      escola,
      descricao: descricao || "AVALIAÇÃO",
      modelo: modelo || "padrao",
      ...cfg,
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
