-- Tabela de Planos de Avaliação
CREATE TABLE IF NOT EXISTS planos_avaliacao (
    id INT AUTO_INCREMENT PRIMARY KEY,
    escola_id INT NOT NULL,
    disciplina VARCHAR(100) NOT NULL,
    bimestre VARCHAR(50) NOT NULL,
    turmas TEXT NOT NULL,
    ano INT NOT NULL,
    status VARCHAR(50) DEFAULT 'RASCUNHO',
    nome_codigo VARCHAR(100) NOT NULL,
    usuario_id INT,
    motivo_devolucao TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uni_plano (escola_id, ano, bimestre, disciplina, turmas(200))
);

-- Tabela de Itens Avaliativos (relacionado ao plano de avaliação)
CREATE TABLE IF NOT EXISTS itens_avaliacao (
    id INT AUTO_INCREMENT PRIMARY KEY,
    plano_id INT NOT NULL,
    atividade VARCHAR(255) NOT NULL,
    data_inicio DATE,
    data_final DATE,
    nota_total DECIMAL(5,2) DEFAULT 0,
    oportunidades INT DEFAULT 1,
    nota_invertida DECIMAL(5,2) DEFAULT 0,
    descricao TEXT,
    fixo_direcao TINYINT(1) DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (plano_id) REFERENCES planos_avaliacao(id) ON DELETE CASCADE
);
