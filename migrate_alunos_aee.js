import pool from './db.js';

async function run() {
  console.log("Iniciando migração de esquema de alunos...");
  try {
    const [rows] = await pool.query("SHOW COLUMNS FROM alunos LIKE 'atendimento_diferencial'");
    if (rows.length === 0) {
      console.log("Adicionando coluna atendimento_diferencial...");
      await pool.query("ALTER TABLE alunos ADD COLUMN atendimento_diferencial TINYINT(1) DEFAULT 0");
      console.log("Coluna atendimento_diferencial adicionada com sucesso!");
    } else {
      console.log("Coluna atendimento_diferencial já existe. Nenhuma alteração necessária.");
    }
    process.exit(0);
  } catch (err) {
    console.error("Erro na migração:", err);
    process.exit(1);
  }
}

run();
