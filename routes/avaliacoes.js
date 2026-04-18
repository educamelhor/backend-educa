import express from "express";
import pool from "../db.js";

const router = express.Router();

/** Converte ISO timestamp (ex: '2026-02-23T03:00:00.000Z') para DATE 'YYYY-MM-DD' */
function toDateOnly(val) {
  if (!val) return null;
  const s = String(val).trim();
  // Já está no formato YYYY-MM-DD?
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // ISO ou datetime — extrai apenas a parte date
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function anoLetivoPadrao() {
  const hoje = new Date();
  const mes = hoje.getMonth() + 1;
  return mes <= 1 ? hoje.getFullYear() - 1 : hoje.getFullYear();
}

/**
 * RECALL — Verifica se há itens de avaliação sem tipo_avaliacao preenchido
 * Retorna a lista de planos afetados para que o professor atualize.
 * Rota DEVE vir antes de /:id para não ser capturada como parâmetro.
 */
router.get("/recall/check", async (req, res) => {
  try {
    const { escola_id, usuario_id } = req.user;

    const [pendentes] = await pool.query(
      `SELECT DISTINCT
         pa.id AS plano_id,
         pa.turmas,
         pa.disciplina,
         pa.bimestre,
         pa.status,
         COUNT(ia.id) AS itens_sem_tipo
       FROM itens_avaliacao ia
       JOIN planos_avaliacao pa ON pa.id = ia.plano_id
       WHERE pa.escola_id = ?
         AND pa.usuario_id = ?
         AND (ia.tipo_avaliacao IS NULL OR ia.tipo_avaliacao = '')
       GROUP BY pa.id
       ORDER BY pa.disciplina, pa.turmas`,
      [escola_id, usuario_id]
    );

    return res.json({
      ok: true,
      pendente: pendentes.length > 0,
      total_planos: pendentes.length,
      total_itens: pendentes.reduce((acc, p) => acc + p.itens_sem_tipo, 0),
      planos: pendentes,
    });
  } catch (error) {
    console.error("Erro ao verificar recall:", error);
    return res.status(500).json({ ok: false, error: "Erro interno." });
  }
});

/**
 * GET /api/avaliacoes/me
 * Retorna os planos de avaliação DO professor logado (por CPF do token).
 * Usa JOIN via modulação — único método confiável:
 *   planos_avaliacao.turmas → turmas.nome → modulacao.turma_id → professores.cpf
 *   planos_avaliacao.disciplina → disciplinas.nome → modulacao.disciplina_id
 * Parâmetros opcionais: ?ano=2026 &bimestre=1º Bimestre
 */
router.get("/me", async (req, res) => {
  try {
    const { escola_id } = req.user;
    const { ano, bimestre } = req.query;

    // Resolve CPF do professor logado (mesmo padrão dos outros /me endpoints)
    let cpf = req.user?.cpf;
    const userId =
      req.user?.id || req.user?.usuario_id || req.user?.userId ||
      req.user?.usuarioId || req.user?.user_id || req.user?.id_usuario;

    if (!cpf && userId) {
      const [urows] = await pool.query(
        "SELECT cpf FROM usuarios WHERE id = ? LIMIT 1", [userId]
      );
      cpf = urows?.[0]?.cpf ? String(urows[0].cpf) : null;
    }

    if (!escola_id || !cpf) {
      return res.status(400).json({ ok: false, message: "Token inválido: escola ou cpf ausente." });
    }

    const cleanCpf = String(cpf).replace(/\D/g, "");
    const anoParam = ano ? Number(ano) : new Date().getFullYear();

    // ── Passo 1: turmas e disciplinas DO professor neste ano (via modulação) ──────────────
    // Usa turmas.ano para garantir que são turmas do ano letivo correto.
    const [vinculos] = await pool.query(
      `SELECT DISTINCT
         t.nome  AS turma_nome,
         d.nome  AS disc_nome
       FROM modulacao m
       JOIN professores p  ON p.id  = m.professor_id AND p.escola_id = ?
       JOIN turmas t       ON t.id  = m.turma_id
       JOIN disciplinas d  ON d.id  = m.disciplina_id
       WHERE REPLACE(REPLACE(p.cpf, '.', ''), '-', '') = ?
         AND t.escola_id = ?
         AND t.ano       = ?`,
      [escola_id, cleanCpf, escola_id, anoParam]
    );

    if (vinculos.length === 0) {
      return res.json({ ok: true, planos: [] });
    }

    const turmaNames = [...new Set(vinculos.map(v => v.turma_nome))];
    const discNames  = [...new Set(vinculos.map(v => v.disc_nome))];

    // ── Passo 2: planos da escola que cruzam as turmas e disciplinas acima ───────────────
    const placeholdersTurmas = turmaNames.map(() => "?").join(", ");
    const placeholdersDisc   = discNames.map(() => "?").join(", ");

    let sql = `
      SELECT * FROM planos_avaliacao
      WHERE escola_id  = ?
        AND ano        = ?
        AND turmas     IN (${placeholdersTurmas})
        AND disciplina IN (${placeholdersDisc})
    `;
    const params = [escola_id, anoParam, ...turmaNames, ...discNames];

    if (bimestre) {
      sql += ` AND bimestre = ?`;
      params.push(bimestre);
    }

    sql += ` ORDER BY disciplina, turmas`;

    const [planos] = await pool.query(sql, params);
    return res.json({ ok: true, planos });

  } catch (err) {
    console.error("Erro ao buscar planos do professor (avaliacoes/me):", err);
    return res.status(500).json({ ok: false, error: "Erro interno." });
  }
});

/**
 * 1) GET /api/avaliacoes
 * Busca todos os planos de avaliação de uma escola, opcionalmente filtrando por ano, disciplina, bimestre.
 */
router.get("/", async (req, res) => {
  try {
    const { escola_id } = req.user;
    const { ano, disciplina, bimestre } = req.query;

    let sql = `SELECT * FROM planos_avaliacao WHERE escola_id = ?`;
    const params = [escola_id];

    if (ano) {
      sql += ` AND ano = ?`;
      params.push(ano);
    }
    if (disciplina) {
      sql += ` AND disciplina = ?`;
      params.push(disciplina);
    }
    if (bimestre) {
      sql += ` AND bimestre = ?`;
      params.push(bimestre);
    }

    const [planos] = await pool.query(sql, params);
    return res.json(planos);
  } catch (error) {
    console.error("Erro ao listar planos:", error);
    return res.status(500).json({ error: "Erro interno do servidor." });
  }
});

/**
 * 2) GET /api/avaliacoes/solicitacoes/pendentes
 * Lista todos os PAPs com status ENVIADO (pendentes de aprovação pela Direção)
 * IMPORTANTE: esta rota DEVE vir antes de /:id para não ser capturada como parâmetro
 */
router.get("/solicitacoes/pendentes", async (req, res) => {
  try {
    const { escola_id } = req.user;
    const ano = req.query.ano || new Date().getFullYear();

    const [planos] = await pool.query(
      `SELECT
         pa.id,
         pa.disciplina,
         pa.bimestre,
         pa.turmas,
         pa.ano,
         pa.status,
         pa.nome_codigo,
         pa.usuario_id,
         pa.motivo_devolucao,
         pa.created_at,
         pa.updated_at,
         u.nome AS professor_nome,
         (SELECT p.foto FROM professores p
          WHERE p.cpf = u.cpf AND p.escola_id = pa.escola_id
          LIMIT 1) AS professor_foto
       FROM planos_avaliacao pa
       LEFT JOIN usuarios u ON u.id = pa.usuario_id
       WHERE pa.escola_id = ?
         AND pa.ano = ?
         AND pa.status IN ('ENVIADO', 'LIBERACAO_SOLICITADA')
       ORDER BY pa.updated_at DESC`,
      [escola_id, ano]
    );

    return res.json({ ok: true, solicitacoes: planos });
  } catch (error) {
    console.error("Erro ao listar solicitações pendentes:", error);
    return res.status(500).json({ ok: false, error: "Erro interno do servidor." });
  }
});

/**
 * SOLICITAR LIBERAÇÃO — Professor solicita desbloqueio de um PAP aprovado
 * Muda status de APROVADO -> LIBERACAO_SOLICITADA para a Direção ver
 */
router.post("/solicitar-liberacao/:id", async (req, res) => {
  try {
    const { escola_id, usuario_id } = req.user;
    const { id } = req.params;
    const { motivo } = req.body;

    const [[plano]] = await pool.query(
      `SELECT id, status FROM planos_avaliacao WHERE id = ? AND escola_id = ? AND usuario_id = ?`,
      [id, escola_id, usuario_id]
    );

    if (!plano) {
      return res.status(404).json({ ok: false, error: "Plano não encontrado." });
    }

    if (plano.status !== "APROVADO") {
      return res.status(400).json({ ok: false, error: `Apenas planos APROVADOS podem solicitar liberação. Status atual: ${plano.status}` });
    }

    await pool.query(
      `UPDATE planos_avaliacao SET status = 'LIBERACAO_SOLICITADA', motivo_devolucao = ?, updated_at = NOW() WHERE id = ?`,
      [motivo || "Professor solicitou liberação para edição.", id]
    );

    return res.json({ ok: true, message: "Solicitação de liberação registrada com sucesso." });
  } catch (error) {
    console.error("Erro ao solicitar liberação:", error);
    return res.status(500).json({ ok: false, error: "Erro interno do servidor." });
  }
});

/**
 * 3) GET /api/avaliacoes/:id
 * Busca um plano específico e seus itens
 */
router.get("/:id", async (req, res) => {
  try {
    const { escola_id } = req.user;
    const { id } = req.params;

    const [[plano]] = await pool.query(
      `SELECT * FROM planos_avaliacao WHERE id = ? AND escola_id = ?`,
      [id, escola_id]
    );

    if (!plano) {
      return res.status(404).json({ error: "Plano não encontrado." });
    }

    const [itens] = await pool.query(
      `SELECT * FROM itens_avaliacao WHERE plano_id = ?`,
      [id]
    );

    plano.itens = itens;
    return res.json(plano);
  } catch (error) {
    console.error("Erro ao buscar plano:", error);
    return res.status(500).json({ error: "Erro interno do servidor." });
  }
});

/**
 * 3) POST /api/avaliacoes
 * Cria ou atualiza (Upsert) um Plano e seus respectivos Itens
 *
 * ── PROTEÇÃO DE DADOS ───────────────────────────────────────────────────────
 * Se o plano já possui notas lançadas no diário (notas_diario), usamos modo
 * PROTEGIDO: UPSERT por nome de atividade preservando os IDs dos itens.
 * Isso garante que os item_idx referenciados em notas_diario permaneçam
 * válidos e que nenhuma nota seja corrompida ou perdida.
 *
 * Se não há notas, usa o comportamento clássico (DELETE + INSERT).
 * ────────────────────────────────────────────────────────────────────────────
 */
router.post("/", async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const { escola_id, usuario_id } = req.user;
    const {
      disciplina,
      bimestre,
      turmas,
      ano = anoLetivoPadrao(),
      nome_codigo,
      status = "RASCUNHO",
      itens = []
    } = req.body;

    // Vai desmembrar as turmas em planos individuais
    const turmasArray = Array.isArray(turmas) ? turmas : turmas.split("-");
    const planoIds = [];

    for (const turmaUnica of turmasArray) {
      let planoId;

      // Busca se já existe o plano especificamente para essa turma
      const [[existente]] = await conn.query(
        `SELECT id FROM planos_avaliacao 
         WHERE escola_id = ? AND ano = ? AND bimestre = ? AND disciplina = ? AND turmas = ?`,
        [escola_id, ano, bimestre, disciplina, turmaUnica]
      );

      // Cada turma recebe um nome de código individual
      const nomeCodigoIndividual = nome_codigo.replace(/-[UP]-/, `-U-`).replace("-BIM-P-", "-BIM-U-") + "-" + turmaUnica;

      if (existente) {
        planoId = existente.id;
        await conn.query(
          `UPDATE planos_avaliacao SET status = ?, nome_codigo = ?, usuario_id = ?, updated_at = NOW() WHERE id = ?`,
          [status, nomeCodigoIndividual, usuario_id, planoId]
        );
      } else {
        const [result] = await conn.query(
          `INSERT INTO planos_avaliacao 
            (escola_id, disciplina, bimestre, turmas, ano, status, nome_codigo, usuario_id) 
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [escola_id, disciplina, bimestre, turmaUnica, ano, status, nomeCodigoIndividual, usuario_id]
        );
        planoId = result.insertId;
      }

      planoIds.push(planoId);

      // ═══════════════════════════════════════════════════════════════
      // PROTEÇÃO DE DADOS: verificar se há notas já lançadas no diário
      // Se houver, usamos UPSERT por atividade (preserva IDs e notas).
      // Se não houver, o comportamento clássico DELETE+INSERT é seguro.
      // ═══════════════════════════════════════════════════════════════
      const [[{ total_notas }]] = await conn.query(
        `SELECT COUNT(*) AS total_notas FROM notas_diario WHERE plano_id = ?`,
        [planoId]
      );

      if (total_notas > 0) {
        // ── Modo PROTEGIDO: há notas lançadas ──────────────────────
        // Busca os itens atuais do plano com seus IDs (ordenados por id = ordem original)
        const [itensAtuais] = await conn.query(
          `SELECT id, atividade FROM itens_avaliacao WHERE plano_id = ? ORDER BY id ASC`,
          [planoId]
        );

        // Mapa: atividade (normalizada) → id atual
        const mapaAtual = {};
        for (const ia of itensAtuais) {
          mapaAtual[ia.atividade.trim().toLowerCase()] = ia.id;
        }

        // Nomes dos itens que vêm do frontend
        const nomesFrontend = itens.map(i => (i.atividade || "").trim().toLowerCase());

        // Itens do banco que o professor quer remover
        const itensParaRemover = itensAtuais.filter(
          ia => !nomesFrontend.includes(ia.atividade.trim().toLowerCase())
        );

        // Bloqueia remoção de itens que já têm notas lançadas
        for (const itemRemover of itensParaRemover) {
          const idx = itensAtuais.indexOf(itemRemover);
          const [[{ count_notas }]] = await conn.query(
            `SELECT COUNT(*) AS count_notas FROM notas_diario WHERE plano_id = ? AND item_idx = ?`,
            [planoId, idx]
          );
          if (count_notas > 0) {
            await conn.rollback();
            conn.release();
            return res.status(409).json({
              ok: false,
              error: `Não é possível remover a atividade "${itemRemover.atividade}" pois ela já possui ${count_notas} nota(s) lançada(s). Apenas o tipo de avaliação e outros campos podem ser atualizados sem remover a atividade.`,
              item_bloqueado: itemRemover.atividade,
            });
          }
        }

        // Remove apenas os itens SEM notas
        for (const itemRemover of itensParaRemover) {
          await conn.query(`DELETE FROM itens_avaliacao WHERE id = ?`, [itemRemover.id]);
        }

        // UPSERT: atualiza existentes, insere novos
        for (const item of itens) {
          const nomeNorm = (item.atividade || "").trim().toLowerCase();
          const itemId = mapaAtual[nomeNorm];

          if (itemId) {
            // Atualiza o item existente (preserva ID => preserva integridade das notas)
            await conn.query(
              `UPDATE itens_avaliacao
               SET tipo_avaliacao = ?,
                   data_inicio    = ?,
                   data_final     = ?,
                   nota_total     = ?,
                   oportunidades  = ?,
                   nota_invertida = ?,
                   descricao      = ?,
                   fixo_direcao   = ?
               WHERE id = ?`,
              [
                item.tipo_avaliacao || null,
                toDateOnly(item.data || item.data_inicio),
                toDateOnly(item.data_final || item.data || item.data_inicio),
                item.nota_total || 0,
                item.oportunidades || 1,
                item.nota_invertida || 0,
                item.descricao || null,
                item.fixo_direcao ? 1 : 0,
                itemId,
              ]
            );
          } else {
            // Insere novo item (não havia antes, sem notas associadas)
            await conn.query(
              `INSERT INTO itens_avaliacao
               (plano_id, atividade, tipo_avaliacao, data_inicio, data_final, nota_total, oportunidades, nota_invertida, descricao, fixo_direcao)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                planoId,
                item.atividade,
                item.tipo_avaliacao || null,
                toDateOnly(item.data || item.data_inicio),
                toDateOnly(item.data_final || item.data || item.data_inicio),
                item.nota_total || 0,
                item.oportunidades || 1,
                item.nota_invertida || 0,
                item.descricao || null,
                item.fixo_direcao ? 1 : 0,
              ]
            );
          }
        }
      } else {
        // ── Modo CLÁSSICO: sem notas lançadas — DELETE + INSERT seguro ──
        await conn.query(`DELETE FROM itens_avaliacao WHERE plano_id = ?`, [planoId]);

        if (itens && itens.length > 0) {
          const insertData = itens.map(i => [
            planoId,
            i.atividade,
            i.tipo_avaliacao || null,
            toDateOnly(i.data || i.data_inicio),
            toDateOnly(i.data_final || i.data || i.data_inicio),
            i.nota_total || 0,
            i.oportunidades || 1,
            i.nota_invertida || 0,
            i.descricao || null,
            i.fixo_direcao ? 1 : 0
          ]);

          await conn.query(
            `INSERT INTO itens_avaliacao 
             (plano_id, atividade, tipo_avaliacao, data_inicio, data_final, nota_total, oportunidades, nota_invertida, descricao, fixo_direcao)
             VALUES ?`,
            [insertData]
          );
        }
      }
    }

    await conn.commit();
    return res.json({ success: true, plano_ids: planoIds });
  } catch (error) {
    await conn.rollback();
    console.error("Erro ao salvar plano:", error);
    return res.status(500).json({ error: "Erro ao salvar plano de avaliação." });
  } finally {
    conn.release();
  }
});



