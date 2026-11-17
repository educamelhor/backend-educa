// routes/frequencia.js
// ============================================================================
// Módulo FREQUÊNCIA — Rotas da API
// - CRUD completo de justificativas de faltas (atestados)
// - CRUD de busca ativa (contatos com famílias)
// - Relatórios de alunos faltosos
// - Encaminhamentos ao Conselho Tutelar
//
// ── Governança de Acesso ────────────────────────────────────────────────────
// Quem VISUALIZA e REGISTRA: diretor, vice_diretor, supervisor, secretario,
//                            coordenador, orientador, pedagogo
// Quem só VISUALIZA:         professor (filtrado por LGPD — apenas suas turmas)
// Sem acesso:                disciplinar, diretor_disciplinar, militar
// ============================================================================

import { Router } from "express";

const router = Router();

// ─────────────────────────────────────────────────
// MIDDLEWARES DE GOVERNANÇA
// ─────────────────────────────────────────────────

const PERFIS_DISCIPLINAR = new Set([
  "disciplinar", "diretor_disciplinar", "militar", "comandante",
]);

const PERFIS_SOMENTE_LEITURA = new Set(["professor"]);

/**
 * Bloqueia totalmente perfis disciplinar/militar do módulo de frequência.
 * HTTP 403 com mensagem clara.
 */
function bloquearDisciplinar(req, res, next) {
  const perfil = String(req.user?.perfil || "").toLowerCase().trim();
  if (PERFIS_DISCIPLINAR.has(perfil)) {
    return res.status(403).json({
      error: "Acesso negado",
      message: "O perfil disciplinar não tem acesso ao módulo de Frequência.",
    });
  }
  next();
}

/**
 * Bloqueia professores de operações de escrita (POST / PUT / DELETE).
 * Professores só podem consultar (GET).
 */
function apenasLeituraProfessor(req, res, next) {
  const perfil = String(req.user?.perfil || "").toLowerCase().trim();
  if (PERFIS_SOMENTE_LEITURA.has(perfil)) {
    return res.status(403).json({
      error: "Acesso negado",
      message: "Professores podem apenas consultar os atestados. O registro é realizado pela secretaria ou equipe gestora.",
    });
  }
  next();
}

// Aplica bloquearDisciplinar em TODAS as rotas deste router
router.use(bloquearDisciplinar);

// ─────────────────────────────────────────────────
// JUSTIFICATIVAS (Atestados) — CRUD COMPLETO
// ─────────────────────────────────────────────────

