// routes/listas-impressao.js
// ============================================================================
// Gera PDF das listas de impressão (Assinatura Prova, Chamada, etc.)
// Cabeçalho institucional idêntico ao Relatório de Registros Disciplinares.
// ============================================================================

import { Router } from "express";
import PDFDocument from "pdfkit";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";
import pool from "../db.js";

const router = Router();
const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Helpers ────────────────────────────────────────────────────────────
function anoLetivoPadrao() {
  const hoje = new Date();
  const mes = hoje.getMonth() + 1;
  return mes <= 1 ? hoje.getFullYear() - 1 : hoje.getFullYear();
}

function fmtDataBr(iso) {
  if (!iso) return "—";
  // Evita problema de fuso: split direto na string YYYY-MM-DD
  const parts = String(iso).split("-");
  if (parts.length === 3) {
    return `${parts[2]}/${parts[1]}/${parts[0]}`;
  }
  return String(iso);
}

// ══════════════════════════════════════════════════════════════════════════
// Rota POR TURNO: GET /api/listas-impressao/por-turno/:turno
// Gera PDF unificado com TODAS as turmas de um turno.
// Cada turma inicia em nova página com cabeçalho institucional completo.
// ══════════════════════════════════════════════════════════════════════════
router.get("/por-turno/:turno", async (req, res) => {
  try {
    const { escola_id } = req.user;
    const turnoParam = decodeURIComponent(req.params.turno);
    const {
      tipo = "assinatura_prova",
      titulo: tituloParam,
      data: dataParam,
      linhas: linhasParam,
    } = req.query;

    const anoLetivo = anoLetivoPadrao();

    // ── Dados da escola ──
    const [[escola]] = await pool.query(
      "SELECT id, nome, apelido, endereco, cidade, estado FROM escolas WHERE id = ?",
      [escola_id]
    );

    // ── Todas as turmas do turno ──
    const [turmasRaw] = await pool.query(
      "SELECT id, nome, turno, ano, serie FROM turmas WHERE escola_id = ? AND ano = ? AND turno = ? ORDER BY nome ASC",
      [escola_id, anoLetivo, turnoParam]
    );
    if (!turmasRaw.length) return res.status(404).json({ error: "Nenhuma turma encontrada para este turno." });

    // ── Buscar alunos de cada turma ──
    const turmasComAlunos = [];
    for (const turma of turmasRaw) {
      const [alunos] = await pool.query(
        `SELECT a.id, a.codigo, a.estudante
         FROM matriculas m
         INNER JOIN alunos a ON a.id = m.aluno_id
         WHERE m.turma_id = ? AND m.escola_id = ? AND m.ano_letivo = ? AND m.status = 'ativo'
         ORDER BY a.estudante ASC`,
        [turma.id, escola_id, anoLetivo]
      );
      turmasComAlunos.push({ turma, alunos });
    }

    const TITULOS_PADRAO = {
      assinatura_prova: "LISTA DE ASSINATURA — PROVA",
      chamada: "LISTA DE CHAMADA",
      assinatura_geral: "LISTA DE ASSINATURA — GERAL",
      branco: "LISTA EM BRANCO",
    };

    const titulo = tituloParam
      ? tituloParam.toUpperCase()
      : TITULOS_PADRAO[tipo] || "LISTA PARA IMPRESSÃO";

    const dataAplicacao = dataParam || new Date().toISOString().slice(0, 10);
    const dataFormatada = fmtDataBr(dataAplicacao);
    const qtdLinhas = Number(linhasParam) || 30;

    // ── Logos ──
    const logoLeft = join(__dirname, "..", "assets", "images", "brasao-gdf.png");
    const logoRight = join(__dirname, "..", "assets", "images", "logo-escola-right.png");
    const hasLogoLeft = existsSync(logoLeft);
    const hasLogoRight = existsSync(logoRight);

    // ══════════════════════════════════════════════════════════════════
    // GERAR PDF UNIFICADO
    // ══════════════════════════════════════════════════════════════════
    const L = 40;
    const R = 40;
    const PW = 595.28 - L - R;
    const PAGE_H = 841.89;
    const FOOTER_Y = PAGE_H - 25;
    const MAX_Y = FOOTER_Y - 15;

    const doc = new PDFDocument({
      size: "A4",
      margins: { top: 30, bottom: 0, left: L, right: R },
      autoFirstPage: false,
      info: {
        Title: `${titulo} — ${turnoParam} (Todas as turmas)`,
        Author: "EDUCA.MELHOR — Sistema Educacional",
        Subject: titulo,
      },
    });

    res.setHeader("Content-Type", "application/pdf");
    const nomeArquivo = `lista_${tipo}_${turnoParam.replace(/\s+/g, "_")}_todas_turmas.pdf`;
    res.setHeader("Content-Disposition", `inline; filename="${nomeArquivo}"`);

    const pdfChunks = [];
    const { PassThrough } = await import("stream");
    const passThrough = new PassThrough();
    passThrough.on("data", (chunk) => pdfChunks.push(chunk));
    doc.pipe(passThrough);

    let pageNum = 0;

    // ── Cores ──
    const COR_AZUL = "#1e3a5f";
    const COR_DOURADO = "#b8860b";
    const COR_CINZA = "#555";

    // ── Funções auxiliares ──
    function drawFooterTurno(turmaLabel) {
      doc
        .font("Helvetica")
        .fontSize(6.5)
        .fillColor("#aaa")
        .text(
          `${titulo} • ${turmaLabel} • ${turnoParam} • Documento gerado pelo EDUCA.MELHOR • Página ${pageNum}`,
          L,
          FOOTER_Y,
          { width: PW, align: "center", lineBreak: false }
        );
    }

    function ensureSpaceTurno(needed, turmaLabel) {
      if (doc.y + needed > MAX_Y) {
        drawFooterTurno(turmaLabel);
        doc.addPage();
        pageNum++;
        doc.y = 30;
      }
    }

    // ══════════════════════════════════════════════════════════════════
    // CAPA DO TURNO (primeira página premium)
    // ══════════════════════════════════════════════════════════════════
    doc.addPage();
    pageNum++;

    // Fundo decorativo gradiente simulado
    doc.rect(0, 0, 595.28, 841.89).fill("#f8fafc");
    // Barra superior
    doc.rect(0, 0, 595.28, 6).fill(COR_DOURADO);
    doc.rect(0, 6, 595.28, 3).fill(COR_AZUL);

    // Logos centralizados
    const logoSize = 72;
    if (hasLogoLeft) {
      doc.image(logoLeft, 595.28 / 2 - logoSize - 30, 80, { width: logoSize, height: logoSize });
    }
    if (hasLogoRight) {
      doc.image(logoRight, 595.28 / 2 + 30, 80, { width: logoSize, height: logoSize });
    }

    // Textos da capa
    let capY = 175;
    doc.font("Helvetica-Bold").fontSize(11).fillColor(COR_AZUL)
      .text("SECRETARIA DE ESTADO DE EDUCAÇÃO DO DISTRITO FEDERAL", 0, capY, { width: 595.28, align: "center" });
    capY += 16;
    doc.font("Helvetica-Bold").fontSize(10).fillColor(COR_AZUL)
      .text(`COORDENAÇÃO REGIONAL DE ENSINO DE ${(escola?.cidade || "PLANALTINA").toUpperCase()}`, 0, capY, { width: 595.28, align: "center" });
    capY += 16;
    const escolaNomeCapa = escola?.apelido ? `${escola.nome} — ${escola.apelido}` : (escola?.nome || "");
    doc.font("Helvetica-Bold").fontSize(11).fillColor(COR_AZUL)
      .text(escolaNomeCapa.toUpperCase(), 0, capY, { width: 595.28, align: "center" });
    capY += 14;
    doc.font("Helvetica").fontSize(8).fillColor(COR_CINZA)
      .text(escola?.endereco || "", 0, capY, { width: 595.28, align: "center" });

    // Linhas decorativas
    capY += 20;
    doc.moveTo(120, capY).lineTo(595.28 - 120, capY).strokeColor(COR_DOURADO).lineWidth(2.5).stroke();
    capY += 5;
    doc.moveTo(120, capY).lineTo(595.28 - 120, capY).strokeColor(COR_AZUL).lineWidth(1).stroke();

    // Título principal
    capY += 35;
    doc.font("Helvetica-Bold").fontSize(22).fillColor(COR_AZUL)
      .text(titulo, 0, capY, { width: 595.28, align: "center" });

    // Badge turno
    capY += 45;
    const badgeW = 240;
    const badgeH = 40;
    const badgeX = (595.28 - badgeW) / 2;
    doc.roundedRect(badgeX, capY, badgeW, badgeH, 8).fill(COR_AZUL);
    doc.font("Helvetica-Bold").fontSize(16).fillColor("#fff")
      .text(`TURNO ${turnoParam.toUpperCase()}`, badgeX, capY + 11, { width: badgeW, align: "center" });

    // Resumo
    capY += badgeH + 40;

    const totalAlunos = turmasComAlunos.reduce((acc, t) => acc + t.alunos.length, 0);

    // Card de resumo
    const cardW = 360;
    const cardX = (595.28 - cardW) / 2;
    const cardH = 110;
    doc.roundedRect(cardX, capY, cardW, cardH, 6).fill("#f0f4ff");
    doc.roundedRect(cardX, capY, cardW, cardH, 6).strokeColor("#c7d2fe").lineWidth(0.8).stroke();

    doc.font("Helvetica-Bold").fontSize(10).fillColor(COR_AZUL)
      .text("RESUMO DO TURNO", cardX, capY + 12, { width: cardW, align: "center" });

    const resumoY = capY + 32;
    const resumoItems = [
      { label: "Turmas:", value: `${turmasComAlunos.length} turma(s)` },
      { label: "Total de Alunos:", value: `${totalAlunos} aluno(s)` },
      { label: "Data:", value: dataFormatada },
      { label: "Ano Letivo:", value: String(anoLetivo) },
    ];

    resumoItems.forEach((item, i) => {
      const ry = resumoY + i * 17;
      doc.font("Helvetica-Bold").fontSize(9).fillColor(COR_AZUL)
        .text(item.label, cardX + 40, ry, { width: 130, lineBreak: false });
      doc.font("Helvetica").fontSize(9).fillColor("#334155")
        .text(item.value, cardX + 175, ry, { width: 160, lineBreak: false });
    });

    // Lista de turmas no resumo
    capY += cardH + 25;
    doc.font("Helvetica-Bold").fontSize(9).fillColor(COR_AZUL)
      .text("TURMAS INCLUÍDAS:", 0, capY, { width: 595.28, align: "center" });
    capY += 16;

    // Grid de turmas na capa
    const chipW = 90;
    const chipH = 22;
    const chipGap = 6;
    const maxPerRow = Math.floor((cardW + chipGap) / (chipW + chipGap));
    turmasComAlunos.forEach((item, i) => {
      const row = Math.floor(i / maxPerRow);
      const col = i % maxPerRow;
      const totalRowItems = Math.min(maxPerRow, turmasComAlunos.length - row * maxPerRow);
      const rowW = totalRowItems * chipW + (totalRowItems - 1) * chipGap;
      const rowX = (595.28 - rowW) / 2;
      const cx = rowX + col * (chipW + chipGap);
      const cy = capY + row * (chipH + chipGap);

      doc.roundedRect(cx, cy, chipW, chipH, 4).fill("#e0e7ff");
      doc.font("Helvetica-Bold").fontSize(8).fillColor(COR_AZUL)
        .text(item.turma.nome, cx, cy + 7, { width: chipW, align: "center", lineBreak: false });
    });

    // Barra inferior capa
    doc.rect(0, 841.89 - 9, 595.28, 3).fill(COR_AZUL);
    doc.rect(0, 841.89 - 6, 595.28, 6).fill(COR_DOURADO);

    drawFooterTurno("CAPA");

    // ══════════════════════════════════════════════════════════════════
    // PÁGINAS POR TURMA
    // ══════════════════════════════════════════════════════════════════
    for (let t = 0; t < turmasComAlunos.length; t++) {
      const { turma, alunos } = turmasComAlunos[t];

      // Nova página para cada turma
      doc.addPage();
      pageNum++;

      // ── Cabeçalho institucional ──
      const headerTop = doc.y;
      const hLogoSize = 58;

      if (hasLogoLeft) {
        doc.image(logoLeft, L, headerTop, { width: hLogoSize, height: hLogoSize });
      }
      if (hasLogoRight) {
        doc.image(logoRight, L + PW - hLogoSize, headerTop, { width: hLogoSize, height: hLogoSize });
      }

      const hx = L + hLogoSize + 8;
      const hw = PW - (hLogoSize + 8) * 2;

      doc.font("Helvetica-Bold").fontSize(9).fillColor(COR_AZUL)
        .text("SECRETARIA DE ESTADO DE EDUCAÇÃO DO DISTRITO FEDERAL", hx, headerTop + 4, { width: hw, align: "center" });
      doc.font("Helvetica-Bold").fontSize(8.5).fillColor(COR_AZUL)
        .text(`COORDENAÇÃO REGIONAL DE ENSINO DE ${(escola?.cidade || "PLANALTINA").toUpperCase()}`, hx, doc.y + 1, { width: hw, align: "center" });
      const nomeCompleto = escola?.apelido ? `${escola.nome} — ${escola.apelido}` : (escola?.nome || "");
      doc.font("Helvetica-Bold").fontSize(9).fillColor(COR_AZUL)
        .text(nomeCompleto.toUpperCase(), hx, doc.y + 1, { width: hw, align: "center" });
      doc.font("Helvetica").fontSize(7.5).fillColor(COR_CINZA)
        .text(escola?.endereco || "", hx, doc.y + 1, { width: hw, align: "center" });

      doc.y = headerTop + hLogoSize + 4;
      doc.moveTo(L, doc.y).lineTo(L + PW, doc.y).strokeColor(COR_DOURADO).lineWidth(2).stroke();
      doc.y += 3;
      doc.moveTo(L, doc.y).lineTo(L + PW, doc.y).strokeColor(COR_AZUL).lineWidth(0.8).stroke();
      doc.y += 8;

      // ── Título ──
      doc.font("Helvetica-Bold").fontSize(14).fillColor(COR_AZUL)
        .text(titulo, L, doc.y, { width: PW, align: "center" });
      doc.y += 6;
      doc.moveTo(L, doc.y).lineTo(L + PW, doc.y).strokeColor("#ccc").lineWidth(0.5).stroke();
      doc.y += 6;

      // ── Badge da turma (destaque premium) ──
      const turBadgeY = doc.y;
      const turBadgeH = 22;
      doc.roundedRect(L, turBadgeY, PW, turBadgeH, 4).fill(COR_AZUL);
      // Indicador de posição
      doc.font("Helvetica").fontSize(7).fillColor("#94a3b8")
        .text(`TURMA ${t + 1} DE ${turmasComAlunos.length}`, L + 8, turBadgeY + 7, { width: 100, lineBreak: false });
      // Nome da turma centralizado
      doc.font("Helvetica-Bold").fontSize(10).fillColor("#fff")
        .text(turma.nome, L, turBadgeY + 5, { width: PW, align: "center", lineBreak: false });
      // Quantidade de alunos
      doc.font("Helvetica").fontSize(7).fillColor("#94a3b8")
        .text(`${alunos.length} aluno(s)`, L + PW - 108, turBadgeY + 7, { width: 100, align: "right", lineBreak: false });
      doc.y = turBadgeY + turBadgeH + 6;

      // ── Identificação da turma ──
      const infoY = doc.y;
      const infoH = 18;
      doc.roundedRect(L, infoY, PW, infoH, 3).fill("#f0f4ff");
      doc.roundedRect(L, infoY, PW, infoH, 3).strokeColor("#c7d2fe").lineWidth(0.5).stroke();

      const infoTextY = infoY + 5;
      const colW = PW / 5;
      const infoCols = [
        { label: "Turma:", value: turma.nome },
        { label: "Turno:", value: turma.turno },
        { label: "Ano Letivo:", value: String(anoLetivo) },
        { label: "Data:", value: dataFormatada },
        { label: "Total:", value: `${tipo === "branco" ? qtdLinhas : alunos.length} aluno(s)` },
      ];
      infoCols.forEach((col, i) => {
        const cx = L + colW * i + 6;
        doc.font("Helvetica-Bold").fontSize(7).fillColor(COR_AZUL)
          .text(col.label, cx, infoTextY, { width: colW - 12, lineBreak: false, continued: true });
        doc.font("Helvetica").fontSize(7).fillColor("#334155")
          .text(` ${col.value}`, { lineBreak: false });
      });
      doc.y = infoY + infoH + 8;

      // ══════════════════════════════════════════════════════════════
      // TABELA DE CONTEÚDO
      // ══════════════════════════════════════════════════════════════
      if (tipo === "assinatura_prova") {
        const COL_RE_W = 42;
        const COL_SIGN_W = 260;
        const COL_NOME_W = PW - COL_RE_W - COL_SIGN_W;
        const TH = 16;
        const TR = 22;

        const thY = doc.y;
        doc.rect(L, thY, PW, TH).fill(COR_AZUL);
        let tx = L;
        [
          { text: "RE", w: COL_RE_W, align: "center" },
          { text: "NOME DO ESTUDANTE", w: COL_NOME_W, align: "left" },
          { text: "ASSINATURA", w: COL_SIGN_W, align: "center" },
        ].forEach((col) => {
          doc.font("Helvetica-Bold").fontSize(8).fillColor("#fff")
            .text(col.text, tx + 4, thY + 4, { width: col.w - 8, align: col.align, lineBreak: false });
          tx += col.w;
        });
        doc.y = thY + TH;

        alunos.forEach((a, i) => {
          ensureSpaceTurno(TR + 2, turma.nome);
          const rowY = doc.y;
          if (i % 2 === 0) doc.rect(L, rowY, PW, TR).fill("#f8fafc");
          doc.moveTo(L, rowY + TR).lineTo(L + PW, rowY + TR).strokeColor("#cbd5e1").lineWidth(0.3).stroke();
          doc.moveTo(L + COL_RE_W, rowY).lineTo(L + COL_RE_W, rowY + TR).strokeColor("#cbd5e1").lineWidth(0.3).stroke();
          doc.moveTo(L + COL_RE_W + COL_NOME_W, rowY).lineTo(L + COL_RE_W + COL_NOME_W, rowY + TR).strokeColor("#cbd5e1").lineWidth(0.3).stroke();
          doc.font("Helvetica-Bold").fontSize(8).fillColor(COR_AZUL)
            .text(String(a.codigo || "—"), L + 2, rowY + 7, { width: COL_RE_W - 4, align: "center", lineBreak: false });
          doc.font("Helvetica").fontSize(8.5).fillColor("#1e293b")
            .text(a.estudante || "—", L + COL_RE_W + 6, rowY + 7, { width: COL_NOME_W - 12, lineBreak: false });
          doc.y = rowY + TR;
        });

        doc.y += 8;
        ensureSpaceTurno(60, turma.nome);
        const sigW = 200;
        const sigLineY = doc.y + 35;
        doc.moveTo(L + 10, sigLineY).lineTo(L + 10 + sigW, sigLineY).strokeColor("#334155").lineWidth(0.5).stroke();
        doc.font("Helvetica").fontSize(8).fillColor("#334155")
          .text("Aplicador(a)", L + 10, sigLineY + 3, { width: sigW, align: "center", lineBreak: false });
        doc.moveTo(L + PW - sigW - 10, sigLineY).lineTo(L + PW - 10, sigLineY).strokeColor("#334155").lineWidth(0.5).stroke();
        doc.font("Helvetica").fontSize(8).fillColor("#334155")
          .text("Coordenador(a)", L + PW - sigW - 10, sigLineY + 3, { width: sigW, align: "center", lineBreak: false });

      } else if (tipo === "chamada") {
        const COL_N_W = 28;
        const COL_P_W = 24;
        const COL_F_W = 24;
        const COL_OBS_W = 100;
        const COL_NOME_W = PW - COL_N_W - COL_P_W - COL_F_W - COL_OBS_W;
        const TH = 16;
        const TR = 18;

        const thY = doc.y;
        doc.rect(L, thY, PW, TH).fill(COR_AZUL);
        let tx = L;
        [
          { text: "Nº", w: COL_N_W, align: "center" },
          { text: "ESTUDANTE", w: COL_NOME_W, align: "left" },
          { text: "P", w: COL_P_W, align: "center" },
          { text: "F", w: COL_F_W, align: "center" },
          { text: "OBSERVAÇÃO", w: COL_OBS_W, align: "center" },
        ].forEach((col) => {
          doc.font("Helvetica-Bold").fontSize(7).fillColor("#fff")
            .text(col.text, tx + 2, thY + 5, { width: col.w - 4, align: col.align, lineBreak: false });
          tx += col.w;
        });
        doc.y = thY + TH;

        alunos.forEach((a, i) => {
          ensureSpaceTurno(TR + 2, turma.nome);
          const rowY = doc.y;
          if (i % 2 === 0) doc.rect(L, rowY, PW, TR).fill("#f8fafc");
          doc.moveTo(L, rowY + TR).lineTo(L + PW, rowY + TR).strokeColor("#cbd5e1").lineWidth(0.3).stroke();
          let bx = L + COL_N_W;
          [COL_NOME_W, COL_P_W, COL_F_W].forEach((w) => {
            doc.moveTo(bx, rowY).lineTo(bx, rowY + TR).strokeColor("#cbd5e1").lineWidth(0.3).stroke();
            bx += w;
          });
          doc.moveTo(bx, rowY).lineTo(bx, rowY + TR).strokeColor("#cbd5e1").lineWidth(0.3).stroke();
          doc.font("Helvetica").fontSize(8).fillColor("#334155")
            .text(String(i + 1), L + 1, rowY + 5, { width: COL_N_W - 2, align: "center", lineBreak: false });
          doc.font("Helvetica").fontSize(8.5).fillColor("#1e293b")
            .text(a.estudante || "—", L + COL_N_W + 4, rowY + 5, { width: COL_NOME_W - 8, lineBreak: false });
          doc.y = rowY + TR;
        });

        doc.y += 4;
        doc.font("Helvetica").fontSize(8).fillColor("#64748b")
          .text("Legenda: P = Presente | F = Falta", L, doc.y, { width: PW });

      } else if (tipo === "assinatura_geral") {
        const COL_N_W = 28;
        const COL_SIGN_W = 130;
        const COL_NOME_W = PW - COL_N_W - COL_SIGN_W * 2;
        const TH = 16;
        const TR = 22;

        const thY = doc.y;
        doc.rect(L, thY, PW, TH).fill(COR_AZUL);
        let tx = L;
        [
          { text: "Nº", w: COL_N_W, align: "center" },
          { text: "ESTUDANTE", w: COL_NOME_W, align: "left" },
          { text: "ASSINATURA ALUNO", w: COL_SIGN_W, align: "center" },
          { text: "ASSINATURA RESPONSÁVEL", w: COL_SIGN_W, align: "center" },
        ].forEach((col) => {
          doc.font("Helvetica-Bold").fontSize(7).fillColor("#fff")
            .text(col.text, tx + 2, thY + 5, { width: col.w - 4, align: col.align, lineBreak: false });
          tx += col.w;
        });
        doc.y = thY + TH;

        alunos.forEach((a, i) => {
          ensureSpaceTurno(TR + 2, turma.nome);
          const rowY = doc.y;
          if (i % 2 === 0) doc.rect(L, rowY, PW, TR).fill("#f8fafc");
          doc.moveTo(L, rowY + TR).lineTo(L + PW, rowY + TR).strokeColor("#cbd5e1").lineWidth(0.3).stroke();
          let bx = L + COL_N_W;
          doc.moveTo(bx, rowY).lineTo(bx, rowY + TR).strokeColor("#cbd5e1").lineWidth(0.3).stroke();
          bx += COL_NOME_W;
          doc.moveTo(bx, rowY).lineTo(bx, rowY + TR).strokeColor("#cbd5e1").lineWidth(0.3).stroke();
          bx += COL_SIGN_W;
          doc.moveTo(bx, rowY).lineTo(bx, rowY + TR).strokeColor("#cbd5e1").lineWidth(0.3).stroke();
          doc.font("Helvetica").fontSize(8).fillColor("#334155")
            .text(String(i + 1), L + 1, rowY + 7, { width: COL_N_W - 2, align: "center", lineBreak: false });
          doc.font("Helvetica").fontSize(8.5).fillColor("#1e293b")
            .text(a.estudante || "—", L + COL_N_W + 4, rowY + 7, { width: COL_NOME_W - 8, lineBreak: false });
          doc.y = rowY + TR;
        });

      } else if (tipo === "branco") {
        const COL_N_W = 28;
        const COL_OBS_W = 120;
        const COL_NOME_W = PW - COL_N_W - COL_OBS_W;
        const TH = 16;
        const TR = 20;

        const thY = doc.y;
        doc.rect(L, thY, PW, TH).fill(COR_AZUL);
        let tx = L;
        [
          { text: "Nº", w: COL_N_W, align: "center" },
          { text: "NOME", w: COL_NOME_W, align: "left" },
          { text: "OBSERVAÇÃO", w: COL_OBS_W, align: "center" },
        ].forEach((col) => {
          doc.font("Helvetica-Bold").fontSize(7).fillColor("#fff")
            .text(col.text, tx + 2, thY + 5, { width: col.w - 4, align: col.align, lineBreak: false });
          tx += col.w;
        });
        doc.y = thY + TH;

        for (let n = 1; n <= qtdLinhas; n++) {
          ensureSpaceTurno(TR + 2, turma.nome);
          const rowY = doc.y;
          if (n % 2 === 0) doc.rect(L, rowY, PW, TR).fill("#f8fafc");
          doc.moveTo(L, rowY + TR).lineTo(L + PW, rowY + TR).strokeColor("#cbd5e1").lineWidth(0.3).stroke();
          doc.moveTo(L + COL_N_W, rowY).lineTo(L + COL_N_W, rowY + TR).strokeColor("#cbd5e1").lineWidth(0.3).stroke();
          doc.moveTo(L + COL_N_W + COL_NOME_W, rowY).lineTo(L + COL_N_W + COL_NOME_W, rowY + TR).strokeColor("#cbd5e1").lineWidth(0.3).stroke();
          doc.font("Helvetica").fontSize(8).fillColor("#334155")
            .text(String(n), L + 1, rowY + 6, { width: COL_N_W - 2, align: "center", lineBreak: false });
          doc.y = rowY + TR;
        }
      }

      // Rodapé da página da turma
      drawFooterTurno(turma.nome);
    }

    // ── Finalize PDF ──
    passThrough.on("end", () => {
      const pdfBuffer = Buffer.concat(pdfChunks);
      res.setHeader("Content-Length", pdfBuffer.length);
      res.end(pdfBuffer);
    });
    doc.end();
  } catch (err) {
    console.error("[LISTAS-IMPRESSAO] Erro ao gerar PDF por turno:", err);
    if (!res.headersSent) res.status(500).json({ error: "Erro ao gerar lista por turno." });
  }
});

