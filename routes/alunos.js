// api/routes/alunos.js

import express from "express";
import multer from "multer";
//import pdfParse from "pdf-parse"; (atenção, comentei para usar gestão_provas)
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




// ─── Configuração do Multer para salvar o upload de foto recortada ─────



// a) Defina o caminho absoluto para uploads/alunos
const uploadDir = path.resolve(__dirname, "../uploads/alunos");



// b) Se não existir, crie a pasta (com recursive: true para criar a árvore)
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}



// c) Configuração do storage do Multer
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    // Agora salvaremos em uploads/alunos
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    // Nome do arquivo: "<codigo>.jpg"
    const codigo = req.params.id;
    cb(null, `${codigo}.jpg`);
  },
});

const upload = multer({ storage });
// ─────────────────────────────────────────────────────────────







// ─────────────────────────────────────────────────────────────
//1) LISTAR TODOS OS ALUNOS: GET /api/alunos/
// ─────────────────────────────────────────────────────────────
router.get("/", async (req, res) => {
  try {
    // Retorna os campos que o AlunoTable.jsx espera (estudante e turma)
    const [rows] = await pool.query(
      `
      SELECT
        a.id,
        a.codigo,
        a.estudante,    -- este campo será exibido em AlunoTable.jsx como aluno.estudante
        DATE_FORMAT(a.data_nascimento, '%Y-%m-%d') AS data_nascimento,
        a.sexo,
        a.status,
        t.nome AS turma,  -- este campo será exibido em AlunoTable.jsx como aluno.turma
        t.turno
      FROM alunos AS a
      LEFT JOIN turmas AS t ON t.id = a.turma_id
      ORDER BY a.estudante;
      `
    );
    return res.json(rows);
  } catch (err) {
    console.error("Erro ao listar alunos:", err);
    return res.status(500).json({ message: "Erro no servidor ao listar alunos." });
  }
});
// ─────────────────────────────────────────────────────────────






// ─────────────────────────────────────────────────────────────
// 2) CRIAR NOVO ALUNO: POST /api/alunos
// ─────────────────────────────────────────────────────────────
router.post("/", async (req, res) => {
  try {
    const { codigo, estudante, data_nascimento, sexo, turma_id } = req.body;
    const [result] = await pool.query(
      `INSERT INTO alunos
         (codigo, estudante, data_nascimento, sexo, turma_id, status)
       VALUES (?, ?, ?, ?, ?, 'ativo')`,
      [codigo, estudante, data_nascimento, sexo, turma_id]
    );
    return res.status(201).json({ id: result.insertId });
  } catch (err) {
    console.error("Erro ao criar aluno:", err);
    return res.status(500).json({ message: "Erro ao criar aluno." });
  }
});
// ─────────────────────────────────────────────────────────────






// ─────────────────────────────────────────────────────────────
// 3) ATUALIZAR / REATIVAR: PUT /api/alunos/:id
// ─────────────────────────────────────────────────────────────
router.put("/:id", async (req, res) => {
  try {
    const { estudante, data_nascimento, sexo, turma_id, status } = req.body;
    const campos = [];
    const valores = [];

    if (estudante) {
      campos.push("estudante = ?");
      valores.push(estudante);
    }
    if (data_nascimento) {
      campos.push("data_nascimento = ?");
      valores.push(data_nascimento);
    }
    if (sexo) {
      campos.push("sexo = ?");
      valores.push(sexo);
    }
    if (turma_id) {
      campos.push("turma_id = ?");
      valores.push(turma_id);
    }
    if (status) {
      campos.push("status = ?");
      valores.push(status);
    }

    if (campos.length === 0) {
      return res.status(400).json({ message: "Nada para atualizar." });
    }

    valores.push(req.params.id);
    await pool.query(
      `UPDATE alunos SET ${campos.join(", ")} WHERE id = ?`,
      valores
    );

    return res.json({ message: "Aluno atualizado com sucesso." });
  } catch (error) {
    console.error("Erro ao atualizar aluno:", error);
    res.status(500).json({ message: "Erro ao atualizar aluno." });
  }
});
// ─────────────────────────────────────────────────────────────