/**
 * 5) PATCH /api/avaliacoes/:id/status
 * A Direção/Coordenação altera o status de um PAP (APROVAR, DEVOLVER, etc.)
 * body: { status: "APROVADO" | "DEVOLVIDO" | "RASCUNHO", motivo?: string }
 */
router.patch("/:id/status", async (req, res) => {
  try {
    const { escola_id } = req.user;
    const { id } = req.params;
    const { status, motivo } = req.body;

    const statusPermitidos = ["APROVADO", "DEVOLVIDO", "RASCUNHO", "LIBERACAO_SOLICITADA"];
    if (!status || !statusPermitidos.includes(status)) {
      return res.status(400).json({ error: `Status inválido. Permitidos: ${statusPermitidos.join(", ")}` });
    }

    // Motivo é obrigatório quando devolve
    if (status === "DEVOLVIDO" && (!motivo || !motivo.trim())) {
      return res.status(400).json({ error: "O motivo da devolução é obrigatório." });
    }

    // Verifica se o plano pertence à escola
    const [[plano]] = await pool.query(
      `SELECT id, status AS status_atual FROM planos_avaliacao WHERE id = ? AND escola_id = ?`,
      [id, escola_id]
    );

    if (!plano) {
      return res.status(404).json({ error: "Plano não encontrado." });
    }

    // Se aprovado → limpa motivo_devolucao; se devolvido → salva motivo
    const motivoValue = status === "DEVOLVIDO" ? motivo.trim() : null;

    await pool.query(
      `UPDATE planos_avaliacao SET status = ?, motivo_devolucao = ?, updated_at = NOW() WHERE id = ?`,
      [status, motivoValue, id]
    );

    return res.json({ ok: true, message: `Status alterado para ${status}.` });
  } catch (error) {
    console.error("Erro ao alterar status do plano:", error);
    return res.status(500).json({ ok: false, error: "Erro interno do servidor." });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/avaliacoes/:id/salvar-notas
// Salva as notas granulares do diário (por item do PAP) na tabela notas_diario
// ═══════════════════════════════════════════════════════════════════════════
router.post("/:id/salvar-notas", async (req, res) => {
  try {
    const { escola_id } = req.user;
    const planoId = req.params.id;
    const { turma_id, notas, cores } = req.body;
    // notas = { "alunoId_itemIdx_opIdx": valor, ... }
    // cores = { "alunoId_itemIdx_opIdx": "red"|"yellow"|"green"|null, ... }

    if (!turma_id || !notas || typeof notas !== "object") {
      return res.status(400).json({ error: "turma_id e notas são obrigatórios." });
    }

    // Verificar se o plano pertence a essa escola
    const [[plano]] = await pool.query(
      "SELECT id, status FROM planos_avaliacao WHERE id = ? AND escola_id = ?",
      [planoId, escola_id]
    );
    if (!plano) {
      return res.status(404).json({ error: "Plano não encontrado." });
    }

    // Verificar se o diário não está fechado para essa turma
    const [[fechamento]] = await pool.query(
      "SELECT id FROM diario_fechamento WHERE plano_id = ? AND turma_id = ?",
      [planoId, turma_id]
    );
    if (fechamento) {
      return res.status(403).json({ error: "Diário já fechado para esta turma. Não é possível editar." });
    }

    // Preparar batch UPSERT
    const entries = Object.entries(notas);
    if (entries.length === 0) {
      return res.json({ ok: true, message: "Nenhuma nota para salvar.", total: 0 });
    }

    const values = [];
    for (const [key, valor] of entries) {
      const parts = key.split("_");
      if (parts.length < 3) continue;
      const alunoId = parseInt(parts[0], 10);
      const itemIdx = parseInt(parts[1], 10);
      const opIdx = parseInt(parts[2], 10);
      if (isNaN(alunoId) || isNaN(itemIdx) || isNaN(opIdx)) continue;
      const cor = cores?.[key] || null;
      values.push([escola_id, planoId, turma_id, alunoId, itemIdx, opIdx, valor, cor]);
    }

    if (values.length === 0) {
      return res.json({ ok: true, message: "Nenhuma nota válida.", total: 0 });
    }

    // Batch UPSERT
    await pool.query(
      `INSERT INTO notas_diario (escola_id, plano_id, turma_id, aluno_id, item_idx, oportunidade_idx, nota, cor)
       VALUES ?
       ON DUPLICATE KEY UPDATE nota = VALUES(nota), cor = VALUES(cor), updated_at = NOW()`,
      [values]
    );

    return res.json({ ok: true, message: `${values.length} nota(s) salva(s) com sucesso.`, total: values.length });
  } catch (err) {
    console.error("Erro ao salvar notas do diário:", err);
    return res.status(500).json({ error: "Erro ao salvar notas." });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/avaliacoes/:id/notas-diario
// Carrega as notas granulares do diário para uma turma específica
// ═══════════════════════════════════════════════════════════════════════════
router.get("/:id/notas-diario", async (req, res) => {
  try {
    const { escola_id } = req.user;
    const planoId = req.params.id;
    const turmaId = req.query.turma_id;

    if (!turmaId) {
      return res.status(400).json({ error: "turma_id é obrigatório." });
    }

    const [rows] = await pool.query(
      `SELECT aluno_id, item_idx, oportunidade_idx, nota, cor
       FROM notas_diario
       WHERE plano_id = ? AND turma_id = ? AND escola_id = ?`,
      [planoId, turmaId, escola_id]
    );

    // Converter para formato { "alunoId_itemIdx_opIdx": { nota, cor } }
    const notas = {};
    const cores = {};
    for (const row of rows) {
      const key = `${row.aluno_id}_${row.item_idx}_${row.oportunidade_idx}`;
      notas[key] = Number(row.nota);
      if (row.cor) cores[key] = row.cor;
    }

    return res.json({ ok: true, notas, cores });
  } catch (err) {
    console.error("Erro ao carregar notas do diário:", err);
    return res.status(500).json({ error: "Erro ao carregar notas." });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/avaliacoes/:id/status-diario
// Verifica se o diário está fechado para uma turma
// ═══════════════════════════════════════════════════════════════════════════
router.get("/:id/status-diario", async (req, res) => {
  try {
    const { escola_id } = req.user;
    const planoId = req.params.id;
    const turmaId = req.query.turma_id;

    if (!turmaId) {
      return res.status(400).json({ error: "turma_id é obrigatório." });
    }

    const [[fechamento]] = await pool.query(
      `SELECT id, fechado_em, total_alunos, total_notas_exportadas
       FROM diario_fechamento
       WHERE plano_id = ? AND turma_id = ? AND escola_id = ?`,
      [planoId, turmaId, escola_id]
    );

    return res.json({
      ok: true,
      fechado: !!fechamento,
      fechamento: fechamento || null,
    });
  } catch (err) {
    console.error("Erro ao verificar status do diário:", err);
    return res.status(500).json({ error: "Erro ao verificar status." });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/avaliacoes/:id/exportar-boletim
// Exporta os TOTAIs do diário para a tabela notas (boletim).
// fechar_diario = false/omitido → exporta sem fechar (professor pode atualizar depois)
// fechar_diario = true          → exporta E fecha o diário definitivamente
// ═══════════════════════════════════════════════════════════════════════════
router.post("/:id/exportar-boletim", async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { escola_id } = req.user;
    const userId = req.user?.id || req.user?.usuario_id;
    const planoId = req.params.id;
    const { turma_id, fechar_diario } = req.body;

    if (!turma_id) {
      conn.release();
      return res.status(400).json({ error: "turma_id é obrigatório." });
    }

    // 1) Buscar o plano
    const [[plano]] = await conn.query(
      "SELECT id, disciplina, bimestre, ano, escola_id, status FROM planos_avaliacao WHERE id = ? AND escola_id = ?",
      [planoId, escola_id]
    );
    if (!plano) {
      conn.release();
      return res.status(404).json({ error: "Plano não encontrado." });
    }

    // 2) Se o diário já está fechado, bloquear qualquer operação
    const [[jaFechado]] = await conn.query(
      "SELECT id FROM diario_fechamento WHERE plano_id = ? AND turma_id = ?",
      [planoId, turma_id]
    );
    if (jaFechado) {
      conn.release();
      return res.status(400).json({ error: "Diário já está fechado. Solicite à Secretaria para reabrir." });
    }

    // 3) Resolver disciplina_id a partir do nome
    const [[disc]] = await conn.query(
      "SELECT id FROM disciplinas WHERE nome = ? AND escola_id = ? LIMIT 1",
      [plano.disciplina, escola_id]
    );
    if (!disc) {
      conn.release();
      return res.status(400).json({ error: `Disciplina '${plano.disciplina}' não encontrada.` });
    }
    const disciplinaId = disc.id;

    // 4) Resolver bimestre numérico
    const bimestreNum = parseBimestre(plano.bimestre);
    if (!bimestreNum) {
      conn.release();
      return res.status(400).json({ error: `Bimestre '${plano.bimestre}' inválido.` });
    }

    const ano = plano.ano || new Date().getFullYear();

    // 5) Buscar totais por aluno a partir de notas_diario
    const [totais] = await conn.query(
      `SELECT aluno_id, SUM(nota) AS total
       FROM notas_diario
       WHERE plano_id = ? AND turma_id = ? AND escola_id = ?
       GROUP BY aluno_id
       HAVING total IS NOT NULL`,
      [planoId, turma_id, escola_id]
    );

    if (totais.length === 0) {
      conn.release();
      return res.status(400).json({ error: "Nenhuma nota encontrada no diário para exportar." });
    }

    // 6) Transação: UPSERT nas notas + registrar fechamento
    await conn.beginTransaction();

    let inseridas = 0;
    let atualizadas = 0;

    for (const row of totais) {
      const nota = Number(row.total).toFixed(2);
      const [result] = await conn.query(
        `INSERT INTO notas (escola_id, aluno_id, ano, bimestre, disciplina_id, nota, data_lancamento)
         VALUES (?, ?, ?, ?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE nota = VALUES(nota), data_lancamento = NOW()`,
        [escola_id, row.aluno_id, ano, bimestreNum, disciplinaId, nota]
      );
      if (result.insertId > 0) inseridas++;
      else atualizadas++;
    }

    // 7) Registrar fechamento SOMENTE se o professor decidiu fechar
    if (fechar_diario) {
      await conn.query(
        `INSERT INTO diario_fechamento (escola_id, plano_id, turma_id, fechado_por, total_alunos, total_notas_exportadas)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [escola_id, planoId, turma_id, userId, totais.length, inseridas + atualizadas]
      );
    }

    await conn.commit();
    conn.release();

    return res.json({
      ok: true,
      message: fechar_diario
        ? `Diário fechado! ${totais.length} aluno(s) exportado(s) para o boletim.`
        : `Notas exportadas! ${totais.length} aluno(s) processado(s). Diário permanece aberto.`,
      diario_fechado: !!fechar_diario,
      resumo: {
        totalAlunos: totais.length,
        notasInseridas: inseridas,
        notasAtualizadas: atualizadas,
        disciplina: plano.disciplina,
        bimestre: plano.bimestre,
        ano,
      },
    });
  } catch (err) {
    await conn.rollback();
    conn.release();
    console.error("Erro ao exportar notas para boletim:", err);
    return res.status(500).json({ error: "Erro ao exportar notas para o boletim." });
  }
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseBimestre(bimestreStr) {
  if (!bimestreStr) return null;
  const match = String(bimestreStr).match(/(\d)/);
  if (match) {
    const num = parseInt(match[1], 10);
    if (num >= 1 && num <= 4) return num;
  }
  return null;
}

export default router;
