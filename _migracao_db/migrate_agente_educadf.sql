-- ============================================================================
-- MIGRAÇÃO: Módulo AGENTE AUTÔNOMO (EducaDF Bridge)
-- ============================================================================
-- Criação das 4 tabelas do módulo Agente.
-- Executar este script no banco de dados de cada escola.
-- ============================================================================

-- 1) Credenciais do professor no EducaDF (criptografadas)
CREATE TABLE IF NOT EXISTS agente_credenciais (
  id INT AUTO_INCREMENT PRIMARY KEY,
  escola_id INT NOT NULL,
  professor_id INT NOT NULL,
  educadf_login VARCHAR(50) NOT NULL,
  educadf_senha_enc TEXT NOT NULL,
  educadf_senha_iv VARCHAR(64) NOT NULL,
  educadf_senha_tag VARCHAR(64) NOT NULL,
  perfil_id INT DEFAULT 1,
  ativo TINYINT(1) DEFAULT 1,
  ultimo_teste_em DATETIME DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_prof_escola (escola_id, professor_id),
  INDEX idx_escola (escola_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 2) Fila / histórico de execuções do agente
CREATE TABLE IF NOT EXISTS agente_execucoes (
  id INT AUTO_INCREMENT PRIMARY KEY,
  escola_id INT NOT NULL,
  professor_id INT NOT NULL,
  tipo ENUM('FREQUENCIA','CONTEUDO','NOTA') NOT NULL,
  status ENUM('PENDENTE','EXECUTANDO','SUCESSO','FALHA','CANCELADO') DEFAULT 'PENDENTE',
  turma_nome VARCHAR(50),
  disciplina_nome VARCHAR(100),
  data_referencia DATE,
  bimestre TINYINT,
  ano_letivo SMALLINT,
  payload JSON,
  resultado JSON,
  erro TEXT,
  screenshot_antes VARCHAR(500),
  screenshot_depois VARCHAR(500),
  tentativa INT DEFAULT 1,
  max_tentativas INT DEFAULT 3,
  duracao_ms INT,
  agendado_para DATETIME,
  iniciado_em DATETIME,
  finalizado_em DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_escola_status (escola_id, status),
  INDEX idx_professor (professor_id),
  INDEX idx_agendado (agendado_para, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 3) Mapeamento Turma EDUCA ↔ Turma EducaDF
CREATE TABLE IF NOT EXISTS agente_mapeamento_turmas (
  id INT AUTO_INCREMENT PRIMARY KEY,
  escola_id INT NOT NULL,
  professor_id INT NOT NULL,
  turma_id_educa INT NOT NULL,
  turma_label_educadf VARCHAR(100) NOT NULL,
  disciplina_id_educa INT,
  disciplina_label_educadf VARCHAR(100),
  ativo TINYINT(1) DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_map (escola_id, professor_id, turma_id_educa, disciplina_id_educa),
  INDEX idx_escola (escola_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 4) Log de auditoria granular
CREATE TABLE IF NOT EXISTS agente_audit_log (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  execucao_id INT NOT NULL DEFAULT 0,
  acao VARCHAR(100) NOT NULL,
  detalhe JSON,
  screenshot_path VARCHAR(500),
  duracao_ms INT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_execucao (execucao_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