// GET /api/frequencia/justificativas
// LGPD: professor acessa apenas turmas em que leciona (ano letivo corrente)
router.get("/justificativas", async (req, res) => {
  try {
    const { escola_id, turma_id, tipo } = req.query;
    if (!escola_id) return res.status(400).json({ error: "escola_id obrigatório" });

    const perfil = String(req.user?.perfil || "").toLowerCase();
    const isProfessor = perfil === "professor";
    const anoLetivo = new Date().getFullYear();

    let sql = `
      SELECT
        fj.*,
        a.estudante AS aluno_nome,
        t.nome AS turma_nome,
        u.nome AS registrado_por_nome
      FROM frequencia_justificativas fj
      LEFT JOIN alunos a ON fj.aluno_id = a.id
      LEFT JOIN turmas t ON fj.turma_id = t.id
      LEFT JOIN usuarios u ON fj.registrado_por = u.id
      WHERE fj.escola_id = ?
    `;
    const params = [escola_id];

    // ── LGPD: professor só vê turmas em que leciona (ano letivo atual) ──
    if (isProfessor) {
      const cpf = req.user?.cpf;
      let cleanCpf = cpf ? String(cpf).replace(/\D/g, "") : null;

      // Fallback: busca CPF pelo usuario_id do token
      if (!cleanCpf) {
        const userId = req.user?.usuario_id || req.user?.usuarioId || req.user?.id;
        if (userId) {
          const [urows] = await req.db.query("SELECT cpf FROM usuarios WHERE id = ? LIMIT 1", [userId]);
          cleanCpf = urows?.[0]?.cpf ? String(urows[0].cpf).replace(/\D/g, "") : null;
        }
      }

      if (cleanCpf) {
        sql += `
          AND (
            fj.turma_id IN (
              SELECT DISTINCT t2.id FROM turmas t2
              WHERE t2.escola_id = ? AND t2.ano = ?
                AND (
                  t2.id IN (
                    SELECT p.turma_id FROM professores p
                    WHERE p.escola_id = ? AND REPLACE(REPLACE(REPLACE(REPLACE(p.cpf, '.', ''), '-', ''), ' ', ''), '/', '') = ?
                  )
                  OR
                  t2.id IN (
                    SELECT m.turma_id FROM modulacao m
                    JOIN professores p ON p.id = m.professor_id
                    WHERE p.escola_id = ? AND REPLACE(REPLACE(REPLACE(REPLACE(p.cpf, '.', ''), '-', ''), ' ', ''), '/', '') = ?
                  )
                )
            )
            OR fj.aluno_id IN (
              SELECT m2.aluno_id
              FROM matriculas m2
              JOIN modulacao md ON md.turma_id = m2.turma_id AND md.escola_id = m2.escola_id
              JOIN professores p2 ON p2.id = md.professor_id
              WHERE m2.escola_id = ? AND m2.ano_letivo = ?
                AND REPLACE(REPLACE(REPLACE(REPLACE(p2.cpf, '.', ''), '-', ''), ' ', ''), '/', '') = ?
            )
            OR fj.aluno_id IN (
              SELECT aa.aluno_id
              FROM agrupamento_alunos aa
              JOIN agrupamento_modulacao am ON am.agrupamento_id = aa.agrupamento_id
              JOIN professores p3 ON p3.id = am.professor_id
              WHERE aa.escola_id = ? AND aa.status = 'ativo'
                AND REPLACE(REPLACE(REPLACE(REPLACE(p3.cpf, '.', ''), '-', ''), ' ', ''), '/', '') = ?
            )
          )
        `;
        params.push(
          escola_id,
          anoLetivo,
          escola_id,
          cleanCpf,
          escola_id,
          cleanCpf,
          escola_id,
          anoLetivo,
          cleanCpf,
          escola_id,
          cleanCpf
        );
      } else {
        // CPF não encontrado: retorna lista vazia por segurança (LGPD — fail-safe)
        return res.json([]);
      }
    }

    if (turma_id) {
      sql += ` AND (fj.turma_id = ? OR fj.aluno_id IN (
        SELECT m_f.aluno_id FROM matriculas m_f WHERE m_f.turma_id = ? AND m_f.escola_id = ?
        UNION
        SELECT aa_f.aluno_id FROM agrupamento_alunos aa_f WHERE aa_f.agrupamento_id = ? AND aa_f.escola_id = ? AND aa_f.status = 'ativo'
      ))`;
      params.push(turma_id, turma_id, escola_id, turma_id, escola_id);
    }
    if (tipo) {
      sql += " AND fj.tipo = ?";
      params.push(tipo);
    }

    sql += " ORDER BY fj.criado_em DESC";

    const [rows] = await req.db.query(sql, params);
    res.json(rows);
  } catch (err) {
    console.error("[FREQUENCIA] Erro ao listar justificativas:", err.message);
    res.status(500).json({ error: "Erro interno" });
  }
});


