// ============================================================================
// monitoramento_overlay.js — geração de overlay com bounding boxes
// ============================================================================

import express from "express";
import fs from "fs";
import path from "path";

// ⚠️ JIMP: compatibilidade CJS/ESM
// - Algumas versões exportam namespace com { Jimp, loadFont, MIME_JPEG, FONT_* }
// - Outras exportam default (CJS)
// A ideia é: garantir que Jimp tenha .read/.loadFont + constantes usadas no restante do arquivo.
import * as jimpPkg from "jimp";
const Jimp = (jimpPkg && (jimpPkg.Jimp || jimpPkg.default || jimpPkg));

import { autenticarToken } from "../middleware/autenticarToken.js";
import { autorizarPermissao } from "../middleware/autorizarPermissao.js";

// 🔧 “Patch” de compatibilidade: se o método/constante existir no módulo mas não em Jimp, copia.
try {
  if (Jimp && !Jimp.loadFont && typeof jimpPkg.loadFont === "function") {
    Jimp.loadFont = jimpPkg.loadFont;
  }
  if (Jimp && !Jimp.MIME_JPEG && jimpPkg.MIME_JPEG) {
    Jimp.MIME_JPEG = jimpPkg.MIME_JPEG;
  }
  if (Jimp && !Jimp.FONT_SANS_16_WHITE && jimpPkg.FONT_SANS_16_WHITE) {
    Jimp.FONT_SANS_16_WHITE = jimpPkg.FONT_SANS_16_WHITE;
  }
} catch (_) {
  // não quebra o boot; qualquer falha aqui será percebida no endpoint com stage detalhado
}


// ----------------------------------------------------------------------------
// Utilidades
// ----------------------------------------------------------------------------
const router = express.Router();

// ✅ PASSO 2.8.1 — Debug factual do print (somente quando debug_text=1)
// Quando true, o safePrint loga o motivo real do erro no terminal.
let PRINT_DEBUG_SAFEPRINT = false;

// ✅ PASSO 2.8.3.1 — Throttle de log (evita flood no terminal durante stream)
let SAFEPRINT_LAST_LOG_AT = 0;
const SAFEPRINT_LOG_EVERY_MS = 1500;


// 🔒 RBAC — só quando montado em rota "protegida"
// ✅ Rotas públicas: /api/monitoramento-public e /api/monitoramento-overlay
router.use((req, res, next) => {
  const base = String(req.baseUrl || "");

  const isPublic =
    base.includes("/api/monitoramento-public") ||
    base.includes("/api/monitoramento-overlay");

  if (isPublic) return next();

  // protegido (se este router for montado em outro baseUrl no futuro)
  return autenticarToken(req, res, (err) => {
    if (err) return; // autenticarToken já respondeu
    return autorizarPermissao("monitoramento.visualizar")(req, res, next);
  });
});


function pJoin(...parts) {
  return path.join(process.cwd(), ...parts);
}

function fileExists(p) {
  try { return fs.existsSync(p); } catch { return false; }
}

function getBmFontReferencedPngName(fntContent) {
  // Ex.: page id=0 file="open-sans-16-white_0.png"
  const m = fntContent.match(/page\s+id=\d+\s+file="([^"]+)"/i);
  return m ? m[1] : null;
}

function ensureBmFontPngExists(fontPath) {
  // Garante que a PNG referenciada dentro do .fnt existe no mesmo diretório
  const dir = path.dirname(fontPath);

  const fntRaw = fs.readFileSync(fontPath, "utf-8");
  const referencedPng = getBmFontReferencedPngName(fntRaw);

  if (!referencedPng) {
    console.warn("[bmfont] Não foi possível detectar PNG referenciada no .fnt");
    return;
  }

  const referencedPngPath = path.join(dir, referencedPng);

  // Se já existe, ok
  if (fileExists(referencedPngPath)) return;

  // Tentativas comuns: sem sufixo _0, ou variações simples
  const fallbacks = [
    path.join(dir, "open-sans-16-white.png"),
    path.join(dir, referencedPng.replace("_0.png", ".png")),
  ];

  const found = fallbacks.find((p) => fileExists(p));

  if (!found) {
    console.error("[bmfont] PNG referenciada não existe e nenhum fallback foi encontrado.", {
      referencedPng,
      referencedPngPath,
      fallbacks,
    });
    return;
  }

  try {
    fs.copyFileSync(found, referencedPngPath);
    console.log("[bmfont] Criado alias da PNG para compatibilidade:", {
      from: found,
      to: referencedPngPath,
    });
  } catch (err) {
    console.error("[bmfont] Falha ao criar alias da PNG:", err?.message);
  }
}

