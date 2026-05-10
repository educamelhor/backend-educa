import express from "express";
import pool from "../db.js";

const router = express.Router();

// Rate limit em memória (por device). Para multi-instância, migrar para Redis.
const CAPTURE_RL_WINDOW_MS = Number(process.env.CAPTURE_RL_WINDOW_MS || 60_000);
const CAPTURE_RL_MAX = Number(process.env.CAPTURE_RL_MAX || 12);

const _captureRlStore = new Map(); // key -> { count, resetAt }

// PASSO 5.2 — Cooldown de ENROLL/REENROLL (evita duplo clique / corrida de token)
const CAPTURE_ENROLL_COOLDOWN_MS = Number(process.env.CAPTURE_ENROLL_COOLDOWN_MS || 10_000);
const _captureEnrollCooldown = new Map(); // key -> { resetAt }

// PASSO 3 — Pareamento com aprovação (pair_code temporário)
const CAPTURE_PAIR_EXPIRES_MS = Number(process.env.CAPTURE_PAIR_EXPIRES_MS || 10 * 60_000); // 10 min
const CAPTURE_PAIR_REQ_COOLDOWN_MS = Number(process.env.CAPTURE_PAIR_REQ_COOLDOWN_MS || 5_000); // evita spam
const _capturePairReqCooldown = new Map(); // device_uid -> { resetAt }

function normalizeDeviceUid(raw) {
  const v = String(raw || "").trim().toUpperCase();
  return v || null;
}

// Código curto (formato XXXX-XXXX), evitando chars confusos
function generatePairCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // sem I, O, 0, 1
  const pick = () => alphabet[crypto.randomInt(0, alphabet.length)];
  const a = Array.from({ length: 4 }, pick).join("");
  const b = Array.from({ length: 4 }, pick).join("");
  return `${a}-${b}`;
}

function checkPairReqCooldown(deviceUidRaw) {
  const device_uid = normalizeDeviceUid(deviceUidRaw);
  if (!device_uid) return { ok: true };

  const now = Date.now();
  const cur = _capturePairReqCooldown.get(device_uid);

  if (cur && now < cur.resetAt) {
    return { ok: false, resetAt: cur.resetAt };
  }

  const next = { resetAt: now + CAPTURE_PAIR_REQ_COOLDOWN_MS };
  _capturePairReqCooldown.set(device_uid, next);
  return { ok: true, resetAt: next.resetAt };
}

function getClientIp(req) {
  return (
    String(req.headers["x-forwarded-for"] || req.ip || "")
      .split(",")[0]
      .trim()
      .slice(0, 45) || null
  );
}

function getUserAgent(req) {
  return String(req.headers["user-agent"] || "").slice(0, 255) || null;
}

async function safeInsertCaptureAuditoria(db, {
  escola_id,
  aluno_id = null,
  device_id = null,
  usuario_id = null,
  acao,
  ip = null,
  user_agent = null,
}) {
  try {
    if (!db) return;

    await db.query(
      `
      INSERT INTO capture_auditoria
        (escola_id, aluno_id, device_id, usuario_id, acao, ip, user_agent, created_at)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, NOW())
      `,
      [escola_id, aluno_id, device_id, usuario_id, acao, ip, user_agent]
    );
  } catch (e) {
    // auditoria nunca pode derrubar o fluxo principal
    console.error("[CAPTURE][AUDIT] falha ao gravar auditoria:", e?.message || e);
  }
}

function checkCaptureRateLimit(deviceKey) {
  const key = String(deviceKey || "").trim();
  if (!key) return { ok: true };

  const now = Date.now();
  const cur = _captureRlStore.get(key);

  if (!cur || now >= cur.resetAt) {
    const next = { count: 1, resetAt: now + CAPTURE_RL_WINDOW_MS };
    _captureRlStore.set(key, next);
    return { ok: true, remaining: CAPTURE_RL_MAX - 1, resetAt: next.resetAt };
  }

  if (cur.count >= CAPTURE_RL_MAX) {
    return { ok: false, resetAt: cur.resetAt };
  }

  cur.count += 1;
  _captureRlStore.set(key, cur);
  return { ok: true, remaining: Math.max(0, CAPTURE_RL_MAX - cur.count), resetAt: cur.resetAt };
}

// PASSO 5.2 — Cooldown de ENROLL/REENROLL (por escola + device_uid)
function checkEnrollCooldown(keyRaw) {
  const key = String(keyRaw || "").trim();
  if (!key) return { ok: true };

  const now = Date.now();
  const cur = _captureEnrollCooldown.get(key);

  if (cur && now < cur.resetAt) {
    return { ok: false, resetAt: cur.resetAt };
  }

  const next = { resetAt: now + CAPTURE_ENROLL_COOLDOWN_MS };
  _captureEnrollCooldown.set(key, next);
  return { ok: true, resetAt: next.resetAt };
}

async function rateLimitCapturePorDevice(req, res, next) {
  const device = req.captureDevice;
  const deviceKey = device?.device_uid || device?.id;

  const rl = checkCaptureRateLimit(deviceKey);
  if (!rl.ok) {
    const payload = {
      ok: false,
      message: "Rate limit excedido para este device.",
      retry_after_ms: Math.max(0, rl.resetAt - Date.now()),
    };

    // Auditoria mínima do bloqueio (LGPD + rastreabilidade)
    const escola_id = Number(req.captureDevice?.escola_id || 0) || null;
    const device_id = Number(req.captureDevice?.id || 0) || null;

    await safeInsertCaptureAuditoria(req.db, {
      escola_id,
      aluno_id: null,
      device_id,
      usuario_id: null,
      acao: "CAPTURA_RATE_LIMIT",
      ip: getClientIp(req),
      user_agent: getUserAgent(req),
    });

    // ⚠️ Estamos ANTES do multer: o iOS/Expo pode falhar se responder enquanto o multipart ainda está sendo enviado.
    // Estratégia: drenar o body e só finalizar a resposta quando o request terminar.
    try {
      let responded = false;

      const finish = () => {
        if (responded) return;
        responded = true;
        if (!res.headersSent) {
          res.status(429).json(payload);
        }
      };

      req.on("data", () => {}); // consome chunks
      req.on("end", finish);
      req.on("error", finish);

      // garante que o stream flua
      req.resume();

      // não chama next()
      return;
    } catch {
      // fallback: resposta imediata
      return res.status(429).json(payload);
    }
  }

  return next();
}

// ==============================
// EDUCA-CAPTURE - ROTAS BASE
// ==============================

// Injeta pool no request para middlewares e rotas que usam req.db
router.use((req, _res, next) => {
  req.db = pool;
  next();
});

// ==============================
// PASSO 3 — Timeout controlado (HARD para multipart/Expo iOS)
// ==============================
const CAPTURE_REQ_TIMEOUT_MS = Number(process.env.CAPTURE_REQ_TIMEOUT_MS || 30_000);

router.use((req, res, next) => {
  let done = false;

  const deviceUid = String(req.headers?.["x-device-uid"] || "").trim() || null;

  const cleanup = () => {
    try { clearTimeout(timer); } catch {}
    try { req.off("aborted", onAbort); } catch {}
    try { res.off("finish", onDone); } catch {}
    try { res.off("close", onDone); } catch {}
    try { req.socket?.off?.("timeout", onSocketTimeout); } catch {}
  };

  const onDone = () => {
    if (done) return;
    done = true;
    cleanup();
  };

  const onAbort = () => onDone();

  const hardClose = () => {
    // Para multipart no iOS/Expo: garantir quebra real da conexão
    try { res.setHeader("Connection", "close"); } catch {}
    try { res.flushHeaders?.(); } catch {}
    try { req.socket?.destroy?.(); } catch {}
    try { req.destroy?.(); } catch {}
  };

  const onTimeout = () => {
    if (done) return;
    done = true;

    console.warn(`[CAPTURE][TIMEOUT] ${req.method} ${req.originalUrl} device_uid=${deviceUid || "-"}`);

    try {
      // garante encerramento da resposta para o iOS/Expo não ficar pendurado
      if (!res.headersSent) {
        res.status(408);
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.setHeader("Connection", "close");
        res.end(JSON.stringify({
          ok: false,
          code: "CAPTURE_TIMEOUT",
          message: "Tempo limite excedido na requisição do EDUCA-CAPTURE.",
          timeoutMs: CAPTURE_REQ_TIMEOUT_MS,
        }));
      } else if (!res.writableEnded) {
        // headers já foram enviados por algum motivo — ainda assim finaliza o stream
        try { res.end(); } catch {}
      }
    } catch {}

    cleanup();

    // deixa o Node flushar o end() antes de destruir o socket
    setImmediate(() => {
      hardClose();
    });
  };

  const onSocketTimeout = () => {
    // redundância: timeout do socket também dispara o mesmo comportamento
    onTimeout();
  };

  // Timer determinístico
  const timer = setTimeout(onTimeout, CAPTURE_REQ_TIMEOUT_MS);

  // Timeout do socket (ajuda em uploads pendurados)
  try {
    req.socket?.setTimeout?.(CAPTURE_REQ_TIMEOUT_MS);
    req.socket?.on?.("timeout", onSocketTimeout);
  } catch {}

  req.on("aborted", onAbort);
  res.on("finish", onDone);
  res.on("close", onDone);

  next();
});

