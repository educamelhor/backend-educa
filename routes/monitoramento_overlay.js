// ============================================================================
// monitoramento_overlay.js — geração de overlay com bounding boxes
// ============================================================================

import express from "express";
import fs from "fs";
import path from "path";

// ⚠️ JIMP: compatibilidade CJS/ESM (evita "Jimp.read is not a function")
// - Em algumas versões o pacote exporta default (CJS);
// - Em outras, exporta { Jimp } (ESM).
// A linha abaixo normaliza para sempre termos um objeto Jimp com .read/.loadFont.
import jimpPkg from "jimp";
const Jimp = (jimpPkg && (jimpPkg.Jimp || jimpPkg.default || jimpPkg));

// ----------------------------------------------------------------------------
// Utilidades
// ----------------------------------------------------------------------------
const router = express.Router();

function pJoin(...parts) {
  return path.join(process.cwd(), ...parts);
}

function fileExists(p) {
  try { return fs.existsSync(p); } catch { return false; }
}

function readJSONSafe(p, fallback = null) {
  try {
    if (!fileExists(p)) return fallback;
    const raw = fs.readFileSync(p, "utf-8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

// ============================================================================
// 🔍 ROTA DE DEBUG RÁPIDO
// GET /api/monitoramento-public/__overlay-debug?escola_dir=CEF04_PLAN&cameraId=1
// ============================================================================
router.get("/__overlay-debug", (req, res) => {
  const { escola_dir = "", cameraId = "1" } = req.query;

  const basePath = pJoin(
    "uploads",
    escola_dir,
    "monitoramento",
    `camera-0${cameraId}`
  );

  const framePath = path.join(basePath, "frame.jpg");
  const facesPath = path.join(basePath, "faces.json");

  return res.json({
    ok: true,
    basePath,
    exists: {
      base: fileExists(basePath),
      frameJpg: fileExists(framePath),
      facesJson: fileExists(facesPath),
    },
    samples: {
      framePath,
      facesPath,
    },
  });
});

// ============================================================================
// 🔍 ROTA: retorna o estado atual de faces detectadas (debug/inspeção)
// GET /api/monitoramento-public/camera/:cameraId/faces?escola_dir=CEF04_PLAN
// ============================================================================
router.get("/camera/:cameraId/faces", async (req, res) => {
  try {
    const { cameraId } = req.params;
    const { escola_dir = "" } = req.query;

    const basePath = pJoin(
      "uploads",
      escola_dir,
      "monitoramento",
      `camera-0${cameraId}`
    );
    const facesPath = path.join(basePath, "faces.json");

    if (!fileExists(basePath)) {
      return res.status(404).json({
        ok: false,
        stage: "prepareBasePath",
        message: "Diretório base não encontrado.",
        basePath,
      });
    }

    if (!fileExists(facesPath)) {
      return res.status(404).json({
        ok: false,
        stage: "checkFacesJson",
        message: "faces.json não encontrado.",
        path: facesPath,
      });
    }

    const data = readJSONSafe(facesPath, { faces: [], width: 0, height: 0 });
    return res.json({
      ok: true,
      ...data,
      escola_dir,
      camera_id: Number(cameraId),
    });
  } catch (err) {
    console.error("[faces] Erro:", err);
    return res.status(500).json({
      ok: false,
      stage: "facesCatch",
      message: "Falha ao obter faces.",
      error: err.message,
    });
  }
});

// ============================================================================
// 🖼️ ROTA PRINCIPAL: gera overlay com caixas/labels sobre o frame atual
// GET /api/monitoramento-public/camera/:cameraId/frame-overlay?escola_dir=CEF04_PLAN&live=1
// ============================================================================
router.get("/camera/:cameraId/frame-overlay", async (req, res) => {
  const stageCtx = { stage: "init" };

  try {
    const { cameraId } = req.params;
    const { escola_dir = "", live } = req.query;

    // --- (1) Resolver caminhos ------------------------------------------------
    stageCtx.stage = "resolvePaths";

    const basePath = pJoin(
      "uploads",
      escola_dir,
      "monitoramento",
      `camera-0${cameraId}`
    );
    const framePath = path.join(basePath, "frame.jpg");
    const facesPath = path.join(basePath, "faces.json");

    if (!fileExists(basePath)) {
      return res.status(404).json({
        ok: false,
        stage: stageCtx.stage,
        message: "Diretório base não encontrado.",
        basePath,
      });
    }

    // --- (2) Verificar frame.jpg ---------------------------------------------
    stageCtx.stage = "checkFrame";
    if (!fileExists(framePath)) {
      return res.status(404).json({
        ok: false,
        stage: stageCtx.stage,
        message: "Frame base não encontrado.",
        framePath,
      });
    }

    // --- (3) Carregar frame com Jimp -----------------------------------------
    stageCtx.stage = "loadFrame";
    const image = await Jimp.read(framePath);

    // --- (4) Carregar faces.json ---------------------------------------------
    stageCtx.stage = "loadFacesJson";
    if (!fileExists(facesPath)) {
      return res.status(404).json({
        ok: false,
        stage: stageCtx.stage,
        message: "faces.json não encontrado.",
        facesPath,
      });
    }

    const facesData = readJSONSafe(facesPath, {
      faces: [],
      width: image?.bitmap?.width ?? 0,
      height: image?.bitmap?.height ?? 0,
    });
    const faces = facesData?.faces ?? [];

    // --- (5) Tipografia/estilos ----------------------------------------------
    stageCtx.stage = "loadFont";
    // Usa fonte embutida do Jimp → evita dependência de /uploads/fonts/Arial.ttf
    const font = await Jimp.loadFont(Jimp.FONT_SANS_16_WHITE);

    // --- (6) Desenhar caixas e labels ----------------------------------------
    stageCtx.stage = "drawBoxes";
    for (const face of faces) {
      const {
        bbox = { left: 0, top: 0, width: 0, height: 0 },
        recognized = false,
        name = "DESCONHECIDO",
        score = 0,
      } = face;

      // Cores ARGB (0xRRGGBBAA)
      const color = recognized ? 0x00ff00ff : 0xff0000ff;

      // Borda superior e inferior
      for (let x = bbox.left; x < bbox.left + bbox.width; x++) {
        image.setPixelColor(color, x, bbox.top);
        image.setPixelColor(color, x, bbox.top + bbox.height);
      }
      // Borda esquerda e direita
      for (let y = bbox.top; y < bbox.top + bbox.height; y++) {
        image.setPixelColor(color, bbox.left, y);
        image.setPixelColor(color, bbox.left + bbox.width, y);
      }

      // Label
      const label = `${name} (${(score * 100).toFixed(1)}%)`;
      const textX = Math.max(0, bbox.left + 4);
      const textY = Math.max(0, bbox.top - 20);
      await image.print(font, textX, textY, label);
    }

    // --- (7) Resposta (live desabilita cache) ---------------------------------
    stageCtx.stage = "encodeOutput";
    if (live) res.set("Cache-Control", "no-cache, no-store, must-revalidate");
    res.set("Content-Type", Jimp.MIME_JPEG);

    const buffer = await image.getBufferAsync(Jimp.MIME_JPEG);
    return res.send(buffer);
  } catch (error) {
    console.error("[frame-overlay] Falha geral:", error);
    return res.status(500).json({
      ok: false,
      stage: stageCtx.stage,
      message: "Falha geral no overlay.",
      error: error?.message,
    });
  }
});

// ============================================================================
// 🆕 PASSO 4.1 — STREAM DE OVERLAY (multipart/x-mixed-replace - MJPEG)
// GET /api/monitoramento/overlay/stream?cameraId=1&escola_dir=CEF04_PLAN&fps=2
// - Mantém todas as rotas anteriores intactas.
// - Multi-escola preservado via escola_dir.
// ============================================================================
let CACHED_FONT = null;

async function drawOverlayBuffer(basePath) {
  // basePath: .../uploads/<apelido>/monitoramento/camera-0X
  const framePath = path.join(basePath, "frame.jpg");
  const facesPath = path.join(basePath, "faces.json");

  // Se não houver frame, gera um placeholder simples (500x280) informativo
  if (!fileExists(framePath)) {
    const img = new Jimp(500, 280, 0x000000ff);
    if (!CACHED_FONT) CACHED_FONT = await Jimp.loadFont(Jimp.FONT_SANS_16_WHITE);
    await img.print(CACHED_FONT, 10, 10, "Preview indisponível (frame.jpg ausente)");
    await img.print(CACHED_FONT, 10, 40, path.normalize(basePath));
    return await img.getBufferAsync(Jimp.MIME_JPEG);
  }

  const image = await Jimp.read(framePath);

  // Carrega faces (se houver)
  let faces = [];
  if (fileExists(facesPath)) {
    const facesData = readJSONSafe(facesPath, {
      faces: [],
      width: image?.bitmap?.width ?? 0,
      height: image?.bitmap?.height ?? 0,
    });
    faces = facesData?.faces ?? [];
  }

  if (!CACHED_FONT) CACHED_FONT = await Jimp.loadFont(Jimp.FONT_SANS_16_WHITE);

  // Desenha caixas
  for (const face of faces) {
    const {
      bbox = { left: 0, top: 0, width: 0, height: 0 },
      recognized = false,
      name = "DESCONHECIDO",
      score = 0,
    } = face;

    const color = recognized ? 0x00ff00ff : 0xff0000ff;

    for (let x = bbox.left; x < bbox.left + bbox.width; x++) {
      image.setPixelColor(color, x, bbox.top);
      image.setPixelColor(color, x, bbox.top + bbox.height);
    }
    for (let y = bbox.top; y < bbox.top + bbox.height; y++) {
      image.setPixelColor(color, bbox.left, y);
      image.setPixelColor(color, bbox.left + bbox.width, y);
    }

    const label = `${name} (${(score * 100).toFixed(1)}%)`;
    const textX = Math.max(0, bbox.left + 4);
    const textY = Math.max(0, bbox.top - 20);
    await image.print(CACHED_FONT, textX, textY, label);
  }

  return await image.getBufferAsync(Jimp.MIME_JPEG);
}

router.get("/overlay/stream", async (req, res) => {
  // Parâmetros: cameraId, escola_dir, fps (opcional)
  const { escola_dir = "", cameraId = "1", fps = "2" } = req.query;

  const basePath = pJoin(
    "uploads",
    escola_dir,
    "monitoramento",
    `camera-0${cameraId}`
  );

  if (!fileExists(basePath)) {
    return res.status(404).json({
      ok: false,
      stage: "overlayStreamBase",
      message: "Diretório base não encontrado.",
      basePath,
    });
  }

  // Cabeçalhos para multipart/x-mixed-replace (padrão MJPEG)
  const boundary = "mjpeg-boundary";
  res.writeHead(200, {
    "Content-Type": `multipart/x-mixed-replace; boundary=${boundary}`,
    "Cache-Control": "no-cache, no-store, must-revalidate",
    Pragma: "no-cache",
    Expires: "0",
    Connection: "keep-alive",
  });

  let closed = false;
  req.on("close", () => { closed = true; });

  // Intervalo baseado no FPS
  const intervalMs = Math.max(200, Math.floor(1000 / Number(fps || 2)));

  const pushFrame = async () => {
    try {
      const buffer = await drawOverlayBuffer(basePath);
      // Escreve um "frame" no fluxo MJPEG
      res.write(`--${boundary}\r\n`);
      res.write("Content-Type: image/jpeg\r\n");
      res.write(`Content-Length: ${buffer.length}\r\n\r\n`);
      res.write(buffer);
      res.write("\r\n");
    } catch (err) {
      console.error("[overlay/stream] Falha ao gerar frame:", err);
      // Em caso de erro, tenta enviar um frame placeholder para não matar a conexão
      try {
        const img = new Jimp(500, 280, 0x000000ff);
        if (!CACHED_FONT) CACHED_FONT = await Jimp.loadFont(Jimp.FONT_SANS_16_WHITE);
        await img.print(CACHED_FONT, 10, 10, "Falha ao gerar frame do overlay");
        const buf = await img.getBufferAsync(Jimp.MIME_JPEG);
        res.write(`--${boundary}\r\n`);
        res.write("Content-Type: image/jpeg\r\n");
        res.write(`Content-Length: ${buf.length}\r\n\r\n`);
        res.write(buf);
        res.write("\r\n");
      } catch (_) {}
    }
  };

  // Loop do stream
  const timer = setInterval(async () => {
    if (closed) {
      clearInterval(timer);
      return;
    }
    await pushFrame();
  }, intervalMs);

  // Envia o primeiro frame imediatamente
  pushFrame().catch(() => {});
});

// ============================================================================
// Export
// ============================================================================
export default router;
