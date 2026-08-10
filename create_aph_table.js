import pool from './db.js';

async function run() {
  try {
    const createTableQuery = `
      CREATE TABLE IF NOT EXISTS aph_atendimentos (
        id INT AUTO_INCREMENT PRIMARY KEY,
        aluno_id INT NOT NULL,
        escola_id INT NOT NULL,
        data_ocorrencia DATETIME DEFAULT CURRENT_TIMESTAMP,
        local VARCHAR(255),
        solicitante VARCHAR(255),
        motivos JSON,
        relato TEXT,
        condicao_geral VARCHAR(100),
        sinais JSON,
        atendimentos JSON,
        descricao_atendimento TEXT,
        desfecho VARCHAR(255),
        comunicacao_resp VARCHAR(255),
        numero_atendimento VARCHAR(50),
        socorrista_nome VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX (aluno_id),
        INDEX (escola_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `;

    console.log("Criando tabela aph_atendimentos...");
    await pool.query(createTableQuery);
    console.log("Tabela aph_atendimentos criada ou já existente com sucesso!");
    
  } catch (error) {
    console.error("Erro ao criar tabela:", error);
  } finally {
    process.exit();
  }
}

run();
