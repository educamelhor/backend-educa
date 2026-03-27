import crypto from "crypto";
import sharp from "sharp";
import { PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getSpacesClient, getSpacesConfig } from "./spacesClient.js";

function assertBuffer(buf) {
  if (!buf || !(buf instanceof Buffer) || buf.length === 0) {
    throw new Error("Arquivo inválido (buffer vazio).");
  }
}

function sanitizeSegment(s) {
  return String(s || "")
    .trim()
    .replace(/[^\w.-]+/g, "_")
    .slice(0, 80);
}

function guessExtFromMime(mime) {
  const m = String(mime || "").toLowerCase();
  if (m === "image/jpeg" || m === "image/jpg") return "jpg";
  if (m === "image/png") return "png";
  return null;
}

async function cropAvatarBuffer(inputBuffer, inputMimeType) {
  // Controle por ENV (default: ligado)
  const enabled = String(process.env.CAPTURE_CROP_ENABLED || "1") !== "0";
  if (!enabled) {
    return { buffer: inputBuffer, mimeType: inputMimeType };
  }

  const size = Number(process.env.CAPTURE_CROP_SIZE || 512); // avatar quadrado
  if (!Number.isFinite(size) || size < 128 || size > 2048) {
    throw new Error("CAPTURE_CROP_SIZE inválido (128 a 2048).");
  }

  const mime = String(inputMimeType || "").toLowerCase();

  // rotate() corrige orientação EXIF (muito comum em mobile)
  let img = sharp(inputBuffer, { failOnError: false }).rotate().resize(size, size, {
    fit: "cover",
    position: "attention", // heurística que tende a “puxar” para região mais relevante (rosto geralmente)
  });

  if (mime === "image/png") {
    const out = await img.png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer();
    return { buffer: out, mimeType: "image/png" };
  }

  // default: jpeg (inclui image/jpeg e image/jpg)
  const quality = Number(process.env.CAPTURE_CROP_JPEG_QUALITY || 85);
  const q = Number.isFinite(quality) ? Math.min(95, Math.max(50, quality)) : 85;

  const out = await img.jpeg({ quality: q, mozjpeg: true }).toBuffer();
  return { buffer: out, mimeType: "image/jpeg" };
}

/**
 * Upload de imagem (buffer) para DigitalOcean Spaces
 *
 * @param {Object} args
 * @param {Buffer} args.buffer
 * @param {string} args.mimeType  - 'image/jpeg' | 'image/png'
 * @param {number|string} args.escolaId
 * @param {string} args.escolaApelido
 * @param {number|string} args.alunoId
 * @param {string} [args.kind] - ex: 'alunos' | 'professores' | 'capture'
 * @returns {Promise<{ bucket:string, objectKey:string, publicUrl:string, etag?:string }>}
 */
export async function uploadImageBufferToSpaces({
  buffer,
  mimeType,
  escolaId,
  escolaApelido,
  alunoId,
  kind = "alunos",
  cacheControl = null,
  objectKey: forcedObjectKey = null,
}) {
  assertBuffer(buffer);

  // LGPD-ready: limites objetivos
  const maxBytes = Number(process.env.CAPTURE_UPLOAD_MAX_BYTES || 3 * 1024 * 1024); // 3MB default
  if (buffer.length > maxBytes) {
    throw new Error(`Arquivo excede limite (${buffer.length} > ${maxBytes} bytes).`);
  }

  const ext = guessExtFromMime(mimeType);
  if (!ext) {
    throw new Error(`Tipo de arquivo não permitido: ${mimeType}`);
  }

  // PASSO 2.3 — crop/centralização automática (avatar)
  const cropped = await cropAvatarBuffer(buffer, mimeType);

  // Revalida limites após processamento (defesa)
  if (!cropped.buffer || !(cropped.buffer instanceof Buffer) || cropped.buffer.length === 0) {
    throw new Error("Falha ao processar imagem (crop retornou buffer vazio).");
  }
  if (cropped.buffer.length > maxBytes) {
    throw new Error(`Arquivo processado excede limite (${cropped.buffer.length} > ${maxBytes} bytes).`);
  }

  buffer = cropped.buffer;
  mimeType = cropped.mimeType;

  const { bucket, endpoint } = getSpacesConfig();
  const s3 = getSpacesClient();

  let objectKey;

  if (forcedObjectKey) {
    objectKey = String(forcedObjectKey).replace(/^\/+/, "");
  } else {
    const escolaSeg = sanitizeSegment(escolaApelido || `escola_${escolaId}`);
    const kindSeg = sanitizeSegment(kind);
    const alunoSeg = sanitizeSegment(alunoId);

    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const rand = crypto.randomBytes(6).toString("hex");

    objectKey = `uploads/${escolaSeg}/${kindSeg}/${alunoSeg}/foto_${ts}_${rand}.${ext}`;
  }

  const cmd = new PutObjectCommand({
    Bucket: bucket,
    Key: objectKey,
    Body: buffer,
    ContentType: mimeType,
    ContentLength: buffer.length,
    ContentDisposition: "inline",
    CacheControl: cacheControl || undefined,

    // ✅ Necessário para renderização direta no EDUCA.MELHOR (evita AccessDenied no browser)
    ACL: "public-read",
  });

  const out = await s3.send(cmd);

  // URL padrão do Spaces (virtual hosted style)
  // https://{bucket}.{region}.digitaloceanspaces.com/{key}
  // Mas como endpoint pode variar, montamos baseado no endpoint regional.
  const publicUrl = `${endpoint.replace(/\/$/, "")}/${bucket}/${objectKey}`;

  return {
    bucket,
    objectKey,
    publicUrl,
    etag: out?.ETag,
  };
}

