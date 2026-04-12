// routes/monitoramento_ingest.js
// ============================================================================
// Ingestão de eventos de reconhecimento facial vindos do Worker
// - POST /api/monitoramento/eventos
// - GET  /api/monitoramento/embeddings/cache  (para o Worker baixar o cache)
// ============================================================================

import express from "express";
import crypto from "node:crypto"
import fs from "fs";
import path from "path";
import { enviarNotificacoesEntradaAluno } from "../services/mobileNotificacoesService.js";

const router = express.Router();

// -------------------------------------------------------------
// Cache em memória para escola_dir (evita query ao DB a cada request)
// TTL de 5 minutos — escola.apelido raramente muda
// -------------------------------------------------------------
const _escolaDirCache = new Map(); // key: escola_id → { dir, ts }
const ESCOLA_DIR_CACHE_TTL = 5 * 60 * 1000; // 5 minutos

async function resolverEscolaDirCached(db, escola_id) {
  const cached = _escolaDirCache.get(escola_id);
  if (cached && (Date.now() - cached.ts) < ESCOLA_DIR_CACHE_TTL) {
    return cached.dir;
  }

  function slugDir(input) {
    return String(input || "")
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 60);
  }

  let dir = "";
  const conn = await db.getConnection();
  try {
    const [rows] = await conn.query(
      "SELECT apelido FROM escolas WHERE id = ? LIMIT 1",
      [escola_id]
    );
    dir = slugDir(rows?.[0]?.apelido || "");
  } finally {
    conn.release();
  }

  if (dir) {
    _escolaDirCache.set(escola_id, { dir, ts: Date.now() });
  }
  return dir;
}

// -------------------------------------------------------------
// Helpers
// -------------------------------------------------------------
function toNumber(n, def = 0) {
  const v = Number(n);
  return Number.isFinite(v) ? v : def;
}
function toJson(obj) {
  try { return JSON.stringify(obj); } catch (e) { return null; }
}

// -------------------------------------------------------------
// Políticas iniciais (PASSO 3.2.3.1)
// -------------------------------------------------------------
const MIN_CONFIDENCE = toNumber(process.env.MONITOR_MIN_CONFIDENCE, 0.85);
const DEFAULT_ZONA = String(process.env.MONITOR_DEFAULT_ZONA || "entrada_principal");

// Janela temporal de dedupe para presença (segundos)
// Dentro da janela: NÃO atualiza ultima_confirmacao (evita spam de confirmações por multi-câmera)
// PASSO 3.2.3.2 — Janela temporal (anti-duplicidade de escrita)
// Dentro desta janela, NÃO atualizamos ultima_confirmacao (reduz ruído e write-amplification)
const PRESENCA_JANELA_SEG = toNumber(process.env.MONITOR_PRESENCA_JANELA_SEG, 120);

// PASSO 5.1 — Dedupe multi-câmera (origem determinística)
// Janela curta para decidir a "câmera de origem" por prioridade (segundos).
// Ex.: se a câmera 2 chegar 2s antes, mas a câmera 1 chegar dentro desta janela,
// atualizamos camera_id_origem/horario/turno para manter regra determinística.
const PRESENCA_ORIGEM_JANELA_SEG = toNumber(process.env.MONITOR_PRESENCA_ORIGEM_JANELA_SEG, 15);

// Prioridade de câmeras (menor = mais prioritária). Default: 1,2,3
const CAMERA_PRIORIDADE = String(process.env.MONITOR_CAMERA_PRIORIDADE || "1,2,3")
  .split(",")
  .map(s => toNumber(s.trim(), 0))
  .filter(Boolean);

function cameraRank(cameraId) {
  const id = toNumber(cameraId, 0);
  const idx = CAMERA_PRIORIDADE.indexOf(id);
  return idx >= 0 ? idx : 999; // desconhecida = baixa prioridade
}

// Determina turno baseado no horário do EVENTO (não do "agora")
// matutino: 05:00–11:59 | vespertino: 12:00–17:59 | noturno: 18:00–04:59
function resolveTurno(dateObj) {
  const h = dateObj.getHours();
  if (h >= 5 && h < 12) return "matutino";
  if (h >= 12 && h < 18) return "vespertino";
  return "noturno";
}

