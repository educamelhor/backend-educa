// api/routes/alunos.js

import express from "express";
import multer from "multer";
import pdfParse from "pdf-parse/lib/pdf-parse.js";
import pool from "../db.js";
import fs from "fs";
import path, { dirname as _dirname } from "path";
import { fileURLToPath } from "url";
import XLSX from "xlsx";
import { getInativos } from "../controllers/alunosController.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = _dirname(__filename);

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// Helper: ano letivo padrão com data de corte em 31/jan
// (se mês <= 1 → ano anterior; senão → ano corrente)
// ─────────────────────────────────────────────────────────────────────────────
function anoLetivoPadrao() {
  const hoje = new Date();
  const mes = hoje.getMonth() + 1; // 1–12
  return mes <= 1 ? hoje.getFullYear() - 1 : hoje.getFullYear();
}

// Base pública do Spaces (sem depender do front “adivinhar” a URL)
// Ex.: https://nyc3.digitaloceanspaces.com/educa-melhor-uploads/
const SPACES_PUBLIC_BASE = String(
  process.env.SPACES_PUBLIC_BASE || "https://nyc3.digitaloceanspaces.com/educa-melhor-uploads/"
).replace(/\/+$/, "") + "/";

/*
 * Middleware local (defensivo) para garantir escola no req.user
 * OBS: O router já é protegido por autenticação + verificarEscola no server.js,
 * mas mantemos aqui para endpoints que o utilizam diretamente.
 */
function verificarEscola(req, res, next) {
  if (!req.user || !req.user.escola_id) {
    return res.status(403).json({ message: "Acesso negado: escola não definida." });
  }
  next();
}

/* ============================================================================
 * 1) CONFIGURAÇÃO DE UPLOAD DE FOTOS (MULTER)
 * - Grava em /uploads/CEF04_PLAN/alunos (pasta servida pelo server.js)
 * ========================================================================== */
const uploadDir = path.resolve(__dirname, "../uploads/CEF04_PLAN/alunos");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const codigo = req.params.id; // usamos :id da rota como "código do aluno"
    cb(null, `${codigo}.jpg`);
  },
});
const upload = multer({ storage });

/* ============================================================================
 * 2) ROTA PÚBLICA PARA IMPRESSÃO (por turma, via secret)
 * GET /api/alunos/publico?turma_id=123&secret=xxxx
 * - Não depende de req.user
 * ========================================================================== */
router.get("/publico", async (req, res) => {
  try {
    const { turma_id, secret } = req.query;

    const PRINT_SECRET = process.env.PRINT_SECRET || "123456";
    if (!secret || secret !== PRINT_SECRET) {
      return res.status(403).json({ message: "Acesso negado (secret inválido)." });
    }
    if (!turma_id) {
      return res.status(400).json({ message: "turma_id obrigatório." });
    }

    const [rows] = await pool.query(
      `
      SELECT a.id, a.codigo, a.estudante,
             DATE_FORMAT(a.data_nascimento, '%Y-%m-%d') AS data_nascimento,
             a.sexo, a.status,
             t.nome AS turma, t.turno
      FROM alunos a
      LEFT JOIN turmas t ON t.id = a.turma_id
      WHERE a.turma_id = ?
      ORDER BY a.estudante
      `,
      [turma_id]
    );

    return res.json({ alunos: rows, total: rows.length });
  } catch (err) {
    console.error("[publico] Erro ao listar alunos:", err);
    res.status(500).json({ message: "Erro no servidor ao listar alunos (publico)." });
  }
});

/* ============================================================================
 * 3) LISTAR ALUNOS (com filtros)
 * GET /api/alunos?turma_id=&filtro=&status=&limit=&offset=
 * - Filtra por escola do usuário (req.user.escola_id)
 * - Filtros: turma_id, busca textual (nome/código/turma/turno) e status (ativo/inativo)
 * ========================================================================== */
router.get("/", verificarEscola, async (req, res) => {
  try {
    const {
      turma_id,
      filtro = "",
      status = "",
      ano_letivo,
      limit = 100,
      offset = 0,
    } = req.query;
    const { escola_id } = req.user;

    // Ano letivo efetivo: usa o parâmetro ou calcula o padrão (corte 31/jan)
    const anoEfetivo = ano_letivo ? Number(ano_letivo) : anoLetivoPadrao();

    // DEBUG: o que chegou do front e do token
    console.log("🔎 /api/alunos → filtros:", { turma_id, filtro, status, ano_letivo, limit, offset });
    console.log("🔎 /api/alunos → req.user:", req.user);

    const where = ["a.escola_id = ?", "m.ano_letivo = ?"];
    // ⚠️ ordem dos params importa: o SQL abaixo usa SPACES_PUBLIC_BASE no primeiro "?"
    const params = [SPACES_PUBLIC_BASE, escola_id, anoEfetivo];

    if (turma_id) {
      where.push("m.turma_id = ?");
      params.push(Number(turma_id));
    }

    if (filtro) {
      where.push(`(
        a.estudante LIKE ? OR a.codigo LIKE ? OR
        t.nome LIKE ? OR t.turno LIKE ?
      )`);
      const filtroLike = `%${filtro}%`;
      params.push(filtroLike, filtroLike, filtroLike, filtroLike);
    }

    const statusNorm = String(status || "").trim().toLowerCase();
    if (statusNorm === "ativo" || statusNorm === "inativo") {
      where.push("m.status = ?");
      params.push(statusNorm);
    }

    const whereSql = `WHERE ${where.join(" AND ")}`;

    const countSql = `
      SELECT COUNT(*) AS total
      FROM alunos AS a
      INNER JOIN matriculas AS m ON m.aluno_id = a.id AND m.escola_id = a.escola_id
      LEFT JOIN  turmas     AS t ON t.id = m.turma_id
      LEFT JOIN  escolas    AS e ON e.id = a.escola_id
      ${whereSql}
    `;

    // Filtra params: SPACES_PUBLIC_BASE não deve ir para o COUNT (já que COUNT usa os mesmos binds do WHERE e ignoramos o bind inicial do SELECT principal)
    // SPACES_PUBLIC_BASE é o params[0], então paramsCount pula ele.
    const paramsCount = params.slice(1);
    const [countRows] = await pool.query(countSql, paramsCount);
    const total = countRows[0].total;

    const sql = `
      SELECT
             a.id,
             a.codigo,
             a.estudante,
             DATE_FORMAT(a.data_nascimento, '%Y-%m-%d') AS data_nascimento,
             a.sexo,
             a.status,
             a.foto,

             -- URL canônica do Spaces (novo padrão do EDUCA-CAPTURE):
             CASE
               WHEN a.foto LIKE 'http%' THEN a.foto
               ELSE CONCAT(?, 'uploads/', COALESCE(e.apelido, CONCAT('escola_', a.escola_id)), '/alunos/', a.codigo, '.jpg')
             END AS foto_url,

             t.nome  AS turma,
             t.turno,
             m.turma_id,
             m.ano_letivo
      FROM alunos AS a
      -- JOIN via matriculas (fonte canônica de turma/ano a partir de 2026-03)
      INNER JOIN matriculas AS m ON m.aluno_id = a.id AND m.escola_id = a.escola_id
      LEFT JOIN  turmas     AS t ON t.id = m.turma_id
      LEFT JOIN  escolas    AS e ON e.id = a.escola_id
      ${whereSql}
      ORDER BY a.estudante
      LIMIT ? OFFSET ?
    `;
    params.push(Number(limit), Number(offset));

    console.log("🔎 /api/alunos → SQL:", sql.replace(/\s+/g, " ").trim());
    console.log("🔎 /api/alunos → params:", params);

    const [rows] = await pool.query(sql, params);
    res.json({ alunos: rows, total });
  } catch (err) {
    console.error("Erro ao listar alunos:", err);
    res.status(500).json({ message: "Erro ao listar alunos." });
  }
});

/* ============================================================================
 * 4) CRIAR ALUNO
 * POST /api/alunos
 * Body: { codigo, estudante, data_nascimento(YYYY-MM-DD), sexo, turma_id }
 * - status padrão: "ativo"
 * ========================================================================== */
