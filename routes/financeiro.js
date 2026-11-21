// routes/financeiro.js
// ============================================================================
// MÓDULO FINANCEIRO — Motor Contábil Trimestral por Portaria (PDAF / SEEDF)
// Baseado 1:1 na Planilha Oficial UEx / UNIAG:
//   - financeiro_uex_config      : Identificação da Caixa Escolar (Nome UEx, CNPJ, Endereço)
//   - financeiro_pdaf_portarias  : Portarias Ordinárias e Emendas Parlamentares (com carry-over trimestral)
//   - financeiro_pdaf_rendimentos: Saldo reprogramado (mês 0) + rendimentos mensais (meses 1..12)
//   - financeiro_pdaf_despesas   : Compras vinculadas por portaria_id ou RENDIMENTO + rateio (split)
//   - financeiro_pdaf_prestacoes : Máquina de estados Pré-SEI por trimestre (Escola <-> UNIAG CRE)
// ============================================================================

import express from "express";
import crypto from "crypto";
import XLSX from "xlsx";
import pool from "../db.js";

const router = express.Router();

const FONTES_VALIDAS = new Set(["ORDINARIO", "EMENDA", "RENDIMENTO"]);
const TIPOS_PORTARIA_VALIDOS = new Set(["ORDINARIO", "EMENDA"]);
const STATUS_BLOQUEADOS_ESCOLA = new Set(["ENVIADO_UNIAG", "EM_ANALISE", "VALIDADO_SEI"]);

export const PERIODOS_TRIMESTRE_LABEL = Object.freeze({
  1: "01/01 a 31/03",
  2: "01/04 a 30/06",
  3: "01/07 a 30/09",
  4: "01/10 a 31/12",
});

let tablesEnsured = false;

