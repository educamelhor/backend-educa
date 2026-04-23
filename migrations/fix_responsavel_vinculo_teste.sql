-- ============================================================
-- DIAGNÓSTICO + FIX: vincular responsável de teste a aluno ativo
-- CPF do responsável: 80426069153
-- Execute no console SQL do DigitalOcean
-- ============================================================

-- PASSO 1: Confirmar responsavel e ver seus vínculos atuais
SELECT
  r.id AS responsavel_id,
  r.nome,
  r.cpf,
  r.email,
  r.status_global,
  ra.aluno_id,
  ra.escola_id,
  ra.ativo AS vinculo_ativo,
  ra.principal,
  a.estudante AS aluno_nome,
  a.turma_id
FROM responsaveis r
LEFT JOIN responsaveis_alunos ra ON ra.responsavel_id = r.id
LEFT JOIN alunos a ON a.id = ra.aluno_id
WHERE r.cpf = '80426069153';

-- ============================================================
-- PASSO 2: Ver alunos ativos com turma em 2025/2026 (escolha um)
-- ============================================================
SELECT
  a.id AS aluno_id,
  a.estudante AS nome,
  a.escola_id,
  e.apelido AS escola,
  t.id AS turma_id,
  t.nome AS turma,
  t.serie,
  t.turno
FROM alunos a
JOIN escolas e ON e.id = a.escola_id
LEFT JOIN turmas t ON t.id = a.turma_id
WHERE a.turma_id IS NOT NULL
ORDER BY e.apelido, t.serie, a.estudante
LIMIT 20;

-- ============================================================
-- PASSO 3: Atualizar vínculo existente para apontar novo aluno
-- Substitua: <ALUNO_ID> e <ESCOLA_ID> com valores do passo 2
-- ============================================================

-- Opção A: Atualizar vínculo existente (se já existe linha na responsaveis_alunos)
/*
UPDATE responsaveis_alunos
SET
  aluno_id  = <ALUNO_ID>,
  escola_id = <ESCOLA_ID>,
  ativo     = 1,
  principal = 1,
  pode_ver_boletim     = 1,
  pode_ver_frequencia  = 1,
  pode_ver_agenda      = 1,
  pode_receber_notificacoes = 1,
  pode_autorizar_terceiros  = 1
WHERE responsavel_id = (SELECT id FROM responsaveis WHERE cpf = '80426069153');
*/

-- Opção B: Inserir novo vínculo (se não existe ou quer adicionar)
/*
INSERT INTO responsaveis_alunos
  (responsavel_id, aluno_id, escola_id, ativo, principal,
   pode_ver_boletim, pode_ver_frequencia, pode_ver_agenda,
   pode_receber_notificacoes, pode_autorizar_terceiros)
SELECT
  r.id, <ALUNO_ID>, <ESCOLA_ID>, 1, 1, 1, 1, 1, 1, 1
FROM responsaveis r
WHERE r.cpf = '80426069153'
ON DUPLICATE KEY UPDATE
  ativo = 1,
  principal = 1,
  pode_ver_boletim = 1,
  pode_ver_frequencia = 1,
  pode_ver_agenda = 1,
  pode_receber_notificacoes = 1,
  pode_autorizar_terceiros = 1;
*/

-- PASSO 4: Confirmar resultado
SELECT
  ra.*,
  a.estudante AS aluno_nome,
  t.nome AS turma,
  t.serie
FROM responsaveis_alunos ra
JOIN responsaveis r ON r.id = ra.responsavel_id
JOIN alunos a ON a.id = ra.aluno_id
LEFT JOIN turmas t ON t.id = a.turma_id
WHERE r.cpf = '80426069153';
