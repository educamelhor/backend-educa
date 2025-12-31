// routes/monitoramento_alerta.js
// ============================================================================
// Monitoramento — Alertas em Tempo Real (SSE) + Gestão de "Alunos em Alerta"
// ----------------------------------------------------------------------------
// Endpoints:
//   - GET  /api/monitoramento_alerta/events                (SSE autenticado por escola)
//   - GET  /api/monitoramento_alerta/alunos/alertas        (listar alunos com alerta=1)
//   - PUT  /api/monitoramento_alerta/alunos/:codigo/alerta (liga/desliga alerta por CÓDIGO)
//   - POST /api/monitoramento_alerta/ingest-recognition    (ingestão dos workers; x-monitor-secret)
// ============================================================================

import { Router } from "express";
import pool from "../db.js";
import { autenticarToken } from "../middleware/autenticarToken.js";
import { verificarEscola } from "../middleware/verificarEscola.js";

const router = Router();

// ============================================================================
// Canal SSE por escola (escola_id -> Set<res>)
// ============================================================================
/** @type {Map<number, Set<import('express').Response>>} */
const escolaClients = new Map();

function addClient(escolaId, res) {
  if (!escolaClients.has(escolaId)) escolaClients.set(escolaId, new Set());
  escolaClients.get(escolaId).add(res);
}

function removeClient(escolaId, res) {
  const set = escolaClients.get(escolaId);
  if (!set) return;
  set.delete(res);
  if (set.size === 0) escolaClients.delete(escolaId);
}

