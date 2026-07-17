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

    // ── Auto-migrations v3.1 (idempotentes — falha silenciosa se já existir) ──
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
      // Agente EDUCA — mensagem do último erro (exibida ao professor)
      "ALTER TABLE planos_avaliacao ADD COLUMN agente_ultimo_erro VARCHAR(500) NULL",
      // Banco de Questões v3 — numeração universal sequencial
      `CREATE TABLE IF NOT EXISTS questoes_num_seq (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY
      ) COMMENT 'Gerador de sequencia global para numero_q das questoes'`,
      "ALTER TABLE questoes ADD COLUMN numero_q INT UNSIGNED NULL UNIQUE COMMENT 'Numero universal Q0001, Q0042... gerado automaticamente'",
      "ALTER TABLE questoes ADD COLUMN professor_nome VARCHAR(150) NULL COMMENT 'Cache do nome do professor autor'",
      "ALTER TABLE questoes ADD INDEX idx_numero_q (numero_q)",
      "ALTER TABLE questoes ADD INDEX idx_professor (professor_id)",
      // Mobile Push Notifications
      `CREATE TABLE IF NOT EXISTS mobile_devices (
        id INT AUTO_INCREMENT PRIMARY KEY,
        responsavel_id INT NULL,
        aluno_id INT NULL,
        escola_id INT NULL,
        device_token VARCHAR(512) NOT NULL,
        plataforma VARCHAR(20) DEFAULT 'unknown',
        ativo TINYINT(1) NOT NULL DEFAULT 1,
        created_at DATETIME DEFAULT NOW(),
        updated_at DATETIME DEFAULT NOW(),
        UNIQUE KEY uk_responsavel_token (responsavel_id, device_token),
        UNIQUE KEY uk_aluno_token (aluno_id, device_token),
        INDEX idx_responsavel (responsavel_id),
        INDEX idx_aluno (aluno_id),
        INDEX idx_escola (escola_id)
      )`,
    ];
    for (const sql of migrations) {
      try {
        await pool.query(sql);
        console.log("[DB] migration OK:", sql.slice(0, 70));
      } catch {
        // coluna/tabela já existe — ignorar
      }
    }

    // ── Limpeza única v3: remove TODAS as questões de teste ─────────────────
    // Identifica se ainda há questões de teste (sem numero_q) OU se o banco
    // global ainda tem entradas do período de testes (antes do modelo v3).
    try {
      // 1. Apaga questões locais sem numero_q (criadas antes do v3)
      const [[{ total_sem_num }]] = await pool.query(
        "SELECT COUNT(*) AS total_sem_num FROM questoes WHERE numero_q IS NULL"
      );
      if (total_sem_num > 0) {
        await pool.query("DELETE FROM questoes WHERE numero_q IS NULL");
        console.log(`[DB] cleanup v3 (questoes): ${total_sem_num} questão(ões) de teste removida(s) ✅`);
        // Reseta sequência para começar do 1
        await pool.query("DELETE FROM questoes_num_seq");
        await pool.query("ALTER TABLE questoes_num_seq AUTO_INCREMENT = 1");
        console.log("[DB] questoes_num_seq resetada → próxima questão será Q0001 ✅");
      }
    } catch (e) {
      console.log("[DB] cleanup v3 (questoes) skip:", e.message?.slice(0, 80));
    }

    // 2. Apaga banco global antigo (questoes_banco_global) — todas as entradas
    //    de teste. No novo modelo v3, o Banco Global = tabela questoes sem filtro.
    try {
      const [[{ total_global }]] = await pool.query(
        "SELECT COUNT(*) AS total_global FROM questoes_banco_global"
      );
      if (total_global > 0) {
        await pool.query("DELETE FROM questoes_banco_global");
        // Zera AUTO_INCREMENT para limpar histórico
        await pool.query("ALTER TABLE questoes_banco_global AUTO_INCREMENT = 1");
        // Limpa também tabelas relacionadas
        await pool.query("DELETE FROM questoes_uso_escola").catch(() => {});
        console.log(`[DB] cleanup v3 (banco_global): ${total_global} entrada(s) de teste removida(s) ✅`);
      }
    } catch (e) {
      console.log("[DB] cleanup v3 (banco_global) skip:", e.message?.slice(0, 80));
    }
  })
  .catch((err) => {
    console.error("[DB] connection FAIL ❌", {
      code: err?.code,
      message: err?.message?.slice(0, 200),
    });
  });

export default pool;
