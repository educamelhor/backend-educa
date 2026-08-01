-- =============================================================================
-- Migracao: Criar tabela noticias
-- =============================================================================

CREATE TABLE IF NOT EXISTS noticias (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  escola_id   INT          NOT NULL,
  titulo      VARCHAR(120) NOT NULL DEFAULT 'Novidade',
  descricao   TEXT,
  imagem_url  TEXT         NOT NULL,
  ativo       TINYINT(1)   NOT NULL DEFAULT 1,
  criado_em   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_noticias_escola FOREIGN KEY (escola_id) REFERENCES escolas(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX IF NOT EXISTS idx_noticias_escola_ativo ON noticias (escola_id, ativo, criado_em DESC);
