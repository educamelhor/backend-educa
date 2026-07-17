// routes/plataforma_usage.js
// ============================================================================
// Rotas de Usage Insights para a Plataforma CEO
// Retorna métricas de acesso, distribuição de perfis, horários de pico,
// e dados estatísticos por escola para o painel do CEO.
// ============================================================================
import express from "express";

const router = express.Router();

// ======================================================
// 1) OVERVIEW — Resumo de TODAS as escolas
// GET /api/plataforma/usage/escolas
// Retorna cards com métricas-chave de cada escola
// ======================================================
router.get("/escolas", async (req, res) => {
  const db = req.db;

  try {
    // 1. Lista de escolas com contagens
    const [escolas] = await db.query(`
      SELECT
        e.id,
        e.nome,
        e.apelido,
        e.cidade,
        e.estado,
        e.tipo,
        e.origem,
        e.status,
        (SELECT COUNT(*) FROM usuarios u WHERE u.escola_id = e.id AND u.ativo = 1) AS total_usuarios,
        (SELECT COUNT(*) FROM alunos a WHERE a.escola_id = e.id) AS total_alunos,
        (SELECT COUNT(*) FROM professores p WHERE p.escola_id = e.id) AS total_professores,
        (SELECT COUNT(*) FROM turmas t WHERE t.escola_id = e.id) AS total_turmas,
        (SELECT MAX(al.created_at) FROM access_log al WHERE al.escola_id = e.id) AS ultimo_acesso,
        (SELECT COUNT(*) FROM access_log al WHERE al.escola_id = e.id AND al.created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)) AS acessos_24h,
        (SELECT COUNT(*) FROM access_log al WHERE al.escola_id = e.id AND al.created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)) AS acessos_7d,
        (SELECT COUNT(*) FROM access_log al WHERE al.escola_id = e.id AND al.created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)) AS acessos_30d,
        (SELECT COUNT(DISTINCT al.usuario_id) FROM access_log al WHERE al.escola_id = e.id AND al.created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)) AS usuarios_ativos_30d
      FROM escolas e
      ORDER BY e.id ASC
      LIMIT 200
    `);

    return res.json({ ok: true, escolas: escolas || [] });
  } catch (err) {
    console.error("[USAGE][OVERVIEW] erro:", err);
    return res.status(500).json({ ok: false, message: "Erro ao carregar overview de uso." });
  }
});

