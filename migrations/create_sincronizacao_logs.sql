-- Migration: Criar tabela sincronizacao_logs
-- Para rastrear todas as execuções do agente sincronizador SEEDF

CREATE TABLE IF NOT EXISTS sincronizacao_logs (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  escola_id     INT NOT NULL,
  usuario_id    INT DEFAULT NULL,
  status        ENUM('em_andamento', 'sucesso', 'parcial', 'falha', 'falha_scraping', 'falha_importacao', 'erro', 'scraping_concluido') DEFAULT 'em_andamento',
  
  -- Turmas solicitadas (JSON array ou null para todas)
  turmas_solicitadas JSON DEFAULT NULL,
  
  -- Relatório completo do agente (JSON)
  relatorio     JSON DEFAULT NULL,
  
  -- Timestamps
  criado_em     DATETIME DEFAULT CURRENT_TIMESTAMP,
  finalizado_em DATETIME DEFAULT NULL,
  
  INDEX idx_escola     (escola_id),
  INDEX idx_status     (status),
  INDEX idx_criado_em  (criado_em)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
