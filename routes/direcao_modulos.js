// routes/direcao_modulos.js
// ============================================================================
// Governança de Módulos por Perfil — Gerenciamento pelo Diretor (Camada 3)
//
// Arquitetura de 3 camadas:
//   Camada 1 (CEO / escola_modulos):       teto geral da escola
//   Camada 2 (CEO / escola_perfil_modulos): teto por perfil — o que o CEO libera
//   Camada 3 (Diretor / direcao_acesso_perfil): o que o Diretor mantém ou restringe
//
// Regras:
//   • Diretor lê o teto do CEO por perfil (escola_perfil_modulos) — não mais escola_modulos
//   • Diretor salva suas restrições em direcao_acesso_perfil (tabela separada, não afeta o CEO)
//   • Diretor NUNCA pode liberar mais do que o CEO definiu para aquele perfil
//   • Padrão (sem config do Diretor) = igual ao CEO (herdado automaticamente)
//
// Isolamento CCMDF:
//   Diretor Pedagógico ('diretor')             → gerencia perfis pedagógicos, módulos não-disciplinares
//   Diretor Disciplinar ('diretor_disciplinar') → gerencia perfis disciplinares, módulos disciplinar.*
// ============================================================================

import express from 'express';
const router = express.Router();

// ── Auto-migrate: garante que a tabela direcao_acesso_perfil existe ────────────
// Tabela SEPARADA de escola_perfil_modulos (que é do CEO).
// Esta tabela armazena as restrições adicionais que o Diretor aplica.
let _tableMigrated = false;
router.use(async (req, _res, next) => {
  if (_tableMigrated) return next();
  try {
    await req.db.query(`
      CREATE TABLE IF NOT EXISTS direcao_acesso_perfil (
        id         INT AUTO_INCREMENT PRIMARY KEY,
        escola_id  INT NOT NULL,
        perfil     VARCHAR(60) NOT NULL,
        modulo     VARCHAR(100) NOT NULL,
        ativo      TINYINT(1) NOT NULL DEFAULT 1,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uk_dap (escola_id, perfil, modulo),
        INDEX      idx_dap_escola_perfil (escola_id, perfil)
      )
    `);
    _tableMigrated = true;
    console.log('[direcao_modulos] Tabela direcao_acesso_perfil verificada/criada ✅');
  } catch (e) {
    _tableMigrated = true;
    if (!String(e.message || '').includes('already exists')) {
      console.warn('[direcao_modulos] Auto-migrate aviso:', e.message);
    }
  }
  next();
});

// ─── Domínios de perfis por tipo de diretor ───────────────────────────────────
const DOMINIOS_DIRETOR = {
  'diretor': new Set([
    'professor', 'coordenador', 'supervisor', 'pedagogo',
    'secretario', 'secretaria', 'orientador',
    'aluno', 'biblioteca', 'educador_social', 'merenda',
    'psicologo', 'responsavel', 'vice_diretor',
    'vigilancia', 'visitante',
  ]),
  'vice_diretor': new Set([
    'professor', 'coordenador', 'supervisor', 'pedagogo',
    'secretario', 'secretaria', 'orientador',
    'aluno', 'biblioteca', 'educador_social', 'merenda',
    'psicologo', 'responsavel',
    'vigilancia', 'visitante',
  ]),
  'diretor_disciplinar': new Set([
    'subcomandante', 'supervisor_disciplinar', 'monitor_disciplinar',
  ]),
};

const PERFIS_VALIDOS = new Set([
  ...DOMINIOS_DIRETOR['diretor'],
  ...DOMINIOS_DIRETOR['diretor_disciplinar'],
]);

// ─── Helper: verifica se módulo pertence ao domínio do diretor ─────────────
function isModuloPermitidoParaDiretor(modulo, perfilDiretor) {
  if (perfilDiretor === 'diretor_disciplinar') {
    return modulo.startsWith('disciplinar');
  }
  return !modulo.startsWith('disciplinar');
}

function getPerfilDiretor(req) {
  return String(req.user?.perfil || '').toLowerCase().trim();
}

function validarAutoridadeDiretor(perfilDiretor, perfilAlvo, res) {
  const dominio = DOMINIOS_DIRETOR[perfilDiretor];
  if (!dominio) {
    res.status(403).json({ ok: false, message: `Perfil '${perfilDiretor}' não tem autoridade de gerenciar módulos.` });
    return false;
  }
  if (!dominio.has(perfilAlvo)) {
    res.status(403).json({ ok: false, message: `Diretor '${perfilDiretor}' não tem autoridade sobre o perfil '${perfilAlvo}'.` });
    return false;
  }
  return true;
}

