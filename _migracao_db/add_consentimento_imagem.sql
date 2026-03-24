-- Migration: Adiciona colunas de consentimento de imagem/dados biométricos
-- na tabela responsaveis_alunos (vínculo responsável ↔ aluno por escola)

ALTER TABLE responsaveis_alunos
  ADD COLUMN consentimento_imagem TINYINT(1) NOT NULL DEFAULT 0
    COMMENT 'Se o responsável assinou o Termo de Consentimento de Uso de Imagem e Dados Biométricos'
    AFTER ativo,
  ADD COLUMN consentimento_imagem_em DATETIME NULL DEFAULT NULL
    COMMENT 'Data/hora em que o consentimento foi registrado'
    AFTER consentimento_imagem,
  ADD COLUMN consentimento_imagem_por INT NULL DEFAULT NULL
    COMMENT 'ID do usuário (diretor/secretário) que registrou o consentimento'
    AFTER consentimento_imagem_em;