// ── Rota principal: GET /api/listas-impressao/:turmaId ──────────────────
// Query params:
//   tipo:   assinatura_prova | chamada | assinatura_geral | branco
//   titulo: Título customizado (opcional)
//   data:   Data de aplicação (YYYY-MM-DD, opcional — default: hoje)
//   linhas: Nº de linhas para lista em branco (opcional, default: 30)
router.get("/:turmaId", async (req, res) => {
  try {
    const { escola_id } = req.user;
    const { turmaId } = req.params;
    const {
      tipo = "assinatura_prova",
      titulo: tituloParam,
      data: dataParam,
      linhas: linhasParam,
    } = req.query;

    const anoLetivo = anoLetivoPadrao();

    // ── Dados da escola ──
    const [[escola]] = await pool.query(
      "SELECT id, nome, apelido, endereco, cidade, estado FROM escolas WHERE id = ?",
      [escola_id]
    );

    // ── Dados da turma ──
    const [[turma]] = await pool.query(
      "SELECT id, nome, turno, ano, serie FROM turmas WHERE id = ? AND escola_id = ?",
      [turmaId, escola_id]
    );
    if (!turma) return res.status(404).json({ error: "Turma não encontrada." });

    // ── Alunos da turma (via matrícula, ano letivo) ──
    const [alunos] = await pool.query(
      `SELECT a.id, a.codigo, a.estudante
       FROM matriculas m
       INNER JOIN alunos a ON a.id = m.aluno_id
       WHERE m.turma_id = ? AND m.escola_id = ? AND m.ano_letivo = ? AND m.status = 'ativo'
       ORDER BY a.estudante ASC`,
      [turmaId, escola_id, anoLetivo]
    );

    // ── Títulos por tipo ──
    const TITULOS_PADRAO = {
      assinatura_prova: "LISTA DE ASSINATURA — PROVA",
      chamada: "LISTA DE CHAMADA",
      assinatura_geral: "LISTA DE ASSINATURA — GERAL",
      branco: "LISTA EM BRANCO",
    };

    const titulo = tituloParam
      ? tituloParam.toUpperCase()
      : TITULOS_PADRAO[tipo] || "LISTA PARA IMPRESSÃO";

    const dataAplicacao = dataParam || new Date().toISOString().slice(0, 10);
    const dataFormatada = fmtDataBr(dataAplicacao);
    const qtdLinhas = Number(linhasParam) || 30;

    // ── Logos ────────────────────────────────────────────────────────
    const logoLeft = join(__dirname, "..", "assets", "images", "brasao-gdf.png");
    const logoRight = join(__dirname, "..", "assets", "images", "logo-escola-right.png");
    const hasLogoLeft = existsSync(logoLeft);
    const hasLogoRight = existsSync(logoRight);

    // ══════════════════════════════════════════════════════════════════
    // GERAR PDF
    // ══════════════════════════════════════════════════════════════════
    const L = 40;
    const R = 40;
    const PW = 595.28 - L - R;
    const PAGE_H = 841.89;
    const FOOTER_Y = PAGE_H - 25;
    const MAX_Y = FOOTER_Y - 15;

    const doc = new PDFDocument({
      size: "A4",
      margins: { top: 30, bottom: 0, left: L, right: R },
      autoFirstPage: true,
      info: {
        Title: `${titulo} - ${turma.nome}`,
        Author: "EDUCA.MELHOR — Sistema Educacional",
        Subject: titulo,
      },
    });

    res.setHeader("Content-Type", "application/pdf");
    const nomeArquivo = `lista_${tipo}_${turma.nome.replace(/\s+/g, "_")}.pdf`;
    res.setHeader("Content-Disposition", `inline; filename="${nomeArquivo}"`);

    const pdfChunks = [];
    const { PassThrough } = await import("stream");
    const passThrough = new PassThrough();
    passThrough.on("data", (chunk) => pdfChunks.push(chunk));
    doc.pipe(passThrough);

    let pageNum = 1;

    // ── Cores ──
    const COR_AZUL = "#1e3a5f";
    const COR_DOURADO = "#b8860b";
    const COR_CINZA = "#555";

    // ── Funções auxiliares ────────────────────────────────────────────
    function drawFooter() {
      doc
        .font("Helvetica")
        .fontSize(6.5)
        .fillColor("#aaa")
        .text(
          `${titulo} • ${turma.nome} • Documento gerado pelo EDUCA.MELHOR • Página ${pageNum}`,
          L,
          FOOTER_Y,
          { width: PW, align: "center", lineBreak: false }
        );
    }

    function drawLine(cor = "#ccc") {
      doc.moveTo(L, doc.y).lineTo(L + PW, doc.y).strokeColor(cor).lineWidth(0.5).stroke();
    }

    function ensureSpace(needed) {
      if (doc.y + needed > MAX_Y) {
        drawFooter();
        doc.addPage();
        pageNum++;
        doc.y = 30;
      }
    }

    // ══════════════════════════════════════════════════════════════════
    // CABEÇALHO INSTITUCIONAL (idêntico ao Relatório Disciplinar)
    // ══════════════════════════════════════════════════════════════════
    const headerTop = doc.y;
    const logoSize = 58;

    if (hasLogoLeft) {
      doc.image(logoLeft, L, headerTop, { width: logoSize, height: logoSize });
    }
    if (hasLogoRight) {
      doc.image(logoRight, L + PW - logoSize, headerTop, { width: logoSize, height: logoSize });
    }

    const hx = L + logoSize + 8;
    const hw = PW - (logoSize + 8) * 2;

    doc
      .font("Helvetica-Bold")
      .fontSize(9)
      .fillColor(COR_AZUL)
      .text("SECRETARIA DE ESTADO DE EDUCAÇÃO DO DISTRITO FEDERAL", hx, headerTop + 4, {
        width: hw,
        align: "center",
      });

    doc
      .font("Helvetica-Bold")
      .fontSize(8.5)
      .fillColor(COR_AZUL)
      .text(
        `COORDENAÇÃO REGIONAL DE ENSINO DE ${(escola?.cidade || "PLANALTINA").toUpperCase()}`,
        hx,
        doc.y + 1,
        { width: hw, align: "center" }
      );

    const escolaNome = escola?.nome || "CENTRO DE ENSINO FUNDAMENTAL 04";
    const escolaApelido = escola?.apelido || "";
    const nomeCompleto = escolaApelido ? `${escolaNome} — ${escolaApelido}` : escolaNome;
    doc
      .font("Helvetica-Bold")
      .fontSize(9)
      .fillColor(COR_AZUL)
      .text(nomeCompleto.toUpperCase(), hx, doc.y + 1, { width: hw, align: "center" });

    const enderecoEscola = escola?.endereco || "Endereço não cadastrado";
    doc
      .font("Helvetica")
      .fontSize(7.5)
      .fillColor(COR_CINZA)
      .text(enderecoEscola, hx, doc.y + 1, { width: hw, align: "center" });

    doc.y = headerTop + logoSize + 4;

    // Linhas decorativas
    doc.moveTo(L, doc.y).lineTo(L + PW, doc.y).strokeColor(COR_DOURADO).lineWidth(2).stroke();
    doc.y += 3;
    doc.moveTo(L, doc.y).lineTo(L + PW, doc.y).strokeColor(COR_AZUL).lineWidth(0.8).stroke();
    doc.y += 8;

    // TÍTULO
    doc
      .font("Helvetica-Bold")
      .fontSize(14)
      .fillColor(COR_AZUL)
      .text(titulo, L, doc.y, { width: PW, align: "center" });
    doc.y += 6;

    drawLine();
    doc.y += 6;

    // ══════════════════════════════════════════════════════════════════
    // IDENTIFICAÇÃO DA TURMA
    // ══════════════════════════════════════════════════════════════════
    const infoY = doc.y;
    const infoH = 18;

    // Fundo
    doc.roundedRect(L, infoY, PW, infoH, 3).fill("#f0f4ff");
    doc.roundedRect(L, infoY, PW, infoH, 3).strokeColor("#c7d2fe").lineWidth(0.5).stroke();

    // Textos
    const infoTextY = infoY + 5;
    const colW = PW / 5;

    const infoCols = [
      { label: "Turma:", value: turma.nome },
      { label: "Turno:", value: turma.turno },
      { label: "Ano Letivo:", value: String(anoLetivo) },
      { label: "Data:", value: dataFormatada },
      { label: "Total:", value: `${tipo === "branco" ? qtdLinhas : alunos.length} aluno(s)` },
    ];

    infoCols.forEach((col, i) => {
      const cx = L + colW * i + 6;
      doc
        .font("Helvetica-Bold")
        .fontSize(7)
        .fillColor(COR_AZUL)
        .text(col.label, cx, infoTextY, { width: colW - 12, lineBreak: false, continued: true });
      doc
        .font("Helvetica")
        .fontSize(7)
        .fillColor("#334155")
        .text(` ${col.value}`, { lineBreak: false });
    });

    doc.y = infoY + infoH + 8;

    // ══════════════════════════════════════════════════════════════════
    // TABELA DE CONTEÚDO (dependendo do tipo)
    // ══════════════════════════════════════════════════════════════════

    if (tipo === "assinatura_prova") {
      // ────── 3 colunas: RE | Nome do Estudante | Assinatura ──────
      const COL_RE_W = 42;
      const COL_SIGN_W = 260;
      const COL_NOME_W = PW - COL_RE_W - COL_SIGN_W;
      const TH = 16;
      const TR = 22;

      // Cabeçalho
      const thY = doc.y;
      doc.rect(L, thY, PW, TH).fill(COR_AZUL);
      let tx = L;
      const thTexts = [
        { text: "RE", w: COL_RE_W, align: "center" },
        { text: "NOME DO ESTUDANTE", w: COL_NOME_W, align: "left" },
        { text: "ASSINATURA", w: COL_SIGN_W, align: "center" },
      ];
      thTexts.forEach((col) => {
        doc
          .font("Helvetica-Bold")
          .fontSize(8)
          .fillColor("#fff")
          .text(col.text, tx + 4, thY + 4, {
            width: col.w - 8,
            align: col.align,
            lineBreak: false,
          });
        tx += col.w;
      });
      doc.y = thY + TH;

      // Linhas de dados
      alunos.forEach((a, i) => {
        ensureSpace(TR + 2);
        const rowY = doc.y;
        const isEven = i % 2 === 0;

        if (isEven) doc.rect(L, rowY, PW, TR).fill("#f8fafc");

        // Bordas horizontais
        doc.moveTo(L, rowY + TR).lineTo(L + PW, rowY + TR).strokeColor("#cbd5e1").lineWidth(0.3).stroke();

        // Bordas verticais
        doc.moveTo(L + COL_RE_W, rowY).lineTo(L + COL_RE_W, rowY + TR).strokeColor("#cbd5e1").lineWidth(0.3).stroke();
        doc.moveTo(L + COL_RE_W + COL_NOME_W, rowY).lineTo(L + COL_RE_W + COL_NOME_W, rowY + TR).strokeColor("#cbd5e1").lineWidth(0.3).stroke();

        // RE
        doc
          .font("Helvetica-Bold")
          .fontSize(8)
          .fillColor(COR_AZUL)
          .text(String(a.codigo || "—"), L + 2, rowY + 7, {
            width: COL_RE_W - 4,
            align: "center",
            lineBreak: false,
          });

        // Nome
        doc
          .font("Helvetica")
          .fontSize(8.5)
          .fillColor("#1e293b")
          .text(a.estudante || "—", L + COL_RE_W + 6, rowY + 7, {
            width: COL_NOME_W - 12,
            lineBreak: false,
          });

        // Assinatura (vazio)
        doc.y = rowY + TR;
      });

      // Bordas externas da tabela
      const tableEndY = doc.y;
      doc.rect(L, doc.y - alunos.length * TR - TH, PW, alunos.length * TR + TH).strokeColor("#94a3b8").lineWidth(0.5).stroke();

      doc.y = tableEndY + 8;

      // ── Linhas de assinatura (Aplicador/Coordenador) ──
      ensureSpace(60);
      const sigW = 200;
      const sigLineY = doc.y + 35;

      // Aplicador(a)
      doc.moveTo(L + 10, sigLineY).lineTo(L + 10 + sigW, sigLineY).strokeColor("#334155").lineWidth(0.5).stroke();
      doc.font("Helvetica").fontSize(8).fillColor("#334155")
        .text("Aplicador(a)", L + 10, sigLineY + 3, { width: sigW, align: "center", lineBreak: false });

      // Coordenador(a)
      doc.moveTo(L + PW - sigW - 10, sigLineY).lineTo(L + PW - 10, sigLineY).strokeColor("#334155").lineWidth(0.5).stroke();
      doc.font("Helvetica").fontSize(8).fillColor("#334155")
        .text("Coordenador(a)", L + PW - sigW - 10, sigLineY + 3, { width: sigW, align: "center", lineBreak: false });

      doc.y = sigLineY + 20;

    } else if (tipo === "chamada") {
      // ────── 5 colunas: Nº | Estudante | P | F | Observação ──────
      const COL_N_W = 28;
      const COL_P_W = 24;
      const COL_F_W = 24;
      const COL_OBS_W = 100;
      const COL_NOME_W = PW - COL_N_W - COL_P_W - COL_F_W - COL_OBS_W;
      const TH = 16;
      const TR = 18;

      // Cabeçalho
      const thY2 = doc.y;
      doc.rect(L, thY2, PW, TH).fill(COR_AZUL);
      let tx = L;
      [
        { text: "Nº", w: COL_N_W, align: "center" },
        { text: "ESTUDANTE", w: COL_NOME_W, align: "left" },
        { text: "P", w: COL_P_W, align: "center" },
        { text: "F", w: COL_F_W, align: "center" },
        { text: "OBSERVAÇÃO", w: COL_OBS_W, align: "center" },
      ].forEach((col) => {
        doc.font("Helvetica-Bold").fontSize(7).fillColor("#fff")
          .text(col.text, tx + 2, thY2 + 5, { width: col.w - 4, align: col.align, lineBreak: false });
        tx += col.w;
      });
      doc.y = thY2 + TH;

      alunos.forEach((a, i) => {
        ensureSpace(TR + 2);
        const rowY = doc.y;
        if (i % 2 === 0) doc.rect(L, rowY, PW, TR).fill("#f8fafc");
        doc.moveTo(L, rowY + TR).lineTo(L + PW, rowY + TR).strokeColor("#cbd5e1").lineWidth(0.3).stroke();

        // Bordas verticais
        let bx = L + COL_N_W;
        [COL_NOME_W, COL_P_W, COL_F_W].forEach((w) => {
          doc.moveTo(bx, rowY).lineTo(bx, rowY + TR).strokeColor("#cbd5e1").lineWidth(0.3).stroke();
          bx += w;
        });
        doc.moveTo(bx, rowY).lineTo(bx, rowY + TR).strokeColor("#cbd5e1").lineWidth(0.3).stroke();

        doc.font("Helvetica").fontSize(8).fillColor("#334155")
          .text(String(i + 1), L + 1, rowY + 5, { width: COL_N_W - 2, align: "center", lineBreak: false });
        doc.font("Helvetica").fontSize(8.5).fillColor("#1e293b")
          .text(a.estudante || "—", L + COL_N_W + 4, rowY + 5, { width: COL_NOME_W - 8, lineBreak: false });

        doc.y = rowY + TR;
      });

      doc.y += 4;
      doc.font("Helvetica").fontSize(8).fillColor("#64748b")
        .text("Legenda: P = Presente | F = Falta", L, doc.y, { width: PW });
      doc.y += 8;

    } else if (tipo === "assinatura_geral") {
      // ────── 4 colunas: Nº | Estudante | Assinatura Aluno | Assinatura Responsável ──────
      const COL_N_W = 28;
      const COL_SIGN_W = 130;
      const COL_NOME_W = PW - COL_N_W - COL_SIGN_W * 2;
      const TH = 16;
      const TR = 22;

      const thY3 = doc.y;
      doc.rect(L, thY3, PW, TH).fill(COR_AZUL);
      let tx = L;
      [
        { text: "Nº", w: COL_N_W, align: "center" },
        { text: "ESTUDANTE", w: COL_NOME_W, align: "left" },
        { text: "ASSINATURA ALUNO", w: COL_SIGN_W, align: "center" },
        { text: "ASSINATURA RESPONSÁVEL", w: COL_SIGN_W, align: "center" },
      ].forEach((col) => {
        doc.font("Helvetica-Bold").fontSize(7).fillColor("#fff")
          .text(col.text, tx + 2, thY3 + 5, { width: col.w - 4, align: col.align, lineBreak: false });
        tx += col.w;
      });
      doc.y = thY3 + TH;

      alunos.forEach((a, i) => {
        ensureSpace(TR + 2);
        const rowY = doc.y;
        if (i % 2 === 0) doc.rect(L, rowY, PW, TR).fill("#f8fafc");
        doc.moveTo(L, rowY + TR).lineTo(L + PW, rowY + TR).strokeColor("#cbd5e1").lineWidth(0.3).stroke();

        let bx = L + COL_N_W;
        doc.moveTo(bx, rowY).lineTo(bx, rowY + TR).strokeColor("#cbd5e1").lineWidth(0.3).stroke();
        bx += COL_NOME_W;
        doc.moveTo(bx, rowY).lineTo(bx, rowY + TR).strokeColor("#cbd5e1").lineWidth(0.3).stroke();
        bx += COL_SIGN_W;
        doc.moveTo(bx, rowY).lineTo(bx, rowY + TR).strokeColor("#cbd5e1").lineWidth(0.3).stroke();

        doc.font("Helvetica").fontSize(8).fillColor("#334155")
          .text(String(i + 1), L + 1, rowY + 7, { width: COL_N_W - 2, align: "center", lineBreak: false });
        doc.font("Helvetica").fontSize(8.5).fillColor("#1e293b")
          .text(a.estudante || "—", L + COL_N_W + 4, rowY + 7, { width: COL_NOME_W - 8, lineBreak: false });

        doc.y = rowY + TR;
      });

      doc.y += 4;

    } else if (tipo === "branco") {
      // ────── 3 colunas: Nº | Nome | Observação ──────
      const COL_N_W = 28;
      const COL_OBS_W = 120;
      const COL_NOME_W = PW - COL_N_W - COL_OBS_W;
      const TH = 16;
      const TR = 20;

      const thY4 = doc.y;
      doc.rect(L, thY4, PW, TH).fill(COR_AZUL);
      let tx = L;
      [
        { text: "Nº", w: COL_N_W, align: "center" },
        { text: "NOME", w: COL_NOME_W, align: "left" },
        { text: "OBSERVAÇÃO", w: COL_OBS_W, align: "center" },
      ].forEach((col) => {
        doc.font("Helvetica-Bold").fontSize(7).fillColor("#fff")
          .text(col.text, tx + 2, thY4 + 5, { width: col.w - 4, align: col.align, lineBreak: false });
        tx += col.w;
      });
      doc.y = thY4 + TH;

      for (let n = 1; n <= qtdLinhas; n++) {
        ensureSpace(TR + 2);
        const rowY = doc.y;
        if (n % 2 === 0) doc.rect(L, rowY, PW, TR).fill("#f8fafc");
        doc.moveTo(L, rowY + TR).lineTo(L + PW, rowY + TR).strokeColor("#cbd5e1").lineWidth(0.3).stroke();

        doc.moveTo(L + COL_N_W, rowY).lineTo(L + COL_N_W, rowY + TR).strokeColor("#cbd5e1").lineWidth(0.3).stroke();
        doc.moveTo(L + COL_N_W + COL_NOME_W, rowY).lineTo(L + COL_N_W + COL_NOME_W, rowY + TR).strokeColor("#cbd5e1").lineWidth(0.3).stroke();

        doc.font("Helvetica").fontSize(8).fillColor("#334155")
          .text(String(n), L + 1, rowY + 6, { width: COL_N_W - 2, align: "center", lineBreak: false });

        doc.y = rowY + TR;
      }

      doc.y += 4;
    }

    // ── Rodapé ──
    drawFooter();

    // ── Finalize PDF ──
    passThrough.on("end", () => {
      const pdfBuffer = Buffer.concat(pdfChunks);
      res.setHeader("Content-Length", pdfBuffer.length);
      res.end(pdfBuffer);
    });
    doc.end();
  } catch (err) {
    console.error("[LISTAS-IMPRESSAO] Erro ao gerar PDF:", err);
    if (!res.headersSent) res.status(500).json({ error: "Erro ao gerar lista para impressão." });
  }
});


