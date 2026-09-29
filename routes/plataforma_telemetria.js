// routes/plataforma_telemetria.js
// ============================================================================
// CEO Dashboard — Telemetria & Analytics do EDUCA MOBILE
// Etapa 2: Endpoints executivos de engajamento mobile de Responsáveis e Estudantes
// ============================================================================
import express from "express";
import pool from "../db.js";

const router = express.Router();

// Helper de mapeamento de cores consistentes por funcionalidade
function getColorForCard(label, modulo) {
  const text = `${label || ""} ${modulo || ""}`.toLowerCase();
  if (text.includes("carteirinha")) return "#a855f7"; // Roxo/Violeta
  if (text.includes("boletim")) return "#38bdf8";    // Ciano/Azul
  if (text.includes("disciplin") || text.includes("registro")) return "#818cf8"; // Índigo
  if (text.includes("frequ") || text.includes("atestado")) return "#34d399";     // Verde
  if (text.includes("horar")) return "#f59e0b";      // Âmbar
  if (text.includes("conteudo") || text.includes("tarefa")) return "#10b981";    // Esmeralda
  if (text.includes("comunic") || text.includes("aviso")) return "#f59e0b";      // Âmbar
  if (text.includes("bibliot") || text.includes("livro")) return "#ec4899";      // Rosa
  if (text.includes("noticia") || text.includes("evento")) return "#38bdf8";     // Azul
  return "#60a5fa";
}

// Helper para descrição amigável de faixa horária de pico
function formatFaixaHorario(hora, perfil) {
  if (hora === null || hora === undefined || hora < 0) {
    return "Aguardando primeiros acessos";
  }
  const h = Number(hora);
  const hFim = (h + 2) % 24;
  let periodo = "Dia";
  if (h >= 6 && h < 12) periodo = "Manhã";
  else if (h >= 12 && h < 14) periodo = "Almoço";
  else if (h >= 14 && h < 18) periodo = "Tarde";
  else if (h >= 18 && h < 24) periodo = "Noite";
  else periodo = "Madrugada";

  return `${String(h).padStart(2, "0")}:00 - ${String(hFim).padStart(2, "0")}:00 (${periodo})`;
}

