// routes/agrupamentos.js
// ============================================================================
// ROTAS: Turmas de Agrupamento / Enturmação Mista (Novo Ensino Médio)
// ----------------------------------------------------------------------------
// Conceito (genérico, vale para qualquer escola):
//   • Agrupamento = turma de agrupamento (IFA, PCA em agrupamento, eletiva, projeto...)
//     que reúne alunos de TURMAS DISTINTAS. NÃO reutiliza `turmas`/`matriculas`
//     (o sistema assume 1 turma por aluno); o aluno continua matriculado na turma base.
//   • Cada escola cadastra seus agrupamentos e os COMPONENTES/atividades de cada um
//     (autonomia da escola, conforme diretrizes).
//   • Modulação dos professores do agrupamento fica em `agrupamento_modulacao`
//     (a tabela `modulacao` NÃO é alterada).
//   • Notas continuam em `notas` (sem turma_id): nada muda no lançamento de notas.
//
// Endpoints (todos filtram por req.user.escola_id; escrita exige perfil de gestão):
//   GET    /api/agrupamentos?ano=&semestre=&turno=&tipo=
//   POST   /api/agrupamentos
//   GET    /api/agrupamentos/:id
//   PUT    /api/agrupamentos/:id
//   DELETE /api/agrupamentos/:id[?forcar=1]
//   POST   /api/agrupamentos/:id/componentes            { disciplina_id | nome, abreviatura?, carga_semanal? }
//   PUT    /api/agrupamentos/:id/componentes/:compId    { carga_semanal }
//   DELETE /api/agrupamentos/:id/componentes/:compId[?forcar=1]
//   GET    /api/agrupamentos/:id/modulacao
//   POST   /api/agrupamentos/:id/modulacao              { professor_id, disciplina_id, aulas }
//   DELETE /api/agrupamentos/:id/modulacao/:modId
//   GET    /api/agrupamentos/modulacao/resumo?ano=&semestre=   (carga por professor)
//   GET    /api/agrupamentos/:id/alunos[?todos=1]
//   GET    /api/agrupamentos/:id/candidatos?q=&turma_id=&limite=
//   POST   /api/agrupamentos/:id/alunos                 { aluno_ids:[], confirmar? }
//   POST   /api/agrupamentos/:id/alunos/remover         { aluno_ids:[] }
//   GET    /api/agrupamentos/aluno/:alunoId?ano=&semestre=
//   GET    /api/agrupamentos/migracao/legados?ano=
//   POST   /api/agrupamentos/migracao/executar          { ano_letivo, disciplina_ids:[], modo, confirmar }
// ============================================================================

import { Router } from "express";
import pool from "../db.js";

const router = Router();

// ---------------------------------------------------------------------------
// Middlewares / constantes
// ---------------------------------------------------------------------------
function verificarEscola(req, res, next) {
  if (!req.user || !req.user.escola_id) {
    return res.status(403).json({ message: "Acesso negado: escola não definida." });
  }
  next();
}

const PERFIS_GESTAO = [
  "diretor", "direcao", "vice_diretor", "secretaria", "secretario",
  "coordenacao", "coordenador", "admin", "administrador",
];

function exigirGestao(req, res, next) {
  const perfil = String(req.user?.perfil || "").toLowerCase().trim();
  if (!PERFIS_GESTAO.includes(perfil)) {
    return res.status(403).json({ message: "Acesso negado: requer perfil de gestão." });
  }
  next();
}

const TIPOS = ["IFA", "PCA", "ELETIVA", "PROJETO", "OUTRO"];
const TURNOS = ["Matutino", "Vespertino", "Noturno", "Integral"];
const STATUS = ["RASCUNHO", "ABERTO", "ENCERRADO"];

router.use(verificarEscola);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const toInt = (v, d = null) => {
  if (v === undefined || v === null || v === "") return d;
  const n = Number(v);
  return Number.isInteger(n) ? n : d;
};

const anoDe = (req, fonte = "query") =>
  toInt(req[fonte]?.ano ?? req[fonte]?.ano_letivo, new Date().getFullYear());

const normTurno = (t) => {
  const s = String(t || "").trim().toLowerCase();
  return TURNOS.find((x) => x.toLowerCase() === s) || null;
};

const semestresSobrepoem = (a, b) => a === 0 || b === 0 || a === b;

function responderErro(res, err, msgPadrao) {
  if (err?.code === "ER_DUP_ENTRY") {
    return res.status(409).json({ message: "Registro duplicado: já existe um item igual." });
  }
  if (err?.status) {
    return res.status(err.status).json({ message: err.message, ...(err.extra || {}) });
  }
  console.error("[agrupamentos]", msgPadrao, err);
  return res.status(500).json({ message: msgPadrao });
}

const falha = (status, message, extra) => Object.assign(new Error(message), { status, extra });

async function buscarAgrupamento(escola_id, id, executor = pool) {
  const [[row]] = await executor.query(
    `SELECT g.*, e.nome AS etapa_nome
       FROM agrupamentos g
       LEFT JOIN etapas e ON e.id = g.etapa_id
      WHERE g.id = ? AND g.escola_id = ? LIMIT 1`,
    [id, escola_id]
  );
  return row || null;
}

async function exigirAgrupamento(req) {
  const id = toInt(req.params.id);
  if (!id) throw falha(400, "Identificador inválido.");
  const agr = await buscarAgrupamento(req.user.escola_id, id);
  if (!agr) throw falha(404, "Turma de agrupamento não encontrada.");
  return agr;
}

async function comTransacao(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const out = await fn(conn);
    await conn.commit();
    return out;
  } catch (e) {
    try { await conn.rollback(); } catch { /* noop */ }
    throw e;
  } finally {
    conn.release();
  }
}

