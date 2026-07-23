import 'dotenv/config';
import pool from './db.js';
async function run() {
  try {
    await pool.query('ALTER TABLE escola_configuracao_grade ADD COLUMN regras_gerais JSON');
    console.log('Column added');
  } catch (err) {
    if (err.code === 'ER_DUP_FIELDNAME') console.log('Column already exists');
    else console.error(err);
  }
  process.exit();
}
run();
