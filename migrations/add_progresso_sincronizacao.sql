-- Migration: Adicionar coluna progresso na tabela sincronizacao_logs
-- Para tracking em tempo real da execução do agente

ALTER TABLE sincronizacao_logs
  ADD COLUMN progresso_atual  INT DEFAULT 0        COMMENT 'Turma atual sendo processada',
  ADD COLUMN progresso_total  INT DEFAULT 0        COMMENT 'Total de turmas a processar',
  ADD COLUMN progresso_turma  VARCHAR(100) DEFAULT NULL COMMENT 'Nome da turma atual';
