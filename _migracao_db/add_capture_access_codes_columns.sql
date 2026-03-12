-- ============================================================
-- Migration: Colunas faltantes na tabela capture_access_codes
-- Executar uma única vez no banco de dados de produção/dev.
--
-- Contexto: o backend (Bloco 2 de ACCESS CODE ADMIN) consulta
-- as colunas label, disabled_by_usuario_id e disabled_at,
-- que ainda não existiam na tabela original.
-- ============================================================

-- Execute cada ALTER separadamente.
-- Se retornar "Duplicate column name" (1060), a coluna já existe — pode ignorar e continuar.

ALTER TABLE capture_access_codes
  ADD COLUMN label VARCHAR(80) NULL DEFAULT NULL
  COMMENT 'Rótulo legível opcional para identificar o dispositivo/uso (ex: Tablet Secretaria)';

ALTER TABLE capture_access_codes
  ADD COLUMN disabled_by_usuario_id INT NULL DEFAULT NULL
  COMMENT 'ID do usuário que desativou o access_code';

ALTER TABLE capture_access_codes
  ADD COLUMN disabled_at DATETIME NULL DEFAULT NULL
  COMMENT 'Data/hora em que o access_code foi desativado';

-- Verificar resultado:
-- DESCRIBE capture_access_codes;
