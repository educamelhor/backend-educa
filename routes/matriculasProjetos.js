// routes/matriculasProjetos.js
// ============================================================================
// EDUCA.MELHOR — Secretaria > Matrículas > Submódulo PROJETOS (Novo Ensino Médio)
// ----------------------------------------------------------------------------
// Finalidade:
//   • Permitir que a Secretaria crie os Projetos / Componentes do Novo Ensino Médio
//     (IFA, Eletiva Orientada, PCA, Projeto de Vida, Parte Diversificada PD1/PD2/PD3,
//      Clubes Juvenis & Projetos Científicos) organizados por Semestre e Turno.
//   • Gerar automaticamente as N turmas de cada projeto (Turma 01, Turma 02, ...)
//     integradas nativamente às tabelas `disciplinas`, `agrupamentos` e
//     `agrupamento_componentes` (compatibilidade imediata com Modulação, Horários
//     Super-Aulas e Boletim, mantendo o estudante na sua turma regular de origem).
//   • Controlar capacidade física/pedagógica (vagas totais, matriculados, vagas
//     restantes) com lock transacional (`SELECT ... FOR UPDATE`), pronto inclusive
//     para autosserviço futuro do estudante via Educa Mobile.
// ============================================================================

import { Router } from "express";
import pool from "../db.js";

const router = Router();

// ---------------------------------------------------------------------------
// Catálogo Oficial dos 6 Cards do Novo Ensino Médio (Lei nº 14.945/2024 + SEEDF)
// ---------------------------------------------------------------------------
export const CATEGORIAS_EM = {
  IFA: {
    codigo: "IFA",
    titulo: "IFA — Itinerário Formativo",
    subtitulo: "Percursos e Trilhas de Aprofundamento por Área do Conhecimento ou FTP",
    disciplinaTipo: "IFA",
    agrupamentoTipo: "IFA",
    abrevPrefix: "IFA",
  },
  ELETIVA: {
    codigo: "ELETIVA",
    titulo: "Eletiva Orientada",
    subtitulo: "Oficinas semestrais interdisciplinares de livre escolha dos estudantes",
    disciplinaTipo: "ELETIVA",
    agrupamentoTipo: "ELETIVA",
    abrevPrefix: "ELET",
  },
  PCA: {
    codigo: "PCA",
    titulo: "PCA — Percurso Comum de Aprofundamento",
    subtitulo: "Projetos integradores de contemplação e aprofundamento de área",
    disciplinaTipo: "PCA",
    agrupamentoTipo: "PCA",
    abrevPrefix: "PCA",
  },
  PROJETO_VIDA: {
    codigo: "PROJETO_VIDA",
    titulo: "Projeto de Vida & Protagonismo",
    subtitulo: "Autoconhecimento, planejamento acadêmico, cidadania e mundo do trabalho",
    disciplinaTipo: "PROJETO",
    agrupamentoTipo: "PROJETO",
    abrevPrefix: "PV",
  },
  PARTE_DIVERSIFICADA: {
    codigo: "PARTE_DIVERSIFICADA",
    titulo: "Parte Diversificada (PD1 / PD2 / PD3 / LEM)",
    subtitulo: "Componentes diversificados da matriz curricular e línguas estrangeiras",
    disciplinaTipo: "PARTE_DIVERSIFICADA",
    agrupamentoTipo: "OUTRO",
    abrevPrefix: "PD",
  },
  PROJETO: {
    codigo: "PROJETO",
    titulo: "Clubes Juvenis & Projetos Científicos",
    subtitulo: "Iniciação científica, robótica, olimpíadas, cultura, artes e desporto",
    disciplinaTipo: "PROJETO",
    agrupamentoTipo: "PROJETO",
    abrevPrefix: "PROJ",
  },
};

const TURNOS_VALIDOS = ["Matutino", "Vespertino", "Noturno", "Integral"];
const STATUS_VALIDOS = ["RASCUNHO", "ABERTO", "ENCERRADO"];

const PERFIS_GESTAO = new Set([
  "diretor", "direcao", "vice_diretor",
  "secretaria", "secretario",
  "coordenacao", "coordenador",
  "supervisor", "supervisor_pedagogico", "supervisor_administrativo",
  "orientador", "administrativo",
  "admin", "administrador", "super_admin", "ceo", "plataforma",
]);

function exigirGestao(req, res, next) {
  const perfil = String(req.user?.perfil || "").toLowerCase().trim();
  if ( req.user?.is_super_admin || PERFIS_GESTAO.has(perfil) ) {
    return next();
  }
  return res.status(403).json({
    ok: false,
    message: "Acesso negado: requer perfil de Secretaria, Coordenação ou Direção.",
  });
}

// ---------------------------------------------------------------------------
// Auto-migração idempotente (executada 1x no ciclo de vida do processo)
// ---------------------------------------------------------------------------
let _schemaReady = false;
let _schemaPromise = null;

export async function ensureMatriculasProjetosSchema() {
  if (_schemaReady) return;
  if (_schemaPromise) return _schemaPromise;

  _schemaPromise = (async () => {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS em_projetos (
          id INT AUTO_INCREMENT PRIMARY KEY,
          escola_id INT NOT NULL,
          ano_letivo INT NOT NULL,
          semestre TINYINT NOT NULL DEFAULT 1,
          categoria VARCHAR(40) NOT NULL,
          nome VARCHAR(120) NOT NULL,
          abreviatura VARCHAR(25) NULL,
          sinopse TEXT NULL,
          professor_idealizador VARCHAR(120) NULL,
          turno VARCHAR(20) NOT NULL,
          series_json VARCHAR(160) NULL,
          carga_semanal INT NOT NULL DEFAULT 2,
          disciplina_id INT NULL,
          qtd_turmas_planejadas INT NOT NULL DEFAULT 1,
          vagas_por_turma INT NOT NULL DEFAULT 35,
          inscricao_aberta TINYINT(1) NOT NULL DEFAULT 1,
          status VARCHAR(20) NOT NULL DEFAULT 'ABERTO',
          criado_por INT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX idx_emp_escola_ano (escola_id, ano_letivo, semestre),
          INDEX idx_emp_categoria (escola_id, categoria)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);

      // Verifica colunas adicionais em `agrupamentos` para vínculo direto com `em_projetos`
      const [cols] = await pool.query(
        `SELECT COLUMN_NAME
           FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME = 'agrupamentos'
            AND COLUMN_NAME IN ('projeto_id', 'apelido_turma')`
      );
      const colSet = new Set((cols || []).map((c) => String(c.COLUMN_NAME).toLowerCase()));

      if (!colSet.has("projeto_id")) {
        await pool.query(
          `ALTER TABLE agrupamentos ADD COLUMN projeto_id INT NULL DEFAULT NULL, ADD INDEX idx_agr_projeto (projeto_id)`
        ).catch((e) => {
          if (!String(e.message || "").includes("Duplicate")) {
            console.warn("[matriculasProjetos] Aviso ao adicionar agrupamentos.projeto_id:", e.message);
          }
        });
      }

      if (!colSet.has("apelido_turma")) {
        await pool.query(
          `ALTER TABLE agrupamentos ADD COLUMN apelido_turma VARCHAR(30) NULL DEFAULT NULL`
        ).catch((e) => {
          if (!String(e.message || "").includes("Duplicate")) {
            console.warn("[matriculasProjetos] Aviso ao adicionar agrupamentos.apelido_turma:", e.message);
          }
        });
      }

      _schemaReady = true;
      console.log("[matriculasProjetos] Schema em_projetos + vínculo agrupamentos verificado ✅");
    } catch (err) {
      console.error("[matriculasProjetos] Erro ao verificar schema:", err.message);
      _schemaPromise = null;
      throw err;
    }
  })();

  return _schemaPromise;
}

// Seed único e idempotente no boot: herda o estado inicial de 'secretaria.alunos'
// apenas onde 'secretaria.matriculas' ainda não existe nas tabelas de licenciamento,
// garantindo visibilidade imediata para Secretarias/Diretores já habilitados pelo CEO
// sem jamais sobrescrever desativações futuras feitas no painel Plataforma > Módulos.
(async function initModuloMatriculasBoot() {
  try {
    await pool.query(`
      INSERT IGNORE INTO escola_modulos (escola_id, modulo, ativo)
      SELECT escola_id, 'secretaria.matriculas', ativo
        FROM escola_modulos
       WHERE modulo = 'secretaria.alunos'
    `).catch(() => {});

    await pool.query(`
      INSERT IGNORE INTO escola_perfil_modulos (escola_id, perfil, modulo, ativo)
      SELECT escola_id, perfil, 'secretaria.matriculas', ativo
        FROM escola_perfil_modulos
       WHERE modulo = 'secretaria.alunos'
    `).catch(() => {});
  } catch {
    // silencioso caso tabelas ainda não existam no ambiente local
  }
})();

