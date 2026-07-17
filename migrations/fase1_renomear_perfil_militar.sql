-- ============================================================
-- MIGRATION: renomear perfil 'militar' → 'diretor_disciplinar'
-- Escolas afetadas: CEF04-CCMDF (ID=1) e CCM-CEF1 RF2 (ID=10000)
-- Data: 2026-07-01
-- ============================================================

-- ─── PASSO 0: Backup de segurança ────────────────────────────
-- Cria a tabela de backup com PK explícita (compatível com sql_require_primary_key=ON)
-- e copia os registros com perfil='militar' antes de qualquer alteração.
-- Nota: a tabela já foi criada com estrutura inválida (com created_at/updated_at)
-- Dropar e recriar apenas com as colunas reais de 'usuarios':
DROP TABLE IF EXISTS usuarios_backup_pre_migration_2026_07;

CREATE TABLE usuarios_backup_pre_migration_2026_07 (
  backup_id   INT AUTO_INCREMENT PRIMARY KEY,
  id          INT,
  cpf         VARCHAR(20),
  nome        VARCHAR(200),
  email       VARCHAR(120),
  perfil      VARCHAR(50),
  escola_id   INT,
  ativo       TINYINT(1),
  senha_hash  TEXT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Insere os registros com perfil='militar' na tabela de backup
INSERT INTO usuarios_backup_pre_migration_2026_07
  (id, cpf, nome, email, perfil, escola_id, ativo, senha_hash)
SELECT
  id, cpf, nome, email, perfil, escola_id, ativo, senha_hash
FROM usuarios
WHERE perfil = 'militar';

-- ─── PASSO 1: Verificar quem será afetado ────────────────────
-- Deve retornar exatamente 2 diretores:
--   - José Roberto de Oliveira Medeiros (CEF04-CCMDF, escola_id=1)
--   - Gerson de Sousa Aguiar (CCM-CEF1 RF2, escola_id=10000)
SELECT id, nome, email, perfil, escola_id, ativo 
FROM usuarios 
WHERE perfil = 'militar'
ORDER BY escola_id;

-- ─── PASSO 2: Aplicar renomeação na tabela usuarios ──────────
UPDATE usuarios 
SET perfil = 'diretor_disciplinar' 
WHERE perfil = 'militar';

-- ─── PASSO 3: Atualizar escola_perfil_modulos (se existirem) ─
UPDATE escola_perfil_modulos 
SET perfil = 'diretor_disciplinar' 
WHERE perfil = 'militar';

-- ─── PASSO 4: Verificar resultado ────────────────────────────
-- Deve retornar os mesmos 2 registros, agora com perfil='diretor_disciplinar'
SELECT id, nome, perfil, escola_id, ativo 
FROM usuarios 
WHERE perfil = 'diretor_disciplinar'
ORDER BY escola_id;

-- ─── ROLLBACK DE EMERGÊNCIA ──────────────────────────────────
-- Em caso de problema, rodar os comandos abaixo para reverter:
-- UPDATE usuarios SET perfil = 'militar' WHERE perfil = 'diretor_disciplinar';
-- UPDATE escola_perfil_modulos SET perfil = 'militar' WHERE perfil = 'diretor_disciplinar';
-- DROP TABLE IF EXISTS usuarios_backup_pre_migration_2026_07;