// POST /api/frequencia/justificativas
// Verifica duplicata (mesmo aluno + tipo + período) antes de inserir
router.post("/justificativas", apenasLeituraProfessor, async (req, res) => {
  try {
    const { escola_id, turma_id, aluno_id, tipo, data_inicio, data_fim, dias, observacao } = req.body;
    if (!escola_id || !aluno_id || !tipo || !data_inicio || !data_fim) {
      return res.status(400).json({ error: "Campos obrigatórios: escola_id, aluno_id, tipo, data_inicio, data_fim" });
    }

    // Verificação de duplicata
    const [duplicados] = await req.db.query(
      `SELECT id FROM frequencia_justificativas
       WHERE escola_id = ? AND aluno_id = ? AND tipo = ? AND data_inicio = ? AND data_fim = ?
       LIMIT 1`,
      [escola_id, aluno_id, tipo, data_inicio, data_fim]
    );
    if (duplicados.length > 0) {
      return res.status(409).json({
        error: "Justificativa duplicada",
        message: "Já existe um registro com os mesmos aluno, tipo e período. Use editar para atualizar.",
        id_existente: duplicados[0].id,
      });
    }

    const registrado_por = req.user?.usuario_id ?? req.user?.usuarioId ?? null;

    const [result] = await req.db.query(
      `INSERT INTO frequencia_justificativas
        (escola_id, turma_id, aluno_id, tipo, data_inicio, data_fim, dias, observacao, registrado_por)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [escola_id, turma_id || null, aluno_id, tipo, data_inicio, data_fim, dias || 1, observacao || null, registrado_por]
    );

    res.status(201).json({ id: result.insertId, message: "Justificativa registrada" });
  } catch (err) {
    console.error("[FREQUENCIA] Erro ao registrar justificativa:", err.message);
    res.status(500).json({ error: "Erro interno" });
  }
});

// PUT /api/frequencia/justificativas/:id
router.put("/justificativas/:id", apenasLeituraProfessor, async (req, res) => {
  try {
    const { id } = req.params;
    const { tipo, data_inicio, data_fim, dias, observacao } = req.body;
    const escola_id = req.escola_id;

    if (!tipo || !data_inicio || !data_fim) {
      return res.status(400).json({ error: "Campos obrigatórios: tipo, data_inicio, data_fim" });
    }

    // Garante que o registro pertence a esta escola
    const [[registro]] = await req.db.query(
      "SELECT id, aluno_id FROM frequencia_justificativas WHERE id = ? AND escola_id = ? LIMIT 1",
      [id, escola_id]
    );
    if (!registro) {
      return res.status(404).json({ error: "Registro não encontrado" });
    }

    // Verifica duplicata para o mesmo aluno (exceto o próprio registro)
    const [duplicados] = await req.db.query(
      `SELECT id FROM frequencia_justificativas
       WHERE escola_id = ? AND aluno_id = ? AND tipo = ? AND data_inicio = ? AND data_fim = ? AND id != ?
       LIMIT 1`,
      [escola_id, registro.aluno_id, tipo, data_inicio, data_fim, id]
    );
    if (duplicados.length > 0) {
      return res.status(409).json({
        error: "Justificativa duplicada",
        message: "Já existe outro registro com os mesmos aluno, tipo e período.",
      });
    }

    await req.db.query(
      `UPDATE frequencia_justificativas
       SET tipo = ?, data_inicio = ?, data_fim = ?, dias = ?, observacao = ?, atualizado_em = NOW()
       WHERE id = ? AND escola_id = ?`,
      [tipo, data_inicio, data_fim, dias || 1, observacao || null, id, escola_id]
    );

    res.json({ message: "Justificativa atualizada com sucesso" });
  } catch (err) {
    console.error("[FREQUENCIA] Erro ao atualizar justificativa:", err.message);
    res.status(500).json({ error: "Erro interno" });
  }
});

// DELETE /api/frequencia/justificativas/:id
router.delete("/justificativas/:id", apenasLeituraProfessor, async (req, res) => {
  try {
    const { id } = req.params;
    const escola_id = req.escola_id;

    const [result] = await req.db.query(
      "DELETE FROM frequencia_justificativas WHERE id = ? AND escola_id = ?",
      [id, escola_id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "Registro não encontrado" });
    }

    res.json({ message: "Justificativa excluída com sucesso" });
  } catch (err) {
    console.error("[FREQUENCIA] Erro ao excluir justificativa:", err.message);
    res.status(500).json({ error: "Erro interno" });
  }
});

// ─────────────────────────────────────────────────
// BUSCA ATIVA (Contatos com famílias)
// ─────────────────────────────────────────────────

// GET /api/frequencia/busca-ativa
router.get("/busca-ativa", async (req, res) => {
  try {
    const { escola_id, turma_id, aluno_id } = req.query;
    if (!escola_id) return res.status(400).json({ error: "escola_id obrigatório" });

    let sql = `
      SELECT
        fba.*,
        a.estudante AS aluno_nome,
        t.nome AS turma_nome,
        u1.nome AS registrado_por_nome,
        u2.nome AS editado_por_nome
      FROM frequencia_busca_ativa fba
      LEFT JOIN alunos a ON fba.aluno_id = a.id
      LEFT JOIN turmas t ON fba.turma_id = t.id
      LEFT JOIN usuarios u1 ON fba.registrado_por = u1.id
      LEFT JOIN usuarios u2 ON fba.editado_por = u2.id
      WHERE fba.escola_id = ?
    `;
    const params = [escola_id];

    if (turma_id) { sql += " AND fba.turma_id = ?"; params.push(turma_id); }
    if (aluno_id) { sql += " AND fba.aluno_id = ?"; params.push(aluno_id); }

    sql += " ORDER BY fba.criado_em DESC";

    const [rows] = await req.db.query(sql, params);
    res.json(rows);
  } catch (err) {
    console.error("[FREQUENCIA] Erro ao listar busca ativa:", err.message);
    res.status(500).json({ error: "Erro interno" });
  }
});

// POST /api/frequencia/busca-ativa
// Verifica duplicata antes de inserir (mesmo aluno + data + meio + resultado)
router.post("/busca-ativa", apenasLeituraProfessor, async (req, res) => {
  try {
    const { escola_id, turma_id, aluno_id, data_contato, meio_contato, resultado, observacao } = req.body;
    if (!escola_id || !aluno_id || !meio_contato || !resultado) {
      return res.status(400).json({ error: "Campos obrigatórios: escola_id, aluno_id, meio_contato, resultado" });
    }

    const dataContato = data_contato || new Date().toISOString().split("T")[0];

    // Verificação de duplicata: mesmo aluno + mesma data + mesmo meio + mesmo resultado
    const [duplicados] = await req.db.query(
      `SELECT id FROM frequencia_busca_ativa
       WHERE escola_id = ? AND aluno_id = ? AND DATE(data_contato) = ? AND meio_contato = ? AND resultado = ?
       LIMIT 1`,
      [escola_id, aluno_id, dataContato, meio_contato, resultado]
    );
    if (duplicados.length > 0) {
      return res.status(409).json({
        error: "Contato duplicado",
        message: "Já existe um registro com os mesmos aluno, data, meio e resultado de contato.",
        id_existente: duplicados[0].id,
      });
    }

    const registrado_por = req.user?.usuario_id ?? req.user?.usuarioId ?? null;

    const [result] = await req.db.query(
      `INSERT INTO frequencia_busca_ativa
        (escola_id, turma_id, aluno_id, data_contato, meio_contato, resultado, observacao, registrado_por)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [escola_id, turma_id || null, aluno_id, dataContato, meio_contato, resultado, observacao || null, registrado_por]
    );

    res.status(201).json({ id: result.insertId, message: "Contato registrado" });
  } catch (err) {
    console.error("[FREQUENCIA] Erro ao registrar busca ativa:", err.message);
    res.status(500).json({ error: "Erro interno" });
  }
});