router.post("/", verificarEscola, async (req, res) => {
  try {
    const { codigo, estudante, data_nascimento, sexo, turma_id } = req.body;
    const { escola_id } = req.user;

    if (!codigo || !estudante) {
      return res.status(400).json({ message: "Código e nome são obrigatórios." });
    }

    const anoLetivoAtual = anoLetivoPadrao();

    // Verifica se já existe na base global da escola
    const [[existe]] = await pool.query(
      "SELECT id, status FROM alunos WHERE codigo = ? AND escola_id = ?",
      [codigo, escola_id]
    );

    let alunoId;

    if (existe) {
      alunoId = existe.id;

      // Se existe, verifica se já está matriculado ATIVO neste mesmo ano letivo
      const [[matr]] = await pool.query(
        "SELECT id, status FROM matriculas WHERE aluno_id = ? AND ano_letivo = ? AND escola_id = ?",
        [alunoId, anoLetivoAtual, escola_id]
      );
      if (matr && matr.status === "ativo") {
        return res.status(409).json({ message: "Este estudante já possui uma matrícula ativa no ano corrente." });
      }

      // Se ele já estava na base, apenas atualizamos seus dados e o validamos como ativo
      await pool.query(
        `UPDATE alunos SET estudante = ?, data_nascimento = ?, sexo = ?, turma_id = ?, status = 'ativo' WHERE id = ?`,
        [estudante, data_nascimento || null, sexo || null, turma_id || null, alunoId]
      );
    } else {
      // Inserção inédita na base global
      const [result] = await pool.query(
        `
        INSERT INTO alunos (codigo, estudante, data_nascimento, sexo, turma_id, escola_id, status)
        VALUES (?, ?, ?, ?, ?, ?, 'ativo')
        `,
        [codigo, estudante, data_nascimento || null, sexo || null, turma_id || null, escola_id]
      );
      alunoId = result.insertId;
    }

    // ✅ Cria matrícula automaticamente ao cadastrar o aluno
    if (turma_id && alunoId) {
      await pool.query(
        `INSERT INTO matriculas (escola_id, aluno_id, turma_id, ano_letivo, status)
         VALUES (?, ?, ?, ?, 'ativo')
         ON DUPLICATE KEY UPDATE status = 'ativo', turma_id = ?, updated_at = CURRENT_TIMESTAMP`,
        [escola_id, alunoId, turma_id, anoLetivoAtual, turma_id]
      );
    }

    res.status(201).json({ id: alunoId, message: "Aluno cadastrado com sucesso." });
  } catch (err) {
    console.error("Erro ao criar aluno:", err);
    res.status(500).json({ message: "Erro ao criar aluno." });
  }
});

/* ============================================================================
 * 5) ATUALIZAR ALUNO
 * PUT /api/alunos/:id
 * Body pode conter: { estudante, data_nascimento, sexo, turma_id, status }
 * ========================================================================== */
router.put("/:id", verificarEscola, async (req, res) => {
  try {
    const { id } = req.params;
    const { escola_id } = req.user;
    const { estudante, data_nascimento, sexo, turma_id, status } = req.body;

    const campos = [];
    const valores = [];

    if (typeof estudante !== "undefined") { campos.push("estudante = ?"); valores.push(estudante); }
    if (typeof data_nascimento !== "undefined") { campos.push("data_nascimento = ?"); valores.push(data_nascimento || null); }
    if (typeof sexo !== "undefined") { campos.push("sexo = ?"); valores.push(sexo || null); }
    if (typeof turma_id !== "undefined") { campos.push("turma_id = ?"); valores.push(turma_id || null); }
    if (typeof status !== "undefined") { campos.push("status = ?"); valores.push(status); }

    if (campos.length === 0) {
      return res.status(400).json({ message: "Nada para atualizar." });
    }

    valores.push(id, escola_id);
    await pool.query(
      `UPDATE alunos SET ${campos.join(", ")} WHERE id = ? AND escola_id = ?`,
      valores
    );
    res.json({ message: "Aluno atualizado com sucesso." });
  } catch (err) {
    console.error("Erro ao atualizar aluno:", err);
    res.status(500).json({ message: "Erro ao atualizar aluno." });
  }
});

/* ============================================================================
 * 6) INATIVAR ALUNO
 * PUT /api/alunos/inativar/:id
 * ========================================================================== */
router.put("/inativar/:id", verificarEscola, async (req, res) => {
  try {
    const { id } = req.params;
    const { escola_id } = req.user;
    await pool.query(
      `UPDATE alunos SET status='inativo' WHERE id = ? AND escola_id = ?`,
      [id, escola_id]
    );
    res.json({ message: "Aluno inativado." });
  } catch (err) {
    console.error("Erro ao inativar aluno:", err);
    res.status(500).json({ message: "Erro ao inativar aluno." });
  }
});

/* ============================================================================
 * 7) EXCLUIR ALUNO
 * DELETE /api/alunos/:id
 * ========================================================================== */
router.delete("/:id", verificarEscola, async (req, res) => {
  try {
    const { id } = req.params;
    const { escola_id } = req.user;
    await pool.query(
      "DELETE FROM alunos WHERE id = ? AND escola_id = ?",
      [id, escola_id]
    );
    res.json({ message: "Aluno excluído." });
  } catch (err) {
    console.error("Erro ao excluir aluno:", err);
    res.status(500).json({ message: "Erro ao excluir aluno." });
  }
});

/* ============================================================================
 * 8) BUSCAR POR CÓDIGO
 * GET /api/alunos/por-codigo/:codigo
 * - Útil para verificar reativação/criação no frontend
 * ========================================================================== */
router.get("/por-codigo/:codigo", verificarEscola, async (req, res) => {
  try {
    const { codigo } = req.params;
    const { escola_id } = req.user;
    const [[aluno]] = await pool.query(
      `SELECT a.id, a.codigo, a.estudante AS nome,
              DATE_FORMAT(a.data_nascimento, '%Y-%m-%d') AS data_nascimento,
              a.sexo, a.foto, a.status,
              t.nome AS turma, t.turno
       FROM alunos a
       LEFT JOIN turmas t ON t.id = a.turma_id
       WHERE a.codigo = ? AND a.escola_id = ?`,
      [codigo, escola_id]
    );
    if (!aluno) {
      return res.status(404).json({ message: "Aluno não encontrado." });
    }
    res.json(aluno);
  } catch (err) {
    console.error("Erro ao buscar aluno por código:", err);
    res.status(500).json({ message: "Erro no servidor ao buscar por código." });
  }
});

/* ============================================================================
 * 8.1) NOTAS SIMPLES DO ALUNO
 * GET /api/alunos/:id/notas
 * ========================================================================== */
router.get("/:id/notas", async (req, res) => {
  try {
    const { id } = req.params;
    const [notas] = await pool.query(
      `SELECT n.id, n.nota, d.nome AS disciplina
       FROM notas n
       JOIN disciplinas d ON n.disciplina_id = d.id
       WHERE n.aluno_id = ?
       ORDER BY d.nome`,
      [id]
    );
    return res.json(notas);
  } catch (err) {
    console.error("Erro ao buscar notas do aluno:", err);
    return res.status(500).json({ message: "Erro no servidor ao buscar notas." });
  }
});

/* ============================================================================
 * 8.2) NOTAS DETALHADAS
 * GET /api/alunos/:id/notas-detalhadas
 * ========================================================================== */
router.get("/:id/notas-detalhadas", async (req, res) => {
  try {
    const { id } = req.params;
    const [notas] = await pool.query(
      `SELECT
         n.id,
         n.nota      AS nota,
         n.ano,
         n.bimestre,
         n.faltas,
         n.disciplina_id,
         d.nome       AS disciplina
       FROM notas n
       JOIN disciplinas d ON d.id = n.disciplina_id
       WHERE n.aluno_id = ?
       ORDER BY n.ano, n.bimestre, d.nome`,
      [id]
    );
    return res.json(notas);
  } catch (err) {
    console.error("Erro ao buscar notas detalhadas:", err);
    return res.status(500).json({ message: "Erro no servidor ao buscar notas." });
  }
});

/* ============================================================================
 * 9) BUSCAR UM ALUNO ESPECÍFICO (por código)
 * GET /api/alunos/:id
 * - Aqui ":id" é o CÓDIGO do aluno (mantido conforme uso no frontend)
 * ========================================================================== */
router.get("/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const [[aluno]] = await pool.query(
      `
      SELECT
        a.id,
        a.codigo,
        a.estudante AS estudante,
        DATE_FORMAT(a.data_nascimento, '%Y-%m-%d') AS data_nascimento,
        a.sexo,
        a.foto,
        a.status,
        t.nome AS turma,
        t.turno
      FROM alunos AS a
      LEFT JOIN turmas AS t ON t.id = a.turma_id
      WHERE a.codigo = ?
      `,
      [id]
    );
    if (!aluno) {
      return res.status(404).json({ message: "Aluno não encontrado." });
    }
    return res.json(aluno);
  } catch (err) {
    console.error("Erro ao buscar aluno:", err);
    return res.status(500).json({ message: "Erro no servidor ao buscar aluno." });
  }
});

/* ============================================================================
 * 10) RECEBER FOTO RECORTADA
 * POST /api/alunos/:id/foto
 * - Salva em /uploads/CEF04_PLAN/alunos/<codigo>.jpg
 * - Atualiza coluna 'foto' com o caminho público
 * ========================================================================== */
