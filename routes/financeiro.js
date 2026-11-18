// routes/financeiro.js
// ============================================================================
// MÓDULO FINANCEIRO — Persistência Real no MySQL (Multi-Tenant por escola_id)
// Submódulo PDAF (Programa de Descentralização Administrativa e Financeira - SEEDF):
//   - financeiro_pdaf_entradas : Repasses ordinários, emendas parlamentares,
//                                rendimentos de aplicação e saldos reprogramados
//   - financeiro_pdaf_despesas : Execução financeira (Compras, OS/3 Orçamentos,
//                                Fornecedor, CNPJ/CPF, Fonte, Processo Incorporação,
//                                Custeio e Capital)
// ============================================================================

import express from "express";
import pool from "../db.js";

const router = express.Router();

const FONTES_VALIDAS = new Set(["ORDINARIO", "EMENDA", "RENDIMENTO"]);

let tablesEnsured = false;

export async function ensureFinanceiroTables(dbConn = pool) {
  if (tablesEnsured) return;
  try {
    await dbConn.query(`
      CREATE TABLE IF NOT EXISTS financeiro_pdaf_entradas (
        id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
        escola_id       INT NOT NULL,
        exercicio       INT NOT NULL,
        data_entrada    DATE NOT NULL,
        fonte_recurso   ENUM('ORDINARIO', 'EMENDA', 'RENDIMENTO') NOT NULL DEFAULT 'ORDINARIO',
        descricao       VARCHAR(255) NOT NULL,
        referencia_doc  VARCHAR(140) DEFAULT NULL,
        valor_custeio   DECIMAL(14,2) NOT NULL DEFAULT 0.00,
        valor_capital   DECIMAL(14,2) NOT NULL DEFAULT 0.00,
        observacoes     TEXT DEFAULT NULL,
        criado_por      VARCHAR(200) DEFAULT NULL,
        criado_em       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        atualizado_em   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        INDEX idx_fin_pdaf_ent_escola_ano (escola_id, exercicio),
        INDEX idx_fin_pdaf_ent_fonte (escola_id, exercicio, fonte_recurso)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        COMMENT='Entradas/repasses de recursos do PDAF (Ordinário, Emenda Parlamentar e Rendimento) por Custeio e Capital'
    `);

    await dbConn.query(`
      CREATE TABLE IF NOT EXISTS financeiro_pdaf_despesas (
        id                       INT UNSIGNED NOT NULL AUTO_INCREMENT,
        escola_id                INT NOT NULL,
        exercicio                INT NOT NULL,
        compra                   VARCHAR(80) NOT NULL,
        data_pagamento           DATE NOT NULL,
        ordem_servico_orcamentos VARCHAR(180) DEFAULT NULL,
        fornecedor               VARCHAR(255) NOT NULL,
        cnpj_cpf                 VARCHAR(30) DEFAULT NULL,
        descricao_geral          TEXT NOT NULL,
        fonte_recurso            ENUM('ORDINARIO', 'EMENDA', 'RENDIMENTO') NOT NULL DEFAULT 'ORDINARIO',
        processo_incorporacao    VARCHAR(140) DEFAULT NULL,
        valor_custeio            DECIMAL(14,2) NOT NULL DEFAULT 0.00,
        valor_capital            DECIMAL(14,2) NOT NULL DEFAULT 0.00,
        observacoes              TEXT DEFAULT NULL,
        criado_por               VARCHAR(200) DEFAULT NULL,
        criado_em                DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        atualizado_em            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        INDEX idx_fin_pdaf_desp_escola_ano (escola_id, exercicio, data_pagamento),
        INDEX idx_fin_pdaf_desp_fonte (escola_id, exercicio, fonte_recurso)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        COMMENT='Despesas e compras executadas no PDAF por unidade escolar'
    `);

    tablesEnsured = true;
  } catch (err) {
    console.error("[FINANCEIRO][ENSURE_TABLES] Erro:", err?.message || err);
  }
}

function getEscolaId(req) {
  return Number(
    req.escola_id ||
      req.user?.escola_id ||
      req.headers?.["x-escola-id"] ||
      req.query?.escola_id ||
      req.body?.escola_id ||
      0
  );
}

