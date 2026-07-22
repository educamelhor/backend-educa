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
import { calcularEUpsertBonusMedia } from "./relatorio-disciplinar.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = _dirname(__filename);

const router = express.Router();

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Helper: ano letivo padrÃ£o com data de corte em 31/jan
// (se mÃªs <= 1 â†’ ano anterior; senÃ£o â†’ ano corrente)
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function anoLetivoPadrao() {
  const hoje = new Date();
  const mes = hoje.getMonth() + 1; // 1â€“12
  return mes <= 1 ? hoje.getFullYear() - 1 : hoje.getFullYear();
}

// Base pÃºblica do Spaces (sem depender do front â€œadivinharâ€ a URL)
// Ex.: https://nyc3.digitaloceanspaces.com/educa-melhor-uploads/
const SPACES_PUBLIC_BASE = String(
  process.env.SPACES_PUBLIC_BASE || "https://nyc3.digitaloceanspaces.com/educa-melhor-uploads/"
).replace(/\/+$/, "") + "/";

/*
 * Middleware local (defensivo) para garantir escola no req.user
 * OBS: O router jÃ¡ Ã© protegido por autenticaÃ§Ã£o + verificarEscola no server.js,
 * mas mantemos aqui para endpoints que o utilizam diretamente.
 */
function verificarEscola(req, res, next) {
  if (!req.user || !req.user.escola_id) {
    return res.status(403).json({ message: "Acesso negado: escola nÃ£o definida." });
  }
  next();
}

/* ============================================================================
 * 1) CONFIGURAÃ‡ÃƒO DE UPLOAD DE FOTOS (MULTER)
 * - Grava em /uploads/CEF04_PLAN/alunos (pasta servida pelo server.js)
 * ========================================================================== */
const uploadDir = path.resolve(__dirname, "../uploads/CEF04_PLAN/alunos");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const codigo = req.params.id; // usamos :id da rota como "cÃ³digo do aluno"
    cb(null, `${codigo}.jpg`);
  },
});
const upload = multer({ storage });

/* ============================================================================
 * 2) ROTA PÃšBLICA PARA IMPRESSÃƒO (por turma, via secret)
 * GET /api/alunos/publico?turma_id=123&secret=xxxx
 * - NÃ£o depende de req.user
 * ========================================================================== */
