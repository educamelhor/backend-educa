import pool from './db.js';

async function run() {
  try {
    const sql = 'CREATE TABLE IF NOT EXISTS ocorrencias_pedagogicas_visualizacoes (id INT AUTO_INCREMENT PRIMARY KEY, ocorrencia_id INT NOT NULL, responsavel_id INT NOT NULL, visualizado_em DATETIME DEFAULT CURRENT_TIMESTAMP, UNIQUE KEY unq_ocorrencia_ped_responsavel (ocorrencia_id, responsavel_id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;';
    await pool.query(sql);
    console.log('Tabela criada.');
    process.exit(0);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
}

run();
