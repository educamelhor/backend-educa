-- ============================================================================
-- Migração: EDUCA SCAN — Fluxo de Sessão de Captura
-- Adiciona: capturado_em, status 'ausente' em gabarito_arquivos
--           turma_id em gabarito_lotes
-- ============================================================================

-- 1. Adicionar timestamp de captura da imagem (sem OMR)
ALTER TABLE gabarito_arquivos
  ADD COLUMN IF NOT EXISTS capturado_em TIMESTAMP NULL DEFAULT NULL
  AFTER corrigido_em;

-- 2. Adicionar status 'ausente' ao enum
ALTER TABLE gabarito_arquivos
  MODIFY COLUMN status
    ENUM('pendente', 'identificado', 'corrigido', 'erro', 'ausente')
    DEFAULT 'pendente';

-- 3. Adicionar turma_id em gabarito_lotes (para lookup por ID além de nome)
ALTER TABLE gabarito_lotes
  ADD COLUMN IF NOT EXISTS turma_id INT NULL DEFAULT NULL
  AFTER turma_nome;

ALTER TABLE gabarito_lotes
  ADD INDEX IF NOT EXISTS idx_lotes_turma_id (turma_id);

-- Verificação final
SELECT 'Migration add_educa_scan_session.sql aplicada com sucesso!' AS resultado;