router.post("/:id/foto", upload.single("foto"), async (req, res) => {
  const { id } = req.params; // código do aluno
  if (!req.file) {
    return res.status(400).json({ message: "Nenhuma foto enviada." });
  }
  try {
    const fotoPath = `/uploads/CEF04_PLAN/alunos/${req.file.filename}`;
    await pool.query("UPDATE alunos SET foto = ? WHERE codigo = ?", [fotoPath, id]);
    return res.status(200).json({ foto: fotoPath });
  } catch (err) {
    console.error("Erro ao atualizar foto no DB:", err);
    return res.status(500).json({ message: "Erro ao inserir foto no servidor." });
  }
});

/* ============================================================================
 * 11) IMPORTAR PDF (gera inserts/reativa/inativa por turma)
 * POST /api/alunos/importar-pdf (arquivo: file)
 * - Nome do arquivo (sem extensão) = nome da turma
 * - PDF padrão da Secretaria de Educação ("Ficha do Estudante")
 *   Cada linha de dados: RE(4-7 dígitos) + NOME + dd/mm/yyyy + filiação...
 *   Extraímos apenas: RE, nome do estudante, data de nascimento
 * ========================================================================== */
const uploadPdf = multer(); // usa buffer
router.post("/importar-pdf", uploadPdf.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: "PDF não enviado." });
  }

  try {
    const { escola_id } = req.user;
    const anoLetivoAtual = typeof anoLetivoPadrao === "function" ? anoLetivoPadrao() : String(new Date().getFullYear());

    // Identifica turma pelo nome do arquivo
    let turmaNomeStr = req.body.turmaNome || req.file.originalname.replace(/\.pdf$/i, "").trim();
    // Corrige erro de parse do multer (latin1 vs utf-8) que causa 6Âº em vez de 6º
    const turmaNome = turmaNomeStr.replace(/Âº/g, 'º').replace(/Âª/g, 'ª');

    const [[turma]] = await pool.query("SELECT id FROM turmas WHERE nome = ? AND escola_id = ?", [turmaNome, escola_id]);
    if (!turma) {
      return res.status(404).json({ message: `Turma "${turmaNome}" não encontrada.` });
    }
    const turma_id = turma.id;
  
    // ──────────────────────────────────────────────────────────────────
    // PARSER POSICIONAL — extrai dados diretamente pelas colunas do PDF
    // Auto-detecta as posições X das colunas pelo cabeçalho (RE, NOME, DT NASCIMENTO, etc.)
    // Funciona com qualquer layout: colunas extras visíveis ou ocultas.
    // Fallback para ranges hardcoded se a auto-detecção falhar.
    // ──────────────────────────────────────────────────────────────────
    const pdfEntries = [];

    // Extrai text items com posição usando pagerender customizado
    const allItems = [];
    const parseOptions = {
      pagerender: async (pageData) => {
        const tc = await pageData.getTextContent();
        for (const item of tc.items) {
          const txt = (item.str || "").trim();
          if (!txt) continue;
          allItems.push({
            text: txt,
            x: Math.round(item.transform[4]),
            y: Math.round(item.transform[5]),
          });
        }
        return ""; // pdf-parse espera string; retornamos vazio pois usamos allItems
      },
    };
    await pdfParse(req.file.buffer, parseOptions);

    // ── Auto-detecção de colunas pelo cabeçalho ──
    // Procura a linha Y onde aparece exatamente "RE" (cabeçalho da tabela)
    // e lê as posições X de cada coluna a partir dos labels.
    const _normH = (s) => (s || "").toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
    let _headerY = null;
    for (const item of allItems) {
      if (_normH(item.text) === "RE") {
        if (_headerY === null || item.y > _headerY) _headerY = item.y;
      }
    }

    let COL_RANGES;
    if (_headerY !== null) {
      const headerItems = allItems.filter(it => Math.abs(it.y - _headerY) <= 3).sort((a, b) => a.x - b.x);
      const colPositions = {};
      for (const item of headerItems) {
        const t = _normH(item.text);
        if (t === "RE") colPositions.re = item.x;
        else if (t === "NOME" || t === "ESTUDANTE") colPositions.nome = item.x;
        else if (t.includes("NASCIMENTO")) colPositions.dataNasc = item.x;
        else if (t.includes("FILIACAO")) colPositions.filiacao = item.x;
        else if (t.includes("RESPONSAVEL") && !t.includes("CPF")) colPositions.responsavel = item.x;
        else if (t.includes("CPF")) colPositions.cpf = item.x;
      }
      if (colPositions.re != null && colPositions.nome != null) {
        const cols = Object.entries(colPositions).sort((a, b) => a[1] - b[1]);
        COL_RANGES = {};
        for (let i = 0; i < cols.length; i++) {
          const [name, startX] = cols[i];
          const nextX = i + 1 < cols.length ? cols[i + 1][1] : startX + 200;
          COL_RANGES[name] = { min: Math.max(0, startX - 10), max: nextX - 5 };
        }
        console.log(`[importar-pdf] Auto-detect colunas OK:`, JSON.stringify(COL_RANGES));
      }
    }

    // Fallback: ranges hardcoded (layout padrão com colunas extras visíveis)
    if (!COL_RANGES) {
      COL_RANGES = {
        re:          { min: 20, max: 85 },
        nome:        { min: 85, max: 310 },
        dataNasc:    { min: 310, max: 400 },
        filiacao:    { min: 400, max: 630 },
        responsavel: { min: 630, max: 865 },
        cpf:         { min: 865, max: 960 },
      };
      console.log(`[importar-pdf] Auto-detect falhou, usando ranges padrão`);
    }

    function getCol(x) {
      for (const [col, range] of Object.entries(COL_RANGES)) {
        if (x >= range.min && x < range.max) return col;
      }
      return null;
    }

    // Agrupa items por linha (Y) → ordena por X dentro de cada linha
    const rowsMap = {};
    for (const it of allItems) {
      // Agrupa Y com tolerância de 3px (variações de renderização)
      const yKey = Math.round(it.y / 3) * 3;
      if (!rowsMap[yKey]) rowsMap[yKey] = [];
      rowsMap[yKey].push(it);
    }

    // ──────────────────────────────────────────────────────────────────
    // DUAS PASSADAS — resolve nomes longos que ocupam 2+ linhas no PDF
    //
    // Passada 1: Identifica cada linha como "data row" (tem RE) ou
    //            "continuation row" (sem RE — é continuação do nome).
    //
    // Passada 2: Mescla continuation rows no data row anterior,
    //            concatenando o texto de cada coluna.
    //
    // Exemplo real:
    //   y=682 RE=226604 NOME="MARIA FERNANDA RIBEIRO DE SILOS"  ← data row
    //   y=671 RE=—      NOME="PEREIRA"                          ← continuation
    //   Resultado: NOME = "MARIA FERNANDA RIBEIRO DE SILOS PEREIRA"
    // ──────────────────────────────────────────────────────────────────
    const yKeys = Object.keys(rowsMap).map(Number).sort((a, b) => b - a); // top→bottom (Y decresce)

    // Passada 1 — classifica linhas e extrai colunas
    const classifiedRows = [];
    for (const yKey of yKeys) {
      const lineItems = rowsMap[yKey].sort((a, b) => a.x - b.x);
      const rowData = {};
      for (const it of lineItems) {
        const col = getCol(it.x);
        if (col) {
          rowData[col] = rowData[col] ? rowData[col] + " " + it.text : it.text;
        }
      }
      const re = (rowData.re || "").trim();
      const isDataRow = /^\d{4,7}$/.test(re);
      classifiedRows.push({ yKey, rowData, isDataRow });
    }

    // Passada 2 — mescla continuation rows no data row anterior
    const mergedRows = [];
    for (let i = 0; i < classifiedRows.length; i++) {
      const row = classifiedRows[i];
      if (row.isDataRow) {
        // Inicia um novo registro a partir desta data row
        const merged = { ...row.rowData };
        // Olha as linhas seguintes (y menor = mais abaixo) e mescla
        let j = i + 1;
        while (j < classifiedRows.length && !classifiedRows[j].isDataRow) {
          const contRow = classifiedRows[j].rowData;
          for (const [col, text] of Object.entries(contRow)) {
            if (col === "re") { j++; continue; } // nunca mescla RE
            merged[col] = merged[col] ? merged[col] + " " + text : text;
          }
          j++;
        }
        mergedRows.push(merged);
      }
      // continuation rows são consumidas pelo loop acima, então ignoramos
    }

    // Passada 3 — extrai dados de cada merged row
    for (const rowData of mergedRows) {
      const re = (rowData.re || "").trim();
      if (!/^\d{4,7}$/.test(re)) continue;

      let estudante = (rowData.nome || "").trim();
      let dataBr = (rowData.dataNasc || "").trim();
      let responsavel = (rowData.responsavel || "").trim();
      let cpfResp = (rowData.cpf || "").replace(/\D/g, "");
      const filiacao = (rowData.filiacao || "").trim();

      // ── Safety net 1: se o CPF vazou para dentro do nome do responsável ──
      // Nomes brasileiros NUNCA contêm dígitos (são apenas letras, acentos e espaços).
      // Logo, a primeira sequência numérica encontrada no campo responsável é o CPF.
      // Isso cobre: "MARIA DA SILVA 12345678901" (com espaço)
      //          e: "MARIA DA SILVA12345678901" (sem espaço / colunas coladas)
      if (!cpfResp && responsavel) {
        const splitMatch = responsavel.match(
          /^([A-Za-zÀ-ÖØ-öø-ÿÇçÃãÕõÉéÍíÓóÚúÂâÊêÎîÔôÛû\s.'-]+?)\s*(\d{11})$/
        );
        if (splitMatch) {
          responsavel = splitMatch[1].trim();
          cpfResp = splitMatch[2];
        }
      }

      // ── Safety net 2: responsável vazou para filiação (drift de colunas) ──
      // Se o responsável ficou vazio mas temos CPF, o nome provavelmente
      // foi classificado como filiação por causa de posição X levemente menor.
      // Nos PDFs da Secretaria de Educação, filiação e responsável frequentemente
      // são a mesma pessoa (mãe), então usamos a filiação como fallback.
      if (!responsavel && cpfResp && filiacao) {
        responsavel = filiacao;
      }

      // ── Safety net 3: data de nascimento com filiação colada ──
      // Se a filiação vazou para o campo dataNasc (drift de colunas),
      // o campo fica com "01/12/2008 MARIA FRANCINETE DA COSTA..."
      // Extraímos apenas o padrão dd/mm/yyyy do início e descartamos o resto.
      if (dataBr && !/^\d{2}\/\d{2}\/\d{4}$/.test(dataBr)) {
        const dateAtStart = dataBr.match(/^(\d{2}\/\d{2}\/\d{4})/);
        if (dateAtStart) {
          dataBr = dateAtStart[1];
        } else {
          dataBr = ""; // não é data
        }
      }

      // Se a data vazou para o campo nome (drift de colunas), extrair e limpar
      const dateInName = estudante.match(/\s+(\d{2}\/\d{2}\/\d{4})\s*$/);
      if (dateInName) {
        if (!dataBr || !/^\d{2}\/\d{2}\/\d{4}$/.test(dataBr)) {
          dataBr = dateInName[1]; // usa a data encontrada no nome
        }
        estudante = estudante.replace(/\s+\d{2}\/\d{2}\/\d{4}\s*$/, "").trim();
      }

      if (!estudante) continue;

      pdfEntries.push({
        codigo: re,
        estudante,
        dataBr,
        sexo: null,
        responsavel: responsavel || null,
        cpfResponsavel: cpfResp.length === 11 ? cpfResp : null,
      });
    }

    // Fallback: se parser posicional não encontrou nada, tenta regex legado
    if (pdfEntries.length === 0) {
      const { text } = await pdfParse(req.file.buffer);
      const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const regexLinha = /^(\d{4,7})([A-Za-zÀ-ÖØ-öø-ÿÇçÃãÕõÉéÍíÓóÚúÂâÊêÎîÔôÛû\s]+?)(\d{2}\/\d{2}\/\d{4})(.*)/;
      for (const ln of lines) {
        const m = ln.match(regexLinha);
        if (!m) continue;
        const [, codigo, nomeRaw, dataBr, restante] = m;
        const cpfMatch = (restante || "").match(/(\d{11})$/);
        const cpfResp = cpfMatch ? cpfMatch[1] : null;
        const nomes = cpfResp ? restante.slice(0, -11).trim() : (restante || "").trim();
        // Fallback: tenta separar nomes duplicados
        let nomeResponsavel = nomes;
        const ngLen = nomes.length;
        if (ngLen > 0 && ngLen % 2 === 0) {
          const half = ngLen / 2;
          if (nomes.substring(0, half) === nomes.substring(half)) {
            nomeResponsavel = nomes.substring(half);
          }
        }
        pdfEntries.push({
          codigo: String(codigo).trim(),
          estudante: nomeRaw.trim(),
          dataBr,
          sexo: null,
          responsavel: nomeResponsavel || null,
          cpfResponsavel: cpfResp || null,
        });
      }
    }

    console.log(`[importar-pdf] Parser posicional extraiu ${pdfEntries.length} alunos`);

    // Situação atual no DB (por turma) — inclui estudante (nome) para match por nome
    const [atuais] = await pool.query(
      "SELECT id, codigo, estudante, status FROM alunos WHERE turma_id = ?",
      [turma_id]
    );

    const atuaisMap = new Map(atuais.map((a) => [String(a.codigo), a]));
    // ── Match por nome normalizado (fallback para migração ieducar→educadf) ──
    const normName = (s) => (s || '').toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();
    const atuaisNomeMap = new Map();
    for (const a of atuais) {
      const key = normName(a.estudante);
      if (key && !atuaisNomeMap.has(key)) atuaisNomeMap.set(key, a);
    }

    const entradaSet = new Set(pdfEntries.map((e) => String(e.codigo)));

    const toInsert = [];
    const toReactivate = [];
    let jaExistiam = 0;
    let atualizadosCodigo = 0;

    for (const e of pdfEntries) {
      const cod = String(e.codigo);
      let atual = atuaisMap.get(cod);

      // Fallback: match por nome normalizado (cobre migração ieducar→educadf)
      if (!atual) {
        const nomeKey = normName(e.estudante);
        const porNome = atuaisNomeMap.get(nomeKey);
        if (porNome) {
          console.log(`[importar-pdf] Match por nome: "${e.estudante}" — código ${porNome.codigo} → ${e.codigo}`);
          await pool.query(
            'UPDATE alunos SET codigo = ? WHERE id = ? AND escola_id = ?',
            [e.codigo, porNome.id, escola_id]
          );
          atualizadosCodigo++;
          atual = porNome;
          atuaisMap.set(cod, porNome);
          atuaisNomeMap.delete(nomeKey);
          entradaSet.add(String(porNome.codigo));
        }
      }

      if (!atual) {
        toInsert.push(e);
      } else if (atual.status === "inativo") {
        toReactivate.push(e);
      } else {
        jaExistiam++;
        const dataValida = e.dataBr && /^\d{2}\/\d{2}\/\d{4}$/.test(e.dataBr);
        if (dataValida) {
          await pool.query(
            `UPDATE alunos SET data_nascimento = STR_TO_DATE(?, '%d/%m/%Y')
             WHERE id = ? AND escola_id = ? AND data_nascimento IS NULL`,
            [e.dataBr, atual.id, escola_id]
          );
        }
        if (e.cpfResponsavel && e.responsavel) {
          try {
            const [respResult] = await pool.query(
              `INSERT INTO responsaveis (nome, cpf)
               VALUES (?, ?)
               ON DUPLICATE KEY UPDATE
                 id = LAST_INSERT_ID(id),
                 nome = IF(VALUES(nome) != '', VALUES(nome), nome)`,
              [e.responsavel, e.cpfResponsavel]
            );
            const responsavelId = respResult.insertId;
            if (responsavelId && atual.id) {
              const [[vinculoExiste]] = await pool.query(
                "SELECT id FROM responsaveis_alunos WHERE responsavel_id = ? AND aluno_id = ? AND escola_id = ?",
                [responsavelId, atual.id, escola_id]
              );
              if (!vinculoExiste) {
                await pool.query(
                  `INSERT INTO responsaveis_alunos (escola_id, responsavel_id, aluno_id, relacionamento, ativo)
                   VALUES (?, ?, ?, 'RESPONSAVEL', 1)`,
                  [escola_id, responsavelId, atual.id]
                );
              }
            }
          } catch (respErr) {
            console.warn(`[importar-pdf] Aviso: falha ao vincular responsável do aluno existente ${e.codigo}:`, respErr.message);
          }
        }
      }
    }

    if (atualizadosCodigo > 0) {
      console.log(`[importar-pdf] ${atualizadosCodigo} códigos atualizados (ieducar → educadf)`);
    }

    // Inserir novos (e lidar com possíveis alunos existentes em outras turmas via DUPLICATE KEY)
    let inseridos = 0;
    for (const e of toInsert) {
      // Se dataBr é vazio/inválido, usa NULL direto (evita STR_TO_DATE com lixo)
      const dataValida = e.dataBr && /^\d{2}\/\d{2}\/\d{4}$/.test(e.dataBr);
      const insertParams = dataValida
        ? [e.codigo, e.estudante, e.dataBr, turma_id, escola_id]
        : [e.codigo, e.estudante, turma_id, escola_id];
      let insertSql = dataValida
        ? `INSERT INTO alunos (codigo, estudante, data_nascimento, turma_id, escola_id, status)
           VALUES (?, ?, STR_TO_DATE(?, '%d/%m/%Y'), ?, ?, 'ativo')
           ON DUPLICATE KEY UPDATE 
             id = LAST_INSERT_ID(id),
             estudante = VALUES(estudante),
             data_nascimento = COALESCE(data_nascimento, VALUES(data_nascimento)),
             turma_id = VALUES(turma_id),
             status = 'ativo'`
        : `INSERT INTO alunos (codigo, estudante, turma_id, escola_id, status)
           VALUES (?, ?, ?, ?, 'ativo')
           ON DUPLICATE KEY UPDATE 
             id = LAST_INSERT_ID(id),
             estudante = VALUES(estudante),
             turma_id = VALUES(turma_id),
             status = 'ativo'`;
      // Se o PDF trouxer sexo (raro), inclui na query
      if (e.sexo) {
        insertSql = `INSERT INTO alunos (codigo, estudante, data_nascimento, sexo, turma_id, escola_id, status)
         VALUES (?, ?, STR_TO_DATE(?, '%d/%m/%Y'), ?, ?, ?, 'ativo')
         ON DUPLICATE KEY UPDATE 
           id = LAST_INSERT_ID(id),
           estudante = VALUES(estudante),
           turma_id = VALUES(turma_id),
           status = 'ativo'`;
        insertParams.splice(3, 0, e.sexo); // insere sexo após dataBr
      }
      const [result] = await pool.query(insertSql, insertParams);
      
      const alunoId = result.insertId;
      if (alunoId) {
        const [matr] = await pool.query(
          "SELECT id FROM matriculas WHERE aluno_id = ? AND ano_letivo = ? AND escola_id = ?",
          [alunoId, anoLetivoAtual, escola_id]
        );
        if (matr.length > 0) {
          await pool.query("UPDATE matriculas SET status = 'ativo', turma_id = ? WHERE id = ?", [turma_id, matr[0].id]);
        } else {
          await pool.query(
            "INSERT INTO matriculas (escola_id, aluno_id, turma_id, ano_letivo, status) VALUES (?, ?, ?, ?, 'ativo')",
            [escola_id, alunoId, turma_id, anoLetivoAtual]
          );
        }

        // ── RESPONSÁVEL (background) ──
        // Insere/atualiza responsável e cria vínculo com o aluno
        if (e.cpfResponsavel && e.responsavel) {
          try {
            // INSERT ou UPDATE pelo CPF (chave natural)
            const [respResult] = await pool.query(
              `INSERT INTO responsaveis (nome, cpf)
               VALUES (?, ?)
               ON DUPLICATE KEY UPDATE
                 id = LAST_INSERT_ID(id),
                 nome = IF(VALUES(nome) != '', VALUES(nome), nome)`,
              [e.responsavel, e.cpfResponsavel]
            );
            const responsavelId = respResult.insertId;

            if (responsavelId) {
              // Cria vínculo aluno ↔ responsável (se não existir)
              const [[vinculoExiste]] = await pool.query(
                "SELECT id FROM responsaveis_alunos WHERE responsavel_id = ? AND aluno_id = ? AND escola_id = ?",
                [responsavelId, alunoId, escola_id]
              );
              if (!vinculoExiste) {
                await pool.query(
                  `INSERT INTO responsaveis_alunos (escola_id, responsavel_id, aluno_id, relacionamento, ativo)
                   VALUES (?, ?, ?, 'RESPONSAVEL', 1)`,
                  [escola_id, responsavelId, alunoId]
                );
              }
            }
          } catch (respErr) {
            // Erro ao inserir responsável não deve bloquear a importação dos alunos
            console.warn(`[importar-pdf] Aviso: falha ao vincular responsável do aluno ${e.codigo}:`, respErr.message);
          }
        }
      }
      inseridos++;
    }

    // Reativar inativos que voltaram
    let reativados = 0;
    for (const e of toReactivate) {
      const atualObj = atuaisMap.get(String(e.codigo));
      const dataValida = e.dataBr && /^\d{2}\/\d{2}\/\d{4}$/.test(e.dataBr);
      if (dataValida) {
        await pool.query(
          `UPDATE alunos SET status='ativo', turma_id = ?,
           data_nascimento = COALESCE(data_nascimento, STR_TO_DATE(?, '%d/%m/%Y'))
           WHERE codigo = ? AND escola_id = ?`,
          [turma_id, e.dataBr, e.codigo, escola_id]
        );
      } else {
        await pool.query(
          "UPDATE alunos SET status='ativo', turma_id = ? WHERE codigo = ? AND escola_id = ?",
          [turma_id, e.codigo, escola_id]
        );
      }
      
      const alunoId = atualObj.id;
      if (alunoId) {
        const [matr] = await pool.query(
          "SELECT id FROM matriculas WHERE aluno_id = ? AND ano_letivo = ? AND escola_id = ?",
          [alunoId, anoLetivoAtual, escola_id]
        );
        if (matr.length > 0) {
          await pool.query("UPDATE matriculas SET status = 'ativo', turma_id = ? WHERE id = ?", [turma_id, matr[0].id]);
        } else {
          await pool.query(
            "INSERT INTO matriculas (escola_id, aluno_id, turma_id, ano_letivo, status) VALUES (?, ?, ?, ?, 'ativo')",
            [escola_id, alunoId, turma_id, anoLetivoAtual]
          );
        }

        // ── RESPONSÁVEL (background — reativação) ──
        if (e.cpfResponsavel && e.responsavel) {
          try {
            const [respResult] = await pool.query(
              `INSERT INTO responsaveis (nome, cpf)
               VALUES (?, ?)
               ON DUPLICATE KEY UPDATE
                 id = LAST_INSERT_ID(id),
                 nome = IF(VALUES(nome) != '', VALUES(nome), nome)`,
              [e.responsavel, e.cpfResponsavel]
            );
            const responsavelId = respResult.insertId;
            if (responsavelId) {
              const [[vinculoExiste]] = await pool.query(
                "SELECT id FROM responsaveis_alunos WHERE responsavel_id = ? AND aluno_id = ? AND escola_id = ?",
                [responsavelId, alunoId, escola_id]
              );
              if (!vinculoExiste) {
                await pool.query(
                  `INSERT INTO responsaveis_alunos (escola_id, responsavel_id, aluno_id, relacionamento, ativo)
                   VALUES (?, ?, ?, 'RESPONSAVEL', 1)`,
                  [escola_id, responsavelId, alunoId]
                );
              }
            }
          } catch (respErr) {
            console.warn(`[importar-pdf] Aviso: falha ao vincular responsável do aluno reativado ${e.codigo}:`, respErr.message);
          }
        }
      }

      reativados++;
    }

    // ──────────────────────────────────────────────────────────────────
    // DETECÇÃO DE AUSENTES (alunos no banco que NÃO estão no PDF)
    // Não inativa automaticamente — retorna a lista para confirmação
    // pelo secretário no frontend via modal de confirmação.
    // ──────────────────────────────────────────────────────────────────
    const pendentesInativacao = [];
    for (const atual of atuais) {
      if (atual.status !== "ativo") continue;
      const cod = String(atual.codigo);
      const nomeKey = normName(atual.estudante);
      // Se não está no PDF (nem por código, nem por nome) → ausente
      const noCodigoPdf = entradaSet.has(cod);
      const noNomePdf = pdfEntries.some(e => normName(e.estudante) === nomeKey);
      if (!noCodigoPdf && !noNomePdf) {
        pendentesInativacao.push({
          id: atual.id,
          codigo: atual.codigo,
          estudante: atual.estudante,
        });
      }
    }

    if (pendentesInativacao.length > 0) {
      console.log(
        `[importar-pdf] ⚠ ${pendentesInativacao.length} aluno(s) ausente(s) no PDF — pendentes de confirmação para inativação`
      );
    }

    console.log(
      `[importar-pdf] → localizados: ${pdfEntries.length}, inseridos: ${inseridos}, reativados: ${reativados}, jáExistiam: ${jaExistiam}, códigosAtualizados: ${atualizadosCodigo}, pendentesInativacao: ${pendentesInativacao.length}`
    );

    return res.json({
      localizados: pdfEntries.length,
      inseridos,
      reativados,
      jaExistiam,
      codigosAtualizados: atualizadosCodigo,
      inativados: 0,
      pendentesInativacao,
      listaAlunos: pdfEntries,
    });
  } catch (err) {
    console.error("Erro ao processar /importar-pdf:", err);
    return res.status(500).json({ message: "Erro ao processar PDF.", error: err.message });
  }
});

