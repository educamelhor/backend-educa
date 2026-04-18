// routes/agente-planos.js
// ============================================================================
// POST /api/agente-planos/:id/exportar-estrutura
// Exporta a coluna "Avaliação Bimestral" de um PAP para o portal EDUCADF.
// ============================================================================

import express from 'express';
import { decrypt } from '../modules/agente/agente.crypt.js';
import { EducaDFBrowser } from '../modules/agente/educadf/educadf.browser.js';
import { exportarPAPEducaDF } from '../modules/agente/educadf/educadf.pap.js';

const router = express.Router();

// ── Helpers ──────────────────────────────────────────────────────────────────
function getUserId(req) {
  return Number(req?.user?.id ?? req?.user?.usuario_id ?? req?.user?.usuarioId ?? 0);
}

function getEscolaId(req) {
  return Number(req?.user?.escola_id ?? 0);
}

// ── Busca credenciais EDUCADF do usuário logado ───────────────────────────────
async function buscarCredenciais(db, escolaId, usuarioId) {
  let rows;
  try {
    [rows] = await db.query(
      `SELECT educadf_login, educadf_senha_enc, educadf_senha_iv, educadf_senha_tag, perfil_id
       FROM agente_credenciais
       WHERE escola_id = ? AND usuario_id = ? AND ativo = 1
       ORDER BY updated_at DESC LIMIT 1`,
      [escolaId, usuarioId]
    );
  } catch {
    // fallback schema antigo (professor_id)
    [rows] = await db.query(
      `SELECT educadf_login, educadf_senha_enc, educadf_senha_iv, educadf_senha_tag, perfil_id
       FROM agente_credenciais
       WHERE escola_id = ? AND professor_id = ? AND ativo = 1
       ORDER BY updated_at DESC LIMIT 1`,
      [escolaId, usuarioId]
    );
  }
  return rows?.[0] || null;
}

// ── Garante coluna agente_exportado_em na tabela ──────────────────────────────
async function ensureAgenteExportadoField(db) {
  try {
    // MySQL 5.7 não suporta ADD COLUMN IF NOT EXISTS — usa INFORMATION_SCHEMA
    const [[row]] = await db.query(`
      SELECT COUNT(*) as cnt
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME   = 'planos_avaliacao'
        AND COLUMN_NAME  = 'agente_exportado_em'
    `);
    if (!row || row.cnt === 0) {
      await db.query(`
        ALTER TABLE planos_avaliacao
        ADD COLUMN agente_exportado_em DATETIME DEFAULT NULL
      `);
      console.log('[agente-planos] Coluna agente_exportado_em adicionada.');
    }
  } catch (err) {
    console.warn('[agente-planos] ensureAgenteExportadoField:', err.message);
  }
}

