// routes/professores.js
// ============================================================================
// Rotas de Professores
// - Lista, busca por ID, cria, atualiza, inativa, exclui e importa.
// - Revisão: campo "turno" agora pertence à tabela "professores".
//   • POST: exige cpf, nome, disciplina_id e turno (turma_id opcional).
//   • PUT : na edição, exige SOMENTE turno, disciplina_id e aulas.
// ============================================================================

import express from "express";
import pool from "../db.js";
import fs from "fs";
import path from "path";
import multer from "multer";
import { dirname as _dirname } from "path";
import { fileURLToPath } from "url";
import pdfParse from "pdf-parse/lib/pdf-parse.js";
import XLSX from "xlsx";

const __filename = fileURLToPath(import.meta.url);
const __dirname = _dirname(__filename);

const router = express.Router();

// ────────────────────────────────────────────────
// Middleware: verificar se usuário possui escola_id
// ────────────────────────────────────────────────
function verificarEscola(req, res, next) {
  if (!req.user || !req.user.escola_id) {
    return res.status(403).json({ error: "Acesso negado: escola não definida." });
  }
  next();
}

// ────────────────────────────────────────────────
// Configuração de upload de foto
// ────────────────────────────────────────────────
const profUploadDir = path.resolve(__dirname, "../uploads/professores");
if (!fs.existsSync(profUploadDir)) {
  fs.mkdirSync(profUploadDir, { recursive: true });
}
const profStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, profUploadDir),
  filename: (req, file, cb) => cb(null, `${req.params.id}.jpg`),
});
const profFileFilter = (_req, file, cb) => {
  const permitidos = ["image/jpeg", "image/png"];
  cb(null, permitidos.includes(file.mimetype));
};
const profUpload = multer({ storage: profStorage, fileFilter: profFileFilter });

// ────────────────────────────────────────────────
// GET: Listar professores (com disciplina, turma e escola)
// - Retorna p.turno (campo da própria tabela)
// ────────────────────────────────────────────────
router.get("/", verificarEscola, async (req, res) => {
  const { escola_id } = req.user;
  try {
    const [rows] = await pool.query(
      `
      SELECT
        p.id,
        p.cpf,
        p.nome,
        p.data_nascimento,
        p.sexo,
        p.aulas,
        p.status,
        p.disciplina_id,
        p.turno,                       -- ← agora vem de "professores"
        d.nome AS disciplina_nome,
        t.nome AS turma_nome,
        e.nome AS nome_escola
      FROM professores p
      LEFT JOIN disciplinas d ON p.disciplina_id = d.id
      LEFT JOIN turmas t      ON p.turma_id     = t.id
      LEFT JOIN escolas e     ON p.escola_id    = e.id
      WHERE p.escola_id = ?
      ORDER BY p.nome
      `,
      [escola_id]
    );
    res.json(rows);
  } catch (err) {
    console.error("Erro ao listar professores:", err);
    res.status(500).json({ message: "Erro ao listar professores." });
  }
});

// ────────────────────────────────────────────────
// GET: Buscar professor por ID
// - Retorna p.turno (campo da própria tabela)
// ────────────────────────────────────────────────
router.get("/:id", verificarEscola, async (req, res) => {
  const { id } = req.params;
  const { escola_id } = req.user;
  try {
    const [rows] = await pool.query(
      `
      SELECT
        p.*,
        d.nome AS disciplina_nome,
        t.nome AS turma_nome,
        e.nome AS nome_escola
      FROM professores p
      LEFT JOIN disciplinas d ON p.disciplina_id = d.id
      LEFT JOIN turmas t      ON p.turma_id     = t.id
      LEFT JOIN escolas e     ON p.escola_id    = e.id
      WHERE p.id = ? AND p.escola_id = ?
      `,
      [id, escola_id]
    );
    if (!rows.length) return res.status(404).json({ message: "Professor não encontrado." });
    res.json(rows[0]);
  } catch (err) {
    console.error("Erro ao buscar professor:", err);
    res.status(500).json({ message: "Erro ao buscar professor." });
  }
});

