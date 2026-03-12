-- ============================================================
-- MIGRAÇÃO: Criação da tabela `matriculas`
-- Sistema: EDUCA.MELHOR
-- Data: 2026-03-09
--
-- IMPORTANTE: Fazer backup antes de executar!
--
-- Lógica de Ano Letivo padrão (data de corte 31/jan):
--   Se datahora atual < 01/02/ANO  →  ano letivo = ANO - 1
--   Caso contrário                 →  ano letivo = ANO corrente
-- ============================================================

-- ─────────────────────────────────────────────────────────────
-- PASSO 1 — Criar a tabela matriculas
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `matriculas` (
  `id`         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `escola_id`  INT(11)         NOT NULL DEFAULT 1
               COMMENT 'Mesmo tipo de alunos.escola_id (sem FK explícita, igual ao padrão do sistema)',
  `aluno_id`   BIGINT UNSIGNED NOT NULL,
  `turma_id`   INT(11)         NOT NULL,
  `ano_letivo` YEAR            NOT NULL,
  `status`     VARCHAR(30)     NOT NULL DEFAULT 'ativo'
               COMMENT 'ativo | inativo | transferido | concluinte',
  `created_at` TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP
               ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (`id`),

  -- Um aluno só pode ter uma matrícula por turma por ano por escola
  UNIQUE KEY `unq_matricula` (`escola_id`, `aluno_id`, `turma_id`, `ano_letivo`),

  -- Índices para filtragem performática
  KEY `idx_mat_escola_ano`  (`escola_id`, `ano_letivo`),
  KEY `idx_mat_turma_ano`   (`turma_id`, `ano_letivo`),
  KEY `idx_mat_aluno`       (`aluno_id`),

  -- Integridade referencial (sem FK para escolas — mesmo padrão de alunos)
  CONSTRAINT `fk_mat_aluno`
    FOREIGN KEY (`aluno_id`)  REFERENCES `alunos` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_mat_turma`
    FOREIGN KEY (`turma_id`)  REFERENCES `turmas` (`id`) ON DELETE RESTRICT

) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  COMMENT='Histórico de matrículas — relaciona aluno + turma + ano_letivo por escola';

-- ─────────────────────────────────────────────────────────────
-- PASSO 2 — Migrar dados existentes de alunos → matriculas
--
-- Usa o campo `turmas.ano` como ano_letivo.
-- Se a turma não tiver ano cadastrado, usa o ano corrente
-- corrigido pela data de corte (31/jan):
--   CASE WHEN MONTH(CURDATE()) = 1 THEN YEAR(CURDATE()) - 1
--        ELSE YEAR(CURDATE())
--   END
--
-- ON DUPLICATE KEY UPDATE garante idempotência (pode re-executar).
-- ─────────────────────────────────────────────────────────────
INSERT INTO `matriculas`
  (`escola_id`, `aluno_id`, `turma_id`, `ano_letivo`, `status`)
SELECT
  a.`escola_id`,
  a.`id`           AS `aluno_id`,
  a.`turma_id`,
  COALESCE(
    NULLIF(t.`ano`, 0),
    CASE
      WHEN MONTH(CURDATE()) <= 1 THEN YEAR(CURDATE()) - 1
      ELSE YEAR(CURDATE())
    END
  )               AS `ano_letivo`,
  a.`status`
FROM `alunos`  a
JOIN `turmas`  t  ON t.`id` = a.`turma_id`
WHERE a.`turma_id` IS NOT NULL
  AND a.`turma_id` != 0
ON DUPLICATE KEY UPDATE
  `status`     = VALUES(`status`),
  `updated_at` = CURRENT_TIMESTAMP;

-- ─────────────────────────────────────────────────────────────
-- PASSO 3 — Tornar alunos.turma_id nullable (abordagem faseada)
--
-- O campo é mantido por compatibilidade e como fallback.
-- Será removido em fase futura após validação em produção.
-- ─────────────────────────────────────────────────────────────
ALTER TABLE `alunos`
  MODIFY COLUMN `turma_id` INT NULL
  COMMENT 'LEGADO: turma atual do aluno. Gerenciado via tabela matriculas desde 2026-03.';

-- ─────────────────────────────────────────────────────────────
-- VERIFICAÇÃO (rode manualmente após a migração):
--
-- SELECT COUNT(*)           FROM matriculas;               -- total migrado
-- SELECT DISTINCT ano_letivo FROM matriculas ORDER BY 1;   -- anos presentes
-- SELECT m.ano_letivo, COUNT(*) AS qtd
--   FROM matriculas m GROUP BY m.ano_letivo ORDER BY 1;    -- alunos por ano
-- ─────────────────────────────────────────────────────────────