import crypto from "crypto";
import bcrypt from "bcryptjs";

// 🔒 Middlewares já existentes no seu projeto
import { autenticarToken } from "../middleware/autenticarToken.js";
import { verificarEscola } from "../middleware/verificarEscola.js";
import { autenticarDeviceCapture } from "../middleware/autenticarDeviceCapture.js";
import { autorizarPermissao } from "../middleware/autorizarPermissao.js";

import multer from "multer";
import sharp from "sharp";
import { uploadImageBufferToSpaces, deleteObjectFromSpaces } from "../storage/spacesUpload.js";

// Health check
router.get("/health", async (_req, res) => {
  return res.json({
    ok: true,
    modulo: "EDUCA-CAPTURE",
    timestamp: new Date().toISOString(),
  });
});

// Device ping (prova do middleware de device)
router.get("/device-ping", autenticarDeviceCapture, async (req, res) => {
  return res.json({
    ok: true,
    message: "Device autenticado com sucesso.",
    device: req.captureDevice,
    timestamp: new Date().toISOString(),
  });
});

// ============================================================================
// PASSO 1.6 — Turma por ID (fonte única da verdade no backend)
// GET /api/capture/turmas/:id
//
// Auth: Authorization: Device <device_token>
//       x-device-uid: <device_uid>
//
// Regra: sempre filtrar por escola_id do device (isolamento multi-escola)
// ============================================================================
router.get("/turmas/:id", autenticarDeviceCapture, async (req, res) => {
  const db = req.db;
  const escola_id = Number(req.captureDevice?.escola_id || 0);
  const turma_id = Number(req.params?.id || 0);

  if (!db) {
    return res.status(500).json({ ok: false, message: "DB não disponível no request." });
  }

  if (!escola_id || escola_id <= 0) {
    return res.status(400).json({ ok: false, message: "escola_id inválida no device." });
  }

  if (!turma_id || turma_id <= 0) {
    return res.status(400).json({ ok: false, message: "turma_id inválido." });
  }

  try {
    const [rows] = await db.query(
      `
      SELECT
        t.id,
        t.nome,
        t.etapa,
        t.ano,
        t.serie,
        t.turno
      FROM turmas t
      WHERE t.id = ?
        AND t.escola_id = ?
        AND t.ano = YEAR(NOW())
      LIMIT 1
      `,
      [turma_id, escola_id]
    );

    if (!rows || rows.length === 0) {
      return res.status(404).json({
        ok: false,
        message: "Turma não encontrada para esta escola.",
      });
    }

    return res.status(200).json({
      ok: true,
      turma: rows[0],
    });
  } catch (err) {
    console.error("[CAPTURE] erro ao buscar turma por id:", err?.message || err);
    return res.status(500).json({ ok: false, message: "Erro interno ao buscar turma." });
  }
});

/**
 * ============================================================================
 * PASSO 1 — DADOS REAIS (Turnos, Turmas, Alunos) via device (multi-escola)
 *
 * Observação:
 * - O app EDUCA-CAPTURE não usa token de usuário do sistema principal.
 * - Portanto, estes endpoints usam autenticarDeviceCapture e filtram por
 *   req.captureDevice.escola_id (isolamento por escola).
 *
 * GET /api/capture/turnos
 * GET /api/capture/turmas?turno=MANHA
 * GET /api/capture/alunos?turma_id=123&filtro=&status=
 * ============================================================================
 */

// Turnos reais (DISTINCT em turmas)
router.get("/turnos", autenticarDeviceCapture, async (req, res) => {
  try {
    const escola_id = Number(req.captureDevice?.escola_id || 0);

    if (!escola_id) {
      return res.status(401).json({ ok: false, message: "Device inválido (escola_id ausente)." });
    }

    const [rows] = await req.db.query(
      `SELECT DISTINCT turno
       FROM turmas
       WHERE escola_id = ?
         AND ano = YEAR(NOW())
       ORDER BY turno`,
      [escola_id]
    );

    const turnos = (rows || []).map((r) => r.turno).filter(Boolean);
    return res.json({ ok: true, turnos });
  } catch (err) {
    console.error("[CAPTURE] erro ao buscar turnos:", err);
    return res.status(500).json({ ok: false, message: "Erro ao buscar turnos." });
  }
});

// Turmas reais (por escola, opcional filtro por turno)
router.get("/turmas", autenticarDeviceCapture, async (req, res) => {
  try {
    const escola_id = Number(req.captureDevice?.escola_id || 0);
    const turno = String(req.query?.turno || "").trim();

    if (!escola_id) {
      return res.status(401).json({ ok: false, message: "Device inválido (escola_id ausente)." });
    }

    // Sempre filtra pelo ano letivo corrente (ano calendário)
    let sql = `
      SELECT
        t.id,
        t.nome,
        t.etapa,
        t.ano,
        t.serie,
        t.turno
      FROM turmas t
      WHERE t.escola_id = ?
        AND t.ano = YEAR(NOW())
    `;
    const params = [escola_id];

    if (turno) {
      sql += " AND t.turno = ?";
      params.push(turno);
    }

    sql += " ORDER BY t.serie, t.nome";

    const [rows] = await req.db.query(sql, params);
    return res.json({ ok: true, turmas: rows || [] });
  } catch (err) {
    console.error("[CAPTURE] erro ao buscar turmas:", err);
    return res.status(500).json({ ok: false, message: "Erro ao buscar turmas." });
  }
});

// Alunos reais (por escola, opcional turma_id / filtro / status)
router.get("/alunos", autenticarDeviceCapture, async (req, res) => {
  try {
    const escola_id = Number(req.captureDevice?.escola_id || 0);
    const turma_id = Number(req.query?.turma_id || 0) || null;
    const filtro = String(req.query?.filtro || "").trim();
    const status = String(req.query?.status || "").trim().toLowerCase();

    if (!escola_id) {
      return res.status(401).json({ ok: false, message: "Device inválido (escola_id ausente)." });
    }

    const where = ["a.escola_id = ?"];
    const params = [escola_id];

    if (turma_id) {
      where.push("a.turma_id = ?");
      params.push(turma_id);
    }

    if (filtro) {
      where.push("(a.estudante LIKE ? OR a.codigo LIKE ?)");
      const like = `%${filtro}%`;
      params.push(like, like);
    }

    if (status === "ativo" || status === "inativo") {
      where.push("a.status = ?");
      params.push(status);
    }

    const sql = `
      SELECT
        a.id,
        a.codigo,
        a.estudante,
        a.status,
        a.foto,
        a.turma_id
      FROM alunos a
      WHERE ${where.join(" AND ")}
      ORDER BY a.estudante
    `;

    const [rows] = await req.db.query(sql, params);
    return res.json({ ok: true, alunos: rows || [] });
  } catch (err) {
    console.error("[CAPTURE] erro ao buscar alunos:", err);
    return res.status(500).json({ ok: false, message: "Erro ao buscar alunos." });
  }
});

// ============================================================================
// PASSO 4.3 — Upload Multipart (buffer) -> DigitalOcean Spaces -> alunos.foto -> auditoria
// POST /api/capture/upload
//
// Auth: Authorization: Device <device_token>
//       x-device-uid: <device_uid>
//
// multipart/form-data:
//   - file: (jpg/png)  [campo: "file"]
//   - aluno_id: number (obrigatório)
//
// Resultado:
//   - atualiza alunos.foto (URL do Spaces)
//   - insere capture_auditoria (acao='CAPTURA_FOTO')
//   - tudo em transação
// ============================================================================

const CAPTURE_MAX_BYTES = Number(process.env.CAPTURE_UPLOAD_MAX_BYTES || 3 * 1024 * 1024); // 3MB

// Saída (normalização)
const CAPTURE_OUT_MAX_PX = Number(process.env.CAPTURE_IMG_MAX_PX || 1024); // max width/height após normalização
const CAPTURE_JPEG_QUALITY = Number(process.env.CAPTURE_IMG_JPEG_QUALITY || 82);

// Entrada (hardening)
const CAPTURE_IN_MIN_PX = Number(process.env.CAPTURE_IMG_MIN_PX || 96);
const CAPTURE_IN_MAX_PX = Number(process.env.CAPTURE_IMG_IN_MAX_PX || 4096);

// Proporção (evita extremos / imagens “panorâmicas” maliciosas)
const CAPTURE_ASPECT_MIN = Number(process.env.CAPTURE_IMG_ASPECT_MIN || 0.6);
const CAPTURE_ASPECT_MAX = Number(process.env.CAPTURE_IMG_ASPECT_MAX || 1.8);

// Cache-Control (URL versionada pelo objectKey -> pode ser cache longo)
const CAPTURE_CACHE_CONTROL =
  process.env.CAPTURE_SPACES_CACHE_CONTROL || "public, max-age=31536000, immutable";

const CAPTURE_PROCESS_TIMEOUT_MS = Number(process.env.CAPTURE_PROCESS_TIMEOUT_MS || 3000);

function withTimeout(promise, ms, label = "operação") {
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(`timeout:${label}`)), ms);
  });
  return Promise.race([
    promise.finally(() => clearTimeout(t)),
    timeout,
  ]);
}