// ────────────────────────────────────────────────
/*
POST: Criar professor
- Unicidade lógica esperada (na camada de dados) permanece a mesma.
- Agora exige: cpf, nome, disciplina_id e turno.
- turma_id permanece OPCIONAL para compatibilidade; caso enviado, será gravado.
*/
// ────────────────────────────────────────────────
router.post("/", verificarEscola, async (req, res) => {
  try {
    const {
      cpf,
      nome,
      data_nascimento,
      sexo,
      disciplina_id,
      turma_id = null, // opcional
      aulas = 0,
      turno,           // ← obrigatório
    } = req.body;
    const { escola_id } = req.user;

    if (!cpf || !nome || !disciplina_id || !turno) {
      return res.status(400).json({ message: "CPF, nome, disciplina e turno são obrigatórios." });
    }
    if (aulas < 0 || aulas > 40) {
      return res.status(400).json({ message: "Número de aulas deve estar entre 0 e 40." });
    }

    await pool.query(
      `
      INSERT INTO professores
        (cpf, nome, data_nascimento, sexo, disciplina_id, turma_id, aulas, turno, escola_id, status)
      VALUES
        (?,   UPPER(?), ?,               ?,   ?,             ?,        ?,     ?,     ?,         'ativo')
      `,
      [cpf, nome, data_nascimento || null, sexo || null, disciplina_id, turma_id, aulas, turno, escola_id]
    );

    await pool.query(
      `INSERT INTO usuarios (cpf, nome, perfil, escola_id)
         VALUES (?, UPPER(?), 'professor', ?)
         ON DUPLICATE KEY UPDATE nome=VALUES(nome)`,
      [cpf, nome, escola_id]
    );

    res.status(201).json({ message: "Professor cadastrado com sucesso." });
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") {
      return res
        .status(409)
        .json({ message: "Já existe este professor cadastrado para a mesma disciplina." });
    }
    console.error("Erro ao cadastrar professor:", err);
    res.status(500).json({ message: "Erro ao cadastrar professor." });
  }
});

// ────────────────────────────────────────────────
/*
PUT: Atualizar professor
- Na edição (fluxo da tabela), EXIGE e atualiza APENAS:
  • turno, disciplina_id e aulas
- CPF, nome, data_nascimento e sexo NÃO são exigidos nem atualizados aqui.
*/
// ────────────────────────────────────────────────
router.put("/:id", verificarEscola, async (req, res) => {
  try {
    const { id } = req.params;
    const { disciplina_id, aulas, turno } = req.body;
    const { escola_id } = req.user;

    if (!turno || !disciplina_id || aulas == null) {
      return res
        .status(400)
        .json({ message: "Turno, disciplina e aulas são obrigatórios na edição." });
    }
    if (aulas < 0 || aulas > 40) {
      return res.status(400).json({ message: "Número de aulas deve estar entre 0 e 40." });
    }

    const [result] = await pool.query(
      `
      UPDATE professores
         SET disciplina_id = ?, aulas = ?, turno = ?
       WHERE id = ? AND escola_id = ?
      `,
      [disciplina_id, aulas, turno, id, escola_id]
    );

    if (!result.affectedRows) {
      return res.status(404).json({ message: "Professor não encontrado." });
    }

    // Nenhuma atualização em "usuarios" necessária na edição (nome/CPF não mudam)
    res.json({ message: "Professor atualizado com sucesso." });
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") {
      return res
        .status(409)
        .json({ message: "Já existe este professor cadastrado para a mesma disciplina." });
    }
    console.error("Erro ao atualizar professor:", err);
    res.status(500).json({ message: "Erro ao atualizar professor." });
  }
});

// ────────────────────────────────────────────────
// PUT: Inativar professor
// ────────────────────────────────────────────────
router.put("/inativar/:id", async (req, res) => {
  try {
    const [result] = await pool.query(
      "UPDATE professores SET status = 'inativo' WHERE id = ?",
      [req.params.id]
    );
    if (!result.affectedRows) {
      return res.status(404).json({ message: "Professor não encontrado." });
    }
    res.json({ message: "Professor inativado com sucesso." });
  } catch (err) {
    console.error("Erro ao inativar professor:", err);
    res.status(500).json({ message: "Erro ao inativar professor." });
  }
});