// ══════════════════════════════════════════════════════════════════════════
// LISTA DE NOTAS
// ══════════════════════════════════════════════════════════════════════════

// GET /api/listas-impressao/notas/avaliacoes
// Lista avaliações que possuem gabaritos corrigidos (respostas salvas)
router.get("/notas/avaliacoes", async (req, res) => {
  try {
    const { escola_id } = req.user;

    const [rows] = await pool.query(
      `SELECT
         ga.id, ga.titulo, ga.bimestre, ga.tipo, ga.nota_total,
         ga.turno, ga.status, ga.created_at,
         COUNT(DISTINCT gr.id) AS total_respostas,
         COUNT(DISTINCT gl.turma_nome) AS total_turmas
       FROM gabarito_avaliacoes ga
       LEFT JOIN gabarito_respostas gr ON gr.avaliacao_id = ga.id AND gr.escola_id = ga.escola_id
       LEFT JOIN gabarito_lotes gl ON gl.avaliacao_id = ga.id AND gl.escola_id = ga.escola_id
       WHERE ga.escola_id = ?
         AND ga.status IN ('publicada', 'notas_importadas')
       GROUP BY ga.id
       HAVING total_respostas > 0
       ORDER BY ga.created_at DESC`,
      [escola_id]
    );

    res.json(rows);
  } catch (err) {
    console.error("[LISTA-NOTAS] Erro ao listar avaliações:", err);
    res.status(500).json({ error: "Erro ao carregar avaliações." });
  }
});

