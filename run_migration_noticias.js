// run_migration_noticias.js
// Cria a tabela noticias no banco de dados de producao.
// Uso: node run_migration_noticias.js
import pool from './db.js';

async function run() {
  const db = pool;
  console.log('[NOTICIAS] Iniciando migracao...');

  await db.query(
    CREATE TABLE IF NOT EXISTS noticias (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      escola_id   INT          NOT NULL,
      titulo      VARCHAR(120) NOT NULL DEFAULT 'Novidade',
      descricao   TEXT,
      imagem_url  TEXT         NOT NULL,
      ativo       TINYINT(1)   NOT NULL DEFAULT 1,
      criado_em   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_noticias_escola FOREIGN KEY (escola_id) REFERENCES escolas(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  );
  console.log('[NOTICIAS] Tabela criada (ou ja existia).');

  // Index para performance (ignora erro se ja existir)
  try {
    await db.query(CREATE INDEX idx_noticias_escola_ativo ON noticias (escola_id, ativo, criado_em DESC));
    console.log('[NOTICIAS] Index criado.');
  } catch(e) {
    if (e.code === 'ER_DUP_KEYNAME') console.log('[NOTICIAS] Index ja existe, ok.');
    else throw e;
  }

  console.log('[NOTICIAS] Migracao concluida!');
  process.exit(0);
}

run().catch(e => { console.error(e); process.exit(1); });
