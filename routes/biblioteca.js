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
import crypto from 'crypto';
import sharp from 'sharp';
import { uploadFileBufferToSpaces } from '../storage/spacesUpload.js';
import PDFDocument from 'pdfkit';
import { PassThrough } from 'stream';
import { getEscolaLogos } from '../utils/logoHelper.js';
import pool from '../db.js';

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
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    cb(null, ok.includes(file.mimetype));
  },
});

// ============================================================================
// ROTAS PÚBLICAS (Sem Autenticação)
// ============================================================================

/** GET /api/biblioteca/vitrine/:escolaId — Rota PÚBLICA para Vitrine */
router.get('/vitrine/:escolaId', async (req, res) => {
  const eid = req.params.escolaId;
  // Fallback to import db temporarily or assume it's attached elsewhere if possible, but normally it's attached via middleware.
  // Wait, req.db is attached by a global middleware in server.js? Let's check where req.db comes from.
  // Often it comes from a middleware before `router`. 
  // We'll use the pool directly or just try using req.db.
  if (!req.db) {
    return res.status(500).json({ ok: false, error: 'DB não anexado' });
  }
  const db = req.db;
  try {
    const [resenhas] = await db.query(
      `SELECT br.id, br.avaliacao, br.resumo, br.resenha, br.favorito,
         ba.titulo AS livro_titulo, ba.autor AS livro_autor, ba.capa_url AS livro_capa,
         t.nome AS turma_nome
       FROM biblioteca_resenhas br
       JOIN biblioteca_acervo ba ON ba.id = br.livro_id
       LEFT JOIN matriculas m ON m.aluno_id = br.aluno_id AND m.escola_id = br.escola_id AND m.status = 'ativo'
       LEFT JOIN turmas t ON t.id = m.turma_id
       WHERE br.escola_id = ? AND br.status = 'destaque'
       ORDER BY br.updated_at DESC LIMIT 50`,
      [eid]
    );
    res.json({ ok: true, destaques: resenhas });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ============================================================================
// ROTAS PRIVADAS
// ============================================================================

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
      where += ' AND (ba.titulo LIKE ? OR ba.autor LIKE ? OR ba.isbn LIKE ? OR ba.editora LIKE ? OR ba.genero LIKE ? OR bae.local_estante LIKE ?)';
      const like = `%${q}%`;
      params.push(like, like, like, like, like, like);
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
      `SELECT ba.*, bae.id AS estoque_id, bae.exemplares, bae.exemplares_disponiveis, bae.local_estante, bae.ativo,
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

/** GET /api/biblioteca/acervo/relatorio-pdf — Gera PDF institucional com a lista de livros do acervo */
router.get('/acervo/relatorio-pdf', async (req, res) => {
  const db = req.db || pool;
  const eid = escolaId(req);
  const { q, categoria, disponivel } = req.query;

  try {
    // 1. Dados da escola
    const [[escola]] = await db.query(
      "SELECT id, nome, apelido, endereco, cidade, estado FROM escolas WHERE id = ?",
      [eid]
    );

    // 2. Logos institucionais
    const { logoLeft, logoRight, hasLogoLeft, hasLogoRight } = await getEscolaLogos(eid);

    // 3. Buscar livros cadastrados no acervo da escola
    let where = 'WHERE bae.escola_id = ? AND bae.ativo = 1';
    const params = [eid];

    if (q) {
      where += ' AND (ba.titulo LIKE ? OR ba.autor LIKE ? OR ba.isbn LIKE ? OR ba.editora LIKE ? OR ba.genero LIKE ? OR bae.local_estante LIKE ?)';
      const like = `%${q}%`;
      params.push(like, like, like, like, like, like);
    }
    if (categoria) {
      where += ' AND ba.categoria = ?';
      params.push(categoria);
    }
    if (disponivel === '1') {
      where += ' AND bae.exemplares_disponiveis > 0';
    }

    const [livros] = await db.query(
      `SELECT ba.isbn, ba.titulo, ba.autor, ba.editora, bae.exemplares, bae.exemplares_disponiveis, bae.local_estante
       FROM biblioteca_acervo_escola bae
       JOIN biblioteca_acervo ba ON ba.id = bae.acervo_id
       ${where}
       ORDER BY ba.titulo ASC`,
      params
    );

    // 4. Parâmetros de página A4
    const L = 40;
    const R = 40;
    const PW = 595.28 - L - R; // 515.28 pt
    const PAGE_H = 841.89;
    const FOOTER_Y = PAGE_H - 25;
    const MAX_Y = FOOTER_Y - 15;

    const doc = new PDFDocument({
      size: "A4",
      margins: { top: 30, bottom: 0, left: L, right: R },
      autoFirstPage: true,
      bufferPages: true,
      info: {
        Title: "Catálogo do Acervo da Biblioteca",
        Author: "EDUCA.MELHOR — Sistema Educacional",
        Subject: "Lista de Livros do Acervo Escolar",
      },
    });

    res.setHeader("Content-Type", "application/pdf");
    const nomeArquivo = `lista_acervo_livros_${new Date().toISOString().slice(0, 10)}.pdf`;
    res.setHeader("Content-Disposition", `inline; filename="${nomeArquivo}"`);

    const pdfChunks = [];
    const passThrough = new PassThrough();
    passThrough.on("data", (chunk) => pdfChunks.push(chunk));
    doc.pipe(passThrough);

    // Cores oficiais da plataforma (padrão Módulo Impressão)
    const COR_AZUL = "#1e3a5f";
    const COR_DOURADO = "#b8860b";
    const COR_CINZA = "#555";

    // Dimensões da tabela:
    // Colunas: Nº, ISBN, TÍTULO, AUTOR, EDITORA
    const COL_N_W = 24;
    const COL_ISBN_W = 86;
    const COL_TITULO_W = 190;
    const COL_AUTOR_W = 120;
    const COL_EDITORA_W = PW - COL_N_W - COL_ISBN_W - COL_TITULO_W - COL_AUTOR_W; // 95.28 pt
    const TH = 16;
    const TR = 20;

    const thCols = [
      { text: "Nº", w: COL_N_W, align: "center" },
      { text: "ISBN", w: COL_ISBN_W, align: "center" },
      { text: "TÍTULO", w: COL_TITULO_W, align: "left" },
      { text: "AUTOR", w: COL_AUTOR_W, align: "left" },
      { text: "EDITORA", w: COL_EDITORA_W, align: "left" },
    ];

    function drawTableHeader(y) {
      doc.rect(L, y, PW, TH).fill(COR_AZUL);
      let tx = L;
      thCols.forEach((col) => {
        doc
          .font("Helvetica-Bold")
          .fontSize(7.5)
          .fillColor("#fff")
          .text(col.text, tx + 4, y + 4.5, {
            width: col.w - 8,
            align: col.align,
            lineBreak: false,
          });
        tx += col.w;
      });
      return y + TH;
    }

    function ensureSpace(needed) {
      if (doc.y + needed > MAX_Y) {
        doc.addPage();
        doc.y = 30;
        doc.y = drawTableHeader(doc.y);
      }
    }

    // ── Cabeçalho Institucional ─────────────────────────────────────
    const headerTop = doc.y;
    const logoSize = 58;

    if (hasLogoLeft) {
      doc.image(logoLeft, L, headerTop, { width: logoSize, height: logoSize });
    }
    if (hasLogoRight) {
      doc.image(logoRight, L + PW - logoSize, headerTop, { width: logoSize, height: logoSize });
    }

    const hx = L + logoSize + 8;
    const hw = PW - (logoSize + 8) * 2;

    doc
      .font("Helvetica-Bold")
      .fontSize(9)
      .fillColor(COR_AZUL)
      .text("SECRETARIA DE ESTADO DE EDUCAÇÃO DO DISTRITO FEDERAL", hx, headerTop + 4, {
        width: hw,
        align: "center",
      });

    doc
      .font("Helvetica-Bold")
      .fontSize(8.5)
      .fillColor(COR_AZUL)
      .text(
        `COORDENAÇÃO REGIONAL DE ENSINO DE ${(escola?.cidade || "PLANALTINA").toUpperCase()}`,
        hx,
        doc.y + 1,
        { width: hw, align: "center" }
      );

    const escolaNome = escola?.nome || "CENTRO DE ENSINO FUNDAMENTAL 04";
    const escolaApelido = escola?.apelido || "";
    const nomeCompleto = escolaApelido ? `${escolaNome} — ${escolaApelido}` : escolaNome;
    doc
      .font("Helvetica-Bold")
      .fontSize(9)
      .fillColor(COR_AZUL)
      .text(nomeCompleto.toUpperCase(), hx, doc.y + 1, { width: hw, align: "center" });

    const enderecoEscola = escola?.endereco || "Endereço não cadastrado";
    doc
      .font("Helvetica")
      .fontSize(7.5)
      .fillColor(COR_CINZA)
      .text(enderecoEscola, hx, doc.y + 1, { width: hw, align: "center" });

    doc.y = headerTop + logoSize + 4;

    // Linhas decorativas (Dourado + Azul)
    doc.moveTo(L, doc.y).lineTo(L + PW, doc.y).strokeColor(COR_DOURADO).lineWidth(2).stroke();
    doc.y += 3;
    doc.moveTo(L, doc.y).lineTo(L + PW, doc.y).strokeColor(COR_AZUL).lineWidth(0.8).stroke();
    doc.y += 8;

    // Título do Relatório
    doc
      .font("Helvetica-Bold")
      .fontSize(13)
      .fillColor(COR_AZUL)
      .text("CATÁLOGO DO ACERVO DA BIBLIOTECA", L, doc.y, { width: PW, align: "center" });
    doc.y += 5;

    doc.moveTo(L, doc.y).lineTo(L + PW, doc.y).strokeColor("#ccc").lineWidth(0.5).stroke();
    doc.y += 6;

    // Barra de Resumo
    const infoY = doc.y;
    const infoH = 18;
    doc.roundedRect(L, infoY, PW, infoH, 3).fill("#f0f4ff");
    doc.roundedRect(L, infoY, PW, infoH, 3).strokeColor("#c7d2fe").lineWidth(0.5).stroke();

    const infoTextY = infoY + 5;
    const colW = PW / 4;
    const dataFormatada = new Date().toLocaleDateString("pt-BR");
    const infoCols = [
      { label: "Módulo:", value: "Biblioteca Escolar" },
      { label: "Ano Letivo:", value: String(anoLetivoAtual()) },
      { label: "Data de Emissão:", value: dataFormatada },
      { label: "Total Cadastrado:", value: `${livros.length} título(s)` },
    ];

    infoCols.forEach((col, i) => {
      const cx = L + colW * i + 6;
      doc
        .font("Helvetica-Bold")
        .fontSize(7)
        .fillColor(COR_AZUL)
        .text(col.label, cx, infoTextY, { width: colW - 12, lineBreak: false, continued: true });
      doc
        .font("Helvetica")
        .fontSize(7)
        .fillColor("#334155")
        .text(` ${col.value}`, { lineBreak: false });
    });

    doc.y = infoY + infoH + 8;

    // Cabeçalho da tabela da 1ª página
    doc.y = drawTableHeader(doc.y);

    // Linhas da tabela
    if (livros.length === 0) {
      doc.y += 15;
      doc
        .font("Helvetica-Oblique")
        .fontSize(9)
        .fillColor("#64748b")
        .text("Nenhum livro cadastrado no acervo escolar.", L, doc.y, { width: PW, align: "center" });
    } else {
      livros.forEach((livro, i) => {
        ensureSpace(TR + 2);
        const rowY = doc.y;
        const isEven = i % 2 === 0;

        if (isEven) doc.rect(L, rowY, PW, TR).fill("#f8fafc");

        // Borda inferior
        doc.moveTo(L, rowY + TR).lineTo(L + PW, rowY + TR).strokeColor("#cbd5e1").lineWidth(0.3).stroke();

        // Linhas verticais separadoras
        let lx = L;
        doc.moveTo(lx + COL_N_W, rowY).lineTo(lx + COL_N_W, rowY + TR).strokeColor("#e2e8f0").lineWidth(0.3).stroke();
        lx += COL_N_W;
        doc.moveTo(lx + COL_ISBN_W, rowY).lineTo(lx + COL_ISBN_W, rowY + TR).strokeColor("#e2e8f0").lineWidth(0.3).stroke();
        lx += COL_ISBN_W;
        doc.moveTo(lx + COL_TITULO_W, rowY).lineTo(lx + COL_TITULO_W, rowY + TR).strokeColor("#e2e8f0").lineWidth(0.3).stroke();
        lx += COL_TITULO_W;
        doc.moveTo(lx + COL_AUTOR_W, rowY).lineTo(lx + COL_AUTOR_W, rowY + TR).strokeColor("#e2e8f0").lineWidth(0.3).stroke();

        // Nº
        doc
          .font("Helvetica")
          .fontSize(7)
          .fillColor("#64748b")
          .text(String(i + 1), L + 2, rowY + 6, {
            width: COL_N_W - 4,
            align: "center",
            lineBreak: false,
          });

        // ISBN
        doc
          .font("Helvetica-Bold")
          .fontSize(7)
          .fillColor(COR_AZUL)
          .text(livro.isbn || "—", L + COL_N_W + 4, rowY + 6, {
            width: COL_ISBN_W - 8,
            align: "center",
            lineBreak: false,
          });

        // TÍTULO
        doc
          .font("Helvetica-Bold")
          .fontSize(7.5)
          .fillColor("#0f172a")
          .text(livro.titulo || "—", L + COL_N_W + COL_ISBN_W + 6, rowY + 6, {
            width: COL_TITULO_W - 12,
            lineBreak: false,
            ellipsis: true,
          });

        // AUTOR
        doc
          .font("Helvetica")
          .fontSize(7.2)
          .fillColor("#334155")
          .text(livro.autor || "—", L + COL_N_W + COL_ISBN_W + COL_TITULO_W + 6, rowY + 6, {
            width: COL_AUTOR_W - 12,
            lineBreak: false,
            ellipsis: true,
          });

        // EDITORA
        doc
          .font("Helvetica")
          .fontSize(7.2)
          .fillColor("#475569")
          .text(livro.editora || "—", L + COL_N_W + COL_ISBN_W + COL_TITULO_W + COL_AUTOR_W + 6, rowY + 6, {
            width: COL_EDITORA_W - 12,
            lineBreak: false,
            ellipsis: true,
          });

        doc.y = rowY + TR;
      });
    }

    // Borda externa inferior e rodapé em todas as páginas com numeração de página
    const range = doc.bufferedPageRange();
    for (let p = 0; p < range.count; p++) {
      doc.switchToPage(p);
      doc
        .font("Helvetica")
        .fontSize(6.5)
        .fillColor("#94a3b8")
        .text(
          `CATÁLOGO DO ACERVO DA BIBLIOTECA • Documento gerado pelo EDUCA.MELHOR • Página ${p + 1} de ${range.count}`,
          L,
          FOOTER_Y,
          { width: PW, align: "center", lineBreak: false }
        );
    }

    passThrough.on("end", () => {
      const pdfBuffer = Buffer.concat(pdfChunks);
      res.setHeader("Content-Length", pdfBuffer.length);
      res.end(pdfBuffer);
    });
    doc.end();
  } catch (err) {
    console.error("[BIBLIOTECA] Erro ao gerar PDF do acervo:", err);
    if (!res.headersSent) res.status(500).json({ ok: false, error: err.message });
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
    sinopse, num_paginas, exemplares, local_estante, capa_url,
  } = req.body;

  const anoLimpo    = sanitizarAno(ano_publicacao);
  const isbnLimpo   = isbn ? isbn.trim().replace(/[-\s]/g, '') || null : null;
  const exemplaresN = parseInt(exemplares) || 1;

  if (!isbnLimpo || isbnLimpo.length < 10)
    return res.status(400).json({ ok: false, error: 'O código ISBN é obrigatório (mínimo 10 dígitos)' });
  if (!titulo || !titulo.trim()) return res.status(400).json({ ok: false, error: 'Título é obrigatório' });
  if (!autor || !autor.trim()) return res.status(400).json({ ok: false, error: 'Autor(es) é obrigatório' });
  if (!editora || !editora.trim()) return res.status(400).json({ ok: false, error: 'Editora é obrigatória' });
  if (!anoLimpo) return res.status(400).json({ ok: false, error: 'Ano de publicação válido é obrigatório' });
  if (!num_paginas || parseInt(num_paginas) <= 0) return res.status(400).json({ ok: false, error: 'Nº de páginas é obrigatório' });
  if (!genero || !genero.trim()) return res.status(400).json({ ok: false, error: 'Gênero / Assunto é obrigatório' });
  if (!categoria || !categoria.trim()) return res.status(400).json({ ok: false, error: 'Categoria é obrigatória' });
  if (!exemplares || parseInt(exemplares) <= 0) return res.status(400).json({ ok: false, error: 'Quantidade de exemplares deve ser de pelo menos 1' });

  try {
    let acervoId;

    // ── Passo 1: catálogo universal (ISBN estritamente obrigatório) ─────────
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
      // Novo livro → INSERT universal com ISBN obrigatório
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
             local_estante = COALESCE(?, local_estante),
             ativo = 1
         WHERE acervo_id = ? AND escola_id = ?`,
        [exemplaresN, exemplaresN, local_estante||null, acervoId, eid]
      );
    } else {
      await db.query(
        `INSERT INTO biblioteca_acervo_escola
           (acervo_id, escola_id, exemplares, exemplares_disponiveis, local_estante)
         VALUES (?,?,?,?,?)`,
        [acervoId, eid, exemplaresN, exemplaresN, local_estante||null]
      );
    }

    const [[livro]] = await db.query(
      `SELECT ba.*, bae.id AS estoque_id, bae.exemplares, bae.exemplares_disponiveis, bae.local_estante
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
    sinopse, num_paginas, exemplares, local_estante, capa_url, ativo,
  } = req.body;

  try {
    // Verifica que essa escola tem o livro
    const [[bae]] = await db.query(
      'SELECT * FROM biblioteca_acervo_escola WHERE acervo_id = ? AND escola_id = ?', [id, eid]
    );
    if (!bae) return res.status(404).json({ ok: false, error: 'Livro não encontrado no acervo desta escola' });

    // Atualiza metadados universais
    // Atualiza metadados universais (permite regularizar ISBN se obra não tinha)
    const isbnLimpo = isbn ? isbn.trim().replace(/[-\s]/g, '') || null : null;
    await db.query(
      `UPDATE biblioteca_acervo SET
         titulo = COALESCE(?,titulo), autor = COALESCE(?,autor), editora = COALESCE(?,editora),
         ano_publicacao = ?, genero = COALESCE(?,genero), categoria = COALESCE(?,categoria),
         sinopse = COALESCE(?,sinopse), num_paginas = COALESCE(?,num_paginas),
         capa_url = COALESCE(?,capa_url),
         isbn = COALESCE(NULLIF(isbn, ''), ?)
       WHERE id = ?`,
      [titulo||null, autor||null, editora||null,
       sanitizarAno(ano_publicacao) ?? null,
       genero||null, categoria||null, sinopse||null,
       num_paginas?parseInt(num_paginas):null,
       capa_url||null, isbnLimpo, id]
    );

    // Atualiza estoque escolar
    if (exemplares !== undefined || local_estante !== undefined || ativo !== undefined) {
      const novoExemp = exemplares !== undefined ? (parseInt(exemplares) || bae.exemplares) : bae.exemplares;
      const diff      = novoExemp - bae.exemplares;
      const novoDisp  = Math.max(0, bae.exemplares_disponiveis + diff);
      const novoLocal = local_estante !== undefined ? local_estante : bae.local_estante;
      
      await db.query(
        `UPDATE biblioteca_acervo_escola SET exemplares = ?, exemplares_disponiveis = ?, local_estante = ?, ativo = ?
         WHERE acervo_id = ? AND escola_id = ?`,
        [novoExemp, novoDisp, novoLocal,
         ativo !== undefined ? (ativo ? 1 : 0) : bae.ativo,
         id, eid]
      );
    }

    const [[livro]] = await db.query(
      `SELECT ba.*, bae.id AS estoque_id, bae.exemplares, bae.exemplares_disponiveis, bae.local_estante, bae.ativo
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

    const processed = await sharp(req.file.buffer)
      .rotate()
      .resize({ width: 800, height: 1200, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85, mozjpeg: true })
      .toBuffer();

    const ts = Date.now();
    const rand = crypto.randomBytes(4).toString('hex');
    const objectKey = `uploads/biblioteca/capas/${ts}_${rand}.jpg`;

    const { publicUrl } = await uploadFileBufferToSpaces({
      buffer: processed,
      contentType: 'image/jpeg',
      objectKey,
      cacheControl: 'public, max-age=31536000',
    });

    await db.query('UPDATE biblioteca_acervo SET capa_url = ? WHERE id = ?', [publicUrl, id]);
    res.json({ ok: true, capa_url: publicUrl });
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

/** PUT /api/biblioteca/emprestimos/:id/renovar — estende o prazo e volta a ficar ativo */
router.put('/emprestimos/:id/renovar', async (req, res) => {
  const db  = req.db;
  const eid = escolaId(req);
  const { id } = req.params;
  const { dias_adicionais = 7 } = req.body;

  try {
    const [[emp]] = await db.query(
      'SELECT * FROM biblioteca_emprestimos WHERE id = ? AND escola_id = ?', [id, eid]
    );
    if (!emp) return res.status(404).json({ ok: false, error: 'Empréstimo não encontrado' });
    if (emp.status === 'devolvido') return res.status(409).json({ ok: false, error: 'Livro já devolvido' });

    await db.query(
      `UPDATE biblioteca_emprestimos
       SET status = 'ativo', 
           data_prevista_devolucao = DATE_ADD(COALESCE(data_prevista_devolucao, CURDATE()), INTERVAL ? DAY)
       WHERE id = ?`,
      [parseInt(dias_adicionais), id]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error('[BIBLIOTECA] renovar:', err.message);
    res.status(500).json({ ok: false, error: err.message });
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
// PERGUNTAS — Banco de Perguntas para Resenhas
// ============================================================================

/** GET /api/biblioteca/perguntas — listar perguntas ativas (ou todas) de um livro */
router.get('/perguntas', async (req, res) => {
  const db  = req.db;
  const eid = escolaId(req);
  const { todas, livro_id } = req.query;
  
  if (!livro_id) {
    return res.status(400).json({ ok: false, error: 'livro_id é obrigatório' });
  }

  try {
    let q = 'SELECT * FROM biblioteca_perguntas WHERE escola_id = ? AND livro_id = ?';
    if (!todas) q += ' AND ativa = 1';
    q += ' ORDER BY ordem ASC, id ASC';
    const [perguntas] = await db.query(q, [eid, livro_id]);
    res.json({ ok: true, perguntas });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/** POST /api/biblioteca/perguntas — criar nova pergunta */
router.post('/perguntas', async (req, res) => {
  const db  = req.db;
  const eid = escolaId(req);
  const { pergunta, ordem = 0, livro_id } = req.body;
  if (!pergunta) return res.status(400).json({ ok: false, error: 'Pergunta é obrigatória' });
  if (!livro_id) return res.status(400).json({ ok: false, error: 'livro_id é obrigatório' });
  try {
    const [result] = await db.query(
      'INSERT INTO biblioteca_perguntas (escola_id, livro_id, pergunta, ordem) VALUES (?, ?, ?, ?)',
      [eid, livro_id, pergunta, ordem]
    );
    res.json({ ok: true, id: result.insertId });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/** PUT /api/biblioteca/perguntas/:id — editar/inativar pergunta */
router.put('/perguntas/:id', async (req, res) => {
  const db  = req.db;
  const eid = escolaId(req);
  const { id } = req.params;
  const { pergunta, ativa, ordem } = req.body;
  try {
    const fields = [];
    const values = [];
    if (pergunta !== undefined) { fields.push('pergunta = ?'); values.push(pergunta); }
    if (ativa !== undefined)    { fields.push('ativa = ?'); values.push(ativa ? 1 : 0); }
    if (ordem !== undefined)    { fields.push('ordem = ?'); values.push(ordem); }
    
    if (fields.length === 0) return res.json({ ok: true });
    
    values.push(id, eid);
    await db.query(`UPDATE biblioteca_perguntas SET ${fields.join(', ')} WHERE id = ? AND escola_id = ?`, values);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/** DELETE /api/biblioteca/perguntas/:id — apagar pergunta */
router.delete('/perguntas/:id', async (req, res) => {
  const db  = req.db;
  const eid = escolaId(req);
  const { id } = req.params;
  try {
    await db.query('DELETE FROM biblioteca_perguntas WHERE id = ? AND escola_id = ?', [id, eid]);
    res.json({ ok: true });
  } catch (err) {
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

/** DELETE /api/biblioteca/resenhas/:id */
router.delete('/resenhas/:id', async (req, res) => {
  const db  = req.db;
  const eid = escolaId(req);
  const { id } = req.params;
  try {
    await db.query('DELETE FROM biblioteca_resenhas WHERE id = ? AND escola_id = ?', [id, eid]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[BIBLIOTECA] delete resenha:', err.message);
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
  const { turma_id, mes, ano, concurso_id } = req.query;

  try {
    let dateFilter = '';
    let resenhaDateFilter = '';
    const params = [];
    
    // Params para o INNER JOIN matriculas e os LEFT JOINs
    const paramsBe = [eid]; // escola_id do emprestimo
    const paramsBr = [eid]; // escola_id da resenha
    
    if (concurso_id) {
      const [[concurso]] = await db.query('SELECT data_inicio, data_fim FROM biblioteca_concurso WHERE id = ? AND escola_id = ?', [concurso_id, eid]);
      if (concurso) {
        if (concurso.data_inicio) {
          resenhaDateFilter += ' AND br.criado_em >= ?';
          paramsBr.push(concurso.data_inicio);
        }
        if (concurso.data_fim) {
          // Garante até o final do dia
          resenhaDateFilter += ' AND br.criado_em <= ?';
          paramsBr.push(concurso.data_fim + ' 23:59:59');
        }
      }
    } else if (mes && ano) {
      // Comportamento original
      dateFilter = 'AND MONTH(be.data_emprestimo) = ? AND YEAR(be.data_emprestimo) = ?';
      paramsBe.push(parseInt(mes), parseInt(ano));
    }

    let turmaFilter = '';
    const paramsWhere = [eid];
    if (turma_id) { turmaFilter = 'AND m.turma_id = ?'; paramsWhere.push(turma_id); }

    const anoAtual = anoLetivoAtual();
    const finalParams = [eid, ...paramsBe, ...paramsBr, ...paramsWhere];

    const [ranking] = await db.query(
      `SELECT
         a.id AS aluno_id, a.estudante AS aluno_nome, a.foto AS aluno_foto,
         t.nome AS turma_nome,
         COUNT(DISTINCT be.id) AS total_livros_emprestados,
         COALESCE(SUM(br.pontuacao), 0) AS pontuacao_total,
         COUNT(DISTINCT br.id) AS total_resenhas
       FROM alunos a
       INNER JOIN matriculas m
         ON m.aluno_id = a.id AND m.escola_id = ? AND m.ano_letivo = ${anoAtual} AND m.status = 'ativo'
       LEFT JOIN turmas t ON t.id = m.turma_id
       LEFT JOIN biblioteca_emprestimos be
         ON be.aluno_id = a.id AND be.escola_id = ? ${dateFilter}
       LEFT JOIN biblioteca_resenhas br
         ON br.aluno_id = a.id AND br.escola_id = ? AND br.status IN ('aprovado','destaque') ${resenhaDateFilter}
       WHERE a.escola_id = ? ${turmaFilter}
       GROUP BY a.id, a.estudante, a.foto, t.nome
       HAVING total_livros_emprestados > 0 OR total_resenhas > 0
       ORDER BY pontuacao_total DESC, total_resenhas DESC, total_livros_emprestados DESC
       LIMIT 50`,
      finalParams
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