// PUT /api/frequencia/busca-ativa/:id
// Edita um registro existente e registra rastreabilidade de quem editou
router.put("/busca-ativa/:id", apenasLeituraProfessor, async (req, res) => {
  try {
    const { id } = req.params;
    const { data_contato, meio_contato, resultado, observacao } = req.body;
    const escola_id = req.escola_id;

    if (!meio_contato || !resultado) {
      return res.status(400).json({ error: "Campos obrigatórios: meio_contato, resultado" });
    }

    // Garante que o registro pertence a esta escola
    const [[registro]] = await req.db.query(
      "SELECT id FROM frequencia_busca_ativa WHERE id = ? AND escola_id = ? LIMIT 1",
      [id, escola_id]
    );
    if (!registro) {
      return res.status(404).json({ error: "Registro não encontrado" });
    }

    const editado_por = req.user?.usuario_id ?? req.user?.usuarioId ?? null;

    await req.db.query(
      `UPDATE frequencia_busca_ativa
       SET data_contato = ?, meio_contato = ?, resultado = ?, observacao = ?,
           editado_por = ?, editado_em = NOW()
       WHERE id = ? AND escola_id = ?`,
      [data_contato, meio_contato, resultado, observacao || null, editado_por, id, escola_id]
    );

    res.json({ message: "Contato atualizado com sucesso" });
  } catch (err) {
    console.error("[FREQUENCIA] Erro ao editar busca ativa:", err.message);
    res.status(500).json({ error: "Erro interno" });
  }
});

