import db from './db.js';

// Diagnóstico: verificar dados reais da tabela notas para alunos de uma turma
// Substitua TURMA_ID pelo ID real da turma 8º ANO E
const TURMA_ID = 221;
const ANO = 2026;
const BIMESTRE = 2;

async function run() {
  try {
    // 1. Alunos da turma via matriculas
    const [alunos] = await db.query(
      `SELECT DISTINCT a.id, a.estudante AS nome
       FROM matriculas m
       JOIN alunos a ON a.id = m.aluno_id
       WHERE m.turma_id = ? AND m.ano_letivo = ?
       LIMIT 5`,
      [TURMA_ID, ANO]
    );
    console.log(`\n1. Alunos na turma ${TURMA_ID} (ano_letivo=${ANO}):`);
    console.log(alunos.length > 0 ? alunos : '⚠️ NENHUM aluno encontrado com ano_letivo=2026');

    if (alunos.length === 0) {
      // Tentar sem filtro de ano
      const [alunosSemAno] = await db.query(
        `SELECT DISTINCT a.id, a.estudante AS nome, m.ano_letivo
         FROM matriculas m
         JOIN alunos a ON a.id = m.aluno_id
         WHERE m.turma_id = ?
         LIMIT 5`,
        [TURMA_ID]
      );
      console.log('   Matriculas existentes (qualquer ano):', alunosSemAno);
    }

    // 2. Verificar colunas disponíveis na tabela notas
    const [cols] = await db.query(`DESCRIBE notas`);
    console.log('\n2. Colunas da tabela notas:');
    console.log(cols.map(c => `  ${c.Field} (${c.Type})`).join('\n'));

    // 3. Exemplo de notas existentes (qualquer aluno da escola)
    const [exemploNotas] = await db.query(
      `SELECT aluno_id, disciplina_id, bimestre, ano, nota
       FROM notas
       LIMIT 3`
    );
    console.log('\n3. Exemplo de 3 notas na tabela (qualquer):');
    console.log(exemploNotas);

    // 4. Se temos alunos, checar se eles têm notas
    if (alunos.length > 0) {
      const ids = alunos.map(a => a.id);
      const ph = ids.map(() => '?').join(',');
      const [notasAlunos] = await db.query(
        `SELECT aluno_id, disciplina_id, bimestre, ano, nota FROM notas WHERE aluno_id IN (${ph}) LIMIT 10`,
        ids
      );
      console.log(`\n4. Notas dos alunos da turma (qualquer bimestre/ano):`);
      console.log(notasAlunos.length > 0 ? notasAlunos : '⚠️ NENHUMA nota encontrada para esses alunos');

      // 5. Quais anos/bimestres existem para esses alunos?
      if (notasAlunos.length > 0) {
        const [dist] = await db.query(
          `SELECT DISTINCT ano, bimestre, COUNT(*) as qtd
           FROM notas WHERE aluno_id IN (${ph})
           GROUP BY ano, bimestre ORDER BY ano, bimestre`,
          ids
        );
        console.log('\n5. Anos/Bimestres disponíveis:');
        console.log(dist);
      }
    }

    process.exit(0);
  } catch (err) {
    console.error('Erro:', err.message);
    process.exit(1);
  }
}

run();
