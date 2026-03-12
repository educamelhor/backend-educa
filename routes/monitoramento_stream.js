// routes/monitoramento_stream.js
// ============================================================================
// Monitoramento — Snapshot JPG e Stream MJPEG
// - GET /api/monitoramento/stream/ping
// - GET /api/monitoramento/stream/:id.jpg?quality=1..4&transport=tcp|udp&timeout=7000&fallback=1
// - GET /api/monitoramento/stream/:id.mjpeg?fps=8&quality=7&transport=tcp
// Regras:
//   • Autenticação: JWT (Authorization: Bearer ...). Também aceita ?token= para testes.
//   • Escola: usa req.user.escola_id (do token) OU header x-escola-id OU ?escola_id.
//   • Busca câmera em monitoramento_cameras (id, escola_id, enabled, rtsp_url).
//   • Se ffmpeg falhar, tenta fallback local em /uploads/<APELIDO>/monitoramento/camera{id}.jpg
//      (ou legado /uploads/monitoramento/camera{id}.jpg). Se existir, retorna 200 OK.
//   • Não depende de middlewares globais de outros módulos (modelo defensivo como alunos.js).
// ============================================================================

import { Router } from "express";
import { spawn } from "child_process";
import ffmpegPath from "ffmpeg-static";
import path from "path";

function getFfmpegBinOrThrow(){
  if (!ffmpegPath) {
    throw new Error("ffmpeg-static não forneceu o caminho do binário. Verifique a instalação/ambiente.");
  }
  return ffmpegPath;
}
import fs from "fs";
import { fileURLToPath } from "url";
import jwt from "jsonwebtoken";
import pool from "../db.js";
import { autenticarToken } from "../middleware/autenticarToken.js";
import { autorizarPermissao } from "../middleware/autorizarPermissao.js";
//import { aplicarOverlayFrame } from "./monitoramento_overlay.js";

const router = Router();

// ============================================================================
// Stream: permitir token via query (?token=...) para TODAS as rotas
// Necessário para MJPEG / <img src="..."> e snapshots
// ============================================================================
router.use(injectTokenFromQuery);


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --------------------------- helpers básicos -------------------------------
function log(...a){ try{ console.log("[stream]",...a);}catch{} }
function warn(...a){ try{ console.warn("[stream]",...a);}catch{} }
function error(...a){ try{ console.error("[stream]",...a);}catch{} }

function getFfmpegBin(){
  if (typeof ffmpegPath === "string" && ffmpegPath.trim()) return ffmpegPath;

  // zero gambiarras: se o ffmpeg-static não fornecer caminho válido, falhar explicitamente
  throw new Error("ffmpeg-static não retornou um caminho válido para o binário do ffmpeg.");
}

// injeta Authorization a partir de ?token=
function injectTokenFromQuery(req, _res, next) {
  let tk = req.query?.token;

  // aceita token com ou sem aspas (caso o usuário cole com "..." ou '...')
  if (typeof tk === "string") {
    tk = tk.trim();
    if (
      (tk.startsWith('"') && tk.endsWith('"')) ||
      (tk.startsWith("'") && tk.endsWith("'"))
    ) {
      tk = tk.slice(1, -1).trim();
    }
  }

  if (tk && !req.headers.authorization) {
    req.headers.authorization = `Bearer ${tk}`;
  }

  next();
}

// resolve escola_id (header/query/token) — não depende de middleware global
function resolveEscolaId(req){
  const cand = [req.headers["x-escola-id"], req.query?.escola_id, req.user?.escola_id];
  for(const v of cand){ const n = Number(v); if(Number.isFinite(n)&&n>0) return n; }
  return null;
}

// base de uploads (compatível com monorepo)
function resolveUploadsBaseDir(){
  const projectRoot = path.resolve(process.cwd());                   // apps/educa-backend
  const env = (process.env.UPLOADS_DIR||"").trim();
  if (env){
    if (path.isAbsolute(env)) return env;
    return path.resolve(projectRoot, env);
  }
  return path.resolve(projectRoot, "uploads");
}
const UPLOADS_BASE = resolveUploadsBaseDir();

async function getEscolaApelidoById(escolaId){
  try{
    const [rows]=await pool.query("SELECT apelido FROM escolas WHERE id=? LIMIT 1",[escolaId]);
    return rows?.[0]?.apelido||null;
  }catch(e){ warn("apelido escola:", e?.message||e); return null; }
}
function mapQualityToQscale(q){
  const n=Number(q); if(n<=1) return 2; if(n===2) return 5; if(n===3) return 10; return 20;
}

