-- ============================================================================
-- Migration: alter_responsaveis_alunos_consent
-- Criada em: 2026-04-28
-- Propósito: Adicionar campos de rastreamento de canal e versão do termo
--            em responsaveis_alunos (flag operacional — não é o log imutável)
-- ============================================================================

-- 1. Novos campos
ALTER TABLE responsaveis_alunos
  ADD COLUMN IF NOT EXISTS consentimento_canal
    ENUM('FISICO','DIGITAL_APP','DIGITAL_WEB') NULL DEFAULT NULL
    COMMENT 'Canal pelo qual o consentimento foi obtido'
    AFTER consentimento_imagem_por,

  ADD COLUMN IF NOT EXISTS consentimento_versao_termo
    VARCHAR(20) NULL DEFAULT NULL
    COMMENT 'Versão do termo aceito (ex: 3.0)'
    AFTER consentimento_canal,

  ADD COLUMN IF NOT EXISTS consentimento_log_id
    BIGINT UNSIGNED NULL DEFAULT NULL
    COMMENT 'Referência ao registro mais recente em consentimentos_log'
    AFTER consentimento_versao_termo;

-- 2. Retrocompatibilidade: marcar registros físicos legados
UPDATE responsaveis_alunos
SET
  consentimento_canal        = 'FISICO',
  consentimento_versao_termo = '3.0'
WHERE
  consentimento_imagem = 1
  AND consentimento_canal IS NULL;
