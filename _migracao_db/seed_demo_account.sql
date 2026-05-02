-- ============================================================================
-- SEED: Conta Demo para Apple App Store Review
-- ============================================================================
-- Objetivo: Criar dados de demonstração persistentes no banco para que o
--           revisor da Apple possa navegar pelo app com dados reais.
--
-- Credenciais de teste:
--   CPF: 000.000.001-91  (normalizado: 00000000191)
--   OTP: 000000
--
-- Turma de referência: 129 (6º ANO - 1C - Vespertino)
-- Disciplinas: Português(48), Matemática(21), Ciências(25), 
--              História(24), Geografia(23), Inglês(30),
--              Artes(26), Ed. Física(27)
-- ============================================================================

-- ── PASSO 1: Inserir Responsável Demo ────────────────────────────────────────
INSERT INTO responsaveis (nome, cpf, email, status_global)
VALUES ('REVISÃO APPLE', '00000000191', 'demo@sistemaeducamelhor.com.br', 'ATIVO');

-- Capturar o ID gerado
SET @demo_responsavel_id = LAST_INSERT_ID();
SELECT @demo_responsavel_id AS 'responsavel_id_criado';

-- ── PASSO 2: Inserir Aluno Demo ──────────────────────────────────────────────
-- Código 999999 (alto, evita conflito com alunos reais)
-- Vinculado à turma 129 (6º ANO - 1C)
INSERT INTO alunos (escola_id, codigo, estudante, data_nascimento, sexo, turma_id, status, alerta_flag)
VALUES (1, 999999, 'JOÃO DEMO DA SILVA', '2013-05-15', 'M', 129, 'ativo', 0);

SET @demo_aluno_id = LAST_INSERT_ID();
SELECT @demo_aluno_id AS 'aluno_id_criado';

-- ── PASSO 3: Vincular Responsável ao Aluno ───────────────────────────────────
INSERT INTO responsaveis_alunos (
    escola_id, responsavel_id, aluno_id,
    relacionamento, principal, ativo,
    pode_ver_boletim, pode_ver_frequencia, pode_ver_agenda,
    pode_receber_notificacoes, pode_autorizar_terceiros
) VALUES (
    1, @demo_responsavel_id, @demo_aluno_id,
    'RESPONSAVEL', 1, 1,
    1, 1, 1,
    1, 1
);

-- ── PASSO 4: Popular Notas (4 bimestres x 8 disciplinas = 32 registros) ─────
-- Disciplinas da escola_id=1:
--   48=Português, 21=Matemática, 25=Ciências, 24=História
--   23=Geografia, 30=Inglês, 26=Artes, 27=Ed. Física

-- ── Bimestre 1 ──
INSERT INTO notas (escola_id, aluno_id, ano, bimestre, disciplina_id, nota, faltas)
VALUES
    (1, @demo_aluno_id, 2025, 1, 48, 8.50, 2),   -- Português
    (1, @demo_aluno_id, 2025, 1, 21, 7.80, 1),   -- Matemática
    (1, @demo_aluno_id, 2025, 1, 25, 9.00, 0),   -- Ciências
    (1, @demo_aluno_id, 2025, 1, 24, 7.50, 3),   -- História
    (1, @demo_aluno_id, 2025, 1, 23, 8.20, 1),   -- Geografia
    (1, @demo_aluno_id, 2025, 1, 30, 9.50, 0),   -- Inglês
    (1, @demo_aluno_id, 2025, 1, 26, 8.80, 0),   -- Artes
    (1, @demo_aluno_id, 2025, 1, 27, 9.20, 1);   -- Ed. Física

-- ── Bimestre 2 ──
INSERT INTO notas (escola_id, aluno_id, ano, bimestre, disciplina_id, nota, faltas)
VALUES
    (1, @demo_aluno_id, 2025, 2, 48, 7.90, 3),   -- Português
    (1, @demo_aluno_id, 2025, 2, 21, 8.30, 0),   -- Matemática
    (1, @demo_aluno_id, 2025, 2, 25, 8.50, 1),   -- Ciências
    (1, @demo_aluno_id, 2025, 2, 24, 6.80, 2),   -- História
    (1, @demo_aluno_id, 2025, 2, 23, 7.60, 2),   -- Geografia
    (1, @demo_aluno_id, 2025, 2, 30, 8.90, 1),   -- Inglês
    (1, @demo_aluno_id, 2025, 2, 26, 9.10, 0),   -- Artes
    (1, @demo_aluno_id, 2025, 2, 27, 8.70, 0);   -- Ed. Física

-- ── Bimestre 3 ──
INSERT INTO notas (escola_id, aluno_id, ano, bimestre, disciplina_id, nota, faltas)
VALUES
    (1, @demo_aluno_id, 2025, 3, 48, 8.00, 1),   -- Português
    (1, @demo_aluno_id, 2025, 3, 21, 7.50, 2),   -- Matemática
    (1, @demo_aluno_id, 2025, 3, 25, 8.80, 0),   -- Ciências
    (1, @demo_aluno_id, 2025, 3, 24, 7.20, 1),   -- História
    (1, @demo_aluno_id, 2025, 3, 23, 8.40, 0),   -- Geografia
    (1, @demo_aluno_id, 2025, 3, 30, 9.30, 0),   -- Inglês
    (1, @demo_aluno_id, 2025, 3, 26, 8.60, 1),   -- Artes
    (1, @demo_aluno_id, 2025, 3, 27, 9.00, 0);   -- Ed. Física

-- ── Bimestre 4 ──
INSERT INTO notas (escola_id, aluno_id, ano, bimestre, disciplina_id, nota, faltas)
VALUES
    (1, @demo_aluno_id, 2025, 4, 48, 8.70, 0),   -- Português
    (1, @demo_aluno_id, 2025, 4, 21, 8.10, 1),   -- Matemática
    (1, @demo_aluno_id, 2025, 4, 25, 9.20, 0),   -- Ciências
    (1, @demo_aluno_id, 2025, 4, 24, 7.80, 2),   -- História
    (1, @demo_aluno_id, 2025, 4, 23, 8.60, 0),   -- Geografia
    (1, @demo_aluno_id, 2025, 4, 30, 9.00, 1),   -- Inglês
    (1, @demo_aluno_id, 2025, 4, 26, 9.40, 0),   -- Artes
    (1, @demo_aluno_id, 2025, 4, 27, 8.90, 0);   -- Ed. Física

-- ── VERIFICAÇÃO ──────────────────────────────────────────────────────────────
SELECT 'RESPONSÁVEL' AS tipo, r.id, r.nome, r.cpf 
FROM responsaveis r WHERE r.cpf = '00000000191';

SELECT 'ALUNO' AS tipo, a.id, a.estudante, a.turma_id, t.nome AS turma 
FROM alunos a JOIN turmas t ON a.turma_id = t.id 
WHERE a.codigo = 999999;

SELECT 'VÍNCULO' AS tipo, ra.id, ra.responsavel_id, ra.aluno_id, ra.ativo 
FROM responsaveis_alunos ra 
WHERE ra.responsavel_id = @demo_responsavel_id;

SELECT 'NOTAS' AS tipo, COUNT(*) AS total_notas 
FROM notas 
WHERE aluno_id = @demo_aluno_id AND ano = 2025;

-- ============================================================================
-- IMPORTANTE: Após executar, anote o @demo_responsavel_id gerado.
-- Esse valor deve ser atualizado no bypass de autenticação em app_pais.js
-- (linha ~1533) para substituir o `id: 0` atual.
-- ============================================================================
