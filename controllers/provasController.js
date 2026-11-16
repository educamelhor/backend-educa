// controllers/provasController.js
import pool from '../db.js';

// ── helpers & migração automática de schema (suporte a todos os modelos de escola) ──
const escolaFilter = (escola_id) =>
  escola_id ? '(p.escola_id = ? OR p.escola_id IS NULL)' : '1=1';
const escolaParam  = (escola_id) => (escola_id ? [escola_id] : []);

function parseCfgObj(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return { ...raw };
  try { return JSON.parse(raw) || {}; } catch { return {}; }
}

export function resolveProvaTemplate(prova) {
  if (!prova) return 'modelo_01_provao';
  const cfg = parseCfgObj(prova.config_json);
  return cfg.modelo_slug || prova.template_slug || 'modelo_01_provao';
}

function serializarCfgComModelo(config_json, templateFinal, existingRaw = null) {
  const base = existingRaw ? parseCfgObj(existingRaw) : {};
  const incoming = parseCfgObj(config_json);
  const merged = {
    ...base,
    ...incoming,
    modelo_slug: templateFinal || incoming.modelo_slug || base.modelo_slug || 'modelo_01_provao',
  };
  return JSON.stringify(merged);
}

let schemaReadyPromise = null;
export function ensureProvasSchema() {
  if (!schemaReadyPromise) {
    schemaReadyPromise = (async () => {
      try {
        // Converte eventual ENUM legado da Sprint 3 em VARCHAR(64) para suportar modelo_01_provao e futuros modelos
        await pool.query(
          "ALTER TABLE provas MODIFY COLUMN template_slug VARCHAR(64) NOT NULL DEFAULT 'modelo_01_provao'"
        );
      } catch (err) {
        console.warn('[ensureProvasSchema] Aviso ao ajustar coluna template_slug:', err.message);
      }
      try {
        // Migra provas criadas antes da conversão do ENUM (onde modelo_slug ainda não era objetiva_2col explícito)
        await pool.query(
          `UPDATE provas
              SET template_slug = 'modelo_01_provao'
            WHERE (template_slug IS NULL OR template_slug = '' OR template_slug = 'objetiva_2col')
              AND (config_json IS NULL OR config_json NOT LIKE '%"modelo_slug":"objetiva_2col"%')`
        );
      } catch (err) {
        console.warn('[ensureProvasSchema] Aviso ao normalizar registros existentes:', err.message);
      }
    })();
  }
  return schemaReadyPromise;
}

// ── 1) LISTAR provas da escola ────────────────────────────────────────────────
export async function listarProvas(req, res) {
  const { escola_id } = req.user;
  const { status } = req.query;
  try {
    await ensureProvasSchema();
    const cond   = [escolaFilter(escola_id)];
    const params = [...escolaParam(escola_id)];
    if (status) { cond.push('p.status = ?'); params.push(status); }

    const [provas] = await pool.query(
      `SELECT p.*,
        (SELECT COUNT(*) FROM prova_questoes pq WHERE pq.prova_id = p.id) AS total_questoes,
        (SELECT COALESCE(SUM(pq.valor_pontos),0) FROM prova_questoes pq WHERE pq.prova_id = p.id) AS total_pontos
       FROM provas p
       WHERE ${cond.join(' AND ')}
       ORDER BY p.id DESC`,
      params
    );
    res.json(provas.map((p) => ({ ...p, template_slug: resolveProvaTemplate(p) })));
  } catch (err) {
    console.error('listarProvas:', err);
    res.status(500).json({ message: 'Erro no servidor.' });
  }
}