function detectImageByMagicNumber(buf) {
  if (!buf || buf.length < 12) return null;

  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { mime: "image/jpeg", ext: "jpg" };
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return { mime: "image/png", ext: "png" };
  }

  return null;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: CAPTURE_MAX_BYTES,
    files: 1,
  },
});

router.post(
  "/upload",
  autenticarDeviceCapture,
  rateLimitCapturePorDevice,
  upload.single("file"),
  async (req, res) => {
    const device = req.captureDevice;
    const db = req.db;

    // Se o timeout middleware já encerrou a conexão, não responda novamente
    if (req.aborted || res.writableEnded || res.headersSent) {
      return;
    }

    if (!db) {
      return res.status(500).json({ ok: false, message: "DB não disponível no request." });
    }

    const escola_id = Number(req.captureDevice?.escola_id || 0);
    const device_id = Number(req.captureDevice?.id || 0);

    const aluno_id = Number(req.body?.aluno_id || 0);

    if (!escola_id || !device_id) {
      return res.status(401).json({ ok: false, message: "Device inválido (contexto ausente)." });
    }

    if (!aluno_id || aluno_id <= 0) {
      return res.status(400).json({ ok: false, message: "aluno_id obrigatório." });
    }

    const file = req.file;
    if (!file) {
      return res.status(400).json({ ok: false, message: "Arquivo obrigatório (campo: file)." });
    }

    // 1) NÃO confiar em mimetype. Validar por magic number.
    const magic = detectImageByMagicNumber(file.buffer);
    if (!magic) {
      return res.status(400).json({
        ok: false,
        message: "Tipo inválido. Aceito apenas JPEG/PNG (validação por assinatura do arquivo).",
      });
    }

    const ip = getClientIp(req);
    const user_agent = getUserAgent(req);

    let conn = null;
    let uploaded = null;

    try {
      // 2) Decodificar/validar imagem REAL + metadata (LGPD: remove metadata na saída)
      let meta;
      try {
        meta = await withTimeout(
          sharp(file.buffer, { failOnError: true }).metadata(),
          CAPTURE_PROCESS_TIMEOUT_MS,
          "metadata"
        );
      } catch (e) {
        const msg = String(e?.message || "");
        if (msg.startsWith("timeout:")) {
          return res.status(408).json({ ok: false, message: "Timeout ao processar imagem (metadata)." });
        }
        return res.status(400).json({ ok: false, message: "Imagem inválida/corrompida (decode falhou)." });
      }

      const inW = Number(meta?.width || 0);
      const inH = Number(meta?.height || 0);

      if (!inW || !inH) {
        return res.status(400).json({ ok: false, message: "Imagem inválida (dimensões ausentes)." });
      }

      if (inW < CAPTURE_IN_MIN_PX || inH < CAPTURE_IN_MIN_PX) {
        return res.status(400).json({
          ok: false,
          message: `Imagem muito pequena (${inW}x${inH}). Mínimo: ${CAPTURE_IN_MIN_PX}px.`,
        });
      }

      if (inW > CAPTURE_IN_MAX_PX || inH > CAPTURE_IN_MAX_PX) {
        return res.status(400).json({
          ok: false,
          message: `Imagem muito grande (${inW}x${inH}). Máximo entrada: ${CAPTURE_IN_MAX_PX}px.`,
        });
      }

      const aspect = inW / inH;
      if (aspect < CAPTURE_ASPECT_MIN || aspect > CAPTURE_ASPECT_MAX) {
        return res.status(400).json({
          ok: false,
          message: `Proporção inválida (${aspect.toFixed(2)}). Aceito entre ${CAPTURE_ASPECT_MIN} e ${CAPTURE_ASPECT_MAX}.`,
        });
      }

      // 3) Normalizar para JPEG (resize + compress + strip metadata)
      const normalizedBuffer = await withTimeout(
        sharp(file.buffer, { failOnError: true })
          .rotate() // respeita orientação EXIF
          .resize({
            width: CAPTURE_OUT_MAX_PX,
            height: CAPTURE_OUT_MAX_PX,
            fit: "inside",
            withoutEnlargement: true,
          })
          .jpeg({ quality: CAPTURE_JPEG_QUALITY, mozjpeg: true })
          .toBuffer(),
        CAPTURE_PROCESS_TIMEOUT_MS,
        "normalize"
      );
      // abre conexão dedicada para transação (mysql2/promise pool)
      conn = await db.getConnection();
      await conn.beginTransaction();








      // garante que o aluno pertence à escola (multi-escola) + pega o CODIGO (para nome do arquivo)
      const [chk] = await conn.query(
        `SELECT id, escola_id, codigo FROM alunos WHERE id = ? AND escola_id = ? LIMIT 1`,
        [aluno_id, escola_id]
      );

      if (!chk || chk.length === 0) {
        await conn.rollback();
        return res.status(404).json({ ok: false, message: "Aluno não encontrado nesta escola." });
      }

      const alunoCodigo = String(chk[0]?.codigo || "").trim();
      if (!alunoCodigo) {
        await conn.rollback();
        return res.status(400).json({ ok: false, message: "Aluno sem CODIGO válido (necessário para nome do arquivo)." });
      }

      // resolve apelido real da escola (ex.: CEF04_PLAN). fallback seguro: escola_<id>
      let escolaApelido = null;
      try {
        const [eRows] = await conn.query(
          `SELECT apelido FROM escolas WHERE id = ? LIMIT 1`,
          [escola_id]
        );
        escolaApelido = String(eRows?.[0]?.apelido || "").trim() || null;
      } catch {}

      escolaApelido = escolaApelido || `escola_${escola_id}`;

      // 🔥 objectKey fixo (sem subpastas): uploads/<APELIDO>/alunos/<CODIGO>.jpg
      const objectKey = `uploads/${escolaApelido}/alunos/${alunoCodigo}.jpg`;

      // upload Spaces (buffer normalizado)
      const up = await uploadImageBufferToSpaces({
        buffer: normalizedBuffer,
        mimeType: "image/jpeg",
        escolaId: escola_id,
        escolaApelido,
        alunoId: alunoCodigo,
        kind: "alunos",
        objectKey,
        cacheControl: CAPTURE_CACHE_CONTROL,
      });

      uploaded = up;

      // atualiza alunos.foto com URL do Spaces (App Pais já aceita http/https)
      await conn.query(
        `UPDATE alunos SET foto = ? WHERE id = ? AND escola_id = ?`,
        [up.publicUrl, aluno_id, escola_id]
      );

      // auditoria
      await conn.query(
        `
        INSERT INTO capture_auditoria
          (escola_id, aluno_id, device_id, usuario_id, acao, ip, user_agent, created_at)
        VALUES
          (?, ?, ?, NULL, 'CAPTURA_FOTO', ?, ?, NOW())
        `,
        [escola_id, aluno_id, device_id, ip, user_agent]
      );

      await conn.commit();

      return res.status(200).json({
        ok: true,
        message: "Upload realizado e foto atualizada com sucesso.",
        escola_id,
        aluno_id,
        device_id,
        foto: up.publicUrl,
        objectKey: up.objectKey,
      });
    } catch (err) {
      // Se a conexão já foi encerrada pelo timeout, só faz cleanup/rollback e sai
      if (req.aborted || res.writableEnded || res.headersSent) {
        try { if (conn) await conn.rollback(); } catch {}
        if (uploaded?.objectKey) {
          try { await deleteObjectFromSpaces(uploaded.objectKey); } catch {}
        }
        return;
      }

      try { if (conn) await conn.rollback(); } catch {}

      // rollback compensatório: se subiu no Spaces e falhou depois (DB/auditoria), apagar objeto para não ficar órfão
      if (uploaded?.objectKey) {
        try {
          await deleteObjectFromSpaces(uploaded.objectKey);
        } catch (e) {
          console.error("[CAPTURE] rollback Spaces falhou:", e?.message || e);
        }
      }

      const msg = String(err?.message || "");
      if (msg.startsWith("timeout:")) {
        return res.status(408).json({ ok: false, message: "Timeout ao processar imagem." });
      }

      console.error("[CAPTURE] upload erro:", err?.message || err);
      return res.status(500).json({ ok: false, message: "Erro interno no upload." });
    } finally {
      try { if (conn) conn.release(); } catch {}
    }
  }
);

/**
 * ============================================================================
 * PASSO 3 — PAREAMENTO COM APROVAÇÃO (MODELO CORPORATIVO)
 *
 * Fluxo:
 * 1) App (sem login) -> POST /api/capture/pair/request
 *    - gera pair_code (10 min) e salva em capture_pair_codes
 *
 * 2) Diretor/Web -> POST /api/capture/admin/pair/approve
 *    - valida pair_code, cria/reenroll device em capture_devices
 *    - retorna device_uid + device_token (UMA vez)
 *
 * Importante:
 * - NÃO remove /enroll (fluxo antigo continua existindo)
 * - Multi-escola: escola_id vem do diretor (token) na aprovação
 * ============================================================================
 */

