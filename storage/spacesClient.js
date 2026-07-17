import { S3Client } from "@aws-sdk/client-s3";

/**
 * DigitalOcean Spaces (S3-compatible) ÔÇö Client oficial (AWS SDK v3)
 *
 * Regras:
 * - Nunca logar segredos (key/secret).
 * - Falhar cedo se ENV obrigat├│rias estiverem ausentes.
 * - Endpoint ├® obrigat├│rio para Spaces (ex.: https://nyc3.digitaloceanspaces.com)
 */
function requireEnv(name) {
  const v = String(process.env[name] || "").trim();
  if (!v) {
    throw new Error(`ENV obrigat├│ria ausente: ${name}`);
  }
  return v;
}

function normalizeEndpoint(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  // aceita com ou sem protocolo
  if (s.startsWith("http://") || s.startsWith("https://")) return s;
  return `https://${s}`;
}

let _client = null;

export function getSpacesConfig() {
  const key = requireEnv("DO_SPACES_KEY");
  const secret = requireEnv("DO_SPACES_SECRET");
  const region = requireEnv("DO_SPACES_REGION");
  const bucket = requireEnv("DO_SPACES_BUCKET");
  const endpoint = normalizeEndpoint(requireEnv("DO_SPACES_ENDPOINT"));

  return {
    key,
    secret,
    region,
    bucket,
    endpoint,
  };
}

export function getSpacesClient() {
  if (_client) return _client;

  const cfg = getSpacesConfig();

  _client = new S3Client({
    region: cfg.region,
    endpoint: cfg.endpoint,
    forcePathStyle: false, // Spaces geralmente funciona bem com virtual-hosted-style
    credentials: {
      accessKeyId: cfg.key,
      secretAccessKey: cfg.secret,
    },
  });

  return _client;
}
