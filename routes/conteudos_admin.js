// routes/conteudos_admin.js
// ============================================================================
// Conteúdos (ADMIN) — CRUD para alimentar o card Conteúdos do App Pais
// Tabelas:
//   - conteudos_planos
//   - conteudos_itens
//
// Regras:
//   - Rotas protegidas (token + escola)
//   - escola_id vem de req.user.escola_id (middleware verificarEscola)
//   - Filtro obrigatório: turma_id, disciplina_id, bimestre, ano_letivo
//   - Itens são gerenciados como lista (substituição completa) para estabilidade
// ============================================================================

import express from "express";
const router = express.Router();

// Helpers
function toInt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function badRequest(res, message) {
  return res.status(400).json({ ok: false, message });
}

// ============================================================================
// Helpers — Catálogo anual + Planejamento (alocações) + Código padronizado
// Padrão final (planejamento): DISC-A{serie}-B{bimestre}-A{assunto}-T{topico}-ST{subtopico}
// Ex.: MATE-A6-B3-A01-T02-ST03
// Obs:
//  - O catálogo anual NÃO carrega bimestre (bimestre = NULL no tópico do catálogo)
//  - O código final nasce na tabela conteudos_plano_alocacoes (planejamento)
// ============================================================================

// Remove acentos e normaliza string
function normalizeAscii(str) {
  return String(str || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Sigla de 4 letras da disciplina (ex.: Matemática -> MATE)
function disciplinaSigla4(disciplinaNome) {
  const s = normalizeAscii(disciplinaNome).toUpperCase().replace(/[^A-Z]/g, "");
  return (s.slice(0, 4) || "DISC").padEnd(4, "X");
}

// Extrai "A6" de "6º ANO", "7 ANO", "8º", etc.
function serieCodigoFromTurmaSerie(serieTxt) {
  const m = String(serieTxt || "").match(/(\d+)/);
  const n = m ? m[1] : "";
  return `A${n || "0"}`;
}

// Remove token de bimestre do código
// Usado no catálogo anual (bimestre = NULL)
function stripBimestreFromCodigo(codigo) {
  const s = String(codigo || "").trim();
  if (!s) return s;

  let out = s;

  out = out.split("-B1-").join("-");
  out = out.split("-B2-").join("-");
  out = out.split("-B3-").join("-");
  out = out.split("-B4-").join("-");

  if (out.endsWith("-B1")) out = out.slice(0, -3);
  if (out.endsWith("-B2")) out = out.slice(0, -3);
  if (out.endsWith("-B3")) out = out.slice(0, -3);
  if (out.endsWith("-B4")) out = out.slice(0, -3);

  return out;
}


// Injeta/atualiza bimestre no código-base
// Aceita código-base em 2 formatos:
//   a) "MATE-A6-A01-T02-ST03" (sem bimestre)
//   b) "MATE-A6-B1-A01-T02-ST03" (com bimestre)
//   c) "A01-T02-ST03" (somente sufixo)
function buildCodigoFinal({ discSigla4, serieCodigo, bimestre, codigoBase }) {
  const B = `B${Number(bimestre)}`;

  const raw = String(codigoBase || "").trim();
  const tokens = raw.split("-").filter(Boolean);

  const hasDiscSerie =
    tokens.length >= 2 &&
    /^[A-Z]{4}$/.test(tokens[0]) &&
    /^A\d+$/.test(tokens[1]);

  // Extrai o "miolo" (A01-T02-ST03) removendo disc/serie e removendo Bx se existir
  let tailTokens = tokens;

  if (hasDiscSerie) {
    tailTokens = tokens.slice(2); // remove DISC-A{serie}
  }

  // Remove Bx do tail se veio junto
  tailTokens = tailTokens.filter((t) => !/^B[1-4]$/.test(t));

  // Se o código-base vier completo (incluindo A01...), tailTokens já está ok.
  // Se vier vazio por algum motivo, garantimos pelo menos "A00"
  if (!tailTokens.length) tailTokens = ["A00"];

  return [discSigla4, serieCodigo, B, ...tailTokens].join("-");
}


// ============================================================================
// GET /api/pedagogico/conteudos/planos
// Lista planos (ou retorna 0/1 plano se filtros completos)
// Query: turma_id, disciplina_id, bimestre, ano_letivo, status(opcional)
// ============================================================================
router.get("/pedagogico/conteudos/planos", async (req, res) => {
  try {
    const escola_id = req.user?.escola_id;
    const turma_id = toInt(req.query.turma_id);
    const disciplina_id = toInt(req.query.disciplina_id);
    const bimestre = toInt(req.query.bimestre);
    const ano_letivo = toInt(req.query.ano_letivo);
    const status = req.query.status || null;

    if (!escola_id) return res.status(403).json({ ok: false, message: "Escola não definida." });
    if (!turma_id || !disciplina_id || !bimestre || !ano_letivo) {
      return badRequest(res, "Informe turma_id, disciplina_id, bimestre e ano_letivo.");
    }

    const params = [escola_id, turma_id, disciplina_id, ano_letivo, bimestre];
    let sql = `
      SELECT id, escola_id, turma_id, disciplina_id, ano_letivo, bimestre, titulo, status, created_at, updated_at
      FROM conteudos_planos
      WHERE escola_id = ?
        AND turma_id = ?
        AND disciplina_id = ?
        AND ano_letivo = ?
        AND bimestre = ?
    `;

    if (status) {
      sql += ` AND status = ?`;
      params.push(status);
    }

    sql += ` ORDER BY id DESC`;

    const [rows] = await req.db.query(sql, params);

    return res.json({ ok: true, planos: rows || [] });
  } catch (err) {
    console.error("[conteudos_admin] GET /planos erro:", err);
    return res.status(500).json({ ok: false, message: "Erro ao listar planos." });
  }
});

// ============================================================================
// POST /api/pedagogico/conteudos/planos
// Cria (ou atualiza via UNIQUE) um plano
// Body: turma_id, disciplina_id, bimestre, ano_letivo, titulo(opcional), status(opcional)
// ============================================================================
router.post("/pedagogico/conteudos/planos", async (req, res) => {
  try {
    const escola_id = req.user?.escola_id;
    const turma_id = toInt(req.body.turma_id);
    const disciplina_id = toInt(req.body.disciplina_id);
    const bimestre = toInt(req.body.bimestre);
    const ano_letivo = toInt(req.body.ano_letivo);
    const titulo = (req.body.titulo || "").trim() || null;
    const status = (req.body.status || "ATIVO").toUpperCase();

    if (!escola_id) return res.status(403).json({ ok: false, message: "Escola não definida." });
    if (!turma_id || !disciplina_id || !bimestre || !ano_letivo) {
      return badRequest(res, "Informe turma_id, disciplina_id, bimestre e ano_letivo.");
    }
    if (!["ATIVO", "INATIVO"].includes(status)) {
      return badRequest(res, "Status inválido. Use ATIVO ou INATIVO.");
    }

    // INSERT com ON DUPLICATE KEY (uk_conteudos_plano já existe)
    const sql = `
      INSERT INTO conteudos_planos (escola_id, turma_id, disciplina_id, ano_letivo, bimestre, titulo, status)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        titulo = VALUES(titulo),
        status = VALUES(status),
        updated_at = CURRENT_TIMESTAMP
    `;
    await req.db.query(sql, [escola_id, turma_id, disciplina_id, ano_letivo, bimestre, titulo, status]);

    // Busca o plano (id) após upsert
    const [rows] = await req.db.query(
      `
      SELECT id, escola_id, turma_id, disciplina_id, ano_letivo, bimestre, titulo, status, created_at, updated_at
      FROM conteudos_planos
      WHERE escola_id = ? AND turma_id = ? AND disciplina_id = ? AND ano_letivo = ? AND bimestre = ?
      LIMIT 1
      `,
      [escola_id, turma_id, disciplina_id, ano_letivo, bimestre]
    );

    return res.json({ ok: true, plano: rows?.[0] || null });
  } catch (err) {
    console.error("[conteudos_admin] POST /planos erro:", err);
    return res.status(500).json({ ok: false, message: "Erro ao salvar plano." });
  }
});

// ============================================================================
// GET /api/pedagogico/conteudos/planos/:id
// Retorna plano + itens (ordenados)
// ============================================================================
router.get("/pedagogico/conteudos/planos/:id", async (req, res) => {
  try {
    const escola_id = req.user?.escola_id;
    const id = toInt(req.params.id);
    if (!escola_id) return res.status(403).json({ ok: false, message: "Escola não definida." });
    if (!id) return badRequest(res, "ID inválido.");

    const [[plano]] = await req.db.query(
      `
      SELECT id, escola_id, turma_id, disciplina_id, ano_letivo, bimestre, titulo, status, created_at, updated_at
      FROM conteudos_planos
      WHERE id = ? AND escola_id = ?
      LIMIT 1
      `,
      [id, escola_id]
    );

    if (!plano) return res.status(404).json({ ok: false, message: "Plano não encontrado." });

    const [itens] = await req.db.query(
      `
      SELECT id, plano_id, ordem, texto, status, created_at, updated_at
      FROM conteudos_itens
      WHERE plano_id = ?
        AND status = 'ATIVO'
      ORDER BY ordem ASC
      `,
      [id]
    );

    return res.json({ ok: true, plano, itens: itens || [] });
  } catch (err) {
    console.error("[conteudos_admin] GET /planos/:id erro:", err);
    return res.status(500).json({ ok: false, message: "Erro ao carregar plano." });
  }
});

// ============================================================================
// PUT /api/pedagogico/conteudos/planos/:id
// Atualiza título/status do plano
// Body: titulo(opcional), status(opcional)
// ============================================================================
router.put("/pedagogico/conteudos/planos/:id", async (req, res) => {
  try {
    const escola_id = req.user?.escola_id;
    const id = toInt(req.params.id);
    const titulo = req.body.titulo !== undefined ? String(req.body.titulo).trim() : undefined;
    const status = req.body.status !== undefined ? String(req.body.status).toUpperCase() : undefined;

    if (!escola_id) return res.status(403).json({ ok: false, message: "Escola não definida." });
    if (!id) return badRequest(res, "ID inválido.");
    if (status !== undefined && !["ATIVO", "INATIVO"].includes(status)) {
      return badRequest(res, "Status inválido. Use ATIVO ou INATIVO.");
    }

    // Confirma existência do plano na escola
    const [[plano]] = await req.db.query(
      `SELECT id FROM conteudos_planos WHERE id = ? AND escola_id = ? LIMIT 1`,
      [id, escola_id]
    );
    if (!plano) return res.status(404).json({ ok: false, message: "Plano não encontrado." });

    const sets = [];
    const params = [];

    if (titulo !== undefined) {
      sets.push("titulo = ?");
      params.push(titulo || null);
    }
    if (status !== undefined) {
      sets.push("status = ?");
      params.push(status);
    }

    if (!sets.length) return badRequest(res, "Nada para atualizar.");

    params.push(id, escola_id);

    await req.db.query(
      `
      UPDATE conteudos_planos
      SET ${sets.join(", ")}, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND escola_id = ?
      `,
      params
    );

    const [[updated]] = await req.db.query(
      `
      SELECT id, escola_id, turma_id, disciplina_id, ano_letivo, bimestre, titulo, status, created_at, updated_at
      FROM conteudos_planos
      WHERE id = ? AND escola_id = ?
      LIMIT 1
      `,
      [id, escola_id]
    );

    return res.json({ ok: true, plano: updated });
  } catch (err) {
    console.error("[conteudos_admin] PUT /planos/:id erro:", err);
    return res.status(500).json({ ok: false, message: "Erro ao atualizar plano." });
  }
});

// ============================================================================
// PUT /api/pedagogico/conteudos/planos/:id/itens
// Substitui a lista inteira de itens (mais simples e estável)
// Body: itens: [{ texto: string }]
// Regras:
//  - remove todos itens anteriores do plano (DELETE) e recria em ordem 1..n
// ============================================================================
router.put("/pedagogico/conteudos/planos/:id/itens", async (req, res) => {
  try {
    const escola_id = req.user?.escola_id;
    const id = toInt(req.params.id);
    const itens = Array.isArray(req.body.itens) ? req.body.itens : null;

    if (!escola_id) return res.status(403).json({ ok: false, message: "Escola não definida." });
    if (!id) return badRequest(res, "ID inválido.");
    if (!itens) return badRequest(res, "Envie 'itens' como array.");

    // Confirma plano na escola
    const [[plano]] = await req.db.query(
      `SELECT id FROM conteudos_planos WHERE id = ? AND escola_id = ? LIMIT 1`,
      [id, escola_id]
    );
    if (!plano) return res.status(404).json({ ok: false, message: "Plano não encontrado." });

    // Normaliza itens (remove vazios)
    const normalized = itens
      .map((x) => (x?.texto !== undefined ? String(x.texto).trim() : ""))
      .filter((t) => t.length > 0)
      .slice(0, 200); // segurança

    // Transação simples
    await req.db.query("START TRANSACTION");

    await req.db.query(`DELETE FROM conteudos_itens WHERE plano_id = ?`, [id]);

    if (normalized.length) {
      const values = normalized.map((texto, idx) => [id, idx + 1, texto, "ATIVO"]);
      await req.db.query(
        `INSERT INTO conteudos_itens (plano_id, ordem, texto, status) VALUES ?`,
        [values]
      );
    }

    await req.db.query(
      `UPDATE conteudos_planos SET updated_at = CURRENT_TIMESTAMP WHERE id = ? AND escola_id = ?`,
      [id, escola_id]
    );

    await req.db.query("COMMIT");

    // Retorna itens atualizados
    const [rows] = await req.db.query(
      `
      SELECT id, plano_id, ordem, texto, status, created_at, updated_at
      FROM conteudos_itens
      WHERE plano_id = ?
      ORDER BY ordem ASC
      `,
      [id]
    );

    return res.json({ ok: true, itens: rows || [] });
  } catch (err) {
    try {
      await req.db.query("ROLLBACK");
    } catch {}
    console.error("[conteudos_admin] PUT /planos/:id/itens erro:", err);
    return res.status(500).json({ ok: false, message: "Erro ao salvar itens." });
  }
});


// ============================================================================
// GET /api/pedagogico/conteudos/catalogo
// Catálogo anual (BNCC-like): Unidade (Assunto) -> Objeto (Tópico) -> "Habilidade operacional" (Subtópico)
// Query: disciplina_id, ano_ref
// Regras:
//  - escola_id vem do token
//  - catálogo anual = conteudos_topicos com bimestre IS NULL
// Retorno: { topicos: [{...topico, subtopicos:[...] }] }
// ============================================================================
router.get("/pedagogico/conteudos/catalogo", async (req, res) => {
  try {
    const escola_id = req.user?.escola_id;
    const disciplina_id = toInt(req.query.disciplina_id);
    const ano_ref = toInt(req.query.ano_ref);

    if (!escola_id) return res.status(403).json({ ok: false, message: "Escola não definida." });
    if (!disciplina_id || !ano_ref) return badRequest(res, "Informe disciplina_id e ano_ref.");

    // Catálogo anual: bimestre IS NULL
    const [rows] = await req.db.query(
      `
      SELECT
        ct.id            AS topico_id,
        ct.escola_id,
        ct.disciplina_id,
        ct.ano_ref,
        ct.bimestre,
        ct.codigo        AS topico_codigo,
        ct.titulo        AS topico_titulo,
        ct.ordem         AS topico_ordem,
        ct.status        AS topico_status,

        cs.id            AS subtopico_id,
        cs.codigo        AS subtopico_codigo,
        cs.titulo        AS subtopico_titulo,
        cs.ordem         AS subtopico_ordem,
        cs.status        AS subtopico_status

      FROM conteudos_topicos ct
      LEFT JOIN conteudos_subtopicos cs ON cs.topico_id = ct.id
      WHERE ct.escola_id = ?
        AND ct.disciplina_id = ?
        AND ct.ano_ref = ?
        AND ct.bimestre IS NULL
        AND ct.status = 'ATIVO'
        AND (cs.id IS NULL OR cs.status = 'ATIVO')
      ORDER BY ct.ordem ASC, cs.ordem ASC
      `,
      [escola_id, disciplina_id, ano_ref]
    );

    // Monta árvore
    const map = new Map();
    for (const r of rows || []) {
      if (!map.has(r.topico_id)) {
        map.set(r.topico_id, {
          id: r.topico_id,
          escola_id: r.escola_id,
          disciplina_id: r.disciplina_id,
          ano_ref: r.ano_ref,
          bimestre: r.bimestre, // NULL
          codigo: stripBimestreFromCodigo(r.topico_codigo),
          titulo: r.topico_titulo,
          ordem: r.topico_ordem,
          status: r.topico_status,
          subtopicos: [],
        });
      }
      if (r.subtopico_id) {
        map.get(r.topico_id).subtopicos.push({
          id: r.subtopico_id,
          topico_id: r.topico_id,
          codigo: stripBimestreFromCodigo(r.subtopico_codigo),
          titulo: r.subtopico_titulo,
          ordem: r.subtopico_ordem,
          status: r.subtopico_status,
        });
      }
    }

    return res.json({ ok: true, topicos: Array.from(map.values()) });
  } catch (err) {
    console.error("[conteudos_admin] GET /catalogo erro:", err);
    return res.status(500).json({ ok: false, message: "Erro ao carregar catálogo." });
  }
});

// ============================================================================
// GET /api/pedagogico/conteudos/planos/:id/alocacoes
// Retorna alocações do plano (ordenadas) com o código final já gravado
// ============================================================================
router.get("/pedagogico/conteudos/planos/:id/alocacoes", async (req, res) => {
  try {
    const escola_id = req.user?.escola_id;
    const plano_id = toInt(req.params.id);

    if (!escola_id) return res.status(403).json({ ok: false, message: "Escola não definida." });
    if (!plano_id) return badRequest(res, "ID inválido.");

    // Confirma plano na escola
    const [[plano]] = await req.db.query(
      `
      SELECT id, escola_id, turma_id, disciplina_id, ano_letivo, bimestre, titulo, status
      FROM conteudos_planos
      WHERE id = ? AND escola_id = ?
      LIMIT 1
      `,
      [plano_id, escola_id]
    );
    if (!plano) return res.status(404).json({ ok: false, message: "Plano não encontrado." });

    const [rows] = await req.db.query(
      `
      SELECT
        cpa.id,
        cpa.plano_id,
        cpa.subtopico_id,
        cpa.codigo,
        cpa.ordem,
        cpa.status,
        cs.titulo AS subtopico_titulo
      FROM conteudos_plano_alocacoes cpa
      JOIN conteudos_subtopicos cs ON cs.id = cpa.subtopico_id
      WHERE cpa.plano_id = ?
        AND cpa.status = 'ATIVO'
      ORDER BY cpa.ordem ASC
      `,
      [plano_id]
    );

    return res.json({ ok: true, plano, alocacoes: rows || [] });
  } catch (err) {
    console.error("[conteudos_admin] GET /planos/:id/alocacoes erro:", err);
    return res.status(500).json({ ok: false, message: "Erro ao carregar alocações." });
  }
});

// ============================================================================
// POST /api/pedagogico/conteudos/planos/:id/alocacoes
// Substitui a lista inteira (estável) e recalcula 'codigo' automaticamente
// Body: alocacoes: [{ subtopico_id: number, ordem?: number }]
// Regras:
//  - Valida plano na escola
//  - Remove alocações anteriores (DELETE) e recria em ordem 1..n
//  - Recalcula codigo (DISC + A{serie} + B{bimestre} + sufixo do catálogo)
// ============================================================================
router.post("/pedagogico/conteudos/planos/:id/alocacoes", async (req, res) => {
  try {
    const escola_id = req.user?.escola_id;
    const plano_id = toInt(req.params.id);
    const alocacoes = Array.isArray(req.body.alocacoes) ? req.body.alocacoes : null;

    if (!escola_id) return res.status(403).json({ ok: false, message: "Escola não definida." });
    if (!plano_id) return badRequest(res, "ID inválido.");
    if (!alocacoes) return badRequest(res, "Envie 'alocacoes' como array.");

    // Confirma plano + obtém dados necessários (bimestre, turma, disciplina)
    const [[plano]] = await req.db.query(
      `
      SELECT id, escola_id, turma_id, disciplina_id, ano_letivo, bimestre, titulo, status
      FROM conteudos_planos
      WHERE id = ? AND escola_id = ?
      LIMIT 1
      `,
      [plano_id, escola_id]
    );
    if (!plano) return res.status(404).json({ ok: false, message: "Plano não encontrado." });

    // Normaliza lista (subtopico_id obrigatorio)
    const normalized = alocacoes
      .map((x) => ({ subtopico_id: toInt(x?.subtopico_id) }))
      .filter((x) => !!x.subtopico_id)
      .slice(0, 400); // segurança

    // Remove duplicados mantendo ordem (primeira ocorrência)
    const seen = new Set();
    const deduped = [];
    for (const item of normalized) {
      if (!seen.has(item.subtopico_id)) {
        seen.add(item.subtopico_id);
        deduped.push(item);
      }
    }

    // Busca disciplina + turma para gerar DISC e A{serie}
    const [[disc]] = await req.db.query(
      `SELECT nome FROM disciplinas WHERE id = ? LIMIT 1`,
      [plano.disciplina_id]
    );

    const [[turma]] = await req.db.query(
      `SELECT serie FROM turmas WHERE id = ? AND escola_id = ? LIMIT 1`,
      [plano.turma_id, escola_id]
    );

    const discSigla4 = disciplinaSigla4(disc?.nome);
    const serieCodigo = serieCodigoFromTurmaSerie(turma?.serie);

    // Vamos precisar do "codigoBase" do subtópico (catálogo)
    // Observação: se o código do catálogo estiver completo ou parcial, buildCodigoFinal resolve.
    const ids = deduped.map((x) => x.subtopico_id);
    if (!ids.length) {
      // Se o usuário limpou tudo
      await req.db.query("START TRANSACTION");
      await req.db.query(`DELETE FROM conteudos_plano_alocacoes WHERE plano_id = ?`, [plano_id]);
      await req.db.query("COMMIT");
      return res.json({ ok: true, plano, alocacoes: [] });
    }

    const [subs] = await req.db.query(
      `
      SELECT id, codigo, titulo
      FROM conteudos_subtopicos
      WHERE id IN (?)
      `,
      [ids]
    );

    const subMap = new Map((subs || []).map((s) => [Number(s.id), s]));

    // Transação: substituição completa
    await req.db.query("START TRANSACTION");

    await req.db.query(`DELETE FROM conteudos_plano_alocacoes WHERE plano_id = ?`, [plano_id]);

    // Insert em lote
    const values = deduped.map((item, idx) => {
      const sub = subMap.get(Number(item.subtopico_id));
      const codigoBase = sub?.codigo || "A00";
      const codigoFinal = buildCodigoFinal({
        discSigla4,
        serieCodigo,
        bimestre: plano.bimestre,
        codigoBase,
      });
      return [plano_id, item.subtopico_id, codigoFinal, idx + 1, "ATIVO"];
    });

    await req.db.query(
      `INSERT INTO conteudos_plano_alocacoes (plano_id, subtopico_id, codigo, ordem, status) VALUES ?`,
      [values]
    );

    await req.db.query(
      `UPDATE conteudos_planos SET updated_at = CURRENT_TIMESTAMP WHERE id = ? AND escola_id = ?`,
      [plano_id, escola_id]
    );

    await req.db.query("COMMIT");

    // Retorna lista final
    const [rows] = await req.db.query(
      `
      SELECT
        cpa.id,
        cpa.plano_id,
        cpa.subtopico_id,
        cpa.codigo,
        cpa.ordem,
        cpa.status,
        cs.titulo AS subtopico_titulo
      FROM conteudos_plano_alocacoes cpa
      JOIN conteudos_subtopicos cs ON cs.id = cpa.subtopico_id
      WHERE cpa.plano_id = ?
        AND cpa.status = 'ATIVO'
      ORDER BY cpa.ordem ASC
      `,
      [plano_id]
    );

    return res.json({ ok: true, plano, alocacoes: rows || [] });
  } catch (err) {
    try {
      await req.db.query("ROLLBACK");
    } catch {}
    console.error("[conteudos_admin] POST /planos/:id/alocacoes erro:", err);
    return res.status(500).json({ ok: false, message: "Erro ao salvar alocações." });
  }
});


export default router;
