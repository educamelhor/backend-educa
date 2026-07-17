// routes/notas.js
// ============================================================================
// Rotas de NOTAS
// - GET /alunos/:id/notas                   → lista notas do aluno (todas, 2024+2025)
// - GET /alunos/:alunoId/ranking            → ranking (ESCOLA) do aluno (apenas 2025)
// - GET /alunos/:alunoId/ranking-completo   → ranking ESCOLA + TURMA (apenas 2025)
// Regras solicitadas:
//   • O RANKING deve considerar SOMENTE 2025.
//   • A soma de notas no front continua usando todas as notas (nenhuma mudança aqui).
// ============================================================================

import express from "express";
import db from "../db.js";

const router = express.Router();

// Ano-base do ranking
const ANO_RANKING = 2025;

// ---------------------------------------------------------------------------
// Middleware anti-cache (evita 304 e "Calculando..." no front)
// Aplica-se a TODAS as rotas deste router.
// ---------------------------------------------------------------------------
router.use((req, res, next) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  res.set("Surrogate-Control", "no-store");
  if (typeof res.removeHeader === "function") res.removeHeader("ETag");
  next();
});

// ---------------------------------------------------------------------------
// Middleware: exige que req.user.escola_id exista (mantido para compatibilidade)
// Usado apenas na LISTAGEM de notas (não no ranking).
// ---------------------------------------------------------------------------
function verificarEscola(req, res, next) {
  if (!req.user || !req.user.escola_id) {
    return res.status(403).json({ message: "Acesso negado: escola não definida." });
  }
  next();
}

// ---------------------------------------------------------------------------
// GET /alunos/:id/notas
// Lista notas do aluno, apenas se ele pertencer à escola do usuário
// (RETORNA TODAS AS NOTAS – 2024 e 2025 – para manter a soma no rodapé)
// ---------------------------------------------------------------------------
router.get("/alunos/:id/notas", verificarEscola, async (req, res) => {
  try {
    const alunoId = req.params.id;
    const { escola_id } = req.user;

    const [rows] = await db.query(
      `SELECT 
         d.nome      AS disciplina,
         n.disciplina_id,
         n.ano,
         n.bimestre,
         n.nota,
         n.faltas,
         n.aluno_id
       FROM notas n
       LEFT JOIN disciplinas d ON d.id = n.disciplina_id
       LEFT JOIN alunos a ON a.id = n.aluno_id
       WHERE n.aluno_id = ? AND a.escola_id = ?
       ORDER BY n.ano, n.bimestre, d.nome`,
      [alunoId, escola_id]
    );

    return res.status(200).json(rows);
  } catch (err) {
    console.warn("Notas não encontradas ou erro:", err?.code, err?.message);
    return res.status(200).json([]);
  }
});

// ---------------------------------------------------------------------------
// GET /alunos/:alunoId/ranking
// Ranking do aluno em relação aos demais da ESCOLA (APENAS 2025)
// • Mantido para compatibilidade (Boletim.jsx usa este formato simples).
// ---------------------------------------------------------------------------
router.get("/alunos/:alunoId/ranking", async (req, res) => {
  const alunoId = req.params.alunoId;

  try {
    // 1) Descobrir a escola do aluno
    const [alunoRes] = await db.query(
      "SELECT escola_id FROM alunos WHERE id = ?",
      [alunoId]
    );
    if (!alunoRes.length) {
      return res.status(200).json({ ranking: null, total_alunos: 0, total_notas: 0 });
    }
    const escola_id = alunoRes[0].escola_id;

    // 2) Calcular ranking (somente 2025)
    const [result] = await db.query(
      `
      SELECT
          t1.aluno_id,
          t1.total_notas,
          (
              SELECT COUNT(*) + 1
              FROM (
                  SELECT a.id AS aluno_id, SUM(n.nota) AS soma
                  FROM notas n
                  JOIN alunos a ON a.id = n.aluno_id
                  WHERE n.ano = ? AND a.escola_id = ?
                  GROUP BY a.id
              ) t2
              WHERE t2.soma > t1.total_notas
          ) AS ranking,
          (
              SELECT COUNT(DISTINCT a.id)
              FROM notas n
              JOIN alunos a ON a.id = n.aluno_id
              WHERE n.ano = ? AND a.escola_id = ?
          ) AS total_alunos
      FROM (
          SELECT a.id AS aluno_id, SUM(n.nota) AS total_notas
          FROM notas n
          JOIN alunos a ON a.id = n.aluno_id
          WHERE n.ano = ? AND a.escola_id = ?
          GROUP BY a.id
      ) t1
      WHERE t1.aluno_id = ?
      `,
      [
        ANO_RANKING, escola_id,     // quem está à frente
        ANO_RANKING, escola_id,     // total participantes (com notas 2025)
        ANO_RANKING, escola_id,     // soma do próprio aluno (2025)
        alunoId
      ]
    );

    if (result.length === 0) {
      return res.status(200).json({ ranking: null, total_alunos: 0, total_notas: 0 });
    }

    return res.json({
      ranking: result[0].ranking,
      total_alunos: result[0].total_alunos,
      total_notas: result[0].total_notas
    });
  } catch (err) {
    console.error("Erro ao calcular ranking:", err);
    return res.status(500).json({ ranking: null, total_alunos: 0, total_notas: 0 });
  }
});

