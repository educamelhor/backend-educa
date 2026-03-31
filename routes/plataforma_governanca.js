// routes/plataforma_governanca.js
// =========================================================================
// GOVERNANÇA (CEO) — Gerencia categorias e itens de configuração globais
// O CEO cria as categorias e itens que serão disponibilizados para TODAS
// as escolas. Cada diretor/vice-diretor poderá configurar suas opções.
// =========================================================================
import express from "express";

const router = express.Router();

// ── Helper: garante tabelas ──
async function ensureTables(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS governanca_categorias (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      nome        VARCHAR(100) NOT NULL,
      icone       VARCHAR(50) DEFAULT 'geral',
      cor         VARCHAR(30) DEFAULT '#64748b',
      ordem       INT NOT NULL DEFAULT 0,
      ativo       TINYINT(1) NOT NULL DEFAULT 1,
      criado_em   DATETIME DEFAULT CURRENT_TIMESTAMP,
      atualizado_em DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_nome_cat (nome)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS governanca_itens (
      id              INT AUTO_INCREMENT PRIMARY KEY,
      categoria_id    INT NOT NULL,
      chave           VARCHAR(120) NOT NULL,
      descricao       VARCHAR(300) NOT NULL,
      tipo            ENUM('boolean','select','text') NOT NULL DEFAULT 'boolean',
      opcoes_json     JSON DEFAULT NULL,
      valor_padrao    VARCHAR(500) NOT NULL DEFAULT '0',
      ordem           INT NOT NULL DEFAULT 0,
      ativo           TINYINT(1) NOT NULL DEFAULT 1,
      criado_em       DATETIME DEFAULT CURRENT_TIMESTAMP,
      atualizado_em   DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_chave_item (chave),
      KEY idx_categoria (categoria_id),
      CONSTRAINT fk_gov_cat FOREIGN KEY (categoria_id) REFERENCES governanca_categorias(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Seed padrão: garante que as 6 categorias e 15 itens iniciais existam
  await seedDefaults(db);
}

// ═══════════════════════════════════════════════════════════════
// SEED PADRÃO — 6 categorias + 15 itens (INSERT IGNORE)
// Roda uma única vez (quando tabelas estão vazias)
// ═══════════════════════════════════════════════════════════════
const SEED_CATEGORIAS = [
  { nome: "Boletim",     cor: "#6366f1", ordem: 1 },
  { nome: "Professores", cor: "#10b981", ordem: 2 },
  { nome: "Coordenação", cor: "#f59e0b", ordem: 3 },
  { nome: "Supervisão",  cor: "#ec4899", ordem: 4 },
  { nome: "Secretaria",  cor: "#06b6d4", ordem: 5 },
  { nome: "Geral",       cor: "#64748b", ordem: 6 },
];

const SEED_ITENS = [
  // Boletim
  { cat: "Boletim", chave: "boletim.tipo", descricao: "Tipo de boletim utilizado", tipo: "select", opcoes: ["padrao", "personalizado"], valor_padrao: "padrao", ordem: 1 },
  { cat: "Boletim", chave: "boletim.exibir_faltas", descricao: "Exibir faltas no boletim", tipo: "boolean", opcoes: null, valor_padrao: "1", ordem: 2 },
  { cat: "Boletim", chave: "boletim.exibir_media_turma", descricao: "Exibir média da turma no boletim", tipo: "boolean", opcoes: null, valor_padrao: "0", ordem: 3 },
  // Professores
  { cat: "Professores", chave: "professor.visualiza_relatorio_disciplinar", descricao: "Professor pode visualizar o relatório disciplinar", tipo: "boolean", opcoes: null, valor_padrao: "0", ordem: 1 },
  { cat: "Professores", chave: "professor.acessa_conselho_classe", descricao: "Professor pode acessar o submenu Conselho de Classe", tipo: "boolean", opcoes: null, valor_padrao: "0", ordem: 2 },
  { cat: "Professores", chave: "professor.exporta_notas", descricao: "Professor pode exportar notas bimestrais para o boletim", tipo: "boolean", opcoes: null, valor_padrao: "0", ordem: 3 },
  // Coordenação
  { cat: "Coordenação", chave: "coordenador.cria_gabarito", descricao: "Coordenador pode criar gabarito", tipo: "boolean", opcoes: null, valor_padrao: "1", ordem: 1 },
  { cat: "Coordenação", chave: "coordenador.exporta_notas_bimestrais", descricao: "Coordenador pode exportar notas bimestrais", tipo: "boolean", opcoes: null, valor_padrao: "0", ordem: 2 },
  { cat: "Coordenação", chave: "coordenador.acessa_conselho_classe", descricao: "Coordenador pode acessar o Conselho de Classe", tipo: "boolean", opcoes: null, valor_padrao: "1", ordem: 3 },
  // Supervisão
  { cat: "Supervisão", chave: "supervisor.cria_gabarito", descricao: "Supervisor pode criar gabarito", tipo: "boolean", opcoes: null, valor_padrao: "0", ordem: 1 },
  { cat: "Supervisão", chave: "supervisor.visualiza_relatorio_disciplinar", descricao: "Supervisor pode visualizar relatório disciplinar", tipo: "boolean", opcoes: null, valor_padrao: "1", ordem: 2 },
  // Secretaria
  { cat: "Secretaria", chave: "secretaria.importa_alunos", descricao: "Secretaria pode importar alunos via planilha", tipo: "boolean", opcoes: null, valor_padrao: "1", ordem: 1 },
  { cat: "Secretaria", chave: "secretaria.edita_notas", descricao: "Secretaria pode editar notas diretamente", tipo: "boolean", opcoes: null, valor_padrao: "0", ordem: 2 },
  // Geral
  { cat: "Geral", chave: "geral.ano_letivo_ativo", descricao: "Ano letivo ativo no sistema", tipo: "select", opcoes: ["2024", "2025", "2026"], valor_padrao: "2025", ordem: 1 },
  { cat: "Geral", chave: "geral.bimestre_ativo", descricao: "Bimestre ativo atual", tipo: "select", opcoes: ["1", "2", "3", "4"], valor_padrao: "1", ordem: 2 },
];

async function seedDefaults(db) {
  try {
    const [catCheck] = await db.query("SELECT COUNT(*) AS total FROM governanca_categorias");
    if (catCheck[0]?.total > 0) return; // já tem dados, não sobrescreve

    // Inserir categorias
    for (const cat of SEED_CATEGORIAS) {
      await db.query(
        "INSERT IGNORE INTO governanca_categorias (nome, cor, ordem) VALUES (?, ?, ?)",
        [cat.nome, cat.cor, cat.ordem]
      );
    }

    // Buscar IDs das categorias recém-inseridas
    const [cats] = await db.query("SELECT id, nome FROM governanca_categorias");
    const catMap = {};
    for (const c of cats) catMap[c.nome] = c.id;

    // Inserir itens
    for (const item of SEED_ITENS) {
      const catId = catMap[item.cat];
      if (!catId) continue;
      await db.query(
        `INSERT IGNORE INTO governanca_itens 
         (categoria_id, chave, descricao, tipo, opcoes_json, valor_padrao, ordem)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [catId, item.chave, item.descricao, item.tipo,
         item.opcoes ? JSON.stringify(item.opcoes) : null,
         item.valor_padrao, item.ordem]
      );
    }

    console.log("[CEO-GOV] Seed padrão aplicado: 6 categorias, 15 itens.");
  } catch (err) {
    console.warn("[CEO-GOV] Seed falhou (ignorando):", err?.message || err);
  }
}

// ═══════════════════════════════════════════════════════════════
// CATEGORIAS
// ═══════════════════════════════════════════════════════════════

// ── GET /api/plataforma/governanca/categorias ──
router.get("/categorias", async (req, res) => {
  const db = req.db;
  try {
    await ensureTables(db);
    const [rows] = await db.query(
      "SELECT * FROM governanca_categorias ORDER BY ordem ASC, nome ASC"
    );
    return res.json({ ok: true, categorias: rows });
  } catch (err) {
    console.error("[CEO-GOV][LISTAR CATEGORIAS]", err);
    return res.status(500).json({ ok: false, message: "Erro ao listar categorias." });
  }
});

// ── POST /api/plataforma/governanca/categorias ──
router.post("/categorias", async (req, res) => {
  const db = req.db;
  const { nome, icone, cor, ordem } = req.body;
  if (!nome || !nome.trim())
    return res.status(400).json({ ok: false, message: "Nome é obrigatório." });

  try {
    await ensureTables(db);
    const [result] = await db.query(
      "INSERT INTO governanca_categorias (nome, icone, cor, ordem) VALUES (?, ?, ?, ?)",
      [nome.trim(), icone || "geral", cor || "#64748b", ordem || 0]
    );
    return res.status(201).json({ ok: true, message: "Categoria criada.", id: result.insertId });
  } catch (err) {
    console.error("[CEO-GOV][CRIAR CATEGORIA]", err);
    if (err.code === "ER_DUP_ENTRY")
      return res.status(409).json({ ok: false, message: "Já existe uma categoria com esse nome." });
    return res.status(500).json({ ok: false, message: "Erro ao criar categoria." });
  }
});

// ── PUT /api/plataforma/governanca/categorias/:id ──
router.put("/categorias/:id", async (req, res) => {
  const db = req.db;
  const id = Number(req.params.id);
  const { nome, icone, cor, ordem } = req.body;
  if (!id || !nome?.trim())
    return res.status(400).json({ ok: false, message: "ID e nome obrigatórios." });

  try {
    await db.query(
      "UPDATE governanca_categorias SET nome = ?, icone = ?, cor = ?, ordem = ? WHERE id = ?",
      [nome.trim(), icone || "geral", cor || "#64748b", ordem ?? 0, id]
    );
    return res.json({ ok: true, message: "Categoria atualizada." });
  } catch (err) {
    console.error("[CEO-GOV][EDITAR CATEGORIA]", err);
    if (err.code === "ER_DUP_ENTRY")
      return res.status(409).json({ ok: false, message: "Já existe uma categoria com esse nome." });
    return res.status(500).json({ ok: false, message: "Erro ao atualizar." });
  }
});

// ── DELETE /api/plataforma/governanca/categorias/:id ──
router.delete("/categorias/:id", async (req, res) => {
  const db = req.db;
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ ok: false, message: "ID inválido." });

  try {
    // Primeiro, pegar as chaves dos itens desta categoria para limpar das escolas
    const [itens] = await db.query(
      "SELECT chave FROM governanca_itens WHERE categoria_id = ?", [id]
    );
    const chaves = itens.map(i => i.chave);

    // Excluir da tabela CEO (CASCADE exclui itens)
    await db.query("DELETE FROM governanca_categorias WHERE id = ?", [id]);

    // Limpar das escolas (configuracoes_escola) para manter sincronia
    if (chaves.length > 0) {
      const placeholders = chaves.map(() => "?").join(",");
      await db.query(
        `DELETE FROM configuracoes_escola WHERE chave IN (${placeholders})`,
        chaves
      );
    }

    return res.json({ ok: true, message: "Categoria, itens e configurações de escola removidos." });
  } catch (err) {
    console.error("[CEO-GOV][EXCLUIR CATEGORIA]", err);
    return res.status(500).json({ ok: false, message: "Erro ao excluir." });
  }
});

// ═══════════════════════════════════════════════════════════════
// ITENS
// ═══════════════════════════════════════════════════════════════

// ── GET /api/plataforma/governanca/itens?categoria_id=X ──
router.get("/itens", async (req, res) => {
  const db = req.db;
  const catId = req.query.categoria_id ? Number(req.query.categoria_id) : null;

  try {
    await ensureTables(db);
    let query = `
      SELECT i.*, c.nome AS categoria_nome
      FROM governanca_itens i
      JOIN governanca_categorias c ON c.id = i.categoria_id
    `;
    const params = [];
    if (catId) { query += " WHERE i.categoria_id = ?"; params.push(catId); }
    query += " ORDER BY c.ordem ASC, c.nome ASC, i.ordem ASC, i.chave ASC";

    const [rows] = await db.query(query, params);
    const parsed = rows.map((r) => {
      let opcoes = null;
      try { opcoes = r.opcoes_json ? JSON.parse(r.opcoes_json) : null; } catch { opcoes = null; }
      return { ...r, opcoes_json: opcoes };
    });

    return res.json({ ok: true, itens: parsed });
  } catch (err) {
    console.error("[CEO-GOV][LISTAR ITENS]", err);
    return res.status(500).json({ ok: false, message: "Erro ao listar itens." });
  }
});

// ── POST /api/plataforma/governanca/itens ──
router.post("/itens", async (req, res) => {
  const db = req.db;
  const { categoria_id, chave, descricao, tipo, opcoes_json, valor_padrao, ordem } = req.body;
  if (!categoria_id || !chave?.trim() || !descricao?.trim())
    return res.status(400).json({ ok: false, message: "categoria_id, chave e descricao são obrigatórios." });

  try {
    await ensureTables(db);
    const [result] = await db.query(
      `INSERT INTO governanca_itens 
       (categoria_id, chave, descricao, tipo, opcoes_json, valor_padrao, ordem)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [Number(categoria_id), chave.trim(), descricao.trim(), tipo || "boolean",
       opcoes_json ? JSON.stringify(opcoes_json) : null, valor_padrao ?? "0", ordem ?? 0]
    );
    return res.status(201).json({ ok: true, message: "Item criado.", id: result.insertId });
  } catch (err) {
    console.error("[CEO-GOV][CRIAR ITEM]", err);
    if (err.code === "ER_DUP_ENTRY")
      return res.status(409).json({ ok: false, message: "Já existe um item com essa chave." });
    return res.status(500).json({ ok: false, message: "Erro ao criar item." });
  }
});

// ── PUT /api/plataforma/governanca/itens/:id ──
router.put("/itens/:id", async (req, res) => {
  const db = req.db;
  const id = Number(req.params.id);
  const { chave, descricao, tipo, opcoes_json, valor_padrao, ordem } = req.body;
  if (!id || !chave?.trim())
    return res.status(400).json({ ok: false, message: "ID e chave obrigatórios." });

  try {
    await db.query(
      `UPDATE governanca_itens 
       SET chave = ?, descricao = ?, tipo = ?, opcoes_json = ?, valor_padrao = ?, ordem = ?
       WHERE id = ?`,
      [chave.trim(), descricao?.trim() || "", tipo || "boolean",
       opcoes_json ? JSON.stringify(opcoes_json) : null, valor_padrao ?? "0", ordem ?? 0, id]
    );
    return res.json({ ok: true, message: "Item atualizado." });
  } catch (err) {
    console.error("[CEO-GOV][EDITAR ITEM]", err);
    if (err.code === "ER_DUP_ENTRY")
      return res.status(409).json({ ok: false, message: "Já existe um item com essa chave." });
    return res.status(500).json({ ok: false, message: "Erro ao atualizar." });
  }
});

// ── DELETE /api/plataforma/governanca/itens/:id ──
router.delete("/itens/:id", async (req, res) => {
  const db = req.db;
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ ok: false, message: "ID inválido." });

  try {
    // Buscar chave antes de excluir para limpar das escolas
    const [rows] = await db.query("SELECT chave FROM governanca_itens WHERE id = ?", [id]);
    const chave = rows[0]?.chave;

    await db.query("DELETE FROM governanca_itens WHERE id = ?", [id]);

    // Limpar das escolas
    if (chave) {
      await db.query("DELETE FROM configuracoes_escola WHERE chave = ?", [chave]);
    }

    return res.json({ ok: true, message: "Item removido de todas as escolas." });
  } catch (err) {
    console.error("[CEO-GOV][EXCLUIR ITEM]", err);
    return res.status(500).json({ ok: false, message: "Erro ao excluir." });
  }
});

// ═══════════════════════════════════════════════════════════════
// VISÃO COMPLETA (categorias + itens agrupados)
// ═══════════════════════════════════════════════════════════════
router.get("/completo", async (req, res) => {
  const db = req.db;
  try {
    await ensureTables(db);

    const [cats] = await db.query(
      "SELECT * FROM governanca_categorias WHERE ativo = 1 ORDER BY ordem ASC, nome ASC"
    );
    const [itens] = await db.query(
      "SELECT * FROM governanca_itens WHERE ativo = 1 ORDER BY ordem ASC, chave ASC"
    );

    const resultado = cats.map((cat) => ({
      ...cat,
      itens: itens
        .filter((i) => i.categoria_id === cat.id)
        .map((i) => {
          let opcoes = null;
          try { opcoes = i.opcoes_json ? JSON.parse(i.opcoes_json) : null; } catch { opcoes = null; }
          return { ...i, opcoes_json: opcoes };
        }),
    }));

    return res.json({ ok: true, categorias: resultado });
  } catch (err) {
    console.error("[CEO-GOV][COMPLETO]", err);
    return res.status(500).json({ ok: false, message: "Erro ao carregar visão completa." });
  }
});

export default router;
