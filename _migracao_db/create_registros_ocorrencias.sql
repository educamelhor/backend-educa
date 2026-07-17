-- Tabela GLOBAL de registros de ocorrências (regimento cívico-militar)
-- Sem escola_id: os dados são universais para todas as escolas cívico-militares
CREATE TABLE IF NOT EXISTS registros_ocorrencias (
  id INT AUTO_INCREMENT PRIMARY KEY,
  medida_disciplinar VARCHAR(100) NOT NULL,
  tipo_ocorrencia VARCHAR(50) NOT NULL,
  descricao_ocorrencia VARCHAR(500) NOT NULL,
  pontos DECIMAL(5,1) DEFAULT 0.0,
  ativo BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY unique_tipo_descricao (tipo_ocorrencia, descricao_ocorrencia)
);
