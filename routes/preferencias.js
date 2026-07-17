// preferencias.js
import express from "express";
import pool from "../db.js";

const router = express.Router();

// Normaliza string (turno -> minúsculo)
function norm(s) {
  return String(s || "").trim().toLowerCase();
}

// GET /api/preferencias?professor_id=12&turno=Matutino
router.get("/", async (req, res) => {
  try {
    const professor_id = Number(req.query.professor_id || 0);
    const turno = norm(req.query.turno || "");
    if (!professor_id || !turno) {
      return res.status(400).json({ error: "professor_id e turno são obrigatórios" });
    }

    const [rows] = await pool.query(
      `SELECT professor_id, turno,
              prefere_aula_dupla, prefere_aula_unica,
              evitar_janela_interna, janela_no_inicio_ok, janela_no_fim_ok,
              max_slots_mesma_turma_dia,
              COALESCE(JSON_EXTRACT(regras_json, '$'), JSON_OBJECT()) AS regras_json
         FROM grade_preferencias_professor
        WHERE professor_id = ? AND turno = ?`,
      [professor_id, turno]
    );

    // Defaults se não houver registro
    const base = {
      professor_id,
      turno,
      prefere_aula_dupla: 0,
      prefere_aula_unica: 0,
      evitar_janela_interna: 1,
      janela_no_inicio_ok: 1,
      janela_no_fim_ok: 1,
      max_slots_mesma_turma_dia: 2,
      regras_json: {},
    };

    const out = rows?.[0]
      ? {
          ...base,
          ...rows[0],
          // garante objeto JS
          regras_json:
            typeof rows[0].regras_json === "string"
              ? JSON.parse(rows[0].regras_json || "{}")
              : rows[0].regras_json || {},
        }
      : base;

    res.json(out);
  } catch (e) {
    console.error("GET /api/preferencias erro:", e);
    res.status(500).json({ error: "Falha ao carregar preferências" });
  }
});

// POST /api/preferencias/upsert
// Body:
// {
//   "professor_id": 12,
//   "turno": "matutino",
//   "prefere_aula_dupla": true,
//   "prefere_aula_unica": false,
//   "evitar_janela_interna": true,
//   "janela_no_inicio_ok": true,
//   "janela_no_fim_ok": false,
//   "max_slots_mesma_turma_dia": 2,
//   "regras_json": { "peso_dupla": 9 }
// }
router.post("/upsert", async (req, res) => {
  try {
    const body = req.body || {};
    const professor_id = Number(body.professor_id || 0);
    const turno = norm(body.turno || "");

    if (!professor_id || !turno) {
      return res.status(400).json({ ok: false, error: "professor_id e turno são obrigatórios" });
    }

    const prefere_aula_dupla = body.prefere_aula_dupla ? 1 : 0;
    const prefere_aula_unica = body.prefere_aula_unica ? 1 : 0;
    const evitar_janela_interna = body.evitar_janela_interna ? 1 : 0;
    const janela_no_inicio_ok = body.janela_no_inicio_ok ? 1 : 0;
    const janela_no_fim_ok = body.janela_no_fim_ok ? 1 : 0;
    const max_slots_mesma_turma_dia = Number(body.max_slots_mesma_turma_dia ?? 2);

    // garante JSON válido; se vier null/undefined, salva {}
    const regras = body.regras_json && typeof body.regras_json === "object" ? body.regras_json : {};
    const regrasStr = JSON.stringify(regras);

    // UPSERT
    await pool.query(
      `
      INSERT INTO grade_preferencias_professor (
        professor_id, turno,
        prefere_aula_dupla, prefere_aula_unica,
        evitar_janela_interna, janela_no_inicio_ok, janela_no_fim_ok,
        max_slots_mesma_turma_dia, regras_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON))
      ON DUPLICATE KEY UPDATE
        prefere_aula_dupla = VALUES(prefere_aula_dupla),
        prefere_aula_unica = VALUES(prefere_aula_unica),
        evitar_janela_interna = VALUES(evitar_janela_interna),
        janela_no_inicio_ok = VALUES(janela_no_inicio_ok),
        janela_no_fim_ok = VALUES(janela_no_fim_ok),
        max_slots_mesma_turma_dia = VALUES(max_slots_mesma_turma_dia),
        regras_json = CAST(VALUES(regras_json) AS JSON)
      `,
      [
        professor_id,
        turno,
        prefere_aula_dupla,
        prefere_aula_unica,
        evitar_janela_interna,
        janela_no_inicio_ok,
        janela_no_fim_ok,
        max_slots_mesma_turma_dia,
        regrasStr,
      ]
    );

    res.json({ ok: true });
  } catch (e) {
    console.error("POST /api/preferencias/upsert erro:", e);
    res.status(500).json({ ok: false, error: "Falha ao salvar preferências" });
  }
});

export default router;