// ============================================================================
// POST /api/agente-planos/:id/exportar-estrutura
// ============================================================================
router.post('/:id/exportar-estrutura', async (req, res) => {
  const db = req.db;
  const planoId = Number(req.params.id);
  const escolaId = getEscolaId(req);
  const usuarioId = getUserId(req);

  try {

    if (!planoId || !escolaId || !usuarioId) {
      return res.status(400).json({ ok: false, error: 'Parâmetros inválidos.' });
    }

    // ── Garante coluna no banco ──────────────────────────────────────────────
    await ensureAgenteExportadoField(db);

    // ── 1. Busca plano ───────────────────────────────────────────────────────
    const [[plano]] = await db.query(
      `SELECT * FROM planos_avaliacao WHERE id = ? AND escola_id = ?`,
      [planoId, escolaId]
    );

    if (!plano) {
      return res.status(404).json({ ok: false, error: 'Plano não encontrado.' });
    }

    if (plano.status !== 'APROVADO' && plano.status !== 'ENVIADO') {
      return res.status(400).json({
        ok: false,
        error: `Apenas planos APROVADOS ou ENVIADOS podem ser exportados. Status atual: ${plano.status}`,
      });
    }

    if (plano.agente_exportado_em) {
      return res.status(409).json({
        ok: false,
        error: 'Este plano já foi exportado para o EDUCADF.',
        exportado_em: plano.agente_exportado_em,
      });
    }

    // ── 2. Busca itens do plano ──────────────────────────────────────────────
    const [itens] = await db.query(
      `SELECT * FROM itens_avaliacao WHERE plano_id = ?`,
      [planoId]
    );

    const itemBimestral = (itens || []).find(i => i.fixo_direcao);
    if (!itemBimestral) {
      return res.status(422).json({
        ok: false,
        error: 'Este plano não possui item de Avaliação Bimestral (fixo_direcao). Verifique o plano.',
      });
    }

    // ── 3. Busca nome do professor DONO DO PLANO ─────────────────────────────
    // IMPORTANTE: usa o nome do professor que criou o plano (plano.usuario_id),
    // NÃO o nome do usuário logado. Isso permite que o diretor exporte o plano
    // de um professor usando o nome correto no filtro do EDUCADF.
    let professorNome = '';
    try {
      // Tenta buscar pelo dono do plano (usuario_id do plano)
      const [[prof]] = await db.query(
        `SELECT u.nome FROM usuarios u
         JOIN planos_avaliacao p ON p.usuario_id = u.id
         WHERE p.id = ? LIMIT 1`,
        [planoId]
      );
      professorNome = prof?.nome || '';
    } catch {
      // Fallback: usa nome do usuário logado
      try {
        const [[u]] = await db.query('SELECT nome FROM usuarios WHERE id = ? LIMIT 1', [usuarioId]);
        professorNome = u?.nome || '';
      } catch { /* não crítico */ }
    }
    console.log(`[agente-planos] Professor do plano: "${professorNome}"`);

    // ── 4. Busca credenciais EDUCADF ─────────────────────────────────────────
    const cred = await buscarCredenciais(db, escolaId, usuarioId);

    if (!cred) {
      return res.status(422).json({
        ok: false,
        error: 'Você ainda não configurou suas credenciais do EDUCADF.',
        codigo: 'SEM_CREDENCIAIS',
      });
    }

    // ── 5. Descriptografa senha ──────────────────────────────────────────────
    let senhaPlain;
    try {
      senhaPlain = decrypt(cred.educadf_senha_enc, cred.educadf_senha_iv, cred.educadf_senha_tag);
    } catch {
      return res.status(422).json({
        ok: false,
        error: 'Suas credenciais do EDUCADF estão desatualizadas. Salve novamente.',
        codigo: 'CREDENCIAIS_CORROMPIDAS',
      });
    }

    const PERFIL_MAP = { 1: 'professor', 2: 'secretario', 3: 'diretor' };
    const perfil = PERFIL_MAP[cred.perfil_id] || 'professor';

    // ── 6. Monta dados para o Playwright ─────────────────────────────────────
    const dadosPlano = {
      turmas:       plano.turmas,
      disciplina:   plano.disciplina,
      bimestre:     plano.bimestre,
      ano:          plano.ano,
      professorNome,
      item: {
        atividade:      itemBimestral.atividade,
        tipo_avaliacao: itemBimestral.tipo_avaliacao,
        data_inicio:    itemBimestral.data_inicio,
        data:           itemBimestral.data_inicio,
        descricao:      itemBimestral.descricao,
        nota_total:     itemBimestral.nota_total,
      },
    };

    console.log(`[agente-planos] Iniciando exportação PAP id=${planoId} → ${plano.turmas} | ${plano.disciplina} | ${plano.bimestre}`);

    // ── 7. Executa Playwright ─────────────────────────────────────────────────
    let resultado;
    try {
      resultado = await EducaDFBrowser.withSession(
        async (session) => exportarPAPEducaDF(session, { login: cred.educadf_login, senha: senhaPlain, perfil }, dadosPlano),
        { escolaId, professorId: usuarioId, headless: true }
      );
    } catch (err) {
      console.error('[agente-planos] Erro no Playwright:', err.message);
      return res.status(500).json({
        ok: false,
        error: `Erro durante a automação: ${err.message}`,
      });
    }

    // ── 8. Atualiza banco se sucesso ──────────────────────────────────────────
    if (resultado.ok) {
      await db.query(
        `UPDATE planos_avaliacao SET agente_exportado_em = NOW() WHERE id = ?`,
        [planoId]
      ).catch(err => console.warn('[agente-planos] Erro ao marcar exportado_em:', err.message));

      console.log(`[agente-planos] ✅ PAP id=${planoId} exportado com sucesso!`);
    } else {
      console.warn(`[agente-planos] ❌ PAP id=${planoId} falhou: ${resultado.message}`);
    }

    // ── 9. Auditoria ──────────────────────────────────────────────────────────
    try {
      await db.query(
        `INSERT INTO agente_audit_log (execucao_id, acao, detalhe, screenshot_path, duracao_ms)
         VALUES (0, 'EXPORTAR_PAP', ?, ?, ?)`,
        [
          JSON.stringify({ plano_id: planoId, turmas: plano.turmas, ok: resultado.ok }),
          resultado.screenshotPath || null,
          resultado.durationMs || 0,
        ]
      );
    } catch { /* auditoria não é crítica */ }

    return res.status(resultado.ok ? 200 : 502).json({
      ok: resultado.ok,
      message: resultado.message,
      error: resultado.ok ? undefined : resultado.message,
      durationMs: resultado.durationMs,
    });

  } catch (err) {
    // Catch-all: qualquer erro inesperado no handler
    console.error(`[agente-planos] ERRO INESPERADO (plano=${planoId}):`, err.message, err.stack);
    return res.status(500).json({
      ok: false,
      error: `Erro interno: ${err.message}`,
    });
  }
});

export default router;