router.get("/publico", async (req, res) => {
  try {
    const { turma_id, secret } = req.query;

    const PRINT_SECRET = process.env.PRINT_SECRET || "123456";
    if (!secret || secret !== PRINT_SECRET) {
      return res.status(403).json({ message: "Acesso negado (secret invÃ¡lido)." });
    }
    if (!turma_id) {
      return res.status(400).json({ message: "turma_id obrigatÃ³rio." });
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
 * - Filtra por escola do usuÃ¡rio (req.user.escola_id)
 * - Filtros: turma_id, busca textual (nome/cÃ³digo/turma/turno) e status (ativo/inativo)
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

    // Ano letivo efetivo: usa o parÃ¢metro ou calcula o padrÃ£o (corte 31/jan)
    const anoEfetivo = ano_letivo ? Number(ano_letivo) : anoLetivoPadrao();

    // DEBUG: o que chegou do front e do token
    console.log("ðŸ”Ž /api/alunos â†’ filtros:", { turma_id, filtro, status, ano_letivo, limit, offset });
    console.log("ðŸ”Ž /api/alunos â†’ req.user:", req.user);

    const where = ["a.escola_id = ?", "m.ano_letivo = ?"];
    // âš ï¸ ordem dos params importa: o SQL abaixo usa SPACES_PUBLIC_BASE no primeiro "?"
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

    // Filtra params: SPACES_PUBLIC_BASE nÃ£o deve ir para o COUNT (jÃ¡ que COUNT usa os mesmos binds do WHERE e ignoramos o bind inicial do SELECT principal)
    // SPACES_PUBLIC_BASE Ã© o params[0], entÃ£o paramsCount pula ele.
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
             a.cpf,
             a.atendimento_diferencial,
             a.status,
             a.foto,

             -- URL canÃ´nica do Spaces (novo padrÃ£o do EDUCA-CAPTURE):
             CASE
               WHEN a.foto LIKE 'http%' THEN a.foto
               ELSE CONCAT(?, 'uploads/', COALESCE(e.apelido, CONCAT('escola_', a.escola_id)), '/alunos/', a.codigo, '.jpg')
             END AS foto_url,

             t.nome  AS turma,
             t.turno,
             m.turma_id,
             m.ano_letivo,

             -- LGPD: consentimento de imagem pelo responsÃ¡vel
             COALESCE(
               (SELECT MAX(CASE WHEN ra.consentimento_imagem = 1 AND ra.ativo = 1 THEN 1 ELSE 0 END)
                  FROM responsaveis_alunos ra
                 WHERE ra.aluno_id = a.id AND ra.escola_id = a.escola_id),
               0
             ) AS consentimento_imagem

      FROM alunos AS a
      -- JOIN via matriculas (fonte canÃ´nica de turma/ano a partir de 2026-03)
      INNER JOIN matriculas AS m ON m.aluno_id = a.id AND m.escola_id = a.escola_id
      LEFT JOIN  turmas     AS t ON t.id = m.turma_id
      LEFT JOIN  escolas    AS e ON e.id = a.escola_id
      ${whereSql}
      ORDER BY a.estudante
      LIMIT ? OFFSET ?
    `;
    params.push(Number(limit), Number(offset));

    console.log("ðŸ”Ž /api/alunos â†’ SQL:", sql.replace(/\s+/g, " ").trim());
    console.log("ðŸ”Ž /api/alunos â†’ params:", params);

    const [rows] = await pool.query(sql, params);

    // LGPD: oculta foto quando nÃ£o hÃ¡ consentimento
    const alunosComConsentimento = rows.map((a) => {
      const ok = Number(a.consentimento_imagem) === 1;
      return {
        ...a,
        foto:     ok ? a.foto     : null,
        foto_url: ok ? a.foto_url : null,
        consentimento_imagem: ok,
      };
    });

    res.json({ alunos: alunosComConsentimento, total });

  } catch (err) {
    console.error("Erro ao listar alunos:", err);
    res.status(500).json({ message: "Erro ao listar alunos." });
  }
});

/* ============================================================================
 * 4) CRIAR ALUNO
 * POST /api/alunos
 * Body: { codigo, estudante, data_nascimento(YYYY-MM-DD), sexo, turma_id }
 * - status padrÃ£o: "ativo"
 * ========================================================================== */
router.post("/", verificarEscola, async (req, res) => {
  try {
    const { codigo, estudante, data_nascimento, sexo, turma_id, cpf, atendimento_diferencial } = req.body;
    const { escola_id } = req.user;

    if (!codigo || !estudante) {
      return res.status(400).json({ message: "CÃ³digo e nome sÃ£o obrigatÃ³rios." });
    }

    const anoLetivoAtual = anoLetivoPadrao();

    // Verifica se jÃ¡ existe na base global da escola
    const [[existe]] = await pool.query(
      "SELECT id, status FROM alunos WHERE codigo = ? AND escola_id = ?",
      [codigo, escola_id]
    );

    let alunoId;

    if (existe) {
      alunoId = existe.id;

      // Se existe, verifica se jÃ¡ estÃ¡ matriculado ATIVO neste mesmo ano letivo
      const [[matr]] = await pool.query(
        "SELECT id, status FROM matriculas WHERE aluno_id = ? AND ano_letivo = ? AND escola_id = ?",
        [alunoId, anoLetivoAtual, escola_id]
      );
      if (matr && matr.status === "ativo") {
        return res.status(409).json({ message: "Este estudante jÃ¡ possui uma matrÃ­cula ativa no ano corrente." });
      }

      // Se ele jÃ¡ estava na base, apenas atualizamos seus dados e o validamos como ativo
      await pool.query(
        `UPDATE alunos SET estudante = ?, data_nascimento = ?, sexo = ?, turma_id = ?, cpf = ?, atendimento_diferencial = ?, status = 'ativo' WHERE id = ?`,
        [estudante, data_nascimento || null, sexo || null, turma_id || null, cpf || null, atendimento_diferencial ? 1 : 0, alunoId]
      );
    } else {
      // InserÃ§Ã£o inÃ©dita na base global
      const [result] = await pool.query(
        `
        INSERT INTO alunos (codigo, estudante, data_nascimento, sexo, turma_id, cpf, atendimento_diferencial, escola_id, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ativo')
        `,
        [codigo, estudante, data_nascimento || null, sexo || null, turma_id || null, cpf || null, atendimento_diferencial ? 1 : 0, escola_id]
      );
      alunoId = result.insertId;
    }

    // âœ… Cria matrÃ­cula automaticamente ao cadastrar o aluno
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
    const { estudante, data_nascimento, sexo, turma_id, status, cpf, atendimento_diferencial } = req.body;

    const campos = [];
    const valores = [];

    if (typeof estudante !== "undefined") { campos.push("estudante = ?"); valores.push(estudante); }
    if (typeof data_nascimento !== "undefined") { campos.push("data_nascimento = ?"); valores.push(data_nascimento || null); }
    if (typeof sexo !== "undefined") { campos.push("sexo = ?"); valores.push(sexo || null); }
    if (typeof turma_id !== "undefined") { campos.push("turma_id = ?"); valores.push(turma_id || null); }
    if (typeof cpf !== "undefined") { campos.push("cpf = ?"); valores.push(cpf || null); }
    if (typeof atendimento_diferencial !== "undefined") { campos.push("atendimento_diferencial = ?"); valores.push(atendimento_diferencial ? 1 : 0); }
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
    res.json({ message: "Aluno excluÃ­do." });
  } catch (err) {
    console.error("Erro ao excluir aluno:", err);
    res.status(500).json({ message: "Erro ao excluir aluno." });
  }
});

/* ============================================================================
 * 8) BUSCAR POR CÃ“DIGO
 * GET /api/alunos/por-codigo/:codigo
 * - Ãštil para verificar reativaÃ§Ã£o/criaÃ§Ã£o no frontend
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
      return res.status(404).json({ message: "Aluno nÃ£o encontrado." });
    }
    res.json(aluno);
  } catch (err) {
    console.error("Erro ao buscar aluno por cÃ³digo:", err);
    res.status(500).json({ message: "Erro no servidor ao buscar por cÃ³digo." });
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
 * 9) BUSCAR UM ALUNO ESPECÃFICO (por cÃ³digo)
 * GET /api/alunos/:id
 * - Aqui ":id" Ã© o CÃ“DIGO do aluno (mantido conforme uso no frontend)
 * ========================================================================== */
router.get("/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const [[aluno]] = await pool.query(
      `
      SELECT
        a.id,
        a.escola_id,
        a.codigo,
        a.estudante AS estudante,
        DATE_FORMAT(a.data_nascimento, '%Y-%m-%d') AS data_nascimento,
        a.sexo,
        a.cpf,
        a.atendimento_diferencial,
        a.foto,
        a.status,
        t.id AS turma_id,
        t.nome AS turma,
        t.turno,
        t.etapa AS etapa,
        t.regime,
        -- Verifica se algum responsÃ¡vel ativo concedeu consentimento de imagem
        COALESCE(
          (SELECT MAX(CASE WHEN ra.consentimento_imagem = 1 AND ra.ativo = 1 THEN 1 ELSE 0 END)
             FROM responsaveis_alunos ra
            WHERE ra.aluno_id = a.id AND ra.escola_id = a.escola_id),
          0
        ) AS consentimento_imagem
      FROM alunos AS a
      LEFT JOIN turmas AS t ON t.id = a.turma_id
      WHERE a.codigo = ?
      `,
      [id]
    );
    if (!aluno) {
      return res.status(404).json({ message: "Aluno nÃ£o encontrado." });
    }

    // LGPD/Consentimento: sÃ³ expÃµe a foto se o responsÃ¡vel autorizou
    const consentimento_ok = Number(aluno.consentimento_imagem) === 1;
    return res.json({
      ...aluno,
      foto: consentimento_ok ? aluno.foto : null,
      consentimento_imagem: consentimento_ok,
    });
  } catch (err) {
    console.error("Erro ao buscar aluno:", err);
    return res.status(500).json({ message: "Erro no servidor ao buscar aluno." });
  }
});


/* ============================================================================
 * 10) RECEBER FOTO RECORTADA
 * POST /api/alunos/:id/foto
 * - Salva em /uploads/CEF04_PLAN/alunos/<codigo>.jpg
 * - Atualiza coluna 'foto' com o caminho pÃºblico
 * ========================================================================== */
router.post("/:id/foto", upload.single("foto"), async (req, res) => {
  const { id } = req.params; // cÃ³digo do aluno
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
 * 11) IMPORTAR PDF â€” Formato EDUCADF 2025 (novo portal da SEEDF)
 * POST /api/alunos/importar-pdf (arquivo: file)
 *
 * Novo formato: 11 colunas
 *   RE do Estudante | Estudante | Data de Nascimento | CPF | Sexo |
 *   Turma | Turno | SÃ©rie | Contato Emergencial | Nome ResponsÃ¡vel | CPF ResponsÃ¡vel
 *
 * Novidades vs. formato antigo:
 *   - Turma identificada pela coluna "Turma" do PDF (nÃ£o pelo nome do arquivo)
 *   - Novos campos: CPF do aluno, Sexo, SÃ©rie, Telefone do responsÃ¡vel
 *   - Parser com separaÃ§Ã£o por pÃ¡gina (evita colisÃ£o de Y entre pÃ¡ginas)
 *   - Nomes longos que quebram para linha abaixo/acima sÃ£o corretamente montados
 *
 * flags opcionais no body:
 *   semTurma=true â†’ importa sem turma (turma_id=null) quando turma nÃ£o existe
 * ========================================================================== */
const uploadPdf = multer(); // usa buffer
router.post("/importar-pdf", uploadPdf.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: "PDF nÃ£o enviado." });
  }

  try {
    const { escola_id } = req.user;
    const anoLetivoAtual = typeof anoLetivoPadrao === "function" ? anoLetivoPadrao() : String(new Date().getFullYear());
    const semTurma = req.body.semTurma === "true" || req.body.semTurma === true;

    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // FASE 1: ExtraÃ§Ã£o posicional com separaÃ§Ã£o por pÃ¡gina
    // Evita que Y=600 da pÃ¡gina 1 colida com Y=600 da pÃ¡gina 2
    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const allItems = [];
    let pageCounter = 0;

    await pdfParse(req.file.buffer, {
      pagerender: async (pageData) => {
        pageCounter++;
        const pg = pageCounter;
        const tc = await pageData.getTextContent();
        for (const item of tc.items) {
          const txt = (item.str || "").trim();
          if (!txt) continue;
          allItems.push({
            text: txt,
            x: Math.round(item.transform[4]),
            y: Math.round(item.transform[5]),
            page: pg,
          });
        }
        return "";
      },
    });

    // Agrupa por chave "pÃ¡gina-Y" (tolerÃ¢ncia 3px no Y)
    const rowsMap = {};
    for (const it of allItems) {
      const yKey = Math.round(it.y / 3) * 3;
      const key = `${it.page}-${yKey}`;
      if (!rowsMap[key]) rowsMap[key] = [];
      rowsMap[key].push(it);
    }

    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // FASE 2: Detecta cabeÃ§alho por pÃ¡gina
    // O cabeÃ§alho tem "RE do Estudante" (ou "RE") + "Turma" + "CPF"
    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const headerYByPage = {};
    for (const [key, items] of Object.entries(rowsMap)) {
      const [pgStr, yStr] = key.split("-");
      const pg = Number(pgStr);
      const y = Number(yStr);
      const textos = items.map((it) => it.text.toUpperCase());
      const hasRE = textos.some((t) => /^RE(\s|$)/.test(t) || t.startsWith("RE DO"));
      const hasTurma = textos.some((t) => t === "TURMA");
      const hasCPF = textos.some((t) => t === "CPF");
      if (hasRE && hasTurma && hasCPF) {
        if (!(pg in headerYByPage) || y > headerYByPage[pg]) {
          headerYByPage[pg] = y;
        }
      }
    }
    console.log(`[importar-pdf-novo] ${pageCounter} pÃ¡gina(s), cabeÃ§alhos:`, headerYByPage);

    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // FASE 3: Ranges de colunas calibrados nas posiÃ§Ãµes reais dos dados
    // (os dados tÃªm X diferentes dos cabeÃ§alhos pelo zoom de renderizaÃ§Ã£o)
    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const COL_RANGES = {
      re:       { min:  68, max: 130 },   // RE: ~80
      nome:     { min: 130, max: 270 },   // Estudante: ~154-165
      dataNasc: { min: 270, max: 373 },   // Data Nasc: ~279-281
      cpfAluno: { min: 373, max: 487 },   // CPF aluno: ~375-376
      sexo:     { min: 480, max: 590 },   // Sexo: ~487-489
      turma:    { min: 580, max: 690 },   // Turma: ~591
      turno:    { min: 680, max: 800 },   // Turno: ~689
      serie:    { min: 793, max: 865 },   // SÃ©rie: ~802
      contato:  { min: 865, max: 960 },   // Contato Emergencial: ~895
      nomeResp: { min: 960, max: 1090 },  // Nome ResponsÃ¡vel: ~971-984
      cpfResp:  { min: 1090, max: 1300 }, // CPF ResponsÃ¡vel: ~1100-1102
    };

    function getCol(x) {
      for (const [col, range] of Object.entries(COL_RANGES)) {
        if (x >= range.min && x < range.max) return col;
      }
      return null;
    }

    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // FASE 4: Classifica cada linha como "data row" ou "continuation"
    // Ordena por pÃ¡gina asc, depois Y desc (topâ†’bottom dentro de cada pÃ¡gina)
    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const sortedKeys = Object.keys(rowsMap).sort((a, b) => {
      const [pa, ya] = a.split("-").map(Number);
      const [pb, yb] = b.split("-").map(Number);
      if (pa !== pb) return pa - pb;
      return yb - ya; // Y maior = mais alto na pÃ¡gina
    });

    const classifiedRows = [];
    for (const key of sortedKeys) {
      const [pgStr, yStr] = key.split("-");
      const pg = Number(pgStr);
      const yKey = Number(yStr);
      const headerY = headerYByPage[pg];
      // Ignora cabeÃ§alho, tÃ­tulo, rodapÃ© (Y >= headerY ou ausente)
      if (!headerY || yKey >= headerY) continue;

      const lineItems = rowsMap[key].sort((a, b) => a.x - b.x);
      const rowData = {};
      for (const it of lineItems) {
        const col = getCol(it.x);
        if (col) {
          rowData[col] = rowData[col] ? rowData[col] + " " + it.text : it.text;
        }
      }
      const reRaw = (rowData.re || "").replace(/\D/g, "").trim();
      const isDataRow = /^\d{4,7}$/.test(reRaw);
      classifiedRows.push({ key, pg, yKey, rowData, isDataRow });
    }

    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // FASE 5: Merge de continuation rows
    // Nomes longos podem ter fragmentos ACIMA ou ABAIXO do data row.
    // Algoritmo: para cada data row, tudo entre ela e o data row
    // adjacente (anterior/posterior da mesma pÃ¡gina) Ã© continuaÃ§Ã£o.
    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    // Agrupa data rows por pÃ¡gina
    const dataRowsByPage = {};
    for (const row of classifiedRows) {
      if (!row.isDataRow) continue;
      if (!dataRowsByPage[row.pg]) dataRowsByPage[row.pg] = [];
      dataRowsByPage[row.pg].push(row);
    }

    const mergedRows = [];

    for (const pg of Object.keys(dataRowsByPage)) {
      const dRows = dataRowsByPage[pg]; // jÃ¡ ordenados topâ†’bottom (Y desc)
      const allPageRows = classifiedRows.filter((r) => r.pg === Number(pg));

      for (let i = 0; i < dRows.length; i++) {
        const currentRow = dRows[i];
        // Limites do "bloco" deste aluno: entre o data row anterior e o prÃ³ximo
        const upperBound = i > 0 ? dRows[i - 1].yKey : Infinity;
        const lowerBound = i < dRows.length - 1 ? dRows[i + 1].yKey : -Infinity;

        // Coleta continuations dentro dos limites (exclui os data rows)
        const continuations = allPageRows.filter(
          (r) => !r.isDataRow && r.yKey < upperBound && r.yKey > lowerBound
        );

        const merged = { ...currentRow.rowData };
        for (const cont of continuations) {
          for (const [col, text] of Object.entries(cont.rowData)) {
            if (col === "re") continue; // nunca mescla RE
            merged[col] = merged[col] ? merged[col] + " " + text : text;
          }
        }
        mergedRows.push(merged);
      }
    }

    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // FASE 6: Limpeza e normalizaÃ§Ã£o de cada registro
    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const pdfEntries = [];
    let turmaNomePdf = null; // turma identificada pela coluna "Turma" do PDF

    for (const r of mergedRows) {
      const re = (r.re || "").replace(/\D/g, "").trim();
      if (!/^\d{4,7}$/.test(re)) continue;

      // Nome: remove fragmentos de data e nÃºmeros que possam ter vazado
      const estudante = (r.nome || "")
        .replace(/\d{2}\/\d{2}\/\d{4}/g, "")
        .replace(/\s{2,}/g, " ")
        .trim();
      if (!estudante) continue;

      // Data de nascimento (extrai dd/mm/yyyy, ignora lixo)
      const dataMatch = (r.dataNasc || "").match(/(\d{2}\/\d{2}\/\d{4})/);
      const dataBr = dataMatch ? dataMatch[1] : "";

      // CPF do aluno (11 dÃ­gitos)
      const cpfAlunoDigitos = (r.cpfAluno || "").replace(/\D/g, "");
      const cpfAluno = cpfAlunoDigitos.length === 11 ? cpfAlunoDigitos : null;

      // Sexo: armazena como "Masculino"/"Feminino" (varchar(10) no BD)
      const sexoRaw = (r.sexo || "").trim();
      const sexo = /masculino/i.test(sexoRaw) ? "Masculino"
                 : /feminino/i.test(sexoRaw)  ? "Feminino"
                 : null;

      // SÃ©rie
      const serie = (r.serie || "").trim() || null;

      // Turma: captura uma vez (todas as linhas terÃ£o o mesmo valor)
      const turmaRaw = (r.turma || "").trim();
      if (turmaRaw && !turmaNomePdf) {
        // Normaliza "7Âº Ano - A" â†’ "7Âº ANO A"
        turmaNomePdf = turmaRaw
          .toUpperCase()
          .replace(/\s*-\s*/g, " ")
          .replace(/\s+/g, " ")
          .trim();
      }

      // Contato Emergencial = telefone do responsÃ¡vel
      const contatoRaw = (r.contato || "").trim();
      const telefone = contatoRaw && contatoRaw !== "-"
        ? contatoRaw.replace(/\D/g, "").substring(0, 20) || null
        : null;

      // Nome do responsÃ¡vel
      const nomeResp = (r.nomeResp || "").trim() || null;

      // CPF do responsÃ¡vel
      const cpfRespDigitos = (r.cpfResp || "").replace(/\D/g, "");
      const cpfResponsavel = cpfRespDigitos.length === 11 ? cpfRespDigitos : null;

      pdfEntries.push({
        codigo: re,
        estudante,
        dataBr,
        cpfAluno,
        sexo,
        serie,
        telefone,
        responsavel: nomeResp,
        cpfResponsavel,
      });
    }

    console.log(
      `[importar-pdf-novo] ExtraÃ­dos: ${pdfEntries.length} alunos | Turma PDF: "${turmaNomePdf}"`
    );

    if (pdfEntries.length === 0) {
      return res.status(400).json({
        message:
          "Nenhum aluno encontrado no PDF. Verifique se o arquivo estÃ¡ no formato EDUCADF 2025.",
      });
    }

    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // FASE 7: IdentificaÃ§Ã£o da turma no BD via coluna "Turma" do PDF
    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    let turma_id = null;

    if (!semTurma) {
      if (!turmaNomePdf) {
        return res.status(400).json({
          message: "NÃ£o foi possÃ­vel identificar a turma no PDF.",
        });
      }

      // Busca exata (UPPER + TRIM + normaliza " - " â†’ " ")
      const [[turma]] = await pool.query(
        `SELECT id, nome FROM turmas
         WHERE UPPER(TRIM(REPLACE(nome, ' - ', ' '))) = ?
           AND escola_id = ?
           AND ano = ?
         ORDER BY id DESC LIMIT 1`,
        [turmaNomePdf, escola_id, anoLetivoAtual]
      );

      if (!turma) {
        // Retorna estruturado para o frontend exibir modal premium
        return res.status(404).json({
          code: "TURMA_NAO_ENCONTRADA",
          message: `Turma "${turmaNomePdf}" nÃ£o encontrada no sistema para o ano letivo ${anoLetivoAtual}.`,
          turmaNaoEncontrada: turmaNomePdf,
        });
      }

      turma_id = turma.id;
      console.log(`[importar-pdf-novo] Turma encontrada: id=${turma_id} nome="${turma.nome}"`);
    }

    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // FASE 8: SituaÃ§Ã£o atual no BD para a turma (duas fontes)
    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const atuaisIdSet = new Set();
    const atuais = [];

    if (turma_id) {
      const [atuaisMatricula] = await pool.query(
        `SELECT a.id, a.codigo, a.estudante, 'ativo' AS status
         FROM matriculas m
         INNER JOIN alunos a ON a.id = m.aluno_id
         WHERE m.turma_id = ? AND m.ano_letivo = ? AND m.escola_id = ? AND m.status = 'ativo'`,
        [turma_id, anoLetivoAtual, escola_id]
      );
      const [atuaisAlunos] = await pool.query(
        `SELECT a.id, a.codigo, a.estudante, a.status
         FROM alunos a
         WHERE a.turma_id = ? AND a.escola_id = ? AND a.status = 'ativo'`,
        [turma_id, escola_id]
      );
      for (const a of atuaisMatricula) {
        if (!atuaisIdSet.has(a.id)) { atuaisIdSet.add(a.id); atuais.push(a); }
      }
      for (const a of atuaisAlunos) {
        if (!atuaisIdSet.has(a.id)) { atuaisIdSet.add(a.id); atuais.push(a); }
      }
    }

    const normName = (s) =>
      (s || "").toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim();

    const atuaisMap = new Map(atuais.map((a) => [String(a.codigo), a]));
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

      // Fallback: match por nome (cobre migraÃ§Ã£o ieducarâ†’educadf com RE diferente)
      if (!atual) {
        const nomeKey = normName(e.estudante);
        const porNome = atuaisNomeMap.get(nomeKey);
        if (porNome) {
          console.log(
            `[importar-pdf-novo] Match por nome: "${e.estudante}" â€” cÃ³digo ${porNome.codigo} â†’ ${e.codigo}`
          );
          await pool.query(
            "UPDATE alunos SET codigo = ? WHERE id = ? AND escola_id = ?",
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
        // Aluno jÃ¡ existe e estÃ¡ ativo â€” complementa campos NULL
        jaExistiam++;
        const sets = [];
        const params = [];

        const dataValida = e.dataBr && /^\d{2}\/\d{2}\/\d{4}$/.test(e.dataBr);
        if (dataValida) {
          sets.push("data_nascimento = COALESCE(data_nascimento, STR_TO_DATE(?, '%d/%m/%Y'))");
          params.push(e.dataBr);
        }
        if (e.sexo) {
          sets.push("sexo = IF(sexo IS NULL OR sexo = '', ?, sexo)");
          params.push(e.sexo);
        }
        if (e.cpfAluno) {
          sets.push("cpf = IF(cpf IS NULL OR cpf = '', ?, cpf)");
          params.push(e.cpfAluno);
        }
        if (e.serie) {
          sets.push("serie = IF(serie IS NULL OR serie = '', ?, serie)");
          params.push(e.serie);
        }
        if (sets.length > 0) {
          params.push(atual.id, escola_id);
          await pool.query(
            `UPDATE alunos SET ${sets.join(", ")} WHERE id = ? AND escola_id = ?`,
            params
          );
        }

        await upsertResponsavelPdf(pool, e, atual.id, escola_id);
      }
    }

    if (atualizadosCodigo > 0) {
      console.log(`[importar-pdf-novo] ${atualizadosCodigo} cÃ³digo(s) atualizado(s) (ieducarâ†’educadf)`);
    }

    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // FASE 9: Inserir novos alunos
    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    let inseridos = 0;
    for (const e of toInsert) {
      const dataValida = e.dataBr && /^\d{2}\/\d{2}\/\d{4}$/.test(e.dataBr);
      const baseParams = [e.codigo, e.estudante];
      let insertSql;

      if (dataValida) {
        insertSql = `INSERT INTO alunos (codigo, estudante, data_nascimento, sexo, cpf, serie, turma_id, escola_id, status)
          VALUES (?, ?, STR_TO_DATE(?, '%d/%m/%Y'), ?, ?, ?, ?, ?, 'ativo')
          ON DUPLICATE KEY UPDATE
            id = LAST_INSERT_ID(id),
            estudante = VALUES(estudante),
            data_nascimento = COALESCE(data_nascimento, VALUES(data_nascimento)),
            sexo  = IF(sexo  IS NULL OR sexo  = '', VALUES(sexo),  sexo),
            cpf   = IF(cpf   IS NULL OR cpf   = '', VALUES(cpf),   cpf),
            serie = IF(serie IS NULL OR serie = '', VALUES(serie),  serie),
            turma_id = VALUES(turma_id),
            status = 'ativo'`;
        baseParams.push(e.dataBr, e.sexo || null, e.cpfAluno || null, e.serie || null, turma_id, escola_id);
      } else {
        insertSql = `INSERT INTO alunos (codigo, estudante, sexo, cpf, serie, turma_id, escola_id, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'ativo')
          ON DUPLICATE KEY UPDATE
            id = LAST_INSERT_ID(id),
            estudante = VALUES(estudante),
            sexo  = IF(sexo  IS NULL OR sexo  = '', VALUES(sexo),  sexo),
            cpf   = IF(cpf   IS NULL OR cpf   = '', VALUES(cpf),   cpf),
            serie = IF(serie IS NULL OR serie = '', VALUES(serie),  serie),
            turma_id = VALUES(turma_id),
            status = 'ativo'`;
        baseParams.push(e.sexo || null, e.cpfAluno || null, e.serie || null, turma_id, escola_id);
      }

      const [result] = await pool.query(insertSql, baseParams);
      const alunoId = result.insertId;

      if (alunoId && turma_id) {
        const [matr] = await pool.query(
          "SELECT id FROM matriculas WHERE aluno_id = ? AND ano_letivo = ? AND escola_id = ?",
          [alunoId, anoLetivoAtual, escola_id]
        );
        if (matr.length > 0) {
          await pool.query(
            "UPDATE matriculas SET status = 'ativo', turma_id = ? WHERE id = ?",
            [turma_id, matr[0].id]
          );
        } else {
          await pool.query(
            "INSERT INTO matriculas (escola_id, aluno_id, turma_id, ano_letivo, status) VALUES (?, ?, ?, ?, 'ativo')",
            [escola_id, alunoId, turma_id, anoLetivoAtual]
          );
        }
      }

      if (alunoId) await upsertResponsavelPdf(pool, e, alunoId, escola_id);
      inseridos++;
    }

    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // FASE 10: Reativar inativos que voltaram
    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    let reativados = 0;
    for (const e of toReactivate) {
      const atualObj = atuaisMap.get(String(e.codigo));
      const dataValida = e.dataBr && /^\d{2}\/\d{2}\/\d{4}$/.test(e.dataBr);

      const sets = ["status = 'ativo'", "turma_id = ?"];
      const params = [turma_id];

      if (dataValida) {
        sets.push("data_nascimento = COALESCE(data_nascimento, STR_TO_DATE(?, '%d/%m/%Y'))");
        params.push(e.dataBr);
      }
      if (e.sexo) {
        sets.push("sexo = IF(sexo IS NULL OR sexo = '', ?, sexo)");
        params.push(e.sexo);
      }
      if (e.cpfAluno) {
        sets.push("cpf = IF(cpf IS NULL OR cpf = '', ?, cpf)");
        params.push(e.cpfAluno);
      }
      if (e.serie) {
        sets.push("serie = IF(serie IS NULL OR serie = '', ?, serie)");
        params.push(e.serie);
      }
      params.push(e.codigo, escola_id);

      await pool.query(
        `UPDATE alunos SET ${sets.join(", ")} WHERE codigo = ? AND escola_id = ?`,
        params
      );

      const alunoId = atualObj?.id;
      if (alunoId && turma_id) {
        const [matr] = await pool.query(
          "SELECT id FROM matriculas WHERE aluno_id = ? AND ano_letivo = ? AND escola_id = ?",
          [alunoId, anoLetivoAtual, escola_id]
        );
        if (matr.length > 0) {
          await pool.query(
            "UPDATE matriculas SET status = 'ativo', turma_id = ? WHERE id = ?",
            [turma_id, matr[0].id]
          );
        } else {
          await pool.query(
            "INSERT INTO matriculas (escola_id, aluno_id, turma_id, ano_letivo, status) VALUES (?, ?, ?, ?, 'ativo')",
            [escola_id, alunoId, turma_id, anoLetivoAtual]
          );
        }
      }
      if (alunoId) await upsertResponsavelPdf(pool, e, alunoId, escola_id);
      reativados++;
    }

    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // FASE 11: Detectar ausentes (alunos no BD que nÃ£o estÃ£o no PDF)
    // NÃ£o inativa automaticamente â€” retorna para confirmaÃ§Ã£o manual
    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const pendentesInativacao = [];
    for (const atual of atuais) {
      if (atual.status !== "ativo") continue;
      const cod = String(atual.codigo);
      const nomeKey = normName(atual.estudante);
      const noCodigoPdf = entradaSet.has(cod);
      const noNomePdf = pdfEntries.some((e) => normName(e.estudante) === nomeKey);
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
        `[importar-pdf-novo] âš  ${pendentesInativacao.length} aluno(s) ausente(s) â€” pendentes de confirmaÃ§Ã£o`
      );
    }

    console.log(
      `[importar-pdf-novo] localizados:${pdfEntries.length} inseridos:${inseridos} reativados:${reativados} jaExistiam:${jaExistiam} pendentes:${pendentesInativacao.length}`
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

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Helper: Upsert de responsÃ¡vel com telefone (novo campo)
// Regra de proteÃ§Ã£o: nÃ£o sobrescreve nome/telefone jÃ¡ existente no BD
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function upsertResponsavelPdf(pool, e, alunoId, escola_id) {
  if (!e.cpfResponsavel) return; // CPF Ã© chave natural â€” sem ele nÃ£o hÃ¡ upsert seguro
  const nomeResp = (e.responsavel || "").trim();
  try {
    const [respResult] = await pool.query(
      `INSERT INTO responsaveis (nome, cpf, telefone)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE
         id       = LAST_INSERT_ID(id),
         nome     = IF(nome     IS NULL OR nome     = '', VALUES(nome),     nome),
         telefone = IF(telefone IS NULL OR telefone = '', VALUES(telefone), telefone)`,
      [nomeResp || null, e.cpfResponsavel, e.telefone || null]
    );
    const responsavelId = respResult.insertId;
    if (responsavelId && alunoId) {
      const [[vinculo]] = await pool.query(
        "SELECT id FROM responsaveis_alunos WHERE responsavel_id = ? AND aluno_id = ? AND escola_id = ?",
        [responsavelId, alunoId, escola_id]
      );
      if (!vinculo) {
        await pool.query(
          "INSERT INTO responsaveis_alunos (escola_id, responsavel_id, aluno_id, relacionamento, ativo) VALUES (?, ?, ?, 'RESPONSAVEL', 1)",
          [escola_id, responsavelId, alunoId]
        );
      }
    }
  } catch (err) {
    console.warn(`[importar-pdf] Falha ao vincular responsÃ¡vel do aluno ${e.codigo}:`, err.message);
  }
}


/* ============================================================================
 * 11b) IMPORTAR CSV â€” Formato EDUCADF (portal oficial SEEDF)






 * POST /api/alunos/importar-csv (arquivo: file)
 *
 * Colunas esperadas (separador ;):
 *   NÂº | RE do Estudante | NOME | MATRÃCULA | DATA_DE_NASCIMENTO | CPF | SEXO |
 *   CONTATO_EMERGENCIAL | STATUS_MATRÃCULA | INÃCIO DA MATRÃCULA | FIM DA MATRÃCULA |
 *   OUTRAS INFORMAÃ‡Ã•ES | NOME FILIAÃ‡ÃƒO 1 | CPF FILIAÃ‡ÃƒO 1 | NOME FILIAÃ‡ÃƒO 2 |
 *   CPF FILIAÃ‡ÃƒO 2 | NOME RESPONSÃVEL | CPF RESPONSÃVEL | ENDEREÃ‡O | ANEES
 *
 * Turma: extraÃ­da do nome do arquivo (ex: "7Âº ANO A.csv" â†’ "7Âº ANO A")
 *        confirmada pelo tÃ­tulo da linha 0 do CSV
 * SÃ©rie e Turno: jÃ¡ cadastrados pelo secretÃ¡rio â€” nÃ£o sobrescritos
 * ========================================================================== */
router.post("/importar-csv", uploadPdf.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: "CSV nÃ£o enviado." });
  }

  try {
    const { escola_id } = req.user;
    const anoLetivoAtual =
      typeof anoLetivoPadrao === "function"
        ? anoLetivoPadrao()
        : String(new Date().getFullYear());

    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // FASE 1: Decodifica CSV (UTF-8 + BOM aware)
    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const raw = req.file.buffer.toString("utf8").replace(/^\uFEFF/, "");
    const lines = raw.split(/\r?\n/).filter((l) => l.trim());

    if (lines.length < 3) {
      return res.status(400).json({ message: "CSV invÃ¡lido ou vazio." });
    }

    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // FASE 2: IdentificaÃ§Ã£o da turma
    // Prioridade: turma_id explÃ­cito no body (enviado pelo frontend apÃ³s
    // o usuÃ¡rio selecionar o turno no modal de conflito) > lookup por nome.
    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const normTurma = (s) =>
      (s || "")
        .toUpperCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/\s*-\s*/g, " ")
        .replace(/\s+/g, " ")
        .trim();

    let turma;
    const turmaIdExplicito = req.body?.turma_id ? Number(req.body.turma_id) : null;

    if (turmaIdExplicito) {
      // Frontend resolveu o conflito de turno â€” usa o id diretamente
      const [[turmaRow]] = await pool.query(
        "SELECT id, nome, serie, turno FROM turmas WHERE id = ? AND escola_id = ?",
        [turmaIdExplicito, escola_id]
      );
      if (!turmaRow) {
        return res.status(404).json({
          code: "TURMA_NAO_ENCONTRADA",
          message: `Turma id=${turmaIdExplicito} nÃ£o encontrada.`,
        });
      }
      turma = turmaRow;
      console.log(`[importar-csv] Turma via turma_id explÃ­cito: id=${turma.id} nome="${turma.nome}" turno="${turma.turno}"`);
    } else {
      // Lookup por nome do arquivo
      let turmaNome = (req.file.originalname || "")
        .replace(/\.csv$/i, "")
        .replace(/Ã‚Âº/g, "Âº")
        .replace(/Ã‚Âª/g, "Âª")
        .trim();

      // Fonte B: linha 0 do CSV contÃ©m "Lista de alunos da Turma 7Âº Ano - A"
      const linha0 = lines[0].replace(/"/g, "").trim();
      const matchTitulo = linha0.match(/Lista\s+de\s+alunos\s+da\s+Turma\s+(.+?)$/i);
      if (matchTitulo) {
        const turmaTitulo = matchTitulo[1].trim();
        if (!turmaNome) turmaNome = turmaTitulo;
        console.log(`[importar-csv] Turma â€” arquivo: "${turmaNome}" | tÃ­tulo CSV: "${turmaTitulo}"`);
      }

      if (!turmaNome) {
        return res.status(400).json({ message: "NÃ£o foi possÃ­vel identificar a turma pelo nome do arquivo CSV." });
      }

      const turmaNomeNorm = normTurma(turmaNome);
      const [turmasEncontradas] = await pool.query(
        `SELECT id, nome, serie, turno
         FROM turmas
         WHERE UPPER(TRIM(REPLACE(
           REPLACE(
             REPLACE(nome COLLATE utf8mb4_general_ci, 'Ã‚', ''),
             'Âº', 'Âº'
           ), ' - ', ' '
         ))) = ? AND escola_id = ? AND ano = ?
         ORDER BY id DESC`,
        [turmaNomeNorm, escola_id, anoLetivoAtual]
      );

      if (turmasEncontradas.length === 0) {
        return res.status(404).json({
          code: "TURMA_NAO_ENCONTRADA",
          message: `Turma "${turmaNome}" nÃ£o encontrada no sistema para o ano letivo ${anoLetivoAtual}.`,
          turmaNaoEncontrada: turmaNome,
        });
      }

      // Se houver mais de uma (frontend nÃ£o enviou turma_id), usa a primeira
      // (situaÃ§Ã£o improvÃ¡vel pois o frontend detecta e pede seleÃ§Ã£o)
      turma = turmasEncontradas[0];
      console.log(`[importar-csv] Turma por nome: id=${turma.id} nome="${turma.nome}" turno="${turma.turno}"`);
    }

    const turma_id = turma.id;

    // FASE 3: Parse do CSV
    // Linha 0 = tÃ­tulo escola | Linha 1 = cabeÃ§alho | Linhas 2+ = dados
    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    function parseCSVLine(line) {
      const campos = [];
      let campo = "";
      let emAspas = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '"') {
          if (emAspas && line[i + 1] === '"') {
            campo += '"';
            i++;
            continue;
          }
          emAspas = !emAspas;
          continue;
        }
        if (c === ";" && !emAspas) {
          campos.push(campo.trim());
          campo = "";
          continue;
        }
        campo += c;
      }
      campos.push(campo.trim());
      return campos;
    }

    const headerCols = parseCSVLine(lines[1]);
    const idxRE    = headerCols.findIndex((h) => /RE\s*do\s*Estudante/i.test(h));
    const idxNome  = headerCols.findIndex((h) => /^NOME$/i.test(h));
    const idxNasc  = headerCols.findIndex((h) => /DATA.*NASCIMENTO/i.test(h));
    const idxCPF   = headerCols.findIndex((h) => /^CPF$/i.test(h));
    const idxSexo  = headerCols.findIndex((h) => /^SEXO$/i.test(h));
    const idxTel   = headerCols.findIndex((h) => /CONTATO.*EMERGENCIAL/i.test(h));
    const idxStatus = headerCols.findIndex((h) => /STATUS.*MATR/i.test(h));
    const idxResp  = headerCols.findIndex((h) => /NOME\s+RESPONS/i.test(h));
    const idxCPFR  = headerCols.findIndex((h) => /CPF\s+RESPONS/i.test(h));
    const idxEnd   = headerCols.findIndex((h) => /ENDERE/i.test(h));
    const idxAnees = headerCols.findIndex((h) => /ANEES|OUTRAS\s+INFORMA/i.test(h));

    if (idxRE < 0 || idxNome < 0) {
      return res.status(400).json({
        message:
          "CSV fora do formato esperado. Verifique se Ã© o arquivo exportado pelo portal EDUCADF.",
      });
    }

    const pdfEntries = [];
    for (let i = 2; i < lines.length; i++) {
      const campos = parseCSVLine(lines[i]);
      const re = (campos[idxRE] || "").replace(/\D/g, "").trim();
      if (!/^\d{4,7}$/.test(re)) continue;

      const estudante = (campos[idxNome] || "").trim();
      if (!estudante) continue;

      const dataBr = ((campos[idxNasc] || "").match(/(\d{2}\/\d{2}\/\d{4})/) || [])[1] || "";
      const cpfAlunoRaw = (campos[idxCPF] || "").replace(/\D/g, "");
      const cpfAluno = cpfAlunoRaw.length === 11 ? cpfAlunoRaw : null;
      const sexoRaw = (campos[idxSexo] || "").trim();
      const sexo =
        /masculino/i.test(sexoRaw)
          ? "Masculino"
          : /feminino/i.test(sexoRaw)
          ? "Feminino"
          : null;
      const telefone =
        idxTel >= 0
          ? (campos[idxTel] || "").replace(/\D/g, "").substring(0, 20) || null
          : null;
      const nomeResp = idxResp >= 0 ? (campos[idxResp] || "").trim() || null : null;
      const cpfRespRaw = idxCPFR >= 0 ? (campos[idxCPFR] || "").replace(/\D/g, "") : "";
      const cpfResponsavel = cpfRespRaw.length === 11 ? cpfRespRaw : null;
      const endereco = idxEnd >= 0 ? (campos[idxEnd] || "").trim() || null : null;
      const anees = idxAnees >= 0 ? (campos[idxAnees] || "").trim() || null : null;

      pdfEntries.push({
        codigo: re,
        estudante,
        dataBr,
        cpfAluno,
        sexo,
        telefone,
        responsavel: nomeResp,
        cpfResponsavel,
        endereco,
        anees,
      });
    }

    console.log(`[importar-csv] ExtraÃ­dos: ${pdfEntries.length} alunos | Turma: "${turma.nome}"`);

    if (pdfEntries.length === 0) {
      return res.status(400).json({
        message: "Nenhum aluno encontrado no CSV. Verifique se o arquivo estÃ¡ no formato correto.",
      });
    }

    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // FASE 4: SituaÃ§Ã£o atual no BD (duas fontes â€” matrÃ­cula e aluno direto)
    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const [atuaisMatricula] = await pool.query(
      `SELECT a.id, a.codigo, a.estudante, 'ativo' AS status
       FROM matriculas m
       INNER JOIN alunos a ON a.id = m.aluno_id
       WHERE m.turma_id = ? AND m.ano_letivo = ? AND m.escola_id = ? AND m.status = 'ativo'`,
      [turma_id, anoLetivoAtual, escola_id]
    );
    const [atuaisAlunos] = await pool.query(
      `SELECT a.id, a.codigo, a.estudante, a.status
       FROM alunos a
       WHERE a.turma_id = ? AND a.escola_id = ? AND a.status = 'ativo'`,
      [turma_id, escola_id]
    );

    const atuaisIdSet = new Set();
    const atuais = [];
    for (const a of atuaisMatricula) {
      if (!atuaisIdSet.has(a.id)) { atuaisIdSet.add(a.id); atuais.push(a); }
    }
    for (const a of atuaisAlunos) {
      if (!atuaisIdSet.has(a.id)) { atuaisIdSet.add(a.id); atuais.push(a); }
    }

    const normName = (s) =>
      (s || "")
        .toUpperCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/\s+/g, " ")
        .trim();

    const atuaisMap = new Map(atuais.map((a) => [String(a.codigo), a]));
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

      if (!atual) {
        const nomeKey = normName(e.estudante);
        const porNome = atuaisNomeMap.get(nomeKey);
        if (porNome) {
          console.log(
            `[importar-csv] Match por nome: "${e.estudante}" â€” cÃ³digo ${porNome.codigo} â†’ ${e.codigo}`
          );
          await pool.query(
            "UPDATE alunos SET codigo = ? WHERE id = ? AND escola_id = ?",
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
        // Aluno ativo â€” complementa campos NULL sem sobrescrever existentes
        jaExistiam++;
        const sets = [];
        const params = [];
        const dataValida = e.dataBr && /^\d{2}\/\d{2}\/\d{4}$/.test(e.dataBr);
        if (dataValida) {
          sets.push("data_nascimento = COALESCE(data_nascimento, STR_TO_DATE(?, '%d/%m/%Y'))");
          params.push(e.dataBr);
        }
        if (e.sexo) {
          sets.push("sexo = IF(sexo IS NULL OR sexo = '', ?, sexo)");
          params.push(e.sexo);
        }
        if (e.cpfAluno) {
          sets.push("cpf = IF(cpf IS NULL OR cpf = '', ?, cpf)");
          params.push(e.cpfAluno);
        }
        if (e.anees) {
          sets.push("anees = IF(anees IS NULL OR anees = '', ?, anees)");
          params.push(e.anees);
        }
        if (sets.length > 0) {
          params.push(atual.id, escola_id);
          await pool.query(
            `UPDATE alunos SET ${sets.join(", ")} WHERE id = ? AND escola_id = ?`,
            params
          );
        }
        await upsertResponsavelCsv(pool, e, atual.id, escola_id);
      }
    }

    if (atualizadosCodigo > 0) {
      console.log(`[importar-csv] ${atualizadosCodigo} cÃ³digo(s) atualizado(s)`);
    }

    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // FASE 5: Inserir novos alunos
    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    let inseridos = 0;
    for (const e of toInsert) {
      const dataValida = e.dataBr && /^\d{2}\/\d{2}\/\d{4}$/.test(e.dataBr);

      let insertSql, baseParams;
      if (dataValida) {
        insertSql = `INSERT INTO alunos
          (codigo, estudante, data_nascimento, sexo, cpf, anees, turma_id, escola_id, status)
          VALUES (?, ?, STR_TO_DATE(?, '%d/%m/%Y'), ?, ?, ?, ?, ?, 'ativo')
          ON DUPLICATE KEY UPDATE
            id = LAST_INSERT_ID(id),
            estudante = VALUES(estudante),
            data_nascimento = COALESCE(data_nascimento, VALUES(data_nascimento)),
            sexo  = IF(sexo  IS NULL OR sexo  = '', VALUES(sexo),  sexo),
            cpf   = IF(cpf   IS NULL OR cpf   = '', VALUES(cpf),   cpf),
            anees = IF(anees IS NULL OR anees = '', VALUES(anees), anees),
            turma_id = VALUES(turma_id),
            status = 'ativo'`;
        baseParams = [
          e.codigo, e.estudante, e.dataBr,
          e.sexo || null, e.cpfAluno || null, e.anees || null,
          turma_id, escola_id,
        ];
      } else {
        insertSql = `INSERT INTO alunos
          (codigo, estudante, sexo, cpf, anees, turma_id, escola_id, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'ativo')
          ON DUPLICATE KEY UPDATE
            id = LAST_INSERT_ID(id),
            estudante = VALUES(estudante),
            sexo  = IF(sexo  IS NULL OR sexo  = '', VALUES(sexo),  sexo),
            cpf   = IF(cpf   IS NULL OR cpf   = '', VALUES(cpf),   cpf),
            anees = IF(anees IS NULL OR anees = '', VALUES(anees), anees),
            turma_id = VALUES(turma_id),
            status = 'ativo'`;
        baseParams = [
          e.codigo, e.estudante,
          e.sexo || null, e.cpfAluno || null, e.anees || null,
          turma_id, escola_id,
        ];
      }

      const [result] = await pool.query(insertSql, baseParams);
      const alunoId = result.insertId;

      if (alunoId) {
        const [matr] = await pool.query(
          "SELECT id FROM matriculas WHERE aluno_id = ? AND ano_letivo = ? AND escola_id = ?",
          [alunoId, anoLetivoAtual, escola_id]
        );
        if (matr.length > 0) {
          await pool.query(
            "UPDATE matriculas SET status = 'ativo', turma_id = ? WHERE id = ?",
            [turma_id, matr[0].id]
          );
        } else {
          await pool.query(
            "INSERT INTO matriculas (escola_id, aluno_id, turma_id, ano_letivo, status) VALUES (?, ?, ?, ?, 'ativo')",
            [escola_id, alunoId, turma_id, anoLetivoAtual]
          );
        }
        await upsertResponsavelCsv(pool, e, alunoId, escola_id);
      }
      inseridos++;
    }

    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // FASE 6: Reativar inativos
    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    let reativados = 0;
    for (const e of toReactivate) {
      const atualObj = atuaisMap.get(String(e.codigo));
      const dataValida = e.dataBr && /^\d{2}\/\d{2}\/\d{4}$/.test(e.dataBr);

      const sets = ["status = 'ativo'", "turma_id = ?"];
      const params = [turma_id];
      if (dataValida) {
        sets.push("data_nascimento = COALESCE(data_nascimento, STR_TO_DATE(?, '%d/%m/%Y'))");
        params.push(e.dataBr);
      }
      if (e.sexo)    { sets.push("sexo  = IF(sexo  IS NULL OR sexo  = '', ?, sexo)");  params.push(e.sexo); }
      if (e.cpfAluno){ sets.push("cpf   = IF(cpf   IS NULL OR cpf   = '', ?, cpf)");   params.push(e.cpfAluno); }
      if (e.anees)   { sets.push("anees = IF(anees IS NULL OR anees = '', ?, anees)"); params.push(e.anees); }
      params.push(e.codigo, escola_id);

      await pool.query(
        `UPDATE alunos SET ${sets.join(", ")} WHERE codigo = ? AND escola_id = ?`,
        params
      );

      const alunoId = atualObj?.id;
      if (alunoId) {
        const [matr] = await pool.query(
          "SELECT id FROM matriculas WHERE aluno_id = ? AND ano_letivo = ? AND escola_id = ?",
          [alunoId, anoLetivoAtual, escola_id]
        );
        if (matr.length > 0) {
          await pool.query(
            "UPDATE matriculas SET status = 'ativo', turma_id = ? WHERE id = ?",
            [turma_id, matr[0].id]
          );
        } else {
          await pool.query(
            "INSERT INTO matriculas (escola_id, aluno_id, turma_id, ano_letivo, status) VALUES (?, ?, ?, ?, 'ativo')",
            [escola_id, alunoId, turma_id, anoLetivoAtual]
          );
        }
        await upsertResponsavelCsv(pool, e, alunoId, escola_id);
      }
      reativados++;
    }

    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // FASE 7: Detectar ausentes (alunos no BD mas nÃ£o no CSV)
    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const pendentesInativacao = [];
    for (const atual of atuais) {
      if (atual.status !== "ativo") continue;
      const cod = String(atual.codigo);
      const nomeKey = normName(atual.estudante);
      const noCodigoCsv = entradaSet.has(cod);
      const noNomeCsv = pdfEntries.some((e) => normName(e.estudante) === nomeKey);
      if (!noCodigoCsv && !noNomeCsv) {
        pendentesInativacao.push({
          id: atual.id,
          codigo: atual.codigo,
          estudante: atual.estudante,
        });
      }
    }

    if (pendentesInativacao.length > 0) {
      console.log(
        `[importar-csv] âš  ${pendentesInativacao.length} aluno(s) ausente(s) â€” pendentes de confirmaÃ§Ã£o`
      );
    }

    console.log(
      `[importar-csv] localizados:${pdfEntries.length} inseridos:${inseridos} reativados:${reativados} jaExistiam:${jaExistiam} pendentes:${pendentesInativacao.length}`
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
    console.error("Erro ao processar /importar-csv:", err);
    return res.status(500).json({ message: "Erro ao processar CSV.", error: err.message });
  }
});

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Helper: Upsert de responsÃ¡vel com endereÃ§o e telefone (via CSV)
// Regra de proteÃ§Ã£o: nÃ£o sobrescreve dados jÃ¡ preenchidos no BD
// CorreÃ§Ãµes:
//   1. Salva em telefone_celular (campo "Telefone Principal" no modal)
//   2. Ignora telefones fictÃ­cios (ex: 99999999999 â€” todos dÃ­gitos iguais)
//   3. Usa SELECT como fallback quando insertId=0 (ON DUPLICATE KEY)
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function upsertResponsavelCsv(pool, e, alunoId, escola_id) {
  if (!e.cpfResponsavel) return; // CPF Ã© chave natural obrigatÃ³ria
  const nomeResp = (e.responsavel || "").trim();

  // Descarta telefones fictÃ­cios: todos dÃ­gitos iguais (ex: 99999999999, 00000000000)
  // ou com menos de 8 dÃ­gitos apÃ³s limpar nÃ£o-numÃ©ricos
  const telDigits = (e.telefone || "").replace(/\D/g, "");
  const telValido =
    telDigits.length >= 8 && !/^(\d)\1+$/.test(telDigits)
      ? telDigits.substring(0, 20)
      : null;

  try {
    const [respResult] = await pool.query(
      `INSERT INTO responsaveis (nome, cpf, telefone_celular, endereco)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         id               = LAST_INSERT_ID(id),
         nome             = IF(nome             IS NULL OR nome             = '', VALUES(nome),             nome),
         telefone_celular = IF(telefone_celular IS NULL OR telefone_celular = '', VALUES(telefone_celular), telefone_celular),
         endereco         = IF(endereco         IS NULL OR endereco         = '', VALUES(endereco),         endereco)`,
      [nomeResp || null, e.cpfResponsavel, telValido, e.endereco || null]
    );

    // ON DUPLICATE KEY retorna insertId=0 quando o registro jÃ¡ existe.
    // Nesse caso fazemos SELECT para obter o id real.
    let responsavelId = respResult.insertId;
    if (!responsavelId) {
      const [[existing]] = await pool.query(
        "SELECT id FROM responsaveis WHERE cpf = ?",
        [e.cpfResponsavel]
      );
      responsavelId = existing?.id || null;
    }

    if (responsavelId && alunoId) {
      const [[vinculo]] = await pool.query(
        "SELECT id FROM responsaveis_alunos WHERE responsavel_id = ? AND aluno_id = ? AND escola_id = ?",
        [responsavelId, alunoId, escola_id]
      );
      if (!vinculo) {
        await pool.query(
          "INSERT INTO responsaveis_alunos (escola_id, responsavel_id, aluno_id, relacionamento, ativo) VALUES (?, ?, ?, 'RESPONSAVEL', 1)",
          [escola_id, responsavelId, alunoId]
        );
      }
    }
  } catch (err) {
    console.warn(`[importar-csv] Falha ao vincular responsÃ¡vel do aluno ${e.codigo}:`, err.message);
  }
}

/* ============================================================================
 * 11c) INATIVAR EM LOTE (confirmaÃ§Ã£o manual pelo secretÃ¡rio)
 * POST /api/alunos/inativar-lote
 * Body: { alunoIds: [1, 2, 3] }
 *
 * Inativa alunos selecionados pelo secretÃ¡rio apÃ³s importaÃ§Ã£o de PDF.
 * Usado quando o PDF nÃ£o contÃ©m alunos que estÃ£o no banco (transferidos).
 * ========================================================================== */
router.post("/inativar-lote", async (req, res) => {
  try {
    const { escola_id } = req.user;
    const { alunoIds } = req.body || {};

    if (!Array.isArray(alunoIds) || alunoIds.length === 0) {
      return res.status(400).json({ message: "Lista de alunos vazia." });
    }

    // SeguranÃ§a: sÃ³ inativa alunos que pertencem Ã  escola do usuÃ¡rio
    const ids = alunoIds.map(Number).filter(n => n > 0);
    if (ids.length === 0) {
      return res.status(400).json({ message: "IDs invÃ¡lidos." });
    }

    const [result] = await pool.query(
      `UPDATE alunos SET status = 'inativo' WHERE id IN (?) AND escola_id = ? AND status = 'ativo'`,
      [ids, escola_id]
    );

    // Inativa matrÃ­culas correspondentes
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
 * 12) IMPORTAR XLSX (lÃ³gica similar ao PDF; converte datas e processa status)
 * POST /api/alunos/importar-xlsx (arquivo: file)
 * - Nome do arquivo (sem extensÃ£o) = nome da turma
 * ========================================================================== */
const uploadXlsx = multer(); // usa buffer
router.post("/importar-xlsx", uploadXlsx.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: "XLSX nÃ£o enviado." });
  }

  try {
    const { escola_id } = req.user;
    const anoLetivoAtual = typeof anoLetivoPadrao === "function" ? anoLetivoPadrao() : String(new Date().getFullYear());

    const workbook = XLSX.read(req.file.buffer, { type: "buffer" });
    const primeiraAbaNome = workbook.SheetNames[0];
    const sheet = workbook.Sheets[primeiraAbaNome];

    const dados = XLSX.utils.sheet_to_json(sheet, {
      header: ["codigo", "estudante", "data_nascimento", "sexo"],
      range: 1,  // pula cabeÃ§alho (linha 0)
      defval: "",
    });

    let turmaNomeStr = req.body.turmaNome || req.file.originalname.replace(/\.[^.]+$/i, "").trim();
    // Corrige erro de parse do multer (latin1 vs utf-8) que causa 6Ã‚Âº em vez de 6Âº
    const turmaNome = turmaNomeStr.replace(/Ã‚Âº/g, 'Âº').replace(/Ã‚Âª/g, 'Âª');

    const [[turma]] = await pool.query("SELECT id FROM turmas WHERE nome = ? AND escola_id = ?", [turmaNome, escola_id]);
    if (!turma) {
      return res.status(404).json({ message: `Turma "${turmaNome}" nÃ£o encontrada.` });
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
          // heurÃ­stica de dia/mÃªs/ano
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
      "SELECT id, codigo, status, data_nascimento, sexo, estudante FROM alunos WHERE turma_id = ? AND escola_id = ?",
      [turma_id, escola_id]
    );
    const atuaisMap = new Map(atuais.map((a) => [String(a.codigo), a]));
    const entradaSet = new Set(xlsxEntries.map((e) => String(e.codigo)));

    const toInsert = [];
    const toReactivate = [];
    const toUpdate = [];   // ativos com dados faltantes a completar
    let jaExistiam = 0;

    for (const e of xlsxEntries) {
      const cod = String(e.codigo);
      const atual = atuaisMap.get(cod);
      if (!atual) {
        toInsert.push(e);
      } else if (atual.status === "inativo") {
        toReactivate.push({ entry: e, atual });
      } else {
        // Ativo: verifica se hÃ¡ dados faltantes no banco que o XLSX pode preencher
        const precisaAtualizar =
          (e.dataBr && !atual.data_nascimento) ||
          (e.sexo   && !atual.sexo);
        if (precisaAtualizar) {
          toUpdate.push({ entry: e, atual });
        } else {
          jaExistiam++;
        }
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
    for (const { entry: e, atual: atualObj } of toReactivate) {
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

    // Atualizar dados faltantes de alunos ativos
    let atualizados = 0;
    for (const { entry: e, atual } of toUpdate) {
      const sets = [];
      const vals = [];

      if (e.dataBr && !atual.data_nascimento) {
        sets.push("data_nascimento = STR_TO_DATE(?, '%d/%m/%Y')");
        vals.push(e.dataBr);
      }
      if (e.sexo && !atual.sexo) {
        sets.push("sexo = ?");
        vals.push(e.sexo);
      }

      if (sets.length > 0) {
        vals.push(atual.id);
        await pool.query(
          `UPDATE alunos SET ${sets.join(", ")} WHERE id = ?`,
          vals
        );
        atualizados++;
      } else {
        jaExistiam++; // sem dados novos para preencher
      }
    }

    // Inativar nÃ£o listados
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
      `[importar-xlsx] localizados: ${xlsxEntries.length}, inseridos: ${inseridos}, reativados: ${reativados}, atualizados: ${atualizados}, jaExistiam: ${jaExistiam}, inativados: ${inativados}`
    );
    return res.json({ localizados: xlsxEntries.length, inseridos, reativados, atualizados, jaExistiam, inativados });
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
 * 15) OCORRÃŠNCIAS DISCIPLINARES
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
    res.status(500).json({ message: "Erro ao buscar prÃ³ximo registro de ocorrÃªncia." });
  }
});
router.get("/:id/ocorrencias", verificarEscola, async (req, res) => {
  try {
    const { id } = req.params;
    const { escola_id } = req.user;

    // Atualiza bÃ´nus de mÃ©dia bimestral em tempo real antes de retornar ocorrÃªncias
    await calcularEUpsertBonusMedia(id, escola_id);

    // Query principal: inclui atenuantes/agravantes (Art. 34/35)
    // Fallback automÃ¡tico caso a migration ainda nÃ£o tenha sido executada no servidor
    const QUERY_FULL = `
      SELECT o.id,
              LPAD(o.id, 4, '0') AS registro,
              DATE_FORMAT(o.data_ocorrencia, '%d/%m/%Y') AS data_ocorrencia,
              o.motivo,
              r.medida_disciplinar,
              r.tipo_ocorrencia AS tipo,
              r.pontos,
              o.descricao,
              o.registro_interno,
              o.convocar_responsavel,
              DATE_FORMAT(o.data_convocacao, '%d/%m/%Y') AS data_convocacao,
              o.dias_suspensao,
              o.atenuantes,
              o.agravantes,
              DATE_FORMAT(o.data_comparecimento_responsavel, '%d/%m/%Y %H:%i') AS data_comparecimento_responsavel,
              o.status,
              ur.nome  AS nome_usuario_registro,
              uf.nome  AS nome_usuario_finalizacao,
              ui.nome  AS nome_usuario_impressao,
              ue.nome  AS nome_usuario_edicao
       FROM ocorrencias_disciplinares o
       LEFT JOIN usuarios ur ON ur.id = o.usuario_registro_id
       LEFT JOIN usuarios uf ON uf.id = o.usuario_finalizacao_id
       LEFT JOIN usuarios ui ON ui.id = o.usuario_impressao_id
       LEFT JOIN usuarios ue ON ue.id = o.usuario_edicao_id
       LEFT JOIN registros_ocorrencias r
         ON r.descricao_ocorrencia = o.motivo
         AND (o.tipo_ocorrencia IS NULL OR o.tipo_ocorrencia = '' OR r.tipo_ocorrencia = o.tipo_ocorrencia)
       WHERE o.aluno_id = ? AND o.escola_id = ?
       ORDER BY o.data_ocorrencia DESC, o.id DESC`;

    const QUERY_COMPAT = `
      SELECT o.id,
              LPAD(o.id, 4, '0') AS registro,
              DATE_FORMAT(o.data_ocorrencia, '%d/%m/%Y') AS data_ocorrencia,
              o.motivo,
              r.medida_disciplinar,
              r.tipo_ocorrencia AS tipo,
              r.pontos,
              o.descricao,
              o.registro_interno,
              o.convocar_responsavel,
              DATE_FORMAT(o.data_convocacao, '%d/%m/%Y') AS data_convocacao,
              o.dias_suspensao,
              NULL AS atenuantes,
              NULL AS agravantes,
              DATE_FORMAT(o.data_comparecimento_responsavel, '%d/%m/%Y %H:%i') AS data_comparecimento_responsavel,
              o.status,
              ur.nome  AS nome_usuario_registro,
              uf.nome  AS nome_usuario_finalizacao,
              ui.nome  AS nome_usuario_impressao,
              ue.nome  AS nome_usuario_edicao
       FROM ocorrencias_disciplinares o
       LEFT JOIN usuarios ur ON ur.id = o.usuario_registro_id
       LEFT JOIN usuarios uf ON uf.id = o.usuario_finalizacao_id
       LEFT JOIN usuarios ui ON ui.id = o.usuario_impressao_id
       LEFT JOIN usuarios ue ON ue.id = o.usuario_edicao_id
       LEFT JOIN registros_ocorrencias r
         ON r.descricao_ocorrencia = o.motivo
         AND (o.tipo_ocorrencia IS NULL OR o.tipo_ocorrencia = '' OR r.tipo_ocorrencia = o.tipo_ocorrencia)
       WHERE o.aluno_id = ? AND o.escola_id = ?
       ORDER BY o.data_ocorrencia DESC, o.id DESC`;

    let rows;
    try {
      [rows] = await pool.query(QUERY_FULL, [id, escola_id]);
    } catch (queryErr) {
      if (queryErr.code === 'ER_BAD_FIELD_ERROR') {
        // Migration atenuantes/agravantes ainda nÃ£o rodou â€” fallback compatÃ­vel
        console.warn('[disciplinar] Colunas atenuantes/agravantes ausentes â€” usando query de compatibilidade. Execute run_migration_atenuantes_agravantes.js no servidor.');
        [rows] = await pool.query(QUERY_COMPAT, [id, escola_id]);
      } else {
        throw queryErr;
      }
    }

    res.json(rows);
  } catch (err) {
    console.error("Erro ao buscar ocorrÃªncias:", err);
    res.status(500).json({ message: "Erro ao buscar ocorrÃªncias disciplinares." });
  }
});

router.post("/:id/ocorrencias", verificarEscola, async (req, res) => {
  try {
    const { id } = req.params;
    const { escola_id } = req.user;
    const usuarioRegistroId = req.user.usuarioId || req.user.id || req.user.usuario_id;
    const { data, motivo, tipoOcorrencia, descricao, registroInterno, convocarResponsavel, diasSuspensao, atenuantes, agravantes, dataConvocacao } = req.body;

    if (!data || !motivo) {
      return res.status(400).json({ message: "Preencha os campos obrigatÃ³rios." });
    }

    // Serializar atenuantes/agravantes como JSON (Art. 34/35)
    const atenuantesJson = Array.isArray(atenuantes) && atenuantes.length > 0 ? JSON.stringify(atenuantes) : null;
    const agravantesJson = Array.isArray(agravantes) && agravantes.length > 0 ? JSON.stringify(agravantes) : null;
    // Normalizar data de convocaÃ§Ã£o (aceita YYYY-MM-DD ou null/undefined)
    const dataConvocacaoVal = dataConvocacao || null;

    // Fallback: se atenuantes/agravantes ou data_convocacao ainda nÃ£o existirem no BD, insere sem elas
    let result;
    try {
      [result] = await pool.query(
        `INSERT INTO ocorrencias_disciplinares
           (aluno_id, escola_id, data_ocorrencia, motivo, tipo_ocorrencia, descricao, registro_interno,
            convocar_responsavel, data_convocacao, dias_suspensao, atenuantes, agravantes, usuario_registro_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, escola_id, data, motivo, tipoOcorrencia || null, descricao || null,
         registroInterno || null, convocarResponsavel ? 1 : 0, dataConvocacaoVal,
         diasSuspensao || null, atenuantesJson, agravantesJson, usuarioRegistroId]
      );
    } catch (insertErr) {
      if (insertErr.code === 'ER_BAD_FIELD_ERROR') {
        // Colunas ausentes â€” insere sem elas
        [result] = await pool.query(
          `INSERT INTO ocorrencias_disciplinares
             (aluno_id, escola_id, data_ocorrencia, motivo, tipo_ocorrencia, descricao, registro_interno,
              convocar_responsavel, dias_suspensao, usuario_registro_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [id, escola_id, data, motivo, tipoOcorrencia || null, descricao || null,
           registroInterno || null, convocarResponsavel ? 1 : 0, diasSuspensao || null,
           usuarioRegistroId]
        );
      } else {
        throw insertErr;
      }
    }

    res.status(201).json({
      message: "OcorrÃªncia registrada com sucesso.",
      id: result.insertId
    });
  } catch (err) {
    console.error("Erro ao registrar ocorrÃªncia:", err);
    res.status(500).json({ message: "Erro ao registrar ocorrÃªncia." });
  }
});

// â”€â”€â”€ F.O. COLETIVO: Registro em Lote â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// POST /api/alunos/ocorrencias/lote
// Body: { data, motivo, tipoOcorrencia, descricao, registroInterno, diasSuspensao, alunos:[{alunoId, convocarResponsavel}] }
router.post("/ocorrencias/lote", verificarEscola, async (req, res) => {
  try {
    const { escola_id } = req.user;
    const usuarioRegistroId = req.user.usuarioId || req.user.id || req.user.usuario_id;
    const { data, motivo, tipoOcorrencia, descricao, registroInterno, diasSuspensao, alunos } = req.body;

    if (!data || !motivo) {
      return res.status(400).json({ message: "Campos obrigatÃ³rios: data e motivo." });
    }
    if (!Array.isArray(alunos) || alunos.length === 0) {
      return res.status(400).json({ message: "Informe ao menos um aluno no lote." });
    }

    // UUID Ãºnico que vincula todos os registros deste lote
    const { randomUUID } = await import("crypto");
    const loteId = randomUUID();

    let sucesso = 0;
    let falhas  = 0;
    const erros = [];

    // Detectar se atenuantes/agravantes existem (teste Ãºnico antes do loop)
    let colunasExtrasExistem = true;
    try {
      await pool.query(
        `INSERT INTO ocorrencias_disciplinares
           (aluno_id, escola_id, data_ocorrencia, motivo, tipo_ocorrencia, descricao, registro_interno,
            convocar_responsavel, dias_suspensao, usuario_registro_id, lote_id, origem, atenuantes, agravantes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'coletivo', NULL, NULL)
         LIMIT 0`,
        [0, 0, data, motivo, null, null, null, 0, null, usuarioRegistroId, loteId]
      );
    } catch (testErr) {
      if (testErr.code === 'ER_BAD_FIELD_ERROR') colunasExtrasExistem = false;
    }

    for (const item of alunos) {
      const { alunoId, convocarResponsavel } = item;
      if (!alunoId) { falhas++; continue; }
      try {
        if (colunasExtrasExistem) {
          await pool.query(
            `INSERT INTO ocorrencias_disciplinares
               (aluno_id, escola_id, data_ocorrencia, motivo, tipo_ocorrencia, descricao, registro_interno,
                convocar_responsavel, dias_suspensao, usuario_registro_id, lote_id, origem)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'coletivo')`,
            [alunoId, escola_id, data, motivo, tipoOcorrencia || null,
             descricao || null, registroInterno || null,
             convocarResponsavel ? 1 : 0, diasSuspensao || null,
             usuarioRegistroId, loteId]
          );
        } else {
          // Fallback: sem atenuantes/agravantes
          await pool.query(
            `INSERT INTO ocorrencias_disciplinares
               (aluno_id, escola_id, data_ocorrencia, motivo, tipo_ocorrencia, descricao, registro_interno,
                convocar_responsavel, dias_suspensao, usuario_registro_id, lote_id, origem)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'coletivo')`,
            [alunoId, escola_id, data, motivo, tipoOcorrencia || null,
             descricao || null, registroInterno || null,
             convocarResponsavel ? 1 : 0, diasSuspensao || null,
             usuarioRegistroId, loteId]
          );
        }
        sucesso++;
      } catch (innerErr) {
        console.error(`[Lote] Erro aluno ${alunoId}:`, innerErr);
        falhas++;
        erros.push({ alunoId, err: innerErr.message });
      }
    }

    return res.status(201).json({
      message: `${sucesso} registros criados com sucesso.${falhas > 0 ? ` ${falhas} falharam.` : ''}`,
      total: alunos.length,
      sucesso,
      falhas,
      lote_id: loteId,
      erros: erros.length > 0 ? erros : undefined,
    });
} catch (err) {
    console.error("[Lote] Erro geral:", err);
    return res.status(500).json({ message: "Erro ao registrar lote." });
  }
});
// â”€â”€â”€ FIM F.O. COLETIVO â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// â”€â”€â”€ F.O. COLETIVO: Buscar registros por data (impressÃ£o em lote) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// GET /api/alunos/ocorrencias/coletivos?data=YYYY-MM-DD
router.get("/ocorrencias/coletivos", verificarEscola, async (req, res) => {
  try {
    const { escola_id } = req.user;
    const dataParam = req.query.data || (() => {
      const d = new Date(Date.now() - 3 * 60 * 60 * 1000);
      return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    })();

    const [rows] = await pool.query(
      `SELECT
         o.lote_id,
         o.id                                                       AS ocorrencia_id,
         DATE_FORMAT(o.data_ocorrencia, '%d/%m/%Y')                 AS data_ocorrencia,
         o.motivo,
         o.tipo_ocorrencia,
         o.status,
         o.descricao,
         a.id                                                        AS aluno_id,
         a.estudante,
         a.codigo,
         t.nome                                                      AS turma,
         t.turno,
         COALESCE(r.medida_disciplinar, o.tipo_ocorrencia, 'N/D')   AS medida_disciplinar,
         ur.nome                                                     AS registrado_por
       FROM ocorrencias_disciplinares o
       JOIN  alunos a  ON a.id = o.aluno_id AND a.escola_id = o.escola_id
       LEFT JOIN turmas t ON t.id = a.turma_id
       LEFT JOIN registros_ocorrencias r
         ON r.descricao_ocorrencia = o.motivo
       LEFT JOIN usuarios ur ON ur.id = o.usuario_registro_id
       WHERE o.escola_id = ?
         AND o.origem    = 'coletivo'
         AND DATE(o.data_ocorrencia) = ?
         AND o.status   != 'CANCELADA'
       ORDER BY o.lote_id, a.estudante ASC`,
      [escola_id, dataParam]
    );

    // Agrupar por lote_id
    const lotesMap = new Map();
    for (const row of rows) {
      const key = row.lote_id || `_${row.ocorrencia_id}`;
      if (!lotesMap.has(key)) {
        lotesMap.set(key, {
          lote_id:           key,
          data_ocorrencia:   row.data_ocorrencia,
          motivo:            row.motivo,
          tipo_ocorrencia:   row.tipo_ocorrencia,
          medida_disciplinar: row.medida_disciplinar,
          descricao:         row.descricao,
          registrado_por:    row.registrado_por,
          alunos:            [],
        });
      }
      lotesMap.get(key).alunos.push({
        aluno_id:      row.aluno_id,
        ocorrencia_id: row.ocorrencia_id,
        estudante:     row.estudante,
        codigo:        row.codigo,
        turma:         row.turma,
        turno:         row.turno,
        status:        row.status,
      });
    }

    res.json({
      data: dataParam,
      lotes: Array.from(lotesMap.values()),
      total_alunos: rows.length,
    });
  } catch (err) {
    console.error("[Coletivos] Erro:", err);
    res.status(500).json({ message: "Erro ao buscar registros coletivos." });
  }
});
// â”€â”€â”€ FIM COLETIVOS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

router.put("/:id/ocorrencias/:ocorrenciaId", verificarEscola, async (req, res) => {
  try {
    const { id, ocorrenciaId } = req.params;
    const { escola_id } = req.user;
    const usuarioEdicaoId = req.user.usuarioId || req.user.id || req.user.usuario_id;
    const { descricao, registroInterno, convocarResponsavel, atenuantes, agravantes, dataConvocacao } = req.body;

    // Serializar atenuantes/agravantes como JSON (Art. 34/35)
    const atenuantesJson = Array.isArray(atenuantes) && atenuantes.length > 0 ? JSON.stringify(atenuantes) : null;
    const agravantesJson = Array.isArray(agravantes) && agravantes.length > 0 ? JSON.stringify(agravantes) : null;
    const dataConvocacaoVal = dataConvocacao || null;

    try {
      await pool.query(
        `UPDATE ocorrencias_disciplinares
         SET descricao = ?, registro_interno = ?, convocar_responsavel = ?,
             data_convocacao = ?, atenuantes = ?, agravantes = ?, usuario_edicao_id = ?
         WHERE id = ? AND aluno_id = ? AND escola_id = ?`,
        [descricao, registroInterno || null, convocarResponsavel ? 1 : 0,
         dataConvocacaoVal, atenuantesJson, agravantesJson, usuarioEdicaoId, ocorrenciaId, id, escola_id]
      );
    } catch (updErr) {
      if (updErr.code === 'ER_BAD_FIELD_ERROR') {
        // Fallback sem data_convocacao/atenuantes/agravantes
        await pool.query(
          `UPDATE ocorrencias_disciplinares
           SET descricao = ?, registro_interno = ?, convocar_responsavel = ?, usuario_edicao_id = ?
           WHERE id = ? AND aluno_id = ? AND escola_id = ?`,
          [descricao, registroInterno || null, convocarResponsavel ? 1 : 0,
           usuarioEdicaoId, ocorrenciaId, id, escola_id]
        );
      } else {
        throw updErr;
      }
    }

    res.json({ message: "OcorrÃªncia atualizada com sucesso." });
  } catch (err) {
    console.error("Erro ao atualizar ocorrÃªncia:", err);
    res.status(500).json({ message: "Erro ao atualizar ocorrÃªncia." });
  }
});

router.put("/:id/ocorrencias/:ocorrenciaId/comparecimento", verificarEscola, async (req, res) => {
  try {
    const { id, ocorrenciaId } = req.params;
    const { escola_id } = req.user;
    const usuarioFinalizacaoId = req.user.usuarioId || req.user.id || req.user.usuario_id;
    const modo = req.body?.modo || 'presenca'; // 'presenca' | 'telefone' | 'nao_compareceu'

    // Texto de rastreabilidade para registro interno
    const agora = new Date(Date.now() - 3 * 60 * 60 * 1000); // UTC-3
    const dataStr = agora.toLocaleDateString('pt-BR') + ' ' + agora.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

    let registroFinal = '';
    if (modo === 'telefone') {
      registroFinal = `[FINALIZAÃ‡ÃƒO] Contato realizado via telefone em ${dataStr}.`;
    } else if (modo === 'nao_compareceu') {
      registroFinal = `[FINALIZAÃ‡ÃƒO] ResponsÃ¡vel convocado e nÃ£o compareceu. Registro finalizado em ${dataStr}.`;
    } else if (modo === 'nao_convocado') {
      registroFinal = `[FINALIZAÃ‡ÃƒO] ResponsÃ¡vel tomou conhecimento do registro disciplinar atravÃ©s do aplicativo. Registro finalizado em ${dataStr}.`;
    }
    // modo = 'presenca' â†’ data_comparecimento_responsavel jÃ¡ registra


    // Se modo = 'presenca' â†’ grava data de comparecimento (quando hÃ¡ convocaÃ§Ã£o)
    // Se modo = 'telefone' ou 'nao_compareceu' â†’ NÃƒO grava data de comparecimento
    const setComparecimento = modo === 'presenca'
      ? `data_comparecimento_responsavel = CASE WHEN convocar_responsavel = 1 THEN DATE_SUB(NOW(), INTERVAL 3 HOUR) ELSE data_comparecimento_responsavel END,`
      : '';

    // Append ao registro_interno existente (nÃ£o sobrescreve)
    const setRegistroInterno = registroFinal
      ? `registro_interno = CASE 
           WHEN registro_interno IS NULL OR registro_interno = '' THEN ?
           ELSE CONCAT(registro_interno, '\\n', ?)
         END,`
      : '';

    const params = [];
    if (registroFinal) {
      params.push(registroFinal, registroFinal);
    }
    params.push(usuarioFinalizacaoId, ocorrenciaId, id, escola_id);

    const [result] = await pool.query(
      `UPDATE ocorrencias_disciplinares 
       SET ${setComparecimento}
           ${setRegistroInterno}
           status = 'FINALIZADA',
           usuario_finalizacao_id = ?
       WHERE id = ? AND aluno_id = ? AND escola_id = ?`,
      params
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "OcorrÃªncia nÃ£o encontrada." });
    }

    res.json({ message: "OcorrÃªncia finalizada com sucesso.", modo });
  } catch (err) {
    console.error("Erro ao finalizar ocorrÃªncia:", err);
    res.status(500).json({ message: "Erro ao finalizar ocorrÃªncia." });
  }
});

// ============================================================================
// PUT /api/alunos/:id/ocorrencias/:ocorrenciaId/cancelamento
// Cancela uma medida disciplinar â€” reverte a pontuaÃ§Ã£o do aluno
// Registra o usuÃ¡rio que realizou o cancelamento
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
      return res.status(404).json({ message: "OcorrÃªncia nÃ£o encontrada ou jÃ¡ cancelada." });
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
      return res.status(404).json({ message: "OcorrÃªncia nÃ£o encontrada ou nÃ£o pode ser excluÃ­da." });
    }

    res.json({ message: "OcorrÃªncia excluÃ­da com sucesso." });
  } catch (err) {
    console.error("Erro ao excluir ocorrÃªncia:", err);
    res.status(500).json({ message: "Erro ao excluir ocorrÃªncia." });
  }
});

/* ============================================================================
 * 16) OCORRÃŠNCIAS PEDAGÃ“GICAS
 * CRUD completo â€” mesma lÃ³gica de status das disciplinares (sem pontuaÃ§Ã£o)
 * ========================================================================== */

// GET â€” listar ocorrÃªncias pedagÃ³gicas de um aluno
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
              o.usuario_registro_id,
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
    console.error("Erro ao buscar ocorrÃªncias pedagÃ³gicas:", err);
    res.status(500).json({ message: "Erro ao buscar ocorrÃªncias pedagÃ³gicas." });
  }
});

// GET â€” prÃ³ximo registro (auto-increment)
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
    console.error("Erro ao buscar prÃ³ximo registro pedagÃ³gico:", err);
    res.status(500).json({ message: "Erro ao buscar prÃ³ximo registro." });
  }
});

// POST â€” criar nova ocorrÃªncia pedagÃ³gica
router.post("/:id/ocorrencias-pedagogicas", verificarEscola, async (req, res) => {
  try {
    const { id } = req.params;
    const { escola_id } = req.user;
    const usuarioId = req.user.usuarioId || req.user.id || req.user.usuario_id;
    const { data, categoria, motivo, descricao, registroInterno, convocarResponsavel } = req.body;

    if (!data || !motivo || !categoria) {
      return res.status(400).json({ message: "Preencha os campos obrigatÃ³rios (data, categoria, motivo)." });
    }

    const [result] = await pool.query(
      `INSERT INTO ocorrencias_pedagogicas
         (aluno_id, escola_id, data_ocorrencia, categoria, motivo, descricao, registro_interno, convocar_responsavel, usuario_registro_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, escola_id, data, categoria, motivo, descricao || null, registroInterno || null, convocarResponsavel ? 1 : 0, usuarioId]
    );

    res.status(201).json({
      message: "Registro pedagÃ³gico criado com sucesso.",
      id: result.insertId,
    });
  } catch (err) {
    console.error("Erro ao registrar ocorrÃªncia pedagÃ³gica:", err);
    res.status(500).json({ message: "Erro ao registrar ocorrÃªncia pedagÃ³gica." });
  }
});

