-- ============================================================================
-- MIGRAÇÃO: Padronizar CPF para apenas dígitos (sem máscara)
-- Versão compatível com DigitalOcean Managed MySQL (sem temp tables)
-- Executar em: educa_migracao (produção)
-- Data: 2026-04-03
-- ============================================================================

-- ═══════════════════════════════════════════════════════════════
-- PASSO 1: Remover duplicatas na tabela USUARIOS
-- Para cada par duplicado, mantém o que TEM senha (conta ativa).
-- Se nenhum tem senha, mantém o de MENOR id.
-- ═══════════════════════════════════════════════════════════════

DELETE u
FROM usuarios u
INNER JOIN (
  SELECT
    REPLACE(REPLACE(REPLACE(cpf, '.', ''), '-', ''), '/', '') AS cpf_limpo,
    escola_id,
    perfil,
    COALESCE(
      MIN(CASE WHEN senha_hash IS NOT NULL AND senha_hash <> '' THEN id ELSE NULL END),
      MIN(id)
    ) AS keeper_id
  FROM usuarios
  GROUP BY
    REPLACE(REPLACE(REPLACE(cpf, '.', ''), '-', ''), '/', ''),
    escola_id,
    perfil
  HAVING COUNT(*) > 1
    AND SUM(cpf REGEXP '[^0-9]') > 0
) dup
  ON REPLACE(REPLACE(REPLACE(u.cpf, '.', ''), '-', ''), '/', '') = dup.cpf_limpo
  AND u.escola_id = dup.escola_id
  AND u.perfil = dup.perfil
WHERE u.id <> dup.keeper_id;

-- ═══════════════════════════════════════════════════════════════
-- PASSO 2: Normalizar CPFs para só dígitos
-- ═══════════════════════════════════════════════════════════════

-- 2a) USUARIOS
UPDATE usuarios
SET cpf = REPLACE(REPLACE(REPLACE(cpf, '.', ''), '-', ''), '/', '')
WHERE cpf REGEXP '[^0-9]';

-- 2b) PROFESSORES — tratar duplicatas primeiro
DELETE p
FROM professores p
INNER JOIN (
  SELECT
    REPLACE(REPLACE(REPLACE(cpf, '.', ''), '-', ''), '/', '') AS cpf_limpo,
    escola_id,
    MIN(id) AS keeper_id
  FROM professores
  GROUP BY
    REPLACE(REPLACE(REPLACE(cpf, '.', ''), '-', ''), '/', ''),
    escola_id
  HAVING COUNT(*) > 1
    AND SUM(cpf REGEXP '[^0-9]') > 0
) dup
  ON REPLACE(REPLACE(REPLACE(p.cpf, '.', ''), '-', ''), '/', '') = dup.cpf_limpo
  AND p.escola_id = dup.escola_id
WHERE p.id <> dup.keeper_id;

UPDATE professores
SET cpf = REPLACE(REPLACE(REPLACE(cpf, '.', ''), '-', ''), '/', '')
WHERE cpf REGEXP '[^0-9]';

-- 2c) CADASTRO_MEMBROS_ESCOLA
UPDATE cadastro_membros_escola
SET cpf = REPLACE(REPLACE(REPLACE(cpf, '.', ''), '-', ''), '/', '')
WHERE cpf REGEXP '[^0-9]';

-- 2d) EQUIPE_ESCOLA
UPDATE equipe_escola
SET cpf = REPLACE(REPLACE(REPLACE(cpf, '.', ''), '-', ''), '/', '')
WHERE cpf REGEXP '[^0-9]';

-- ═══════════════════════════════════════════════════════════════
-- PASSO 3: Verificação final (deve retornar 0 linhas)
-- ═══════════════════════════════════════════════════════════════
SELECT id, cpf, escola_id, perfil FROM usuarios WHERE cpf REGEXP '[^0-9]';
SELECT id, cpf, escola_id FROM professores WHERE cpf REGEXP '[^0-9]';
