// routes/disponibilidades.js
// ============================================================================
// Disponibilidades de Professores por Turno/Dia/Período
// ----------------------------------------------------------------------------
// Objetivo
//   • GET  /api/disponibilidades           → expandido: [{ professor_id, dia, ordem, status }]
//   • POST /api/disponibilidades/upsert    → upsert por (escola_id, professor_id, turno, dia_semana)
// Observações
//   • Sem uso de created_at/updated_at (compatível com seu esquema atual).
//   • Campo `turno` (ENUM no DB) é minúsculo; normalizamos.
//   • Coluna `periodos` é JSON; parser robusto (string | Buffer | objeto).
//   • Ausência de períodos = "livre" por padrão (não gera linhas).
// ============================================================================

import express from "express";
import pool from "../db.js";

const router = express.Router();

// ----------------------------------------------------------------------------
// Middleware local: exige escola_id no usuário autenticado
// ----------------------------------------------------------------------------
function exigirEscola(req, res, next) {
  if (!req.user || !req.user.escola_id) {
    return res.status(403).json({ message: "Acesso negado: escola não definida." });
  }
  next();
}

// ----------------------------------------------------------------------------
function parseJsonColumn(raw) {
  try {
    if (Array.isArray(raw)) return raw;
    if (raw && typeof raw === "object" && !Buffer.isBuffer(raw)) {
      return Array.isArray(raw) ? raw : [];
    }
    if (typeof raw === "string") return JSON.parse(raw || "[]");
    if (raw && Buffer.isBuffer(raw)) return JSON.parse(raw.toString("utf8") || "[]");
  } catch {
    /* ignore */
  }
  return [];
}

// ============================================================================
// GET /api/disponibilidades?turno=...&professor_id=&dia_semana=
// ============================================================================
router.get("/", exigirEscola, async (req, res) => {
  try {
    const escola_id = req.user.escola_id;
    const turno = String(req.query.turno || "").trim();
    if (!turno) {
      return res.status(400).json({ message: "Parâmetro 'turno' é obrigatório." });
    }
    const turnoNorm = turno.toLowerCase();

    const professorId = req.query.professor_id ? Number(req.query.professor_id) : null;
    const diaSemana = req.query.dia_semana ? Number(req.query.dia_semana) : null;

    let sql = `
      SELECT professor_id,
             dia_semana               AS dia,
             COALESCE(status,'livre') AS status_padrao,
             periodos                 AS periodos_json
        FROM grade_disponibilidades
       WHERE escola_id = ?
         AND turno     = ?
    `;
    const params = [escola_id, turnoNorm];

    if (Number.isFinite(professorId) && professorId > 0) {
      sql += " AND professor_id = ?";
      params.push(professorId);
    }
    if (Number.isFinite(diaSemana) && diaSemana > 0) {
      sql += " AND dia_semana = ?";
      params.push(diaSemana);
    }

    const [rows] = await pool.query(sql, params);

    const out = [];
    for (const r of rows) {
      const arr = parseJsonColumn(r.periodos_json);
      for (const it of arr) {
        const ordemNum = Number(it?.ordem);
        if (!Number.isFinite(ordemNum)) continue;
        const status = String(it?.status || r.status_padrao || "livre");
        out.push({
          professor_id: Number(r.professor_id),
          dia: Number(r.dia),
          ordem: ordemNum,
          status, // "livre" | "indisponivel" | "evitar"
        });
      }
    }

    return res.json(out);
  } catch (err) {
    console.error("Erro no GET /disponibilidades:", err);
    return res.status(500).json({ message: "Erro ao carregar disponibilidades." });
  }
});

// ============================================================================
// POST /api/disponibilidades/upsert
// Body:
// {
//   professor_id: number,
//   turno: "matutino"|"vespertino"|"noturno"|"integral",
//   dia_semana: number,
//   status_padrao?: "livre"|"indisponivel"|"evitar",
//   periodos: [{ordem:number, status:"livre"|"indisponivel"|"evitar"}]
// }
// ============================================================================
router.post("/upsert", exigirEscola, async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const escola_id = req.user.escola_id;

    const {
      professor_id,
      turno,
      dia_semana,
      status_padrao = "livre",
      periodos,
    } = req.body || {};

    if (!professor_id || !turno || !dia_semana || !Array.isArray(periodos)) {
      return res.status(400).json({
        message: "professor_id, turno, dia_semana e periodos são obrigatórios.",
      });
    }

    const profId = Number(professor_id);
    const dia = Number(dia_semana);
    if (!Number.isFinite(profId) || profId <= 0) {
      return res.status(400).json({ message: "professor_id inválido." });
    }
    if (!Number.isFinite(dia) || dia <= 0) {
      return res.status(400).json({ message: "dia_semana inválido." });
    }

    const turnoNorm = String(turno).toLowerCase();

    const normPeriodos = [];
    for (const it of periodos) {
      const ordemNum = Number(it?.ordem);
      if (!Number.isFinite(ordemNum) || ordemNum <= 0) continue;
      const st = String(it?.status || "livre").toLowerCase();
      normPeriodos.push({
        ordem: ordemNum,
        status: ["livre", "indisponivel", "evitar"].includes(st) ? st : "livre",
      });
    }

    const periodosJson = JSON.stringify(normPeriodos);
    const statusDefault = ["livre", "indisponivel", "evitar"].includes(String(status_padrao).toLowerCase())
      ? String(status_padrao).toLowerCase()
      : "livre";

    await conn.beginTransaction();

    // Existe?
    const [[existe]] = await conn.query(
      `
      SELECT id
        FROM grade_disponibilidades
       WHERE escola_id = ?
         AND professor_id = ?
         AND turno = ?
         AND dia_semana = ?
       LIMIT 1
      `,
      [escola_id, profId, turnoNorm, dia]
    );

    let id;
    let atualizado = false;

    if (existe?.id) {
      // UPDATE (sem updated_at, compatível com seu schema)
      await conn.query(
        `
        UPDATE grade_disponibilidades
           SET status = ?, periodos = ?
         WHERE id = ?
        `,
        [statusDefault, periodosJson, existe.id]
      );
      id = existe.id;
      atualizado = true;
    } else {
      // INSERT (sem created_at/updated_at)
      const [ins] = await conn.query(
        `
        INSERT INTO grade_disponibilidades
          (escola_id, professor_id, turno, dia_semana, status, periodos)
        VALUES (?, ?, ?, ?, ?, ?)
        `,
        [escola_id, profId, turnoNorm, dia, statusDefault, periodosJson]
      );
      id = ins.insertId;
    }

    await conn.commit();
    return res.json({ ok: true, id, atualizado });
  } catch (err) {
    try { await conn.rollback(); } catch {}
    console.error("Erro no POST /disponibilidades/upsert:", err);
    return res.status(500).json({ message: "Erro ao salvar disponibilidades." });
  } finally {
    try { conn.release(); } catch {}
  }
});

export default router;