/* ============================================================================
 * 11b) INATIVAR EM LOTE (confirmação manual pelo secretário)
 * POST /api/alunos/inativar-lote
 * Body: { alunoIds: [1, 2, 3] }
 *
 * Inativa alunos selecionados pelo secretário após importação de PDF.
 * Usado quando o PDF não contém alunos que estão no banco (transferidos).
 * ========================================================================== */
router.post("/inativar-lote", async (req, res) => {
  try {
    const { escola_id } = req.user;
    const { alunoIds } = req.body || {};

    if (!Array.isArray(alunoIds) || alunoIds.length === 0) {
      return res.status(400).json({ message: "Lista de alunos vazia." });
    }

    // Segurança: só inativa alunos que pertencem à escola do usuário
    const ids = alunoIds.map(Number).filter(n => n > 0);
    if (ids.length === 0) {
      return res.status(400).json({ message: "IDs inválidos." });
    }

    const [result] = await pool.query(
      `UPDATE alunos SET status = 'inativo' WHERE id IN (?) AND escola_id = ? AND status = 'ativo'`,
      [ids, escola_id]
    );

    // Inativa matrículas correspondentes
    const anoLetivoAtual = typeof anoLetivoPadrao === "function" ? anoLetivoPadrao() : String(new Date().getFullYear());
    await pool.query(
      `UPDATE matriculas SET status = 'inativo' WHERE aluno_id IN (?) AND escola_id = ? AND ano_letivo = ?`,
      [ids, escola_id, anoLetivoAtual]
    ).catch(() => {});

    console.log(`[inativar-lote] ${result.affectedRows} aluno(s) inativado(s) (escola_id=${escola_id})`);

    return res.json({
      ok: true,
      inativados: result.affectedRows,
      message: `${result.affectedRows} aluno(s) inativado(s) com sucesso.`,
    });
  } catch (err) {
    console.error("Erro ao inativar em lote:", err);
    return res.status(500).json({ message: "Erro ao inativar alunos.", error: err.message });
  }
});

