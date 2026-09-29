-- ============================================================================
-- MIGRAÇÃO: Suporte a Registro de Alunos Pegos Colando / Anulação de Gabarito
-- ============================================================================
-- Permite que coordenadores e professores anulem gabaritos de alunos pegos colando,
-- usando celular ou cometendo infrações disciplinares na avaliação.
-- Preserva a nota original para permitir desfeitas/reversões 100% seguras.
-- ============================================================================

-- 1. Tabela gabarito_respostas: status de anulação, motivo e nota original
ALTER TABLE `gabarito_respostas`
  ADD COLUMN IF NOT EXISTS `status` ENUM('regular', 'anulado') NOT NULL DEFAULT 'regular'
    COMMENT 'Status do gabarito: regular ou anulado por cola/fraude',
  ADD COLUMN IF NOT EXISTS `motivo_anulacao` VARCHAR(255) DEFAULT NULL
    COMMENT 'Motivo da anulação (ex: Cola / Fraude durante a prova)',
  ADD COLUMN IF NOT EXISTS `anulado_em` DATETIME DEFAULT NULL
    COMMENT 'Data e hora em que a anulação foi registrada',
  ADD COLUMN IF NOT EXISTS `anulado_por` INT DEFAULT NULL
    COMMENT 'ID do usuário que realizou a anulação',
  ADD COLUMN IF NOT EXISTS `anulado_por_nome` VARCHAR(255) DEFAULT NULL
    COMMENT 'Nome do usuário que realizou a anulação',
  ADD COLUMN IF NOT EXISTS `anulado_observacao` TEXT DEFAULT NULL
    COMMENT 'Observações detalhadas da anulação',
  ADD COLUMN IF NOT EXISTS `nota_original` DECIMAL(5,2) DEFAULT NULL
    COMMENT 'Nota original preservada para possibilitar restauração',
  ADD COLUMN IF NOT EXISTS `acertos_original` INT DEFAULT NULL
    COMMENT 'Acertos originais preservados para restauração';

-- 2. Tabela gabarito_arquivos: expandir ENUM status e campos de anulação
ALTER TABLE `gabarito_arquivos`
  MODIFY COLUMN `status` ENUM('pendente', 'identificado', 'corrigido', 'erro', 'ausente', 'anulado') DEFAULT 'pendente',
  ADD COLUMN IF NOT EXISTS `motivo_anulacao` VARCHAR(255) DEFAULT NULL
    COMMENT 'Motivo da anulação (ex: Cola / Fraude)',
  ADD COLUMN IF NOT EXISTS `anulado_em` DATETIME DEFAULT NULL
    COMMENT 'Data e hora da anulação',
  ADD COLUMN IF NOT EXISTS `anulado_por` INT DEFAULT NULL
    COMMENT 'ID do usuário que realizou a anulação',
  ADD COLUMN IF NOT EXISTS `anulado_por_nome` VARCHAR(255) DEFAULT NULL
    COMMENT 'Nome do usuário que realizou a anulação',
  ADD COLUMN IF NOT EXISTS `anulado_observacao` TEXT DEFAULT NULL
    COMMENT 'Observações detalhadas da anulação';