// GET /api/listas-impressao/notas/:avaliacaoId/turmas
// Lista turmas com respostas para uma avaliação específica.
// Query vai direto em gabarito_respostas (sem JOIN com gabarito_lotes)
// para evitar falhas de collation no cruzamento por turma_nome.
router.get("/notas/:avaliacaoId/turmas", async (req, res) => {
  try {
    const { escola_id } = req.user;
    const { avaliacaoId } = req.params;

    const [rows] = await pool.query(
      `SELECT
         gr.turma_nome,
         gr.turma_id,
         COUNT(gr.id) AS total_alunos_corrigidos,
         t.turno
       FROM gabarito_respostas gr
       LEFT JOIN turmas t
         ON t.id = gr.turma_id
         AND t.escola_id = gr.escola_id
       WHERE gr.avaliacao_id = ? AND gr.escola_id = ?
       GROUP BY gr.turma_nome, gr.turma_id, t.turno
       HAVING total_alunos_corrigidos > 0
       ORDER BY gr.turma_nome ASC`,
      [avaliacaoId, escola_id]
    );

    // Garantir lote_id compatível com o frontend (usa lote_id como key)
    const resultado = rows.map((r, i) => ({
      lote_id: r.turma_id || `turma_${i}`,
      turma_nome: r.turma_nome,
      turma_id: r.turma_id,
      turno: r.turno || null,
      total_alunos_corrigidos: r.total_alunos_corrigidos,
    }));

    res.json(resultado);
  } catch (err) {
    console.error("[LISTA-NOTAS] Erro ao listar turmas:", err);
    res.status(500).json({ error: "Erro ao carregar turmas." });
  }
});

