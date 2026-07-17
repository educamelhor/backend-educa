import pool from './db.js';
async function run() {
  const [rows] = await pool.query('DESCRIBE alunos');
  console.log(JSON.stringify(rows, null, 2));
  process.exit(0);
}
run();
