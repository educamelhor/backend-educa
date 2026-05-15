// routes/disciplinar-atas.js
import { Router } from "express";
import PDFDocument from "pdfkit";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";
import pool from "../db.js";

const router = Router();
const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Auto-create + migrations ───────────────────────────────────────────────
async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS disciplinar_atas (
      id              INT AUTO_INCREMENT PRIMARY KEY,
      escola_id       INT NOT NULL,
      titulo          VARCHAR(500) NOT NULL,
      conteudo        TEXT NOT NULL,
      status          ENUM('Rascunho','Finalizado') NOT NULL DEFAULT 'Rascunho',
      turno           VARCHAR(50)  DEFAULT NULL,
      turma_id        INT          DEFAULT NULL,
      turma_nome      VARCHAR(255) DEFAULT NULL,
      aluno_id        INT          DEFAULT NULL,
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
  `);
  // Adiciona colunas de contexto se não existirem (migration incremental)
  try {
    const [cols] = await pool.query(`
      SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'disciplinar_atas'
      AND COLUMN_NAME IN ('turno','turma_id','turma_nome','aluno_id')
    `);
    const ex = new Set(cols.map(c => c.COLUMN_NAME));
    const add = [];
    if (!ex.has('turno'))      add.push("ADD COLUMN turno VARCHAR(50) DEFAULT NULL");
    if (!ex.has('turma_id'))   add.push("ADD COLUMN turma_id INT DEFAULT NULL");
    if (!ex.has('turma_nome')) add.push("ADD COLUMN turma_nome VARCHAR(255) DEFAULT NULL");
    if (!ex.has('aluno_id'))   add.push("ADD COLUMN aluno_id INT DEFAULT NULL");
    if (add.length) await pool.query(`ALTER TABLE disciplinar_atas ${add.join(', ')}`);
  } catch (e) { console.warn("[DISCIPLINAR-ATAS] migration ctx:", e.message); }
}
ensureTable().catch(err => console.error("[DISCIPLINAR-ATAS] Erro ao criar tabela:", err));

// ── Correção retroativa de nomes ──────────────────────────────────────────
async function fixNomesUsuario() {
  try {
    for (const col of ['criado','editado','finalizado']) {
      await pool.query(`
        UPDATE disciplinar_atas da JOIN usuarios u ON u.id = da.${col}_por_id
        SET da.${col}_por = u.nome
        WHERE (da.${col}_por IS NULL OR da.${col}_por = 'Usuário') AND da.${col}_por_id IS NOT NULL
      `);
    }
  } catch (e) { console.warn("[DISCIPLINAR-ATAS] fixNomes:", e.message); }
}
fixNomesUsuario();

// ── Helpers ───────────────────────────────────────────────────────────────
function hoje() {
  const m = ["janeiro","fevereiro","março","abril","maio","junho","julho","agosto","setembro","outubro","novembro","dezembro"];
  const d = new Date();
  return `${d.getDate()} de ${m[d.getMonth()]} de ${d.getFullYear()}`;
}
function fmtDataNasc(val) {
  if (!val) return "—";
  const d = new Date(val);
  if (isNaN(d.getTime())) return String(val);
  return `${String(d.getDate()).padStart(2,"0")}/${String(d.getMonth()+1).padStart(2,"0")}/${d.getFullYear()}`;
}
async function getNomeUsuario(req) {
  const uid = req.user?.usuario_id || req.user?.usuarioId || req.user?.id;
  if (!uid) return "Usuário";
  try {
    const [[row]] = await pool.query("SELECT nome FROM usuarios WHERE id = ? LIMIT 1", [uid]);
    return row?.nome || "Usuário";
  } catch { return "Usuário"; }
}

// ══ GET / — Listar ════════════════════════════════════════════════════════
router.get("/", async (req, res) => {
  try {
    const { escola_id } = req.user;
    const [rows] = await pool.query(
      `SELECT id, titulo, conteudo, status,
              turno, turma_id, turma_nome, aluno_id,
              criado_por, criado_em, editado_por, editado_em,
              finalizado_por, finalizado_em
       FROM disciplinar_atas WHERE escola_id = ? ORDER BY criado_em DESC`,
      [escola_id]
    );
    res.json(rows);
  } catch (err) {
    console.error("[DISCIPLINAR-ATAS] listar:", err);
    res.status(500).json({ error: "Erro ao buscar atas." });
  }
});

// ══ POST / — Criar ════════════════════════════════════════════════════════
router.post("/", async (req, res) => {
  try {
    const { escola_id, id: usuario_id } = req.user;
    const { titulo, conteudo, turno, turma_id, turma_nome, aluno_id } = req.body;
    if (!titulo || !conteudo) return res.status(400).json({ error: "Título e conteúdo são obrigatórios." });
    const nome = await getNomeUsuario(req);
    const [result] = await pool.query(
      `INSERT INTO disciplinar_atas
       (escola_id, titulo, conteudo, status, turno, turma_id, turma_nome, aluno_id, criado_por, criado_por_id)
       VALUES (?, ?, ?, 'Rascunho', ?, ?, ?, ?, ?, ?)`,
      [escola_id, titulo.trim(), conteudo.trim(), turno||null, turma_id||null, turma_nome||null, aluno_id||null, nome, usuario_id]
    );
    const [[ata]] = await pool.query("SELECT * FROM disciplinar_atas WHERE id = ?", [result.insertId]);
    res.status(201).json(ata);
  } catch (err) {
    console.error("[DISCIPLINAR-ATAS] criar:", err);
    res.status(500).json({ error: "Erro ao criar ata." });
  }
});

// ══ PUT /:id — Editar ═════════════════════════════════════════════════════
router.put("/:id", async (req, res) => {
  try {
    const { escola_id, id: usuario_id } = req.user;
    const { id } = req.params;
    const { titulo, conteudo } = req.body;
    const [[ata]] = await pool.query("SELECT id, status FROM disciplinar_atas WHERE id = ? AND escola_id = ?", [id, escola_id]);
    if (!ata) return res.status(404).json({ error: "Ata não encontrada." });
    if (ata.status === "Finalizado") return res.status(400).json({ error: "Não é possível editar uma ata finalizada." });
    const nome = await getNomeUsuario(req);
    await pool.query(
      `UPDATE disciplinar_atas SET titulo=?, conteudo=?, editado_por=?, editado_por_id=?, editado_em=NOW() WHERE id=? AND escola_id=?`,
      [titulo.trim(), conteudo.trim(), nome, usuario_id, id, escola_id]
    );
    const [[updated]] = await pool.query("SELECT * FROM disciplinar_atas WHERE id = ?", [id]);
    res.json(updated);
  } catch (err) {
    console.error("[DISCIPLINAR-ATAS] editar:", err);
    res.status(500).json({ error: "Erro ao editar ata." });
  }
});

// ══ POST /:id/finalizar ═══════════════════════════════════════════════════
router.post("/:id/finalizar", async (req, res) => {
  try {
    const { escola_id, id: usuario_id } = req.user;
    const { id } = req.params;
    const [[ata]] = await pool.query("SELECT id, status FROM disciplinar_atas WHERE id = ? AND escola_id = ?", [id, escola_id]);
    if (!ata) return res.status(404).json({ error: "Ata não encontrada." });
    if (ata.status === "Finalizado") return res.status(400).json({ error: "Ata já finalizada." });
    const nome = await getNomeUsuario(req);
    await pool.query(
      `UPDATE disciplinar_atas SET status='Finalizado', finalizado_por=?, finalizado_por_id=?, finalizado_em=NOW() WHERE id=? AND escola_id=?`,
      [nome, usuario_id, id, escola_id]
    );
    const [[updated]] = await pool.query("SELECT * FROM disciplinar_atas WHERE id = ?", [id]);
    res.json(updated);
  } catch (err) {
    console.error("[DISCIPLINAR-ATAS] finalizar:", err);
    res.status(500).json({ error: "Erro ao finalizar ata." });
  }
});

// ══ DELETE /:id ═══════════════════════════════════════════════════════════
router.delete("/:id", async (req, res) => {
  try {
    const { escola_id } = req.user;
    const { id } = req.params;
    const [[ata]] = await pool.query("SELECT id FROM disciplinar_atas WHERE id = ? AND escola_id = ?", [id, escola_id]);
    if (!ata) return res.status(404).json({ error: "Ata não encontrada." });
    await pool.query("DELETE FROM disciplinar_atas WHERE id = ? AND escola_id = ?", [id, escola_id]);
    res.json({ ok: true });
  } catch (err) {
    console.error("[DISCIPLINAR-ATAS] excluir:", err);
    res.status(500).json({ error: "Erro ao excluir ata." });
  }
});

// ══ GET /:id/pdf — PDF premium ════════════════════════════════════════════
router.get("/:id/pdf", async (req, res) => {
  try {
    const { escola_id } = req.user;
    const { id } = req.params;

    const [[ata]] = await pool.query("SELECT * FROM disciplinar_atas WHERE id = ? AND escola_id = ?", [id, escola_id]);
    if (!ata) return res.status(404).json({ error: "Ata não encontrada." });

    const [[escola]] = await pool.query("SELECT id, nome, apelido, endereco, cidade FROM escolas WHERE id = ?", [escola_id]);

    // Contexto aluno (se houver)
    let alunoCtx = null, respCtx = null;
    if (ata.aluno_id) {
      const [[aRow]] = await pool.query(
        `SELECT a.id, a.codigo, a.estudante, a.data_nascimento, t.nome AS turma, t.turno
         FROM alunos a LEFT JOIN turmas t ON t.id = a.turma_id
         WHERE a.id = ? AND a.escola_id = ?`, [ata.aluno_id, escola_id]
      );
      alunoCtx = aRow || null;
      if (alunoCtx) {
        const [[rRow]] = await pool.query(
          `SELECT r.nome FROM responsaveis r JOIN responsaveis_alunos ra ON ra.responsavel_id = r.id
           WHERE ra.aluno_id = ? AND ra.escola_id = ? AND ra.ativo = 1 ORDER BY ra.id ASC LIMIT 1`,
          [ata.aluno_id, escola_id]
        );
        respCtx = rRow || null;
      }
    }

    const logoLeft  = join(__dirname, "..", "assets", "images", "brasao-gdf.png");
    const logoRight = join(__dirname, "..", "assets", "images", "logo-escola-right.png");

    const L = 40, R = 40, PW = 595.28 - L - R;
    const PAGE_H = 841.89, FOOTER_Y = PAGE_H - 25, MAX_Y = FOOTER_Y - 15;

    const doc = new PDFDocument({ size: "A4", margins: { top: 30, bottom: 0, left: L, right: R }, autoFirstPage: true,
      info: { Title: `Ata — ${ata.titulo}`, Author: "EDUCA.MELHOR", Subject: "Ata Disciplinar Oficial" } });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="ata_${ata.id}.pdf"`);

    const chunks = [];
    const { PassThrough } = await import("stream");
    const pt = new PassThrough();
    pt.on("data", c => chunks.push(c));
    doc.pipe(pt);

    let pageNum = 1;
    const COR_AZUL = "#1e3a5f", COR_DOURADO = "#b8860b", COR_CINZA = "#555";

    const drawFooter = () =>
      doc.font("Helvetica").fontSize(6.5).fillColor("#aaa")
        .text(`Ata Oficial — Documento gerado pelo EDUCA.MELHOR • Página ${pageNum}`, L, FOOTER_Y, { width: PW, align: "center", lineBreak: false });

    const ensureSpace = (n) => {
      if (doc.y + n > MAX_Y) { drawFooter(); doc.addPage(); pageNum++; doc.y = 30; }
    };

    const drawSigLine = (x, y, w, nome, cargo) => {
      const ly = y + 30;
      doc.moveTo(x, ly).lineTo(x + w, ly).strokeColor("#333").lineWidth(0.5).stroke();
      if (nome) doc.font("Helvetica-Bold").fontSize(8).fillColor("#333").text(nome, x, ly + 3, { width: w, align: "center", lineBreak: false });
      doc.font("Helvetica").fontSize(7).fillColor("#666").text(cargo, x, ly + (nome ? 13 : 3), { width: w, align: "center", lineBreak: false });
    };

    // ── CABEÇALHO INSTITUCIONAL ─────────────────────────────────────────
    const headerTop = doc.y;
    const logoSize = 58;
    if (existsSync(logoLeft))  doc.image(logoLeft,  L, headerTop, { width: logoSize, height: logoSize });
    if (existsSync(logoRight)) doc.image(logoRight, L + PW - logoSize, headerTop, { width: logoSize, height: logoSize });

    const hx = L + logoSize + 8, hw = PW - (logoSize + 8) * 2;
    doc.font("Helvetica-Bold").fontSize(9).fillColor(COR_AZUL)
      .text("SECRETARIA DE ESTADO DE EDUCAÇÃO DO DISTRITO FEDERAL", hx, headerTop + 4, { width: hw, align: "center" });
    doc.font("Helvetica-Bold").fontSize(8.5).fillColor(COR_AZUL)
      .text(`COORDENAÇÃO REGIONAL DE ENSINO DE ${(escola?.cidade || "PLANALTINA").toUpperCase()}`, hx, doc.y + 1, { width: hw, align: "center" });
    const nomeCompleto = escola?.apelido ? `${escola.nome} — ${escola.apelido}` : (escola?.nome || "CEF04");
    doc.font("Helvetica-Bold").fontSize(9).fillColor(COR_AZUL)
      .text(nomeCompleto.toUpperCase(), hx, doc.y + 1, { width: hw, align: "center" });
    doc.font("Helvetica").fontSize(7.5).fillColor(COR_CINZA)
      .text(escola?.endereco || "", hx, doc.y + 1, { width: hw, align: "center" });

    doc.y = headerTop + logoSize + 4;

    // Linhas decorativas
    doc.moveTo(L, doc.y).lineTo(L + PW, doc.y).strokeColor(COR_DOURADO).lineWidth(2).stroke(); doc.y += 3;
    doc.moveTo(L, doc.y).lineTo(L + PW, doc.y).strokeColor(COR_AZUL).lineWidth(0.8).stroke();  doc.y += 8;

    // ── BLOCO DE CONTEXTO (entre linha dourada e título) ─────────────────
    const temCtx = ata.turma_nome || ata.turno || alunoCtx;
    if (temCtx) {
      const boxY = doc.y;
      if (alunoCtx) {
        // Aluno selecionado — 6 campos
        const boxH = 62;
        doc.roundedRect(L, boxY, PW, boxH, 4).fill("#eff6ff");
        doc.roundedRect(L, boxY, PW, boxH, 4).strokeColor("#1e3a5f").lineWidth(1).stroke();

        doc.font("Helvetica-Bold").fontSize(7.5).fillColor(COR_AZUL)
          .text("IDENTIFICAÇÃO DO ESTUDANTE", L + 6, boxY + 5, { width: PW - 12, align: "center" });

        // Nome + RE
        const lw = PW * 0.65, rw = PW * 0.33;
        doc.font("Helvetica-Bold").fontSize(9).fillColor("#0f172a")
          .text(alunoCtx.estudante || "—", L + 6, boxY + 15, { width: lw, lineBreak: false });
        doc.font("Helvetica").fontSize(8).fillColor(COR_CINZA)
          .text(`RE: ${alunoCtx.codigo || "—"}`, L + 6 + lw, boxY + 16, { width: rw - 6, align: "right", lineBreak: false });

        // Turma | Turno | Nasc.
        const linha2 = [
          alunoCtx.turma && `Turma: ${alunoCtx.turma}`,
          (ata.turno || alunoCtx.turno) && `Turno: ${ata.turno || alunoCtx.turno}`,
          alunoCtx.data_nascimento && `Nasc.: ${fmtDataNasc(alunoCtx.data_nascimento)}`,
        ].filter(Boolean).join("   |   ");
        doc.font("Helvetica").fontSize(8).fillColor(COR_CINZA)
          .text(linha2, L + 6, boxY + 28, { width: PW - 12, lineBreak: false });

        // Responsável
        if (respCtx) {
          doc.font("Helvetica").fontSize(8).fillColor(COR_CINZA)
            .text(`Responsável: ${respCtx.nome || "—"}`, L + 6, boxY + 40, { width: PW - 12, lineBreak: false });
        }
        doc.y = boxY + boxH + 6;
      } else {
        // Apenas turma/turno
        const boxH = 22;
        doc.roundedRect(L, boxY, PW, boxH, 4).fill("#eff6ff");
        doc.roundedRect(L, boxY, PW, boxH, 4).strokeColor("#1e3a5f").lineWidth(1).stroke();
        const info = [ata.turma_nome && `Turma: ${ata.turma_nome}`, ata.turno && `Turno: ${ata.turno}`].filter(Boolean).join("   |   ");
        doc.font("Helvetica-Bold").fontSize(9).fillColor(COR_AZUL)
          .text(info, L, boxY + 6, { width: PW, align: "center", lineBreak: false });
        doc.y = boxY + boxH + 6;
      }
    }

    // ── TÍTULO ───────────────────────────────────────────────────────────
    doc.font("Helvetica-Bold").fontSize(13).fillColor(COR_AZUL)
      .text("ATA DISCIPLINAR OFICIAL", L, doc.y, { width: PW, align: "center" });
    doc.y += 2;
    doc.moveTo(L, doc.y).lineTo(L + PW, doc.y).strokeColor("#ccc").lineWidth(0.5).stroke(); doc.y += 8;

    doc.font("Helvetica-Bold").fontSize(12).fillColor("#0f172a")
      .text(ata.titulo.toUpperCase(), L, doc.y, { width: PW, align: "center" });
    doc.y += 10;

    doc.font("Helvetica").fontSize(8).fillColor(COR_CINZA).text(`Documento ID: #${ata.id}`, L, doc.y, { width: PW * 0.5 });
    doc.y -= 9;
    doc.font("Helvetica").fontSize(8).fillColor(COR_CINZA).text(`Status: ${ata.status}`, L + PW * 0.5, doc.y, { width: PW * 0.5, align: "right" });
    doc.y += 12;
    doc.moveTo(L, doc.y).lineTo(L + PW, doc.y).strokeColor("#ccc").lineWidth(0.5).stroke(); doc.y += 10;

    // ── CONTEÚDO ─────────────────────────────────────────────────────────
    doc.font("Helvetica-Bold").fontSize(10).fillColor(COR_AZUL).text("REGISTRO:", L, doc.y, { width: PW });
    doc.y += 6;
    for (const para of ata.conteudo.split("\n").filter(Boolean)) {
      ensureSpace(30);
      doc.font("Helvetica").fontSize(10).fillColor("#1a1a1a").text(para, L, doc.y, { width: PW, lineGap: 2, align: "justify" });
      doc.y += 4;
    }

    // ── RASTREABILIDADE ───────────────────────────────────────────────────
    ensureSpace(80);
    doc.y += 6;
    doc.moveTo(L, doc.y).lineTo(L + PW, doc.y).strokeColor("#ccc").lineWidth(0.5).stroke(); doc.y += 8;
    doc.font("Helvetica-Bold").fontSize(9).fillColor(COR_AZUL).text("RASTREABILIDADE DOCUMENTAL", L, doc.y, { width: PW });
    doc.y += 5;
    const fmtDt = v => v ? new Date(v).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }) : "—";
    [
      { label: "Criado por",     nome: ata.criado_por,     em: fmtDt(ata.criado_em) },
      { label: "Editado por",    nome: ata.editado_por,    em: fmtDt(ata.editado_em) },
      { label: "Finalizado por", nome: ata.finalizado_por, em: fmtDt(ata.finalizado_em) },
    ].filter(t => t.nome).forEach(t => {
      doc.font("Helvetica").fontSize(8).fillColor(COR_CINZA)
        .text(`${t.label}: ${t.nome} — ${t.em}`, L + 4, doc.y, { width: PW - 8 });
      doc.y += 1;
    });

    // ── ASSINATURAS ───────────────────────────────────────────────────────
    ensureSpace(120);
    doc.y += 10;
    doc.moveTo(L, doc.y).lineTo(L + PW, doc.y).strokeColor("#ccc").lineWidth(0.5).stroke(); doc.y += 8;
    doc.font("Helvetica-Bold").fontSize(10).fillColor(COR_AZUL).text("ASSINATURAS", L, doc.y, { width: PW });
    doc.y += 4;
    doc.font("Helvetica").fontSize(9).fillColor("#333")
      .text(`${escola?.cidade || "Planaltina"} — DF, ${hoje()}.`, L, doc.y, { width: PW, align: "right" });
    doc.y += 18;

    const sigW = PW * 0.40, sigGap = PW * 0.20;
    const ySig1 = doc.y;
    drawSigLine(L,                    ySig1, sigW, "", "Responsável Legal / Assinante");
    drawSigLine(L + sigW + sigGap,    ySig1, sigW, ata.finalizado_por || "", "Militar Solicitante / Finalizador");
    doc.y = ySig1 + 52;

    ensureSpace(60);
    const cmdW = PW * 0.50;
    drawSigLine(L + (PW - cmdW) / 2, doc.y, cmdW, "", "Diretor(a) / Comandante Disciplinar");
    doc.y += 52;

    drawFooter();
    pt.on("end", () => { const buf = Buffer.concat(chunks); res.setHeader("Content-Length", buf.length); res.end(buf); });
    doc.end();
  } catch (err) {
    console.error("[DISCIPLINAR-ATAS] pdf:", err);
    if (!res.headersSent) res.status(500).json({ error: "Erro ao gerar PDF." });
  }
});

export default router;
