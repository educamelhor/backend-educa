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

    const anoAtual = new Date().getFullYear();

    // Resolve CPF do professor logado (igual ao /me)
    let cpf = req.user?.cpf;
    if (!cpf && usuario_id) {
      const [urows] = await pool.query("SELECT cpf FROM usuarios WHERE id = ? LIMIT 1", [usuario_id]);
      cpf = urows?.[0]?.cpf ? String(urows[0].cpf).replace(/\D/g, '') : null;
    }

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
         AND pa.ano = ?
         AND (ia.tipo_avaliacao IS NULL OR ia.tipo_avaliacao = '')
         -- ✅ Valida que (turma, disciplina) existe na modulação atual do professor
         AND EXISTS (
           SELECT 1
           FROM turmas tt
           JOIN modulacao m ON m.turma_id = tt.id
           JOIN disciplinas dd ON dd.id = m.disciplina_id
           JOIN professores pp ON pp.id = m.professor_id
           WHERE tt.nome COLLATE utf8mb4_general_ci = pa.turmas COLLATE utf8mb4_general_ci
             AND tt.escola_id = pa.escola_id
             AND tt.ano = pa.ano
             AND dd.nome COLLATE utf8mb4_general_ci = pa.disciplina COLLATE utf8mb4_general_ci
             AND REPLACE(REPLACE(pp.cpf, '.', ''), '-', '') = ?
         )
       GROUP BY pa.id
       ORDER BY pa.disciplina, pa.turmas`,
      [escola_id, usuario_id, anoAtual, cpf || '']
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
    const { ano, bimestre, semestre } = req.query;

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

    // ── Passo 1: turmas e disciplinas DO professor neste ano (via modulação) ───────────────────
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
    // Usamos pares exatos (turma, disciplina) para evitar "data leakage" cruzando turmas e disciplinas incorretas
    const conditions = vinculos.map(() => "(turmas = ? AND disciplina = ?)").join(" OR ");
    
    let sql = `
      SELECT * FROM planos_avaliacao
      WHERE escola_id  = ?
        AND ano        = ?
        AND (${conditions})
    `;
    const params = [escola_id, anoParam];
    vinculos.forEach(v => {
      params.push(v.turma_nome, v.disc_nome);
    });

    if (bimestre) {
      sql += ` AND bimestre = ?`;
      params.push(bimestre);
    }

    // Filtro por semestre: NULL = regime anual (sem filtro), 1 ou 2 = semestral
    if (semestre && ["1", "2"].includes(String(semestre))) {
      sql += ` AND semestre = ?`;
      params.push(Number(semestre));
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
 * Busca todos os planos de avaliação de uma escola, opcionalmente filtrando por ano, disciplina, bimestre, semestre.
 */
router.get("/", async (req, res) => {
  try {
    const { escola_id } = req.user;
    const { ano, disciplina, bimestre, semestre } = req.query;

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

    // Filtro por semestre (NULL = anual, 1 ou 2 = semestral)
    if (semestre && ["1", "2"].includes(String(semestre))) {
      sql += ` AND semestre = ?`;
      params.push(Number(semestre));
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
      `SELECT id, status FROM planos_avaliacao WHERE id = ? AND escola_id = ?`,
      [id, escola_id]
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



// ─────────────────────────────────────────────────────────────────────────────
// GET /solicitacoes-reabertura
// Coordenacao/Direcao busca TODAS as solicitacoes de reabertura de diario
// da sua escola. Retorna status PENDENTE por padrao (query ?status=PENDENTE|APROVADA|NEGADA|todas)
// ─────────────────────────────────────────────────────────────────────────────
router.get("/solicitacoes-reabertura", async (req, res) => {
  try {
    const { escola_id } = req.user;
    const statusFiltro = req.query.status || "PENDENTE";

    // Garante tabela existe
    await pool.query(`
      CREATE TABLE IF NOT EXISTS solicitacoes_reabertura_diario (
        id                INT AUTO_INCREMENT PRIMARY KEY,
        plano_id          INT NOT NULL,
        turma_id          INT NOT NULL,
        escola_id         INT,
        professor_id      INT,
        aluno_id          INT,
        aluno_nome        VARCHAR(255),
        motivo            TEXT NOT NULL,
        status            ENUM('PENDENTE','APROVADA','NEGADA') NOT NULL DEFAULT 'PENDENTE',
        resposta_pedagogico TEXT,
        respondido_por    INT,
        respondido_em     DATETIME,
        criado_em         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_plano_turma (plano_id, turma_id),
        INDEX idx_status (status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    const whereStatus = statusFiltro === "todas" ? "" : "AND s.status = ?";
    const params = statusFiltro === "todas"
      ? [escola_id]
      : [escola_id, statusFiltro];

    const [rows] = await pool.query(`
      SELECT
        s.id, s.plano_id, s.turma_id, s.escola_id,
        s.aluno_id, s.aluno_nome, s.motivo, s.status,
        s.resposta_pedagogico, s.respondido_em, s.criado_em,
        p.nome         AS professor_nome,
        p.foto         AS professor_foto,
        t.nome         AS turma_nome,
        av.disciplina,
        av.bimestre
      FROM solicitacoes_reabertura_diario s
      LEFT JOIN usuarios         p  ON p.id  = s.professor_id
      LEFT JOIN turmas           t  ON t.id  = s.turma_id
      LEFT JOIN planos_avaliacao av ON av.id = s.plano_id
      WHERE s.escola_id = ? ${whereStatus}
      ORDER BY s.criado_em DESC
    `, params);

    return res.json({ ok: true, solicitacoes: rows });
  } catch (err) {
    console.error("Erro ao buscar solicitacoes de reabertura:", err);
    return res.status(500).json({ ok: false, error: "Erro interno." });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /solicitacoes-reabertura/:solicitacaoId
// Pedagogico responde (APROVADA ou NEGADA) a uma solicitacao de reabertura.
// Se APROVADA: remove o registro de diario_fechamento para reabrir o diario.
// ─────────────────────────────────────────────────────────────────────────────
router.patch("/solicitacoes-reabertura/:solicitacaoId", async (req, res) => {
  const { solicitacaoId } = req.params;
  const { status, resposta } = req.body;
  const respondido_por = req.user?.id || null;

  if (!["APROVADA", "NEGADA"].includes(status)) {
    return res.status(400).json({ ok: false, error: "Status invalido. Use APROVADA ou NEGADA." });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Buscar solicitacao
    const [[sol]] = await conn.query(
      "SELECT * FROM solicitacoes_reabertura_diario WHERE id = ?",
      [solicitacaoId]
    );
    if (!sol) {
      await conn.rollback();
      conn.release();
      return res.status(404).json({ ok: false, error: "Solicitacao nao encontrada." });
    }
    if (sol.status !== "PENDENTE") {
      await conn.rollback();
      conn.release();
      return res.status(409).json({ ok: false, error: `Solicitacao ja foi respondida (${sol.status}).` });
    }

    // Atualizar solicitacao
    await conn.query(
      `UPDATE solicitacoes_reabertura_diario
       SET status = ?, resposta_pedagogico = ?, respondido_por = ?, respondido_em = NOW()
       WHERE id = ?`,
      [status, resposta || null, respondido_por, solicitacaoId]
    );

    // Se APROVADA: remover fechamento do diario para reabri-lo
    if (status === "APROVADA") {
      await conn.query(
        "DELETE FROM diario_fechamento WHERE plano_id = ? AND turma_id = ?",
        [sol.plano_id, sol.turma_id]
      );
    }

    await conn.commit();
    conn.release();

    return res.json({
      ok: true,
      message: status === "APROVADA"
        ? "Diario reaberto com sucesso. O professor ja pode realizar edicoes."
        : "Solicitacao negada. O professor sera notificado.",
    });
  } catch (err) {
    await conn.rollback();
    conn.release();
    console.error("Erro ao responder solicitacao de reabertura:", err);
    return res.status(500).json({ ok: false, error: "Erro interno." });
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

    // Desserializa JSON de stats da exportação de notas (para o polling path no frontend)
    if (plano.agente_notas_resultado_json) {
      try {
        plano.agente_notas_resultado = JSON.parse(plano.agente_notas_resultado_json);
      } catch { plano.agente_notas_resultado = null; }
    }

    return res.json(plano);
  } catch (error) {
    console.error("Erro ao buscar plano:", error);
    return res.status(500).json({ error: "Erro interno do servidor." });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// Exclusão de Plano de Avaliação
// ────────────────────────────────────────────────────────────────────────────
router.delete("/:id", async (req, res) => {
  const { id } = req.params;
  const conn = await pool.getConnection();

  try {
    // 1) Verificar se o plano existe
    const [[plano]] = await conn.query("SELECT * FROM planos_avaliacao WHERE id = ?", [id]);
    if (!plano) {
      return res.status(404).json({ success: false, message: "Plano não encontrado." });
    }

    // 2) Verificar se existem notas lançadas para os itens deste plano
    const [[{ total_notas }]] = await conn.query(
      `SELECT COUNT(*) as total_notas FROM notas_diario WHERE plano_id = ?`,
      [id]
    );

    if (total_notas > 0) {
      return res.status(400).json({
        success: false,
        message: "Não é possível excluir o plano, pois já existem notas lançadas. Remova as notas primeiro."
      });
    }

    // 3) Excluir plano (itens_avaliacao serão deletados por ON DELETE CASCADE se configurado, 
    // mas forçaremos o delete para segurança)
    await conn.beginTransaction();
    await conn.query("DELETE FROM itens_avaliacao WHERE plano_id = ?", [id]);
    await conn.query("DELETE FROM planos_avaliacao WHERE id = ?", [id]);
    await conn.commit();

    return res.json({ success: true, message: "Plano excluído com sucesso." });
  } catch (err) {
    if (conn) await conn.rollback();
    console.error("[DELETE /avaliacoes/:id]", err);
    return res.status(500).json({ success: false, message: "Erro interno ao excluir plano." });
  } finally {
    if (conn) conn.release();
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
      semestre = null,
      itens = []
    } = req.body;

    // Normaliza semestre: apenas 1 ou 2 são válidos para turmas semestrais;
    // NULL indica regime anual (compatível com dados existentes).
    const semestreNorm = [1, 2].includes(Number(semestre)) ? Number(semestre) : null;

    // Vai desmembrar as turmas em planos individuais
    const turmasArray = Array.isArray(turmas) ? turmas : turmas.split("-");
    const planoIds = [];

    for (const turmaUnica of turmasArray) {
      let planoId;

      // Busca se já existe o plano especificamente para essa turma
      const [[existente]] = await conn.query(
        `SELECT id FROM planos_avaliacao 
         WHERE escola_id = ? AND ano = ? AND bimestre = ? AND disciplina = ? AND turmas = ?
           AND (semestre <=> ?)`,
        [escola_id, ano, bimestre, disciplina, turmaUnica, semestreNorm]
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
            (escola_id, disciplina, bimestre, semestre, turmas, ano, status, nome_codigo, usuario_id) 
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [escola_id, disciplina, bimestre, semestreNorm, turmaUnica, ano, status, nomeCodigoIndividual, usuario_id]
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

        // Mapa: id atual -> atividade
        const mapaAtual = {};
        for (const ia of itensAtuais) {
          mapaAtual[ia.id] = ia.atividade;
        }

        // IDs dos itens que vêm do frontend
        const idsFrontend = itens.filter(i => i.id).map(i => i.id);

        // Itens do banco que o professor quer remover
        const itensParaRemover = itensAtuais.filter(
          ia => !idsFrontend.includes(ia.id)
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
              error: `Não é possível remover a atividade "${itemRemover.atividade}" pois ela já possui ${count_notas} nota(s) lançada(s).`,
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
          const itemId = item.id;

          if (itemId && mapaAtual[itemId]) {
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

    // ════════════════════════════════════════════════════════════════════
    // AUTO-ITEM: Prova Bimestral padronizada (com Governança de Exceções)
    // Se a escola adota avaliação bimestral padronizada (governança) e a
    // disciplina NÃO é uma exceção configurada pela direção, garante que
    // cada plano tenha um item fixo_direcao=1 com atividade='Prova Bimestral'
    // e tipo_avaliacao='PROVA'.
    // Caso contrário (desativada ou exceção), removemos o item de forma segura.
    // ════════════════════════════════════════════════════════════════════
    try {
      const [[config]] = await conn.query(
        `SELECT valor FROM configuracoes_escola
         WHERE escola_id = ? AND chave = 'escola.avaliacao_padrao_bimestral' LIMIT 1`,
        [escola_id]
      );

      const [[configExc]] = await conn.query(
        `SELECT valor FROM configuracoes_escola
         WHERE escola_id = ? AND chave = 'escola.avaliacao_padrao_bimestral.excecoes' LIMIT 1`,
        [escola_id]
      );

      let isException = false;
      if (config?.valor === '1' && configExc?.valor) {
        try {
          const excIds = JSON.parse(configExc.valor);
          if (Array.isArray(excIds) && excIds.length > 0) {
            const [rowsExcNames] = await conn.query(
              `SELECT nome FROM disciplinas WHERE escola_id = ? AND id IN (?)`,
              [escola_id, excIds]
            );
            const excNames = rowsExcNames.map(r => String(r.nome).trim().toLowerCase());
            if (excNames.includes(String(disciplina).trim().toLowerCase())) {
              isException = true;
            }
          }
        } catch (excErr) {
          console.warn('[avaliacoes] Erro ao verificar exceções de disciplinas:', excErr.message);
        }
      }

      if (config?.valor === '1' && !isException) {
        for (const planoId of planoIds) {
          // Verifica se já existe item fixo_direcao nesse plano
          const [[jaExiste]] = await conn.query(
            `SELECT id FROM itens_avaliacao WHERE plano_id = ? AND fixo_direcao = 1 LIMIT 1`,
            [planoId]
          );

          if (!jaExiste) {
            await conn.query(
              `INSERT INTO itens_avaliacao
                (plano_id, atividade, tipo_avaliacao, data_inicio, data_final,
                 nota_total, oportunidades, nota_invertida, descricao, fixo_direcao)
               VALUES (?, 'Prova Bimestral', 'PROVA', NULL, NULL, 5, 1, 0, NULL, 1)`,
              [planoId]
            );
            console.log(`[avaliacoes] Auto-item Prova Bimestral inserido no plano ${planoId}`);
          } else {
            // Já existe — garante que tipo_avaliacao está correto (PROVA)
            await conn.query(
              `UPDATE itens_avaliacao
               SET atividade = 'Prova Bimestral', tipo_avaliacao = 'PROVA'
               WHERE plano_id = ? AND fixo_direcao = 1`,
              [planoId]
            );
          }
        }
      } else {
        // Se a escola não adota ou se a disciplina é exceção, removemos a Prova Bimestral (fixo_direcao = 1) de forma segura
        for (const planoId of planoIds) {
          const [[jaExiste]] = await conn.query(
            `SELECT id FROM itens_avaliacao WHERE plano_id = ? AND fixo_direcao = 1 LIMIT 1`,
            [planoId]
          );
          if (jaExiste) {
            // Verifica se tem notas no diário para esse item específico
            const [itensAtuais] = await conn.query(
              `SELECT id FROM itens_avaliacao WHERE plano_id = ? ORDER BY id ASC`,
              [planoId]
            );
            const idx = itensAtuais.findIndex(i => i.id === jaExiste.id);
            if (idx !== -1) {
              const [[{ count_notas }]] = await conn.query(
                `SELECT COUNT(*) AS count_notas FROM notas_diario WHERE plano_id = ? AND item_idx = ?`,
                [planoId, idx]
              );
              if (count_notas === 0) {
                await conn.query(
                  `DELETE FROM itens_avaliacao WHERE id = ?`,
                  [jaExiste.id]
                );
                console.log(`[avaliacoes] Auto-item Prova Bimestral removido com segurança do plano ${planoId} (disciplina de exceção ou desativada)`);
              }
            }
          }
        }
      }
    } catch (govErr) {
      // Não bloqueia o salvamento do plano se a verificação de governança falhar
      console.warn('[avaliacoes] Auto-item Prova Bimestral ignorado:', govErr.message);
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
 * PATCH /api/avaliacoes/:id/item/:itemId/data
 * Professor atualiza a data_inicio de um item específico do PAP.
 * Bloqueado para itens fixo_direcao (Prova Bimestral — gerenciado pela direção).
 * body: { data_inicio: "YYYY-MM-DD" }
 */
router.patch("/:id/item/:itemId/data", async (req, res) => {
  try {
    const { escola_id, usuario_id } = req.user;
    const { id: planoId, itemId } = req.params;
    const { data_inicio } = req.body;

    // Verifica se o plano pertence à escola
    const [[plano]] = await pool.query(
      `SELECT id, status FROM planos_avaliacao WHERE id = ? AND escola_id = ?`,
      [planoId, escola_id]
    );
    if (!plano) {
      return res.status(404).json({ ok: false, error: "Plano não encontrado ou sem permissão." });
    }

    // Verifica se o item existe e não é fixo_direcao
    const [[item]] = await pool.query(
      `SELECT id, fixo_direcao FROM itens_avaliacao WHERE id = ? AND plano_id = ?`,
      [itemId, planoId]
    );
    if (!item) {
      return res.status(404).json({ ok: false, error: "Item não encontrado." });
    }
    if (item.fixo_direcao) {
      return res.status(403).json({ ok: false, error: "A data da Prova Bimestral é gerenciada pela Direção e não pode ser alterada aqui." });
    }

    const dataFormatada = toDateOnly(data_inicio);
    await pool.query(
      `UPDATE itens_avaliacao SET data_inicio = ?, data_final = ?, updated_at = NOW() WHERE id = ?`,
      [dataFormatada, dataFormatada, itemId]
    );

    return res.json({ ok: true, data_inicio: dataFormatada });
  } catch (error) {
    console.error("Erro ao atualizar data do item:", error);
    return res.status(500).json({ ok: false, error: "Erro interno." });
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

    const statusPermitidos = ["APROVADO", "DEVOLVIDO", "RASCUNHO", "LIBERADO", "LIBERACAO_SOLICITADA"];
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
// Carrega as notas granulares do diário para uma turma específica.
// Também retorna `alunosComGabarito`: array de aluno_ids cuja nota fixo_direcao
// foi importada pelo módulo de Gabarito (e não digitada manualmente).
// ═══════════════════════════════════════════════════════════════════════════
router.get("/:id/notas-diario", async (req, res) => {
  try {
    const { escola_id } = req.user;
    const planoId = req.params.id;
    const turmaId = req.query.turma_id;

    if (!turmaId) {
      return res.status(400).json({ error: "turma_id é obrigatório." });
    }

    // ── 1. Notas granulares do diário ──────────────────────────────────────
    const [rows] = await pool.query(
      `SELECT aluno_id, item_idx, oportunidade_idx, nota, cor
       FROM notas_diario
       WHERE plano_id = ? AND turma_id = ? AND escola_id = ?`,
      [planoId, turmaId, escola_id]
    );

    const notas = {};
    const cores = {};
    for (const row of rows) {
      const key = `${row.aluno_id}_${row.item_idx}_${row.oportunidade_idx}`;
      notas[key] = Number(row.nota);
      if (row.cor) cores[key] = row.cor;
    }

    // ── 2. Detectar quais alunos têm nota originada do Gabarito ────────────
    // Busca o plano para obter disciplina + bimestre, depois cruza com
    // gabarito_avaliacoes e gabarito_respostas para determinar com precisao
    // quais alunos tiveram a Prova Bimestral preenchida via gabarito.
    let alunosComGabarito = [];
    try {
      const [[plano]] = await pool.query(
        `SELECT disciplina, bimestre FROM planos_avaliacao WHERE id = ? AND escola_id = ?`,
        [planoId, escola_id]
      );

      if (plano) {
        const bimestreNum = String(plano.bimestre).replace(/\D/g, ""); // "2º Bimestre" → "2"

        // Gabaritos da mesma escola/disciplina/bimestre
        const [gabsRows] = await pool.query(
          `SELECT DISTINCT ga.id
           FROM gabarito_avaliacoes ga
           WHERE ga.escola_id = ?
             AND ga.bimestre LIKE ?
             AND JSON_CONTAINS(
               CONVERT(ga.disciplinas_config USING utf8mb4) COLLATE utf8mb4_unicode_ci,
               JSON_OBJECT('nome', CONVERT(? USING utf8mb4)) COLLATE utf8mb4_unicode_ci
             )`,
          [escola_id, `%${bimestreNum}%`, plano.disciplina]
        );

        if (gabsRows.length > 0) {
          const gabIds = gabsRows.map(g => g.id);
          const placeholders = gabIds.map(() => "?").join(",");

          // Alunos da turma que têm respostas nesse(s) gabarito(s)
          const [alunosGabRows] = await pool.query(
            `SELECT DISTINCT a.id AS aluno_id
             FROM gabarito_respostas gr
             JOIN alunos a
               ON CONVERT(a.codigo USING utf8mb4) COLLATE utf8mb4_unicode_ci
                  = CONVERT(gr.codigo_aluno USING utf8mb4) COLLATE utf8mb4_unicode_ci
              AND a.escola_id = ?
             JOIN matriculas m ON m.aluno_id = a.id AND m.turma_id = ? AND m.escola_id = ?
             WHERE gr.avaliacao_id IN (${placeholders})
               AND gr.escola_id = ?`,
            [escola_id, turmaId, escola_id, ...gabIds, escola_id]
          );

          alunosComGabarito = alunosGabRows.map(r => r.aluno_id);
        }
      }
    } catch (gabErr) {
      // Nao critico: sem esse dado o frontend simplesmente nao exibe o aviso de gabarito
      console.warn("[notas-diario] Erro ao detectar alunosComGabarito (nao critico):", gabErr.message);
    }

    return res.json({ ok: true, notas, cores, alunosComGabarito });
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

// ─────────────────────────────────────────────────────────────────────────────
// POST /:id/solicitar-reabertura-diario
// Professor solicita reabertura do diario fechado.
// Cria registro em solicitacoes_reabertura_diario (status: PENDENTE).
// PASSO 3 (Pedagogico) devera aprovar/negar via rota separada.
// ─────────────────────────────────────────────────────────────────────────────
router.post("/:id/solicitar-reabertura-diario", async (req, res) => {
  const planoId = req.params.id;
  const { turma_id, motivo, aluno_id, aluno_nome } = req.body;
  const professor_id = req.user?.id || req.headers["x-professor-id"] || null;
  const escola_id = req.user?.escola_id || req.headers["x-escola-id"] || null;

  if (!turma_id || !motivo?.trim()) {
    return res.status(400).json({ ok: false, error: "turma_id e motivo sao obrigatorios." });
  }

  try {
    // 1) Garantir que a tabela existe (idempotente)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS solicitacoes_reabertura_diario (
        id                INT AUTO_INCREMENT PRIMARY KEY,
        plano_id          INT NOT NULL,
        turma_id          INT NOT NULL,
        escola_id         INT,
        professor_id      INT,
        aluno_id          INT,
        aluno_nome        VARCHAR(255),
        motivo            TEXT NOT NULL,
        status            ENUM('PENDENTE','APROVADA','NEGADA') NOT NULL DEFAULT 'PENDENTE',
        resposta_pedagogico TEXT,
        respondido_por    INT,
        respondido_em     DATETIME,
        criado_em         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_plano_turma (plano_id, turma_id),
        INDEX idx_status (status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // 2) Verificar se o diario esta de fato fechado
    const [[fechamento]] = await pool.query(
      "SELECT id FROM diario_fechamento WHERE plano_id = ? AND turma_id = ?",
      [planoId, turma_id]
    );
    if (!fechamento) {
      return res.status(400).json({ ok: false, error: "O diario nao esta fechado." });
    }

    // 3) Verificar se ja existe solicitacao PENDENTE
    const [[pendente]] = await pool.query(
      "SELECT id FROM solicitacoes_reabertura_diario WHERE plano_id = ? AND turma_id = ? AND status = 'PENDENTE'",
      [planoId, turma_id]
    );
    if (pendente) {
      return res.status(409).json({ ok: false, error: "Ja existe uma solicitacao de reabertura pendente para este diario." });
    }

    // 4) Inserir solicitacao
    const [result] = await pool.query(
      `INSERT INTO solicitacoes_reabertura_diario
         (plano_id, turma_id, escola_id, professor_id, aluno_id, aluno_nome, motivo)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [planoId, turma_id, escola_id, professor_id, aluno_id || null, aluno_nome || null, motivo.trim()]
    );

    return res.json({
      ok: true,
      id: result.insertId,
      message: "Solicitacao de reabertura enviada. Aguarde a aprovacao do Pedagogico.",
    });
  } catch (err) {
    console.error("Erro ao solicitar reabertura de diario:", err);
    return res.status(500).json({ ok: false, error: "Erro interno ao processar a solicitacao." });
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