// Normaliza RTSP para evitar quebra por caracteres especiais em userinfo (ex.: senha com #)
// - Se já estiver URL-encoded, não atrapalha
function normalizeRtspUrl(raw){
  const s = String(raw || "").trim();
  if (!s) return s;

  // só mexe na parte "userinfo" (antes do @), se existir
  const at = s.indexOf("@");
  if (at === -1) return s;

  const head = s.slice(0, at);   // rtsp://user:pass
  const tail = s.slice(at);      // @ip:port/...

  // substitui apenas os caracteres mais críticos (mínimo necessário)
  // (#) precisa virar %23
  const safeHead = head.replaceAll("#", "%23");

  return safeHead + tail;
}

function enviarFallbackLocal(res, localPath){
  try{
    if(localPath && fs.existsSync(localPath)){
      res.setHeader("Content-Type","image/jpeg");
      res.setHeader("X-Fallback","1");
      fs.createReadStream(localPath).pipe(res);
      return true;
    }
  }catch{}
  return false;
}

async function resolverFrameLocal(escolaId, camId) {
  try {
    // resolver pasta da escola (exatamente como no disco)
    const escolaDir = path.join(
      process.cwd(),
      "uploads",
      "CEF04_PLAN",
      "monitoramento"
    );

    // padrões reais que você mostrou no print
    const candidatos = [
      `camera_${camId}.jpg`,
      `camera_${camId}.jpeg`,
      `camera${camId}.jpg`,
      `camera${camId}.jpeg`,
    ];

    for (const nome of candidatos) {
      const full = path.join(escolaDir, nome);
      if (fs.existsSync(full)) {
        return full;
      }
    }

    return null;
  } catch {
    return null;
  }
}

async function obterRTSP({id, escola_id}){
  const [rows]=await pool.query(
    `SELECT id, escola_id, enabled, rtsp_url
       FROM monitoramento_cameras
      WHERE id=? AND escola_id=? LIMIT 1`, [id, escola_id]
  );
  return rows?.[0]||null;
}

// ------------------------------- /ping -------------------------------------
router.get(
  "/ping",
  injectTokenFromQuery,
  autenticarToken,
  autorizarPermissao("monitoramento.visualizar"),
  (_req, res) => {
    res.json({
      ok: true,
      scope: "stream",
      ffmpeg: getFfmpegBin(),
      ts: new Date().toISOString(),
    });
  }
);

// ============================================================================
// PASSO 4.1.1 — Token curto para stream MJPEG (uso em <img src="...">)
// GET /api/monitoramento/stream/token?ttl=90
// ============================================================================
router.get(
  "/stream/token",
  autenticarToken,
  autorizarPermissao("monitoramento.visualizar"),
  (req, res) => {
    try {
      const escola_id = req.escola_id || req.user?.escola_id;
      const usuario_id = req.user?.usuario_id || req.user?.id;

      if (!escola_id || !usuario_id) {
        return res.status(400).json({
          ok: false,
          message: "Contexto de escola/usuário inválido.",
        });
      }

      // TTL do token de stream (segundos)
      // padrão: 8h | mínimo: 30s | máximo: 8h
      const ttlDefault = Number(process.env.MONITORAMENTO_STREAM_TTL_SECONDS || 28800);
      const ttlMax = 28800;
      const ttl = Math.max(30, Math.min(ttlMax, Number(req.query.ttl || ttlDefault)));


      const payload = {
        scope: "stream",
        escola_id,
        usuario_id,
      };

      const token = jwt.sign(payload, getJwtSecret(), { expiresIn: ttl });

      return res.json({
        ok: true,
        escola_id,
        ttl_seg: ttl,
        stream_token: token,
      });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        message: "Falha ao gerar stream_token.",
        dev: String(err?.message || err),
      });
    }
  }
);


// ============================================================================
// PASSO 4.1.1 — Stream Token curto (para MJPEG via <img src="...">)
// GET /api/monitoramento/stream/token?ttl=90
// - Exige JWT normal (Authorization Bearer)
// - Retorna um JWT curto (scope="stream") para usar em ?token= no .mjpeg
// ============================================================================

function getJwtSecret() {
  const s = (process.env.JWT_SECRET || "").trim();
  if (!s) throw new Error("JWT_SECRET ausente no ambiente.");
  return s;
}

