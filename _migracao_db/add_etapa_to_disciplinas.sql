-- ============================================================
-- MIGRAÇÃO: Adicionar coluna `etapa` à tabela `disciplinas`
-- e atualizar a UNIQUE KEY para (nome, etapa, escola_id)
-- 
-- SEGURO PARA DADOS EXISTENTES:
-- - A coluna etapa é adicionada como NULL DEFAULT 'GERAL'
-- - O unique constraint existente é substituído
-- ============================================================

-- 1. Adiciona coluna etapa (nullable, com default GERAL para não quebrar dados existentes)
ALTER TABLE `disciplinas`
  ADD COLUMN `etapa` VARCHAR(50) NOT NULL DEFAULT 'GERAL'
  AFTER `nome`;

-- 2. Remove a UNIQUE KEY antiga (nome, escola_id)
ALTER TABLE `disciplinas`
  DROP INDEX `unq_nome_escola`;

-- 3. Cria a nova UNIQUE KEY (nome, etapa, escola_id)
ALTER TABLE `disciplinas`
  ADD UNIQUE KEY `unq_nome_etapa_escola` (`nome`, `etapa`, `escola_id`);

-- 4. Confirma o resultado
SELECT id, nome, etapa, carga, escola_id FROM disciplinas ORDER BY escola_id, nome;
