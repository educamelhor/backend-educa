// run_migration_add_tipo_origem_escolas.js
// Adiciona colunas 'tipo' (JSON) e 'origem' (ENUM) na tabela escolas
// Uso: node run_migration_add_tipo_origem_escolas.js

import dotenv from "dotenv";
dotenv.config({ path: ".env.development" });
import mysql from "mysql2/promise";
import fs from "fs";
import path from "path";

const sslCaPath = process.env.MYSQL_SSL_CA;
let sslCa = undefined;
if (sslCaPath) {
  const resolved = path.resolve(sslCaPath);
  if (fs.existsSync(resolved)) {
    sslCa = fs.readFileSync(resolved);
  }
}

const pool = mysql.createPool({
  host: process.env.MYSQL_HOST,
  port: Number(process.env.MYSQL_PORT) || 3306,
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
  ssl: sslCa ? { ca: sslCa } : undefined,
});

async function hasColumn(db, table, column) {
  const [rows] = await db.query(
    `SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?
     LIMIT 1`,
    [table, column]
  );
  return rows.length > 0;
}

async function run() {
  const conn = await pool.getConnection();
  console.log("🔗 Conectado ao MySQL.");

  try {
    // 1) Adiciona coluna 'tipo' (JSON)
    if (await hasColumn(conn, "escolas", "tipo")) {
      console.log("✅ Coluna 'tipo' já existe. Pulando.");
    } else {
      await conn.query(`
        ALTER TABLE escolas
          ADD COLUMN tipo JSON DEFAULT NULL
            COMMENT 'Array de tipos: Infantil, Anos Iniciais, Anos Finais, Ensino Médio, Profissionalizante, Integral, CCMDF'
          AFTER telefone
      `);
      console.log("✅ Coluna 'tipo' adicionada.");
    }

    // 2) Adiciona coluna 'origem' (ENUM)
    if (await hasColumn(conn, "escolas", "origem")) {
      console.log("✅ Coluna 'origem' já existe. Pulando.");
    } else {
      await conn.query(`
        ALTER TABLE escolas
          ADD COLUMN origem ENUM('publica', 'particular') DEFAULT NULL
            COMMENT 'Origem: pública ou particular'
          AFTER tipo
      `);
      console.log("✅ Coluna 'origem' adicionada.");
    }

    // 3) Verifica o schema final
    const [cols] = await conn.query(
      `SELECT COLUMN_NAME, COLUMN_TYPE FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'escolas'
       ORDER BY ORDINAL_POSITION`
    );
    console.log("\n📋 Schema atual da tabela 'escolas':");
    for (const c of cols) {
      console.log(`   ${c.COLUMN_NAME.padEnd(20)} ${c.COLUMN_TYPE}`);
    }

    console.log("\n✅ Migração concluída com sucesso!");
  } catch (err) {
    console.error("❌ Erro na migração:", err);
  } finally {
    conn.release();
    await pool.end();
  }
}

run();
