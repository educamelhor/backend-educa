// api/routes/conteudos_admin.js
import { Router } from "express";
import { autorizarPermissao } from "../middleware/autorizarPermissao.js";

const router = Router();

/**
 * =========================================================
 * EDUCA.MELHOR — MÓDULO CONTEÚDOS (Admin)
 *
 * Este router é montado no server.js em "/api" e já passa por:
 * - autenticarToken
 * - verificarEscola
 *
 * Endpoints mínimos (PASSO 4.3):
 * 1) GET  /conteudos/admin/contexto/opcoes
 * 2) GET  /conteudos/admin/plano/itens
 *
 * Observação:
 * - req.db é injetado no server.js (pool).
 * =========================================================
 */

function assertAuthEscola(req, res) {
  const escolaId = req?.escola_id ?? req?.user?.escola_id;

  if (!escolaId) {
    res.status(403).json({ ok: false, message: "Acesso negado: escola não definida." });
    return false;
  }
  return true;
}

function normSerie(raw) {
  // Mantemos string livre ("8º Ano", "8", etc). Apenas trim.
  return String(raw || "").trim();
}

function normTxt(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

// Mapeamento BNCC (componente_id) por "nome da disciplina" (fallback)
// Ajuste/expansão conforme seu catálogo interno de disciplinas evoluir.

function mapDisciplinaNomeToComponenteId(nomeDisciplina) {
  const n = normTxt(nomeDisciplina);

  if (!n) return null;

  // BNCC componentes (padrão comum):
  // 1 LP, 2 MAT, 3 CIÊNCIAS, 4 GEOG, 5 HIST, 6 ARTE, 7 ED.FÍSICA, 8 INGLÊS
  if (n.includes("matemat")) return 2;
  if (n.includes("portugues") || n.includes("lingua portuguesa")) return 1;
  if (n.includes("ciencia")) return 3;
  if (n.includes("geograf")) return 4;
  if (n.includes("histor")) return 5;
  if (n.includes("arte")) return 6;
  if (n.includes("educacao fisica") || n.includes("ed fisica") || n.includes("educacao fis")) return 7;
  if (n.includes("ingles") || n.includes("lingua inglesa")) return 8;

  return null;
}

async function isDisciplinaGeometria(db, disciplina_id) {
  try {
    const [rows] = await db.query(
      `
      SELECT nome
      FROM disciplinas
      WHERE id = ?
      LIMIT 1
      `,
      [Number(disciplina_id)]
    );

    const nome = rows?.[0]?.nome;
    const n = normTxt(nome);
    return !!n && n.includes("geometria");
  } catch (e) {
    return false;
  }
}

async function resolveBnccComponenteId(db, disciplina_id) {

  // 1) Aceita direto SOMENTE se for um componente BNCC válido conhecido (1..10)
  // Evita confundir disciplina_id interno (ex.: 21 = Matemática) com componente BNCC
  if (
    Number.isFinite(Number(disciplina_id)) &&
    Number(disciplina_id) > 0 &&
    Number(disciplina_id) <= 10
  ) {
    return Number(disciplina_id);
  }

  // 2) Tenta buscar nome na tabela disciplinas (se existir) e mapear para componente_id.
  try {
    const [rows] = await db.query(
      `
      SELECT nome
      FROM disciplinas
      WHERE id = ?
      LIMIT 1
      `,
      [Number(disciplina_id)]
    );

    const nome = rows?.[0]?.nome;
    const mapped = mapDisciplinaNomeToComponenteId(nome);
    if (Number.isFinite(Number(mapped))) return Number(mapped);
  } catch (e) {
    // silencioso: nem toda base tem a tabela/coluna exatamente assim
  }

  // 3) Fallback: null (para não filtrar errado)
  return null;
}


/**
 * POST /api/conteudos/admin/solicitacoes/edicao
 *
 * Professor registra solicitação de edição (governança premium).
 * - NÃO libera edição
 * - Apenas cria registro na fila (conteudos_solicitacoes_edicao)
 *
 * Body obrigatório:
 * - escopo: 'CONTEXTO' | 'ITEM_EDIT' | 'ITEM_DELETE'
 * - disciplina_id
 * - serie
 * - bimestre
 * - ano_letivo
 *
 * Body condicional:
 * - item_id (obrigatório se escopo != 'CONTEXTO')
 * - motivo (opcional)
 *
 * Anti-duplicação:
 * - Não permite 2 solicitações PENDENTE iguais
 */
router.post(
  "/conteudos/admin/solicitacoes/edicao",
  autorizarPermissao("conteudos.enviar"),
  async (req, res) => {
  try {
    if (!assertAuthEscola(req, res)) return;

    const escola_id = Number(req.user.escola_id);
    const solicitado_por_usuario_id = Number(req.user.usuarioId ?? req.user.id);

    const {
      escopo,
      disciplina_id,
      serie,
      bimestre,
      ano_letivo,
      item_id,
      motivo,
    } = req.body ?? {};

    if (
      !escopo ||
      !disciplina_id ||
      !serie ||
      !bimestre ||
      !ano_letivo
    ) {
      return res.status(400).json({
        ok: false,
        message: "Campos obrigatórios não informados.",
      });
    }

    if (escopo !== "CONTEXTO" && !item_id) {
      return res.status(400).json({
        ok: false,
        message: "item_id é obrigatório para solicitações por item.",
      });
    }

    const db = req.db;

    // 🔒 Anti-duplicação: já existe solicitação PENDENTE igual?
    const [existente] = await db.query(
      `
      SELECT id
      FROM conteudos_solicitacoes_edicao
      WHERE escola_id = ?
        AND disciplina_id = ?
        AND serie = ?
        AND bimestre = ?
        AND ano_letivo = ?
        AND escopo = ?
        AND (
          (? IS NULL AND item_id IS NULL)
          OR item_id = ?
        )
        AND status = 'PENDENTE'
      LIMIT 1
      `,
      [
        escola_id,
        Number(disciplina_id),
        normSerie(serie),
        Number(bimestre),
        Number(ano_letivo),
        escopo,
        item_id ?? null,
        item_id ?? null,
      ]
    );

    if (existente?.length) {
      return res.json({
        ok: true,
        ja_existente: true,
        message: "Solicitação já registrada e aguardando análise da direção.",
      });
    }

    // ➕ Criar solicitação
    const [ins] = await db.query(
      `
      INSERT INTO conteudos_solicitacoes_edicao (
        escola_id,
        disciplina_id,
        serie,
        bimestre,
        ano_letivo,
        escopo,
        item_id,
        motivo,
        solicitado_por_usuario_id,
        status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDENTE')
      `,
      [
        escola_id,
        Number(disciplina_id),
        normSerie(serie),
        Number(bimestre),
        Number(ano_letivo),
        escopo,
        item_id ?? null,
        motivo ?? null,
        solicitado_por_usuario_id,
      ]
    );

    return res.status(201).json({
      ok: true,
      id: ins?.insertId,
      status: "PENDENTE",
    });
  } catch (err) {
    console.error("Erro POST /conteudos/admin/solicitacoes/edicao:", err);
    return res.status(500).json({
      ok: false,
      message: "Erro ao registrar solicitação de edição.",
    });
  }
});


/**
 * POST /api/conteudos/admin/planejamento
 *
 * SALVAR do modal Conteúdos:
 * - BNCC e SEEDF são catálogos globais (somente leitura)
 * - Isolamento acontece aqui (conteudos_objetivos_escola)
 */
router.post(
  "/conteudos/admin/planejamento",
  autorizarPermissao("conteudos.criar"),
  async (req, res) => {
  try {
    if (!assertAuthEscola(req, res)) return;

    const escola_id = Number(req.escola_id ?? req.user.escola_id);
    const professor_id = Number(req.user.usuarioId ?? req.user.id);
    const created_by = professor_id;

    if (!Number.isFinite(professor_id) || professor_id <= 0) {
      return res.status(403).json({
        ok: false,
        message: "Acesso negado: professor_id inválido no token (esperado usuarioId).",
      });
    }

    const body = req.body ?? {};

    const {
      disciplina_id,
      serie,
      bimestre,
      ano_letivo,
      bncc_unidade_tematica_id,
      seedf_conteudo_id,
      texto,
    } = body;

    if (!req.body) {
      return res.status(400).json({
        ok: false,
        message: "Body ausente. Envie JSON (Content-Type: application/json).",
      });
    }

    if (!disciplina_id || !serie || !bimestre || !ano_letivo) {
      return res.status(400).json({
        ok: false,
        message: "Campos obrigatórios: disciplina_id, serie, bimestre, ano_letivo.",
      });
    }

    const db = req.db;

    const [result] = await db.query(
      `
      INSERT INTO conteudos_objetivos_escola
      (
        escola_id,
        professor_id,
        created_by,
        disciplina_id,
        serie,
        bimestre,
        ano_letivo,
        bncc_unidade_tematica_id,
        seedf_conteudo_id,
        texto,
        ativo,
        status,
        edicao_liberada
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 0)
      ON DUPLICATE KEY UPDATE
        texto = VALUES(texto),
        ativo = 1,
        status = 1,
        edicao_liberada = 0,
        updated_at = CURRENT_TIMESTAMP
      `,
      [
        escola_id,
        professor_id,
        created_by,
        disciplina_id,
        normSerie(serie),
        Number(bimestre),
        Number(ano_letivo),
        Number(bncc_unidade_tematica_id),
        Number(seedf_conteudo_id),
        texto ?? null,
      ]
    );

    return res.json({
      ok: true,
      id: result.insertId || null,
    });
  } catch (err) {
    console.error("Erro POST /conteudos/admin/planejamento:", err);
    return res.status(500).json({
      ok: false,
      message: "Erro ao salvar planejamento.",
    });
  }
});


// ═══════════════════════════════════════════════════════════════
// ENDPOINTS DE CASCATA BNCC — Novo Conteúdo Programático
// ═══════════════════════════════════════════════════════════════

/**
 * GET /api/conteudos/admin/bncc/disciplinas
 * Disciplinas com mapeamento BNCC ativo (para dropdown do BÁSICO)
 */
router.get(
  "/conteudos/admin/bncc/disciplinas",
  autorizarPermissao("conteudos.visualizar"),
  async (req, res) => {
    try {
      const db = req.db;
      const [rows] = await db.query(
        `SELECT d.id, d.nome, bc.id AS componente_id
         FROM bncc_componentes bc
         JOIN disciplinas d ON bc.disciplina_id = d.id
         WHERE bc.ativo = 1
         ORDER BY d.nome ASC`
      );
      return res.json({ ok: true, disciplinas: rows || [] });
    } catch (err) {
      console.error("Erro GET /bncc/disciplinas:", err);
      return res.status(500).json({ ok: false, message: "Erro ao carregar disciplinas BNCC." });
    }
  }
);

/**
 * GET /api/conteudos/admin/bncc/unidades?disciplina_id=X&ano_id=Y
 * Unidades Temáticas BNCC para a disciplina+ano (1ª cascata)
 */
router.get(
  "/conteudos/admin/bncc/unidades",
  autorizarPermissao("conteudos.visualizar"),
  async (req, res) => {
    try {
      const disciplina_id = Number(req.query.disciplina_id);
      const ano_id = Number(req.query.ano_id);
      if (!disciplina_id || !ano_id) {
        return res.status(400).json({ ok: false, message: "disciplina_id e ano_id são obrigatórios." });
      }
      const db = req.db;
      // Resolve componente_id via bncc_componentes (join direto, sem text-matching)
      const [comp] = await db.query(
        "SELECT id FROM bncc_componentes WHERE disciplina_id = ? AND ativo = 1 LIMIT 1",
        [disciplina_id]
      );
      const componente_id = comp?.[0]?.id;
      if (!componente_id) return res.json({ ok: true, unidades: [] });

      const [rows] = await db.query(
        `SELECT id, nome AS texto FROM bncc_unidades_tematicas
         WHERE componente_id = ? AND ano_id = ?
         ORDER BY nome ASC LIMIT 500`,
        [componente_id, ano_id]
      );
      return res.json({ ok: true, unidades: rows || [] });
    } catch (err) {
      console.error("Erro GET /bncc/unidades:", err);
      return res.status(500).json({ ok: false, message: "Erro ao carregar unidades temáticas." });
    }
  }
);

/**
 * GET /api/conteudos/admin/bncc/objetos?unidade_tematica_id=X
 * Objetos de Conhecimento para a Unidade Temática selecionada (2ª cascata)
 */
router.get(
  "/conteudos/admin/bncc/objetos",
  autorizarPermissao("conteudos.visualizar"),
  async (req, res) => {
    try {
      const unidade_tematica_id = Number(req.query.unidade_tematica_id);
      if (!unidade_tematica_id) {
        return res.status(400).json({ ok: false, message: "unidade_tematica_id é obrigatório." });
      }
      const db = req.db;
      const [rows] = await db.query(
        `SELECT id, nome AS texto FROM bncc_objetos_conhecimento
         WHERE unidade_tematica_id = ?
         ORDER BY nome ASC LIMIT 500`,
        [unidade_tematica_id]
      );
      return res.json({ ok: true, objetos: rows || [] });
    } catch (err) {
      console.error("Erro GET /bncc/objetos:", err);
      return res.status(500).json({ ok: false, message: "Erro ao carregar objetos de conhecimento." });
    }
  }
);

/**
 * GET /api/conteudos/admin/seedf/conteudos?disciplina_id=X&serie=Y[&unidade_tematica_id=Z]
 * Conteúdos SEE-DF filtrados pela disciplina, série e (opcionalmente) unidade temática
 */
router.get(
  "/conteudos/admin/seedf/conteudos",
  autorizarPermissao("conteudos.visualizar"),
  async (req, res) => {
    try {
      const disciplina_id = Number(req.query.disciplina_id);
      const serie = normSerie(req.query.serie || ""); // ex: "6º ANO"
      const unidade_tematica_id = req.query.unidade_tematica_id
        ? Number(req.query.unidade_tematica_id)
        : null;
      if (!disciplina_id || !serie) {
        return res.status(400).json({ ok: false, message: "disciplina_id e serie são obrigatórios." });
      }
      const db = req.db;
      const params = [disciplina_id, serie];
      let whereExtra = "";
      if (unidade_tematica_id) {
        whereExtra = " AND bncc_unidade_tematica_id = ?";
        params.push(unidade_tematica_id);
      }
      const [rows] = await db.query(
        `SELECT id, texto FROM seedf_conteudos
         WHERE disciplina_id = ? AND serie = ? AND ativo = 1 ${whereExtra}
         ORDER BY texto ASC LIMIT 800`,
        params
      );
      return res.json({ ok: true, conteudos: rows || [] });
    } catch (err) {
      console.error("Erro GET /seedf/conteudos:", err);
      return res.status(500).json({ ok: false, message: "Erro ao carregar conteúdos SEE-DF." });
    }
  }
);


/**
 * GET /api/conteudos/admin/contexto/opcoes
 *
 * Query:
 * - disciplina_id (obrigatório)
 * - serie        (obrigatório)  -> vem da turma (frontend manda)
 * - bncc_unidade_tematica_id (opcional) -> filtrar SEEDF/OBJETIVOS
 * - seedf_conteudo_id        (opcional) -> filtrar OBJETIVOS
 *
 * Retorna:
 * {
 *   temas:     [{id, texto}],
 *   conteudos: [{id, texto}],
 *   objetivos: [{id, texto}]
 * }
 */
router.get(
  "/conteudos/admin/contexto/opcoes",
  autorizarPermissao("conteudos.visualizar"),
  async (req, res) => {
  try {
    if (!assertAuthEscola(req, res)) return;

    const escola_id = Number(req.user.escola_id);
    const disciplina_id = Number(req.query.disciplina_id);

    // ✅ Novo contrato: serie (string) é o parâmetro oficial do contexto curricular.
    // Compatibilidade: se vier ano_id (legado), derivamos serie como "7º ANO".
    const ano_id = req.query.ano_id ? Number(req.query.ano_id) : null;
    let serie = req.query.serie ? normSerie(req.query.serie) : "";

    if (!serie && Number.isFinite(ano_id)) {
      serie = `${ano_id}º ANO`;
    }

    // BNCC exige ano_id (numérico). Se não veio, derivamos do início da série (ex.: "7º ANO" -> 7).
    const ano_bncc = Number.isFinite(ano_id)
      ? Number(ano_id)
      : (() => {
          const m = String(serie || "").trim().match(/^(\d+)/);
          const n = m ? Number(m[1]) : null;
          return Number.isFinite(n) ? n : null;
        })();

    const bncc_unidade_tematica_id = req.query.bncc_unidade_tematica_id
      ? Number(req.query.bncc_unidade_tematica_id)
      : null;

    const seedf_conteudo_id = req.query.seedf_conteudo_id
      ? Number(req.query.seedf_conteudo_id)
      : null;

    if (!disciplina_id || !serie || !Number.isFinite(ano_bncc)) {
      return res.status(400).json({
        ok: false,
        message: "disciplina_id e serie são obrigatórios (e a serie deve permitir derivar ano_id para BNCC).",
      });
    }

    const db = req.db;

    // 1) TEMAS — modo híbrido
    // - Se disciplina interna for "Geometria": usa tabela interna geometria_tema (por escola/ano)
    // - Caso contrário: usa BNCC oficial (bncc_unidades_tematicas)
    const isGeo = await isDisciplinaGeometria(db, disciplina_id);

    let temas = [];

    if (isGeo) {
      const [rowsTemasGeo] = await db.query(
        `
        SELECT
          id,
          nome AS texto
        FROM geometria_tema
        WHERE escola_id = ?
          AND ano_id = ?
          AND ativo = 1
        ORDER BY nome ASC
        LIMIT 500
        `,
        [escola_id, ano_bncc]
      );

      temas = rowsTemasGeo || [];
    } else {
      // ✅ disciplina_id (interno) ≠ componente_id (BNCC)
      // Precisamos mapear antes de consultar bncc_unidades_tematicas.
      const componente_id =
        req.query.componente_id != null && Number.isFinite(Number(req.query.componente_id))
          ? Number(req.query.componente_id)
          : await resolveBnccComponenteId(db, disciplina_id);

      const [rowsTemasBncc] = await db.query(
        `
        SELECT
          id,
          nome AS texto
        FROM bncc_unidades_tematicas
        WHERE componente_id = ?
          AND ano_id = ?
        ORDER BY nome ASC
        LIMIT 500
        `,
        [componente_id ?? -1, ano_bncc]
      );

      temas = rowsTemasBncc || [];
    }

    // 2) CONTEÚDOS (SEEDF) — somente leitura para professor
    const paramsConteudos = [disciplina_id, String(serie)];
    let whereBncc = "";
    if (bncc_unidade_tematica_id) {
      whereBncc = " AND (bncc_unidade_tematica_id = ?) ";
      paramsConteudos.push(bncc_unidade_tematica_id);
    }

    const [rowsConteudos] = await db.query(
      `
      SELECT
        id,
        texto
      FROM seedf_conteudos
      WHERE disciplina_id = ?
        AND serie = ?
        AND ativo = 1
        ${whereBncc}
      ORDER BY texto ASC
      LIMIT 800
      `,
      paramsConteudos
    );

    // 3) OBJETIVOS (ESCOLA) — catálogo reutilizável
    // Regras:
    // - escola_id obrigatório
    // - filtra por disciplina/serie
    // - se houver bncc/seedf selecionados, estreita
    const paramsObj = [escola_id, disciplina_id, String(serie)];
    let whereObj = "";

    if (bncc_unidade_tematica_id) {
      whereObj += " AND (bncc_unidade_tematica_id = ? OR bncc_unidade_tematica_id IS NULL) ";
      paramsObj.push(bncc_unidade_tematica_id);
    }

    if (seedf_conteudo_id) {
      whereObj += " AND (seedf_conteudo_id = ? OR seedf_conteudo_id IS NULL) ";
      paramsObj.push(seedf_conteudo_id);
    }

    const [rowsObjetivos] = await db.query(
      `
      SELECT
        id,
        texto
      FROM conteudos_objetivos_escola
      WHERE escola_id = ?
        AND disciplina_id = ?
        AND serie = ?
        AND ativo = 1
        ${whereObj}
      ORDER BY texto ASC
      LIMIT 800
      `,
      paramsObj
    );

    return res.json({
      ok: true,
      temas: temas.map((t) => ({ id: t.id, texto: t.texto })),
      conteudos: (rowsConteudos || []).map((c) => ({ id: c.id, texto: c.texto })),
      objetivos: (rowsObjetivos || []).map((o) => ({ id: o.id, texto: o.texto })),
    });
  } catch (err) {
    console.error("Erro /conteudos/admin/contexto/opcoes:", err);
    return res.status(500).json({ ok: false, message: "Erro ao carregar opções do contexto." });
  }
});


/**
 * GET /api/conteudos/admin/solicitacoes/edicao
 *
 * Retorna as solicitações de edição PENDENTES do contexto (e itens) para:
 * disciplina_id + serie + bimestre + ano_letivo, sempre filtrado por escola_id do token.
 *
 * Query (obrigatório):
 * - disciplina_id
 * - serie
 * - bimestre
 * - ano_letivo
 *
 * Retorna:
 * {
 *   ok: true,
 *   contexto_pendente: boolean,
 *   itens_pendentes: [{ id, escopo, item_id, status, created_at }],
 *   solicitacoes: [{ id, escopo, item_id, status, motivo, created_at }]
 * }
 */
router.get(
  "/conteudos/admin/solicitacoes/edicao",
  autorizarPermissao("conteudos.visualizar"),
  async (req, res) => {
  try {
    if (!assertAuthEscola(req, res)) return;

    const escola_id = Number(req.user.escola_id);

    const disciplina_id = Number(req.query?.disciplina_id);
    const serie = req.query?.serie ? normSerie(req.query.serie) : "";
    const bimestre = Number(req.query?.bimestre);
    const ano_letivo = Number(req.query?.ano_letivo);

    if (!disciplina_id || !serie || !bimestre || !ano_letivo) {
      return res.status(400).json({
        ok: false,
        message: "Parâmetros obrigatórios: disciplina_id, serie, bimestre, ano_letivo.",
      });
    }

    const db = req.db;

    const [rows] = await db.query(
      `
      SELECT
        id,
        escopo,
        item_id,
        status,
        motivo,
        created_at
      FROM conteudos_solicitacoes_edicao
      WHERE escola_id = ?
        AND disciplina_id = ?
        AND serie = ?
        AND bimestre = ?
        AND ano_letivo = ?
        AND status = 'PENDENTE'
      ORDER BY created_at DESC
      LIMIT 300
      `,
      [escola_id, disciplina_id, serie, bimestre, ano_letivo]
    );

    const solicitacoes = (rows || []).map((r) => ({
      id: Number(r.id),
      escopo: String(r.escopo || ""),
      item_id: r.item_id === null || r.item_id === undefined ? null : Number(r.item_id),
      status: String(r.status || ""),
      motivo: r.motivo ?? null,
      created_at: r.created_at ?? null,
    }));

    const contexto_pendente = solicitacoes.some((s) => s.escopo === "CONTEXTO");

    const itens_pendentes = solicitacoes
      .filter((s) => s.escopo !== "CONTEXTO" && Number.isFinite(Number(s.item_id)))
      .map((s) => ({
        id: s.id,
        escopo: s.escopo,
        item_id: Number(s.item_id),
        status: s.status,
        created_at: s.created_at,
      }));

    return res.json({
      ok: true,
      contexto_pendente,
      itens_pendentes,
      solicitacoes,
    });
  } catch (err) {
    console.error("Erro GET /conteudos/admin/solicitacoes/edicao:", err);
    return res
      .status(500)
      .json({ ok: false, message: "Erro ao carregar solicitações de edição." });
  }
});



/**
 * DELETE /api/conteudos/admin/planejamento/itens/:id
 *
 * Remove (soft delete) um item do planejamento salvo (conteudos_objetivos_escola)
 * - Marca ativo = 0
 * - Garante que pertence à escola do token
 */
router.delete(
  "/conteudos/admin/planejamento/itens/:id",
  autorizarPermissao("conteudos.editar"),
  async (req, res) => {
  try {
    if (!assertAuthEscola(req, res)) return;

    const escola_id = Number(req.user.escola_id);
    const id = Number(req.params.id);

    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ ok: false, message: "ID inválido." });
    }

    const db = req.db;

    const [r] = await db.query(
      `
      UPDATE conteudos_objetivos_escola
      SET ativo = 0,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
        AND escola_id = ?
      LIMIT 1
      `,
      [id, escola_id]
    );

    if (!r?.affectedRows) {
      return res.status(404).json({
        ok: false,
        message: "Item não encontrado (ou não pertence a esta escola).",
      });
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error("Erro DELETE /conteudos/admin/planejamento/itens/:id:", err);
    return res.status(500).json({ ok: false, message: "Erro ao excluir item do planejamento." });
  }
});