// Requer token específico do Worker (além do JWT normal do admin)
function validarTokenWorker(req, res, next) {
  // Modos suportados:
  // - DEV (default): valida por MONITOR_WORKER_TOKEN via x-worker-token
  // - PROD (quando MONITOR_WORKER_SECRET existe): exige assinatura HMAC (x-worker-signature + x-worker-ts)
  //
  // Obs: Mantemos compatibilidade: em DEV continua aceitando x-worker-token.

  const nodeEnv = String(process.env.NODE_ENV || "").toLowerCase();
  const isProd = nodeEnv === "production";

  const tokenExpect = (process.env.MONITOR_WORKER_TOKEN || "").trim();
  const tokenGot = (req.header("x-worker-token") || "").trim();

  const secret = (process.env.MONITOR_WORKER_SECRET || "").trim();
  const sig = (req.header("x-worker-signature") || "").trim();
  const ts = (req.header("x-worker-ts") || "").trim();

  // Worker deve enviar x-escola-id (numérico) — já padronizamos depois no router.use,
  // mas aqui também ajudamos para validações que dependem de req.escola_id.
  const escolaIdHeader = toNumber(req.header("x-escola-id"), 0);
  if (escolaIdHeader) req.escola_id = escolaIdHeader;

  function safeEqualUtf8(aStr, bStr) {
    const a = Buffer.from(String(aStr || ""), "utf8");
    const b = Buffer.from(String(bStr || ""), "utf8");
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  function sha256Hex(input) {
    const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input ?? ""), "utf8");
    return crypto.createHash("sha256").update(buf).digest("hex");
  }

  function hmacHex(key, msg) {
    return crypto.createHmac("sha256", key).update(msg).digest("hex");
  }

  function safeEqualHex(aHex, bHex) {
    const a = Buffer.from(String(aHex || ""), "hex");
    const b = Buffer.from(String(bHex || ""), "hex");
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  // ---------------------------
  // 1) Se temos SECRET em PROD, exigimos assinatura
  // ---------------------------
  if (isProd && secret) {
    if (!ts || !sig) {
      return res.status(401).json({
        ok: false,
        message: "Assinatura do worker ausente (x-worker-ts / x-worker-signature)."
      });
    }

    const tsNum = Number(ts);
    if (!Number.isFinite(tsNum) || tsNum <= 0) {
      return res.status(401).json({
        ok: false,
        message: "x-worker-ts inválido."
      });
    }

    // anti-replay simples: tolerância 120s
    const now = Date.now();
    const deltaMs = Math.abs(now - tsNum);
    if (deltaMs > 120_000) {
      return res.status(401).json({
        ok: false,
        message: "Assinatura expirada (timestamp fora da janela)."
      });
    }

    // bodyHash: para GET normalmente será vazio; para POST dependerá do body já parseado
    let bodyForHash = "";
    try {
      bodyForHash = req.body == null ? "" : (Buffer.isBuffer(req.body) ? req.body : JSON.stringify(req.body));
    } catch (e) {
      bodyForHash = "";
    }

    const bodyHash = sha256Hex(bodyForHash);

    // Base string: ts.method.originalUrl.escolaId.bodyHash
    const base = `${ts}.${req.method}.${req.originalUrl}.${toNumber(req.escola_id, 0)}.${bodyHash}`;
    const expectSig = hmacHex(secret, base);

    if (!safeEqualHex(expectSig, sig)) {
      return res.status(401).json({
        ok: false,
        message: "Assinatura do worker inválida."
      });
    }

    return next();
  }

  // ---------------------------
  // 2) DEV fallback: token simples
  // ---------------------------
  if (!tokenExpect) {
    return res.status(500).json({
      ok: false,
      message: "Token do worker não configurado."
    });
  }

  if (!safeEqualUtf8(tokenExpect, tokenGot)) {
    return res.status(401).json({
      ok: false,
      message: "Token do worker inválido.",
      debug: {
        expectedPrefix: tokenExpect.slice(0, 4) + "...",
        expectedLen: tokenExpect.length,
        gotPrefix: tokenGot.slice(0, 4) + "...",
        gotLen: tokenGot.length,
        isProd,
        hasSecret: !!secret,
      }
    });
  }

  next();
}

// Middleware simples para expor req.db = pool
router.use(async (req, _res, next) => {
  try {
    // db.js exporta pool (mysql2/promise)
    const pool = (await import("../db.js")).default;
    req.db = pool;

    // ✅ Padroniza escola_id para rotas do ingest
    // Worker deve enviar x-escola-id (numérico)
    req.escola_id = toNumber(req.header("x-escola-id"), 0);

    next();
  } catch (e) {
    console.error("[monitoramento_ingest] falha ao carregar pool:", e);
    next(e);
  }
});

function exigirEscolaId(req, res, next) {
  const escola_id = toNumber(req.escola_id, 0);
  if (!escola_id) {
    return res.status(422).json({
      ok: false,
      message: "x-escola-id obrigatório"
    });
  }
  next();
}


