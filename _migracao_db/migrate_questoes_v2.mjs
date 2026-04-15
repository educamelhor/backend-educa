// migrate_questoes_v2.mjs
// Roda direto com Node.js: node migrate_questoes_v2.mjs
// Adiciona as colunas de Banco de Questões v2 à tabela questoes

import mysql from 'mysql2/promise';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, '../.env.development') });

const conn = await mysql.createConnection({
  host:     process.env.MYSQL_HOST,
  port:     Number(process.env.MYSQL_PORT || 3306),
  user:     process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
  ssl:      process.env.MYSQL_SSLMODE === 'REQUIRED'
              ? { rejectUnauthorized: false }
              : undefined,
});

console.log('✅ Conectado ao banco:', process.env.MYSQL_DATABASE);

// Helper: adiciona coluna se não existir
async function addColumnIfMissing(table, column, definition) {
  const [rows] = await conn.query(
    `SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column]
  );
  if (rows.length > 0) {
    console.log(`  ↳ SKIP  ${column} (já existe)`);
    return;
  }
  await conn.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
  console.log(`  ✅ ADD   ${column}`);
}

// Helper: adiciona índice se não existir
async function addIndexIfMissing(table, indexName, columns) {
  const [rows] = await conn.query(
    `SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`,
    [table, indexName]
  );
  if (rows.length > 0) {
    console.log(`  ↳ SKIP  INDEX ${indexName} (já existe)`);
    return;
  }
  await conn.query(`ALTER TABLE \`${table}\` ADD INDEX \`${indexName}\` (${columns})`);
  console.log(`  ✅ INDEX ${indexName}`);
}

console.log('\n📋 Migrando tabela `questoes` — Banco de Questões v2\n');

// ── Novas colunas ─────────────────────────────────────────────────────────────
await addColumnIfMissing('questoes', 'serie',
  "VARCHAR(30) DEFAULT NULL AFTER disciplina");

await addColumnIfMissing('questoes', 'bimestre',
  "TINYINT DEFAULT NULL AFTER serie");

await addColumnIfMissing('questoes', 'habilidade_bncc',
  "VARCHAR(20) DEFAULT NULL AFTER bimestre");

await addColumnIfMissing('questoes', 'texto_apoio',
  "TEXT DEFAULT NULL AFTER habilidade_bncc");

await addColumnIfMissing('questoes', 'fonte',
  "VARCHAR(200) DEFAULT NULL AFTER texto_apoio");

await addColumnIfMissing('questoes', 'explicacao',
  "TEXT DEFAULT NULL AFTER fonte");

await addColumnIfMissing('questoes', 'compartilhada',
  "TINYINT(1) NOT NULL DEFAULT 0 AFTER explicacao");

await addColumnIfMissing('questoes', 'status',
  "ENUM('rascunho','ativa','arquivada') NOT NULL DEFAULT 'ativa' AFTER compartilhada");

await addColumnIfMissing('questoes', 'escola_id',
  "INT DEFAULT NULL");

await addColumnIfMissing('questoes', 'professor_id',
  "INT DEFAULT NULL");

// ── Índices (ó adiciona os que não dependem de colunas óbvias) ──────────────────
await addIndexIfMissing('questoes', 'idx_bq_nivel',    '`nivel`');
await addIndexIfMissing('questoes', 'idx_bq_tipo',     '`tipo`');
await addIndexIfMissing('questoes', 'idx_bq_bimestre', '`bimestre`');
await addIndexIfMissing('questoes', 'idx_bq_bncc',     '`habilidade_bncc`');
await addIndexIfMissing('questoes', 'idx_bq_status',   '`status`');
await addIndexIfMissing('questoes', 'idx_bq_disc',     '`disciplina`(50)');

// ── Atualiza legado ───────────────────────────────────────────────────────────
const [upd] = await conn.query(
  "UPDATE questoes SET status = 'ativa' WHERE status IS NULL OR status NOT IN ('rascunho','ativa','arquivada')"
);
console.log(`\n  ✅ ${upd.affectedRows} questão(ões) marcadas como 'ativa' (legado)`);

// ── Resumo final ──────────────────────────────────────────────────────────────
const [[count]] = await conn.query('SELECT COUNT(*) AS total FROM questoes');
console.log(`\n🎉 Migração concluída! Total de questões no banco: ${count.total}\n`);

await conn.end();