// ─────────────────────────────────────────────────────────────
// 4) INATIVAR: PUT /api/alunos/inativar/:id
// ─────────────────────────────────────────────────────────────
router.put("/inativar/:id", async (req, res) => {
  try {
    await pool.query(
      `UPDATE alunos
         SET status='inativo'
       WHERE id = ?`,
      [req.params.id]
    );
    return res.json({ message: "Aluno inativado." });
  } catch (err) {
    console.error("Erro ao inativar aluno:", err);
    return res.status(500).json({ message: "Erro ao inativar aluno." });
  }
});
// ─────────────────────────────────────────────────────────────






// ─────────────────────────────────────────────────────────────
// 5) EXCLUIR (opcional): DELETE /api/alunos/:id
// ─────────────────────────────────────────────────────────────
router.delete("/:id", async (req, res) => {
  try {
    await pool.query("DELETE FROM alunos WHERE id = ?", [req.params.id]);
    return res.json({ message: "Aluno excluído." });
  } catch (err) {
    console.error("Erro ao excluir aluno:", err);
    return res.status(500).json({ message: "Erro ao excluir aluno." });
  }
});
// ─────────────────────────────────────────────────────────────








// ─────────────────────────────────────────────────────────────
// 6) BUSCAR ALUNO POR CÓDIGO: GET /api/alunos/por-codigo/:codigo
// ─────────────────────────────────────────────────────────────
router.get(
  "/por-codigo/:codigo",
  async (req, res) => {
    try {
      const { codigo } = req.params;
      const [[aluno]] = await pool.query(
        `
        SELECT
          a.id,
          a.codigo,
          a.estudante AS nome,
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
        [codigo]
      );
      if (!aluno) {
        return res.status(404).json({ message: "Aluno não encontrado." });
      }
      return res.json(aluno);
    } catch (err) {
      console.error("Erro ao buscar aluno por código:", err);
      return res
        .status(500)
        .json({ message: "Erro no servidor ao buscar por código." });
    }
  }
);
// ─────────────────────────────────────────────────────────────






// ─────────────────────────────────────────────────────────────
//7) BUSCAR BOLETIM: GET /api/alunos/:id/notas
// ─────────────────────────────────────────────────────────────
router.get(
  "/:id/notas",                        // ← ADICIONADO
  async (req, res) => {
    try {
      const { id } = req.params;
      const [notas] = await pool.query(
        `SELECT n.id, n.valor, d.nome AS disciplina
         FROM notas n
         JOIN disciplinas d ON n.disciplina_id = d.id
         WHERE n.aluno_id = ?
         ORDER BY d.nome`,
        [id]
      );
      return res.json(notas);
    } catch (err) {
      console.error("Erro ao buscar notas do aluno:", err);
      return res
        .status(500)
        .json({ message: "Erro no servidor ao buscar notas." });
    }
  }
);
// ─────────────────────────────────────────────────────────────





// ─────────────────────────────────────────────────────────────
// 8) Retorna todos os alunos com status "inativo"
// ─────────────────────────────────────────────────────────────

router.get("/inativos", getInativos);








// ─────────────────────────────────────────────────────────────
//9) BUSCAR UM ALUNO ESPECÍFICO: GET /api/alunos/:id
// ─────────────────────────────────────────────────────────────
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
// ─────────────────────────────────────────────────────────────






// ─────────────────────────────────────────────────────────────
//10) RECEBER FOTO RECORTADA: POST /api/alunos/:id/foto
// ─────────────────────────────────────────────────────────────
router.post(
  "/:id/foto",
  upload.single("foto"),
  async (req, res) => {
    const { id } = req.params;
    if (!req.file) {
      return res.status(400).json({ message: "Nenhuma foto enviada." });
    }
    try {
      // O Multer salvou em "uploads/alunos/<codigo>.jpg"
      const fotoPath = `/uploads/alunos/${req.file.filename}`;
      // Atualiza a coluna `foto` daquele aluno (onde `codigo = id`)
      await pool.query("UPDATE alunos SET foto = ? WHERE codigo = ?", [
        fotoPath,
        id,
      ]);
      return res.status(200).json({ foto: fotoPath });
    } catch (err) {
      console.error("Erro ao atualizar foto no DB:", err);
      return res
        .status(500)
        .json({ message: "Erro ao inserir foto no servidor." });
    }
  }
);
// ─────────────────────────────────────────────────────────────







// ─────────────────────────────────────────────────────────────
//11) IMPORTAR PDF → GERAR INSERTS DE ALUNOS (POST "/importar-pdf")
// ─────────────────────────────────────────────────────────────
const uploadPdf = multer(); // não precisa de storage, usaremos buffer
router.post(
  "/importar-pdf",
  uploadPdf.single("file"),
  async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ message: "PDF não enviado." });
    }

    try {
      // 11.1) Lê todo o texto do PDF enviado
      const { text } = await pdfParse(req.file.buffer);
      // O nome do arquivo enviado, sem extensão, é o nome da turma
      const turmaNome = req.file.originalname.replace(/\.pdf$/i, "").trim();

      // 11.2) Localizar o ID da turma no banco
      const [[turma]] = await pool.query(
        "SELECT id FROM turmas WHERE nome = ?",
        [turmaNome]
      );
      if (!turma) {
        return res
          .status(404)
          .json({ message: `Turma "${turmaNome}" não encontrada.` });
      }
      const turma_id = turma.id;

      // 11.3) Quebra o texto em linhas e extrai os dados de cada aluno pelo regex
      const lines = text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l);
      const pdfEntries = [];
      for (let i = 0; i < lines.length; i++) {
        const ln = lines[i];
        // Regex que busca: código (3+ dígitos), nome, data "dd/mm/aaaa"
        const m = ln.match(/^(\d{3,})\s*([A-Za-zÀ-ÖØ-öø-ÿ\s]+?)\s*(\d{2}\/\d{2}\/\d{4})\s*$/);
        if (!m) continue;
        const [, codigo, nomeRaw, dataBr] = m;
        // O sexo vem duas linhas abaixo
        const sexoRaw = (lines[i + 2] || "").charAt(0).toUpperCase();
        if (!/^[MF]$/.test(sexoRaw)) continue;

        pdfEntries.push({
          codigo,
          estudante: nomeRaw.trim(),
          data_nascimento: dataBr,  // ex.: "12/08/2023"
          sexo: sexoRaw,
          turma_nome: turmaNome
        });
        i += 2; // pula as próximas duas linhas (já usamos para o sexo)
      }


      const localizados = pdfEntries.length;


      // 11.4) Cria Set dos códigos do PDF
      const setPdf = new Set(pdfEntries.map(e => e.codigo));



      // 11.5) Busca todos os alunos daquela turma (ativos e inativos)
      const [dbRowsAll] = await pool.query(
        "SELECT id, codigo, status FROM alunos WHERE turma_id = ?",
        [turma_id]
      );


      const dbActive   = dbRowsAll.filter(r => r.status === "ativo");
      const dbInactive = dbRowsAll.filter(r => r.status !== "ativo");
      const setAllCodes    = new Set(dbRowsAll.map(r => String(r.codigo)));
      const setActiveCodes = new Set(dbActive.map(r => String(r.codigo)));



      // 11.6) Calcula quem já existia (ativo), quem inserir, quem reativar, quem inativar
      const jaExistiam = pdfEntries.filter(e => setActiveCodes.has(e.codigo)).length;
      const toInsert    = pdfEntries.filter(e => !setAllCodes.has(e.codigo));
      const toReactivate = pdfEntries.filter(e =>
        dbInactive.some(r => String(r.codigo) === e.codigo)
      );
      const toInactivate = dbActive.filter(r => !setPdf.has(String(r.codigo)));




      // 11.7) Insere novos alunos
      let inseridos = 0;
      for (const e of toInsert) {
        await pool.query(
          `
          INSERT INTO alunos
            (codigo, estudante, data_nascimento, sexo, turma_id, status)
          VALUES
            (?, ?, STR_TO_DATE(?, '%d/%m/%Y'), ?, ?, 'ativo')
          `,
          [e.codigo, e.estudante, e.data_nascimento, e.sexo, turma_id]
        );
        inseridos++;
      }



      // 11.8) Reativar os inativos que voltaram no PDF
      let reativados = 0;
      for (const e of toReactivate) {
        await pool.query(
          "UPDATE alunos SET status='ativo', turma_id = ? WHERE codigo = ?",
          [turma_id, e.codigo]
        );
      reativados++;
      }




      // 11.9) Inativar quem saiu do PDF
      let inativados = 0;
      for (const r of toInactivate) {
        const correspondente = pdfEntries.find(e => e.codigo === String(r.codigo));
          if (correspondente) {
            await pool.query(
              `UPDATE alunos
               SET status='inativo', data_nascimento = STR_TO_DATE(?, '%d/%m/%Y')
               WHERE id = ?`,
              [correspondente.dataBr, r.id]
            );
          } else {
            await pool.query("UPDATE alunos SET status='inativo' WHERE id = ?", [r.id]);
          }
        inativados++;
      }




      console.log(
        `[importar-pdf] → localizados: ${localizados}, inseridos: ${inseridos}, reativados: ${reativados}, jáExistiam: ${jaExistiam}, inativados: ${inativados}`
      );




      return res.json({ 
        localizados, 
        inseridos, 
        reativados, 
        jaExistiam, 
        inativados,
        listaAlunos: pdfEntries
      });
    } catch (err) {
      console.error("Erro ao processar /importar-pdf:", err);
      return res
        .status(500)
        .json({ message: "Erro ao processar PDF.", error: err.message });
    }
  }
);
// ─────────────────────────────────────────────────────────────







// ───────────────────────────────────────────────────────────── 
// 12) NOVA ROTA: IMPORTAR XLSX
// ─────────────────────────────────────────────────────────────
const uploadXlsx = multer(); // multer sem storage, lida com buffer
router.post(
  "/importar-xlsx",
  uploadXlsx.single("file"),
  async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ message: "XLSX não enviado." });
    }

    try {
      // 12.1) Obter o buffer e transformar em workbook
      const workbook = XLSX.read(req.file.buffer, { type: "buffer" });


      // 12.2) Vamos assumir que a primeira aba contém a lista de alunos:
      const primeiraAbaNome = workbook.SheetNames[0];
      const sheet = workbook.Sheets[primeiraAbaNome];



      // 12.3) Converter a aba em um array de objetos JS (header: primeira linha)
      const dados = XLSX.utils.sheet_to_json(sheet, {
        header: ["codigo", "estudante", "data_nascimento", "sexo"],
        range: 1, // ignorar a linha de cabeçalho (linha 0)
        defval: "", // células vazias viram string vazia
      });



      // 12.4) Para este exemplo, vamos considerar que há uma coluna "turma" fixa, 
      //    ou você pode decidir extrair uma coluna adicional do XLSX.
      //    Aqui vou exemplificar que o nome do arquivo (sem extensão) é o nome da turma,
      //    da mesma forma que no PDF:
      const turmaNome = req.file.originalname.replace(/\.[^.]+$/, "").trim();




      // 12.5) Consultar ID da turma
      const [[turma]] = await pool.query(
        "SELECT id FROM turmas WHERE nome = ?",
        [turmaNome]
      );
      if (!turma) {
        return res
          .status(404)
          .json({ message: `Turma "${turmaNome}" não encontrada.` });
      }
      const turma_id = turma.id;



      // 12.6) Preparar arrays para comparar com DB (mesma lógica do PDF)
      //    Transformar cada linha em um objeto { codigo, estudante, dataBr, sexo }







      const xlsxEntries = [];
      for (const linha of dados) {
        const codigo = String(linha.codigo).trim();
        const estudante = String(linha.estudante).trim();
        const sexoRaw = String(linha.sexo).trim().toUpperCase();

        // 🔍 Lógica inteligente para interpretar a data corretamente
        let dataBr = "";

        if (typeof linha.data_nascimento === "number") {
           // Data em formato serial do Excel
           dataBr = XLSX.SSF.format("dd/mm/yyyy", linha.data_nascimento);
        } else {
          // Data como texto: tentar detectar o padrão
          const str = String(linha.data_nascimento).trim().replace(/-/g, "/");
          const partes = str.split("/");

          if (partes.length === 3) {
            if (partes[0].length === 4) {
              // yyyy/mm/dd → dd/mm/yyyy
              dataBr = `${partes[2]}/${partes[1]}/${partes[0]}`;
             } else if (partes[2].length === 4) {
              // dd/mm/yyyy → mantém
              dataBr = str;
            } else {
              dataBr = ""; // formato inválido
            }
          }
        }

        if (!codigo || !estudante || !dataBr || !/^[MF]$/.test(sexoRaw)) {
          continue; // pula linhas mal formatadas
        }

        xlsxEntries.push({
          codigo,
          estudante,
          dataBr,
          sexo: sexoRaw,
        });
      }





      const localizados = xlsxEntries.length;
      const setXlsx = new Set(xlsxEntries.map(e => e.codigo));



      // 12.7) Pega todos os alunos daquela turma, seja ativo ou inativo
       const [dbRowsAll] = await pool.query(
         "SELECT id, codigo, status FROM alunos WHERE turma_id = ?",
         [turma_id]
       );
       const dbActive  = dbRowsAll.filter(r => r.status === "ativo");
       const dbInactive = dbRowsAll.filter(r => r.status !== "ativo");
       // Sets para comparação
       const setAllCodes    = new Set(dbRowsAll.map(r => String(r.codigo)));
       const setActiveCodes = new Set(dbActive.map(r => String(r.codigo)));






       // Quantos já existiam (ativos)  
       const jaExistiam = xlsxEntries.filter(e => setActiveCodes.has(e.codigo)).length;
       // Quem não existe de jeito nenhum → inserir  
       const toInsert    = xlsxEntries.filter(e => !setAllCodes.has(e.codigo));
       // Quem existe mas está inativo → reativar  
       const toReactivate = xlsxEntries.filter(e =>
         dbInactive.some(r => String(r.codigo) === e.codigo)
       );
       // Quem está ativo no BD mas não veio no XLSX → inativar  
       const toInactivate = dbActive.filter(r => !setXlsx.has(String(r.codigo)));








      // 12.8) Inserir novos alunos (não existentes)
      let inseridos = 0;
      for (const e of toInsert) {
        await pool.query(
          `
          INSERT INTO alunos
            (codigo, estudante, data_nascimento, sexo, turma_id, status)
          VALUES (?, ?, STR_TO_DATE(?, '%d/%m/%Y'), ?, ?, 'ativo')
          `,
          [e.codigo, e.estudante, e.dataBr, e.sexo, turma_id]
        );
        inseridos++;
      }




       // 12.9) Reativar quem estava inativo
       let reativados = 0;
       for (const e of toReactivate) {
         await pool.query(
           "UPDATE alunos SET status='ativo', turma_id = ? WHERE codigo = ?",
           [turma_id, e.codigo]
         );
         reativados++;
       }
 



       // 12.10) Inativar quem não veio no XLSX
      let inativados = 0;
      for (const r of toInactivate) {
        const correspondente = xlsxEntries.find(e => e.codigo === String(r.codigo));
          if (correspondente) {
            await pool.query(
              `UPDATE alunos
               SET status='inativo', data_nascimento = STR_TO_DATE(?, '%d/%m/%Y')
               WHERE id = ?`,
              [correspondente.dataBr, r.id]
            );
          } else {
            await pool.query("UPDATE alunos SET status='inativo' WHERE id = ?", [r.id]);
         }
        inativados++;
      }






      console.log(
        `[importar-xlsx] → localizados: ${localizados}, inseridos: ${inseridos}, reativados: ${reativados}, jáExistiam: ${jaExistiam}, inativados: ${inativados}`
      );
      return res.json({ localizados, inseridos, reativados, jaExistiam, inativados });
    } catch (err) {
      console.error("Erro ao processar /importar-xlsx:", err);
      return res
        .status(500)
        .json({ message: "Erro ao processar XLSX.", error: err.message });
    }
  }
);
// ─────────────────────────────────────────────────────────────





// ─────────────────────────────────────────────────────────────
// 13) NOVA ROTA: LISTAR ALUNOS INATIVOS → GET /alunos/inativos
// ─────────────────────────────────────────────────────────────
router.get("/inativos", async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT
        a.id,
        a.codigo,
        a.estudante,
        DATE_FORMAT(a.data_nascimento, '%Y-%m-%d') AS data_nascimento,
        a.sexo,
        a.status,
        t.nome AS turma,
        t.turno
      FROM alunos AS a
      LEFT JOIN turmas AS t ON t.id = a.turma_id
      WHERE a.status = 'inativo'
      ORDER BY a.estudante`
    );
    return res.json(rows);
  } catch (err) {
    console.error("Erro ao buscar alunos inativos:", err);
    return res.status(500).json({ message: "Erro ao buscar alunos inativos." });
  }
});
// ─────────────────────────────────────────────────────────────








export default router;
