// _migracao_db/migrate_sprint5.mjs
// EDUCA.PROVA — Sprint 5: Governança + Polish
// Executar: node _migracao_db/migrate_sprint5.mjs

import mysql from 'mysql2/promise';
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
  ssl: process.env.MYSQL_SSLMODE === 'REQUIRED' ? { rejectUnauthorized: false } : undefined,
  multipleStatements: true,
});

console.log('✅ Conectado:', process.env.MYSQL_DATABASE);

async function run(sql, label) {
  try {
    await conn.query(sql);
    console.log('  ✅', label);
  } catch (e) {
    if (e.code === 'ER_DUP_FIELDNAME' || e.code === 'ER_TABLE_EXISTS_ERROR' ||
        e.code === 'ER_DUP_KEYNAME'   || (e.sqlMessage || '').includes('Duplicate column')) {
      console.log('  ⏭️  Já existe:', label);
    } else {
      console.error('  ❌', label, ':', e.sqlMessage || e.message);
    }
  }
}

async function migrate() {

  console.log('\n📦 Sprint 5 — Governança + Polish\n');

  // ── Tabela questoes: novos campos ──────────────────────────────────────────
  await run(`ALTER TABLE questoes ADD COLUMN vezes_utilizada INT DEFAULT 0`, 'questoes.vezes_utilizada');
  await run(`ALTER TABLE questoes ADD COLUMN professor_nome VARCHAR(120)`,   'questoes.professor_nome');

  // ── Tabela provas: embaralhar alternativas ─────────────────────────────────
  await run(`ALTER TABLE provas ADD COLUMN embaralhar_alternativas TINYINT(1) DEFAULT 0`, 'provas.embaralhar_alternativas');
  await run(`ALTER TABLE provas ADD COLUMN pdf_url VARCHAR(500)`,            'provas.pdf_url');
  await run(`ALTER TABLE provas ADD COLUMN gabarito_pdf_url VARCHAR(500)`,   'provas.gabarito_pdf_url');

  // ── Tabela questoes_historico (audit trail) ────────────────────────────────
  await run(`
    CREATE TABLE IF NOT EXISTS questoes_historico (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      questao_id  INT NOT NULL,
      usuario_id  INT,
      acao        ENUM('criou','editou','arquivou','usou_em_prova','duplicou','restaurou') NOT NULL,
      prova_id    INT,
      snapshot_json LONGTEXT,
      criado_em   DATETIME DEFAULT NOW(),
      INDEX idx_questao (questao_id),
      INDEX idx_usuario (usuario_id),
      INDEX idx_acao    (acao)
    )
  `, 'tabela questoes_historico');

  // ── Index vezes_utilizada para ordenação ──────────────────────────────────
  await run(`ALTER TABLE questoes ADD INDEX idx_vezes (vezes_utilizada DESC)`, 'idx_vezes_utilizada');

  // ── Atualiza vezes_utilizada existentes ───────────────────────────────────
  await run(`
    UPDATE questoes q
    SET vezes_utilizada = (
      SELECT COUNT(*) FROM prova_questoes pq WHERE pq.questao_id = q.id
    )
    WHERE 1=1
  `, 'Sync vezes_utilizada existentes');

  const [[r1]] = await conn.query('SELECT COUNT(*) AS n FROM questoes_historico');
  const [[r2]] = await conn.query('SELECT COUNT(*) AS n FROM questoes WHERE vezes_utilizada > 0');
  console.log(`\n🎉 Sprint 5 migração concluída!`);
  console.log(`   historico=${r1.n} | questões com uso=${r2.n}\n`);
}

await migrate().catch(e => { console.error('FATAL:', e.message); process.exit(1); }).finally(() => conn?.end());