// ---------------------------------------------------------------------------
// GET /alunos/:alunoId/ranking-completo
// Ranking do aluno por ESCOLA e TURMA (APENAS 2025)
// • Formato compatível com o fluxo de impressão/BoletimPrint:
//   { escola: { ranking, total_alunos, semNotas }, turma: { ... } }
// ---------------------------------------------------------------------------
router.get("/alunos/:alunoId/ranking-completo", async (req, res) => {
  const alunoId = req.params.alunoId;

  try {
    // 1) Escola e turma do aluno
    const [alRes] = await db.query(
      "SELECT escola_id, turma_id FROM alunos WHERE id = ?",
      [alunoId]
    );
    if (!alRes.length) {
      return res.status(200).json({
        escola: { ranking: 0, total_alunos: 0, semNotas: true },
        turma:  { ranking: 0, total_alunos: 0, semNotas: true }
      });
    }
    const { escola_id, turma_id } = alRes[0];

    // 2) Soma 2025 do aluno (se não tiver, ele não entra no ranking)
    const [somaRes] = await db.query(
      "SELECT SUM(n.nota) AS soma FROM notas n WHERE n.aluno_id = ? AND n.ano = ?",
      [alunoId, ANO_RANKING]
    );
    const soma2025 = somaRes[0]?.soma;

    // 3) Totais de participantes (com notas 2025)
    const [[{ total: totalEscola }]] = await db.query(
      `
      SELECT COUNT(*) AS total FROM (
        SELECT a.id, SUM(n.nota) AS soma_notas
        FROM alunos a
        JOIN notas n ON n.aluno_id = a.id
        WHERE a.escola_id = ? AND n.ano = ?
        GROUP BY a.id
        HAVING soma_notas IS NOT NULL
      ) x
      `,
      [escola_id, ANO_RANKING]
    );
    const [[{ total: totalTurma }]] = await db.query(
      `
      SELECT COUNT(*) AS total FROM (
        SELECT a.id, SUM(n.nota) AS soma_notas
        FROM alunos a
        JOIN notas n ON n.aluno_id = a.id
        WHERE a.turma_id = ? AND n.ano = ?
        GROUP BY a.id
        HAVING soma_notas IS NOT NULL
      ) x
      `,
      [turma_id, ANO_RANKING]
    );

    // 4) Se o aluno não tem notas 2025, marcar semNotas
    if (!soma2025) {
      return res.json({
        escola: { ranking: totalEscola || 0, total_alunos: totalEscola || 0, semNotas: true },
        turma:  { ranking: totalTurma  || 0, total_alunos: totalTurma  || 0, semNotas: true }
      });
    }

    // 5) Posições (conta quantos têm soma maior + 1)
    const [[{ posicao: posEscola }]] = await db.query(
      `
      SELECT COUNT(*) + 1 AS posicao
      FROM (
        SELECT a.id, SUM(n.nota) AS soma_notas
        FROM alunos a
        JOIN notas n ON n.aluno_id = a.id
        WHERE a.escola_id = ? AND n.ano = ?
        GROUP BY a.id
        HAVING soma_notas IS NOT NULL
      ) r
      WHERE r.soma_notas > (
        SELECT SUM(n2.nota) FROM notas n2 WHERE n2.aluno_id = ? AND n2.ano = ?
      )
      `,
      [escola_id, ANO_RANKING, alunoId, ANO_RANKING]
    );

    const [[{ posicao: posTurma }]] = await db.query(
      `
      SELECT COUNT(*) + 1 AS posicao
      FROM (
        SELECT a.id, SUM(n.nota) AS soma_notas
        FROM alunos a
        JOIN notas n ON n.aluno_id = a.id
        WHERE a.turma_id = ? AND n.ano = ?
        GROUP BY a.id
        HAVING soma_notas IS NOT NULL
      ) r
      WHERE r.soma_notas > (
        SELECT SUM(n2.nota) FROM notas n2 WHERE n2.aluno_id = ? AND n2.ano = ?
      )
      `,
      [turma_id, ANO_RANKING, alunoId, ANO_RANKING]
    );

    return res.json({
      escola: { ranking: posEscola || 1, total_alunos: totalEscola || 0, semNotas: false },
      turma:  { ranking: posTurma  || 1, total_alunos: totalTurma  || 0, semNotas: false }
    });
  } catch (err) {
    console.error("Erro ao calcular ranking-completo:", err);
    return res.status(500).json({
      escola: { ranking: 0, total_alunos: 0, semNotas: true },
      turma:  { ranking: 0, total_alunos: 0, semNotas: true }
    });
  }
});

