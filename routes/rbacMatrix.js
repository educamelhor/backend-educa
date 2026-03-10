// api/routes/rbacMatrix.js
// Matriz RBAC explícita (v1): perfil -> permissões
// Obs.: strings padronizadas "recurso:acao" (simples e auditável)

export const RBAC_MATRIX = Object.freeze({
  // Governança máxima (escola)
  diretor: [
    "conteudos:ver",
    "conteudos:criar",
    "conteudos:editar",
    "conteudos:excluir",
    "conteudos:enviar",
    "conteudos:aprovar",
    "conteudos:reabrir",
    "conteudos:bloquear_edicao",
    "usuarios:ver",
    "usuarios:criar",
    "usuarios:editar",
    "usuarios:inativar",
    "professores:ver",
    "professores:criar",
    "professores:editar",
    "professores:inativar",
  ],

  // Gestão pedagógica (pode aprovar/reabrir dependendo da sua regra)
  coordenador: [
    "conteudos:ver",
    "conteudos:criar",
    "conteudos:editar",
    "conteudos:enviar",
    "conteudos:aprovar",
    "conteudos:reabrir",
    "usuarios:ver",
    "professores:ver",
  ],

  supervisor: [
    "conteudos:ver",
    "conteudos:aprovar",
    "conteudos:reabrir",
  ],

  orientador: [
    "conteudos:ver",
  ],

  pedagogo: [
    "conteudos:ver",
  ],

  // Docente (não governa status)
  professor: [
    "conteudos:ver",
    "conteudos:criar",
    "conteudos:editar",
    "conteudos:enviar",
  ],

  secretario: [
    "usuarios:ver",
    "usuarios:criar",
    "usuarios:editar",
    "professores:ver",
  ],

  admin: [
    "usuarios:ver",
    "usuarios:criar",
    "usuarios:editar",
  ],

  visitante: [],
  aluno: [],
  responsavel: [],
  militar: [],
});

export function getPermissoesPorPerfil(perfil) {
  const p = String(perfil || "visitante").toLowerCase();
  return RBAC_MATRIX[p] ? [...RBAC_MATRIX[p]] : [];
}
