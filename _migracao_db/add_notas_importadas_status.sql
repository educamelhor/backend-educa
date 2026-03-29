-- ============================================================================
-- MIGRAÇÃO: Adicionar status 'notas_importadas' ao enum de gabarito_avaliacoes
-- ============================================================================
-- Data: 2026-03-28
-- Descrição: Adiciona o status 'notas_importadas' ao campo status da tabela
-- gabarito_avaliacoes para rastrear quais avaliações já tiveram suas notas
-- importadas para o diário (tabela notas).
-- ============================================================================

ALTER TABLE gabarito_avaliacoes 
  MODIFY COLUMN status ENUM('rascunho','publicada','em_correcao','finalizada','notas_importadas') 
  DEFAULT 'rascunho'
  COMMENT 'Ciclo de vida: rascunho → publicada → em_correcao → finalizada → notas_importadas';
