-- ============================================================================
-- LIMPEZA: Excluir todos os alunos INATIVOS e seus registros relacionados
-- Escola ID = 1
-- ============================================================================

-- ╔══════════════════════════════════════════════════════════════════╗
-- ║  PASSO 1: DIAGNÓSTICO — quantos inativos existem?             ║
-- ╚══════════════════════════════════════════════════════════════════╝

SELECT 
  'Alunos inativos' AS item, 
  COUNT(*) AS qtd 
FROM alunos WHERE status = 'inativo' AND escola_id = 1
UNION ALL
SELECT 
  'Matrículas inativas', 
  COUNT(*) 
FROM matriculas WHERE status = 'inativo' AND escola_id = 1;

-- ╔══════════════════════════════════════════════════════════════════╗
-- ║  PASSO 2: EXCLUIR registros relacionados dos alunos inativos  ║
-- ╚══════════════════════════════════════════════════════════════════╝

-- 2a. Matrículas inativas
DELETE FROM matriculas 
WHERE escola_id = 1 
  AND status = 'inativo';

-- 2b. Matrículas (qualquer status) de alunos inativos
DELETE FROM matriculas 
WHERE escola_id = 1 
  AND aluno_id IN (SELECT id FROM alunos WHERE status = 'inativo' AND escola_id = 1);

-- 2c. Vínculos responsáveis
DELETE FROM responsaveis_alunos 
WHERE escola_id = 1 
  AND aluno_id IN (SELECT id FROM alunos WHERE status = 'inativo' AND escola_id = 1);

-- 2d. Frequência — justificativas
DELETE FROM frequencia_justificativas 
WHERE escola_id = 1 
  AND aluno_id IN (SELECT id FROM alunos WHERE status = 'inativo' AND escola_id = 1);

-- 2e. Frequência — busca ativa  
DELETE FROM frequencia_busca_ativa 
WHERE escola_id = 1 
  AND aluno_id IN (SELECT id FROM alunos WHERE status = 'inativo' AND escola_id = 1);

-- 2f. Frequência — encaminhamentos CT
DELETE FROM frequencia_encaminhamentos_ct 
WHERE escola_id = 1 
  AND aluno_id IN (SELECT id FROM alunos WHERE status = 'inativo' AND escola_id = 1);

-- 2g. Ocorrências pedagógicas
DELETE FROM ocorrencias_pedagogicas 
WHERE escola_id = 1 
  AND aluno_id IN (SELECT id FROM alunos WHERE status = 'inativo' AND escola_id = 1);

-- ╔══════════════════════════════════════════════════════════════════╗
-- ║  PASSO 3: EXCLUIR os alunos inativos                         ║
-- ╚══════════════════════════════════════════════════════════════════╝

DELETE FROM alunos 
WHERE status = 'inativo' 
  AND escola_id = 1;

-- ╔══════════════════════════════════════════════════════════════════╗
-- ║  PASSO 4: VERIFICAÇÃO — deve ter 0 inativos                  ║
-- ╚══════════════════════════════════════════════════════════════════╝

SELECT 
  'Alunos inativos restantes' AS item, 
  COUNT(*) AS qtd 
FROM alunos WHERE status = 'inativo' AND escola_id = 1;
