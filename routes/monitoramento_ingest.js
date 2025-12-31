// routes/monitoramento_ingest.js
// ============================================================================
// Ingestão de eventos de reconhecimento facial vindos do Worker
// - POST /api/monitoramento/eventos
// - GET  /api/monitoramento/embeddings/cache  (para o Worker baixar o cache)
// ============================================================================

import express from "express";
import crypto from "crypto";

const router = express.Router();

// -------------------------------------------------------------
// Helpers
// -------------------------------------------------------------
function toNumber(n, def = 0) {
  const v = Number(n);
  return Number.isFinite(v) ? v : def;
}
function toJson(obj) {
  try { return JSON.stringify(obj); } catch { return null; }
}

// Determina turno (ajuste se já tiver util próprio)
function resolveTurno(dateObj) {
  const h = dateObj.getHours();
  if (h < 12) return "matutino";
  if (h < 18) return "vespertino";
  return "noturno";
}

// Requer token específico do Worker (além do JWT normal do admin)
function validarTokenWorker(req, res, next) {
  const expect = (process.env.MONITOR_WORKER_TOKEN || "").trim();
  const got = (req.header("x-worker-token") || "").trim();
  if (!expect) return res.status(500).json({ ok: false, message: "Token do worker não configurado." });
  if (got !== expect) return res.status(401).json({ ok: false, message: "Token do worker inválido." });
  next();
}

// Middleware simples para expor req.db = pool
router.use(async (req, _res, next) => {
  try {
    // db.js exporta pool (mysql2/promise)
    const pool = (await import("../db.js")).default;
    req.db = pool;
    next();
  } catch (e) {
    console.error("[monitoramento_ingest] falha ao carregar pool:", e);
    next(e);
  }
});

// -------------------------------------------------------------
// GET /api/monitoramento/embeddings/cache
// (endpoint que o worker usa para sincronizar cache local)
// -------------------------------------------------------------
router.get("/embeddings/cache", async (req, res) => {
  try {
    const escola_id = toNumber(req.header("x-escola-id"));
    if (!escola_id) return res.status(422).json({ ok: false, message: "x-escola-id obrigatório" });

    const conn = await req.db.getConnection();
    try {
      const [rows] = await conn.query(
        `SELECT
           a.id           AS aluno_id,
           a.estudante    AS nome,
           a.codigo       AS codigo,
           t.nome_turma   AS turma,
           ae.embedding   AS embedding,      -- vetor (texto/longtext)
           ae.dimensao    AS dim,
           ae.modelo      AS modelo
         FROM alunos a
         JOIN alunos_embeddings ae ON ae.aluno_id = a.id
         LEFT JOIN turmas t ON t.id = a.turma_id
        WHERE a.escola_id = ?
        ORDER BY a.id ASC`,
        [escola_id]
      );

      res.json({ ok: true, escola_id, total: rows.length, rows });
    } finally {
      conn.release();
    }
  } catch (err) {
    console.error("[embeddings/cache] erro:", err);
    res.status(500).json({ ok: false, message: "Falha ao obter cache." });
  }
});

// -------------------------------------------------------------
// POST /api/monitoramento/eventos
// -------------------------------------------------------------
router.post("/eventos", validarTokenWorker, async (req, res) => {
  const escola_id = req.escola_id;
  const camera_id = toNumber(req.body?.camera_id);
  const aluno_id  = req.body?.aluno_id ? toNumber(req.body.aluno_id) : null;
  const score     = req.body?.score != null ? Number(req.body.score) : null;
  const bbox      = req.body?.bbox || null;
  const now       = req.body?.ts ? new Date(req.body.ts) : new Date();

  if (!camera_id) return res.status(422).json({ error: "camera_id obrigatório" });

  // status detectado/reconhecido
  const status = aluno_id ? "RECONHECIDO" : "DETECTADO";

  const conn = await req.db.getConnection();
  try {
    await conn.beginTransaction();

    // 1) Inserir evento
    await conn.query(
      `INSERT INTO monitoramento_eventos
       (escola_id, camera_id, aluno_id, status, conf, bbox, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        escola_id,
        camera_id,
        aluno_id,
        status,
        score,
        bbox ? toJson(bbox) : null,
        now
      ]
    );

    // 2) Se reconhecido, manter presenca do dia (com dedupe)
    if (aluno_id) {
      const dataDia = now.toISOString().slice(0, 10);     // "YYYY-MM-DD"
      const turno   = resolveTurno(now);

      // UPSERT presença diária
      await conn.query(
        `INSERT INTO presencas_diarias
           (escola_id, aluno_id, data, horario, camera_id_origem, turno, metodo)
         VALUES (?, ?, ?, ?, ?, ?, 'face')
         ON DUPLICATE KEY UPDATE
           ultima_confirmacao = VALUES(ultima_confirmacao)`,
        [
          escola_id,
          aluno_id,
          dataDia,
          now.toTimeString().slice(0, 8), // HH:mm:ss
          camera_id,
          turno
        ]
      );

      // Observação:
      // Se quiser "travar" a primeira câmera/horário (não sobrescrever),
      // troque pelo padrão:
      //   UPDATE ... SET ultima_confirmacao = NOW()
      //   WHERE horario IS NOT NULL AND camera_id_origem IS NOT NULL;
    }

    await conn.commit();
    res.json({ ok: true });
  } catch (err) {
    await conn.rollback();
    console.error("[eventos] erro:", err);
    res.status(500).json({ ok: false, message: "Falha ao processar evento" });
  } finally {
    conn.release();
  }
});

export default router;
