// routes/direcao_modulos.js
// ============================================================================
// Governança de Módulos por Perfil — Gerenciamento pelo Diretor
// ✅ [GOVERNANÇA v2] Arquitetura de 3 camadas:
//   Camada 1 (CEO):     escola_modulos → TETO da escola
//   Camada 2 (Diretor): escola_perfil_modulos → o que cada perfil pode acessar
//   Camada 3 (Usuário): intersection(CEO ceiling, config Diretor) = acesso real
//
// Isolamento CCMDF:
//   Diretor Pedagógico ('diretor')         → gerencia perfis pedagógicos, módulos não-disciplinares
//   Diretor Disciplinar ('diretor_disciplinar') → gerencia perfis disciplinares, módulos disciplinar.*
// ============================================================================

import express from 'express';
const router = express.Router();

// ── Auto-migrate: garante que a tabela escola_perfil_modulos existe ────────────
let _tableMigrated = false;
router.use(async (req, _res, next) => {
  if (_tableMigrated) return next();
  try {
    await req.db.query(`
      CREATE TABLE IF NOT EXISTS escola_perfil_modulos (
        id          INT AUTO_INCREMENT PRIMARY KEY,
        escola_id   INT NOT NULL,
        perfil      VARCHAR(50) NOT NULL,
        modulo      VARCHAR(100) NOT NULL,
        ativo       TINYINT(1) NOT NULL DEFAULT 0,
        updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uk_epm (escola_id, perfil, modulo),
        INDEX idx_escola_perfil (escola_id, perfil)
      )
    `);
    _tableMigrated = true;
    console.log('[direcao_modulos] Tabela escola_perfil_modulos verificada/criada ✅');
  } catch (e) {
    _tableMigrated = true;
    if (!String(e.message || '').includes('already exists')) {
      console.warn('[direcao_modulos] Auto-migrate aviso:', e.message);
    }
  }
  next();
});

// ─── Domínios de perfis por tipo de diretor ───────────────────────────────────
// Define quais perfis cada tipo de diretor pode gerenciar.
const DOMINIOS_DIRETOR = {
  // Diretor Pedagógico (escola comum ou CCMDF — domínio pedagógico)
  'diretor': new Set([
    'professor', 'coordenador', 'supervisor', 'pedagogo',
    'secretario', 'secretaria', 'orientador',
    'aluno', 'biblioteca', 'educador_social', 'merenda',
    'psicologo', 'responsavel', 'vice_diretor',
    'vigilancia', 'visitante',
  ]),
  // Vice-Diretor: mesmos perfis do diretor pedagógico
  'vice_diretor': new Set([
    'professor', 'coordenador', 'supervisor', 'pedagogo',
    'secretario', 'secretaria', 'orientador',
    'aluno', 'biblioteca', 'educador_social', 'merenda',
    'psicologo', 'responsavel',
    'vigilancia', 'visitante',
  ]),
  // Diretor Disciplinar (CCMDF — domínio disciplinar)
  'diretor_disciplinar': new Set([
    'subcomandante', 'supervisor_disciplinar', 'monitor_disciplinar',
  ]),
};

// Todos os perfis configuráveis (união de todos os domínios)
const PERFIS_VALIDOS = new Set([
  ...DOMINIOS_DIRETOR['diretor'],
  ...DOMINIOS_DIRETOR['diretor_disciplinar'],
]);

// ─── Helper: verifica se um módulo pertence ao domínio do diretor ─────────────
function isModuloPermitidoParaDiretor(modulo, perfilDiretor) {
  if (perfilDiretor === 'diretor_disciplinar') {
    // Diretor Disciplinar: APENAS módulos disciplinar.*
    return modulo.startsWith('disciplinar');
  }
  // Diretor Pedagógico / Vice-Diretor: tudo EXCETO disciplinar.*
  return !modulo.startsWith('disciplinar');
}

// ─── Helper: obtém perfil do diretor logado ───────────────────────────────────
function getPerfilDiretor(req) {
  return String(req.user?.perfil || '').toLowerCase().trim();
}

