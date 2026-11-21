// routes/cre.js
// ============================================================================
// MÓDULO CRE — Coordenações Regionais de Ensino (SEEDF)
// Ambiente isolado (scope: "cre" + verificarRegional)
// Escopo Operacional (Passo 1 + Passo 2B):
//   1. Gabinete Regional (/api/cre/gabinete) — Visão executiva consolidada da Rede CRE
//   2. UNIAG (/api/cre/uniag/*) — Fluxo Trimestral de Pré-Auditoria SEI do PDAF:
//      - Consolidação trimestral por escola (Portarias, Emendas, Rendimentos, Despesas)
//      - Decisão institucional UNIAG (EM_ANALISE, EM_DILIGENCIA com parecer, VALIDADO_SEI)
//      - Exportação idêntica da Planilha Oficial .xlsx de 5 Abas (Padrão SEEDF)
// ============================================================================

import express from "express";
import fs from "fs";
import path, { dirname as _dirname } from "path";
import { fileURLToPath } from "url";
import multer from "multer";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import pool from "../db.js";
import {
  ensureFinanceiroTables,
  parseExercicio,
  toCents,
  centsToDecimal,
  calcularExercicioCompletoPdaf,
  carregarDadosCompletosPdafEscola,
  gerarBufferPlanilhaPdaf,
} from "./financeiro.js";
import {
  CARGOS_CRE_LABELS,
  exigirCargoRegional,
} from "../middleware/verificarRegional.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = _dirname(__filename);

const router = express.Router();

function getGestorCreLabel(req) {
  const nome = String(req.user?.nome || "").trim();
  const cargo = String(req.cargo_label || req.cargo_regional || "UNIAG/CRE").trim();
  if (nome && cargo) return `${nome} (${cargo})`;
  return nome || cargo;
}

