// routes/governanca.js
// =========================================================================
// GOVERNANÇA — Configurações da escola gerenciadas pelo Diretor/Vice-Diretor
// Tabela `configuracoes_escola` (chave-valor por escola, com categorias)
// SINCRONIA: só mostra itens que existem no template CEO
// =========================================================================
import express from "express";

const router = express.Router();

// ── Helper: garante que a tabela existe ──
async function ensureTable(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS configuracoes_escola (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      escola_id   INT NOT NULL,
      categoria   VARCHAR(80) NOT NULL DEFAULT 'geral',
      chave       VARCHAR(120) NOT NULL,
      valor       VARCHAR(500) NOT NULL DEFAULT '0',
      descricao   VARCHAR(300) DEFAULT NULL,
      tipo        ENUM('boolean','select','text') NOT NULL DEFAULT 'boolean',
      opcoes_json JSON DEFAULT NULL,
      ordem       INT NOT NULL DEFAULT 0,
      ativo       TINYINT(1) NOT NULL DEFAULT 1,
      criado_em   DATETIME DEFAULT CURRENT_TIMESTAMP,
      atualizado_em DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_escola_chave (escola_id, chave),
      KEY idx_escola_cat (escola_id, categoria)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
}

// ── Sync completo: CEO template → configuracoes_escola ──
// 1) Insere novos itens do CEO que ainda não existem na escola
// 2) Remove itens órfãos (que foram excluídos pelo CEO)
// 3) Atualiza descrição/tipo/opcoes dos itens existentes (CEO é master)
// Valores (configurados pelo diretor) NUNCA são sobrescritos.
async function syncFromCeoTemplate(db, escolaId) {
  try {
    // Verifica se tabelas CEO existem
    const [tableCheck] = await db.query("SHOW TABLES LIKE 'governanca_itens'");
    if (!tableCheck.length) return;

    // ── Ler template CEO ──
    const [ceoItens] = await db.query(`
      SELECT i.chave, i.descricao, i.tipo, i.opcoes_json, i.valor_padrao, i.ordem,
             c.nome AS categoria
      FROM governanca_itens i
      JOIN governanca_categorias c ON c.id = i.categoria_id
      WHERE i.ativo = 1 AND c.ativo = 1
      ORDER BY c.ordem ASC, i.ordem ASC
    `);

    // Se CEO não tem itens, limpar tudo da escola
    if (!ceoItens.length) {
      await db.query(
        "DELETE FROM configuracoes_escola WHERE escola_id = ?",
        [Number(escolaId)]
      );
      return;
    }

    // ── 1) Inserir novos itens que não existem na escola ──
    for (const item of ceoItens) {
      try {
        await db.query(
          `INSERT IGNORE INTO configuracoes_escola 
           (escola_id, categoria, chave, valor, descricao, tipo, opcoes_json, ordem) 
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            Number(escolaId),
            item.categoria,
            item.chave,
            item.valor_padrao || "0",
            item.descricao,
            item.tipo,
            item.opcoes_json,
            item.ordem,
          ]
        );
      } catch {
        // ignora duplicatas
      }
    }

    // ── 2) Remover itens órfãos (excluídos pelo CEO) ──
    const chavesValidas = ceoItens.map(i => i.chave);
    const placeholders = chavesValidas.map(() => "?").join(",");
    await db.query(
      `DELETE FROM configuracoes_escola 
       WHERE escola_id = ? AND chave NOT IN (${placeholders})`,
      [Number(escolaId), ...chavesValidas]
    );

    // ── 3) Atualizar metadados (descrição, tipo, opções, categoria, ordem) ──
    // O CEO é master dos metadados; o diretor só controla o VALOR
    for (const item of ceoItens) {
      await db.query(
        `UPDATE configuracoes_escola 
         SET descricao = ?, tipo = ?, opcoes_json = ?, categoria = ?, ordem = ?
         WHERE escola_id = ? AND chave = ?`,
        [
          item.descricao,
          item.tipo,
          item.opcoes_json,
          item.categoria,
          item.ordem,
          Number(escolaId),
          item.chave,
        ]
      );
    }
  } catch (err) {
    console.warn("[GOVERNANCA] Sync CEO template:", err?.message || err);
  }
}

// ── Guard: perfil deve ser diretor ou vice_diretor ──
function guardDiretor(req, res, next) {
  const perfil = String(req.headers["x-perfil"] || "").toLowerCase().trim();
  if (perfil === "diretor" || perfil === "vice_diretor") {
    return next();
  }
  return res.status(403).json({
    ok: false,
    message: "Acesso restrito a Diretor e Vice-Diretor.",
  });
}

// ── OPTIONS: responde preflight explicitamente para todas as rotas deste router ──
router.options("/{*any}", (req, res) => res.status(204).end());
router.options("/", (req, res) => res.status(204).end());

// ═══════════════════════════════════════════════════════════════
// ENDPOINTS
// ═══════════════════════════════════════════════════════════════

// ── GET /api/governanca/boletim-config?escola_id=X ──────────────
// Leitura RÁPIDA das flags de boletim (sem sync, sem ensure).
// O sync completo roda só quando o diretor acessa Governança.
// Se a escola não tiver configs ainda, retorna defaults seguros.
// ─────────────────────────────────────────────────────────────────
const BOLETIM_DEFAULTS = {
  "boletim.exibir_ano_anterior": "0",
  "boletim.exibir_media_rodape": "1",
  "boletim.exibir_faltas": "1",
  "boletim.exibir_ranking": "1",
  "boletim.exibir_media_turma": "0",
};

router.get("/boletim-config", async (req, res) => {
  const db = req.db;
  const escolaId = Number(req.query.escola_id || req.user?.escola_id);
  if (!escolaId)
    return res.status(400).json({ ok: false, message: "escola_id é obrigatório." });

  try {
    const [rows] = await db.query(
      `SELECT chave, valor FROM configuracoes_escola
       WHERE escola_id = ? AND chave LIKE 'boletim.%'`,
      [escolaId]
    );

    // Começa com defaults, sobrescreve com valores do DB
    const config = { ...BOLETIM_DEFAULTS };
    for (const row of rows) {
      config[row.chave] = row.valor;
    }

    return res.json({ ok: true, config });
  } catch (err) {
    // Se tabela não existir, retorna defaults sem erro
    if (err?.code === "ER_NO_SUCH_TABLE") {
      return res.json({ ok: true, config: { ...BOLETIM_DEFAULTS } });
    }
    console.error("[GOVERNANCA][BOLETIM-CONFIG]", err);
    return res.status(500).json({ ok: false, message: "Erro ao buscar config do boletim." });
  }
});

// ── GET /api/governanca/avaliacao-config?escola_id=X ─────────────
// Leitura rápida das flags de avaliação (sem sync).
// ─────────────────────────────────────────────────────────────────
const AVALIACAO_DEFAULTS = {
  "escola.avaliacao_padrao_bimestral": "0",
  "nota.avaliacao_padrao.bimestral": "0",
  "coordenador.acessa_gabarito": "0",
  "supervisor.acessa_gabarito": "0",
  "escola.permitir_boletim_manual": "0",
  "escola.avaliacao_padrao_bimestral.excecoes": "[]",
};

router.get("/avaliacao-config", async (req, res) => {
  const db = req.db;
  const escolaId = Number(req.query.escola_id || req.user?.escola_id);
  if (!escolaId)
    return res.status(400).json({ ok: false, message: "escola_id é obrigatório." });

  try {
    const [rows] = await db.query(
      `SELECT chave, valor FROM configuracoes_escola
       WHERE escola_id = ? AND (
         chave LIKE 'escola.avaliacao%'
         OR chave LIKE 'nota.avaliacao%'
         OR chave LIKE 'coordenador.acessa%'
         OR chave LIKE 'supervisor.acessa%'
         OR chave = 'escola.permitir_boletim_manual'
       )`,
      [escolaId]
    );

    const config = { ...AVALIACAO_DEFAULTS };
    for (const row of rows) {
      config[row.chave] = row.valor;
    }

    return res.json({ ok: true, config });
  } catch (err) {
    if (err?.code === "ER_NO_SUCH_TABLE") {
      return res.json({ ok: true, config: { ...AVALIACAO_DEFAULTS } });
    }
    console.error("[GOVERNANCA][AVALIACAO-CONFIG]", err);
    return res.status(500).json({ ok: false, message: "Erro ao buscar config de avaliação." });
  }
});

// ── GET /api/governanca/conteudo-modo?escola_id=X ─────────────────
// Retorna o modo ativo de governança de conteúdos programáticos.
// Modos:
//   "coordenacao_decide"    → Só direção/coordenação cria (padrão)
//   "professor_aprovacao"   → Professor cria e envia para aprovação
//   "professor_autonomo"    → Professor cria com publicação direta
// ──────────────────────────────────────────────────────────────────
router.get("/conteudo-modo", async (req, res) => {
  const db = req.db;
  const escolaId = Number(req.query.escola_id || req.user?.escola_id);
  if (!escolaId)
    return res.status(400).json({ ok: false, message: "escola_id é obrigatório." });

  const CHAVES = [
    "coordenacao_decide_conteudo",
    "professor_decide_conteudo",
    "coordenacao_aprova_conteudo",
  ];

  const DEFAULTS = {
    coordenacao_decide_conteudo: "1",
    professor_decide_conteudo:   "0",
    coordenacao_aprova_conteudo: "0",
  };

  try {
    const [rows] = await db.query(
      `SELECT chave, valor FROM configuracoes_escola
       WHERE escola_id = ? AND chave IN (?, ?, ?)`,
      [escolaId, ...CHAVES]
    );

    const cfg = { ...DEFAULTS };
    for (const row of rows) cfg[row.chave] = row.valor;

    const isOn = (k) => cfg[k] === "1" || cfg[k] === "true";

    // Determina modo ativo (prioridade: professor_autonomo > professor_aprovacao > coordenacao_decide)
    let modo = "coordenacao_decide";
    if (isOn("professor_decide_conteudo"))   modo = "professor_aprovacao";
    if (isOn("coordenacao_aprova_conteudo")) modo = "professor_autonomo";

    return res.json({ ok: true, modo, config: cfg });
  } catch (err) {
    if (err?.code === "ER_NO_SUCH_TABLE") {
      return res.json({ ok: true, modo: "coordenacao_decide", config: { ...DEFAULTS } });
    }
    console.error("[GOVERNANCA][CONTEUDO-MODO]", err);
    return res.status(500).json({ ok: false, message: "Erro ao buscar modo de conteúdo." });
  }
});


router.get("/", guardDiretor, async (req, res) => {
  const db = req.db;
  const escolaId = Number(req.query.escola_id);
  if (!escolaId)
    return res.status(400).json({ ok: false, message: "escola_id é obrigatório." });

  try {
    await ensureTable(db);
    await syncFromCeoTemplate(db, escolaId);

    const [rows] = await db.query(
      `SELECT id, categoria, chave, valor, descricao, tipo, opcoes_json, ordem, ativo
       FROM configuracoes_escola
       WHERE escola_id = ?
       ORDER BY categoria ASC, ordem ASC, chave ASC`,
      [escolaId]
    );

    // Agrupa por categoria para o frontend
    const agrupado = {};
    for (const row of rows) {
      if (!agrupado[row.categoria]) agrupado[row.categoria] = [];
      let opcoes = null;
      try {
        opcoes = row.opcoes_json ? JSON.parse(row.opcoes_json) : null;
      } catch {
        opcoes = null;
      }
      agrupado[row.categoria].push({ ...row, opcoes_json: opcoes });
    }

    return res.json({ ok: true, configuracoes: agrupado });
  } catch (err) {
    console.error("[GOVERNANCA][LISTAR]", err);
    return res.status(500).json({ ok: false, message: "Erro ao listar configurações." });
  }
});

// ── PUT /api/governanca/:id — Atualizar valor de uma configuração ──
router.put("/:id", guardDiretor, async (req, res) => {
  const db = req.db;
  const id = Number(req.params.id);
  const { valor } = req.body;

  if (!id) return res.status(400).json({ ok: false, message: "ID inválido." });
  if (valor === undefined || valor === null)
    return res.status(400).json({ ok: false, message: "Valor é obrigatório." });

  try {
    const [result] = await db.query(
      "UPDATE configuracoes_escola SET valor = ? WHERE id = ?",
      [String(valor), id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ ok: false, message: "Configuração não encontrada." });
    }

    return res.json({ ok: true, message: "Configuração atualizada." });
  } catch (err) {
    console.error("[GOVERNANCA][ATUALIZAR]", err);
    return res.status(500).json({ ok: false, message: "Erro ao atualizar." });
  }
});

// ── Sincroniza todos os PAPs da escola com a regra bimestral e exceções ──
export async function syncPlanosAvaliacao(db, escolaId) {
  try {
    const anoAtual = new Date().getFullYear();

    // 1) Busca configurações
    const [[configBimestral]] = await db.query(
      `SELECT valor FROM configuracoes_escola WHERE escola_id = ? AND chave = 'escola.avaliacao_padrao_bimestral' LIMIT 1`,
      [escolaId]
    );

    const [[configExcecoes]] = await db.query(
      `SELECT valor FROM configuracoes_escola WHERE escola_id = ? AND chave = 'escola.avaliacao_padrao_bimestral.excecoes' LIMIT 1`,
      [escolaId]
    );

    const adotaBimestral = configBimestral?.valor === "1";
    let exceptionNames = [];

    if (adotaBimestral && configExcecoes?.valor) {
      try {
        const excIds = JSON.parse(configExcecoes.valor);
        if (Array.isArray(excIds) && excIds.length > 0) {
          const [disciplinasExc] = await db.query(
            `SELECT nome FROM disciplinas WHERE escola_id = ? AND id IN (?)`,
            [escolaId, excIds]
          );
          exceptionNames = disciplinasExc.map(d => String(d.nome).trim().toLowerCase());
        }
      } catch (e) {
        console.warn("[GOVERNANCA][SYNC-PAPs] Erro ao parsear exceções:", e.message);
      }
    }

    // 2) Busca todos os planos do ano corrente
    const [planos] = await db.query(
      `SELECT id, disciplina FROM planos_avaliacao WHERE escola_id = ? AND ano = ?`,
      [escolaId, anoAtual]
    );

    console.log(`[GOVERNANCA][SYNC-PAPs] Sincronizando ${planos.length} planos para a escola ${escolaId} (${anoAtual})`);

    for (const plano of planos) {
      const planoId = plano.id;
      const isException = exceptionNames.includes(String(plano.disciplina).trim().toLowerCase());

      if (adotaBimestral && !isException) {
        // --- DEVE ter Prova Bimestral ---
        const [[jaExiste]] = await db.query(
          `SELECT id FROM itens_avaliacao WHERE plano_id = ? AND fixo_direcao = 1 LIMIT 1`,
          [planoId]
        );

        if (!jaExiste) {
          await db.query(
            `INSERT INTO itens_avaliacao
              (plano_id, atividade, tipo_avaliacao, data_inicio, data_final,
               nota_total, oportunidades, nota_invertida, descricao, fixo_direcao)
             VALUES (?, 'Prova Bimestral', 'PROVA', NULL, NULL, 5, 1, 0, NULL, 1)`,
            [planoId]
          );
          console.log(`[GOVERNANCA][SYNC-PAPs] Inserido auto-item Prova Bimestral no plano ${planoId}`);
        } else {
          await db.query(
            `UPDATE itens_avaliacao
             SET atividade = 'Prova Bimestral', tipo_avaliacao = 'PROVA'
             WHERE plano_id = ? AND fixo_direcao = 1`,
            [planoId]
          );
        }
      } else {
        // --- NÃO deve ter Prova Bimestral ---
        const [[jaExiste]] = await db.query(
          `SELECT id FROM itens_avaliacao WHERE plano_id = ? AND fixo_direcao = 1 LIMIT 1`,
          [planoId]
        );

        if (jaExiste) {
          // Verifica se existem notas cadastradas para este item no plano
          const [itensAtuais] = await db.query(
            `SELECT id FROM itens_avaliacao WHERE plano_id = ? ORDER BY id ASC`,
            [planoId]
          );
          const idx = itensAtuais.findIndex(i => i.id === jaExiste.id);

          if (idx !== -1) {
            const [[{ count_notas }]] = await db.query(
              `SELECT COUNT(*) AS count_notas FROM notas_diario WHERE plano_id = ? AND item_idx = ?`,
              [planoId, idx]
            );

            if (count_notas === 0) {
              await db.query(
                `DELETE FROM itens_avaliacao WHERE id = ?`,
                [jaExiste.id]
              );
              console.log(`[GOVERNANCA][SYNC-PAPs] Removida Prova Bimestral do plano ${planoId} (exceção ou inativo)`);
            } else {
              console.log(`[GOVERNANCA][SYNC-PAPs] Prova Bimestral preservada no plano ${planoId} pois já possui ${count_notas} nota(s)`);
            }
          }
        }
      }
    }
  } catch (err) {
    console.error("[GOVERNANCA][SYNC-PAPs] Erro geral ao sincronizar:", err);
  }
}

// ── PUT /api/governanca/batch/update — Atualizar múltiplas de uma vez ──
router.put("/batch/update", guardDiretor, async (req, res) => {
  const db = req.db;
  const { items } = req.body;
  const escolaId = Number(req.query.escola_id || req.user?.escola_id || req.headers["x-escola-id"]);

  if (!Array.isArray(items) || items.length === 0)
    return res.status(400).json({ ok: false, message: "items é obrigatório (array)." });

  if (!escolaId)
    return res.status(400).json({ ok: false, message: "escola_id é obrigatório." });

  try {
    let updated = 0;
    let hasBimestralOrExcChange = false;

    for (const item of items) {
      if (!item.id || item.valor === undefined) continue;

      // Busca a chave correspondente ao ID para saber se é bimestral ou exceções
      const [[cfg]] = await db.query(
        "SELECT chave, valor FROM configuracoes_escola WHERE id = ?",
        [Number(item.id)]
      );
      if (cfg && (cfg.chave === "escola.avaliacao_padrao_bimestral" || cfg.chave === "escola.avaliacao_padrao_bimestral.excecoes")) {
        if (String(cfg.valor) !== String(item.valor)) {
          hasBimestralOrExcChange = true;
        }
      }

      const [result] = await db.query(
        "UPDATE configuracoes_escola SET valor = ? WHERE id = ?",
        [String(item.valor), Number(item.id)]
      );
      updated += result.affectedRows;
    }

    if (hasBimestralOrExcChange) {
      // Dispara a sincronização de planos existentes em segundo plano para não travar a resposta
      syncPlanosAvaliacao(db, escolaId).catch(err => {
        console.error("[GOVERNANCA] Erro na sync de planos:", err);
      });
    }

    return res.json({ ok: true, message: `${updated} configurações atualizadas.` });
  } catch (err) {
    console.error("[GOVERNANCA][BATCH]", err);
    return res.status(500).json({ ok: false, message: "Erro ao atualizar em lote." });
  }
});

export default router;
