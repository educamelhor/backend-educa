-- ============================================================
-- Migration: Suporte ao fluxo access_code + polling no educa-capture
-- Executar uma única vez no banco de dados de produção/dev.
-- ============================================================

-- 1) Colunas para entrega automática do device_token via polling (/pair/status)
-- Execute cada ALTER separadamente.
-- Se retornar "Duplicate column name" (1060), a coluna já existe — pode ignorar e continuar.

ALTER TABLE capture_pair_codes
  ADD COLUMN device_token_plain TEXT NULL DEFAULT NULL
  COMMENT 'Token em texto plano (salvo temporariamente para entrega via polling). Apagar após token_delivered_at ser preenchido.';

ALTER TABLE capture_pair_codes
  ADD COLUMN token_delivered_at DATETIME NULL DEFAULT NULL
  COMMENT 'Momento em que o device_token foi entregue ao app via /pair/status. Evita re-entrega.';

-- 2) (Opcional, boa prática) Apagar o token_plain após entrega para minimizar exposição.
--    O backend já faz isso via UPDATE ao entregar, mas o job abaixo limpa qualquer resíduo > 1h.
-- DELIMITER $$
-- CREATE EVENT IF NOT EXISTS clean_cap_token_plain
--   ON SCHEDULE EVERY 1 HOUR
--   DO
--     UPDATE capture_pair_codes
--        SET device_token_plain = NULL
--      WHERE token_delivered_at IS NOT NULL
--        AND token_delivered_at < DATE_SUB(NOW(), INTERVAL 1 HOUR);
-- $$
-- DELIMITER ;

-- Verificar resultado:
-- DESCRIBE capture_pair_codes;