/**
 * PATCH /api/conteudos/admin/direcao/planejamento/itens/:id/edicao
 *
 * Direção/Coordenação libera (ou revoga) edição de UMA linha do planejamento (conteudos_objetivos_escola).
 * Body:
 * - edicao_liberada: 0 | 1
 *
 * Observação:
 * - Por enquanto, não fazemos checagem de perfil/role aqui (depende do seu modelo de auth).
 *   Se você já tiver "req.user.perfil", podemos travar isso em seguida.
 */
router.patch(
  "/conteudos/admin/direcao/planejamento/itens/:id/edicao",
  autorizarPermissao("conteudos.aprovar"),
  async (req, res) => {
  try {
    if (!assertAuthEscola(req, res)) return;

    const escola_id = Number(req.user.escola_id);
    const id = Number(req.params.id);

    const edicao_liberada = Number(req.body?.edicao_liberada) === 1 ? 1 : 0;

    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ ok: false, message: "ID inválido." });
    }

    const db = req.db;

    const [r] = await db.query(
      `
      UPDATE conteudos_objetivos_escola
      SET edicao_liberada = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
        AND escola_id = ?
        AND ativo = 1
      LIMIT 1
      `,
      [edicao_liberada, id, escola_id]
    );

    if (!r?.affectedRows) {
      return res.status(404).json({
        ok: false,
        message: "Item não encontrado (ou não pertence a esta escola).",
      });
    }

    return res.json({ ok: true, id, edicao_liberada });
  } catch (err) {
    console.error("Erro PATCH /conteudos/admin/direcao/planejamento/itens/:id/edicao:", err);
    return res.status(500).json({ ok: false, message: "Erro ao atualizar liberação de edição do item." });
  }
});