// ---------------------------------------------------------------------------
// GET /  → lista
// ---------------------------------------------------------------------------
router.get("/", async (req, res) => {
  try {
    const { escola_id } = req.user;
    const ano = anoDe(req);
    const semestre = toInt(req.query.semestre);
    const turno = req.query.turno ? normTurno(req.query.turno) : null;
    const tipo = req.query.tipo ? String(req.query.tipo).toUpperCase() : null;

    let sql = `
      SELECT g.*, e.nome AS etapa_nome,
        (SELECT COUNT(*) FROM agrupamento_componentes c WHERE c.agrupamento_id = g.id) AS total_componentes,
        (SELECT COUNT(*) FROM agrupamento_alunos aa WHERE aa.agrupamento_id = g.id AND aa.status = 'ativo') AS total_alunos,
        (SELECT COUNT(DISTINCT m.professor_id) FROM agrupamento_modulacao m WHERE m.agrupamento_id = g.id) AS total_professores
      FROM agrupamentos g
      LEFT JOIN etapas e ON e.id = g.etapa_id
      WHERE g.escola_id = ? AND g.ano_letivo = ?`;
    const params = [escola_id, ano];

    if (semestre !== null) { sql += " AND (g.semestre = ? OR g.semestre = 0)"; params.push(semestre); }
    if (turno) { sql += " AND g.turno = ?"; params.push(turno); }
    if (tipo) { sql += " AND g.tipo = ?"; params.push(tipo); }
    sql += " ORDER BY g.turno, g.nome";

    const [rows] = await pool.query(sql, params);
    res.json(rows);
  } catch (err) {
    responderErro(res, err, "Não foi possível listar as turmas de agrupamento.");
  }
});

// ---------------------------------------------------------------------------
// GET /modulacao/resumo  → carga de aulas por professor nos agrupamentos
// (usada para somar com a modulação das turmas regulares)
// ---------------------------------------------------------------------------
router.get("/modulacao/resumo", async (req, res) => {
  try {
    const { escola_id } = req.user;
    const ano = anoDe(req);
    const semestre = toInt(req.query.semestre);

    let sql = `
      SELECT m.professor_id, p.nome AS professor_nome,
             SUM(m.aulas) AS aulas_agrupamento,
             COUNT(DISTINCT m.agrupamento_id) AS total_agrupamentos
        FROM agrupamento_modulacao m
        JOIN agrupamentos g ON g.id = m.agrupamento_id
        JOIN professores p ON p.id = m.professor_id
       WHERE g.escola_id = ? AND g.ano_letivo = ? AND g.status <> 'ENCERRADO'`;
    const params = [escola_id, ano];
    if (semestre !== null) { sql += " AND (g.semestre = ? OR g.semestre = 0)"; params.push(semestre); }
    sql += " GROUP BY m.professor_id, p.nome ORDER BY p.nome";

    const [rows] = await pool.query(sql, params);
    res.json(rows);
  } catch (err) {
    responderErro(res, err, "Não foi possível calcular a carga dos agrupamentos.");
  }
});

// ---------------------------------------------------------------------------
// GET /aluno/:alunoId  → agrupamentos do aluno (base para boletim/diário)
// ---------------------------------------------------------------------------
router.get("/aluno/:alunoId", async (req, res) => {
  try {
    const { escola_id } = req.user;
    const alunoId = toInt(req.params.alunoId);
    if (!alunoId) return res.status(400).json({ message: "Aluno inválido." });
    const ano = anoDe(req);
    const semestre = toInt(req.query.semestre);

    let sql = `
      SELECT g.id, g.nome, g.tipo, g.turno, g.semestre, g.ano_letivo, g.status,
             aa.turma_origem_id,
             (SELECT JSON_ARRAYAGG(JSON_OBJECT('disciplina_id', d.id, 'nome', d.nome, 'abreviatura', d.abreviatura, 'carga_semanal', c.carga_semanal))
                FROM agrupamento_componentes c JOIN disciplinas d ON d.id = c.disciplina_id
               WHERE c.agrupamento_id = g.id) AS componentes
        FROM agrupamento_alunos aa
        JOIN agrupamentos g ON g.id = aa.agrupamento_id
       WHERE aa.aluno_id = ? AND aa.escola_id = ? AND aa.status = 'ativo' AND g.ano_letivo = ?`;
    const params = [alunoId, escola_id, ano];
    if (semestre !== null) { sql += " AND (g.semestre = ? OR g.semestre = 0)"; params.push(semestre); }
    sql += " ORDER BY g.semestre, g.nome";

    const [rows] = await pool.query(sql, params);
    res.json(rows.map((r) => ({
      ...r,
      componentes: typeof r.componentes === "string" ? JSON.parse(r.componentes) : (r.componentes || []),
    })));
  } catch (err) {
    responderErro(res, err, "Não foi possível carregar os agrupamentos do aluno.");
  }
});

// ===========================================================================
// ASSISTENTE DE MIGRAÇÃO DE ELETIVAS LEGADAS (genérico)
// ---------------------------------------------------------------------------
// Legado = disciplina cadastrada como eletiva/IFA/projeto (tipo IFA|ELETIVA|PROJETO,
// modo AGRUPAMENTO, ou nome iniciando em "IFA_"), cujas notas já existem em `notas`.
// A migração NÃO altera notas, NÃO renomeia e NÃO apaga disciplinas: cria o
// agrupamento (1 por semestre com notas), usa a própria disciplina legada como
// componente (as notas continuam apontando para ela) e enturma quem tem nota.
// Semestre: bimestres 1–2 → 1º semestre; bimestres 3–4 → 2º semestre.
// A modulação legada NÃO é copiada (evita contar a carga do professor duas vezes);
// ela é apenas listada no relatório.
// ===========================================================================
const SQL_LEGADOS = `
  (d.tipo IN ('IFA','ELETIVA','PROJETO') OR d.modo_oferta = 'AGRUPAMENTO' OR d.nome LIKE 'IFA\\\\_%')`;

