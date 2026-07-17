import pool from './db.js';

async function run() {
  try {
    // Notas do diário da ALANA - sem join com planos_avaliacao para não errar colunas
    const [rows] = await pool.query(`
      SELECT nd.*, a.estudante
      FROM notas_diario nd
      JOIN alunos a ON a.id = nd.aluno_id
      WHERE a.estudante LIKE '%ALANA%' AND a.estudante LIKE '%BUENO%'
      ORDER BY nd.plano_id, nd.item_idx
    `);
    console.log("=== NOTAS DIÁRIO ===");
    console.log(JSON.stringify(rows, null, 2));

    // Planos associados
    if (rows.length > 0) {
      const planoIds = [...new Set(rows.map(r => r.plano_id))];
      const [planos] = await pool.query(
        `SELECT id, turmas, disciplina, bimestre, status FROM planos_avaliacao WHERE id IN (${planoIds.map(() => '?').join(',')})`,
        planoIds
      );
      console.log("\n=== PLANOS ASSOCIADOS ===");
      console.log(JSON.stringify(planos, null, 2));
    }

    // Gabaritos da ALANA
    try {
      const [gabs] = await pool.query(`
        SELECT gla.*, a.estudante, gl.bimestre, gl.turma_nome
        FROM gabarito_lotes_alunos gla
        JOIN alunos a ON a.id = gla.aluno_id
        JOIN gabarito_lotes gl ON gl.id = gla.lote_id
        WHERE a.estudante LIKE '%ALANA%' AND a.estudante LIKE '%BUENO%'
        ORDER BY gl.bimestre
      `);
      console.log("\n=== GABARITOS LOTES ===");
      console.log(JSON.stringify(gabs, null, 2));
    } catch(e) {
      console.log("\n=== GABARITOS LOTES: erro:", e.message);
    }

    process.exit(0);
  } catch (err) {
    console.error("Erro:", err.message);
    process.exit(1);
  }
}

run();