/**
 * GET /api/conteudos/admin/planejamento/itens
 *
 * Lista o planejamento salvo via POST /planejamento/lote
 * Fonte: conteudos_objetivos_escola
 *
 * Query (obrigatório):
 * - disciplina_id
 * - serie
 * - ano_letivo
 * - bimestre
 *
 * Retorna:
 * { ok:true, itens:[...] }
 *
 * Observação:
 * - Mantém nomes compatíveis com o frontend (tema_texto_snapshot, conteudo_texto_snapshot, objetivo_texto)
 */
/**
 * PATCH /api/conteudos/admin/direcao/planejamento/contexto/edicao
 *
 * Direção/Coordenação libera (ou revoga) edição de TODAS as linhas do contexto (set em massa).
 *
 * Body obrigatório:
 * - disciplina_id
 * - serie
 * - bimestre
 * - ano_letivo
 * - edicao_liberada: 0 | 1
 *
 * Observação:
 * - Por enquanto, sem checagem de perfil/role (depende do seu auth).
 */
router.patch(
  "/conteudos/admin/direcao/planejamento/contexto/edicao",
  autorizarPermissao("conteudos.aprovar"),
  async (req, res) => {
  try {
    if (!assertAuthEscola(req, res)) return;

    const escola_id = Number(req.user.escola_id);

    const disciplina_id = Number(req.body?.disciplina_id);
    const serie = req.body?.serie ? normSerie(req.body.serie) : "";
    const bimestre = Number(req.body?.bimestre);
    const ano_letivo = Number(req.body?.ano_letivo);

    const edicao_liberada = Number(req.body?.edicao_liberada) === 1 ? 1 : 0;

    if (!disciplina_id || !serie || !bimestre || !ano_letivo) {
      return res.status(400).json({
        ok: false,
        message: "disciplina_id, serie, bimestre e ano_letivo são obrigatórios.",
      });
    }

    const db = req.db;

    const [r] = await db.query(
      `
      UPDATE conteudos_objetivos_escola
      SET edicao_liberada = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE escola_id = ?
        AND disciplina_id = ?
        AND serie = ?
        AND bimestre = ?
        AND ano_letivo = ?
        AND ativo = 1
      `,
      [edicao_liberada, escola_id, disciplina_id, serie, bimestre, ano_letivo]
    );

    return res.json({
      ok: true,
      edicao_liberada,
      afetados: r?.affectedRows ?? 0,
      contexto: { escola_id, disciplina_id, serie, bimestre, ano_letivo },
    });
  } catch (err) {
    console.error("Erro PATCH /conteudos/admin/direcao/planejamento/contexto/edicao:", err);
    return res.status(500).json({ ok: false, message: "Erro ao atualizar liberação de edição do contexto." });
  }
});

