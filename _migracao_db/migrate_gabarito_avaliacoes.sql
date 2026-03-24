-- ============================================================================
-- MIGRAÇÃO: Módulo Gabarito — Avaliações + Respostas
-- ============================================================================
-- Data: 2026-03-22
-- Descrição: Cria as tabelas para persistência de avaliações e respostas dos
-- alunos, com suporte a mapeamento multidisciplinar por faixa de questões.
-- ============================================================================

-- 1. Tabela principal: Avaliações (provas criadas pelo coordenador)
CREATE TABLE IF NOT EXISTS `gabarito_avaliacoes` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `escola_id` BIGINT(20) UNSIGNED NOT NULL,
  `titulo` VARCHAR(200) NOT NULL COMMENT 'Ex: PROVÃO DE EXATAS - 1º BIMESTRE',
  `bimestre` VARCHAR(50) DEFAULT NULL COMMENT 'Ex: 1º Bimestre, 2º Bimestre',
  `num_questoes` INT NOT NULL COMMENT 'Total de questões (1-100)',
  `num_alternativas` INT NOT NULL COMMENT 'Total de alternativas por questão (2-6)',
  `nota_total` DECIMAL(5,2) DEFAULT 10.00 COMMENT 'Nota máxima da avaliação',
  `modelo` ENUM('padrao','enem','simplificado') DEFAULT 'padrao',
  
  `gabarito_oficial` JSON DEFAULT NULL 
    COMMENT 'Array de respostas corretas: ["A","B","C","D",...] ou NULL se ainda não marcou',
  
  `disciplinas_config` JSON DEFAULT NULL 
    COMMENT 'Mapeamento de disciplinas por faixa de questões: [{disciplina_id, nome, de, ate}, ...]',
  
  `turmas_ids` JSON DEFAULT NULL 
    COMMENT 'IDs das turmas que fizeram essa prova: [203, 204, 205]',
  
  `turno` VARCHAR(50) DEFAULT NULL COMMENT 'MATUTINO, VESPERTINO (filtro rápido)',
  
  `status` ENUM('rascunho','publicada','em_correcao','finalizada') DEFAULT 'rascunho'
    COMMENT 'Ciclo de vida: rascunho → publicada → em_correcao → finalizada',
  
  `criado_por` INT DEFAULT NULL COMMENT 'ID do usuário que criou',
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  
  PRIMARY KEY (`id`),
  INDEX `idx_gab_aval_escola` (`escola_id`),
  INDEX `idx_gab_aval_status` (`status`),
  INDEX `idx_gab_aval_bimestre` (`escola_id`, `bimestre`),
  
  CONSTRAINT `fk_gab_aval_escola` FOREIGN KEY (`escola_id`) 
    REFERENCES `escolas` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 
  COMMENT='Avaliações/provas criadas pelo coordenador para correção via gabarito OMR';


-- 2. Tabela de respostas: Resultados individuais por aluno
CREATE TABLE IF NOT EXISTS `gabarito_respostas` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `avaliacao_id` INT NOT NULL COMMENT 'FK para gabarito_avaliacoes',
  `escola_id` BIGINT(20) UNSIGNED NOT NULL,
  `aluno_id` INT DEFAULT NULL COMMENT 'FK para alunos (pode ser NULL se não encontrado)',
  `codigo_aluno` VARCHAR(20) NOT NULL COMMENT 'Código/matrícula do aluno',
  `nome_aluno` VARCHAR(200) DEFAULT NULL,
  `turma_id` INT DEFAULT NULL,
  `turma_nome` VARCHAR(50) DEFAULT NULL,
  
  `respostas_aluno` JSON NOT NULL 
    COMMENT 'Respostas detectadas pelo OMR: ["A","C",null,"B",...]',
  
  `acertos` INT DEFAULT 0 COMMENT 'Total de acertos',
  `total_questoes` INT DEFAULT NULL,
  `nota` DECIMAL(5,2) DEFAULT 0.00 COMMENT 'Nota calculada proporcionalmente',
  
  `acertos_por_disciplina` JSON DEFAULT NULL
    COMMENT 'Acertos detalhados por disciplina: [{disciplina_id, nome, acertos, total, nota}, ...]',
  
  `detalhes` JSON DEFAULT NULL 
    COMMENT 'Detalhes questão a questão: [{q, resp, correto, acertou}, ...]',
  
  `avisos` JSON DEFAULT NULL 
    COMMENT 'Alertas do OMR: [{questao, tipo, alternativas}, ...]',
  
  `origem` ENUM('omr','manual') DEFAULT 'omr',
  `corrigido_em` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `corrigido_por` INT DEFAULT NULL,
  
  PRIMARY KEY (`id`),
  INDEX `idx_gab_resp_avaliacao` (`avaliacao_id`),
  INDEX `idx_gab_resp_aluno` (`codigo_aluno`),
  INDEX `idx_gab_resp_escola` (`escola_id`),
  
  UNIQUE KEY `uk_gab_resp_avaliacao_aluno` (`avaliacao_id`, `codigo_aluno`),
  
  CONSTRAINT `fk_gab_resp_avaliacao` FOREIGN KEY (`avaliacao_id`) 
    REFERENCES `gabarito_avaliacoes` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_gab_resp_escola` FOREIGN KEY (`escola_id`) 
    REFERENCES `escolas` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  COMMENT='Respostas individuais de cada aluno, vinculadas a uma avaliação';