router.get("/migracao/legados", async (req, res) => {
  try {
    const { escola_id } = req.user;
    const ano = anoDe(req);
    const [rows] = await pool.query(
      `SELECT d.id, d.nome, d.abreviatura, d.tipo, d.modo_oferta,
              (SELECT COUNT(*) FROM agrupamentos g
                WHERE g.escola_id = d.escola_id AND g.origem_disciplina_legada_id = d.id AND g.ano_letivo = ?) AS agrupamentos_migrados,
              (SELECT COUNT(DISTINCT n.aluno_id) FROM notas n
                WHERE n.escola_id = d.escola_id AND n.disciplina_id = d.id AND n.ano = ?) AS alunos_com_nota
         FROM disciplinas d
        WHERE d.escola_id = ? AND d.mesclada_em IS NULL AND ${SQL_LEGADOS}
        ORDER BY d.nome`,
      [ano, ano, escola_id]
    );
    const [[{ piloto }]] = await pool.query(
      `SELECT COUNT(*) AS piloto FROM agrupamentos WHERE escola_id = ? AND origem_disciplina_legada_id IS NOT NULL`,
      [escola_id]
    );
    res.json({ ano_letivo: ano, piloto_ja_executado: Number(piloto) > 0, legados: rows });
  } catch (err) {
    responderErro(res, err, "Não foi possível listar as disciplinas legadas.");
  }
});

async function planejarLegado(executor, escola_id, ano, disc) {
  // 1) quem tem nota, por semestre
  const [notas] = await executor.query(
    `SELECT aluno_id, MAX(bimestre <= 2) AS s1, MAX(bimestre >= 3) AS s2
       FROM notas
      WHERE escola_id = ? AND disciplina_id = ? AND ano = ?
      GROUP BY aluno_id`,
    [escola_id, disc.id, ano]
  );

  const alunoIds = notas.map((n) => n.aluno_id);
  let alunosValidos = new Set();
  const matr = new Map();
  if (alunoIds.length) {
    const [al] = await executor.query(
      `SELECT id FROM alunos WHERE escola_id = ? AND id IN (?)`, [escola_id, alunoIds]
    );
    alunosValidos = new Set(al.map((a) => String(a.id)));

    const [ms] = await executor.query(
      `SELECT m.aluno_id, m.id AS matricula_id, m.turma_id, t.nome AS turma_nome, t.turno AS turma_turno
         FROM matriculas m
         JOIN turmas t ON t.id = m.turma_id
        WHERE m.escola_id = ? AND m.ano_letivo = ? AND m.aluno_id IN (?)
        ORDER BY m.id`,
      [escola_id, ano, alunoIds]
    );
    for (const m of ms) matr.set(String(m.aluno_id), m); // última matrícula prevalece
  }

  const semestres = [];
  for (const sem of [1, 2]) {
    const lista = notas
      .filter((n) => Number(sem === 1 ? n.s1 : n.s2) === 1 && alunosValidos.has(String(n.aluno_id)))
      .map((n) => {
        const m = matr.get(String(n.aluno_id));
        return {
          aluno_id: n.aluno_id,
          matricula_id: m?.matricula_id ?? null,
          turma_origem_id: m?.turma_id ?? null,
          turma_nome: m?.turma_nome ?? null,
          turma_turno: m?.turma_turno ?? null,
        };
      });
    if (!lista.length) continue;

    const porTurma = {};
    const porTurno = {};
    for (const a of lista) {
      const k = a.turma_nome || "(sem matrícula no ano)";
      porTurma[k] = (porTurma[k] || 0) + 1;
      if (a.turma_turno) porTurno[a.turma_turno] = (porTurno[a.turma_turno] || 0) + 1;
    }
    const turnosOrd = Object.entries(porTurno).sort((x, y) => y[1] - x[1]);

    const [[jaMigrado]] = await executor.query(
      `SELECT id FROM agrupamentos
        WHERE escola_id = ? AND ano_letivo = ? AND semestre = ? AND origem_disciplina_legada_id = ? LIMIT 1`,
      [escola_id, ano, sem, disc.id]
    );

    semestres.push({
      semestre: sem,
      nome_agrupamento: disc.nome,
      turno: turnosOrd[0]?.[0] || "Integral",
      turno_misto: turnosOrd.length > 1,
      total_alunos: lista.length,
      sem_matricula: lista.filter((a) => !a.matricula_id).length,
      por_turma: porTurma,
      ja_migrado: !!jaMigrado,
      agrupamento_existente_id: jaMigrado?.id || null,
      _alunos: lista,
    });
  }

  const [profs] = await executor.query(
    `SELECT p.nome AS professor, m.semestre, SUM(m.aulas) AS aulas
       FROM modulacao m JOIN professores p ON p.id = m.professor_id
      WHERE m.escola_id = ? AND m.disciplina_id = ?
      GROUP BY p.id, p.nome, m.semestre ORDER BY p.nome, m.semestre`,
    [escola_id, disc.id]
  );

  return { disciplina_id: disc.id, nome: disc.nome, semestres, professores_modulados_legado: profs };
}

const tipoDoLegado = (d) => {
  const t = String(d.tipo || "").toUpperCase();
  if (TIPOS.includes(t) && t !== "OUTRO") return t;
  if (/^IFA_/i.test(d.nome || "")) return "IFA";
  return "OUTRO";
};

