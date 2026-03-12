-- Script para criar a tabela de Ocorrências Disciplinares

CREATE TABLE IF NOT EXISTS ocorrencias_disciplinares (
    id INT AUTO_INCREMENT PRIMARY KEY,
    aluno_id BIGINT UNSIGNED NOT NULL,
    escola_id INT,
    data_ocorrencia DATE NOT NULL,
    motivo VARCHAR(255) NOT NULL,
    descricao TEXT,
    convocar_responsavel TINYINT(1) DEFAULT 0,
    status VARCHAR(50) DEFAULT 'REGISTRADA',
    criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (aluno_id) REFERENCES alunos(id) ON DELETE CASCADE
    -- A coluna 'id' servirá como o 'registro' único geral de ocorrência, e formataremos com 4 dígitos no front (ex: 0001, 0002)
);
