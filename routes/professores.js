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
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

// ✅ auth (garante req.user disponível neste router)
import { autenticarToken } from "../middleware/autenticarToken.js";
import { verificarEscola } from "../middleware/verificarEscola.js";


const __filename = fileURLToPath(import.meta.url);
const __dirname = _dirname(__filename);

const router = express.Router();

// ────────────────────────────────────────────────
// DigitalOcean Spaces (S3 compatível) — usado em PRODUÇÃO para persistir uploads
// Mantém no banco o caminho relativo: /uploads/<APELIDO>/professores/<id>.<ext>
// ────────────────────────────────────────────────
const SPACES_BUCKET = process.env.SPACES_BUCKET || process.env.DO_SPACES_BUCKET;
const SPACES_REGION = process.env.SPACES_REGION || process.env.DO_SPACES_REGION || "nyc3";
const rawSpacesEndpoint =
  process.env.SPACES_ENDPOINT ||
  process.env.DO_SPACES_ENDPOINT ||
  "https://nyc3.digitaloceanspaces.com";

// Normaliza endpoint: se vier "https://<bucket>.<region>.digitaloceanspaces.com",
// converte para "https://<region>.digitaloceanspaces.com"
function normalizeSpacesEndpoint(endpoint, bucket, region) {
  try {
    const url = new URL(endpoint);
    const host = url.host; // ex: educa-melhor-uploads.nyc3.digitaloceanspaces.com

    // Caso 1: endpoint já é regional
    if (host === `${region}.digitaloceanspaces.com`) return url.toString();

    // Caso 2: endpoint veio com bucket na frente
    if (bucket && host === `${bucket}.${region}.digitaloceanspaces.com`) {
      url.host = `${region}.digitaloceanspaces.com`;
      return url.toString();
    }

    // Caso 3: alguma variação — tenta remover "<bucket>." do começo
    if (bucket && host.startsWith(`${bucket}.`)) {
      url.host = host.replace(`${bucket}.`, "");
      return url.toString();
    }

    return url.toString();
  } catch {
    // fallback seguro
    return `https://${region}.digitaloceanspaces.com`;
  }
}

const SPACES_ENDPOINT = normalizeSpacesEndpoint(rawSpacesEndpoint, SPACES_BUCKET, SPACES_REGION);

const SPACES_KEY = process.env.SPACES_KEY || process.env.DO_SPACES_KEY;
const SPACES_SECRET = process.env.SPACES_SECRET || process.env.DO_SPACES_SECRET;


const s3 =
  SPACES_BUCKET && SPACES_KEY && SPACES_SECRET
    ? new S3Client({
        region: SPACES_REGION,
        endpoint: SPACES_ENDPOINT,
        credentials: { accessKeyId: SPACES_KEY, secretAccessKey: SPACES_SECRET },
        forcePathStyle: false, // importante para DO Spaces (host-style)
      })
    : null;

// ✅ DIAGNÓSTICO PRODUÇÃO (não imprime secrets)
console.log("[SPACES] enabled?", !!s3, {
  bucket: !!SPACES_BUCKET,
  region: SPACES_REGION || null,
  endpoint: SPACES_ENDPOINT || null,
  key: SPACES_KEY ? "OK" : null,
  secret: SPACES_SECRET ? "OK" : null,
});

async function uploadToSpaces({ key, body, contentType }) {
  if (!s3) {
    console.log("[SPACES] skip upload (s3=null). Missing env?", {
      bucket: !!SPACES_BUCKET,
      region: SPACES_REGION || null,
      endpoint: SPACES_ENDPOINT || null,
      key: SPACES_KEY ? "OK" : null,
      secret: SPACES_SECRET ? "OK" : null,
    });
    return;
  }

  console.log("[SPACES] uploading object:", {
    bucket: SPACES_BUCKET,
    endpoint: SPACES_ENDPOINT,
    key,
    contentType,
    bytes: body?.length || null,
  });

  try {
    await s3.send(
      new PutObjectCommand({
        Bucket: SPACES_BUCKET,
        Key: key,
        Body: body,

        // ESSENCIAL: deixa o objeto público para o CDN/HTTP
        ACL: "public-read",

        ContentType: contentType,
        CacheControl: "public, max-age=31536000",
      })
    );


    console.log("[SPACES] upload OK:", { key });
  } catch (err) {
    console.error("[SPACES] upload FAIL:", {
      name: err?.name,
      message: err?.message,
      code: err?.code,
      status: err?.$metadata?.httpStatusCode,
      requestId: err?.$metadata?.requestId,
      cfId: err?.$metadata?.cfId,
      key,
      endpoint: SPACES_ENDPOINT,
      bucket: SPACES_BUCKET,
    });
    throw err; // mantém 500 para você ver claramente que o upload falhou
  }
}