/* ============================================================================
 * 12) IMPORTAR XLSX (lógica similar ao PDF; converte datas e processa status)
 * POST /api/alunos/importar-xlsx (arquivo: file)
 * - Nome do arquivo (sem extensão) = nome da turma
 * ========================================================================== */
const uploadXlsx = multer(); // usa buffer
router.post("/importar-xlsx", uploadXlsx.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: "XLSX não enviado." });
  }

  try {
    const { escola_id } = req.user;
    const anoLetivoAtual = typeof anoLetivoPadrao === "function" ? anoLetivoPadrao() : String(new Date().getFullYear());

    const workbook = XLSX.read(req.file.buffer, { type: "buffer" });
    const primeiraAbaNome = workbook.SheetNames[0];
    const sheet = workbook.Sheets[primeiraAbaNome];

    const dados = XLSX.utils.sheet_to_json(sheet, {
      header: ["codigo", "estudante", "data_nascimento", "sexo"],
      range: 1,  // pula cabeçalho (linha 0)
      defval: "",
    });

    let turmaNomeStr = req.body.turmaNome || req.file.originalname.replace(/\.[^.]+$/i, "").trim();
    // Corrige erro de parse do multer (latin1 vs utf-8) que causa 6Âº em vez de 6º
    const turmaNome = turmaNomeStr.replace(/Âº/g, 'º').replace(/Âª/g, 'ª');

    const [[turma]] = await pool.query("SELECT id FROM turmas WHERE nome = ? AND escola_id = ?", [turmaNome, escola_id]);
    if (!turma) {
      return res.status(404).json({ message: `Turma "${turmaNome}" não encontrada.` });
    }
    const turma_id = turma.id;

    const xlsxEntries = [];
    for (const linha of dados) {
      const codigo = String(linha.codigo).trim();
      const estudante = String(linha.estudante).trim();
      const sexoRaw = String(linha.sexo).trim().toUpperCase();

      // Data pode vir como serial do Excel ou texto; convertemos para dd/mm/yyyy
      let dataBr = "";
      if (typeof linha.data_nascimento === "number") {
        dataBr = XLSX.SSF.format("dd/mm/yyyy", linha.data_nascimento);
      } else {
        const str = String(linha.data_nascimento).trim().replace(/-/g, "/");
        const partes = str.split("/");
        if (partes.length === 3) {
          // heurística de dia/mês/ano
          const [p0, p1, p2] = partes;
          if (p0.length === 2 && p1.length === 2 && p2.length === 4) {
            dataBr = `${p0}/${p1}/${p2}`;
          } else if (p0.length === 4 && p1.length === 2 && p2.length === 2) {
            dataBr = `${p2}/${p1}/${p0}`;
          }
        }
      }

      if (!codigo || !estudante) continue;

      xlsxEntries.push({
        codigo,
        estudante,
        dataBr: dataBr || null,
        sexo: /^[MF]$/.test(sexoRaw) ? sexoRaw : null,
      });
    }

    const [atuais] = await pool.query(
      "SELECT id, codigo, status FROM alunos WHERE turma_id = ?",
      [turma_id]
    );
    const atuaisMap = new Map(atuais.map((a) => [String(a.codigo), a]));
    const entradaSet = new Set(xlsxEntries.map((e) => String(e.codigo)));

    const toInsert = [];
    const toReactivate = [];
    let jaExistiam = 0;

    for (const e of xlsxEntries) {
      const cod = String(e.codigo);
      const atual = atuaisMap.get(cod);
      if (!atual) {
        toInsert.push(e);
      } else if (atual.status === "inativo") {
        toReactivate.push(e);
      } else {
        jaExistiam++;
      }
    }

    const toInactivate = atuais.filter((a) => !entradaSet.has(String(a.codigo)));

    // Inserir novos
    let inseridos = 0;
    for (const e of toInsert) {
      const [result] = await pool.query(
        `INSERT INTO alunos (codigo, estudante, data_nascimento, sexo, turma_id, escola_id, status)
         VALUES (?, ?, ${e.dataBr ? "STR_TO_DATE(?, '%d/%m/%Y')" : "NULL"}, ?, ?, ?, 'ativo')
         ON DUPLICATE KEY UPDATE 
           id = LAST_INSERT_ID(id),
           estudante = VALUES(estudante),
           turma_id = VALUES(turma_id),
           status = 'ativo'`,
        e.dataBr
          ? [e.codigo, e.estudante, e.dataBr, e.sexo, turma_id, escola_id]
          : [e.codigo, e.estudante, e.sexo, turma_id, escola_id]
      );
      
      const alunoId = result.insertId;
      if (alunoId) {
        const [matr] = await pool.query(
          "SELECT id FROM matriculas WHERE aluno_id = ? AND ano_letivo = ? AND escola_id = ?",
          [alunoId, anoLetivoAtual, escola_id]
        );
        if (matr.length > 0) {
          await pool.query("UPDATE matriculas SET status = 'ativo', turma_id = ? WHERE id = ?", [turma_id, matr[0].id]);
        } else {
          await pool.query(
            "INSERT INTO matriculas (escola_id, aluno_id, turma_id, ano_letivo, status) VALUES (?, ?, ?, ?, 'ativo')",
            [escola_id, alunoId, turma_id, anoLetivoAtual]
          );
        }
      }
      
      inseridos++;
    }

    // Reativar
    let reativados = 0;
    for (const e of toReactivate) {
      const atualObj = atuaisMap.get(String(e.codigo));
      await pool.query(
        "UPDATE alunos SET status='ativo', turma_id = ? WHERE codigo = ? AND escola_id = ?",
        [turma_id, e.codigo, escola_id]
      );
      
      const alunoId = atualObj.id;
      if (alunoId) {
        const [matr] = await pool.query(
          "SELECT id FROM matriculas WHERE aluno_id = ? AND ano_letivo = ? AND escola_id = ?",
          [alunoId, anoLetivoAtual, escola_id]
        );
        if (matr.length > 0) {
          await pool.query("UPDATE matriculas SET status = 'ativo', turma_id = ? WHERE id = ?", [turma_id, matr[0].id]);
        } else {
          await pool.query(
            "INSERT INTO matriculas (escola_id, aluno_id, turma_id, ano_letivo, status) VALUES (?, ?, ?, ?, 'ativo')",
            [escola_id, alunoId, turma_id, anoLetivoAtual]
          );
        }
      }

      reativados++;
    }

    // Inativar não listados
    let inativados = 0;
    for (const r of toInactivate) {
      const correspondente = xlsxEntries.find((e) => e.codigo === String(r.codigo));
      if (correspondente && correspondente.dataBr && /^\d{2}\/\d{2}\/\d{4}$/.test(correspondente.dataBr)) {
        await pool.query(
          `UPDATE alunos
           SET status='inativo', data_nascimento = STR_TO_DATE(?, '%d/%m/%Y'), turma_id = ?
           WHERE id = ?`,
          [correspondente.dataBr, turma_id, r.id]
        );
      } else {
        await pool.query("UPDATE alunos SET status='inativo' WHERE id = ?", [r.id]);
      }
      
      await pool.query(
        "UPDATE matriculas SET status='inativo' WHERE aluno_id = ? AND ano_letivo = ? AND escola_id = ?",
        [r.id, anoLetivoAtual, escola_id]
      );
      inativados++;
    }

    console.log(
      `[importar-xlsx] → localizados: ${xlsxEntries.length}, inseridos: ${inseridos}, reativados: ${reativados}, jáExistiam: ${jaExistiam}, inativados: ${inativados}`
    );
    return res.json({ localizados: xlsxEntries.length, inseridos, reativados, jaExistiam, inativados });
  } catch (err) {
    console.error("Erro ao processar /importar-xlsx:", err);
    return res.status(500).json({ message: "Erro ao processar XLSX.", error: err.message });
  }
});

