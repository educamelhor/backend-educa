-- Migração: adiciona colunas tipo e origem na tabela escolas
-- tipo: JSON array com os tipos da escola (ex: ["Anos Finais", "CCMDF"])
-- origem: pública ou particular

ALTER TABLE escolas
  ADD COLUMN tipo JSON DEFAULT NULL COMMENT 'Array de tipos: Infantil, Anos Iniciais, Anos Finais, Ensino Médio, Profissionalizante, Integral, CCMDF'
    AFTER telefone,
  ADD COLUMN origem ENUM('publica', 'particular') DEFAULT NULL COMMENT 'Origem: pública ou particular'
    AFTER tipo;