router.get(
  "/token",
  autenticarToken,
  autorizarPermissao("monitoramento.visualizar"),
  (req, res) => {
    try {
      const escola_id = resolveEscolaId(req);
      const usuario_id = Number(req.user?.usuario_id ?? req.user?.usuarioId ?? req.user?.id ?? 0);

      if (!escola_id || !usuario_id) {
        return res.status(400).json({ ok: false, message: "Contexto inválido (escola/usuario)." });
      }

      // TTL do token de stream (segundos)
      // padrão: 8h | mínimo: 30s | máximo: 8h
      const ttlDefault = Number(process.env.MONITORAMENTO_STREAM_TTL_SECONDS || 28800);
      const ttlMax = 28800;
      const ttl = Math.max(30, Math.min(ttlMax, Number(req.query.ttl || ttlDefault)));


      const payload = {
        scope: "stream",
        usuario_id,
        escola_id,
        iat: Math.floor(Date.now() / 1000),
      };

      const token = jwt.sign(payload, getJwtSecret(), { expiresIn: ttl });

      return res.json({
        ok: true,
        escola_id,
        ttl_seg: ttl,
        stream_token: token,
      });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        message: "Falha ao gerar stream_token.",
        dev: String(err?.message || err),
      });
    }
  }
);

// --------------------------- snapshot .jpg ---------------------------------
router.get(
  "/:id.jpg",
  injectTokenFromQuery,
  autenticarToken,
  autorizarPermissao("monitoramento.visualizar"),
  async (req,res)=>{
    const camId = Number(req.params.id||0);
    const escolaId = resolveEscolaId(req);
    if(!camId || !escolaId) return res.status(400).json({ message:"Parâmetros inválidos." });

    const transport = (String(req.query.transport||"tcp").toLowerCase()==="udp")?"udp":"tcp";
    const qscale = mapQualityToQscale(req.query.quality);
    const timeoutMs = Math.max(1000, Math.min(15000, Number(req.query.timeout||7000)));
    const allowFallback = String(req.query.fallback||"1")==="1"; // padrão: permite fallback
    const forceFallback = String(req.query.force_fallback||"0")==="1"; // NOVO
    const withOverlay = String(req.query.overlay||"1")==="1";

    try{
      // Se forçar fallback, tenta retornar o arquivo local ANTES de qualquer RTSP/ffmpeg
      if (forceFallback && allowFallback) {

        const local = await resolverFrameLocal(escolaId, camId);
        if (enviarFallbackLocal(res, local)) return;
      }

      const cam = await obterRTSP({ id:camId, escola_id:escolaId });

      // Sem câmera ou sem RTSP → tenta fallback se permitido
      if(!cam || !cam.enabled || !cam.rtsp_url){
        const local = allowFallback ? await resolverFrameLocal(escolaId, camId) : null;
        if (allowFallback && enviarFallbackLocal(res, local)) return;
        return res.status(404).json({ message:"Câmera não encontrada ou sem RTSP." });
      }

      const rtspUrl = String(cam.rtsp_url || "").trim();
      if (!rtspUrl) {
        return res.status(404).json({ message: "rtsp_url vazio para esta câmera." });
      }

      // -rw_timeout usa MICROSEGUNDOS (µs)
      const timeoutUs = Math.max(1_000_000, Math.floor(Number(timeoutMs) * 1000));

      const args = [
        "-hide_banner",
        "-loglevel", "error",

        "-rtsp_transport", transport,

        "-i", rtspUrl,

        "-frames:v", "1",
        "-f", "image2",
        "-vcodec", "mjpeg",
        "pipe:1"
      ];


      const ff = spawn(getFfmpegBinOrThrow(), args, { windowsHide:true });

      const chunks=[]; let stderrTxt="";
      const killer=setTimeout(()=>{ try{ff.kill("SIGKILL");}catch{} }, timeoutMs);

      ff.stdout.on("data",(c)=>chunks.push(c));
      ff.stderr.on("data",(d)=>{ stderrTxt+=d.toString(); });

      ff.on("error", (e) => {
        stderrTxt += `\n[spawn_error] ${String(e?.message || e)}`;
      });

      ff.on("close", async (code, signal)=>{
        clearTimeout(killer);

        if(code===0 && chunks.length){
          let buf = Buffer.concat(chunks);
          try{
            if(withOverlay && typeof aplicarOverlayFrame==="function"){
              buf = await aplicarOverlayFrame(buf, camId, escolaId);
            }
          }catch(e){ warn("overlay:", e?.message||e); }

          res.setHeader("Cache-Control","no-cache, no-store, must-revalidate");
          res.setHeader("Pragma","no-cache");
          res.setHeader("Expires","0");
          res.setHeader("Content-Type","image/jpeg");

          try { return res.end(buf); } catch { return; }
        }

        warn(`ffmpeg falhou cam=${camId} escola=${escolaId} code=${code} signal=${signal||""} err=${stderrTxt.slice(0,300)}`);

        if(allowFallback){
          const local = await resolverFrameLocal(escolaId, camId);
          if (enviarFallbackLocal(res, local)) return;
        }

        try { return res.status(502).json({ message:"Falha ao capturar frame." }); } catch { return; }
      });

      // IMPORTANTE (Windows + polling): não matar ffmpeg no "req close" para snapshot,
      // senão o browser cancela requests e gera code=null (cai em fallback).
      // req.on("close",()=>{ try{ff.kill("SIGKILL");}catch{} });
    }catch(e){
      error("snapshot:", e);
      const local = allowFallback ? await resolverFrameLocal(escolaId, camId) : null;
      if (allowFallback && enviarFallbackLocal(res, local)) return;
      return res.status(500).json({ message:"Erro interno no snapshot." });
    }
  }
);