/* ============================================================================
 * 13) LISTAR INATIVOS
 * GET /api/alunos/inativos
 * ========================================================================== */
router.get("/inativos", verificarEscola, async (req, res) => {
  try {
    const { escola_id } = req.user;
    const [rows] = await pool.query(
      `SELECT a.id, a.codigo, a.estudante,
              DATE_FORMAT(a.data_nascimento, '%Y-%m-%d') AS data_nascimento,
              a.sexo, a.status,
              t.nome AS turma, t.turno
       FROM alunos a
       LEFT JOIN turmas t ON t.id = a.turma_id
       WHERE a.status='inativo' AND a.escola_id = ?
       ORDER BY a.estudante`,
      [escola_id]
    );
    res.json(rows);
  } catch (err) {
    console.error("Erro ao buscar alunos inativos:", err);
    res.status(500).json({ message: "Erro ao buscar alunos inativos." });
  }
});

/* ============================================================================
 * 14) ROTA DE TESTE (opcional)
 * GET /api/alunos/testetodosalunos
 * ========================================================================== */
router.get("/testetodosalunos", async (req, res) => {
  const [rows] = await pool.query("SELECT * FROM alunos");
  res.json(rows);
});

/* ============================================================================
 * 15) OCORRÊNCIAS DISCIPLINARES
 * GET /api/alunos/:id/ocorrencias
 * POST /api/alunos/:id/ocorrencias
 * ========================================================================== */
