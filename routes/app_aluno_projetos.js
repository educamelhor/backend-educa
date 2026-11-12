// routes/app_aluno_projetos.js
// ============================================================================
// EDUCA.MELHOR — Ponte API Mobile (Educa Mobile: Estudante & Responsável)
// Submódulo: PROJETOS DO NOVO ENSINO MÉDIO (Escolha Semestral de Projetos)
// ----------------------------------------------------------------------------
// Base URL montada em server.js (ANTES do catch-all autenticarToken):
//   • /api/app-pais/aluno/projetos
//
// Autenticação:
//   • Header: Authorization: Bearer <token> (assinado com APP_PAIS_JWT_SECRET)
//   • Suporta:
//       1) Token de ESTUDANTE (`payload.tipo === "ALUNO"`): leitura + inscrição
//          + troca de turma + cancelamento (enquanto `inscricao_aberta = 1`).
//       2) Token de RESPONSÁVEL (`payload.tipo === "RESPONSAVEL"` + `?aluno_id=`):
//          consulta em modo somente leitura validando vínculo ativo em
//          `responsaveis_alunos`.
//
// Endpoints:
//   • GET  /api/app-pais/aluno/projetos?semestre=&ano_letivo=&aluno_id=
//       Retorna elegibilidade do estudante (Ensino Médio), projetos disponíveis
//       para sua série/turno com sinopse e vagas restantes por turma, além de
//       `minhas_inscricoes`.
//   • POST /api/app-pais/aluno/projetos/inscrever
//       Body: { agrupamento_id }
//       Inscreve (ou troca de turma dentro do mesmo projeto) com lock pessimista
//       `SELECT ... FOR UPDATE` garantindo zero overbooking simultâneo.
//   • POST /api/app-pais/aluno/projetos/cancelar
//       Body: { agrupamento_id }
//       Cancela inscrição enquanto o projeto estiver com `inscricao_aberta = 1`.
// ============================================================================

import express from "express";
import jwt from "jsonwebtoken";
import pool from "../db.js";
import {
  CATEGORIAS_EM,
  ensureMatriculasProjetosSchema,
  obterEixosEscola,
} from "./matriculasProjetos.js";

const router = express.Router();

const PRIMARY_SECRET =
  process.env.APP_PAIS_JWT_SECRET || "DEV_ONLY__app_pais_jwt_secret_2025";
const FALLBACK_DEV_SECRET = "DEV_ONLY__CHANGE_ME_APP_PAIS_JWT_SECRET";

function anoLetivoPadrao() {
  const hoje = new Date();
  const mes = hoje.getMonth() + 1;
  return mes <= 1 ? hoje.getFullYear() - 1 : hoje.getFullYear();
}

function semestreSugeridoAtual() {
  const mes = new Date().getMonth() + 1;
  return mes <= 6 ? 1 : 2;
}

const toInt = (v, fallback = null) => {
  if (v === undefined || v === null || v === "") return fallback;
  const n = Number(v);
  return Number.isInteger(n) ? n : fallback;
};

const falha = (status, message, extra = {}) =>
  Object.assign(new Error(message), { status, extra });

function parseSeriesJson(raw) {
  if (!raw) return ["1ª Série", "2ª Série", "3ª Série"];
  if (Array.isArray(raw)) return raw.map((s) => String(s).trim()).filter(Boolean);
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed.map((s) => String(s).trim()).filter(Boolean);
    }
  } catch {
    // fallback CSV
  }
  return String(raw)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Decodifica o Bearer token do Educa Mobile (suporta APP_PAIS_JWT_SECRET em prod
 * e ambos os fallbacks locais de dev em app_aluno_auth.js / app_pais.js).
 */
function verificarJwtMobile(token) {
  try {
    return jwt.verify(token, PRIMARY_SECRET);
  } catch (err) {
    if (!process.env.APP_PAIS_JWT_SECRET) {
      return jwt.verify(token, FALLBACK_DEV_SECRET);
    }
    throw err;
  }
}

/**
 * Middleware de autenticação para Estudante ou Responsável no Educa Mobile.
 */