router.use(async (_req, res, next) => {
  try {
    await ensureMatriculasProjetosSchema();
    next();
  } catch {
    return res.status(500).json({
      ok: false,
      message: "Erro ao inicializar estrutura de Matrículas / Projetos.",
    });
  }
});

// ---------------------------------------------------------------------------
// Helpers utilitários
// ---------------------------------------------------------------------------
function anoLetivoPadrao() {
  const hoje = new Date();
  const mes = hoje.getMonth() + 1;
  return mes <= 1 ? hoje.getFullYear() - 1 : hoje.getFullYear();
}

const toInt = (v, fallback = null) => {
  if (v === undefined || v === null || v === "") return fallback;
  const n = Number(v);
  return Number.isInteger(n) ? n : fallback;
};

const normTurno = (t) => {
  const s = String(t || "").trim().toLowerCase();
  return TURNOS_VALIDOS.find((x) => x.toLowerCase() === s) || null;
};

const falha = (status, message, extra = {}) =>
  Object.assign(new Error(message), { status, extra });

function responderErro(res, err, msgPadrao) {
  if (err?.status) {
    return res.status(err.status).json({ ok: false, message: err.message, ...err.extra });
  }
  if (err?.code === "ER_DUP_ENTRY") {
    return res.status(409).json({
      ok: false,
      message: "Já existe um registro com o mesmo nome, turno e semestre.",
    });
  }
  console.error("[matriculasProjetos]", msgPadrao, err);
  return res.status(500).json({ ok: false, message: msgPadrao });
}

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

function normalizarSeriesInput(series) {
  const arr = Array.isArray(series)
    ? series.map((s) => String(s).trim()).filter(Boolean)
    : parseSeriesJson(series);
  const finalArr = arr.length > 0 ? arr : ["1ª Série", "2ª Série", "3ª Série"];
  return JSON.stringify(finalArr).slice(0, 160);
}

function gerarAbreviaturaPadrao(nome, abrevPrefix = "PROJ") {
  const limpo = String(nome || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9\s]/g, " ")
    .trim();
  const palavras = limpo.split(/\s+/).filter((w) => w.length > 2);
  if (palavras.length === 0) return abrevPrefix.slice(0, 12);
  const iniciais = palavras.slice(0, 4).map((w) => w[0].toUpperCase()).join("");
  return `${abrevPrefix}-${iniciais}`.slice(0, 20);
}