// -------------------------------------------------------------
// GET /api/monitoramento/embeddings/cache
// (endpoint que o worker usa para sincronizar cache local)
// -------------------------------------------------------------
router.get("/embeddings/cache", validarTokenWorker, exigirEscolaId, async (req, res) => {
  try {
    const escola_id = toNumber(req.escola_id, 0);
    if (!escola_id) return res.status(422).json({ ok: false, message: "x-escola-id obrigatório" });

    const conn = await req.db.getConnection();
    try {
      const [rows] = await conn.query(
        `SELECT
           a.id           AS aluno_id,
           a.estudante    AS nome,
           a.codigo       AS codigo,
           t.nome         AS turma,
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
// DEBUG — valida se o router está sendo alcançado e se headers/env estão chegando
// GET /api/monitoramento/__token-debug
// -------------------------------------------------------------
router.get("/__token-debug", validarTokenWorker, (req, res) => {
  // Em produção, desabilita endpoint de debug
  if (String(process.env.NODE_ENV || "").toLowerCase() === "production") {
    return res.status(404).json({ ok: false, message: "Not found" });
  }

  const got = (req.header("x-worker-token") || "").trim();

  return res.json({
    ok: true,
    got_len: got.length
  });
});

// -------------------------------------------------------------
// POST /api/monitoramento/eventos
// -------------------------------------------------------------
router.post("/eventos", validarTokenWorker, exigirEscolaId, async (req, res) => {
  try {
    const escola_id = Number(req.headers["x-escola-id"]);
  const camera_id = Number(req.body?.camera_id);
  await assertCameraDaEscola(req, escola_id, camera_id);


  const aluno_id_in = req.body?.aluno_id ? toNumber(req.body.aluno_id) : null;

  // score só é válido quando vem aluno_id
  const rawScore = req.body?.score != null ? Number(req.body.score) : null;
  const score    = aluno_id_in ? rawScore : null;

  const bbox = req.body?.bbox || null;
  const now  = req.body?.ts ? new Date(req.body.ts) : new Date();

  if (!camera_id) {
    return res.status(422).json({ error: "camera_id obrigatório" });
  }

  const conn = await req.db.getConnection();
  try {

    // 🔒 PASSO 6.1 — valida se camera pertence à escola
    const [camRows] = await conn.query(
      `SELECT id
         FROM monitoramento_cameras
        WHERE id = ?
          AND escola_id = ?
          AND enabled = 1
        LIMIT 1`,
      [camera_id, escola_id]
    );

    if (!camRows.length) {
      return res.status(422).json({
        ok: false,
        message: "camera_id inválida para esta escola"
      });
    }

    // -------------------------------------------------------------
    // PASSO 3.2.3.1 — Políticas: confidence mínima + zona
    // -------------------------------------------------------------
    // Regra: só consideramos RECONHECIDO se aluno_id veio E score >= MIN_CONFIDENCE
    const reconhecido = !!(aluno_id_in && Number.isFinite(score) && score >= MIN_CONFIDENCE);

    // Se não bateu a confiança mínima, degradamos para DETECTADO (sem aluno_id)
    const aluno_id = reconhecido ? aluno_id_in : null;

    // status detectado/reconhecido (derivado da política acima)
    const status = reconhecido ? "RECONHECIDO" : "DETECTADO";

    // Zona: aceita do worker, senão cai no DEFAULT_ZONA
    const zonaRaw = String(req.body?.zona || "").trim();
    const zonaEvento = zonaRaw || DEFAULT_ZONA;

    // ✅ Fallback de nome (NOT NULL no evento)
    const nomeEventoRaw = String(req.body?.nome || "").trim();
    const nomeEvento =
      nomeEventoRaw || (reconhecido ? "Reconhecimento facial" : "Detecção facial");

    await conn.beginTransaction();

    // 1) Inserir evento
    const sqlEvento = `INSERT INTO monitoramento_eventos
       (escola_id, aluno_id, nome, status, camera_id, zona, timestamp_evento, confidence, bbox)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;

    const paramsEvento = [
      escola_id,
      aluno_id,
      nomeEvento,
      status,
      camera_id,
      zonaEvento,
      now,                      // timestamp_evento
      score,                    // confidence (NULL quando DETECTADO)
      bbox ? toJson(bbox) : null
    ];

    console.log("[eventos] INSERT monitoramento_eventos:", {
      sql: sqlEvento,
      params: paramsEvento
    });

    const [eventoRes] = await conn.query(sqlEvento, paramsEvento);
    const evento_id = eventoRes?.insertId || null;


    // 2) Se reconhecido, manter presenca do dia (com dedupe)
    let presencaInfo = null;

    if (aluno_id) {

      const dataDia = now.toISOString().slice(0, 10);     // "YYYY-MM-DD"
      const turno   = resolveTurno(now);

      // UPSERT presença diária
      // ✅ PASSO 3.2.1.3 — presencas_diarias.turma é NOT NULL (sem default)
      // Se o worker não enviar turma ainda, gravamos vazio (não quebra schema).
      const turmaRaw = String(req.body?.turma || "").trim();
      const turmaPresenca = turmaRaw || "";

      // Nome em presencas_diarias também é NOT NULL (sem default).
      // Enquanto o worker não manda o nome do aluno, usamos um fallback determinístico.
      const nomeAlunoRaw = String(req.body?.aluno_nome || req.body?.nome_aluno || "").trim();
      const nomeAluno = nomeAlunoRaw || `ALUNO#${aluno_id}`;

      // -------------------------------------------------------
      // PASSO 3.2.3.2.A — Janela temporal (dedupe por tempo)
      // Regra:
      // - Se JÁ EXISTE presença do dia e o evento (ts) está DENTRO da janela:
      //     NÃO atualiza ultima_confirmacao (nem mexe no registro)
      // - Se está FORA da janela:
      //     atualiza ultima_confirmacao usando o ts do evento
      // -------------------------------------------------------


      // -------------------------------------------------------
      // PASSO 3.2.3.3 — Política final de agregação (presença única por dia)
      //
      // CHAVE ÚNICA (fato do schema):
      //   uq_escola_aluno_data (escola_id, aluno_id, data)
      //
      // Regras:
      // - Cria presença apenas em RECONHECIDO (já estamos dentro de if(aluno_id))
      // - "Trava" campos do 1º registro do dia: horario/turno/camera_id_origem/zona
      // - Dentro da janela: NÃO faz UPDATE (evita write-amplification e evita carimbar ultima_confirmacao)
      // - Fora da janela: atualiza ultima_confirmacao + confidence (melhor score do dia)
      // - Concorrência: trata ER_DUP_ENTRY no INSERT (3 câmeras simultâneas)
      // -------------------------------------------------------

async function selectPresencaEstado() {
  const [rows] = await conn.query(
    `SELECT ultima_confirmacao, horario, turno, camera_id_origem, zona
       FROM presencas_diarias
      WHERE escola_id = ?
        AND aluno_id  = ?
        AND data      = ?
      LIMIT 1`,
    [escola_id, aluno_id, dataDia]
  );
  return rows;
}


      const eventoTs = now; // já parseado do body.ts (Date)
      let presRows = await selectPresencaEstado();

      // Controle de resposta (PASSO 3.3)
      let presencaAcao = null;     // "CRIADA" | "ATUALIZADA" | "IGNORADA"
      let presencaMotivo = null;   // "primeira_do_dia" | "dentro_da_janela" | "fora_da_janela" | "concorrencia_dup"
      let diffSegResp = null;

      if (presRows.length === 0) {
        try {
          // Primeira presença do dia => INSERT (campos travados aqui)
          await conn.query(
            `INSERT INTO presencas_diarias
               (escola_id, aluno_id, nome, turma, data, horario, camera_id_origem, turno, metodo, zona, confidence, ultima_confirmacao)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'face', ?, ?, ?)`,
            [
              escola_id,
              aluno_id,
              nomeAluno,
              turmaPresenca,
              dataDia,
              eventoTs.toTimeString().slice(0, 8), // HH:mm:ss
              camera_id,
              turno,
              zonaEvento,
              score,
              eventoTs
            ]
          );

          presencaAcao = "CRIADA";
          presencaMotivo = "primeira_do_dia";

          // Inseriu com sucesso: não precisa atualizar nada agora
          presRows = [{ ultima_confirmacao: eventoTs }]; // mantém coerência local
        } catch (err) {
          // Concorrência: se outra requisição inseriu primeiro, seguimos como "já existe"
          const isDup =
            err?.code === "ER_DUP_ENTRY" ||
            err?.errno === 1062 ||
            String(err?.message || "").toLowerCase().includes("duplicate");

          if (!isDup) throw err;

          presencaMotivo = "concorrencia_dup";

          // Re-lê para aplicar política de janela corretamente
          presRows = await selectPresencaEstado();
        }
      }

      // Se chegou aqui, já existe presença do dia (ou foi criada acima)
      if (presRows.length > 0) {






const pres = presRows[0] || {};
const ultima = pres?.ultima_confirmacao ? new Date(pres.ultima_confirmacao) : null;

// Se por algum motivo vier inválida, trata como "fora da janela"
const diffSeg = ultima
  ? Math.abs((eventoTs.getTime() - ultima.getTime()) / 1000)
  : (PRESENCA_JANELA_SEG + 1);

diffSegResp = diffSeg;


// PASSO 5.3 — Dentro da janela: PRESERVA origem oficial (1ª câmera/horário/turno/zona)
// Regra: dentro da janela, apenas "refresh" de presença -> atualiza ultima_confirmacao (+ melhora confidence)
// sem alterar camera_id_origem/horario/turno/zona.
if (diffSeg < PRESENCA_JANELA_SEG) {
  await conn.query(
    `UPDATE presencas_diarias
        SET ultima_confirmacao = ?,
            confidence = GREATEST(IFNULL(confidence, 0), IFNULL(?, 0)),
            nome  = IF(nome IS NULL OR nome = '', ?, nome),
            turma = IF(turma IS NULL OR turma = '', ?, turma)
      WHERE escola_id = ?
        AND aluno_id  = ?
        AND data      = ?`,
    [
      eventoTs,
      score,
      nomeAluno,
      turmaPresenca,
      escola_id,
      aluno_id,
      dataDia
    ]
  );

  if (!presencaAcao) presencaAcao = "ATUALIZADA";
  if (!presencaMotivo) presencaMotivo = "dentro_da_janela_refresh";
} else {


  // Fora da janela => atualiza somente o que NÃO quebra o "travamento" do 1º registro
  await conn.query(
    `UPDATE presencas_diarias
        SET ultima_confirmacao = ?,
            nome       = IF(nome IS NULL OR nome = '', ?, nome),
            turma      = IF(turma IS NULL OR turma = '', ?, turma),
            confidence = GREATEST(IFNULL(confidence, 0), IFNULL(?, 0))
      WHERE escola_id = ?
        AND aluno_id  = ?
        AND data      = ?`,
    [
      eventoTs,
      nomeAluno,
      turmaPresenca,
      score,
      escola_id,
      aluno_id,
      dataDia
    ]
  );

  if (!presencaAcao) presencaAcao = "ATUALIZADA";
  if (!presencaMotivo) presencaMotivo = "fora_da_janela";
}
      presencaInfo = {
        acao: presencaAcao,
        motivo: presencaMotivo,
        data: dataDia,
        diff_seg: diffSegResp,
        janela_seg: PRESENCA_JANELA_SEG
      };

      // Observação:
      // Se quiser "travar" a primeira câmera/horário (não sobrescrever),
      // troque pelo padrão:
      //   UPDATE ... SET ultima_confirmacao = NOW()
      //   WHERE horario IS NOT NULL AND camera_id_origem IS NOT NULL;
    } // <-- fecha if (presRows.length > 0)
  }   // <-- fecha if (aluno_id)

    await conn.commit();

    // Dispara a notificação mobile (apenas na 1ª vez do dia)
    if (presencaInfo?.acao === "CRIADA" && presencaInfo?.motivo === "primeira_do_dia") {
      enviarNotificacoesEntradaAluno({
        escolaId: escola_id,
        alunoId: aluno_id,
        cameraId: camera_id,
        horario: now
      }).catch(err => console.error("[eventos] Falha ao disparar notificacao de entrada:", err));
    }

    return res.status(200).json({
      ok: true,
      escola_id,
      camera_id,
      status,
      evento_id,
      aluno_id,
      ts: now instanceof Date ? now.toISOString() : String(req.body?.ts || ""),
      zona: zonaEvento,
      score,
      presenca: presencaInfo
    });

  } catch (err) {
    await conn.rollback();
    console.error("[eventos] erro:", err);
    return res.status(500).json({ ok: false, message: "Erro interno ao processar evento" });
  } finally {
    conn.release();
  }

  } catch (err) {
    console.error("[eventos] erro (outer):", err);
    return res.status(500).json({ ok: false, message: "Erro interno ao processar evento" });
  }
});



// -------------------------------------------------------------
// POST /api/monitoramento/frame
// Worker envia o frame JPEG (ETAPA 3.1) e o backend salva frame.jpg
// em: uploads/<escola_dir>/monitoramento/camera-0X/frame.jpg
//
// Body esperado:
// {
//   "escola_dir": "CEF04_PLAN",                  // opcional (pode resolver por x-escola-id)
//   "camera_id": 1,                              // obrigatório
//   "ts": "2026-01-21T20:42:39.366Z",            // opcional
//   "jpeg_base64": "data:image/jpeg;base64,...." // obrigatório
// }
//
// Regras:
// - escrita atômica: frame.<ts>.<rand>.tmp.jpg -> rename para frame.jpg
// - limite ~8MB do JPEG (após decode)
// - falhas retornam 4xx/5xx, sem quebrar o servidor
// -------------------------------------------------------------
function parseDataUrlImage(dataUrl) {
  const m = String(dataUrl || "").match(
    /^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/
  );
  if (!m) return null;
  return { mime: m[1].toLowerCase(), b64: m[2] };
}

router.post("/frame", validarTokenWorker, exigirEscolaId, async (req, res) => {
  try {
    const escola_id = toNumber(req.escola_id, 0);

    const nodeEnv = String(process.env.NODE_ENV || "").toLowerCase();
    const isProd = nodeEnv === "production";

    function slugDir(input) {
      return String(input || "")
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // remove acentos
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 60);
    }

    // ✅ PASSO 6.2.1 — Resolve escola_dir via DB (escolas.apelido).
    // Fallback: aceita header x-escola-dir quando o apelido não está no banco
    // (útil quando o campo apelido é NULL em produção).
    let escola_dir = "";

    if (escola_id) {
      try {
        const conn = await req.db.getConnection();
        try {
          const [rows] = await conn.query(
            "SELECT apelido FROM escolas WHERE id = ? LIMIT 1",
            [escola_id]
          );
          escola_dir = slugDir(rows?.[0]?.apelido || "");
        } finally {
          conn.release();
        }
      } catch (_) {
        // segue; validação abaixo decide se pode prosseguir
      }
    }

    // Fallback via header x-escola-dir (enviado pelo worker quando apelido está vazio no DB)
    if (!escola_dir) {
      const dirHeader = (req.header("x-escola-dir") || "").trim();
      if (dirHeader) {
        escola_dir = slugDir(dirHeader);
        console.warn(`[ingest/frame] escola_dir resolvido via header fallback: ${escola_dir} (escola_id=${escola_id})`);
      }
    }

    const camera_id = toNumber(req.body?.camera_id, 0);
    const ts = req.body?.ts ? String(req.body.ts) : new Date().toISOString();

    if (!escola_dir) {
      return res.status(422).json({
        ok: false,
        message: "escola_dir obrigatório (ou envie x-escola-id válido para resolução automática).",
        debug: { escola_id }
      });
    }
    if (!camera_id) {
      return res.status(422).json({ ok: false, message: "camera_id obrigatório" });
    }

    // 🔒 PASSO 6.1 — valida se camera pertence à escola (evita vazamento multi-escola)
    try {
      const connCam = await req.db.getConnection();
      try {
        const [camRows] = await connCam.query(
          `SELECT id
             FROM monitoramento_cameras
            WHERE id = ?
              AND escola_id = ?
              AND enabled = 1
            LIMIT 1`,
          [camera_id, escola_id]
        );

        if (!camRows.length) {
          return res.status(422).json({
            ok: false,
            message: "camera_id inválida para esta escola"
          });
        }
      } finally {
        connCam.release();
      }
    } catch (e) {
      console.error("[ingest/frame] AggregateError validar camera_id:", {
        name: e?.name,
        message: e?.message,
        code: e?.code,
        errno: e?.errno,
        sqlState: e?.sqlState,
        errors: e?.errors?.map(x => ({ msg: x?.message, code: x?.code, errno: x?.errno })),
        dbPoolReady: !!req.db,
      });
      return res.status(500).json({
        ok: false,
        message: "Falha ao validar camera_id",
        error: String(e?.message || e),
        detail: {
          name: e?.name,
          code: e?.code,
          errno: e?.errno,
          errors: e?.errors?.map(x => x?.message)?.slice(0, 3),
        }
      });
    }

    const parsed = parseDataUrlImage(req.body?.jpeg_base64);
    if (!parsed) {
      return res.status(422).json({
        ok: false,
        message: "jpeg_base64 inválido. Esperado data:image/jpeg;base64,..."
      });
    }

    const allowed = new Set(["image/jpeg", "image/jpg"]);
    if (!allowed.has(parsed.mime)) {
      return res.status(415).json({
        ok: false,
        message: `Formato não suportado (${parsed.mime}). Use image/jpeg.`
      });
    }

    const jpegBuf = Buffer.from(parsed.b64, "base64");

    const MAX_BYTES = 8 * 1024 * 1024; // ~8MB
    if (!jpegBuf.length || jpegBuf.length > MAX_BYTES) {
      return res.status(413).json({
        ok: false,
        message: `JPEG excede o limite (~8MB). Tamanho: ${jpegBuf.length} bytes.`
      });
    }

    // Caminho destino (mesmo padrão do overlay)
    const camDir = `camera-${String(camera_id).padStart(2, "0")}`;
    const basePath = path.join(
      process.cwd(),
      "uploads",
      escola_dir,
      "monitoramento",
      camDir
    );

    fs.mkdirSync(basePath, { recursive: true });

    const finalPath = path.join(basePath, "frame.jpg");

    // tmp único para evitar colisão
    const tmpName = `frame.${Date.now()}.${crypto.randomBytes(4).toString("hex")}.tmp.jpg`;
    const tmpPath = path.join(basePath, tmpName);

    // limpa tmps antigos (2 min)
    try {
      const nowMs = Date.now();
      const ttlMs = 2 * 60 * 1000;

      const files = fs.readdirSync(basePath);
      for (const f of files) {
        if (!/^frame\..+\.tmp\.jpg$/i.test(f)) continue;
        const p = path.join(basePath, f);
        const st = fs.statSync(p);
        if (!st?.isFile?.()) continue;
        if ((nowMs - st.mtimeMs) > ttlMs) fs.unlinkSync(p);
      }
    } catch (_) {}

    fs.writeFileSync(tmpPath, jpegBuf);
    fs.renameSync(tmpPath, finalPath);

    return res.json({
      ok: true,
      escola_dir,
      camera_id,
      bytes: jpegBuf.length,
      path: finalPath,
      ts,
    });
  } catch (err) {
    console.error("[ingest/frame] erro:", err);
    return res.status(500).json({
      ok: false,
      message: "Falha ao processar frame",
      error: err?.message,
    });
  }
});