// GET /api/capture/pair/qr/:pair_code  (PADRÃO QR PAYLOAD - app/web só codifica/decodifica)
router.get("/pair/qr/:pair_code", async (req, res) => {
  const pair_code = String(req.params?.pair_code || "").trim().toUpperCase();

  if (!pair_code || pair_code.length < 8) {
    return res.status(400).json({ ok: false, message: "pair_code inválido." });
  }

  try {
    const [rows] = await pool.query(
      `
      SELECT
        pair_code,
        expires_at,
        used_at
      FROM capture_pair_codes
      WHERE pair_code = ?
      LIMIT 1
      `,
      [pair_code]
    );

    if (!rows || rows.length === 0) {
      return res.status(404).json({ ok: false, message: "pair_code não encontrado." });
    }

    const r = rows[0];

    if (r.used_at) {
      return res.status(409).json({ ok: false, message: "pair_code já foi utilizado." });
    }

    const exp = new Date(r.expires_at);
    if (Date.now() > exp.getTime()) {
      return res.status(410).json({ ok: false, message: "pair_code expirado. Gere um novo no app." });
    }

    // Payload padronizado (versão 1). App/Web devem codificar/ler exatamente esta string.
    const qr_payload = JSON.stringify({
      v: 1,
      type: "CAPTURE_PAIR",
      pair_code,
    });

    return res.status(200).json({
      ok: true,
      pair_code,
      expires_at: exp.toISOString(),
      qr_payload,
    });
  } catch (err) {
    console.error("[CAPTURE][PAIR] erro ao gerar qr_payload:", err?.message || err);
    return res.status(500).json({ ok: false, message: "Erro interno ao gerar qr_payload." });
  }
});

// GET /api/capture/pair/status/:pair_code  (APP — polling: aprovado pelo diretor?)
// Retorna { ok, approved, device_token?, device_uid? }
// O device_token só é entregue UMA vez (aprovação detectada por approved_at != null e token_delivered_at == null).
// Para usar este endpoint, adicione à tabela capture_pair_codes:
//   ALTER TABLE capture_pair_codes ADD COLUMN token_delivered_at DATETIME NULL DEFAULT NULL;
router.get("/pair/status/:pair_code", async (req, res) => {
  const pair_code = String(req.params?.pair_code || "").trim().toUpperCase();

  if (!pair_code || pair_code.length < 8) {
    return res.status(400).json({ ok: false, message: "pair_code inválido." });
  }

  try {
    const [rows] = await pool.query(
      `
      SELECT
        id,
        pair_code,
        expires_at,
        used_at,
        approved_at,
        device_uid,
        device_id,
        token_delivered_at
      FROM capture_pair_codes
      WHERE pair_code = ?
      LIMIT 1
      `,
      [pair_code]
    );

    if (!rows || rows.length === 0) {
      return res.status(404).json({ ok: false, message: "pair_code não encontrado." });
    }

    const r = rows[0];

    // Expirado e não aprovado → erro
    const exp = new Date(r.expires_at);
    if (!r.approved_at && Date.now() > exp.getTime()) {
      return res.status(410).json({ ok: false, approved: false, message: "pair_code expirado." });
    }

    // Ainda não aprovado
    if (!r.approved_at) {
      return res.status(200).json({ ok: true, approved: false });
    }

    // Já aprovado, mas token já foi entregue anteriormente → não entrega de novo
    if (r.token_delivered_at) {
      return res.status(200).json({
        ok: true,
        approved: true,
        message: "Dispositivo já credenciado. O token foi entregue anteriormente.",
      });
    }

    // ✅ Aprovado e token ainda não foi entregue: busca o device_token real via capture_devices
    const device_id = Number(r.device_id || 0);
    if (!device_id) {
      return res.status(500).json({ ok: false, message: "device_id ausente no par. Tente novo pareamento." });
    }

    // Gera um novo token temporário? Não — o token foi gerado em /admin/pair/approve.
    // Para entregá-lo, o backend precisaria armazená-lo em texto plano antes de fazer hash.
    // ESTRATÉGIA CLEAN: marcar delivered e mandar o app refazer a autenticação normalmente.
    // O app vai usar o token que o diretor copiou/exibiu. Mas numa integração full, o backend
    // pode guardar o token_plain na tabela temporariamente para entrega aqui.
    //
    // Por ora: entregamos device_uid e sinalizamos o app para aguardar o token do diretor.
    // Se quiser entrega automática, adicione coluna `device_token_plain TEXT` em capture_pair_codes
    // e popule-a em /admin/pair/approve antes de fazer o bcrypt.hash.

    // Busca device_uid
    const [devRows] = await pool.query(
      "SELECT device_uid FROM capture_devices WHERE id = ? LIMIT 1",
      [device_id]
    );
    const device_uid = devRows?.[0]?.device_uid ? String(devRows[0].device_uid) : null;

    // Marca como entregue para não repetir
    await pool.query(
      "UPDATE capture_pair_codes SET token_delivered_at = NOW() WHERE id = ?",
      [Number(r.id)]
    );

    // Se existe device_token_plain na tabela, entrega; caso contrário, apenas avisa
    let device_token_plain = null;
    try {
      const [tRows] = await pool.query(
        "SELECT device_token_plain FROM capture_pair_codes WHERE id = ? LIMIT 1",
        [Number(r.id)]
      );
      device_token_plain = tRows?.[0]?.device_token_plain
        ? String(tRows[0].device_token_plain)
        : null;
    } catch { /* coluna pode não existir ainda */ }

    return res.status(200).json({
      ok: true,
      approved: true,
      device_uid: device_uid || null,
      device_token: device_token_plain || null,
      message: device_token_plain
        ? "Dispositivo aprovado. Token entregue."
        : "Dispositivo aprovado. Solicite o token ao diretor manualmente.",
    });
  } catch (err) {
    console.error("[CAPTURE][PAIR][STATUS] erro:", err?.message || err);
    return res.status(500).json({ ok: false, message: "Erro interno ao verificar status do pareamento." });
  }
});

