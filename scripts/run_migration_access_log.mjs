/**
 * Migration: Criar tabela access_log
 * Registra cada login/autenticação válida por escola
 * 
 * Uso:  node scripts/run_migration_access_log.mjs
 */
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import mysql from "mysql2/promise";
import fs from "fs";

const __filenameEnv = fileURLToPath(import.meta.url);
const __dirnameEnv = dirname(__filenameEnv);

const envFile =
  process.env.NODE_ENV === "production" ? ".env.production" : ".env.development";
dotenv.config({ path: join(__dirnameEnv, "..", envFile) });

const {
  MYSQL_HOST, MYSQL_PORT, MYSQL_USER, MYSQL_PASSWORD, MYSQL_DATABASE,
  MYSQL_SSLMODE, MYSQL_SSL_CA,
} = process.env;

let ssl = undefined;
if (String(MYSQL_SSLMODE || "").toUpperCase() === "REQUIRED") {
  if (MYSQL_SSL_CA) {
    const looksLikePem = MYSQL_SSL_CA.includes("BEGIN CERTIFICATE");
    if (looksLikePem) ssl = { ca: MYSQL_SSL_CA, rejectUnauthorized: true };
    else if (fs.existsSync(MYSQL_SSL_CA)) ssl = { ca: fs.readFileSync(MYSQL_SSL_CA, "utf8"), rejectUnauthorized: true };
    else ssl = { rejectUnauthorized: true };
  } else {
    ssl = { rejectUnauthorized: true };
  }
}

const pool = mysql.createPool({
  host: MYSQL_HOST,
  port: MYSQL_PORT ? Number(MYSQL_PORT) : 3306,
  user: MYSQL_USER,
  password: MYSQL_PASSWORD,
  database: MYSQL_DATABASE,
  waitForConnections: true,
  connectionLimit: 5,
  ...(ssl ? { ssl } : {}),
});

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS access_log (
    id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    usuario_id  INT UNSIGNED NOT NULL,
    escola_id   INT UNSIGNED NOT NULL,
    perfil      VARCHAR(50)  DEFAULT NULL,
    ip          VARCHAR(45)  DEFAULT NULL,
    user_agent  VARCHAR(512) DEFAULT NULL,
    action      VARCHAR(50)  DEFAULT 'login',
    created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_access_escola_data (escola_id, created_at),
    INDEX idx_access_usuario (usuario_id, created_at),
    INDEX idx_access_created (created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
];

async function run() {
  console.log("[MIGRATION] Iniciando migração access_log...");
  for (const sql of MIGRATIONS) {
    const name = sql.match(/CREATE TABLE\s+IF NOT EXISTS\s+(\w+)/i)?.[1];
    try {
      await pool.query(sql);
      console.log(`  ✅ Tabela '${name}' OK`);
    } catch (err) {
      console.error(`  ❌ Erro em '${name}':`, err.message);
    }
  }
  console.log("[MIGRATION] Concluído.");
  await pool.end();
  process.exit(0);
}

run().catch((err) => {
  console.error("[MIGRATION] Erro fatal:", err);
  process.exit(1);
});