// -------------------------------------------------------------
// POST /api/monitoramento/frame-binary?camera_id=1
// Worker/Postman envia o JPEG no corpo RAW (sem base64/clipboard)
// Salva em: uploads/<escola_dir>/monitoramento/camera-0X/frame.jpg
//
// Headers obrigatórios:
// - x-worker-token
// - x-escola-id
// -------------------------------------------------------------
async function resolverEscolaDirPorId(req, escola_id) {
  const conn = await req.db.getConnection();
  try {
    const [rows] = await conn.query(
      "SELECT apelido FROM escolas WHERE id = ? LIMIT 1",
      [escola_id]
    );
    const dir = String(rows?.[0]?.apelido || "").trim();
    return dir || null;
  } finally {
    conn.release();
  }
}

async function assertCameraDaEscola(req, escola_id, camera_id) {
  const camId = Number(camera_id);

  if (!Number.isFinite(camId) || camId <= 0) {
    const err = new Error("camera_id inválido");
    err.status = 422;
    err.code = "CAMERA_ID_INVALID";
    throw err;
  }

  const conn = await req.db.getConnection();
  try {
    const [rows] = await conn.query(
      `
      SELECT id, escola_id, enabled
      FROM monitoramento_cameras
      WHERE id = ? AND escola_id = ?
      LIMIT 1
      `,
      [camId, escola_id]
    );

    if (!rows || rows.length === 0) {
      const err = new Error("camera_id inválida para esta escola");
      err.status = 422;
      err.code = "CAMERA_NOT_BELONGS_TO_SCHOOL";
      throw err;
    }

    if (Number(rows[0].enabled) !== 1) {
      const err = new Error("câmera desativada");
      err.status = 422;
      err.code = "CAMERA_DISABLED";
      throw err;
    }

    return rows[0];
  } finally {
    conn.release();
  }
}

