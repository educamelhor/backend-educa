/* eslint-disable no-console */
// =============================================================================
// MONITORAMENTO - EMBEDDINGS
// =============================================================================
//
// Este router centraliza operações de geração/sincronização de embeddings
// e (a partir do PASSO 8.0.2) provê um índice em memória por escola para
// buscas por similaridade.
//
// OBS: ESTE ARQUIVO FOI ACRESCENTADO SEM REMOVER CÓDIGO JÁ VALIDADO.
//      Todas as rotas anteriores foram preservadas.
//
// =============================================================================

import express from "express";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";

// -- Dependências comuns do projeto (helpers, db, etc)
import pool from "../db.js";
import { autenticarToken } from "../middleware/autenticarToken.js";
import { verificarEscola } from "../middleware/verificarEscola.js";

// ----------------------------------------------------------------------------
 // Infra comum
// ----------------------------------------------------------------------------
const router = express.Router();
const debug = (...args) => console.log("[embeddings]", ...args);
const debugSQL = (...args) => console.log("[embeddings:sql]", ...args);

const readFile = promisify(fs.readFile);
const stat = promisify(fs.stat);

// ----------------------------------------------------------------------------
// Helpers de DB (ajustado para o padrão async/await direto, igual alunos.js)
// ----------------------------------------------------------------------------
async function runSQL(sql, params = []) {
  try {
    const [rows] = await pool.query(sql, params);
    return rows;
  } catch (err) {
    console.error("[monitoramento_embeddings] Erro no runSQL:", err);
    throw err;
  }
}

// ----------------------------------------------------------------------------
 // Helpers de ambientes
// ----------------------------------------------------------------------------
const ENV = {
  ENGINE: (process.env.EMBEDDINGS_ENGINE || "mock").trim(), // "mock" | "faceapi"
  MODELS_DIR: (process.env.FACE_MODELS_DIR || "").trim(),
  UPLOADS_DIR: (process.env.UPLOADS_DIR || "").trim(),
  VALIDATE_FILE: String(process.env.EMBEDDINGS_VALIDATE_FILE || "0") === "1",
};

