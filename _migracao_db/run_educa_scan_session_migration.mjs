// run_educa_scan_session_migration.mjs
// Executa a migração add_educa_scan_session.sql no banco de dados
import pool from '../db.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function run() {
  const sql = fs.readFileSync(
    path.join(__dirname, 'add_educa_scan_session.sql'),
    'utf8'
  );

  // Executar cada statement separadamente
  const statements = sql
    .split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0 && !s.startsWith('--'));

  console.log(`[migration] Executando ${statements.length} statements...`);

  for (const stmt of statements) {
    try {
      await pool.query(stmt);
      console.log(`[migration] OK: ${stmt.slice(0, 80)}...`);
    } catch (err) {
      if (err.code === 'ER_DUP_FIELDNAME' || err.message.includes('Duplicate column')) {
        console.log(`[migration] SKIP (já existe): ${stmt.slice(0, 80)}`);
      } else {
        console.error(`[migration] ERRO: ${err.message}`);
        console.error(`  Statement: ${stmt.slice(0, 120)}`);
      }
    }
  }

  console.log('[migration] Concluída!');
  process.exit(0);
}

run().catch(err => {
  console.error('[migration] Fatal:', err);
  process.exit(1);
});
