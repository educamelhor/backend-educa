-- migrate_governanca_seed.sql
-- =========================================================================
-- Cria as tabelas de Governança CEO (se não existirem) e insere os 6
-- categorias + 17 itens padrão. Tabelas de escola (configuracoes_escola)
-- já existem — não são recriadas aqui.
-- Usar INSERT IGNORE para idempotência (pode rodar quantas vezes precisar).
-- =========================================================================

-- ── 1) Tabela de Categorias ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS governanca_categorias (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  nome          VARCHAR(100) NOT NULL,
  icone         VARCHAR(50) DEFAULT 'geral',
  cor           VARCHAR(30) DEFAULT '#64748b',
  ordem         INT NOT NULL DEFAULT 0,
  ativo         TINYINT(1) NOT NULL DEFAULT 1,
  criado_em     DATETIME DEFAULT CURRENT_TIMESTAMP,
  atualizado_em DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_nome_cat (nome)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── 2) Tabela de Itens ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS governanca_itens (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  categoria_id    INT NOT NULL,
  chave           VARCHAR(120) NOT NULL,
  descricao       VARCHAR(300) NOT NULL,
  tipo            ENUM('boolean','select','text') NOT NULL DEFAULT 'boolean',
  opcoes_json     JSON DEFAULT NULL,
  valor_padrao    VARCHAR(500) NOT NULL DEFAULT '0',
  ordem           INT NOT NULL DEFAULT 0,
  ativo           TINYINT(1) NOT NULL DEFAULT 1,
  criado_em       DATETIME DEFAULT CURRENT_TIMESTAMP,
  atualizado_em   DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_chave_item (chave),
  KEY idx_categoria (categoria_id),
  CONSTRAINT fk_gov_cat FOREIGN KEY (categoria_id) REFERENCES governanca_categorias(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── 3) Seed: 6 Categorias ───────────────────────────────────────────────
INSERT IGNORE INTO governanca_categorias (nome, cor, ordem) VALUES
  ('Boletim',     '#6366f1', 1),
  ('Professores', '#10b981', 2),
  ('Coordenação', '#f59e0b', 3),
  ('Supervisão',  '#ec4899', 4),
  ('Secretaria',  '#06b6d4', 5),
  ('Geral',       '#64748b', 6);

-- ── 4) Seed: 17 Itens (usa subquery para resolver categoria_id) ─────────

-- Boletim (5 itens)
INSERT IGNORE INTO governanca_itens (categoria_id, chave, descricao, tipo, opcoes_json, valor_padrao, ordem)
VALUES
  ((SELECT id FROM governanca_categorias WHERE nome='Boletim'), 'boletim.exibir_ano_anterior', 'Boletim mostra nota ano anterior (escolaridade 2 anos)', 'boolean', NULL, '0', 1),
  ((SELECT id FROM governanca_categorias WHERE nome='Boletim'), 'boletim.exibir_media_rodape', 'Exibir média por bimestre no rodapé', 'boolean', NULL, '1', 2),
  ((SELECT id FROM governanca_categorias WHERE nome='Boletim'), 'boletim.exibir_faltas', 'Exibir faltas no boletim', 'boolean', NULL, '1', 3),
  ((SELECT id FROM governanca_categorias WHERE nome='Boletim'), 'boletim.exibir_ranking', 'Exibir ranking no boletim', 'boolean', NULL, '1', 4),
  ((SELECT id FROM governanca_categorias WHERE nome='Boletim'), 'boletim.exibir_media_turma', 'Exibir média da turma no boletim', 'boolean', NULL, '0', 5);

-- Professores (3 itens)
INSERT IGNORE INTO governanca_itens (categoria_id, chave, descricao, tipo, opcoes_json, valor_padrao, ordem)
VALUES
  ((SELECT id FROM governanca_categorias WHERE nome='Professores'), 'professor.visualiza_relatorio_disciplinar', 'Professor pode visualizar o relatório disciplinar', 'boolean', NULL, '0', 1),
  ((SELECT id FROM governanca_categorias WHERE nome='Professores'), 'professor.acessa_conselho_classe', 'Professor pode acessar o submenu Conselho de Classe', 'boolean', NULL, '0', 2),
  ((SELECT id FROM governanca_categorias WHERE nome='Professores'), 'professor.exporta_notas', 'Professor pode exportar notas bimestrais para o boletim', 'boolean', NULL, '0', 3);