async function comTransacao(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const out = await fn(conn);
    await conn.commit();
    return out;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Gera um nome único em `agrupamentos` respeitando VARCHAR(100) e chave única
 * (escola_id, ano_letivo, semestre, turno, nome).
 */
async function gerarNomeTurmaAgrupamento(conn, {
  escola_id,
  ano_letivo,
  semestre,
  turno,
  nomeProjeto,
  numeroTurma,
}) {
  const numFmt = String(numeroTurma).padStart(2, "0");
  const apelido = `Turma ${numFmt}`;
  const sufixoBase = ` - T${numFmt}`;
  const baseLimpa = String(nomeProjeto || "Projeto").trim().slice(0, 100 - sufixoBase.length).trim();

  let candidato = `${baseLimpa}${sufixoBase}`;
  let tentativa = 1;

  while (tentativa <= 25) {
    const [[existe]] = await conn.query(
      `SELECT id FROM agrupamentos
        WHERE escola_id = ? AND ano_letivo = ? AND semestre = ? AND turno = ? AND nome = ?
        LIMIT 1`,
      [escola_id, ano_letivo, semestre, turno, candidato]
    );
    if (!existe) {
      return { nome: candidato, apelido };
    }
    tentativa += 1;
    const sufixoExtra = ` - T${numFmt} (${tentativa})`;
    const baseCurta = String(nomeProjeto || "Projeto").trim().slice(0, 100 - sufixoExtra.length).trim();
    candidato = `${baseCurta}${sufixoExtra}`;
  }

  throw falha(409, "Não foi possível gerar identificador único para a nova turma do projeto.");
}

/**
 * Busca ou cria a disciplina vinculada ao Projeto (modo_oferta = 'AGRUPAMENTO').
 */
async function resolverOuCriarDisciplinaProjeto(conn, {
  escola_id,
  nomeProjeto,
  abreviatura,
  catInfo,
  turno,
  carga_semanal,
}) {
  const nomeDisc = String(nomeProjeto || "").trim().slice(0, 100);
  const [[existente]] = await conn.query(
    `SELECT id, nome, abreviatura
       FROM disciplinas
      WHERE escola_id = ?
        AND LOWER(TRIM(nome)) = LOWER(?)
        AND (mesclada_em IS NULL)
      LIMIT 1`,
    [escola_id, nomeDisc]
  );

  if (existente) {
    return existente.id;
  }

  const abrevFinal =
    typeof abreviatura === "string" && abreviatura.trim()
      ? abreviatura.trim().toUpperCase().slice(0, 20)
      : gerarAbreviaturaPadrao(nomeDisc, catInfo.abrevPrefix);

  const turnoUpper = String(turno || "INTEGRAL").toUpperCase();
  const [ins] = await conn.query(
    `INSERT INTO disciplinas
       (nome, abreviatura, tipo, modo_oferta, etapa, turno, carga, escola_id, created_at, updated_at)
     VALUES (?, ?, ?, 'AGRUPAMENTO', 'MÉDIO', ?, ?, ?, NOW(), NOW())`,
    [nomeDisc, abrevFinal, catInfo.disciplinaTipo, turnoUpper, carga_semanal, escola_id]
  );

  return ins.insertId;
}

/**
 * Hidrata uma lista de projetos com suas turmas (`agrupamentos`) e contadores de vagas.
 */
async function hidratarProjetosComTurmas(escola_id, projetosRows, executor = pool) {
  if (!projetosRows || projetosRows.length === 0) return [];

  const projetoIds = projetosRows.map((p) => p.id);

  const [turmasRows] = await executor.query(
    `SELECT
       g.id,
       g.projeto_id,
       g.nome,
       g.apelido_turma,
       g.tipo,
       g.turno,
       g.semestre,
       g.ano_letivo,
       g.capacidade,
       g.status,
       (SELECT COUNT(*)
          FROM agrupamento_alunos aa
         WHERE aa.agrupamento_id = g.id AND aa.status = 'ativo') AS matriculados
     FROM agrupamentos g
     WHERE g.escola_id = ? AND g.projeto_id IN (?)
     ORDER BY g.id ASC`,
    [escola_id, projetoIds]
  );

  const agrupamentoIds = turmasRows.map((t) => t.id);
  let profsPorTurma = new Map();

  if (agrupamentoIds.length > 0) {
    const [modRows] = await executor.query(
      `SELECT m.agrupamento_id, p.id AS professor_id, p.nome AS professor_nome, m.aulas
         FROM agrupamento_modulacao m
         JOIN professores p ON p.id = m.professor_id
        WHERE m.escola_id = ? AND m.agrupamento_id IN (?)
        ORDER BY p.nome ASC`,
      [escola_id, agrupamentoIds]
    );
    for (const m of modRows) {
      const list = profsPorTurma.get(m.agrupamento_id) || [];
      list.push({
        professor_id: m.professor_id,
        professor_nome: m.professor_nome,
        aulas: Number(m.aulas || 0),
      });
      profsPorTurma.set(m.agrupamento_id, list);
    }
  }

  const turmasPorProjeto = new Map();
  for (const t of turmasRows) {
    const cap = t.capacidade !== null && t.capacidade !== undefined ? Number(t.capacidade) : null;
    const mat = Number(t.matriculados || 0);
    const vagasRestantes = cap !== null ? Math.max(0, cap - mat) : null;
    const list = turmasPorProjeto.get(t.projeto_id) || [];
    const idx = list.length + 1;
    list.push({
      id: t.id,
      projeto_id: t.projeto_id,
      nome: t.nome,
      apelido_turma: t.apelido_turma || `Turma ${String(idx).padStart(2, "0")}`,
      turno: t.turno,
      semestre: Number(t.semestre),
      ano_letivo: Number(t.ano_letivo),
      capacidade: cap,
      matriculados: mat,
      vagas_restantes: vagasRestantes,
      lotada: cap !== null && mat >= cap,
      status: t.status,
      professores: profsPorTurma.get(t.id) || [],
    });
    turmasPorProjeto.set(t.projeto_id, list);
  }

  return projetosRows.map((p) => {
    const turmas = turmasPorProjeto.get(p.id) || [];
    const vagasTotais = turmas.reduce((acc, t) => acc + Number(t.capacidade || 0), 0);
    const totalMatriculados = turmas.reduce((acc, t) => acc + Number(t.matriculados || 0), 0);
    const vagasRestantesTotal = Math.max(0, vagasTotais - totalMatriculados);

    return {
      id: p.id,
      escola_id: p.escola_id,
      ano_letivo: Number(p.ano_letivo),
      semestre: Number(p.semestre),
      categoria: p.categoria,
      categoria_info: CATEGORIAS_EM[p.categoria] || CATEGORIAS_EM.PROJETO,
      nome: p.nome,
      abreviatura: p.abreviatura,
      sinopse: p.sinopse || "",
      professor_idealizador: p.professor_idealizador || "",
      turno: p.turno,
      series: parseSeriesJson(p.series_json),
      carga_semanal: Number(p.carga_semanal || 2),
      disciplina_id: p.disciplina_id,
      qtd_turmas_planejadas: Number(p.qtd_turmas_planejadas || turmas.length || 1),
      vagas_por_turma: Number(p.vagas_por_turma || 35),
      inscricao_aberta: Number(p.inscricao_aberta) === 1,
      status: p.status,
      created_at: p.created_at,
      updated_at: p.updated_at,
      resumo_vagas: {
        total_turmas: turmas.length,
        vagas_totais: vagasTotais,
        matriculados: totalMatriculados,
        vagas_restantes: vagasRestantesTotal,
      },
      turmas,
    };
  });
}

// ===========================================================================
// GET /api/matriculas/projetos
// Retorna catálogo dos 6 cards (com contadores ao vivo no ano/semestre) + lista
// de projetos hidratados com suas turmas e vagas.
// ===========================================================================
router.get("/", async (req, res) => {
  try {
    const { escola_id } = req.user;
    const anoLetivo = toInt(req.query.ano_letivo, anoLetivoPadrao());
    const semestreFiltro =
      req.query.semestre !== undefined && req.query.semestre !== "" && req.query.semestre !== "TODOS"
        ? toInt(req.query.semestre, null)
        : null;
    const turnoFiltro =
      req.query.turno && req.query.turno !== "TODOS" ? normTurno(req.query.turno) : null;
    const categoriaFiltro =
      req.query.categoria && req.query.categoria !== "TODAS"
        ? String(req.query.categoria).toUpperCase().trim()
        : null;
    const busca = String(req.query.q || "").trim().toLowerCase();

    // Busca todos os projetos do ano (e semestre/turno se filtrados) para calcular
    // o resumo fiel dos 6 cards do topo mesmo quando 1 card específico está filtrado.
    const whereBase = ["p.escola_id = ?", "p.ano_letivo = ?"];
    const paramsBase = [escola_id, anoLetivo];

    if (semestreFiltro !== null && [0, 1, 2].includes(semestreFiltro)) {
      whereBase.push("p.semestre = ?");
      paramsBase.push(semestreFiltro);
    }
    if (turnoFiltro) {
      whereBase.push("p.turno = ?");
      paramsBase.push(turnoFiltro);
    }

    const [todosProjetosRows] = await pool.query(
      `SELECT p.*
         FROM em_projetos p
        WHERE ${whereBase.join(" AND ")}
        ORDER BY p.created_at DESC, p.id DESC`,
      paramsBase
    );

    const todosHidratados = await hidratarProjetosComTurmas(escola_id, todosProjetosRows);

    // Monta estatísticas por categoria para os 6 cards do topo
    const resumoCategorias = {};
    for (const key of Object.keys(CATEGORIAS_EM)) {
      resumoCategorias[key] = {
        ...CATEGORIAS_EM[key],
        total_projetos: 0,
        total_turmas: 0,
        vagas_totais: 0,
        matriculados: 0,
        vagas_restantes: 0,
      };
    }

    for (const proj of todosHidratados) {
      const bucket = resumoCategorias[proj.categoria];
      if (!bucket) continue;
      bucket.total_projetos += 1;
      bucket.total_turmas += proj.resumo_vagas.total_turmas;
      bucket.vagas_totais += proj.resumo_vagas.vagas_totais;
      bucket.matriculados += proj.resumo_vagas.matriculados;
      bucket.vagas_restantes += proj.resumo_vagas.vagas_restantes;
    }

    // Aplica filtro de categoria e busca textual para a listagem de tabelas abaixo
    let projetosFiltrados = todosHidratados;
    if (categoriaFiltro && CATEGORIAS_EM[categoriaFiltro]) {
      projetosFiltrados = projetosFiltrados.filter((p) => p.categoria === categoriaFiltro);
    }
    if (busca) {
      projetosFiltrados = projetosFiltrados.filter(
        (p) =>
          String(p.nome || "").toLowerCase().includes(busca) ||
          String(p.sinopse || "").toLowerCase().includes(busca) ||
          String(p.abreviatura || "").toLowerCase().includes(busca) ||
          String(p.professor_idealizador || "").toLowerCase().includes(busca)
      );
    }

    return res.json({
      ok: true,
      ano_letivo: anoLetivo,
      categorias: Object.values(resumoCategorias),
      projetos: projetosFiltrados,
    });
  } catch (err) {
    return responderErro(res, err, "Erro ao carregar projetos do Novo Ensino Médio.");
  }
});

// ===========================================================================
// POST /api/matriculas/projetos
// Cria o Projeto + Disciplina (modo AGRUPAMENTO) + N Turmas automaticamente!
// ===========================================================================
router.post("/", exigirGestao, async (req, res) => {
  try {
    const { escola_id, id: usuarioId } = req.user;
    const body = req.body || {};

    const categoria = String(body.categoria || "").toUpperCase().trim();
    const catInfo = CATEGORIAS_EM[categoria];
    if (!catInfo) {
      throw falha(400, "Categoria de projeto inválida.");
    }

    const nome = String(body.nome || "").trim();
    if (!nome) throw falha(400, "Informe o nome do projeto / componente curricular.");
    if (nome.length > 120) throw falha(400, "O nome do projeto deve ter no máximo 120 caracteres.");

    const turno = normTurno(body.turno);
    if (!turno) throw falha(400, `Selecione um turno válido (${TURNOS_VALIDOS.join(", ")}).`);

    const anoLetivo = toInt(body.ano_letivo, anoLetivoPadrao());
    if (!anoLetivo || anoLetivo < 2020 || anoLetivo > 2100) {
      throw falha(400, "Ano letivo inválido.");
    }

    const semestre = toInt(body.semestre, 1);
    if (![0, 1, 2].includes(semestre)) {
      throw falha(400, "Semestre inválido (use 1 para 1º Semestre, 2 para 2º Semestre ou 0 para Anual).");
    }

    const qtdTurmas = toInt(body.qtd_turmas, 1);
    if (!qtdTurmas || qtdTurmas < 1 || qtdTurmas > 20) {
      throw falha(400, "A quantidade de turmas deve ser entre 1 e 20.");
    }

    const vagasPorTurma = toInt(body.vagas_por_turma, 35);
    if (!vagasPorTurma || vagasPorTurma < 1 || vagasPorTurma > 500) {
      throw falha(400, "A quantidade de alunos (vagas) por turma deve ser entre 1 e 500.");
    }

    const cargaSemanal = toInt(body.carga_semanal, 2);
    if (!cargaSemanal || cargaSemanal < 1 || cargaSemanal > 20) {
      throw falha(400, "A carga semanal deve ser entre 1 e 20 aulas.");
    }

    const sinopse = body.sinopse ? String(body.sinopse).trim().slice(0, 4000) : null;
    const professorIdealizador = body.professor_idealizador
      ? String(body.professor_idealizador).trim().slice(0, 120)
      : null;
    const seriesJson = normalizarSeriesInput(body.series);
    const inscricaoAberta = body.inscricao_aberta === false ? 0 : 1;
    const abrevFinal =
      typeof body.abreviatura === "string" && body.abreviatura.trim()
        ? body.abreviatura.trim().toUpperCase().slice(0, 20)
        : gerarAbreviaturaPadrao(nome, catInfo.abrevPrefix);

    const projetoCriado = await comTransacao(async (conn) => {
      // 1. Garante a disciplina em `disciplinas` (modo_oferta = 'AGRUPAMENTO')
      const disciplinaId = await resolverOuCriarDisciplinaProjeto(conn, {
        escola_id,
        nomeProjeto: nome,
        abreviatura: abrevFinal,
        catInfo,
        turno,
        carga_semanal: cargaSemanal,
      });

      // 2. Insere o registro mestre em `em_projetos`
      const [insProj] = await conn.query(
        `INSERT INTO em_projetos
           (escola_id, ano_letivo, semestre, categoria, nome, abreviatura, sinopse,
            professor_idealizador, turno, series_json, carga_semanal, disciplina_id,
            qtd_turmas_planejadas, vagas_por_turma, inscricao_aberta, status, criado_por)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ABERTO', ?)`,
        [
          escola_id,
          anoLetivo,
          semestre,
          categoria,
          nome,
          abrevFinal,
          sinopse,
          professorIdealizador,
          turno,
          seriesJson,
          cargaSemanal,
          disciplinaId,
          qtdTurmas,
          vagasPorTurma,
          inscricaoAberta,
          usuarioId || null,
        ]
      );
      const projetoId = insProj.insertId;

      // 3. Gera automaticamente as N turmas em `agrupamentos` + vínculo `agrupamento_componentes`
      for (let i = 1; i <= qtdTurmas; i++) {
        const { nome: nomeAgr, apelido } = await gerarNomeTurmaAgrupamento(conn, {
          escola_id,
          ano_letivo: anoLetivo,
          semestre,
          turno,
          nomeProjeto: nome,
          numeroTurma: i,
        });

        const [insAgr] = await conn.query(
          `INSERT INTO agrupamentos
             (escola_id, ano_letivo, semestre, nome, apelido_turma, projeto_id, tipo, turno, capacidade, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ABERTO')`,
          [
            escola_id,
            anoLetivo,
            semestre,
            nomeAgr,
            apelido,
            projetoId,
            catInfo.agrupamentoTipo,
            turno,
            vagasPorTurma,
          ]
        );

        await conn.query(
          `INSERT INTO agrupamento_componentes
             (escola_id, agrupamento_id, disciplina_id, carga_semanal)
           VALUES (?, ?, ?, ?)`,
          [escola_id, insAgr.insertId, disciplinaId, cargaSemanal]
        );
      }

      const [rowsProj] = await conn.query(
        `SELECT * FROM em_projetos WHERE id = ? AND escola_id = ? LIMIT 1`,
        [projetoId, escola_id]
      );
      const [hidratado] = await hidratarProjetosComTurmas(escola_id, rowsProj, conn);
      return hidratado;
    });

    return res.status(201).json({
      ok: true,
      message: `Projeto "${nome}" criado com ${qtdTurmas} turma(s) de ${vagasPorTurma} vagas.`,
      projeto: projetoCriado,
    });
  } catch (err) {
    return responderErro(res, err, "Não foi possível criar o projeto e suas turmas.");
  }
});

// ===========================================================================
// PUT /api/matriculas/projetos/:id
// Atualiza metadados do projeto, capacidade das turmas e cria turmas extras se
// qtd_turmas tiver sido ampliada.
// ===========================================================================
router.put("/:id", exigirGestao, async (req, res) => {
  try {
    const { escola_id } = req.user;
    const projetoId = toInt(req.params.id);
    if (!projetoId) throw falha(400, "Identificador de projeto inválido.");

    const body = req.body || {};

    const projetoAtualizado = await comTransacao(async (conn) => {
      const [[atual]] = await conn.query(
        `SELECT * FROM em_projetos WHERE id = ? AND escola_id = ? FOR UPDATE`,
        [projetoId, escola_id]
      );
      if (!atual) throw falha(404, "Projeto não encontrado nesta escola.");

      const categoria = body.categoria
        ? String(body.categoria).toUpperCase().trim()
        : atual.categoria;
      const catInfo = CATEGORIAS_EM[categoria];
      if (!catInfo) throw falha(400, "Categoria inválida.");

      const nome = body.nome !== undefined ? String(body.nome).trim() : atual.nome;
      if (!nome) throw falha(400, "O nome do projeto não pode ficar vazio.");
      if (nome.length > 120) throw falha(400, "Nome muito longo (máx. 120 caracteres).");

      const turno = body.turno !== undefined ? normTurno(body.turno) : atual.turno;
      if (!turno) throw falha(400, "Turno inválido.");

      const semestre = body.semestre !== undefined ? toInt(body.semestre, atual.semestre) : Number(atual.semestre);
      if (![0, 1, 2].includes(semestre)) throw falha(400, "Semestre inválido.");

      const cargaSemanal =
        body.carga_semanal !== undefined ? toInt(body.carga_semanal, atual.carga_semanal) : Number(atual.carga_semanal);
      if (!cargaSemanal || cargaSemanal < 1 || cargaSemanal > 20) {
        throw falha(400, "Carga semanal inválida (1 a 20 aulas).");
      }

      const vagasPorTurma =
        body.vagas_por_turma !== undefined ? toInt(body.vagas_por_turma, atual.vagas_por_turma) : Number(atual.vagas_por_turma);
      if (!vagasPorTurma || vagasPorTurma < 1 || vagasPorTurma > 500) {
        throw falha(400, "Quantidade de vagas por turma inválida (1 a 500).");
      }

      const status =
        body.status !== undefined ? String(body.status).toUpperCase().trim() : atual.status;
      if (!STATUS_VALIDOS.includes(status)) throw falha(400, "Status inválido.");

      const sinopse =
        body.sinopse !== undefined
          ? (body.sinopse ? String(body.sinopse).trim().slice(0, 4000) : null)
          : atual.sinopse;
      const professorIdealizador =
        body.professor_idealizador !== undefined
          ? (body.professor_idealizador ? String(body.professor_idealizador).trim().slice(0, 120) : null)
          : atual.professor_idealizador;
      const seriesJson =
        body.series !== undefined ? normalizarSeriesInput(body.series) : atual.series_json;
      const inscricaoAberta =
        body.inscricao_aberta !== undefined
          ? (body.inscricao_aberta ? 1 : 0)
          : Number(atual.inscricao_aberta);
      const abrevFinal =
        body.abreviatura !== undefined
          ? (body.abreviatura.trim()
              ? body.abreviatura.trim().toUpperCase().slice(0, 20)
              : gerarAbreviaturaPadrao(nome, catInfo.abrevPrefix))
          : atual.abreviatura;

      // Busca turmas existentes do projeto
      const [turmasAtuais] = await conn.query(
        `SELECT g.id, g.nome, g.apelido_turma, g.capacidade,
                (SELECT COUNT(*) FROM agrupamento_alunos aa WHERE aa.agrupamento_id = g.id AND aa.status = 'ativo') AS matriculados
           FROM agrupamentos g
          WHERE g.escola_id = ? AND g.projeto_id = ?
          ORDER BY g.id ASC`,
        [escola_id, projetoId]
      );

      // Verifica se alguma turma tem mais matriculados que a nova capacidade
      if (body.vagas_por_turma !== undefined) {
        const excedida = turmasAtuais.find((t) => Number(t.matriculados) > vagasPorTurma);
        if (excedida) {
          throw falha(
            409,
            `A ${excedida.apelido_turma || excedida.nome} já possui ${excedida.matriculados} estudantes matriculados (maior que o novo limite de ${vagasPorTurma} vagas).`
          );
        }
      }

      const qtdTurmasDesejada =
        body.qtd_turmas !== undefined
          ? toInt(body.qtd_turmas, turmasAtuais.length)
          : Math.max(Number(atual.qtd_turmas_planejadas || 1), turmasAtuais.length);

      if (qtdTurmasDesejada < turmasAtuais.length) {
        throw falha(
          409,
          `O projeto já possui ${turmasAtuais.length} turma(s) criada(s). Para reduzir turmas, exclua a turma específica desejada.`
        );
      }
      if (qtdTurmasDesejada > 20) {
        throw falha(400, "Máximo de 20 turmas por projeto.");
      }

      // Atualiza disciplina se nome mudou
      let disciplinaId = atual.disciplina_id;
      if (!disciplinaId) {
        disciplinaId = await resolverOuCriarDisciplinaProjeto(conn, {
          escola_id,
          nomeProjeto: nome,
          abreviatura: abrevFinal,
          catInfo,
          turno,
          carga_semanal: cargaSemanal,
        });
      }

      await conn.query(
        `UPDATE em_projetos
            SET categoria = ?, nome = ?, abreviatura = ?, sinopse = ?,
                professor_idealizador = ?, turno = ?, semestre = ?,
                series_json = ?, carga_semanal = ?, disciplina_id = ?,
                qtd_turmas_planejadas = ?, vagas_por_turma = ?,
                inscricao_aberta = ?, status = ?
          WHERE id = ? AND escola_id = ?`,
        [
          categoria,
          nome,
          abrevFinal,
          sinopse,
          professorIdealizador,
          turno,
          semestre,
          seriesJson,
          cargaSemanal,
          disciplinaId,
          qtdTurmasDesejada,
          vagasPorTurma,
          inscricaoAberta,
          status,
          projetoId,
          escola_id,
        ]
      );

      // Sincroniza turmas existentes
      for (let idx = 0; idx < turmasAtuais.length; idx++) {
        const t = turmasAtuais[idx];
        const num = idx + 1;
        let novoNomeTurma = t.nome;
        if (nome !== atual.nome || turno !== atual.turno || semestre !== Number(atual.semestre)) {
          const gerado = await gerarNomeTurmaAgrupamento(conn, {
            escola_id,
            ano_letivo: Number(atual.ano_letivo),
            semestre,
            turno,
            nomeProjeto: nome,
            numeroTurma: num,
          });
          novoNomeTurma = gerado.nome;
        }

        await conn.query(
          `UPDATE agrupamentos
              SET nome = ?, tipo = ?, turno = ?, semestre = ?, capacidade = ?, status = ?
            WHERE id = ? AND escola_id = ?`,
          [novoNomeTurma, catInfo.agrupamentoTipo, turno, semestre, vagasPorTurma, status, t.id, escola_id]
        );

        await conn.query(
          `UPDATE agrupamento_componentes
              SET carga_semanal = ?
            WHERE agrupamento_id = ? AND escola_id = ?`,
          [cargaSemanal, t.id, escola_id]
        );
      }

      // Se ampliou qtd_turmas, cria automaticamente as turmas adicionais!
      for (let i = turmasAtuais.length + 1; i <= qtdTurmasDesejada; i++) {
        const { nome: nomeAgr, apelido } = await gerarNomeTurmaAgrupamento(conn, {
          escola_id,
          ano_letivo: Number(atual.ano_letivo),
          semestre,
          turno,
          nomeProjeto: nome,
          numeroTurma: i,
        });

        const [insAgr] = await conn.query(
          `INSERT INTO agrupamentos
             (escola_id, ano_letivo, semestre, nome, apelido_turma, projeto_id, tipo, turno, capacidade, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            escola_id,
            Number(atual.ano_letivo),
            semestre,
            nomeAgr,
            apelido,
            projetoId,
            catInfo.agrupamentoTipo,
            turno,
            vagasPorTurma,
            status,
          ]
        );

        await conn.query(
          `INSERT INTO agrupamento_componentes
             (escola_id, agrupamento_id, disciplina_id, carga_semanal)
           VALUES (?, ?, ?, ?)`,
          [escola_id, insAgr.insertId, disciplinaId, cargaSemanal]
        );
      }

      const [rowsProj] = await conn.query(
        `SELECT * FROM em_projetos WHERE id = ? AND escola_id = ? LIMIT 1`,
        [projetoId, escola_id]
      );
      const [hidratado] = await hidratarProjetosComTurmas(escola_id, rowsProj, conn);
      return hidratado;
    });

    return res.json({
      ok: true,
      message: "Projeto atualizado com sucesso.",
      projeto: projetoAtualizado,
    });
  } catch (err) {
    return responderErro(res, err, "Não foi possível atualizar o projeto.");
  }
});

// ===========================================================================
// POST /api/matriculas/projetos/:id/turmas
// Adiciona +1 turma extra a um projeto já existente (ex.: Turma 04)
// ===========================================================================
router.post("/:id/turmas", exigirGestao, async (req, res) => {
  try {
    const { escola_id } = req.user;
    const projetoId = toInt(req.params.id);
    if (!projetoId) throw falha(400, "Projeto inválido.");

    const resultado = await comTransacao(async (conn) => {
      const [[proj]] = await conn.query(
        `SELECT * FROM em_projetos WHERE id = ? AND escola_id = ? FOR UPDATE`,
        [projetoId, escola_id]
      );
      if (!proj) throw falha(404, "Projeto não encontrado.");

      const [turmas] = await conn.query(
        `SELECT id FROM agrupamentos WHERE escola_id = ? AND projeto_id = ? ORDER BY id ASC`,
        [escola_id, projetoId]
      );
      if (turmas.length >= 20) {
        throw falha(400, "Limite máximo de 20 turmas por projeto atingido.");
      }

      const vagas = toInt(req.body?.capacidade, Number(proj.vagas_por_turma || 35));
      if (!vagas || vagas < 1 || vagas > 500) {
        throw falha(400, "Capacidade inválida (1 a 500 vagas).");
      }

      const catInfo = CATEGORIAS_EM[proj.categoria] || CATEGORIAS_EM.PROJETO;
      const proxNumero = turmas.length + 1;
      const { nome: nomeAgr, apelido } = await gerarNomeTurmaAgrupamento(conn, {
        escola_id,
        ano_letivo: Number(proj.ano_letivo),
        semestre: Number(proj.semestre),
        turno: proj.turno,
        nomeProjeto: proj.nome,
        numeroTurma: proxNumero,
      });

      let disciplinaId = proj.disciplina_id;
      if (!disciplinaId) {
        disciplinaId = await resolverOuCriarDisciplinaProjeto(conn, {
          escola_id,
          nomeProjeto: proj.nome,
          abreviatura: proj.abreviatura,
          catInfo,
          turno: proj.turno,
          carga_semanal: Number(proj.carga_semanal || 2),
        });
      }

      const [insAgr] = await conn.query(
        `INSERT INTO agrupamentos
           (escola_id, ano_letivo, semestre, nome, apelido_turma, projeto_id, tipo, turno, capacidade, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ABERTO')`,
        [
          escola_id,
          Number(proj.ano_letivo),
          Number(proj.semestre),
          nomeAgr,
          apelido,
          projetoId,
          catInfo.agrupamentoTipo,
          proj.turno,
          vagas,
        ]
      );

      await conn.query(
        `INSERT INTO agrupamento_componentes
           (escola_id, agrupamento_id, disciplina_id, carga_semanal)
         VALUES (?, ?, ?, ?)`,
        [escola_id, insAgr.insertId, disciplinaId, Number(proj.carga_semanal || 2)]
      );

      await conn.query(
        `UPDATE em_projetos SET qtd_turmas_planejadas = ? WHERE id = ? AND escola_id = ?`,
        [proxNumero, projetoId, escola_id]
      );

      const [rowsProj] = await conn.query(
        `SELECT * FROM em_projetos WHERE id = ? AND escola_id = ? LIMIT 1`,
        [projetoId, escola_id]
      );
      const [hidratado] = await hidratarProjetosComTurmas(escola_id, rowsProj, conn);
      return { projeto: hidratado, nova_turma_id: insAgr.insertId, apelido };
    });

    return res.status(201).json({
      ok: true,
      message: `${resultado.apelido} adicionada ao projeto com sucesso.`,
      ...resultado,
    });
  } catch (err) {
    return responderErro(res, err, "Não foi possível adicionar nova turma ao projeto.");
  }
});

// ===========================================================================
// DELETE /api/matriculas/projetos/:id[?forcar=1]
// Exclui o projeto e todas as suas turmas vinculadas.
// ===========================================================================
router.delete("/:id", exigirGestao, async (req, res) => {
  try {
    const { escola_id } = req.user;
    const projetoId = toInt(req.params.id);
    if (!projetoId) throw falha(400, "Identificador inválido.");
    const forcar = String(req.query.forcar || "") === "1";

    await comTransacao(async (conn) => {
      const [[proj]] = await conn.query(
        `SELECT * FROM em_projetos WHERE id = ? AND escola_id = ? FOR UPDATE`,
        [projetoId, escola_id]
      );
      if (!proj) throw falha(404, "Projeto não encontrado.");

      const [turmas] = await conn.query(
        `SELECT id FROM agrupamentos WHERE escola_id = ? AND projeto_id = ?`,
        [escola_id, projetoId]
      );
      const agrIds = turmas.map((t) => t.id);

      if (agrIds.length > 0) {
        const [[{ totalAlunos }]] = await conn.query(
          `SELECT COUNT(*) AS totalAlunos
             FROM agrupamento_alunos
            WHERE escola_id = ? AND agrupamento_id IN (?) AND status = 'ativo'`,
          [escola_id, agrIds]
        );
        const [[{ totalMod }]] = await conn.query(
          `SELECT COUNT(*) AS totalMod
             FROM agrupamento_modulacao
            WHERE escola_id = ? AND agrupamento_id IN (?)`,
          [escola_id, agrIds]
        );

        if ((Number(totalAlunos) > 0 || Number(totalMod) > 0) && !forcar) {
          throw falha(
            409,
            `Este projeto possui ${totalAlunos} estudante(s) matriculado(s) e ${totalMod} vínculo(s) de modulação. Confirme para excluir tudo.`,
            {
              requer_confirmacao: true,
              total_alunos: Number(totalAlunos),
              total_modulacoes: Number(totalMod),
            }
          );
        }

        await conn.query(
          `DELETE FROM agrupamento_alunos WHERE escola_id = ? AND agrupamento_id IN (?)`,
          [escola_id, agrIds]
        );
        await conn.query(
          `DELETE FROM agrupamento_modulacao WHERE escola_id = ? AND agrupamento_id IN (?)`,
          [escola_id, agrIds]
        );
        await conn.query(
          `DELETE FROM agrupamento_componentes WHERE escola_id = ? AND agrupamento_id IN (?)`,
          [escola_id, agrIds]
        );
        await conn.query(
          `DELETE FROM agrupamentos WHERE escola_id = ? AND id IN (?)`,
          [escola_id, agrIds]
        );
      }

      await conn.query(`DELETE FROM em_projetos WHERE id = ? AND escola_id = ?`, [
        projetoId,
        escola_id,
      ]);
    });

    return res.json({ ok: true, message: "Projeto e turmas excluídos com sucesso." });
  } catch (err) {
    return responderErro(res, err, "Não foi possível excluir o projeto.");
  }
});

// ===========================================================================
// DELETE /api/matriculas/projetos/turmas/:agrupamentoId[?forcar=1]
// Exclui uma turma específica de um projeto (desde que reste ao menos 1 turma).
// ===========================================================================
router.delete("/turmas/:agrupamentoId", exigirGestao, async (req, res) => {
  try {
    const { escola_id } = req.user;
    const agrupamentoId = toInt(req.params.agrupamentoId);
    if (!agrupamentoId) throw falha(400, "Turma inválida.");
    const forcar = String(req.query.forcar || "") === "1";

    await comTransacao(async (conn) => {
      const [[agr]] = await conn.query(
        `SELECT * FROM agrupamentos WHERE id = ? AND escola_id = ? FOR UPDATE`,
        [agrupamentoId, escola_id]
      );
      if (!agr || !agr.projeto_id) throw falha(404, "Turma de projeto não encontrada.");

      const [irmas] = await conn.query(
        `SELECT id FROM agrupamentos WHERE escola_id = ? AND projeto_id = ? ORDER BY id ASC`,
        [escola_id, agr.projeto_id]
      );
      if (irmas.length <= 1) {
        throw falha(
          409,
          "Esta é a única turma do projeto. Para remover tudo, utilize a opção Excluir Projeto."
        );
      }

      const [[{ totalAlunos }]] = await conn.query(
        `SELECT COUNT(*) AS totalAlunos
           FROM agrupamento_alunos
          WHERE escola_id = ? AND agrupamento_id = ? AND status = 'ativo'`,
        [escola_id, agrupamentoId]
      );
      if (Number(totalAlunos) > 0 && !forcar) {
        throw falha(
          409,
          `Esta turma possui ${totalAlunos} estudante(s) matriculado(s). Confirme para excluir mesmo assim.`,
          { requer_confirmacao: true, total_alunos: Number(totalAlunos) }
        );
      }

      await conn.query(
        `DELETE FROM agrupamento_alunos WHERE escola_id = ? AND agrupamento_id = ?`,
        [escola_id, agrupamentoId]
      );
      await conn.query(
        `DELETE FROM agrupamento_modulacao WHERE escola_id = ? AND agrupamento_id = ?`,
        [escola_id, agrupamentoId]
      );
      await conn.query(
        `DELETE FROM agrupamento_componentes WHERE escola_id = ? AND agrupamento_id = ?`,
        [escola_id, agrupamentoId]
      );
      await conn.query(
        `DELETE FROM agrupamentos WHERE escola_id = ? AND id = ?`,
        [escola_id, agrupamentoId]
      );

      await conn.query(
        `UPDATE em_projetos SET qtd_turmas_planejadas = ? WHERE id = ? AND escola_id = ?`,
        [irmas.length - 1, agr.projeto_id, escola_id]
      );
    });

    return res.json({ ok: true, message: "Turma removida do projeto." });
  } catch (err) {
    return responderErro(res, err, "Não foi possível excluir a turma.");
  }
});

// ===========================================================================
// GET /api/matriculas/projetos/turmas/:agrupamentoId/alunos
// Retorna relação nominal de estudantes da turma selecionada, vagas e turmas irmãs
// ===========================================================================
router.get("/turmas/:agrupamentoId/alunos", async (req, res) => {
  try {
    const { escola_id } = req.user;
    const agrupamentoId = toInt(req.params.agrupamentoId);
    if (!agrupamentoId) throw falha(400, "Turma inválida.");

    const [[agr]] = await pool.query(
      `SELECT g.*, p.nome AS projeto_nome, p.categoria AS projeto_categoria, p.series_json
         FROM agrupamentos g
         LEFT JOIN em_projetos p ON p.id = g.projeto_id
        WHERE g.id = ? AND g.escola_id = ?
        LIMIT 1`,
      [agrupamentoId, escola_id]
    );
    if (!agr) throw falha(404, "Turma não encontrada.");

    const [alunos] = await pool.query(
      `SELECT
         aa.id,
         aa.aluno_id,
         a.codigo,
         a.estudante AS nome,
         aa.turma_origem_id,
         t.nome AS turma_origem_nome,
         t.serie AS turma_origem_serie,
         t.turno AS turma_origem_turno,
         aa.entrada_em
       FROM agrupamento_alunos aa
       JOIN alunos a ON a.id = aa.aluno_id
       LEFT JOIN turmas t ON t.id = aa.turma_origem_id
       WHERE aa.escola_id = ? AND aa.agrupamento_id = ? AND aa.status = 'ativo'
       ORDER BY t.nome ASC, a.estudante ASC`,
      [escola_id, agrupamentoId]
    );

    // Turmas irmãs do mesmo projeto (para transferência rápida entre Turma 01 ↔ Turma 02)
    let outrasTurmas = [];
    if (agr.projeto_id) {
      const [irmas] = await pool.query(
        `SELECT g.id, g.nome, g.apelido_turma, g.capacidade,
                (SELECT COUNT(*) FROM agrupamento_alunos aa WHERE aa.agrupamento_id = g.id AND aa.status = 'ativo') AS matriculados
           FROM agrupamentos g
          WHERE g.escola_id = ? AND g.projeto_id = ? AND g.id <> ?
          ORDER BY g.id ASC`,
        [escola_id, agr.projeto_id, agrupamentoId]
      );
      outrasTurmas = irmas.map((ir) => {
        const cap = ir.capacidade !== null ? Number(ir.capacidade) : null;
        const mat = Number(ir.matriculados || 0);
        return {
          id: ir.id,
          nome: ir.nome,
          apelido_turma: ir.apelido_turma || ir.nome,
          capacidade: cap,
          matriculados: mat,
          vagas_restantes: cap !== null ? Math.max(0, cap - mat) : null,
        };
      });
    }

    // Turmas regulares da escola no ano letivo (para filtro rápido no modal de matrícula)
    const [turmasRegulares] = await pool.query(
      `SELECT DISTINCT t.id, t.nome, t.serie, t.turno, t.etapa
         FROM turmas t
         JOIN matriculas m ON m.turma_id = t.id AND m.escola_id = t.escola_id
        WHERE t.escola_id = ? AND m.ano_letivo = ? AND m.status IN ('ativo', 'matriculado')
        ORDER BY t.turno ASC, t.nome ASC`,
      [escola_id, agr.ano_letivo]
    );

    const cap = agr.capacidade !== null ? Number(agr.capacidade) : null;
    const mat = alunos.length;

    return res.json({
      ok: true,
      turma: {
        id: agr.id,
        projeto_id: agr.projeto_id,
        projeto_nome: agr.projeto_nome || agr.nome,
        apelido_turma: agr.apelido_turma || agr.nome,
        nome: agr.nome,
        turno: agr.turno,
        semestre: Number(agr.semestre),
        ano_letivo: Number(agr.ano_letivo),
        capacidade: cap,
        matriculados: mat,
        vagas_restantes: cap !== null ? Math.max(0, cap - mat) : null,
        status: agr.status,
      },
      alunos,
      outras_turmas_projeto: outrasTurmas,
      turmas_regulares: turmasRegulares,
    });
  } catch (err) {
    return responderErro(res, err, "Erro ao carregar estudantes da turma.");
  }
});

// ===========================================================================
// GET /api/matriculas/projetos/turmas/:agrupamentoId/candidatos
// Pesquisa estudantes com matrícula regular ativa para enturmar nesta turma
// ===========================================================================
router.get("/turmas/:agrupamentoId/candidatos", async (req, res) => {
  try {
    const { escola_id } = req.user;
    const agrupamentoId = toInt(req.params.agrupamentoId);
    if (!agrupamentoId) throw falha(400, "Turma inválida.");

    const [[agr]] = await pool.query(
      `SELECT id, projeto_id, ano_letivo, semestre, turno
         FROM agrupamentos
        WHERE id = ? AND escola_id = ?
        LIMIT 1`,
      [agrupamentoId, escola_id]
    );
    if (!agr) throw falha(404, "Turma não encontrada.");

    const turmaOrigemId = toInt(req.query.turma_origem_id);
    const mesmoTurno = String(req.query.mesmo_turno || "") === "1";
    const q = String(req.query.q || "").trim();
    const limite = Math.min(Math.max(toInt(req.query.limite, 120) || 120, 1), 300);

    // Exclui alunos já ativos nesta turma OU em qualquer outra turma do MESMO projeto!
    let exclusaoProjetoSql = `
      NOT EXISTS (
        SELECT 1 FROM agrupamento_alunos y
         WHERE y.escola_id = m.escola_id
           AND y.aluno_id = a.id
           AND y.status = 'ativo'
           AND y.agrupamento_id = ?
      )
    `;
    const paramsExclusao = [agr.id];

    if (agr.projeto_id) {
      exclusaoProjetoSql = `
        NOT EXISTS (
          SELECT 1 FROM agrupamento_alunos y
            JOIN agrupamentos gy ON gy.id = y.agrupamento_id
           WHERE y.escola_id = m.escola_id
             AND y.aluno_id = a.id
             AND y.status = 'ativo'
             AND gy.projeto_id = ?
        )
      `;
      paramsExclusao[0] = agr.projeto_id;
    }

    let sql = `
      SELECT
        a.id AS aluno_id,
        a.codigo,
        a.estudante AS nome,
        m.id AS matricula_id,
        m.turma_id AS turma_origem_id,
        t.nome AS turma_origem_nome,
        t.serie AS turma_origem_serie,
        t.turno AS turma_origem_turno,
        t.etapa AS turma_origem_etapa,
        (SELECT COUNT(*)
           FROM agrupamento_alunos x
           JOIN agrupamentos gx ON gx.id = x.agrupamento_id
          WHERE x.escola_id = m.escola_id
            AND x.aluno_id = a.id
            AND x.status = 'ativo'
            AND gx.ano_letivo = ?
            AND gx.id <> ?
            AND (gx.semestre = 0 OR ? = 0 OR gx.semestre = ?)) AS outros_projetos_semestre
      FROM matriculas m
      JOIN alunos a ON a.id = m.aluno_id
      JOIN turmas t ON t.id = m.turma_id
      WHERE m.escola_id = ?
        AND m.ano_letivo = ?
        AND m.status IN ('ativo', 'matriculado')
        AND (a.status = 'ativo' OR a.status IS NULL)
        AND ${exclusaoProjetoSql}
    `;

    const params = [
      agr.ano_letivo,
      agr.id,
      agr.semestre,
      agr.semestre,
      escola_id,
      agr.ano_letivo,
      ...paramsExclusao,
    ];

    if (turmaOrigemId) {
      sql += " AND m.turma_id = ?";
      params.push(turmaOrigemId);
    }
    if (mesmoTurno && agr.turno && agr.turno !== "Integral") {
      sql += " AND LOWER(t.turno) = LOWER(?)";
      params.push(agr.turno);
    }
    if (q) {
      sql += " AND (a.estudante LIKE ? OR CAST(a.codigo AS CHAR) LIKE ?)";
      params.push(`%${q}%`, `%${q}%`);
    }

    sql += " ORDER BY t.nome ASC, a.estudante ASC LIMIT ?";
    params.push(limite);

    const [candidatos] = await pool.query(sql, params);
    return res.json({ ok: true, candidatos });
  } catch (err) {
    return responderErro(res, err, "Erro ao pesquisar estudantes candidatos.");
  }
});

// ===========================================================================
// POST /api/matriculas/projetos/turmas/:agrupamentoId/matricular
// Enturma estudantes na turma do projeto com lock transacional de vagas (`FOR UPDATE`)
// ===========================================================================
router.post("/turmas/:agrupamentoId/matricular", exigirGestao, async (req, res) => {
  try {
    const { escola_id } = req.user;
    const agrupamentoId = toInt(req.params.agrupamentoId);
    if (!agrupamentoId) throw falha(400, "Turma inválida.");

    const alunoIds = [
      ...new Set(
        (Array.isArray(req.body?.aluno_ids) ? req.body.aluno_ids : [])
          .map((v) => toInt(v))
          .filter(Boolean)
      ),
    ];
    if (alunoIds.length === 0) {
      throw falha(400, "Selecione ao menos um estudante para matricular.");
    }
    if (alunoIds.length > 500) {
      throw falha(400, "Máximo de 500 estudantes por operação.");
    }

    const resultado = await comTransacao(async (conn) => {
      // Lock pessimista na linha da turma para impedir overbooking simultâneo
      const [[agr]] = await conn.query(
        `SELECT id, projeto_id, nome, apelido_turma, ano_letivo, semestre, turno, capacidade, status
           FROM agrupamentos
          WHERE id = ? AND escola_id = ?
          FOR UPDATE`,
        [agrupamentoId, escola_id]
      );
      if (!agr) throw falha(404, "Turma não encontrada.");
      if (agr.status === "ENCERRADO") {
        throw falha(409, "Esta turma está encerrada e não aceita novas matrículas.");
      }

      // Verifica matrículas regulares ativas no ano letivo
      const [matRows] = await conn.query(
        `SELECT m.aluno_id, m.id AS matricula_id, m.turma_id, a.estudante AS nome
           FROM matriculas m
           JOIN alunos a ON a.id = m.aluno_id
          WHERE m.escola_id = ?
            AND m.ano_letivo = ?
            AND m.status IN ('ativo', 'matriculado')
            AND (a.status = 'ativo' OR a.status IS NULL)
            AND m.aluno_id IN (?)
          ORDER BY m.id ASC`,
        [escola_id, agr.ano_letivo, alunoIds]
      );
      const mapaMat = new Map(matRows.map((m) => [Number(m.aluno_id), m]));
      const elegiveis = alunoIds.filter((id) => mapaMat.has(id));
      if (elegiveis.length === 0) {
        throw falha(400, "Nenhum dos estudantes selecionados possui matrícula regular ativa neste ano letivo.");
      }

      // Verifica se já estão em alguma turma do MESMO projeto
      let jaNoProjetoSet = new Set();
      if (agr.projeto_id) {
        const [jaProj] = await conn.query(
          `SELECT aa.aluno_id, g.apelido_turma, g.nome
             FROM agrupamento_alunos aa
             JOIN agrupamentos g ON g.id = aa.agrupamento_id
            WHERE aa.escola_id = ? AND g.projeto_id = ? AND aa.status = 'ativo' AND aa.aluno_id IN (?)`,
          [escola_id, agr.projeto_id, elegiveis]
        );
        jaNoProjetoSet = new Set(jaProj.map((r) => Number(r.aluno_id)));
      } else {
        const [jaAgr] = await conn.query(
          `SELECT aluno_id
             FROM agrupamento_alunos
            WHERE escola_id = ? AND agrupamento_id = ? AND status = 'ativo' AND aluno_id IN (?)`,
          [escola_id, agr.id, elegiveis]
        );
        jaNoProjetoSet = new Set(jaAgr.map((r) => Number(r.aluno_id)));
      }

      const novos = elegiveis.filter((id) => !jaNoProjetoSet.has(id));

      // Validação estrita de vagas restantes
      const [[{ ocupadas }]] = await conn.query(
        `SELECT COUNT(*) AS ocupadas
           FROM agrupamento_alunos
          WHERE escola_id = ? AND agrupamento_id = ? AND status = 'ativo'`,
        [escola_id, agr.id]
      );

      if (agr.capacidade !== null && agr.capacidade !== undefined) {
        const vagasRestantes = Number(agr.capacidade) - Number(ocupadas);
        if (novos.length > vagasRestantes) {
          throw falha(
            409,
            `Vagas insuficientes na ${agr.apelido_turma || agr.nome}: restam ${Math.max(0, vagasRestantes)} vaga(s) e foram selecionados ${novos.length} estudante(s).`,
            { vagas_restantes: Math.max(0, vagasRestantes) }
          );
        }
      }

      if (novos.length > 0) {
        const hojeIso = new Date().toISOString().slice(0, 10);
        const valores = novos.map((id) => {
          const m = mapaMat.get(id);
          return [escola_id, agr.id, id, m.matricula_id, m.turma_id, "ativo", hojeIso];
        });

        await conn.query(
          `INSERT INTO agrupamento_alunos
             (escola_id, agrupamento_id, aluno_id, matricula_id, turma_origem_id, status, entrada_em)
           VALUES ?
           ON DUPLICATE KEY UPDATE
             status = 'ativo',
             saida_em = NULL,
             matricula_id = VALUES(matricula_id),
             turma_origem_id = VALUES(turma_origem_id),
             entrada_em = CURDATE()`,
          [valores]
        );
      }

      const novoTotal = Number(ocupadas) + novos.length;
      const vagasRestantesPos =
        agr.capacidade !== null ? Math.max(0, Number(agr.capacidade) - novoTotal) : null;

      return {
        adicionados: novos.length,
        ja_matriculados_no_projeto: jaNoProjetoSet.size,
        matriculados_atual: novoTotal,
        vagas_restantes: vagasRestantesPos,
      };
    });

    return res.status(201).json({
      ok: true,
      message: `${resultado.adicionados} estudante(s) matriculado(s) com sucesso.`,
      ...resultado,
    });
  } catch (err) {
    return responderErro(res, err, "Não foi possível matricular os estudantes na turma.");
  }
});

// ===========================================================================
// POST /api/matriculas/projetos/turmas/:agrupamentoId/transferir
// Transfere um estudante entre turmas do mesmo projeto (ex: Turma 01 -> Turma 02)
// ===========================================================================
router.post("/turmas/:agrupamentoId/transferir", exigirGestao, async (req, res) => {
  try {
    const { escola_id } = req.user;
    const origemId = toInt(req.params.agrupamentoId);
    const alunoId = toInt(req.body?.aluno_id);
    const destinoId = toInt(req.body?.destino_agrupamento_id);

    if (!origemId || !alunoId || !destinoId) {
      throw falha(400, "Informe o estudante e a turma de destino.");
    }
    if (origemId === destinoId) {
      throw falha(400, "A turma de destino deve ser diferente da turma atual.");
    }

    await comTransacao(async (conn) => {
      // Lock ordenado por ID para prevenir deadlock
      const [idMenor, idMaior] = origemId < destinoId ? [origemId, destinoId] : [destinoId, origemId];
      const [agrs] = await conn.query(
        `SELECT id, projeto_id, nome, apelido_turma, capacidade, status
           FROM agrupamentos
          WHERE escola_id = ? AND id IN (?, ?)
          ORDER BY id ASC
          FOR UPDATE`,
        [escola_id, idMenor, idMaior]
      );

      const origem = agrs.find((a) => a.id === origemId);
      const destino = agrs.find((a) => a.id === destinoId);
      if (!origem || !destino) throw falha(404, "Turma de origem ou destino não encontrada.");
      if (origem.projeto_id !== destino.projeto_id) {
        throw falha(400, "A transferência direta só é permitida entre turmas do mesmo projeto.");
      }
      if (destino.status === "ENCERRADO") {
        throw falha(409, "A turma de destino está encerrada.");
      }

      const [[vinculoAtual]] = await conn.query(
        `SELECT id, matricula_id, turma_origem_id
           FROM agrupamento_alunos
          WHERE escola_id = ? AND agrupamento_id = ? AND aluno_id = ? AND status = 'ativo'
          LIMIT 1`,
        [escola_id, origemId, alunoId]
      );
      if (!vinculoAtual) {
        throw falha(404, "Estudante não encontrado na turma de origem.");
      }

      if (destino.capacidade !== null && destino.capacidade !== undefined) {
        const [[{ ocupadasDestino }]] = await conn.query(
          `SELECT COUNT(*) AS ocupadasDestino
             FROM agrupamento_alunos
            WHERE escola_id = ? AND agrupamento_id = ? AND status = 'ativo'`,
          [escola_id, destinoId]
        );
        if (Number(ocupadasDestino) >= Number(destino.capacidade)) {
          throw falha(
            409,
            `A ${destino.apelido_turma || destino.nome} está lotada (${destino.capacidade}/${destino.capacidade}).`
          );
        }
      }

      // Inativa na origem e ativa/insere no destino
      await conn.query(
        `UPDATE agrupamento_alunos
            SET status = 'inativo', saida_em = CURDATE()
          WHERE id = ? AND escola_id = ?`,
        [vinculoAtual.id, escola_id]
      );

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
          escola_id,
          destinoId,
          alunoId,
          vinculoAtual.matricula_id,
          vinculoAtual.turma_origem_id,
          hojeIso,
        ]
      );
    });

    return res.json({
      ok: true,
      message: "Estudante transferido de turma com sucesso.",
    });
  } catch (err) {
    return responderErro(res, err, "Não foi possível transferir o estudante.");
  }
});

// ===========================================================================
// POST /api/matriculas/projetos/turmas/:agrupamentoId/remover
// Remove (inativa preservando histórico) estudantes da turma do projeto
// ===========================================================================
router.post("/turmas/:agrupamentoId/remover", exigirGestao, async (req, res) => {
  try {
    const { escola_id } = req.user;
    const agrupamentoId = toInt(req.params.agrupamentoId);
    if (!agrupamentoId) throw falha(400, "Turma inválida.");

    const alunoIds = [
      ...new Set(
        (Array.isArray(req.body?.aluno_ids) ? req.body.aluno_ids : [])
          .map((v) => toInt(v))
          .filter(Boolean)
      ),
    ];
    if (alunoIds.length === 0) throw falha(400, "Informe o(s) estudante(s) a remover.");

    const [r] = await pool.query(
      `UPDATE agrupamento_alunos
          SET status = 'inativo', saida_em = CURDATE()
        WHERE escola_id = ? AND agrupamento_id = ? AND status = 'ativo' AND aluno_id IN (?)`,
      [escola_id, agrupamentoId, alunoIds]
    );

    return res.json({
      ok: true,
      removidos: r.affectedRows,
      message: "Estudante(s) removido(s) da turma.",
    });
  } catch (err) {
    return responderErro(res, err, "Não foi possível remover o(s) estudante(s).");
  }
});

export default router;