// ── 2) OBTER prova completa (com questões) ────────────────────────────────────
export async function obterProva(req, res) {
  const { id } = req.params;
  const { escola_id } = req.user;
  try {
    await ensureProvasSchema();
    const [[prova]] = await pool.query(
      `SELECT * FROM provas p
       WHERE p.id = ? AND ${escolaFilter(escola_id)}`,
      [id, ...escolaParam(escola_id)]
    );
    if (!prova) return res.status(404).json({ message: 'Prova não encontrada.' });

    const [itens] = await pool.query(
      `SELECT pq.id, pq.ordem, pq.valor_pontos,
              q.id AS questao_id,
              CONCAT('EMQE-', LPAD(COALESCE(q.numero_q, q.id), 5, '0')) AS codigo,
              q.conteudo_bruto, q.comando_final, q.tipo, q.nivel,
              q.disciplina, q.alternativas_json, q.estrutura_json,
              q.correta, q.resposta_aberta, q.tags,
              q.habilidade_bncc, q.imagem_url, q.imagem_base64, q.midia_json,
              q.texto_apoio, q.fonte, q.explicacao
       FROM prova_questoes pq
       JOIN questoes q ON q.id = pq.questao_id
       WHERE pq.prova_id = ?
       ORDER BY pq.ordem ASC`,
      [id]
    );
    res.json({ ...prova, template_slug: resolveProvaTemplate(prova), itens });
  } catch (err) {
    console.error('obterProva:', err);
    res.status(500).json({ message: 'Erro no servidor.' });
  }
}

// ── 3) CRIAR prova ────────────────────────────────────────────────────────────
export async function criarProva(req, res) {
  const { escola_id, professor_id } = req.user;
  const {
    titulo = 'Nova Prova', disciplina, turma, bimestre,
    ano_letivo, template_slug = 'modelo_01_provao', config_json,
  } = req.body;
  try {
    await ensureProvasSchema();
    const templateFinal = template_slug || 'modelo_01_provao';
    const cfgSerialized = serializarCfgComModelo(config_json, templateFinal);

    let insertId;
    try {
      const [r] = await pool.query(
        `INSERT INTO provas
          (escola_id, professor_id, titulo, disciplina, turma, bimestre, ano_letivo, template_slug, config_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          escola_id || null, professor_id || null,
          titulo, disciplina || null, turma || null,
          bimestre || null, ano_letivo || new Date().getFullYear(),
          templateFinal, cfgSerialized,
        ]
      );
      insertId = r.insertId;
    } catch (dbErr) {
      // Fallback defensivo caso o banco restrinja DDL em ENUM legado (preserva modelo_slug em config_json)
      const [rFallback] = await pool.query(
        `INSERT INTO provas
          (escola_id, professor_id, titulo, disciplina, turma, bimestre, ano_letivo, template_slug, config_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          escola_id || null, professor_id || null,
          titulo, disciplina || null, turma || null,
          bimestre || null, ano_letivo || new Date().getFullYear(),
          'objetiva_2col', cfgSerialized,
        ]
      );
      insertId = rFallback.insertId;
    }
    res.status(201).json({ id: insertId, template_slug: templateFinal, message: 'Prova criada.' });
  } catch (err) {
    console.error('criarProva:', err);
    res.status(500).json({ message: 'Erro ao criar prova.', detail: err.message });
  }
}

// ── 4) ATUALIZAR prova ────────────────────────────────────────────────────────
export async function atualizarProva(req, res) {
  const { id } = req.params;
  const { escola_id } = req.user;
  const {
    titulo, disciplina, turma, bimestre, ano_letivo,
    template_slug, config_json, status,
  } = req.body;
  try {
    await ensureProvasSchema();
    const [[atual]] = await pool.query(
      `SELECT config_json, template_slug FROM provas p WHERE p.id = ? AND ${escolaFilter(escola_id)}`,
      [id, ...escolaParam(escola_id)]
    );
    if (!atual) return res.status(404).json({ message: 'Prova não encontrada.' });

    const templateFinal = template_slug || resolveProvaTemplate(atual);
    const cfgSerialized = serializarCfgComModelo(config_json, templateFinal, atual.config_json);

    try {
      await pool.query(
        `UPDATE provas SET
          titulo = ?, disciplina = ?, turma = ?, bimestre = ?, ano_letivo = ?,
          template_slug = ?, config_json = ?, status = COALESCE(?, status), atualizada_em = NOW()
         WHERE id = ? AND ${escolaFilter(escola_id)}`,
        [
          titulo, disciplina || null, turma || null, bimestre || null,
          ano_letivo || null, templateFinal,
          cfgSerialized,
          status || null,
          id, ...escolaParam(escola_id),
        ]
      );
    } catch (dbErr) {
      await pool.query(
        `UPDATE provas SET
          titulo = ?, disciplina = ?, turma = ?, bimestre = ?, ano_letivo = ?,
          template_slug = 'objetiva_2col', config_json = ?, status = COALESCE(?, status), atualizada_em = NOW()
         WHERE id = ? AND ${escolaFilter(escola_id)}`,
        [
          titulo, disciplina || null, turma || null, bimestre || null,
          ano_letivo || null,
          cfgSerialized,
          status || null,
          id, ...escolaParam(escola_id),
        ]
      );
    }
    res.json({ message: 'Prova atualizada.', template_slug: templateFinal });
  } catch (err) {
    console.error('atualizarProva:', err);
    res.status(500).json({ message: 'Erro ao atualizar prova.', detail: err.message });
  }
}

