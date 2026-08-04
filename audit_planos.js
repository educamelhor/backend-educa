import db from './db.js';

async function run() {
  // 1) Verificar se planos_avaliacao tem campo turno
  console.log('\n=== Estrutura da tabela planos_avaliacao ===');
  const [cols] = await db.query('DESCRIBE planos_avaliacao');
  console.table(cols.map(c => ({ Field: c.Field, Type: c.Type, Null: c.Null, Default: c.Default })));

  // 2) Quem é o usuario_id 100035 (criador do plano 708)?
  console.log('\n=== Usuário que criou o plano 708 ===');
  const [usuario] = await db.query(`
    SELECT u.id, u.nome, u.tipo, u.escola_id, p.id AS professor_id
    FROM usuarios u
    LEFT JOIN professores p ON p.usuario_id = u.id
    WHERE u.id = 100035
  `);
  console.table(usuario);

  // 3) Qual turma+turno esse professor tem na modulação?
  const profId = usuario[0]?.professor_id;
  if (profId) {
    console.log('\n=== Modulação do professor (id=' + profId + ') ===');
    const [mods] = await db.query(`
      SELECT mo.id, t.id AS turma_id, t.nome AS turma, t.turno, d.nome AS disciplina
      FROM modulacao mo
      JOIN turmas t ON t.id = mo.turma_id
      JOIN disciplinas d ON d.id = mo.disciplina_id
      WHERE mo.professor_id = ?
      ORDER BY t.nome, d.nome
    `, [profId]);
    console.table(mods);
  }

  // 4) Como o professor cria o plano? Buscar no route de professores
  // Verificar se o INSERT salva turno
  console.log('\n=== Planos recentes criados por professores do noturno 7A ===');
  const [recentes] = await db.query(`
    SELECT pa.id, pa.disciplina, pa.turmas, pa.bimestre, pa.status, pa.usuario_id,
           u.nome AS criado_por
    FROM planos_avaliacao pa
    JOIN usuarios u ON u.id = pa.usuario_id
    WHERE pa.escola_id = 3 AND pa.turmas = '7º ANO A' AND pa.ano = 2026
    ORDER BY pa.id
  `);
  console.table(recentes);

  process.exit();
}
run().catch(console.error);
