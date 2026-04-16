// _migracao_db/migrate_dispositivos_confiados.mjs
// Cria tabela dispositivos_confiados para o fluxo "Confiar neste dispositivo"
// Executar: node _migracao_db/migrate_dispositivos_confiados.mjs

import mysql from 'mysql2/promise';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, '../.env.development') });

const conn = await mysql.createConnection({
  host:     process.env.MYSQL_HOST,
  port:     Number(process.env.MYSQL_PORT || 3306),
  user:     process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
  ssl: process.env.MYSQL_SSLMODE === 'REQUIRED' ? { rejectUnauthorized: false } : undefined,
  multipleStatements: true,
});

console.log('✅ Conectado:', process.env.MYSQL_DATABASE);

async function run(sql, label) {
  try {
    await conn.query(sql);
    console.log('  ✅', label);
  } catch (e) {
    if (
      e.code === 'ER_TABLE_EXISTS_ERROR' ||
      e.code === 'ER_DUP_FIELDNAME' ||
      e.code === 'ER_DUP_KEYNAME' ||
      (e.sqlMessage || '').includes('Duplicate')
    ) {
      console.log('  ⏭️  Já existe:', label);
    } else {
      console.error('  ❌', label, ':', e.sqlMessage || e.message);
    }
  }
}

async function migrate() {
  console.log('\n📦 Migracao — dispositivos_confiados\n');

  // Tabela principal: armazena tokens de dispositivos confiados por usuário
  await run(`
    CREATE TABLE IF NOT EXISTS dispositivos_confiados (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      usuario_id  INT NOT NULL,
      token_hash  VARCHAR(64) NOT NULL COMMENT 'SHA-256 do device_token enviado ao frontend',
      descricao   VARCHAR(200) COMMENT 'User-Agent resumido, para exibir nas configurações futuras',
      criado_em   DATETIME DEFAULT NOW(),
      expira_em   DATETIME NOT NULL COMMENT 'Validade: 90 dias por padrão',
      ultimo_uso  DATETIME DEFAULT NOW(),
      UNIQUE KEY uq_token (token_hash),
      INDEX idx_usuario (usuario_id),
      INDEX idx_expira  (expira_em)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `, 'tabela dispositivos_confiados');

  const [[r]] = await conn.query('SELECT COUNT(*) AS n FROM dispositivos_confiados');
  console.log(`\n🎉 Migração dispositivos_confiados concluída! Registros: ${r.n}\n`);
}

await migrate()
  .catch(e => { console.error('FATAL:', e.message); process.exit(1); })
  .finally(() => conn?.end());
