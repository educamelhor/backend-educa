import pool from '../db.js';

async function migrate() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS diario_fechamento (
        id INT AUTO_INCREMENT PRIMARY KEY,
        escola_id BIGINT UNSIGNED NOT NULL,
        plano_id INT NOT NULL,
        turma_id INT NOT NULL,
        fechado_em DATETIME DEFAULT CURRENT_TIMESTAMP,
        fechado_por INT DEFAULT NULL,
        total_alunos INT DEFAULT 0,
        total_notas_exportadas INT DEFAULT 0,
        UNIQUE KEY unq_fechamento (plano_id, turma_id),
        KEY idx_escola (escola_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    console.log('✅ Tabela diario_fechamento criada');
  } catch (err) {
    console.error('❌ Erro:', err.message);
  }
  process.exit(0);
}
migrate();
