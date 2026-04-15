-- =====================================================================
-- EDUCA.PROVA — Migração: Banco de Questões v2
-- Compatível com MySQL 5.7+ / DigitalOcean Managed MySQL
-- =====================================================================

-- Usa PROCEDURE para simular IF NOT EXISTS no ALTER TABLE
DROP PROCEDURE IF EXISTS bq_add_column;

DELIMITER $$

CREATE PROCEDURE bq_add_column(
  IN tbl VARCHAR(64),
  IN col VARCHAR(64),
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

-- ── Adicionar colunas ────────────────────────────────────────────────────────

CALL bq_add_column('questoes', 'serie',
  'VARCHAR(30) DEFAULT NULL AFTER disciplina');

CALL bq_add_column('questoes', 'bimestre',
  'TINYINT DEFAULT NULL AFTER serie');

CALL bq_add_column('questoes', 'habilidade_bncc',
  'VARCHAR(20) DEFAULT NULL AFTER bimestre');

CALL bq_add_column('questoes', 'texto_apoio',
  'TEXT DEFAULT NULL AFTER habilidade_bncc');

CALL bq_add_column('questoes', 'fonte',
  'VARCHAR(200) DEFAULT NULL AFTER texto_apoio');

CALL bq_add_column('questoes', 'explicacao',
  'TEXT DEFAULT NULL AFTER fonte');

CALL bq_add_column('questoes', 'compartilhada',
  "TINYINT(1) NOT NULL DEFAULT 0 AFTER explicacao");

CALL bq_add_column('questoes', 'status',
  "ENUM('rascunho','ativa','arquivada') NOT NULL DEFAULT 'ativa' AFTER compartilhada");

CALL bq_add_column('questoes', 'professor_id',
  'INT DEFAULT NULL AFTER escola_id');

-- ── Adicionar índices (ignora se já existirem) ───────────────────────────────

DROP PROCEDURE IF EXISTS bq_add_index;

DELIMITER $$

CREATE PROCEDURE bq_add_index(
  IN tbl   VARCHAR(64),
  IN idx   VARCHAR(64),
  IN cols  VARCHAR(200)
)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME   = tbl
      AND INDEX_NAME   = idx
  ) THEN
    SET @sql = CONCAT('ALTER TABLE `', tbl, '` ADD INDEX `', idx, '` (', cols, ')');
    PREPARE stmt FROM @sql;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END$$

DELIMITER ;

CALL bq_add_index('questoes', 'idx_bq_escola_status',   '`escola_id`, `status`');
CALL bq_add_index('questoes', 'idx_bq_disciplina',      '`escola_id`, `disciplina`(50)');
CALL bq_add_index('questoes', 'idx_bq_nivel',           '`escola_id`, `nivel`');
CALL bq_add_index('questoes', 'idx_bq_tipo',            '`escola_id`, `tipo`');
CALL bq_add_index('questoes', 'idx_bq_bimestre',        '`bimestre`');
CALL bq_add_index('questoes', 'idx_bq_bncc',            '`habilidade_bncc`');

-- ── Atualiza registros legados ────────────────────────────────────────────────
UPDATE questoes SET status = 'ativa'
WHERE status IS NULL OR status NOT IN ('rascunho','ativa','arquivada');

-- ── Limpeza ────────────────────────────────────────────────────────────────────
DROP PROCEDURE IF EXISTS bq_add_column;
DROP PROCEDURE IF EXISTS bq_add_index;

-- ── Verificar estrutura final ─────────────────────────────────────────────────
SELECT
  COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME   = 'questoes'
ORDER BY ORDINAL_POSITION;
