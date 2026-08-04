import pool from "../db.js";

async function up() {
  const connection = await pool.getConnection();

  try {
    console.log("Iniciando migração: Criando tabela merenda_distribuicoes...");

    await connection.query(`
      CREATE TABLE IF NOT EXISTS merenda_distribuicoes (
        id INT AUTO_INCREMENT PRIMARY KEY,
        escola_id INT NOT NULL,
        data_inicio DATE NOT NULL,
        data_fim DATE NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    console.log("Tabela merenda_distribuicoes criada/verificada com sucesso.");
  } catch (err) {
    console.error("Erro na migração:", err);
  } finally {
    connection.release();
    process.exit(0);
  }
}

up();