function getUsuarioLabel(req) {
  const nome = String(req.user?.nome || req.body?.criado_por || "").trim();
  const perfil = String(req.user?.perfil || "").trim();
  if (nome && perfil) return `${nome} (${perfil})`;
  return nome || perfil || null;
}

function normalizarDataIso(val) {
  const s = String(val || "").trim().slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return new Date().toISOString().slice(0, 10);
}

function parseExercicio(val) {
  const anoAtual = new Date().getFullYear();
  const n = Number(val);
  if (Number.isInteger(n) && n >= 2020 && n <= 2100) return n;
  return anoAtual;
}

function toCents(val) {
  if (val === null || val === undefined || val === "") return 0;
  if (typeof val === "number") {
    return Number.isFinite(val) ? Math.round(val * 100) : 0;
  }
  let s = String(val).trim().replace(/[R$\s]/g, "");
  if (!s) return 0;
  if (s.includes(",") && s.includes(".")) {
    s = s.replace(/\./g, "").replace(",", ".");
  } else if (s.includes(",")) {
    s = s.replace(",", ".");
  }
  const num = Number(s);
  return Number.isFinite(num) ? Math.round(num * 100) : 0;
}

function centsToDecimal(cents) {
  return Number((cents / 100).toFixed(2));
}

function criarBucketVazio() {
  return {
    entradas_custeio_cents: 0,
    entradas_capital_cents: 0,
    saidas_custeio_cents: 0,
    saidas_capital_cents: 0,
  };
}

function formatarBucket(b) {
  const entCust = b.entradas_custeio_cents;
  const entCap = b.entradas_capital_cents;
  const saiCust = b.saidas_custeio_cents;
  const saiCap = b.saidas_capital_cents;
  const saldoCust = entCust - saiCust;
  const saldoCap = entCap - saiCap;
  return {
    entradas_custeio: centsToDecimal(entCust),
    entradas_capital: centsToDecimal(entCap),
    entradas_total: centsToDecimal(entCust + entCap),
    saidas_custeio: centsToDecimal(saiCust),
    saidas_capital: centsToDecimal(saiCap),
    saidas_total: centsToDecimal(saiCust + saiCap),
    saldo_custeio: centsToDecimal(saldoCust),
    saldo_capital: centsToDecimal(saldoCap),
    saldo_total: centsToDecimal(saldoCust + saldoCap),
  };
}

function calcularResumoPdaf(entradas = [], despesas = []) {
  const buckets = {
    ORDINARIO: criarBucketVazio(),
    EMENDA: criarBucketVazio(),
    RENDIMENTO: criarBucketVazio(),
  };

  for (const e of entradas) {
    const f = FONTES_VALIDAS.has(e.fonte_recurso) ? e.fonte_recurso : "ORDINARIO";
    buckets[f].entradas_custeio_cents += toCents(e.valor_custeio);
    buckets[f].entradas_capital_cents += toCents(e.valor_capital);
  }

  for (const d of despesas) {
    const f = FONTES_VALIDAS.has(d.fonte_recurso) ? d.fonte_recurso : "ORDINARIO";
    buckets[f].saidas_custeio_cents += toCents(d.valor_custeio);
    buckets[f].saidas_capital_cents += toCents(d.valor_capital);
  }

  const totalBucket = {
    entradas_custeio_cents:
      buckets.ORDINARIO.entradas_custeio_cents +
      buckets.EMENDA.entradas_custeio_cents +
      buckets.RENDIMENTO.entradas_custeio_cents,
    entradas_capital_cents:
      buckets.ORDINARIO.entradas_capital_cents +
      buckets.EMENDA.entradas_capital_cents +
      buckets.RENDIMENTO.entradas_capital_cents,
    saidas_custeio_cents:
      buckets.ORDINARIO.saidas_custeio_cents +
      buckets.EMENDA.saidas_custeio_cents +
      buckets.RENDIMENTO.saidas_custeio_cents,
    saidas_capital_cents:
      buckets.ORDINARIO.saidas_capital_cents +
      buckets.EMENDA.saidas_capital_cents +
      buckets.RENDIMENTO.saidas_capital_cents,
  };

  return {
    ordinario: formatarBucket(buckets.ORDINARIO),
    emenda: formatarBucket(buckets.EMENDA),
    rendimento: formatarBucket(buckets.RENDIMENTO),
    total: formatarBucket(totalBucket),
  };
}

