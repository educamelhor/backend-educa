// modules/questoes-ai/smartMediaEngine.js
// EDUCA.STUDIO AI — Smart Media Engine (v2 — Multi-Column & Multi-Figure)
// Dá status independente às imagens de questões:
// - Auto-crop espacial único ou múltiplo (questões em 2 colunas / múltiplas figuras)
// - Gutter Clamp (trava na calha entre colunas p/ nunca invadir texto vizinho)
// - Limpeza inteligente de resíduos de borda (letras/hífens cortados nas margens)
// - Reconstrução de figuras partidas em quebras de coluna (stitch vertical)
// - Composição Editorial HD (Lado a Lado ou Empilhadas) + Scanner Clean + Escala/DPI

import crypto from 'crypto';
import sharp from 'sharp';
import { uploadFileBufferToSpaces } from '../../storage/spacesUpload.js';

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

/**
 * Classifica o preset ideal de largura da figura na questão com base na geometria real.
 * - 'P'    (36% largura): moléculas compactas, ícones geométricos, figuras verticais estreitas
 * - 'M'    (56% largura): gráficos cartesianos, mapas médios, circuitos, charges padrão
 * - 'G'    (84% largura): painéis compostos lado a lado (2 colunas), diagramas largos, 2–3 quadros
 * - '100%' (largura total): tirinhas panorâmicas extensas (4+ quadros em alta largura)
 */