// DELETE /api/frequencia/busca-ativa/:id
router.delete("/busca-ativa/:id", apenasLeituraProfessor, async (req, res) => {
  try {
    const { id } = req.params;
    const escola_id = req.escola_id;

    const [result] = await req.db.query(
      "DELETE FROM frequencia_busca_ativa WHERE id = ? AND escola_id = ?",
      [id, escola_id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "Registro não encontrado" });
    }

    res.json({ message: "Contato excluído com sucesso" });
  } catch (err) {
    console.error("[FREQUENCIA] Erro ao excluir busca ativa:", err.message);
    res.status(500).json({ error: "Erro interno" });
  }
});

// ─────────────────────────────────────────────────
// RELATÓRIOS — Alunos mais faltosos
// ─────────────────────────────────────────────────

// GET /api/frequencia/relatorios/faltosos
router.get("/relatorios/faltosos", async (req, res) => {
  try {
    const { escola_id, turma_id, periodo = "ano_letivo" } = req.query;
    if (!escola_id) return res.status(400).json({ error: "escola_id obrigatório" });

    const anoLetivo = Number(req.query.ano) || new Date().getFullYear();

    // Determina filtro de bimestres conforme período solicitado (conectado à Governança > Ano Letivo)
    let bimestresFiltro = [1, 2, 3, 4];
    let cargaAulasReferencia = 1000; // Carga anual de referência (200 dias * 5h-aula)
    try {
      const hoje = new Date().toISOString().slice(0, 10);
      const [pRows] = await req.db.query(
        `SELECT numero,
                DATE_FORMAT(data_inicio, '%Y-%m-%d') AS data_inicio,
                DATE_FORMAT(data_fim, '%Y-%m-%d') AS data_fim
           FROM governanca_ano_letivo_periodos
          WHERE escola_id = ? AND ano_letivo = ? AND tipo = 'bimestre'
          ORDER BY numero ASC`,
        [escola_id, anoLetivo]
      );
      const perVigente = (pRows || []).find(
        (p) => p.data_inicio && p.data_fim && hoje >= p.data_inicio && hoje <= p.data_fim
      );
      const mesAtual = new Date().getMonth() + 1;
      const bimAtual = perVigente
        ? Number(perVigente.numero)
        : mesAtual <= 4
        ? 1
        : mesAtual <= 7
        ? 2
        : mesAtual <= 9
        ? 3
        : 4;

      if (periodo === "bimestre_atual") {
        bimestresFiltro = [bimAtual];
        cargaAulasReferencia = 250;
      } else if (periodo === "semestre") {
        bimestresFiltro = bimAtual <= 2 ? [1, 2] : [3, 4];
        cargaAulasReferencia = 500;
      }
    } catch (_) {}

    const phBim = bimestresFiltro.map(() => "?").join(",");

    let sql = `
      SELECT
        a.id AS aluno_id,
        a.estudante AS aluno_nome,
        COALESCE(t_mat.nome, t_al.nome, '—') AS turma_nome,
        COALESCE(nf.total_faltas, 0) AS total_faltas,
        COALESCE(jf.dias_justificados, 0) AS justificadas
      FROM alunos a
      LEFT JOIN matriculas m
        ON m.aluno_id = a.id
       AND m.escola_id = a.escola_id
       AND m.ano_letivo = ?
       AND m.status IN ('ativo', 'matriculado')
      LEFT JOIN turmas t_mat ON t_mat.id = m.turma_id
      LEFT JOIN turmas t_al ON t_al.id = a.turma_id
      LEFT JOIN (
        SELECT aluno_id, SUM(COALESCE(faltas, 0)) AS total_faltas
          FROM notas
         WHERE escola_id = ? AND ano = ? AND bimestre IN (${phBim})
         GROUP BY aluno_id
      ) nf ON nf.aluno_id = a.id
      LEFT JOIN (
        SELECT aluno_id, SUM(COALESCE(dias, 1)) AS dias_justificados
          FROM frequencia_justificativas
         WHERE escola_id = ? AND (YEAR(data_inicio) = ? OR YEAR(data_fim) = ?)
         GROUP BY aluno_id
      ) jf ON jf.aluno_id = a.id
      WHERE a.escola_id = ?
        AND (a.status = 'ativo' OR a.status IS NULL)
    `;

    const params = [
      anoLetivo,
      escola_id,
      anoLetivo,
      ...bimestresFiltro,
      escola_id,
      anoLetivo,
      anoLetivo,
      escola_id,
    ];

    if (turma_id) {
      sql += " AND (m.turma_id = ? OR (m.turma_id IS NULL AND a.turma_id = ?))";
      params.push(turma_id, turma_id);
    }

    sql += `
      HAVING total_faltas > 0
      ORDER BY total_faltas DESC
      LIMIT 100
    `;

    const [rows] = await req.db.query(sql, params);
    const formatados = (rows || []).map((r) => {
      const totalFaltas = Number(r.total_faltas || 0);
      // Estima aulas justificadas (média de 5 aulas/dia letivo coberto por atestado, limitado a totalFaltas)
      const aulasJustificadas = Math.min(totalFaltas, Number(r.justificadas || 0) * 5);
      const naoJustificadas = Math.max(0, totalFaltas - aulasJustificadas);
      const percFreq = Math.max(
        0,
        Math.min(100, Number((((cargaAulasReferencia - totalFaltas) / cargaAulasReferencia) * 100).toFixed(1)))
      );
      return {
        aluno_id: r.aluno_id,
        aluno_nome: r.aluno_nome,
        turma_nome: r.turma_nome,
        total_faltas: totalFaltas,
        justificadas: aulasJustificadas,
        dias_atestado: Number(r.justificadas || 0),
        nao_justificadas: naoJustificadas,
        percentual_frequencia: percFreq,
      };
    });

    res.json(formatados);
  } catch (err) {
    console.error("[FREQUENCIA] Erro ao gerar relatório faltosos:", err.message);
    res.status(500).json({ error: "Erro interno" });
  }
});

