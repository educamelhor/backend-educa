// modules/questoes-ai/smartMediaEngine.js
// EDUCA.STUDIO AI — Smart Media Engine (v2.2 — Proportional Column-Occupancy Scale & Optical Rescue)
// Dá status independente às imagens de questões:
// - Auto-crop espacial único ou múltiplo (questões em 2 colunas / múltiplas figuras)
// - Smart Margin Rescue (resgata rótulos periféricos como R2, transmembrana e fórmulas no rodapé sem capturar texto)
// - Gutter Clamp + Despeckle (trava na calha entre colunas e remove resíduos vizinhos)
// - Costura de Quebra de Coluna com Alinhamento Óptico 1D por correlação de traços verticais
// - Escala Proporcional Relativa à Largura Útil da Coluna (evita esticar recortes pequenos para G/100%)

import crypto from 'crypto';
import sharp from 'sharp';
import { uploadFileBufferToSpaces } from '../../storage/spacesUpload.js';

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

/**
 * Classifica o preset ideal de largura da figura ('P'=36%, 'M'=56%, 'G'=84%, '100%')
 * combinando razão de aspecto com ocupação horizontal real em relação à coluna do print original.
 */
export function calcularPresetGeometria(width, height, opts = {}) {
  if (!width || !height) return 'M';
  const ratio = width / height;
  const {
    refColWidth = 0,
    composicaoLayout = 'unico',
    hasCrop = false,
  } = opts || {};

  // Painel composto lado a lado (2 colunas unificadas horizontalmente) precisa de largura editorial ampla
  if (composicaoLayout === 'horizontal') {
    return ratio >= 3.2 && width >= 720 ? '100%' : 'G';
  }

  // Quando a figura veio de um recorte sobre print/página, respeita a proporção real que ela ocupava na coluna!
  if (hasCrop && refColWidth >= 160) {
    const relW = width / refColWidth;

    // Recortes compactos (< 38% da largura útil da coluna) nunca devem ser esticados
    if (relW < 0.38 && height < refColWidth * 0.65) {
      return 'P';
    }

    // Recortes intermediários (< 62% da coluna) ficam em P ou M — nunca esticam para G (84%) só por serem baixos!
    if (relW < 0.62) {
      return ratio <= 0.68 ? 'P' : 'M';
    }

    // Figuras realmente largas na coluna original (>= 62% da largura da coluna)
    if (ratio >= 3.2 && relW >= 0.82 && width >= 640) return '100%';
    if (ratio >= 1.85) return 'G';
    if (ratio <= 0.68) return 'P';
    return 'M';
  }

  // Upload avulso direto (sem recorte de página inteira)
  if (ratio >= 3.4 && width >= 720) return '100%';
  if (ratio >= 1.95 && width >= 540) return 'G';
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
 * Expande de forma elástica e segura as bordas do bbox sobre o buffer RGB original para resgatar
 * rótulos periféricos cortados pelo LLM (ex: "R2" abaixo da proteína, 2ª linha "transmembrana",
 * fórmulas coladas no limite y=1000 da coluna), parando imediatamente ao encontrar corredor branco
 * largo ou linhas de parágrafo de texto do enunciado/alternativas.
 */
export function resgatarMargensInteligente(fullRgb, origW, origH, rawBox, opts = {}) {
  const {
    coluna = 'unica',
    divX = 0,
    minTopNorm = 0,
    maxBottomNorm = 1000,
    stitchTop = false,
    stitchBottom = false,
  } = opts;

  const [rawYmin, rawXmin, rawYmax, rawXmax] = rawBox.map(Number);
  const hasValidGutter = Number.isFinite(divX) && divX >= 280 && divX <= 720;

  // Limites rígidos horizontais brutos da coluna
  const rawColMinX = hasValidGutter && (coluna === 'direita' || rawXmin >= divX - 10)
    ? clamp(Math.round((divX / 1000) * origW), 0, origW - 20)
    : 0;
  const rawColMaxX = hasValidGutter && (coluna === 'esquerda' || rawXmax <= divX + 10)
    ? clamp(Math.round((divX / 1000) * origW), rawColMinX + 20, origW)
    : origW;
  const rawColW = Math.max(30, rawColMaxX - rawColMinX);

  const isInk = (x, y) => {
    const idx = (y * origW + x) * 3;
    return fullRgb[idx] < 228 || fullRgb[idx + 1] < 228 || fullRgb[idx + 2] < 228;
  };

  // Detecta e exclui molduras verticais externas da página e fios divisórios centrais de coluna
  // (linhas verticais contínuas com tinta em > 42% da altura total da página)
  let colMinX = rawColMinX;
  const maxLeftBorderScan = Math.min(rawColMaxX - 24, rawColMinX + Math.round(rawColW * 0.12));
  for (let x = rawColMinX; x <= maxLeftBorderScan; x++) {
    let darkY = 0;
    for (let y = 0; y < origH; y += 2) {
      if (isInk(x, y)) darkY++;
    }
    if (darkY > (origH / 2) * 0.44) {
      colMinX = Math.min(rawColMaxX - 24, x + 4);
    }
  }

  let colMaxX = rawColMaxX;
  const minRightBorderScan = Math.max(colMinX + 24, rawColMaxX - Math.round(rawColW * 0.12));
  for (let x = rawColMaxX - 1; x >= minRightBorderScan; x--) {
    let darkY = 0;
    for (let y = 0; y < origH; y += 2) {
      if (isInk(x, y)) darkY++;
    }
    if (darkY > (origH / 2) * 0.42) {
      colMaxX = Math.max(colMinX + 24, x - 4);
    }
  }

  const colW = Math.max(30, colMaxX - colMinX);

  // Mede onde começa a margem esquerda real dos parágrafos de texto dentro da área limpa da coluna
  let textMarginLeftX = colMinX;
  for (let x = colMinX; x < colMinX + Math.round(colW * 0.25); x++) {
    let inkRows = 0;
    for (let y = 0; y < origH; y += 2) {
      if (isInk(x, y)) inkRows++;
    }
    if (inkRows >= 10 && inkRows < (origH / 2) * 0.40) {
      textMarginLeftX = x;
      break;
    }
  }

  let topPx = clamp(Math.round((rawYmin / 1000) * origH), 0, origH - 12);
  let bottomPx = clamp(Math.round((rawYmax / 1000) * origH), topPx + 12, origH);
  let leftPx = clamp(Math.round((rawXmin / 1000) * origW), colMinX, colMaxX - 12);
  let rightPx = clamp(Math.round((rawXmax / 1000) * origW), leftPx + 12, colMaxX);

  // Caso especial: figura partida na quebra de coluna (rodapé esq -> topo dir)
  if (stitchBottom && rawYmax >= 870) {
    bottomPx = origH;
  }
  if (stitchTop && rawYmin <= 95) {
    topPx = 0;
  }

  // 1) Resgate horizontal (rótulos laterais como "transmembrana" ou borda de gravura dentro da mesma coluna)
  const maxGapX = Math.max(10, Math.round(colW * 0.026));
  const limitLeft = Math.max(colMinX, leftPx - Math.round(colW * 0.14));
  let rescuedLeft = leftPx;
  let gapL = 0;
  for (let x = leftPx - 1; x >= limitLeft; x--) {
    let ink = 0;
    for (let y = topPx; y < bottomPx; y++) {
      if (isInk(x, y)) { ink++; if (ink >= 2) break; }
    }
    if (ink >= 2) {
      rescuedLeft = x;
      gapL = 0;
    } else {
      gapL++;
      if (gapL > maxGapX) break;
    }
  }
  leftPx = Math.max(colMinX, rescuedLeft - 6);

  const limitRight = Math.min(colMaxX, rightPx + Math.round(colW * 0.16));
  let rescuedRight = rightPx;
  let gapR = 0;
  for (let x = rightPx; x < limitRight; x++) {
    let ink = 0;
    for (let y = topPx; y < bottomPx; y++) {
      if (isInk(x, y)) { ink++; if (ink >= 2) break; }
    }
    if (ink >= 2) {
      rescuedRight = x + 1;
      gapR = 0;
    } else {
      gapR++;
      if (gapR > maxGapX) break;
    }
  }
  rightPx = Math.min(colMaxX, rescuedRight + 6);

  // Helper para agrupar linhas horizontais de tinta em bandas na área útil da coluna (sem molduras externas)
  const scanVerticalBands = (yFrom, yTo, step) => {
    const xScanMin = colMinX;
    const xScanMax = colMaxX;
    const rows = [];
    for (let y = yFrom; step > 0 ? y < yTo : y >= yTo; y += step) {
      let ink = 0;
      let minX = xScanMax;
      let maxX = xScanMin;
      for (let x = xScanMin; x < xScanMax; x++) {
        if (isInk(x, y)) {
          ink++;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
        }
      }
      rows.push({ y, hasInk: ink >= 2, minX, maxX });
    }

    const bands = [];
    let cur = null;
    let smallEmpty = 0;
    for (const r of rows) {
      if (r.hasInk) {
        if (!cur) {
          cur = { startY: r.y, endY: r.y, minX: r.minX, maxX: r.maxX };
        } else {
          cur.endY = r.y;
          if (r.minX < cur.minX) cur.minX = r.minX;
          if (r.maxX > cur.maxX) cur.maxX = r.maxX;
        }
        smallEmpty = 0;
      } else if (cur) {
        smallEmpty++;
        if (smallEmpty >= 4) {
          bands.push(cur);
          cur = null;
          smallEmpty = 0;
        }
      }
    }
    if (cur) bands.push(cur);
    return bands;
  };

  const maxTextLineH = Math.max(24, Math.round(origH * 0.024));

  // 2) Resgate inferior (ex: metade inferior de gravura cortada, legenda de fonte ou "R2"/"transmembrana")
  if (!(stitchBottom && rawYmax >= 870)) {
    const hardBottomPx = clamp(Math.round((maxBottomNorm / 1000) * origH), bottomPx, origH);
    const limitBottom = Math.min(hardBottomPx, bottomPx + Math.round(origH * 0.24));
    if (limitBottom > bottomPx + 2) {
      const downBands = scanVerticalBands(bottomPx, limitBottom, 1);
      let curBottom = bottomPx;
      const connectedGapMax = Math.max(8, Math.round(origH * 0.014));
      const labelGapMax = Math.max(15, Math.round(origH * 0.024));

      for (const b of downBands) {
        const gap = b.startY - curBottom;
        const bandH = Math.abs(b.endY - b.startY) + 1;
        const span = b.maxX - b.minX;
        const isContinuousGraphic = gap <= 2 || (bandH > maxTextLineH && gap <= connectedGapMax);

        if (isContinuousGraphic) {
          curBottom = b.endY + 1;
          leftPx = Math.max(colMinX, Math.min(leftPx, b.minX - 6));
          rightPx = Math.min(colMaxX, Math.max(rightPx, b.maxX + 6));
          continue;
        }

        const startsAtLeftMargin = (b.minX - textMarginLeftX) < colW * 0.08;
        const looksLikeBodyParagraph = startsAtLeftMargin && (span > colW * 0.46 || gap >= connectedGapMax);

        if (looksLikeBodyParagraph) break;

        if (gap <= connectedGapMax && span < colW * 0.78) {
          curBottom = b.endY + 1;
          leftPx = Math.max(colMinX, Math.min(leftPx, b.minX - 6));
          rightPx = Math.min(colMaxX, Math.max(rightPx, b.maxX + 6));
        } else if (gap <= labelGapMax && span < colW * 0.42 && !startsAtLeftMargin) {
          curBottom = b.endY + 1;
          leftPx = Math.max(colMinX, Math.min(leftPx, b.minX - 6));
          rightPx = Math.min(colMaxX, Math.max(rightPx, b.maxX + 6));
        } else {
          break;
        }
      }
      bottomPx = Math.min(hardBottomPx, curBottom + (stitchBottom ? 1 : 6));
    }
  }

  // 3) Resgate superior (ex: gravura/charge cujo ymin começou no meio da imagem, ou rótulo "R1" no topo)
  if (!(stitchTop && rawYmin <= 95)) {
    const hardTopPx = clamp(Math.round((minTopNorm / 1000) * origH), 0, topPx);
    const limitTop = Math.max(hardTopPx, topPx - Math.round(origH * 0.34));
    if (topPx - limitTop > 2) {
      const upBands = scanVerticalBands(topPx - 1, limitTop, -1);
      let curTop = topPx;
      const connectedGapMax = Math.max(8, Math.round(origH * 0.014));
      const labelGapMax = Math.max(14, Math.round(origH * 0.022));

      for (const b of upBands) {
        // No sentido reverso (step = -1), b.startY >= b.endY
        const gap = curTop - 1 - b.startY;
        const bandH = Math.abs(b.startY - b.endY) + 1;
        const span = b.maxX - b.minX;
        const isContinuousGraphic = gap <= 2 || (bandH > maxTextLineH && gap <= connectedGapMax);

        if (isContinuousGraphic) {
          curTop = b.endY;
          leftPx = Math.max(colMinX, Math.min(leftPx, b.minX - 6));
          rightPx = Math.min(colMaxX, Math.max(rightPx, b.maxX + 6));
          continue;
        }

        const startsAtLeftMargin = (b.minX - textMarginLeftX) < colW * 0.08;
        const looksLikeBodyParagraph = startsAtLeftMargin && (span > colW * 0.46 || gap >= connectedGapMax);

        if (looksLikeBodyParagraph) break;

        if (gap <= connectedGapMax && span < colW * 0.78) {
          curTop = b.endY;
          leftPx = Math.max(colMinX, Math.min(leftPx, b.minX - 6));
          rightPx = Math.min(colMaxX, Math.max(rightPx, b.maxX + 6));
        } else if (gap <= labelGapMax && span < colW * 0.42 && !startsAtLeftMargin) {
          curTop = b.endY;
          leftPx = Math.max(colMinX, Math.min(leftPx, b.minX - 6));
          rightPx = Math.min(colMaxX, Math.max(rightPx, b.maxX + 6));
        } else {
          break;
        }
      }
      topPx = Math.max(hardTopPx, curTop - (stitchTop ? 1 : 6));
    }
  }

  // Encontra o primeiro pixel real de tinta dentro da área resgatada (âncora p/ alinhamento entre colunas)
  let firstInkOrigX = leftPx;
  outerInk: for (let x = leftPx; x < rightPx; x++) {
    let cnt = 0;
    for (let y = topPx; y < bottomPx; y++) {
      if (isInk(x, y)) {
        cnt++;
        if (cnt >= 2) {
          firstInkOrigX = x;
          break outerInk;
        }
      }
    }
  }

  return {
    left: clamp(leftPx, 0, origW - 12),
    top: clamp(topPx, 0, origH - 12),
    width: clamp(rightPx - leftPx, 12, origW - leftPx),
    height: clamp(bottomPx - topPx, 12, origH - topPx),
    firstInkOrigX,
    normBbox: [
      clamp(Math.round((topPx / origH) * 1000), 0, 995),
      clamp(Math.round((leftPx / origW) * 1000), 0, 995),
      clamp(Math.round((bottomPx / origH) * 1000), 5, 1000),
      clamp(Math.round((rightPx / origW) * 1000), 5, 1000),
    ],
  };
}

/**
 * Mede a coordenada X onde se inicia a margem esquerda do texto de uma coluna [xStart..xEnd).
 */
function medirMargemEsquerdaColuna(fullRgb, origW, origH, xStart, xEnd) {
  for (let x = Math.max(0, xStart); x < Math.min(origW, xEnd); x++) {
    let darkRows = 0;
    for (let y = 0; y < origH; y++) {
      const idx = (y * origW + x) * 3;
      if (fullRgb[idx] < 200 || fullRgb[idx + 1] < 200 || fullRgb[idx + 2] < 200) {
        darkRows++;
        if (darkRows >= 8) return x;
      }
    }
  }
  return xStart;
}

/**
 * Mede a largura útil horizontal real ocupada pelo bloco de texto/conteúdo de uma coluna [xStart..xEnd),
 * descontando margens brancas laterais de prints largos de navegador/Word.
 */
function medirLarguraUtilColuna(fullRgb, origW, origH, xStart, xEnd) {
  const s = Math.max(0, xStart);
  const e = Math.min(origW, xEnd);
  if (e - s < 160) return Math.max(160, e - s);

  const leftEdge = medirMargemEsquerdaColuna(fullRgb, origW, origH, s, e);
  let rightEdge = e - 1;
  for (let x = e - 1; x > leftEdge; x--) {
    let darkRows = 0;
    for (let y = 0; y < origH; y++) {
      const idx = (y * origW + x) * 3;
      if (fullRgb[idx] < 200 || fullRgb[idx + 1] < 200 || fullRgb[idx + 2] < 200) {
        darkRows++;
        if (darkRows >= 8) {
          rightEdge = x;
          x = leftEdge; // encerra varredura externa
          break;
        }
      }
    }
  }

  const span = rightEdge - leftEdge;
  return span >= 140 ? span : Math.max(180, e - s);
}

/**
 * Remove artefatos isolados de texto vizinho que tenham encostado nos primeiros pixels
 * da borda do recorte, preservando molduras contínuas legítimas de tabelas/tirinhas.
 */
async function limparArtefatosMargem(buf) {
  try {
    const { data, info } = await sharp(buf)
      .flatten({ background: '#ffffff' })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const W = info.width;
    const H = info.height;
    if (W < 60 || H < 60 || info.channels !== 3) return buf;

    const isInk = (x, y) => {
      const idx = (y * W + x) * 3;
      return data[idx] < 228 || data[idx + 1] < 228 || data[idx + 2] < 228;
    };

    let modified = false;
    const maxColScan = Math.min(48, Math.floor(W * 0.12));
    const colInkCount = new Int32Array(W);
    const colMaxRun = new Int32Array(W);

    const computeColStats = (x) => {
      let count = 0;
      let run = 0;
      let maxRun = 0;
      for (let y = 0; y < H; y++) {
        if (isInk(x, y)) {
          count++;
          run++;
          if (run > maxRun) maxRun = run;
        } else {
          run = 0;
        }
      }
      colInkCount[x] = count;
      colMaxRun[x] = maxRun;
    };

    // Margem esquerda
    for (let x = 0; x < maxColScan; x++) computeColStats(x);
    let leftSliverEnd = -1;
    let leftGapLen = 0;
    for (let x = 0; x < maxColScan; x++) {
      if (colInkCount[x] <= 1) {
        if (leftSliverEnd >= 0) leftGapLen++;
      } else {
        if (leftGapLen >= 9) break;
        leftSliverEnd = x;
        leftGapLen = 0;
      }
    }
    if (leftSliverEnd >= 0 && leftSliverEnd <= Math.min(18, Math.floor(W * 0.05)) && leftGapLen >= 9) {
      let maxCoverage = 0;
      let longestRun = 0;
      for (let x = 0; x <= leftSliverEnd; x++) {
        if (colInkCount[x] > maxCoverage) maxCoverage = colInkCount[x];
        if (colMaxRun[x] > longestRun) longestRun = colMaxRun[x];
      }
      if (maxCoverage < H * 0.28 && longestRun < 28) {
        for (let y = 0; y < H; y++) {
          for (let x = 0; x <= leftSliverEnd + 1; x++) {
            const idx = (y * W + x) * 3;
            data[idx] = 255; data[idx + 1] = 255; data[idx + 2] = 255;
          }
        }
        modified = true;
      }
    }

    // Margem direita
    for (let x = W - 1; x >= W - maxColScan; x--) computeColStats(x);
    let rightSliverStart = -1;
    let rightGapLen = 0;
    for (let x = W - 1; x >= W - maxColScan; x--) {
      if (colInkCount[x] <= 1) {
        if (rightSliverStart >= 0) rightGapLen++;
      } else {
        if (rightGapLen >= 9) break;
        rightSliverStart = x;
        rightGapLen = 0;
      }
    }
    if (rightSliverStart >= 0 && (W - 1 - rightSliverStart) <= Math.min(18, Math.floor(W * 0.05)) && rightGapLen >= 9) {
      let maxCoverage = 0;
      let longestRun = 0;
      for (let x = rightSliverStart; x < W; x++) {
        if (colInkCount[x] > maxCoverage) maxCoverage = colInkCount[x];
        if (colMaxRun[x] > longestRun) longestRun = colMaxRun[x];
      }
      if (maxCoverage < H * 0.28 && longestRun < 28) {
        for (let y = 0; y < H; y++) {
          for (let x = rightSliverStart - 1; x < W; x++) {
            const idx = (y * W + x) * 3;
            data[idx] = 255; data[idx + 1] = 255; data[idx + 2] = 255;
          }
        }
        modified = true;
      }
    }

    if (!modified) return buf;
    return await sharp(data, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
  } catch {
    return buf;
  }
}

/**
 * Extrai e limpa individualmente um único recorte (bbox) com Smart Margin Rescue + Gutter Clamp.
 */
async function extrairBlocoIndividual(
  normalizedBuf,
  fullRgb,
  origW,
  origH,
  spec,
  { scannerClean = false, autoTrim = true, tightTop = false, tightBottom = false, minTopNorm = 0, maxBottomNorm = 1000 }
) {
  let workBuf = normalizedBuf;
  let appliedBbox = null;
  let firstInkOrigX = 0;

  const rawBox = Array.isArray(spec?.bbox) ? spec.bbox : (Array.isArray(spec) ? spec : null);
  const coluna = spec?.coluna || 'unica';
  const divX = Number(spec?.coluna_divisao_x || 0);

  if (Array.isArray(rawBox) && rawBox.length === 4) {
    const [rawYmin, rawXmin, rawYmax, rawXmax] = rawBox.map(Number);
    if (
      Number.isFinite(rawYmin) && Number.isFinite(rawXmin) &&
      Number.isFinite(rawYmax) && Number.isFinite(rawXmax) &&
      rawYmax - rawYmin >= 14 && rawXmax - rawXmin >= 14
    ) {
      const rescued = resgatarMargensInteligente(fullRgb, origW, origH, [rawYmin, rawXmin, rawYmax, rawXmax], {
        coluna,
        divX,
        minTopNorm,
        maxBottomNorm,
        stitchTop: tightTop,
        stitchBottom: tightBottom,
      });

      workBuf = await sharp(normalizedBuf)
        .extract({ left: rescued.left, top: rescued.top, width: rescued.width, height: rescued.height })
        .toBuffer();
      appliedBbox = rescued.normBbox;
      firstInkOrigX = rescued.firstInkOrigX;
    }
  }

  workBuf = await sharp(workBuf)
    .flatten({ background: '#ffffff' })
    .toBuffer();

  if (scannerClean) {
    workBuf = await sharp(workBuf)
      .normalise()
      .linear(1.24, -22)
      .sharpen({ sigma: 0.85 })
      .toBuffer();
  }

  if (appliedBbox) {
    workBuf = await limparArtefatosMargem(workBuf);
  }

  if (autoTrim) {
    try {
      const trimmed = await sharp(workBuf)
        .trim({ threshold: 18 })
        .extend({
          top: tightTop ? 2 : 8,
          bottom: tightBottom ? 2 : 8,
          left: 8,
          right: 8,
          background: { r: 255, g: 255, b: 255 },
        })
        .toBuffer();
      const tMeta = await sharp(trimmed).metadata();
      if ((tMeta.width || 0) >= 20 && (tMeta.height || 0) >= 14) {
        workBuf = trimmed;
      }
    } catch {
      // Mantém buffer intacto caso imagem uniforme
    }
  }

  const meta = await sharp(workBuf).metadata();
  return {
    buf: workBuf,
    w: meta.width || 200,
    h: meta.height || 200,
    appliedBbox,
    firstInkOrigX,
    continuacao: Boolean(spec?.continuacao || spec?.continuacao_quebra_coluna),
  };
}

/**
 * Calcula o deslocamento horizontal ótimo (dx = leftBot - leftTop) combinando a âncora geométrica
 * da margem da coluna original (priorDx) com correlação fina 1D na faixa inferior de átomos/hastes.
 */
async function calcularOffsetAlinhamentoCostura(topItem, bottomItem, priorDx = null) {
  const anchorDx = Number.isFinite(priorDx) ? Math.round(priorDx) : Math.round((topItem.w - bottomItem.w) / 2);
  try {
    const topRaw = await sharp(topItem.buf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const botRaw = await sharp(bottomItem.buf).removeAlpha().raw().toBuffer({ resolveWithObject: true });

    const w1 = topRaw.info.width;
    const h1 = topRaw.info.height;
    const w2 = botRaw.info.width;
    const h2 = botRaw.info.height;

    const isDark = (buf, w, x, y) => {
      const idx = (y * w + x) * 3;
      return buf[idx] < 210 || buf[idx + 1] < 210 || buf[idx + 2] < 210;
    };

    // Projeção do topo do bottomItem (primeiros 20px): detecta hastes/ligações verticais "|"
    const botScanH = Math.min(20, Math.max(8, Math.floor(h2 * 0.24)));
    const projBot = new Float32Array(w2);
    let botEnergy = 0;
    for (let x = 1; x < w2 - 1; x++) {
      let vRun = 0;
      let maxRun = 0;
      for (let y = 0; y < botScanH; y++) {
        if (isDark(botRaw.data, w2, x, y)) {
          vRun++;
          if (vRun > maxRun) maxRun = vRun;
        } else {
          vRun = 0;
        }
      }
      if (maxRun >= 5) {
        projBot[x] = 1;
        botEnergy += 1;
      }
    }

    if (botEnergy < 3) return anchorDx;

    // Projeção APENAS dos últimos 16px do topItem (apenas a linha inferior de átomos "— N — C — C —",
    // sem alcançar as ligações superiores "| H" e "|| O") e com peso binário igual (1.0) p/ N e C!
    const topStartY = Math.max(0, h1 - 17);
    const projTop = new Float32Array(w1);
    let topEnergy = 0;
    for (let x = 1; x < w1 - 1; x++) {
      let darkCount = 0;
      for (let y = topStartY; y < h1; y++) {
        if (isDark(topRaw.data, w1, x, y)) darkCount++;
      }
      if (darkCount >= 5) {
        projTop[x] = 1;
        topEnergy += 1;
      }
    }

    if (topEnergy < 3) return anchorDx;

    const smoothTop = new Float32Array(w1);
    for (let x = 1; x < w1 - 1; x++) {
      smoothTop[x] = 0.5 * projTop[x - 1] + projTop[x] + 0.5 * projTop[x + 1];
    }

    // Quando temos priorDx medido das margens reais das duas colunas, restringe o ajuste fino a ±13px
    // (impedindo matematicamente pular +32px para o átomo vizinho!)
    const maxShift = Number.isFinite(priorDx) ? 13 : 28;
    let bestDx = anchorDx;
    let bestScore = -1;

    for (let dx = anchorDx - maxShift; dx <= anchorDx + maxShift; dx++) {
      let score = 0;
      for (let xb = 0; xb < w2; xb++) {
        if (projBot[xb] === 0) continue;
        // Em "xb + dx": como leftBot - leftTop = dx, o pixel xb do bottomItem cai em xt = xb + dx do topItem!
        const xt = xb + dx;
        if (xt >= 0 && xt < w1) {
          score += projBot[xb] * smoothTop[xt];
        }
      }
      const distPenalty = 1 - Math.abs(dx - anchorDx) * 0.004;
      const weighted = score * distPenalty;
      if (weighted > bestScore) {
        bestScore = weighted;
        bestDx = dx;
      }
    }

    return bestScore > 0 ? bestDx : anchorDx;
  } catch {
    return anchorDx;
  }
}

/**
 * Costura verticalmente duas metades de uma mesma figura/fórmula partida na quebra de coluna.
 */
async function costurarQuebraColuna(topItem, bottomItem, priorDx = null) {
  const pad = 6;
  const seamGap = 2;
  const dx = await calcularOffsetAlinhamentoCostura(topItem, bottomItem, priorDx);

  const leftTopRel = Math.max(0, -dx);
  const leftBotRel = Math.max(0, dx);
  const contentW = Math.max(leftTopRel + topItem.w, leftBotRel + bottomItem.w);

  const canvasW = contentW + pad * 2;
  const canvasH = topItem.h + bottomItem.h + seamGap + pad * 2;

  const stitchedBuf = await sharp({
    create: {
      width: canvasW,
      height: canvasH,
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
  })
    .composite([
      { input: topItem.buf, left: pad + leftTopRel, top: pad },
      { input: bottomItem.buf, left: pad + leftBotRel, top: pad + topItem.h + seamGap },
    ])
    .png()
    .toBuffer();

  return {
    buf: stitchedBuf,
    w: canvasW,
    h: canvasH,
  };
}

/**
 * Decide e compõe múltiplos blocos visuais independentes em um único painel editorial HD.
 */
async function comporPainelMultiFigura(blocos, modoPreferido = 'auto') {
  if (blocos.length === 1) {
    return { buf: blocos[0].buf, modoUsado: 'unico' };
  }

  let modo = modoPreferido;
  if (modo !== 'horizontal' && modo !== 'vertical') {
    if (blocos.length === 2) {
      const r0 = blocos[0].w / Math.max(1, blocos[0].h);
      const r1 = blocos[1].w / Math.max(1, blocos[1].h);
      modo = (r0 < 2.15 && r1 < 2.15) ? 'horizontal' : 'vertical';
    } else {
      modo = 'vertical';
    }
  }

  const pad = 10;
  if (modo === 'horizontal') {
    const gap = 28;
    const totalW = pad * 2 + blocos.reduce((s, b) => s + b.w, 0) + gap * (blocos.length - 1);
    const maxH = Math.max(...blocos.map((b) => b.h));
    const totalH = pad * 2 + maxH;

    let curX = pad;
    const layers = blocos.map((b) => {
      const layer = {
        input: b.buf,
        left: curX,
        top: pad + Math.floor((maxH - b.h) / 2),
      };
      curX += b.w + gap;
      return layer;
    });

    const out = await sharp({
      create: { width: totalW, height: totalH, channels: 3, background: { r: 255, g: 255, b: 255 } },
    })
      .composite(layers)
      .png()
      .toBuffer();

    return { buf: out, modoUsado: 'horizontal' };
  }

  // Modo vertical (empilhadas)
  const gap = 22;
  const maxW = Math.max(...blocos.map((b) => b.w));
  const totalW = pad * 2 + maxW;
  const totalH = pad * 2 + blocos.reduce((s, b) => s + b.h, 0) + gap * (blocos.length - 1);

  let curY = pad;
  const layers = blocos.map((b) => {
    const layer = {
      input: b.buf,
      left: pad + Math.floor((maxW - b.w) / 2),
      top: curY,
    };
    curY += b.h + gap;
    return layer;
  });

  const out = await sharp({
    create: { width: totalW, height: totalH, channels: 3, background: { r: 255, g: 255, b: 255 } },
  })
    .composite(layers)
    .png()
    .toBuffer();

  return { buf: out, modoUsado: 'vertical' };
}

/**
 * Publica a página inteira (PDF renderizado ou foto de folha de prova) uma única vez no DO Spaces
 * para ser compartilhada como `original_url` entre todas as questões/figuras extraídas daquela página.
 */
export async function publicarPaginaOriginalLista(inputBuffer) {
  const normalizedBuf = await sharp(inputBuffer, { failOnError: false })
    .rotate()
    .toBuffer();

  const origJpg = await sharp(normalizedBuf)
    .flatten({ background: '#ffffff' })
    .resize({ width: 1900, height: 1900, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 88, mozjpeg: true })
    .toBuffer();

  const meta = await sharp(origJpg).metadata();
  const tsOrig = Date.now();
  const randOrig = crypto.randomBytes(4).toString('hex');
  const objectKey = `uploads/questoes/pag_${tsOrig}_${randOrig}.jpg`;

  const upOrig = await uploadFileBufferToSpaces({
    buffer: origJpg,
    contentType: 'image/jpeg',
    objectKey,
    cacheControl: 'public, max-age=31536000',
  });

  return {
    paginaUrl: upOrig.publicUrl,
    objectKey,
    width: meta.width || 1200,
    height: meta.height || 1600,
  };
}

/**
 * Processa um buffer de imagem e publica no DO Spaces retornando o objeto `midia` completo.
 */
export async function processarMidiaQuestao(inputBuffer, opts = {}) {
  const {
    bbox = null,
    bboxes = null,
    composicaoLayout = 'auto',
    colunaDivisaoX = 0,
    layoutOrigem = 'coluna_unica',
    minTopNorm: globalMinTopNorm = 0,
    maxBottomNorm: globalMaxBottomNorm = 1000,
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

  // 1) Normaliza rotação EXIF e extrai buffer RGB plano p/ análise óptica de margens
  const normalizedBuf = await sharp(inputBuffer, { failOnError: false })
    .rotate()
    .toBuffer();

  const { data: fullRgb, info: rawInfo } = await sharp(normalizedBuf)
    .flatten({ background: '#ffffff' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const origW = rawInfo.width || 800;
  const origH = rawInfo.height || 600;

  // 2) Salva print original completo p/ permitir re-crop manual simples ou multi-caixa no frontend
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

  // 3) Normaliza lista de regiões a recortar (1 ou N regiões)
  const specsList = [];
  if (Array.isArray(bboxes) && bboxes.length > 0) {
    for (const item of bboxes) {
      const b = Array.isArray(item) ? item : item?.bbox;
      if (Array.isArray(b) && b.length === 4) {
        specsList.push({
          bbox: b.map(Number),
          coluna: item?.coluna || 'unica',
          coluna_divisao_x: Number(item?.coluna_divisao_x || colunaDivisaoX || 0),
          continuacao: Boolean(item?.continuacao ?? item?.continuacao_quebra_coluna),
          minTopNorm: Number.isFinite(Number(item?.minTopNorm)) ? Number(item.minTopNorm) : globalMinTopNorm,
          maxBottomNorm: Number.isFinite(Number(item?.maxBottomNorm)) ? Number(item.maxBottomNorm) : globalMaxBottomNorm,
        });
      }
    }
  } else if (Array.isArray(bbox) && bbox.length === 4) {
    specsList.push({
      bbox: bbox.map(Number),
      coluna: 'unica',
      coluna_divisao_x: Number(colunaDivisaoX || 0),
      continuacao: false,
      minTopNorm: globalMinTopNorm,
      maxBottomNorm: globalMaxBottomNorm,
    });
  }

  let workBuf = null;
  let appliedBbox = null;
  let appliedBboxes = null;
  let composicaoUsada = 'unico';

  if (specsList.length === 0) {
    const single = await extrairBlocoIndividual(normalizedBuf, fullRgb, origW, origH, null, {
      scannerClean,
      autoTrim,
    });
    workBuf = single.buf;
  } else if (specsList.length === 1) {
    const single = await extrairBlocoIndividual(normalizedBuf, fullRgb, origW, origH, specsList[0], {
      scannerClean,
      autoTrim,
      minTopNorm: specsList[0].minTopNorm ?? globalMinTopNorm,
      maxBottomNorm: specsList[0].maxBottomNorm ?? globalMaxBottomNorm,
    });
    workBuf = single.buf;
    appliedBbox = single.appliedBbox;
    if (appliedBbox) {
      appliedBboxes = [{ bbox: appliedBbox, coluna: specsList[0].coluna, continuacao: false }];
    }
  } else {
    // Heurística automática de costura em quebra de coluna: rodapé esq (ymax >= 930) + topo dir (ymin <= 110)
    for (let i = 0; i < specsList.length - 1; i++) {
      const cur = specsList[i];
      const nxt = specsList[i + 1];
      if (!nxt.continuacao && layoutOrigem === 'duas_colunas') {
        const curH = cur.bbox[2] - cur.bbox[0];
        if (cur.bbox[2] >= 925 && nxt.bbox[0] <= 115 && cur.bbox[3] <= 535 && nxt.bbox[1] >= 465 && curH <= 220) {
          nxt.continuacao = true;
        }
      }
    }

    const extraidos = [];
    for (let i = 0; i < specsList.length; i++) {
      const curSpec = specsList[i];
      const nextIsStitch = i + 1 < specsList.length && specsList[i + 1].continuacao;
      const curIsStitch = i > 0 && curSpec.continuacao;

      // Calcula teto/piso de não-invasão contra outras figuras da mesma coluna (e limites da questão na página)
      let minTopNorm = curSpec.minTopNorm ?? globalMinTopNorm;
      let maxBottomNorm = curSpec.maxBottomNorm ?? globalMaxBottomNorm;
      for (let j = 0; j < specsList.length; j++) {
        if (j === i) continue;
        const other = specsList[j];
        if (other.coluna === curSpec.coluna) {
          if (other.bbox[2] <= curSpec.bbox[0] + 15 && other.bbox[2] > minTopNorm) {
            minTopNorm = other.bbox[2];
          }
          if (other.bbox[0] >= curSpec.bbox[2] - 15 && other.bbox[0] < maxBottomNorm) {
            maxBottomNorm = other.bbox[0];
          }
        }
      }

      const item = await extrairBlocoIndividual(normalizedBuf, fullRgb, origW, origH, curSpec, {
        scannerClean,
        autoTrim,
        tightBottom: nextIsStitch,
        tightTop: curIsStitch,
        minTopNorm,
        maxBottomNorm,
      });
      extraidos.push({
        ...item,
        coluna: curSpec.coluna,
        continuacao: curIsStitch,
      });
    }

    appliedBboxes = extraidos
      .filter((e) => Array.isArray(e.appliedBbox))
      .map((e) => ({
        bbox: e.appliedBbox,
        coluna: e.coluna,
        continuacao: e.continuacao,
      }));
    appliedBbox = appliedBboxes[0]?.bbox || null;

    // 1º passo: costura pares marcados como continuação de quebra de coluna (com âncora de margem + correlação 1D)
    const divXPx = colunaDivisaoX >= 280 && colunaDivisaoX <= 720
      ? Math.round((colunaDivisaoX / 1000) * origW)
      : Math.round(origW / 2);
    const col1MarginPx = layoutOrigem === 'duas_colunas'
      ? medirMargemEsquerdaColuna(fullRgb, origW, origH, 0, divXPx)
      : null;
    const col2MarginPx = layoutOrigem === 'duas_colunas'
      ? medirMargemEsquerdaColuna(fullRgb, origW, origH, divXPx, origW)
      : null;

    const blocosConsolidados = [];
    for (const ext of extraidos) {
      if (ext.continuacao && blocosConsolidados.length > 0) {
        const prev = blocosConsolidados.pop();
        let priorDx = null;
        if (
          col1MarginPx !== null &&
          col2MarginPx !== null &&
          prev.coluna === 'esquerda' &&
          ext.coluna === 'direita' &&
          prev.firstInkOrigX > 0 &&
          ext.firstInkOrigX > 0
        ) {
          priorDx = (ext.firstInkOrigX - col2MarginPx) - (prev.firstInkOrigX - col1MarginPx);
        }
        const unidos = await costurarQuebraColuna(prev, ext, priorDx);
        blocosConsolidados.push(unidos);
      } else {
        blocosConsolidados.push(ext);
      }
    }

    // 2º passo: compõe os blocos consolidados (lado a lado ou empilhados)
    const comp = await comporPainelMultiFigura(blocosConsolidados, composicaoLayout);
    workBuf = comp.buf;
    composicaoUsada = comp.modoUsado;
  }

  // 4) Redimensionamento final HD (Chroma 4:4:4 para nitidez de textos e fórmulas químicas)
  const finalBuf = await sharp(workBuf)
    .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
    .sharpen({ sigma: 0.48 })
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

  const hasCrop = specsList.length > 0;
  let refColWidth = 0;
  if (hasCrop) {
    if (layoutOrigem === 'duas_colunas') {
      const divRefPx = colunaDivisaoX >= 280 && colunaDivisaoX <= 720
        ? Math.round((colunaDivisaoX / 1000) * origW)
        : Math.round(origW / 2);
      const usaColDir = specsList.every((sp) => sp.coluna === 'direita');
      refColWidth = usaColDir
        ? medirLarguraUtilColuna(fullRgb, origW, origH, divRefPx, origW)
        : medirLarguraUtilColuna(fullRgb, origW, origH, 0, divRefPx);
    } else {
      refColWidth = medirLarguraUtilColuna(fullRgb, origW, origH, 0, origW);
    }
  }

  const autoPreset = calcularPresetGeometria(finalW, finalH, {
    refColWidth,
    composicaoLayout: composicaoUsada,
    hasCrop,
  });
  const preset = ['P', 'M', 'G', '100%'].includes(presetOverride) ? presetOverride : autoPreset;
  const dpiStatus = calcularStatusNitidez(finalW, finalH);

  const midia = {
    url: publicUrl,
    original_url: originalUrl || publicUrl,
    bbox: appliedBbox,
    bboxes: appliedBboxes,
    partes_count: appliedBboxes ? appliedBboxes.length : (appliedBbox ? 1 : 0),
    composicao_layout: composicaoUsada,
    layout_origem: layoutOrigem || 'coluna_unica',
    coluna_divisao_x: Number(colunaDivisaoX || 0) || null,
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