/**
 * GET /api/direcao/modulos/meus-perfis
 *
 * Retorna os perfis que:
 *   1. Estão no domínio do diretor logado (ex: 'diretor' → pedagógicos)
 *   2. O CEO JÁ CONFIGUROU em escola_perfil_modulos para esta escola
 *
 * Antes: retornava todos os 17 perfis do domínio (lista estática)
 * Agora: filtra pelos perfis que o CEO efetivamente habilitou para esta escola
 */
router.get('/meus-perfis', async (req, res) => {
  const db = req.db;
  const escola_id = req.user?.escola_id;
  const perfilDiretor = getPerfilDiretor(req);
  const dominio = DOMINIOS_DIRETOR[perfilDiretor];

  if (!dominio) {
    return res.status(403).json({ ok: false, message: `Perfil '${perfilDiretor}' não tem autoridade de gerenciar módulos.` });
  }

  if (!escola_id) {
    return res.status(401).json({ ok: false, message: 'Escola não identificada.' });
  }

  try {
    // Busca perfis que o CEO configurou (com ao menos 1 módulo ativo) para esta escola
    const [rows] = await db.query(
      `SELECT DISTINCT perfil FROM escola_perfil_modulos
       WHERE escola_id = ? AND ativo = 1`,
      [Number(escola_id)]
    ).catch(() => [[]]);

    const perfisConfiguradosCEO = new Set((rows || []).map(r => r.perfil));

    // Filtra pelos perfis no domínio do diretor que o CEO configurou
    const perfisGerenciaveis = [...dominio].filter(p => perfisConfiguradosCEO.has(p));

    return res.json({
      ok: true,
      perfil_diretor: perfilDiretor,
      perfis: perfisGerenciaveis,
      total_configurados_ceo: perfisConfiguradosCEO.size,
    });
  } catch (err) {
    console.error('[direcao_modulos] GET /meus-perfis erro:', err);
    return res.status(500).json({ ok: false, message: 'Erro ao buscar perfis.' });
  }
});

/**
 * GET /api/direcao/modulos/:perfil
 *
 * Retorna os módulos do CEO para o perfil (teto do Diretor)
 * + estado atual da configuração do Diretor para cada módulo.
 *
 * Camada 2 (CEO ceiling por perfil): lê escola_perfil_modulos WHERE perfil=?
 * Camada 3 (Diretor config):         lê direcao_acesso_perfil WHERE perfil=?
 *
 * Response:
 * {
 *   ok: true,
 *   perfil: 'professor',
 *   modulos: [
 *     { modulo: 'secretaria.alunos', ceo_ativo: true, diretor_ativo: true|false|null }
 *   ]
 * }
 * diretor_ativo = null → Diretor ainda não configurou (padrão: herda o CEO = liberado)
 */
router.get('/:perfil', async (req, res) => {
  const db = req.db;
  const escola_id = req.user?.escola_id;
  const { perfil } = req.params;
  const perfilDiretor = getPerfilDiretor(req);

  if (!escola_id) return res.status(401).json({ ok: false, message: 'Escola não identificada.' });
  if (!PERFIS_VALIDOS.has(perfil)) return res.status(400).json({ ok: false, message: `Perfil inválido: ${perfil}` });
  if (!validarAutoridadeDiretor(perfilDiretor, perfil, res)) return;

  try {
    // ── Camada 2: teto do CEO para este perfil específico (escola_perfil_modulos) ──
    const [ceoPorPerfilRows] = await db.query(
      `SELECT modulo FROM escola_perfil_modulos
       WHERE escola_id = ? AND perfil = ? AND ativo = 1`,
      [Number(escola_id), perfil]
    ).catch(() => [[]]);

    // Filtra pelo domínio do diretor (pedagógico não vê disciplinar e vice-versa)
    const ceoCeiling = (ceoPorPerfilRows || [])
      .map(r => r.modulo)
      .filter(m => isModuloPermitidoParaDiretor(m, perfilDiretor));

    if (ceoCeiling.length === 0) {
      return res.json({
        ok: true, escola_id, perfil,
        modulos: [],
        aviso: 'CEO ainda não configurou módulos para este perfil nesta escola.',
      });
    }

    // ── Camada 3: configuração do Diretor (direcao_acesso_perfil) ──────────────
    const [diretorRows] = await db.query(
      `SELECT modulo, ativo FROM direcao_acesso_perfil
       WHERE escola_id = ? AND perfil = ?`,
      [Number(escola_id), perfil]
    ).catch(() => [[]]);

    const diretorMap = new Map((diretorRows || []).map(r => [r.modulo, Number(r.ativo) === 1]));

    // Monta resposta: apenas módulos que o CEO liberou para este perfil
    const modulos = ceoCeiling.map(modulo => ({
      modulo,
      ceo_ativo: true,                                               // sempre true (só listamos os ativos do CEO)
      diretor_ativo: diretorMap.has(modulo) ? diretorMap.get(modulo) : null, // null = não configurado = herda CEO
    }));

    return res.json({ ok: true, escola_id, perfil, modulos });
  } catch (err) {
    console.error('[direcao_modulos] GET /:perfil erro:', err);
    return res.status(500).json({ ok: false, message: 'Erro ao buscar módulos.' });
  }
});

