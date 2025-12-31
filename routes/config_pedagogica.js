// PATH: api/routes/config_pedagogica.js
// ============================================================================
// Rotas: Configurações Pedagógicas do Gerador de Horários
// ============================================================================
// Endpoints:
//   GET  /api/config-pedagogica?turno=...&ano_ref=...&nivel=... (nivel opcional)
//   POST /api/config-pedagogica  (upsert)
// ----------------------------------------------------------------------------
// Regras:
// - escola_id vem do JWT (req.user.escola_id) via middleware verificarEscola
// - Persistência em: grade_config_pedagogica
// - Retornos padronizados para o frontend:
//     GET  -> { is_default: boolean, config_pedagogica: { nivel, regras } | null }
//     POST -> { ok: true, message: "...", saved: { turno, ano_ref, nivel } }
// ============================================================================

import express from "express";
import pool from "../db.js";

const router = express.Router();

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
function normalizeTurno(turno) {
  return String(turno || "").trim();
}

function normalizeAnoRef(anoRef) {
  return String(anoRef || "").trim();
}

function normalizeNivel(nivel) {
  const n = String(nivel || "").trim();
  return n || "fundamental_II";
}

function safeJsonParse(v) {
  if (v == null) return null;
  if (typeof v === "object") return v;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

// ----------------------------------------------------------------------------
// GET /api/config-pedagogica
// ----------------------------------------------------------------------------
router.get("/", async (req, res) => {
  try {
    const escolaId = req.user?.escola_id;
    const turno = normalizeTurno(req.query.turno);
    const anoRef = normalizeAnoRef(req.query.ano_ref);
    const nivel = normalizeNivel(req.query.nivel);

    if (!escolaId) {
      return res.status(403).json({ message: "Acesso negado: escola não definida." });
    }
    if (!turno || !anoRef) {
      return res.status(400).json({
        message: "Parâmetros obrigatórios: turno e ano_ref.",
      });
    }

    const [rows] = await pool.query(
      `
        SELECT id, escola_id, ano_ref, turno, nivel, regras_json, created_at, updated_at
        FROM grade_config_pedagogica
        WHERE escola_id = ? AND ano_ref = ? AND turno = ? AND nivel = ?
        LIMIT 1
      `,
      [escolaId, anoRef, turno, nivel]
    );

    if (!rows || rows.length === 0) {
      // Sem registro => frontend usa default
      return res.json({
        is_default: true,
        config_pedagogica: null,
      });
    }

    const row = rows[0];
    const regras = safeJsonParse(row.regras_json) || safeJsonParse(String(row.regras_json)) || {};

    return res.json({
      is_default: false,
      config_pedagogica: {
        nivel: row.nivel,
        regras,
      },
    });
  } catch (err) {
    console.error("[config_pedagogica][GET] Erro:", err);
    return res.status(500).json({ message: "Erro no servidor." });
  }
});

// ----------------------------------------------------------------------------
// POST /api/config-pedagogica  (upsert)
// ----------------------------------------------------------------------------
router.post("/", async (req, res) => {
  try {
    const escolaId = req.user?.escola_id;

    const turno = normalizeTurno(req.body?.turno);
    const anoRef = normalizeAnoRef(req.body?.ano_ref);
    const nivel = normalizeNivel(req.body?.nivel);
    const regras = req.body?.regras;

    if (!escolaId) {
      return res.status(403).json({ message: "Acesso negado: escola não definida." });
    }
    if (!turno || !anoRef) {
      return res.status(400).json({ message: "Campos obrigatórios: turno e ano_ref." });
    }
    if (!regras || typeof regras !== "object") {
      return res.status(400).json({ message: "Campo obrigatório: regras (objeto JSON)." });
    }

    // Persistimos como JSON
    const regrasJson = JSON.stringify(regras);

    await pool.query(
      `
        INSERT INTO grade_config_pedagogica (escola_id, ano_ref, turno, nivel, regras_json)
        VALUES (?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          regras_json = VALUES(regras_json),
          updated_at = CURRENT_TIMESTAMP
      `,
      [escolaId, anoRef, turno, nivel, regrasJson]
    );

    return res.json({
      ok: true,
      message: "Configuração pedagógica salva com sucesso.",
      saved: { turno, ano_ref: anoRef, nivel },
    });
  } catch (err) {
    console.error("[config_pedagogica][POST] Erro:", err);
    return res.status(500).json({ message: "Erro no servidor." });
  }
});

export default router;