// ---------------------------------------------------------------------------
// GET /alunos/:alunoId/ranking-anual
// Ranking expandido para o Boletim Anual (ano letivo único):
//   → Escola, Turma, Série e Turno (APENAS ano corrente)
// Formato:
//   { escola: {...}, turma: {...}, serie: {...}, turno: {...} }
// ---------------------------------------------------------------------------
router.get("/alunos/:alunoId/ranking-anual", async (req, res) => {
  const alunoId = req.params.alunoId;
  const anoRef = Number(req.query.ano) || ANO_RANKING;

  const semNotasObj = { ranking: 0, total_alunos: 0, semNotas: true };
  const emptyRes = { escola: semNotasObj, turma: semNotasObj, serie: semNotasObj, turno: semNotasObj };

  try {
    // 1) Dados do aluno: escola_id, turma_id + serie e turno via turmas
    const [alRes] = await db.query(
      `SELECT a.escola_id, a.turma_id, t.serie, t.turno
       FROM alunos a
       LEFT JOIN turmas t ON t.id = a.turma_id
       WHERE a.id = ?`,
      [alunoId]
    );
    if (!alRes.length) return res.json(emptyRes);

    const { escola_id, turma_id, serie, turno } = alRes[0];

    // 2) Soma do aluno no ano
    const [somaRes] = await db.query(
      "SELECT SUM(n.nota) AS soma FROM notas n WHERE n.aluno_id = ? AND n.ano = ?",
      [alunoId, anoRef]
    );
    const somaAluno = somaRes[0]?.soma;

    // Helper: calcula ranking em um escopo (WHERE clause fragment)
    async function calcRanking(whereClause, params) {
      // Total de participantes
      const [[{ total }]] = await db.query(
        `SELECT COUNT(*) AS total FROM (
          SELECT a2.id, SUM(n2.nota) AS soma_notas
          FROM alunos a2
          JOIN notas n2 ON n2.aluno_id = a2.id
          LEFT JOIN turmas t2 ON t2.id = a2.turma_id
          WHERE n2.ano = ? ${whereClause}
          GROUP BY a2.id
          HAVING soma_notas IS NOT NULL
        ) x`,
        [anoRef, ...params]
      );

      if (!somaAluno) {
        return { ranking: total || 0, total_alunos: total || 0, semNotas: true };
      }

      // Posição
      const [[{ posicao }]] = await db.query(
        `SELECT COUNT(*) + 1 AS posicao FROM (
          SELECT a2.id, SUM(n2.nota) AS soma_notas
          FROM alunos a2
          JOIN notas n2 ON n2.aluno_id = a2.id
          LEFT JOIN turmas t2 ON t2.id = a2.turma_id
          WHERE n2.ano = ? ${whereClause}
          GROUP BY a2.id
          HAVING soma_notas IS NOT NULL
        ) r
        WHERE r.soma_notas > (
          SELECT SUM(n3.nota) FROM notas n3 WHERE n3.aluno_id = ? AND n3.ano = ?
        )`,
        [anoRef, ...params, alunoId, anoRef]
      );

      return { ranking: posicao || 1, total_alunos: total || 0, semNotas: false };
    }

    // 3) Calcular os 4 rankings
    const [rkEscola, rkTurma, rkSerie, rkTurno] = await Promise.all([
      calcRanking("AND a2.escola_id = ?", [escola_id]),
      calcRanking("AND a2.turma_id = ?", [turma_id]),
      serie
        ? calcRanking("AND a2.escola_id = ? AND t2.serie = ?", [escola_id, serie])
        : Promise.resolve(semNotasObj),
      turno
        ? calcRanking("AND a2.escola_id = ? AND t2.turno = ?", [escola_id, turno])
        : Promise.resolve(semNotasObj),
    ]);

    return res.json({
      escola: rkEscola,
      turma: rkTurma,
      serie: rkSerie,
      turno: rkTurno,
    });
  } catch (err) {
    console.error("Erro ao calcular ranking-anual:", err);
    return res.status(500).json(emptyRes);
  }
});