// ── 5) EXCLUIR prova ──────────────────────────────────────────────────────────
export async function excluirProva(req, res) {
  const { id } = req.params;
  const { escola_id } = req.user;
  try {
    // Verifica se a prova pertence à escola (usa alias p para compatibilidade com escolaFilter)
    const [[prova]] = await pool.query(
      `SELECT p.id FROM provas p WHERE p.id = ? AND ${escolaFilter(escola_id)}`,
      [id, ...escolaParam(escola_id)]
    );
    if (!prova) return res.status(404).json({ message: 'Prova não encontrada.' });

    // Apaga primeiro os itens (FK constraint)
    await pool.query('DELETE FROM prova_questoes WHERE prova_id = ?', [id]);
    // Apaga a prova
    await pool.query('DELETE FROM provas WHERE id = ?', [id]);

    res.status(204).end();
  } catch (err) {
    console.error('excluirProva:', err);
    res.status(500).json({ message: 'Erro ao excluir prova.', detail: err.message });
  }
}

// ── 6) ADICIONAR questão à prova ──────────────────────────────────────────────
export async function addQuestaoProva(req, res) {
  const { id } = req.params; // prova_id
  const { questao_id, valor_pontos = 1.0 } = req.body;
  const { professor_id } = req.user || {};
  try {
    const [[{ maxOrdem }]] = await pool.query(
      'SELECT COALESCE(MAX(ordem), 0) AS maxOrdem FROM prova_questoes WHERE prova_id = ?', [id]
    );
    const [r] = await pool.query(
      'INSERT INTO prova_questoes (prova_id, questao_id, ordem, valor_pontos) VALUES (?, ?, ?, ?)',
      [id, questao_id, maxOrdem + 1, valor_pontos]
    );
    // Sprint 5: incrementa contador de uso e registra histórico
    await pool.query(
      'UPDATE questoes SET vezes_utilizada = COALESCE(vezes_utilizada,0) + 1 WHERE id = ?',
      [questao_id]
    );
    pool.query(
      `INSERT IGNORE INTO questoes_historico (questao_id, usuario_id, acao, prova_id, criado_em)
       VALUES (?, ?, 'usou_em_prova', ?, NOW())`,
      [questao_id, professor_id || null, id]
    ).catch(() => {});

    res.status(201).json({ id: r.insertId, ordem: maxOrdem + 1 });
  } catch (err) {
    console.error('addQuestaoProva:', err);
    res.status(500).json({ message: 'Erro ao adicionar questão.', detail: err.message });
  }
}


// ── 7) REMOVER questão da prova ───────────────────────────────────────────────
export async function removeQuestaoProva(req, res) {
  const { id, itemId } = req.params;
  try {
    await pool.query('DELETE FROM prova_questoes WHERE id = ? AND prova_id = ?', [itemId, id]);
    res.status(204).end();
  } catch (err) {
    console.error('removeQuestaoProva:', err);
    res.status(500).json({ message: 'Erro ao remover questão.' });
  }
}

