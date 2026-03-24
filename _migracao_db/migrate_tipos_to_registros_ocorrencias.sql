-- ============================================================================
-- Migração: tipos_ocorrencia -> registros_ocorrencias
-- 
-- Passo 1: Renomeia a tabela
-- Passo 2: Renomeia e ajusta as colunas para o novo padrão
-- ============================================================================

-- 1. Renomear tabela
RENAME TABLE tipos_ocorrencia TO registros_ocorrencias;

-- 2. Renomear coluna 'motivo' -> 'descricao_ocorrencia' + ampliar
ALTER TABLE registros_ocorrencias 
  CHANGE COLUMN motivo descricao_ocorrencia VARCHAR(500) NOT NULL;

-- 3. Renomear coluna 'tipo' -> 'tipo_ocorrencia' + ampliar
ALTER TABLE registros_ocorrencias 
  CHANGE COLUMN tipo tipo_ocorrencia VARCHAR(50) DEFAULT 'Leve';

-- 4. Adicionar coluna 'medida_disciplinar'
ALTER TABLE registros_ocorrencias 
  ADD COLUMN medida_disciplinar VARCHAR(100) NOT NULL DEFAULT 'Advertência Oral' AFTER escola_id;

-- 5. Ajustar a UNIQUE KEY (remover antiga e criar nova)
ALTER TABLE registros_ocorrencias
  DROP INDEX unique_motivo_escola,
  ADD UNIQUE KEY unique_descricao_escola (escola_id, descricao_ocorrencia);