async function autenticarMobileProjetos(req, res, next) {
  try {
    await ensureMatriculasProjetosSchema();

    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : null;
    if (!token) {
      return res.status(401).json({ ok: false, message: "Token de autenticação ausente." });
    }

    let decoded;
    try {
      decoded = verificarJwtMobile(token);
    } catch {
      return res.status(401).json({ ok: false, message: "Sessão expirada. Faça login novamente." });
    }

    if (decoded?.tipo === "ALUNO" && decoded?.aluno_id) {
      req.mobileAuth = {
        tipo: "ALUNO",
        aluno_id: Number(decoded.aluno_id),
        somente_leitura: false,
      };
      return next();
    }

    if (decoded?.tipo === "RESPONSAVEL" && decoded?.responsavel_id) {
      const alunoIdQuery = toInt(req.query?.aluno_id ?? req.body?.aluno_id);
      if (!alunoIdQuery) {
        return res.status(400).json({
          ok: false,
          message: "Informe aluno_id para consultar os projetos do estudante vinculado.",
        });
      }

      const [[vinculo]] = await pool.query(
        `SELECT id FROM responsaveis_alunos
          WHERE responsavel_id = ? AND aluno_id = ? AND ativo = 1
          LIMIT 1`,
        [Number(decoded.responsavel_id), alunoIdQuery]
      );
      if (!vinculo) {
        return res.status(403).json({
          ok: false,
          message: "Estudante não vinculado a este responsável.",
        });
      }

      req.mobileAuth = {
        tipo: "RESPONSAVEL",
        responsavel_id: Number(decoded.responsavel_id),
        aluno_id: alunoIdQuery,
        somente_leitura: true,
      };
      return next();
    }

    return res.status(403).json({ ok: false, message: "Perfil de token não autorizado." });
  } catch (err) {
    console.error("[app_aluno_projetos] Erro de autenticação:", err);
    return res.status(500).json({ ok: false, message: "Erro interno ao validar sessão." });
  }
}

/**
 * Identifica se a turma/série do estudante pertence ao Ensino Médio (1ª, 2ª ou 3ª Série),
 * cobrindo nomenclaturas convencionais e códigos oficiais SEEDF (`EM_...` / `EMI_...`).
 */
