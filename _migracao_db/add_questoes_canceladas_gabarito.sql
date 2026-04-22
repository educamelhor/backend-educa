-- ============================================================================
-- MIGRAÇÃO: Cancelamento de Questão no Gabarito
-- ============================================================================
-- Data: 2026-04-22
-- Descrição: Adiciona coluna `questoes_canceladas` à tabela gabarito_avaliacoes
-- para registrar questões anuladas com efeito em lote sobre todos os alunos.
--
-- Modos disponíveis:
--   "bonificar"      → todos os alunos ganham o ponto independente da resposta
--   "desconsiderar"  → questão excluída do total (nota / N-1 questões)
--
-- Formato JSON:
-- [
--   {
--     "numero": 5,
--     "modo": "bonificar",
--     "motivo": "Gabarito oficial estava errado",
--     "cancelado_em": "2026-04-22T20:30:00.000Z",
--     "cancelado_por": 42
--   }
-- ]
-- ============================================================================

ALTER TABLE gabarito_avaliacoes
  ADD COLUMN questoes_canceladas JSON DEFAULT NULL
  COMMENT 'Questões anuladas em lote: [{numero, modo (bonificar|desconsiderar), motivo, cancelado_em, cancelado_por}]';
