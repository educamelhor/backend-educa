-- ============================================================================
-- Migração: notas_diario + status FECHADO no planos_avaliacao
-- ============================================================================

-- 1) Tabela notas_diario: notas granulares por item do PAP
CREATE TABLE IF NOT EXISTS notas_diario (
  id INT AUTO_INCREMENT PRIMARY KEY,
  escola_id BIGINT UNSIGNED NOT NULL,
  plano_id INT NOT NULL,
  turma_id INT NOT NULL,
  aluno_id BIGINT UNSIGNED NOT NULL,
  item_idx TINYINT NOT NULL,
  oportunidade_idx TINYINT NOT NULL DEFAULT 0,
  nota DECIMAL(5,2) DEFAULT NULL,
  cor VARCHAR(10) DEFAULT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY unq_nota_diario (plano_id, turma_id, aluno_id, item_idx, oportunidade_idx),
  KEY idx_plano_turma (plano_id, turma_id),
  KEY idx_aluno (aluno_id),
  CONSTRAINT fk_nd_aluno FOREIGN KEY (aluno_id) REFERENCES alunos(id) ON DELETE CASCADE,
  CONSTRAINT fk_nd_escola FOREIGN KEY (escola_id) REFERENCES escolas(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 2) Adicionar status FECHADO ao planos_avaliacao
ALTER TABLE planos_avaliacao 
  MODIFY COLUMN status ENUM('RASCUNHO','ENVIADO','APROVADO','REJEITADO','FECHADO') DEFAULT 'RASCUNHO';

-- 3) Coluna para controlar turma_id do fechamento (qual turma já exportou)
-- Usaremos uma tabela de controle separada:
CREATE TABLE IF NOT EXISTS diario_fechamento (
  id INT AUTO_INCREMENT PRIMARY KEY,
  escola_id BIGINT UNSIGNED NOT NULL,
  plano_id INT NOT NULL,
  turma_id INT NOT NULL,
  fechado_em DATETIME DEFAULT CURRENT_TIMESTAMP,
  fechado_por INT DEFAULT NULL,
  total_alunos INT DEFAULT 0,
  total_notas_exportadas INT DEFAULT 0,
  UNIQUE KEY unq_fechamento (plano_id, turma_id),
  CONSTRAINT fk_df_escola FOREIGN KEY (escola_id) REFERENCES escolas(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
