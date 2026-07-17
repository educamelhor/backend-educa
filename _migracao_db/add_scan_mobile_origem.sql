-- Migration: expandir ENUM 'origem' em gabarito_respostas para incluir 'scan_mobile'
-- Criado em: 2026-04-26

ALTER TABLE gabarito_respostas
  MODIFY COLUMN origem ENUM('omr', 'manual', 'scan_mobile') DEFAULT 'omr'
  COMMENT 'Origem da correção: omr=scanner/batch, manual=digitação, scan_mobile=app celular';
