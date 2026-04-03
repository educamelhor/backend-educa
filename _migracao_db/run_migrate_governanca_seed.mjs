// run_migrate_governanca_seed.mjs
// Executa a migração de governança (cria tabelas + seed de categorias e itens)
// Uso: node _migracao_db/run_migrate_governanca_seed.mjs

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import pool from '../db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function migrate() {
  try {
    const sql = readFileSync(join(__dirname, 'migrate_governanca_seed.sql'), 'utf-8');

    // Divide por ";" para executar statement por statement
    const statements = sql
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0 && !s.startsWith('--'));

    for (const stmt of statements) {
      try {
        await pool.query(stmt);
        // Mostra os primeiros 60 chars para feedback
        const preview = stmt.replace(/\s+/g, ' ').slice(0, 60);
        console.log(`✅ OK: ${preview}...`);
      } catch (err) {
        // Ignora erros de duplicata (esperado com INSERT IGNORE)
        if (err.code === 'ER_DUP_ENTRY') {
          console.log(`⚠️  SKIP (já existe): ${stmt.slice(0, 60)}...`);
        } else {
          console.error(`❌ ERRO: ${err.message}`);
          console.error(`   SQL: ${stmt.slice(0, 100)}...`);
        }
      }
    }

    console.log('\n🎉 Migração de governança concluída!');
  } catch (err) {
    console.error('❌ Erro fatal na migração:', err.message);
  }
  process.exit(0);
}

migrate();
