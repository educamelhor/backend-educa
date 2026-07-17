-- ============================================================================
-- MIGRAÇÃO: Criar tabela ocorrencias_pedagogicas
-- Estrutura semelhante à ocorrencias_disciplinares, sem pontuação
-- Data: 2026-04-04
-- ============================================================================

CREATE TABLE IF NOT EXISTS ocorrencias_pedagogicas (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  aluno_id      INT NOT NULL,
  escola_id     INT NOT NULL,
  data_ocorrencia DATE NOT NULL,
  categoria     VARCHAR(100) NOT NULL COMMENT 'Categoria do registro pedagógico',
  motivo        VARCHAR(255) NOT NULL COMMENT 'Item selecionado da lista de ocorrências',
  descricao     TEXT COMMENT 'Relato detalhado da situação',
  registro_interno TEXT COMMENT 'Anotações internas (não impresso)',
  convocar_responsavel TINYINT(1) NOT NULL DEFAULT 0,
  data_comparecimento_responsavel DATETIME NULL,
  status        ENUM('REGISTRADA','FINALIZADA','CANCELADA') NOT NULL DEFAULT 'REGISTRADA',
  usuario_registro_id  INT NULL COMMENT 'Quem registrou',
  usuario_finalizacao_id INT NULL COMMENT 'Quem finalizou/cancelou',
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_aluno_escola (aluno_id, escola_id),
  INDEX idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
