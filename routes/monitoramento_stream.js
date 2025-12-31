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
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import pool from "../db.js";
import { autenticarToken } from "../middleware/autenticarToken.js";
//import { aplicarOverlayFrame } from "./monitoramento_overlay.js";

const router = Router({ mergeParams: true });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --------------------------- helpers básicos -------------------------------
function log(...a){ try{ console.log("[stream]",...a);}catch{} }
function warn(...a){ try{ console.warn("[stream]",...a);}catch{} }
function error(...a){ try{ console.error("[stream]",...a);}catch{} }

// injeta Authorization a partir de ?token=
function injectTokenFromQuery(req,_res,next){
  const tk = req.query?.token;
  if (tk && !req.headers.authorization) req.headers.authorization = `Bearer ${tk}`;
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
async function resolverFrameLocal(escolaId, camId){
  const apelido = (await getEscolaApelidoById(escolaId)) || (process.env.ESCOLA_DIR_DEFAULT || "CEF04_PLAN");
  const multi = path.join(UPLOADS_BASE, apelido, "monitoramento", `camera${camId}.jpg`);
  const legacy= path.join(UPLOADS_BASE, "monitoramento", `camera${camId}.jpg`);
  if (fs.existsSync(multi)) return multi;
  if (fs.existsSync(legacy)) return legacy;
  return null;
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
router.get("/ping", (_req,res)=>{
  res.json({ ok:true, scope:"stream", ffmpeg:"ffmpeg (PATH)", ts:new Date().toISOString() });
});

// --------------------------- snapshot .jpg ---------------------------------
router.get(
  "/:id.jpg",
  injectTokenFromQuery,
  autenticarToken,
  async (req,res)=>{
    const camId = Number(req.params.id||0);
    const escolaId = resolveEscolaId(req);
    if(!camId || !escolaId) return res.status(400).json({ message:"Parâmetros inválidos." });

    const transport = (String(req.query.transport||"tcp").toLowerCase()==="udp")?"udp":"tcp";
    const qscale = mapQualityToQscale(req.query.quality);
    const timeoutMs = Math.max(1000, Math.min(15000, Number(req.query.timeout||7000)));
    const allowFallback = String(req.query.fallback||"1")==="1"; // padrão: permite fallback
    const withOverlay = String(req.query.overlay||"1")==="1";

    try{
      const cam = await obterRTSP({ id:camId, escola_id:escolaId });

      // Sem câmera ou sem RTSP → tenta fallback se permitido
      if(!cam || !cam.enabled || !cam.rtsp_url){
        const local = allowFallback ? await resolverFrameLocal(escolaId, camId) : null;
        if (allowFallback && enviarFallbackLocal(res, local)) return;
        return res.status(404).json({ message:"Câmera não encontrada ou sem RTSP." });
      }

      const args = [
        "-rtsp_transport", transport,
        "-rtsp_flags", "prefer_tcp",
        "-stimeout", "3000000",
        "-rw_timeout", "3000000",
        "-i", cam.rtsp_url,
        "-frames:v","1",
        "-f","image2pipe",
        "-qscale:v", String(qscale),
        "pipe:1"
      ];
      const ff = spawn("ffmpeg", args, { stdio:["ignore","pipe","pipe"] });

      const chunks=[]; let stderrTxt="";
      const killer=setTimeout(()=>{ try{ff.kill("SIGKILL");}catch{} }, timeoutMs);

      ff.stdout.on("data",(c)=>chunks.push(c));
      ff.stderr.on("data",(d)=>{ stderrTxt+=d.toString(); });

      ff.on("close", async (code)=>{
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
          return res.end(buf);
        }
        warn(`ffmpeg falhou cam=${camId} escola=${escolaId} code=${code} err=${stderrTxt.slice(0,300)}`);
        if(allowFallback){
          const local = await resolverFrameLocal(escolaId, camId);
          if (enviarFallbackLocal(res, local)) return;
        }
        return res.status(502).json({ message:"Falha ao capturar frame." });
      });

      req.on("close",()=>{ try{ff.kill("SIGKILL");}catch{} });
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
  async (req,res)=>{
    const camId = Number(req.params.id||0);
    const escolaId = resolveEscolaId(req);
    if(!camId || !escolaId) return res.status(400).json({ message:"Parâmetros inválidos." });

    const transport = (String(req.query.transport||"tcp").toLowerCase()==="udp")?"udp":"tcp";
    const fps = Math.max(1, Math.min(30, Number(req.query.fps||8)));
    const qscale = Math.max(2, Math.min(31, Number(req.query.quality||7)));

    try{
      const cam = await obterRTSP({ id:camId, escola_id:escolaId });
      if(!cam || !cam.enabled || !cam.rtsp_url){
        return res.status(404).json({ message:"Câmera indisponível." });
      }

      const boundary="mjpeg-boundary-"+Date.now();
      res.setHeader("Content-Type", `multipart/x-mixed-replace; boundary=${boundary}`);
      res.setHeader("Cache-Control","no-cache, no-store, must-revalidate");
      res.setHeader("Pragma","no-cache");
      res.setHeader("Connection","keep-alive");

      const args=[
        "-rtsp_transport", transport,
        "-rtsp_flags", "prefer_tcp",
        "-stimeout", "3000000",
        "-rw_timeout", "3000000",
        "-i", cam.rtsp_url,
        "-r", String(fps),
        "-f", "image2pipe",
        "-qscale:v", String(qscale),
        "pipe:1"
      ];
      const ff=spawn("ffmpeg", args, { stdio:["ignore","pipe","pipe"] });

      const onFrame = async (jpeg)=>{
        try{
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

      ff.stderr.on("data",()=>{});
      const close=()=>{ try{ff.kill("SIGKILL");}catch{} try{res.end();}catch{} };
      ff.on("close", close);
      req.on("close", close);
    }catch(e){
      error("stream mjpeg:", e);
      return res.status(500).json({ message:"Erro interno no stream." });
    }
  }
);

export default router;
