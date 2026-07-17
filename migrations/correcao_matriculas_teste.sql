-- ============================================================================
-- CORREÇÃO: Inativar matrículas do teste do agente (2026-04-04)
-- 
-- DIAGNÓSTICO CONFIRMADO:
-- A importação de teste em 04/04 inseriu alunos que NÃO estão no SEEDF atual.
-- A importação correta em 04/05 trouxe os 26 alunos reais.
-- Os 27 extras (04/04) precisam ser inativados.
--
-- EXECUÇÃO: Passo a passo, um SELECT antes de cada UPDATE.
-- ============================================================================

-- ╔══════════════════════════════════════════════════════════════════╗
-- ║  PASSO 1: VER O PANORAMA DE TODAS AS TURMAS                   ║
-- ║  (mostra quais turmas têm matrículas de 04/04 + 04/05)        ║
-- ╚══════════════════════════════════════════════════════════════════╝

SELECT 
  t.nome AS turma,
  SUM(CASE WHEN DATE(m.created_at) = '2026-04-04' THEN 1 ELSE 0 END) AS qtd_04_04,
  SUM(CASE WHEN DATE(m.created_at) = '2026-04-05' THEN 1 ELSE 0 END) AS qtd_04_05,
  COUNT(*) AS total
FROM matriculas m
INNER JOIN turmas t ON t.id = m.turma_id
WHERE m.ano_letivo = 2026
  AND m.status = 'ativo'
  AND m.escola_id = 1
GROUP BY t.id, t.nome
HAVING SUM(CASE WHEN DATE(m.created_at) = '2026-04-04' THEN 1 ELSE 0 END) > 0
ORDER BY t.nome;

-- ╔══════════════════════════════════════════════════════════════════╗
-- ║  PASSO 2: INATIVAR matrículas do teste (04/04) nas turmas     ║
-- ║  que TAMBÉM tiveram importação correta (04/05)                 ║
-- ╚══════════════════════════════════════════════════════════════════╝

-- Primeiro contar quantas serão inativadas:
SELECT COUNT(*) AS matriculas_a_inativar
FROM matriculas m
INNER JOIN turmas t ON t.id = m.turma_id
WHERE m.ano_letivo = 2026
  AND m.status = 'ativo'
  AND m.escola_id = 1
  AND DATE(m.created_at) = '2026-04-04'
  AND m.turma_id IN (
    -- Turmas que TAMBÉM têm matrículas de 04/05 (importação correta)
    SELECT turma_id FROM matriculas
    WHERE ano_letivo = 2026 AND escola_id = 1 AND DATE(created_at) = '2026-04-05'
  );

-- EXECUTAR a inativação:
UPDATE matriculas m
SET m.status = 'inativo'
WHERE m.ano_letivo = 2026
  AND m.status = 'ativo'
  AND m.escola_id = 1
  AND DATE(m.created_at) = '2026-04-04'
  AND m.turma_id IN (
    SELECT turma_id FROM (
      SELECT DISTINCT turma_id FROM matriculas
      WHERE ano_letivo = 2026 AND escola_id = 1 AND DATE(created_at) = '2026-04-05'
    ) AS sub
  );

-- ╔══════════════════════════════════════════════════════════════════╗
-- ║  PASSO 3: INATIVAR os registros na tabela alunos também       ║
-- ║  (para alunos que NÃO têm nenhuma matrícula ativa restante)   ║
-- ╚══════════════════════════════════════════════════════════════════╝

UPDATE alunos a
SET a.status = 'inativo'
WHERE a.escola_id = 1
  AND a.status = 'ativo'
  AND NOT EXISTS (
    SELECT 1 FROM matriculas m
    WHERE m.aluno_id = a.id
      AND m.escola_id = 1
      AND m.ano_letivo = 2026
      AND m.status = 'ativo'
  );

-- ╔══════════════════════════════════════════════════════════════════╗
-- ║  PASSO 4: VERIFICAÇÃO — contagem final por turma              ║
-- ║  (deve bater com SEEDF!)                                       ║
-- ╚══════════════════════════════════════════════════════════════════╝

SELECT 
  t.nome AS turma,
  COUNT(m.id) AS total_alunos
FROM turmas t
LEFT JOIN matriculas m ON m.turma_id = t.id 
  AND m.ano_letivo = 2026 
  AND m.status = 'ativo'
WHERE t.ano = 2026 
  AND t.escola_id = 1
  AND t.nome LIKE '%ANO%'
GROUP BY t.id, t.nome
ORDER BY t.nome;
