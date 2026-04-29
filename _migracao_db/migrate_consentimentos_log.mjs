/**
 * migrate_consentimentos_log.mjs
 * Criado em: 2026-04-28
 *
 * Executa as migrations de consentimento LGPD:
 *   1. CREATE TABLE consentimentos_log (audit log imutável)
 *   2. ALTER TABLE responsaveis_alunos (novos campos de rastreamento)
 *   3. UPDATE legados (marca registros físicos existentes)
 *
 * Uso: node migrate_consentimentos_log.mjs
 */

import pool from "../db.js";

const steps = [
  {
    name: "CREATE TABLE consentimentos_log",
    sql: `
      CREATE TABLE IF NOT EXISTS consentimentos_log (
        id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,

        responsavel_id  INT NOT NULL,
        aluno_id        INT NOT NULL,
        escola_id       INT NOT NULL,

        responsavel_nome  VARCHAR(255) NOT NULL,
        responsavel_cpf   VARCHAR(11)  NOT NULL,
        aluno_nome        VARCHAR(255) NOT NULL,

        acao          ENUM('CONCEDER','REVOGAR') NOT NULL DEFAULT 'CONCEDER',
        canal         ENUM('FISICO','DIGITAL_APP','DIGITAL_WEB') NOT NULL,
        versao_termo  VARCHAR(20) NOT NULL DEFAULT '3.0',

        ip_address  VARCHAR(45)  NULL COMMENT 'IPv4 ou IPv6 de quem assinou',
        user_agent  TEXT         NULL COMMENT 'Browser/app e versão',
        device_id   VARCHAR(255) NULL COMMENT 'Expo Push Token ou device identifier',
        plataforma  VARCHAR(50)  NULL COMMENT 'ios | android | web | fisico',

        chk_fotografia_cadastro    TINYINT(1) NOT NULL DEFAULT 0,
        chk_imagem_sistema         TINYINT(1) NOT NULL DEFAULT 0,
        chk_template_biometrico    TINYINT(1) NOT NULL DEFAULT 0,
        chk_sistemas_seguranca     TINYINT(1) NOT NULL DEFAULT 0,
        chk_app_educa_mobile       TINYINT(1) NOT NULL DEFAULT 0,
        chk_captura_educa_capture  TINYINT(1) NOT NULL DEFAULT 0,

        confirmado_por_usuario_id  INT          NULL,
        confirmado_por_nome        VARCHAR(255) NULL,
        confirmado_por_ip          VARCHAR(45)  NULL,

        criado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

        INDEX idx_responsavel (responsavel_id),
        INDEX idx_aluno       (aluno_id),
        INDEX idx_escola      (escola_id),
        INDEX idx_criado_em   (criado_em),
        INDEX idx_canal       (canal),
        INDEX idx_acao        (acao)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        COMMENT='Audit log jurídico de consentimentos LGPD — IMUTÁVEL';
    `,
  },
  {
    name: "ALTER TABLE responsaveis_alunos — adicionar consentimento_canal",
    sql: `ALTER TABLE responsaveis_alunos
          ADD COLUMN IF NOT EXISTS consentimento_canal
            ENUM('FISICO','DIGITAL_APP','DIGITAL_WEB') NULL DEFAULT NULL
            COMMENT 'Canal pelo qual o consentimento foi obtido'
            AFTER consentimento_imagem_por`,
  },
  {
    name: "ALTER TABLE responsaveis_alunos — adicionar consentimento_versao_termo",
    sql: `ALTER TABLE responsaveis_alunos
          ADD COLUMN IF NOT EXISTS consentimento_versao_termo
            VARCHAR(20) NULL DEFAULT NULL
            COMMENT 'Versão do termo aceito (ex: 3.0)'
            AFTER consentimento_canal`,
  },
  {
    name: "ALTER TABLE responsaveis_alunos — adicionar consentimento_log_id",
    sql: `ALTER TABLE responsaveis_alunos
          ADD COLUMN IF NOT EXISTS consentimento_log_id
            BIGINT UNSIGNED NULL DEFAULT NULL
            COMMENT 'Referência ao registro mais recente em consentimentos_log'
            AFTER consentimento_versao_termo`,
  },
  {
    name: "UPDATE legados — marcar registros físicos existentes",
    sql: `UPDATE responsaveis_alunos
          SET
            consentimento_canal        = 'FISICO',
            consentimento_versao_termo = '3.0'
          WHERE
            consentimento_imagem = 1
            AND consentimento_canal IS NULL`,
  },
];

async function run() {
  console.log("🔄 Iniciando migrations de consentimento LGPD...\n");

  const conn = await pool.getConnection();
  try {
    for (const step of steps) {
      process.stdout.write(`  ▸ ${step.name}... `);
      try {
        await conn.query(step.sql);
        console.log("✅");
      } catch (err) {
        console.log(`❌ ERRO: ${err.message}`);
        // ADD COLUMN IF NOT EXISTS pode falhar em MySQL < 8.0 — tentar sem o IF NOT EXISTS
        if (err.message.includes("IF NOT EXISTS")) {
          const sqlAlt = step.sql.replace(/ADD COLUMN IF NOT EXISTS/g, "ADD COLUMN");
          try {
            process.stdout.write(`    ↻ Tentando sem IF NOT EXISTS... `);
            await conn.query(sqlAlt);
            console.log("✅");
          } catch (err2) {
            if (err2.message.includes("Duplicate column")) {
              console.log("⏭️  Coluna já existe — ignorando.");
            } else {
              throw err2;
            }
          }
        } else if (!err.message.includes("already exists") && !err.message.includes("Duplicate")) {
          throw err;
        } else {
          console.log("⏭️  Já existe — ignorando.");
        }
      }
    }

    console.log("\n✅ Migrations concluídas com sucesso!");

    // Verifica resultado
    const [rows] = await conn.query("DESCRIBE consentimentos_log");
    console.log(`\n📋 consentimentos_log: ${rows.length} colunas criadas.`);

    const [cols] = await conn.query(
      "SHOW COLUMNS FROM responsaveis_alunos LIKE 'consentimento_%'"
    );
    console.log(`📋 responsaveis_alunos: ${cols.length} colunas de consentimento.`);
    cols.forEach(c => console.log(`   · ${c.Field}`));

  } finally {
    conn.release();
    await pool.end();
  }
}

run().catch(err => {
  console.error("\n❌ Falha crítica na migration:", err);
  process.exit(1);
});
