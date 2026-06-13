// routes/direcao_modulos.js
// Governança de Módulos por Perfil — Gerenciamento pelo Diretor
// Camada 2 da arquitetura: CEO define o TETO, Diretor distribui por perfil

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

const PERFIS_VALIDOS = new Set([
  'secretario', 'secretaria', 'professor', 'coordenador',
  'supervisor', 'disciplinar', 'diretor_disciplinar'
]);

/**
 * GET /api/direcao/modulos/:perfil
 * Retorna o CEO ceiling + config do Diretor para o perfil solicitado.
 * Usado pela tela de Governança do Diretor.
 *
 * Response:
 * {
 *   ok: true,
 *   perfil: 'secretario',
 *   modulos: [
 *     { modulo: 'secretaria.alunos', ceo_ativo: true, diretor_ativo: true|false|null }
 *   ]
 * }
 * diretor_ativo = null → Diretor ainda não configurou (padrão: habilitado)
 */
router.get('/:perfil', async (req, res) => {
  const db = req.db;
  const escola_id = req.user?.escola_id;
  const { perfil } = req.params;

  if (!escola_id) {
    return res.status(401).json({ ok: false, message: 'Escola não identificada.' });
  }

  if (!PERFIS_VALIDOS.has(perfil)) {
    return res.status(400).json({ ok: false, message: `Perfil inválido: ${perfil}` });
  }

  try {
    // CEO ceiling: todos os módulos ativos da escola
    const [ceoCeilingRows] = await db.query(
      'SELECT modulo FROM escola_modulos WHERE escola_id = ? AND ativo = 1',
      [Number(escola_id)]
    );
    const ceoCeiling = new Set(ceoCeilingRows.map(r => r.modulo));

    // Config do Diretor para este perfil
    const [perfilRows] = await db.query(
      'SELECT modulo, ativo FROM escola_perfil_modulos WHERE escola_id = ? AND perfil = ?',
      [Number(escola_id), perfil]
    ).catch(() => [[]]);

    const perfilMap = new Map(perfilRows.map(r => [r.modulo, Number(r.ativo) === 1]));

    // Monta a resposta: apenas módulos habilitados pelo CEO
    const modulos = [...ceoCeiling].map(modulo => ({
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
 * Apenas módulos que estão no CEO ceiling são aceitos.
 *
 * Body: { modulos: [{ modulo: 'secretaria.alunos', ativo: true }, ...] }
 */
router.put('/:perfil', async (req, res) => {
  const db = req.db;
  const escola_id = req.user?.escola_id;
  const { perfil } = req.params;
  const { modulos } = req.body;

  if (!escola_id) {
    return res.status(401).json({ ok: false, message: 'Escola não identificada.' });
  }

  if (!PERFIS_VALIDOS.has(perfil)) {
    return res.status(400).json({ ok: false, message: `Perfil inválido: ${perfil}` });
  }

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
 * Resultado: perfil volta ao comportamento padrão (usa CEO ceiling completo).
 */
router.delete('/:perfil', async (req, res) => {
  const db = req.db;
  const escola_id = req.user?.escola_id;
  const { perfil } = req.params;

  if (!escola_id) return res.status(401).json({ ok: false });
  if (!PERFIS_VALIDOS.has(perfil)) return res.status(400).json({ ok: false });

  try {
    await db.query(
      'DELETE FROM escola_perfil_modulos WHERE escola_id = ? AND perfil = ?',
      [Number(escola_id), perfil]
    );
    return res.json({ ok: true, message: `Configuração do perfil ${perfil} removida. Voltou ao padrão.` });
  } catch (err) {
    console.error('[direcao_modulos] DELETE erro:', err);
    return res.status(500).json({ ok: false, message: 'Erro ao remover configuração.' });
  }
});

export default router;
