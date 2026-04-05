-- ============================================================================
-- Migration: Módulo FREQUÊNCIA
-- Cria tabelas para justificativas, busca ativa e encaminhamentos
-- ============================================================================

-- Justificativas de faltas (atestados)
CREATE TABLE IF NOT EXISTS frequencia_justificativas (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  escola_id       INT NOT NULL,
  turma_id        INT,
  aluno_id        INT NOT NULL,
  tipo            VARCHAR(60) NOT NULL COMMENT 'atestado_medico, atestado_acompanhamento, etc.',
  data_inicio     DATE NOT NULL,
  data_fim        DATE NOT NULL,
  dias            INT NOT NULL DEFAULT 1,
  observacao      TEXT,
  registrado_por  INT COMMENT 'usuario_id de quem registrou',
  criado_em       DATETIME DEFAULT CURRENT_TIMESTAMP,
  atualizado_em   DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_escola (escola_id),
  INDEX idx_aluno (aluno_id),
  INDEX idx_turma (turma_id),
  INDEX idx_tipo (tipo),
  INDEX idx_periodo (data_inicio, data_fim)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Busca Ativa (contatos com famílias)
CREATE TABLE IF NOT EXISTS frequencia_busca_ativa (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  escola_id       INT NOT NULL,
  turma_id        INT,
  aluno_id        INT NOT NULL,
  data_contato    DATE NOT NULL,
  meio_contato    VARCHAR(40) NOT NULL COMMENT 'telefone, whatsapp, visita_domiciliar, etc.',
  resultado       VARCHAR(40) NOT NULL COMMENT 'sucesso, sem_resposta, numero_invalido, etc.',
  observacao      TEXT,
  registrado_por  INT,
  criado_em       DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_escola (escola_id),
  INDEX idx_aluno (aluno_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Encaminhamentos ao Conselho Tutelar
CREATE TABLE IF NOT EXISTS frequencia_encaminhamentos_ct (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  escola_id       INT NOT NULL,
  turma_id        INT,
  aluno_id        INT NOT NULL,
  motivo          TEXT,
  registrado_por  INT,
  criado_em       DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_escola (escola_id),
  INDEX idx_aluno (aluno_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
