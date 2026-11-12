// modules/questoes-ai/smartMediaEngine.js
// EDUCA.STUDIO AI — Smart Media Engine
// Dá status independente às imagens de questões: auto-crop espacial, trim de bordas,
// filtro "Scanner Clean" para fotos de livros/provas e preset inteligente de escala/DPI.

import crypto from 'crypto';
import sharp from 'sharp';
import { uploadFileBufferToSpaces } from '../../storage/spacesUpload.js';

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

/**
 * Classifica o preset ideal de largura da figura na questão com base na geometria real.
 * - 'P'    (35% largura): moléculas compactas, ícones geométricos, figuras verticais estreitas
 * - 'M'    (55% largura): gráficos cartesianos, mapas médios, circuitos, charges padrão
 * - 'G'    (82% largura): tirinhas horizontais de 2–3 quadros, diagramas largos (ex: pista dupla)
 * - '100%' (largura total): tirinhas panorâmicas longas (4+ quadros), linhas do tempo extensas
 */
export function calcularPresetGeometria(width, height) {
  if (!width || !height) return 'M';
  const ratio = width / height;

  if (ratio >= 3.0) return '100%';
  if (ratio >= 2.05) return 'G';
  if (ratio <= 0.68) return 'P';
  if (width <= 380 && height <= 380 && ratio >= 0.72 && ratio <= 1.45) return 'P';
  return 'M';
}

/**
 * Avalia nitidez/densidade de pixels para impressão escolar A4 (300 DPI).
 */
export function calcularStatusNitidez(width, height) {
  const maxDim = Math.max(width || 0, height || 0);
  const minDim = Math.min(width || 0, height || 0);
  if (maxDim >= 520 && minDim >= 160) return 'alta';
  if (maxDim >= 260 && minDim >= 95) return 'media';
  return 'baixa';
}

/**
 * Baixa de forma segura apenas imagens hospedadas no DO Spaces / CDN confiável.
 */
export async function baixarImagemSegura(sourceUrl) {
  const clean = String(sourceUrl || '').trim();
  if (!/^https:\/\/[a-z0-9.-]*digitaloceanspaces\.com\//i.test(clean)) {
    throw new Error('URL de origem inválida para reprocessamento.');
  }
  const resp = await fetch(clean, { signal: AbortSignal.timeout(15000) });
  if (!resp.ok) {
    throw new Error(`Falha ao carregar imagem original (${resp.status}).`);
  }
  const arr = await resp.arrayBuffer();
  return Buffer.from(arr);
}

/**
 * Processa um buffer de imagem e publica no DO Spaces retornando o objeto `midia` completo.
 *
 * @param {Buffer} inputBuffer
 * @param {Object} opts
 * @param {number[]|null} [opts.bbox] - [ymin, xmin, ymax, xmax] normalizado 0..1000
 * @param {boolean} [opts.autoTrim=true] - Remove margens brancas mortas ao redor da figura
 * @param {boolean} [opts.scannerClean=false] - Limpa fundo acinzentado de foto de livro/celular
 * @param {boolean} [opts.keepOriginal=false] - Salva também o print completo para re-crop futuro
 * @param {string|null} [opts.existingOriginalUrl=null] - Reaproveita URL original já salva
 * @param {string} [opts.posicao='entre_enunciado_e_comando']
 * @param {string|null} [opts.presetOverride=null]
 * @param {string} [opts.alinhamento='center']
 * @param {string} [opts.legenda='']
 * @param {string} [opts.credito='']
 */