router.post("/migracao/executar", exigirGestao, async (req, res) => {
  try {
    const { escola_id } = req.user;
    const ano = anoDe(req, "body");
    const ids = [...new Set((Array.isArray(req.body?.disciplina_ids) ? req.body.disciplina_ids : [])
      .map((v) => toInt(v)).filter(Boolean))];
    if (!ids.length) throw falha(400, "Informe ao menos uma disciplina legada (disciplina_ids).");

    const executar = req.body?.modo === "executar" && req.body?.confirmar === true;

    const [discs] = await pool.query(
      `SELECT d.id, d.nome, d.tipo, d.carga FROM disciplinas d
        WHERE d.escola_id = ? AND d.mesclada_em IS NULL AND d.id IN (?)`,
      [escola_id, ids]
    );
    if (discs.length !== ids.length) throw falha(404, "Alguma disciplina não foi encontrada nesta escola.");

    // --- DRY-RUN (padrão) ---------------------------------------------------
    if (!executar) {
      const plano = [];
      for (const d of discs) {
        const p = await planejarLegado(pool, escola_id, ano, d);
        p.semestres.forEach((s) => delete s._alunos);
        plano.push(p);
      }
      return res.json({ modo: "dry-run", executado: false, ano_letivo: ano, plano });
    }

    // --- Trava de segurança: lote só depois de um piloto --------------------
    if (ids.length > 1) {
      const [[{ n }]] = await pool.query(
        `SELECT COUNT(*) AS n FROM agrupamentos WHERE escola_id = ? AND origem_disciplina_legada_id IS NOT NULL`,
        [escola_id]
      );
      if (Number(n) === 0) {
        throw falha(409, "Execute primeiro um piloto com 1 disciplina e confira o resultado antes de migrar em lote.");
      }
    }

    // --- EXECUÇÃO (1 transação por legado) ---------------------------------
    const resultado = [];
    for (const d of discs) {
      const r = await comTransacao(async (conn) => {
        const p = await planejarLegado(conn, escola_id, ano, d);
        const criados = [];
        for (const s of p.semestres) {
          if (s.ja_migrado) continue;
          const [ins] = await conn.query(
            `INSERT INTO agrupamentos
               (escola_id, ano_letivo, semestre, nome, tipo, turno, status, origem_disciplina_legada_id)
             VALUES (?, ?, ?, ?, ?, ?, 'ABERTO', ?)`,
            [escola_id, ano, s.semestre, s.nome_agrupamento, tipoDoLegado(d), s.turno, d.id]
          );
          const agrId = ins.insertId;
          await conn.query(
            `INSERT INTO agrupamento_componentes (escola_id, agrupamento_id, disciplina_id, carga_semanal)
             VALUES (?, ?, ?, ?)`,
            [escola_id, agrId, d.id, Math.min(Math.max(toInt(d.carga, 1) || 1, 1), 20)]
          );
          await conn.query(
            `INSERT INTO agrupamento_alunos (escola_id, agrupamento_id, aluno_id, matricula_id, turma_origem_id, status)
             VALUES ?`,
            [s._alunos.map((a) => [escola_id, agrId, a.aluno_id, a.matricula_id, a.turma_origem_id, "ativo"])]
          );
          criados.push({ semestre: s.semestre, agrupamento_id: agrId, alunos: s._alunos.length, turno: s.turno, turno_misto: s.turno_misto });
        }
        // Metadado apenas (não renomeia/apaga): marca a disciplina como ofertada em agrupamento.
        await conn.query(
          `UPDATE disciplinas
              SET modo_oferta = 'AGRUPAMENTO',
                  tipo = CASE WHEN tipo = 'REGULAR' AND nome LIKE 'IFA\\\\_%' THEN 'IFA' ELSE tipo END
            WHERE id = ? AND escola_id = ?`,
          [d.id, escola_id]
        );
        return { disciplina_id: d.id, nome: d.nome, criados, ja_migrados: p.semestres.filter((s) => s.ja_migrado).length };
      });
      resultado.push(r);
    }

    res.json({ modo: "executar", executado: true, ano_letivo: ano, resultado });
  } catch (err) {
    responderErro(res, err, "Falha na migração das disciplinas legadas.");
  }
});

// ---------------------------------------------------------------------------
// POST /  → cria agrupamento
// ---------------------------------------------------------------------------
async function validarEtapa(escola_id, etapa_id) {
  if (etapa_id === null || etapa_id === undefined || etapa_id === "") return null;
  const id = toInt(etapa_id);
  if (!id) throw falha(400, "Etapa inválida.");
  const [[e]] = await pool.query(`SELECT id FROM etapas WHERE id = ? AND escola_id = ? LIMIT 1`, [id, escola_id]);
  if (!e) throw falha(400, "Etapa não encontrada nesta escola.");
  return id;
}

function lerCamposAgrupamento(body, parcial = false) {
  const out = {};
  if (!parcial || body.nome !== undefined) {
    const nome = String(body.nome || "").trim();
    if (!nome) throw falha(400, "Informe o nome da turma de agrupamento.");
    if (nome.length > 100) throw falha(400, "Nome muito longo (máx. 100 caracteres).");
    out.nome = nome;
  }
  if (!parcial || body.tipo !== undefined) {
    const tipo = String(body.tipo || "IFA").toUpperCase();
    if (!TIPOS.includes(tipo)) throw falha(400, `Tipo inválido. Use: ${TIPOS.join(", ")}.`);
    out.tipo = tipo;
  }
  if (!parcial || body.turno !== undefined) {
    const turno = normTurno(body.turno);
    if (!turno) throw falha(400, `Turno inválido. Use: ${TURNOS.join(", ")}.`);
    out.turno = turno;
  }
  if (!parcial || body.semestre !== undefined) {
    const sem = toInt(body.semestre, 1);
    if (![0, 1, 2].includes(sem)) throw falha(400, "Semestre inválido (0=anual, 1 ou 2).");
    out.semestre = sem;
  }
  if (body.capacidade !== undefined) {
    if (body.capacidade === null || body.capacidade === "") out.capacidade = null;
    else {
      const c = toInt(body.capacidade);
      if (!c || c < 1 || c > 500) throw falha(400, "Capacidade inválida (1 a 500).");
      out.capacidade = c;
    }
  }
  if (body.status !== undefined) {
    const st = String(body.status).toUpperCase();
    if (!STATUS.includes(st)) throw falha(400, `Status inválido. Use: ${STATUS.join(", ")}.`);
    out.status = st;
  }
  return out;
}

