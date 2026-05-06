import mysql from "mysql2/promise";
import fs from "fs";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

// Carrega .env ANTES de ler process.env (dev local).
// Em produção no DO, não existe .env — as vars vêm do App Platform.
const __filenameEnv = fileURLToPath(import.meta.url);
const __dirnameEnv = dirname(__filenameEnv);
const envFile =
  process.env.NODE_ENV === "production" ? ".env.production" : ".env.development";
dotenv.config({ path: join(__dirnameEnv, envFile) });

// ─── Resolve credenciais MySQL ────────────────────────────────────────────────
// Prioridade:
//   1) Variáveis individuais MYSQL_HOST / MYSQL_PORT / ... (dev local + legacy)
//   2) DATABASE_URL (DigitalOcean App Platform injeta automaticamente)
// ─────────────────────────────────────────────────────────────────────────────
let {
  MYSQL_HOST,
  MYSQL_PORT,
  MYSQL_USER,
  MYSQL_PASSWORD,
  MYSQL_DATABASE,
  MYSQL_SSLMODE,
  MYSQL_SSL_CA,
} = process.env;

// Se as vars individuais não vieram, tenta parsear DATABASE_URL
if (!MYSQL_HOST && process.env.DATABASE_URL) {
  try {
    const dbUrl = new URL(process.env.DATABASE_URL);
    MYSQL_HOST     = dbUrl.hostname;
    MYSQL_PORT     = dbUrl.port || "3306";
    MYSQL_USER     = decodeURIComponent(dbUrl.username);
    MYSQL_PASSWORD = decodeURIComponent(dbUrl.password);
    MYSQL_DATABASE = dbUrl.pathname.replace(/^\//, "");

    // ssl-mode=REQUIRED na query string
    const sslParam = dbUrl.searchParams.get("ssl-mode") ||
                     dbUrl.searchParams.get("sslmode")  || "";
    if (sslParam.toUpperCase() === "REQUIRED") {
      MYSQL_SSLMODE = "REQUIRED";
    }

    console.log("[DB] usando DATABASE_URL:", {
      host: MYSQL_HOST,
      port: MYSQL_PORT,
      database: MYSQL_DATABASE,
    });
  } catch (e) {
    console.error("[DB] falha ao parsear DATABASE_URL:", e.message);
  }
}

// ─── SSL ──────────────────────────────────────────────────────────────────────
let ssl = undefined;

if (String(MYSQL_SSLMODE || "").toUpperCase() === "REQUIRED") {
  if (MYSQL_SSL_CA) {
    const looksLikePem = MYSQL_SSL_CA.includes("BEGIN CERTIFICATE");
    if (looksLikePem) {
      ssl = { ca: MYSQL_SSL_CA, rejectUnauthorized: true };
    } else if (fs.existsSync(MYSQL_SSL_CA)) {
      ssl = { ca: fs.readFileSync(MYSQL_SSL_CA, "utf8"), rejectUnauthorized: true };
    } else {
      ssl = { rejectUnauthorized: false }; // DO managed DB — cert válido mas sem CA local
    }
  } else {
    // Sem CA explícito: aceita certificado do servidor DO (rejectUnauthorized:false)
    // O host do DO tem certificado válido — é seguro para conexão interna.
    ssl = { rejectUnauthorized: false };
  }
}

// ─── Log de configuração ──────────────────────────────────────────────────────
console.log("[DB] config:", {
  host: MYSQL_HOST || "UNDEFINED",
  port: MYSQL_PORT || "UNDEFINED",
  database: MYSQL_DATABASE || "UNDEFINED",
  sslMode: MYSQL_SSLMODE || "none",
  sslEnabled: !!ssl,
});

// ─── Pool ─────────────────────────────────────────────────────────────────────
const pool = mysql.createPool({
  host: MYSQL_HOST,
  port: MYSQL_PORT ? Number(MYSQL_PORT) : 3306,
  user: MYSQL_USER,
  password: MYSQL_PASSWORD,
  database: MYSQL_DATABASE,

  // DO MySQL roda em UTC — necessário para evitar shift de +3h no BRT
  timezone: "+00:00",

  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,

  ...(ssl ? { ssl } : {}),
});

// Probe de conexão + auto-migrations
pool
  .getConnection()
  .then(async (conn) => {
    console.log("[DB] connection OK ✅");
    conn.release();

    // ── Auto-migrations (idempotentes — falha silenciosa se já existir) ──
    const migrations = [
      // Busca Ativa — rastreabilidade de edição
      "ALTER TABLE frequencia_busca_ativa ADD COLUMN editado_por INT NULL AFTER registrado_por",
      "ALTER TABLE frequencia_busca_ativa ADD COLUMN editado_em DATETIME NULL AFTER editado_por",
      // Agente EDUCA — lock de execução concorrente
      "ALTER TABLE planos_avaliacao ADD COLUMN agente_executando_desde DATETIME NULL",
      // Agente EDUCA — resultado da exportação de estrutura (CRIADO | JA_EXISTIA)
      "ALTER TABLE planos_avaliacao ADD COLUMN agente_exportado_resultado VARCHAR(32) NULL",
      // Agente EDUCA — resultado da exportação de notas (CRIADO | FALHOU)
      "ALTER TABLE planos_avaliacao ADD COLUMN agente_notas_resultado_json TEXT NULL",
    ];
    for (const sql of migrations) {
      try {
        await pool.query(sql);
        console.log("[DB] migration OK:", sql.slice(0, 60));
      } catch {
        // coluna já existe — ignorar
      }
    }
  })
  .catch((err) => {
    console.error("[DB] connection FAIL ❌", {
      code: err?.code,
      message: err?.message?.slice(0, 200),
    });
  });

export default pool;