// GET /api/listas-impressao/notas/:avaliacaoId/:turmaId
// Gera PDF da Lista de Notas para uma turma + avaliação
// Query params: turma_nome (nome textual da turma, alternativa ao turmaId)
router.get("/notas/:avaliacaoId/:turmaId", async (req, res) => {
  try {
    const { escola_id } = req.user;
    const { avaliacaoId, turmaId } = req.params;
    const { turma_nome: turmaNomeParam } = req.query;

    const anoLetivo = anoLetivoPadrao();

    // ── Dados da escola ──
    const [[escola]] = await pool.query(
      "SELECT id, nome, apelido, endereco, cidade FROM escolas WHERE id = ?",
      [escola_id]
    );

    // ── Dados da avaliação ──
    const [[av]] = await pool.query(
      "SELECT id, titulo, bimestre, nota_total, tipo, turno FROM gabarito_avaliacoes WHERE id = ? AND escola_id = ?",
      [avaliacaoId, escola_id]
    );
    if (!av) return res.status(404).json({ error: "Avaliação não encontrada." });

    // ── Dados da turma ──
    let turma = null;
    let turmaNomeConsulta = turmaNomeParam;

    if (turmaId !== "por-nome") {
      const [[turmaRow]] = await pool.query(
        "SELECT id, nome, turno, serie FROM turmas WHERE id = ? AND escola_id = ?",
        [turmaId, escola_id]
      );
      if (turmaRow) {
        turma = turmaRow;
        turmaNomeConsulta = turmaRow.nome;
      }
    }

    // Fallback: busca pelo nome informado
    if (!turma && turmaNomeConsulta) {
      const [[turmaRow]] = await pool.query(
        `SELECT id, nome, turno, serie FROM turmas
         WHERE escola_id = ?
           AND CONVERT(nome USING utf8mb4) COLLATE utf8mb4_unicode_ci
             = CONVERT(? USING utf8mb4) COLLATE utf8mb4_unicode_ci
         LIMIT 1`,
        [escola_id, turmaNomeConsulta]
      );
      if (turmaRow) turma = turmaRow;
    }

    const turmaLabel = turma?.nome || turmaNomeConsulta || "Turma";
    const turnoLabel = turma?.turno || av.turno || "";

    // ── Notas corrigidas da turma via gabarito ──
    const [respostas] = await pool.query(
      `SELECT gr.codigo_aluno, gr.nome_aluno, gr.nota, gr.acertos,
              (SELECT num_questoes FROM gabarito_avaliacoes WHERE id = gr.avaliacao_id) AS total_questoes
       FROM gabarito_respostas gr
       WHERE gr.avaliacao_id = ? AND gr.escola_id = ?
         AND CONVERT(gr.turma_nome USING utf8mb4) COLLATE utf8mb4_unicode_ci
           = CONVERT(? USING utf8mb4) COLLATE utf8mb4_unicode_ci
       ORDER BY gr.nome_aluno ASC`,
      [avaliacaoId, escola_id, turmaNomeConsulta]
    );

    if (respostas.length === 0) {
      return res.status(404).json({ error: "Nenhuma nota encontrada para esta turma/avaliação." });
    }

    // ── Logos ──
    const logoLeft = join(__dirname, "..", "assets", "images", "brasao-gdf.png");
    const logoRight = join(__dirname, "..", "assets", "images", "logo-escola-right.png");
    const hasLogoLeft = existsSync(logoLeft);
    const hasLogoRight = existsSync(logoRight);

    // ══════════════════════════════════════════════════════════════════
    // GERAR PDF
    // ══════════════════════════════════════════════════════════════════
    const L = 40;
    const R = 40;
    const PW = 595.28 - L - R;
    const PAGE_H = 841.89;
    const FOOTER_Y = PAGE_H - 25;
    const MAX_Y = FOOTER_Y - 15;

    const titulo = `LISTA DE NOTAS — ${av.titulo.toUpperCase()}`;

    const doc = new PDFDocument({
      size: "A4",
      margins: { top: 30, bottom: 0, left: L, right: R },
      autoFirstPage: true,
      info: {
        Title: `${titulo} - ${turmaLabel}`,
        Author: "EDUCA.MELHOR — Sistema Educacional",
        Subject: "Lista de Notas",
      },
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="lista_notas_${turmaLabel.replace(/\s+/g, "_")}_${av.titulo.replace(/\s+/g, "_")}.pdf"`);

    const pdfChunks = [];
    const { PassThrough } = await import("stream");
    const passThrough = new PassThrough();
    passThrough.on("data", (chunk) => pdfChunks.push(chunk));
    doc.pipe(passThrough);

    let pageNum = 1;

    const COR_AZUL = "#1e3a5f";
    const COR_DOURADO = "#b8860b";
    const COR_CINZA = "#555";
    const COR_VERDE = "#166534";
    const COR_VERDE_BG = "#dcfce7";
    const COR_VERMELHO = "#991b1b";
    const COR_VERMELHO_BG = "#fee2e2";
    const COR_AMARELO = "#854d0e";
    const COR_AMARELO_BG = "#fef9c3";

    function drawFooter() {
      doc
        .font("Helvetica").fontSize(6.5).fillColor("#aaa")
        .text(
          `${titulo} • ${turmaLabel} • Documento gerado pelo EDUCA.MELHOR • Página ${pageNum}`,
          L, FOOTER_Y, { width: PW, align: "center", lineBreak: false }
        );
    }

    function ensureSpace(needed) {
      if (doc.y + needed > MAX_Y) {
        drawFooter();
        doc.addPage();
        pageNum++;
        doc.y = 30;
      }
    }

    // ── Cabeçalho Institucional Premium ──
    const headerTop = doc.y;
    const logoSize = 58;

    if (hasLogoLeft) doc.image(logoLeft, L, headerTop, { width: logoSize, height: logoSize });
    if (hasLogoRight) doc.image(logoRight, L + PW - logoSize, headerTop, { width: logoSize, height: logoSize });

    const hx = L + logoSize + 8;
    const hw = PW - (logoSize + 8) * 2;

    doc.font("Helvetica-Bold").fontSize(9).fillColor(COR_AZUL)
      .text("SECRETARIA DE ESTADO DE EDUCAÇÃO DO DISTRITO FEDERAL", hx, headerTop + 4, { width: hw, align: "center" });
    doc.font("Helvetica-Bold").fontSize(8.5).fillColor(COR_AZUL)
      .text(`COORDENAÇÃO REGIONAL DE ENSINO DE ${(escola?.cidade || "PLANALTINA").toUpperCase()}`, hx, doc.y + 1, { width: hw, align: "center" });
    const nomeCompleto = escola?.apelido ? `${escola.nome} — ${escola.apelido}` : (escola?.nome || "");
    doc.font("Helvetica-Bold").fontSize(9).fillColor(COR_AZUL)
      .text(nomeCompleto.toUpperCase(), hx, doc.y + 1, { width: hw, align: "center" });
    doc.font("Helvetica").fontSize(7.5).fillColor(COR_CINZA)
      .text(escola?.endereco || "", hx, doc.y + 1, { width: hw, align: "center" });

    doc.y = headerTop + logoSize + 4;

    // Linhas decorativas duplas
    doc.moveTo(L, doc.y).lineTo(L + PW, doc.y).strokeColor(COR_DOURADO).lineWidth(2).stroke();
    doc.y += 3;
    doc.moveTo(L, doc.y).lineTo(L + PW, doc.y).strokeColor(COR_AZUL).lineWidth(0.8).stroke();
    doc.y += 8;

    // TÍTULO
    doc.font("Helvetica-Bold").fontSize(14).fillColor(COR_AZUL)
      .text(titulo, L, doc.y, { width: PW, align: "center" });
    doc.y += 4;
    doc.moveTo(L, doc.y).lineTo(L + PW, doc.y).strokeColor("#ccc").lineWidth(0.5).stroke();
    doc.y += 6;

    // ── Faixa de identificação premium ──
    const infoY = doc.y;
    const infoH = 20;
    doc.roundedRect(L, infoY, PW, infoH, 3).fill("#f0f4ff");
    doc.roundedRect(L, infoY, PW, infoH, 3).strokeColor("#c7d2fe").lineWidth(0.5).stroke();

    const colW = PW / 5;
    const infoCols = [
      { label: "Turma:", value: turmaLabel },
      { label: "Turno:", value: turnoLabel },
      { label: "Bimestre:", value: av.bimestre || "—" },
      { label: "Total alunos:", value: String(respostas.length) },
      { label: "Ano Letivo:", value: String(anoLetivo) },
    ];
    const infoTextY = infoY + 6;
    infoCols.forEach((col, i) => {
      const cx = L + colW * i + 6;
      doc.font("Helvetica-Bold").fontSize(7).fillColor(COR_AZUL)
        .text(col.label, cx, infoTextY, { width: colW - 12, lineBreak: false, continued: true });
      doc.font("Helvetica").fontSize(7).fillColor("#334155")
        .text(` ${col.value}`, { lineBreak: false });
    });
    doc.y = infoY + infoH + 8;

    // ── Estatísticas resumo ──
    const notaMax = Number(av.nota_total) || 10;
    const notas = respostas.map(r => Number(r.nota) || 0);
    const media = notas.length ? (notas.reduce((a, b) => a + b, 0) / notas.length) : 0;
    const aprov = notas.filter(n => n >= notaMax * 0.5).length;
    const reprov = notas.length - aprov;
    const maiorNota = Math.max(...notas);
    const menorNota = Math.min(...notas);

    const statY = doc.y;
    const statH = 22;
    const statW = PW / 5;
    const stats = [
      { label: "Média da Turma", value: media.toFixed(1), cor: COR_AZUL, bg: "#f0f4ff", border: "#c7d2fe" },
      { label: "Aprovados", value: `${aprov} (${Math.round((aprov / notas.length) * 100)}%)`, cor: COR_VERDE, bg: COR_VERDE_BG, border: "#86efac" },
      { label: "Reprovados", value: `${reprov} (${Math.round((reprov / notas.length) * 100)}%)`, cor: COR_VERMELHO, bg: COR_VERMELHO_BG, border: "#fca5a5" },
      { label: "Maior Nota", value: maiorNota.toFixed(1), cor: COR_VERDE, bg: COR_VERDE_BG, border: "#86efac" },
      { label: "Menor Nota", value: menorNota.toFixed(1), cor: COR_VERMELHO, bg: COR_VERMELHO_BG, border: "#fca5a5" },
    ];
    stats.forEach((s, i) => {
      const sx = L + statW * i + (i > 0 ? 3 : 0);
      const sw = statW - (i > 0 ? 3 : 0);
      doc.roundedRect(sx, statY, sw, statH, 3).fill(s.bg);
      doc.roundedRect(sx, statY, sw, statH, 3).strokeColor(s.border).lineWidth(0.5).stroke();
      doc.font("Helvetica").fontSize(6).fillColor(s.cor)
        .text(s.label, sx + 3, statY + 3, { width: sw - 6, align: "center", lineBreak: false });
      doc.font("Helvetica-Bold").fontSize(9).fillColor(s.cor)
        .text(s.value, sx + 3, statY + 10, { width: sw - 6, align: "center", lineBreak: false });
    });
    doc.y = statY + statH + 10;

    // ════════════════════════════════════════════════════
    // TABELA DE NOTAS
    // ════════════════════════════════════════════════════
    const COL_N_W = 26;
    const COL_RE_W = 52;
    const COL_ACERTOS_W = 54;
    const COL_NOTA_W = 58;
    const COL_CONCEITO_W = 62;
    const COL_NOME_W = PW - COL_N_W - COL_RE_W - COL_ACERTOS_W - COL_NOTA_W - COL_CONCEITO_W;
    const TH = 16;
    const TR = 18;

    const thY = doc.y;
    doc.rect(L, thY, PW, TH).fill(COR_AZUL);
    let tx = L;
    [
      { text: "Nº", w: COL_N_W, align: "center" },
      { text: "RE", w: COL_RE_W, align: "center" },
      { text: "ESTUDANTE", w: COL_NOME_W, align: "left" },
      { text: "ACERTOS", w: COL_ACERTOS_W, align: "center" },
      { text: `NOTA (${notaMax})`, w: COL_NOTA_W, align: "center" },
      { text: "SITUAÇÃO", w: COL_CONCEITO_W, align: "center" },
    ].forEach((col) => {
      doc.font("Helvetica-Bold").fontSize(7.5).fillColor("#fff")
        .text(col.text, tx + 3, thY + 4, { width: col.w - 6, align: col.align, lineBreak: false });
      tx += col.w;
    });
    doc.y = thY + TH;

    respostas.forEach((r, i) => {
      ensureSpace(TR + 2);
      const rowY = doc.y;
      const nota = Number(r.nota) || 0;
      const aprovado = nota >= notaMax * 0.5;

      // Linha zebrada
      if (i % 2 === 0) doc.rect(L, rowY, PW, TR).fill("#f8fafc");
      doc.moveTo(L, rowY + TR).lineTo(L + PW, rowY + TR).strokeColor("#e2e8f0").lineWidth(0.3).stroke();

      // Divisórias das colunas
      let bx = L;
      [COL_N_W, COL_RE_W, COL_NOME_W, COL_ACERTOS_W, COL_NOTA_W].forEach(w => {
        bx += w;
        doc.moveTo(bx, rowY).lineTo(bx, rowY + TR).strokeColor("#e2e8f0").lineWidth(0.3).stroke();
      });

      const cy = rowY + 5;

      // Número
      doc.font("Helvetica").fontSize(7.5).fillColor("#64748b")
        .text(String(i + 1), L + 1, cy, { width: COL_N_W - 2, align: "center", lineBreak: false });

      // RE (código)
      doc.font("Helvetica-Bold").fontSize(7.5).fillColor(COR_AZUL)
        .text(String(r.codigo_aluno || "—"), L + COL_N_W + 2, cy, { width: COL_RE_W - 4, align: "center", lineBreak: false });

      // Nome
      doc.font("Helvetica").fontSize(8.5).fillColor("#1e293b")
        .text(r.nome_aluno || "—", L + COL_N_W + COL_RE_W + 4, cy, { width: COL_NOME_W - 8, lineBreak: false });

      // Acertos
      const totalQ = Number(r.total_questoes) || 0;
      const acertos = Number(r.acertos) || 0;
      doc.font("Helvetica-Bold").fontSize(8).fillColor(aprovado ? COR_VERDE : COR_VERMELHO)
        .text(totalQ > 0 ? `${acertos}/${totalQ}` : String(acertos), L + COL_N_W + COL_RE_W + COL_NOME_W, cy, { width: COL_ACERTOS_W, align: "center", lineBreak: false });

      // Nota — badge colorido
      const bNotaX = L + COL_N_W + COL_RE_W + COL_NOME_W + COL_ACERTOS_W + 4;
      const bNotaW = COL_NOTA_W - 8;
      const bNotaH = TR - 6;
      const bNotaBg = aprovado ? COR_VERDE_BG : COR_VERMELHO_BG;
      const bNotaCor = aprovado ? COR_VERDE : COR_VERMELHO;
      doc.roundedRect(bNotaX, rowY + 3, bNotaW, bNotaH, 3).fill(bNotaBg);
      doc.font("Helvetica-Bold").fontSize(9).fillColor(bNotaCor)
        .text(nota.toFixed(1), bNotaX, rowY + 5, { width: bNotaW, align: "center", lineBreak: false });

      // Situação
      const sitTxt = aprovado ? "APROVADO" : "REPROVADO";
      const sitCor = aprovado ? COR_VERDE : COR_VERMELHO;
      doc.font("Helvetica-Bold").fontSize(7).fillColor(sitCor)
        .text(sitTxt, L + COL_N_W + COL_RE_W + COL_NOME_W + COL_ACERTOS_W + COL_NOTA_W, cy, {
          width: COL_CONCEITO_W, align: "center", lineBreak: false
        });

      doc.y = rowY + TR;
    });

    // Borda inferior da tabela
    doc.moveTo(L, doc.y).lineTo(L + PW, doc.y).strokeColor(COR_AZUL).lineWidth(1).stroke();
    doc.y += 14;

    // ── Assinaturas ──
    ensureSpace(70);
    const sigW = 180;
    const sigLineY = doc.y + 30;
    const sigNames = ["Coordenador(a) Pedagógico(a)", "Professor(a) Responsável"];
    const sigPositions = [L + 20, L + PW - sigW - 20];
    sigPositions.forEach((sx, i) => {
      doc.moveTo(sx, sigLineY).lineTo(sx + sigW, sigLineY).strokeColor("#334155").lineWidth(0.5).stroke();
      doc.font("Helvetica").fontSize(8).fillColor("#475569")
        .text(sigNames[i], sx, sigLineY + 3, { width: sigW, align: "center", lineBreak: false });
    });

    // ── Rodapé ──
    drawFooter();

    // ── Finalize PDF ──
    passThrough.on("end", () => {
      const pdfBuffer = Buffer.concat(pdfChunks);
      res.setHeader("Content-Length", pdfBuffer.length);
      res.end(pdfBuffer);
    });
    doc.end();
  } catch (err) {
    console.error("[LISTA-NOTAS] Erro ao gerar PDF:", err);
    if (!res.headersSent) res.status(500).json({ error: "Erro ao gerar Lista de Notas." });
  }
});

export default router;

