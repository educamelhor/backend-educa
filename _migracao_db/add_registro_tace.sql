-- Migration: Insere o registro de ocorrência para TACE na tabela registros_ocorrencias
-- Tipo: TACE | Medida: Ajuste | Ocorrência: Termo de Ajuste de Conduta Escolar | PTS: -1.0
-- Este registro é usado no JOIN quando listando ocorrências disciplinares vinculadas.

INSERT INTO registros_ocorrencias (medida_disciplinar, tipo_ocorrencia, descricao_ocorrencia, pontos, ativo)
VALUES ('Ajuste', 'TACE', 'Termo de Ajuste de Conduta Escolar', -1.0, 1);
