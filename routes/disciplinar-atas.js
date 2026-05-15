// routes/disciplinar-atas.js
// ============================================================================
// Gestão de Atas Disciplinares
// CRUD completo com rastreabilidade (criado_por, editado_por, finalizado_por)
// e geração de PDF com cabeçalho institucional premium (estilo TACE).
// ============================================================================

import { Router } from "express";
import PDFDocument from "pdfkit";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";
import pool from "../db.js";

const router = Router();
const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Auto-create table ──────────────────────────────────────────────────────
async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS disciplinar_atas (
      id              INT AUTO_INCREMENT PRIMARY KEY,
      escola_id       INT NOT NULL,
      titulo          VARCHAR(500) NOT NULL,
      conteudo        TEXT NOT NULL,
      status          ENUM('Rascunho','Finalizado') NOT NULL DEFAULT 'Rascunho',
      criado_por      VARCHAR(255),
      criado_por_id   INT,
      criado_em       DATETIME DEFAULT CURRENT_TIMESTAMP,
      editado_por     VARCHAR(255),
      editado_por_id  INT,
      editado_em      DATETIME DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
      finalizado_por  VARCHAR(255),
      finalizado_por_id INT,
      finalizado_em   DATETIME DEFAULT NULL,
      INDEX idx_escola (escola_id),
      INDEX idx_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      COMMENT='Atas disciplinares com rastreabilidade completa'
  `);
}
ensureTable().catch(err => console.error("[DISCIPLINAR-ATAS] Erro ao criar tabela:", err));

// ── Helpers ────────────────────────────────────────────────────────────────
function hoje() {
  const m = ["janeiro","fevereiro","março","abril","maio","junho","julho","agosto","setembro","outubro","novembro","dezembro"];
  const d = new Date();
  return `${d.getDate()} de ${m[d.getMonth()]} de ${d.getFullYear()}`;
}

// ══════════════════════════════════════════════════════════════════════════
// GET /api/disciplinar-atas — Listar atas da escola
// ══════════════════════════════════════════════════════════════════════════
router.get("/", async (req, res) => {
  try {
    const { escola_id } = req.user;
    const [rows] = await pool.query(
      `SELECT id, titulo, conteudo, status,
              criado_por, criado_em,
              editado_por, editado_em,
              finalizado_por, finalizado_em
       FROM disciplinar_atas
       WHERE escola_id = ?
       ORDER BY criado_em DESC`,
      [escola_id]
    );
    res.json(rows);
  } catch (err) {
    console.error("[DISCIPLINAR-ATAS] Erro ao listar:", err);
    res.status(500).json({ error: "Erro ao buscar atas." });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// POST /api/disciplinar-atas — Criar nova ata
// ══════════════════════════════════════════════════════════════════════════
router.post("/", async (req, res) => {
  try {
    const { escola_id, nome, id: usuario_id } = req.user;
    const { titulo, conteudo } = req.body;
    if (!titulo || !conteudo) return res.status(400).json({ error: "Título e conteúdo são obrigatórios." });

    const [result] = await pool.query(
      `INSERT INTO disciplinar_atas (escola_id, titulo, conteudo, status, criado_por, criado_por_id)
       VALUES (?, ?, ?, 'Rascunho', ?, ?)`,
      [escola_id, titulo.trim(), conteudo.trim(), nome || "Usuário", usuario_id]
    );

    const [[ata]] = await pool.query(
      "SELECT * FROM disciplinar_atas WHERE id = ?",
      [result.insertId]
    );
    res.status(201).json(ata);
  } catch (err) {
    console.error("[DISCIPLINAR-ATAS] Erro ao criar:", err);
    res.status(500).json({ error: "Erro ao criar ata." });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// PUT /api/disciplinar-atas/:id — Editar ata (apenas se Rascunho)
// ══════════════════════════════════════════════════════════════════════════
router.put("/:id", async (req, res) => {
  try {
    const { escola_id, nome, id: usuario_id } = req.user;
    const { id } = req.params;
    const { titulo, conteudo } = req.body;

    const [[ata]] = await pool.query(
      "SELECT id, status FROM disciplinar_atas WHERE id = ? AND escola_id = ?",
      [id, escola_id]
    );
    if (!ata) return res.status(404).json({ error: "Ata não encontrada." });
    if (ata.status === "Finalizado") return res.status(400).json({ error: "Não é possível editar uma ata finalizada." });

    await pool.query(
      `UPDATE disciplinar_atas
       SET titulo = ?, conteudo = ?, editado_por = ?, editado_por_id = ?, editado_em = NOW()
       WHERE id = ? AND escola_id = ?`,
      [titulo.trim(), conteudo.trim(), nome || "Usuário", usuario_id, id, escola_id]
    );

    const [[updated]] = await pool.query("SELECT * FROM disciplinar_atas WHERE id = ?", [id]);
    res.json(updated);
  } catch (err) {
    console.error("[DISCIPLINAR-ATAS] Erro ao editar:", err);
    res.status(500).json({ error: "Erro ao editar ata." });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// POST /api/disciplinar-atas/:id/finalizar — Finalizar ata
// ══════════════════════════════════════════════════════════════════════════
router.post("/:id/finalizar", async (req, res) => {
  try {
    const { escola_id, nome, id: usuario_id } = req.user;
    const { id } = req.params;

    const [[ata]] = await pool.query(
      "SELECT id, status FROM disciplinar_atas WHERE id = ? AND escola_id = ?",
      [id, escola_id]
    );
    if (!ata) return res.status(404).json({ error: "Ata não encontrada." });
    if (ata.status === "Finalizado") return res.status(400).json({ error: "Ata já finalizada." });

    await pool.query(
      `UPDATE disciplinar_atas
       SET status = 'Finalizado', finalizado_por = ?, finalizado_por_id = ?, finalizado_em = NOW()
       WHERE id = ? AND escola_id = ?`,
      [nome || "Usuário", usuario_id, id, escola_id]
    );

    const [[updated]] = await pool.query("SELECT * FROM disciplinar_atas WHERE id = ?", [id]);
    res.json(updated);
  } catch (err) {
    console.error("[DISCIPLINAR-ATAS] Erro ao finalizar:", err);
    res.status(500).json({ error: "Erro ao finalizar ata." });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// GET /api/disciplinar-atas/:id/pdf — Gerar PDF com cabeçalho premium TACE
// ══════════════════════════════════════════════════════════════════════════
router.get("/:id/pdf", async (req, res) => {
  try {
    const { escola_id } = req.user;
    const { id } = req.params;

    const [[ata]] = await pool.query(
      "SELECT * FROM disciplinar_atas WHERE id = ? AND escola_id = ?",
      [id, escola_id]
    );
    if (!ata) return res.status(404).json({ error: "Ata não encontrada." });

    const [[escola]] = await pool.query(
      "SELECT id, nome, apelido, endereco, cidade, estado FROM escolas WHERE id = ?",
      [escola_id]
    );

    // ── Logos ──
    const logoLeft  = join(__dirname, "..", "assets", "images", "brasao-gdf.png");
    const logoRight = join(__dirname, "..", "assets", "images", "logo-escola-right.png");
    const hasLogoLeft  = existsSync(logoLeft);
    const hasLogoRight = existsSync(logoRight);

    // ── PDFKit setup ──
    const L = 40, R = 40;
    const PW = 595.28 - L - R;
    const PAGE_H = 841.89;
    const FOOTER_Y = PAGE_H - 25;
    const MAX_Y = FOOTER_Y - 15;

    const doc = new PDFDocument({
      size: "A4",
      margins: { top: 30, bottom: 0, left: L, right: R },
      autoFirstPage: true,
      info: {
        Title: `Ata — ${ata.titulo}`,
        Author: "EDUCA.MELHOR — Sistema Educacional",
        Subject: "Ata Disciplinar Oficial",
      },
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="ata_${ata.id}.pdf"`);

    const pdfChunks = [];
    const { PassThrough } = await import("stream");
    const passThrough = new PassThrough();
    passThrough.on("data", chunk => pdfChunks.push(chunk));
    doc.pipe(passThrough);

    let pageNum = 1;
    const COR_AZUL    = "#1e3a5f";
    const COR_DOURADO = "#b8860b";
    const COR_CINZA   = "#555";

    function drawFooter() {
      doc.font("Helvetica").fontSize(6.5).fillColor("#aaa")
        .text(
          `Ata Oficial — Documento gerado pelo EDUCA.MELHOR • Página ${pageNum}`,
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

    function drawSigLine(x, y, w, nome, cargo) {
      const lineY = y + 30;
      doc.moveTo(x, lineY).lineTo(x + w, lineY).strokeColor("#333").lineWidth(0.5).stroke();
      if (nome) {
        doc.font("Helvetica-Bold").fontSize(8).fillColor("#333")
          .text(nome, x, lineY + 3, { width: w, align: "center", lineBreak: false });
      }
      doc.font("Helvetica").fontSize(7).fillColor("#666")
        .text(cargo, x, lineY + (nome ? 13 : 3), { width: w, align: "center", lineBreak: false });
    }

    // ══════════════════════════════════════════════════════════════════
    // CABEÇALHO INSTITUCIONAL PREMIUM (idêntico ao TACE)
    // ══════════════════════════════════════════════════════════════════
    const headerTop = doc.y;
    const logoSize = 58;

    if (hasLogoLeft)  doc.image(logoLeft,  L,                      headerTop, { width: logoSize, height: logoSize });
    if (hasLogoRight) doc.image(logoRight, L + PW - logoSize,      headerTop, { width: logoSize, height: logoSize });

    const hx = L + logoSize + 8;
    const hw = PW - (logoSize + 8) * 2;

    doc.font("Helvetica-Bold").fontSize(9).fillColor(COR_AZUL)
      .text("SECRETARIA DE ESTADO DE EDUCAÇÃO DO DISTRITO FEDERAL", hx, headerTop + 4, { width: hw, align: "center" });

    doc.font("Helvetica-Bold").fontSize(8.5).fillColor(COR_AZUL)
      .text(
        `COORDENAÇÃO REGIONAL DE ENSINO DE ${(escola?.cidade || "PLANALTINA").toUpperCase()}`,
        hx, doc.y + 1, { width: hw, align: "center" }
      );

    const escolaNome    = escola?.nome    || "CENTRO DE ENSINO FUNDAMENTAL 04";
    const escolaApelido = escola?.apelido || "";
    const nomeCompleto  = escolaApelido ? `${escolaNome} — ${escolaApelido}` : escolaNome;
    doc.font("Helvetica-Bold").fontSize(9).fillColor(COR_AZUL)
      .text(nomeCompleto.toUpperCase(), hx, doc.y + 1, { width: hw, align: "center" });

    doc.font("Helvetica").fontSize(7.5).fillColor(COR_CINZA)
      .text(escola?.endereco || "Endereço não cadastrado", hx, doc.y + 1, { width: hw, align: "center" });

    doc.y = headerTop + logoSize + 4;

    // Linhas decorativas dourado + azul (mesmo padrão TACE)
    doc.moveTo(L, doc.y).lineTo(L + PW, doc.y).strokeColor(COR_DOURADO).lineWidth(2).stroke();
    doc.y += 3;
    doc.moveTo(L, doc.y).lineTo(L + PW, doc.y).strokeColor(COR_AZUL).lineWidth(0.8).stroke();
    doc.y += 10;

    // ── TÍTULO DA ATA ──
    doc.font("Helvetica-Bold").fontSize(13).fillColor(COR_AZUL)
      .text("ATA DISCIPLINAR OFICIAL", L, doc.y, { width: PW, align: "center" });
    doc.y += 2;
    doc.moveTo(L, doc.y).lineTo(L + PW, doc.y).strokeColor("#ccc").lineWidth(0.5).stroke();
    doc.y += 8;

    // ── TÍTULO DO DOCUMENTO ──
    doc.font("Helvetica-Bold").fontSize(12).fillColor("#0f172a")
      .text(ata.titulo.toUpperCase(), L, doc.y, { width: PW, align: "center" });
    doc.y += 10;

    // ── Metadados ──
    doc.font("Helvetica").fontSize(8).fillColor(COR_CINZA)
      .text(`Documento ID: #${ata.id}`, L, doc.y, { width: PW * 0.5 });
    doc.y -= 9;
    doc.font("Helvetica").fontSize(8).fillColor(COR_CINZA)
      .text(`Status: ${ata.status}`, L + PW * 0.5, doc.y, { width: PW * 0.5, align: "right" });
    doc.y += 12;

    doc.moveTo(L, doc.y).lineTo(L + PW, doc.y).strokeColor("#ccc").lineWidth(0.5).stroke();
    doc.y += 10;

    // ══════════════════════════════════════════════════════════════════
    // CONTEÚDO DA ATA
    // ══════════════════════════════════════════════════════════════════
    doc.font("Helvetica-Bold").fontSize(10).fillColor(COR_AZUL)
      .text("REGISTRO:", L, doc.y, { width: PW });
    doc.y += 6;

    const paragraphs = ata.conteudo.split("\n").filter(Boolean);
    for (const para of paragraphs) {
      ensureSpace(30);
      doc.font("Helvetica").fontSize(10).fillColor("#1a1a1a")
        .text(para, L, doc.y, { width: PW, lineGap: 2, align: "justify" });
      doc.y += 4;
    }

    // ══════════════════════════════════════════════════════════════════
    // RASTREABILIDADE
    // ══════════════════════════════════════════════════════════════════
    ensureSpace(80);
    doc.y += 6;
    doc.moveTo(L, doc.y).lineTo(L + PW, doc.y).strokeColor("#ccc").lineWidth(0.5).stroke();
    doc.y += 8;

    doc.font("Helvetica-Bold").fontSize(9).fillColor(COR_AZUL)
      .text("RASTREABILIDADE DOCUMENTAL", L, doc.y, { width: PW });
    doc.y += 5;

    const fmtDate = (val) => {
      if (!val) return "—";
      const d = new Date(val);
      return d.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
    };

    const trail = [
      { label: "Criado por",    nome: ata.criado_por,     em: fmtDate(ata.criado_em) },
      { label: "Editado por",   nome: ata.editado_por,    em: fmtDate(ata.editado_em) },
      { label: "Finalizado por",nome: ata.finalizado_por, em: fmtDate(ata.finalizado_em) },
    ].filter(t => t.nome);

    trail.forEach(t => {
      doc.font("Helvetica").fontSize(8).fillColor(COR_CINZA)
        .text(`${t.label}: ${t.nome} — ${t.em}`, L + 4, doc.y, { width: PW - 8 });
      doc.y += 1;
    });

    // ══════════════════════════════════════════════════════════════════
    // ASSINATURAS
    // ══════════════════════════════════════════════════════════════════
    ensureSpace(120);
    doc.y += 10;
    doc.moveTo(L, doc.y).lineTo(L + PW, doc.y).strokeColor("#ccc").lineWidth(0.5).stroke();
    doc.y += 8;

    doc.font("Helvetica-Bold").fontSize(10).fillColor(COR_AZUL)
      .text("ASSINATURAS", L, doc.y, { width: PW });
    doc.y += 4;

    const cidadeEscola = escola?.cidade || "Planaltina";
    doc.font("Helvetica").fontSize(9).fillColor("#333")
      .text(`${cidadeEscola} — DF, ${hoje()}.`, L, doc.y, { width: PW, align: "right" });
    doc.y += 18;

    const sigLineW = PW * 0.40;
    const sigGap   = PW * 0.20;

    // Linha 1: Responsável Legal + Militar Solicitante
    const ySig1 = doc.y;
    drawSigLine(L,                        ySig1, sigLineW, "", "Responsável Legal / Assinante");
    drawSigLine(L + sigLineW + sigGap,    ySig1, sigLineW, ata.finalizado_por || "", "Militar Solicitante / Finalizador");
    doc.y = ySig1 + 52;

    // Linha 2: Diretor(a) Disciplinar (centralizado)
    ensureSpace(60);
    const cmdW = PW * 0.50;
    const cmdX = L + (PW - cmdW) / 2;
    drawSigLine(cmdX, doc.y, cmdW, "", "Diretor(a) / Comandante Disciplinar");
    doc.y += 52;

    drawFooter();

    passThrough.on("end", () => {
      const pdfBuffer = Buffer.concat(pdfChunks);
      res.setHeader("Content-Length", pdfBuffer.length);
      res.end(pdfBuffer);
    });
    doc.end();

  } catch (err) {
    console.error("[DISCIPLINAR-ATAS] Erro ao gerar PDF:", err);
    if (!res.headersSent) res.status(500).json({ error: "Erro ao gerar PDF da ata." });
  }
});

export default router;