// ────────────────────────────────────────────────
// DELETE: Excluir professor
// ────────────────────────────────────────────────
router.delete("/:id", verificarEscola, async (req, res) => {
  try {
    const { id } = req.params;
    const { escola_id } = req.user;

    const [[prof]] = await pool.query(
      "SELECT cpf FROM professores WHERE id = ? AND escola_id = ?",
      [id, escola_id]
    );
    if (!prof) return res.status(404).json({ message: "Professor não encontrado." });

    await pool.query("DELETE FROM professores WHERE id = ? AND escola_id = ?", [
      id,
      escola_id,
    ]);
    await pool.query(
      "DELETE FROM usuarios WHERE cpf = ? AND perfil = 'professor' AND escola_id = ?",
      [prof.cpf, escola_id]
    );

    res.json({ message: "Professor excluído com sucesso." });
  } catch (err) {
    console.error("Erro ao excluir professor:", err);
    res.status(500).json({ message: "Erro ao excluir professor." });
  }
});

// ────────────────────────────────────────────────
// POST: Upload de foto do professor
// ────────────────────────────────────────────────
router.post("/:id/foto", profUpload.single("foto"), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: "Nenhuma foto enviada." });
  try {
    const fotoPath = `/uploads/professores/${req.file.filename}`;
    await pool.query("UPDATE professores SET foto = ? WHERE id = ?", [
      fotoPath,
      req.params.id,
    ]);
    res.json({ foto: fotoPath });
  } catch (err) {
    console.error("Erro ao atualizar foto:", err);
    res.status(500).json({ message: "Erro ao atualizar foto do professor." });
  }
});

// ────────────────────────────────────────────────
// POST: Importar professores via PDF (com sincronização)
// (mantido — não altera TURNO)
// ────────────────────────────────────────────────
const uploadPdf = multer();
router.post("/importar-pdf", uploadPdf.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: "PDF não enviado." });

  try {
    const { text } = await pdfParse(req.file.buffer);
    const linhas = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);

    const profs = [];
    for (let i = 0; i < linhas.length; i++) {
      const m = linhas[i].match(
        /^(\d{4,}\.\d{3,}-[\dxX])\s+([A-ZÁÉÍÓÚÂÊÔÃÕÇ\s.]+)\s+([A-Z\s.]+)$/i
      );
      if (m) {
        profs.push({
          cpf: m[1].replace(/[^\dX]/gi, ""),
          nome: m[2].trim(),
          cargo: m[3].trim(),
        });
      }
    }

    const setCpfs = new Set(profs.map((p) => p.cpf));
    const [dbRowsAll] = await pool.query("SELECT id, cpf, status FROM professores");

    const dbActive = dbRowsAll.filter((r) => r.status === "ativo");
    const dbInactive = dbRowsAll.filter((r) => r.status !== "ativo");
    const setAllCpfs = new Set(dbRowsAll.map((r) => String(r.cpf)));
    const setActiveCpfs = new Set(dbActive.map((r) => String(r.cpf)));

    const jaExistiam = profs.filter((e) => setActiveCpfs.has(e.cpf)).length;
    const toInsert = profs.filter((e) => !setAllCpfs.has(e.cpf));
    const toReactivate = profs.filter((e) =>
      dbInactive.some((r) => String(r.cpf) === e.cpf)
    );
    const toInactivate = dbActive.filter((r) => !setCpfs.has(String(r.cpf)));

    // Insere novos
    let inseridos = 0;
    for (const e of toInsert) {
      await pool.query(
        "INSERT INTO professores (cpf, nome, cargo, status) VALUES (?, UPPER(?), ?, 'ativo')",
        [e.cpf, e.nome, e.cargo]
      );
      await pool.query(
        `INSERT INTO usuarios (cpf, nome, perfil) VALUES (?, UPPER(?), 'professor')
           ON DUPLICATE KEY UPDATE nome=VALUES(nome)`,
        [e.cpf, e.nome]
      );
      inseridos++;
    }

    // Reativa inativos
    let reativados = 0;
    for (const e of toReactivate) {
      await pool.query(
        "UPDATE professores SET status='ativo', nome=UPPER(?), cargo=? WHERE cpf=?",
        [e.nome, e.cargo, e.cpf]
      );
      await pool.query(
        `INSERT INTO usuarios (cpf, nome, perfil) VALUES (?, UPPER(?), 'professor')
           ON DUPLICATE KEY UPDATE nome=VALUES(nome)`,
        [e.cpf, e.nome]
      );
      reativados++;
    }

    // Inativa ausentes
    let inativados = 0;
    for (const r of toInactivate) {
      await pool.query("UPDATE professores SET status='inativo' WHERE id=?", [r.id]);
      inativados++;
    }

    res.json({
      localizados: profs.length,
      inseridos,
      jaExistiam,
      reativados,
      inativados,
      listaProfessores: profs,
    });
  } catch (err) {
    console.error("Erro ao importar PDF de professores:", err);
    res.status(500).json({ message: "Erro ao processar PDF.", error: err.message });
  }
});

