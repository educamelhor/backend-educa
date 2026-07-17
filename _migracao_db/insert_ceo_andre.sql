-- Recria acesso CEO para André Luiz Morais dos Santos
-- Senha temporária: Educa@2026
-- escola_id = 0 (obrigatório para login CEO/Plataforma)
-- perfil = SUPER_ADMIN

INSERT INTO usuarios (cpf, nome, email, perfil, escola_id, senha_hash, ativo)
VALUES (
  '80426069153',
  'André Luiz Morais dos Santos',
  'anju.vendas.online@gmail.com',
  'SUPER_ADMIN',
  0,
  '$2b$10$4PzgvBAjU3RhFqIyQlRCz..Jo8PC26Zikqav.vb/GS8t6muvgL7mu',
  1
);