router.post("/", exigirGestao, async (req, res) => {
  try {
    const { escola_id } = req.user;
    const ano = anoDe(req, "body");
    const c = lerCamposAgrupamento(req.body || {});
    const etapa_id = await validarEtapa(escola_id, req.body?.etapa_id);

    const [ins] = await pool.query(
      `INSERT INTO agrupamentos (escola_id, ano_letivo, semestre, nome, tipo, etapa_id, turno, capacidade, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [escola_id, ano, c.semestre, c.nome, c.tipo, etapa_id, c.turno, c.capacidade ?? null, c.status || "ABERTO"]
    );
    res.status(201).json(await buscarAgrupamento(escola_id, ins.insertId));
  } catch (err) {
    if (err?.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ message: "Já existe uma turma de agrupamento com este nome, turno e semestre." });
    }
    responderErro(res, err, "Não foi possível criar a turma de agrupamento.");
  }
});

// ---------------------------------------------------------------------------
// GET /:id  → detalhe (componentes com professores)
// ---------------------------------------------------------------------------
router.get("/:id", async (req, res) => {
  try {
    const agr = await exigirAgrupamento(req);
    const [componentes] = await pool.query(
      `SELECT c.id, c.disciplina_id, d.nome AS disciplina_nome, d.abreviatura, c.carga_semanal
         FROM agrupamento_componentes c
         JOIN disciplinas d ON d.id = c.disciplina_id
        WHERE c.agrupamento_id = ? ORDER BY d.nome`,
      [agr.id]
    );
    const [mods] = await pool.query(
      `SELECT m.id, m.disciplina_id, m.professor_id, p.nome AS professor_nome, m.aulas
         FROM agrupamento_modulacao m JOIN professores p ON p.id = m.professor_id
        WHERE m.agrupamento_id = ? ORDER BY p.nome`,
      [agr.id]
    );
    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total FROM agrupamento_alunos WHERE agrupamento_id = ? AND status = 'ativo'`,
      [agr.id]
    );
    res.json({
      ...agr,
      total_alunos: Number(total),
      componentes: componentes.map((c) => ({ ...c, professores: mods.filter((m) => m.disciplina_id === c.disciplina_id) })),
    });
  } catch (err) {
    responderErro(res, err, "Não foi possível carregar a turma de agrupamento.");
  }
});

// ---------------------------------------------------------------------------
// PUT /:id
// ---------------------------------------------------------------------------
router.put("/:id", exigirGestao, async (req, res) => {
  try {
    const { escola_id } = req.user;
    const agr = await exigirAgrupamento(req);
    const c = lerCamposAgrupamento(req.body || {}, true);
    if (req.body?.etapa_id !== undefined) c.etapa_id = await validarEtapa(escola_id, req.body.etapa_id);

    if (c.capacidade !== undefined && c.capacidade !== null) {
      const [[{ n }]] = await pool.query(
        `SELECT COUNT(*) AS n FROM agrupamento_alunos WHERE agrupamento_id = ? AND status = 'ativo'`, [agr.id]
      );
      if (Number(n) > c.capacidade) {
        throw falha(409, `Capacidade menor que o número de alunos enturmados (${n}).`);
      }
    }

    const campos = Object.keys(c);
    if (!campos.length) throw falha(400, "Nada para atualizar.");
    await pool.query(
      `UPDATE agrupamentos SET ${campos.map((k) => `${k} = ?`).join(", ")} WHERE id = ? AND escola_id = ?`,
      [...campos.map((k) => c[k]), agr.id, escola_id]
    );
    res.json(await buscarAgrupamento(escola_id, agr.id));
  } catch (err) {
    if (err?.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ message: "Já existe uma turma de agrupamento com este nome, turno e semestre." });
    }
    responderErro(res, err, "Não foi possível atualizar a turma de agrupamento.");
  }
});

// ---------------------------------------------------------------------------
// DELETE /:id  (bloqueia se houver alunos/modulação, salvo ?forcar=1)
// ---------------------------------------------------------------------------
router.delete("/:id", exigirGestao, async (req, res) => {
  try {
    const { escola_id } = req.user;
    const agr = await exigirAgrupamento(req);
    const forcar = String(req.query.forcar || "") === "1";

    const [[{ alunos }]] = await pool.query(
      `SELECT COUNT(*) AS alunos FROM agrupamento_alunos WHERE agrupamento_id = ? AND status = 'ativo'`, [agr.id]
    );
    const [[{ mods }]] = await pool.query(
      `SELECT COUNT(*) AS mods FROM agrupamento_modulacao WHERE agrupamento_id = ?`, [agr.id]
    );
    if ((Number(alunos) > 0 || Number(mods) > 0) && !forcar) {
      throw falha(409, `Esta turma possui ${alunos} aluno(s) enturmado(s) e ${mods} professor(es) modulado(s). Confirme a exclusão para removê-los do agrupamento.`, { alunos: Number(alunos), modulacoes: Number(mods) });
    }
    await pool.query(`DELETE FROM agrupamentos WHERE id = ? AND escola_id = ?`, [agr.id, escola_id]);
    res.json({ message: "Turma de agrupamento excluída." });
  } catch (err) {
    responderErro(res, err, "Não foi possível excluir a turma de agrupamento.");
  }
});

// ===========================================================================
// COMPONENTES (cadastrados pela própria escola)
// ===========================================================================
const cargaSemanal = (v) => {
  const n = toInt(v, 1);
  if (!n || n < 1 || n > 20) throw falha(400, "Carga semanal inválida (1 a 20 aulas).");
  return n;
};