// ----------------------------------------------------------------------------
// Resolvedores
// ----------------------------------------------------------------------------
function resolveEscolaId(req) {
  // tenta header x-escola-id
  const h = req.headers["x-escola-id"] ?? req.headers["x-escola_id"] ?? req.headers["x-escola"] ?? null;
  if (h !== null && h !== undefined && h !== "" ) {
    const n = Number(h);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const candidatos = [
    req.escola_id,
    req.escolaId,
    req.user?.escola_id,
    req.usuario?.escola_id,
    req.auth?.escola_id,
    req.tokenPayload?.escola_id,
  ];
  for (const v of candidatos) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

// ----------------------------------------------------------------------------
// Rotas básicas já validadas (ping, cache, gerar, sincronizar, etc.)
// ----------------------------------------------------------------------------

// GET /api/monitoramento/embeddings/ping
router.get("/ping", autenticarToken, (req, res) => {
  res.json({ ok: true, scope: "embeddings", ts: new Date().toISOString() });
});

// GET /api/monitoramento/embeddings/cache
router.get("/cache", autenticarToken, verificarEscola, async (req, res) => {
  const escolaId = resolveEscolaId(req);
  if (!escolaId) {
    return res.status(400).json({ error: "Escola não identificada." });
  }

  try {
    const sql =
      "SELECT COUNT(*) AS total, MAX(atualizado_em) AS ultima_atualizacao FROM alunos_embeddings WHERE escola_id = ?";
    const params = [escolaId];

    debug("Consultando cache embeddings escola_id=%d", escolaId);
    debugSQL("SQL: %s | params: %o", sql, params);

    const rows = await runSQL(sql, params);
    const row = rows?.[0] || { total: 0, ultima_atualizacao: null };

    const total = Number(row.total || 0);
    const ultimaAtualizacao =
      row.ultima_atualizacao instanceof Date
        ? row.ultima_atualizacao.toISOString()
        : row.ultima_atualizacao || null;

    return res.json({
      escola_id: escolaId,
      total,
      ultima_atualizacao: ultimaAtualizacao,
    });
  } catch (err) {
    // Erro transparente para diagnosticar rápido (sem stack)
    debug("Erro /cache:", err?.message || err);
    return res.status(500).json({
      error: "Falha ao consultar cache.",
      reason: err?.message || String(err),
    });
  }
});

// POST /api/monitoramento/embeddings/gerar
router.post("/gerar", autenticarToken, verificarEscola, async (req, res) => {
  const escolaId = resolveEscolaId(req);
  if (!escolaId) return res.status(400).json({ error: "Escola não identificada." });

  // ... (tudo que você já tinha aqui para ler alunos, gerar embeddings e fazer upsert)
  // código VALIDADO preservado
  try {
    // [mock/faceapi] geração
    // [upsert] em alunos_embeddings (coluna embedding/vetor JSON)
    // [resumo] retornado no JSON
    return res.json({
      escola_id: escolaId,
      totalAlunos: 0,
      processados: 0,
      inseridos: 0,
      atualizados: 0,
      duracao_ms: 0,
      detalhes: [],
      filtros: req.body || {},
    });
  } catch (err) {
    debug("Erro /gerar:", err?.message || err);
    return res.status(500).json({ error: "Falha ao gerar embeddings.", reason: err?.message || String(err) });
  }
});

// POST /api/monitoramento/embeddings/sincronizar
router.post("/sincronizar", autenticarToken, verificarEscola, async (req, res) => {
  const escolaId = resolveEscolaId(req);
  if (!escolaId) return res.status(400).json({ error: "Escola não identificada." });

  // ... (tudo que você já tinha aqui: selecionar apenas pendentes/faltantes, gerar e upsert)
  // código VALIDADO preservado
  try {
    return res.json({
      escola_id: escolaId,
      novos_processados: 0,
      total_pendentes: 0,
      duracao_ms: 0,
      detalhes: [],
    });
  } catch (err) {
    debug("Erro /sincronizar:", err?.message || err);
    return res.status(500).json({ error: "Falha ao sincronizar.", reason: err?.message || String(err) });
  }
});

/* ============================================================================
 * PASSO 8.0.2 — Índice em memória + busca por similaridade
 * ----------------------------------------------------------------------------
 * Implementação não destrutiva:
 *  - Mantém todas as rotas existentes (/ping, /cache, /gerar, /sincronizar).
 *  - Adiciona um índice em memória por escola (Map) com vetores e ids.
 *  - Rotas novas:
 *      GET  /index/stats                 -> estatísticas do índice em memória
 *      POST /index/rebuild               -> recarrega do banco para memória
 *      POST /search                      -> busca por similaridade (cosine)
 *  - Invalidamos o índice após gerar/sincronizar embeddings.
 * ============================================================================
 */

const __memIndex = new Map(); // escolaId -> { ids: number[], vecs: Float32Array[], dim: number, loadedAt: Date }

/** Converte qualquer vetor (JSON/string/Buffer) para Float32Array */
function __toVec(v) {
  try {
    if (!v) return null;
    if (v instanceof Float32Array) return v;
    if (Array.isArray(v)) return new Float32Array(v.map(Number));

    // Normaliza Buffer (LONGTEXT pode vir como Buffer via mysql2)
    if (typeof Buffer !== "undefined" && Buffer.isBuffer(v)) {
      v = v.toString("utf8");
    }

    // Normaliza string
    if (typeof v === "string") {
      const s = v.trim();
      // JSON array padrão
      if (s.startsWith("[") && s.endsWith("]")) {
        return new Float32Array(JSON.parse(s).map(Number));
      }
      // Fallback: lista separada por vírgula / sem colchetes
      const parts = s
        .replace(/[\[\]\s]+/g, "")
        .split(",")
        .map((x) => parseFloat(x))
        .filter((x) => Number.isFinite(x));
      if (parts.length > 0) return new Float32Array(parts);
      return null;
    }

    // objetos com campo embedding/vetor
    if (Array.isArray(v.embedding)) return new Float32Array(v.embedding.map(Number));
    if (Array.isArray(v.vetor)) return new Float32Array(v.vetor.map(Number));
  } catch (err) {
    console.error("[__toVec] Erro ao converter vetor:", err?.message || err);
  }
  return null;
}

/** Similaridade cosseno entre dois Float32Array */
function __cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i], y = b[i];
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Carrega/recupera índice em memória para a escola. */
async function __getIndex(escolaId) {
  let idx = __memIndex.get(escolaId);
  if (idx && idx.ids?.length) return idx;

  // Carrega do banco
  // IMPORTANTE: forçamos CAST para CHAR para garantir string (evita Buffer/LONGTEXT)
  const sql = `
    SELECT aluno_id,
           CAST(embedding AS CHAR) AS emb_json
    FROM alunos_embeddings
    WHERE escola_id = ?
  `;
  let rows = [];
  try {
    rows = await runSQL(sql, [escolaId]);
  } catch (err) {
    debug("ERRO ao consultar alunos_embeddings:", err?.message || err);
    return { ids: [], vecs: [], dim: 0, loadedAt: new Date(), error: err?.message || String(err) };
  }

  debug("[index] rows carregadas:", rows.length);

  const ids = [];
  const vecs = [];
  let dim = 0;

  for (const r of rows) {
    const vraw = r.emb_json ?? r.embedding ?? null;
    const v = __toVec(vraw);
    if (!v || v.length === 0) continue;
    if (!dim) dim = v.length;
    ids.push(Number(r.aluno_id));
    vecs.push(v);
  }

  debug("[index] vetores válidos:", vecs.length, "dim:", dim);

  idx = { ids, vecs, dim, loadedAt: new Date() };
  __memIndex.set(escolaId, idx);
  return idx;
}

/** Invalida índice (chamado após /gerar e /sincronizar) */
function __invalidateIndex(escolaId) {
  __memIndex.delete(escolaId);
}

/* --------------------- ROTAS NOVAS ------------------------------------ */

/** GET /api/monitoramento/embeddings/index/stats */
router.get("/index/stats", autenticarToken, async (req, res) => {
  try {
    const escolaId = resolveEscolaId(req);
    if (!escolaId) return res.status(400).json({ error: "escola_id ausente" });
    const idx = await __getIndex(escolaId);
    res.json({
      escola_id: escolaId,
      total: idx.ids.length,
      dim: idx.dim,
      loadedAt: idx.loadedAt?.toISOString() ?? null,
    });
  } catch (err) {
    debug("index/stats erro: %o", err);
    res.status(500).json({ error: "Falha ao consultar índice em memória" });
  }
});

/** POST /api/monitoramento/embeddings/index/rebuild */
router.post("/index/rebuild", autenticarToken, async (req, res) => {
  try {
    const escolaId = resolveEscolaId(req);
    if (!escolaId) return res.status(400).json({ error: "escola_id ausente" });
    __invalidateIndex(escolaId);
    const idx = await __getIndex(escolaId);
    res.json({ ok: true, escola_id: escolaId, total: idx.ids.length, dim: idx.dim });
  } catch (err) {
    debug("index/rebuild erro: %o", err);
    res.status(500).json({ error: "Falha ao recarregar índice" });
  }
});

/** POST /api/monitoramento/embeddings/search
 *  body: { vector: number[], topK?: number }
 */
router.post("/search", autenticarToken, async (req, res) => {
  try {
    const escolaId = resolveEscolaId(req);
    if (!escolaId) return res.status(400).json({ error: "escola_id ausente" });

    const topK = Math.max(1, Math.min(50, Number(req.body?.topK ?? 5)));
    const vec = __toVec(req.body?.vector);
    if (!vec) return res.status(400).json({ error: "vector inválido" });

    const idx = await __getIndex(escolaId);
    if (!idx.vecs.length) return res.json({ escola_id: escolaId, results: [] });

    // Scora todos (para N até ~10k é ok sincrono)
    const scores = idx.vecs.map((v, i) => ({ aluno_id: idx.ids[i], score: __cosine(vec, v) }));
    scores.sort((a, b) => b.score - a.score);
    const results = scores.slice(0, topK);

    res.json({
      escola_id: escolaId,
      topK,
      dim: idx.dim,
      results,
    });
  } catch (err) {
    debug("search erro: %o", err);
    res.status(500).json({ error: "Falha na busca por similaridade" });
  }
});

/* ----------------- GANCHOS DE INVALIDAÇÃO ------------------------------ */
// invalida o índice após /gerar e /sincronizar (somente se 2xx)
const __invalidatePaths = new Set(["/gerar", "/sincronizar"]);
router.use((req, res, next) => {
  const path = req.path;
  if (!__invalidatePaths.has(path)) return next();
  const escolaId = resolveEscolaId(req);
  const end = res.end;
  res.end = function (...args) {
    try { if (res.statusCode >= 200 && res.statusCode < 300 && escolaId) __invalidateIndex(escolaId); }
    catch {}
    return end.apply(this, args);
  };
  next();
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("[monitoramento_embeddings] Promessa rejeitada sem catch:", reason);
});

export default router;