// ---------------------------------------------------------------------------
// GET /turmas/:turmaId/mapa-nota?bimestre=2&ano=2026
// Retorna o mapa de notas de todos os alunos da turma por disciplina.
// Também retorna os flags de "não destaque" (amarelo) do professor logado.
// ---------------------------------------------------------------------------
router.get("/turmas/:turmaId/mapa-nota", verificarEscola, async (req, res) => {
  try {
    const escola_id = req.user?.escola_id;
    // JWT usa 'usuario_id' (vários aliases por compatibilidade)
    const usuario_id =
      req.user?.usuario_id ||
      req.user?.usuarioId ||
      req.user?.id ||
      req.user?.user_id ||
      req.user?.id_usuario;
    const { turmaId } = req.params;
    const bimestre = parseInt(req.query.bimestre) || 1;
    const ano = parseInt(req.query.ano) || new Date().getFullYear();

    console.log(`[mapa-nota] usuario_id=${usuario_id}, escola_id=${escola_id}, turmaId=${turmaId}, bimestre=${bimestre}, ano=${ano}`);

    // 1) Alunos matriculados na turma (ordenados por nome)
    const [alunos] = await db.query(
      `SELECT DISTINCT a.id, a.estudante AS nome, a.codigo
       FROM matriculas m
       JOIN alunos a ON a.id = m.aluno_id
       WHERE m.turma_id = ? AND m.escola_id = ? AND m.ano_letivo = ?
       ORDER BY a.estudante`,
      [turmaId, escola_id, ano]
    );

    // 2) Notas da turma no bimestre/ano (tabela notas = boletim exportado)
    const alunoIds = alunos.map(a => a.id);
    if (alunoIds.length === 0) {
      return res.json({ ok: true, alunos: [], disciplinas: [], notas: {}, flags: [] });
    }

    const placeholders = alunoIds.map(() => "?").join(",");
    const [notasRows] = await db.query(
      `SELECT n.aluno_id, n.disciplina_id, d.nome AS disciplina, n.nota
       FROM notas n
       JOIN disciplinas d ON d.id = n.disciplina_id
       WHERE n.aluno_id IN (${placeholders})
         AND n.bimestre = ?
         AND n.ano = ?
       ORDER BY d.nome`,
      [...alunoIds, bimestre, ano]
    );

    // 3) Flags de "não destaque" do professor logado
    const [flagsRows] = await db.query(
      `SELECT aluno_id, disciplina_id
       FROM mapa_nota_flags
       WHERE escola_id = ? AND usuario_id = ? AND bimestre = ? AND ano = ? AND flagged = 1`,
      [escola_id, usuario_id, bimestre, ano]
    );

    // 4) Disciplina(s) que o professor logado leciona para essa turma
    // Fonte de verdade: tripla professor_id + disciplina_id + turma_id na tabela modulacao
    // A ponte usuarios → professores é via CPF (não existe usuario_id em professores)
    // Um professor pode ter N disciplinas na mesma turma — DISTINCT retorna todas.
    let discsProfessor = new Set();
    try {
      const [discProfRows] = await db.query(
        `SELECT DISTINCT mo.disciplina_id
         FROM usuarios u
         JOIN professores p
           ON REPLACE(REPLACE(p.cpf, '.', ''), '-', '') = REPLACE(REPLACE(u.cpf, '.', ''), '-', '')
          AND p.escola_id = u.escola_id
         JOIN modulacao mo ON mo.professor_id = p.id AND mo.turma_id = ?
         WHERE u.id = ?
           AND mo.escola_id = ?`,
        [turmaId, usuario_id, escola_id]
      );
      discsProfessor = new Set(discProfRows.map(r => r.disciplina_id));
      console.log(`[mapa-nota] usuario_id=${usuario_id} → discsProfessor na turma ${turmaId}:`, [...discsProfessor]);
    } catch (discErr) {
      // Nao critico: professor nao tera celulas editaveis, mas tabela continua funcional
      console.warn("[mapa-nota] Erro ao buscar disciplinas do professor:", discErr.message);
    }

    // 5) Montar lista de disciplinas únicas (em ordem)
    const discMap = new Map();
    for (const n of notasRows) {
      if (!discMap.has(n.disciplina_id)) {
        discMap.set(n.disciplina_id, {
          id: n.disciplina_id,
          nome: n.disciplina,
          minha: discsProfessor.has(n.disciplina_id),
        });
      }
    }
    const disciplinas = [...discMap.values()];

    // 6) Montar mapa de notas: { "alunoId_disciplinaId": nota }
    const notasMap = {};
    for (const n of notasRows) {
      notasMap[`${n.aluno_id}_${n.disciplina_id}`] = Number(n.nota);
    }

    // 7) Montar set de flags: ["alunoId_disciplinaId"]
    const flagsSet = flagsRows.map(f => `${f.aluno_id}_${f.disciplina_id}`);

    return res.json({ ok: true, alunos, disciplinas, notas: notasMap, flags: flagsSet });
  } catch (err) {
    console.error("[mapa-nota] Erro:", err.message);
    return res.status(500).json({ ok: false, error: "Erro ao carregar mapa de notas." });
  }
});

