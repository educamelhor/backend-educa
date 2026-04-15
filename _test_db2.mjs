// Simula ambiente de producao (NODE_ENV=production, sem MYSQL_HOST, somente DATABASE_URL)
// Remove vars individuais para forcar uso do DATABASE_URL

// Dobra verificacao: o que process.env tem agora
const dbUrl = process.env.DATABASE_URL;
const mysqlHost = process.env.MYSQL_HOST;
console.log("NODE_ENV:", process.env.NODE_ENV);
console.log("DATABASE_URL present:", !!dbUrl, dbUrl ? dbUrl.slice(0, 40) + "..." : "NONE");
console.log("MYSQL_HOST:", mysqlHost || "UNDEFINED");

import pool from './db.js';

try {
  const conn = await pool.getConnection();
  const [rows] = await conn.query('SELECT 1 AS ok, @@hostname AS host, @@port AS port');
  console.log('\n✅ DB OK:', rows[0]);
  conn.release();
} catch (e) {
  console.error('\n❌ DB FALHOU:', e.message);
}
await pool.end();
process.exit(0);
