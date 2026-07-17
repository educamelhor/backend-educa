-- ============================================================================
-- Migração: Adicionar coluna professor_id na tabela gabarito_lotes
-- Permite vincular um professor responsável a cada lote (turma)
-- ============================================================================

ALTER TABLE gabarito_lotes 
ADD COLUMN professor_id INT NULL DEFAULT NULL AFTER criado_por;

-- Índice para consultas por professor
ALTER TABLE gabarito_lotes ADD INDEX idx_lotes_professor (professor_id);