// ── GET /api/financeiro/pdaf?exercicio=YYYY ─────────────────────────────────
router.get("/pdaf", async (req, res) => {
  const db = req.db || pool;
  const escolaId = getEscolaId(req);
  if (!escolaId) {
    return res.status(400).json({ ok: false, message: "escola_id é obrigatório." });
  }

  const exercicio = parseExercicio(req.query?.exercicio);

  try {
    await ensureFinanceiroTables(db);

    const [[entradas], [despesas], [anosEnt], [anosDesp]] = await Promise.all([
      db.query(
        `SELECT
          id, escola_id, exercicio,
          DATE_FORMAT(data_entrada, '%Y-%m-%d') AS data_entrada,
          fonte_recurso, descricao, referencia_doc,
          valor_custeio, valor_capital, observacoes,
          criado_por, criado_em, atualizado_em
        FROM financeiro_pdaf_entradas
        WHERE escola_id = ? AND exercicio = ?
        ORDER BY data_entrada DESC, id DESC`,
        [escolaId, exercicio]
      ),
      db.query(
        `SELECT
          id, escola_id, exercicio, compra,
          DATE_FORMAT(data_pagamento, '%Y-%m-%d') AS data_pagamento,
          ordem_servico_orcamentos, fornecedor, cnpj_cpf,
          descricao_geral, fonte_recurso, processo_incorporacao,
          valor_custeio, valor_capital, observacoes,
          criado_por, criado_em, atualizado_em
        FROM financeiro_pdaf_despesas
        WHERE escola_id = ? AND exercicio = ?
        ORDER BY data_pagamento DESC, id DESC`,
        [escolaId, exercicio]
      ),
      db.query(
        "SELECT DISTINCT exercicio FROM financeiro_pdaf_entradas WHERE escola_id = ?",
        [escolaId]
      ),
      db.query(
        "SELECT DISTINCT exercicio FROM financeiro_pdaf_despesas WHERE escola_id = ?",
        [escolaId]
      ),
    ]);

    const anoAtual = new Date().getFullYear();
    const anosSet = new Set([anoAtual - 1, anoAtual, anoAtual + 1, exercicio]);
    for (const r of anosEnt || []) if (r?.exercicio) anosSet.add(Number(r.exercicio));
    for (const r of anosDesp || []) if (r?.exercicio) anosSet.add(Number(r.exercicio));
    const exerciciosDisponiveis = Array.from(anosSet).sort((a, b) => b - a);

    const entradasFmt = (entradas || []).map((r) => ({
      ...r,
      valor_custeio: Number(r.valor_custeio || 0),
      valor_capital: Number(r.valor_capital || 0),
    }));

    const despesasFmt = (despesas || []).map((r) => ({
      ...r,
      valor_custeio: Number(r.valor_custeio || 0),
      valor_capital: Number(r.valor_capital || 0),
    }));

    const resumo = calcularResumoPdaf(entradasFmt, despesasFmt);

    return res.json({
      ok: true,
      escola_id: escolaId,
      exercicio,
      exercicios_disponiveis: exerciciosDisponiveis,
      resumo,
      entradas: entradasFmt,
      despesas: despesasFmt,
    });
  } catch (err) {
    console.error("[FINANCEIRO][GET /pdaf]", err);
    return res.status(500).json({ ok: false, message: "Erro ao carregar dados do PDAF." });
  }
});