async function safeAddColumn(dbConn, table, column, definition) {
  try {
    const [cols] = await dbConn.query(
      `SELECT COLUMN_NAME
       FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [table, column]
    );
    if (!cols || cols.length === 0) {
      await dbConn.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  } catch (err) {
    console.warn(`[FINANCEIRO][MIGRATION] Aviso ao adicionar ${table}.${column}:`, err?.message);
  }
}

export async function ensureFinanceiroTables(dbConn = pool) {
  if (tablesEnsured) return;
  try {
    // 1) Cabeçalho da Unidade Executora (Caixa Escolar)
    await dbConn.query(`
      CREATE TABLE IF NOT EXISTS financeiro_uex_config (
        escola_id      INT NOT NULL,
        nome_uex       VARCHAR(255) NOT NULL,
        cnpj           VARCHAR(30) DEFAULT NULL,
        endereco       VARCHAR(255) DEFAULT NULL,
        atualizado_por VARCHAR(200) DEFAULT NULL,
        atualizado_em  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (escola_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // 2) Portarias de Liberação de Verba (PDAF Ordinário e Emendas Parlamentares)
    await dbConn.query(`
      CREATE TABLE IF NOT EXISTS financeiro_pdaf_portarias (
        id                      INT UNSIGNED NOT NULL AUTO_INCREMENT,
        escola_id               INT NOT NULL,
        exercicio               INT NOT NULL,
        tipo                    ENUM('ORDINARIO', 'EMENDA') NOT NULL DEFAULT 'ORDINARIO',
        numero_portaria         VARCHAR(40) NOT NULL,
        titulo_portaria         VARCHAR(160) DEFAULT NULL,
        data_portaria           DATE DEFAULT NULL,
        eh_reprogramado         TINYINT(1) NOT NULL DEFAULT 0,
        trimestre_entrada       TINYINT NOT NULL DEFAULT 1,
        credito_custeio         DECIMAL(14,2) NOT NULL DEFAULT 0.00,
        credito_capital         DECIMAL(14,2) NOT NULL DEFAULT 0.00,
        deputado                VARCHAR(180) DEFAULT NULL,
        processo_sei_liberacao  VARCHAR(140) DEFAULT NULL,
        data_pagamento_credito  DATE DEFAULT NULL,
        destinacao_oficio       TEXT DEFAULT NULL,
        observacoes             TEXT DEFAULT NULL,
        criado_por              VARCHAR(200) DEFAULT NULL,
        criado_em               DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        atualizado_em           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uk_fin_pdaf_portaria (escola_id, exercicio, numero_portaria),
        INDEX idx_fin_pdaf_port_escola_ano (escola_id, exercicio, tipo)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // 3) Rendimentos de Aplicação Financeira (mês 0 = reprogramado ano anterior; 1..12 = meses do exercício)
    await dbConn.query(`
      CREATE TABLE IF NOT EXISTS financeiro_pdaf_rendimentos (
        id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
        escola_id      INT NOT NULL,
        exercicio      INT NOT NULL,
        mes            TINYINT NOT NULL COMMENT '0 = Saldo Reprogramado Ano Anterior; 1..12 = Jan..Dez',
        valor          DECIMAL(14,2) NOT NULL DEFAULT 0.00,
        observacoes    VARCHAR(255) DEFAULT NULL,
        atualizado_por VARCHAR(200) DEFAULT NULL,
        atualizado_em  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uk_fin_pdaf_rend (escola_id, exercicio, mes),
        INDEX idx_fin_pdaf_rend_escola_ano (escola_id, exercicio)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // 4) Tabela legada de entradas (mantida para integridade retrocompatível)
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
        INDEX idx_fin_pdaf_ent_escola_ano (escola_id, exercicio)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // 5) Despesas e Compras Executadas no PDAF
    await dbConn.query(`
      CREATE TABLE IF NOT EXISTS financeiro_pdaf_despesas (
        id                       INT UNSIGNED NOT NULL AUTO_INCREMENT,
        escola_id                INT NOT NULL,
        exercicio                INT NOT NULL,
        trimestre                TINYINT NOT NULL DEFAULT 1,
        portaria_id              INT UNSIGNED DEFAULT NULL,
        compra                   VARCHAR(80) NOT NULL,
        data_pagamento           DATE NOT NULL,
        documento_fiscal         VARCHAR(80) DEFAULT NULL,
        ordem_servico_orcamentos VARCHAR(180) DEFAULT NULL,
        fornecedor               VARCHAR(255) NOT NULL,
        cnpj_cpf                 VARCHAR(30) DEFAULT NULL,
        descricao_geral          TEXT NOT NULL,
        fonte_recurso            ENUM('ORDINARIO', 'EMENDA', 'RENDIMENTO') NOT NULL DEFAULT 'ORDINARIO',
        processo_incorporacao    VARCHAR(140) DEFAULT NULL,
        valor_custeio            DECIMAL(14,2) NOT NULL DEFAULT 0.00,
        valor_capital            DECIMAL(14,2) NOT NULL DEFAULT 0.00,
        grupo_rateio_uid         VARCHAR(64) DEFAULT NULL,
        observacoes              TEXT DEFAULT NULL,
        criado_por               VARCHAR(200) DEFAULT NULL,
        criado_em                DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        atualizado_em            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        INDEX idx_fin_pdaf_desp_escola_ano (escola_id, exercicio, trimestre, data_pagamento),
        INDEX idx_fin_pdaf_desp_portaria (portaria_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await safeAddColumn(dbConn, "financeiro_pdaf_despesas", "trimestre", "TINYINT NOT NULL DEFAULT 1 AFTER exercicio");
    await safeAddColumn(dbConn, "financeiro_pdaf_despesas", "portaria_id", "INT UNSIGNED DEFAULT NULL AFTER trimestre");
    await safeAddColumn(dbConn, "financeiro_pdaf_despesas", "documento_fiscal", "VARCHAR(80) DEFAULT NULL AFTER data_pagamento");
    await safeAddColumn(dbConn, "financeiro_pdaf_despesas", "grupo_rateio_uid", "VARCHAR(64) DEFAULT NULL AFTER valor_capital");

    try {
      await dbConn.query(`
        UPDATE financeiro_pdaf_despesas
           SET trimestre = QUARTER(data_pagamento)
         WHERE data_pagamento IS NOT NULL
           AND (trimestre IS NULL OR trimestre NOT IN (1, 2, 3, 4))
      `);
    } catch {}

    // 6) Controle de Remessas Trimestrais Pré-SEI (Escola <-> CRE UNIAG)
    await dbConn.query(`
      CREATE TABLE IF NOT EXISTS financeiro_pdaf_prestacoes (
        id                     INT UNSIGNED NOT NULL AUTO_INCREMENT,
        escola_id              INT NOT NULL,
        exercicio              INT NOT NULL,
        trimestre              TINYINT NOT NULL,
        status                 ENUM('EM_ELABORACAO', 'ENVIADO_UNIAG', 'EM_ANALISE', 'EM_DILIGENCIA', 'VALIDADO_SEI') NOT NULL DEFAULT 'EM_ELABORACAO',
        processo_sei_prestacao VARCHAR(140) DEFAULT NULL,
        observacoes_escola     TEXT DEFAULT NULL,
        parecer_uniag          TEXT DEFAULT NULL,
        enviado_por            VARCHAR(200) DEFAULT NULL,
        enviado_em             DATETIME DEFAULT NULL,
        analisado_por          VARCHAR(200) DEFAULT NULL,
        analisado_em           DATETIME DEFAULT NULL,
        atualizado_em          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uk_fin_pdaf_prest_tri (escola_id, exercicio, trimestre),
        INDEX idx_fin_pdaf_prest_status (exercicio, trimestre, status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    tablesEnsured = true;
  } catch (err) {
    console.error("[FINANCEIRO][ENSURE_TABLES] Erro:", err?.message || err);
  }
}

// ── Helpers Utilitários & Monetários ────────────────────────────────────────
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

export function parseExercicio(val) {
  const anoAtual = new Date().getFullYear();
  const n = Number(val);
  if (Number.isInteger(n) && n >= 2020 && n <= 2100) return n;
  return anoAtual;
}

function parseTrimestre(val, fallbackDateIso = null) {
  const t = Number(val);
  if ([1, 2, 3, 4].includes(t)) return t;
  if (fallbackDateIso && /^\d{4}-\d{2}-\d{2}$/.test(String(fallbackDateIso).slice(0, 10))) {
    const mes = Number(String(fallbackDateIso).slice(5, 7));
    if (mes >= 1 && mes <= 12) return Math.ceil(mes / 3);
  }
  return 1;
}

function normalizarDataIso(val, allowNull = false) {
  if (!val && allowNull) return null;
  const s = String(val || "").trim().slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return allowNull ? null : new Date().toISOString().slice(0, 10);
}

export function toCents(val) {
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

export function centsToDecimal(cents) {
  const safe = Math.abs(cents) === 0 ? 0 : cents;
  return Number((safe / 100).toFixed(2));
}

function formatarDataCurtaBR(iso) {
  if (!iso) return "";
  const s = String(iso).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const [y, m, d] = s.split("-");
  return `${d}/${m}/${y}`;
}

function montarTituloPadraoPortaria(numeroPortaria, dataIso) {
  const numLimpo = String(numeroPortaria || "").trim();
  const parteNum = numLimpo.includes("/") ? numLimpo.split("/")[0] : numLimpo;
  const dtBr = formatarDataCurtaBR(dataIso);
  if (dtBr) return `PORT ${parteNum} - ${dtBr}`;
  return `PORT ${numLimpo}`;
}

async function verificarTrimestreBloqueado(db, escolaId, exercicio, trimestreAlvo) {
  const [[row]] = await db.query(
    `SELECT trimestre, status
       FROM financeiro_pdaf_prestacoes
      WHERE escola_id = ?
        AND exercicio = ?
        AND trimestre >= ?
        AND status IN ('ENVIADO_UNIAG', 'EM_ANALISE', 'VALIDADO_SEI')
      ORDER BY trimestre ASC
      LIMIT 1`,
    [escolaId, exercicio, trimestreAlvo]
  );
  if (!row) return null;
  const st = String(row.status || "").toUpperCase();
  return STATUS_BLOQUEADOS_ESCOLA.has(st)
    ? `${row.trimestre}º Trimestre (${st})`
    : null;
}

// ══════════════════════════════════════════════════════════════════════════════
// MOTOR CONTÁBIL TRIMESTRAL COM TRANSPORTE DE SALDO (CARRY-OVER 1º -> 4º TRI)
// Exportado para uso idêntico tanto na Escola quanto na Auditoria CRE / UNIAG
// ══════════════════════════════════════════════════════════════════════════════
export function calcularExercicioCompletoPdaf({
  exercicio,
  uex,
  portarias = [],
  rendimentosMap = {},
  despesas = [],
  prestacoesMap = {},
}) {
  // Normaliza mapa de rendimentos (0 = reprogramado ano anterior; 1..12 = meses)
  const rendCents = {};
  for (let m = 0; m <= 12; m++) {
    rendCents[m] = toCents(rendimentosMap[m] || 0);
  }

  // Ordena portarias de forma determinística (reprogramadas primeiro, depois data/id)
  const portariasOrd = [...portarias].sort((a, b) => {
    if (Number(b.eh_reprogramado || 0) !== Number(a.eh_reprogramado || 0)) {
      return Number(b.eh_reprogramado || 0) - Number(a.eh_reprogramado || 0);
    }
    const da = String(a.data_portaria || "");
    const db = String(b.data_portaria || "");
    if (da !== db) return da.localeCompare(db);
    return Number(a.id || 0) - Number(b.id || 0);
  });

  // Estado acumulado de carry-over entre trimestres
  const saldoAnteriorPortaria = new Map(); // portaria_id -> { custeio_cents, capital_cents }
  let saldoRendimentoAnteriorCents = rendCents[0];

  const trimestres = {};

  for (let tri = 1; tri <= 4; tri++) {
    const despesasTri = despesas.filter((d) => parseTrimestre(d.trimestre, d.data_pagamento) === tri);

    // Soma despesas por portaria_id no trimestre
    const gastosPorPortaria = new Map();
    let gastosRendCusteioCents = 0;
    let gastosRendCapitalCents = 0;
    let gastosSemPortariaOrdinarioCents = { custeio: 0, capital: 0 };
    let gastosSemPortariaEmendaCents = { custeio: 0, capital: 0 };

    for (const d of despesasTri) {
      const cust = toCents(d.valor_custeio);
      const cap = toCents(d.valor_capital);
      const pid = d.portaria_id ? Number(d.portaria_id) : null;

      if (d.fonte_recurso === "RENDIMENTO") {
        gastosRendCusteioCents += cust;
        gastosRendCapitalCents += cap;
      } else if (pid && pid > 0) {
        const cur = gastosPorPortaria.get(pid) || { custeio: 0, capital: 0 };
        cur.custeio += cust;
        cur.capital += cap;
        gastosPorPortaria.set(pid, cur);
      } else if (d.fonte_recurso === "EMENDA") {
        gastosSemPortariaEmendaCents.custeio += cust;
        gastosSemPortariaEmendaCents.capital += cap;
      } else {
        gastosSemPortariaOrdinarioCents.custeio += cust;
        gastosSemPortariaOrdinarioCents.capital += cap;
      }
    }

    const linhasOrdinario = [];
    const linhasEmenda = [];

    const totOrd = {
      credito_custeio: 0,
      credito_capital: 0,
      despesa_custeio: 0,
      despesa_capital: 0,
      saldo_custeio: 0,
      saldo_capital: 0,
      saldo_total: 0,
    };
    const totEme = {
      credito_custeio: 0,
      credito_capital: 0,
      despesa_custeio: 0,
      despesa_capital: 0,
      saldo_custeio: 0,
      saldo_capital: 0,
      saldo_total: 0,
    };

    for (const p of portariasOrd) {
      const pid = Number(p.id);
      const triEntrada = Number(p.eh_reprogramado) === 1 ? 1 : parseTrimestre(p.trimestre_entrada, p.data_portaria);

      // Portarias liberadas em trimestres futuros ainda não compõem o trimestre atual
      if (triEntrada > tri) continue;

      let credCusteioCents = 0;
      let credCapitalCents = 0;
      let origemCredito = "LIBERACAO_TRIMESTRE";

      if (triEntrada === tri) {
        credCusteioCents = toCents(p.credito_custeio);
        credCapitalCents = toCents(p.credito_capital);
        origemCredito = Number(p.eh_reprogramado) === 1 ? "REPROGRAMADO_ANO_ANTERIOR" : "NOVA_PORTARIA";
      } else {
        const prev = saldoAnteriorPortaria.get(pid) || { custeio: 0, capital: 0 };
        credCusteioCents = prev.custeio;
        credCapitalCents = prev.capital;
        origemCredito = `SALDO_TRI_${tri - 1}`;
      }

      const gasto = gastosPorPortaria.get(pid) || { custeio: 0, capital: 0 };
      const saldoCustCents = credCusteioCents - gasto.custeio;
      const saldoCapCents = credCapitalCents - gasto.capital;
      const saldoTotCents = saldoCustCents + saldoCapCents;

      // Salva saldo final para alimentar automaticamente o próximo trimestre (T+1)
      saldoAnteriorPortaria.set(pid, {
        custeio: saldoCustCents,
        capital: saldoCapCents,
      });

      const linha = {
        portaria_id: pid,
        tipo: p.tipo,
        numero_portaria: p.numero_portaria,
        titulo_portaria: p.titulo_portaria || montarTituloPadraoPortaria(p.numero_portaria, p.data_portaria),
        data_portaria: p.data_portaria,
        eh_reprogramado: Boolean(p.eh_reprogramado),
        trimestre_entrada: triEntrada,
        origem_credito: origemCredito,
        deputado: p.deputado || null,
        processo_sei_liberacao: p.processo_sei_liberacao || null,
        destinacao_oficio: p.destinacao_oficio || null,
        credito_custeio: centsToDecimal(credCusteioCents),
        credito_capital: centsToDecimal(credCapitalCents),
        despesa_custeio: centsToDecimal(gasto.custeio),
        despesa_capital: centsToDecimal(gasto.capital),
        saldo_custeio: centsToDecimal(saldoCustCents),
        saldo_capital: centsToDecimal(saldoCapCents),
        saldo_total: centsToDecimal(saldoTotCents),
      };

      if (p.tipo === "EMENDA") {
        linhasEmenda.push(linha);
        totEme.credito_custeio += credCusteioCents;
        totEme.credito_capital += credCapitalCents;
        totEme.despesa_custeio += gasto.custeio;
        totEme.despesa_capital += gasto.capital;
        totEme.saldo_custeio += saldoCustCents;
        totEme.saldo_capital += saldoCapCents;
        totEme.saldo_total += saldoTotCents;
      } else {
        linhasOrdinario.push(linha);
        totOrd.credito_custeio += credCusteioCents;
        totOrd.credito_capital += credCapitalCents;
        totOrd.despesa_custeio += gasto.custeio;
        totOrd.despesa_capital += gasto.capital;
        totOrd.saldo_custeio += saldoCustCents;
        totOrd.saldo_capital += saldoCapCents;
        totOrd.saldo_total += saldoTotCents;
      }
    }

    // Rendimentos do Trimestre (3 meses + saldo anterior)
    const m1 = (tri - 1) * 3 + 1;
    const m2 = m1 + 1;
    const m3 = m1 + 2;
    const somaMesesTriCents = rendCents[m1] + rendCents[m2] + rendCents[m3];
    const baseAnteriorRendCents = tri === 1 ? rendCents[0] : saldoRendimentoAnteriorCents;
    const creditoRendTriCents = baseAnteriorRendCents + somaMesesTriCents;
    const saldoRendFinalCents =
      creditoRendTriCents - gastosRendCusteioCents - gastosRendCapitalCents;

    saldoRendimentoAnteriorCents = saldoRendFinalCents;

    const saldoTotalRecursosCents =
      totOrd.saldo_total + totEme.saldo_total + saldoRendFinalCents;

    // ── Auditoria Automática de Conformidade Pré-SEI ──
    const pendencias = [];

    if (!uex?.cnpj || String(uex.cnpj).trim().length < 11) {
      pendencias.push({
        nivel: "ERRO",
        codigo: "UEX_SEM_CNPJ",
        mensagem: "Informe o CNPJ da Unidade Executora (Caixa Escolar) no cabeçalho da UEx.",
      });
    }

    for (const l of [...linhasOrdinario, ...linhasEmenda]) {
      if (l.saldo_custeio < -0.005) {
        pendencias.push({
          nivel: "ERRO",
          codigo: "SALDO_PORTARIA_CUSTEIO_NEGATIVO",
          mensagem: `A Portaria ${l.numero_portaria} está com saldo de Custeio negativo (${l.saldo_custeio.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}).`,
        });
      }
      if (l.saldo_capital < -0.005) {
        pendencias.push({
          nivel: "ERRO",
          codigo: "SALDO_PORTARIA_CAPITAL_NEGATIVO",
          mensagem: `A Portaria ${l.numero_portaria} está com saldo de Capital negativo (${l.saldo_capital.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}).`,
        });
      }
    }

    if (centsToDecimal(saldoRendFinalCents) < -0.005) {
      pendencias.push({
        nivel: "ERRO",
        codigo: "SALDO_RENDIMENTO_NEGATIVO",
        mensagem: "O saldo de Rendimentos está negativo neste trimestre. Confira os rendimentos mensais lançados.",
      });
    }

    for (const d of despesasTri) {
      if (d.fonte_recurso !== "RENDIMENTO" && !d.portaria_id) {
        pendencias.push({
          nivel: "ERRO",
          codigo: "DESPESA_SEM_PORTARIA",
          mensagem: `A Compra ${d.compra} (${d.fornecedor}) não está vinculada a uma Portaria específica.`,
        });
      }
      if (!String(d.cnpj_cpf || "").trim()) {
        pendencias.push({
          nivel: "ERRO",
          codigo: "DESPESA_SEM_CNPJ",
          mensagem: `A Compra ${d.compra} (${d.fornecedor}) está sem CNPJ/CPF informado.`,
        });
      }
      if (!String(d.ordem_servico_orcamentos || "").trim()) {
        pendencias.push({
          nivel: "AVISO",
          codigo: "DESPESA_SEM_OS_ORCAMENTOS",
          mensagem: `A Compra ${d.compra} (${d.fornecedor}) está sem Nº de Ordem de Serviço / 3 Orçamentos.`,
        });
      }
      if (Number(d.valor_capital || 0) > 0 && !String(d.processo_incorporacao || "").trim()) {
        pendencias.push({
          nivel: "AVISO",
          codigo: "CAPITAL_SEM_PROCESSO_INCORPORACAO",
          mensagem: `A Compra ${d.compra} (${d.fornecedor}) possui gasto de Capital sem Nº de Processo de Incorporação de Bens.`,
        });
      }
    }

    const prestInfo = prestacoesMap[tri] || null;
    const statusTri = prestInfo?.status || "EM_ELABORACAO";

    trimestres[tri] = {
      trimestre: tri,
      titulo: `${tri}º TRIMESTRE / ${exercicio}`,
      periodo: `${PERIODOS_TRIMESTRE_LABEL[tri]} de ${exercicio}`,
      status: statusTri,
      bloqueado_edicao: STATUS_BLOQUEADOS_ESCOLA.has(statusTri),
      prestacao: prestInfo
        ? {
            status: prestInfo.status,
            processo_sei_prestacao: prestInfo.processo_sei_prestacao || null,
            observacoes_escola: prestInfo.observacoes_escola || null,
            parecer_uniag: prestInfo.parecer_uniag || null,
            enviado_por: prestInfo.enviado_por || null,
            enviado_em: prestInfo.enviado_em || null,
            analisado_por: prestInfo.analisado_por || null,
            analisado_em: prestInfo.analisado_em || null,
          }
        : null,
      saldos_topo: {
        ordinario: centsToDecimal(totOrd.saldo_total),
        emenda: centsToDecimal(totEme.saldo_total),
        rendimento: centsToDecimal(saldoRendFinalCents),
        total_recursos: centsToDecimal(saldoTotalRecursosCents),
      },
      ordinario: {
        linhas: linhasOrdinario,
        totais: {
          credito_custeio: centsToDecimal(totOrd.credito_custeio),
          credito_capital: centsToDecimal(totOrd.credito_capital),
          despesa_custeio: centsToDecimal(totOrd.despesa_custeio),
          despesa_capital: centsToDecimal(totOrd.despesa_capital),
          saldo_custeio: centsToDecimal(totOrd.saldo_custeio),
          saldo_capital: centsToDecimal(totOrd.saldo_capital),
          saldo_total: centsToDecimal(totOrd.saldo_total),
        },
      },
      emendas: {
        linhas: linhasEmenda,
        totais: {
          credito_custeio: centsToDecimal(totEme.credito_custeio),
          credito_capital: centsToDecimal(totEme.credito_capital),
          despesa_custeio: centsToDecimal(totEme.despesa_custeio),
          despesa_capital: centsToDecimal(totEme.despesa_capital),
          saldo_custeio: centsToDecimal(totEme.saldo_custeio),
          saldo_capital: centsToDecimal(totEme.saldo_capital),
          saldo_total: centsToDecimal(totEme.saldo_total),
        },
      },
      rendimentos: {
        saldo_anterior: centsToDecimal(baseAnteriorRendCents),
        eh_reprogramado_base: tri === 1,
        meses: [
          { mes: m1, label: `${String(m1).padStart(2, "0")}/${exercicio}`, valor: centsToDecimal(rendCents[m1]) },
          { mes: m2, label: `${String(m2).padStart(2, "0")}/${exercicio}`, valor: centsToDecimal(rendCents[m2]) },
          { mes: m3, label: `${String(m3).padStart(2, "0")}/${exercicio}`, valor: centsToDecimal(rendCents[m3]) },
        ],
        total_trimestre: centsToDecimal(somaMesesTriCents),
        credito_disponivel: centsToDecimal(creditoRendTriCents),
        despesa_custeio: centsToDecimal(gastosRendCusteioCents),
        despesa_capital: centsToDecimal(gastosRendCapitalCents),
        saldo_final: centsToDecimal(saldoRendFinalCents),
      },
      despesas: despesasTri,
      pendencias,
      pronto_envio_uniag: pendencias.filter((p) => p.nivel === "ERRO").length === 0,
    };
  }

  // Resumo consolidado anual (compatibilidade com cards gerais e visão macro)
  const ordEntCust = portariasOrd
    .filter((p) => p.tipo === "ORDINARIO")
    .reduce((acc, p) => acc + toCents(p.credito_custeio), 0);
  const ordEntCap = portariasOrd
    .filter((p) => p.tipo === "ORDINARIO")
    .reduce((acc, p) => acc + toCents(p.credito_capital), 0);
  const emeEntCust = portariasOrd
    .filter((p) => p.tipo === "EMENDA")
    .reduce((acc, p) => acc + toCents(p.credito_custeio), 0);
  const emeEntCap = portariasOrd
    .filter((p) => p.tipo === "EMENDA")
    .reduce((acc, p) => acc + toCents(p.credito_capital), 0);

  let rendEntTotal = 0;
  for (let m = 0; m <= 12; m++) rendEntTotal += rendCents[m];

  let ordSaiCust = 0, ordSaiCap = 0;
  let emeSaiCust = 0, emeSaiCap = 0;
  let renSaiCust = 0, renSaiCap = 0;

  for (const d of despesas) {
    const c = toCents(d.valor_custeio);
    const k = toCents(d.valor_capital);
    if (d.fonte_recurso === "EMENDA") {
      emeSaiCust += c; emeSaiCap += k;
    } else if (d.fonte_recurso === "RENDIMENTO") {
      renSaiCust += c; renSaiCap += k;
    } else {
      ordSaiCust += c; ordSaiCap += k;
    }
  }

  const buildBucket = (ec, ek, sc, sk, isRendimento = false) => {
    const entTot = ec + ek;
    const saiTot = sc + sk;
    const sCust = isRendimento ? entTot - saiTot : ec - sc;
    const sCap = isRendimento ? 0 : ek - sk;
    return {
      entradas_custeio: centsToDecimal(ec),
      entradas_capital: centsToDecimal(ek),
      entradas_total: centsToDecimal(entTot),
      saidas_custeio: centsToDecimal(sc),
      saidas_capital: centsToDecimal(sk),
      saidas_total: centsToDecimal(saiTot),
      saldo_custeio: centsToDecimal(sCust),
      saldo_capital: centsToDecimal(sCap),
      saldo_total: centsToDecimal(entTot - saiTot),
    };
  };

  const resumo = {
    ordinario: buildBucket(ordEntCust, ordEntCap, ordSaiCust, ordSaiCap),
    emenda: buildBucket(emeEntCust, emeEntCap, emeSaiCust, emeSaiCap),
    rendimento: buildBucket(rendEntTotal, 0, renSaiCust, renSaiCap, true),
    total: {
      entradas_custeio: centsToDecimal(ordEntCust + emeEntCust + rendEntTotal),
      entradas_capital: centsToDecimal(ordEntCap + emeEntCap),
      entradas_total: centsToDecimal(ordEntCust + ordEntCap + emeEntCust + emeEntCap + rendEntTotal),
      saidas_custeio: centsToDecimal(ordSaiCust + emeSaiCust + renSaiCust),
      saidas_capital: centsToDecimal(ordSaiCap + emeSaiCap + renSaiCap),
      saidas_total: centsToDecimal(ordSaiCust + ordSaiCap + emeSaiCust + emeSaiCap + renSaiCust + renSaiCap),
      saldo_custeio: centsToDecimal((ordEntCust - ordSaiCust) + (emeEntCust - emeSaiCust) + (rendEntTotal - renSaiCust - renSaiCap)),
      saldo_capital: centsToDecimal((ordEntCap - ordSaiCap) + (emeEntCap - emeSaiCap)),
      saldo_total: centsToDecimal(
        (ordEntCust + ordEntCap + emeEntCust + emeEntCap + rendEntTotal) -
        (ordSaiCust + ordSaiCap + emeSaiCust + emeSaiCap + renSaiCust + renSaiCap)
      ),
    },
  };

  // Fichas individualizadas das Emendas Parlamentares (para a 5ª aba da planilha SEEDF)
  const fichasEmendas = portariasOrd
    .filter((p) => p.tipo === "EMENDA")
    .map((p) => {
      const pid = Number(p.id);
      const despEmenda = despesas.filter((d) => Number(d.portaria_id) === pid);
      const sCust = despEmenda.reduce((acc, d) => acc + toCents(d.valor_custeio), 0);
      const sCap = despEmenda.reduce((acc, d) => acc + toCents(d.valor_capital), 0);
      const cCust = toCents(p.credito_custeio);
      const cCap = toCents(p.credito_capital);
      return {
        portaria_id: pid,
        numero_portaria: p.numero_portaria,
        titulo_portaria: p.titulo_portaria || montarTituloPadraoPortaria(p.numero_portaria, p.data_portaria),
        data_portaria: p.data_portaria,
        deputado: p.deputado || "",
        processo_sei_liberacao: p.processo_sei_liberacao || "",
        data_pagamento_credito: p.data_pagamento_credito || p.data_portaria || null,
        destinacao_oficio: p.destinacao_oficio || "",
        credito_custeio: centsToDecimal(cCust),
        credito_capital: centsToDecimal(cCap),
        despesa_custeio: centsToDecimal(sCust),
        despesa_capital: centsToDecimal(sCap),
        saldo_custeio: centsToDecimal(cCust - sCust),
        saldo_capital: centsToDecimal(cCap - sCap),
        saldo_total: centsToDecimal((cCust + cCap) - (sCust + sCap)),
        despesas: despEmenda,
      };
    });

  return {
    trimestres,
    resumo,
    fichas_emendas: fichasEmendas,
  };
}

export async function carregarDadosCompletosPdafEscola(db, escolaId, exercicioRaw) {
  await ensureFinanceiroTables(db);
  const exercicio = parseExercicio(exercicioRaw);

  const [
    [escolaRows],
    [uexRows],
    [portariasRows],
    [rendRows],
    [despesasRows],
    [prestRows],
    [anosPort],
    [anosDesp],
  ] = await Promise.all([
    db.query(
      "SELECT id, nome, apelido, cnpj, endereco, cidade, estado FROM escolas WHERE id = ? LIMIT 1",
      [escolaId]
    ),
    db.query(
      "SELECT escola_id, nome_uex, cnpj, endereco, atualizado_por, atualizado_em FROM financeiro_uex_config WHERE escola_id = ? LIMIT 1",
      [escolaId]
    ),
    db.query(
      `SELECT
         id, escola_id, exercicio, tipo, numero_portaria, titulo_portaria,
         DATE_FORMAT(data_portaria, '%Y-%m-%d') AS data_portaria,
         eh_reprogramado, trimestre_entrada,
         credito_custeio, credito_capital,
         deputado, processo_sei_liberacao,
         DATE_FORMAT(data_pagamento_credito, '%Y-%m-%d') AS data_pagamento_credito,
         destinacao_oficio, observacoes, criado_por, criado_em, atualizado_em
       FROM financeiro_pdaf_portarias
       WHERE escola_id = ? AND exercicio = ?
       ORDER BY eh_reprogramado DESC, data_portaria ASC, id ASC`,
      [escolaId, exercicio]
    ),
    db.query(
      `SELECT mes, valor, observacoes, atualizado_por, atualizado_em
         FROM financeiro_pdaf_rendimentos
        WHERE escola_id = ? AND exercicio = ?
        ORDER BY mes ASC`,
      [escolaId, exercicio]
    ),
    db.query(
      `SELECT
         d.id, d.escola_id, d.exercicio, d.trimestre, d.portaria_id,
         p.numero_portaria, p.titulo_portaria,
         d.compra,
         DATE_FORMAT(d.data_pagamento, '%Y-%m-%d') AS data_pagamento,
         d.documento_fiscal,
         d.ordem_servico_orcamentos, d.fornecedor, d.cnpj_cpf,
         d.descricao_geral, d.fonte_recurso, d.processo_incorporacao,
         d.valor_custeio, d.valor_capital, d.grupo_rateio_uid,
         d.observacoes, d.criado_por, d.criado_em, d.atualizado_em
       FROM financeiro_pdaf_despesas d
       LEFT JOIN financeiro_pdaf_portarias p ON p.id = d.portaria_id
       WHERE d.escola_id = ? AND d.exercicio = ?
       ORDER BY d.data_pagamento ASC, d.id ASC`,
      [escolaId, exercicio]
    ),
    db.query(
      `SELECT
         trimestre, status, processo_sei_prestacao,
         observacoes_escola, parecer_uniag,
         enviado_por, enviado_em, analisado_por, analisado_em, atualizado_em
       FROM financeiro_pdaf_prestacoes
       WHERE escola_id = ? AND exercicio = ?`,
      [escolaId, exercicio]
    ),
    db.query("SELECT DISTINCT exercicio FROM financeiro_pdaf_portarias WHERE escola_id = ?", [escolaId]),
    db.query("SELECT DISTINCT exercicio FROM financeiro_pdaf_despesas WHERE escola_id = ?", [escolaId]),
  ]);

  const esc = escolaRows?.[0] || {};
  const uexRow = uexRows?.[0] || null;
  const enderecoPadrao = [esc.endereco, esc.cidade, esc.estado].filter(Boolean).join(" - ");

  const uex = {
    configurada: Boolean(uexRow),
    nome_uex: uexRow?.nome_uex || `CAIXA ESCOLAR — ${esc.apelido || esc.nome || "UNIDADE ESCOLAR"}`,
    cnpj: uexRow?.cnpj || esc.cnpj || "",
    endereco: uexRow?.endereco || enderecoPadrao || "",
    escola_nome: esc.nome || "",
    escola_apelido: esc.apelido || esc.nome || "",
  };

  const portarias = (portariasRows || []).map((p) => ({
    ...p,
    eh_reprogramado: Number(p.eh_reprogramado) === 1,
    trimestre_entrada: Number(p.trimestre_entrada || 1),
    credito_custeio: Number(p.credito_custeio || 0),
    credito_capital: Number(p.credito_capital || 0),
  }));

  const rendimentosMap = {};
  for (let m = 0; m <= 12; m++) rendimentosMap[m] = 0;
  for (const r of rendRows || []) {
    const mesNum = Number(r.mes);
    if (mesNum >= 0 && mesNum <= 12) {
      rendimentosMap[mesNum] = Number(r.valor || 0);
    }
  }

  const despesas = (despesasRows || []).map((d) => ({
    ...d,
    trimestre: parseTrimestre(d.trimestre, d.data_pagamento),
    portaria_id: d.portaria_id ? Number(d.portaria_id) : null,
    fonte_codigo:
      d.fonte_recurso === "RENDIMENTO"
        ? "Rendimentos"
        : d.numero_portaria || d.fonte_recurso,
    valor_custeio: Number(d.valor_custeio || 0),
    valor_capital: Number(d.valor_capital || 0),
  }));

  const prestacoesMap = {};
  for (const pr of prestRows || []) {
    prestacoesMap[Number(pr.trimestre)] = pr;
  }

  const anoAtual = new Date().getFullYear();
  const anosSet = new Set([anoAtual + 1, anoAtual, anoAtual - 1, exercicio]);
  for (const r of anosPort || []) if (r?.exercicio) anosSet.add(Number(r.exercicio));
  for (const r of anosDesp || []) if (r?.exercicio) anosSet.add(Number(r.exercicio));
  const exerciciosDisponiveis = Array.from(anosSet).sort((a, b) => b - a);

  const calculado = calcularExercicioCompletoPdaf({
    exercicio,
    uex,
    portarias,
    rendimentosMap,
    despesas,
    prestacoesMap,
  });

  return {
    ok: true,
    escola_id: escolaId,
    exercicio,
    exercicios_disponiveis: exerciciosDisponiveis,
    uex,
    portarias,
    rendimentos_mensais: rendimentosMap,
    despesas,
    trimestres: calculado.trimestres,
    fichas_emendas: calculado.fichas_emendas,
    resumo: calculado.resumo,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// GERADOR OFICIAL DO ARQUIVO EXCEL DE 5 ABAS (PADRÃO SEEDF / UNIAG / SEI)
// Exportado para uso idêntico tanto na Escola quanto na Auditoria CRE / UNIAG
// ══════════════════════════════════════════════════════════════════════════════
export function gerarBufferPlanilhaPdaf(dadosPdaf) {
  const exercicio = Number(dadosPdaf?.exercicio || new Date().getFullYear());
  const uex = dadosPdaf?.uex || {};
  const wb = XLSX.utils.book_new();

  const datasPeriodoCompleto = {
    1: `01/01/${exercicio} a 31/03/${exercicio}`,
    2: `01/04/${exercicio} a 30/06/${exercicio}`,
    3: `01/07/${exercicio} a 30/09/${exercicio}`,
    4: `01/10/${exercicio} a 31/12/${exercicio}`,
  };

  // Abas 1 a 4: 1º ao 4º Trimestre
  for (let tri = 1; tri <= 4; tri++) {
    const tData = dadosPdaf?.trimestres?.[tri] || {};
    const rows = [];

    // Cabeçalho Institucional UEx (Linhas 1 a 6)
    rows.push(["", "IDENTIFICAÇÃO"]);
    rows.push([
      "",
      `UNIDADE EXECUTORA: ${uex.nome_uex || ""}`,
      "",
      "",
      "",
      "",
      "",
      `${tri}º TRIMESTRE/ ${exercicio}`,
    ]);
    rows.push([
      "",
      `CNPJ: ${uex.cnpj || ""}`,
      "",
      "",
      "",
      "",
      "",
      datasPeriodoCompleto[tri],
    ]);
    rows.push(["", `ENDEREÇO: ${uex.endereco || ""}`]);
    rows.push([
      "",
      "SALDO PDAF ORDINÁRIO",
      "",
      "SALDO EMENDA PARLAMENTAR",
      "",
      "SALDO RENDIMENTO",
      "",
      "SALDO TOTAL RECURSOS",
    ]);
    rows.push([
      "",
      Number(tData?.saldos_topo?.ordinario || 0),
      "",
      Number(tData?.saldos_topo?.emenda || 0),
      "",
      Number(tData?.saldos_topo?.rendimento || 0),
      "",
      Number(tData?.saldos_topo?.total_recursos || 0),
    ]);

    // Quadro lateral de Rendimentos (Colunas L e M = índices 11 e 12)
    const mesesRend = tData?.rendimentos?.meses || [];
    const lateralRend = [
      ["RENDIMENTOS", ""],
      [
        tri === 1 ? `REND ${exercicio - 1}` : `SALDO ${tri - 1}º TRI`,
        Number(tData?.rendimentos?.saldo_anterior || 0),
      ],
      ["MÊS", "VALOR"],
      [mesesRend[0]?.label || "", Number(mesesRend[0]?.valor || 0)],
      [mesesRend[1]?.label || "", Number(mesesRend[1]?.valor || 0)],
      [mesesRend[2]?.label || "", Number(mesesRend[2]?.valor || 0)],
      ["SUBTOTAL TRIMESTRE", Number(tData?.rendimentos?.total_trimestre || 0)],
      ["TOTAL RENDIMENTOS", Number(tData?.rendimentos?.credito_disponivel || 0)],
    ];

    // Seção PDAF ORDINÁRIO
    rows.push(["", "PDAF ORDINÁRIO"]);
    rows.push([
      "CÓDIGO",
      "PORTARIA",
      "CRÉDITO CUSTEIO",
      "CRÉDITO CAPITAL",
      "DESPESA CUSTEIO",
      "DESPESA CAPITAL",
      "SALDO CUSTEIO",
      "SALDO CAPITAL",
      "Total Geral ORDINÁRIO",
      "",
      "",
      lateralRend[0][0],
      lateralRend[0][1],
    ]);

    const ordLinhas = tData?.ordinario?.linhas || [];
    const totalSlotsOrd = Math.max(5, ordLinhas.length);
    for (let i = 0; i < totalSlotsOrd; i++) {
      const l = ordLinhas[i];
      const lat = lateralRend[i + 1] || ["", ""];
      if (l) {
        rows.push([
          l.numero_portaria,
          l.titulo_portaria,
          Number(l.credito_custeio || 0),
          Number(l.credito_capital || 0),
          Number(l.despesa_custeio || 0),
          Number(l.despesa_capital || 0),
          Number(l.saldo_custeio || 0),
          Number(l.saldo_capital || 0),
          Number(l.saldo_total || 0),
          "",
          "",
          lat[0],
          lat[1],
        ]);
      } else {
        rows.push(["", "", 0, 0, 0, 0, 0, 0, 0, "", "", lat[0], lat[1]]);
      }
    }

    const latTotalOrd = lateralRend[totalSlotsOrd + 1] || ["", ""];
    const ordTot = tData?.ordinario?.totais || {};
    rows.push([
      "",
      "TOTAL",
      Number(ordTot.credito_custeio || 0),
      Number(ordTot.credito_capital || 0),
      Number(ordTot.despesa_custeio || 0),
      Number(ordTot.despesa_capital || 0),
      Number(ordTot.saldo_custeio || 0),
      Number(ordTot.saldo_capital || 0),
      Number(ordTot.saldo_total || 0),
      "",
      "",
      latTotalOrd[0],
      latTotalOrd[1],
    ]);

    // Seção EMENDAS PARLAMENTAR
    const latRestante = lateralRend[totalSlotsOrd + 2] || ["", ""];
    rows.push(["", "EMENDAS PARLAMENTAR", "", "", "", "", "", "", "", "", "", latRestante[0], latRestante[1]]);
    rows.push([
      "Comentário",
      "PORTARIA",
      "CRÉDITO CUSTEIO",
      "CRÉDITO CAPITAL",
      "DESPESA CUSTEIO",
      "DESPESA CAPITAL",
      "SALDO CUSTEIO",
      "SALDO CAPITAL",
      "Total Geral PARLAMENTAR",
    ]);

    const emeLinhas = tData?.emendas?.linhas || [];
    const totalSlotsEme = Math.max(3, emeLinhas.length);
    for (let i = 0; i < totalSlotsEme; i++) {
      const l = emeLinhas[i];
      if (l) {
        rows.push([
          l.numero_portaria,
          l.titulo_portaria,
          Number(l.credito_custeio || 0),
          Number(l.credito_capital || 0),
          Number(l.despesa_custeio || 0),
          Number(l.despesa_capital || 0),
          Number(l.saldo_custeio || 0),
          Number(l.saldo_capital || 0),
          Number(l.saldo_total || 0),
        ]);
      } else {
        rows.push(["", "", 0, 0, 0, 0, 0, 0, 0]);
      }
    }

    const emeTot = tData?.emendas?.totais || {};
    rows.push([
      "",
      "TOTAL",
      Number(emeTot.credito_custeio || 0),
      Number(emeTot.credito_capital || 0),
      Number(emeTot.despesa_custeio || 0),
      Number(emeTot.despesa_capital || 0),
      Number(emeTot.saldo_custeio || 0),
      Number(emeTot.saldo_capital || 0),
      Number(emeTot.saldo_total || 0),
    ]);

    // Seção Resumo de RENDIMENTOS (Linha 22-24 do modelo oficial)
    rows.push(["", "RENDIMENTOS"]);
    rows.push([
      "",
      "PORTARIA",
      "CRÉDITO",
      "",
      "DESPESA CUSTEIO",
      "DESPESA CAPITAL",
      "SALDO RENDIMENTO",
    ]);
    rows.push([
      "",
      "Rendimentos",
      Number(tData?.rendimentos?.credito_disponivel || 0),
      "",
      Number(tData?.rendimentos?.despesa_custeio || 0),
      Number(tData?.rendimentos?.despesa_capital || 0),
      Number(tData?.rendimentos?.saldo_final || 0),
    ]);

    // Seção RELAÇÃO DE DESPESAS REALIZADAS NO TRIMESTRE
    rows.push(["", `RELAÇÃO DE DESPESAS REALIZADAS - ${tri}º TRIMESTRE`]);
    rows.push([
      "COMPRA",
      "DATA PAGAMENTO",
      "Nº ORDEM SERVIÇO/ 3 ORÇAMENTOS",
      "FORNECEDOR",
      "CNPJ/CPF",
      "DESCRIÇÃO GERAL DA COMPRA",
      "FONTE/RECURSO",
      "Nº PROCESSO INCORPORAÇÃO DE BENS",
      "Custeio",
      "Capital",
    ]);

    const despTri = tData?.despesas || [];
    let somaDespCust = 0;
    let somaDespCap = 0;
    for (const d of despTri) {
      const vc = Number(d.valor_custeio || 0);
      const vk = Number(d.valor_capital || 0);
      somaDespCust += vc;
      somaDespCap += vk;
      rows.push([
        d.compra || "",
        formatarDataCurtaBR(d.data_pagamento),
        d.ordem_servico_orcamentos || "",
        d.fornecedor || "",
        d.cnpj_cpf || "",
        d.descricao_geral || "",
        d.fonte_codigo || d.fonte_recurso || "",
        d.processo_incorporacao || "",
        vc,
        vk,
      ]);
    }

    rows.push([
      "",
      "TOTAL DESPESAS DO TRIMESTRE",
      "",
      "",
      "",
      "",
      "",
      "",
      Number(somaDespCust.toFixed(2)),
      Number(somaDespCap.toFixed(2)),
    ]);

    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws["!cols"] = [
      { wch: 13 },
      { wch: 28 },
      { wch: 22 },
      { wch: 26 },
      { wch: 20 },
      { wch: 30 },
      { wch: 16 },
      { wch: 24 },
      { wch: 18 },
      { wch: 16 },
      { wch: 4 },
      { wch: 18 },
      { wch: 16 },
    ];
    XLSX.utils.book_append_sheet(wb, ws, `${tri}º TRIMESTRE ${exercicio}`);
  }

  // 5ª Aba: EMENDA PARLAMENTAR YYYY
  const rowsEme = [];
  const fichas = dadosPdaf?.fichas_emendas || [];

  if (fichas.length === 0) {
    rowsEme.push(["IDENTIFICAÇÃO"]);
    rowsEme.push([`UNIDADE EXECUTORA: ${uex.nome_uex || ""}`, "", "", "", "", "", "", `PORTARIA`]);
    rowsEme.push([`CNPJ: ${uex.cnpj || ""}`, "", "", "", "", "", "", `SEM EMENDAS EM ${exercicio}`]);
    rowsEme.push([`ENDEREÇO: ${uex.endereco || ""}`]);
    rowsEme.push(["DEPUTADO: —"]);
    rowsEme.push(["PROCESSO DE LIBERAÇÃO DO RECURSO: —"]);
    rowsEme.push(["DATA DO PAGAMENTO: —"]);
    rowsEme.push(["DESTINAÇÃO DO RECURSO (OFÍCIO DO DEPUTADO): —"]);
  } else {
    fichas.forEach((f, idx) => {
      if (idx > 0) rowsEme.push([], []);
      rowsEme.push(["IDENTIFICAÇÃO"]);
      rowsEme.push([
        `UNIDADE EXECUTORA: ${uex.nome_uex || ""}`,
        "",
        "",
        "",
        "",
        "",
        "",
        "PORTARIA",
      ]);
      rowsEme.push([
        `CNPJ: ${uex.cnpj || ""}`,
        "",
        "",
        "",
        "",
        "",
        "",
        f.titulo_portaria || f.numero_portaria,
      ]);
      rowsEme.push([`ENDEREÇO: ${uex.endereco || ""}`]);
      rowsEme.push([`DEPUTADO: ${f.deputado || ""}`]);
      rowsEme.push([`PROCESSO DE LIBERAÇÃO DO RECURSO: ${f.processo_sei_liberacao || ""}`]);
      rowsEme.push([`DATA DO PAGAMENTO: ${formatarDataCurtaBR(f.data_pagamento_credito)}`]);
      rowsEme.push([`DESTINAÇÃO DO RECURSO (OFÍCIO DO DEPUTADO): ${f.destinacao_oficio || ""}`]);
      rowsEme.push(["RESUMO DA EXECUÇÃO"]);
      rowsEme.push([
        "CRÉDITO CUSTEIO",
        "CRÉDITO CAPITAL",
        "DESPESA CUSTEIO",
        "DESPESA CAPITAL",
        "SALDO CUSTEIO",
        "SALDO CAPITAL",
        "SALDO FINAL",
      ]);
      rowsEme.push([
        Number(f.credito_custeio || 0),
        Number(f.credito_capital || 0),
        Number(f.despesa_custeio || 0),
        Number(f.despesa_capital || 0),
        Number(f.saldo_custeio || 0),
        Number(f.saldo_capital || 0),
        Number(f.saldo_total || 0),
      ]);
      rowsEme.push([`RELAÇÃO DE DESPESAS REALIZADAS - ${exercicio}`]);
      rowsEme.push([
        "COMPRA",
        "FORNECEDOR",
        "CNPJ/CPF",
        "DOC. FISCAL",
        "O S",
        "DATA",
        "AQUISIÇÃO/SERVIÇO",
        "VALOR TOTAL",
      ]);

      let somaTotalFicha = 0;
      for (const d of f.despesas || []) {
        const tot = Number(d.valor_custeio || 0) + Number(d.valor_capital || 0);
        somaTotalFicha += tot;
        rowsEme.push([
          d.compra || "",
          d.fornecedor || "",
          d.cnpj_cpf || "",
          d.documento_fiscal || "",
          d.ordem_servico_orcamentos || "",
          formatarDataCurtaBR(d.data_pagamento),
          d.descricao_geral || "",
          Number(tot.toFixed(2)),
        ]);
      }

      rowsEme.push([
        "TOTAL DE DESPESAS REALIZADAS (R$)",
        "",
        "",
        "",
        "",
        "",
        "",
        Number(somaTotalFicha.toFixed(2)),
      ]);
      rowsEme.push([
        "SALDO FINAL DA EMENDA (R$)",
        "",
        "",
        "",
        "",
        "",
        "",
        Number(f.saldo_total || 0),
      ]);
    });
  }

  const wsEme = XLSX.utils.aoa_to_sheet(rowsEme);
  wsEme["!cols"] = [
    { wch: 22 },
    { wch: 28 },
    { wch: 20 },
    { wch: 16 },
    { wch: 18 },
    { wch: 14 },
    { wch: 32 },
    { wch: 20 },
  ];
  XLSX.utils.book_append_sheet(wb, wsEme, `EMENDA PARLAMENTAR ${exercicio}`);

  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

// ══════════════════════════════════════════════════════════════════════════════
// ROTAS DA UNIDADE ESCOLAR (/api/financeiro/pdaf/*)
// ══════════════════════════════════════════════════════════════════════════════

// 1) GET /api/financeiro/pdaf?exercicio=YYYY
router.get("/pdaf", async (req, res) => {
  const db = req.db || pool;
  const escolaId = getEscolaId(req);
  if (!escolaId) {
    return res.status(400).json({ ok: false, message: "escola_id é obrigatório." });
  }

  try {
    const payload = await carregarDadosCompletosPdafEscola(db, escolaId, req.query?.exercicio);
    return res.json(payload);
  } catch (err) {
    console.error("[FINANCEIRO][GET /pdaf]", err);
    return res.status(500).json({ ok: false, message: "Erro ao carregar dados do PDAF." });
  }
});

// 2) PUT /api/financeiro/pdaf/uex — Salvar Cabeçalho da Caixa Escolar (UEx)
router.put("/pdaf/uex", async (req, res) => {
  const db = req.db || pool;
  const escolaId = getEscolaId(req);
  if (!escolaId) {
    return res.status(400).json({ ok: false, message: "escola_id é obrigatório." });
  }

  const nomeUex = String(req.body?.nome_uex || "").trim();
  const cnpj = String(req.body?.cnpj || "").trim() || null;
  const endereco = String(req.body?.endereco || "").trim() || null;

  if (!nomeUex) {
    return res.status(400).json({ ok: false, message: "Informe o nome da Unidade Executora (Caixa Escolar)." });
  }

  try {
    await ensureFinanceiroTables(db);
    await db.query(
      `INSERT INTO financeiro_uex_config (escola_id, nome_uex, cnpj, endereco, atualizado_por)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         nome_uex = VALUES(nome_uex),
         cnpj = VALUES(cnpj),
         endereco = VALUES(endereco),
         atualizado_por = VALUES(atualizado_por)`,
      [escolaId, nomeUex.toUpperCase(), cnpj, endereco, getUsuarioLabel(req)]
    );

    return res.json({ ok: true, message: "Dados da Unidade Executora atualizados com sucesso." });
  } catch (err) {
    console.error("[FINANCEIRO][PUT /pdaf/uex]", err);
    return res.status(500).json({ ok: false, message: "Erro ao salvar dados da Unidade Executora." });
  }
});

// 3) POST /api/financeiro/pdaf/portarias — Cadastrar Portaria Ordinária ou Emenda
router.post("/pdaf/portarias", async (req, res) => {
  const db = req.db || pool;
  const escolaId = getEscolaId(req);
  if (!escolaId) {
    return res.status(400).json({ ok: false, message: "escola_id é obrigatório." });
  }

  const body = req.body || {};
  const exercicio = parseExercicio(body.exercicio);
  const tipo = String(body.tipo || "ORDINARIO").toUpperCase().trim();
  const numeroPortaria = String(body.numero_portaria || "").trim().toUpperCase();
  const dataPortaria = normalizarDataIso(body.data_portaria, true);
  const ehReprogramado = Boolean(body.eh_reprogramado) ? 1 : 0;
  const trimestreEntrada = ehReprogramado ? 1 : parseTrimestre(body.trimestre_entrada, dataPortaria);
  const custeioCents = toCents(body.credito_custeio);
  const capitalCents = toCents(body.credito_capital);

  if (!TIPOS_PORTARIA_VALIDOS.has(tipo)) {
    return res.status(400).json({ ok: false, message: "Tipo de portaria inválido (use ORDINARIO ou EMENDA)." });
  }
  if (!numeroPortaria) {
    return res.status(400).json({ ok: false, message: "Informe o número/ano da Portaria (ex.: 122/2026)." });
  }
  if (custeioCents < 0 || capitalCents < 0 || custeioCents + capitalCents <= 0) {
    return res.status(400).json({ ok: false, message: "Informe um valor maior que zero em Crédito Custeio e/ou Capital." });
  }

  const tituloPortaria =
    String(body.titulo_portaria || "").trim() ||
    montarTituloPadraoPortaria(numeroPortaria, dataPortaria);

  try {
    await ensureFinanceiroTables(db);

    const statusBloq = await verificarTrimestreBloqueado(db, escolaId, exercicio, trimestreEntrada);
    if (statusBloq) {
      return res.status(409).json({
        ok: false,
        message: `O ${trimestreEntrada}º Trimestre já está enviado/validado (${statusBloq}) e não permite inclusão retroativa de portarias.`,
      });
    }

    const [result] = await db.query(
      `INSERT INTO financeiro_pdaf_portarias (
         escola_id, exercicio, tipo, numero_portaria, titulo_portaria,
         data_portaria, eh_reprogramado, trimestre_entrada,
         credito_custeio, credito_capital,
         deputado, processo_sei_liberacao, data_pagamento_credito, destinacao_oficio,
         observacoes, criado_por
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        escolaId,
        exercicio,
        tipo,
        numeroPortaria,
        tituloPortaria,
        dataPortaria,
        ehReprogramado,
        trimestreEntrada,
        centsToDecimal(custeioCents),
        centsToDecimal(capitalCents),
        body.deputado ? String(body.deputado).trim() : null,
        body.processo_sei_liberacao ? String(body.processo_sei_liberacao).trim() : null,
        normalizarDataIso(body.data_pagamento_credito, true),
        body.destinacao_oficio ? String(body.destinacao_oficio).trim() : null,
        body.observacoes ? String(body.observacoes).trim() : null,
        getUsuarioLabel(req),
      ]
    );

    return res.status(201).json({
      ok: true,
      id: result.insertId,
      message: `Portaria ${numeroPortaria} registrada com sucesso.`,
    });
  } catch (err) {
    if (err?.code === "ER_DUP_ENTRY") {
      return res.status(409).json({
        ok: false,
        message: `A Portaria ${numeroPortaria} já está cadastrada neste exercício.`,
      });
    }
    console.error("[FINANCEIRO][POST /pdaf/portarias]", err);
    return res.status(500).json({ ok: false, message: "Erro ao cadastrar portaria." });
  }
});

// 4) PUT /api/financeiro/pdaf/portarias/:id — Editar Portaria
router.put("/pdaf/portarias/:id", async (req, res) => {
  const db = req.db || pool;
  const escolaId = getEscolaId(req);
  const id = Number(req.params.id);
  if (!escolaId || !id) {
    return res.status(400).json({ ok: false, message: "Parâmetros inválidos." });
  }

  const body = req.body || {};
  const tipo = String(body.tipo || "ORDINARIO").toUpperCase().trim();
  const numeroPortaria = String(body.numero_portaria || "").trim().toUpperCase();
  const dataPortaria = normalizarDataIso(body.data_portaria, true);
  const ehReprogramado = Boolean(body.eh_reprogramado) ? 1 : 0;
  const trimestreEntrada = ehReprogramado ? 1 : parseTrimestre(body.trimestre_entrada, dataPortaria);
  const custeioCents = toCents(body.credito_custeio);
  const capitalCents = toCents(body.credito_capital);

  if (!TIPOS_PORTARIA_VALIDOS.has(tipo) || !numeroPortaria) {
    return res.status(400).json({ ok: false, message: "Informe número e tipo válidos da Portaria." });
  }
  if (custeioCents < 0 || capitalCents < 0 || custeioCents + capitalCents <= 0) {
    return res.status(400).json({ ok: false, message: "Informe um valor maior que zero em Crédito Custeio e/ou Capital." });
  }

  try {
    await ensureFinanceiroTables(db);
    const [[atual]] = await db.query(
      "SELECT id, exercicio, trimestre_entrada FROM financeiro_pdaf_portarias WHERE id = ? AND escola_id = ? LIMIT 1",
      [id, escolaId]
    );
    if (!atual) {
      return res.status(404).json({ ok: false, message: "Portaria não encontrada." });
    }

    const statusBloq = await verificarTrimestreBloqueado(db, escolaId, atual.exercicio, Math.min(atual.trimestre_entrada, trimestreEntrada));
    if (statusBloq) {
      return res.status(409).json({
        ok: false,
        message: "Não é possível alterar valores de uma Portaria vinculada a trimestre já enviado/validado na UNIAG.",
      });
    }

    const tituloPortaria =
      String(body.titulo_portaria || "").trim() ||
      montarTituloPadraoPortaria(numeroPortaria, dataPortaria);

    await db.query(
      `UPDATE financeiro_pdaf_portarias
          SET tipo = ?, numero_portaria = ?, titulo_portaria = ?,
              data_portaria = ?, eh_reprogramado = ?, trimestre_entrada = ?,
              credito_custeio = ?, credito_capital = ?,
              deputado = ?, processo_sei_liberacao = ?,
              data_pagamento_credito = ?, destinacao_oficio = ?, observacoes = ?
        WHERE id = ? AND escola_id = ?`,
      [
        tipo,
        numeroPortaria,
        tituloPortaria,
        dataPortaria,
        ehReprogramado,
        trimestreEntrada,
        centsToDecimal(custeioCents),
        centsToDecimal(capitalCents),
        body.deputado ? String(body.deputado).trim() : null,
        body.processo_sei_liberacao ? String(body.processo_sei_liberacao).trim() : null,
        normalizarDataIso(body.data_pagamento_credito, true),
        body.destinacao_oficio ? String(body.destinacao_oficio).trim() : null,
        body.observacoes ? String(body.observacoes).trim() : null,
        id,
        escolaId,
      ]
    );

    return res.json({ ok: true, message: "Portaria atualizada com sucesso." });
  } catch (err) {
    if (err?.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ ok: false, message: `Já existe outra portaria com o número ${numeroPortaria}.` });
    }
    console.error("[FINANCEIRO][PUT /pdaf/portarias/:id]", err);
    return res.status(500).json({ ok: false, message: "Erro ao atualizar portaria." });
  }
});

// 5) DELETE /api/financeiro/pdaf/portarias/:id — Excluir Portaria (apenas sem despesas vinculadas)
router.delete("/pdaf/portarias/:id", async (req, res) => {
  const db = req.db || pool;
  const escolaId = getEscolaId(req);
  const id = Number(req.params.id);
  if (!escolaId || !id) {
    return res.status(400).json({ ok: false, message: "Parâmetros inválidos." });
  }

  try {
    await ensureFinanceiroTables(db);
    const [[port]] = await db.query(
      "SELECT id, exercicio, trimestre_entrada, numero_portaria FROM financeiro_pdaf_portarias WHERE id = ? AND escola_id = ? LIMIT 1",
      [id, escolaId]
    );
    if (!port) {
      return res.status(404).json({ ok: false, message: "Portaria não encontrada." });
    }

    const [[uso]] = await db.query(
      "SELECT COUNT(*) AS qtd FROM financeiro_pdaf_despesas WHERE escola_id = ? AND portaria_id = ?",
      [escolaId, id]
    );
    if (Number(uso?.qtd || 0) > 0) {
      return res.status(409).json({
        ok: false,
        message: `A Portaria ${port.numero_portaria} possui ${uso.qtd} despesa(s) vinculada(s). Remova ou altere as despesas antes de excluí-la.`,
      });
    }

    const statusBloq = await verificarTrimestreBloqueado(db, escolaId, port.exercicio, port.trimestre_entrada);
    if (statusBloq) {
      return res.status(409).json({
        ok: false,
        message: "Não é possível excluir portaria de trimestre enviado ou validado pela UNIAG.",
      });
    }

    await db.query("DELETE FROM financeiro_pdaf_portarias WHERE id = ? AND escola_id = ?", [id, escolaId]);
    return res.json({ ok: true, message: "Portaria removida com sucesso." });
  } catch (err) {
    console.error("[FINANCEIRO][DELETE /pdaf/portarias/:id]", err);
    return res.status(500).json({ ok: false, message: "Erro ao remover portaria." });
  }
});

// 6) PUT /api/financeiro/pdaf/rendimentos — Salvar Rendimentos Mensais / Saldo Reprogramado
// body: { exercicio: 2026, itens: [{ mes: 0, valor: 24814.84 }, { mes: 4, valor: 2657.58 }, ...] }
router.put("/pdaf/rendimentos", async (req, res) => {
  const db = req.db || pool;
  const escolaId = getEscolaId(req);
  if (!escolaId) {
    return res.status(400).json({ ok: false, message: "escola_id é obrigatório." });
  }

  const exercicio = parseExercicio(req.body?.exercicio);
  const itens = Array.isArray(req.body?.itens) ? req.body.itens : [];
  if (itens.length === 0) {
    return res.status(400).json({ ok: false, message: "Informe os valores de rendimentos a salvar." });
  }

  try {
    await ensureFinanceiroTables(db);
    const usuario = getUsuarioLabel(req);

    for (const item of itens) {
      const mes = Number(item?.mes);
      if (!Number.isInteger(mes) || mes < 0 || mes > 12) continue;
      const triAlvo = mes === 0 ? 1 : Math.ceil(mes / 3);
      const statusBloq = await verificarTrimestreBloqueado(db, escolaId, exercicio, triAlvo);
      if (statusBloq) {
        return res.status(409).json({
          ok: false,
          message: `Os rendimentos do ${triAlvo}º Trimestre estão bloqueados porque o trimestre está ${statusBloq}.`,
        });
      }
    }

    for (const item of itens) {
      const mes = Number(item?.mes);
      if (!Number.isInteger(mes) || mes < 0 || mes > 12) continue;
      const valCents = Math.max(0, toCents(item?.valor));
      await db.query(
        `INSERT INTO financeiro_pdaf_rendimentos (escola_id, exercicio, mes, valor, atualizado_por)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           valor = VALUES(valor),
           atualizado_por = VALUES(atualizado_por)`,
        [escolaId, exercicio, mes, centsToDecimal(valCents), usuario]
      );
    }

    return res.json({ ok: true, message: "Rendimentos registrados com sucesso." });
  } catch (err) {
    console.error("[FINANCEIRO][PUT /pdaf/rendimentos]", err);
    return res.status(500).json({ ok: false, message: "Erro ao salvar rendimentos." });
  }
});

// 7) POST /api/financeiro/pdaf/despesas — Registrar Compra Simples ou Rateada (Split em 2+ Portarias)
router.post("/pdaf/despesas", async (req, res) => {
  const db = req.db || pool;
  const escolaId = getEscolaId(req);
  if (!escolaId) {
    return res.status(400).json({ ok: false, message: "escola_id é obrigatório." });
  }

  const body = req.body || {};
  const compraLimpa = String(body.compra || "").trim();
  const fornecedorLimpo = String(body.fornecedor || "").trim();
  const descricaoLimpa = String(body.descricao_geral || "").trim();
  const dataIso = normalizarDataIso(body.data_pagamento);
  const ano = parseExercicio(body.exercicio || String(dataIso).slice(0, 4));
  const trimestre = parseTrimestre(body.trimestre, dataIso);

  if (!compraLimpa || !fornecedorLimpo || !descricaoLimpa) {
    return res.status(400).json({
      ok: false,
      message: "Preencha os campos obrigatórios: Compra, Fornecedor e Descrição Geral.",
    });
  }

  // Suporte nativo a Rateio (ex.: OS 90060 paga parte com Portaria A e parte com Portaria B)
  const parcelasRaw = Array.isArray(body.rateios) && body.rateios.length > 0
    ? body.rateios
    : [
        {
          fonte_recurso: body.fonte_recurso,
          portaria_id: body.portaria_id,
          valor_custeio: body.valor_custeio,
          valor_capital: body.valor_capital,
        },
      ];

  try {
    await ensureFinanceiroTables(db);

    const statusBloq = await verificarTrimestreBloqueado(db, escolaId, ano, trimestre);
    if (statusBloq) {
      return res.status(409).json({
        ok: false,
        message: `O ${trimestre}º Trimestre já foi enviado/validado (${statusBloq}) e está bloqueado para novos lançamentos.`,
      });
    }

    const parcelasValidadas = [];
    for (const parc of parcelasRaw) {
      let fonte = String(parc.fonte_recurso || "ORDINARIO").toUpperCase().trim();
      let portariaId = parc.portaria_id ? Number(parc.portaria_id) : null;
      const custCents = toCents(parc.valor_custeio);
      const capCents = toCents(parc.valor_capital);

      if (custCents < 0 || capCents < 0 || custCents + capCents <= 0) {
        return res.status(400).json({
          ok: false,
          message: "Cada parcela da compra deve ter valor maior que zero em Custeio e/ou Capital.",
        });
      }

      if (fonte === "RENDIMENTO") {
        portariaId = null;
      } else {
        if (!portariaId) {
          return res.status(400).json({
            ok: false,
            message: "Selecione a Portaria específica que custeará esta despesa (ou selecione Rendimentos).",
          });
        }
        const [[portRow]] = await db.query(
          "SELECT id, tipo FROM financeiro_pdaf_portarias WHERE id = ? AND escola_id = ? AND exercicio = ? LIMIT 1",
          [portariaId, escolaId, ano]
        );
        if (!portRow) {
          return res.status(404).json({ ok: false, message: "Portaria selecionada não pertence a esta escola/exercício." });
        }
        fonte = portRow.tipo;
      }

      if (!FONTES_VALIDAS.has(fonte)) {
        return res.status(400).json({ ok: false, message: "Fonte de recurso inválida." });
      }

      parcelasValidadas.push({
        fonte,
        portariaId,
        custeio: centsToDecimal(custCents),
        capital: centsToDecimal(capCents),
      });
    }

    const grupoRateioUid = parcelasValidadas.length > 1 ? crypto.randomUUID() : null;
    const criadoPor = getUsuarioLabel(req);

    await db.query("START TRANSACTION");
    const insertedIds = [];

    for (const p of parcelasValidadas) {
      const [ins] = await db.query(
        `INSERT INTO financeiro_pdaf_despesas (
           escola_id, exercicio, trimestre, portaria_id, compra, data_pagamento,
           documento_fiscal, ordem_servico_orcamentos, fornecedor, cnpj_cpf,
           descricao_geral, fonte_recurso, processo_incorporacao,
           valor_custeio, valor_capital, grupo_rateio_uid, observacoes, criado_por
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          escolaId,
          ano,
          trimestre,
          p.portariaId,
          compraLimpa,
          dataIso,
          body.documento_fiscal ? String(body.documento_fiscal).trim() : null,
          body.ordem_servico_orcamentos ? String(body.ordem_servico_orcamentos).trim() : null,
          fornecedorLimpo,
          body.cnpj_cpf ? String(body.cnpj_cpf).trim() : null,
          descricaoLimpa,
          p.fonte,
          body.processo_incorporacao ? String(body.processo_incorporacao).trim() : null,
          p.custeio,
          p.capital,
          grupoRateioUid,
          body.observacoes ? String(body.observacoes).trim() : null,
          criadoPor,
        ]
      );
      insertedIds.push(ins.insertId);
    }

    await db.query("COMMIT");

    return res.status(201).json({
      ok: true,
      ids: insertedIds,
      message:
        parcelasValidadas.length > 1
          ? `Compra rateada em ${parcelasValidadas.length} fontes registrada com sucesso.`
          : "Compra/despesa registrada com sucesso.",
    });
  } catch (err) {
    try { await db.query("ROLLBACK"); } catch {}
    console.error("[FINANCEIRO][POST /pdaf/despesas]", err);
    return res.status(500).json({ ok: false, message: "Erro ao registrar compra/despesa." });
  }
});

// 8) PUT /api/financeiro/pdaf/despesas/:id — Editar Despesa
router.put("/pdaf/despesas/:id", async (req, res) => {
  const db = req.db || pool;
  const escolaId = getEscolaId(req);
  const id = Number(req.params.id);
  if (!escolaId || !id) {
    return res.status(400).json({ ok: false, message: "Parâmetros inválidos." });
  }

  const body = req.body || {};
  const compraLimpa = String(body.compra || "").trim();
  const fornecedorLimpo = String(body.fornecedor || "").trim();
  const descricaoLimpa = String(body.descricao_geral || "").trim();
  const dataIso = normalizarDataIso(body.data_pagamento);
  const custeioCents = toCents(body.valor_custeio);
  const capitalCents = toCents(body.valor_capital);

  if (!compraLimpa || !fornecedorLimpo || !descricaoLimpa) {
    return res.status(400).json({
      ok: false,
      message: "Preencha os campos obrigatórios: Compra, Fornecedor e Descrição Geral.",
    });
  }
  if (custeioCents < 0 || capitalCents < 0 || custeioCents + capitalCents <= 0) {
    return res.status(400).json({
      ok: false,
      message: "Informe um valor maior que zero em Custeio e/ou Capital.",
    });
  }

  try {
    await ensureFinanceiroTables(db);
    const [[atual]] = await db.query(
      "SELECT id, exercicio, trimestre FROM financeiro_pdaf_despesas WHERE id = ? AND escola_id = ? LIMIT 1",
      [id, escolaId]
    );
    if (!atual) {
      return res.status(404).json({ ok: false, message: "Compra/despesa não encontrada." });
    }

    const ano = parseExercicio(body.exercicio || atual.exercicio);
    const novoTrimestre = parseTrimestre(body.trimestre, dataIso);

    const bloqAnt = await verificarTrimestreBloqueado(db, escolaId, atual.exercicio, atual.trimestre);
    const bloqNovo = await verificarTrimestreBloqueado(db, escolaId, ano, novoTrimestre);
    if (bloqAnt || bloqNovo) {
      return res.status(409).json({
        ok: false,
        message: "Não é possível editar despesas de trimestre já enviado ou validado pela UNIAG.",
      });
    }

    let fonte = String(body.fonte_recurso || "ORDINARIO").toUpperCase().trim();
    let portariaId = body.portaria_id ? Number(body.portaria_id) : null;

    if (fonte === "RENDIMENTO") {
      portariaId = null;
    } else {
      if (!portariaId) {
        return res.status(400).json({ ok: false, message: "Selecione a Portaria vinculada à despesa." });
      }
      const [[portRow]] = await db.query(
        "SELECT id, tipo FROM financeiro_pdaf_portarias WHERE id = ? AND escola_id = ? AND exercicio = ? LIMIT 1",
        [portariaId, escolaId, ano]
      );
      if (!portRow) {
        return res.status(404).json({ ok: false, message: "Portaria selecionada inválida." });
      }
      fonte = portRow.tipo;
    }

    await db.query(
      `UPDATE financeiro_pdaf_despesas
          SET exercicio = ?, trimestre = ?, portaria_id = ?,
              compra = ?, data_pagamento = ?, documento_fiscal = ?,
              ordem_servico_orcamentos = ?, fornecedor = ?, cnpj_cpf = ?,
              descricao_geral = ?, fonte_recurso = ?, processo_incorporacao = ?,
              valor_custeio = ?, valor_capital = ?, observacoes = ?
        WHERE id = ? AND escola_id = ?`,
      [
        ano,
        novoTrimestre,
        portariaId,
        compraLimpa,
        dataIso,
        body.documento_fiscal ? String(body.documento_fiscal).trim() : null,
        body.ordem_servico_orcamentos ? String(body.ordem_servico_orcamentos).trim() : null,
        fornecedorLimpo,
        body.cnpj_cpf ? String(body.cnpj_cpf).trim() : null,
        descricaoLimpa,
        fonte,
        body.processo_incorporacao ? String(body.processo_incorporacao).trim() : null,
        centsToDecimal(custeioCents),
        centsToDecimal(capitalCents),
        body.observacoes ? String(body.observacoes).trim() : null,
        id,
        escolaId,
      ]
    );

    return res.json({ ok: true, message: "Compra/despesa atualizada com sucesso." });
  } catch (err) {
    console.error("[FINANCEIRO][PUT /pdaf/despesas/:id]", err);
    return res.status(500).json({ ok: false, message: "Erro ao atualizar compra/despesa." });
  }
});

// 9) DELETE /api/financeiro/pdaf/despesas/:id — Excluir Despesa
router.delete("/pdaf/despesas/:id", async (req, res) => {
  const db = req.db || pool;
  const escolaId = getEscolaId(req);
  const id = Number(req.params.id);
  if (!escolaId || !id) {
    return res.status(400).json({ ok: false, message: "Parâmetros inválidos." });
  }

  try {
    await ensureFinanceiroTables(db);
    const [[atual]] = await db.query(
      "SELECT id, exercicio, trimestre FROM financeiro_pdaf_despesas WHERE id = ? AND escola_id = ? LIMIT 1",
      [id, escolaId]
    );
    if (!atual) {
      return res.status(404).json({ ok: false, message: "Registro não encontrado." });
    }

    const statusBloq = await verificarTrimestreBloqueado(db, escolaId, atual.exercicio, atual.trimestre);
    if (statusBloq) {
      return res.status(409).json({
        ok: false,
        message: "Não é possível remover despesas de trimestre já enviado ou validado pela UNIAG.",
      });
    }

    await db.query("DELETE FROM financeiro_pdaf_despesas WHERE id = ? AND escola_id = ?", [id, escolaId]);
    return res.json({ ok: true, message: "Compra/despesa removida com sucesso." });
  } catch (err) {
    console.error("[FINANCEIRO][DELETE /pdaf/despesas/:id]", err);
    return res.status(500).json({ ok: false, message: "Erro ao remover compra/despesa." });
  }
});

// 10) POST /api/financeiro/pdaf/trimestres/:trimestre/enviar — Submeter Trimestre à UNIAG (Pré-SEI)
router.post("/pdaf/trimestres/:trimestre/enviar", async (req, res) => {
  const db = req.db || pool;
  const escolaId = getEscolaId(req);
  const trimestre = Number(req.params.trimestre);
  const exercicio = parseExercicio(req.body?.exercicio);

  if (!escolaId || ![1, 2, 3, 4].includes(trimestre)) {
    return res.status(400).json({ ok: false, message: "Trimestre inválido." });
  }

  try {
    const dados = await carregarDadosCompletosPdafEscola(db, escolaId, exercicio);
    const dadosTri = dados.trimestres?.[trimestre];
    if (!dadosTri) {
      return res.status(404).json({ ok: false, message: "Dados do trimestre não localizados." });
    }

    if (dadosTri.status === "VALIDADO_SEI") {
      return res.status(409).json({
        ok: false,
        message: "Este trimestre já foi validado pela UNIAG para autuação no SEI.",
      });
    }

    const errosBloqueantes = (dadosTri.pendencias || []).filter((p) => p.nivel === "ERRO");
    if (errosBloqueantes.length > 0) {
      return res.status(422).json({
        ok: false,
        message: `Corrija ${errosBloqueantes.length} pendência(s) obrigatória(s) antes de enviar à UNIAG.`,
        pendencias: errosBloqueantes,
      });
    }

    const procSei = req.body?.processo_sei_prestacao
      ? String(req.body.processo_sei_prestacao).trim()
      : null;
    const obsEscola = req.body?.observacoes_escola
      ? String(req.body.observacoes_escola).trim()
      : null;

    await db.query(
      `INSERT INTO financeiro_pdaf_prestacoes (
         escola_id, exercicio, trimestre, status,
         processo_sei_prestacao, observacoes_escola,
         enviado_por, enviado_em
       ) VALUES (?, ?, ?, 'ENVIADO_UNIAG', ?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE
         status = 'ENVIADO_UNIAG',
         processo_sei_prestacao = COALESCE(VALUES(processo_sei_prestacao), processo_sei_prestacao),
         observacoes_escola = VALUES(observacoes_escola),
         enviado_por = VALUES(enviado_por),
         enviado_em = NOW()`,
      [escolaId, exercicio, trimestre, procSei, obsEscola, getUsuarioLabel(req)]
    );

    return res.json({
      ok: true,
      message: `${trimestre}º Trimestre/${exercicio} enviado para Pré-Análise da UNIAG com sucesso!`,
    });
  } catch (err) {
    console.error("[FINANCEIRO][ENVIAR TRIMESTRE]", err);
    return res.status(500).json({ ok: false, message: "Erro ao enviar trimestre para a UNIAG." });
  }
});

// 11) POST /api/financeiro/pdaf/trimestres/:trimestre/reabrir — Retomar edição antes da validação UNIAG
router.post("/pdaf/trimestres/:trimestre/reabrir", async (req, res) => {
  const db = req.db || pool;
  const escolaId = getEscolaId(req);
  const trimestre = Number(req.params.trimestre);
  const exercicio = parseExercicio(req.body?.exercicio);

  if (!escolaId || ![1, 2, 3, 4].includes(trimestre)) {
    return res.status(400).json({ ok: false, message: "Trimestre inválido." });
  }

  try {
    await ensureFinanceiroTables(db);
    const [[atual]] = await db.query(
      "SELECT status FROM financeiro_pdaf_prestacoes WHERE escola_id = ? AND exercicio = ? AND trimestre = ? LIMIT 1",
      [escolaId, exercicio, trimestre]
    );

    if (!atual || atual.status !== "ENVIADO_UNIAG") {
      return res.status(409).json({
        ok: false,
        message: "Apenas trimestres aguardando conferência inicial podem ser retomados pela escola.",
      });
    }

    await db.query(
      "UPDATE financeiro_pdaf_prestacoes SET status = 'EM_ELABORACAO' WHERE escola_id = ? AND exercicio = ? AND trimestre = ?",
      [escolaId, exercicio, trimestre]
    );

    return res.json({ ok: true, message: `Edição do ${trimestre}º Trimestre reaberta.` });
  } catch (err) {
    console.error("[FINANCEIRO][REABRIR TRIMESTRE]", err);
    return res.status(500).json({ ok: false, message: "Erro ao reabrir trimestre." });
  }
});

// 12) GET /api/financeiro/pdaf/exportar-xlsx?exercicio=YYYY — Exportar Planilha Oficial de 5 Abas (Padrão SEEDF / SEI)
router.get("/pdaf/exportar-xlsx", async (req, res) => {
  const db = req.db || pool;
  const escolaId = getEscolaId(req);
  if (!escolaId) {
    return res.status(400).json({ ok: false, message: "escola_id é obrigatório." });
  }

  try {
    const dadosPdaf = await carregarDadosCompletosPdafEscola(db, escolaId, req.query?.exercicio);
    const buffer = gerarBufferPlanilhaPdaf(dadosPdaf);
    const apelidoLimpo = String(dadosPdaf?.uex?.escola_apelido || `ESCOLA_${escolaId}`)
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9_-]+/g, "_")
      .toUpperCase();
    const filename = `UEx_CONTROLE_DE_DESPESAS_${dadosPdaf.exercicio}_${apelidoLimpo}.xlsx`;

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    return res.send(buffer);
  } catch (err) {
    console.error("[FINANCEIRO][EXPORTAR XLSX]", err);
    return res.status(500).json({ ok: false, message: "Erro ao gerar planilha oficial de prestação de contas." });
  }
});

export default router;
