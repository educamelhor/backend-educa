// run_migration_atenuantes_agravantes.js
// Adiciona colunas atenuantes e agravantes (JSON) na tabela ocorrencias_disciplinares
// Art. 34 (atenuantes) e Art. 35 (agravantes) do Regulamento Disciplinar CCMDF
// Executar no servidor DO: node run_migration_atenuantes_agravantes.js

import pool from "./db.js";

async function run() {
  console.log("🔄 Iniciando migration: atenuantes e agravantes...");

  const [columns] = await pool.query(
    `SELECT COLUMN_NAME
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'ocorrencias_disciplinares'
       AND COLUMN_NAME IN ('atenuantes', 'agravantes')`
  );
  const existentes = columns.map((c) => c.COLUMN_NAME);

  if (!existentes.includes("atenuantes")) {
    await pool.query(
      `ALTER TABLE ocorrencias_disciplinares
       ADD COLUMN atenuantes JSON NULL
         COMMENT 'Art. 34 – circunstâncias atenuantes (array de strings)'
       AFTER dias_suspensao`
    );
    console.log("✅ Coluna 'atenuantes' adicionada.");
  } else {
    console.log("ℹ️  Coluna 'atenuantes' já existe — pulando.");
  }

  if (!existentes.includes("agravantes")) {
    await pool.query(
      `ALTER TABLE ocorrencias_disciplinares
       ADD COLUMN agravantes JSON NULL
         COMMENT 'Art. 35 – circunstâncias agravantes (array de strings)'
       AFTER atenuantes`
    );
    console.log("✅ Coluna 'agravantes' adicionada.");
  } else {
    console.log("ℹ️  Coluna 'agravantes' já existe — pulando.");
  }

  console.log("🏁 Migration concluída com sucesso.");
  process.exit(0);
}

run().catch((err) => {
  console.error("❌ Erro na migration:", err);
  process.exit(1);
});
