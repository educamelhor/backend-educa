import pool from './db.js';

const sql = `
CREATE TABLE IF NOT EXISTS escola_modulos (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  escola_id  INT NOT NULL,
  modulo     VARCHAR(100) NOT NULL,
  ativo      TINYINT(1) NOT NULL DEFAULT 0,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_escola_modulo (escola_id, modulo),
  CONSTRAINT fk_escola_modulos_escola
    FOREIGN KEY (escola_id) REFERENCES escolas(id) ON DELETE CASCADE
)
`;

try {
  const [result] = await pool.query(sql);
  console.log('[MIGRATION] escola_modulos criada com sucesso.');
} catch(e) {
  if (e.code === 'ER_TABLE_EXISTS_ERROR') {
    console.log('[MIGRATION] Tabela escola_modulos ja existe.');
  } else {
    console.error('[MIGRATION] Erro:', e.message);
  }
} finally {
  process.exit(0);
}
