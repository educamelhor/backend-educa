-- Migration: Aumenta o tamanho da coluna 'perfil' da tabela 'usuarios'
-- para acomodar o valor 'disciplinar' (12 caracteres).
-- Valores atuais: 'diretor', 'professor', 'disciplinar'

ALTER TABLE usuarios MODIFY COLUMN perfil VARCHAR(30) NOT NULL DEFAULT 'professor';