// ---------------------------------------------------------------------------
// POST /mapa-nota/flag
// Toggle de flag amarelo (não destaque) por professor/aluno/disciplina/bimestre/ano.
// O professor só pode flagear disciplinas que ele próprio leciona na turma.
// ---------------------------------------------------------------------------
router.post("/mapa-nota/flag", verificarEscola, async (req, res) => {
  try {
    const escola_id = req.user?.escola_id;
    const usuario_id =
      req.user?.usuario_id ||
      req.user?.usuarioId ||
      req.user?.id ||
      req.user?.user_id ||
      req.user?.id_usuario;
    const { aluno_id, disciplina_id, bimestre, ano, turma_id } = req.body;

    if (!aluno_id || !disciplina_id || !bimestre || !ano) {
      return res.status(400).json({ ok: false, error: "Parâmetros insuficientes." });
    }

    // Verificar se o professor leciona essa disciplina na turma (via professores + modulacao)
    if (turma_id) {
      let autorizado = false;
      try {
        const [[uRow]] = await db.query(
          `SELECT cpf FROM usuarios WHERE id = ? LIMIT 1`,
          [usuario_id]
        );
        if (uRow?.cpf) {
          const cpfLimpo = String(uRow.cpf).replace(/\D/g, "");
          const [check] = await db.query(
            `SELECT mo.id FROM professores p
             JOIN modulacao mo ON mo.professor_id = p.id
             WHERE p.escola_id = ?
               AND REPLACE(REPLACE(p.cpf, '.', ''), '-', '') = ?
               AND mo.turma_id = ?
               AND mo.disciplina_id = ?
             LIMIT 1`,
            [escola_id, cpfLimpo, turma_id, disciplina_id]
          );
          autorizado = check.length > 0;
        }
      } catch (checkErr) {
        console.warn("[mapa-nota/flag] Erro ao verificar vinculo professor:", checkErr.message);
        // Em caso de erro na verificacao, negar por seguranca
        return res.status(403).json({ ok: false, error: "Não foi possível verificar permissão." });
      }
      if (!autorizado) {
        return res.status(403).json({ ok: false, error: "Você não pode sinalizar esta disciplina." });
      }
    }

    // Toggle: INSERT ON DUPLICATE KEY UPDATE flagged = 1 - flagged
    await db.query(
      `INSERT INTO mapa_nota_flags
         (escola_id, usuario_id, aluno_id, disciplina_id, bimestre, ano, flagged)
       VALUES (?, ?, ?, ?, ?, ?, 1)
       ON DUPLICATE KEY UPDATE flagged = 1 - flagged, updated_at = NOW()`,
      [escola_id, usuario_id, aluno_id, disciplina_id, bimestre, ano]
    );

    // Retornar estado atual do flag
    const [[flag]] = await db.query(
      `SELECT flagged FROM mapa_nota_flags
       WHERE escola_id = ? AND usuario_id = ? AND aluno_id = ? AND disciplina_id = ? AND bimestre = ? AND ano = ?`,
      [escola_id, usuario_id, aluno_id, disciplina_id, bimestre, ano]
    );

    return res.json({ ok: true, flagged: flag?.flagged === 1 });
  } catch (err) {
    console.error("[mapa-nota/flag] Erro:", err.message);
    return res.status(500).json({ ok: false, error: "Erro ao salvar flag." });
  }
});

export default router;
