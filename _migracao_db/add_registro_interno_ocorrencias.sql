-- Migration: Adiciona coluna registro_interno na tabela ocorrencias_disciplinares
-- Registro Interno: comunicação interna entre militares, não é impresso em nenhum documento.
-- Apenas visível no modal "Detalhes da Medida Disciplinar" (ícone olhinho).

ALTER TABLE ocorrencias_disciplinares
  ADD COLUMN registro_interno TEXT DEFAULT NULL
  AFTER descricao;
