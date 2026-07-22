// migrate_semestres.js
// Roda as 4 migrations de suporte a semestres
import pool from './db.js';

async function run() {
  const conn = await pool.getConnection();
  try {
    // A: turmas.regime
    try {
      await conn.query(`ALTER TABLE turmas ADD COLUMN regime ENUM('anual','semestral') NOT NULL DEFAULT 'anual' AFTER turno`);
      console.log('✅ A: turmas.regime adicionado');
    } catch(e) { console.log('⚠️  A: turmas.regime já existe ou erro:', e.message); }

    // B: turma_cargas.semestre
    try {
      await conn.query(`ALTER TABLE turma_cargas ADD COLUMN semestre TINYINT(1) NOT NULL DEFAULT 1 AFTER turma_id`);
      console.log('✅ B: turma_cargas.semestre adicionado');
    } catch(e) { console.log('⚠️  B: turma_cargas.semestre já existe ou erro:', e.message); }

    // B2: drop old unique, add new
    try { await conn.query(`ALTER TABLE turma_cargas DROP INDEX uk_turma_disc`); } catch(e) {}
    try {
      await conn.query(`ALTER TABLE turma_cargas ADD UNIQUE KEY uk_turma_disc_semestre (escola_id, turma_id, disciplina_id, semestre)`);
      console.log('✅ B2: unique index uk_turma_disc_semestre OK');
    } catch(e) { console.log('⚠️  B2: index:', e.message); }

    // C: planos_avaliacao.semestre
    try {
      await conn.query(`ALTER TABLE planos_avaliacao ADD COLUMN semestre TINYINT(1) DEFAULT NULL AFTER bimestre`);
      console.log('✅ C: planos_avaliacao.semestre adicionado');
    } catch(e) { console.log('⚠️  C: planos_avaliacao.semestre já existe ou erro:', e.message); }

    // D: notas_diario.semestre
    try {
      await conn.query(`ALTER TABLE notas_diario ADD COLUMN semestre TINYINT(1) DEFAULT NULL AFTER plano_id`);
      console.log('✅ D: notas_diario.semestre adicionado');
    } catch(e) { console.log('⚠️  D: notas_diario.semestre já existe ou erro:', e.message); }

    console.log('\n🎉 Migrations concluídas!');
  } finally {
    conn.release();
    await pool.end();
  }
}

run().catch(e => { console.error('ERRO FATAL:', e); process.exit(1); });