function sseSend(res, eventName, dataObj) {
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(dataObj)}\n\n`);
}

function broadcastToSchool(escolaId, eventName, payload) {
  const set = escolaClients.get(escolaId);
  if (!set) return;
  for (const res of set) {
    try { sseSend(res, eventName, payload); } catch {}
  }
}

// ============================================================================
// GET /events (SSE autenticado)
// ----------------------------------------------------------------------------
// IMPORTANTE p/ EventSource do frontend (não envia headers):
// - Aceita token via querystring (?token=...) e injeta em req.headers.authorization
//   antes de chamar autenticarToken/verificarEscola.
// ============================================================================
router.get(
  "/events",
  (req, _res, next) => {
    const tokenFromQuery = req.query?.token;
    if (tokenFromQuery && !req.headers.authorization) {
      req.headers.authorization = `Bearer ${tokenFromQuery}`;
    }
    next();
  },
  autenticarToken,
  verificarEscola,
  (req, res) => {
    const { escola_id } = req.user;

    // Headers SSE
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");

    // Alguns proxies só iniciam o stream se flusharmos os headers
    res.flushHeaders?.();

    // Keep-alive (evita fechar por inatividade)
    const keep = setInterval(() => {
      try { res.write(": ping\n\n"); } catch {}
    }, 25000);

    // Registrar cliente por escola
    const escolaNum = Number(escola_id);
    addClient(escolaNum, res);

    // Boas-vindas (front usa para exibir "SSE ativo")
    sseSend(res, "ready", { ok: true, escola_id: escolaNum });

    // Limpeza
    req.on("close", () => {
      clearInterval(keep);
      removeClient(escolaNum, res);
      try { res.end(); } catch {}
    });
  }
);

// ============================================================================
// GET /alunos/alertas (autenticado) — lista alertas da escola
// ============================================================================
router.get("/alunos/alertas", autenticarToken, verificarEscola, async (req, res) => {
  const { escola_id } = req.user;
  try {
    const [rows] = await pool.query(
      `SELECT a.id, a.codigo, a.estudante, a.alerta_flag, a.alerta_motivo,
              t.nome AS turma, t.turno
         FROM alunos a
         LEFT JOIN turmas t ON t.id = a.turma_id
        WHERE a.escola_id = ? AND a.alerta_flag = 1
        ORDER BY a.estudante`,
      [escola_id]
    );
    res.json(rows);
  } catch (err) {
    console.error("[monitoramento_alerta] erro ao listar:", err);
    res.status(500).json({ message: "Erro ao listar alunos em alerta." });
  }
});

// ============================================================================
// PUT /alunos/:codigo/alerta (autenticado) — liga/desliga alerta por CÓDIGO
// Body: { flag: boolean, motivo?: string }
// ============================================================================
router.put("/alunos/:codigo/alerta", autenticarToken, verificarEscola, async (req, res) => {
  const { escola_id } = req.user;
  const { codigo } = req.params;
  const { flag, motivo } = req.body || {};

  const alertaFlag = flag ? 1 : 0;
  const alertaMotivo = motivo || null;

  try {
    const [result] = await pool.query(
      `UPDATE alunos
          SET alerta_flag = ?, alerta_motivo = ?
        WHERE codigo = ? AND escola_id = ?`,
      [alertaFlag, alertaMotivo, codigo, escola_id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Aluno não encontrado nesta escola." });
    }

    const [[aluno]] = await pool.query(
      `SELECT a.id, a.codigo, a.estudante, a.alerta_flag, a.alerta_motivo,
              t.nome AS turma, t.turno
         FROM alunos a
         LEFT JOIN turmas t ON t.id = a.turma_id
        WHERE a.codigo = ? AND a.escola_id = ?`,
      [codigo, escola_id]
    );

    res.json({ ok: true, aluno });
  } catch (err) {
    console.error("[monitoramento_alerta] erro ao atualizar:", err);
    res.status(500).json({ message: "Erro ao atualizar alerta do aluno." });
  }
});

// ============================================================================
// POST /ingest-recognition (sem JWT; cabeçalho x-monitor-secret)
// Body:
// {
//   "camera": "centro"|"direita"|"esquerda",
//   "reconhecido": true|false,
//   "codigo": "123456",           // obrigatório se reconhecido=true
//   "timestamp": "ISO",           // opcional
//   "escola_id": 1                // opcional; se omitido usa MONITOR_ESCOLA_ID
// }
// Se aluno.alerta_flag=1 => dispara evento SSE "alerta" com payload detalhado.
// ============================================================================
router.post("/ingest-recognition", async (req, res) => {
  try {
    const headerSecret = req.get("x-monitor-secret") || "";
    const MONITOR_SECRET = process.env.MONITOR_SECRET || process.env.MONIT_SECRET || "";
    if (!MONITOR_SECRET || headerSecret !== MONITOR_SECRET) {
      return res.status(403).json({ message: "Segredo inválido para ingestão." });
    }

    const {
      camera,
      reconhecido = false,
      codigo,
      timestamp,
      escola_id: escolaIdBody
    } = req.body || {};

    const escolaId = Number(escolaIdBody);
    if (!escolaId) {
      return res.status(400).json({ message: "Campo 'escola_id' é obrigatório no corpo da requisição." });
    }

    if (!reconhecido) {
      // Futuro: poderemos emitir evento "nao-reconhecido" se necessário
      return res.json({ ok: true, recebido: true });
    }

    if (!codigo) {
      return res.status(400).json({ message: "Campo 'codigo' é obrigatório quando reconhecido=true." });
    }

    const [[aluno]] = await pool.query(
      `SELECT id, codigo, estudante, alerta_flag, alerta_motivo, turma_id
         FROM alunos
        WHERE codigo = ? AND escola_id = ?`,
      [String(codigo), escolaId]
    );
    if (!aluno) {
      return res.status(404).json({ message: "Aluno não localizado nesta escola." });
    }

    if (aluno.alerta_flag === 1) {
      const [[turma]] = await pool.query(
        `SELECT t.nome AS turma, t.turno
           FROM turmas t
          WHERE t.id = ?`,
        [aluno.turma_id || null]
      );

      const payload = {
        tipo: "alerta",
        camera: camera || "desconhecida",
        timestamp: timestamp || new Date().toISOString(),
        aluno: {
          id: aluno.id,
          codigo: aluno.codigo,
          estudante: aluno.estudante,
          motivo: aluno.alerta_motivo || "ALERTA ATIVO",
          turma: turma?.turma || null,
          turno: turma?.turno || null,
        },
      };

      broadcastToSchool(escolaId, "alerta", payload);
    }

    res.json({ ok: true, processado: true });
  } catch (err) {
    console.error("[monitoramento_alerta] erro na ingestão:", err);
    res.status(500).json({ message: "Erro ao ingerir reconhecimento." });
  }
});

export default router;