// (REMOVIDO)
// Usaremos o middleware oficial em ./middleware/verificarEscola.js
// que aceita x-escola-id (header), query/body ou token e seta req.escola_id.


// ────────────────────────────────────────────────
// Configuração de upload de foto (multi-escola)
// Salva em: /uploads/<CODIGO_ESCOLA>/professores/<id>.<ext>
// - CODIGO_ESCOLA: vem da tabela escolas (coluna "codigo"), com fallback "escola_<id>"
// ────────────────────────────────────────────────
const getExtFromMime = (mime) => {
  if (mime === "image/png") return "png";
  if (mime === "image/webp") return "webp";
  return "jpg"; // default p/ jpeg
};

const profStorage = multer.diskStorage({

destination: (req, _file, cb) => {
  // Multi-escola: prioriza middleware (req.escola_id), depois token, depois header
  const escolaId =
    req.escola_id ||
    req.user?.escola_id ||
    (req.headers?.["x-escola-id"] ? Number(req.headers["x-escola-id"]) : null);

  if (!escolaId || Number.isNaN(Number(escolaId)) || Number(escolaId) <= 0) {
    return cb(new Error("Acesso negado: escola não definida."), null);
  }

  // mantém compatibilidade: algumas rotas ainda leem req.user.escola_id
  if (req.user && !req.user.escola_id) req.user.escola_id = Number(escolaId);

  // Busca o "apelido" da escola para criar a pasta (ex: CEF04_PLAN)
  pool
    .query("SELECT apelido FROM escolas WHERE id = ? LIMIT 1", [Number(escolaId)])
      .then(([rows]) => {
        const apelidoRaw = rows?.[0]?.apelido ? String(rows[0].apelido) : `escola_${escolaId}`;

        // slug simples (evita espaços/acentos/caracteres ruins)
        const apelido = apelidoRaw
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .replace(/[^a-zA-Z0-9_-]+/g, "_")
          .replace(/_+/g, "_")
          .replace(/^_|_$/g, "");

        const dir = path.resolve(__dirname, `../uploads/${apelido}/professores`);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        // guarda para o filename/response
        req.__upload_escola_apelido = apelido;

        cb(null, dir);
      })
      .catch((err) => cb(err, null));
  },

  filename: async (req, file, cb) => {
    try {
const escolaId =
  req.escola_id ||
  req.user?.escola_id ||
  (req.headers?.["x-escola-id"] ? Number(req.headers["x-escola-id"]) : null);

// 1) tenta cpf no token
let cpf = req.user?.cpf;

// 2) fallback: pega cpf no banco via id do usuário (caso o token não traga cpf)
// (alguns tokens usam "sub" ao invés de "id")
const userId =
  req.user?.id ||
  req.user?.usuario_id ||
  req.user?.userId ||
  req.user?.usuarioId ||
  req.user?.user_id ||
  req.user?.id_usuario ||
  req.user?.uid ||
  req.user?.sub ||
  req.user?.user?.id ||
  req.user?.usuario?.id;


if (!cpf && userId) {
  const [urows] = await pool.query(
    "SELECT cpf FROM usuarios WHERE id = ? LIMIT 1",
    [userId]
  );
  cpf = urows?.[0]?.cpf ? String(urows[0].cpf) : null;
}

if (!escolaId || !cpf) {
  return cb(new Error("Token inválido: cpf/escola ausentes."), null);
}


      if (!cpf && userId) {
        const [urows] = await pool.query(
          "SELECT cpf FROM usuarios WHERE id = ? LIMIT 1",
          [userId]
        );
        cpf = urows?.[0]?.cpf ? String(urows[0].cpf) : null;
      }

      if (!escolaId || !cpf) {
        return cb(new Error("Token inválido: cpf/escola ausentes."), null);
      }

      // Descobre o professor logado nesta escola
      const [rows] = await pool.query(
        "SELECT id FROM professores WHERE cpf = ? AND escola_id = ? LIMIT 1",
        [cpf, escolaId]
      );
      if (!rows?.length) {
        return cb(new Error("Professor não encontrado para esta escola."), null);
      }

      const profId = rows[0].id;
      const ext = getExtFromMime(file.mimetype);

      // guarda para o handler final (atualizar banco/retornar url)
      req.__upload_prof_id = profId;
      req.__upload_ext = ext;

      cb(null, `${profId}.${ext}`);
    } catch (err) {
      cb(err, null);
    }
  },
});