router.post(
  "/frame-binary",
  express.raw({
    type: ["image/jpeg", "image/jpg", "application/octet-stream"],
    limit: "8mb"
  }),
  validarTokenWorker,
  exigirEscolaId,
  async (req, res) => {
    try {
      const escola_id = toNumber(req.escola_id, 0);
      if (!escola_id) {
        return res.status(422).json({ ok: false, message: "x-escola-id obrigatório" });
      }

      const camera_id = toNumber(req.query?.camera_id, 0);
      if (!camera_id) {
        return res.status(422).json({ ok: false, message: "camera_id obrigatório (query param)" });
      }

      // 🔒 PASSO 6.1 — valida se camera pertence à escola (evita vazamento multi-escola)
      {
        const connCam = await req.db.getConnection();
        try {
          const [camRows] = await connCam.query(
            `SELECT id
               FROM monitoramento_cameras
              WHERE id = ?
                AND escola_id = ?
                AND enabled = 1
              LIMIT 1`,
            [camera_id, escola_id]
          );

          if (!camRows.length) {
            return res.status(422).json({
              ok: false,
              message: "camera_id inválida para esta escola"
            });
          }
        } finally {
          connCam.release();
        }
      }

      const escola_dir = await resolverEscolaDirPorId(req, escola_id);
      if (!escola_dir) {
        return res.status(422).json({
          ok: false,
          message: "Não foi possível resolver escolas.apelido pelo x-escola-id",
          debug: { escola_id }
        });
      }

      const jpegBuf = Buffer.isBuffer(req.body) ? req.body : Buffer.from([]);
      if (!jpegBuf.length) {
        return res.status(422).json({
          ok: false,
          message: "Body RAW vazio. Envie um JPEG em Body -> binary."
        });
      }

      // Caminho destino (mesmo padrão do overlay)
      const camDir = `camera-${String(camera_id).padStart(2, "0")}`;
      const basePath = path.join(
        process.cwd(),
        "uploads",
        escola_dir,
        "monitoramento",
        camDir
      );

      fs.mkdirSync(basePath, { recursive: true });

      const finalPath = path.join(basePath, "frame.jpg");
      const tmpName = `frame.${Date.now()}.${crypto.randomBytes(4).toString("hex")}.tmp.jpg`;
      const tmpPath = path.join(basePath, tmpName);

      fs.writeFileSync(tmpPath, jpegBuf);
      fs.renameSync(tmpPath, finalPath);

      return res.json({
        ok: true,
        escola_id,
        escola_dir,
        camera_id,
        bytes: jpegBuf.length,
        path: finalPath
      });
    } catch (err) {
      console.error("[ingest/frame-binary] erro:", err);
      return res.status(500).json({
        ok: false,
        message: "Falha ao processar frame-binary",
        error: err?.message
      });
    }
  }
);


