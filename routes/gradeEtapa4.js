// routes/gradeEtapa4.js
// ============================================================================
// Rotas ETAPA 4 — Versionamento (Cenários A-B-C), Qualidade Pedagógica &
// Substituição de Professores com Preservação Integral de Diários
// Montado sob /api/grade via gradePublish.js
// ============================================================================

import express from "express";
import pool from "../db.js";
import {
  listarCenariosTurno,
  salvarCenarioGrade,
  atualizarMetadadosCenario,
  excluirCenarioGrade,
  aplicarCenarioNaGrade,
  avaliarQualidadePedagogicaSlots,
  simularSubstituicaoProfessor,
  executarSubstituicaoProfessor,
  listarHistoricoSubstituicoes,
  reverterSubstituicaoProfessor,
} from "../services/gradeEtapa4Service.js";

const router = express.Router();

function requireEscola(req, res, next) {
  const escolaId = req.user?.escola_id || Number(req.headers["x-escola-id"]);
  if (!escolaId) return res.status(403).json({ ok: false, error: "Acesso negado: escola não definida." });
  req.escolaId = Number(escolaId);
  next();
}

function extrairUsuario(req) {
  return {
    id:
      req.user?.id ||
      req.user?.usuario_id ||
      req.user?.userId ||
      req.user?.usuarioId ||
      null,
    nome: req.user?.nome || req.user?.name || req.user?.email || null,
  };
}

// ----------------------------------------------------------------------------
// 1. CENÁRIOS A-B-C & HISTÓRICO DE VERSÕES PUBLICADAS
// ----------------------------------------------------------------------------

// GET /api/grade/cenarios?turno=matutino&semestre=1
router.get("/cenarios", requireEscola, async (req, res) => {
  try {
    const turno = String(req.query.turno || "matutino").trim();
    const semestre = req.query.semestre ? Number(req.query.semestre) : null;
    const data = await listarCenariosTurno(pool, {
      escolaId: req.escolaId,
      turno,
      semestre,
    });
    return res.json({ ok: true, ...data });
  } catch (err) {
    console.error("GET /api/grade/cenarios:", err);
    return res.status(500).json({ ok: false, error: err?.message || "Falha ao carregar cenários da grade." });
  }
});

// POST /api/grade/cenarios
router.post("/cenarios", requireEscola, async (req, res) => {
  try {
    const {
      turno,
      semestre,
      codigo_cenario,
      nome,
      descricao,
      tipo,
      favorito,
      origem_dados,
      slots,
      sobrescrever_codigo = true,
    } = req.body || {};

    if (!turno) {
      return res.status(400).json({ ok: false, error: "Parâmetro 'turno' é obrigatório." });
    }

    const out = await salvarCenarioGrade(pool, {
      escolaId: req.escolaId,
      turno,
      semestre,
      codigo_cenario,
      nome,
      descricao,
      tipo: tipo || "CENARIO",
      favorito: Boolean(favorito),
      origem_dados: origem_dados || "rascunho",
      slots_custom: Array.isArray(slots) && slots.length > 0 ? slots : null,
      sobrescrever_codigo: Boolean(sobrescrever_codigo),
      usuario: extrairUsuario(req),
    });

    return res.json({ ok: true, ...out });
  } catch (err) {
    console.error("POST /api/grade/cenarios:", err);
    return res.status(400).json({ ok: false, error: err?.message || "Falha ao salvar cenário." });
  }
});

// PUT /api/grade/cenarios/:id
router.put("/cenarios/:id", requireEscola, async (req, res) => {
  try {
    const cenarioId = Number(req.params.id);
    if (!cenarioId) return res.status(400).json({ ok: false, error: "ID do cenário inválido." });
    const { nome, descricao, codigo_cenario, favorito } = req.body || {};
    const out = await atualizarMetadadosCenario(pool, {
      escolaId: req.escolaId,
      cenarioId,
      nome,
      descricao,
      codigo_cenario,
      favorito,
    });
    return res.json(out);
  } catch (err) {
    console.error("PUT /api/grade/cenarios/:id:", err);
    return res.status(400).json({ ok: false, error: err?.message || "Falha ao atualizar cenário." });
  }
});

// POST /api/grade/cenarios/:id/aplicar
router.post("/cenarios/:id/aplicar", requireEscola, async (req, res) => {
  try {
    const cenarioId = Number(req.params.id);
    if (!cenarioId) return res.status(400).json({ ok: false, error: "ID do cenário inválido." });
    const publicarDireto = Boolean(req.body?.publicar_direto);
    const out = await aplicarCenarioNaGrade(pool, {
      escolaId: req.escolaId,
      cenarioId,
      publicarDireto,
      usuario: extrairUsuario(req),
    });
    return res.json(out);
  } catch (err) {
    console.error("POST /api/grade/cenarios/:id/aplicar:", err);
    return res.status(400).json({ ok: false, error: err?.message || "Falha ao aplicar cenário na grade." });
  }
});

