import fetch from "node-fetch";
import sharp from "sharp";
import { existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import pool from "../db.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function fetchImageBuffer(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const ab = await res.arrayBuffer();
    return Buffer.from(ab);
  } catch (err) {
    console.error(`[logoHelper] Error fetching image from ${url}:`, err.message);
    return null;
  }
}

export async function fetchLogoBuffer(url) {
  if (!url) return null;
  const buf = await fetchImageBuffer(url);
  if (!buf) return null;

  // Detect WebP format by magic bytes
  const isWebP = buf.length > 12 &&
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && // RIFF
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50;  // WEBP

  if (isWebP) {
    try {
      return await sharp(buf).png().toBuffer();
    } catch (e) {
      console.warn('[logoHelper] WebP→PNG conversion failed:', e.message);
      return null;
    }
  }
  return buf;
}

export async function getEscolaLogos(escolaId) {
  let logoEsqBuf = null;
  let logoDirBuf = null;

  try {
    const [logoRows] = await pool.query(
      "SELECT posicao, url_thumb, url_header FROM escola_logos WHERE escola_id=? AND ativo=1 AND posicao IN ('esquerda','direita') LIMIT 2",
      [escolaId]
    );

    const pickUrl = (row) => row?.url_thumb || row?.url_header || null;

    const leftRow = logoRows.find(l => l.posicao === 'esquerda');
    const rightRow = logoRows.find(l => l.posicao === 'direita');

    const [esq, dir] = await Promise.all([
      fetchLogoBuffer(pickUrl(leftRow)),
      fetchLogoBuffer(pickUrl(rightRow))
    ]);

    logoEsqBuf = esq;
    logoDirBuf = dir;
  } catch (err) {
    console.error("[logoHelper] Error querying escola_logos:", err);
  }

  const fallbackLeft = join(__dirname, "..", "assets", "images", "brasao-gdf.png");
  const fallbackRight = join(__dirname, "..", "assets", "images", "logo-escola-right.png");

  const logoLeft = logoEsqBuf || (existsSync(fallbackLeft) ? fallbackLeft : null);
  const logoRight = logoDirBuf || (existsSync(fallbackRight) ? fallbackRight : null);

  return {
    logoLeft,
    logoRight,
    hasLogoLeft: !!logoLeft,
    hasLogoRight: !!logoRight,
    left: logoLeft,
    right: logoRight,
    hasLeft: !!logoLeft,
    hasRight: !!logoRight
  };
}
