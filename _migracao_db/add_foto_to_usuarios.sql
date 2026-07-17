-- Migração: adicionar coluna `foto` na tabela `usuarios`
-- Permite que qualquer perfil (professor, diretor, coordenador, etc.) tenha foto de perfil
ALTER TABLE usuarios ADD COLUMN foto VARCHAR(500) DEFAULT NULL AFTER email;
