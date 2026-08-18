import pool from './db.js';

async function run() {
  try {
    console.log("Criando tabela ocorrencias_visualizacoes...");

    const sql = `
      CREATE TABLE IF NOT EXISTS ocorrencias_visualizacoes (
        id INT AUTO_INCREMENT PRIMARY KEY,
        ocorrencia_id INT NOT NULL,
        responsavel_id INT NOT NULL,
        visualizado_em DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY unq_ocorrencia_responsavel (ocorrencia_id, responsavel_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `;

    await pool.query(sql);

    console.log("Tabela ocorrencias_visualizacoes criada com sucesso.");
    process.exit(0);
  } catch (error) {
    console.error("Erro ao criar a tabela:", error);
    process.exit(1);
  }
}

run();