router.get("/:id/proxima-ocorrencia", verificarEscola, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT AUTO_INCREMENT
       FROM information_schema.tables
       WHERE table_name = 'ocorrencias_disciplinares'
       AND table_schema = DATABASE()`
    );

    const proximoId = rows[0]?.AUTO_INCREMENT || 1;
    const registroFormatado = String(proximoId).padStart(4, '0');

    res.json({ proximoRegistro: registroFormatado });
  } catch (err) {
    console.error("Erro ao buscar proximo registro:", err);
    res.status(500).json({ message: "Erro ao buscar próximo registro de ocorrência." });
  }
});
router.get("/:id/ocorrencias", verificarEscola, async (req, res) => {
  try {
    const { id } = req.params;
    const { escola_id } = req.user;

    // Buscar ocorrências do aluno
    const [rows] = await pool.query(
      `SELECT o.id, 
              LPAD(o.id, 4, '0') AS registro, 
              DATE_FORMAT(o.data_ocorrencia, '%d/%m/%Y') AS data_ocorrencia,
              o.motivo, 
              r.medida_disciplinar,
              r.tipo_ocorrencia AS tipo,
              r.pontos,
              o.descricao,
              o.registro_interno,
              o.convocar_responsavel,
              o.dias_suspensao,
              DATE_FORMAT(o.data_comparecimento_responsavel, '%d/%m/%Y %H:%i') AS data_comparecimento_responsavel,
              o.status,
              u.nome AS nome_usuario_finalizacao
       FROM ocorrencias_disciplinares o
       LEFT JOIN usuarios u ON u.id = o.usuario_finalizacao_id
       LEFT JOIN registros_ocorrencias r ON r.descricao_ocorrencia = o.motivo AND r.tipo_ocorrencia = o.tipo_ocorrencia
       WHERE o.aluno_id = ? AND o.escola_id = ?
       ORDER BY o.data_ocorrencia DESC, o.id DESC`,
      [id, escola_id]
    );

    res.json(rows);
  } catch (err) {
    console.error("Erro ao buscar ocorrências:", err);
    res.status(500).json({ message: "Erro ao buscar ocorrências disciplinares." });
  }
});

router.post("/:id/ocorrencias", verificarEscola, async (req, res) => {
  try {
    const { id } = req.params;
    const { escola_id } = req.user;
    const { data, motivo, tipoOcorrencia, descricao, registroInterno, convocarResponsavel, diasSuspensao } = req.body;

    if (!data || !motivo) {
      return res.status(400).json({ message: "Preencha os campos obrigatórios." });
    }

    const [result] = await pool.query(
      `INSERT INTO ocorrencias_disciplinares 
         (aluno_id, escola_id, data_ocorrencia, motivo, tipo_ocorrencia, descricao, registro_interno, convocar_responsavel, dias_suspensao) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, escola_id, data, motivo, tipoOcorrencia || null, descricao || null, registroInterno || null, convocarResponsavel ? 1 : 0, diasSuspensao || null]
    );

    res.status(201).json({
      message: "Ocorrência registrada com sucesso.",
      id: result.insertId
    });
  } catch (err) {
    console.error("Erro ao registrar ocorrência:", err);
    res.status(500).json({ message: "Erro ao registrar ocorrência." });
  }
});

router.put("/:id/ocorrencias/:ocorrenciaId", verificarEscola, async (req, res) => {
  try {
    const { id, ocorrenciaId } = req.params;
    const { escola_id } = req.user;
    const { descricao, registroInterno, convocarResponsavel } = req.body;

    await pool.query(
      `UPDATE ocorrencias_disciplinares 
       SET descricao = ?, registro_interno = ?, convocar_responsavel = ? 
       WHERE id = ? AND aluno_id = ? AND escola_id = ?`,
      [descricao, registroInterno || null, convocarResponsavel ? 1 : 0, ocorrenciaId, id, escola_id]
    );

    res.json({ message: "Ocorrência atualizada com sucesso." });
  } catch (err) {
    console.error("Erro ao atualizar ocorrência:", err);
    res.status(500).json({ message: "Erro ao atualizar ocorrência." });
  }
});