// ─── Helper: valida se o diretor tem autoridade sobre o perfil solicitado ─────
function validarAutoridadeDiretor(perfilDiretor, perfilAlvo, res) {
  const dominio = DOMINIOS_DIRETOR[perfilDiretor];
  if (!dominio) {
    res.status(403).json({
      ok: false,
      message: `Perfil '${perfilDiretor}' não tem autoridade de gerenciar módulos.`,
    });
    return false;
  }
  if (!dominio.has(perfilAlvo)) {
    res.status(403).json({
      ok: false,
      message: `Diretor com perfil '${perfilDiretor}' não tem autoridade para gerenciar o perfil '${perfilAlvo}'.`,
    });
    return false;
  }
  return true;
}

/**
 * GET /api/direcao/modulos/meus-perfis
 * Retorna os perfis que o diretor logado tem autoridade de gerenciar.
 * ✅ [GOVERNANÇA v2] Novo endpoint
 */
router.get('/meus-perfis', async (req, res) => {
  const perfilDiretor = getPerfilDiretor(req);
  const dominio = DOMINIOS_DIRETOR[perfilDiretor];
  if (!dominio) {
    return res.status(403).json({
      ok: false,
      message: `Perfil '${perfilDiretor}' não tem autoridade de gerenciar módulos.`,
    });
  }
  return res.json({
    ok: true,
    perfil_diretor: perfilDiretor,
    perfis: [...dominio],
  });
});

/**
 * GET /api/direcao/modulos/:perfil
 * Retorna o CEO ceiling + config do Diretor para o perfil solicitado.
 * Respeitando o domínio do diretor logado.
 *
 * Response:
 * {
 *   ok: true,
 *   perfil: 'secretario',
 *   modulos: [
 *     { modulo: 'secretaria.alunos', ceo_ativo: true, diretor_ativo: true|false|null }
 *   ]
 * }
 * diretor_ativo = null → Diretor ainda não configurou (padrão: desabilitado na v2)
 */
router.get('/:perfil', async (req, res) => {
  const db = req.db;
  const escola_id = req.user?.escola_id;
  const { perfil } = req.params;
  const perfilDiretor = getPerfilDiretor(req);

  if (!escola_id) {
    return res.status(401).json({ ok: false, message: 'Escola não identificada.' });
  }

  if (!PERFIS_VALIDOS.has(perfil)) {
    return res.status(400).json({ ok: false, message: `Perfil inválido: ${perfil}` });
  }

  // Valida autoridade do diretor sobre esse perfil
  if (!validarAutoridadeDiretor(perfilDiretor, perfil, res)) return;

  try {
    // CEO ceiling: todos os módulos ativos da escola
    const [ceoCeilingRows] = await db.query(
      'SELECT modulo FROM escola_modulos WHERE escola_id = ? AND ativo = 1',
      [Number(escola_id)]
    );
    const ceoCeiling = new Set(ceoCeilingRows.map(r => r.modulo));

    // Filtra pelo domínio do diretor (pedagógico vs disciplinar)
    const ceoCeilingFiltrado = [...ceoCeiling].filter(m =>
      isModuloPermitidoParaDiretor(m, perfilDiretor)
    );

    // Config do Diretor para este perfil
    const [perfilRows] = await db.query(
      'SELECT modulo, ativo FROM escola_perfil_modulos WHERE escola_id = ? AND perfil = ?',
      [Number(escola_id), perfil]
    ).catch(() => [[]]);

    const perfilMap = new Map(perfilRows.map(r => [r.modulo, Number(r.ativo) === 1]));

    // Monta a resposta: apenas módulos do domínio do diretor habilitados pelo CEO
    const modulos = ceoCeilingFiltrado.map(modulo => ({
      modulo,
      ceo_ativo: true,
      diretor_ativo: perfilMap.has(modulo) ? perfilMap.get(modulo) : null,
    }));

    return res.json({ ok: true, escola_id, perfil, modulos });
  } catch (err) {
    console.error('[direcao_modulos] GET erro:', err);
    return res.status(500).json({ ok: false, message: 'Erro ao buscar módulos.' });
  }
});