// ---------------------------- stream .mjpeg --------------------------------
router.get(
  "/:id.mjpeg",
  injectTokenFromQuery,
  autenticarToken,
  autorizarPermissao("monitoramento.visualizar"),
  async (req,res)=>{
    const camId = Number(req.params.id||0);
    const escolaId = resolveEscolaId(req);
    if(!camId || !escolaId) return res.status(400).json({ message:"Parâmetros inválidos." });

    const transport = (String(req.query.transport||"tcp").toLowerCase()==="udp")?"udp":"tcp";
    const fps = Math.max(1, Math.min(30, Number(req.query.fps||8)));
    const qscale = Math.max(2, Math.min(31, Number(req.query.quality||7)));
    const allowFallback = String(req.query.fallback||"1")==="1"; // NOVO
    const forceFallback = String(req.query.force_fallback||"0")==="1"; // NOVO

    try{
      // Se forçar fallback, serve MJPEG a partir do arquivo local (sem RTSP/ffmpeg)
      if (forceFallback && allowFallback) {
        const local = await resolverFrameLocal(escolaId, camId);
        if (!local || !fs.existsSync(local)) {
          return res.status(404).json({ message:"Fallback local indisponível." });
        }

        const boundary="mjpeg-boundary-"+Date.now();
        res.setHeader("Content-Type", `multipart/x-mixed-replace; boundary=${boundary}`);
        res.setHeader("Cache-Control","no-cache, no-store, must-revalidate");
        res.setHeader("Pragma","no-cache");
        res.setHeader("Connection","keep-alive");

        const intervalMs = Math.max(50, Math.floor(1000 / fps));
        const timer = setInterval(async () => {
          try {
            let jpeg = fs.readFileSync(local);
            if (typeof aplicarOverlayFrame==="function") {
              jpeg = await aplicarOverlayFrame(jpeg, camId, escolaId);
            }
            res.write(`--${boundary}\r\n`);
            res.write("Content-Type: image/jpeg\r\n");
            res.write(`Content-Length: ${jpeg.length}\r\n\r\n`);
            res.write(jpeg);
            res.write("\r\n");
          } catch (e) {
            // se falhar leitura/stream, apenas encerra
            try { clearInterval(timer); } catch {}
            try { res.end(); } catch {}
          }
        }, intervalMs);

        const close = () => { try { clearInterval(timer); } catch {} try { res.end(); } catch {} };
        req.on("close", close);
        return;
      }

      const cam = await obterRTSP({ id:camId, escola_id:escolaId });
      if(!cam || !cam.enabled || !cam.rtsp_url){
        return res.status(404).json({ message:"Câmera indisponível." });
      }

      const rtspUrl = String(cam.rtsp_url || "").trim();
      if (!rtspUrl) {
        return res.status(404).json({ message: "rtsp_url vazio para esta câmera." });
      }

      // permite forçar UDP via querystring (?transport=udp), default tcp
      const transport = String(req.query.transport || "tcp").toLowerCase() === "udp" ? "udp" : "tcp";

      // timeout configurável por query (?timeoutMs=5000), com limites seguros
      const timeoutMs = Math.min(15000, Math.max(1000, Number(req.query.timeoutMs || 5000)));
      const timeoutUs = Math.max(1_000_000, Math.floor(timeoutMs * 1000)); // µs

      const boundary="mjpeg-boundary-"+Date.now();


      res.setHeader("Content-Type", `multipart/x-mixed-replace; boundary=${boundary}`);
      res.setHeader("Cache-Control","no-cache, no-store, must-revalidate");
      res.setHeader("Pragma","no-cache");
      res.setHeader("Connection","keep-alive");

      const args=[
        "-hide_banner",
        "-loglevel", "error",

        "-rtsp_transport", transport,

        "-i", rtspUrl,

        // stream contínuo MJPEG (sem áudio)
        "-an",
        "-vf", `fps=${fps}`,
        "-c:v", "mjpeg",
        "-q:v", String(qscale),
        "-f", "mjpeg",
        "pipe:1"
      ];

      const ff=spawn(getFfmpegBinOrThrow(), args, { stdio:["ignore","pipe","pipe"] });

      // garante que o browser receba headers imediatamente (stream real)
      try { if (typeof res.flushHeaders === "function") res.flushHeaders(); } catch {}

      let sentFirstFrame = false;
      let stderrTxt = "";

      const startFallbackMjpeg = async () => {
        if (!allowFallback) return;

        const local = await resolverFrameLocal(escolaId, camId);
        if (!local || !fs.existsSync(local)) {
          warn("fallback mjpeg: arquivo local inexistente");
          try { res.end(); } catch {}
          return;
        }

        const intervalMs = Math.max(50, Math.floor(1000 / fps));
        const timer = setInterval(async () => {
          try {
            let jpeg = fs.readFileSync(local);
            if (typeof aplicarOverlayFrame==="function") {
              jpeg = await aplicarOverlayFrame(jpeg, camId, escolaId);
            }
            res.write(`--${boundary}\r\n`);
            res.write("Content-Type: image/jpeg\r\n");
            res.write(`Content-Length: ${jpeg.length}\r\n\r\n`);
            res.write(jpeg);
            res.write("\r\n");
          } catch (e) {
            warn("fallback mjpeg tick:", e?.message || e);
            try { clearInterval(timer); } catch {}
            try { res.end(); } catch {}
          }
        }, intervalMs);

        const closeFallback = () => {
          try { clearInterval(timer); } catch {}
          try { res.end(); } catch {}
        };
        req.on("close", closeFallback);
      };

      const onFrame = async (jpeg)=>{
        try{
          sentFirstFrame = true;
          let out = jpeg;
          if (typeof aplicarOverlayFrame==="function") out = await aplicarOverlayFrame(jpeg, camId, escolaId);
          res.write(`--${boundary}\r\n`);
          res.write("Content-Type: image/jpeg\r\n");
          res.write(`Content-Length: ${out.length}\r\n\r\n`);
          res.write(out);
          res.write("\r\n");
        }catch(e){
          warn("onFrame:", e?.message||e);
        }
      };

      let buffer=Buffer.alloc(0);
      ff.stdout.on("data",(chunk)=>{
        buffer = Buffer.concat([buffer, chunk]);
        let s,e;
        const SOI=Buffer.from([0xFF,0xD8]), EOI=Buffer.from([0xFF,0xD9]);
        while((s=buffer.indexOf(SOI))!==-1 && (e=buffer.indexOf(EOI,s+2))!==-1){
          const jpeg=buffer.slice(s,e+2);
          buffer=buffer.slice(e+2);
          onFrame(jpeg);
        }
      });

      ff.stderr.on("data",(d)=>{
        try { stderrTxt += d.toString(); } catch {}
      });

      const close = async () => {
        try { ff.kill("SIGKILL"); } catch {}

        // se morreu antes de mandar 1º frame, tenta fallback MJPEG (não encerra seco)
        if (!sentFirstFrame && allowFallback) {
          warn(`ffmpeg encerrou antes do 1º frame cam=${camId} escola=${escolaId}. stderr=${stderrTxt.slice(0,300)}`);
          return startFallbackMjpeg();
        }

        try { res.end(); } catch {}
      };

      ff.on("close", () => { close(); });
      req.on("close", () => { close(); });
    }catch(e){
      error("stream mjpeg:", e);
      return res.status(500).json({ message:"Erro interno no stream." });
    }
  }
);

export default router;
