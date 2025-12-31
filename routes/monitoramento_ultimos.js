// routes/monitoramento_ultimos.js
// ============================================================================
// Monitoramento — Últimos reconhecidos (por câmera)
// ----------------------------------------------------------------------------
// GET /api/monitoramento/ultimos?limit=20&janelaMin=60
//   -> { ok: true, cameras: { "1":[{hora,nome,turma}], "2":[], "3":[] } }
//
// Regras / Considerações:
// - Multi-escola: filtra por req.user.escola_id (middlewares autenticarToken + verificarEscola)
// - Consulta eventos reconhecidos (status='RECONHECIDO')
// - Consolida por camera_id, até `limit` itens por câmera
// - Formata horário como HH:mm (ex.: "07:12")
// - JOIN refinado: busca aluno mesmo que o evento tenha divergência de escola_id
// ============================================================================

import { Router } from "express";
import pool from "../db.js";
import { autenticarToken } from "../middleware/autenticarToken.js";
import { verificarEscola } from "../middleware/verificarEscola.js";

const router = Router();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function toInt(n, def = 0) {
  const x = Number(n);
  return Number.isFinite(x) ? Math.trunc(x) : def;
}
function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

async function columnExists(table, column) {
  try {
    const [rows] = await pool.query("SHOW COLUMNS FROM ?? LIKE ?", [table, column]);
    return !!(rows && rows.length);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// GET /ultimos
// ---------------------------------------------------------------------------
router.get("/ultimos", autenticarToken, verificarEscola, async (req, res) => {
  try {
    const { escola_id } = req.user || {};
    if (!escola_id) {
      return res.status(400).json({ ok: false, message: "escola_id ausente no token." });
    }

    const limitPerCamera = clamp(toInt(req.query.limit, 20), 1, 100);
    const janelaMin = clamp(toInt(req.query.janelaMin, 60), 1, 24 * 60);
    const bulkLimit = limitPerCamera * 6;

    // Detecta colunas existentes
    const hasCreatedAt = await columnExists("monitoramento_eventos", "created_at");
    const hasCriadoEm = await columnExists("monitoramento_eventos", "criado_em");
    const createdCol = hasCreatedAt
      ? "me.created_at"
      : hasCriadoEm
      ? "me.criado_em"
      : "me.timestamp_evento";

    const hasTurmaNomeTurma = await columnExists("turmas", "nome_turma");
    const hasTurmaNome = await columnExists("turmas", "nome");
    const turmaExpr = hasTurmaNomeTurma
      ? "t.nome_turma"
      : hasTurmaNome
      ? "t.nome"
      : "NULL";

    // -----------------------------------------------------------------------
    // SQL aprimorado: JOIN por aluno_id, sem exigir match de escola_id no aluno
    // -----------------------------------------------------------------------
    const sql = `
      SELECT
        me.camera_id,
        DATE_FORMAT(${createdCol}, '%H:%i') AS hora,
        COALESCE(a.estudante, a.nome, '—') AS nome,
        COALESCE(${turmaExpr}, '—') AS turma
      FROM monitoramento_eventos AS me
      LEFT JOIN alunos AS a
        ON a.id = me.aluno_id
      LEFT JOIN turmas AS t
        ON t.id = a.turma_id
      WHERE
        me.escola_id = ?
        AND me.\`status\` = 'RECONHECIDO'
        AND ${createdCol} >= (NOW() - INTERVAL ? MINUTE)
      ORDER BY ${createdCol} DESC
      LIMIT ?
    `;

    const params = [escola_id, janelaMin, bulkLimit];
    const [rows] = await pool.query(sql, params);

    // Agrupa resultados por câmera
    const cameras = {};
    for (const r of rows) {
      const key = String(r.camera_id || "");
      if (!key) continue;
      if (!cameras[key]) cameras[key] = [];
      if (cameras[key].length < limitPerCamera) {
        cameras[key].push({
          hora: r.hora || "",
          nome: r.nome || "—",
          turma: r.turma || "—",
        });
      }
    }

    // Garante chaves padrão (1,2,3)
    for (const k of ["1", "2", "3"]) {
      if (!cameras[k]) cameras[k] = [];
    }

    return res.json({ ok: true, cameras });
  } catch (err) {
    console.error("[monitoramento_ultimos] erro:", {
      message: err?.message,
      code: err?.code,
      sqlState: err?.sqlState,
      sqlMessage: err?.sqlMessage,
    });
    return res
      .status(500)
      .json({ ok: false, message: "Erro ao consultar últimos reconhecidos." });
  }
});

export default router;