export async function processarMidiaQuestao(inputBuffer, opts = {}) {
  const {
    bbox = null,
    autoTrim = true,
    scannerClean = false,
    keepOriginal = false,
    existingOriginalUrl = null,
    posicao = 'entre_enunciado_e_comando',
    presetOverride = null,
    alinhamento = 'center',
    legenda = '',
    credito = '',
  } = opts;

  // 1) Normaliza rotação EXIF do buffer base
  const normalizedBuf = await sharp(inputBuffer, { failOnError: false })
    .rotate()
    .toBuffer();

  const baseMeta = await sharp(normalizedBuf).metadata();
  const origW = baseMeta.width || 800;
  const origH = baseMeta.height || 600;

  // 2) Se solicitado (clonagem de print), salva o print original completo p/ permitir re-crop manual
  let originalUrl = existingOriginalUrl || null;
  if (keepOriginal && !originalUrl) {
    const origJpg = await sharp(normalizedBuf)
      .flatten({ background: '#ffffff' })
      .resize({ width: 1800, height: 1800, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 88, mozjpeg: true })
      .toBuffer();
    const tsOrig = Date.now();
    const randOrig = crypto.randomBytes(4).toString('hex');
    const upOrig = await uploadFileBufferToSpaces({
      buffer: origJpg,
      contentType: 'image/jpeg',
      objectKey: `uploads/questoes/orig_${tsOrig}_${randOrig}.jpg`,
      cacheControl: 'public, max-age=31536000',
    });
    originalUrl = upOrig.publicUrl;
  }

  // 3) Recorte espacial (Bounding Box 0..1000) quando houver figura dentro de um print de questão
  let workBuf = normalizedBuf;
  let appliedBbox = null;

  if (Array.isArray(bbox) && bbox.length === 4) {
    const [rawYmin, rawXmin, rawYmax, rawXmax] = bbox.map(Number);
    if (
      Number.isFinite(rawYmin) && Number.isFinite(rawXmin) &&
      Number.isFinite(rawYmax) && Number.isFinite(rawXmax) &&
      rawYmax - rawYmin >= 18 && rawXmax - rawXmin >= 18
    ) {
      // Margem de respiro sutil (1%) para não cortar rótulos de eixos/setas na borda
      const padY = 8;
      const padX = 8;
      const ymin = clamp(rawYmin - padY, 0, 990);
      const xmin = clamp(rawXmin - padX, 0, 990);
      const ymax = clamp(rawYmax + padY, ymin + 15, 1000);
      const xmax = clamp(rawXmax + padX, xmin + 15, 1000);

      const left = Math.round((xmin / 1000) * origW);
      const top = Math.round((ymin / 1000) * origH);
      const width = clamp(Math.round(((xmax - xmin) / 1000) * origW), 16, origW - left);
      const height = clamp(Math.round(((ymax - ymin) / 1000) * origH), 16, origH - top);

      workBuf = await sharp(normalizedBuf)
        .extract({ left, top, width, height })
        .toBuffer();
      appliedBbox = [Math.round(ymin), Math.round(xmin), Math.round(ymax), Math.round(xmax)];
    }
  }

  // 4) Achata transparência para branco editorial (#FFFFFF)
  workBuf = await sharp(workBuf)
    .flatten({ background: '#ffffff' })
    .toBuffer();

  // 5) Filtro "Scanner Clean" (remove fundo cinza/amarelado de fotos de papel e realça traços)
  if (scannerClean) {
    workBuf = await sharp(workBuf)
      .normalise()
      .linear(1.24, -22)
      .sharpen({ sigma: 0.85 })
      .toBuffer();
  }

  // 6) Auto-trim de margens brancas excessivas + respiro limpo de 8px
  if (autoTrim) {
    try {
      const trimmed = await sharp(workBuf)
        .trim({ threshold: 18 })
        .extend({
          top: 8, bottom: 8, left: 8, right: 8,
          background: { r: 255, g: 255, b: 255 },
        })
        .toBuffer();
      const tMeta = await sharp(trimmed).metadata();
      if ((tMeta.width || 0) >= 24 && (tMeta.height || 0) >= 24) {
        workBuf = trimmed;
      }
    } catch {
      // Se a imagem for uniforme ou não puder sofrer trim, mantém o buffer intacto
    }
  }

  // 7) Redimensionamento de alta definição sem estourar imagens pequenas + compressão Chroma 4:4:4
  const finalBuf = await sharp(workBuf)
    .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
    .sharpen({ sigma: 0.5 })
    .jpeg({ quality: 92, chromaSubsampling: '4:4:4', mozjpeg: true })
    .toBuffer();

  const finalMeta = await sharp(finalBuf).metadata();
  const finalW = finalMeta.width || origW;
  const finalH = finalMeta.height || origH;
  const aspectRatio = Number((finalW / Math.max(1, finalH)).toFixed(2));

  const ts = Date.now();
  const rand = crypto.randomBytes(4).toString('hex');
  const objectKey = `uploads/questoes/fig_${ts}_${rand}.jpg`;

  const { publicUrl } = await uploadFileBufferToSpaces({
    buffer: finalBuf,
    contentType: 'image/jpeg',
    objectKey,
    cacheControl: 'public, max-age=31536000',
  });

  const autoPreset = calcularPresetGeometria(finalW, finalH);
  const preset = ['P', 'M', 'G', '100%'].includes(presetOverride) ? presetOverride : autoPreset;
  const dpiStatus = calcularStatusNitidez(finalW, finalH);

  const midia = {
    url: publicUrl,
    original_url: originalUrl || publicUrl,
    bbox: appliedBbox,
    width: finalW,
    height: finalH,
    aspect_ratio: aspectRatio,
    preset,
    preset_auto: autoPreset,
    posicao: ['apos_texto_apoio', 'entre_enunciado_e_comando', 'abaixo_comando'].includes(posicao)
      ? posicao
      : 'entre_enunciado_e_comando',
    alinhamento: ['left', 'center', 'right'].includes(alinhamento) ? alinhamento : 'center',
    scanner_clean: Boolean(scannerClean),
    dpi_status: dpiStatus,
    legenda: String(legenda || '').trim(),
    credito: String(credito || '').trim(),
  };

  return { url: publicUrl, objectKey, midia };
}