-- Coordenação (3 itens)
INSERT IGNORE INTO governanca_itens (categoria_id, chave, descricao, tipo, opcoes_json, valor_padrao, ordem)
VALUES
  ((SELECT id FROM governanca_categorias WHERE nome='Coordenação'), 'coordenador.cria_gabarito', 'Coordenador pode criar gabarito', 'boolean', NULL, '1', 1),
  ((SELECT id FROM governanca_categorias WHERE nome='Coordenação'), 'coordenador.exporta_notas_bimestrais', 'Coordenador pode exportar notas bimestrais', 'boolean', NULL, '0', 2),
  ((SELECT id FROM governanca_categorias WHERE nome='Coordenação'), 'coordenador.acessa_conselho_classe', 'Coordenador pode acessar o Conselho de Classe', 'boolean', NULL, '1', 3);

-- Supervisão (2 itens)
INSERT IGNORE INTO governanca_itens (categoria_id, chave, descricao, tipo, opcoes_json, valor_padrao, ordem)
VALUES
  ((SELECT id FROM governanca_categorias WHERE nome='Supervisão'), 'supervisor.cria_gabarito', 'Supervisor pode criar gabarito', 'boolean', NULL, '0', 1),
  ((SELECT id FROM governanca_categorias WHERE nome='Supervisão'), 'supervisor.visualiza_relatorio_disciplinar', 'Supervisor pode visualizar relatório disciplinar', 'boolean', NULL, '1', 2);

-- Secretaria (2 itens)
INSERT IGNORE INTO governanca_itens (categoria_id, chave, descricao, tipo, opcoes_json, valor_padrao, ordem)
VALUES
  ((SELECT id FROM governanca_categorias WHERE nome='Secretaria'), 'secretaria.importa_alunos', 'Secretaria pode importar alunos via planilha', 'boolean', NULL, '1', 1),
  ((SELECT id FROM governanca_categorias WHERE nome='Secretaria'), 'secretaria.edita_notas', 'Secretaria pode editar notas diretamente', 'boolean', NULL, '0', 2);

-- Avaliações (5 itens)
INSERT IGNORE INTO governanca_categorias (nome, cor, ordem) VALUES ('Avaliações', '#8b5cf6', 6);
UPDATE governanca_categorias SET ordem = 7 WHERE nome = 'Geral';

INSERT IGNORE INTO governanca_itens (categoria_id, chave, descricao, tipo, opcoes_json, valor_padrao, ordem)
VALUES
  ((SELECT id FROM governanca_categorias WHERE nome='Avaliações'), 'escola.avaliacao_padrao_bimestral', 'Escola adota avaliação padrão bimestral (semana de prova)', 'boolean', NULL, '0', 1),
  ((SELECT id FROM governanca_categorias WHERE nome='Avaliações'), 'nota.avaliacao_padrao.bimestral', 'A nota da avaliação padrão bimestral é por área.', 'boolean', NULL, '0', 2),
  ((SELECT id FROM governanca_categorias WHERE nome='Avaliações'), 'coordenador.acessa_gabarito', 'Coordenador pode acessar gabarito.', 'boolean', NULL, '0', 3),
  ((SELECT id FROM governanca_categorias WHERE nome='Avaliações'), 'supervisor.acessa_gabarito', 'Supervisor pode acessar gabarito.', 'boolean', NULL, '0', 4);

-- Geral (2 itens)
INSERT IGNORE INTO governanca_itens (categoria_id, chave, descricao, tipo, opcoes_json, valor_padrao, ordem)
VALUES
  ((SELECT id FROM governanca_categorias WHERE nome='Geral'), 'geral.ano_letivo_ativo', 'Ano letivo ativo no sistema', 'select', '["2024","2025","2026"]', '2025', 1),
  ((SELECT id FROM governanca_categorias WHERE nome='Geral'), 'geral.bimestre_ativo', 'Bimestre ativo atual', 'select', '["1","2","3","4"]', '1', 2);

-- =========================================================================
-- PRONTO! Tabelas criadas e seed aplicado.
-- As escolas receberão esses itens automaticamente via syncFromCeoTemplate()
-- quando o diretor acessar Governança pela primeira vez.
-- =========================================================================
