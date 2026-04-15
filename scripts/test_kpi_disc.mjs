import pool from '../db.js';

try {
  const [rows] = await pool.query(`
    SELECT
      o.id, o.aluno_id, o.data_ocorrencia, o.motivo, o.tipo_ocorrencia,
      o.descricao, o.convocar_responsavel, o.data_comparecimento_responsavel,
      o.status, o.criado_em, o.dias_suspensao,
      ANY_VALUE(a.estudante)                             AS aluno_nome,
      ANY_VALUE(a.codigo)                               AS aluno_codigo,
      ANY_VALUE(t.nome)                                 AS turma_nome,
      ANY_VALUE(t.turno)                                AS turma_turno,
      ANY_VALUE(COALESCE(r.medida_disciplinar, o.tipo_ocorrencia)) AS medida_disciplinar,
      ANY_VALUE(COALESCE(r.pontos, 0))                  AS pontos,
      ANY_VALUE(resp.nome)                              AS responsavel_nome,
      ANY_VALUE(resp.telefone_celular)                  AS responsavel_telefone,
      ANY_VALUE(u.nome)                                 AS registrado_por
    FROM ocorrencias_disciplinares o
    JOIN alunos a ON a.id = o.aluno_id AND a.escola_id = o.escola_id
    LEFT JOIN turmas t ON t.id = a.turma_id
    LEFT JOIN registros_ocorrencias r
      ON r.descricao_ocorrencia = o.motivo AND r.tipo_ocorrencia = o.tipo_ocorrencia
    LEFT JOIN responsaveis_alunos ra ON ra.aluno_id = o.aluno_id AND ra.escola_id = o.escola_id AND ra.ativo = 1
    LEFT JOIN responsaveis resp ON resp.id = ra.responsavel_id
    LEFT JOIN usuarios u ON u.id = o.usuario_finalizacao_id
    WHERE o.escola_id = 1
    GROUP BY o.id, o.aluno_id, o.data_ocorrencia, o.motivo, o.tipo_ocorrencia,
             o.descricao, o.convocar_responsavel, o.data_comparecimento_responsavel,
             o.status, o.criado_em, o.dias_suspensao
    ORDER BY o.criado_em DESC
    LIMIT 5 OFFSET 0
  `);
  console.log('✅ OK - rows:', rows.length);
  console.log('sample:', JSON.stringify(rows[0]));
} catch (err) {
  console.error('❌ ERRO SQL:', err.message);
}
process.exit(0);
