// routes/monitoramento.js
// ============================================================================
// ROTAS DO MÓDULO DE MONITORAMENTO (CÂMERAS IP)
// Nesta fase inicial, devolvemos apenas imagens placeholder simulando
// o "frame atual" de cada câmera instalada.
// ============================================================================

import express from "express";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

import { autenticarToken } from "../middleware/autenticarToken.js";
import { verificarEscola } from "../middleware/verificarEscola.js";
import { autorizarPermissao } from "../middleware/autorizarPermissao.js";
import pool from "../db.js";

const router = express.Router();

// ============================================================================
// PASSO 4.2.2 — Rate limit (anti-spam) por (escola_id + cameraId)
// - In-memory (DEV)
// - Bloqueia concorrência (capture in-flight)
// - Janela temporal pós-captura (cooldown após finalizar)
// ============================================================================
const CAPTURE_COOLDOWN_MS = 4000; // janela pós-captura (ajuste fino depois)
const captureInFlightByKey = new Map(); // key -> boolean
const lastCaptureDoneAtByKey = new Map(); // key -> timestamp (fim da última captura)

function getCaptureKey({ escolaId, cameraId }) {
  return `${escolaId}:${cameraId}`;
}

function canStartCapture({ escolaId, cameraId }) {
  const key = getCaptureKey({ escolaId, cameraId });
  const now = Date.now();

  // 1) Bloqueio de concorrência: se já há captura em andamento
  if (captureInFlightByKey.get(key)) {
    return { ok: false, reason: "in_flight", key, waitMs: CAPTURE_COOLDOWN_MS };
  }

  // 2) Janela temporal pós-captura: bloqueia se a última captura terminou há pouco
  const lastDone = lastCaptureDoneAtByKey.get(key) || 0;
  const delta = now - lastDone;

  if (lastDone > 0 && delta < CAPTURE_COOLDOWN_MS) {
    return { ok: false, reason: "cooldown", key, waitMs: CAPTURE_COOLDOWN_MS - delta };
  }

  return { ok: true, reason: "ok", key, waitMs: 0 };
}

function markCaptureStart({ escolaId, cameraId }) {
  const key = getCaptureKey({ escolaId, cameraId });
  captureInFlightByKey.set(key, true);
  return key;
}

function markCaptureDone({ escolaId, cameraId }) {
  const key = getCaptureKey({ escolaId, cameraId });
  captureInFlightByKey.set(key, false);
  lastCaptureDoneAtByKey.set(key, Date.now());
  return key;
}

// ✅ PASSO 4.2.3 — libera o lock sem aplicar cooldown (para casos de erro)
function releaseCaptureLock({ escolaId, cameraId }) {
  const key = getCaptureKey({ escolaId, cameraId });
  captureInFlightByKey.set(key, false);
  return key;
}

// ✅ PASSO 4.2.4 — Normalizar resposta de rate limit (shape + Retry-After)
function sendRateLimit(res, { reason, cameraId, escolaId, waitMs }) {
  const retryAfterMs = Math.max(0, Number(waitMs || 0));
  const retryAfterSec = Math.max(1, Math.ceil(retryAfterMs / 1000)); // header não deve ser 0

  res.setHeader("Retry-After", String(retryAfterSec));

  return res.status(429).json({
    ok: false,
    code: "RATE_LIMIT",
    type: "rate_limit",
    message:
      reason === "in_flight"
        ? "Rate limit: captura em andamento para esta câmera."
        : "Rate limit: aguarde antes de capturar novamente.",
    reason,
    cameraId: String(cameraId),
    escolaId: String(escolaId),
    retryAfterMs,
  });
}

// ============================================================================
// PASSO 4.3 — Observabilidade & Trilha de Auditoria (RBAC_AUDITORIA)
// - Logs estruturados (console)
// - Persistência mínima em rbac_auditoria.detalle (JSON)
// ============================================================================

function safeStr(v, max = 500) {
  const s = v === null || v === undefined ? "" : String(v);
  return s.length > max ? s.slice(0, max) + "..." : s;
}