export async function deleteObjectFromSpaces(objectKey) {
  const { bucket } = getSpacesConfig();
  const s3 = getSpacesClient();

  const key = String(objectKey || "").trim();
  if (!key) {
    throw new Error("objectKey obrigatório para delete no Spaces.");
  }

  const cmd = new DeleteObjectCommand({
    Bucket: bucket,
    Key: key,
  });

  await s3.send(cmd);
  return { ok: true, bucket, objectKey: key };
}

export async function getSignedGetObjectUrl(objectKey, expiresInSeconds = 3600) {
  const { bucket } = getSpacesConfig();
  const s3 = getSpacesClient();

  const key = String(objectKey || "").trim().replace(/^\/+/, "");
  if (!key) {
    throw new Error("objectKey obrigatório para assinar URL.");
  }

  const expires = Number(expiresInSeconds);
  if (!Number.isFinite(expires) || expires <= 0 || expires > 60 * 60 * 24) {
    throw new Error("expiresInSeconds inválido (1s a 86400s).");
  }

  const cmd = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
  });

  const url = await getSignedUrl(s3, cmd, { expiresIn: expires });
  return { url, bucket, objectKey: key, expiresIn: expires };
}

/**
 * Upload genérico de arquivo (sem crop/resize) para DigitalOcean Spaces.
 * Útil para gabaritos, PDFs, documentos, etc.
 *
 * @param {Object} args
 * @param {Buffer} args.buffer
 * @param {string} args.contentType - MIME type (ex: 'image/jpeg', 'application/pdf')
 * @param {string} args.objectKey  - Caminho completo no bucket (ex: 'uploads/CEF04_PLAN/gabaritos/1/arquivo.jpg')
 * @param {string} [args.cacheControl]
 * @returns {Promise<{ bucket:string, objectKey:string, publicUrl:string, etag?:string }>}
 */
export async function uploadFileBufferToSpaces({ buffer, contentType, objectKey, cacheControl = null }) {
  assertBuffer(buffer);

  const maxBytes = Number(process.env.GABARITO_UPLOAD_MAX_BYTES || 20 * 1024 * 1024); // 20MB
  if (buffer.length > maxBytes) {
    throw new Error(`Arquivo excede limite (${buffer.length} > ${maxBytes} bytes).`);
  }

  const { bucket, endpoint } = getSpacesConfig();
  const s3 = getSpacesClient();

  const key = String(objectKey).replace(/^\/+/, "");

  const cmd = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: buffer,
    ContentType: contentType || "application/octet-stream",
    ContentLength: buffer.length,
    ContentDisposition: "inline",
    CacheControl: cacheControl || undefined,
    ACL: "public-read",
  });

  const out = await s3.send(cmd);

  const publicUrl = `${endpoint.replace(/\/$/, "")}/${bucket}/${key}`;

  return {
    bucket,
    objectKey: key,
    publicUrl,
    etag: out?.ETag,
  };
}

/**
 * Baixa um arquivo do DigitalOcean Spaces e retorna como Buffer.
 * Útil para enviar ao OMR para processamento.
 *
 * @param {string} objectKey - Caminho no bucket (ex: 'uploads/CEF04_PLAN/gabaritos/1/arquivo.jpg')
 * @returns {Promise<{ buffer: Buffer, contentType: string }>}
 */
export async function downloadBufferFromSpaces(objectKey) {
  const { bucket } = getSpacesConfig();
  const s3 = getSpacesClient();

  const key = String(objectKey || "").trim().replace(/^\/+/, "");
  if (!key) {
    throw new Error("objectKey obrigatório para download do Spaces.");
  }

  const cmd = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
  });

  const resp = await s3.send(cmd);

  // Converter stream para Buffer
  const chunks = [];
  for await (const chunk of resp.Body) {
    chunks.push(chunk);
  }
  const buffer = Buffer.concat(chunks);

  return {
    buffer,
    contentType: resp.ContentType || "application/octet-stream",
  };
}