router.post("/:id/componentes", exigirGestao, async (req, res) => {
  try {
    const { escola_id } = req.user;
    const agr = await exigirAgrupamento(req);
    if (agr.status === "ENCERRADO") throw falha(409, "Turma encerrada: não é possível alterar componentes.");
    const carga = cargaSemanal(req.body?.carga_semanal);

    const out = await comTransacao(async (conn) => {
      let disciplinaId = toInt(req.body?.disciplina_id);
      let criada = false;

      if (disciplinaId) {
        const [[d]] = await conn.query(
          `SELECT id FROM disciplinas WHERE id = ? AND escola_id = ? AND mesclada_em IS NULL LIMIT 1`,
          [disciplinaId, escola_id]
        );
        if (!d) throw falha(404, "Disciplina não encontrada nesta escola.");
      } else {
        const nome = String(req.body?.nome || "").trim();
        if (!nome) throw falha(400, "Informe disciplina_id ou o nome do novo componente.");
        if (nome.length > 100) throw falha(400, "Nome muito longo (máx. 100 caracteres).");

        const [[ex]] = await conn.query(
          `SELECT id FROM disciplinas
            WHERE LOWER(TRIM(nome)) = LOWER(?) AND escola_id = ? AND mesclada_em IS NULL LIMIT 1`,
          [nome, escola_id]
        );
        if (ex) {
          disciplinaId = ex.id;
        } else {
          const abrev = typeof req.body?.abreviatura === "string" && req.body.abreviatura.trim()
            ? req.body.abreviatura.trim().toUpperCase().slice(0, 20) : null;
          const etapaTxt = agr.etapa_nome ? String(agr.etapa_nome).toUpperCase() : "GERAL";
          const [ins] = await conn.query(
            `INSERT INTO disciplinas (nome, abreviatura, tipo, modo_oferta, etapa, turno, carga, escola_id, created_at, updated_at)
             VALUES (?, ?, ?, 'AGRUPAMENTO', ?, 'INTEGRAL', ?, ?, NOW(), NOW())`,
            [nome, abrev, agr.tipo === "OUTRO" ? "PROJETO" : agr.tipo, etapaTxt, carga, escola_id]
          );
          disciplinaId = ins.insertId;
          criada = true;
        }
      }

      const [ins2] = await conn.query(
        `INSERT INTO agrupamento_componentes (escola_id, agrupamento_id, disciplina_id, carga_semanal)
         VALUES (?, ?, ?, ?)`,
        [escola_id, agr.id, disciplinaId, carga]
      );
      return { id: ins2.insertId, disciplina_id: disciplinaId, carga_semanal: carga, disciplina_criada: criada };
    });
    res.status(201).json(out);
  } catch (err) {
    if (err?.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ message: "Este componente já faz parte da turma de agrupamento." });
    }
    responderErro(res, err, "Não foi possível adicionar o componente.");
  }
});

router.put("/:id/componentes/:compId", exigirGestao, async (req, res) => {
  try {
    const { escola_id } = req.user;
    const agr = await exigirAgrupamento(req);
    const compId = toInt(req.params.compId);
    const carga = cargaSemanal(req.body?.carga_semanal);
    const [r] = await pool.query(
      `UPDATE agrupamento_componentes SET carga_semanal = ? WHERE id = ? AND agrupamento_id = ? AND escola_id = ?`,
      [carga, compId, agr.id, escola_id]
    );
    if (!r.affectedRows) throw falha(404, "Componente não encontrado.");
    res.json({ message: "Componente atualizado.", carga_semanal: carga });
  } catch (err) {
    responderErro(res, err, "Não foi possível atualizar o componente.");
  }
});

router.delete("/:id/componentes/:compId", exigirGestao, async (req, res) => {
  try {
    const { escola_id } = req.user;
    const agr = await exigirAgrupamento(req);
    const compId = toInt(req.params.compId);
    const forcar = String(req.query.forcar || "") === "1";

    const [[comp]] = await pool.query(
      `SELECT id, disciplina_id FROM agrupamento_componentes WHERE id = ? AND agrupamento_id = ? AND escola_id = ?`,
      [compId, agr.id, escola_id]
    );
    if (!comp) throw falha(404, "Componente não encontrado.");

    const [[{ n }]] = await pool.query(
      `SELECT COUNT(*) AS n FROM agrupamento_modulacao WHERE agrupamento_id = ? AND disciplina_id = ?`,
      [agr.id, comp.disciplina_id]
    );
    if (Number(n) > 0 && !forcar) {
      throw falha(409, `Há ${n} professor(es) modulado(s) neste componente. Confirme para removê-los junto.`, { modulacoes: Number(n) });
    }
    await pool.query(`DELETE FROM agrupamento_componentes WHERE id = ? AND escola_id = ?`, [comp.id, escola_id]);
    res.json({ message: "Componente removido." });
  } catch (err) {
    responderErro(res, err, "Não foi possível remover o componente.");
  }
});

// ===========================================================================
// MODULAÇÃO DOS PROFESSORES DO AGRUPAMENTO
// ===========================================================================
router.get("/:id/modulacao", async (req, res) => {
  try {
    const agr = await exigirAgrupamento(req);
    const [rows] = await pool.query(
      `SELECT m.id, m.professor_id, p.nome AS professor_nome, m.disciplina_id, d.nome AS disciplina_nome, m.aulas
         FROM agrupamento_modulacao m
         JOIN professores p ON p.id = m.professor_id
         JOIN disciplinas d ON d.id = m.disciplina_id
        WHERE m.agrupamento_id = ? ORDER BY d.nome, p.nome`,
      [agr.id]
    );
    res.json(rows);
  } catch (err) {
    responderErro(res, err, "Não foi possível carregar a modulação.");
  }
});

