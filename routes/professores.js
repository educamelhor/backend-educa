// routes/professores.js

import express from "express";
import pool from "../db.js";
import fs from "fs";
import path from "path";
import multer from "multer";
import { dirname as _dirname } from "path";
import { fileURLToPath } from "url";


const __filename = fileURLToPath(import.meta.url);
const __dirname = _dirname(__filename);


const router = express.Router();





// ─── Se você quiser suportar upload de foto de professor ─────────────────

// 1) Cria pasta uploads/professores (se não existir)
const profUploadDir = path.resolve(__dirname, "../uploads/professores");
if (!fs.existsSync(profUploadDir)) {
  fs.mkdirSync(profUploadDir, { recursive: true });
}

// 2) Configura Multer para salvar em uploads/professores
const profStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, profUploadDir);
  },
  filename: (_req, file, cb) => {
    // Se existir um campo “id” na URL, poderíamos usar esse id:
    const { id } = _req.params;
    // Exemplo: salvar como “<id>.jpg” ou “<timestamp>_<originalname>”
    cb(null, `${id}.jpg`);
  },
});

// 3) Podemos deixar um fileFilter específico (apenas imagens, por exemplo)
const profFileFilter = (_req, file, cb) => {
  const permitidos = ["image/jpeg", "image/png"];
  cb(null, permitidos.includes(file.mimetype));
};

const profUpload = multer({ storage: profStorage, fileFilter: profFileFilter });

// ─────────────────────────────────────────────────────────────





// ─────────────────────────────────────────────────────────────
 /** GET /professores
 * Retorna todos os professores, incluindo o nome da disciplina associada (se houver).
 */
