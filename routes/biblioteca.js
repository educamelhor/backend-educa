// ============================================================================
// routes/biblioteca.js — Módulo BIBLIOTECA (EDUCA.MELHOR) v2
// Acervo Universal · Estoque por Escola · Empréstimos · Leitor Destaque · Concurso
// ============================================================================
import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { autenticarToken } from '../middleware/autenticarToken.js';
import { verificarEscola } from '../middleware/verificarEscola.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const router = express.Router();

// ── Regra do ano letivo: corte em 15/fev ────────────────────────────────────
function anoLetivoAtual() {
  const hoje = new Date();
  const mes  = hoje.getMonth() + 1;
  const dia  = hoje.getDate();
  if (mes < 2 || (mes === 2 && dia < 15)) return hoje.getFullYear() - 1;
  return hoje.getFullYear();
}

// ── Sanitiza ano: extrai apenas 4 dígitos numéricos ─────────────────────────
// Google Books às vezes retorna "Feb 2024", "2024-02", "2024" etc.
function sanitizarAno(valor) {
  if (!valor && valor !== 0) return null;
  const str = String(valor);
  const match = str.match(/\d{4}/);
  if (!match) return null;
  const ano = parseInt(match[0]);
  return isNaN(ano) ? null : ano;
}

// ─── Upload de capas ────────────────────────────────────────────────────────
const uploadsDir = join(__dirname, '..', 'uploads', 'biblioteca', 'capas');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename:    (_req, file,  cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, `capa_${Date.now()}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    cb(null, ok.includes(file.mimetype));
  },
});

// Middleware padrão do sistema
router.use(autenticarToken);
router.use(verificarEscola);

// Helper: escola_id do request
const escolaId = (req) => req.escola_id || req.headers['x-escola-id'];

// ============================================================================
// ACERVO — Catálogo universal + estoque escolar
// ============================================================================

/** GET /api/biblioteca/acervo/buscar-isbn/:isbn
 *  Verifica se ISBN já existe no catálogo universal.
 *  Retorna {ok, encontrado, livro?} */
router.get('/acervo/buscar-isbn/:isbn', async (req, res) => {
  const db  = req.db;
  const isbn = req.params.isbn.trim().replace(/[-\s]/g, '');
  if (!isbn) return res.status(400).json({ ok: false, error: 'ISBN obrigatório' });

  try {
    const [[livro]] = await db.query(
      'SELECT * FROM biblioteca_acervo WHERE isbn = ? LIMIT 1', [isbn]
    );
    if (!livro) return res.json({ ok: true, encontrado: false });

    // Verifica se a escola já tem esse livro no estoque
    const eid = escolaId(req);
    const [[estoque]] = await db.query(
      'SELECT * FROM biblioteca_acervo_escola WHERE acervo_id = ? AND escola_id = ?',
      [livro.id, eid]
    );
    res.json({ ok: true, encontrado: true, livro, estoque: estoque || null });
  } catch (err) {
    console.error('[BIBLIOTECA] buscar-isbn:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/** GET /api/biblioteca/acervo — lista livros do acervo escolar */
router.get('/acervo', async (req, res) => {
  const db  = req.db;
  const eid = escolaId(req);
  const { q, genero, categoria, disponivel, page = 1, limit = 24 } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);

  try {
    let where = 'WHERE bae.escola_id = ? AND bae.ativo = 1';
    const params = [eid];

    if (q) {
      where += ' AND (ba.titulo LIKE ? OR ba.autor LIKE ? OR ba.isbn LIKE ?)';
      const like = `%${q}%`;
      params.push(like, like, like);
    }
    if (genero)    { where += ' AND ba.genero = ?';    params.push(genero); }
    if (categoria) { where += ' AND ba.categoria = ?'; params.push(categoria); }
    if (disponivel === '1') { where += ' AND bae.exemplares_disponiveis > 0'; }

    const [[{ total }]] = await db.query(
      `SELECT COUNT(*) AS total
       FROM biblioteca_acervo_escola bae
       JOIN biblioteca_acervo ba ON ba.id = bae.acervo_id
       ${where}`, params
    );

    const [livros] = await db.query(
      `SELECT ba.*, bae.id AS estoque_id, bae.exemplares, bae.exemplares_disponiveis, bae.ativo,
         (SELECT COUNT(*) FROM biblioteca_emprestimos be
          WHERE be.livro_id = ba.id AND be.escola_id = ? AND be.status = 'ativo') AS emprestados_agora,
         (SELECT COUNT(*) FROM biblioteca_resenhas br
          WHERE br.livro_id = ba.id AND br.escola_id = ?) AS total_resenhas
       FROM biblioteca_acervo_escola bae
       JOIN biblioteca_acervo ba ON ba.id = bae.acervo_id
       ${where}
       ORDER BY ba.titulo ASC
       LIMIT ? OFFSET ?`,
      [eid, eid, ...params, parseInt(limit), offset]
    );

    res.json({ ok: true, livros, total: parseInt(total), page: parseInt(page), limit: parseInt(limit) });
  } catch (err) {
    console.error('[BIBLIOTECA] acervo list:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/** POST /api/biblioteca/acervo — cadastra livro (acervo universal + estoque escolar)
 *  Fluxo:
 *  1. Se ISBN fornecido e já existe no catálogo universal → usa o id existente
 *  2. Se não existe → INSERT em biblioteca_acervo
 *  3. Insere ou atualiza biblioteca_acervo_escola (exemplares da escola)
 */
router.post('/acervo', async (req, res) => {
  const db  = req.db;
  const eid = escolaId(req);
  const {
    titulo, autor, isbn, editora, ano_publicacao, genero, categoria,
    sinopse, num_paginas, exemplares, capa_url,
  } = req.body;

  if (!titulo) return res.status(400).json({ ok: false, error: 'Título obrigatório' });

  const anoLimpo    = sanitizarAno(ano_publicacao);
  const isbnLimpo   = isbn ? isbn.trim().replace(/[-\s]/g, '') || null : null;
  const exemplaresN = parseInt(exemplares) || 1;

  try {
    let acervoId;

    // ── Passo 1: catálogo universal ─────────────────────────────────────────
    if (isbnLimpo) {
      const [[existente]] = await db.query(
        'SELECT id FROM biblioteca_acervo WHERE isbn = ?', [isbnLimpo]
      );
      if (existente) {
        // Livro já catalogado — atualiza apenas se campos estiverem vazios
        acervoId = existente.id;
        await db.query(
          `UPDATE biblioteca_acervo SET
             titulo    = COALESCE(NULLIF(titulo,''), ?),
             autor     = COALESCE(autor, ?),
             editora   = COALESCE(editora, ?),
             genero    = COALESCE(genero, ?),
             categoria = COALESCE(categoria, ?),
             sinopse   = COALESCE(sinopse, ?),
             num_paginas = COALESCE(num_paginas, ?),
             capa_url  = COALESCE(capa_url, ?)
           WHERE id = ?`,
          [titulo, autor||null, editora||null, genero||null,
           categoria||'juvenil', sinopse||null, num_paginas?parseInt(num_paginas):null,
           capa_url||null, acervoId]
        );
      } else {
        // Novo livro → INSERT universal
        const [r] = await db.query(
          `INSERT INTO biblioteca_acervo
             (isbn, titulo, autor, editora, ano_publicacao, genero, categoria,
              sinopse, num_paginas, capa_url)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [isbnLimpo, titulo, autor||null, editora||null, anoLimpo, genero||null,
           categoria||'juvenil', sinopse||null, num_paginas?parseInt(num_paginas):null,
           capa_url||null]
        );
        acervoId = r.insertId;
      }
    } else {
      // Sem ISBN — sempre insere no catálogo universal
      const [r] = await db.query(
        `INSERT INTO biblioteca_acervo
           (isbn, titulo, autor, editora, ano_publicacao, genero, categoria,
            sinopse, num_paginas, capa_url)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [null, titulo, autor||null, editora||null, anoLimpo, genero||null,
         categoria||'juvenil', sinopse||null, num_paginas?parseInt(num_paginas):null,
         capa_url||null]
      );
      acervoId = r.insertId;
    }

    // ── Passo 2: estoque da escola ──────────────────────────────────────────
    const [[estoqueExistente]] = await db.query(
      'SELECT id FROM biblioteca_acervo_escola WHERE acervo_id = ? AND escola_id = ?',
      [acervoId, eid]
    );

    if (estoqueExistente) {
      // Escola já tem — atualiza exemplares
      await db.query(
        `UPDATE biblioteca_acervo_escola
         SET exemplares = exemplares + ?, exemplares_disponiveis = exemplares_disponiveis + ?,
             ativo = 1
         WHERE acervo_id = ? AND escola_id = ?`,
        [exemplaresN, exemplaresN, acervoId, eid]
      );
    } else {
      await db.query(
        `INSERT INTO biblioteca_acervo_escola
           (acervo_id, escola_id, exemplares, exemplares_disponiveis)
         VALUES (?,?,?,?)`,
        [acervoId, eid, exemplaresN, exemplaresN]
      );
    }

    const [[livro]] = await db.query(
      `SELECT ba.*, bae.id AS estoque_id, bae.exemplares, bae.exemplares_disponiveis
       FROM biblioteca_acervo ba
       JOIN biblioteca_acervo_escola bae ON bae.acervo_id = ba.id AND bae.escola_id = ?
       WHERE ba.id = ?`,
      [eid, acervoId]
    );

    res.status(201).json({ ok: true, livro });
  } catch (err) {
    console.error('[BIBLIOTECA] acervo create:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/** PUT /api/biblioteca/acervo/:id — edita livro (:id = biblioteca_acervo.id) */
router.put('/acervo/:id', async (req, res) => {
  const db  = req.db;
  const eid = escolaId(req);
  const { id } = req.params;
  const {
    titulo, autor, isbn, editora, ano_publicacao, genero, categoria,
    sinopse, num_paginas, exemplares, capa_url, ativo,
  } = req.body;

  try {
    // Verifica que essa escola tem o livro
    const [[bae]] = await db.query(
      'SELECT * FROM biblioteca_acervo_escola WHERE acervo_id = ? AND escola_id = ?', [id, eid]
    );
    if (!bae) return res.status(404).json({ ok: false, error: 'Livro não encontrado no acervo desta escola' });

    // Atualiza metadados universais
    await db.query(
      `UPDATE biblioteca_acervo SET
         titulo = COALESCE(?,titulo), autor = COALESCE(?,autor), editora = COALESCE(?,editora),
         ano_publicacao = ?, genero = COALESCE(?,genero), categoria = COALESCE(?,categoria),
         sinopse = COALESCE(?,sinopse), num_paginas = COALESCE(?,num_paginas),
         capa_url = COALESCE(?,capa_url)
       WHERE id = ?`,
      [titulo||null, autor||null, editora||null,
       sanitizarAno(ano_publicacao) ?? null,
       genero||null, categoria||null, sinopse||null,
       num_paginas?parseInt(num_paginas):null,
       capa_url||null, id]
    );

    // Atualiza estoque escolar
    if (exemplares !== undefined) {
      const novoExemp = parseInt(exemplares) || bae.exemplares;
      const diff      = novoExemp - bae.exemplares;
      const novoDisp  = Math.max(0, bae.exemplares_disponiveis + diff);
      await db.query(
        `UPDATE biblioteca_acervo_escola SET exemplares = ?, exemplares_disponiveis = ?, ativo = ?
         WHERE acervo_id = ? AND escola_id = ?`,
        [novoExemp, novoDisp,
         ativo !== undefined ? (ativo ? 1 : 0) : bae.ativo,
         id, eid]
      );
    } else if (ativo !== undefined) {
      await db.query(
        'UPDATE biblioteca_acervo_escola SET ativo = ? WHERE acervo_id = ? AND escola_id = ?',
        [ativo ? 1 : 0, id, eid]
      );
    }

    const [[livro]] = await db.query(
      `SELECT ba.*, bae.id AS estoque_id, bae.exemplares, bae.exemplares_disponiveis, bae.ativo
       FROM biblioteca_acervo ba
       JOIN biblioteca_acervo_escola bae ON bae.acervo_id = ba.id AND bae.escola_id = ?
       WHERE ba.id = ?`, [eid, id]
    );
    res.json({ ok: true, livro });
  } catch (err) {
    console.error('[BIBLIOTECA] acervo update:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/** POST /api/biblioteca/acervo/:id/capa — upload de imagem de capa */
router.post('/acervo/:id/capa', upload.single('capa'), async (req, res) => {
  const db  = req.db;
  const eid = escolaId(req);
  const { id } = req.params;

  if (!req.file) return res.status(400).json({ ok: false, error: 'Arquivo de imagem não enviado' });

  try {
    // Verifica que essa escola tem o livro
    const [[bae]] = await db.query(
      'SELECT * FROM biblioteca_acervo_escola WHERE acervo_id = ? AND escola_id = ?', [id, eid]
    );
    if (!bae) return res.status(404).json({ ok: false, error: 'Livro não encontrado' });

    const capaUrl = `/uploads/biblioteca/capas/${req.file.filename}`;
    await db.query('UPDATE biblioteca_acervo SET capa_url = ? WHERE id = ?', [capaUrl, id]);
    res.json({ ok: true, capa_url: capaUrl });
  } catch (err) {
    console.error('[BIBLIOTECA] capa upload:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/** DELETE /api/biblioteca/acervo/:id — inativa livro apenas para esta escola */
router.delete('/acervo/:id', async (req, res) => {
  const db  = req.db;
  const eid = escolaId(req);
  const { id } = req.params;
  try {
    await db.query(
      'UPDATE biblioteca_acervo_escola SET ativo = 0 WHERE acervo_id = ? AND escola_id = ?', [id, eid]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ============================================================================
// EMPRÉSTIMOS — Controle de estoque físico
// ============================================================================

/** GET /api/biblioteca/emprestimos — lista empréstimos */
router.get('/emprestimos', async (req, res) => {
  const db  = req.db;
  const eid = escolaId(req);
  const { status, aluno_id, livro_id, page = 1, limit = 30 } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);

  try {
    let where = 'WHERE be.escola_id = ?';
    const params = [eid];

    if (status)   { where += ' AND be.status = ?';   params.push(status); }
    if (aluno_id) { where += ' AND be.aluno_id = ?'; params.push(aluno_id); }
    if (livro_id) { where += ' AND be.livro_id = ?'; params.push(livro_id); }

    const [[{ total }]] = await db.query(
      `SELECT COUNT(*) AS total FROM biblioteca_emprestimos be ${where}`, params
    );

    const [emprestimos] = await db.query(
      `SELECT be.*,
         ba.titulo AS livro_titulo, ba.autor AS livro_autor, ba.capa_url AS livro_capa,
         a.estudante AS aluno_nome, a.turma_id,
         t.nome AS turma_nome
       FROM biblioteca_emprestimos be
       JOIN biblioteca_acervo ba ON ba.id = be.livro_id
       LEFT JOIN alunos a ON a.id = be.aluno_id
       LEFT JOIN turmas t ON t.id = a.turma_id
       ${where}
       ORDER BY be.data_emprestimo DESC
       LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), offset]
    );

    res.json({ ok: true, emprestimos, total: parseInt(total), page: parseInt(page) });
  } catch (err) {
    console.error('[BIBLIOTECA] emprestimos list:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/** POST /api/biblioteca/emprestimos — cria empréstimo (com controle de estoque) */
router.post('/emprestimos', async (req, res) => {
  const db  = req.db;
  const eid = escolaId(req);
  const { livro_id, aluno_id, data_prevista_devolucao, observacao } = req.body;

  if (!livro_id || !aluno_id)
    return res.status(400).json({ ok: false, error: 'livro_id e aluno_id obrigatórios' });

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    // Estoque desta escola — com lock para concorrência segura
    const [[estoque]] = await conn.query(
      `SELECT * FROM biblioteca_acervo_escola
       WHERE acervo_id = ? AND escola_id = ? FOR UPDATE`, [livro_id, eid]
    );
    if (!estoque) {
      await conn.rollback();
      return res.status(404).json({ ok: false, error: 'Livro não encontrado no acervo desta escola' });
    }
    if (estoque.exemplares_disponiveis <= 0) {
      await conn.rollback();
      return res.status(409).json({ ok: false, error: 'Nenhum exemplar disponível para empréstimo' });
    }

    const [result] = await conn.query(
      `INSERT INTO biblioteca_emprestimos
         (escola_id, livro_id, aluno_id, data_prevista_devolucao, observacao, registrado_por)
       VALUES (?,?,?,?,?,?)`,
      [eid, livro_id, aluno_id, data_prevista_devolucao || null, observacao || null,
       req.usuario?.nome || null]
    );

    await conn.query(
      `UPDATE biblioteca_acervo_escola
       SET exemplares_disponiveis = exemplares_disponiveis - 1
       WHERE acervo_id = ? AND escola_id = ?`,
      [livro_id, eid]
    );

    await conn.commit();

    const [[emprestimo]] = await db.query(
      `SELECT be.*, ba.titulo AS livro_titulo, a.estudante AS aluno_nome
       FROM biblioteca_emprestimos be
       JOIN biblioteca_acervo ba ON ba.id = be.livro_id
       LEFT JOIN alunos a ON a.id = be.aluno_id
       WHERE be.id = ?`, [result.insertId]
    );

    res.status(201).json({ ok: true, emprestimo });
  } catch (err) {
    await conn.rollback();
    console.error('[BIBLIOTECA] emprestimo create:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  } finally {
    conn.release();
  }
});

/** PUT /api/biblioteca/emprestimos/:id/devolver — registra devolução */
router.put('/emprestimos/:id/devolver', async (req, res) => {
  const db  = req.db;
  const eid = escolaId(req);
  const { id } = req.params;
  const { observacao } = req.body;

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [[emp]] = await conn.query(
      'SELECT * FROM biblioteca_emprestimos WHERE id = ? AND escola_id = ? FOR UPDATE', [id, eid]
    );
    if (!emp) { await conn.rollback(); return res.status(404).json({ ok: false, error: 'Empréstimo não encontrado' }); }
    if (emp.status === 'devolvido') {
      await conn.rollback();
      return res.status(409).json({ ok: false, error: 'Livro já devolvido' });
    }

    await conn.query(
      `UPDATE biblioteca_emprestimos
       SET status = 'devolvido', data_devolucao = NOW(),
           observacao = COALESCE(?, observacao)
       WHERE id = ?`,
      [observacao || null, id]
    );

    await conn.query(
      `UPDATE biblioteca_acervo_escola
       SET exemplares_disponiveis = exemplares_disponiveis + 1
       WHERE acervo_id = ? AND escola_id = ?`,
      [emp.livro_id, eid]
    );

    await conn.commit();
    res.json({ ok: true });
  } catch (err) {
    await conn.rollback();
    console.error('[BIBLIOTECA] devolucao:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  } finally {
    conn.release();
  }
});

// ============================================================================
// ALUNOS — Histórico de leitura
// ============================================================================

/** GET /api/biblioteca/alunos/:alunoId/historico */
router.get('/alunos/:alunoId/historico', async (req, res) => {
  const db  = req.db;
  const eid = escolaId(req);
  const { alunoId } = req.params;

  try {
    const [emprestimos] = await db.query(
      `SELECT be.*, ba.titulo, ba.autor, ba.capa_url, ba.genero, ba.categoria
       FROM biblioteca_emprestimos be
       JOIN biblioteca_acervo ba ON ba.id = be.livro_id
       WHERE be.escola_id = ? AND be.aluno_id = ?
       ORDER BY be.data_emprestimo DESC`,
      [eid, alunoId]
    );

    const [resenhas] = await db.query(
      `SELECT br.*, ba.titulo AS livro_titulo
       FROM biblioteca_resenhas br
       JOIN biblioteca_acervo ba ON ba.id = br.livro_id
       WHERE br.escola_id = ? AND br.aluno_id = ?
       ORDER BY br.criado_em DESC`,
      [eid, alunoId]
    );

    const [[{ total_livros }]] = await db.query(
      `SELECT COUNT(DISTINCT livro_id) AS total_livros
       FROM biblioteca_emprestimos
       WHERE escola_id = ? AND aluno_id = ?`,
      [eid, alunoId]
    );

    res.json({ ok: true, emprestimos, resenhas, total_livros: parseInt(total_livros) });
  } catch (err) {
    console.error('[BIBLIOTECA] aluno historico:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/** GET /api/biblioteca/turmas/leitores — ranking por turma (ano letivo atual) */
router.get('/turmas/leitores', async (req, res) => {
  const db  = req.db;
  const eid = escolaId(req);
  const anoAtual = anoLetivoAtual();

  try {
    const [turmas] = await db.query(
      `SELECT t.id AS turma_id, t.nome AS turma_nome,
         COUNT(DISTINCT be.aluno_id) AS total_leitores,
         COUNT(be.id) AS total_emprestimos
       FROM turmas t
       INNER JOIN matriculas m
         ON m.turma_id = t.id AND m.escola_id = ? AND m.ano_letivo = ? AND m.status = 'ativo'
       LEFT JOIN biblioteca_emprestimos be
         ON be.aluno_id = m.aluno_id AND be.escola_id = ?
       WHERE t.escola_id = ?
       GROUP BY t.id, t.nome
       ORDER BY total_leitores DESC, total_emprestimos DESC`,
      [eid, anoAtual, eid, eid]
    );
    res.json({ ok: true, turmas, ano_letivo: anoAtual });
  } catch (err) {
    console.error('[BIBLIOTECA] turmas leitores:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ============================================================================
// RESENHAS — Leitor Destaque
// ============================================================================

/** GET /api/biblioteca/resenhas */
router.get('/resenhas', async (req, res) => {
  const db  = req.db;
  const eid = escolaId(req);
  const { status, livro_id, turma_id, page = 1, limit = 20 } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);

  try {
    let where = 'WHERE br.escola_id = ?';
    const params = [eid];

    if (status)   { where += ' AND br.status = ?';   params.push(status); }
    if (livro_id) { where += ' AND br.livro_id = ?'; params.push(livro_id); }
    if (turma_id) { where += ' AND br.turma_id = ?'; params.push(turma_id); }

    const [[{ total }]] = await db.query(
      `SELECT COUNT(*) AS total FROM biblioteca_resenhas br ${where}`, params
    );

    const [resenhas] = await db.query(
      `SELECT br.*,
         ba.titulo AS livro_titulo, ba.autor AS livro_autor, ba.capa_url AS livro_capa,
         a.estudante AS aluno_nome, t.nome AS turma_nome
       FROM biblioteca_resenhas br
       JOIN biblioteca_acervo ba ON ba.id = br.livro_id
       LEFT JOIN alunos a ON a.id = br.aluno_id
       LEFT JOIN turmas t ON t.id = br.turma_id
       ${where}
       ORDER BY br.criado_em DESC
       LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), offset]
    );

    res.json({ ok: true, resenhas, total: parseInt(total), page: parseInt(page) });
  } catch (err) {
    console.error('[BIBLIOTECA] resenhas list:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/** POST /api/biblioteca/resenhas */
router.post('/resenhas', async (req, res) => {
  const db  = req.db;
  const eid = escolaId(req);
  const { livro_id, aluno_id, turma_id, resumo, resenha, favorito, avaliacao, respostas_json } = req.body;

  if (!livro_id || !aluno_id)
    return res.status(400).json({ ok: false, error: 'livro_id e aluno_id obrigatórios' });

  try {
    const [result] = await db.query(
      `INSERT INTO biblioteca_resenhas
         (escola_id, livro_id, aluno_id, turma_id, resumo, resenha, favorito, avaliacao, respostas_json)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [eid, livro_id, aluno_id, turma_id || null, resumo || null, resenha || null,
       favorito || null, avaliacao ? parseInt(avaliacao) : null,
       respostas_json ? JSON.stringify(respostas_json) : null]
    );
    const [[nova]] = await db.query('SELECT * FROM biblioteca_resenhas WHERE id = ?', [result.insertId]);
    res.status(201).json({ ok: true, resenha: nova });
  } catch (err) {
    console.error('[BIBLIOTECA] resenha create:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/** PUT /api/biblioteca/resenhas/:id/status */
router.put('/resenhas/:id/status', async (req, res) => {
  const db  = req.db;
  const eid = escolaId(req);
  const { id } = req.params;
  const { status, pontuacao } = req.body;

  const statusValidos = ['rascunho', 'enviado', 'aprovado', 'destaque'];
  if (!statusValidos.includes(status))
    return res.status(400).json({ ok: false, error: 'Status inválido' });

  try {
    await db.query(
      `UPDATE biblioteca_resenhas SET status = ?, pontuacao = ?,
       aprovado_por = ? WHERE id = ? AND escola_id = ?`,
      [status, pontuacao || 0, req.usuario?.nome || null, id, eid]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[BIBLIOTECA] resenha status:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ============================================================================
// RANKING — Gamificado
// ============================================================================

/** GET /api/biblioteca/ranking */
router.get('/ranking', async (req, res) => {
  const db  = req.db;
  const eid = escolaId(req);
  const { turma_id, mes, ano } = req.query;

  try {
    let dateFilter = '';
    const params = [eid, eid];

    if (mes && ano) {
      dateFilter = 'AND MONTH(be.data_emprestimo) = ? AND YEAR(be.data_emprestimo) = ?';
      params.push(parseInt(mes), parseInt(ano));
    }

    let turmaFilter = '';
    if (turma_id) { turmaFilter = 'AND m.turma_id = ?'; params.push(turma_id); }

    const anoAtual = anoLetivoAtual();

    const [ranking] = await db.query(
      `SELECT
         a.id AS aluno_id, a.estudante AS aluno_nome, a.foto AS aluno_foto,
         t.nome AS turma_nome,
         COUNT(DISTINCT be.id) AS total_livros,
         COALESCE(SUM(br.pontuacao), 0) AS pontuacao_total,
         COUNT(DISTINCT br.id) AS total_resenhas
       FROM alunos a
       -- Apenas alunos matriculados no ano letivo atual
       INNER JOIN matriculas m
         ON m.aluno_id = a.id AND m.escola_id = ? AND m.ano_letivo = ${anoAtual} AND m.status = 'ativo'
       LEFT JOIN turmas t ON t.id = m.turma_id
       LEFT JOIN biblioteca_emprestimos be
         ON be.aluno_id = a.id AND be.escola_id = ? ${dateFilter}
       LEFT JOIN biblioteca_resenhas br
         ON br.aluno_id = a.id AND br.escola_id = ? AND br.status IN ('aprovado','destaque')
       WHERE a.escola_id = ? ${turmaFilter}
       GROUP BY a.id, a.estudante, a.foto, t.nome
       HAVING total_livros > 0
       ORDER BY total_livros DESC, pontuacao_total DESC
       LIMIT 50`,
      [...params, eid, eid]
    );

    res.json({ ok: true, ranking });
  } catch (err) {
    console.error('[BIBLIOTECA] ranking:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ============================================================================
// CONCURSO — Culminância de Leitura
// ============================================================================

router.get('/concurso', async (req, res) => {
  const db  = req.db;
  const eid = escolaId(req);
  try {
    const [concursos] = await db.query(
      'SELECT * FROM biblioteca_concurso WHERE escola_id = ? ORDER BY criado_em DESC', [eid]
    );
    res.json({ ok: true, concursos });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/concurso', async (req, res) => {
  const db  = req.db;
  const eid = escolaId(req);
  const { titulo, descricao, data_inicio, data_fim, regras_json } = req.body;
  if (!titulo) return res.status(400).json({ ok: false, error: 'Título obrigatório' });

  try {
    const [result] = await db.query(
      `INSERT INTO biblioteca_concurso (escola_id, titulo, descricao, data_inicio, data_fim, regras_json)
       VALUES (?,?,?,?,?,?)`,
      [eid, titulo, descricao||null, data_inicio||null, data_fim||null,
       regras_json ? JSON.stringify(regras_json) : null]
    );
    const [[concurso]] = await db.query('SELECT * FROM biblioteca_concurso WHERE id = ?', [result.insertId]);
    res.status(201).json({ ok: true, concurso });
  } catch (err) {
    console.error('[BIBLIOTECA] concurso create:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.put('/concurso/:id/status', async (req, res) => {
  const db  = req.db;
  const eid = escolaId(req);
  const { id } = req.params;
  const { status } = req.body;
  try {
    await db.query(
      'UPDATE biblioteca_concurso SET status = ? WHERE id = ? AND escola_id = ?', [status, id, eid]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ============================================================================
// METADADOS — Painel analítico
// ============================================================================

router.get('/metadados', async (req, res) => {
  const db  = req.db;
  const eid = escolaId(req);
  try {
    const [[stats]] = await db.query(
      `SELECT
         (SELECT COUNT(*) FROM biblioteca_acervo_escola WHERE escola_id = ? AND ativo = 1) AS total_livros,
         (SELECT COUNT(*) FROM biblioteca_emprestimos WHERE escola_id = ? AND status = 'ativo') AS emprestimos_ativos,
         (SELECT COUNT(*) FROM biblioteca_emprestimos WHERE escola_id = ? AND status = 'atrasado') AS emprestimos_atrasados,
         (SELECT COUNT(*) FROM biblioteca_resenhas WHERE escola_id = ? AND status = 'destaque') AS total_destaques,
         (SELECT COUNT(DISTINCT aluno_id) FROM biblioteca_emprestimos WHERE escola_id = ?) AS alunos_leitores`,
      [eid, eid, eid, eid, eid]
    );

    const [generos] = await db.query(
      `SELECT ba.genero, COUNT(*) AS total
       FROM biblioteca_acervo ba
       JOIN biblioteca_acervo_escola bae ON bae.acervo_id = ba.id AND bae.escola_id = ? AND bae.ativo = 1
       WHERE ba.genero IS NOT NULL
       GROUP BY ba.genero ORDER BY total DESC`,
      [eid]
    );

    const [mais_lidos] = await db.query(
      `SELECT ba.id, ba.titulo, ba.autor, ba.capa_url,
         COUNT(be.id) AS total_emprestimos
       FROM biblioteca_acervo ba
       JOIN biblioteca_acervo_escola bae ON bae.acervo_id = ba.id AND bae.escola_id = ? AND bae.ativo = 1
       LEFT JOIN biblioteca_emprestimos be ON be.livro_id = ba.id AND be.escola_id = ?
       GROUP BY ba.id, ba.titulo, ba.autor, ba.capa_url
       ORDER BY total_emprestimos DESC
       LIMIT 10`,
      [eid, eid]
    );

    res.json({ ok: true, stats, generos, mais_lidos });
  } catch (err) {
    console.error('[BIBLIOTECA] metadados:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

export default router;