// -------------------------------------------------------------
// POST /api/monitoramento/faces
// Worker envia as detecções da câmera (somente DETECÇÃO - ETAPA 4)
// Escreve faces.json de forma atômica em:
// uploads/<escola_dir>/monitoramento/camera-0X/faces.json
//
// Body esperado:
// {
//   "escola_dir": "CEF04_PLAN",
//   "camera_id": 1,
//   "ts": "2026-01-21T20:42:39.366Z",       // opcional
//   "width": 1920,                         // opcional (fallback via frame.jpg já existe no overlay)
//   "height": 1080,                        // opcional
//   "faces": [
//     { "bbox": { "x": 10, "y": 20, "width": 100, "height": 120 } }
//   ]
// }
//
// Regras:
// - recognized sempre false nesta etapa
// - name = "DESCONHECIDO"
// - score = 0
// - escrita atômica: faces.json.tmp -> rename para faces.json
// -------------------------------------------------------------
router.post("/faces", validarTokenWorker, exigirEscolaId, async (req, res) => {
  try {
    const escola_id = toNumber(req.escola_id, 0);

    // ✅ Usa cache em memória para resolução rápida (evita query DB a cada frame)
    let escola_dir = "";

    if (escola_id) {
      try {
        escola_dir = await resolverEscolaDirCached(req.db, escola_id);
      } catch (_) {
        // continua; validação abaixo decide se pode prosseguir
      }
    }


    const camera_id = toNumber(req.body?.camera_id, 0);
    const ts = req.body?.ts ? String(req.body.ts) : new Date().toISOString();

    if (!escola_dir) {
      return res.status(422).json({
        ok: false,
        message: "escola_dir obrigatório (ou envie x-escola-id válido para resolução automática).",
        debug: { escola_id }
      });
    }
    if (!camera_id) {
      return res.status(422).json({ ok: false, message: "camera_id obrigatório" });
    }


    const facesIn = Array.isArray(req.body?.faces) ? req.body.faces : [];

    // Sanitização mínima: garantir bbox numérico e positivo
    const faces = facesIn
      .map((f) => {
        const bbox = f?.bbox || {};
        const x = toNumber(bbox.x ?? bbox.left, 0);
        const y = toNumber(bbox.y ?? bbox.top, 0);
        const width = toNumber(bbox.width, 0);
        const height = toNumber(bbox.height, 0);

        if (width <= 0 || height <= 0) return null;

        return {
          bbox: { x, y, width, height },
          recognized: false,
          name: "DESCONHECIDO",
          score: 0,
        };
      })
      .filter(Boolean);

    const out = {
      ts,
      width: toNumber(req.body?.width, 0),
      height: toNumber(req.body?.height, 0),
      faces,
    };

    // Caminho destino (mesmo padrão do overlay)
    const camDir = `camera-${String(camera_id).padStart(2, "0")}`;

    const basePath = path.join(
      process.cwd(),
      "uploads",
      escola_dir,
      "monitoramento",
      camDir
    );

    // Garante diretório
    fs.mkdirSync(basePath, { recursive: true });

    const facesPath = path.join(basePath, "faces.json");

    // ✅ PASSO 4.2.2: tmp único para evitar colisão em escrita concorrente
    const tmpName = `faces.${Date.now()}.${crypto.randomBytes(4).toString("hex")}.tmp.json`;
    const tmpPath = path.join(basePath, tmpName);

    // ✅ PASSO 4.2.2 (opcional): limpa tmp antigos (ex.: crash entre write e rename)
    try {
      const nowMs = Date.now();
      const ttlMs = 2 * 60 * 1000; // 2 minutos

      const files = fs.readdirSync(basePath);
      for (const f of files) {
        if (!/^faces\..+\.tmp\.json$/i.test(f)) continue;

        const p = path.join(basePath, f);
        const st = fs.statSync(p);
        if (!st?.isFile?.()) continue;

        if ((nowMs - st.mtimeMs) > ttlMs) {
          fs.unlinkSync(p);
        }
      }
    } catch (_) {
      // silêncio: limpeza nunca pode quebrar o ingest
    }








    // ✅ Diagnóstico mínimo (não altera comportamento)
    if (facesIn.length === 0) {
      console.warn("[ingest/faces] faces[] vazio", { escola_dir, camera_id, escola_id });
    }

    const discarded = facesIn.length - faces.length;
    if (discarded > 0) {
      console.warn("[ingest/faces] bboxes descartados", { escola_dir, camera_id, discarded, total_in: facesIn.length });
    }

    const wIn = toNumber(req.body?.width, 0);
    const hIn = toNumber(req.body?.height, 0);
    if (!wIn || !hIn) {
      console.warn("[ingest/faces] width/height ausentes (ok; overlay pode inferir do frame)", { escola_dir, camera_id });
    }

    // ✅ DEBUG (opt-in) — grava o payload bruto recebido do worker + resumo de bbox
    // Ativar com: MONITORAMENTO_DEBUG_FACES=1
    const debugFaces = String(process.env.MONITORAMENTO_DEBUG_FACES || "") === "1";
    if (debugFaces) {
      try {
        const coords = faces.map((f) => f.bbox).filter(Boolean);

        const summary = coords.length
          ? {
              count: coords.length,
              minX: Math.min(...coords.map((b) => b.x)),
              minY: Math.min(...coords.map((b) => b.y)),
              maxX: Math.max(...coords.map((b) => b.x + b.width)),
              maxY: Math.max(...coords.map((b) => b.y + b.height)),
              minW: Math.min(...coords.map((b) => b.width)),
              minH: Math.min(...coords.map((b) => b.height)),
              maxW: Math.max(...coords.map((b) => b.width)),
              maxH: Math.max(...coords.map((b) => b.height)),
            }
          : { count: 0 };

        const debugOut = {
          ts,
          escola_id,
          escola_dir,
          camera_id,
          width: toNumber(req.body?.width, 0),
          height: toNumber(req.body?.height, 0),
          summary,
          faces_raw_in: facesIn, // exatamente como o worker mandou
          faces_sanitized: faces, // após sanitização do ingest
        };

        const debugPath = path.join(basePath, "faces.last_payload.json");
        const debugTmp = path.join(
          basePath,
          `faces.last_payload.${Date.now()}.${crypto.randomBytes(4).toString("hex")}.tmp.json`
        );

        fs.writeFileSync(debugTmp, JSON.stringify(debugOut, null, 2), { encoding: "utf-8" });
        fs.renameSync(debugTmp, debugPath);
      } catch (e) {
        console.warn("[ingest/faces][debug] falhou ao gravar faces.last_payload.json", e?.message);
      }
    }

    // Escrita atômica: escreve tmp e renomeia
    fs.writeFileSync(tmpPath, JSON.stringify(out), { encoding: "utf-8" });
    fs.renameSync(tmpPath, facesPath);

    return res.json({
      ok: true,
      escola_dir,
      camera_id,
      total_faces: faces.length,
      path: facesPath,
      ts,
    });
  } catch (err) {
    console.error("[ingest/faces] erro:", err?.message || err);
    return res.status(500).json({
      ok: false,
      error: "INGEST_FACES_FAILED",
      message: err?.message || "Falha no ingest de faces",
    });
  }
});

export default router;


