// Migration runner: adiciona 'scan_mobile' ao ENUM origem de gabarito_respostas
// Execute: node _migracao_db/run_add_scan_mobile_origem.mjs

import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '..', '.env.development') });

const { MYSQL_HOST, MYSQL_PORT, MYSQL_USER, MYSQL_PASSWORD, MYSQL_DATABASE } = process.env;

const pool = await mysql.createConnection({
  host: MYSQL_HOST,
  port: Number(MYSQL_PORT) || 3306,
  user: MYSQL_USER,
  password: MYSQL_PASSWORD,
  database: MYSQL_DATABASE,
  ssl: { rejectUnauthorized: false },
});

console.log('[migration] Conectado ao banco. Executando ALTER TABLE...');

await pool.execute(`
  ALTER TABLE gabarito_respostas
    MODIFY COLUMN origem ENUM('omr', 'manual', 'scan_mobile') DEFAULT 'omr'
`);

console.log('[migration] ✅ ENUM origem atualizado: omr | manual | scan_mobile');

await pool.end();