router.post("/:id/modulacao", exigirGestao, async (req, res) => {
  try {
    const { escola_id } = req.user;
    const agr = await exigirAgrupamento(req);
    if (agr.status === "ENCERRADO") throw falha(409, "Turma encerrada: não é possível alterar a modulação.");

    const professorId = toInt(req.body?.professor_id);
    const disciplinaId = toInt(req.body?.disciplina_id);
    const aulas = toInt(req.body?.aulas);
    if (!professorId || !disciplinaId) throw falha(400, "Informe professor_id e disciplina_id.");
    if (!aulas || aulas < 1 || aulas > 40) throw falha(400, "Número de aulas inválido (1 a 40).");

    const [[prof]] = await pool.query(
      `SELECT id FROM professores WHERE id = ? AND escola_id = ? AND (status = 'ativo' OR status IS NULL) LIMIT 1`,
      [professorId, escola_id]
    );
    if (!prof) throw falha(404, "Professor não encontrado (ou inativo) nesta escola.");

    const [[comp]] = await pool.query(
      `SELECT id FROM agrupamento_componentes WHERE agrupamento_id = ? AND disciplina_id = ? LIMIT 1`,
      [agr.id, disciplinaId]
    );
    if (!comp) throw falha(400, "Esta disciplina não é um componente da turma de agrupamento.");

    await pool.query(
      `INSERT INTO agrupamento_modulacao (escola_id, agrupamento_id, professor_id, disciplina_id, aulas)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE aulas = VALUES(aulas)`,
      [escola_id, agr.id, professorId, disciplinaId, aulas]
    );
    res.status(201).json({ message: "Modulação salva.", professor_id: professorId, disciplina_id: disciplinaId, aulas });
  } catch (err) {
    responderErro(res, err, "Não foi possível salvar a modulação.");
  }
});

router.delete("/:id/modulacao/:modId", exigirGestao, async (req, res) => {
  try {
    const { escola_id } = req.user;
    const agr = await exigirAgrupamento(req);
    const [r] = await pool.query(
      `DELETE FROM agrupamento_modulacao WHERE id = ? AND agrupamento_id = ? AND escola_id = ?`,
      [toInt(req.params.modId), agr.id, escola_id]
    );
    if (!r.affectedRows) throw falha(404, "Modulação não encontrada.");
    res.json({ message: "Modulação removida." });
  } catch (err) {
    responderErro(res, err, "Não foi possível remover a modulação.");
  }
});

// ===========================================================================
// ENTURMAÇÃO (alunos)
// ===========================================================================
router.get("/:id/alunos", async (req, res) => {
  try {
    const { escola_id } = req.user;
    const agr = await exigirAgrupamento(req);
    const todos = String(req.query.todos || "") === "1";
    const [rows] = await pool.query(
      `SELECT aa.id, aa.aluno_id, a.estudante AS nome, a.codigo AS matricula,
              aa.turma_origem_id, t.nome AS turma_origem, aa.status, aa.entrada_em, aa.saida_em
         FROM agrupamento_alunos aa
         JOIN alunos a ON a.id = aa.aluno_id
         LEFT JOIN turmas t ON t.id = aa.turma_origem_id
        WHERE aa.agrupamento_id = ? AND aa.escola_id = ? ${todos ? "" : "AND aa.status = 'ativo'"}
        ORDER BY t.nome, a.estudante`,
      [agr.id, escola_id]
    );
    res.json(rows);
  } catch (err) {
    responderErro(res, err, "Não foi possível carregar os alunos enturmados.");
  }
});

// Candidatos: alunos com matrícula ativa no ano, ainda não enturmados neste agrupamento.
router.get("/:id/candidatos", async (req, res) => {
  try {
    const { escola_id } = req.user;
    const agr = await exigirAgrupamento(req);
    const turmaId = toInt(req.query.turma_id);
    const q = String(req.query.q || "").trim();
    const limite = Math.min(Math.max(toInt(req.query.limite, 50) || 50, 1), 200);

    let sql = `
      SELECT a.id, a.estudante AS nome, a.codigo AS matricula,
             m.id AS matricula_id, m.turma_id, t.nome AS turma_nome, t.turno AS turma_turno,
             (SELECT COUNT(*) FROM agrupamento_alunos x
                JOIN agrupamentos gx ON gx.id = x.agrupamento_id
               WHERE x.aluno_id = a.id AND x.status = 'ativo' AND gx.escola_id = ?
                 AND gx.ano_letivo = ? AND gx.id <> ?
                 AND (gx.semestre = 0 OR ? = 0 OR gx.semestre = ?)) AS outros_agrupamentos
        FROM matriculas m
        JOIN alunos a ON a.id = m.aluno_id
        JOIN turmas t ON t.id = m.turma_id
       WHERE m.escola_id = ? AND m.ano_letivo = ? AND m.status IN ('ativo','matriculado')
         AND (a.status = 'ativo' OR a.status IS NULL)
         AND NOT EXISTS (SELECT 1 FROM agrupamento_alunos y
                          WHERE y.agrupamento_id = ? AND y.aluno_id = a.id AND y.status = 'ativo')`;
    const params = [escola_id, agr.ano_letivo, agr.id, agr.semestre, agr.semestre, escola_id, agr.ano_letivo, agr.id];

    if (turmaId) { sql += " AND m.turma_id = ?"; params.push(turmaId); }
    if (q) {
      sql += " AND (a.estudante LIKE ? OR a.codigo = ?)";
      params.push(`%${q}%`, toInt(q, -1));
    }
    sql += " ORDER BY t.nome, a.estudante LIMIT ?";
    params.push(limite);

    const [rows] = await pool.query(sql, params);
    res.json(rows);
  } catch (err) {
    responderErro(res, err, "Não foi possível buscar os alunos.");
  }
});