// POST /api/capture/pair/request  (APP, sem autenticação de usuário)
router.post("/pair/request", async (req, res) => {
  const nome_dispositivo = req.body?.nome_dispositivo ? String(req.body.nome_dispositivo).trim() : null;
  const plataforma = String(req.body?.plataforma || "").trim().toUpperCase();
  const app_version = req.body?.app_version ? String(req.body.app_version).trim() : null;

  const device_uid = normalizeDeviceUid(req.body?.device_uid || req.headers?.["x-device-uid"] || "");

  // ✅ NOVO: código de acesso (primeira tela do app) -> resolve escola_id
  const access_code = String(req.body?.access_code || "").trim().toUpperCase();

  const UID_MIN = 8;
  const UID_MAX = 64;
  const UID_RE = /^[A-Z0-9][A-Z0-9_-]*$/;

  if (!device_uid || device_uid.length < UID_MIN || device_uid.length > UID_MAX || !UID_RE.test(device_uid)) {
    return res.status(400).json({
      ok: false,
      message: `device_uid inválido. Use ${UID_MIN}-${UID_MAX} chars, apenas A-Z, 0-9, _ ou - (ex: TAB_SEC_001).`,
    });
  }

  if (!["ANDROID", "IOS"].includes(plataforma)) {
    return res.status(400).json({ ok: false, message: "plataforma inválida (ANDROID|IOS)." });
  }

  // Regras do access_code: A-Z, 0-9, hífen e underscore (ex: CEF04-CCMDF, CEF_04)
  const AC_MIN = 4;
  const AC_MAX = 24;
  const AC_RE = /^[A-Z0-9][A-Z0-9_-]*[A-Z0-9]$|^[A-Z0-9]$/;

  if (!access_code || access_code.length < AC_MIN || access_code.length > AC_MAX || !AC_RE.test(access_code)) {
    return res.status(400).json({
      ok: false,
      message: `access_code inválido. Use ${AC_MIN}-${AC_MAX} chars (A-Z, 0-9, hífen ou underscore). Exemplo: CEF04-CCMDF.`,
    });
  }

  // ── DEMO BYPASS ──────────────────────────────────────────────────────────
  // Conta demo para revisão Apple/Google Store.
  // Verificado ANTES da consulta ao banco para evitar o 401.
  // DEMO-APPLE: auto-aprova o device imediatamente (escola_id = 1).
  // ────────────────────────────────────────────────────────────────────────
  const DEMO_ACCESS_CODES = ["DEMO-APPLE"];
  if (DEMO_ACCESS_CODES.includes(access_code)) {
    let conn = null;
    const demo_escola_id = 1; // escola demo fixa para revisão das lojas
    const created_ip = getClientIp(req);
    const created_user_agent = getUserAgent(req);
    try {
      conn = await pool.getConnection();
      await conn.beginTransaction();

      // Gera device_token
      const device_token = crypto.randomBytes(32).toString("hex");
      const device_secret_hash = await bcrypt.hash(device_token, 10);

      // Upsert em capture_devices
      const [devRows] = await conn.query(
        "SELECT id FROM capture_devices WHERE device_uid = ? LIMIT 1",
        [device_uid]
      );

      let device_id = null;
      if (devRows && devRows.length > 0) {
        device_id = Number(devRows[0].id);
        await conn.query(
          `UPDATE capture_devices
              SET escola_id = ?, nome_dispositivo = ?, plataforma = ?,
                  device_secret_hash = ?, app_version = ?, ativo = 1,
                  enrolled_by_usuario_id = 99999, last_seen_at = NOW()
            WHERE id = ?`,
          [demo_escola_id, nome_dispositivo || "EDUCA-CAPTURE (Demo)", plataforma, device_secret_hash, app_version, device_id]
        );
      } else {
        const [ins] = await conn.query(
          `INSERT INTO capture_devices
            (escola_id, nome_dispositivo, plataforma, device_uid, device_secret_hash, app_version, ativo, enrolled_by_usuario_id, created_at, last_seen_at)
           VALUES (?, ?, ?, ?, ?, ?, 1, 99999, NOW(), NOW())`,
          [demo_escola_id, nome_dispositivo || "EDUCA-CAPTURE (Demo)", plataforma, device_uid, device_secret_hash, app_version]
        );
        device_id = Number(ins.insertId);
      }

      // Cria pair_code já aprovado (para rastreabilidade)
      const pair_code = generatePairCode();
      try {
        await conn.query(
          `INSERT INTO capture_pair_codes
            (pair_code, escola_id, device_uid, plataforma, nome_dispositivo, app_version,
             expires_at, created_ip, created_user_agent, created_at,
             approved_at, approved_by_usuario_id, device_id, used_at,
             device_token_plain, token_delivered_at)
           VALUES (?, ?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL 1 HOUR), ?, ?, NOW(),
                   NOW(), 99999, ?, NOW(), ?, NOW())`,
          [pair_code, demo_escola_id, device_uid, plataforma, nome_dispositivo, app_version,
           created_ip, created_user_agent, device_id, device_token]
        );
      } catch (e) {
        if (String(e?.code || "") !== "ER_DUP_ENTRY") throw e;
      }

      await safeInsertCaptureAuditoria(conn, {
        escola_id: demo_escola_id,
        aluno_id: null,
        device_id,
        usuario_id: 99999,
        acao: "DEMO_AUTO_APPROVE",
        ip: created_ip,
        user_agent: created_user_agent,
      });

      await conn.commit();

      console.log(`[CAPTURE][DEMO] Auto-approve: access_code=${access_code}, device_uid=${device_uid}, device_id=${device_id}`);

      return res.status(201).json({
        ok: true,
        pair_code,
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
        _demo: true,
        _auto_approved: true,
        device_token,
        device_uid,
        device_id,
      });
    } catch (err) {
      try { if (conn) await conn.rollback(); } catch {}
      console.error("[CAPTURE][DEMO] erro ao auto-aprovar:", err?.message || err);
      return res.status(500).json({ ok: false, message: "Erro interno ao auto-aprovar conta demo." });
    } finally {
      try { if (conn) conn.release(); } catch {}
    }
  }
  // ── FIM DEMO BYPASS ──────────────────────────────────────────────────────

  // Resolve escola_id via access_code (multi-escola hardening)
  let escola_id = 0;
  try {
    const [aRows] = await pool.query(
      `
      SELECT escola_id
      FROM capture_access_codes
      WHERE access_code = ?
        AND ativo = 1
      LIMIT 1
      `,
      [access_code]
    );

    escola_id = Number(aRows?.[0]?.escola_id || 0);
    if (!escola_id || escola_id <= 0) {
      return res.status(401).json({ ok: false, message: "access_code inválido ou inativo." });
    }
  } catch (err) {
    console.error("[CAPTURE][PAIR] erro ao validar access_code:", err?.message || err);
    return res.status(500).json({ ok: false, message: "Erro interno ao validar access_code." });
  }

  const cd = checkPairReqCooldown(device_uid);
  if (!cd.ok) {
    return res.status(429).json({
      ok: false,
      message: "Solicitação de pareamento muito frequente. Aguarde alguns segundos e tente novamente.",
      retry_after_ms: Math.max(0, cd.resetAt - Date.now()),
    });
  }

  const created_ip = getClientIp(req);
  const created_user_agent = getUserAgent(req);

  // ✅ escola_id já resolvido e validado pelo access_code acima.
  // Não exigimos pré-cadastro do device_uid em capture_devices:
  // o access_code É a prova de pertencimento à escola.
  // O device será criado/atualizado em capture_devices no momento do approve.









  const created_ip = getClientIp(req);
  const created_user_agent = getUserAgent(req);

  // ✅ escola_id já resolvido e validado pelo access_code acima.
  // Não exigimos pré-cadastro do device_uid em capture_devices:
  // o access_code É a prova de pertencimento à escola.
  // O device será criado/atualizado em capture_devices no momento do approve.


  const expiresAt = new Date(Date.now() + CAPTURE_PAIR_EXPIRES_MS);
  const MAX_TRIES = 6;

  try {
    for (let i = 0; i < MAX_TRIES; i++) {
      const pair_code = generatePairCode();

      try {
        await pool.query(
          `
          INSERT INTO capture_pair_codes
            (pair_code, escola_id, device_uid, plataforma, nome_dispositivo, app_version, expires_at, created_ip, created_user_agent, created_at)
          VALUES
            (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
          `,
          [pair_code, escola_id, device_uid, plataforma, nome_dispositivo, app_version, expiresAt, created_ip, created_user_agent]
        );

        return res.status(201).json({
          ok: true,
          pair_code,
          expires_at: expiresAt.toISOString(),
        });
      } catch (e) {
        // colisão de unique(pair_code) → tenta outro
        if (String(e?.code || "") === "ER_DUP_ENTRY") continue;
        throw e;
      }
    }

    return res.status(500).json({ ok: false, message: "Falha ao gerar pair_code. Tente novamente." });
  } catch (err) {
    console.error("[CAPTURE][PAIR] erro ao criar pair_code:", err?.message || err);
    return res.status(500).json({ ok: false, message: "Erro interno ao criar pair_code." });
  }
});

// POST /api/capture/admin/pair/approve  (DIRETOR/WEB)
router.post(
  "/admin/pair/approve",
  autenticarToken,
  verificarEscola,
  autorizarPermissao("capture_devices.gerenciar"),
  async (req, res) => {
    const escola_id = Number(req.user?.escola_id || 0);
    const usuario_id = req.user?.usuarioId ?? req.user?.id ?? req.user?.usuario_id ?? null;

    const pair_code = String(req.body?.pair_code || "").trim().toUpperCase();

    if (!escola_id || escola_id <= 0) {
      return res.status(400).json({ ok: false, message: "escola_id inválida no usuário." });
    }

    if (!pair_code || pair_code.length < 8) {
      return res.status(400).json({ ok: false, message: "pair_code obrigatório." });
    }

    const approved_ip = getClientIp(req);
    const approved_user_agent = getUserAgent(req);

    let conn = null;

    try {
      conn = await pool.getConnection();
      await conn.beginTransaction();

      // 1) Busca e valida o pair_code (não expirado, não usado)
      const [rows] = await conn.query(
        `
        SELECT
          id,
          pair_code,
          device_uid,
          plataforma,
          nome_dispositivo,
          app_version,
          escola_id,
          device_id,
          expires_at,
          used_at
        FROM capture_pair_codes
        WHERE pair_code = ?
        LIMIT 1
        `,
        [pair_code]
      );

      if (!rows || rows.length === 0) {
        await conn.rollback();
        return res.status(404).json({ ok: false, message: "pair_code não encontrado." });
      }

      const r = rows[0];

      // ✅ HARDENING multi-escola: pair_code precisa pertencer à escola do diretor
      const pair_escola_id = Number(r.escola_id || 0);
      if (!pair_escola_id || pair_escola_id !== escola_id) {
        await conn.rollback();
        return res.status(403).json({
          ok: false,
          message: "pair_code não pertence a esta escola (ou foi gerado sem escola_id). Gere novamente no app com access_code válido.",
        });
      }

      if (r.used_at) {
        await conn.rollback();
        return res.status(409).json({ ok: false, message: "pair_code já foi utilizado." });
      }

      const exp = new Date(r.expires_at);
      if (Date.now() > exp.getTime()) {
        await conn.rollback();
        return res.status(410).json({ ok: false, message: "pair_code expirado. Gere um novo no app." });
      }

      const device_uid = normalizeDeviceUid(r.device_uid);
      const nome_dispositivo = String(r.nome_dispositivo || "EDUCA-CAPTURE").trim();
      const plataforma = String(r.plataforma || "").trim().toUpperCase();
      const app_version = r.app_version ? String(r.app_version).trim() : null;

      // 2) Gera device_token (entregue UMA vez)
      const device_token = crypto.randomBytes(32).toString("hex");
      const device_secret_hash = await bcrypt.hash(device_token, 10);

      // 3) Upsert em capture_devices por device_uid (mantém o comportamento do /enroll)
      const [devRows] = await conn.query(
        "SELECT id FROM capture_devices WHERE device_uid = ? LIMIT 1",
        [device_uid]
      );

      let device_id = null;

      if (devRows && devRows.length > 0) {
        device_id = Number(devRows[0].id);

        await conn.query(
          `
          UPDATE capture_devices
             SET escola_id = ?,
                 nome_dispositivo = ?,
                 plataforma = ?,
                 device_secret_hash = ?,
                 app_version = ?,
                 ativo = 1,
                 enrolled_by_usuario_id = ?,
                 last_seen_at = NOW()
           WHERE id = ?
          `,
          [escola_id, nome_dispositivo, plataforma, device_secret_hash, app_version, usuario_id, device_id]
        );

        await safeInsertCaptureAuditoria(conn, {
          escola_id,
          aluno_id: null,
          device_id,
          usuario_id,
          acao: "DEVICE_REENROLL",
          ip: approved_ip,
          user_agent: approved_user_agent,
        });
      } else {
        const [ins] = await conn.query(
          `
          INSERT INTO capture_devices
            (escola_id, nome_dispositivo, plataforma, device_uid, device_secret_hash, app_version, ativo, enrolled_by_usuario_id, created_at, last_seen_at)
          VALUES (?, ?, ?, ?, ?, ?, 1, ?, NOW(), NOW())
          `,
          [escola_id, nome_dispositivo, plataforma, device_uid, device_secret_hash, app_version, usuario_id]
        );

        device_id = Number(ins.insertId);

        await safeInsertCaptureAuditoria(conn, {
          escola_id,
          aluno_id: null,
          device_id,
          usuario_id,
          acao: "DEVICE_ENROLL",
          ip: approved_ip,
          user_agent: approved_user_agent,
        });
      }

      // 4) Marca o pair_code como usado + aprovado + vinculando escola e device_id
      // device_token_plain é guardado temporariamente para entrega via /pair/status (polling do app).
      // Após a entrega, token_delivered_at é marcado e device_token_plain pode ser apagado.
      await conn.query(
        `
        UPDATE capture_pair_codes
           SET escola_id = ?,
               approved_by_usuario_id = ?,
               approved_at = NOW(),
               device_id = ?,
               used_at = NOW(),
               approved_ip = ?,
               approved_user_agent = ?,
               device_token_plain = ?
         WHERE id = ?
        `,
        [escola_id, usuario_id, device_id, approved_ip, approved_user_agent, device_token, Number(r.id)]
      );

      await safeInsertCaptureAuditoria(conn, {
        escola_id,
        aluno_id: null,
        device_id,
        usuario_id,
        acao: "PAIR_CODE_APROVADO",
        ip: approved_ip,
        user_agent: approved_user_agent,
      });

      await conn.commit();

      return res.status(200).json({
        ok: true,
        message: "Pareamento aprovado. Entregando token ao app (UMA vez).",
        device_id,
        device_uid,
        device_token,
      });
    } catch (err) {
      try { if (conn) await conn.rollback(); } catch {}
      console.error("[CAPTURE][PAIR][ADMIN] erro ao aprovar:", err?.message || err);
      return res.status(500).json({ ok: false, message: "Erro interno ao aprovar pareamento." });
    } finally {
      try { if (conn) conn.release(); } catch {}
    }
  }
);