// ── POST /api/financeiro/pdaf/entradas ──────────────────────────────────────
router.post("/pdaf/entradas", async (req, res) => {
  const db = req.db || pool;
  const escolaId = getEscolaId(req);
  if (!escolaId) {
    return res.status(400).json({ ok: false, message: "escola_id é obrigatório." });
  }

  const {
    exercicio,
    data_entrada,
    fonte_recurso,
    descricao,
    referencia_doc,
    valor_custeio,
    valor_capital,
    observacoes,
  } = req.body || {};

  const fonte = String(fonte_recurso || "ORDINARIO").toUpperCase().trim();
  if (!FONTES_VALIDAS.has(fonte)) {
    return res.status(400).json({ ok: false, message: "Fonte de recurso inválida." });
  }

  const descLimpa = String(descricao || "").trim();
  if (!descLimpa) {
    return res.status(400).json({ ok: false, message: "Informe a descrição da entrada de recurso." });
  }

  const custeioCents = toCents(valor_custeio);
  const capitalCents = toCents(valor_capital);

  if (custeioCents < 0 || capitalCents < 0 || custeioCents + capitalCents <= 0) {
    return res.status(400).json({
      ok: false,
      message: "Informe um valor maior que zero em Custeio e/ou Capital.",
    });
  }

  const ano = parseExercicio(exercicio || String(data_entrada || "").slice(0, 4));
  const dataIso = normalizarDataIso(data_entrada);
  const criadoPor = getUsuarioLabel(req);

  try {
    await ensureFinanceiroTables(db);

    const [result] = await db.query(
      `INSERT INTO financeiro_pdaf_entradas (
        escola_id, exercicio, data_entrada, fonte_recurso,
        descricao, referencia_doc, valor_custeio, valor_capital,
        observacoes, criado_por
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        escolaId,
        ano,
        dataIso,
        fonte,
        descLimpa,
        referencia_doc ? String(referencia_doc).trim() : null,
        centsToDecimal(custeioCents),
        centsToDecimal(capitalCents),
        observacoes ? String(observacoes).trim() : null,
        criadoPor,
      ]
    );

    return res.status(201).json({
      ok: true,
      id: result.insertId,
      message: "Entrada de recurso registrada com sucesso.",
    });
  } catch (err) {
    console.error("[FINANCEIRO][POST /pdaf/entradas]", err);
    return res.status(500).json({ ok: false, message: "Erro ao registrar entrada de recurso." });
  }
});

// ── PUT /api/financeiro/pdaf/entradas/:id ───────────────────────────────────
router.put("/pdaf/entradas/:id", async (req, res) => {
  const db = req.db || pool;
  const escolaId = getEscolaId(req);
  const id = Number(req.params.id);

  if (!escolaId || !id) {
    return res.status(400).json({ ok: false, message: "Parâmetros inválidos." });
  }

  const {
    exercicio,
    data_entrada,
    fonte_recurso,
    descricao,
    referencia_doc,
    valor_custeio,
    valor_capital,
    observacoes,
  } = req.body || {};

  const fonte = String(fonte_recurso || "ORDINARIO").toUpperCase().trim();
  if (!FONTES_VALIDAS.has(fonte)) {
    return res.status(400).json({ ok: false, message: "Fonte de recurso inválida." });
  }

  const descLimpa = String(descricao || "").trim();
  if (!descLimpa) {
    return res.status(400).json({ ok: false, message: "Informe a descrição da entrada de recurso." });
  }

  const custeioCents = toCents(valor_custeio);
  const capitalCents = toCents(valor_capital);

  if (custeioCents < 0 || capitalCents < 0 || custeioCents + capitalCents <= 0) {
    return res.status(400).json({
      ok: false,
      message: "Informe um valor maior que zero em Custeio e/ou Capital.",
    });
  }

  const ano = parseExercicio(exercicio || String(data_entrada || "").slice(0, 4));
  const dataIso = normalizarDataIso(data_entrada);

  try {
    await ensureFinanceiroTables(db);

    const [result] = await db.query(
      `UPDATE financeiro_pdaf_entradas
       SET exercicio = ?, data_entrada = ?, fonte_recurso = ?,
           descricao = ?, referencia_doc = ?,
           valor_custeio = ?, valor_capital = ?, observacoes = ?
       WHERE id = ? AND escola_id = ?`,
      [
        ano,
        dataIso,
        fonte,
        descLimpa,
        referencia_doc ? String(referencia_doc).trim() : null,
        centsToDecimal(custeioCents),
        centsToDecimal(capitalCents),
        observacoes ? String(observacoes).trim() : null,
        id,
        escolaId,
      ]
    );

    if (!result.affectedRows) {
      return res.status(404).json({ ok: false, message: "Registro de entrada não encontrado." });
    }

    return res.json({ ok: true, message: "Entrada de recurso atualizada com sucesso." });
  } catch (err) {
    console.error("[FINANCEIRO][PUT /pdaf/entradas/:id]", err);
    return res.status(500).json({ ok: false, message: "Erro ao atualizar entrada de recurso." });
  }
});

// ── DELETE /api/financeiro/pdaf/entradas/:id ────────────────────────────────
router.delete("/pdaf/entradas/:id", async (req, res) => {
  const db = req.db || pool;
  const escolaId = getEscolaId(req);
  const id = Number(req.params.id);

  if (!escolaId || !id) {
    return res.status(400).json({ ok: false, message: "Parâmetros inválidos." });
  }

  try {
    await ensureFinanceiroTables(db);
    const [result] = await db.query(
      "DELETE FROM financeiro_pdaf_entradas WHERE id = ? AND escola_id = ?",
      [id, escolaId]
    );

    if (!result.affectedRows) {
      return res.status(404).json({ ok: false, message: "Registro não encontrado." });
    }

    return res.json({ ok: true, message: "Entrada removida com sucesso." });
  } catch (err) {
    console.error("[FINANCEIRO][DELETE /pdaf/entradas/:id]", err);
    return res.status(500).json({ ok: false, message: "Erro ao remover entrada." });
  }
});

// ── POST /api/financeiro/pdaf/despesas ──────────────────────────────────────
router.post("/pdaf/despesas", async (req, res) => {
  const db = req.db || pool;
  const escolaId = getEscolaId(req);
  if (!escolaId) {
    return res.status(400).json({ ok: false, message: "escola_id é obrigatório." });
  }

  const {
    exercicio,
    compra,
    data_pagamento,
    ordem_servico_orcamentos,
    fornecedor,
    cnpj_cpf,
    descricao_geral,
    fonte_recurso,
    processo_incorporacao,
    valor_custeio,
    valor_capital,
    observacoes,
  } = req.body || {};

  const compraLimpa = String(compra || "").trim();
  const fornecedorLimpo = String(fornecedor || "").trim();
  const descricaoLimpa = String(descricao_geral || "").trim();
  const fonte = String(fonte_recurso || "ORDINARIO").toUpperCase().trim();

  if (!compraLimpa || !fornecedorLimpo || !descricaoLimpa) {
    return res.status(400).json({
      ok: false,
      message: "Preencha os campos obrigatórios: Compra, Fornecedor e Descrição Geral.",
    });
  }

  if (!FONTES_VALIDAS.has(fonte)) {
    return res.status(400).json({ ok: false, message: "Fonte de recurso inválida." });
  }

  const custeioCents = toCents(valor_custeio);
  const capitalCents = toCents(valor_capital);

  if (custeioCents < 0 || capitalCents < 0 || custeioCents + capitalCents <= 0) {
    return res.status(400).json({
      ok: false,
      message: "Informe um valor maior que zero em Custeio e/ou Capital.",
    });
  }

  const ano = parseExercicio(exercicio || String(data_pagamento || "").slice(0, 4));
  const dataIso = normalizarDataIso(data_pagamento);
  const criadoPor = getUsuarioLabel(req);

  try {
    await ensureFinanceiroTables(db);

    const [result] = await db.query(
      `INSERT INTO financeiro_pdaf_despesas (
        escola_id, exercicio, compra, data_pagamento,
        ordem_servico_orcamentos, fornecedor, cnpj_cpf,
        descricao_geral, fonte_recurso, processo_incorporacao,
        valor_custeio, valor_capital, observacoes, criado_por
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        escolaId,
        ano,
        compraLimpa,
        dataIso,
        ordem_servico_orcamentos ? String(ordem_servico_orcamentos).trim() : null,
        fornecedorLimpo,
        cnpj_cpf ? String(cnpj_cpf).trim() : null,
        descricaoLimpa,
        fonte,
        processo_incorporacao ? String(processo_incorporacao).trim() : null,
        centsToDecimal(custeioCents),
        centsToDecimal(capitalCents),
        observacoes ? String(observacoes).trim() : null,
        criadoPor,
      ]
    );

    return res.status(201).json({
      ok: true,
      id: result.insertId,
      message: "Compra/despesa registrada com sucesso.",
    });
  } catch (err) {
    console.error("[FINANCEIRO][POST /pdaf/despesas]", err);
    return res.status(500).json({ ok: false, message: "Erro ao registrar compra/despesa." });
  }
});