function detectarElegibilidadeEnsinoMedio({ etapa, serie, turmaNome, nomeOficial }) {
  const txtEtapa = String(etapa || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase();
  const txtSerie = String(serie || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase();
  const txtTurma = String(turmaNome || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase();
  const txtOficial = String(nomeOficial || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase();

  const combinado = `${txtEtapa} | ${txtSerie} | ${txtTurma} | ${txtOficial}`;

  // Códigos oficiais SEEDF: EM_1_M_1_A (Ensino Médio), EMI_2_I_1_B (Ensino Médio Integral), etc.
  const matchCodigoSeedf = combinado.match(/\bEMI?_([123])_/);
  if (matchCodigoSeedf) {
    return {
      elegivel_ensino_medio: true,
      serie_detectada: `${matchCodigoSeedf[1]}ª Série`,
    };
  }

  const mencionaMedio =
    txtEtapa.includes("MEDIO") ||
    combinado.includes("ENSINO MEDIO") ||
    combinado.includes("MEDIO INTEGRAL") ||
    /\b[123]\s*(A|ª|O|º)?\s*SERIE\b/.test(combinado) ||
    /\b[123]\s*(O|º|A|ª)?\s*EM\b/.test(combinado);

  if (!mencionaMedio) {
    return { elegivel_ensino_medio: false, serie_detectada: null };
  }

  // Extrai número da série (1, 2 ou 3 — cobre inclusive "3º ANO A" quando etapa = MÉDIO)
  const matchNum =
    txtSerie.match(/\b([123])\b/) ||
    txtTurma.match(/(?:^|\D)([123])(?:\D|$)/);
  const num = matchNum ? matchNum[1] : null;

  return {
    elegivel_ensino_medio: true,
    serie_detectada: num ? `${num}ª Série` : null,
  };
}

/**
 * Carrega dados escolares e matrícula regular ativa do estudante no ano letivo.
 */
async function carregarContextoEstudante(alunoId, anoLetivo, executor = pool) {
  const [[aluno]] = await executor.query(
    `SELECT a.id, a.codigo, a.estudante AS nome, a.escola_id, a.serie AS serie_cadastro, a.turma_id AS turma_cadastro_id
       FROM alunos a
      WHERE a.id = ? AND (a.status = 'ativo' OR a.status IS NULL)
      LIMIT 1`,
    [alunoId]
  );
  if (!aluno) throw falha(404, "Cadastro do estudante não encontrado ou inativo.");

  // Prioriza matrícula ativa do ano letivo na tabela `matriculas`
  const [[mat]] = await executor.query(
    `SELECT m.id AS matricula_id, m.turma_id, t.nome AS turma_nome, t.nome_oficial, t.turno, t.etapa, t.serie
       FROM matriculas m
       JOIN turmas t ON t.id = m.turma_id
      WHERE m.escola_id = ?
        AND m.aluno_id = ?
        AND m.ano_letivo = ?
        AND m.status IN ('ativo', 'matriculado')
      ORDER BY m.id DESC
      LIMIT 1`,
    [aluno.escola_id, aluno.id, anoLetivo]
  );

  let turmaFallback = null;
  if (!mat && aluno.turma_cadastro_id) {
    const [[tf]] = await executor.query(
      `SELECT id AS turma_id, nome AS turma_nome, nome_oficial, turno, etapa, serie
         FROM turmas
        WHERE id = ? AND escola_id = ?
        LIMIT 1`,
      [aluno.turma_cadastro_id, aluno.escola_id]
    );
    turmaFallback = tf || null;
  }

  const turmaRef = mat || turmaFallback || {};
  const deteccao = detectarElegibilidadeEnsinoMedio({
    etapa: turmaRef.etapa,
    serie: turmaRef.serie || aluno.serie_cadastro,
    turmaNome: turmaRef.turma_nome,
    nomeOficial: turmaRef.nome_oficial,
  });

  return {
    id: aluno.id,
    codigo: aluno.codigo,
    nome: aluno.nome,
    escola_id: aluno.escola_id,
    ano_letivo: anoLetivo,
    possui_matricula_regular_ano: Boolean(mat?.matricula_id),
    matricula_id: mat?.matricula_id || null,
    turma_origem_id: turmaRef.turma_id || null,
    turma_origem_nome: turmaRef.turma_nome || aluno.serie_cadastro || "",
    turno: turmaRef.turno || null,
    etapa: turmaRef.etapa || null,
    serie_detectada: deteccao.serie_detectada,
    elegivel_ensino_medio: deteccao.elegivel_ensino_medio,
  };
}

function turnosCompativeis(turnoEstudante, turnoProjeto) {
  if (!turnoEstudante || !turnoProjeto) return true;
  const te = String(turnoEstudante).trim().toLowerCase();
  const tp = String(turnoProjeto).trim().toLowerCase();
  if (te === "integral" || tp === "integral") return true;
  return te === tp;
}

// ===========================================================================
// Handler: GET /
// Lista inscrições atuais do estudante + vitrine de projetos disponíveis
// ===========================================================================
async function handleListarProjetosAluno(req, res) {
  try {
    const { aluno_id: alunoId, tipo: perfilToken, somente_leitura } = req.mobileAuth;
    const anoLetivo = toInt(req.query.ano_letivo, anoLetivoPadrao());
    const semestreFiltro =
      req.query.semestre !== undefined && req.query.semestre !== "" && req.query.semestre !== "TODOS"
        ? toInt(req.query.semestre, null)
        : null;

    const est = await carregarContextoEstudante(alunoId, anoLetivo);
    const eixosEscola = await obterEixosEscola(est.escola_id);
    const eixosMap = new Map(eixosEscola.map((e) => [e.codigo, e]));
    const eixosAtivos = eixosEscola.filter((e) => e.ativo === true);
    const eixosAtivosSet = new Set(eixosAtivos.map((e) => e.codigo));

    // 1. Busca todas as inscrições ativas do estudante em projetos neste ano letivo
    const [inscricoesRows] = await pool.query(
      `SELECT
         aa.id AS vinculo_id,
         aa.agrupamento_id,
         aa.entrada_em,
         g.nome AS turma_nome,
         g.apelido_turma,
         g.turno,
         g.semestre,
         g.capacidade,
         g.projeto_id,
         p.nome AS projeto_nome,
         p.categoria,
         p.abreviatura,
         p.sinopse,
         p.professor_idealizador,
         p.carga_semanal,
         p.inscricao_aberta,
         COALESCE(p.ativo_mobile, 1) AS ativo_mobile,
         p.status AS projeto_status
       FROM agrupamento_alunos aa
       JOIN agrupamentos g ON g.id = aa.agrupamento_id
       JOIN em_projetos p ON p.id = g.projeto_id
       WHERE aa.escola_id = ?
         AND aa.aluno_id = ?
         AND aa.status = 'ativo'
         AND g.ano_letivo = ?
       ORDER BY g.semestre ASC, p.nome ASC`,
      [est.escola_id, est.id, anoLetivo]
    );

    const minhasInscricoes = inscricoesRows.map((r) => {
      const catInfo = eixosMap.get(r.categoria) || CATEGORIAS_EM[r.categoria] || CATEGORIAS_EM.PROJETO;
      const eixoEstaAtivo = eixosAtivosSet.has(r.categoria);
      return {
        vinculo_id: r.vinculo_id,
        projeto_id: r.projeto_id,
        projeto_nome: r.projeto_nome,
        abreviatura: r.abreviatura,
        categoria: r.categoria,
        categoria_info: catInfo,
        sinopse: r.sinopse || "",
        professor_idealizador: r.professor_idealizador || "",
        carga_semanal: Number(r.carga_semanal || 2),
        semestre: Number(r.semestre),
        turno: r.turno,
        agrupamento_id: r.agrupamento_id,
        apelido_turma: r.apelido_turma || r.turma_nome,
        turma_nome: r.turma_nome,
        entrada_em: r.entrada_em,
        pode_cancelar_ou_trocar:
          !somente_leitura &&
          eixoEstaAtivo &&
          Number(r.ativo_mobile) === 1 &&
          Number(r.inscricao_aberta) === 1 &&
          r.projeto_status === "ABERTO",
      };
    });

    // Se a Secretaria já inscreveu este aluno em algum projeto, garante elegibilidade visual
    if (minhasInscricoes.length > 0) {
      est.elegivel_ensino_medio = true;
    }

    const formatarCardsMobile = (listaProjetosDisp = []) =>
      eixosAtivos.map((e) => {
        const qtdDisp = listaProjetosDisp.filter(
          (p) =>
            p.categoria === e.codigo &&
            Array.isArray(p.turmas) &&
            p.turmas.length > 0
        ).length;
        return {
          id: e.card_id_mobile,
          codigo: e.codigo,
          label: e.label_mobile || e.sigla,
          sigla: e.sigla,
          titulo: e.titulo,
          subtitulo: e.subtitulo,
          descricao_curta: e.descricao_curta,
          icon: e.icone_mobile || "school-outline",
          icone_emoji: e.icone_emoji,
          cor_tema: e.cor_tema,
          ativo: true,
          padrao_sistema: e.padrao_sistema,
          ordem: e.ordem,
          total_projetos_disponiveis: qtdDisp,
        };
      });

    // 2. Se não for Ensino Médio e não tiver inscrição, retorna vitrine vazia de forma limpa
    if (!est.elegivel_ensino_medio) {
      return res.json({
        ok: true,
        perfil_token: perfilToken,
        somente_leitura,
        exibir_card_mobile: false,
        semestre_sugerido: semestreSugeridoAtual(),
        estudante: est,
        cards_mobile: [],
        categorias_catalogo: [],
        minhas_inscricoes: [],
        projetos_disponiveis: [],
      });
    }

    // 3. Busca apenas projetos abertos E ativos no mobile da escola no ano letivo
    const whereProj = [
      "p.escola_id = ?",
      "p.ano_letivo = ?",
      "p.status = 'ABERTO'",
      "COALESCE(p.ativo_mobile, 1) = 1",
    ];
    const paramsProj = [est.escola_id, anoLetivo];
    if (semestreFiltro !== null && [0, 1, 2].includes(semestreFiltro)) {
      whereProj.push("(p.semestre = ? OR p.semestre = 0)");
      paramsProj.push(semestreFiltro);
    }

    const [projetosRows] = await pool.query(
      `SELECT p.*
         FROM em_projetos p
        WHERE ${whereProj.join(" AND ")}
        ORDER BY p.semestre ASC, p.categoria ASC, p.nome ASC`,
      paramsProj
    );

    // Filtra projetos pertencentes a Eixos ATIVOS e compatíveis com o turno e a série do estudante
    const projetosInscritosSet = new Set(minhasInscricoes.map((i) => i.projeto_id));
    const projetosElegiveisRows = projetosRows.filter((p) => {
      if (!eixosAtivosSet.has(p.categoria)) return false;
      if (projetosInscritosSet.has(p.id)) return true;
      if (!turnosCompativeis(est.turno, p.turno)) return false;
      const seriesProj = parseSeriesJson(p.series_json);
      if (est.serie_detectada && seriesProj.length > 0) {
        if (!seriesProj.includes(est.serie_detectada)) return false;
      }
      return true;
    });

    let projetosDisponiveis = [];
    if (projetosElegiveisRows.length > 0) {
      const projIds = projetosElegiveisRows.map((p) => p.id);
      const [turmasRows] = await pool.query(
        `SELECT
           g.id,
           g.projeto_id,
           g.nome,
           g.apelido_turma,
           g.turno,
           g.semestre,
           g.capacidade,
           g.status,
           (SELECT COUNT(*)
              FROM agrupamento_alunos aa
             WHERE aa.agrupamento_id = g.id AND aa.status = 'ativo') AS matriculados
         FROM agrupamentos g
         WHERE g.escola_id = ? AND g.projeto_id IN (?)
         ORDER BY g.id ASC`,
        [est.escola_id, projIds]
      );

      const agrIds = turmasRows.map((t) => t.id);
      const profsMap = new Map();
      if (agrIds.length > 0) {
        const [modRows] = await pool.query(
          `SELECT m.agrupamento_id, p.nome AS professor_nome
             FROM agrupamento_modulacao m
             JOIN professores p ON p.id = m.professor_id
            WHERE m.escola_id = ? AND m.agrupamento_id IN (?)
            ORDER BY p.nome ASC`,
          [est.escola_id, agrIds]
        );
        for (const mr of modRows) {
          const list = profsMap.get(mr.agrupamento_id) || [];
          list.push(mr.professor_nome);
          profsMap.set(mr.agrupamento_id, list);
        }
      }

      const turmasPorProj = new Map();
      for (const t of turmasRows) {
        const cap = t.capacidade !== null ? Number(t.capacidade) : null;
        const mat = Number(t.matriculados || 0);
        const vagasRestantes = cap !== null ? Math.max(0, cap - mat) : null;
        const list = turmasPorProj.get(t.projeto_id) || [];
        const idx = list.length + 1;
        list.push({
          id: t.id,
          apelido_turma: t.apelido_turma || `Turma ${String(idx).padStart(2, "0")}`,
          nome: t.nome,
          turno: t.turno,
          semestre: Number(t.semestre),
          capacidade: cap,
          matriculados: mat,
          vagas_restantes: vagasRestantes,
          lotada: cap !== null && mat >= cap,
          status: t.status,
          professores: profsMap.get(t.id) || [],
        });
        turmasPorProj.set(t.projeto_id, list);
      }

      const mapaMinhaPorProjeto = new Map(
        minhasInscricoes.map((m) => [m.projeto_id, m])
      );

      projetosDisponiveis = projetosElegiveisRows.map((p) => {
        const turmas = turmasPorProj.get(p.id) || [];
        const vagasTotais = turmas.reduce((acc, t) => acc + Number(t.capacidade || 0), 0);
        const matriculadosTotal = turmas.reduce((acc, t) => acc + Number(t.matriculados || 0), 0);
        const vagasRestantesTotal = Math.max(0, vagasTotais - matriculadosTotal);
        const minha = mapaMinhaPorProjeto.get(p.id) || null;

        return {
          id: p.id,
          categoria: p.categoria,
          categoria_info:
            eixosMap.get(p.categoria) ||
            CATEGORIAS_EM[p.categoria] ||
            CATEGORIAS_EM.PROJETO,
          nome: p.nome,
          abreviatura: p.abreviatura,
          sinopse: p.sinopse || "",
          professor_idealizador: p.professor_idealizador || "",
          turno: p.turno,
          semestre: Number(p.semestre),
          series: parseSeriesJson(p.series_json),
          carga_semanal: Number(p.carga_semanal || 2),
          inscricao_aberta: Number(p.inscricao_aberta) === 1,
          ja_inscrito: Boolean(minha),
          minha_turma_id: minha?.agrupamento_id || null,
          minha_turma_apelido: minha?.apelido_turma || null,
          resumo_vagas: {
            total_turmas: turmas.length,
            vagas_totais: vagasTotais,
            matriculados: matriculadosTotal,
            vagas_restantes: vagasRestantesTotal,
            lotado: vagasTotais > 0 && vagasRestantesTotal === 0,
          },
          turmas,
        };
      });
    }

    const cardsMobile = formatarCardsMobile(projetosDisponiveis);

    return res.json({
      ok: true,
      perfil_token: perfilToken,
      somente_leitura,
      exibir_card_mobile:
        est.elegivel_ensino_medio &&
        (cardsMobile.length > 0 || minhasInscricoes.length > 0),
      semestre_sugerido: semestreSugeridoAtual(),
      estudante: est,
      cards_mobile: cardsMobile,
      categorias_catalogo: cardsMobile,
      minhas_inscricoes: minhasInscricoes,
      projetos_disponiveis: projetosDisponiveis,
    });
  } catch (err) {
    if (err?.status) {
      return res.status(err.status).json({ ok: false, message: err.message, ...err.extra });
    }
    console.error("[app_aluno_projetos] Erro no GET /:", err);
    return res.status(500).json({ ok: false, message: "Erro ao carregar projetos disponíveis." });
  }
}

// ===========================================================================
// Handler: POST /inscrever
// Estudante escolhe a turma de um projeto (com lock pessimista anti-overbooking)
// ===========================================================================
async function handleInscreverAlunoProjeto(req, res) {
  let conn;
  try {
    if (req.mobileAuth?.tipo !== "ALUNO") {
      throw falha(
        403,
        "A escolha e confirmação de matrícula no projeto deve ser realizada pelo perfil do Estudante."
      );
    }

    const alunoId = req.mobileAuth.aluno_id;
    const agrupamentoId = toInt(req.body?.agrupamento_id);
    if (!agrupamentoId) {
      throw falha(400, "Selecione a turma do projeto em que deseja se inscrever.");
    }

    conn = await pool.getConnection();
    await conn.beginTransaction();

    // 1. Carrega e trava a linha da turma (`FOR UPDATE`) + dados do projeto
    const [[alvo]] = await conn.query(
      `SELECT
         g.id AS agrupamento_id,
         g.escola_id,
         g.ano_letivo,
         g.semestre,
         g.turno,
         g.nome AS turma_nome,
         g.apelido_turma,
         g.capacidade,
         g.status AS turma_status,
         g.projeto_id,
         p.categoria AS projeto_categoria,
         p.nome AS projeto_nome,
         p.series_json,
         p.inscricao_aberta,
         COALESCE(p.ativo_mobile, 1) AS projeto_ativo_mobile,
         p.status AS projeto_status
       FROM agrupamentos g
       JOIN em_projetos p ON p.id = g.projeto_id
       WHERE g.id = ?
       FOR UPDATE`,
      [agrupamentoId]
    );

    if (!alvo) {
      throw falha(404, "Turma de projeto não encontrada.");
    }

    // 2. Verifica contexto do estudante na mesma escola e ano letivo
    const est = await carregarContextoEstudante(alunoId, Number(alvo.ano_letivo), conn);
    if (est.escola_id !== alvo.escola_id) {
      throw falha(403, "Este projeto pertence a outra unidade escolar.");
    }
    if (!est.possui_matricula_regular_ano || !est.matricula_id) {
      throw falha(
        409,
        "Sua matrícula regular no ano letivo atual ainda não consta ativa na Secretaria."
      );
    }

    // Verifica se o Eixo e o Projeto estão ATIVOS no Educa Mobile
    const eixosEscolaInscricao = await obterEixosEscola(alvo.escola_id, conn);
    const eixoDoProjeto = eixosEscolaInscricao.find(
      (e) => e.codigo === alvo.projeto_categoria
    );
    if (!eixoDoProjeto || !eixoDoProjeto.ativo) {
      throw falha(
        403,
        "Este eixo semestral está desativado pela gestão escolar no aplicativo."
      );
    }
    if (Number(alvo.projeto_ativo_mobile) !== 1) {
      throw falha(
        403,
        "Este projeto está desativado pela Secretaria Escolar no aplicativo."
      );
    }
    if (alvo.projeto_status !== "ABERTO" || alvo.turma_status !== "ABERTO") {
      throw falha(409, "Este projeto ou turma não está aberto para matrículas.");
    }
    if (Number(alvo.inscricao_aberta) !== 1) {
      throw falha(
        403,
        "O período de escolha pelos estudantes para este projeto está encerrado pela Secretaria."
      );
    }

    // 3. Verifica compatibilidade de Turno e Série do Ensino Médio
    if (!turnosCompativeis(est.turno, alvo.turno)) {
      throw falha(
        403,
        `Este projeto é ofertado no turno ${alvo.turno}, incompatível com o seu turno (${est.turno}).`
      );
    }
    const seriesPermitidas = parseSeriesJson(alvo.series_json);
    if (est.serie_detectada && seriesPermitidas.length > 0) {
      if (!seriesPermitidas.includes(est.serie_detectada)) {
        throw falha(
          403,
          `Este projeto é destinado a: ${seriesPermitidas.join(", ")} (sua série atual: ${est.serie_detectada}).`
        );
      }
    }

    // 4. Verifica se o estudante já está inscrito neste mesmo projeto (mesma turma ou outra turma irmã)
    const [jaNoProjeto] = await conn.query(
      `SELECT aa.id, aa.agrupamento_id, g.apelido_turma
         FROM agrupamento_alunos aa
         JOIN agrupamentos g ON g.id = aa.agrupamento_id
        WHERE aa.escola_id = ?
          AND aa.aluno_id = ?
          AND aa.status = 'ativo'
          AND g.projeto_id = ?
        FOR UPDATE`,
      [est.escola_id, est.id, alvo.projeto_id]
    );

    const mesmaTurma = jaNoProjeto.find((r) => r.agrupamento_id === alvo.agrupamento_id);
    if (mesmaTurma) {
      await conn.commit();
      return res.json({
        ok: true,
        ja_inscrito: true,
        message: `Você já está matriculado(a) na ${alvo.apelido_turma || alvo.turma_nome} de "${alvo.projeto_nome}".`,
      });
    }

    // 5. Verifica vagas restantes na turma de destino
    const [[{ ocupadas }]] = await conn.query(
      `SELECT COUNT(*) AS ocupadas
         FROM agrupamento_alunos
        WHERE escola_id = ? AND agrupamento_id = ? AND status = 'ativo'`,
      [est.escola_id, alvo.agrupamento_id]
    );

    if (alvo.capacidade !== null && Number(ocupadas) >= Number(alvo.capacidade)) {
      throw falha(
        409,
        `A ${alvo.apelido_turma || alvo.turma_nome} acabou de atingir a lotação máxima (${alvo.capacidade} vagas). Selecione outra turma com vagas disponíveis.`,
        { lotada: true, vagas_restantes: 0 }
      );
    }

    // Se estava em outra turma irmã do mesmo projeto, inativa a anterior (troca atômica de turma!)
    let trocouDeTurma = false;
    if (jaNoProjeto.length > 0) {
      trocouDeTurma = true;
      const idsAntigos = jaNoProjeto.map((r) => r.id);
      await conn.query(
        `UPDATE agrupamento_alunos
            SET status = 'inativo', saida_em = CURDATE()
          WHERE escola_id = ? AND id IN (?)`,
        [est.escola_id, idsAntigos]
      );
    }

    // 6. Efetiva matrícula do estudante na turma escolhida
    const hojeIso = new Date().toISOString().slice(0, 10);
    await conn.query(
      `INSERT INTO agrupamento_alunos
         (escola_id, agrupamento_id, aluno_id, matricula_id, turma_origem_id, status, entrada_em)
       VALUES (?, ?, ?, ?, ?, 'ativo', ?)
       ON DUPLICATE KEY UPDATE
         status = 'ativo',
         saida_em = NULL,
         matricula_id = VALUES(matricula_id),
         turma_origem_id = VALUES(turma_origem_id),
         entrada_em = CURDATE()`,
      [
        est.escola_id,
        alvo.agrupamento_id,
        est.id,
        est.matricula_id,
        est.turma_origem_id,
        hojeIso,
      ]
    );

    await conn.commit();

    const novoOcupadas = Number(ocupadas) + 1;
    const vagasRestantes =
      alvo.capacidade !== null ? Math.max(0, Number(alvo.capacidade) - novoOcupadas) : null;

    return res.status(201).json({
      ok: true,
      trocou_de_turma: trocouDeTurma,
      message: trocouDeTurma
        ? `Turma alterada com sucesso para ${alvo.apelido_turma || alvo.turma_nome} em "${alvo.projeto_nome}"!`
        : `Inscrição confirmada na ${alvo.apelido_turma || alvo.turma_nome} do projeto "${alvo.projeto_nome}"!`,
      inscricao: {
        projeto_id: alvo.projeto_id,
        projeto_nome: alvo.projeto_nome,
        agrupamento_id: alvo.agrupamento_id,
        apelido_turma: alvo.apelido_turma || alvo.turma_nome,
        vagas_restantes: vagasRestantes,
      },
    });
  } catch (err) {
    if (conn) await conn.rollback().catch(() => {});
    if (err?.status) {
      return res.status(err.status).json({ ok: false, message: err.message, ...err.extra });
    }
    console.error("[app_aluno_projetos] Erro no POST /inscrever:", err);
    return res.status(500).json({ ok: false, message: "Não foi possível concluir sua inscrição." });
  } finally {
    if (conn) conn.release();
  }
}

// ===========================================================================
// Handler: POST /cancelar
// Permite ao estudante cancelar sua inscrição enquanto `inscricao_aberta = 1`
// ===========================================================================
async function handleCancelarInscricaoProjeto(req, res) {
  let conn;
  try {
    if (req.mobileAuth?.tipo !== "ALUNO") {
      throw falha(403, "Apenas o estudante pode cancelar sua escolha pelo aplicativo.");
    }

    const alunoId = req.mobileAuth.aluno_id;
    const agrupamentoId = toInt(req.body?.agrupamento_id);
    if (!agrupamentoId) {
      throw falha(400, "Informe agrupamento_id para cancelar a inscrição.");
    }

    conn = await pool.getConnection();
    await conn.beginTransaction();

    const [[vinculo]] = await conn.query(
      `SELECT
         aa.id,
         aa.escola_id,
         g.apelido_turma,
         g.nome AS turma_nome,
         p.nome AS projeto_nome,
         p.inscricao_aberta,
         p.status AS projeto_status
       FROM agrupamento_alunos aa
       JOIN agrupamentos g ON g.id = aa.agrupamento_id
       JOIN em_projetos p ON p.id = g.projeto_id
       WHERE aa.aluno_id = ?
         AND aa.agrupamento_id = ?
         AND aa.status = 'ativo'
       FOR UPDATE`,
      [alunoId, agrupamentoId]
    );

    if (!vinculo) {
      throw falha(404, "Você não possui inscrição ativa nesta turma.");
    }

    if (Number(vinculo.inscricao_aberta) !== 1 || vinculo.projeto_status !== "ABERTO") {
      throw falha(
        403,
        "O prazo de alteração pelo aplicativo foi encerrado pela Secretaria. Procure a Secretaria Escolar caso precise de remanejamento."
      );
    }

    await conn.query(
      `UPDATE agrupamento_alunos
          SET status = 'inativo', saida_em = CURDATE()
        WHERE id = ? AND escola_id = ?`,
      [vinculo.id, vinculo.escola_id]
    );

    await conn.commit();

    return res.json({
      ok: true,
      message: `Sua inscrição em "${vinculo.projeto_nome}" (${vinculo.apelido_turma || vinculo.turma_nome}) foi cancelada.`,
    });
  } catch (err) {
    if (conn) await conn.rollback().catch(() => {});
    if (err?.status) {
      return res.status(err.status).json({ ok: false, message: err.message, ...err.extra });
    }
    console.error("[app_aluno_projetos] Erro no POST /cancelar:", err);
    return res.status(500).json({ ok: false, message: "Não foi possível cancelar a inscrição." });
  } finally {
    if (conn) conn.release();
  }
}

router.get("/", autenticarMobileProjetos, handleListarProjetosAluno);
router.post("/inscrever", autenticarMobileProjetos, handleInscreverAlunoProjeto);
router.post("/cancelar", autenticarMobileProjetos, handleCancelarInscricaoProjeto);

/**
 * Registra as rotas diretamente na instância do Express `app` (mesmo padrão de
 * `mountAppPaisToApp` em `server.js`) para blindar contra o bug de roteamento
 * de POSTs em sub-routers no Express 5 + Docker DigitalOcean.
 */
export function mountAppAlunoProjetosToApp(app, basePath = "/api/app-pais/aluno/projetos") {
  app.get(basePath, autenticarMobileProjetos, handleListarProjetosAluno);
  app.post(`${basePath}/inscrever`, autenticarMobileProjetos, handleInscreverAlunoProjeto);
  app.post(`${basePath}/cancelar`, autenticarMobileProjetos, handleCancelarInscricaoProjeto);
}

export default router;
