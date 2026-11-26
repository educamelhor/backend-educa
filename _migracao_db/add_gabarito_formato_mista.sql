-- ============================================================================
-- Migration: Suporte a Questões Certo/Errado e Prova Mista no Módulo Gabarito
-- Data: 2026-11-26
-- ============================================================================

ALTER TABLE gabarito_avaliacoes
  ADD COLUMN formato_questoes ENUM('multipla_escolha', 'certo_errado', 'mista') NOT NULL DEFAULT 'multipla_escolha'
    COMMENT 'Formato das questões: multipla_escolha, certo_errado ou mista',
  ADD COLUMN questoes_ce JSON DEFAULT NULL
    COMMENT 'Array 1-based dos números das questões Certo/Errado (ex: [1,2,3,4,5])',
  ADD COLUMN penalidade_ce TINYINT(1) NOT NULL DEFAULT 0
    COMMENT '1 = aplica fator de correção (1 errada anula 1 certa nos itens C/E)';
