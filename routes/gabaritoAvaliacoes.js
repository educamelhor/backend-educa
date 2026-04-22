// ============================================================================
// GABARITO — CRUD de Avaliações (Persistência no BD)
// ============================================================================
// Cada avaliação gerada na Etapa 1 é salva aqui. Na Etapa 2, o coordenador
// seleciona a avaliação para correção. Suporta mapeamento multidisciplinar.
//
// disciplinas_config: [
//   { disciplina_id: 21, nome: "Matemática", de: 1, ate: 15 },
//   { disciplina_id: 25, nome: "Ciências",   de: 16, ate: 25 }
// ]
// ============================================================================

import { Router } from "express";
import pool from "../db.js";

const router = Router();

// ─── Helpers ─────────────────────────────────────────────────────────────────

function anoLetivoAtual() {
  const hoje = new Date();
  const mes = hoje.getMonth() + 1;
  return mes <= 1 ? hoje.getFullYear() - 1 : hoje.getFullYear();
}

// ─── GET /api/gabarito-avaliacoes ────────────────────────────────────────────
// Lista todas as avaliações da escola (opcionalmente filtradas por status)
router.get("/", async (req, res) => {
  try {
    const { escola_id } = req.user;
    const { status, bimestre, limit } = req.query;

    let sql = `
      SELECT 
        id, titulo, tipo, bimestre, num_questoes, num_alternativas,
        nota_total, modelo, gabarito_oficial, disciplinas_config,
        turmas_ids, turno, status, criado_por,
        created_at, updated_at
      FROM gabarito_avaliacoes
      WHERE escola_id = ?
    `;
    const params = [escola_id];

    if (status) {
      sql += " AND status = ?";
      params.push(status);
    }
    if (bimestre) {
      sql += " AND bimestre = ?";
      params.push(bimestre);
    }

    sql += " ORDER BY created_at DESC";

    if (limit) {
      sql += " LIMIT ?";
      params.push(Number(limit));
    }

    const [rows] = await pool.query(sql, params);

    // Parse JSON fields
    const parsed = rows.map((r) => ({
      ...r,
      gabarito_oficial: safeJson(r.gabarito_oficial),
      disciplinas_config: safeJson(r.disciplinas_config),
      turmas_ids: safeJson(r.turmas_ids),
    }));

    res.json(parsed);
  } catch (err) {
    console.error("Erro ao listar avaliações:", err);
    res.status(500).json({ error: "Erro ao carregar avaliações." });
  }
});

// ─── GET /api/gabarito-avaliacoes/:id ────────────────────────────────────────
// Retorna uma avaliação específica
router.get("/:id", async (req, res) => {
  try {
    const { escola_id } = req.user;
    const { id } = req.params;

    const [rows] = await pool.query(
      `SELECT * FROM gabarito_avaliacoes WHERE id = ? AND escola_id = ?`,
      [id, escola_id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: "Avaliação não encontrada." });
    }

    const r = rows[0];
    res.json({
      ...r,
      gabarito_oficial: safeJson(r.gabarito_oficial),
      disciplinas_config: safeJson(r.disciplinas_config),
      turmas_ids: safeJson(r.turmas_ids),
    });
  } catch (err) {
    console.error("Erro ao buscar avaliação:", err);
    res.status(500).json({ error: "Erro ao buscar avaliação." });
  }
});

// ─── GET /api/gabarito-avaliacoes/verificar-duplicidade ──────────────────────
// Verifica se já existe avaliação similar (mesmo tipo+titulo+bimestre)
router.get("/verificar-duplicidade", async (req, res) => {
  try {
    const { escola_id } = req.user;
    const { tipo, titulo, bimestre } = req.query;

    if (!titulo) return res.json({ existe: false });

    let sql = `
      SELECT id, titulo, tipo, bimestre, status, created_at
      FROM gabarito_avaliacoes
      WHERE escola_id = ? AND LOWER(TRIM(titulo)) = LOWER(TRIM(?))
    `;
    const params = [escola_id, titulo];

    if (tipo) {
      sql += " AND tipo = ?";
      params.push(tipo);
    }
    if (bimestre) {
      sql += " AND bimestre = ?";
      params.push(bimestre);
    }

    sql += " ORDER BY created_at DESC LIMIT 1";
    const [rows] = await pool.query(sql, params);

    if (rows.length > 0) {
      return res.json({ existe: true, avaliacao: rows[0] });
    }
    res.json({ existe: false });
  } catch (err) {
    console.error("Erro ao verificar duplicidade:", err);
    res.status(500).json({ error: "Erro ao verificar duplicidade." });
  }
});