// POST /api/capture/admin/pair/approve/:id  (DIRETOR/WEB)
// Aprova diretamente pelo ID retornado em /admin/pair/pending (UX: sem copiar/colar pair_code).
router.post(
  "/admin/pair/approve/:id",
  autenticarToken,
  verificarEscola,
  autorizarPermissao("capture_devices.gerenciar"),
  async (req, res) => {
    const escola_id = Number(req.user?.escola_id || 0);
    const usuario_id = req.user?.usuarioId ?? req.user?.id ?? req.user?.usuario_id ?? null;

    const pair_id = Number(req.params?.id || 0);

    if (!escola_id || escola_id <= 0) {
      return res.status(400).json({ ok: false, message: "escola_id inválida no usuário." });
    }

    if (!pair_id || pair_id <= 0) {
      return res.status(400).json({ ok: false, message: "pair_id inválido." });
    }

    const approved_ip = getClientIp(req);
    const approved_user_agent = getUserAgent(req);

    let conn = null;

    try {
      conn = await pool.getConnection();
      await conn.beginTransaction();

      // 1) Busca e valida o pair_code pelo ID (não expirado, não usado)
      const [rows] = await conn.query(
        `
        SELECT
          id,
          pair_code,
          device_uid,
          plataforma,
          nome_dispositivo,
          app_version,
          escola_id,
          device_id,
          expires_at,
          used_at
        FROM capture_pair_codes
        WHERE id = ?
        LIMIT 1
        `,
        [pair_id]
      );

      if (!rows || rows.length === 0) {
        await conn.rollback();
        return res.status(404).json({ ok: false, message: "pair_id não encontrado." });
      }

      const r = rows[0];

      // ✅ HARDENING multi-escola: pair_code precisa pertencer à escola do diretor
      const pair_escola_id = Number(r.escola_id || 0);
      if (!pair_escola_id || pair_escola_id !== escola_id) {
        await conn.rollback();
        return res.status(403).json({
          ok: false,
          message: "pair_code não pertence a esta escola (ou foi gerado sem escola_id). Gere novamente no app com access_code válido.",
        });
      }

      if (r.used_at) {
        await conn.rollback();
        return res.status(409).json({ ok: false, message: "pair_code já foi utilizado." });
      }

      const exp = new Date(r.expires_at);
      if (Date.now() > exp.getTime()) {
        await conn.rollback();
        return res.status(410).json({ ok: false, message: "pair_code expirado. Gere um novo no app." });
      }

      const device_uid = normalizeDeviceUid(r.device_uid);
      const nome_dispositivo = String(r.nome_dispositivo || "EDUCA-CAPTURE").trim();
      const plataforma = String(r.plataforma || "").trim().toUpperCase();
      const app_version = r.app_version ? String(r.app_version).trim() : null;

      // 2) Gera device_token (entregue UMA vez)
      const device_token = crypto.randomBytes(32).toString("hex");
      const device_secret_hash = await bcrypt.hash(device_token, 10);

      // 3) Upsert em capture_devices por device_uid (mantém o comportamento do /enroll)
      const [devRows] = await conn.query(
        "SELECT id FROM capture_devices WHERE device_uid = ? LIMIT 1",
        [device_uid]
      );

      let device_id = null;

      if (devRows && devRows.length > 0) {
        device_id = Number(devRows[0].id);

        await conn.query(
          `
          UPDATE capture_devices
             SET escola_id = ?,
                 nome_dispositivo = ?,
                 plataforma = ?,
                 device_secret_hash = ?,
                 app_version = ?,
                 ativo = 1,
                 enrolled_by_usuario_id = ?,
                 last_seen_at = NOW()
           WHERE id = ?
          `,
          [escola_id, nome_dispositivo, plataforma, device_secret_hash, app_version, usuario_id, device_id]
        );

        await safeInsertCaptureAuditoria(conn, {
          escola_id,
          aluno_id: null,
          device_id,
          usuario_id,
          acao: "DEVICE_REENROLL",
          ip: approved_ip,
          user_agent: approved_user_agent,
        });
      } else {
        const [ins] = await conn.query(
          `
          INSERT INTO capture_devices
            (escola_id, nome_dispositivo, plataforma, device_uid, device_secret_hash, app_version, ativo, enrolled_by_usuario_id, created_at, last_seen_at)
          VALUES (?, ?, ?, ?, ?, ?, 1, ?, NOW(), NOW())
          `,
          [escola_id, nome_dispositivo, plataforma, device_uid, device_secret_hash, app_version, usuario_id]
        );

        device_id = Number(ins.insertId);

        await safeInsertCaptureAuditoria(conn, {
          escola_id,
          aluno_id: null,
          device_id,
          usuario_id,
          acao: "DEVICE_ENROLL",
          ip: approved_ip,
          user_agent: approved_user_agent,
        });
      }

      // 4) Marca como usado + aprovado + vinculando escola e device_id
      await conn.query(
        `
        UPDATE capture_pair_codes
           SET escola_id = ?,
               approved_by_usuario_id = ?,
               approved_at = NOW(),
               device_id = ?,
               used_at = NOW(),
               approved_ip = ?,
               approved_user_agent = ?,
               device_token_plain = ?
         WHERE id = ?
        `,
        [escola_id, usuario_id, device_id, approved_ip, approved_user_agent, device_token, Number(r.id)]
      );

      await safeInsertCaptureAuditoria(conn, {
        escola_id,
        aluno_id: null,
        device_id,
        usuario_id,
        acao: "PAIR_CODE_APROVADO",
        ip: approved_ip,
        user_agent: approved_user_agent,
      });

      await conn.commit();

      return res.status(200).json({
        ok: true,
        message: "Pareamento aprovado. Entregando token ao app (UMA vez).",
        pair_id: Number(r.id),
        pair_code: String(r.pair_code || "").toUpperCase(),
        device_id,
        device_uid,
        device_token,
      });
    } catch (err) {
      try { if (conn) await conn.rollback(); } catch {}
      console.error("[CAPTURE][PAIR][ADMIN] erro ao aprovar por id:", err?.message || err);
      return res.status(500).json({ ok: false, message: "Erro interno ao aprovar pareamento." });
    } finally {
      try { if (conn) conn.release(); } catch {}
    }
  }
);

