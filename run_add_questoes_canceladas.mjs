// Script de migração: adicionar coluna questoes_canceladas em gabarito_avaliacoes
import mysql from "mysql2/promise";
import { config } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, ".env.development") });

const conn = await mysql.createConnection({
  host: process.env.MYSQL_HOST,
  port: Number(process.env.MYSQL_PORT) || 3306,
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
  ssl: { rejectUnauthorized: false },
});

console.log("✅ Conectado ao banco de dados.");

try {
  // Verificar se a coluna já existe
  const [cols] = await conn.query(`
    SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'gabarito_avaliacoes' AND COLUMN_NAME = 'questoes_canceladas'
  `, [process.env.MYSQL_DATABASE]);

  if (cols.length > 0) {
    console.log("ℹ️  Coluna 'questoes_canceladas' já existe. Nada a fazer.");
  } else {
    await conn.query(`
      ALTER TABLE gabarito_avaliacoes
        ADD COLUMN questoes_canceladas JSON DEFAULT NULL
        COMMENT 'Questoes anuladas em lote: [{numero, modo (bonificar|desconsiderar), motivo, cancelado_em, cancelado_por}]'
    `);
    console.log("✅ Coluna 'questoes_canceladas' adicionada com sucesso em 'gabarito_avaliacoes'.");
  }
} catch (err) {
  console.error("❌ Erro na migração:", err.message);
  process.exit(1);
} finally {
  await conn.end();
}

console.log("🎉 Migração concluída.");
