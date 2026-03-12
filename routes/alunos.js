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
 * - Linhas no padrão: "<codigo> <nome> <dd/mm/aaaa>"
 *   Sexo vem 2 linhas abaixo (M/F)
 * ========================================================================== */
const uploadPdf = multer(); // usa buffer
router.post("/importar-pdf", uploadPdf.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: "PDF não enviado." });
  }

  try {
    const { escola_id } = req.user;
    const anoLetivoAtual = typeof anoLetivoPadrao === "function" ? anoLetivoPadrao() : String(new Date().getFullYear());
  
    const { text } = await pdfParse(req.file.buffer);
    let turmaNomeStr = req.body.turmaNome || req.file.originalname.replace(/\.pdf$/i, "").trim();
    // Corrige erro de parse do multer (latin1 vs utf-8) que causa 6Âº em vez de 6º
    const turmaNome = turmaNomeStr.replace(/Âº/g, 'º').replace(/Âª/g, 'ª');

    const [[turma]] = await pool.query("SELECT id FROM turmas WHERE nome = ? AND escola_id = ?", [turmaNome, escola_id]);
    if (!turma) {
      return res.status(404).json({ message: `Turma "${turmaNome}" não encontrada.` });
    }
    const turma_id = turma.id;

    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const pdfEntries = [];
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      const m = ln.match(/^(\d{3,})\s*([A-Za-zÀ-ÖØ-öø-ÿ\s]+?)\s*(\d{2}\/\d{2}\/\d{4})\s*$/);
      if (!m) continue;
      const [, codigo, nomeRaw, dataBr] = m;
      const sexoRaw = (lines[i + 2] || "").charAt(0).toUpperCase();
      if (!/^[MF]$/.test(sexoRaw)) continue;

      pdfEntries.push({
        codigo: String(codigo).trim(),
        estudante: nomeRaw.trim(),
        dataBr,                 // dd/mm/yyyy
        sexo: sexoRaw,
      });
    }

    // Situação atual no DB (por turma)
    const [atuais] = await pool.query(
      "SELECT id, codigo, status FROM alunos WHERE turma_id = ?",
      [turma_id]
    );

    const atuaisMap = new Map(atuais.map((a) => [String(a.codigo), a]));
    const entradaSet = new Set(pdfEntries.map((e) => String(e.codigo)));

    const toInsert = [];
    const toReactivate = [];
    let jaExistiam = 0;

    for (const e of pdfEntries) {
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

    // Inserir novos (e lidar com possíveis alunos existentes em outras turmas via DUPLICATE KEY)
    let inseridos = 0;
    for (const e of toInsert) {
      const [result] = await pool.query(
        `INSERT INTO alunos (codigo, estudante, data_nascimento, sexo, turma_id, escola_id, status)
         VALUES (?, ?, STR_TO_DATE(?, '%d/%m/%Y'), ?, ?, ?, 'ativo')
         ON DUPLICATE KEY UPDATE 
           id = LAST_INSERT_ID(id),
           estudante = VALUES(estudante),
           turma_id = VALUES(turma_id),
           status = 'ativo'`,
        [e.codigo, e.estudante, e.dataBr, e.sexo, turma_id, escola_id]
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

    // Reativar inativos que voltaram
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

    // Inativar quem saiu do arquivo
    let inativados = 0;
    for (const r of toInactivate) {
      const correspondente = pdfEntries.find((e) => e.codigo === String(r.codigo));
      if (correspondente) {
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
      `[importar-pdf] → localizados: ${pdfEntries.length}, inseridos: ${inseridos}, reativados: ${reativados}, jáExistiam: ${jaExistiam}, inativados: ${inativados}`
    );

    return res.json({
      localizados: pdfEntries.length,
      inseridos,
      reativados,
      jaExistiam,
      inativados,
      listaAlunos: pdfEntries,
    });
  } catch (err) {
    console.error("Erro ao processar /importar-pdf:", err);
    return res.status(500).json({ message: "Erro ao processar PDF.", error: err.message });
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
      if (correspondente && correspondente.dataBr) {
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
              o.descricao, 
              o.convocar_responsavel, 
              DATE_FORMAT(o.data_comparecimento_responsavel, '%d/%m/%Y %H:%i') AS data_comparecimento_responsavel,
              o.status,
              u.nome AS nome_usuario_finalizacao
       FROM ocorrencias_disciplinares o
       LEFT JOIN usuarios u ON u.id = o.usuario_finalizacao_id
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
    const { data, motivo, descricao, convocarResponsavel } = req.body;

    if (!data || !motivo || !descricao) {
      return res.status(400).json({ message: "Preencha os campos obrigatórios." });
    }

    const [result] = await pool.query(
      `INSERT INTO ocorrencias_disciplinares 
         (aluno_id, escola_id, data_ocorrencia, motivo, descricao, convocar_responsavel) 
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, escola_id, data, motivo, descricao, convocarResponsavel ? 1 : 0]
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
    const { descricao, convocarResponsavel } = req.body;

    if (!descricao) {
      return res.status(400).json({ message: "A descrição é obrigatória." });
    }

    await pool.query(
      `UPDATE ocorrencias_disciplinares 
       SET descricao = ?, convocar_responsavel = ? 
       WHERE id = ? AND aluno_id = ? AND escola_id = ?`,
      [descricao, convocarResponsavel ? 1 : 0, ocorrenciaId, id, escola_id]
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

export default router;