router.get(
  "/conteudos/admin/planejamento/itens",
  autorizarPermissao("conteudos.visualizar"),
  async (req, res) => {
  try {
    if (!assertAuthEscola(req, res)) return;

    const escola_id = Number(req.user.escola_id);

    const disciplina_id = Number(req.query.disciplina_id);
    const ano_letivo = Number(req.query.ano_letivo);
    const bimestre = Number(req.query.bimestre);
    const serie = req.query.serie ? normSerie(req.query.serie) : "";

    if (!disciplina_id || !ano_letivo || !bimestre || !serie) {
      return res.status(400).json({
        ok: false,
        message: "disciplina_id, serie, ano_letivo e bimestre são obrigatórios.",
      });
    }

    const db = req.db;

    const [rows] = await db.query(
      `
      SELECT
        coe.id,
        NULL AS turma_id,
        coe.disciplina_id,
        coe.serie,
        coe.ano_letivo,
        coe.bimestre,
        coe.bncc_unidade_tematica_id,
        bt.nome AS tema_texto_snapshot,
        coe.seedf_conteudo_id,
        sc.texto AS conteudo_texto_snapshot,
        coe.texto AS objetivo_texto,
                    coe.status,
                    coe.edicao_liberada,
                    coe.created_at
      FROM conteudos_objetivos_escola coe
      LEFT JOIN bncc_unidades_tematicas bt
        ON bt.id = coe.bncc_unidade_tematica_id
      LEFT JOIN seedf_conteudos sc
        ON sc.id = coe.seedf_conteudo_id
      WHERE coe.escola_id = ?
        AND coe.disciplina_id = ?
        AND coe.serie = ?
        AND coe.ano_letivo = ?
        AND coe.bimestre = ?
        AND coe.ativo = 1
      ORDER BY coe.id DESC
      LIMIT 500
      `,
      [escola_id, disciplina_id, serie, ano_letivo, bimestre]
    );

    return res.json({ ok: true, itens: rows || [] });
  } catch (err) {
    console.error("Erro /conteudos/admin/planejamento/itens:", err);
    return res.status(500).json({ ok: false, message: "Erro ao carregar itens do planejamento." });
  }
});







