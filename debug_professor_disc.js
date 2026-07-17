import db from './db.js';

// Debug: verificar como o professor é identificado pelo token/usuario
// Use o usuario_id de um professor que faz login (ex: professora Dandara)
// Substitua USUARIO_ID pelo id real do usuário da Dandara
const ESCOLA_ID = 1; // ajuste conforme necessário
const TURMA_ID = 218; // Turma 8º ANO C (ajuste pelo ID real)

async function run() {
  try {
    // 1. Verificar usuários que são professores (amostra)
    const [usuarios] = await db.query(
      `SELECT id, nome, email, cpf, perfil FROM usuarios WHERE perfil = 'professor' AND escola_id = ? LIMIT 5`,
      [ESCOLA_ID]
    );
    console.log('\n1. Usuários professor (primeiros 5):');
    console.log(usuarios);

    // 2. Verificar se professores têm cpf
    const [profSemCpf] = await db.query(
      `SELECT COUNT(*) as total FROM usuarios WHERE perfil = 'professor' AND escola_id = ? AND (cpf IS NULL OR cpf = '')`,
      [ESCOLA_ID]
    );
    console.log('\n2. Professores SEM cpf na tabela usuarios:', profSemCpf[0].total);

    // 3. Verificar tabela professores e como se liga a usuarios
    const [profCols] = await db.query(`DESCRIBE professores`);
    console.log('\n3. Colunas da tabela professores:');
    console.log(profCols.map(c => `  ${c.Field} (${c.Type})`).join('\n'));

    // 4. Verificar se existe usuario_id na tabela professores
    const hasUsuarioId = profCols.some(c => c.Field === 'usuario_id');
    console.log('\n4. professores tem coluna usuario_id?', hasUsuarioId);

    // 5. Amostra da tabela professores
    const [profAmostra] = await db.query(
      `SELECT * FROM professores WHERE escola_id = ? LIMIT 3`,
      [ESCOLA_ID]
    );
    console.log('\n5. Amostra professores:');
    console.log(profAmostra);

    // 6. Verificar tabela modulacao
    const [modCols] = await db.query(`DESCRIBE modulacao`);
    console.log('\n6. Colunas da tabela modulacao:');
    console.log(modCols.map(c => `  ${c.Field} (${c.Type})`).join('\n'));

    // 7. Amostra modulacao para a turma
    const [modAmostra] = await db.query(
      `SELECT mo.*, p.nome as prof_nome, p.cpf as prof_cpf, d.nome as disc_nome
       FROM modulacao mo
       JOIN professores p ON p.id = mo.professor_id
       JOIN disciplinas d ON d.id = mo.disciplina_id
       WHERE mo.turma_id = ?
       LIMIT 10`,
      [TURMA_ID]
    );
    console.log(`\n7. Modulacao da turma ${TURMA_ID}:`);
    console.log(modAmostra);

    // 8. Cruzar usuario com professor via CPF (como o código faz)
    if (usuarios.length > 0) {
      const u = usuarios[0];
      const cpfLimpo = u.cpf ? String(u.cpf).replace(/\D/g, '') : '';
      console.log(`\n8. Testando usuario ID=${u.id}, CPF=${u.cpf}, CPF limpo="${cpfLimpo}"`);
      if (cpfLimpo) {
        const [prof] = await db.query(
          `SELECT p.id, p.nome, p.cpf FROM professores p
           WHERE p.escola_id = ?
             AND REPLACE(REPLACE(p.cpf, '.', ''), '-', '') = ?`,
          [ESCOLA_ID, cpfLimpo]
        );
        console.log('   Professor encontrado:', prof);
      } else {
        console.log('   ⚠️ CPF vazio no usuarios — a detecção falha!');
      }
    }

    process.exit(0);
  } catch (err) {
    console.error('Erro:', err.message);
    process.exit(1);
  }
}

run();
