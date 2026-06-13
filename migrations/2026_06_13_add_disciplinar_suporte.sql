-- Migração: garantir que disciplinar.suporte = ativo para todas as escolas que já possuem módulos configurados
-- Isso evita que o Suporte Técnico desapareça para escolas que já estavam em produção
INSERT INTO escola_modulos (escola_id, modulo, ativo)
SELECT DISTINCT escola_id, 'disciplinar.suporte', 1
FROM escola_modulos
WHERE escola_id NOT IN (
  SELECT escola_id FROM escola_modulos WHERE modulo = 'disciplinar.suporte'
)
ON DUPLICATE KEY UPDATE ativo = 1;