// GET /api/capture/admin/pair/pending  (DIRETOR/WEB)
// Lista pair_codes pendentes (não usados e não expirados).
// Observação: como o pair_code nasce sem escola_id (device ainda não vinculado),
// este endpoint retorna pendências globais (sem dados sensíveis como IP/UA).
router.get(
  "/admin/pair/pending",
  autenticarToken,
  verificarEscola,
  autorizarPermissao("capture_devices.gerenciar"),
  async (req, res) => {
    try {
      // Mantém a validação de contexto (diretor precisa estar em uma escola),
      // mesmo que o filtro por escola ainda não seja possível antes da aprovação.
      const escola_id = Number(req.user?.escola_id || 0);

      if (!escola_id || escola_id <= 0) {
        return res.status(400).json({ ok: false, message: "escola_id inválida no usuário." });
      }

      const limitRaw = Number(req.query?.limit || 50);
      const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 50;

      const [rows] = await pool.query(
        `
        SELECT
          id,
          pair_code,
          device_uid,
          plataforma,
          nome_dispositivo,
          app_version,
          expires_at,
          created_at
        FROM capture_pair_codes
        WHERE used_at IS NULL
          AND expires_at > NOW()
          AND escola_id = ?
        ORDER BY created_at DESC
        LIMIT ?
        `,
        [escola_id, limit]
      );

      return res.status(200).json({
        ok: true,
        pending: rows || [],
      });
    } catch (err) {
      console.error("[CAPTURE][PAIR][ADMIN] erro ao listar pendências:", err?.message || err);
      return res.status(500).json({ ok: false, message: "Erro interno ao listar pendências." });
    }
  }
);

/**
 * POST /api/capture/enroll
 * - Protegido: JWT + escola (x-escola-id ou token escolar)
 * - Objetivo: parear um dispositivo institucional e gerar device_token (1ª e única vez)
 * Body:
 *  - nome_dispositivo (string)
 *  - plataforma ('ANDROID'|'IOS')
 *  - device_uid (string)  // identificador único gerado no app
 *  - app_version (string opcional)
 */
// ============================================================================
// PASSO 3.1 — ADMIN (Diretor / Gestão) — Devices EDUCA-CAPTURE
// - SEM alterar o fluxo do app
// - Isolamento por escola_id (multi-tenant)
// - Bloqueio/liberação via campo capture_devices.ativo (já suportado pelo middleware)
// ============================================================================

// GET /api/capture/admin/devices
router.get(
  "/admin/devices",
  autenticarToken,
  verificarEscola,
  autorizarPermissao("capture_devices.gerenciar"),
  async (req, res) => {
    const escola_id = Number(req.user?.escola_id || 0);

    if (!escola_id || escola_id <= 0) {
      return res.status(400).json({ ok: false, message: "escola_id inválida no usuário." });
    }

    try {
      const [rows] = await pool.query(
        `
        SELECT
          id,
          escola_id,
          nome_dispositivo,
          plataforma,
          device_uid,
          app_version,
          ativo,
          enrolled_by_usuario_id,
          created_at,
          last_seen_at
        FROM capture_devices
        WHERE escola_id = ?
        ORDER BY id DESC
        `,
        [escola_id]
      );

      return res.status(200).json({
        ok: true,
        devices: rows || [],
      });
    } catch (err) {
      console.error("[CAPTURE][ADMIN] erro ao listar devices:", err?.message || err);
      return res.status(500).json({ ok: false, message: "Erro interno ao listar devices." });
    }
  }
);

// PATCH /api/capture/admin/devices/:id/ativo
router.patch(
  "/admin/devices/:id/ativo",
  autenticarToken,
  verificarEscola,
  autorizarPermissao("capture_devices.gerenciar"),
  async (req, res) => {
    const escola_id = Number(req.user?.escola_id || 0);
    const usuario_id = req.user?.usuarioId ?? req.user?.id ?? req.user?.usuario_id ?? null;

    const device_id = Number(req.params?.id || 0);
    const ativoRaw = req.body?.ativo;

    // aceita: 1/0, true/false, "1"/"0"
    const ativo =
      ativoRaw === true || ativoRaw === 1 || ativoRaw === "1"
        ? 1
        : ativoRaw === false || ativoRaw === 0 || ativoRaw === "0"
          ? 0
          : null;

    if (!escola_id || escola_id <= 0) {
      return res.status(400).json({ ok: false, message: "escola_id inválida no usuário." });
    }

    if (!device_id || device_id <= 0) {
      return res.status(400).json({ ok: false, message: "device_id inválido." });
    }

    if (ativo === null) {
      return res.status(400).json({ ok: false, message: "Campo 'ativo' obrigatório (0/1 ou true/false)." });
    }

    try {
      // garante isolamento por escola_id
      const [rows] = await pool.query(
        `
        SELECT id, escola_id, ativo
        FROM capture_devices
        WHERE id = ? AND escola_id = ?
        LIMIT 1
        `,
        [device_id, escola_id]
      );

      if (!rows || rows.length === 0) {
        return res.status(404).json({ ok: false, message: "Device não encontrado para esta escola." });
      }

      await pool.query(
        `
        UPDATE capture_devices
        SET ativo = ?
        WHERE id = ? AND escola_id = ?
        `,
        [ativo, device_id, escola_id]
      );

      await safeInsertCaptureAuditoria(pool, {
        escola_id,
        aluno_id: null,
        device_id,
        usuario_id,
        acao: ativo ? "DEVICE_LIBERADO" : "DEVICE_BLOQUEADO",
        ip: getClientIp(req),
        user_agent: getUserAgent(req),
      });

      return res.status(200).json({
        ok: true,
        message: ativo ? "Device liberado com sucesso." : "Device bloqueado com sucesso.",
        device_id,
        ativo,
      });
    } catch (err) {
      console.error("[CAPTURE][ADMIN] erro ao atualizar ativo:", err?.message || err);
      return res.status(500).json({ ok: false, message: "Erro interno ao atualizar device." });
    }
  }
);




// ============================================================================
// PASSO — ACCESS CODE (ADMIN / DIRETOR)
// Objetivo: diretor cria um código curto (ex: A1B2C3) para o app informar na 1ª tela.
// Depois, o /pair/request poderá nascer com escola_id sem pré-cadastro de device_uid.
//
// Tabela esperada (a ser criada no DB):
// capture_access_codes: id, escola_id, access_code, label, ativo,
// created_by_usuario_id, created_at, disabled_by_usuario_id, disabled_at
// ============================================================================

// GET /api/capture/admin/access-codes
router.get(
  "/admin/access-codes",
  autenticarToken,
  verificarEscola,
  autorizarPermissao("capture_devices.gerenciar"),
  async (req, res) => {
    const escola_id = Number(req.user?.escola_id || 0);

    if (!escola_id || escola_id <= 0) {
      return res.status(400).json({ ok: false, message: "escola_id inválida no usuário." });
    }

    try {
      const [rows] = await pool.query(
        `
        SELECT
          id,
          escola_id,
          access_code,
          label,
          ativo,
          created_by_usuario_id,
          created_at,
          disabled_by_usuario_id,
          disabled_at
        FROM capture_access_codes
        WHERE escola_id = ?
        ORDER BY ativo DESC, id DESC
        `,
        [escola_id]
      );

      return res.status(200).json({ ok: true, access_codes: rows || [] });
    } catch (err) {
      console.error("[CAPTURE][ACCESS_CODE][ADMIN] erro ao listar:", err?.message || err);
      return res.status(500).json({ ok: false, message: "Erro interno ao listar access_codes." });
    }
  }
);

// POST /api/capture/admin/access-codes
router.post(
  "/admin/access-codes",
  autenticarToken,
  verificarEscola,
  autorizarPermissao("capture_devices.gerenciar"),
  async (req, res) => {
    const escola_id = Number(req.user?.escola_id || 0);
    const usuario_id = req.user?.usuarioId ?? req.user?.id ?? req.user?.usuario_id ?? null;

    if (!escola_id || escola_id <= 0) {
      return res.status(400).json({ ok: false, message: "escola_id inválida no usuário." });
    }

    const access_code = String(req.body?.access_code || "")
      .trim()
      .toUpperCase();

    const label = req.body?.label ? String(req.body.label).trim().slice(0, 80) : null;

    // Padrão unificado: 4-24 chars, A-Z/0-9, hífen ou underscore internos (ex: CEF04-CCMDF)
    const RE = /^[A-Z0-9][A-Z0-9_-]*[A-Z0-9]$|^[A-Z0-9]$/;
    const AC_MIN = 4;
    const AC_MAX = 24;
    if (!access_code || access_code.length < AC_MIN || access_code.length > AC_MAX || !RE.test(access_code)) {
      return res.status(400).json({
        ok: false,
        message: `access_code inválido. Use ${AC_MIN}-${AC_MAX} chars (A-Z, 0-9, hífen ou underscore). Ex: CEF04-CCMDF.`,
      });
    }

    try {
      // Evita duplicidade dentro da escola
      const [dup] = await pool.query(
        `
        SELECT id, ativo
        FROM capture_access_codes
        WHERE escola_id = ? AND access_code = ?
        LIMIT 1
        `,
        [escola_id, access_code]
      );

      if (dup && dup.length > 0) {
        return res.status(409).json({
          ok: false,
          message: "Este access_code já existe para esta escola.",
          id: Number(dup[0].id),
          ativo: Number(dup[0].ativo) ? 1 : 0,
        });
      }

      const [ins] = await pool.query(
        `
        INSERT INTO capture_access_codes
          (escola_id, access_code, label, ativo, created_by_usuario_id, created_at)
        VALUES
          (?, ?, ?, 1, ?, NOW())
        `,
        [escola_id, access_code, label, usuario_id]
      );

      // Auditoria
      await safeInsertCaptureAuditoria(pool, {
        escola_id,
        aluno_id: null,
        device_id: null,
        usuario_id,
        acao: "ACCESS_CODE_CRIADO",
        ip: getClientIp(req),
        user_agent: getUserAgent(req),
      });

      return res.status(201).json({
        ok: true,
        message: "access_code criado com sucesso.",
        access_code: {
          id: Number(ins.insertId),
          escola_id,
          access_code,
          label,
          ativo: 1,
        },
      });
    } catch (err) {
      console.error("[CAPTURE][ACCESS_CODE][ADMIN] erro ao criar:", err?.message || err);
      return res.status(500).json({ ok: false, message: "Erro interno ao criar access_code." });
    }
  }
);

