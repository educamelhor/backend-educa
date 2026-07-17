// routes/monitoramento_evento.js
// ============================================================================
// MONITORAMENTO — EVENTOS DE RECONHECIMENTO FACIAL
// ============================================================================

import express from "express";
import pool from "../db.js";
import * as XLSX from "xlsx";
import PDFDocument from "pdfkit";

import { autenticarToken } from "../middleware/autenticarToken.js";
import { verificarEscola } from "../middleware/verificarEscola.js";
import { autorizarPermissao } from "../middleware/autorizarPermissao.js";

const router = express.Router();

// 🔒 RBAC — exige login + escola válida + permissão do módulo
router.use(autenticarToken, verificarEscola, autorizarPermissao("monitoramento.visualizar"));

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
    const escola_id = toNumber(req.escola_id);
    if (!escola_id) return res.status(422).json({ ok: false, message: "escola_id obrigatório" });

    const limit = Math.min(Math.max(toNumber(req.query.limit, 20), 1), 200);

    const sql = `
      SELECT
        me.id, me.escola_id, me.camera_id, me.aluno_id,
        me.status, me.conf AS score, me.bbox, me.created_at,
        a.estudante AS aluno_nome, t.nome AS turma
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
    const escolaId = toNumber(req.escola_id);
    if (!escolaId) return res.status(422).json({ ok: false, message: "escola_id obrigatório" });

    const hoje = new Date();
    const dataDia = (req.query.data || "").trim() || toDateOnlyStr(hoje);
    const turno   = (req.query.turno  || "").trim().toLowerCase() || "matutino";

    // ── Presentes (registros em presencas_diarias) ──────────────────────────
    const sqlPres = `
      SELECT
        a.id          AS aluno_id,
        a.codigo      AS codigo,
        a.estudante   AS nome,
        t.nome        AS turma,
        pd.horario    AS horario,
        pd.camera_id_origem,
        pd.ultima_confirmacao AS ultima
      FROM presencas_diarias pd
      LEFT JOIN alunos  a ON a.id   = pd.aluno_id
      LEFT JOIN turmas  t ON t.id   = a.turma_id
      WHERE pd.data = ?
        AND pd.turno = ?
        AND pd.escola_id = ?
        AND a.escola_id = ?
      ORDER BY a.estudante ASC
    `;
    const [rowsPres] = await pool.query(sqlPres, [dataDia, turno, escolaId, escolaId]);

    const idsPresentes = rowsPres.map(r => r.aluno_id).filter(Boolean);

    const presentes = rowsPres.map(r => ({
      aluno_id:        r.aluno_id,
      codigo:          (r.codigo !== null && r.codigo !== undefined) ? String(r.codigo) : "—",
      nome:            r.nome   || "—",
      turma:           r.turma  || "—",
      horario:         r.horario || null,
      camera_id_origem: r.camera_id_origem || null,
      ultima:          r.ultima  || null,
    }));

    // ── Ausentes (alunos do turno que NÃO constam em presencas_diarias) ─────
    let ausentes = [];
    if (["matutino", "vespertino", "noturno"].includes(turno)) {
      const sqlAus = `
        SELECT
          a.id       AS aluno_id,
          a.codigo   AS codigo,
          a.estudante AS nome,
          t.nome     AS turma
        FROM alunos a
        INNER JOIN turmas t ON t.id = a.turma_id
        WHERE a.escola_id = ?
          AND t.turno = ?
          ${ idsPresentes.length > 0 ? "AND a.id NOT IN (" + idsPresentes.map(() => "?").join(",") + ")" : "" }
        ORDER BY a.estudante ASC
      `;
      const params = idsPresentes.length > 0
        ? [escolaId, turno, ...idsPresentes]
        : [escolaId, turno];
      const [rowsAus] = await pool.query(sqlAus, params);
      ausentes = rowsAus.map(r => ({
        aluno_id: r.aluno_id,
        codigo:   (r.codigo !== null && r.codigo !== undefined) ? String(r.codigo) : "—",
        nome:     r.nome  || "—",
        turma:    r.turma || "—",
      }));
    }

    res.json({
      ok: true,
      escola_id: escolaId,
      data:             dataDia,
      turno,
      total_presentes:  presentes.length,
      total_ausentes:   ausentes.length,
      presentes,
      ausentes,
    });
  } catch (e) {
    console.error("[monitoramento_evento] /presencas-turno:", e);
    res.status(500).json({ ok: false, message: "Falha ao consultar presenças." });
  }
});

// ============================================================================
// GET /api/monitoramento/presencas-turno/export.xlsx  (URL que o frontend usa)
// GET /api/monitoramento/presencas-turno.xlsx          (alias de compatibilidade)
// Exporta planilha com presenças + ausentes do turno
// ============================================================================
async function handleExportXlsx(req, res) {
  try {
    const escolaId = toNumber(req.escola_id);
    if (!escolaId) return res.status(422).json({ ok: false, message: "escola_id obrigatório" });

    const hoje = new Date();
    const dataDia = (req.query.data  || "").trim() || toDateOnlyStr(hoje);
    const turno   = (req.query.turno || "").trim().toLowerCase() || "matutino";
    const aba     = (req.query.aba   || "ambos").toLowerCase(); // "presentes"|"ausentes"|"ambos"

    // Presentes
    const sqlPres = `
      SELECT a.codigo, a.estudante AS nome, t.nome AS turma,
             pd.horario, pd.camera_id_origem
      FROM presencas_diarias pd
      LEFT JOIN alunos a ON a.id = pd.aluno_id
      LEFT JOIN turmas t ON t.id = a.turma_id
      WHERE pd.data = ? AND pd.turno = ? AND pd.escola_id = ? AND a.escola_id = ?
      ORDER BY a.estudante ASC
    `;
    const [rowsPres] = await pool.query(sqlPres, [dataDia, turno, escolaId, escolaId]);
    const idsPresentes = rowsPres.map(r => r.aluno_id).filter(Boolean);

    // Ausentes
    let rowsAus = [];
    if (["matutino", "vespertino", "noturno"].includes(turno)) {
      const sqlAus = `
        SELECT a.codigo, a.estudante AS nome, t.nome AS turma
        FROM alunos a INNER JOIN turmas t ON t.id = a.turma_id
        WHERE a.escola_id = ? AND t.turno = ?
        ${ idsPresentes.length > 0 ? "AND a.id NOT IN (" + idsPresentes.map(() => "?").join(",") + ")" : "" }
        ORDER BY a.estudante ASC
      `;
      [rowsAus] = await pool.query(
        sqlAus,
        idsPresentes.length > 0 ? [escolaId, turno, ...idsPresentes] : [escolaId, turno]
      );
    }

    const wb = XLSX.utils.book_new();

    if (aba === "presentes" || aba === "ambos") {
      const dataPres = rowsPres.map(r => ({
        "Código":   String(r.codigo ?? "—"),
        "Estudante": r.nome  || "—",
        "Turma":    r.turma  || "—",
        "Horário":  r.horario || "",
        "Câmera":   r.camera_id_origem ? `Câmera ${r.camera_id_origem}` : "",
      }));
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(dataPres), "Presentes");
    }
    if (aba === "ausentes" || aba === "ambos") {
      const dataAus = rowsAus.map(r => ({
        "Código":   String(r.codigo ?? "—"),
        "Estudante": r.nome  || "—",
        "Turma":    r.turma  || "—",
      }));
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(dataAus), "Ausentes");
    }

    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
    const filename = `presencas_${turno}_${dataDia}.xlsx`;
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
    return res.send(buf);
  } catch (e) {
    console.error("[monitoramento_evento] Erro export.xlsx:", e);
    res.status(500).json({ ok: false, message: "Erro ao gerar planilha." });
  }
}
router.get("/presencas-turno/export.xlsx", handleExportXlsx);
router.get("/presencas-turno.xlsx",         handleExportXlsx);

// ============================================================================
// COMPAT: antigo endpoint que foi refatorado acima — manter para não quebrar
// ============================================================================
router.get("/presencas-turno.xlsx_LEGADO_REMOVIDO", async (req, res) => {
  try {
    const escolaId = toNumber(req.escola_id);
    if (!escolaId) return res.status(422).json({ ok: false, message: "escola_id obrigatório" });

    const hoje = new Date();
    const dataDia = (req.query.data || "").trim() || toDateOnlyStr(hoje);
    const turno = (req.query.turno || "").trim().toLowerCase() || "matutino";

    const sql = `
      SELECT
        a.id          AS aluno_id,
        a.codigo      AS codigo,
        a.estudante   AS nome,
        t.nome        AS turma,
        pd.horario    AS horario,
        pd.ultima_confirmacao AS ultima
      FROM presencas_diarias pd
      LEFT JOIN alunos  a ON a.id   = pd.aluno_id
      LEFT JOIN turmas  t ON t.id   = a.turma_id
     WHERE pd.data = ?
       AND pd.turno = ?
       AND pd.escola_id = ?
       AND a.escola_id = ?
     ORDER BY a.estudante ASC
    `;
    const [rows] = await pool.query(sql, [dataDia, turno, escolaId, escolaId]);

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
// GET /api/monitoramento/presencas-turno/export.pdf  (URL que o frontend usa)
// GET /api/monitoramento/presencas-turno.pdf          (alias de compatibilidade)
// Exporta PDF com presenças e/ou ausentes do turno
// ============================================================================
async function handleExportPdf(req, res) {
  try {
    const escolaId = toNumber(req.escola_id);
    if (!escolaId) return res.status(422).json({ ok: false, message: "escola_id obrigatório" });

    const hoje = new Date();
    const dataDia  = (req.query.data      || "").trim() || toDateOnlyStr(hoje);
    const turno    = (req.query.turno     || "").trim().toLowerCase() || "matutino";
    const aba      = (req.query.aba       || "ambos").toLowerCase();
    const cabecalho = req.query.cabecalho !== "0";

    // Presentes
    const [rowsPres] = await pool.query(`
      SELECT a.codigo, a.estudante AS nome, t.nome AS turma, pd.horario, pd.camera_id_origem
      FROM presencas_diarias pd
      LEFT JOIN alunos a ON a.id = pd.aluno_id
      LEFT JOIN turmas t ON t.id = a.turma_id
      WHERE pd.data = ? AND pd.turno = ? AND pd.escola_id = ? AND a.escola_id = ?
      ORDER BY a.estudante ASC`, [dataDia, turno, escolaId, escolaId]);

    const idsPresentes = rowsPres.map(r => r.aluno_id).filter(Boolean);

    let rowsAus = [];
    if ((aba === "ausentes" || aba === "ambos") && ["matutino","vespertino","noturno"].includes(turno)) {
      const sqlAus = `SELECT a.codigo, a.estudante AS nome, t.nome AS turma FROM alunos a INNER JOIN turmas t ON t.id = a.turma_id WHERE a.escola_id = ? AND t.turno = ?${idsPresentes.length > 0 ? " AND a.id NOT IN (" + idsPresentes.map(() => "?").join(",") + ")" : ""} ORDER BY a.estudante ASC`;
      [rowsAus] = await pool.query(sqlAus, idsPresentes.length > 0 ? [escolaId, turno, ...idsPresentes] : [escolaId, turno]);
    }

    const doc = new PDFDocument({ size: "A4", margin: 40 });
    const buffers = [];
    doc.on("data", d => buffers.push(d));
    doc.on("end", () => {
      const buf = Buffer.concat(buffers);
      const filename = `presencas_${turno}_${aba}_${dataDia}.pdf`;
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
      res.send(buf);
    });

    const turnoLabel = turno.charAt(0).toUpperCase() + turno.slice(1);

    if (cabecalho) {
      doc.fontSize(14).font("Helvetica-Bold").text(`Presenças — ${turnoLabel}`, { align: "center" });
      doc.fontSize(10).font("Helvetica").text(`Data: ${dataDia}`, { align: "center" });
      doc.moveDown(0.5);
    }

    function drawTable(titulo, rows, colunas) {
      doc.fontSize(12).font("Helvetica-Bold").text(titulo);
      doc.moveDown(0.3);
      const startY = doc.y;
      doc.fontSize(9).font("Helvetica-Bold");
      colunas.forEach(c => doc.text(c.label, c.x, startY, { width: c.w, lineBreak: false }));
      doc.moveDown(0.5);
      doc.moveTo(40, doc.y).lineTo(555, doc.y).stroke();
      doc.font("Helvetica").fontSize(8);
      rows.forEach(row => {
        const y = doc.y + 3;
        colunas.forEach(c => doc.text(String(row[c.key] || ""), c.x, y, { width: c.w, lineBreak: false }));
        doc.moveDown(0.6);
      });
      doc.moveDown(0.3);
      doc.fontSize(9).font("Helvetica-Bold").text(`Total: ${rows.length}`, { align: "right" });
      doc.moveDown(1);
    }

    if (aba === "presentes" || aba === "ambos") {
      drawTable(`Presentes (${rowsPres.length})`, rowsPres.map(r => ({
        codigo: String(r.codigo ?? "—"),
        nome:   r.nome  || "—",
        turma:  r.turma || "—",
        horario: r.horario ? String(r.horario).slice(0,5) : "—",
        camera: r.camera_id_origem ? `Câm. ${r.camera_id_origem}` : "",
      })), [
        { label: "Código",   key: "codigo",  x: 40,  w: 60  },
        { label: "Estudante",key: "nome",    x: 105, w: 230 },
        { label: "Turma",    key: "turma",   x: 340, w: 100 },
        { label: "Hora",     key: "horario", x: 445, w: 50  },
        { label: "Câmera",   key: "camera",  x: 500, w: 55  },
      ]);
    }

    if (aba === "ausentes" || aba === "ambos") {
      if (aba === "ambos") doc.addPage();
      drawTable(`Ausentes (${rowsAus.length})`, rowsAus.map(r => ({
        codigo: String(r.codigo ?? "—"),
        nome:   r.nome  || "—",
        turma:  r.turma || "—",
      })), [
        { label: "Código",   key: "codigo", x: 40,  w: 70  },
        { label: "Estudante",key: "nome",   x: 115, w: 280 },
        { label: "Turma",    key: "turma",  x: 400, w: 155 },
      ]);
    }

    doc.end();
  } catch (e) {
    console.error("[monitoramento_evento] Erro export.pdf:", e);
    res.status(500).json({ ok: false, message: "Erro ao gerar PDF." });
  }
}
router.get("/presencas-turno/export.pdf", handleExportPdf);
router.get("/presencas-turno.pdf",         handleExportPdf);

// ── antigo bloco que existia para o .pdf (foi refatorado acima) ─────────────
router.get("/presencas-turno.pdf_LEGADO_REMOVIDO", async (req, res) => {
  try {
    const escolaId = toNumber(req.escola_id);
    if (!escolaId) return res.status(422).json({ ok: false, message: "escola_id obrigatório" });

    const hoje = new Date();
    const dataDia = (req.query.data || "").trim() || toDateOnlyStr(hoje);
    const turno = (req.query.turno || "").trim().toLowerCase() || "matutino";

    const sqlPres = `
      SELECT
        a.id          AS aluno_id,
        a.codigo      AS codigo,
        a.estudante   AS nome,
        t.nome        AS turma,
        pd.horario    AS horario,
        pd.ultima_confirmacao AS ultima
      FROM presencas_diarias pd
      LEFT JOIN alunos  a ON a.id   = pd.aluno_id
      LEFT JOIN turmas  t ON t.id   = a.turma_id
     WHERE pd.data = ?
       AND pd.turno = ?
       AND pd.escola_id = ?
       AND a.escola_id = ?
     ORDER BY a.estudante ASC
    `;
    const [rowsPres] = await pool.query(sqlPres, [dataDia, turno, escolaId, escolaId]);

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