/**
 * PUT /api/direcao/modulos/:perfil
 *
 * Salva a configuração do Diretor para um perfil.
 * Escreve em direcao_acesso_perfil (NÃO afeta escola_perfil_modulos do CEO).
 * Valida: módulos devem estar no CEO ceiling (escola_perfil_modulos WHERE perfil=?).
 *
 * Body: { modulos: [{ modulo: 'secretaria.alunos', ativo: true }, ...] }
 */
router.put('/:perfil', async (req, res) => {
  const db = req.db;
  const escola_id = req.user?.escola_id;
  const { perfil } = req.params;
  const { modulos } = req.body;
  const perfilDiretor = getPerfilDiretor(req);

  if (!escola_id) return res.status(401).json({ ok: false, message: 'Escola não identificada.' });
  if (!PERFIS_VALIDOS.has(perfil)) return res.status(400).json({ ok: false, message: `Perfil inválido: ${perfil}` });
  if (!validarAutoridadeDiretor(perfilDiretor, perfil, res)) return;
  if (!Array.isArray(modulos) || modulos.length === 0) {
    return res.status(400).json({ ok: false, message: 'modulos deve ser um array não vazio.' });
  }

  try {
    // Camada 2: CEO ceiling POR PERFIL (não mais escola_modulos genérico)
    const [ceoPorPerfilRows] = await db.query(
      `SELECT modulo FROM escola_perfil_modulos WHERE escola_id = ? AND perfil = ? AND ativo = 1`,
      [Number(escola_id), perfil]
    ).catch(() => [[]]);

    const ceoCeiling = new Set((ceoPorPerfilRows || []).map(r => r.modulo));

    let total_ativados = 0;
    let total_desativados = 0;
    let total_ignorados = 0;

    for (const { modulo, ativo } of modulos) {
      if (!modulo) continue;

      // Só aceita módulos que o CEO liberou para este perfil
      if (!ceoCeiling.has(modulo)) {
        total_ignorados++;
        continue;
      }

      // Só aceita módulos no domínio do diretor
      if (!isModuloPermitidoParaDiretor(modulo, perfilDiretor)) {
        total_ignorados++;
        console.warn(`[direcao_modulos] Módulo '${modulo}' bloqueado: fora do domínio do diretor '${perfilDiretor}'`);
        continue;
      }

      const ativoVal = ativo ? 1 : 0;

      // Escreve em direcao_acesso_perfil (NÃO em escola_perfil_modulos)
      await db.query(
        `INSERT INTO direcao_acesso_perfil (escola_id, perfil, modulo, ativo)
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
 * Remove a configuração do Diretor para o perfil.
 * Com isso, o perfil volta a herdar diretamente o que o CEO definiu.
 */
router.delete('/:perfil', async (req, res) => {
  const db = req.db;
  const escola_id = req.user?.escola_id;
  const { perfil } = req.params;
  const perfilDiretor = getPerfilDiretor(req);

  if (!escola_id) return res.status(401).json({ ok: false });
  if (!PERFIS_VALIDOS.has(perfil)) return res.status(400).json({ ok: false });
  if (!validarAutoridadeDiretor(perfilDiretor, perfil, res)) return;

  try {
    await db.query(
      'DELETE FROM direcao_acesso_perfil WHERE escola_id = ? AND perfil = ?',
      [Number(escola_id), perfil]
    );
    return res.json({
      ok: true,
      message: `Configuração do Diretor para perfil '${perfil}' removida. O perfil volta a usar o teto do CEO.`,
    });
  } catch (err) {
    console.error('[direcao_modulos] DELETE erro:', err);
    return res.status(500).json({ ok: false, message: 'Erro ao remover configuração.' });
  }
});

export default router;
