import db from './db.js';

async function run() {
  // 1) Todos os planos_avaliacao de PD2 da escola POMPS
  console.log('\n=== planos_avaliacao: PD2 (escola POMPS) ===');
  const [planos] = await db.query(`
    SELECT pa.id, pa.disciplina, pa.turmas, pa.bimestre, pa.status
    FROM planos_avaliacao pa
    WHERE pa.escola_id = 3 AND pa.disciplina = 'PD2'
    ORDER BY pa.turmas, pa.bimestre
  `);
  console.table(planos);

  // 2) Modulacao de PD2 (escola POMPS) — com turma_id e turno
  console.log('\n=== modulacao: PD2 por turma e turno ===');
  const [mods] = await db.query(`
    SELECT 
      mo.id AS mod_id, t.id AS turma_id, t.nome AS turma, t.turno, 
      d.nome AS disciplina, p.nome AS professor
    FROM modulacao mo
    JOIN turmas t ON t.id = mo.turma_id
    JOIN disciplinas d ON d.id = mo.disciplina_id AND d.nome = 'PD2'
    JOIN professores p ON p.id = mo.professor_id
    WHERE mo.escola_id = 3
    ORDER BY t.nome, t.turno
  `);
  console.table(mods);

  // 3) Turmas do noturno na escola POMPS em 2026
  console.log('\n=== turmas NOTURNAS escola POMPS 2026 ===');
  const [turmas] = await db.query(`
    SELECT id, nome, turno FROM turmas
    WHERE escola_id = 3 AND ano = 2026
    ORDER BY turno, nome
  `);
  console.table(turmas);

  process.exit();
}

run().catch(console.error);