router.get("/", async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT
        p.id,
        p.cpf,
        p.nome,
        p.data_nascimento,
        p.sexo,
        p.aulas,
        p.disciplina_id,
        d.nome AS disciplina_nome
      FROM professores p
      LEFT JOIN disciplinas d ON p.disciplina_id = d.id
      ORDER BY p.nome
    `);
    res.json(rows);
  } catch (err) {
    console.error("Erro ao buscar professores:", err);
    res.status(500).json({ message: "Erro ao buscar professores." });
  }
});
// ─────────────────────────────────────────────────────────────





// ─────────────────────────────────────────────────────────────
 /** GET /professores/:id
 * Retorna um único professor pelo ID, incluindo o nome da disciplina associada (se houver).
 */
router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await pool.query(
      `
      SELECT
        p.id,
        p.cpf,
        p.nome,
        p.data_nascimento,
        p.sexo,
        p.disciplina_id,
        d.nome AS disciplina_nome
      FROM professores p
      LEFT JOIN disciplinas d ON p.disciplina_id = d.id
      WHERE p.id = ?
      `,
      [id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "Professor não encontrado." });
    }

    res.json(rows[0]);
  } catch (err) {
    console.error("Erro ao buscar professor pelo ID:", err);
    res.status(500).json({ message: "Erro ao buscar professor." });
  }
});
// ─────────────────────────────────────────────────────────────








// ─────────────────────────────────────────────────────────────
 /** POST /professores
 * Cria um novo professor. Espera no body:
 * { cpf, nome, data_nascimento, sexo, disciplina_id }
 *
 * OBS: removemos as colunas created_at e updated_at, pois não existem nesta tabela.
 */
router.post("/", async (req, res) => {
  try {
    const { cpf, nome, data_nascimento, sexo, disciplina_id, aulas } = req.body;

    if (!cpf || !nome || !data_nascimento || !sexo) {
      return res
        .status(400)
        .json({ message: "CPF, nome, data de nascimento e sexo são obrigatórios." });
    }

    if (aulas < 0 || aulas > 40) {
      return res.status(400).json({ message: "Número de aulas deve estar entre 0 e 40." });
    }

    await pool.query(
      `
      INSERT INTO professores (cpf, nome, data_nascimento, sexo, disciplina_id, aulas)
      VALUES (?, ?, ?, ?, ?, ?)
      `,
      [cpf, nome, data_nascimento, sexo, disciplina_id || null, aulas]
    );

    return res.status(201).json({ message: "Professor criado com sucesso." });
  } catch (err) {
    console.error("Erro ao criar professor:", err);
    res.status(500).json({ message: "Falha ao criar professor." });
  }
});
// ─────────────────────────────────────────────────────────────







// ─────────────────────────────────────────────────────────────
 /** PUT /professores/:id
 * Atualiza os dados de um professor existente. Espera no body:
 * { cpf, nome, data_nascimento, sexo, disciplina_id }
 *
 * OBS: removemos updated_at, já que não há essa coluna na tabela.
 */
router.put("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { cpf, nome, data_nascimento, sexo, disciplina_id, aulas } = req.body;

    if (!cpf || !nome || !data_nascimento || !sexo) {
      return res
        .status(400)
        .json({ message: "CPF, nome, data de nascimento e sexo são obrigatórios." });
    }


    if (aulas < 0 || aulas > 40) {
      return res.status(400).json({ message: "Número de aulas deve estar entre 0 e 40." });
    }


    const [result] = await pool.query(
      `
      UPDATE professores
      SET cpf = ?, nome = ?, data_nascimento = ?, sexo = ?, disciplina_id = ?, aulas = ?
      WHERE id = ?
      `,
      [cpf, nome, data_nascimento, sexo, disciplina_id || null, aulas, id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Professor não encontrado." });
    }

    return res.json({ message: "Professor atualizado com sucesso." });
  } catch (err) {
    console.error("Erro ao atualizar professor:", err);
    res.status(500).json({ message: "Falha ao atualizar professor." });
  }
});
// ─────────────────────────────────────────────────────────────





// ─────────────────────────────────────────────────────────────
//PUT /professores/inativar/:id

     router.put("/inativar/:id", async (req, res) => {
       const { id } = req.params;
       try {
         const [result] = await pool.query(
           "UPDATE professores SET status = 'inativo' WHERE id = ?",
           [id]
         );
         if (result.affectedRows === 0) {
           return res.status(404).json({ message: "Professor não encontrado." });
         }
         return res.json({ message: "Professor inativado com sucesso." });
       } catch (err) {
         console.error("Erro ao inativar professor:", err);
         return res.status(500).json({ message: "Não foi possível inativar o professor." });
       }
     });
// ─────────────────────────────────────────────────────────────







// ─────────────────────────────────────────────────────────────
 /** DELETE /professores/:id
 * (Opcional) Remove um professor pelo ID.
 */
router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const [result] = await pool.query("DELETE FROM professores WHERE id = ?", [id]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Professor não encontrado." });
    }

    return res.json({ message: "Professor removido com sucesso." });
  } catch (err) {
    console.error("Erro ao excluir professor:", err);
    res.status(500).json({ message: "Falha ao excluir professor." });
  }
});
// ─────────────────────────────────────────────────────────────





// ─────────────────────────────────────────────────────────────
/** Se quiser oferecer upload de foto de professor, crie este endpoint:
 * POST /professores/:id/foto
 * (a tabela `professores` precisaria ter uma coluna `foto VARCHAR(...)`)
 */
router.post(
  "/:id/foto",
  profUpload.single("foto"),
  async (req, res) => {
    const { id } = req.params;
    if (!req.file) {
      return res.status(400).json({ message: "Nenhuma foto enviada." });
    }
    try {
      // O Multer salvou em uploads/professores/<id>.jpg
      const fotoPath = `/uploads/professores/${req.file.filename}`;
      // Exemplo de UPDATE para armazenar o caminho no banco:
      await pool.query("UPDATE professores SET foto = ? WHERE id = ?", [
        fotoPath,
        id,
      ]);
      return res.status(200).json({ foto: fotoPath });
    } catch (err) {
      console.error("Erro ao atualizar foto do professor no DB:", err);
      return res
        .status(500)
        .json({ message: "Erro ao inserir foto do professor no servidor." });
    }
  }
);
// ─────────────────────────────────────────────────────────────




// ─────────────────────────────────────────────────────────────
// GET /professores/por-cpf-e-disciplina/:cpf/:disciplina_id
router.get("/por-cpf-e-disciplina/:cpf/:disciplina_id", async (req, res) => {
  const { cpf, disciplina_id } = req.params;
  try {
    const [rows] = await pool.query(
      `SELECT * FROM professores WHERE cpf = ? AND disciplina_id = ?`,
      [cpf, disciplina_id]
    );
    if (rows.length > 0) {
      return res.status(200).json(rows[0]);
    } else {
      return res.status(404).json({ message: "Nenhum professor encontrado." });
    }
  } catch (err) {
    console.error("Erro ao verificar professor por CPF e disciplina:", err);
    return res.status(500).json({ message: "Erro interno." });
  }
});
// ─────────────────────────────────────────────────────────────






export default router;