router.post("/:id/alunos", exigirGestao, async (req, res) => {
  try {
    const { escola_id } = req.user;
    const agr = await exigirAgrupamento(req);
    if (agr.status === "ENCERRADO") throw falha(409, "Turma encerrada: não é possível enturmar.");

    const ids = [...new Set((Array.isArray(req.body?.aluno_ids) ? req.body.aluno_ids : [])
      .map((v) => toInt(v)).filter(Boolean))];
    if (!ids.length) throw falha(400, "Selecione ao menos um aluno.");
    if (ids.length > 500) throw falha(400, "Máximo de 500 alunos por operação.");
    const confirmar = req.body?.confirmar === true;

    // 1) matrícula ativa no ano (turma de origem)
    const [ms] = await pool.query(
      `SELECT m.aluno_id, m.id AS matricula_id, m.turma_id, a.estudante AS nome
         FROM matriculas m JOIN alunos a ON a.id = m.aluno_id
        WHERE m.escola_id = ? AND m.ano_letivo = ? AND m.status IN ('ativo','matriculado')
          AND (a.status = 'ativo' OR a.status IS NULL) AND m.aluno_id IN (?)
        ORDER BY m.id`,
      [escola_id, agr.ano_letivo, ids]
    );
    const matr = new Map(ms.map((m) => [String(m.aluno_id), m]));
    const rejeitados = ids.filter((i) => !matr.has(String(i)))
      .map((i) => ({ aluno_id: i, motivo: "Sem matrícula ativa no ano letivo desta turma." }));
    const elegiveis = ids.filter((i) => matr.has(String(i)));
    if (!elegiveis.length) throw falha(400, "Nenhum aluno elegível.", { rejeitados });

    // 2) já enturmados neste agrupamento
    const [ja] = await pool.query(
      `SELECT aluno_id FROM agrupamento_alunos WHERE agrupamento_id = ? AND status = 'ativo' AND aluno_id IN (?)`,
      [agr.id, elegiveis]
    );
    const jaSet = new Set(ja.map((r) => String(r.aluno_id)));
    const novos = elegiveis.filter((i) => !jaSet.has(String(i)));

    // 3) capacidade
    if (agr.capacidade) {
      const [[{ n }]] = await pool.query(
        `SELECT COUNT(*) AS n FROM agrupamento_alunos WHERE agrupamento_id = ? AND status = 'ativo'`, [agr.id]
      );
      const vagas = agr.capacidade - Number(n);
      if (novos.length > vagas) {
        throw falha(409, `Sem vagas suficientes: restam ${Math.max(vagas, 0)} vaga(s) e foram selecionados ${novos.length} aluno(s).`, { vagas: Math.max(vagas, 0) });
      }
    }

    // 4) alerta: já enturmados em outro agrupamento no mesmo período
    if (novos.length && !confirmar) {
      const [conf] = await pool.query(
        `SELECT x.aluno_id, gx.id AS agrupamento_id, gx.nome AS agrupamento, gx.semestre, gx.turno
           FROM agrupamento_alunos x
           JOIN agrupamentos gx ON gx.id = x.agrupamento_id
          WHERE x.status = 'ativo' AND gx.escola_id = ? AND gx.ano_letivo = ? AND gx.id <> ?
            AND x.aluno_id IN (?)`,
        [escola_id, agr.ano_letivo, agr.id, novos]
      );
      const porAluno = {};
      for (const c of conf) {
        if (!semestresSobrepoem(Number(c.semestre), agr.semestre)) continue;
        (porAluno[c.aluno_id] ||= []).push({ agrupamento_id: c.agrupamento_id, nome: c.agrupamento, turno: c.turno, semestre: c.semestre });
      }
      const conflitos = Object.entries(porAluno).map(([alunoId, agrs]) => ({
        aluno_id: Number(alunoId), nome: matr.get(String(alunoId))?.nome, agrupamentos: agrs,
        mesmo_turno: agrs.some((a) => a.turno === agr.turno),
      }));
      if (conflitos.length) {
        throw falha(409, "Alguns alunos já estão enturmados em outra turma de agrupamento no mesmo período. Confirme para continuar.", { requer_confirmacao: true, conflitos });
      }
    }

    // 5) grava (reativa se já houve saída)
    if (novos.length) {
      await pool.query(
        `INSERT INTO agrupamento_alunos
           (escola_id, agrupamento_id, aluno_id, matricula_id, turma_origem_id, status, entrada_em)
         VALUES ?
         ON DUPLICATE KEY UPDATE status = 'ativo', saida_em = NULL,
           matricula_id = VALUES(matricula_id), turma_origem_id = VALUES(turma_origem_id), entrada_em = CURDATE()`,
        [novos.map((i) => {
          const m = matr.get(String(i));
          return [escola_id, agr.id, i, m.matricula_id, m.turma_id, "ativo", new Date().toISOString().slice(0, 10)];
        })]
      );
    }

    res.status(201).json({ adicionados: novos.length, ja_enturmados: jaSet.size, rejeitados });
  } catch (err) {
    responderErro(res, err, "Não foi possível enturmar os alunos.");
  }
});

// Saída do agrupamento = inativação (preserva histórico; não apaga).
router.post("/:id/alunos/remover", exigirGestao, async (req, res) => {
  try {
    const { escola_id } = req.user;
    const agr = await exigirAgrupamento(req);
    const ids = [...new Set((Array.isArray(req.body?.aluno_ids) ? req.body.aluno_ids : [])
      .map((v) => toInt(v)).filter(Boolean))];
    if (!ids.length) throw falha(400, "Selecione ao menos um aluno.");
    const [r] = await pool.query(
      `UPDATE agrupamento_alunos SET status = 'inativo', saida_em = CURDATE()
        WHERE agrupamento_id = ? AND escola_id = ? AND status = 'ativo' AND aluno_id IN (?)`,
      [agr.id, escola_id, ids]
    );
    res.json({ removidos: r.affectedRows });
  } catch (err) {
    responderErro(res, err, "Não foi possível remover os alunos.");
  }
});

export default router;
