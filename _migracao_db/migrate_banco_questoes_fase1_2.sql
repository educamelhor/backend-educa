-- =====================================================================
-- EDUCA.PROVA — Migração: Banco de Questões Fase 1+2
-- Fase 1: imagem_url, questao_temas (índice de temas)
-- Fase 2: questoes_master, questao_master_temas
-- Compatível com MySQL 5.7+ / DigitalOcean Managed MySQL
-- =====================================================================

-- ── Helper: adicionar coluna seguro ──────────────────────────────────
DROP PROCEDURE IF EXISTS bq2_add_column;
DELIMITER $$
CREATE PROCEDURE bq2_add_column(
  IN tbl     VARCHAR(64),
  IN col     VARCHAR(64),
  IN col_def VARCHAR(500)
)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME   = tbl
      AND COLUMN_NAME  = col
  ) THEN
    SET @sql = CONCAT('ALTER TABLE `', tbl, '` ADD COLUMN `', col, '` ', col_def);
    PREPARE stmt FROM @sql;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END$$
DELIMITER ;

-- ── FASE 1.1: Adicionar imagem_url nas tabelas existentes ─────────────
CALL bq2_add_column('questoes',              'imagem_url', 'VARCHAR(500) NULL AFTER imagem_base64');
CALL bq2_add_column('questoes_banco_global', 'imagem_url', 'VARCHAR(500) NULL AFTER imagem_base64');

-- ── FASE 1.2: Tabela questao_temas (índice de temas para busca) ───────
CREATE TABLE IF NOT EXISTS questao_temas (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  questao_id INT NOT NULL,
  fonte      ENUM('local','global','master') NOT NULL DEFAULT 'local',
  tema       VARCHAR(100) NOT NULL,
  INDEX idx_tema (tema),
  INDEX idx_questao_fonte (questao_id, fonte)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── FASE 2.1: Tabela questoes_master ──────────────────────────────────
CREATE TABLE IF NOT EXISTS questoes_master (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  codigo              VARCHAR(20) UNIQUE,

  -- Classificação pedagógica
  disciplina          VARCHAR(80)  NOT NULL,
  area_conhecimento   VARCHAR(80)  DEFAULT NULL,
  conteudo            VARCHAR(120) NOT NULL,
  tema                VARCHAR(120) NOT NULL,
  subtema             VARCHAR(120) DEFAULT NULL,
  nivel               ENUM('basico','intermediario','avancado','vestibular','enem') NOT NULL DEFAULT 'intermediario',
  serie               VARCHAR(20)  DEFAULT NULL,
  habilidade_bncc     VARCHAR(20)  DEFAULT NULL,
  palavras_chave      JSON         DEFAULT NULL,

  -- Conteúdo
  tipo                ENUM('objetiva','discursiva','verdadeiro_falso') NOT NULL DEFAULT 'objetiva',
  enunciado           TEXT         NOT NULL,
  imagem_url          VARCHAR(500) DEFAULT NULL,
  texto_apoio         TEXT         DEFAULT NULL,

  -- Gabarito e estudo (diferencial master)
  alternativas_json   JSON         DEFAULT NULL,
  correta             CHAR(1)      DEFAULT NULL,
  gabarito_comentado  TEXT         NOT NULL,
  dicas               JSON         DEFAULT NULL,
  resolucao_completa  TEXT         DEFAULT NULL,
  conceito_chave      TEXT         DEFAULT NULL,

  -- Fonte/Origem (compliance legal)
  fonte               VARCHAR(300) NOT NULL,
  fonte_tipo          ENUM('enem','vestibular','concurso','livro','autoria_educa') DEFAULT 'enem',
  ano_fonte           YEAR         DEFAULT NULL,

  -- Controle
  status              ENUM('rascunho','revisao','publicado','arquivado') NOT NULL DEFAULT 'rascunho',
  criada_por          VARCHAR(80)  DEFAULT 'agente_ia',
  revisada_por        VARCHAR(80)  DEFAULT NULL,
  publicada_em        DATETIME     DEFAULT NULL,
  criada_em           DATETIME     DEFAULT NOW(),
  atualizada_em       DATETIME     DEFAULT NOW() ON UPDATE NOW(),
  visualizacoes       INT          DEFAULT 0,

  -- Índices
  FULLTEXT INDEX ft_busca (enunciado, gabarito_comentado),
  INDEX idx_qm_disciplina (disciplina),
  INDEX idx_qm_nivel (nivel),
  INDEX idx_qm_status (status),
  INDEX idx_qm_conteudo (conteudo(50)),
  INDEX idx_qm_fonte_tipo (fonte_tipo, ano_fonte)

) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── FASE 2.2: Tabela questao_master_temas ─────────────────────────────
CREATE TABLE IF NOT EXISTS questao_master_temas (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  questao_id INT NOT NULL,
  tema       VARCHAR(100) NOT NULL,
  INDEX idx_qmt_tema (tema),
  INDEX idx_qmt_questao (questao_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Limpeza ────────────────────────────────────────────────────────────
DROP PROCEDURE IF EXISTS bq2_add_column;

-- ── Excluir questões de teste ─────────────────────────────────────────
-- (seguro: banco praticamente vazio, só questões de teste)
DELETE FROM questoes;
DELETE FROM questoes_banco_global;

-- ── Verificação final ─────────────────────────────────────────────────
SELECT 'questoes.imagem_url' AS campo,
  CASE WHEN EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='questoes' AND COLUMN_NAME='imagem_url'
  ) THEN 'OK ✅' ELSE 'FALTANDO ❌' END AS status
UNION ALL
SELECT 'questao_temas',
  CASE WHEN EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='questao_temas'
  ) THEN 'OK ✅' ELSE 'FALTANDO ❌' END
UNION ALL
SELECT 'questoes_master',
  CASE WHEN EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='questoes_master'
  ) THEN 'OK ✅' ELSE 'FALTANDO ❌' END
UNION ALL
SELECT 'questao_master_temas',
  CASE WHEN EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='questao_master_temas'
  ) THEN 'OK ✅' ELSE 'FALTANDO ❌' END;