export function calcularPresetGeometria(width, height) {
  if (!width || !height) return 'M';
  const ratio = width / height;

  if (ratio >= 3.4 && width >= 720) return '100%';
  if (ratio >= 1.85) return 'G';
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
 * Remove artefatos isolados de texto vizinho que tenham encostado nos primeiros pixels
 * da borda do recorte (ex: hífens "-" ou finais de letras da coluna ao lado seguidos por
 * um corredor branco limpo), preservando molduras contínuas legítimas de tabelas/tirinhas.
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

    // 1) Varredura de margem esquerda e direita (ex: resíduos da coluna vizinha)
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
        if (leftGapLen >= 9) break; // Encontrou a figura real após o corredor branco
        leftSliverEnd = x;
        leftGapLen = 0;
      }
    }
    if (leftSliverEnd >= 0 && leftSliverEnd <= Math.min(18, Math.floor(W * 0.05)) && leftGapLen >= 9) {
      // Confirma que não é uma linha de moldura vertical (moldura ocupa > 35% da altura)
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

    // 2) Margem superior e inferior (descendentes de letras "g, p, q" da linha acima/abaixo)
    const maxRowScan = Math.min(36, Math.floor(H * 0.1));
    const rowInkCount = new Int32Array(H);
    const computeRowStats = (y) => {
      let count = 0;
      for (let x = 0; x < W; x++) if (isInk(x, y)) count++;
      rowInkCount[y] = count;
    };

    for (let y = 0; y < maxRowScan; y++) computeRowStats(y);
    let topSliverEnd = -1;
    let topGapLen = 0;
    for (let y = 0; y < maxRowScan; y++) {
      if (rowInkCount[y] <= 1) {
        if (topSliverEnd >= 0) topGapLen++;
      } else {
        if (topGapLen >= 8) break;
        topSliverEnd = y;
        topGapLen = 0;
      }
    }
    if (topSliverEnd >= 0 && topSliverEnd <= 12 && topGapLen >= 8) {
      let maxCoverage = 0;
      for (let y = 0; y <= topSliverEnd; y++) if (rowInkCount[y] > maxCoverage) maxCoverage = rowInkCount[y];
      if (maxCoverage < W * 0.25) {
        for (let y = 0; y <= topSliverEnd + 1; y++) {
          for (let x = 0; x < W; x++) {
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
 * Extrai e limpa individualmente um único recorte (bbox) aplicando Gutter Clamp entre colunas.
 */
async function extrairBlocoIndividual(normalizedBuf, origW, origH, spec, { scannerClean = false, autoTrim = true, tightTop = false, tightBottom = false }) {
  let workBuf = normalizedBuf;
  let appliedBbox = null;

  const rawBox = Array.isArray(spec?.bbox) ? spec.bbox : (Array.isArray(spec) ? spec : null);
  const coluna = spec?.coluna || 'unica';
  const divX = Number(spec?.coluna_divisao_x || 0);
  const hasValidGutter = Number.isFinite(divX) && divX >= 280 && divX <= 720;

  if (Array.isArray(rawBox) && rawBox.length === 4) {
    const [rawYmin, rawXmin, rawYmax, rawXmax] = rawBox.map(Number);
    if (
      Number.isFinite(rawYmin) && Number.isFinite(rawXmin) &&
      Number.isFinite(rawYmax) && Number.isFinite(rawXmax) &&
      rawYmax - rawYmin >= 16 && rawXmax - rawXmin >= 16
    ) {
      const padY = 6;
      const padX = 6;
      let ymin = clamp(rawYmin - (tightTop ? 1 : padY), 0, 992);
      let xmin = clamp(rawXmin - padX, 0, 992);
      let ymax = clamp(rawYmax + (tightBottom ? 1 : padY), ymin + 12, 1000);
      let xmax = clamp(rawXmax + padX, xmin + 12, 1000);

      // Gutter Clamp: nunca deixa a margem invadir a coluna vizinha em layouts de 2 colunas
      if (hasValidGutter) {
        if (coluna === 'esquerda' || rawXmax <= divX + 10) {
          xmax = Math.min(xmax, Math.max(xmin + 15, divX));
        } else if (coluna === 'direita' || rawXmin >= divX - 10) {
          xmin = Math.max(xmin, Math.min(xmax - 15, divX));
        }
      }

      const left = clamp(Math.round((xmin / 1000) * origW), 0, origW - 12);
      const top = clamp(Math.round((ymin / 1000) * origH), 0, origH - 12);
      const width = clamp(Math.round(((xmax - xmin) / 1000) * origW), 12, origW - left);
      const height = clamp(Math.round(((ymax - ymin) / 1000) * origH), 12, origH - top);

      workBuf = await sharp(normalizedBuf)
        .extract({ left, top, width, height })
        .toBuffer();
      appliedBbox = [Math.round(ymin), Math.round(xmin), Math.round(ymax), Math.round(xmax)];
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
      if ((tMeta.width || 0) >= 20 && (tMeta.height || 0) >= 16) {
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
    continuacao: Boolean(spec?.continuacao || spec?.continuacao_quebra_coluna),
  };
}

/**
 * Costura verticalmente duas metades de uma mesma figura/fórmula partida na quebra de coluna.
 */
async function costurarQuebraColuna(topItem, bottomItem) {
  const pad = 6;
  const seamGap = 3;
  const canvasW = Math.max(topItem.w, bottomItem.w) + pad * 2;
  const canvasH = topItem.h + bottomItem.h + seamGap + pad * 2;

  const leftTop = Math.floor((canvasW - topItem.w) / 2);
  const leftBot = Math.floor((canvasW - bottomItem.w) / 2);

  const stitchedBuf = await sharp({
    create: {
      width: canvasW,
      height: canvasH,
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
  })
    .composite([
      { input: topItem.buf, left: leftTop, top: pad },
      { input: bottomItem.buf, left: leftBot, top: pad + topItem.h + seamGap },
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
 * - modo 'horizontal': lado a lado centralizados verticalmente (ideal p/ 2 figuras de 2 colunas)
 * - modo 'vertical': empilhados centralizados horizontalmente
 */
async function comporPainelMultiFigura(blocos, modoPreferido = 'auto') {
  if (blocos.length === 1) {
    return { buf: blocos[0].buf, modoUsado: 'unico' };
  }

  let modo = modoPreferido;
  if (modo !== 'horizontal' && modo !== 'vertical') {
    // Auto-decisão geométrica: se forem exatamente 2 blocos e nenhum deles for largo demais,
    // lado a lado economiza metade da altura na folha A4 mantendo escala 1:1 legível!
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
 * Processa um buffer de imagem e publica no DO Spaces retornando o objeto `midia` completo.
 * Suporta tanto 1 `bbox` quanto múltiplas regiões `bboxes` (questões de 2 colunas / multi-figura).
 */
export async function processarMidiaQuestao(inputBuffer, opts = {}) {
  const {
    bbox = null,
    bboxes = null,
    composicaoLayout = 'auto',
    colunaDivisaoX = 0,
    layoutOrigem = 'coluna_unica',
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
        });
      }
    }
  } else if (Array.isArray(bbox) && bbox.length === 4) {
    specsList.push({
      bbox: bbox.map(Number),
      coluna: 'unica',
      coluna_divisao_x: Number(colunaDivisaoX || 0),
      continuacao: false,
    });
  }

  let workBuf = null;
  let appliedBbox = null;
  let appliedBboxes = null;
  let composicaoUsada = 'unico';

  if (specsList.length === 0) {
    // Upload direto de figura avulsa (sem recorte por bbox)
    const single = await extrairBlocoIndividual(normalizedBuf, origW, origH, null, {
      scannerClean,
      autoTrim,
    });
    workBuf = single.buf;
  } else if (specsList.length === 1) {
    const single = await extrairBlocoIndividual(normalizedBuf, origW, origH, specsList[0], {
      scannerClean,
      autoTrim,
    });
    workBuf = single.buf;
    appliedBbox = single.appliedBbox;
    if (appliedBbox) {
      appliedBboxes = [{ bbox: appliedBbox, coluna: specsList[0].coluna, continuacao: false }];
    }
  } else {
    // Múltiplas áreas visuais (ex: questão dividida em 2 colunas ou figura partida na quebra)
    // Heurística adicional: se layout for 2 colunas e o item i encostar no rodapé esquerdo (ymax >= 945)
    // e o item i+1 encostar no topo direito (ymin <= 105) sendo faixa curta, ativa costura automática!
    for (let i = 0; i < specsList.length - 1; i++) {
      const cur = specsList[i];
      const nxt = specsList[i + 1];
      if (!nxt.continuacao && layoutOrigem === 'duas_colunas') {
        const curH = cur.bbox[2] - cur.bbox[0];
        if (cur.bbox[2] >= 945 && nxt.bbox[0] <= 105 && cur.bbox[3] <= 530 && nxt.bbox[1] >= 470 && curH <= 210) {
          nxt.continuacao = true;
        }
      }
    }

    const extraidos = [];
    for (let i = 0; i < specsList.length; i++) {
      const nextIsStitch = i + 1 < specsList.length && specsList[i + 1].continuacao;
      const curIsStitch = i > 0 && specsList[i].continuacao;
      const item = await extrairBlocoIndividual(normalizedBuf, origW, origH, specsList[i], {
        scannerClean,
        autoTrim,
        tightBottom: nextIsStitch,
        tightTop: curIsStitch,
      });
      extraidos.push({
        ...item,
        coluna: specsList[i].coluna,
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

    // 1º passo: costura pares marcados como continuação de quebra de coluna
    const blocosConsolidados = [];
    for (const ext of extraidos) {
      if (ext.continuacao && blocosConsolidados.length > 0) {
        const prev = blocosConsolidados.pop();
        const unidos = await costurarQuebraColuna(prev, ext);
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

  const autoPreset = calcularPresetGeometria(finalW, finalH);
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
