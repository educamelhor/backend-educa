-- =============================================================================
-- Migration: Adicionar colunas atenuantes e agravantes (Art. 34/35)
-- em ocorrencias_disciplinares (caso ainda não existam)
-- =============================================================================
ALTER TABLE ocorrencias_disciplinares
  ADD COLUMN IF NOT EXISTS atenuantes TEXT NULL AFTER dias_suspensao,
  ADD COLUMN IF NOT EXISTS agravantes TEXT NULL AFTER atenuantes;
