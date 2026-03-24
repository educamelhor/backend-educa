-- Adicionar coluna dias_suspensao na tabela ocorrencias_disciplinares
-- Armazena a quantidade de dias de suspensão (máximo 3)
ALTER TABLE ocorrencias_disciplinares
ADD COLUMN dias_suspensao TINYINT UNSIGNED DEFAULT NULL
COMMENT 'Dias de suspensão (1 a 3), aplicável apenas quando a medida for Suspensão';
