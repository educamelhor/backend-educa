// routes/cre.js
// ============================================================================
// MÓDULO CRE — Coordenações Regionais de Ensino (SEEDF)
// Passo 1 Técnico: Ambiente isolado (scope: "cre" + verificarRegional)
// Escopo do Piloto:
//   1. Gabinete Regional (/api/cre/gabinete) — Visão consolidada da Rede CRE
//   2. UNIAG (/api/cre/uniag/*) — Acompanhamento Financeiro PDAF & Pré-Análise SEI
// ============================================================================

import express from "express";
import fs from "fs";
import path, { dirname as _dirname } from "path";
import { fileURLToPath } from "url";
import multer from "multer";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import pool from "../db.js";
import { ensureFinanceiroTables } from "./financeiro.js";
import { CARGOS_CRE_LABELS, exigirCargoRegional } from "../middleware/verificarRegional.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = _dirname(__filename);

const router = express.Router();

const FONTES_VALIDAS = new Set(["ORDINARIO", "EMENDA", "RENDIMENTO"]);

// ── Helpers Monetários (precisão em centavos, espelhando routes/financeiro.js) ──
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

// ── Upload de Foto de Perfil para Gestores CRE (/api/cre/me/foto) ────────────
const SPACES_BUCKET = process.env.SPACES_BUCKET || process.env.DO_SPACES_BUCKET;
const SPACES_REGION = process.env.SPACES_REGION || process.env.DO_SPACES_REGION || "nyc3";
const rawSpacesEndpoint =
  process.env.SPACES_ENDPOINT ||
  process.env.DO_SPACES_ENDPOINT ||
  `https://${SPACES_REGION}.digitaloceanspaces.com`;

function normalizeSpacesEndpoint(endpoint, bucket, region) {
  try {
    const url = new URL(endpoint);
    if (bucket && url.host.startsWith(`${bucket}.`)) {
      url.host = url.host.replace(`${bucket}.`, "");
    }
    return url.toString();
  } catch {
    return `https://${region}.digitaloceanspaces.com`;
  }
}

const SPACES_KEY = process.env.SPACES_KEY || process.env.DO_SPACES_KEY;
const SPACES_SECRET = process.env.SPACES_SECRET || process.env.DO_SPACES_SECRET;
const s3Cre =
  SPACES_BUCKET && SPACES_KEY && SPACES_SECRET
    ? new S3Client({
        region: SPACES_REGION,
        endpoint: normalizeSpacesEndpoint(rawSpacesEndpoint, SPACES_BUCKET, SPACES_REGION),
        credentials: { accessKeyId: SPACES_KEY, secretAccessKey: SPACES_SECRET },
        forcePathStyle: false,
      })
    : null;

const getExtFromMime = (mime) => {
  if (mime === "image/png") return "png";
  if (mime === "image/webp") return "webp";
  return "jpg";
};

const crePhotoUpload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => {
      const rid = Number(req.regional_id || req.user?.regional_id || 0);
      const dir = path.resolve(__dirname, `../uploads/cre_${rid}/usuarios`);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const uid = Number(req.user?.usuario_id || req.user?.usuarioId || req.user?.id || 0);
      const ext = getExtFromMime(file.mimetype);
      req.__cre_photo_ext = ext;
      cb(null, `${uid}.${ext}`);
    },
  }),
  fileFilter: (_req, file, cb) => {
    cb(null, ["image/jpeg", "image/png", "image/webp"].includes(file.mimetype));
  },
  limits: { fileSize: 3 * 1024 * 1024 },
});