// ─── POST /api/gabarito-avaliacoes ───────────────────────────────────────────
// Cria uma nova avaliação (Etapa 1)
router.post("/", async (req, res) => {
  try {
    const { escola_id } = req.user;
    const userId = req.user.id || req.user.userId;

    const {
      titulo,
      tipo,
      bimestre,
      num_questoes,
      num_alternativas,
      nota_total,
      modelo,
      gabarito_oficial,
      disciplinas_config,
      turmas_ids,
      turno,
      data_aplicacao,  // ← DATA DA PROVA BIMESTRAL (definida pela direção)
    } = req.body;

    // Validações
    if (!titulo || !titulo.trim()) {
      return res.status(400).json({ error: "Título é obrigatório." });
    }
    const nQ = Number(num_questoes);
    if (!nQ || nQ < 1 || nQ > 100) {
      return res.status(400).json({ error: "Número de questões inválido (1-100)." });
    }
    const nA = Number(num_alternativas);
    if (!nA || nA < 2 || nA > 6) {
      return res.status(400).json({ error: "Alternativas inválidas (2-6)." });
    }

    // Validar disciplinas_config (se fornecido)
    if (disciplinas_config && Array.isArray(disciplinas_config)) {
      for (const dc of disciplinas_config) {
        if (!dc.disciplina_id || !dc.de || !dc.ate) {
          return res.status(400).json({ error: "Configuração de disciplinas inválida." });
        }
        if (dc.de > dc.ate || dc.de < 1 || dc.ate > nQ) {
          return res.status(400).json({
            error: `Faixa de questões inválida para ${dc.nome || "disciplina"}: ${dc.de}–${dc.ate}.`,
          });
        }
      }
    }

    // Determinar status inicial
    const status = gabarito_oficial && Array.isArray(gabarito_oficial) && gabarito_oficial.length === nQ
      ? "publicada"
      : "rascunho";

    const [result] = await pool.query(
      `INSERT INTO gabarito_avaliacoes 
       (escola_id, titulo, tipo, bimestre, num_questoes, num_alternativas, nota_total, 
        modelo, gabarito_oficial, disciplinas_config, turmas_ids, turno, status, criado_por, data_aplicacao)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        escola_id,
        titulo.trim(),
        tipo || null,
        bimestre || null,
        nQ,
        nA,
        Number(nota_total) || 10,
        modelo || "padrao",
        gabarito_oficial ? JSON.stringify(gabarito_oficial) : null,
        disciplinas_config ? JSON.stringify(disciplinas_config) : null,
        turmas_ids ? JSON.stringify(turmas_ids) : null,
        turno || null,
        status,
        userId,
        data_aplicacao || null,
      ]
    );

    // Retornar o registro criado
    const [created] = await pool.query(
      "SELECT * FROM gabarito_avaliacoes WHERE id = ?",
      [result.insertId]
    );
    const r = created[0];

    // ── PROPAGA data_aplicacao para os itens fixo_direcao do PAP ──────────────
    // Quando a direção cria um gabarito com data, essa data é automaticamente
    // preenchida no campo data_inicio do item Prova Bimestral de cada PAP
    // aprovado/enviado do mesmo bimestre na escola.
    if (data_aplicacao && bimestre) {
      try {
        const [propagado] = await pool.query(
          `UPDATE itens_avaliacao ia
           JOIN planos_avaliacao pa ON pa.id = ia.plano_id
           SET ia.data_inicio = ?, ia.data_final = ?
           WHERE pa.escola_id = ?
             AND pa.bimestre LIKE ?
             AND ia.fixo_direcao = 1`,
          [data_aplicacao, data_aplicacao, escola_id, `%${bimestre.replace(/[^\d]/g, '')}%`]
        );
        console.log(`[gabarito] Propagou data_aplicacao ${data_aplicacao} para ${propagado.affectedRows} item(ns) fixo_direcao`);
      } catch (propErr) {
        console.warn('[gabarito] Propagação de data_aplicacao falhou (não crítico):', propErr.message);
      }
    }

    res.status(201).json({
      ...r,
      gabarito_oficial: safeJson(r.gabarito_oficial),
      disciplinas_config: safeJson(r.disciplinas_config),
      turmas_ids: safeJson(r.turmas_ids),
    });
  } catch (err) {
    console.error("Erro ao criar avaliação:", err);
    res.status(500).json({ error: "Erro ao criar avaliação." });
  }
});

// ─── PUT /api/gabarito-avaliacoes/:id ────────────────────────────────────────
// Atualiza avaliação (ex: marcar gabarito oficial, alterar status)
router.put("/:id", async (req, res) => {
  try {
    const { escola_id } = req.user;
    const { id } = req.params;

    // Verificar se existe
    const [existing] = await pool.query(
      "SELECT id, status FROM gabarito_avaliacoes WHERE id = ? AND escola_id = ?",
      [id, escola_id]
    );
    if (existing.length === 0) {
      return res.status(404).json({ error: "Avaliação não encontrada." });
    }

    const {
      titulo,
      bimestre,
      num_questoes,
      num_alternativas,
      nota_total,
      modelo,
      gabarito_oficial,
      disciplinas_config,
      turmas_ids,
      turno,
      status,
    } = req.body;

    // Build dynamic SET clause
    const sets = [];
    const params = [];

    if (titulo !== undefined) { sets.push("titulo = ?"); params.push(titulo.trim()); }
    if (req.body.tipo !== undefined) { sets.push("tipo = ?"); params.push(req.body.tipo); }
    if (bimestre !== undefined) { sets.push("bimestre = ?"); params.push(bimestre); }
    if (num_questoes !== undefined) { sets.push("num_questoes = ?"); params.push(Number(num_questoes)); }
    if (num_alternativas !== undefined) { sets.push("num_alternativas = ?"); params.push(Number(num_alternativas)); }
    if (nota_total !== undefined) { sets.push("nota_total = ?"); params.push(Number(nota_total)); }
    if (modelo !== undefined) { sets.push("modelo = ?"); params.push(modelo); }
    if (gabarito_oficial !== undefined) {
      sets.push("gabarito_oficial = ?");
      params.push(gabarito_oficial ? JSON.stringify(gabarito_oficial) : null);
    }
    if (disciplinas_config !== undefined) {
      sets.push("disciplinas_config = ?");
      params.push(disciplinas_config ? JSON.stringify(disciplinas_config) : null);
    }
    if (turmas_ids !== undefined) {
      sets.push("turmas_ids = ?");
      params.push(turmas_ids ? JSON.stringify(turmas_ids) : null);
    }
    if (turno !== undefined) { sets.push("turno = ?"); params.push(turno); }
    if (status !== undefined) { sets.push("status = ?"); params.push(status); }
    if (req.body.data_aplicacao !== undefined) {
      sets.push("data_aplicacao = ?");
      params.push(req.body.data_aplicacao || null);
    }

    // Auto-update status when gabarito_oficial is set
    if (gabarito_oficial && !status) {
      const nQ = num_questoes || existing[0].num_questoes;
      if (Array.isArray(gabarito_oficial) && gabarito_oficial.length > 0) {
        sets.push("status = ?");
        params.push("publicada");
      }
    }

    if (sets.length === 0) {
      return res.status(400).json({ error: "Nenhum campo para atualizar." });
    }

    params.push(id, escola_id);
    await pool.query(
      `UPDATE gabarito_avaliacoes SET ${sets.join(", ")} WHERE id = ? AND escola_id = ?`,
      params
    );

    // Return updated record
    const [updated] = await pool.query(
      "SELECT * FROM gabarito_avaliacoes WHERE id = ?",
      [id]
    );
    const r = updated[0];

    res.json({
      ...r,
      gabarito_oficial: safeJson(r.gabarito_oficial),
      disciplinas_config: safeJson(r.disciplinas_config),
      turmas_ids: safeJson(r.turmas_ids),
    });
  } catch (err) {
    console.error("Erro ao atualizar avaliação:", err);
    res.status(500).json({ error: "Erro ao atualizar avaliação." });
  }
});

// ─── DELETE /api/gabarito-avaliacoes/:id ──────────────────────────────────────
router.delete("/:id", async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const { escola_id } = req.user;
    const { id } = req.params;

    // Verificar se a avaliação existe
    const [existing] = await conn.query(
      "SELECT id FROM gabarito_avaliacoes WHERE id = ? AND escola_id = ?",
      [id, escola_id]
    );
    if (existing.length === 0) {
      await conn.rollback(); conn.release();
      return res.status(404).json({ error: "Avaliação não encontrada." });
    }

    // 1. Buscar lotes vinculados
    const [lotes] = await conn.query(
      "SELECT id FROM gabarito_lotes WHERE avaliacao_id = ? AND escola_id = ?",
      [id, escola_id]
    );
    const loteIds = lotes.map(l => l.id);

    // 2. Excluir arquivos dos lotes
    if (loteIds.length > 0) {
      await conn.query(
        `DELETE FROM gabarito_lote_arquivos WHERE lote_id IN (${loteIds.map(() => "?").join(",")})`,
        loteIds
      );
    }

    // 3. Excluir lotes
    await conn.query(
      "DELETE FROM gabarito_lotes WHERE avaliacao_id = ? AND escola_id = ?",
      [id, escola_id]
    );

    // 4. Excluir respostas (gabarito_respostas)
    await conn.query(
      "DELETE FROM gabarito_respostas WHERE avaliacao_id = ? AND escola_id = ?",
      [id, escola_id]
    );

    // 5. Excluir a avaliação (qualquer status)
    await conn.query(
      "DELETE FROM gabarito_avaliacoes WHERE id = ? AND escola_id = ?",
      [id, escola_id]
    );

    await conn.commit();
    conn.release();

    res.json({ ok: true, message: "Avaliação excluída com sucesso." });
  } catch (err) {
    await conn.rollback();
    conn.release();
    console.error("Erro ao excluir avaliação:", err);
    res.status(500).json({ error: "Erro ao excluir avaliação." });
  }
});

// ─── GET /api/gabarito-avaliacoes/:id/status-importacao ──────────────────────
// Verifica se todos os lotes estão finalizados e se já houve importação
router.get("/:id/status-importacao", async (req, res) => {
  try {
    const { escola_id } = req.user;
    const { id } = req.params;

    // Buscar avaliação
    const [avRows] = await pool.query(
      "SELECT id, tipo, bimestre, status, disciplinas_config, nota_total FROM gabarito_avaliacoes WHERE id = ? AND escola_id = ?",
      [id, escola_id]
    );
    if (avRows.length === 0) {
      return res.status(404).json({ error: "Avaliação não encontrada." });
    }
    const av = avRows[0];
    const discConfig = safeJson(av.disciplinas_config);

    // Verificar se é prova padronizada
    const isPadronizada = av.tipo === "prova_padronizada";

    // Buscar lotes vinculados a esta avaliação
    const [lotes] = await pool.query(
      "SELECT id, turma_nome, status, total_arquivos, total_corrigidos FROM gabarito_lotes WHERE avaliacao_id = ? AND escola_id = ?",
      [id, escola_id]
    );

    const totalLotes = lotes.length;
    const lotesFinalizados = lotes.filter(l => l.status === "finalizado").length;
    const todosFinalizados = totalLotes > 0 && lotesFinalizados === totalLotes;

    // Contar respostas disponíveis
    const [[{ total_respostas }]] = await pool.query(
      "SELECT COUNT(*) AS total_respostas FROM gabarito_respostas WHERE avaliacao_id = ? AND escola_id = ?",
      [id, escola_id]
    );

    // Verificar se já importou (status da avaliação)
    const jaImportou = av.status === "notas_importadas";

    res.json({
      pronta: isPadronizada && todosFinalizados && !jaImportou && totalLotes > 0,
      isPadronizada,
      totalLotes,
      lotesFinalizados,
      todosFinalizados,
      totalRespostas: total_respostas,
      jaImportou,
      temDisciplinas: Array.isArray(discConfig) && discConfig.length > 0,
      disciplinas: discConfig || [],
      bimestre: av.bimestre,
      notaTotal: av.nota_total,
    });
  } catch (err) {
    console.error("Erro ao verificar status de importação:", err);
    res.status(500).json({ error: "Erro ao verificar status de importação." });
  }
});

// ─── POST /api/gabarito-avaliacoes/:id/importar-notas ────────────────────────
// Importa notas do Provão Bimestral para a tabela `notas_diario` (diário do professor)
// - Nome da disciplina SEMPRE vem da tabela `disciplinas` (padrão do secretário)
// - Escreve na coluna Provão Bimestral (fixo_direcao=1, item_idx=0) do PAP de cada professor
// - NÃO escreve em `notas` — boletim será alimentado quando o professor fechar o diário
// - Nota é escalada: (nota_gabarito / nota_max_gabarito) × nota_total_item_PAP
router.post("/:id/importar-notas", async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const { escola_id } = req.user;
    const { id } = req.params;

    // ── 1. Buscar avaliação ────────────────────────────────────────────────
    const [avRows] = await conn.query(
      "SELECT * FROM gabarito_avaliacoes WHERE id = ? AND escola_id = ?",
      [id, escola_id]
    );
    if (avRows.length === 0) {
      await conn.rollback(); conn.release();
      return res.status(404).json({ error: "Avaliação não encontrada." });
    }
    const av = avRows[0];
    const notaMaxGabarito = Number(av.nota_total) || 10;

    // ── 2. Validar tipo ────────────────────────────────────────────────────
    if (av.tipo !== "prova_padronizada") {
      await conn.rollback(); conn.release();
      return res.status(400).json({ error: "Apenas avaliações do tipo 'Prova Padronizada' podem ter notas importadas para o diário." });
    }

    // ── 3. Enriquecer disciplinas_config — nome SEMPRE da tabela disciplinas ─
    const discConfigRaw = safeJson(av.disciplinas_config);
    if (!Array.isArray(discConfigRaw) || discConfigRaw.length === 0) {
      await conn.rollback(); conn.release();
      return res.status(400).json({ error: "Esta avaliação não possui disciplinas configuradas." });
    }

    const discConfig = [];
    for (const dc of discConfigRaw) {
      if (!dc.disciplina_id) continue;
      const [[discRow]] = await conn.query(
        "SELECT id, nome FROM disciplinas WHERE id = ? AND escola_id = ?",
        [dc.disciplina_id, escola_id]
      );
      if (!discRow) {
        await conn.rollback(); conn.release();
        return res.status(400).json({ error: `Disciplina ID ${dc.disciplina_id} não encontrada na tabela de disciplinas. Verifique o cadastro com o secretário.` });
      }
      discConfig.push({ ...dc, nome: discRow.nome, disciplinaId: discRow.id });
    }

    // ── 4. Converter bimestre ──────────────────────────────────────────────
    const bimestreNum = parseBimestre(av.bimestre);
    if (!bimestreNum) {
      await conn.rollback(); conn.release();
      return res.status(400).json({ error: `Bimestre inválido: "${av.bimestre}".` });
    }

    // ── 5. Verificar lotes finalizados ─────────────────────────────────────
    const [lotes] = await conn.query(
      "SELECT id, status, turma_nome FROM gabarito_lotes WHERE avaliacao_id = ? AND escola_id = ?",
      [id, escola_id]
    );
    if (lotes.length === 0) {
      await conn.rollback(); conn.release();
      return res.status(400).json({ error: "Nenhum lote encontrado para esta avaliação." });
    }
    const lotesNaoFinalizados = lotes.filter(l => l.status !== "finalizado");
    if (lotesNaoFinalizados.length > 0) {
      const turmasNomes = lotesNaoFinalizados.map(l => l.turma_nome).join(", ");
      await conn.rollback(); conn.release();
      return res.status(400).json({ error: `Os seguintes lotes ainda não foram finalizados: ${turmasNomes}. Finalize a correção antes de importar.` });
    }

    // ── 6. Buscar respostas corrigidas ─────────────────────────────────────
    const [respostas] = await conn.query(
      "SELECT codigo_aluno, nome_aluno, nota, turma_id, turma_nome FROM gabarito_respostas WHERE avaliacao_id = ? AND escola_id = ?",
      [id, escola_id]
    );
    if (respostas.length === 0) {
      await conn.rollback(); conn.release();
      return res.status(400).json({ error: "Nenhuma resposta de aluno encontrada para esta avaliação." });
    }

    // ── 7. Cache: PAP por (disciplina + turma) ─────────────────────────────
    // Usa CONVERT/COLLATE para evitar Error 1267 (Illegal mix of collations)
    const papCache = new Map();
    async function resolverPAP(discNome, turmaNome) {
      const key = `${discNome}::${turmaNome}`;
      if (papCache.has(key)) return papCache.get(key);

      const [rows] = await conn.query(
        `SELECT pa.id AS plano_id, ia.nota_total AS item_nota_total
         FROM planos_avaliacao pa
         JOIN itens_avaliacao ia ON ia.plano_id = pa.id AND ia.fixo_direcao = 1
         WHERE pa.escola_id = ?
           AND CONVERT(pa.disciplina USING utf8mb4) COLLATE utf8mb4_unicode_ci
               = CONVERT(? USING utf8mb4) COLLATE utf8mb4_unicode_ci
           AND CONVERT(pa.turmas USING utf8mb4) COLLATE utf8mb4_unicode_ci
               = CONVERT(? USING utf8mb4) COLLATE utf8mb4_unicode_ci
           AND pa.bimestre LIKE ?
           AND pa.status IN ('APROVADO', 'ENVIADO')
         ORDER BY ia.id ASC
         LIMIT 1`,
        [escola_id, discNome, turmaNome, `${bimestreNum}%`]
      );

      const result = rows.length > 0 ? rows[0] : null;
      papCache.set(key, result);
      return result;
    }

    // ── 8. Cache: turma_id numérico por nome ──────────────────────────────
    const turmaIdCache = new Map();
    async function resolverTurmaId(resp) {
      const numId = Number(resp.turma_id);
      if (numId && numId > 0) return numId; // already a valid FK

      const nome = resp.turma_nome;
      if (turmaIdCache.has(nome)) return turmaIdCache.get(nome);

      const [[row]] = await conn.query(
        `SELECT id FROM turmas
         WHERE escola_id = ?
           AND CONVERT(nome USING utf8mb4) COLLATE utf8mb4_unicode_ci
               = CONVERT(? USING utf8mb4) COLLATE utf8mb4_unicode_ci
         LIMIT 1`,
        [escola_id, nome]
      );
      const resolved = row?.id || null;
      turmaIdCache.set(nome, resolved);
      return resolved;
    }

    // ── 9. Processar cada aluno ────────────────────────────────────────────
    let totalInseridos = 0;
    let totalAtualizados = 0;
    const erros = [];
    const avisos = [];
    const alunosProcessados = [];

    for (const resp of respostas) {
      if (!resp.codigo_aluno || resp.codigo_aluno.startsWith("ARQ_")) {
        erros.push({ codigo: resp.codigo_aluno, motivo: "Aluno não identificado (sem QR Code)" });
        continue;
      }

      const [[alunoRow]] = await conn.query(
        "SELECT id, estudante FROM alunos WHERE codigo = ? AND escola_id = ?",
        [resp.codigo_aluno, escola_id]
      );
      if (!alunoRow) {
        erros.push({ codigo: resp.codigo_aluno, nome: resp.nome_aluno, motivo: "Aluno não encontrado na base de dados" });
        continue;
      }

      const alunoId = alunoRow.id;
      const notaGabarito = Number(resp.nota) || 0;

      const turmaNumericalId = await resolverTurmaId(resp);
      if (!turmaNumericalId) {
        erros.push({ codigo: resp.codigo_aluno, nome: resp.nome_aluno, motivo: `Turma "${resp.turma_nome}" não encontrada` });
        continue;
      }

      let alunoImportou = false;

      for (const dc of discConfig) {
        const pap = await resolverPAP(dc.nome, resp.turma_nome);

        if (!pap) {
          const avisoKey = `${dc.nome}::${resp.turma_nome}`;
          if (!avisos.find(a => a.chave === avisoKey)) {
            avisos.push({
              chave: avisoKey,
              disciplina: dc.nome,
              turma: resp.turma_nome,
              motivo: `PAP não encontrado para ${dc.nome} / ${resp.turma_nome} / ${av.bimestre} (status APROVADO ou ENVIADO)`,
            });
          }
          continue;
        }

        // Escalar nota: aluno tirou X/nota_max_gabarito → converte para escala do PAP
        // Ex: 7/10 no gabarito, PAP Provão vale 5.0 → nota_diario = (7/10) × 5 = 3.50
        const notaItemPAP = Number(pap.item_nota_total) || 5;
        const notaEscalada = parseFloat(((notaGabarito / notaMaxGabarito) * notaItemPAP).toFixed(2));

        // item_idx=0 (Provão Bimestral é sempre o 1º item do PAP — confirmado via BD)
        // oportunidade_idx=0 (única oportunidade do Provão)
        const [result] = await conn.query(
          `INSERT INTO notas_diario
             (escola_id, plano_id, turma_id, aluno_id, item_idx, oportunidade_idx, nota, updated_at)
           VALUES (?, ?, ?, ?, 0, 0, ?, NOW())
           ON DUPLICATE KEY UPDATE nota = VALUES(nota), updated_at = NOW()`,
          [escola_id, pap.plano_id, turmaNumericalId, alunoId, notaEscalada]
        );

        if (result.affectedRows === 1) totalInseridos++;
        else if (result.affectedRows === 2) totalAtualizados++;
        alunoImportou = true;
      }

      if (alunoImportou) {
        alunosProcessados.push({
          codigo: resp.codigo_aluno,
          nome: resp.nome_aluno || alunoRow.estudante,
          nota: notaGabarito,
          turma: resp.turma_nome,
        });
      }
    }

    // ── 10. Atualizar status da avaliação ──────────────────────────────────
    await conn.query(
      "UPDATE gabarito_avaliacoes SET status = 'notas_importadas' WHERE id = ? AND escola_id = ?",
      [id, escola_id]
    );

    await conn.commit();
    conn.release();

    console.log(`[importar-notas] Avaliação #${id}: ${alunosProcessados.length} alunos, ${totalInseridos} inseridas, ${totalAtualizados} atualizadas, ${avisos.length} avisos, ${erros.length} erros`);

    const discNomes = discConfig.map(dc => dc.nome).join(", ");
    res.json({
      success: true,
      message: `Importação concluída! ${alunosProcessados.length} aluno(s) importado(s) para ${discConfig.length} disciplina(s) no diário.`,
      resumo: {
        totalAlunos: respostas.length,
        alunosImportados: alunosProcessados.length,
        totalNotas: totalInseridos + totalAtualizados,
        notasInseridas: totalInseridos,
        notasAtualizadas: totalAtualizados,
        disciplinas: discNomes,
        bimestre: av.bimestre,
        erros: erros.length,
        avisos: avisos.length,
        detalheErros: erros,
        detalheAvisos: avisos,
      },
    });
  } catch (err) {
    await conn.rollback();
    conn.release();
    console.error("Erro ao importar notas para o diário:", err);
    res.status(500).json({ error: "Erro ao importar notas para o diário. A operação foi revertida." });
  }
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Converte texto de bimestre para número
 * "1º Bimestre" → 1, "2º Bimestre" → 2, etc.
 */
function parseBimestre(bimestreStr) {
  if (!bimestreStr) return null;
  const match = bimestreStr.match(/(\d)/);
  if (match) {
    const num = parseInt(match[1], 10);
    if (num >= 1 && num <= 4) return num;
  }
  return null;
}

function safeJson(val) {
  if (!val) return null;
  if (typeof val === "object") return val;
  try {
    return JSON.parse(val);
  } catch {
    return null;
  }
}

/**
 * Recalcula em lote todas as respostas de uma avaliação aplicando as questões canceladas.
 * Deve ser chamado dentro de uma transação existente (conn).
 *
 * Modos:
 *   "bonificar"     → todos ganham o ponto desta questão
 *   "desconsiderar" → questão excluída do total (nota / N-1 questões)
 */
async function recalcularRespostasEmLote(conn, avaliacaoId, escola_id) {
  // Buscar avaliação com gabarito oficial + questões canceladas
  const [[av]] = await conn.query(
    `SELECT gabarito_oficial, num_questoes, nota_total, disciplinas_config, questoes_canceladas
     FROM gabarito_avaliacoes WHERE id = ? AND escola_id = ?`,
    [avaliacaoId, escola_id]
  );
  if (!av) throw new Error("Avaliação não encontrada no recálculo.");

  const gabOficial       = safeJson(av.gabarito_oficial) || [];
  const numQuestoes      = av.num_questoes || gabOficial.length;
  const notaTotal        = Number(av.nota_total) || 10;
  const disciplinasConfig = safeJson(av.disciplinas_config) || [];
  const canceladas       = safeJson(av.questoes_canceladas) || [];

  // Indexar cancelamentos por número de questão
  const cancelMap = {};
  for (const c of canceladas) {
    cancelMap[c.numero] = c.modo; // "bonificar" | "desconsiderar"
  }

  // Contar questões efetivas (excluindo as desconsideradas)
  const numDesconsideradas = canceladas.filter(c => c.modo === "desconsiderar").length;
  const numQuestoesEfetivas = Math.max(1, numQuestoes - numDesconsideradas);

  // Buscar todas as respostas desta avaliação
  const [respostas] = await conn.query(
    `SELECT id, codigo_aluno, respostas_aluno
     FROM gabarito_respostas WHERE avaliacao_id = ? AND escola_id = ?`,
    [avaliacaoId, escola_id]
  );

  let totalAtualizados = 0;

  for (const resp of respostas) {
    const respostasAluno = safeJson(resp.respostas_aluno) || [];
    const detalhes = [];

    for (let i = 0; i < numQuestoes; i++) {
      const questaoNum = i + 1;
      const modo = cancelMap[questaoNum];

      if (modo === "desconsiderar") continue; // pula — não entra no cálculo

      if (modo === "bonificar") {
        // Todos ganham o ponto independente da resposta
        detalhes.push({
          numero: questaoNum,
          resposta: respostasAluno[i] || null,
          correto: gabOficial[i] || "",
          acertou: true,
          cancelada: "bonificada",
        });
        continue;
      }

      // Questão normal
      const resp_aluno = respostasAluno[i] || null;
      const correto    = gabOficial[i] || "";
      const isNulo     = resp_aluno === "N";
      detalhes.push({
        numero: questaoNum,
        resposta: resp_aluno,
        correto,
        acertou: !isNulo && resp_aluno !== null && resp_aluno === correto,
      });
    }

    const acertos      = detalhes.filter(d => d.acertou).length;
    const valorQuestao = notaTotal / numQuestoesEfetivas;
    const nota         = parseFloat((acertos * valorQuestao).toFixed(2));

    // Acertos por disciplina (exclui questões desconsideradas)
    let acertosPorDisciplina = null;
    if (disciplinasConfig.length > 0) {
      acertosPorDisciplina = disciplinasConfig.map(dc => {
        const questoesDc = detalhes.filter(d => d.numero >= dc.de && d.numero <= dc.ate);
        return {
          nome: dc.nome,
          disciplina_id: dc.disciplina_id,
          de: dc.de,
          ate: dc.ate,
          total: questoesDc.length,
          acertos: questoesDc.filter(d => d.acertou).length,
        };
      });
    }

    await conn.query(
      `UPDATE gabarito_respostas
       SET acertos = ?, total_questoes = ?, nota = ?, detalhes = ?, acertos_por_disciplina = ?
       WHERE id = ?`,
      [
        acertos,
        numQuestoesEfetivas,
        nota,
        JSON.stringify(detalhes),
        acertosPorDisciplina ? JSON.stringify(acertosPorDisciplina) : null,
        resp.id,
      ]
    );
    totalAtualizados++;
  }

  // Atualizar gabarito_arquivos também (para nota exibida no lote do professor)
  // Faz JOIN via lote para garantir escola correta
  await conn.query(
    `UPDATE gabarito_arquivos ga
     JOIN gabarito_lotes gl ON gl.id = ga.lote_id
     SET ga.nota = (
       SELECT gr.nota FROM gabarito_respostas gr
       WHERE gr.avaliacao_id = gl.avaliacao_id
         AND gr.codigo_aluno = ga.codigo_aluno
         AND gr.escola_id = ?
       LIMIT 1
     )
     WHERE gl.avaliacao_id = ? AND ga.status = 'corrigido'`,
    [escola_id, avaliacaoId]
  );

  return { totalAtualizados, numQuestoesEfetivas, canceladas };
}

// ─── PUT /api/gabarito-avaliacoes/:id/cancelar-questao ────────────────────────
// Registra o cancelamento de uma questão e recalcula TODAS as notas em lote.
// Governança: apenas coordenador, diretor, vice_diretor, supervisor
router.put("/:id/cancelar-questao", async (req, res) => {
  // Verificar perfil (governança)
  const perfilUsuario = (req.user?.perfil || "").toLowerCase();
  const perfisPermitidos = ["coordenador", "diretor", "vice_diretor", "supervisor", "admin"];
  if (!perfisPermitidos.includes(perfilUsuario)) {
    return res.status(403).json({
      error: "Apenas coordenador, diretor ou supervisor podem cancelar questões.",
    });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const { escola_id } = req.user;
    const userId = req.user.id || req.user.userId;
    const { id } = req.params;
    const { numero, modo, motivo } = req.body;

    // Validações
    const numQ = Number(numero);
    if (!numQ || numQ < 1) {
      await conn.rollback(); conn.release();
      return res.status(400).json({ error: "Número da questão inválido." });
    }
    if (!["bonificar", "desconsiderar"].includes(modo)) {
      await conn.rollback(); conn.release();
      return res.status(400).json({ error: "Modo deve ser 'bonificar' ou 'desconsiderar'." });
    }

    // Verificar avaliação
    const [[av]] = await conn.query(
      "SELECT id, num_questoes, questoes_canceladas, status FROM gabarito_avaliacoes WHERE id = ? AND escola_id = ?",
      [id, escola_id]
    );
    if (!av) {
      await conn.rollback(); conn.release();
      return res.status(404).json({ error: "Avaliação não encontrada." });
    }
    if (numQ > av.num_questoes) {
      await conn.rollback(); conn.release();
      return res.status(400).json({ error: `Questão ${numQ} não existe (avaliação tem ${av.num_questoes} questões).` });
    }

    // Montar array de cancelamentos (merge com existentes)
    const canceladas = safeJson(av.questoes_canceladas) || [];
    const idx = canceladas.findIndex(c => c.numero === numQ);

    const novoItem = {
      numero: numQ,
      modo,
      motivo: motivo?.trim() || null,
      cancelado_em: new Date().toISOString(),
      cancelado_por: userId,
    };

    if (idx >= 0) {
      canceladas[idx] = novoItem; // atualiza existente
    } else {
      canceladas.push(novoItem);
    }
    canceladas.sort((a, b) => a.numero - b.numero);

    // Gravar no BD
    await conn.query(
      "UPDATE gabarito_avaliacoes SET questoes_canceladas = ? WHERE id = ? AND escola_id = ?",
      [JSON.stringify(canceladas), id, escola_id]
    );

    // Recalcular todas as respostas em lote
    const resultado = await recalcularRespostasEmLote(conn, id, escola_id);

    await conn.commit();
    conn.release();

    console.log(
      `[cancelar-questao] Avaliação #${id}: questão ${numQ} (${modo}). ` +
      `${resultado.totalAtualizados} alunos recalculados. Total efetivo: ${resultado.numQuestoesEfetivas} questões.`
    );

    res.json({
      ok: true,
      questao_cancelada: novoItem,
      questoes_canceladas: canceladas,
      total_recalculados: resultado.totalAtualizados,
      num_questoes_efetivas: resultado.numQuestoesEfetivas,
    });
  } catch (err) {
    await conn.rollback();
    conn.release();
    console.error("Erro ao cancelar questão:", err);
    res.status(500).json({ error: "Erro ao cancelar questão. A operação foi revertida." });
  }
});

// ─── GET /api/gabarito-avaliacoes/:id/questoes-canceladas ─────────────────────
// Lista as questões canceladas de uma avaliação
router.get("/:id/questoes-canceladas", async (req, res) => {
  try {
    const { escola_id } = req.user;
    const { id } = req.params;

    const [[av]] = await pool.query(
      "SELECT id, num_questoes, nota_total, questoes_canceladas FROM gabarito_avaliacoes WHERE id = ? AND escola_id = ?",
      [id, escola_id]
    );
    if (!av) return res.status(404).json({ error: "Avaliação não encontrada." });

    const canceladas = safeJson(av.questoes_canceladas) || [];

    // Enriquecer com nome do usuário que cancelou
    const enriquecidas = [];
    for (const c of canceladas) {
      let cancelado_por_nome = null;
      if (c.cancelado_por) {
        const [[u]] = await pool.query("SELECT nome FROM usuarios WHERE id = ?", [c.cancelado_por]);
        cancelado_por_nome = u?.nome || null;
      }
      enriquecidas.push({ ...c, cancelado_por_nome });
    }

    const numDesconsideradas = canceladas.filter(c => c.modo === "desconsiderar").length;

    res.json({
      avaliacao_id: av.id,
      num_questoes_original: av.num_questoes,
      num_questoes_efetivas: Math.max(1, av.num_questoes - numDesconsideradas),
      nota_total: av.nota_total,
      questoes_canceladas: enriquecidas,
    });
  } catch (err) {
    console.error("Erro ao listar questões canceladas:", err);
    res.status(500).json({ error: "Erro ao listar questões canceladas." });
  }
});

// ─── DELETE /api/gabarito-avaliacoes/:id/cancelar-questao/:numero ─────────────
// Reverte o cancelamento de uma questão e recalcula todas as notas em lote.
// Governança: apenas coordenador, diretor, vice_diretor, supervisor
router.delete("/:id/cancelar-questao/:numero", async (req, res) => {
  // Verificar perfil (governança)
  const perfilUsuario = (req.user?.perfil || "").toLowerCase();
  const perfisPermitidos = ["coordenador", "diretor", "vice_diretor", "supervisor", "admin"];
  if (!perfisPermitidos.includes(perfilUsuario)) {
    return res.status(403).json({
      error: "Apenas coordenador, diretor ou supervisor podem reverter cancelamentos.",
    });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const { escola_id } = req.user;
    const { id, numero } = req.params;
    const numQ = Number(numero);

    const [[av]] = await conn.query(
      "SELECT id, num_questoes, questoes_canceladas FROM gabarito_avaliacoes WHERE id = ? AND escola_id = ?",
      [id, escola_id]
    );
    if (!av) {
      await conn.rollback(); conn.release();
      return res.status(404).json({ error: "Avaliação não encontrada." });
    }

    const canceladas = safeJson(av.questoes_canceladas) || [];
    const novaLista = canceladas.filter(c => c.numero !== numQ);

    if (novaLista.length === canceladas.length) {
      await conn.rollback(); conn.release();
      return res.status(404).json({ error: `Questão ${numQ} não está cancelada.` });
    }

    // Gravar lista atualizada
    await conn.query(
      "UPDATE gabarito_avaliacoes SET questoes_canceladas = ? WHERE id = ? AND escola_id = ?",
      [novaLista.length > 0 ? JSON.stringify(novaLista) : null, id, escola_id]
    );

    // Recalcular todas as respostas em lote (sem o cancelamento revertido)
    const resultado = await recalcularRespostasEmLote(conn, id, escola_id);

    await conn.commit();
    conn.release();

    console.log(
      `[cancelar-questao] Avaliação #${id}: cancelamento da questão ${numQ} REVERTIDO. ` +
      `${resultado.totalAtualizados} alunos recalculados.`
    );

    res.json({
      ok: true,
      questao_revertida: numQ,
      questoes_canceladas: novaLista,
      total_recalculados: resultado.totalAtualizados,
      num_questoes_efetivas: resultado.numQuestoesEfetivas,
    });
  } catch (err) {
    await conn.rollback();
    conn.release();
    console.error("Erro ao reverter cancelamento:", err);
    res.status(500).json({ error: "Erro ao reverter cancelamento. A operação foi revertida." });
  }
});

export default router;