// DELETE /api/grade/cenarios/:id
router.delete("/cenarios/:id", requireEscola, async (req, res) => {
  try {
    const cenarioId = Number(req.params.id);
    if (!cenarioId) return res.status(400).json({ ok: false, error: "ID do cenário inválido." });
    const out = await excluirCenarioGrade(pool, {
      escolaId: req.escolaId,
      cenarioId,
    });
    return res.json(out);
  } catch (err) {
    console.error("DELETE /api/grade/cenarios/:id:", err);
    return res.status(400).json({ ok: false, error: err?.message || "Falha ao excluir cenário." });
  }
});

// POST /api/grade/qualidade/avaliar
router.post("/qualidade/avaliar", requireEscola, async (req, res) => {
  try {
    const { turno = "matutino", slots = [], payload = null } = req.body || {};
    const metricas = avaliarQualidadePedagogicaSlots({ slots, payload, turno });
    return res.json({ ok: true, metricas });
  } catch (err) {
    console.error("POST /api/grade/qualidade/avaliar:", err);
    return res.status(400).json({ ok: false, error: err?.message || "Falha ao calcular qualidade pedagógica." });
  }
});

// ----------------------------------------------------------------------------
// 2. SUBSTITUIÇÃO DE PROFESSORES COM PRESERVAÇÃO DE DIÁRIOS E REVERSÃO
// ----------------------------------------------------------------------------

// GET /api/grade/substituicoes?turno=matutino
router.get("/substituicoes", requireEscola, async (req, res) => {
  try {
    const turno = req.query.turno ? String(req.query.turno) : null;
    const historico = await listarHistoricoSubstituicoes(pool, {
      escolaId: req.escolaId,
      turno,
    });
    return res.json({ ok: true, historico });
  } catch (err) {
    console.error("GET /api/grade/substituicoes:", err);
    return res.status(500).json({ ok: false, error: err?.message || "Falha ao listar substituições." });
  }
});

// POST /api/grade/substituicoes/simular
router.post("/substituicoes/simular", requireEscola, async (req, res) => {
  try {
    const {
      turno = "matutino",
      semestre = null,
      professor_titular_id,
      professor_substituto_id,
      turma_ids_filtro = null,
    } = req.body || {};

    const out = await simularSubstituicaoProfessor(pool, {
      escolaId: req.escolaId,
      turno,
      semestre,
      professor_titular_id,
      professor_substituto_id,
      turma_ids_filtro,
    });
    return res.json(out);
  } catch (err) {
    console.error("POST /api/grade/substituicoes/simular:", err);
    return res.status(400).json({ ok: false, error: err?.message || "Falha ao simular substituição." });
  }
});

// POST /api/grade/substituicoes/executar
router.post("/substituicoes/executar", requireEscola, async (req, res) => {
  try {
    const {
      turno = "matutino",
      semestre = null,
      professor_titular_id,
      professor_substituto_id,
      turma_ids_filtro = null,
      motivo = "SUBSTITUICAO_TEMPORARIA",
      observacao = null,
      data_inicio = null,
      data_fim_prevista = null,
      sincronizar_modulacao = true,
      manter_fixacoes = true,
      pular_slots_em_colisao = false,
      inativar_titular = false,
    } = req.body || {};

    const out = await executarSubstituicaoProfessor(pool, {
      escolaId: req.escolaId,
      turno,
      semestre,
      professor_titular_id,
      professor_substituto_id,
      turma_ids_filtro,
      motivo,
      observacao,
      data_inicio,
      data_fim_prevista,
      sincronizar_modulacao: Boolean(sincronizar_modulacao),
      manter_fixacoes: Boolean(manter_fixacoes),
      pular_slots_em_colisao: Boolean(pular_slots_em_colisao),
      inativar_titular: Boolean(inativar_titular),
      usuario: extrairUsuario(req),
    });
    return res.json(out);
  } catch (err) {
    console.error("POST /api/grade/substituicoes/executar:", err);
    return res.status(err?.code === "SUBSTITUICAO_COLISAO_TURNO" ? 409 : 400).json({
      ok: false,
      code: err?.code || "ERRO_SUBSTITUICAO",
      error: err?.message || "Falha ao executar substituição de professor.",
      simulacao: err?.simulacao || undefined,
    });
  }
});

// POST /api/grade/substituicoes/:id/reverter
router.post("/substituicoes/:id/reverter", requireEscola, async (req, res) => {
  try {
    const substituicaoId = Number(req.params.id);
    if (!substituicaoId) return res.status(400).json({ ok: false, error: "ID inválido." });
    const { data_retorno_efetivo = null, observacao_retorno = null } = req.body || {};
    const out = await reverterSubstituicaoProfessor(pool, {
      escolaId: req.escolaId,
      substituicaoId,
      data_retorno_efetivo,
      observacao_retorno,
      usuario: extrairUsuario(req),
    });
    return res.json(out);
  } catch (err) {
    console.error("POST /api/grade/substituicoes/:id/reverter:", err);
    return res.status(400).json({ ok: false, error: err?.message || "Falha ao reverter substituição." });
  }
});

export default router;
