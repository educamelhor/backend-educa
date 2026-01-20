import mysql from "mysql2/promise";
import fs from "fs";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

// Carrega .env ANTES de ler process.env (necessário por causa do ESM/import order)
const __filenameEnv = fileURLToPath(import.meta.url);
const __dirnameEnv = dirname(__filenameEnv);
const envFile =
  process.env.NODE_ENV === "production" ? ".env.production" : ".env.development";
dotenv.config({ path: join(__dirnameEnv, envFile) });

const {
  MYSQL_HOST,
  MYSQL_PORT,
  MYSQL_USER,
  MYSQL_PASSWORD,
  MYSQL_DATABASE,

  // DO Managed MySQL: sslmode REQUIRED
  MYSQL_SSLMODE,
  MYSQL_SSL_CA,
} = process.env;


// Se estiver em DO (sslmode REQUIRED), tentamos carregar CA (recomendado).
let ssl = undefined;

if (String(MYSQL_SSLMODE || "").toUpperCase() === "REQUIRED") {
  // MYSQL_SSL_CA pode vir de 2 formas:
  // 1) Conteúdo do certificado (recomendado na App Platform)
  // 2) Caminho para um arquivo .crt (quando rodar local/servidor com arquivo)
  if (MYSQL_SSL_CA) {
    const looksLikePem = MYSQL_SSL_CA.includes("BEGIN CERTIFICATE");

    if (looksLikePem) {
      ssl = { ca: MYSQL_SSL_CA, rejectUnauthorized: true };
    } else if (fs.existsSync(MYSQL_SSL_CA)) {
      ssl = { ca: fs.readFileSync(MYSQL_SSL_CA, "utf8"), rejectUnauthorized: true };
    } else {
      ssl = { rejectUnauthorized: true };
    }
  } else {
    ssl = { rejectUnauthorized: true };
  }
}


// --- DEBUG (TEMP): mostrar config efetiva (sem senha) ---
console.log("[DB] env config:", {
  MYSQL_HOST,
  MYSQL_PORT,
  MYSQL_USER,
  MYSQL_DATABASE,
  MYSQL_SSLMODE,
  MYSQL_SSL_CA,
  sslEnabled: !!ssl,
});
// --- /DEBUG (TEMP) ---

const pool = mysql.createPool({
  host: MYSQL_HOST,
  port: MYSQL_PORT ? Number(MYSQL_PORT) : 3306,
  user: MYSQL_USER,
  password: MYSQL_PASSWORD,
  database: MYSQL_DATABASE,

  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,

  ...(ssl ? { ssl } : {}),
});

// --- DEBUG (TEMP): probe de conexão (uma vez ao subir) ---
pool
  .getConnection()
  .then((conn) => {
    console.log("[DB] connection OK");
    conn.release();
  })
  .catch((err) => {
    console.log("[DB] connection FAIL:", {
      code: err?.code,
      errno: err?.errno,
      syscall: err?.syscall,
      address: err?.address,
      port: err?.port,
      message: err?.message,
    });
  });
// --- /DEBUG (TEMP) ---

export default pool;