// ─────────────────────────────────────────────────
// CONSELHO TUTELAR — Relatório individual + Encaminhamentos
// ─────────────────────────────────────────────────

// GET /api/frequencia/conselho-tutelar/relatorio
router.get("/conselho-tutelar/relatorio", async (req, res) => {
  try {
    const { escola_id, aluno_id } = req.query;
    if (!escola_id || !aluno_id) return res.status(400).json({ error: "escola_id e aluno_id obrigatórios" });

    const anoLetivo = Number(req.query.ano) || new Date().getFullYear();

    const [[aluno]] = await req.db.query(
      `SELECT a.estudante AS aluno_nome,
              COALESCE(t_mat.nome, t.nome) AS turma_nome
         FROM alunos a
         LEFT JOIN matriculas m ON m.aluno_id = a.id AND m.escola_id = a.escola_id AND m.ano_letivo = ? AND m.status IN ('ativo', 'matriculado')
         LEFT JOIN turmas t_mat ON t_mat.id = m.turma_id
         LEFT JOIN turmas t ON a.turma_id = t.id
        WHERE a.id = ? AND a.escola_id = ?
        LIMIT 1`,
      [anoLetivo, aluno_id, escola_id]
    );

    const [justificativas] = await req.db.query(
      "SELECT * FROM frequencia_justificativas WHERE aluno_id = ? AND escola_id = ? ORDER BY data_inicio DESC",
      [aluno_id, escola_id]
    );

    const [buscaAtiva] = await req.db.query(
      "SELECT * FROM frequencia_busca_ativa WHERE aluno_id = ? AND escola_id = ? ORDER BY data_contato DESC",
      [aluno_id, escola_id]
    );

    const [[faltasRow]] = await req.db.query(
      `SELECT COALESCE(SUM(faltas), 0) AS total_faltas_notas
         FROM notas
        WHERE aluno_id = ? AND escola_id = ? AND ano = ?`,
      [aluno_id, escola_id, anoLetivo]
    );

    const totalDiasAtestado = justificativas.reduce((s, j) => s + (Number(j.dias) || 1), 0);
    const totalFaltasReais = Number(faltasRow?.total_faltas_notas || 0);
    const faltasJustificadas = Math.min(totalFaltasReais, totalDiasAtestado * 5);
    const faltasNaoJustificadas = Math.max(0, totalFaltasReais - faltasJustificadas);

    res.json({
      aluno_nome: aluno?.aluno_nome || "",
      turma_nome: aluno?.turma_nome || "",
      total_faltas: totalFaltasReais,
      justificadas: faltasJustificadas,
      dias_atestado: totalDiasAtestado,
      nao_justificadas: faltasNaoJustificadas,
      busca_ativa_total: buscaAtiva.length,
      justificativas: justificativas.map(j => ({
        ...j,
        tipo_label: j.tipo?.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()),
      })),
      busca_ativa: buscaAtiva,
    });
  } catch (err) {
    console.error("[FREQUENCIA] Erro ao gerar relatório CT:", err.message);
    res.status(500).json({ error: "Erro interno" });
  }
});