// PUT — editar ocorrência pedagógica (apenas pelo autor do registro)
router.put("/:id/ocorrencias-pedagogicas/:ocorrenciaId", verificarEscola, async (req, res) => {
  try {
    const { id, ocorrenciaId } = req.params;
    const { escola_id } = req.user;
    const usuarioId = req.user.usuarioId || req.user.id || req.user.usuario_id;
    const { descricao, registroInterno, convocarResponsavel } = req.body;

    // Valida autoria: apenas quem criou pode editar
    const [[registro]] = await pool.query(
      'SELECT usuario_registro_id FROM ocorrencias_pedagogicas WHERE id = ? AND aluno_id = ? AND escola_id = ?',
      [ocorrenciaId, id, escola_id]
    );
    if (!registro) {
      return res.status(404).json({ message: 'Registro não encontrado.' });
    }
    if (registro.usuario_registro_id && registro.usuario_registro_id !== usuarioId) {
      return res.status(403).json({ message: 'Sem permissão: você não é o autor deste registro.' });
    }

    await pool.query(
      `UPDATE ocorrencias_pedagogicas
       SET descricao = ?, registro_interno = ?, convocar_responsavel = ?
       WHERE id = ? AND aluno_id = ? AND escola_id = ?`,
      [descricao, registroInterno || null, convocarResponsavel ? 1 : 0, ocorrenciaId, id, escola_id]
    );

    res.json({ message: 'Registro pedagógico atualizado.' });
  } catch (err) {
    console.error('Erro ao atualizar ocorrência pedagógica:', err);
    res.status(500).json({ message: 'Erro ao atualizar registro pedagógico.' });
  }
});

