import db from './db.js';

const IDS = [547, 496, 514];

async function run() {
  const [result] = await db.query(
    `DELETE FROM planos_avaliacao WHERE id IN (?)`,
    [IDS]
  );
  console.log('✅ Registros excluídos:', result.affectedRows);

  // Confirma que sumiram
  const [check] = await db.query(
    `SELECT id FROM planos_avaliacao WHERE id IN (?)`,
    [IDS]
  );
  console.log('Restantes no banco:', check.length === 0 ? 'Nenhum ✅' : check);

  process.exit();
}

run().catch(console.error);