function resolveBmFontPath() {
  const file = "open-sans-16-white.fnt";

  // Candidatos (cobrindo os 2 cenários mais comuns de process.cwd())
  const candidates = [
    // Quando o backend é iniciado dentro de apps/educa-backend
    path.join(process.cwd(), "assets", "fonts", file),

    // Quando o backend é iniciado na raiz do mono-repo
    path.join(process.cwd(), "apps", "educa-backend", "assets", "fonts", file),
  ];

  for (const p of candidates) {
    if (fileExists(p)) {
      // 🔒 Garantia: PNG referenciada no .fnt existe (corrige _0.png vs .png)
      ensureBmFontPngExists(p);
      return p;
    }
  }

  return null;
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

function normalizeBBox(bbox) {
  const b = bbox || {};

  const x = Number.isFinite(b.x) ? b.x : (Number.isFinite(b.left) ? b.left : 0);
  const y = Number.isFinite(b.y) ? b.y : (Number.isFinite(b.top) ? b.top : 0);

  const width = Number.isFinite(b.width) ? b.width : 0;
  const height = Number.isFinite(b.height) ? b.height : 0;

  return { x, y, width, height };
}

// ---------------------------------------------------------------------------
// ✅ PASSO 4.2.1 — Blindagem: clamp do bbox ao frame (evita pixel fora do bitmap)
// ---------------------------------------------------------------------------
function clampBBoxToImage(bbox, imgW, imgH) {
  const w = Number(imgW || 0);
  const h = Number(imgH || 0);
  if (!w || !h) return null;

  const x0 = Math.max(0, Math.floor(bbox.x));
  const y0 = Math.max(0, Math.floor(bbox.y));

  // bbox.width/height podem estourar a imagem; ajusta o "fim" ao limite do bitmap
  const x1 = Math.min(w - 1, Math.floor(bbox.x + bbox.width));
  const y1 = Math.min(h - 1, Math.floor(bbox.y + bbox.height));

  const newW = x1 - x0;
  const newH = y1 - y0;

  // Se depois do clamp ficar inválido, ignora
  if (newW <= 1 || newH <= 1) return null;

  return { x: x0, y: y0, width: newW, height: newH };
}


function buildSimulatedFaces(imgW, imgH, mode = "default", simTick = 0) {

  const w = Number(imgW || 0);
  const h = Number(imgH || 0);

  // Proteção básica
  if (!w || !h) return [];

  // (A) Modo padrão: caixas afastadas (sanidade visual)
  if (mode !== "cluster") {
    const box1 = {
      x: Math.floor(w * 0.12),
      y: Math.floor(h * 0.18),
      width: Math.floor(w * 0.22),
      height: Math.floor(h * 0.28),
    };

    const box2 = {
      x: Math.floor(w * 0.55),
      y: Math.floor(h * 0.25),
      width: Math.floor(w * 0.18),
      height: Math.floor(h * 0.24),
    };

    const box3 = {
      x: Math.floor(w * 0.35),
      y: Math.floor(h * 0.55),
      width: Math.floor(w * 0.20),
      height: Math.floor(h * 0.26),
    };

    return [
      { bbox: box1, recognized: false, name: "SIMULADO 01", score: 0.0 },
      { bbox: box2, recognized: true,  name: "SIMULADO 02", score: 0.98 },
      { bbox: box3, recognized: false, name: "SIMULADO 03", score: 0.12 },
    ];
  }

  // (B) Modo cluster: múltiplos rostos bem próximos (força colisão/stack)
  // ideia: 3 boxes colados (mesmo “grupo”) + 1 box distante (outro cluster)
  const baseX = Math.floor(w * 0.18);
  const baseY = Math.floor(h * 0.22);

  // ✅ PASSO 2.8 — movimento artificial (sem câmera real)
  // Oscila levemente para forçar mudança frame-a-frame e permitir validar pseudo-tracking.
  const t = Number(simTick || 0);
  const dx = Math.round(Math.sin(t / 4) * 8);  // ~[-8..+8]
  const dy = Math.round(Math.cos(t / 5) * 6);  // ~[-6..+6]

  const bw = Math.floor(w * 0.18);
  const bh = Math.floor(h * 0.22);

  const box1 = { x: baseX + dx, y: baseY + dy, width: bw, height: bh };
  const box2 = { x: baseX + Math.floor(bw * 0.65) + dx, y: baseY + Math.floor(bh * 0.10) + dy, width: bw, height: bh };
  const box3 = { x: baseX + Math.floor(bw * 0.25) + dx, y: baseY + Math.floor(bh * 0.70) + dy, width: bw, height: bh };

  // cluster distante (pra testar occupiedRects entre clusters)
  const box4 = {
    x: Math.floor(w * 0.62) - dx,
    y: Math.floor(h * 0.18) + dy,
    width: Math.floor(w * 0.18),
    height: Math.floor(h * 0.24),
  };

  return [
    { bbox: box1, recognized: false, name: "CLUSTER 01", score: 0.12 },
    { bbox: box2, recognized: true,  name: "CLUSTER 02", score: 0.98 },
    { bbox: box3, recognized: false, name: "CLUSTER 03", score: 0.33 },
    { bbox: box4, recognized: true,  name: "ISOLADO 01", score: 0.91 },
  ];
}
 
async function toJpegBuffer(img) {

  const MIME_JPEG = Jimp?.MIME_JPEG || jimpPkg?.MIME_JPEG || "image/jpeg";

  if (img && typeof img.getBufferAsync === "function") {
    return await img.getBufferAsync(MIME_JPEG);
  }

  if (img && typeof img.getBuffer === "function") {
    const maybePromise = img.getBuffer(MIME_JPEG);

    if (maybePromise && typeof maybePromise.then === "function") {
      return await maybePromise;
    }

    return await new Promise((resolve, reject) => {
      img.getBuffer(MIME_JPEG, (err, buf) => (err ? reject(err) : resolve(buf)));
    });
  }

  throw new Error("Jimp buffer API indisponível (getBuffer/getBufferAsync).");
}

// ✅ PASSO 2.3 — Labels resilientes
// Algumas versões do Jimp esperam print(font, x, y, "texto")
// Outras esperam print(font, x, y, { text: "texto" }) (validadas via Zod)
// Este helper tenta os dois formatos e NUNCA deixa o overlay cair por causa de texto.


















async function safePrint(img, font, x, y, text) {
  // Objetivo: suportar múltiplas assinaturas do Jimp.print sem derrubar o overlay.
  // - Algumas versões: print(font, x, y, "texto")
  // - Outras versões: print(font, x, y, { text: "texto" })
  // - Outras versões (Zod): print(font, { x, y, text })
  // - E algumas aceitam variações com maxWidth/maxHeight
  try {
    if (!img || !font) return false;

    const t = (typeof text === "string" || typeof text === "number")
      ? String(text)
      : "";

    if (!t) return true; // nada a imprimir, mas não é falha

    const imgW = Number(img?.bitmap?.width || 0);
    const imgH = Number(img?.bitmap?.height || 0);
    if (!imgW || !imgH) return false;

    const px = Math.max(0, Math.min(imgW - 1, Math.floor(Number(x) || 0)));
    const py = Math.max(0, Math.min(imgH - 1, Math.floor(Number(y) || 0)));

    const maxW = Math.max(1, imgW - px - 2);
    const maxH = Math.max(1, imgH - py - 2);

    const shouldLog = () => {
      const now = Date.now();
      if ((now - SAFEPRINT_LAST_LOG_AT) < SAFEPRINT_LOG_EVERY_MS) return false;
      SAFEPRINT_LAST_LOG_AT = now;
      return true;
    };

    const logFail = (tag, err) => {
      if (!PRINT_DEBUG_SAFEPRINT) return;
      if (!shouldLog()) return;

      const msg = err?.message || String(err);
      const stack = err?.stack || "";
      console.warn(`[safePrint][${tag}] falhou: ${msg}`);
      if (stack) console.warn(stack);
    };

    const tries = [
      {
        tag: "string_direct",
        fn: () => img.print(font, px, py, t),
      },
      {
        tag: "payload_text_only",
        fn: () => img.print(font, px, py, { text: t }),
      },
      {
        tag: "object_xy_text",
        fn: () => img.print(font, { x: px, y: py, text: t }),
      },
      {
        tag: "object_xy_text_with_bounds",
        fn: () => img.print(font, { x: px, y: py, text: t, maxWidth: maxW, maxHeight: maxH }),
      },
      {
        tag: "payload_text_only_with_bounds",
        fn: () => img.print(font, px, py, { text: t }, maxW, maxH),
      },
      {
        tag: "object_with_font",
        fn: () => img.print({ font, x: px, y: py, text: t }),
      },
    ];

    for (const attempt of tries) {
      try {
        const r = attempt.fn();
        // compat: algumas versões retornam Promise, outras não
        if (r && typeof r.then === "function") await r;
        return true;
      } catch (err) {
        logFail(attempt.tag, err);
      }
    }

    // falhou em todas as assinaturas
    return false;

  } catch (err) {
    if (PRINT_DEBUG_SAFEPRINT) {
      const msg = err?.message || String(err);
      const stack = err?.stack || "";
      console.warn(`[safePrint][catch] falhou: ${msg}`);
      if (stack) console.warn(stack);
    }
    return false;
  }
}















// ✅ PASSO 2.4 — Texto sempre visível (placa/fundo) + clamp dentro do frame
function clamp(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  return Math.min(max, Math.max(min, x));
}

// Desenha um retângulo sólido (rápido o suficiente para “placas” pequenas)
function fillRect(img, x, y, w, h, color) {
  if (!img?.bitmap) return;
  const imgW = img.bitmap.width;
  const imgH = img.bitmap.height;

  const x0 = clamp(Math.floor(x), 0, imgW - 1);
  const y0 = clamp(Math.floor(y), 0, imgH - 1);
  const x1 = clamp(Math.floor(x + w - 1), 0, imgW - 1);
  const y1 = clamp(Math.floor(y + h - 1), 0, imgH - 1);

  if (x1 <= x0 || y1 <= y0) return;

  for (let yy = y0; yy <= y1; yy++) {
    for (let xx = x0; xx <= x1; xx++) {
      img.setPixelColor(color, xx, yy);
    }
  }
}

// Heurística simples de tamanho do “label box” (sem medir texto)
// - Como usamos fonte pequena, isso é suficiente e estável para produção agora.
function estimateLabelSize(text) {
  const t = (text ?? "").toString();
  const charW = 8;     // heurística (fonte ~16px)
  const padX = 8;      // padding lateral
  const padY = 5;      // padding vertical
  const textH = 18;    // altura aproximada do texto
  const w = Math.max(40, (t.length * charW) + (padX * 2));
  const h = textH + (padY * 2);
  return { w, h, padX, padY, textH };
}

// ✅ PASSO 2.4.1 — Escolha de posição do label (clamp + alternativas ao redor do bbox)
// Retorna posição (x,y) para a “placa”, tentando evitar que fique fora do frame.
function chooseLabelPosition(img, desiredX, desiredY, labelW, labelH, bbox) {
  const imgW = img?.bitmap?.width ?? 0;
  const imgH = img?.bitmap?.height ?? 0;

  const clampX = (x) => clamp(x, 0, Math.max(0, imgW - labelW - 1));
  const clampY = (y) => clamp(y, 0, Math.max(0, imgH - labelH - 1));

  const dx = Math.floor(Number(desiredX) || 0);
  const dy = Math.floor(Number(desiredY) || 0);

  // bbox pode vir em formatos diferentes; aqui assumimos {x,y,w,h} já normalizado
  const bx = Math.floor(bbox?.x ?? 0);
  const by = Math.floor(bbox?.y ?? 0);
  const bw = Math.floor(bbox?.w ?? 0);
  const bh = Math.floor(bbox?.h ?? 0);

  // “preferência” de posições:
  // 1) acima do rosto (padrão)
  // 2) abaixo
  // 3) direita
  // 4) esquerda
  // 5) topo (fallback)
  const candidates = [
    { x: bx, y: by - (labelH + 6) },            // acima
    { x: bx, y: by + bh + 6 },                  // abaixo
    { x: bx + bw + 6, y: by },                  // direita
    { x: bx - (labelW + 6), y: by },            // esquerda
    { x: dx, y: dy },                           // desejado (fallback)
    { x: bx, y: 0 },                            // topo
  ];

  for (const c of candidates) {
    const x = clampX(c.x);
    const y = clampY(c.y);
    return { x, y };
  }

  return { x: clampX(dx), y: clampY(dy) };
}

// ✅ PASSO 2.5 — Hierarquia visual (prioridade de labels) + anticolisão simples
function getFacePriority(face) {

  // Maior = mais importante (desenhar por último)
  const recognized = !!face?.recognized;
  const score = Number(face?.score ?? 0);
  const name = (face?.name ?? "").toString().trim();

  // Regras:
  // 1) Reconhecido > não reconhecido
  // 2) Score maior > score menor
  // 3) Nome diferente de "DESCONHECIDO" ganha leve bônus
  const nameBonus = (name && name.toUpperCase() !== "DESCONHECIDO") ? 0.05 : 0;

  return (recognized ? 10 : 0) + score + nameBonus;
}

function sortFacesByPriority(faces) {
  const arr = Array.isArray(faces) ? [...faces] : [];
  // desenhar primeiro os menos importantes e por último os mais importantes
  arr.sort((a, b) => getFacePriority(a) - getFacePriority(b));
  return arr;
}

function rectsIntersect(a, b) {
  return !(
    (a.x + a.w) <= b.x ||
    (b.x + b.w) <= a.x ||
    (a.y + a.h) <= b.y ||
    (b.y + b.h) <= a.y
  );
}

function bboxToRect(b) {
  return { x: b.x, y: b.y, w: b.width, h: b.height };
}

function expandRect(r, pad) {
  return {
    x: r.x - pad,
    y: r.y - pad,
    w: r.w + pad * 2,
    h: r.h + pad * 2,
  };
}

function unionRect(a, b) {
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const x1 = Math.max(a.x + a.w, b.x + b.w);
  const y1 = Math.max(a.y + a.h, b.y + b.h);
  return { x: x0, y: y0, w: (x1 - x0), h: (y1 - y0) };
}

// Faces “próximas” = interseção OU quase encostando (via padding)
function areFacesClose(b1, b2, padPx = 18) {
  const r1 = expandRect(bboxToRect(b1), padPx);
  const r2 = expandRect(bboxToRect(b2), padPx);
  return rectsIntersect(r1, r2);
}

// Agrupa faces em clusters (conexo por proximidade)
function clusterFacesByProximity(faces, padPx = 18) {
  const list = Array.isArray(faces) ? faces : [];
  const used = new Array(list.length).fill(false);
  const clusters = [];

  for (let i = 0; i < list.length; i++) {
    if (used[i]) continue;

    const queue = [i];
    used[i] = true;

    const cluster = [];
    while (queue.length) {
      const idx = queue.shift();
      const f = list[idx];
      cluster.push(f);

      const b1 = f?.__bbox_clamped;
      if (!b1) continue;

      for (let j = 0; j < list.length; j++) {
        if (used[j]) continue;
        const b2 = list[j]?.__bbox_clamped;
        if (!b2) continue;

        if (areFacesClose(b1, b2, padPx)) {
          used[j] = true;
          queue.push(j);
        }
      }
    }

    clusters.push(cluster);
  }

  return clusters;
}

// Escolhe um “anchor” de label por cluster (top-left do retângulo união)
function getClusterBounds(cluster) {
  let bounds = null;
  for (const f of cluster) {
    const b = f?.__bbox_clamped;
    if (!b) continue;
    const r = bboxToRect(b);
    bounds = bounds ? unionRect(bounds, r) : r;
  }
  return bounds;
}

// Posição “boa” do stack: tentar acima; se não couber, abaixo; se não, topo do frame.
function chooseClusterLabelAnchor(img, clusterBounds, labelW, labelH) {
  const imgW = img?.bitmap?.width ?? 0;
  const imgH = img?.bitmap?.height ?? 0;

  const desiredX = Math.floor(clusterBounds.x);
  const aboveY = Math.floor(clusterBounds.y - (labelH + 6));
  const belowY = Math.floor(clusterBounds.y + clusterBounds.h + 6);

  const candidates = [
    { x: desiredX, y: aboveY },
    { x: desiredX, y: belowY },
    { x: desiredX, y: 0 },
  ];

  for (const c of candidates) {
    const x = clamp(c.x, 0, Math.max(0, imgW - labelW - 1));
    const y = clamp(c.y, 0, Math.max(0, imgH - labelH - 1));
    return { x, y };
  }

  return {
    x: clamp(desiredX, 0, Math.max(0, imgW - labelW - 1)),
    y: 0,
  };
}

// ✅ PASSO 2.7 — ID visual de track (por quadro)
// #A, #B, #C... (e se passar de 26: #AA, #AB...)
function trackTagFromIndex(i) {
  const n = Number(i);
  if (!Number.isFinite(n) || n < 0) return "#?";

  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  if (n < 26) return `#${A[n]}`;

  const first = Math.floor(n / 26) - 1;
  const second = n % 26;

  const c1 = A[first] || "Z";
  const c2 = A[second] || "Z";
  return `#${c1}${c2}`;
}

// ✅ PASSO 2.8 — Pseudo-tracking temporal (memória curta) por camera+escola
// Mantém o mesmo #A/#B entre frames usando proximidade (centro do bbox).
const TRACKERS = new Map(); // key -> { nextId, tracks: Map<tag, {cx,cy,lastSeen}> }

function getTracker(key) {
  const k = String(key || "");
  if (!k) return null;

  let t = TRACKERS.get(k);
  if (!t) {
    t = { nextId: 0, tracks: new Map() };
    TRACKERS.set(k, t);
  }
  return t;
}

function bboxCenter(b) {
  const x = Number(b?.x ?? 0);
  const y = Number(b?.y ?? 0);
  const w = Number(b?.width ?? 0);
  const h = Number(b?.height ?? 0);
  return { cx: x + (w / 2), cy: y + (h / 2) };
}

function dist2(a, b) {
  const dx = a.cx - b.cx;
  const dy = a.cy - b.cy;
  return (dx * dx) + (dy * dy);
}

function purgeOldTracks(tracker, nowMs, ttlMs = 2500) {
  for (const [tag, tr] of tracker.tracks.entries()) {
    if ((nowMs - (tr.lastSeen || 0)) > ttlMs) {
      tracker.tracks.delete(tag);
    }
  }
}

// Atribui tags estáveis para um frame (greedy por menor distância)
// items: [{ face, bbox }] (bbox já clamped)
function assignStableTagsForFrame(tracker, items, nowMs, maxDistPx = 90) {
  const tagByFace = new Map();
  if (!tracker) return tagByFace;

  purgeOldTracks(tracker, nowMs);

  const usedTags = new Set();
  const maxDist2 = maxDistPx * maxDistPx;

  // precompute centros
  const centers = items.map((it) => ({ it, c: bboxCenter(it.bbox) }));

  for (const { it, c } of centers) {
    let bestTag = null;
    let bestD2 = Infinity;

    for (const [tag, tr] of tracker.tracks.entries()) {
      if (usedTags.has(tag)) continue;

      const d2 = dist2(c, tr);
      if (d2 < bestD2) {
        bestD2 = d2;
        bestTag = tag;
      }
    }

    if (bestTag && bestD2 <= maxDist2) {
      // reaproveita track
      const tr = tracker.tracks.get(bestTag);
      tr.cx = c.cx;
      tr.cy = c.cy;
      tr.lastSeen = nowMs;

      usedTags.add(bestTag);
      tagByFace.set(it.face, bestTag);
    } else {
      // cria novo track
      const id = tracker.nextId++;
      const tag = trackTagFromIndex(id);

      tracker.tracks.set(tag, { cx: c.cx, cy: c.cy, lastSeen: nowMs });

      usedTags.add(tag);
      tagByFace.set(it.face, tag);
    }
  }

  return tagByFace;
}



async function drawLabelWithBgPriority(img, font, desiredX, desiredY, text, bbox, occupiedRects, priority) {
  // priority: quanto maior, menos chance de “ceder” (mas aqui usamos simples)
  try {
    if (!img) return false;

    const t = (text ?? "").toString();
    if (!t) return true;
    if (!font) return false;

    const { w, h, padX, padY } = estimateLabelSize(t);

    // escolhe posição inicial (clamp + alternativas)
    let { x: bx, y: by } = chooseLabelPosition(img, desiredX, desiredY, w, h, bbox);

    // anticolisão: tenta empurrar para baixo algumas linhas se colidir
    // Observação: como desenhamos em ordem de prioridade crescente, os “importantes” vêm por último
    // e normalmente serão os que ficam por cima, reduzindo conflito visual.
    if (Array.isArray(occupiedRects)) {
      let tries = 0;
      const maxTries = 8;
      const stepY = h + 4;

      while (tries < maxTries) {
        const candidate = { x: bx, y: by, w, h };
        const hit = occupiedRects.some((r) => rectsIntersect(candidate, r));
        if (!hit) break;

        // desloca para baixo (mantém clamp)
        by = clamp(by + stepY, 0, Math.max(0, (img.bitmap.height ?? 0) - h - 1));
        tries++;
      }
    }

    // registra área ocupada
    if (Array.isArray(occupiedRects)) {
      occupiedRects.push({ x: bx, y: by, w, h, p: priority });
    }

    // placa + texto (forçada opaca para garantir visibilidade no JPEG)
    const bgColor = 0x000000ff;
    fillRect(img, bx, by, w, h, bgColor);

    const tx = Math.floor(bx + padX);
    const ty = Math.floor(by + padY);

    const printed = await safePrint(img, font, tx, ty, t);

    // Se não conseguiu imprimir texto, deixa marcador VISÍVEL dentro da placa
    // (para não parecer "placa vazia" e para diagnóstico factual no stream)
    if (!printed) {
      // tarja branca no meio
      const white = 0xffffffff;
      const midY = Math.floor(by + (h / 2));
      fillRect(img, bx + 3, midY, Math.max(1, w - 6), 3, white);

      // X vermelho no canto superior esquerdo da placa
      const red = 0xff0000ff;
      const diag = Math.min(18, Math.max(6, Math.floor(Math.min(w, h) / 2)));
      for (let i = 0; i < diag; i++) {
        img.setPixelColor(red, bx + 4 + i, by + 4 + i);
        img.setPixelColor(red, bx + 4 + (diag - i), by + 4 + i);
      }
    }

    return true;

  } catch (_) {
    return false;
  }
}


// Desenha placa + texto (best-effort, nunca derruba o overlay)
async function drawLabelWithBg(img, font, x, y, text) {
  try {
    if (!img) return false;

    const t = (text ?? "").toString();
    if (!t) return true; // nada a imprimir

    // Se não tem fonte, não imprime texto, mas também não quebra
    if (!font) return false;

    const { w, h, padX, padY } = estimateLabelSize(t);

    // Clamp para não “sair” do frame
    const imgW = img.bitmap.width;
    const imgH = img.bitmap.height;

    const bx = clamp(x, 0, Math.max(0, imgW - w - 1));
    const by = clamp(y, 0, Math.max(0, imgH - h - 1));

    // Placa (preta opaca) — garante visibilidade no JPEG
    const bgColor = 0x000000ff;

    fillRect(img, bx, by, w, h, bgColor);

    // Texto por cima
    const tx = Math.floor(bx + padX);
    const ty = Math.floor(by + padY);

    const printed = await safePrint(img, font, tx, ty, t);

    // Se não conseguiu imprimir texto, deixa um marcador visual (prova factual)
    // para não parecer “placa vazia” sem saber se foi bug do print.
    if (!printed) {
      // tarja branca fina no meio da placa
      const white = 0xffffffff;
      const midY = Math.floor(by + (h / 2));
      fillRect(img, bx + 2, midY, Math.max(1, w - 4), 3, white);
    }

    return true;

  } catch (_) {
    return false;
  }
}


// ✅ Helper compatível para criar imagem "em branco" (Jimp varia por versão)
function createBlankImage(width, height, background = 0x000000ff) {
  // 1) Algumas versões expõem Jimp.create(w, h, bg)
  if (Jimp && typeof Jimp.create === "function") {
    return Jimp.create(width, height, background);
  }

  // 2) Outras versões aceitam new Jimp({ width, height, background })
  try {
    return new Jimp({ width, height, background });
  } catch (_) {}

  // 3) Outras aceitam new Jimp(w, h, bg)
  try {
    return new Jimp(width, height, background);
  } catch (_) {}

  throw new Error("createBlankImage: API do Jimp incompatível para criar bitmap vazio.");
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
// 🔤 DEBUG DE FONTE DO OVERLAY
// GET /api/monitoramento-public/__overlay-font-debug
// ============================================================================
// Mostra: path resolvido, existência dos arquivos e status do cache em runtime
router.get("/__overlay-font-debug", async (req, res) => {
  const fontPath = resolveBmFontPath();

  let fntExists = false;
  let pngExists = false;

  try {
    if (fontPath) {
      fntExists = fileExists(fontPath);

      // tenta inferir PNG referenciada dentro do .fnt
      try {
        const raw = fs.readFileSync(fontPath, "utf-8");
        const pngName = getBmFontReferencedPngName(raw);
        if (pngName) {
          const pngPath = path.join(path.dirname(fontPath), pngName);
          pngExists = fileExists(pngPath);
        }
      } catch (_) {}
    }
  } catch (_) {}

  // ✅ opcional: força carregar a fonte (para diagnóstico factual)
  const wantLoad = String(req.query.load || "") === "1";

  let loadedNow = false;
  let loadError = null;
  let usedFallback = false;

  if (wantLoad && fontPath) {
    try {
      // tenta BMFont
      const f = await Jimp.loadFont(fontPath);
      if (!f) throw new Error("Jimp.loadFont(BMFont) retornou vazio/falsy.");
      CACHED_FONT = f;
      loadedNow = true;
    } catch (e1) {
      // tenta fallback embutido do Jimp
      try {
        const fallback = Jimp?.FONT_SANS_16_WHITE || jimpPkg?.FONT_SANS_16_WHITE;
        if (!fallback) throw new Error("Fallback FONT_SANS_16_WHITE indisponível.");
        const f2 = await Jimp.loadFont(fallback);
        if (!f2) throw new Error("Jimp.loadFont(fallback) retornou vazio/falsy.");
        CACHED_FONT = f2;
        loadedNow = true;
        usedFallback = true;
      } catch (e2) {
        loadError = `${e1?.message || e1} | fallback: ${e2?.message || e2}`;
        CACHED_FONT = null;
      }
    }
  }

  return res.json({
    ok: true,
    resolvedFontPath: fontPath,
    fntExists,
    referencedPngExists: pngExists,
    cachedFontLoaded: !!CACHED_FONT,
    loadAttempted: wantLoad,
    loadedNow,
    usedFallback,
    loadError,
  });
});












// (removido) bloco duplicado/solto após __overlay-font-debug — causava "Illegal return statement"


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
    const framePath = path.join(basePath, "frame.jpg");

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

    // ✅ Fallback: se width/height vierem 0, tenta inferir do frame.jpg (diagnóstico confiável)
    let width = Number(data?.width || 0);
    let height = Number(data?.height || 0);

    if ((!width || !height) && fileExists(framePath)) {
      try {
        const img = await Jimp.read(framePath);
        width = Number(img?.bitmap?.width || 0);
        height = Number(img?.bitmap?.height || 0);
      } catch (e) {
        // não quebra o endpoint; apenas mantém 0/0
      }
    }

    return res.json({
      ok: true,
      faces: Array.isArray(data?.faces) ? data.faces : [],
      width,
      height,
      escola_dir,
      camera_id: Number(cameraId),
      sources: {
        facesJson: facesPath,
        frameJpg: fileExists(framePath) ? framePath : null,
      },
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
// 🖼️ ROTA: retorna o frame BASE (sem overlay) — ETAPA 1 (prova canônica)
// GET /api/monitoramento-public/camera/:cameraId/frame?escola_dir=CEF04_PLAN&live=1
// ============================================================================
router.get("/camera/:cameraId/frame", async (req, res) => {
  try {
    const { cameraId } = req.params;
    const { escola_dir = "", live } = req.query;

    const basePath = pJoin(
      "uploads",
      escola_dir,
      "monitoramento",
      `camera-0${cameraId}`
    );

    const framePath = path.join(basePath, "frame.jpg");

    if (!fileExists(basePath)) {
      return res.status(404).json({
        ok: false,
        stage: "frameBasePath",
        message: "Diretório base não encontrado.",
        basePath,
      });
    }

    if (!fileExists(framePath)) {
      return res.status(404).json({
        ok: false,
        stage: "frameCheck",
        message: "Frame base não encontrado.",
        framePath,
      });
    }

    if (live) res.set("Cache-Control", "no-cache, no-store, must-revalidate");
    res.setHeader("Content-Type", "image/jpeg");

    const stream = fs.createReadStream(framePath);
    stream.on("error", (err) => {
      console.error("[frame-base] Erro ao ler frame:", err);
      return res.status(500).json({
        ok: false,
        stage: "frameStream",
        message: "Erro ao carregar frame base.",
      });
    });

    return stream.pipe(res);
  } catch (err) {
    console.error("[frame-base] Falha geral:", err);
    return res.status(500).json({
      ok: false,
      stage: "frameCatch",
      message: "Falha geral ao retornar frame base.",
      error: err?.message,
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

    const labelsEnabled = String(req.query.labels || "1") === "1";

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

    let faces = facesData?.faces ?? [];

    // ✅ ETAPA 3: simular bounding boxes (independente do faces.json)
    const simulateRaw = String(req.query.simulate || "");
    const simulate = (simulateRaw === "1" || simulateRaw === "2" || simulateRaw === "cluster");

    if (simulate) {
      const imgW = image?.bitmap?.width ?? facesData?.width ?? 0;
      const imgH = image?.bitmap?.height ?? facesData?.height ?? 0;

      const mode = (simulateRaw === "2" || simulateRaw === "cluster") ? "cluster" : "default";
      faces = buildSimulatedFaces(imgW, imgH, mode);
    }

    // --- (5) Tipografia/estilos ----------------------------------------------
    stageCtx.stage = "loadFont";
    // ✅ Fonte local explícita (BMFont gerada manualmente)
    let font = null;
    try {
      const fontPath = resolveBmFontPath();

      if (!fontPath) {
        throw new Error(
          "BMFont não encontrada. Verifique assets/fonts/open-sans-16-white.fnt (cwd raiz ou apps/educa-backend)."
        );
      }

      console.log("[frame-overlay] Carregando fonte (BMFont):", fontPath);
      font = await Jimp.loadFont(fontPath);

    } catch (e1) {
      // ✅ Fallback 1: fonte embutida do Jimp (quando disponível)
      try {
        const fallback = Jimp?.FONT_SANS_16_WHITE || jimpPkg?.FONT_SANS_16_WHITE;
        if (fallback) {
          console.warn("[frame-overlay] BMFont falhou, tentando fallback do Jimp:", e1?.message);
          font = await Jimp.loadFont(fallback);
        } else {
          font = null;
        }
      } catch (e2) {
        console.warn("[frame-overlay] Fonte indisponível (BMFont + fallback Jimp). Seguindo sem labels:", e2?.message);
        font = null;
      }
    }



    // --- (6) Desenhar caixas e labels ----------------------------------------
    stageCtx.stage = "drawBoxes";

    // ✅ PASSO 2.5: desenhar por prioridade (menos importante primeiro, mais importante por último)
    const facesOrdered = sortFacesByPriority(faces);
    const occupiedRects = [];

    let trackIdx = 0;

    for (const face of facesOrdered) {

      const {
        bbox: rawBbox,
        recognized = false,
        name = "DESCONHECIDO",
        score = 0,
      } = face;

      const rawBBox = normalizeBBox(rawBbox);

      // Ignora bbox inválido (evita erro no print/draw)
      if (!Number.isFinite(rawBBox.x) || !Number.isFinite(rawBBox.y) || rawBBox.width <= 0 || rawBBox.height <= 0) {
        continue;
      }

      // ✅ PASSO 4.2.1: clamp do bbox ao bitmap do frame (evita pixel fora da imagem)
      const bbox = clampBBoxToImage(
        rawBBox,
        image?.bitmap?.width,
        image?.bitmap?.height
      );

      if (!bbox) continue;

      // Cores ARGB (0xRRGGBBAA)
      const color = recognized ? 0x00ff00ff : 0xff0000ff;

      // Ajuste: desenhar bordas usando limites inclusivos (evita +1 fora)
      const x0 = Math.floor(bbox.x);
      const y0 = Math.floor(bbox.y);
      const x1 = Math.floor(bbox.x + bbox.width - 1);
      const y1 = Math.floor(bbox.y + bbox.height - 1);

      // Borda superior e inferior
      for (let x = x0; x <= x1; x++) {
        image.setPixelColor(color, x, y0);
        image.setPixelColor(color, x, y1);
      }
      // Borda esquerda e direita
      for (let y = y0; y <= y1; y++) {
        image.setPixelColor(color, x0, y);
        image.setPixelColor(color, x1, y);
      }

      // Label (opcional)
      if (labelsEnabled && font) {
      const tag = trackTagFromIndex(trackIdx++);
      const label = `${tag} ${name} (${(score * 100).toFixed(1)}%)`;

      // posição desejada: acima do bbox; se não couber, vamos tentar alternativas (helper faz clamp)
      let textX = Math.max(0, Math.floor(x0 + 4));
      let textY = Math.floor(y0 - 26);
      if (textY < 0) textY = Math.max(0, Math.floor(y0 + 4));

      const priority = getFacePriority(face);

      await drawLabelWithBgPriority(
        image,
        font,
        textX,
        textY,
        label,
        bbox,
        occupiedRects,
        priority
      );
    }

    }

    // --- (7) Resposta (live desabilita cache) ---------------------------------
    stageCtx.stage = "encodeOutput";

    if (live) res.set("Cache-Control", "no-cache, no-store, must-revalidate");

    // MIME precisa ser único neste escopo (evita "already been declared")
    const MIME_JPEG = Jimp?.MIME_JPEG || jimpPkg?.MIME_JPEG || "image/jpeg";
    res.set("Content-Type", MIME_JPEG);

    // ✅ Compatibilidade entre versões do Jimp (getBufferAsync vs getBuffer)
    let buffer;

    if (typeof image.getBufferAsync === "function") {
      buffer = await image.getBufferAsync(MIME_JPEG);
    } else if (typeof image.getBuffer === "function") {
      // Algumas versões retornam Promise; outras usam callback
      const maybePromise = image.getBuffer(MIME_JPEG);

      if (maybePromise && typeof maybePromise.then === "function") {
        buffer = await maybePromise;
      } else {
        buffer = await new Promise((resolve, reject) => {
          image.getBuffer(MIME_JPEG, (err, buf) => (err ? reject(err) : resolve(buf)));
        });
      }
    } else {
      throw new Error("Jimp buffer API indisponível (getBuffer/getBufferAsync).");
    }

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

async function drawOverlayBuffer(basePath, opts = {}) {
  const labelsEnabled = opts?.labels !== false;

  // ✅ PASSO 2.8.1 — habilita logs do safePrint somente quando debug_text=1
  const prevDebug = PRINT_DEBUG_SAFEPRINT;
  PRINT_DEBUG_SAFEPRINT = (opts?.debugText === true);

  try {
    // basePath: .../uploads/<apelido>/monitoramento/camera-0X
    const framePath = path.join(basePath, "frame.jpg");
    const facesPath = path.join(basePath, "faces.json");

  // Se não houver frame, gera um placeholder simples (500x280) informativo
  if (!fileExists(framePath)) {
    const img = await createBlankImage(500, 280, 0x000000ff);

    // texto é best-effort (não pode quebrar o stream)
    try {
      const fontPath = resolveBmFontPath();
      if (fontPath) {
        if (!CACHED_FONT) {
          console.log("[overlay-stream] Carregando fonte (placeholder):", fontPath);
          CACHED_FONT = await Jimp.loadFont(fontPath);
        }
      }
      if (CACHED_FONT) {
        await safePrint(img, CACHED_FONT, 10, 10, "Preview indisponível (frame.jpg ausente)");
        await safePrint(img, CACHED_FONT, 10, 40, path.normalize(basePath));

      }
    } catch (_) {
      // sem texto, segue
    }

    return await toJpegBuffer(img);
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

  // ✅ ETAPA 3: simular bounding boxes (independente do faces.json)
  if (opts?.simulate === true) {
    const imgW = image?.bitmap?.width ?? 0;
    const imgH = image?.bitmap?.height ?? 0;

    const mode = (opts?.simulateCluster === true) ? "cluster" : "default";
    faces = buildSimulatedFaces(imgW, imgH, mode, opts?.simTick || 0);
  }


  // ✅ PASSO 2.2.2: só carrega fonte se labels estiverem habilitados
  if (labelsEnabled && !CACHED_FONT) {
    // 1) tenta BMFont
    try {
      const fontPath = resolveBmFontPath();

      if (!fontPath) {
        throw new Error(
          "BMFont não encontrada. Verifique assets/fonts/open-sans-16-white.fnt (cwd raiz ou apps/educa-backend)."
        );
      }

      console.log("[overlay-stream] Carregando fonte (BMFont):", fontPath);
      const f = await Jimp.loadFont(fontPath);
      if (!f) throw new Error("Jimp.loadFont(BMFont) retornou vazio/falsy.");
      CACHED_FONT = f;

    } catch (e1) {
      // 2) fallback embutido do Jimp
      const fallback = Jimp?.FONT_SANS_16_WHITE || jimpPkg?.FONT_SANS_16_WHITE;
      if (fallback) {
        console.warn("[overlay-stream] BMFont falhou, tentando fallback do Jimp:", e1?.message);
        const f2 = await Jimp.loadFont(fallback);
        if (!f2) throw new Error("Jimp.loadFont(fallback) retornou vazio/falsy.");
        CACHED_FONT = f2;
      } else {
        // 3) sem fonte: não quebra o stream, só não imprime labels
        console.warn("[overlay-stream] Sem fonte disponível (BMFont + fallback). Labels serão desativados.");
        CACHED_FONT = null;
      }
    }
  }




  // ✅ DEBUG: prova factual se o print está funcionando (gera texto fixo no canto)
  if (opts?.debugText === true && labelsEnabled && CACHED_FONT) {
    try {
      // placa de debug (garante contraste)
      fillRect(image, 6, 6, 260, 54, 0x000000ff);

      let ok1 = await safePrint(image, CACHED_FONT, 14, 12, "DEBUG_TEXT_OK");
      let ok2 = await safePrint(image, CACHED_FONT, 14, 32, `tick=${opts?.simTick || 0}`);

      // Se falhou, tenta fallback embutido do Jimp (factual: ou imprime, ou não imprime)
      if (!ok1 && !ok2) {
        try {
          const fallback = Jimp?.FONT_SANS_16_WHITE || jimpPkg?.FONT_SANS_16_WHITE;
          if (fallback) {
            const f2 = await Jimp.loadFont(fallback);
            if (f2) {
              // tenta imprimir de novo
              fillRect(image, 6, 6, 260, 54, 0x000000ff);
              ok1 = await safePrint(image, f2, 14, 12, "DEBUG_TEXT_OK (fallback)");
              ok2 = await safePrint(image, f2, 14, 32, `tick=${opts?.simTick || 0}`);

              // se o fallback funcionou, troca o cache (corrige labels também)
              if (ok1 || ok2) {
                CACHED_FONT = f2;
                if (((opts?.simTick || 0) % 10) === 1) {
                  console.warn("[overlay-stream][debug_text] BMFont falhou; fallback do Jimp assumido.");
                }
              }
            }
          }
        } catch (_) {
          // ignora
        }
      }

      // Se ainda falhar, marca com X vermelho (prova visual do erro do print)
      if (!ok1 && !ok2) {
        const red = 0xff0000ff;
        for (let i = 0; i < 48; i++) {
          image.setPixelColor(red, 12 + i, 10 + i);
          image.setPixelColor(red, 60 - i, 10 + i);
        }
        if (((opts?.simTick || 0) % 10) === 1) {
          console.warn("[overlay-stream][debug_text] safePrint falhou (BMFont e fallback).");
        }
      }
    } catch (_) {
      // não quebra o stream
    }
  }








  // Desenha caixas
  // ✅ PASSO 2.5: desenhar por prioridade (menos importante primeiro, mais importante por último)
  const facesOrdered = sortFacesByPriority(faces);
  const occupiedRects = [];

  // ✅ PASSO 2.8 — tracker por camera+escola (stream)
  const tracker = getTracker(opts?.trackerKey || "");

  // ✅ PASSO 2.6 — múltiplos rostos próximos:
  // 1) desenha caixas sempre
  // 2) labels: agrupa faces próximas e empilha labels por cluster (evita sobreposição)
  const facesForLabeling = [];
  for (const face of facesOrdered) {

    const {
      bbox: rawBbox,
      recognized = false,
      name = "DESCONHECIDO",
      score = 0,
    } = face;

    const rawBBox = normalizeBBox(rawBbox);

    // Ignora bbox inválido
    if (!Number.isFinite(rawBBox.x) || !Number.isFinite(rawBBox.y) || rawBBox.width <= 0 || rawBBox.height <= 0) {
      continue;
    }

    // clamp do bbox ao bitmap
    const bbox = clampBBoxToImage(
      rawBBox,
      image?.bitmap?.width,
      image?.bitmap?.height
    );

    if (!bbox) continue;

    // guarda bbox clamped na própria face (para clusterização)
    face.__bbox_clamped = bbox;

    const color = recognized ? 0x00ff00ff : 0xff0000ff;

    // bordas
    const x0 = Math.floor(bbox.x);
    const y0 = Math.floor(bbox.y);
    const x1 = Math.floor(bbox.x + bbox.width - 1);
    const y1 = Math.floor(bbox.y + bbox.height - 1);

    for (let x = x0; x <= x1; x++) {
      image.setPixelColor(color, x, y0);
      image.setPixelColor(color, x, y1);
    }
    for (let y = y0; y <= y1; y++) {
      image.setPixelColor(color, x0, y);
      image.setPixelColor(color, x1, y);
    }

    // prepara dados para labels (não desenha aqui ainda)
    if (labelsEnabled && CACHED_FONT) {
      const label = `${name} (${(score * 100).toFixed(1)}%)`;
      const priority = getFacePriority(face);

      facesForLabeling.push({
        face,
        bbox,
        label,     // base (sem tag)
        priority,
      });
    }
  }

  // (B) Labels por cluster (evita labels batendo quando faces estão próximas)
  if (labelsEnabled && CACHED_FONT && facesForLabeling.length) {

    const nowMs = Date.now();
    const stableTags = assignStableTagsForFrame(
      tracker,
      facesForLabeling.map((x) => ({ face: x.face, bbox: x.bbox })),
      nowMs,
      90 // maxDistPx (ajustável depois)
    );

    // clusteriza com base em proximidade do bbox clamped
    const clusters = clusterFacesByProximity(
      facesForLabeling.map((x) => x.face),
      18 // padPx: ajuste fino se necessário
    );

    for (const clusterFaces of clusters) {

      // mapeia cluster -> itens de labeling
      const items = clusterFaces
        .map((f) => facesForLabeling.find((x) => x.face === f))
        .filter(Boolean);

      if (!items.length) continue;

      // bounds do cluster (união dos bbox)
      const bounds = getClusterBounds(clusterFaces);
      if (!bounds) continue;

      // (1) IDs visuais estáveis (PASSO 2.8): reutiliza tags do tracker (por frame)
      // (não re-atribui por cluster)

      // (2) mais importante primeiro no “stack”
      items.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));

      // (3) calcula tamanho do stack (heurístico) já com prefixo #X
      const sizes = items.map((it) => {
        const tag = stableTags.get(it.face) || "#?";
        const labelWithTag = `${tag} ${it.label}`;
        const s = estimateLabelSize(labelWithTag);
        return { ...s, label: labelWithTag, priority: it.priority, bbox: it.bbox };
      });

      const maxW = Math.max(...sizes.map((s) => s.w));
      const lineH = Math.max(...sizes.map((s) => s.h));
      const gap = 4;
      const totalH = (sizes.length * lineH) + ((sizes.length - 1) * gap);

      // âncora para o stack (tenta acima; senão abaixo; senão topo)
      const anchor = chooseClusterLabelAnchor(image, bounds, maxW, totalH);

      // desenha cada label empilhado
      let yCursor = anchor.y;
      for (const s of sizes) {
        await drawLabelWithBgPriority(
          image,
          CACHED_FONT,
          anchor.x,
          yCursor,
          s.label,
          s.bbox,
          occupiedRects,
          s.priority
        );
        yCursor += (lineH + gap);
      }
    }
  }

  return await toJpegBuffer(image);

  } catch (err) {
    console.error("[drawOverlayBuffer] Falha:", err?.message || err);
    throw err;
  } finally {
    // 🔒 garante que o flag de debug do safePrint não “vaze” entre requests
    PRINT_DEBUG_SAFEPRINT = prevDebug;
  }
}

router.get("/overlay/stream", async (req, res) => {
  // Parâmetros: cameraId, escola_dir, fps (opcional)
  const { escola_dir = "", cameraId = "1", fps = "2" } = req.query;

  const labelsEnabled = String(req.query.labels || "1") === "1";

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

  // Intervalo baseado no FPS (sanitizado)
  // - evita NaN/Infinity e valores extremos
  // - faixa segura para operação (1 a 5 fps)
  const fpsNum = Number(fps);
  const fpsSafe = Number.isFinite(fpsNum) ? Math.min(5, Math.max(1, fpsNum)) : 2;
  const intervalMs = Math.floor(1000 / fpsSafe);

  const pushFrame = async () => {
    try {
      const simulateRaw = String(req.query.simulate || "");
      const simulate = (simulateRaw === "1" || simulateRaw === "2" || simulateRaw === "cluster");
      const simulateCluster = (simulateRaw === "2" || simulateRaw === "cluster");

      const trackerKey = `${String(escola_dir || "")}|camera-${String(cameraId || "")}`;

      // ✅ PASSO 2.8 — simTick por stream (incremental por conexão)
      pushFrame.__tick = (pushFrame.__tick || 0) + 1;

      const buffer = await drawOverlayBuffer(basePath, {
        simulate,
        simulateCluster,
        labels: labelsEnabled,
        trackerKey,
        simTick: pushFrame.__tick,
        debugText: String(req.query.debug_text || "0") === "1",
      });

      // Escreve um "frame" no fluxo MJPEG
      res.write(`--${boundary}\r\n`);
      res.write("Content-Type: image/jpeg\r\n");
      res.write(`Content-Length: ${buffer.length}\r\n\r\n`);
      res.write(buffer);
      res.write("\r\n");

    } catch (err) {
      console.error("[overlay/stream] Falha ao gerar frame:", err);

      // ✅ Fallback ultra-robusto: sempre envia algum JPEG, com ou sem texto
      try {
        const img = await createBlankImage(500, 280, 0x000000ff);

        // tenta escrever texto, mas NÃO depende disso
        try {
          const fontPath = resolveBmFontPath();
          if (fontPath) {
            if (!CACHED_FONT) {
              console.log("[overlay-stream] Carregando fonte (fallback):", fontPath);
              CACHED_FONT = await Jimp.loadFont(fontPath);
            }
            await safePrint(img, CACHED_FONT, 10, 10, "Falha ao gerar frame do overlay");
          }
        } catch (_) {
          // sem texto, segue
        }

        const buf = await toJpegBuffer(img);

        res.write(`--${boundary}\r\n`);
        res.write("Content-Type: image/jpeg\r\n");
        res.write(`Content-Length: ${buf.length}\r\n\r\n`);
        res.write(buf);
        res.write("\r\n");
      } catch (e2) {
        // último recurso: encerra conexão com log (evita “carregando infinito” silencioso)
        console.error("[overlay/stream] Fallback também falhou:", e2?.message);
        try { res.end(); } catch (_) {}
      }
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
