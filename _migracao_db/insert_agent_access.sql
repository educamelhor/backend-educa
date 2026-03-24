-- ============================================================================
-- Acesso exclusivo para o Agente IA (Antigravity)
-- Perfil: diretor (acesso completo, sem OTP/2FA)
-- Login: CPF 00000000000 + senha Agent@2026
-- Escola: CEF04-CCMDF (id = 1)
-- ============================================================================
-- NOTA: CPF fictício (11 zeros) para não conflitar com nenhum CPF real.
-- Para remover: DELETE FROM usuarios WHERE cpf = '00000000000' AND nome = 'Agente IA';

INSERT INTO usuarios (cpf, nome, email, perfil, escola_id, senha_hash, ativo)
VALUES (
  '00000000000',
  'Agente IA',
  'agent@educa.melhor',
  'diretor',
  1,
  '$2b$10$pkQIzJfZJy0QDxIlNvjA0O/x4tSWKLrLwxEL6nWwR.KWQN7iW/2Pe',
  1
)
ON DUPLICATE KEY UPDATE
  senha_hash = '$2b$10$pkQIzJfZJy0QDxIlNvjA0O/x4tSWKLrLwxEL6nWwR.KWQN7iW/2Pe',
  ativo = 1,
  perfil = 'diretor',
  escola_id = 1;
