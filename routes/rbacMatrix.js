// api/routes/rbacMatrix.js
// Matriz RBAC explícita (v2): perfil -> permissões
// ✅ [GOVERNANÇA v2] O controle de acesso primário é por módulo (escola_perfil_modulos).
// Esta matriz mantém permissões granulares apenas para retrocompatibilidade
// com endpoints que ainda não foram migrados para o modelo de módulos.
// Obs.: strings padronizadas "recurso:acao" (simples e auditável)

export const RBAC_MATRIX = Object.freeze({
  // Governança máxima (escola comum)
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
    "capture_devices.gerenciar",   // EDUCA-CAPTURE: gerir dispositivos da escola
  ],

  // ✅ [GOVERNANÇA v2] Diretor Disciplinar (CCMDF — Comandante)
  // Acesso controlado por módulos (disciplinar.*) — permissões granulares mínimas
  diretor_disciplinar: [
    "usuarios:ver",
    "usuarios:criar",
    "usuarios:editar",
    "usuarios:inativar",
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

  secretaria: [
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

  // ✅ [GOVERNANÇA v2] Novos perfis CCMDF (disciplinar)
  subcomandante: [],
  supervisor_disciplinar: [],
  monitor_disciplinar: [],

  visitante: [],
  aluno: [],
  responsavel: [],
  // 'militar' removido — substituído por 'diretor_disciplinar'
});

export function getPermissoesPorPerfil(perfil) {
  let p = String(perfil || 'visitante').toLowerCase().trim();
  // ✅ [GOVERNANÇA v2] Mapeamento de aliases
  if (p === 'secretaria') p = 'secretario';
  if (p === 'militar') p = 'diretor_disciplinar'; // retrocompatibilidade temporária
  return RBAC_MATRIX[p] ? [...RBAC_MATRIX[p]] : [];
}