/**
 * GET /api/conteudos/admin/plano/itens
 *
 * Query (obrigatório):
 * - turma_id
 * - disciplina_id
 * - ano_letivo
 * - bimestre
 *
 * Retorna:
 * { ok:true, itens:[...] }
 */
router.get(
  "/conteudos/admin/plano/itens",
  autorizarPermissao("conteudos.visualizar"),
  async (req, res) => {
  try {
    if (!assertAuthEscola(req, res)) return;

    const escola_id = Number(req.user.escola_id);

    // ✅ Novo contrato: plano é por SÉRIE (não por turma)
    // Compatibilidade: se vier turma_id (legado), derivamos a série como antes.
    const turma_id = req.query.turma_id ? Number(req.query.turma_id) : null;
    const disciplina_id = Number(req.query.disciplina_id);
    const ano_letivo = Number(req.query.ano_letivo);
    const bimestre = Number(req.query.bimestre);
    const serieParam = req.query.serie ? normSerie(req.query.serie) : "";

    if (!disciplina_id || !ano_letivo || !bimestre) {
      return res.status(400).json({
        ok: false,
        message: "disciplina_id, ano_letivo e bimestre são obrigatórios.",
      });
    }

    const db = req.db;

    let serie = serieParam;

    // Compatibilidade: deriva série a partir da turma_id (se necessário)
    if (!serie && turma_id) {
      const [rowsTurma] = await db.query(
        `
        SELECT serie
        FROM turmas
        WHERE id = ?
          AND escola_id = ?
        LIMIT 1
        `,
        [turma_id, escola_id]
      );

      serie = String(rowsTurma?.[0]?.serie || "").trim();
    }

    if (!serie) {
      return res.status(400).json({
        ok: false,
        message: "serie é obrigatória (ou informe turma_id para derivação).",
      });
    }

    const [rows] = await db.query(
      `
      SELECT
        id,
        turma_id, -- turma de referência (para manter compatibilidade de schema)
        disciplina_id,
        serie,
        ano_letivo,
        bimestre,
        bncc_unidade_tematica_id,
        tema_texto_snapshot,
        seedf_conteudo_id,
        conteudo_texto_snapshot,
        objetivo_texto,
        status,
        created_at
      FROM conteudos_plano_itens
      WHERE escola_id = ?
        AND serie = ?
        AND disciplina_id = ?
        AND ano_letivo = ?
        AND bimestre = ?
      ORDER BY id DESC
      LIMIT 500
      `,
      [escola_id, serie, disciplina_id, ano_letivo, bimestre]
    );

    return res.json({ ok: true, itens: rows || [] });
  } catch (err) {
    console.error("Erro /conteudos/admin/plano/itens:", err);
    return res.status(500).json({ ok: false, message: "Erro ao carregar itens do plano." });
  }
});