// ────────────────────────────────────────────────
// POST: Importar professores via XLSX (com sincronização)
// (mantido — não altera TURNO)
// ────────────────────────────────────────────────
const uploadXlsx = multer();
router.post("/importar-xlsx", uploadXlsx.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: "XLSX não enviado." });

  try {
    const workbook = XLSX.read(req.file.buffer, { type: "buffer" });
    const primeiraAbaNome = workbook.SheetNames[0];
    const sheet = workbook.Sheets[primeiraAbaNome];
    const dados = XLSX.utils.sheet_to_json(sheet, { defval: "" });

    const profs = [];
    for (const linha of dados) {
      let cargo = (linha.cargo || linha.Cargo || "").toString().trim().toUpperCase();
      if (!cargo.startsWith("PROFESSOR")) continue;

      let cpf = (linha.cpf || linha.CPF || "").toString().replace(/[^\dxX]/gi, "");
      let nome = (linha.nome || linha.Nome || "").trim();
      if (!cpf || !nome) continue;

      profs.push({ cpf, nome });
    }

    const setCpfs = new Set(profs.map((p) => p.cpf));
    const [dbRowsAll] = await pool.query("SELECT id, cpf, status FROM professores");

    const dbActive = dbRowsAll.filter((r) => r.status === "ativo");
    const dbInactive = dbRowsAll.filter((r) => r.status !== "ativo");
    const setAllCpfs = new Set(dbRowsAll.map((r) => String(r.cpf)));
    const setActiveCpfs = new Set(dbActive.map((r) => String(r.cpf)));

    const jaExistiam = profs.filter((e) => setActiveCpfs.has(e.cpf)).length;
    const toInsert = profs.filter((e) => !setAllCpfs.has(e.cpf));
    const toReactivate = profs.filter((e) =>
      dbInactive.some((r) => String(r.cpf) === e.cpf)
    );
    const toInactivate = dbActive.filter((r) => !setCpfs.has(String(r.cpf)));

    // Inserir novos
    let inseridos = 0;
    for (const e of toInsert) {
      await pool.query(
        "INSERT INTO professores (cpf, nome, disciplina_id, status) VALUES (?, UPPER(?), ?, 'ativo')",
        [e.cpf, e.nome, null]
      );
      await pool.query(
        `INSERT INTO usuarios (cpf, nome, perfil) VALUES (?, UPPER(?), 'professor')
           ON DUPLICATE KEY UPDATE nome=VALUES(nome)`,
        [e.cpf, e.nome]
      );
      inseridos++;
    }

    // Reativar inativos
    let reativados = 0;
    for (const e of toReactivate) {
      await pool.query(
        "UPDATE professores SET status='ativo', nome=UPPER(?) WHERE cpf=?",
        [e.nome, e.cpf]
      );
      await pool.query(
        `INSERT INTO usuarios (cpf, nome, perfil) VALUES (?, UPPER(?), 'professor')
           ON DUPLICATE KEY UPDATE nome=VALUES(nome)`,
        [e.cpf, e.nome]
      );
      reativados++;
    }

    // Inativar ausentes
    let inativados = 0;
    for (const r of toInactivate) {
      await pool.query("UPDATE professores SET status='inativo' WHERE id=?", [r.id]);
      inativados++;
    }

    res.json({
      localizados: profs.length,
      inseridos,
      jaExistiam,
      reativados,
      inativados,
      listaProfessores: profs,
    });
  } catch (err) {
    console.error("Erro ao importar XLSX de professores:", err);
    res.status(500).json({ message: "Erro ao processar XLSX.", error: err.message });
  }
});

export default router;
