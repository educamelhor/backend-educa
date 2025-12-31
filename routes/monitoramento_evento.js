// routes/monitoramento_evento.js
// ============================================================================
// MONITORAMENTO — EVENTOS DE RECONHECIMENTO FACIAL
// ============================================================================

import express from "express";
import pool from "../db.js";
import * as XLSX from "xlsx";
import PDFDocument from "pdfkit";

const router = express.Router();

// ============================================================================
// DEBUG LOGGER (apenas para esta rota)
// ============================================================================
router.use((req, _res, next) => {
  const path = req.path || "";
  if (
    path.startsWith("/presencas-turno") ||
    path.startsWith("/presencas-turno.xlsx") ||
    path.startsWith("/presencas-turno.pdf")
  ) {
    console.log("[monitoramento_evento] =>", req.method, path);
  }
  next();
});

// ============================================================================
// Helpers
// ============================================================================
function toNumber(n, def = 0) {
  const v = Number(n);
  return Number.isFinite(v) ? v : def;
}

function toDateOnlyStr(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function toTimeStr(d) {
  return d.toTimeString().slice(0, 8);
}

// ============================================================================
// GET /api/monitoramento/eventos/recentes
// Lista últimos N eventos para depuração/inspeção rápida
// ============================================================================
router.get("/eventos/recentes", async (req, res) => {
  try {
    const escola_id = toNumber(req.header("x-escola-id"));
    if (!escola_id) return res.status(422).json({ ok: false, message: "x-escola-id obrigatório" });

    const limit = Math.min(Math.max(toNumber(req.query.limit, 20), 1), 200);

    const sql = `
      SELECT
        me.id, me.escola_id, me.camera_id, me.aluno_id,
        me.status, me.conf AS score, me.bbox, me.created_at,
        a.estudante AS aluno_nome, t.nome_turma AS turma
      FROM monitoramento_eventos me
      LEFT JOIN alunos a   ON a.id = me.aluno_id
      LEFT JOIN turmas t   ON t.id = a.turma_id
      WHERE me.escola_id = ?
      ORDER BY me.created_at DESC
      LIMIT ?
    `;
    const [rows] = await pool.query(sql, [escola_id, limit]);

    res.json({ ok: true, rows });
  } catch (e) {
    console.error("[monitoramento_evento] /eventos/recentes:", e);
    res.status(500).json({ ok: false, message: "Falha ao consultar eventos." });
  }
});

// ============================================================================
// GET /api/monitoramento/presencas-turno
// Lista consolidação de presenças do dia/turno
// ============================================================================
router.get("/presencas-turno", async (req, res) => {
  try {
    const escolaId = toNumber(req.header("x-escola-id"));
    if (!escolaId) return res.status(422).json({ ok: false, message: "x-escola-id obrigatório" });

    const hoje = new Date();
    const dataDia = (req.query.data || "").trim() || toDateOnlyStr(hoje);
    const turno = (req.query.turno || "").trim().toLowerCase() || "matutino";

    const sql = `
      SELECT
        a.id          AS aluno_id,
        a.codigo      AS codigo,
        a.estudante   AS nome,
        t.nome_turma  AS turma,
        pd.horario    AS horario,          -- primeira detecção / confirmação
        pd.ultima_confirmacao AS ultima    -- última fusão/refresh de presença
      FROM presencas_diarias pd
      LEFT JOIN alunos  a ON a.id   = pd.aluno_id
      LEFT JOIN turmas  t ON t.id   = a.turma_id
     WHERE pd.data = ?
       AND pd.turno = ?
       AND a.escola_id = ?
     ORDER BY a.estudante ASC
    `;
    const [rows] = await pool.query(sql, [dataDia, turno, escolaId]);

    const presentes = rows.map(r => ({
      aluno_id: r.aluno_id,
      codigo: (r.codigo !== null && r.codigo !== undefined) ? String(r.codigo) : "—",
      nome: r.nome || "—",
      turma: r.turma || "—",
      horario: r.horario || null,
      ultima: r.ultima || null,
    }));

    res.json({
      ok: true,
      escola_id: escolaId,
      data: dataDia,
      turno,
      total: presentes.length,
      presentes,
    });
  } catch (e) {
    console.error("[monitoramento_evento] /presencas-turno:", e);
    res.status(500).json({ ok: false, message: "Falha ao consultar presenças." });
  }
});

// ============================================================================
// GET /api/monitoramento/presencas-turno.xlsx
// Exporta planilha com presenças do turno
// ============================================================================
router.get("/presencas-turno.xlsx", async (req, res) => {
  try {
    const escolaId = toNumber(req.header("x-escola-id"));
    if (!escolaId) return res.status(422).json({ ok: false, message: "x-escola-id obrigatório" });

    const hoje = new Date();
    const dataDia = (req.query.data || "").trim() || toDateOnlyStr(hoje);
    const turno = (req.query.turno || "").trim().toLowerCase() || "matutino";

    const sql = `
      SELECT
        a.id          AS aluno_id,
        a.codigo      AS codigo,
        a.estudante   AS nome,
        t.nome_turma  AS turma,
        pd.horario    AS horario,
        pd.ultima_confirmacao AS ultima
      FROM presencas_diarias pd
      LEFT JOIN alunos  a ON a.id   = pd.aluno_id
      LEFT JOIN turmas  t ON t.id   = a.turma_id
     WHERE pd.data = ?
       AND pd.turno = ?
       AND a.escola_id = ?
     ORDER BY a.estudante ASC
    `;
    const [rows] = await pool.query(sql, [dataDia, turno, escolaId]);

    const data = rows.map(r => ({
      "Código": (r.codigo !== null && r.codigo !== undefined) ? String(r.codigo) : "—",
      "Estudante": r.nome || "—",
      "Turma": r.turma || "—",
      "Horário": r.horario || "",
      "Última Conf.": r.ultima || "",
    }));

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(data);
    XLSX.utils.book_append_sheet(wb, ws, "Presenças");
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="presencas_${dataDia}_${turno}.xlsx"`);
    return res.send(buf);
  } catch (e) {
    console.error("[monitoramento_evento] Erro export.xlsx:", e);
    res.status(500).json({ ok: false, message: "Erro ao gerar planilha." });
  }
});

// ============================================================================
// GET /api/monitoramento/presencas-turno.pdf
// Exporta PDF enxuto com presenças do turno
// ============================================================================
router.get("/presencas-turno.pdf", async (req, res) => {
  try {
    const escolaId = toNumber(req.header("x-escola-id"));
    if (!escolaId) return res.status(422).json({ ok: false, message: "x-escola-id obrigatório" });

    const hoje = new Date();
    const dataDia = (req.query.data || "").trim() || toDateOnlyStr(hoje);
    const turno = (req.query.turno || "").trim().toLowerCase() || "matutino";

    const sqlPres = `
      SELECT
        a.id          AS aluno_id,
        a.codigo      AS codigo,
        a.estudante   AS nome,
        t.nome_turma  AS turma,
        pd.horario    AS horario,
        pd.ultima_confirmacao AS ultima
      FROM presencas_diarias pd
      LEFT JOIN alunos  a ON a.id   = pd.aluno_id
      LEFT JOIN turmas  t ON t.id   = a.turma_id
     WHERE pd.data = ?
       AND pd.turno = ?
       AND a.escola_id = ?
     ORDER BY a.estudante ASC
    `;
    const [rowsPres] = await pool.query(sqlPres, [dataDia, turno, escolaId]);

    const presentes = rowsPres.map(r => ({
      aluno_id: r.aluno_id,
      codigo: (r.codigo !== null && r.codigo !== undefined) ? String(r.codigo) : "—",
      nome: r.nome || "—",
      turma: r.turma || "—",
      horario: r.horario || null,
      ultima: r.ultima || null,
    }));

    // --- Layout simples ---
    const doc = new PDFDocument({ size: "A4", margin: 40 });
    const buffers = [];
    doc.on("data", (d) => buffers.push(d));
    doc.on("end", () => {
      const buf = Buffer.concat(buffers);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="presencas_${dataDia}_${turno}.pdf"`);
      res.send(buf);
    });

    doc.fontSize(16).text(`Presenças — ${dataDia} (${turno})`, { align: "center" });
    doc.moveDown(1);

    const colX = [40, 110, 360, 450, 520];
    doc.fontSize(11).text("Código", colX[0], doc.y);
    doc.text("Estudante", colX[1], doc.y);
    doc.text("Turma", colX[2], doc.y);
    doc.text("1ª Conf.", colX[3], doc.y);
    doc.text("Última", colX[4], doc.y);
    doc.moveDown(0.5);
    doc.moveTo(40, doc.y).lineTo(555, doc.y).stroke();

    presentes.forEach((p) => {
      doc.moveDown(0.3);
      doc.text(p.codigo,    colX[0], doc.y);
      doc.text(p.nome,      colX[1], doc.y);
      doc.text(p.turma,     colX[2], doc.y);
      doc.text(p.horario || "", colX[3], doc.y);
      doc.text(p.ultima  || "", colX[4], doc.y);
    });

    // Rodapé com total
    doc.moveDown(1);
    doc.moveTo(40, doc.y).lineTo(555, doc.y).stroke();
    doc.moveDown(0.3);
    doc.text(`Total: ${presentes.length}`, { align: "right" });

    // (Opcional) Ausentes — se quiser montar a partir de tabela alunos/inscritos:
    // Mantive apenas o placeholder do fluxo, para futura expansão.
    const incluirAusentes = false;
    if (incluirAusentes) {
      const ausentes = [];
      doc.addPage();
      doc.fontSize(16).text("Ausentes", { align: "center" });
      doc.moveDown(1);
      doc.fontSize(11).list(
        ausentes.map(a => `${a.codigo} - ${a.nome} (${a.turma || "—"})`),
        { bulletRadius: 2 }
      );
    }

    doc.end();
  } catch (e) {
    console.error("[monitoramento_evento] Erro export.pdf:", e);
    res.status(500).json({ ok: false, message: "Erro ao gerar PDF." });
  }
});

// ============================================================================
export default router;