/**
 * POST /api/conteudos/admin/plano/itens
 *
 * Body (obrigatório):
 * - turma_id
 * - disciplina_id
 * - ano_letivo
 * - bimestre
 * - tema_texto_snapshot
 * - conteudo_texto_snapshot
 *
 * Body (opcional):
 * - bncc_unidade_tematica_id
 * - seedf_conteudo_id
 * - objetivo_texto (aceita null)
 * - serie (fallback, caso não seja possível derivar pela turma)
 */
router.post(
  "/conteudos/admin/plano/itens",
  autorizarPermissao("conteudos.criar"),
  async (req, res) => {
  try {
    if (!assertAuthEscola(req, res)) return;

    const escola_id = Number(req.user.escola_id);

    // ✅ Novo contrato: plano por SÉRIE
    // Compatibilidade: aceita turma_id (legado) para derivar série.
    const turma_id_body = req.body?.turma_id ? Number(req.body.turma_id) : null;
    const disciplina_id = Number(req.body?.disciplina_id);
    const ano_letivo = Number(req.body?.ano_letivo);
    const bimestre = Number(req.body?.bimestre);

    const serieBody = req.body?.serie ? normSerie(req.body.serie) : "";

    const bncc_unidade_tematica_id = req.body?.bncc_unidade_tematica_id
      ? Number(req.body.bncc_unidade_tematica_id)
      : null;

    const seedf_conteudo_id = req.body?.seedf_conteudo_id
      ? Number(req.body.seedf_conteudo_id)
      : null;

    const tema_texto_snapshot = String(req.body?.tema_texto_snapshot || "").trim();
    const conteudo_texto_snapshot = String(req.body?.conteudo_texto_snapshot || "").trim();

    // objetivo_texto pode ser null (opcional)
    const objetivo_texto =
      req.body?.objetivo_texto === null || typeof req.body?.objetivo_texto === "undefined"
        ? null
        : String(req.body.objetivo_texto).trim() || null;

    if (!disciplina_id || !ano_letivo || !bimestre) {
      return res.status(400).json({
        ok: false,
        message: "disciplina_id, ano_letivo e bimestre são obrigatórios.",
      });
    }

    if (!tema_texto_snapshot || !conteudo_texto_snapshot) {
      return res.status(400).json({
        ok: false,
        message: "tema_texto_snapshot e conteudo_texto_snapshot são obrigatórios.",
      });
    }

    const db = req.db;

    let serie = serieBody;

    // Compatibilidade: deriva série pela turma (se necessário)
    if (!serie && turma_id_body) {
      const [rowsTurma] = await db.query(
        `
        SELECT serie
        FROM turmas
        WHERE id = ?
          AND escola_id = ?
        LIMIT 1
        `,
        [turma_id_body, escola_id]
      );

      serie = String(rowsTurma?.[0]?.serie || "").trim();
    }

    if (!serie) {
      return res.status(400).json({
        ok: false,
        message: "serie é obrigatória (ou informe turma_id para derivação).",
      });
    }

    // ✅ Mantém compatibilidade do schema: escolhe uma turma de referência desta série
    // Preferência: turma_id enviado (se bater com a mesma série); caso contrário, usa a primeira turma da série.
    let turma_id = null;

    if (turma_id_body) {
      const [chk] = await db.query(
        `
        SELECT id
        FROM turmas
        WHERE id = ?
          AND escola_id = ?
          AND TRIM(serie) = TRIM(?)
        LIMIT 1
        `,
        [turma_id_body, escola_id, serie]
      );

      if (chk?.length) {
        turma_id = Number(turma_id_body);
      }
    }

    if (!turma_id) {
      const [pick] = await db.query(
        `
        SELECT id
        FROM turmas
        WHERE escola_id = ?
          AND TRIM(serie) = TRIM(?)
          AND (ano IS NULL OR ano = ?)
        ORDER BY id ASC
        LIMIT 1
        `,
        [escola_id, serie, ano_letivo]
      );

      turma_id = pick?.[0]?.id ? Number(pick[0].id) : null;
    }

    if (!turma_id) {
      return res.status(400).json({
        ok: false,
        message: "Não foi possível localizar uma turma de referência para a série informada.",
      });
    }

    const [ins] = await db.query(
      `
      INSERT INTO conteudos_plano_itens (
        escola_id,
        turma_id,
        disciplina_id,
        serie,
        ano_letivo,
        bimestre,
        bncc_unidade_tematica_id,
        tema_texto_snapshot,
        seedf_conteudo_id,
        conteudo_texto_snapshot,
        objetivo_texto,
        status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        escola_id,
        turma_id,
        disciplina_id,
        serie || null,
        ano_letivo,
        bimestre,
        bncc_unidade_tematica_id,
        tema_texto_snapshot,
        seedf_conteudo_id,
        conteudo_texto_snapshot,
        objetivo_texto,
        "ATIVO",
      ]
    );

    const item = {
      id: ins?.insertId,
      escola_id,
      turma_id,
      disciplina_id,
      serie: serie || null,
      ano_letivo,
      bimestre,
      bncc_unidade_tematica_id,
      tema_texto_snapshot,
      seedf_conteudo_id,
      conteudo_texto_snapshot,
      objetivo_texto,
      status: "ATIVO",
    };

    return res.status(201).json({ ok: true, item });





  } catch (err) {
    console.error("Erro POST /conteudos/admin/plano/itens:", err);
    return res.status(500).json({ ok: false, message: "Erro ao salvar item do plano." });
  }
});

/**
 * POST /api/conteudos/admin/planejamento/lote
 *
 * Objetivo (OPÇÃO A):
 * - Recebe as linhas que o professor montou no FRONT (tabela)
 * - Persiste em conteudos_objetivos_escola somente quando clicar no SALVAR (superior)
 *
 * Body (obrigatório):
 * - disciplina_id
 * - serie
 * - bimestre
 * - ano_letivo
 * - itens: [{ bncc_unidade_tematica_id, seedf_conteudo_id, texto }]
 *
 * Observações:
 * - "texto" é o objetivo (opcional): pode ser null/"".
 * - professor_id e created_by virão do token (req.user.usuarioId)
 * - escola_id vem do middleware verificarEscola (req.user.escola_id)
 */
router.post(
  "/conteudos/admin/planejamento/lote",
  autorizarPermissao("conteudos.criar"),
  async (req, res) => {
  try {
    if (!assertAuthEscola(req, res)) return;

    const escola_id = Number(req.user.escola_id);
    const professor_id = Number(req.user.usuarioId); // token
    const created_by = Number(req.user.usuarioId);   // token

    const disciplina_id = Number(req.body?.disciplina_id);
    const serie = normSerie(req.body?.serie);
    const bimestre = Number(req.body?.bimestre);
    const ano_letivo = Number(req.body?.ano_letivo);

    const itens = Array.isArray(req.body?.itens) ? req.body.itens : [];

    if (!professor_id || !created_by) {
      return res.status(403).json({ ok: false, message: "Acesso negado: usuário não definido no token." });
    }

    if (!disciplina_id || !serie || !bimestre || !ano_letivo) {
      return res.status(400).json({
        ok: false,
        message: "disciplina_id, serie, bimestre e ano_letivo são obrigatórios.",
      });
    }

    if (!itens.length) {
      return res.status(400).json({
        ok: false,
        message: "Nenhum item para salvar (itens vazio).",
      });
    }

    const db = req.db;

    await db.query("START TRANSACTION");

    let upserts = 0;

    for (const it of itens) {
      const bncc_unidade_tematica_id = Number(it?.bncc_unidade_tematica_id);
      const seedf_conteudo_id = Number(it?.seedf_conteudo_id);

      // texto (objetivo) é opcional
      const texto =
        it?.texto === null || typeof it?.texto === "undefined"
          ? null
          : String(it.texto).trim() || null;

      if (!bncc_unidade_tematica_id || !seedf_conteudo_id) {
        await db.query("ROLLBACK");
        return res.status(400).json({
          ok: false,
          message: "Cada item deve conter bncc_unidade_tematica_id e seedf_conteudo_id.",
        });
      }

      const [r] = await db.query(
        `
        INSERT INTO conteudos_objetivos_escola (
                      escola_id,
                      professor_id,
                     created_by,
                     disciplina_id,
                     serie,
                     bimestre,
                    ano_letivo,
                     bncc_unidade_tematica_id,
                     seedf_conteudo_id,
                    texto,
                                                  ativo,
                                                 status,
                                                 edicao_liberada
                                      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 0)
                                   ON DUPLICATE KEY UPDATE
                                         texto = VALUES(texto),
                                         ativo = 1,
                                         status = 1,
                                         edicao_liberada = 0,
                                        updated_at = CURRENT_TIMESTAMP
        `,
        [
          escola_id,
          professor_id,
          created_by,
          disciplina_id,
          serie,
          bimestre,
          ano_letivo,
          bncc_unidade_tematica_id,
          seedf_conteudo_id,
          texto,
        ]
      );

      // mysql2: affectedRows = 1 (insert) ou 2 (update)
      if (r?.affectedRows) upserts += 1;
    }

    await db.query("COMMIT");

    return res.status(200).json({
      ok: true,
      message: "Planejamento salvo com sucesso.",
      total_recebido: itens.length,
      total_processado: upserts,
    });
  } catch (err) {
    try {
      req?.db?.query?.("ROLLBACK");
    } catch (_) {}

    console.error("Erro POST /conteudos/admin/planejamento/lote:", err);
    return res.status(500).json({ ok: false, message: "Erro ao salvar planejamento (lote)." });
  }
});

export default router;