const profFileFilter = (_req, file, cb) => {
  const permitidos = ["image/jpeg", "image/png", "image/webp"];
  cb(null, permitidos.includes(file.mimetype));
};

const profUpload = multer({
  storage: profStorage,
  fileFilter: profFileFilter,
  limits: { fileSize: 3 * 1024 * 1024 }, // 3MB
});


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
// POST: Upload da foto do professor logado (multi-escola)
// URL pública retornada: /uploads/<CODIGO_ESCOLA>/professores/<arquivo>
// ────────────────────────────────────────────────
router.post(
  "/me/foto",
  autenticarToken,
  verificarEscola,
  profUpload.single("foto"),
  async (req, res) => {
    if (!req.file) return res.status(400).json({ message: "Nenhuma foto enviada." });

    try {
      const apelido = req.__upload_escola_apelido || `escola_${req.user.escola_id}`;
      const profId = req.__upload_prof_id;
      const ext = req.__upload_ext || "jpg";

      if (!profId) {
        return res.status(400).json({ message: "Falha ao identificar professor logado." });
      }

      // caminho relativo (permanece no banco, igual alunos)
      const fotoUrl = `/uploads/${apelido}/professores/${profId}.${ext}`;

      // 1) Se Spaces estiver configurado, sobe o arquivo para lá também (persistência em produção)
      // Key no bucket NÃO tem barra inicial
      const key = fotoUrl.replace(/^\/+/, "");
      const buffer = await fs.promises.readFile(req.file.path);
      await uploadToSpaces({ key, body: buffer, contentType: req.file.mimetype });

      // 2) Atualiza banco com o caminho relativo
      await pool.query(
        "UPDATE professores SET foto = ? WHERE id = ? AND escola_id = ?",
        [fotoUrl, profId, req.user.escola_id]
      );

      return res.json({ foto_url: fotoUrl });
    } catch (err) {
      console.error("Erro ao atualizar foto (me/foto):", err);

      // Diagnóstico temporário (remover depois)
      return res.status(500).json({
        message: "Erro ao atualizar foto do professor.",
        debug: {
          name: err?.name,
          message: err?.message,
          code: err?.code,
          status: err?.$metadata?.httpStatusCode,
        },
      });
    }
  }
);



// ────────────────────────────────────────────────
// GET: Foto do professor logado (para re-hidratar o header após novo login)
// Retorna: { foto_url: "/uploads/<apelido>/professores/<id>.jpg" } ou { foto_url: "" }
// ────────────────────────────────────────────────
router.get("/me/foto", autenticarToken, verificarEscola, async (req, res) => {
  try {
    const escolaId = req.user?.escola_id;

    // 1) tenta cpf no token
    let cpf = req.user?.cpf;

    // 2) fallback: pega cpf no banco via id do usuário (caso o token não traga cpf)
    const userId =
      req.user?.id ||
      req.user?.usuario_id ||
      req.user?.userId ||
      req.user?.usuarioId ||
      req.user?.user_id ||
      req.user?.id_usuario ||
      req.user?.uid ||
      req.user?.sub ||
      req.user?.user?.id ||
      req.user?.usuario?.id;

    if (!cpf && userId) {
      const [urows] = await pool.query(
        "SELECT cpf FROM usuarios WHERE id = ? LIMIT 1",
        [userId]
      );
      cpf = urows?.[0]?.cpf ? String(urows[0].cpf) : null;
    }

    if (!escolaId || !cpf) {
      return res.status(400).json({ ok: false, message: "Token inválido: cpf/escola ausentes." });
    }

    const [rows] = await pool.query(
      "SELECT foto FROM professores WHERE cpf = ? AND escola_id = ? LIMIT 1",
      [cpf, escolaId]
    );

    const fotoUrl = rows?.[0]?.foto ? String(rows[0].foto) : "";
    return res.json({ foto_url: fotoUrl });
  } catch (err) {
    console.error("Erro ao buscar foto do professor (me/foto):", err);
    return res.status(500).json({ ok: false, message: "Erro ao buscar foto do professor." });
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
