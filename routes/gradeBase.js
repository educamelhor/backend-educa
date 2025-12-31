// routes/gradeBase.js
// -----------------------------------------------------------------------------
// Rotas da malha temporal (grade_base) por escola/turno
// GET  /api/grade/base?turno=Matutino
// PUT  /api/grade/base  { turno, itens: [{dia_semana, periodo_ordem, hora_inicio, hora_fim}] }
// -----------------------------------------------------------------------------

import express from "express";
import pool from "../db.js"; // <- padrão do seu projeto

const router = express.Router();

const TURNOS_VALIDOS = new Set([
  "matutino", "vespertino", "noturno", "integral",
  "Matutino", "Vespertino", "Noturno", "Integral",
]);

const isTurnoValido = (t) => TURNOS_VALIDOS.has(t);
const isHora = (v) => typeof v === "string" && /^\d{2}:\d{2}$/.test(v);

function getEscolaId(req) {
  // vem do token via middleware verificarEscola
  return req.user?.escola_id || Number(req.headers["x-escola-id"]);
}

// -----------------------------------------------------------------------------
// GET /api/grade/base?turno=Matutino
// -----------------------------------------------------------------------------
router.get("/base", async (req, res) => {
  try {
    const escolaId = getEscolaId(req);
    const { turno } = req.query;

    if (!escolaId) return res.status(400).json({ ok: false, error: "escola_id ausente (login)." });
    if (!turno || !isTurnoValido(turno)) return res.status(400).json({ ok: false, error: "turno inválido." });

    const [rows] = await pool.execute(
      `SELECT id,
              dia_semana,
              periodo_ordem,
              TIME_FORMAT(hora_inicio, '%H:%i') AS hora_inicio,
              TIME_FORMAT(hora_fim,   '%H:%i') AS hora_fim
         FROM grade_base
        WHERE escola_id = ? AND turno = ?
        ORDER BY dia_semana, periodo_ordem`,
      [escolaId, turno]
    );

    return res.json({ ok: true, turno, itens: rows });
  } catch (err) {
    console.error("GET /api/grade/base error:", err);
    return res.status(500).json({ ok: false, error: "Falha ao consultar grade_base." });
  }
});

// -----------------------------------------------------------------------------
// PUT /api/grade/base
// Body exemplo:
// {
//   "turno": "Matutino",
//   "itens": [
//     {"dia_semana":1,"periodo_ordem":1,"hora_inicio":"07:00","hora_fim":"07:50"},
//     {"dia_semana":1,"periodo_ordem":2,"hora_inicio":"07:50","hora_fim":"08:40"}
//   ]
// }
// -----------------------------------------------------------------------------
router.put("/base", async (req, res) => {
  const escolaId = getEscolaId(req);
  const { turno, itens } = req.body || {};

  if (!escolaId) return res.status(400).json({ ok: false, error: "escola_id ausente (login)." });
  if (!turno || !isTurnoValido(turno)) return res.status(400).json({ ok: false, error: "turno inválido." });
  if (!Array.isArray(itens) || itens.length === 0) {
    return res.status(400).json({ ok: false, error: "itens deve ser um array não vazio." });
  }

  for (const it of itens) {
    const ds = Number(it.dia_semana);
    const po = Number(it.periodo_ordem);
    if (!(ds >= 1 && ds <= 6)) return res.status(400).json({ ok: false, error: "dia_semana deve estar entre 1 e 6." });
    if (!(po >= 1)) return res.status(400).json({ ok: false, error: "periodo_ordem deve ser >= 1." });
    if (!isHora(it.hora_inicio) || !isHora(it.hora_fim)) {
      return res.status(400).json({ ok: false, error: "hora_inicio/hora_fim devem estar no formato HH:MM." });
    }
  }

  let conn;
  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();
    let afetados = 0;

    for (const it of itens) {
      const params = [
        escolaId,
        turno,
        it.dia_semana,
        it.periodo_ordem,
        it.hora_inicio + ":00",
        it.hora_fim + ":00",
      ];

      // UNIQUE (escola_id, turno, dia_semana, periodo_ordem)
      const [r] = await conn.execute(
        `INSERT INTO grade_base
           (escola_id, turno, dia_semana, periodo_ordem, hora_inicio, hora_fim)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           hora_inicio = VALUES(hora_inicio),
           hora_fim    = VALUES(hora_fim)`,
        params
      );
      afetados += r.affectedRows || 0;
    }

    await conn.commit();
    return res.json({ ok: true, turno, afetados });
  } catch (err) {
    console.error("PUT /api/grade/base error:", err);
    if (conn) try { await conn.rollback(); } catch {}
    return res.status(500).json({ ok: false, error: "Falha ao gravar grade_base." });
  } finally {
    if (conn) try { conn.release(); } catch {}
  }
});

export default router;