// PATCH /api/capture/admin/access-codes/:id/ativo
router.patch(
  "/admin/access-codes/:id/ativo",
  autenticarToken,
  verificarEscola,
  autorizarPermissao("capture_devices.gerenciar"),
  async (req, res) => {
    const escola_id = Number(req.user?.escola_id || 0);
    const usuario_id = req.user?.usuarioId ?? req.user?.id ?? req.user?.usuario_id ?? null;

    const id = Number(req.params?.id || 0);
    const ativoRaw = req.body?.ativo;

    const ativo =
      ativoRaw === true || ativoRaw === 1 || ativoRaw === "1"
        ? 1
        : ativoRaw === false || ativoRaw === 0 || ativoRaw === "0"
          ? 0
          : null;

    if (!escola_id || escola_id <= 0) {
      return res.status(400).json({ ok: false, message: "escola_id inválida no usuário." });
    }

    if (!id || id <= 0) {
      return res.status(400).json({ ok: false, message: "id inválido." });
    }

    if (ativo === null) {
      return res.status(400).json({ ok: false, message: "Campo 'ativo' obrigatório (0/1 ou true/false)." });
    }

    try {
      const [rows] = await pool.query(
        `
        SELECT id, escola_id, ativo, access_code
        FROM capture_access_codes
        WHERE id = ? AND escola_id = ?
        LIMIT 1
        `,
        [id, escola_id]
      );

      if (!rows || rows.length === 0) {
        return res.status(404).json({ ok: false, message: "access_code não encontrado para esta escola." });
      }

      const access_code = String(rows[0]?.access_code || "").trim();

      if (ativo === 0) {
        await pool.query(
          `
          UPDATE capture_access_codes
          SET ativo = 0,
              disabled_by_usuario_id = ?,
              disabled_at = NOW()
          WHERE id = ? AND escola_id = ?
          `,
          [usuario_id, id, escola_id]
        );
      } else {
        await pool.query(
          `
          UPDATE capture_access_codes
          SET ativo = 1,
              disabled_by_usuario_id = NULL,
              disabled_at = NULL
          WHERE id = ? AND escola_id = ?
          `,
          [id, escola_id]
        );
      }

      await safeInsertCaptureAuditoria(pool, {
        escola_id,
        aluno_id: null,
        device_id: null,
        usuario_id,
        acao: ativo ? "ACCESS_CODE_ATIVADO" : "ACCESS_CODE_DESATIVADO",
        ip: getClientIp(req),
        user_agent: getUserAgent(req),
      });

      return res.status(200).json({
        ok: true,
        message: ativo ? "access_code ativado com sucesso." : "access_code desativado com sucesso.",
        id,
        access_code,
        ativo,
      });
    } catch (err) {
      console.error("[CAPTURE][ACCESS_CODE][ADMIN] erro ao atualizar ativo:", err?.message || err);
      return res.status(500).json({ ok: false, message: "Erro interno ao atualizar access_code." });
    }
  }
);

router.post("/enroll", autenticarToken, verificarEscola, async (req, res) => {
  const escola_id = Number(req.user?.escola_id);
  const usuario_id = req.user?.usuarioId ?? req.user?.id ?? req.user?.usuario_id ?? null;

  const nome_dispositivo = String(req.body?.nome_dispositivo || "").trim();
  const plataforma = String(req.body?.plataforma || "").trim().toUpperCase();

  // PASSO 4 — Normalização/validação estrutural do UID (consistente com autenticarDeviceCapture)
  const deviceUidBodyRaw = String(req.body?.device_uid || "").trim();
  const deviceUidHeaderRaw = String(req.headers?.["x-device-uid"] || "").trim();

  const device_uid_raw = deviceUidBodyRaw || deviceUidHeaderRaw;

  const device_uid = String(device_uid_raw || "").trim().toUpperCase();
  const UID_MIN = 8;
  const UID_MAX = 64;
  const UID_RE = /^[A-Z0-9][A-Z0-9_-]*$/;

  // Se vierem os 2 (body e header) e forem diferentes após normalização → rejeita
  if (deviceUidBodyRaw && deviceUidHeaderRaw) {
    const b = deviceUidBodyRaw.toUpperCase();
    const h = deviceUidHeaderRaw.toUpperCase();
    if (b !== h) {
      return res.status(400).json({
        ok: false,
        message: "Conflito: device_uid no body difere do header. Envie apenas um, ou valores idênticos.",
      });
    }
  }

  const app_version = req.body?.app_version ? String(req.body.app_version).trim() : null;

  if (!escola_id || escola_id <= 0) {
    return res.status(400).json({ ok: false, message: "escola_id inválida." });
  }

  if (!nome_dispositivo || nome_dispositivo.length < 3) {
    return res.status(400).json({ ok: false, message: "nome_dispositivo obrigatório." });
  }

  if (!["ANDROID", "IOS"].includes(plataforma)) {
    return res.status(400).json({ ok: false, message: "plataforma inválida (ANDROID|IOS)." });
  }

  if (!device_uid || device_uid.length < UID_MIN || device_uid.length > UID_MAX || !UID_RE.test(device_uid)) {
    return res.status(400).json({
      ok: false,
      message: `device_uid inválido. Use ${UID_MIN}-${UID_MAX} chars, apenas A-Z, 0-9, _ ou - (ex: TAB_SEC_001).`,
    });
  }

  // PASSO 5.2 — Cooldown: evita reenroll duplicado que invalida o token anterior
  const enrollKey = `${escola_id}:${device_uid}`;
  const cd = checkEnrollCooldown(enrollKey);
  if (!cd.ok) {
    return res.status(429).json({
      ok: false,
      message: "Reenroll muito frequente. Aguarde alguns segundos e tente novamente.",
      retry_after_ms: Math.max(0, cd.resetAt - Date.now()),
    });
  }

  try {
    // Gera token do dispositivo (entregue UMA única vez ao app)
    const device_token = crypto.randomBytes(32).toString("hex");
    const device_secret_hash = await bcrypt.hash(device_token, 10);

    // Upsert simples: se device_uid já existir, atualiza segredo + meta
    const [rows] = await pool.query(
      "SELECT id FROM capture_devices WHERE device_uid = ?",
      [device_uid]
    );

    if (rows.length > 0) {
      const deviceId = rows[0].id;

      await pool.query(
        `
        UPDATE capture_devices
           SET escola_id = ?,
               nome_dispositivo = ?,
               plataforma = ?,
               device_secret_hash = ?,
               app_version = ?,
               ativo = 1,
               enrolled_by_usuario_id = ?,
               last_seen_at = NOW()
         WHERE id = ?
        `,
        [escola_id, nome_dispositivo, plataforma, device_secret_hash, app_version, usuario_id, deviceId]
      );

      await safeInsertCaptureAuditoria(pool, {
        escola_id,
        aluno_id: null,
        device_id: deviceId,
        usuario_id,
        acao: "DEVICE_REENROLL",
        ip: getClientIp(req),
        user_agent: getUserAgent(req),
      });

      return res.status(200).json({
        ok: true,
        message: "Dispositivo reenrolled com sucesso.",
        device_id: deviceId,
        device_token, // ⚠️ entregue apenas aqui
      });
    }

    const [ins] = await pool.query(
      `
      INSERT INTO capture_devices
        (escola_id, nome_dispositivo, plataforma, device_uid, device_secret_hash, app_version, ativo, enrolled_by_usuario_id, created_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, NOW(), NOW())
      `,
      [escola_id, nome_dispositivo, plataforma, device_uid, device_secret_hash, app_version, usuario_id]
    );

    await safeInsertCaptureAuditoria(pool, {
      escola_id,
      aluno_id: null,
      device_id: ins.insertId,
      usuario_id,
      acao: "DEVICE_ENROLL",
      ip: getClientIp(req),
      user_agent: getUserAgent(req),
    });

    return res.status(201).json({
      ok: true,
      message: "Dispositivo enrolled com sucesso.",
      device_id: ins.insertId,
      device_token, // ⚠️ entregue apenas aqui
    });
  } catch (err) {
    console.error("[CAPTURE] erro no enroll:", err?.message || err);
    return res.status(500).json({ ok: false, message: "Erro ao enrolled dispositivo." });
  }
});

export default router;