// ── 8) ATUALIZAR item (pontos) ────────────────────────────────────────────────
export async function atualizarItemProva(req, res) {
  const { id, itemId } = req.params;
  const { valor_pontos } = req.body;
  try {
    await pool.query(
      'UPDATE prova_questoes SET valor_pontos = ? WHERE id = ? AND prova_id = ?',
      [valor_pontos, itemId, id]
    );
    res.json({ message: 'Item atualizado.' });
  } catch (err) {
    console.error('atualizarItemProva:', err);
    res.status(500).json({ message: 'Erro ao atualizar item.' });
  }
}

// ── 9) REORDENAR questões ─────────────────────────────────────────────────────
export async function reordenarProva(req, res) {
  const { id } = req.params;
  const { ordem } = req.body; // [{id: itemId, ordem: N}, ...]
  if (!Array.isArray(ordem)) return res.status(400).json({ message: 'Payload inválido.' });
  try {
    const conn = await pool.getConnection();
    await conn.beginTransaction();
    for (const item of ordem) {
      await conn.query(
        'UPDATE prova_questoes SET ordem = ? WHERE id = ? AND prova_id = ?',
        [item.ordem, item.id, id]
      );
    }
    await conn.commit();
    conn.release();
    res.json({ message: 'Reordenado.' });
  } catch (err) {
    console.error('reordenarProva:', err);
    res.status(500).json({ message: 'Erro ao reordenar.' });
  }
}

// ── 10) SINCRONIZAR lista completa de questões da prova (edição atômica) ──────
export async function sincronizarQuestoesProva(req, res) {
  const { id } = req.params;
  const { escola_id, professor_id } = req.user || {};
  const { itens } = req.body; // [{ questao_id, valor_pontos }]
  if (!Array.isArray(itens)) {
    return res.status(400).json({ message: 'Informe o array itens.' });
  }

  let conn = null;
  try {
    const [[prova]] = await pool.query(
      `SELECT p.id FROM provas p WHERE p.id = ? AND ${escolaFilter(escola_id)}`,
      [id, ...escolaParam(escola_id)]
    );
    if (!prova) return res.status(404).json({ message: 'Prova não encontrada.' });

    conn = await pool.getConnection();
    await conn.beginTransaction();

    const [atuais] = await conn.query(
      'SELECT questao_id FROM prova_questoes WHERE prova_id = ?',
      [id]
    );
    const jaExistiamSet = new Set(atuais.map((r) => Number(r.questao_id)));

    await conn.query('DELETE FROM prova_questoes WHERE prova_id = ?', [id]);

    const inseridos = [];
    for (let idx = 0; idx < itens.length; idx++) {
      const qid = Number(itens[idx].questao_id);
      if (!qid) continue;
      const pts = Number(itens[idx].valor_pontos) || 1.0;
      const [ins] = await conn.query(
        'INSERT INTO prova_questoes (prova_id, questao_id, ordem, valor_pontos) VALUES (?, ?, ?, ?)',
        [id, qid, idx + 1, pts]
      );
      inseridos.push({ id: ins.insertId, questao_id: qid, ordem: idx + 1, valor_pontos: pts });

      if (!jaExistiamSet.has(qid)) {
        await conn.query(
          'UPDATE questoes SET vezes_utilizada = COALESCE(vezes_utilizada, 0) + 1 WHERE id = ?',
          [qid]
        );
        conn.query(
          `INSERT IGNORE INTO questoes_historico (questao_id, usuario_id, acao, prova_id, criado_em)
           VALUES (?, ?, 'usou_em_prova', ?, NOW())`,
          [qid, professor_id || null, id]
        ).catch(() => {});
      }
    }

    await conn.commit();
    conn.release();
    conn = null;
    res.json({ ok: true, itens: inseridos });
  } catch (err) {
    if (conn) {
      await conn.rollback().catch(() => {});
      conn.release();
    }
    console.error('sincronizarQuestoesProva:', err);
    res.status(500).json({ message: 'Erro ao sincronizar questões da prova.', detail: err.message });
  }
}