// ── Carregador em lote dos dados PDAF de todas as escolas de uma Regional ──
async function carregarMapaPdafEscolasRegional(db, escolasRows = [], exercicioRaw) {
  const exercicio = parseExercicio(exercicioRaw);
  const escolaIds = (escolasRows || [])
    .map((e) => Number(e.id))
    .filter((id) => id > 0);

  const anoAtual = new Date().getFullYear();
  const anosSet = new Set([anoAtual + 1, anoAtual, anoAtual - 1, exercicio]);

  const uexMap = new Map();
  const portariasMap = new Map();
  const rendMapPorEscola = new Map();
  const despesasMap = new Map();
  const prestacoesMapPorEscola = new Map();

  if (escolaIds.length > 0) {
    const placeholders = escolaIds.map(() => "?").join(", ");
    const [
      [uexRows],
      [portRows],
      [rendRows],
      [despRows],
      [prestRows],
      [anosPort],
      [anosDesp],
    ] = await Promise.all([
      db.query(
        `SELECT escola_id, nome_uex, cnpj, endereco
           FROM financeiro_uex_config
          WHERE escola_id IN (${placeholders})`,
        escolaIds
      ),
      db.query(
        `SELECT
           id, escola_id, exercicio, tipo, numero_portaria, titulo_portaria,
           DATE_FORMAT(data_portaria, '%Y-%m-%d') AS data_portaria,
           eh_reprogramado, trimestre_entrada,
           credito_custeio, credito_capital,
           deputado, processo_sei_liberacao,
           DATE_FORMAT(data_pagamento_credito, '%Y-%m-%d') AS data_pagamento_credito,
           destinacao_oficio, atualizado_em
         FROM financeiro_pdaf_portarias
         WHERE exercicio = ? AND escola_id IN (${placeholders})
         ORDER BY eh_reprogramado DESC, data_portaria ASC, id ASC`,
        [exercicio, ...escolaIds]
      ),
      db.query(
        `SELECT escola_id, mes, valor, atualizado_em
           FROM financeiro_pdaf_rendimentos
          WHERE exercicio = ? AND escola_id IN (${placeholders})`,
        [exercicio, ...escolaIds]
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
           d.atualizado_em
         FROM financeiro_pdaf_despesas d
         LEFT JOIN financeiro_pdaf_portarias p ON p.id = d.portaria_id
         WHERE d.exercicio = ? AND d.escola_id IN (${placeholders})
         ORDER BY d.data_pagamento ASC, d.id ASC`,
        [exercicio, ...escolaIds]
      ),
      db.query(
        `SELECT
           escola_id, trimestre, status, processo_sei_prestacao,
           observacoes_escola, parecer_uniag,
           enviado_por, enviado_em, analisado_por, analisado_em, atualizado_em
         FROM financeiro_pdaf_prestacoes
         WHERE exercicio = ? AND escola_id IN (${placeholders})`,
        [exercicio, ...escolaIds]
      ),
      db.query(
        `SELECT DISTINCT exercicio FROM financeiro_pdaf_portarias WHERE escola_id IN (${placeholders})`,
        escolaIds
      ),
      db.query(
        `SELECT DISTINCT exercicio FROM financeiro_pdaf_despesas WHERE escola_id IN (${placeholders})`,
        escolaIds
      ),
    ]);

    for (const r of anosPort || []) if (r?.exercicio) anosSet.add(Number(r.exercicio));
    for (const r of anosDesp || []) if (r?.exercicio) anosSet.add(Number(r.exercicio));

    for (const u of uexRows || []) {
      uexMap.set(Number(u.escola_id), u);
    }

    for (const p of portRows || []) {
      const eid = Number(p.escola_id);
      if (!portariasMap.has(eid)) portariasMap.set(eid, []);
      portariasMap.get(eid).push({
        ...p,
        eh_reprogramado: Number(p.eh_reprogramado) === 1,
        trimestre_entrada: Number(p.trimestre_entrada || 1),
        credito_custeio: Number(p.credito_custeio || 0),
        credito_capital: Number(p.credito_capital || 0),
      });
    }

    for (const r of rendRows || []) {
      const eid = Number(r.escola_id);
      if (!rendMapPorEscola.has(eid)) {
        const zero = {};
        for (let m = 0; m <= 12; m++) zero[m] = 0;
        rendMapPorEscola.set(eid, zero);
      }
      const m = Number(r.mes);
      if (m >= 0 && m <= 12) {
        rendMapPorEscola.get(eid)[m] = Number(r.valor || 0);
      }
    }

    for (const d of despRows || []) {
      const eid = Number(d.escola_id);
      if (!despesasMap.has(eid)) despesasMap.set(eid, []);
      despesasMap.get(eid).push({
        ...d,
        trimestre: Number(d.trimestre || 1),
        portaria_id: d.portaria_id ? Number(d.portaria_id) : null,
        fonte_codigo:
          d.fonte_recurso === "RENDIMENTO"
            ? "Rendimentos"
            : d.numero_portaria || d.fonte_recurso,
        valor_custeio: Number(d.valor_custeio || 0),
        valor_capital: Number(d.valor_capital || 0),
      });
    }

    for (const pr of prestRows || []) {
      const eid = Number(pr.escola_id);
      if (!prestacoesMapPorEscola.has(eid)) prestacoesMapPorEscola.set(eid, {});
      prestacoesMapPorEscola.get(eid)[Number(pr.trimestre)] = pr;
    }
  }

  const calculosPorEscola = new Map();

  for (const esc of escolasRows || []) {
    const eid = Number(esc.id);
    const uexRow = uexMap.get(eid) || null;
    const uex = {
      configurada: Boolean(uexRow),
      nome_uex:
        uexRow?.nome_uex ||
        `CAIXA ESCOLAR — ${esc.apelido || esc.nome || "UNIDADE ESCOLAR"}`,
      cnpj: uexRow?.cnpj || esc.cnpj || "",
      endereco: uexRow?.endereco || "",
    };

    const portarias = portariasMap.get(eid) || [];
    const rendimentosMap = rendMapPorEscola.get(eid) || {};
    const despesas = despesasMap.get(eid) || [];
    const prestacoesMap = prestacoesMapPorEscola.get(eid) || {};

    const calc = calcularExercicioCompletoPdaf({
      exercicio,
      uex,
      portarias,
      rendimentosMap,
      despesas,
      prestacoesMap,
    });

    calculosPorEscola.set(eid, {
      uex,
      portarias,
      rendimentosMap,
      despesas,
      prestacoesMap,
      calculado: calc,
    });
  }

  return {
    exercicio,
    exerciciosDisponiveis: Array.from(anosSet).sort((a, b) => b - a),
    calculosPorEscola,
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

    const { exerciciosDisponiveis, calculosPorEscola } =
      await carregarMapaPdafEscolasRegional(db, escolasRows, exercicio);

    let totalAlunosRede = 0;
    let totalTurmasRede = 0;
    let pdafRecebidoCents = 0;
    let pdafExecutadoCents = 0;
    let escolasComPdaf = 0;
    let remessasAguardandoUniag = 0;
    let remessasValidadasSei = 0;

    const escolas = (escolasRows || []).map((esc) => {
      const eid = Number(esc.id);
      const pack = calculosPorEscola.get(eid);
      const resumoEsc = pack?.calculado?.resumo?.total || {
        entradas_total: 0,
        saidas_total: 0,
        saldo_total: 0,
      };

      const alunosNum = Number(esc.total_alunos || 0);
      const turmasNum = Number(esc.total_turmas || 0);
      totalAlunosRede += alunosNum;
      totalTurmasRede += turmasNum;

      const recCents = toCents(resumoEsc.entradas_total);
      const exeCents = toCents(resumoEsc.saidas_total);
      pdafRecebidoCents += recCents;
      pdafExecutadoCents += exeCents;

      const portCount = pack?.portarias?.length || 0;
      const despCount = pack?.despesas?.length || 0;
      const temRend = Object.values(pack?.rendimentosMap || {}).some((v) => Number(v) > 0);
      const temMovimentacaoPdaf = portCount > 0 || despCount > 0 || temRend;
      if (temMovimentacaoPdaf) escolasComPdaf += 1;

      const statusTrimestres = {};
      for (let t = 1; t <= 4; t++) {
        const st = pack?.calculado?.trimestres?.[t]?.status || "EM_ELABORACAO";
        statusTrimestres[t] = st;
        if (st === "ENVIADO_UNIAG" || st === "EM_ANALISE") remessasAguardandoUniag += 1;
        if (st === "VALIDADO_SEI") remessasValidadasSei += 1;
      }

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
        cnpj: pack?.uex?.cnpj || esc.cnpj,
        uex_nome: pack?.uex?.nome_uex || null,
        tipos: tiposArr,
        status: esc.status || "ativa",
        diretor: esc.diretor || null,
        comandante: esc.comandante || null,
        total_alunos: alunosNum,
        total_turmas: turmasNum,
        modulo_financeiro_ativo: Boolean(esc.modulo_financeiro_ativo) || temMovimentacaoPdaf,
        pdaf: {
          entradas_count: portCount,
          despesas_count: despCount,
          recebido: resumoEsc.entradas_total,
          executado: resumoEsc.saidas_total,
          saldo: resumoEsc.saldo_total,
          trimestres_status: statusTrimestres,
        },
      };
    });

    const escolasAtivas = escolas.filter(
      (e) => String(e.status).toLowerCase() === "ativa"
    ).length;

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
        remessas_aguardando_uniag: remessasAguardandoUniag,
        remessas_validadas_sei: remessasValidadasSei,
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
// 2) UNIAG — Resumo Modular Trimestral de Todas as Escolas da Regional
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

    const { exerciciosDisponiveis, calculosPorEscola } =
      await carregarMapaPdafEscolasRegional(db, escolasRows, exercicio);

    // Consolidação por trimestre (1..4) para alimentar os 4 botões modulares da UNIAG
    const trimestresRede = {};
    for (let t = 1; t <= 4; t++) {
      trimestresRede[t] = {
        trimestre: t,
        total_escolas: escolasRows.length,
        aguardando_analise: 0,
        em_diligencia: 0,
        validados_sei: 0,
        em_elaboracao: 0,
        saldos_rede: {
          ordinario_cents: 0,
          emenda_cents: 0,
          rendimento_cents: 0,
          total_cents: 0,
        },
      };
    }

    const escolas = (escolasRows || []).map((esc) => {
      const eid = Number(esc.id);
      const pack = calculosPorEscola.get(eid);
      const trisCalc = pack?.calculado?.trimestres || {};

      const trimestresResumoEscola = {};

      for (let t = 1; t <= 4; t++) {
        const td = trisCalc[t] || {};
        const st = td.status || "EM_ELABORACAO";

        if (st === "ENVIADO_UNIAG" || st === "EM_ANALISE") {
          trimestresRede[t].aguardando_analise += 1;
        } else if (st === "EM_DILIGENCIA") {
          trimestresRede[t].em_diligencia += 1;
        } else if (st === "VALIDADO_SEI") {
          trimestresRede[t].validados_sei += 1;
        } else {
          trimestresRede[t].em_elaboracao += 1;
        }

        const sOrd = toCents(td?.saldos_topo?.ordinario || 0);
        const sEme = toCents(td?.saldos_topo?.emenda || 0);
        const sRen = toCents(td?.saldos_topo?.rendimento || 0);
        const sTot = toCents(td?.saldos_topo?.total_recursos || 0);

        trimestresRede[t].saldos_rede.ordinario_cents += sOrd;
        trimestresRede[t].saldos_rede.emenda_cents += sEme;
        trimestresRede[t].saldos_rede.rendimento_cents += sRen;
        trimestresRede[t].saldos_rede.total_cents += sTot;

        const errosCount = (td?.pendencias || []).filter((p) => p.nivel === "ERRO").length;
        const portariasVigentes =
          (td?.ordinario?.linhas?.length || 0) + (td?.emendas?.linhas?.length || 0);

        trimestresResumoEscola[t] = {
          status: st,
          saldos_topo: td?.saldos_topo || {
            ordinario: 0,
            emenda: 0,
            rendimento: 0,
            total_recursos: 0,
          },
          portarias_count: portariasVigentes,
          despesas_count: td?.despesas?.length || 0,
          pendencias_erro_count: errosCount,
          enviado_em: td?.prestacao?.enviado_em || null,
          analisado_em: td?.prestacao?.analisado_em || null,
          processo_sei_prestacao: td?.prestacao?.processo_sei_prestacao || null,
        };
      }

      return {
        id: eid,
        nome: esc.nome,
        apelido: esc.apelido || esc.nome,
        cidade: esc.cidade || null,
        estado: esc.estado || "DF",
        cnpj: pack?.uex?.cnpj || esc.cnpj || null,
        uex_nome: pack?.uex?.nome_uex || null,
        status: esc.status || "ativa",
        diretor: esc.diretor || null,
        modulo_financeiro_ativo:
          Boolean(esc.modulo_financeiro_ativo) ||
          (pack?.portarias?.length || 0) > 0 ||
          (pack?.despesas?.length || 0) > 0,
        resumo_anual: pack?.calculado?.resumo || null,
        trimestres: trimestresResumoEscola,
      };
    });

    const trimestresRedeFormatados = {};
    for (let t = 1; t <= 4; t++) {
      const tr = trimestresRede[t];
      trimestresRedeFormatados[t] = {
        trimestre: t,
        total_escolas: tr.total_escolas,
        aguardando_analise: tr.aguardando_analise,
        em_diligencia: tr.em_diligencia,
        validados_sei: tr.validados_sei,
        em_elaboracao: tr.em_elaboracao,
        saldos_topo: {
          ordinario: centsToDecimal(tr.saldos_rede.ordinario_cents),
          emenda: centsToDecimal(tr.saldos_rede.emenda_cents),
          rendimento: centsToDecimal(tr.saldos_rede.rendimento_cents),
          total_recursos: centsToDecimal(tr.saldos_rede.total_cents),
        },
      };
    }

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
      trimestres_rede: trimestresRedeFormatados,
      escolas,
    });
  } catch (err) {
    console.error("[CRE][GET /uniag/resumo] Erro:", err);
    return res.status(500).json({ ok: false, message: "Erro ao carregar painel financeiro da UNIAG." });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// 3) UNIAG — Espelho Completo da Prestação de Contas PDAF de uma Escola da CRE
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

    // Trava territorial estrita: a escola DEVE pertencer à regional do gestor logado
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

    const dadosPdaf = await carregarDadosCompletosPdafEscola(db, escolaId, exercicio);

    return res.json({
      ...dadosPdaf,
      somente_leitura: true,
      escola: {
        id: escola.id,
        nome: escola.nome,
        apelido: escola.apelido || escola.nome,
        cidade: escola.cidade || null,
        estado: escola.estado || "DF",
        cnpj: dadosPdaf?.uex?.cnpj || escola.cnpj || null,
        status: escola.status || "ativa",
        diretor: escola.diretor || null,
      },
    });
  } catch (err) {
    console.error("[CRE][GET /uniag/escolas/:escolaId/pdaf] Erro:", err);
    return res.status(500).json({ ok: false, message: "Erro ao inspecionar execução financeira da escola." });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// 4) UNIAG — Decisão de Pré-Auditoria SEI sobre o Trimestre da Escola
// POST /api/cre/uniag/escolas/:escolaId/trimestres/:trimestre/avaliar
// body: { exercicio, acao: 'EM_ANALISE' | 'EM_DILIGENCIA' | 'VALIDADO_SEI', parecer_uniag, processo_sei_prestacao }
// ══════════════════════════════════════════════════════════════════════════════
router.post(
  "/uniag/escolas/:escolaId/trimestres/:trimestre/avaliar",
  exigirCargoRegional("chefe_uniag"),
  async (req, res) => {
    const db = req.db || pool;
    const regionalId = Number(req.regional_id);
    const escolaId = Number(req.params.escolaId);
    const trimestre = Number(req.params.trimestre);
    const exercicio = parseExercicio(req.body?.exercicio);
    const acao = String(req.body?.acao || "").toUpperCase().trim();
    const parecerUniag = String(req.body?.parecer_uniag || "").trim();
    const processoSei = req.body?.processo_sei_prestacao
      ? String(req.body.processo_sei_prestacao).trim()
      : null;

    if (!escolaId || ![1, 2, 3, 4].includes(trimestre)) {
      return res.status(400).json({ ok: false, message: "Escola ou trimestre inválido." });
    }

    const ACOES_PERMITIDAS = new Set(["EM_ANALISE", "EM_DILIGENCIA", "VALIDADO_SEI"]);
    if (!ACOES_PERMITIDAS.has(acao)) {
      return res.status(400).json({
        ok: false,
        message: "Ação inválida. Use EM_ANALISE, EM_DILIGENCIA ou VALIDADO_SEI.",
      });
    }

    if (acao === "EM_DILIGENCIA" && !parecerUniag) {
      return res.status(400).json({
        ok: false,
        message: "Informe no parecer técnico os ajustes que a direção da escola precisa realizar na diligência.",
      });
    }

    try {
      await ensureFinanceiroTables(db);

      const [[escola]] = await db.query(
        "SELECT id, nome, apelido FROM escolas WHERE id = ? AND regional_id = ? LIMIT 1",
        [escolaId, regionalId]
      );
      if (!escola) {
        return res.status(404).json({
          ok: false,
          message: "Unidade escolar não encontrada ou fora da jurisdição desta CRE.",
        });
      }

      if (acao === "VALIDADO_SEI") {
        const dadosPdaf = await carregarDadosCompletosPdafEscola(db, escolaId, exercicio);
        const triData = dadosPdaf?.trimestres?.[trimestre];
        const erros = (triData?.pendencias || []).filter((p) => p.nivel === "ERRO");
        if (erros.length > 0) {
          return res.status(422).json({
            ok: false,
            message: `Não é possível validar para o SEI enquanto houver ${erros.length} inconsistência(s) contábil(is) bloqueante(s). Devolva em diligência para correção.`,
            pendencias: erros,
          });
        }
      }

      const gestorLabel = getGestorCreLabel(req);

      await db.query(
        `INSERT INTO financeiro_pdaf_prestacoes (
           escola_id, exercicio, trimestre, status,
           processo_sei_prestacao, parecer_uniag,
           analisado_por, analisado_em
         ) VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE
           status = VALUES(status),
           processo_sei_prestacao = COALESCE(VALUES(processo_sei_prestacao), processo_sei_prestacao),
           parecer_uniag = VALUES(parecer_uniag),
           analisado_por = VALUES(analisado_por),
           analisado_em = NOW()`,
        [
          escolaId,
          exercicio,
          trimestre,
          acao,
          processoSei,
          parecerUniag || null,
          gestorLabel,
        ]
      );

      const mensagens = {
        EM_ANALISE: `${trimestre}º Trimestre colocado em conferência técnica pela UNIAG.`,
        EM_DILIGENCIA: `${trimestre}º Trimestre devolvido em diligência para ajustes da escola.`,
        VALIDADO_SEI: `${trimestre}º Trimestre validado pela UNIAG! Liberado para autuação no SEI.`,
      };

      return res.json({
        ok: true,
        status: acao,
        message: mensagens[acao],
      });
    } catch (err) {
      console.error("[CRE][POST /uniag/avaliar] Erro:", err);
      return res.status(500).json({
        ok: false,
        message: "Erro ao registrar parecer da UNIAG sobre o trimestre.",
      });
    }
  }
);

// ══════════════════════════════════════════════════════════════════════════════
// 5) UNIAG — Exportar Planilha Oficial .xlsx de 5 Abas de uma Escola da CRE
// GET /api/cre/uniag/escolas/:escolaId/exportar-xlsx?exercicio=YYYY
// ══════════════════════════════════════════════════════════════════════════════
router.get(
  "/uniag/escolas/:escolaId/exportar-xlsx",
  exigirCargoRegional("chefe_uniag"),
  async (req, res) => {
    const db = req.db || pool;
    const regionalId = Number(req.regional_id);
    const escolaId = Number(req.params.escolaId);
    const exercicio = parseExercicio(req.query?.exercicio);

    if (!escolaId || Number.isNaN(escolaId) || escolaId <= 0) {
      return res.status(400).json({ ok: false, message: "ID de unidade escolar inválido." });
    }

    try {
      await ensureFinanceiroTables(db);

      const [[escola]] = await db.query(
        "SELECT id, nome, apelido FROM escolas WHERE id = ? AND regional_id = ? LIMIT 1",
        [escolaId, regionalId]
      );
      if (!escola) {
        return res.status(404).json({
          ok: false,
          message: "Unidade escolar não encontrada ou não vinculada a esta Coordenação Regional.",
        });
      }

      const dadosPdaf = await carregarDadosCompletosPdafEscola(db, escolaId, exercicio);
      const buffer = gerarBufferPlanilhaPdaf(dadosPdaf);

      const apelidoLimpo = String(escola.apelido || escola.nome || `ESCOLA_${escolaId}`)
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
      console.error("[CRE][EXPORTAR XLSX ESCOLA] Erro:", err);
      return res.status(500).json({
        ok: false,
        message: "Erro ao gerar planilha oficial .xlsx da unidade escolar.",
      });
    }
  }
);

// ══════════════════════════════════════════════════════════════════════════════
// 6) FOTO DO PERFIL DO GESTOR REGIONAL (compatível com HeaderGlobal)
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