async function auditRbac({
  usuarioId = null,
  escolaId = null,
  perfil = null,
  metodo = null,
  rota = null,
  permissao = "monitoramento.visualizar",
  decisao = "ALLOW",
  ip = null,
  userAgent = null,
  detalheObj = null,
}) {
  try {
    const detalhe = detalheObj ? JSON.stringify(detalheObj) : null;

    await pool.query(
      `INSERT INTO rbac_auditoria
        (usuario_id, escola_id, perfil, metodo, rota, permissao_requerida, decisao, ip, user_agent, detalhe)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        usuarioId,
        escolaId,
        perfil,
        metodo,
        rota,
        permissao,
        decisao,
        ip,
        userAgent ? safeStr(userAgent, 255) : null,
        detalhe ? safeStr(detalhe, 4000) : null,
      ]
    );
  } catch (e) {
    // auditoria não pode quebrar o fluxo
    console.warn("[monitoramento][audit] falha ao gravar rbac_auditoria:", e?.message || e);
  }
}

function logStructured(obj) {
  // JSON estruturado no console (sem segredos)
  try {
    console.log(JSON.stringify(obj));
  } catch {
    console.log("[monitoramento][log] (falha stringify)");
  }
}

// 🔒 RBAC — exige login + escola válida + permissão do módulo
router.use(autenticarToken, verificarEscola, autorizarPermissao("monitoramento.visualizar"));

// ============================================================================
// CONFIGURAÇÃO DE CAMINHOS
// ============================================================================
// __dirname não existe nativamente em ES Modules, então calculamos manualmente.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Pasta onde estão armazenadas as imagens das câmeras simuladas.
// Estrutura esperada (real no seu projeto):
//   educa-backend/
//     routes/monitoramento.js   (este arquivo)
//     uploads/monitoramento/camera1.jpg
//                              camera2.jpg
//                              camera3.jpg
//
// OBS: Como este arquivo está em /routes e as imagens estão em /uploads,
// precisamos subir um nível com ".."
const BASE_FOLDER = path.join(__dirname, "..", "uploads", "monitoramento");

// ============================================================================
// PASSO 1.1 — RTSP por (escola_id + cameraId) vindo do banco (monitoramento_cameras)
// Convenção: cameraId (1..3) mapeia para monitoramento_cameras.ordem (1..3)
// ============================================================================
async function getRtspUrlFromDb({ escolaId, cameraId }) {
  const camNum = Number(cameraId);

  if (!Number.isFinite(camNum) || camNum < 1) {
    const e = new Error("cameraId inválido para lookup de RTSP");
    e.code = "CAPTURE_BAD_INPUT";
    throw e;
  }

  const [rows] = await pool.query(
    `SELECT rtsp_url, enabled, id, ordem, slug
       FROM monitoramento_cameras
      WHERE escola_id = ?
        AND ordem = ?
      LIMIT 1`,
    [Number(escolaId), camNum]
  );

  if (!rows?.length) {
    const e = new Error("Câmera não cadastrada no banco para esta escola");
    e.code = "RTSP_NOT_CONFIGURED";
    e.meta = { escolaId: Number(escolaId), cameraId: camNum };
    throw e;
  }

  const row = rows[0];

  if (!row.enabled) {
    const e = new Error("Câmera desativada no cadastro");
    e.code = "RTSP_DISABLED";
    e.meta = { escolaId: Number(escolaId), cameraId: camNum, cameraDbId: row.id, slug: row.slug };
    throw e;
  }

  const rtspUrl = row.rtsp_url ? String(row.rtsp_url).trim() : "";

  if (!rtspUrl) {
    const e = new Error("RTSP não configurado para esta câmera");
    e.code = "RTSP_NOT_CONFIGURED";
    e.meta = { escolaId: Number(escolaId), cameraId: camNum, cameraDbId: row.id, slug: row.slug };
    throw e;
  }

  return rtspUrl;
}

// ============================================================================
// ROTA DE TESTE (diagnóstico rápido)
// GET /api/monitoramento/teste
// ============================================================================
// Esta rota é útil para verificar se o módulo está operacional e sem bloqueio
// de autenticação (usada em fases de validação e integração com o frontend).
// ============================================================================
router.get("/teste", (req, res) => {
  console.log("[monitoramento] ROTA /teste chamada com sucesso");
  return res.json({
    ok: true,
    message: "Rota de monitoramento ativa e funcional.",
  });
});

// ============================================================================
// ROTA PRINCIPAL: FRAME DE CADA CÂMERA
// GET /api/monitoramento/camera/:id/frame
// ============================================================================
// Retorna uma imagem (frame atual da câmera) baseada no ID solicitado.
// IDs válidos nesta fase inicial: 1, 2 ou 3
// ============================================================================
router.get("/camera/:id/frame", (req, res) => {
  const { id } = req.params;

  console.log(`[monitoramento] GET /camera/${id}/frame`);

  // Segurança básica: aceitar apenas 1, 2 ou 3
  if (!["1", "2", "3"].includes(id)) {
    console.warn(`[monitoramento] Câmera inválida (${id})`);
    return res.status(400).json({
      ok: false,
      message: "Câmera inválida. Use 1, 2 ou 3.",
    });
  }

  // Monta o caminho do arquivo
  const fileName = `camera${id}.jpg`;
  const filePath = path.join(BASE_FOLDER, fileName);

  console.log(`[monitoramento] Tentando ler arquivo: ${filePath}`);

  // Verifica se o arquivo existe
  if (!fs.existsSync(filePath)) {
    console.warn(`[monitoramento] Arquivo não encontrado: ${filePath}`);
    return res.status(404).json({
      ok: false,
      message: `Frame não encontrado para câmera ${id}`,
    });
  }

  // Define tipo do conteúdo (image/jpeg)
  res.setHeader("Content-Type", "image/jpeg");

  // Stream da imagem
  const stream = fs.createReadStream(filePath);
  stream.on("error", (err) => {
    console.error("[monitoramento] Erro ao ler imagem:", err);
    return res.status(500).json({
      ok: false,
      message: "Erro ao carregar frame da câmera.",
    });
  });

  // Envia o stream para o cliente
  stream.pipe(res);
});


// ============================================================================
// PASSO 4.1.2 — Captura real de frame via FFmpeg (RTSP → JPG)
// GET /api/monitoramento/camera/1/capture
// ============================================================================

import { captureFrame } from "../services/cameraCapture.js";

router.get("/camera/:id/capture", async (req, res) => {
  const startedAt = Date.now();

  // Identidade (sem suposição: melhor esforço)
  const usuarioId = req?.user?.id ?? req?.user?.usuario_id ?? null;
  const perfil = req?.user?.perfil ?? null;

  try {
    const cameraId = String(req.params.id || "").trim();

    if (!/^\d+$/.test(cameraId)) {
      return res.status(400).json({
        ok: false,
        message: "camera id inválido",
      });
    }

    // ✅ PASSO 7.1 — agora suportamos câmeras 1, 2 e 3
    if (!["1", "2", "3"].includes(cameraId)) {
      return res.status(400).json({
        ok: false,
        message: "Câmera inválida. Use 1, 2 ou 3.",
      });
    }

    // PASSO 4.2.2 — Rate limit por (escola_id + cameraId) + lock in-flight
    const escolaId = String(req.escola_id ?? req?.user?.escola_id ?? "0");
    const gate = canStartCapture({ escolaId, cameraId });

    if (!gate.ok) {
      const durationMs = Date.now() - startedAt;

      logStructured({
        ts: new Date().toISOString(),
        module: "monitoramento",
        event: "capture_attempt",
        ok: false,
        code: "RATE_LIMIT",
        reason: gate.reason,
        escolaId,
        cameraId,
        usuarioId,
        durationMs,
      });

      await auditRbac({
        usuarioId,
        escolaId,
        perfil,
        metodo: req.method,
        rota: req.originalUrl,
        decisao: "DENY",
        ip: req.ip,
        userAgent: req.get("user-agent"),
        detalheObj: {
          kind: "MONITORAMENTO_CAPTURE",
          outcome: "RATE_LIMIT",
          reason: gate.reason,
          cameraId,
          escolaId,
          waitMs: gate.waitMs,
          durationMs,
        },
      });

      return sendRateLimit(res, {
        reason: gate.reason,
        cameraId,
        escolaId,
        waitMs: gate.waitMs,
      });
    }

    // marca início (trava concorrência)
    markCaptureStart({ escolaId, cameraId });

    try {
      // ✅ PASSO 1.1 — RTSP vem do banco (por escola + cameraId)
      const rtspUrl = await getRtspUrlFromDb({ escolaId, cameraId });

      const outputPath = path.join(
        __dirname,
        "..",
        "uploads",
        "monitoramento",
        `camera${cameraId}.jpg`
      );

      const result = await captureFrame({
        rtspUrl,
        outputPath,
      });

      // ✅ Só aplica cooldown quando a captura foi bem-sucedida
      markCaptureDone({ escolaId, cameraId });

      const durationMs = Date.now() - startedAt;

      logStructured({
        ts: new Date().toISOString(),
        module: "monitoramento",
        event: "capture_attempt",
        ok: true,
        code: "CAPTURE_OK",
        escolaId,
        cameraId,
        usuarioId,
        durationMs,
        sizeBytes: result?.sizeBytes ?? null,
      });

      await auditRbac({
        usuarioId,
        escolaId,
        perfil,
        metodo: req.method,
        rota: req.originalUrl,
        decisao: "ALLOW",
        ip: req.ip,
        userAgent: req.get("user-agent"),
        detalheObj: {
          kind: "MONITORAMENTO_CAPTURE",
          outcome: "OK",
          cameraId,
          escolaId,
          durationMs,
          sizeBytes: result?.sizeBytes ?? null,
          outputPath: safeStr(result?.outputPath ?? "", 255),
        },
      });

      return res.json({
        ok: true,
        message: "Frame capturado com sucesso",
        frame: `/uploads/monitoramento/camera${cameraId}.jpg`,
        details: result,
      });
    } catch (err) {
      const durationMs = Date.now() - startedAt;

      const errorCode = safeStr(err?.code || "CAPTURE_FAIL", 60);

      const errorType =
        errorCode.startsWith("RTSP_") ? "rtsp" :
        errorCode.startsWith("FFMPEG_") ? "ffmpeg" :
        errorCode.startsWith("FS_") || errorCode.startsWith("FRAME_") ? "filesystem" :
        errorCode === "CAPTURE_BAD_INPUT" ? "input" :
        "unknown";

      const httpStatus =
        errorCode === "FFMPEG_TIMEOUT" || errorCode === "RTSP_TIMEOUT" ? 504 :
        errorCode === "RTSP_AUTH_FAIL" ? 502 :
        errorCode === "RTSP_NOT_CONFIGURED" ? 404 :
        errorCode === "RTSP_DISABLED" ? 409 :
        errorCode.startsWith("RTSP_") ? 502 :
        errorCode.startsWith("FFMPEG_") ? 502 :
        errorCode.startsWith("FS_") || errorCode.startsWith("FRAME_") ? 500 :
        500;

      const errorMsg = safeStr(err?.message || "erro_desconhecido", 800);

      logStructured({
        ts: new Date().toISOString(),
        module: "monitoramento",
        event: "capture_attempt",
        ok: false,
        code: "CAPTURE_FAIL",
        errorCode,
        errorType,
        escolaId,
        cameraId,
        usuarioId,
        durationMs,
        error: errorMsg,
      });

      await auditRbac({
        usuarioId,
        escolaId,
        perfil,
        metodo: req.method,
        rota: req.originalUrl,
        decisao: "DENY",
        ip: req.ip,
        userAgent: req.get("user-agent"),
        detalheObj: {
          kind: "MONITORAMENTO_CAPTURE",
          outcome: "FAIL",
          cameraId,
          escolaId,
          durationMs,
          errorCode,
          errorType,
          error: errorMsg,
          meta: err?.meta || null,
        },
      });

      console.error("[monitoramento] Erro ao capturar frame:", err?.message);

      return res.status(httpStatus).json({
        ok: false,
        message: "Falha ao capturar frame da câmera",
        errorCode,
        errorType,
        error: errorMsg,
      });
    } finally {

      // ✅ PASSO 4.2.3 — garante liberação do lock SEM iniciar cooldown em caso de erro
      releaseCaptureLock({ escolaId, cameraId });
    }
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const errorMsg = safeStr(err?.message || "erro_desconhecido", 800);

    logStructured({
      ts: new Date().toISOString(),
      module: "monitoramento",
      event: "capture_attempt",
      ok: false,
      code: "CAPTURE_FAIL_OUTER",
      escolaId: String(req.escola_id ?? req?.user?.escola_id ?? "0"),
      cameraId: String(req.params.id || ""),
      usuarioId,
      durationMs,
      error: errorMsg,
    });

    // best-effort: não garante que escolaId/cameraId estejam válidos aqui
    await auditRbac({
      usuarioId,
      escolaId: String(req.escola_id ?? req?.user?.escola_id ?? "0"),
      perfil,
      metodo: req.method,
      rota: req.originalUrl,
      decisao: "DENY",
      ip: req.ip,
      userAgent: req.get("user-agent"),
      detalheObj: {
        kind: "MONITORAMENTO_CAPTURE",
        outcome: "FAIL_OUTER",
        cameraId: String(req.params.id || ""),
        escolaId: String(req.escola_id ?? req?.user?.escola_id ?? "0"),
        durationMs,
        error: errorMsg,
      },
    });

    console.error("[monitoramento] Erro ao capturar frame:", err.message);

    return res.status(500).json({
      ok: false,
      message: "Falha ao capturar frame da câmera",
      error: err.message,
    });
  }
});


// ============================================================================
// EXPORTAÇÃO DO ROUTER
// ============================================================================
export default router;