router.put("/:id/ocorrencias/:ocorrenciaId/comparecimento", verificarEscola, async (req, res) => {
  try {
    const { id, ocorrenciaId } = req.params;
    const { escola_id } = req.user;
    const usuarioFinalizacaoId = req.user.usuarioId || req.user.id || req.user.usuario_id;

    const [result] = await pool.query(
      `UPDATE ocorrencias_disciplinares 
       SET data_comparecimento_responsavel = CASE WHEN convocar_responsavel = 1 THEN DATE_SUB(NOW(), INTERVAL 3 HOUR) ELSE data_comparecimento_responsavel END,
           status = 'FINALIZADA',
           usuario_finalizacao_id = ?
       WHERE id = ? AND aluno_id = ? AND escola_id = ?`,
      [usuarioFinalizacaoId, ocorrenciaId, id, escola_id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Ocorrência não encontrada." });
    }

    res.json({ message: "Ocorrência finalizada com sucesso." });
  } catch (err) {
    console.error("Erro ao finalizar ocorrência:", err);
    res.status(500).json({ message: "Erro ao finalizar ocorrência." });
  }
});

// ============================================================================
// PUT /api/alunos/:id/ocorrencias/:ocorrenciaId/cancelamento
// Cancela uma medida disciplinar — reverte a pontuação do aluno
// Registra o usuário que realizou o cancelamento
// ============================================================================
router.put("/:id/ocorrencias/:ocorrenciaId/cancelamento", verificarEscola, async (req, res) => {
  try {
    const { id, ocorrenciaId } = req.params;
    const { escola_id } = req.user;
    const usuarioCancelamentoId = req.user.usuarioId || req.user.id || req.user.usuario_id;

    const [result] = await pool.query(
      `UPDATE ocorrencias_disciplinares 
       SET status = 'CANCELADA',
           usuario_finalizacao_id = ?
       WHERE id = ? AND aluno_id = ? AND escola_id = ? AND status IN ('FINALIZADA', 'REGISTRADA')`,
      [usuarioCancelamentoId, ocorrenciaId, id, escola_id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Ocorrência não encontrada ou já cancelada." });
    }

    res.json({ message: "Medida disciplinar cancelada com sucesso." });
  } catch (err) {
    console.error("Erro ao cancelar medida disciplinar:", err);
    res.status(500).json({ message: "Erro ao cancelar medida disciplinar." });
  }
});

router.delete("/:id/ocorrencias/:ocorrenciaId", verificarEscola, async (req, res) => {
  try {
    const { id, ocorrenciaId } = req.params;
    const { escola_id } = req.user;

    const [result] = await pool.query(
      `DELETE FROM ocorrencias_disciplinares 
       WHERE id = ? AND aluno_id = ? AND escola_id = ? AND status != 'FINALIZADA'`,
      [ocorrenciaId, id, escola_id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Ocorrência não encontrada ou não pode ser excluída." });
    }

    res.json({ message: "Ocorrência excluída com sucesso." });
  } catch (err) {
    console.error("Erro ao excluir ocorrência:", err);
    res.status(500).json({ message: "Erro ao excluir ocorrência." });
  }
});

/* ============================================================================
 * 16) OCORRÊNCIAS PEDAGÓGICAS
 * CRUD completo — mesma lógica de status das disciplinares (sem pontuação)
 * ========================================================================== */

// GET — listar ocorrências pedagógicas de um aluno
router.get("/:id/ocorrencias-pedagogicas", verificarEscola, async (req, res) => {
  try {
    const { id } = req.params;
    const { escola_id } = req.user;

    const [rows] = await pool.query(
      `SELECT o.id,
              LPAD(o.id, 4, '0') AS registro,
              DATE_FORMAT(o.data_ocorrencia, '%d/%m/%Y') AS data_ocorrencia,
              o.categoria,
              o.motivo,
              o.descricao,
              o.registro_interno,
              o.convocar_responsavel,
              DATE_FORMAT(o.data_comparecimento_responsavel, '%d/%m/%Y %H:%i') AS data_comparecimento_responsavel,
              o.status,
              ur.nome AS nome_usuario_registro,
              uf.nome AS nome_usuario_finalizacao
       FROM ocorrencias_pedagogicas o
       LEFT JOIN usuarios ur ON ur.id = o.usuario_registro_id
       LEFT JOIN usuarios uf ON uf.id = o.usuario_finalizacao_id
       WHERE o.aluno_id = ? AND o.escola_id = ?
       ORDER BY o.data_ocorrencia DESC, o.id DESC`,
      [id, escola_id]
    );

    res.json(rows);
  } catch (err) {
    console.error("Erro ao buscar ocorrências pedagógicas:", err);
    res.status(500).json({ message: "Erro ao buscar ocorrências pedagógicas." });
  }
});

// GET — próximo registro (auto-increment)
router.get("/:id/proxima-ocorrencia-pedagogica", verificarEscola, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT AUTO_INCREMENT
       FROM information_schema.tables
       WHERE table_name = 'ocorrencias_pedagogicas'
       AND table_schema = DATABASE()`
    );
    const proximoId = rows[0]?.AUTO_INCREMENT || 1;
    res.json({ proximoRegistro: String(proximoId).padStart(4, '0') });
  } catch (err) {
    console.error("Erro ao buscar próximo registro pedagógico:", err);
    res.status(500).json({ message: "Erro ao buscar próximo registro." });
  }
});

// POST — criar nova ocorrência pedagógica
router.post("/:id/ocorrencias-pedagogicas", verificarEscola, async (req, res) => {
  try {
    const { id } = req.params;
    const { escola_id } = req.user;
    const usuarioId = req.user.usuarioId || req.user.id || req.user.usuario_id;
    const { data, categoria, motivo, descricao, registroInterno, convocarResponsavel } = req.body;

    if (!data || !motivo || !categoria) {
      return res.status(400).json({ message: "Preencha os campos obrigatórios (data, categoria, motivo)." });
    }

    const [result] = await pool.query(
      `INSERT INTO ocorrencias_pedagogicas
         (aluno_id, escola_id, data_ocorrencia, categoria, motivo, descricao, registro_interno, convocar_responsavel, usuario_registro_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, escola_id, data, categoria, motivo, descricao || null, registroInterno || null, convocarResponsavel ? 1 : 0, usuarioId]
    );

    res.status(201).json({
      message: "Registro pedagógico criado com sucesso.",
      id: result.insertId,
    });
  } catch (err) {
    console.error("Erro ao registrar ocorrência pedagógica:", err);
    res.status(500).json({ message: "Erro ao registrar ocorrência pedagógica." });
  }
});

// PUT — editar ocorrência pedagógica (apenas descricao e registro interno)
router.put("/:id/ocorrencias-pedagogicas/:ocorrenciaId", verificarEscola, async (req, res) => {
  try {
    const { id, ocorrenciaId } = req.params;
    const { escola_id } = req.user;
    const { descricao, registroInterno, convocarResponsavel } = req.body;

    await pool.query(
      `UPDATE ocorrencias_pedagogicas
       SET descricao = ?, registro_interno = ?, convocar_responsavel = ?
       WHERE id = ? AND aluno_id = ? AND escola_id = ?`,
      [descricao, registroInterno || null, convocarResponsavel ? 1 : 0, ocorrenciaId, id, escola_id]
    );

    res.json({ message: "Registro pedagógico atualizado." });
  } catch (err) {
    console.error("Erro ao atualizar ocorrência pedagógica:", err);
    res.status(500).json({ message: "Erro ao atualizar registro pedagógico." });
  }
});

// PUT — finalizar ocorrência pedagógica
router.put("/:id/ocorrencias-pedagogicas/:ocorrenciaId/finalizar", verificarEscola, async (req, res) => {
  try {
    const { id, ocorrenciaId } = req.params;
    const { escola_id } = req.user;
    const usuarioFinalizacaoId = req.user.usuarioId || req.user.id || req.user.usuario_id;

    const [result] = await pool.query(
      `UPDATE ocorrencias_pedagogicas
       SET data_comparecimento_responsavel = CASE WHEN convocar_responsavel = 1 THEN DATE_SUB(NOW(), INTERVAL 3 HOUR) ELSE data_comparecimento_responsavel END,
           status = 'FINALIZADA',
           usuario_finalizacao_id = ?
       WHERE id = ? AND aluno_id = ? AND escola_id = ?`,
      [usuarioFinalizacaoId, ocorrenciaId, id, escola_id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Registro pedagógico não encontrado." });
    }

    res.json({ message: "Registro pedagógico finalizado." });
  } catch (err) {
    console.error("Erro ao finalizar registro pedagógico:", err);
    res.status(500).json({ message: "Erro ao finalizar registro pedagógico." });
  }
});

// PUT — cancelar ocorrência pedagógica
router.put("/:id/ocorrencias-pedagogicas/:ocorrenciaId/cancelamento", verificarEscola, async (req, res) => {
  try {
    const { id, ocorrenciaId } = req.params;
    const { escola_id } = req.user;
    const usuarioCancelamentoId = req.user.usuarioId || req.user.id || req.user.usuario_id;

    const [result] = await pool.query(
      `UPDATE ocorrencias_pedagogicas
       SET status = 'CANCELADA',
           usuario_finalizacao_id = ?
       WHERE id = ? AND aluno_id = ? AND escola_id = ? AND status IN ('FINALIZADA', 'REGISTRADA')`,
      [usuarioCancelamentoId, ocorrenciaId, id, escola_id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Registro não encontrado ou já cancelado." });
    }

    res.json({ message: "Registro pedagógico cancelado." });
  } catch (err) {
    console.error("Erro ao cancelar registro pedagógico:", err);
    res.status(500).json({ message: "Erro ao cancelar registro pedagógico." });
  }
});

// DELETE — excluir ocorrência pedagógica (apenas REGISTRADA)
router.delete("/:id/ocorrencias-pedagogicas/:ocorrenciaId", verificarEscola, async (req, res) => {
  try {
    const { id, ocorrenciaId } = req.params;
    const { escola_id } = req.user;

    const [result] = await pool.query(
      `DELETE FROM ocorrencias_pedagogicas
       WHERE id = ? AND aluno_id = ? AND escola_id = ? AND status = 'REGISTRADA'`,
      [ocorrenciaId, id, escola_id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Registro não encontrado ou não pode ser excluído." });
    }

    res.json({ message: "Registro pedagógico excluído." });
  } catch (err) {
    console.error("Erro ao excluir registro pedagógico:", err);
    res.status(500).json({ message: "Erro ao excluir registro pedagógico." });
  }
});

export default router;