// Formata último acesso de forma humana no fuso horário de Brasília (America/Sao_Paulo = UTC-3)
function formatUltimoAcesso(dt) {
  if (!dt) return "Sem registros recentes";
  const date = new Date(dt);
  const tz = "America/Sao_Paulo";

  const dateFmt = new Intl.DateTimeFormat("pt-BR", {
    timeZone: tz,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });

  const timeFmt = new Intl.DateTimeFormat("pt-BR", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  const now = new Date();
  const hojeStr = dateFmt.format(now);
  const dataEventoStr = dateFmt.format(date);

  const ontemDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const ontemStr = dateFmt.format(ontemDate);

  const horaStr = timeFmt.format(date);

  if (dataEventoStr === hojeStr) return `Hoje às ${horaStr}`;
  if (dataEventoStr === ontemStr) return `Ontem às ${horaStr}`;

  return `${dataEventoStr.slice(0, 5)} às ${horaStr}`;
}

// Gera array dos últimos 7 dias da semana no fuso horário de Brasília
function buildUltimos7Dias(diasAgrupados = {}) {
  const nomesDias = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
  const resultado = [];
  const tz = "America/Sao_Paulo";

  // Obter ano, mes, dia de hoje em Brasília (evita shift de UTC virar o dia antes das 21h BRT)
  const now = new Date();
  const spDateStr = now.toLocaleDateString("en-CA", { timeZone: tz }); // YYYY-MM-DD
  const [ano, mes, dia] = spDateStr.split("-").map(Number);
  const hojeSp = new Date(ano, mes - 1, dia);

  for (let i = 6; i >= 0; i--) {
    const d = new Date(hojeSp);
    d.setDate(hojeSp.getDate() - i);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    const keyIso = `${y}-${m}-${day}`;
    const diaSemana = nomesDias[d.getDay()];
    resultado.push({
      data: keyIso,
      dia: diaSemana,
      total: Number(diasAgrupados[keyIso] || 0),
    });
  }
  return resultado;
}

// ============================================================================
// 1) GET /api/plataforma/telemetria/overview
// Retorna visão executiva das escolas e KPIs consolidados para o dashboard
// Query Params:
//   - perfil: "RESPONSAVEL" | "ALUNO" | "TODOS" (default: "TODOS")
// ============================================================================
router.get("/overview", async (req, res) => {
  const db = req.db || pool;
  const perfil = String(req.query.perfil || "TODOS").toUpperCase();

  try {
    // 1. Busca todas as escolas ativas da rede
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
        (SELECT COUNT(*) FROM alunos a WHERE a.escola_id = e.id) AS total_alunos,
        (SELECT COUNT(DISTINCT ra.responsavel_id)
         FROM responsaveis_alunos ra
         JOIN alunos a2 ON a2.id = ra.aluno_id
         WHERE a2.escola_id = e.id) AS total_responsaveis
      FROM escolas e
      WHERE e.status != 'cancelada'
      ORDER BY e.nome ASC
    `);

    if (!escolas || escolas.length === 0) {
      return res.json({
        ok: true,
        perfil,
        kpis_globais: {
          total_escolas: 0,
          total_usuarios_base: 0,
          total_usuarios_app: 0,
          acessos_hoje: 0,
          acessos_7d: 0,
          acessos_30d: 0,
          android_pct: 80,
          ios_pct: 20,
        },
        escolas: [],
      });
    }

    const escolaIds = escolas.map((e) => e.id);
    const placeholders = escolaIds.map(() => "?").join(",");

    // Monta cláusula WHERE de perfil para as consultas de telemetria
    const perfilCond = perfil === "TODOS" ? "1=1" : "perfil = ?";
    const perfilParams = perfil === "TODOS" ? [] : [perfil];

    // 2. Consulta consolidada de acessos e usuários por escola na tabela de telemetria
    const [statsPorEscola] = await db.query(
      `
      SELECT
        escola_id,
        COUNT(DISTINCT COALESCE(usuario_id, aluno_id)) AS usuarios_app,
        SUM(CASE WHEN DATE(DATE_SUB(created_at, INTERVAL 3 HOUR)) = DATE(DATE_SUB(NOW(), INTERVAL 3 HOUR)) THEN 1 ELSE 0 END) AS acessos_hoje,
        SUM(CASE WHEN created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY) THEN 1 ELSE 0 END) AS acessos_7d,
        COUNT(*) AS acessos_30d,
        MAX(created_at) AS ultimo_acesso,
        SUM(CASE WHEN LOWER(COALESCE(plataforma, '')) LIKE '%android%' THEN 1 ELSE 0 END) AS android_count,
        SUM(CASE WHEN LOWER(COALESCE(plataforma, '')) LIKE '%ios%' THEN 1 ELSE 0 END) AS ios_count
      FROM app_telemetria_eventos
      WHERE escola_id IN (${placeholders})
        AND ${perfilCond}
        AND created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
      GROUP BY escola_id
      `,
      [...escolaIds, ...perfilParams]
    );

    const statsMap = new Map();
    for (const s of statsPorEscola) {
      statsMap.set(Number(s.escola_id), s);
    }

    // 3. Consulta de histórico de 7 dias por escola (ajustado para fuso BRT -03:00)
    const [historicoRows] = await db.query(
      `
      SELECT
        escola_id,
        DATE(DATE_SUB(created_at, INTERVAL 3 HOUR)) AS dia_iso,
        COUNT(*) AS total
      FROM app_telemetria_eventos
      WHERE escola_id IN (${placeholders})
        AND ${perfilCond}
        AND created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
      GROUP BY escola_id, DATE(DATE_SUB(created_at, INTERVAL 3 HOUR))
      `,
      [...escolaIds, ...perfilParams]
    );

    const historicoMap = new Map();
    for (const h of historicoRows) {
      const eid = Number(h.escola_id);
      if (!historicoMap.has(eid)) historicoMap.set(eid, {});
      const isoStr = h.dia_iso instanceof Date ? h.dia_iso.toISOString().slice(0, 10) : String(h.dia_iso);
      historicoMap.get(eid)[isoStr] = Number(h.total);
    }

    // 4. Consulta de top cards/funcionalidades por escola
    const [cardsRows] = await db.query(
      `
      SELECT
        escola_id,
        COALESCE(card_label, modulo, 'Módulo Mobile') AS label,
        modulo,
        COUNT(*) AS cliques
      FROM app_telemetria_eventos
      WHERE escola_id IN (${placeholders})
        AND ${perfilCond}
        AND created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
      GROUP BY escola_id, label, modulo
      ORDER BY escola_id ASC, cliques DESC
      `,
      [...escolaIds, ...perfilParams]
    );

    const topCardsMap = new Map();
    for (const c of cardsRows) {
      const eid = Number(c.escola_id);
      if (!topCardsMap.has(eid)) topCardsMap.set(eid, []);
      if (topCardsMap.get(eid).length < 4) {
        topCardsMap.get(eid).push({
          label: c.label,
          modulo: c.modulo,
          cliques: Number(c.cliques),
        });
      }
    }

    // 5. Consulta de faixa de pico de horário por escola (ajustado para fuso BRT -03:00)
    const [picoRows] = await db.query(
      `
      SELECT
        escola_id,
        HOUR(DATE_SUB(created_at, INTERVAL 3 HOUR)) AS hora,
        COUNT(*) AS total_hora
      FROM app_telemetria_eventos
      WHERE escola_id IN (${placeholders})
        AND ${perfilCond}
        AND created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
      GROUP BY escola_id, HOUR(DATE_SUB(created_at, INTERVAL 3 HOUR))
      ORDER BY escola_id ASC, total_hora DESC
      `,
      [...escolaIds, ...perfilParams]
    );

    const picoMap = new Map();
    for (const p of picoRows) {
      const eid = Number(p.escola_id);
      if (!picoMap.has(eid)) {
        picoMap.set(eid, p.hora);
      }
    }

    // 6. Montagem estruturada do retorno
    let somaBaseGeral = 0;
    let somaAppGeral = 0;
    let somaHojeGeral = 0;
    let soma7dGeral = 0;
    let soma30dGeral = 0;
    let somaAndroidGeral = 0;
    let somaIosGeral = 0;

    const listaProcessada = escolas.map((esc) => {
      const stat = statsMap.get(Number(esc.id)) || {};
      const baseUsuarios =
        perfil === "RESPONSAVEL"
          ? (Number(esc.total_responsaveis) || Number(esc.total_alunos) || 0)
          : Number(esc.total_alunos || 0);

      const usuariosApp = Number(stat.usuarios_app || 0);
      const acessosHoje = Number(stat.acessos_hoje || 0);
      const acessos7d = Number(stat.acessos_7d || 0);
      const acessos30d = Number(stat.acessos_30d || 0);

      const androidCount = Number(stat.android_count || 0);
      const iosCount = Number(stat.ios_count || 0);
      const totalDispositivos = androidCount + iosCount;

      let androidPct = null;
      let iosPct = null;
      if (totalDispositivos > 0) {
        androidPct = Math.round((androidCount / totalDispositivos) * 100);
        iosPct = 100 - androidPct;
      }

      // Consolidação de acumuladores globais
      somaBaseGeral += baseUsuarios;
      somaAppGeral += usuariosApp;
      somaHojeGeral += acessosHoje;
      soma7dGeral += acessos7d;
      soma30dGeral += acessos30d;
      somaAndroidGeral += androidCount;
      somaIosGeral += iosCount;

      // Cards mais acessados com cálculo percentual
      const cardsBrutos = topCardsMap.get(Number(esc.id)) || [];
      const totalCliquesCards = cardsBrutos.reduce((acc, c) => acc + c.cliques, 0) || 1;

      const topCardsFormatados = cardsBrutos.map((c) => ({
        label: c.label,
        cliques: c.cliques,
        pct: Math.round((c.cliques / totalCliquesCards) * 100),
        color: getColorForCard(c.label, c.modulo),
      }));

      // Histórico dos 7 dias
      const diasDict = historicoMap.get(Number(esc.id)) || {};
      const historico7d = buildUltimos7Dias(diasDict);

      // Pico e último acesso
      const horaPico = picoMap.get(Number(esc.id));
      const picoHorario = formatFaixaHorario(horaPico, perfil);
      const ultimoAcesso = formatUltimoAcesso(stat.ultimo_acesso);

      // Trata tipo da escola para array
      let tipoArray = [];
      try {
        if (Array.isArray(esc.tipo)) {
          tipoArray = esc.tipo;
        } else if (typeof esc.tipo === "string" && esc.tipo.trim()) {
          tipoArray = JSON.parse(esc.tipo);
        }
      } catch {
        tipoArray = esc.tipo ? [String(esc.tipo)] : [];
      }

      return {
        id: esc.id,
        nome: esc.nome,
        apelido: esc.apelido || esc.nome,
        cidade: esc.cidade || "Brasília",
        estado: esc.estado || "DF",
        tipo: tipoArray,
        status: esc.status || "ativa",
        // Métricas de usuários (adaptadas conforme o perfil)
        total_responsaveis: baseUsuarios,
        responsaveis_app: usuariosApp,
        total_alunos: Number(esc.total_alunos || 0),
        alunos_app: usuariosApp,
        // Métricas de acessos
        acessos_hoje: acessosHoje,
        acessos_7d: acessos7d,
        acessos_30d: acessos30d,
        android_pct: androidPct,
        ios_pct: iosPct,
        top_cards: topCardsFormatados,
        historico_7d: historico7d,
        pico_horario: picoHorario,
        ultimo_acesso: ultimoAcesso,
      };
    });

    // Percentuais consolidados de dispositivos
    const totalDispGeral = somaAndroidGeral + somaIosGeral;
    let androidPctGeral = null;
    let iosPctGeral = null;
    if (totalDispGeral > 0) {
      androidPctGeral = Math.round((somaAndroidGeral / totalDispGeral) * 100);
      iosPctGeral = 100 - androidPctGeral;
    }

    return res.json({
      ok: true,
      perfil,
      kpis_globais: {
        total_escolas: escolas.length,
        total_usuarios_base: somaBaseGeral,
        total_usuarios_app: somaAppGeral,
        acessos_hoje: somaHojeGeral,
        acessos_7d: soma7dGeral,
        acessos_30d: soma30dGeral,
        android_pct: androidPctGeral,
        ios_pct: iosPctGeral,
      },
      escolas: listaProcessada,
    });
  } catch (err) {
    console.error("[TELEMETRIA_OVERVIEW] Erro ao carregar métricas executivas:", err);
    return res.status(500).json({
      ok: false,
      message: "Erro interno ao processar telemetria executiva.",
    });
  }
});

// ============================================================================
// 2) GET /api/plataforma/telemetria/escola/:id
// Detalhes aprofundados de telemetria de uma escola específica (com filtros)
// ============================================================================
router.get("/escola/:id", async (req, res) => {
  const db = req.db || pool;
  const escolaId = Number(req.params.id);
  const perfil = String(req.query.perfil || "TODOS").toUpperCase();

  if (!escolaId || Number.isNaN(escolaId)) {
    return res.status(400).json({ ok: false, message: "ID de escola inválido." });
  }

  try {
    // 1. Dados cadastrais da escola
    const [[escola]] = await db.query(
      `SELECT id, nome, apelido, cidade, estado, tipo, origem, status, created_at
       FROM escolas WHERE id = ? LIMIT 1`,
      [escolaId]
    );

    if (!escola) {
      return res.status(404).json({ ok: false, message: "Escola não encontrada." });
    }

    const perfilCond = perfil === "TODOS" ? "1=1" : "perfil = ?";
    const perfilParams = perfil === "TODOS" ? [] : [perfil];

    // 2. Ranking de módulos/cards (Top 10)
    const [topCards] = await db.query(
      `
      SELECT
        COALESCE(card_label, modulo, 'Módulo Mobile') AS label,
        modulo,
        COUNT(*) AS cliques
      FROM app_telemetria_eventos
      WHERE escola_id = ?
        AND ${perfilCond}
        AND created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
      GROUP BY label, modulo
      ORDER BY cliques DESC
      LIMIT 10
      `,
      [escolaId, ...perfilParams]
    );

    const totalCliques = topCards.reduce((acc, c) => acc + Number(c.cliques), 0) || 1;
    const cardsFormatados = topCards.map((c) => ({
      label: c.label,
      modulo: c.modulo,
      cliques: Number(c.cliques),
      pct: Math.round((Number(c.cliques) / totalCliques) * 100),
      color: getColorForCard(c.label, c.modulo),
    }));

    // 3. Distribuição por Série escolar
    const [series] = await db.query(
      `
      SELECT
        COALESCE(serie, 'Não informada') AS serie,
        COUNT(*) AS total_cliques,
        COUNT(DISTINCT COALESCE(usuario_id, aluno_id)) AS usuarios_unicos
      FROM app_telemetria_eventos
      WHERE escola_id = ?
        AND ${perfilCond}
        AND created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
      GROUP BY serie
      ORDER BY total_cliques DESC
      LIMIT 12
      `,
      [escolaId, ...perfilParams]
    );

    // 4. Últimos 25 eventos em tempo real
    const [eventosRecentes] = await db.query(
      `
      SELECT
        id,
        evento,
        perfil,
        modulo,
        card_label,
        tela,
        plataforma,
        serie,
        turma_nome,
        created_at
      FROM app_telemetria_eventos
      WHERE escola_id = ?
        AND ${perfilCond}
      ORDER BY created_at DESC
      LIMIT 25
      `,
      [escolaId, ...perfilParams]
    );

    return res.json({
      ok: true,
      escola,
      ranking_cards: cardsFormatados,
      distribuicao_series: series,
      eventos_recentes: eventosRecentes,
    });
  } catch (err) {
    console.error(`[TELEMETRIA_ESCOLA_${escolaId}] Erro:`, err);
    return res.status(500).json({ ok: false, message: "Erro ao obter detalhes de telemetria da escola." });
  }
});

// ============================================================================
// 3) GET /api/plataforma/telemetria/eventos
// Feed geral de eventos de telemetria em tempo real
// ============================================================================
router.get("/eventos", async (req, res) => {
  const db = req.db || pool;
  const limit = Math.min(Number(req.query.limit || 50), 200);
  const perfil = req.query.perfil ? String(req.query.perfil).toUpperCase() : null;
  const escolaId = req.query.escola_id ? Number(req.query.escola_id) : null;

  try {
    const whereClauses = [];
    const params = [];

    if (perfil && perfil !== "TODOS") {
      whereClauses.push("t.perfil = ?");
      params.push(perfil);
    }
    if (escolaId) {
      whereClauses.push("t.escola_id = ?");
      params.push(escolaId);
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

    const [rows] = await db.query(
      `
      SELECT
        t.id,
        t.escola_id,
        e.apelido AS escola_apelido,
        e.nome AS escola_nome,
        t.perfil,
        t.evento,
        t.modulo,
        t.card_label,
        t.tela,
        t.plataforma,
        t.serie,
        t.turma_nome,
        t.created_at
      FROM app_telemetria_eventos t
      LEFT JOIN escolas e ON e.id = t.escola_id
      ${whereSql}
      ORDER BY t.created_at DESC
      LIMIT ?
      `,
      [...params, limit]
    );

    return res.json({ ok: true, eventos: rows || [] });
  } catch (err) {
    console.error("[TELEMETRIA_EVENTOS] Erro:", err);
    return res.status(500).json({ ok: false, message: "Erro ao listar feed de telemetria." });
  }
});

export default router;
