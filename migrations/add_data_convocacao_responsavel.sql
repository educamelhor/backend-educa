-- Migration: add_data_convocacao_responsavel
-- Data agendada para o responsável comparecer (diferente de data_comparecimento_responsavel,
-- que é quando ele efetivamente compareceu)
-- Executar com: mysql -u <user> -p <banco> < add_data_convocacao_responsavel.sql

ALTER TABLE ocorrencias_disciplinares
  ADD COLUMN IF NOT EXISTS data_convocacao DATE NULL
    COMMENT 'Data agendada para comparecimento do responsável (opcional)'
    AFTER convocar_responsavel;
