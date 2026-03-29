import pool from '../db.js';

async function migrate() {
  try {
    await pool.query(`
      ALTER TABLE gabarito_avaliacoes 
      MODIFY COLUMN status ENUM('rascunho','publicada','em_correcao','finalizada','notas_importadas') 
      DEFAULT 'rascunho'
    `);
    console.log('✅ Migration OK: status enum updated with notas_importadas');
  } catch (err) {
    console.error('❌ Migration error:', err.message);
  }
  process.exit(0);
}

migrate();
