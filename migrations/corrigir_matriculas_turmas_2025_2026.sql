-- ============================================================================
-- Migration: Corrigir matrículas 2026 vinculadas a turmas de 2025
-- 
-- PROBLEMA: O agente de sincronização importou alunos para turmas de 2025
-- (por falta de filtro AND ano = ?) criando matrículas no ano_letivo 2026
-- apontando para turma_id de turmas de 2025.
--
-- SOLUÇÃO:
-- 1. Identificar matrículas 2026 vinculadas a turmas de 2025
-- 2. Para cada uma, buscar a turma de 2026 com mesmo nome
-- 3. Re-vincular a matrícula para a turma correta de 2026
-- 4. Remover matrículas duplicadas (evitar dois registros para mesmo aluno+turma)
-- 5. Corrigir turma_id na tabela alunos (campo legado)
-- ============================================================================

-- ╔══════════════════════════════════════════════════════════════════╗
-- ║  PASSO 1: DIAGNÓSTICO — ver quantas matrículas estão erradas   ║
-- ╚══════════════════════════════════════════════════════════════════╝
-- Execute este SELECT primeiro para verificar a situação:

SELECT 
  m.id AS matricula_id,
  m.aluno_id,
  a.estudante AS aluno_nome,
  t_atual.nome AS turma_2025,
  t_atual.ano AS ano_turma_atual,
  t_correta.id AS turma_2026_id,
  t_correta.nome AS turma_2026_nome,
  t_correta.ano AS ano_turma_correta
FROM matriculas m
INNER JOIN alunos a ON a.id = m.aluno_id
INNER JOIN turmas t_atual ON t_atual.id = m.turma_id
INNER JOIN turmas t_correta ON t_correta.nome = t_atual.nome 
  AND t_correta.escola_id = t_atual.escola_id 
  AND t_correta.ano = 2026
WHERE m.ano_letivo = 2026
  AND t_atual.ano = 2025
ORDER BY t_atual.nome, a.estudante;

-- ╔══════════════════════════════════════════════════════════════════╗
-- ║  PASSO 2: CORRIGIR — re-vincular matrículas para turmas 2026   ║
-- ╚══════════════════════════════════════════════════════════════════╝

UPDATE matriculas m
INNER JOIN turmas t_atual ON t_atual.id = m.turma_id
INNER JOIN turmas t_correta ON t_correta.nome = t_atual.nome 
  AND t_correta.escola_id = t_atual.escola_id 
  AND t_correta.ano = 2026
SET m.turma_id = t_correta.id
WHERE m.ano_letivo = 2026
  AND t_atual.ano = 2025;

-- ╔══════════════════════════════════════════════════════════════════╗
-- ║  PASSO 3: REMOVER DUPLICATAS — se houver 2 matrículas para     ║
-- ║  o mesmo aluno na mesma turma no mesmo ano letivo               ║
-- ╚══════════════════════════════════════════════════════════════════╝

-- Primeiro listar duplicatas:
SELECT aluno_id, turma_id, ano_letivo, escola_id, COUNT(*) AS qtd
FROM matriculas
WHERE ano_letivo = 2026
GROUP BY aluno_id, turma_id, ano_letivo, escola_id
HAVING COUNT(*) > 1;

-- Remover duplicatas mantendo a de menor ID:
DELETE m1 FROM matriculas m1
INNER JOIN matriculas m2 
  ON m1.aluno_id = m2.aluno_id 
  AND m1.turma_id = m2.turma_id 
  AND m1.ano_letivo = m2.ano_letivo
  AND m1.escola_id = m2.escola_id
  AND m1.id > m2.id
WHERE m1.ano_letivo = 2026;

-- ╔══════════════════════════════════════════════════════════════════╗
-- ║  PASSO 4: CORRIGIR turma_id na tabela alunos (campo legado)    ║
-- ║  Atualiza alunos para apontar para a turma 2026                ║
-- ╚══════════════════════════════════════════════════════════════════╝

UPDATE alunos a
INNER JOIN turmas t_atual ON t_atual.id = a.turma_id AND t_atual.ano = 2025
INNER JOIN turmas t_correta ON t_correta.nome = t_atual.nome 
  AND t_correta.escola_id = t_atual.escola_id 
  AND t_correta.ano = 2026
SET a.turma_id = t_correta.id
WHERE a.escola_id = t_atual.escola_id;

-- ╔══════════════════════════════════════════════════════════════════╗
-- ║  PASSO 5: VERIFICAÇÃO — confirmar que ficou correto            ║
-- ╚══════════════════════════════════════════════════════════════════╝

-- Contar alunos por turma no ano 2026 (deve bater com SEEDF):
SELECT t.nome, t.ano, COUNT(m.id) AS total_alunos
FROM turmas t
LEFT JOIN matriculas m ON m.turma_id = t.id AND m.ano_letivo = 2026 AND m.status = 'ativo'
WHERE t.ano = 2026 AND t.escola_id = 1
GROUP BY t.id, t.nome, t.ano
ORDER BY t.nome;