// GET /api/frequencia/conselho-tutelar/encaminhamentos
router.get("/conselho-tutelar/encaminhamentos", async (req, res) => {
  try {
    const { escola_id } = req.query;
    if (!escola_id) return res.status(400).json({ error: "escola_id obrigatório" });

    const [rows] = await req.db.query(`
      SELECT
        fec.*,
        a.estudante AS aluno_nome,
        t.nome AS turma_nome,
        u.nome AS registrado_por_nome
      FROM frequencia_encaminhamentos_ct fec
      LEFT JOIN alunos a ON fec.aluno_id = a.id
      LEFT JOIN turmas t ON fec.turma_id = t.id
      LEFT JOIN usuarios u ON fec.registrado_por = u.id
      WHERE fec.escola_id = ?
      ORDER BY fec.criado_em DESC
    `, [escola_id]);

    res.json(rows);
  } catch (err) {
    console.error("[FREQUENCIA] Erro ao listar encaminhamentos:", err.message);
    res.status(500).json({ error: "Erro interno" });
  }
});

// POST /api/frequencia/conselho-tutelar/encaminhamentos
router.post("/conselho-tutelar/encaminhamentos", apenasLeituraProfessor, async (req, res) => {
  try {
    const { escola_id, turma_id, aluno_id, motivo } = req.body;
    if (!escola_id || !aluno_id) return res.status(400).json({ error: "escola_id e aluno_id obrigatórios" });

    const registrado_por = req.user?.id || null;

    const [result] = await req.db.query(
      `INSERT INTO frequencia_encaminhamentos_ct
        (escola_id, turma_id, aluno_id, motivo, registrado_por)
       VALUES (?, ?, ?, ?, ?)`,
      [escola_id, turma_id || null, aluno_id, motivo || null, registrado_por]
    );

    res.status(201).json({ id: result.insertId, message: "Encaminhamento registrado" });
  } catch (err) {
    console.error("[FREQUENCIA] Erro ao registrar encaminhamento:", err.message);
    res.status(500).json({ error: "Erro interno" });
  }
});

export default router;