// ======================================================
// 2) DETALHES — Dashboard de UMA escola
// GET /api/plataforma/usage/escolas/:id
// Retorna dashboard completo com:
//   - KPIs, distribuição por perfil, acessos por hora,
//   - acessos por dia da semana, últimos acessos, etc.
// ======================================================
router.get("/escolas/:id", async (req, res) => {
  const db = req.db;
  const escolaId = Number(req.params.id);

  if (!escolaId || Number.isNaN(escolaId)) {
    return res.status(400).json({ ok: false, message: "ID inválido." });
  }

  try {
    // ── Dados da escola ──
    const [[escola]] = await db.query(
      "SELECT id, nome, apelido, cidade, estado, tipo, origem, status, created_at FROM escolas WHERE id = ? LIMIT 1",
      [escolaId]
    );
    if (!escola) {
      return res.status(404).json({ ok: false, message: "Escola não encontrada." });
    }

    // ── KPIs ──
    const [[kpi]] = await db.query(`
      SELECT
        (SELECT COUNT(*) FROM usuarios WHERE escola_id = ? AND ativo = 1) AS total_usuarios_ativos,
        (SELECT COUNT(*) FROM usuarios WHERE escola_id = ? AND ativo = 0) AS total_usuarios_inativos,
        (SELECT COUNT(*) FROM alunos WHERE escola_id = ?) AS total_alunos,
        (SELECT COUNT(*) FROM professores WHERE escola_id = ?) AS total_professores,
        (SELECT COUNT(*) FROM turmas WHERE escola_id = ?) AS total_turmas,
        (SELECT COUNT(*) FROM access_log WHERE escola_id = ?) AS total_acessos,
        (SELECT COUNT(*) FROM access_log WHERE escola_id = ? AND created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)) AS acessos_24h,
        (SELECT COUNT(*) FROM access_log WHERE escola_id = ? AND created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)) AS acessos_7d,
        (SELECT COUNT(*) FROM access_log WHERE escola_id = ? AND created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)) AS acessos_30d,
        (SELECT COUNT(DISTINCT usuario_id) FROM access_log WHERE escola_id = ? AND created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)) AS usuarios_ativos_30d,
        (SELECT MAX(created_at) FROM access_log WHERE escola_id = ?) AS ultimo_acesso
    `, [escolaId, escolaId, escolaId, escolaId, escolaId, escolaId, escolaId, escolaId, escolaId, escolaId, escolaId]);

    // ── Distribuição por perfil (usuarios) ──
    const [perfilDistribuicao] = await db.query(`
      SELECT
        perfil,
        COUNT(*) AS quantidade,
        SUM(CASE WHEN ativo = 1 THEN 1 ELSE 0 END) AS ativos
      FROM usuarios
      WHERE escola_id = ?
      GROUP BY perfil
      ORDER BY quantidade DESC
    `, [escolaId]);

    // ── Acessos por hora do dia (últimos 30 dias) ──
    const [acessosPorHora] = await db.query(`
      SELECT
        HOUR(created_at) AS hora,
        COUNT(*) AS quantidade
      FROM access_log
      WHERE escola_id = ?
        AND created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
      GROUP BY HOUR(created_at)
      ORDER BY hora ASC
    `, [escolaId]);

    // ── Acessos por dia da semana (últimos 30 dias) ──
    const [acessosPorDiaSemana] = await db.query(`
      SELECT
        DAYOFWEEK(created_at) AS dia_semana,
        COUNT(*) AS quantidade
      FROM access_log
      WHERE escola_id = ?
        AND created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
      GROUP BY DAYOFWEEK(created_at)
      ORDER BY dia_semana ASC
    `, [escolaId]);

    // ── Acessos diários (últimos 30 dias) — para gráfico de linha ──
    const [acessosDiarios] = await db.query(`
      SELECT
        DATE(created_at) AS data,
        COUNT(*) AS quantidade,
        COUNT(DISTINCT usuario_id) AS usuarios_unicos
      FROM access_log
      WHERE escola_id = ?
        AND created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
      GROUP BY DATE(created_at)
      ORDER BY data ASC
    `, [escolaId]);

    // ── Últimos acessos (recentes) ──
    const [ultimosAcessos] = await db.query(`
      SELECT
        al.id,
        al.usuario_id,
        al.perfil,
        al.ip,
        al.action,
        al.created_at,
        u.nome AS usuario_nome
      FROM access_log al
      LEFT JOIN usuarios u ON u.id = al.usuario_id
      WHERE al.escola_id = ?
      ORDER BY al.created_at DESC
      LIMIT 50
    `, [escolaId]);

    // ── Top usuários (mais acessos nos últimos 30 dias) ──
    const [topUsuarios] = await db.query(`
      SELECT
        al.usuario_id,
        u.nome AS usuario_nome,
        al.perfil,
        COUNT(*) AS total_acessos,
        MAX(al.created_at) AS ultimo_acesso
      FROM access_log al
      LEFT JOIN usuarios u ON u.id = al.usuario_id
      WHERE al.escola_id = ?
        AND al.created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
      GROUP BY al.usuario_id, u.nome, al.perfil
      ORDER BY total_acessos DESC
      LIMIT 20
    `, [escolaId]);

    // ── Acessos por perfil (últimos 30 dias) ──
    const [acessosPorPerfil] = await db.query(`
      SELECT
        COALESCE(al.perfil, 'desconhecido') AS perfil,
        COUNT(*) AS quantidade
      FROM access_log al
      WHERE al.escola_id = ?
        AND al.created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
      GROUP BY al.perfil
      ORDER BY quantidade DESC
    `, [escolaId]);

    return res.json({
      ok: true,
      escola,
      kpi: kpi || {},
      perfilDistribuicao: perfilDistribuicao || [],
      acessosPorHora: acessosPorHora || [],
      acessosPorDiaSemana: acessosPorDiaSemana || [],
      acessosDiarios: acessosDiarios || [],
      ultimosAcessos: ultimosAcessos || [],
      topUsuarios: topUsuarios || [],
      acessosPorPerfil: acessosPorPerfil || [],
    });
  } catch (err) {
    console.error("[USAGE][DETALHE] erro:", err);
    return res.status(500).json({ ok: false, message: "Erro ao carregar uso da escola." });
  }
});

export default router;