// ══════════════════════════════════════════════════════════════════════════════
// 1) GABINETE REGIONAL — Visão Consolidada da Coordenação Regional e Escolas
// GET /api/cre/gabinete?exercicio=YYYY
// ══════════════════════════════════════════════════════════════════════════════
router.get("/gabinete", async (req, res) => {
  const db = req.db || pool;
  const regionalId = Number(req.regional_id);
  const exercicio = parseExercicio(req.query?.exercicio);

  try {
    await ensureFinanceiroTables(db);

    const [[regional]] = await db.query(
      `SELECT id, nome, apelido, codigo_cre, cnpj, endereco, cidade, estado, tipo, origem, status, telefone, email
       FROM regionais
       WHERE id = ?
       LIMIT 1`,
      [regionalId]
    );

    if (!regional) {
      return res.status(404).json({ ok: false, message: "Coordenação Regional não encontrada." });
    }

    if (String(regional.status || "ativa").toLowerCase() !== "ativa") {
      return res.status(403).json({ ok: false, message: "Esta Coordenação Regional está inativa ou bloqueada." });
    }

    let unidadesAtivas = [];
    if (regional.tipo) {
      try {
        const parsed = typeof regional.tipo === "string" ? JSON.parse(regional.tipo) : regional.tipo;
        if (Array.isArray(parsed)) unidadesAtivas = parsed;
      } catch {}
    }

    // Quadro de chefes cadastrados nesta Regional
    const [chefesRows] = await db.query(
      `SELECT
         id,
         nome,
         email,
         ativo,
         COALESCE(cargo_regional, 'coordenador_regional') AS cargo_regional
       FROM usuarios
       WHERE regional_id = ?
         AND perfil IN ('chefe_regional', 'coordenador_regional')
         AND ativo = 1
       ORDER BY
         CASE COALESCE(cargo_regional, 'coordenador_regional')
           WHEN 'coordenador_regional' THEN 0
           WHEN 'chefe_uniag' THEN 1
           ELSE 2
         END ASC,
         nome ASC`,
      [regionalId]
    );

    const chefes = (chefesRows || []).map((c) => ({
      ...c,
      cargo_label: CARGOS_CRE_LABELS[c.cargo_regional] || "Gestor(a) Regional",
    }));

    // Escolas vinculadas à Regional + indicadores operacionais e financeiros do exercício
    const [escolasRows] = await db.query(
      `SELECT
         e.id,
         e.nome,
         e.apelido,
         e.cidade,
         e.estado,
         e.cnpj,
         e.tipo,
         e.status,
         (SELECT dir.nome FROM usuarios dir
          WHERE dir.escola_id = e.id AND dir.perfil = 'diretor' AND dir.ativo = 1
          ORDER BY dir.id DESC LIMIT 1) AS diretor,
         (SELECT cmd.nome FROM usuarios cmd
          WHERE cmd.escola_id = e.id AND cmd.perfil IN ('diretor_disciplinar', 'comandante') AND cmd.ativo = 1
          ORDER BY cmd.id DESC LIMIT 1) AS comandante,
         (SELECT COUNT(*) FROM alunos a WHERE a.escola_id = e.id) AS total_alunos,
         (SELECT COUNT(*) FROM turmas t WHERE t.escola_id = e.id AND t.ano = ?) AS total_turmas,
         EXISTS(
           SELECT 1 FROM escola_perfil_modulos epm
           WHERE epm.escola_id = e.id AND epm.modulo LIKE 'financeiro%' AND epm.ativo = 1
         ) AS modulo_financeiro_ativo
       FROM escolas e
       WHERE e.regional_id = ?
       ORDER BY e.apelido ASC, e.nome ASC`,
      [exercicio, regionalId]
    );

    const escolaIds = (escolasRows || []).map((e) => Number(e.id)).filter((id) => id > 0);

    let entradasPorEscola = new Map();
    let despesasPorEscola = new Map();

    if (escolaIds.length > 0) {
      const placeholders = escolaIds.map(() => "?").join(", ");
      const [[entRows], [despRows]] = await Promise.all([
        db.query(
          `SELECT escola_id, fonte_recurso, valor_custeio, valor_capital
           FROM financeiro_pdaf_entradas
           WHERE exercicio = ? AND escola_id IN (${placeholders})`,
          [exercicio, ...escolaIds]
        ),
        db.query(
          `SELECT escola_id, fonte_recurso, valor_custeio, valor_capital
           FROM financeiro_pdaf_despesas
           WHERE exercicio = ? AND escola_id IN (${placeholders})`,
          [exercicio, ...escolaIds]
        ),
      ]);

      for (const r of entRows || []) {
        const eid = Number(r.escola_id);
        if (!entradasPorEscola.has(eid)) entradasPorEscola.set(eid, []);
        entradasPorEscola.get(eid).push(r);
      }
      for (const r of despRows || []) {
        const eid = Number(r.escola_id);
        if (!despesasPorEscola.has(eid)) despesasPorEscola.set(eid, []);
        despesasPorEscola.get(eid).push(r);
      }
    }

    let totalAlunosRede = 0;
    let totalTurmasRede = 0;
    let pdafRecebidoCents = 0;
    let pdafExecutadoCents = 0;
    let escolasComPdaf = 0;

    const escolas = (escolasRows || []).map((esc) => {
      const eid = Number(esc.id);
      const entList = entradasPorEscola.get(eid) || [];
      const despList = despesasPorEscola.get(eid) || [];
      const resumoEsc = calcularResumoPdaf(entList, despList);

      const alunosNum = Number(esc.total_alunos || 0);
      const turmasNum = Number(esc.total_turmas || 0);
      totalAlunosRede += alunosNum;
      totalTurmasRede += turmasNum;

      const recCents = toCents(resumoEsc.total.entradas_total);
      const exeCents = toCents(resumoEsc.total.saidas_total);
      pdafRecebidoCents += recCents;
      pdafExecutadoCents += exeCents;

      const temMovimentacaoPdaf = entList.length > 0 || despList.length > 0;
      if (temMovimentacaoPdaf) escolasComPdaf += 1;

      let tiposArr = [];
      if (esc.tipo) {
        try {
          const p = typeof esc.tipo === "string" ? JSON.parse(esc.tipo) : esc.tipo;
          if (Array.isArray(p)) tiposArr = p;
        } catch {}
      }

      return {
        id: eid,
        nome: esc.nome,
        apelido: esc.apelido || esc.nome,
        cidade: esc.cidade,
        estado: esc.estado,
        cnpj: esc.cnpj,
        tipos: tiposArr,
        status: esc.status || "ativa",
        diretor: esc.diretor || null,
        comandante: esc.comandante || null,
        total_alunos: alunosNum,
        total_turmas: turmasNum,
        modulo_financeiro_ativo: Boolean(esc.modulo_financeiro_ativo) || temMovimentacaoPdaf,
        pdaf: {
          entradas_count: entList.length,
          despesas_count: despList.length,
          recebido: resumoEsc.total.entradas_total,
          executado: resumoEsc.total.saidas_total,
          saldo: resumoEsc.total.saldo_total,
        },
      };
    });

    const escolasAtivas = escolas.filter((e) => String(e.status).toLowerCase() === "ativa").length;

    return res.json({
      ok: true,
      exercicio,
      regional: {
        id: regional.id,
        nome: regional.nome,
        apelido: regional.apelido || regional.nome,
        codigo_cre: regional.codigo_cre || null,
        cidade: regional.cidade || null,
        estado: regional.estado || "DF",
        status: regional.status || "ativa",
        unidades_ativas: unidadesAtivas,
      },
      usuario: {
        id: Number(req.user?.usuario_id || req.user?.usuarioId || 0),
        cargo_regional: req.cargo_regional,
        cargo_label: req.cargo_label,
      },
      kpis: {
        total_escolas: escolas.length,
        escolas_ativas: escolasAtivas,
        total_alunos: totalAlunosRede,
        total_turmas: totalTurmasRede,
        escolas_com_pdaf: escolasComPdaf,
        pdaf_recebido: centsToDecimal(pdafRecebidoCents),
        pdaf_executado: centsToDecimal(pdafExecutadoCents),
        pdaf_saldo: centsToDecimal(pdafRecebidoCents - pdafExecutadoCents),
      },
      chefes,
      escolas,
    });
  } catch (err) {
    console.error("[CRE][GET /gabinete] Erro:", err);
    return res.status(500).json({ ok: false, message: "Erro ao carregar painel do Gabinete Regional." });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// 2) UNIAG — Painel Consolidado de Acompanhamento Financeiro PDAF da Regional
// GET /api/cre/uniag/resumo?exercicio=YYYY
// ══════════════════════════════════════════════════════════════════════════════
router.get("/uniag/resumo", exigirCargoRegional("chefe_uniag"), async (req, res) => {
  const db = req.db || pool;
  const regionalId = Number(req.regional_id);
  const exercicio = parseExercicio(req.query?.exercicio);

  try {
    await ensureFinanceiroTables(db);

    const [[regional]] = await db.query(
      `SELECT id, nome, apelido, codigo_cre, cidade, estado, status
       FROM regionais
       WHERE id = ?
       LIMIT 1`,
      [regionalId]
    );

    if (!regional) {
      return res.status(404).json({ ok: false, message: "Coordenação Regional não encontrada." });
    }

    const [escolasRows] = await db.query(
      `SELECT
         e.id,
         e.nome,
         e.apelido,
         e.cidade,
         e.estado,
         e.cnpj,
         e.status,
         (SELECT dir.nome FROM usuarios dir
          WHERE dir.escola_id = e.id AND dir.perfil = 'diretor' AND dir.ativo = 1
          ORDER BY dir.id DESC LIMIT 1) AS diretor,
         EXISTS(
           SELECT 1 FROM escola_perfil_modulos epm
           WHERE epm.escola_id = e.id AND epm.modulo LIKE 'financeiro%' AND epm.ativo = 1
         ) AS modulo_financeiro_ativo
       FROM escolas e
       WHERE e.regional_id = ?
       ORDER BY e.apelido ASC, e.nome ASC`,
      [regionalId]
    );

    const escolaIds = (escolasRows || []).map((e) => Number(e.id)).filter((id) => id > 0);
    const anoAtual = new Date().getFullYear();
    const anosSet = new Set([anoAtual + 1, anoAtual, anoAtual - 1, exercicio]);

    let todasEntradas = [];
    let todasDespesas = [];
    const entradasPorEscola = new Map();
    const despesasPorEscola = new Map();
    const ultimaMovPorEscola = new Map();

    if (escolaIds.length > 0) {
      const placeholders = escolaIds.map(() => "?").join(", ");
      const [[entRows], [despRows], [anosEnt], [anosDesp]] = await Promise.all([
        db.query(
          `SELECT id, escola_id, fonte_recurso, valor_custeio, valor_capital, atualizado_em
           FROM financeiro_pdaf_entradas
           WHERE exercicio = ? AND escola_id IN (${placeholders})`,
          [exercicio, ...escolaIds]
        ),
        db.query(
          `SELECT id, escola_id, fonte_recurso, valor_custeio, valor_capital, atualizado_em
           FROM financeiro_pdaf_despesas
           WHERE exercicio = ? AND escola_id IN (${placeholders})`,
          [exercicio, ...escolaIds]
        ),
        db.query(
          `SELECT DISTINCT exercicio FROM financeiro_pdaf_entradas WHERE escola_id IN (${placeholders})`,
          escolaIds
        ),
        db.query(
          `SELECT DISTINCT exercicio FROM financeiro_pdaf_despesas WHERE escola_id IN (${placeholders})`,
          escolaIds
        ),
      ]);

      todasEntradas = entRows || [];
      todasDespesas = despRows || [];

      for (const r of anosEnt || []) if (r?.exercicio) anosSet.add(Number(r.exercicio));
      for (const r of anosDesp || []) if (r?.exercicio) anosSet.add(Number(r.exercicio));

      const registrarData = (eid, dt) => {
        if (!dt) return;
        const ts = new Date(dt).getTime();
        if (!Number.isFinite(ts)) return;
        const prev = ultimaMovPorEscola.get(eid) || 0;
        if (ts > prev) ultimaMovPorEscola.set(eid, ts);
      };

      for (const r of todasEntradas) {
        const eid = Number(r.escola_id);
        if (!entradasPorEscola.has(eid)) entradasPorEscola.set(eid, []);
        entradasPorEscola.get(eid).push(r);
        registrarData(eid, r.atualizado_em);
      }

      for (const r of todasDespesas) {
        const eid = Number(r.escola_id);
        if (!despesasPorEscola.has(eid)) despesasPorEscola.set(eid, []);
        despesasPorEscola.get(eid).push(r);
        registrarData(eid, r.atualizado_em);
      }
    }

    const resumoRede = calcularResumoPdaf(todasEntradas, todasDespesas);

    const escolas = (escolasRows || []).map((esc) => {
      const eid = Number(esc.id);
      const entList = entradasPorEscola.get(eid) || [];
      const despList = despesasPorEscola.get(eid) || [];
      const resEscola = calcularResumoPdaf(entList, despList);
      const lastTs = ultimaMovPorEscola.get(eid) || null;

      let situacao = "SEM_LANCAMENTOS";
      if (entList.length > 0 || despList.length > 0) {
        situacao = resEscola.total.saldo_total < -0.005 ? "SALDO_NEGATIVO" : "EM_EXECUCAO";
      }

      return {
        id: eid,
        nome: esc.nome,
        apelido: esc.apelido || esc.nome,
        cidade: esc.cidade || null,
        estado: esc.estado || "DF",
        cnpj: esc.cnpj || null,
        status: esc.status || "ativa",
        diretor: esc.diretor || null,
        modulo_financeiro_ativo: Boolean(esc.modulo_financeiro_ativo) || entList.length > 0 || despList.length > 0,
        entradas_count: entList.length,
        despesas_count: despList.length,
        resumo: resEscola,
        situacao,
        ultima_atualizacao: lastTs ? new Date(lastTs).toISOString() : null,
      };
    });

    const exerciciosDisponiveis = Array.from(anosSet).sort((a, b) => b - a);

    return res.json({
      ok: true,
      exercicio,
      exercicios_disponiveis: exerciciosDisponiveis,
      regional: {
        id: regional.id,
        nome: regional.nome,
        apelido: regional.apelido || regional.nome,
        codigo_cre: regional.codigo_cre || null,
        cidade: regional.cidade || null,
        estado: regional.estado || "DF",
      },
      resumo_rede: resumoRede,
      escolas,
    });
  } catch (err) {
    console.error("[CRE][GET /uniag/resumo] Erro:", err);
    return res.status(500).json({ ok: false, message: "Erro ao carregar painel financeiro da UNIAG." });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// 3) UNIAG — Inspeção Somente-Leitura da Execução PDAF de uma Escola da CRE
// GET /api/cre/uniag/escolas/:escolaId/pdaf?exercicio=YYYY
// ══════════════════════════════════════════════════════════════════════════════
router.get("/uniag/escolas/:escolaId/pdaf", exigirCargoRegional("chefe_uniag"), async (req, res) => {
  const db = req.db || pool;
  const regionalId = Number(req.regional_id);
  const escolaId = Number(req.params.escolaId);
  const exercicio = parseExercicio(req.query?.exercicio);

  if (!escolaId || Number.isNaN(escolaId) || escolaId <= 0) {
    return res.status(400).json({ ok: false, message: "ID de unidade escolar inválido." });
  }

  try {
    await ensureFinanceiroTables(db);

    // 🔒 Trava territorial estrita: a escola DEVE pertencer à regional do gestor logado
    const [[escola]] = await db.query(
      `SELECT
         e.id,
         e.nome,
         e.apelido,
         e.cidade,
         e.estado,
         e.cnpj,
         e.status,
         (SELECT dir.nome FROM usuarios dir
          WHERE dir.escola_id = e.id AND dir.perfil = 'diretor' AND dir.ativo = 1
          ORDER BY dir.id DESC LIMIT 1) AS diretor
       FROM escolas e
       WHERE e.id = ? AND e.regional_id = ?
       LIMIT 1`,
      [escolaId, regionalId]
    );

    if (!escola) {
      return res.status(404).json({
        ok: false,
        message: "Unidade escolar não encontrada ou não vinculada a esta Coordenação Regional.",
      });
    }

    const [[entradas], [despesas]] = await Promise.all([
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
    ]);

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
      somente_leitura: true,
      exercicio,
      escola: {
        id: escola.id,
        nome: escola.nome,
        apelido: escola.apelido || escola.nome,
        cidade: escola.cidade || null,
        estado: escola.estado || "DF",
        cnpj: escola.cnpj || null,
        status: escola.status || "ativa",
        diretor: escola.diretor || null,
      },
      resumo,
      entradas: entradasFmt,
      despesas: despesasFmt,
    });
  } catch (err) {
    console.error("[CRE][GET /uniag/escolas/:escolaId/pdaf] Erro:", err);
    return res.status(500).json({ ok: false, message: "Erro ao inspecionar execução financeira da escola." });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// 4) FOTO DO PERFIL DO GESTOR REGIONAL (compatível com HeaderGlobal)
// GET & POST /api/cre/me/foto
// ══════════════════════════════════════════════════════════════════════════════
router.get("/me/foto", async (req, res) => {
  try {
    const userId = Number(req.user?.usuario_id || req.user?.usuarioId || req.user?.id || 0);
    if (!userId) return res.status(400).json({ ok: false, message: "Usuário não identificado." });

    const [[row]] = await pool.query(
      "SELECT COALESCE(foto, '') AS foto_url FROM usuarios WHERE id = ? LIMIT 1",
      [userId]
    );

    let fotoUrl = row?.foto_url ? String(row.foto_url) : "";
    if (fotoUrl && !fotoUrl.startsWith("http")) {
      const bucket = process.env.DO_SPACES_BUCKET || process.env.SPACES_BUCKET || "educa-melhor-uploads";
      const region = process.env.DO_SPACES_REGION || process.env.SPACES_REGION || "nyc3";
      const key = fotoUrl.replace(/^\/+/, "");
      fotoUrl = `https://${bucket}.${region}.digitaloceanspaces.com/${key}`;
    }

    return res.json({ foto_url: fotoUrl });
  } catch (err) {
    console.error("[CRE][GET /me/foto] Erro:", err);
    return res.status(500).json({ ok: false, message: "Erro ao buscar foto do perfil." });
  }
});

router.post("/me/foto", crePhotoUpload.single("foto"), async (req, res) => {
  try {
    const userId = Number(req.user?.usuario_id || req.user?.usuarioId || req.user?.id || 0);
    const regionalId = Number(req.regional_id || 0);
    if (!userId || !regionalId || !req.file) {
      return res.status(400).json({ ok: false, message: "Arquivo ou contexto regional inválido." });
    }

    const ext = req.__cre_photo_ext || "jpg";
    const fotoUrl = `/uploads/cre_${regionalId}/usuarios/${userId}.${ext}`;

    if (s3Cre) {
      const key = fotoUrl.replace(/^\/+/, "");
      const buffer = await fs.promises.readFile(req.file.path);
      await s3Cre.send(
        new PutObjectCommand({
          Bucket: SPACES_BUCKET,
          Key: key,
          Body: buffer,
          ACL: "public-read",
          ContentType: req.file.mimetype,
          CacheControl: "public, max-age=31536000",
        })
      );
    }

    await pool.query("UPDATE usuarios SET foto = ? WHERE id = ?", [fotoUrl, userId]);
    return res.json({ foto_url: fotoUrl });
  } catch (err) {
    console.error("[CRE][POST /me/foto] Erro:", err);
    return res.status(500).json({ ok: false, message: "Erro ao salvar foto do perfil." });
  }
});

export default router;
