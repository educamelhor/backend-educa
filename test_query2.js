import db from './db.js';

async function run() {
  const sql = `
    SELECT 
      pa.id as plano_id,
      pa.disciplina, 
      COALESCE(MAX(CASE WHEN mod_prof.professor_id IS NOT NULL THEN t.nome END), MAX(t.nome)) AS turma_nome, 
      COALESCE(MAX(CASE WHEN mod_prof.professor_id IS NOT NULL THEN t.turno END), MAX(t.turno)) AS turno,
      MAX(mod_prof.professor_nome) AS professor_nome 
    FROM planos_avaliacao pa 
    JOIN turmas t 
      ON CONVERT(t.nome USING utf8mb4) COLLATE utf8mb4_unicode_ci = CONVERT(pa.turmas USING utf8mb4) COLLATE utf8mb4_unicode_ci 
     AND t.escola_id = pa.escola_id 
     AND t.ano = pa.ano 
    LEFT JOIN (
      SELECT 
        mo.turma_id, 
        d.nome AS disciplina_nome, 
        p.nome AS professor_nome, 
        mo.escola_id,
        mo.professor_id
      FROM modulacao mo 
      JOIN disciplinas d ON d.id = mo.disciplina_id 
      JOIN professores p ON p.id = mo.professor_id 
      GROUP BY mo.turma_id, d.nome, p.nome, mo.escola_id, mo.professor_id
    ) mod_prof 
      ON mod_prof.turma_id = t.id 
     AND CONVERT(mod_prof.disciplina_nome USING utf8mb4) COLLATE utf8mb4_unicode_ci = CONVERT(pa.disciplina USING utf8mb4) COLLATE utf8mb4_unicode_ci 
     AND mod_prof.escola_id = pa.escola_id 
    WHERE pa.escola_id = 3 AND t.nome = '7º ANO A'
    GROUP BY pa.id
  `;
  try {
    const [rows] = await db.query(sql);
    console.log(rows);
  } catch (err) {
    console.error(err);
  } finally {
    process.exit();
  }
}

run();
