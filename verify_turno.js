import db from './db.js';

async function run() {
  console.log('\n=== Teste completo: query exata do backend (sem filtros extras) ===');
  try {
    const params = [3, 2026];
    const sql = `
      SELECT
        pa.id AS plano_id, pa.status AS plano_status, pa.bimestre, pa.ano,
        pa.disciplina AS disciplina_nome,
        IF(df.id IS NOT NULL, 1, 0) AS diario_fechado,
        t.id AS turma_id, t.nome AS turma_nome, t.turno,
        mod_prof.professor_id, mod_prof.professor_nome
      FROM planos_avaliacao pa
      JOIN turmas t
        ON CONVERT(t.nome USING utf8mb4) COLLATE utf8mb4_unicode_ci
         = CONVERT(pa.turmas USING utf8mb4) COLLATE utf8mb4_unicode_ci
       AND t.escola_id = pa.escola_id
       AND t.ano       = pa.ano
       AND (pa.turno IS NULL OR
            CONVERT(t.turno USING utf8mb4) COLLATE utf8mb4_unicode_ci
            = CONVERT(pa.turno USING utf8mb4) COLLATE utf8mb4_unicode_ci)
      LEFT JOIN (
        SELECT mo.turma_id, d.nome AS disciplina_nome, mo.professor_id, p.nome AS professor_nome, mo.escola_id
        FROM modulacao mo
        JOIN disciplinas d ON d.id = mo.disciplina_id
        JOIN professores p ON p.id = mo.professor_id
        GROUP BY mo.turma_id, d.nome, mo.professor_id, p.nome, mo.escola_id
      ) mod_prof
        ON mod_prof.turma_id = t.id
       AND CONVERT(mod_prof.disciplina_nome USING utf8mb4) COLLATE utf8mb4_unicode_ci
         = CONVERT(pa.disciplina USING utf8mb4) COLLATE utf8mb4_unicode_ci
       AND mod_prof.escola_id = pa.escola_id
      LEFT JOIN diario_fechamento df
        ON df.plano_id = pa.id AND df.turma_id = t.id AND df.escola_id = pa.escola_id
      WHERE pa.escola_id = ? AND pa.ano = ?
      ORDER BY mod_prof.professor_nome, t.nome, pa.disciplina
    `;
    const [rows] = await db.query(sql, params);
    console.log(`✅ Query OK! Total: ${rows.length} diários.`);

    // Verificar PD2 7A
    const pd2 = rows.filter(r => r.disciplina_nome === 'PD2' && r.turma_nome === '7º ANO A');
    console.log(`\nPD2 / 7º ANO A: ${pd2.length} linha(s) ${pd2.length === 1 ? '✅' : '🔴'}`);
    console.table(pd2.map(r => ({ plano_id: r.plano_id, disciplina: r.disciplina_nome, turma: r.turma_nome, turno: r.turno, professor: r.professor_nome })));

    // Linhas sem professor
    const semProf = rows.filter(r => !r.professor_nome);
    console.log(`\nLinhas sem professor: ${semProf.length}`);
    if (semProf.length > 0) {
      console.table(semProf.slice(0, 10).map(r => ({ plano_id: r.plano_id, disciplina: r.disciplina_nome, turma: r.turma_nome, turno: r.turno })));
    }
  } catch (err) {
    console.error('❌ ERRO:', err.sqlMessage || err.message);
  }
  process.exit();
}
run().catch(console.error);
