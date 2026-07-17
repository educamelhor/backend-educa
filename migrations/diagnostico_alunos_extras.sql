-- ============================================================================
-- DIAGNÓSTICO APROFUNDADO — Alunos extras nas turmas
-- Execute cada query separadamente e envie os resultados
-- ============================================================================

-- ╔══════════════════════════════════════════════════════════════════╗
-- ║  QUERY A: Quantos alunos por turma no 6º ANO (ano 2026)?      ║
-- ║  Compara matrículas vs alunos.turma_id                         ║
-- ╚══════════════════════════════════════════════════════════════════╝

SELECT 
  t.nome AS turma,
  t.ano,
  t.id AS turma_id,
  (SELECT COUNT(*) FROM matriculas m WHERE m.turma_id = t.id AND m.ano_letivo = 2026 AND m.status = 'ativo') AS via_matriculas,
  (SELECT COUNT(*) FROM alunos a WHERE a.turma_id = t.id AND a.status = 'ativo') AS via_alunos_turma_id
FROM turmas t
WHERE t.escola_id = 1
  AND t.nome LIKE '%ANO A'
ORDER BY t.ano, t.nome;

-- ╔══════════════════════════════════════════════════════════════════╗
-- ║  QUERY B: Alunos com MÚLTIPLAS matrículas ativas em 2026?     ║
-- ║  (mesmo aluno em turmas diferentes no mesmo ano)               ║
-- ╚══════════════════════════════════════════════════════════════════╝

SELECT 
  a.id AS aluno_id,
  a.estudante,
  a.codigo,
  COUNT(m.id) AS qtd_matriculas,
  GROUP_CONCAT(t.nome ORDER BY t.nome SEPARATOR ', ') AS turmas
FROM matriculas m
INNER JOIN alunos a ON a.id = m.aluno_id
INNER JOIN turmas t ON t.id = m.turma_id
WHERE m.ano_letivo = 2026
  AND m.status = 'ativo'
  AND m.escola_id = 1
GROUP BY a.id, a.estudante, a.codigo
HAVING COUNT(m.id) > 1
ORDER BY qtd_matriculas DESC
LIMIT 50;

-- ╔══════════════════════════════════════════════════════════════════╗
-- ║  QUERY C: Matrículas duplicadas (mesmo aluno + mesma turma)?  ║
-- ╚══════════════════════════════════════════════════════════════════╝

SELECT 
  m.aluno_id,
  a.estudante,
  t.nome AS turma,
  m.turma_id,
  m.ano_letivo,
  COUNT(*) AS duplicatas
FROM matriculas m
INNER JOIN alunos a ON a.id = m.aluno_id
INNER JOIN turmas t ON t.id = m.turma_id
WHERE m.ano_letivo = 2026 AND m.escola_id = 1
GROUP BY m.aluno_id, m.turma_id, m.ano_letivo
HAVING COUNT(*) > 1
LIMIT 50;

-- ╔══════════════════════════════════════════════════════════════════╗
-- ║  QUERY D: Quantas turmas existem com mesmo nome?              ║
-- ║  (verifica se há turmas duplicadas 2025/2026)                  ║
-- ╚══════════════════════════════════════════════════════════════════╝

SELECT nome, GROUP_CONCAT(ano ORDER BY ano) AS anos, 
       GROUP_CONCAT(id ORDER BY ano) AS ids,
       COUNT(*) AS qtd
FROM turmas
WHERE escola_id = 1
GROUP BY nome
HAVING COUNT(*) > 1
ORDER BY nome;
