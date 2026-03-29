-- ============================================================================
-- GABARITO — Tabelas de Upload em Lote e Arquivos Individuais
-- Suporta o fluxo: Coordenador faz upload por turma, Professor corrige 1 a 1
-- ============================================================================

-- Lote = 1 pasta = 1 turma + 1 avaliação
CREATE TABLE IF NOT EXISTS gabarito_lotes (
  id INT AUTO_INCREMENT PRIMARY KEY,
  avaliacao_id INT NOT NULL,
  escola_id INT NOT NULL,
  turma_nome VARCHAR(100) NOT NULL,
  total_arquivos INT DEFAULT 0,
  total_corrigidos INT DEFAULT 0,
  status ENUM('pendente', 'em_correcao', 'finalizado') DEFAULT 'pendente',
  criado_por INT DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_avaliacao_turma (avaliacao_id, turma_nome, escola_id)
);

-- Cada arquivo escaneado dentro de um lote
CREATE TABLE IF NOT EXISTS gabarito_arquivos (
  id INT AUTO_INCREMENT PRIMARY KEY,
  lote_id INT NOT NULL,
  escola_id INT NOT NULL,
  arquivo_nome VARCHAR(255) NOT NULL,
  arquivo_path VARCHAR(500) NOT NULL,
  codigo_aluno VARCHAR(20) DEFAULT NULL,
  nome_aluno VARCHAR(255) DEFAULT NULL,
  turma_id INT DEFAULT NULL,
  status ENUM('pendente', 'identificado', 'corrigido', 'erro') DEFAULT 'pendente',
  qr_data JSON DEFAULT NULL,
  respostas_aluno JSON DEFAULT NULL,
  acertos INT DEFAULT NULL,
  nota DECIMAL(6,2) DEFAULT NULL,
  corrigido_em TIMESTAMP NULL,
  corrigido_por INT DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (lote_id) REFERENCES gabarito_lotes(id) ON DELETE CASCADE
);
