-- ============================================================================
-- DIAGNÓSTICO FINAL — Verificar origem dos alunos extras
-- ============================================================================

-- ╔══════════════════════════════════════════════════════════════════╗
-- ║  QUERY E: Todos os alunos do 6º ANO A (turma_id=202)          ║
-- ║  com data de criação da matrícula para identificar extras      ║
-- ╚══════════════════════════════════════════════════════════════════╝

SELECT 
  a.id,
  a.codigo AS RE,
  a.estudante,
  a.status AS status_aluno,
  m.status AS status_matricula,
  m.created_at AS matricula_criada,
  t.nome AS turma
FROM matriculas m
INNER JOIN alunos a ON a.id = m.aluno_id
INNER JOIN turmas t ON t.id = m.turma_id
WHERE m.turma_id = 202
  AND m.ano_letivo = 2026
  AND m.status = 'ativo'
ORDER BY m.created_at ASC, a.estudante;

-- ╔══════════════════════════════════════════════════════════════════╗
-- ║  QUERY F: Resumo por data de criação da matrícula              ║
-- ║  (para ver quantos vieram de cada leva de importação)          ║
-- ╚══════════════════════════════════════════════════════════════════╝

SELECT 
  DATE(m.created_at) AS data_importacao,
  COUNT(*) AS qtd_alunos
FROM matriculas m
WHERE m.turma_id = 202
  AND m.ano_letivo = 2026
  AND m.status = 'ativo'
GROUP BY DATE(m.created_at)
ORDER BY data_importacao;
