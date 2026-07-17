-- ============================================================
-- MIGRAÇÃO: Adicionar coluna `turno` à tabela `disciplinas`
-- e atualizar a UNIQUE KEY para (nome, etapa, turno, escola_id)
--
-- SEGURO PARA DADOS EXISTENTES:
-- - A coluna turno é adicionada com DEFAULT 'DIURNO'
-- - O unique constraint existente é substituído
-- ============================================================

-- 1. Adiciona coluna turno (com default DIURNO para não quebrar dados existentes)
ALTER TABLE `disciplinas`
  ADD COLUMN `turno` VARCHAR(20) NOT NULL DEFAULT 'INTEGRAL'
  AFTER `etapa`;

-- 2. Remove a UNIQUE KEY anterior (nome, etapa, escola_id)
ALTER TABLE `disciplinas`
  DROP INDEX `unq_nome_etapa_escola`;

-- 3. Cria a nova UNIQUE KEY (nome, etapa, turno, escola_id)
ALTER TABLE `disciplinas`
  ADD UNIQUE KEY `unq_nome_etapa_turno_escola` (`nome`, `etapa`, `turno`, `escola_id`);

-- 4. Confirma o resultado
SELECT id, nome, etapa, turno, carga, escola_id FROM disciplinas ORDER BY escola_id, nome;