// PUT â€” finalizar ocorrÃªncia pedagÃ³gica
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
      return res.status(404).json({ message: "Registro pedagÃ³gico nÃ£o encontrado." });
    }

    res.json({ message: "Registro pedagÃ³gico finalizado." });
  } catch (err) {
    console.error("Erro ao finalizar registro pedagÃ³gico:", err);
    res.status(500).json({ message: "Erro ao finalizar registro pedagÃ³gico." });
  }
});

// PUT â€” cancelar ocorrÃªncia pedagÃ³gica
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
      return res.status(404).json({ message: "Registro nÃ£o encontrado ou jÃ¡ cancelado." });
    }

    res.json({ message: "Registro pedagÃ³gico cancelado." });
  } catch (err) {
    console.error("Erro ao cancelar registro pedagÃ³gico:", err);
    res.status(500).json({ message: "Erro ao cancelar registro pedagÃ³gico." });
  }
});

// DELETE — excluir ocorrência pedagógica (apenas REGISTRADA e pelo autor)
router.delete("/:id/ocorrencias-pedagogicas/:ocorrenciaId", verificarEscola, async (req, res) => {
  try {
    const { id, ocorrenciaId } = req.params;
    const { escola_id } = req.user;
    const usuarioId = req.user.usuarioId || req.user.id || req.user.usuario_id;

    // Valida autoria antes de excluir
    const [[registro]] = await pool.query(
      'SELECT usuario_registro_id, status FROM ocorrencias_pedagogicas WHERE id = ? AND aluno_id = ? AND escola_id = ?',
      [ocorrenciaId, id, escola_id]
    );
    if (!registro) {
      return res.status(404).json({ message: 'Registro não encontrado.' });
    }
    if (registro.usuario_registro_id && registro.usuario_registro_id !== usuarioId) {
      return res.status(403).json({ message: 'Sem permissão: você não é o autor deste registro.' });
    }

    const [result] = await pool.query(
      `DELETE FROM ocorrencias_pedagogicas
       WHERE id = ? AND aluno_id = ? AND escola_id = ? AND status = 'REGISTRADA'`,
      [ocorrenciaId, id, escola_id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Registro não encontrado ou não pode ser excluído.' });
    }

    res.json({ message: 'Registro pedagógico excluído.' });
  } catch (err) {
    console.error('Erro ao excluir registro pedagógico:', err);
    res.status(500).json({ message: 'Erro ao excluir registro pedagógico.' });
  }
});

export default router;
