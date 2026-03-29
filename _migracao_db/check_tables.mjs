import pool from '../db.js';
async function check() {
  try {
    const [r1] = await pool.query('DESCRIBE notas_diario');
    console.log('notas_diario:', r1.map(c => c.Field).join(', '));
  } catch(e) { console.log('notas_diario MISSING:', e.message); }
  try {
    const [r2] = await pool.query('DESCRIBE diario_fechamento');
    console.log('diario_fechamento:', r2.map(c => c.Field).join(', '));
  } catch(e) { console.log('diario_fechamento MISSING:', e.message); }
  try {
    const [r3] = await pool.query("SHOW COLUMNS FROM planos_avaliacao WHERE Field = 'status'");
    console.log('planos_avaliacao.status:', r3[0]?.Type);
  } catch(e) { console.log('status check failed:', e.message); }
  process.exit(0);
}
check();
