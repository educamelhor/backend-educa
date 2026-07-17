import db from './db.js';

async function run() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS mapa_nota_flags (
        id             INT AUTO_INCREMENT PRIMARY KEY,
        escola_id      INT NOT NULL,
        usuario_id     INT NOT NULL,
        aluno_id       INT NOT NULL,
        disciplina_id  INT NOT NULL,
        bimestre       TINYINT NOT NULL,
        ano            YEAR NOT NULL,
        flagged        TINYINT(1) NOT NULL DEFAULT 1,
        updated_at     DATETIME DEFAULT NOW() ON UPDATE NOW(),
        UNIQUE KEY uk_flag (escola_id, usuario_id, aluno_id, disciplina_id, bimestre, ano)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('✅ Tabela mapa_nota_flags criada (ou já existia).');
    process.exit(0);
  } catch (err) {
    console.error('❌ Erro:', err.message);
    process.exit(1);
  }
}

run();