// ── PUT /api/financeiro/pdaf/despesas/:id ───────────────────────────────────
router.put("/pdaf/despesas/:id", async (req, res) => {
  const db = req.db || pool;
  const escolaId = getEscolaId(req);
  const id = Number(req.params.id);

  if (!escolaId || !id) {
    return res.status(400).json({ ok: false, message: "Parâmetros inválidos." });
  }

  const {
    exercicio,
    compra,
    data_pagamento,
    ordem_servico_orcamentos,
    fornecedor,
    cnpj_cpf,
    descricao_geral,
    fonte_recurso,
    processo_incorporacao,
    valor_custeio,
    valor_capital,
    observacoes,
  } = req.body || {};

  const compraLimpa = String(compra || "").trim();
  const fornecedorLimpo = String(fornecedor || "").trim();
  const descricaoLimpa = String(descricao_geral || "").trim();
  const fonte = String(fonte_recurso || "ORDINARIO").toUpperCase().trim();

  if (!compraLimpa || !fornecedorLimpo || !descricaoLimpa) {
    return res.status(400).json({
      ok: false,
      message: "Preencha os campos obrigatórios: Compra, Fornecedor e Descrição Geral.",
    });
  }

  if (!FONTES_VALIDAS.has(fonte)) {
    return res.status(400).json({ ok: false, message: "Fonte de recurso inválida." });
  }

  const custeioCents = toCents(valor_custeio);
  const capitalCents = toCents(valor_capital);

  if (custeioCents < 0 || capitalCents < 0 || custeioCents + capitalCents <= 0) {
    return res.status(400).json({
      ok: false,
      message: "Informe um valor maior que zero em Custeio e/ou Capital.",
    });
  }

  const ano = parseExercicio(exercicio || String(data_pagamento || "").slice(0, 4));
  const dataIso = normalizarDataIso(data_pagamento);

  try {
    await ensureFinanceiroTables(db);

    const [result] = await db.query(
      `UPDATE financeiro_pdaf_despesas
       SET exercicio = ?, compra = ?, data_pagamento = ?,
           ordem_servico_orcamentos = ?, fornecedor = ?, cnpj_cpf = ?,
           descricao_geral = ?, fonte_recurso = ?, processo_incorporacao = ?,
           valor_custeio = ?, valor_capital = ?, observacoes = ?
       WHERE id = ? AND escola_id = ?`,
      [
        ano,
        compraLimpa,
        dataIso,
        ordem_servico_orcamentos ? String(ordem_servico_orcamentos).trim() : null,
        fornecedorLimpo,
        cnpj_cpf ? String(cnpj_cpf).trim() : null,
        descricaoLimpa,
        fonte,
        processo_incorporacao ? String(processo_incorporacao).trim() : null,
        centsToDecimal(custeioCents),
        centsToDecimal(capitalCents),
        observacoes ? String(observacoes).trim() : null,
        id,
        escolaId,
      ]
    );

    if (!result.affectedRows) {
      return res.status(404).json({ ok: false, message: "Compra/despesa não encontrada." });
    }

    return res.json({ ok: true, message: "Compra/despesa atualizada com sucesso." });
  } catch (err) {
    console.error("[FINANCEIRO][PUT /pdaf/despesas/:id]", err);
    return res.status(500).json({ ok: false, message: "Erro ao atualizar compra/despesa." });
  }
});

// ── DELETE /api/financeiro/pdaf/despesas/:id ────────────────────────────────
router.delete("/pdaf/despesas/:id", async (req, res) => {
  const db = req.db || pool;
  const escolaId = getEscolaId(req);
  const id = Number(req.params.id);

  if (!escolaId || !id) {
    return res.status(400).json({ ok: false, message: "Parâmetros inválidos." });
  }

  try {
    await ensureFinanceiroTables(db);
    const [result] = await db.query(
      "DELETE FROM financeiro_pdaf_despesas WHERE id = ? AND escola_id = ?",
      [id, escolaId]
    );

    if (!result.affectedRows) {
      return res.status(404).json({ ok: false, message: "Registro não encontrado." });
    }

    return res.json({ ok: true, message: "Compra/despesa removida com sucesso." });
  } catch (err) {
    console.error("[FINANCEIRO][DELETE /pdaf/despesas/:id]", err);
    return res.status(500).json({ ok: false, message: "Erro ao remover compra/despesa." });
  }
});

export default router;