/**
 * PUT /api/direcao/modulos/:perfil
 * Salva a configuração do Diretor para um perfil.
 * Valida: (1) CEO ceiling, (2) domínio do diretor (pedagógico vs disciplinar).
 *
 * Body: { modulos: [{ modulo: 'secretaria.alunos', ativo: true }, ...] }
 */
router.put('/:perfil', async (req, res) => {
  const db = req.db;
  const escola_id = req.user?.escola_id;
  const { perfil } = req.params;
  const { modulos } = req.body;
  const perfilDiretor = getPerfilDiretor(req);

  if (!escola_id) {
    return res.status(401).json({ ok: false, message: 'Escola não identificada.' });
  }

  if (!PERFIS_VALIDOS.has(perfil)) {
    return res.status(400).json({ ok: false, message: `Perfil inválido: ${perfil}` });
  }

  // Valida autoridade do diretor sobre esse perfil
  if (!validarAutoridadeDiretor(perfilDiretor, perfil, res)) return;

  if (!Array.isArray(modulos) || modulos.length === 0) {
    return res.status(400).json({ ok: false, message: 'modulos deve ser um array não vazio.' });
  }

  try {
    // CEO ceiling: valida que apenas módulos habilitados pelo CEO são aceitos
    const [ceoCeilingRows] = await db.query(
      'SELECT modulo FROM escola_modulos WHERE escola_id = ? AND ativo = 1',
      [Number(escola_id)]
    );
    const ceoCeiling = new Set(ceoCeilingRows.map(r => r.modulo));

    let total_ativados = 0;
    let total_desativados = 0;
    let total_ignorados = 0;

    for (const { modulo, ativo } of modulos) {
      if (!modulo) continue;

      // Não aceita módulos fora do CEO ceiling
      if (!ceoCeiling.has(modulo)) {
        total_ignorados++;
        continue;
      }

      // ✅ [GOVERNANÇA v2] Não aceita módulos fora do domínio do diretor
      if (!isModuloPermitidoParaDiretor(modulo, perfilDiretor)) {
        total_ignorados++;
        console.warn(`[direcao_modulos] Módulo '${modulo}' bloqueado: fora do domínio do diretor '${perfilDiretor}'`);
        continue;
      }

      const ativoVal = ativo ? 1 : 0;
      await db.query(
        `INSERT INTO escola_perfil_modulos (escola_id, perfil, modulo, ativo)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE ativo = ?`,
        [Number(escola_id), perfil, modulo, ativoVal, ativoVal]
      );

      if (ativoVal) total_ativados++;
      else total_desativados++;
    }

    console.log(`[direcao_modulos] PUT escola=${escola_id} perfil=${perfil}: +${total_ativados} -${total_desativados} (ignorados: ${total_ignorados})`);
    return res.json({ ok: true, perfil, total_ativados, total_desativados, total_ignorados });
  } catch (err) {
    console.error('[direcao_modulos] PUT erro:', err);
    return res.status(500).json({ ok: false, message: 'Erro ao salvar módulos.' });
  }
});

/**
 * DELETE /api/direcao/modulos/:perfil
 * Remove TODA a configuração do Diretor para um perfil.
 * ✅ [GOVERNANÇA v2] Com fallback zero, isso resulta em acesso zero ao perfil.
 */
router.delete('/:perfil', async (req, res) => {
  const db = req.db;
  const escola_id = req.user?.escola_id;
  const { perfil } = req.params;
  const perfilDiretor = getPerfilDiretor(req);

  if (!escola_id) return res.status(401).json({ ok: false });
  if (!PERFIS_VALIDOS.has(perfil)) return res.status(400).json({ ok: false });

  // Valida autoridade
  if (!validarAutoridadeDiretor(perfilDiretor, perfil, res)) return;

  try {
    await db.query(
      'DELETE FROM escola_perfil_modulos WHERE escola_id = ? AND perfil = ?',
      [Number(escola_id), perfil]
    );
    return res.json({
      ok: true,
      message: `Configuração do perfil ${perfil} removida. ⚠️ Usuários deste perfil ficam sem acesso (fallback zero).`,
    });
  } catch (err) {
    console.error('[direcao_modulos] DELETE erro:', err);
    return res.status(500).json({ ok: false, message: 'Erro ao remover configuração.' });
  }
});

export default router;
