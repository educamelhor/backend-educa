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
        p.foto,
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
// GET: Turmas da escola do usuário logado (para contexto de Conteúdos)
// Retorna: { ok: true, turmas: [{ id, nome, ano, serie, turno, etapa }, ...] }
// Observação: por governança, aqui retornamos as turmas da escola (multi-escola via token).
// ────────────────────────────────────────────────
router.get("/me/turmas", autenticarToken, verificarEscola, async (req, res) => {
  try {
    const escolaId = req.user?.escola_id;
    const disciplinaFiltrada = req.query.disciplina;

    // Obtém o CPF
    let cpf = req.user?.cpf;
    const userId =
      req.user?.id ||
      req.user?.usuario_id ||
      req.user?.userId ||
      req.user?.usuarioId ||
      req.user?.user_id ||
      req.user?.id_usuario;

    if (!cpf && userId) {
      const [urows] = await pool.query("SELECT cpf FROM usuarios WHERE id = ? LIMIT 1", [userId]);
      cpf = urows?.[0]?.cpf ? String(urows[0].cpf) : null;
    }

    if (!escolaId || Number.isNaN(Number(escolaId)) || Number(escolaId) <= 0 || !cpf) {
      return res.status(400).json({ ok: false, message: "Token inválido: escola ou cpf ausente." });
    }

    const cleanCpf = String(cpf).replace(/\D/g, "");

    let sql = `
      SELECT DISTINCT
        t.id,
        t.nome,
        t.ano,
        t.serie,
        t.turno,
        t.etapa
      FROM turmas t
      WHERE t.escola_id = ?
        AND (
          t.id IN (
            SELECT p.turma_id FROM professores p WHERE p.escola_id = ? AND REPLACE(REPLACE(p.cpf, '.', ''), '-', '') = ?
          )
          OR
          t.id IN (
            SELECT m.turma_id FROM modulacao m
            JOIN professores p ON p.id = m.professor_id
            `;
            
    if (disciplinaFiltrada) {
      sql += ` JOIN disciplinas d ON d.id = m.disciplina_id AND d.nome = ? `;
    }
            
    sql += `
            WHERE p.escola_id = ? AND REPLACE(REPLACE(p.cpf, '.', ''), '-', '') = ?
          )
        )
      ORDER BY
        t.ano DESC,
        t.etapa ASC,
        t.serie ASC,
        t.nome ASC
      `;

    let params = [Number(escolaId), Number(escolaId), cleanCpf];
    if (disciplinaFiltrada) params.push(disciplinaFiltrada);
    params.push(Number(escolaId), cleanCpf);

    const [rows] = await pool.query(sql, params);

    const turmas = Array.isArray(rows)
      ? rows
          .map((r) => ({
            id: Number(r?.id),
            nome: String(r?.nome || "").trim(),
            ano: r?.ano != null ? Number(r.ano) : null,
            serie: String(r?.serie || "").trim() || null,
            turno: String(r?.turno || "").trim() || null,
            etapa: String(r?.etapa || "").trim() || null,
          }))
          .filter((t) => Number.isFinite(t.id) && t.nome)
      : [];

    return res.json({ ok: true, turmas });
  } catch (err) {
    console.error("Erro ao buscar turmas (me/turmas):", err);
    return res.status(500).json({ ok: false, message: "Erro ao buscar turmas da escola." });
  }
});


// ────────────────────────────────────────────────
// GET: Professor IDs do professor logado (para módulo Gabarito)
// Retorna: { ok: true, professor_ids: [5, 12, …] }
// Resolve via CPF do token → tabela professores (pode ter múltiplos registros)
// ────────────────────────────────────────────────
router.get("/me/id", autenticarToken, verificarEscola, async (req, res) => {
  try {
    const escolaId = req.user?.escola_id;

    let cpf = req.user?.cpf;
    const userId =
      req.user?.id ||
      req.user?.usuario_id ||
      req.user?.userId ||
      req.user?.usuarioId ||
      req.user?.user_id ||
      req.user?.id_usuario;

    if (!cpf && userId) {
      const [urows] = await pool.query("SELECT cpf FROM usuarios WHERE id = ? LIMIT 1", [userId]);
      cpf = urows?.[0]?.cpf ? String(urows[0].cpf) : null;
    }

    if (!escolaId || !cpf) {
      return res.status(400).json({ ok: false, message: "Token inválido: cpf/escola ausentes." });
    }

    const cleanCpf = String(cpf).replace(/\D/g, "");

    const [rows] = await pool.query(
      `SELECT id FROM professores
       WHERE escola_id = ? AND REPLACE(REPLACE(cpf, '.', ''), '-', '') = ? AND status = 'ativo'
       ORDER BY id`,
      [escolaId, cleanCpf]
    );

    const ids = rows.map(r => r.id);

    return res.json({ ok: true, professor_ids: ids });
  } catch (err) {
    console.error("Erro ao buscar professor_id (me/id):", err);
    return res.status(500).json({ ok: false, message: "Erro ao resolver professor." });
  }
});


// ────────────────────────────────────────────────
// GET: Disciplinas do professor logado (para contexto de Conteúdos)
// Retorna: { ok: true, disciplinas: [{ id, nome }, ...] }
// ────────────────────────────────────────────────
router.get("/me/disciplinas", autenticarToken, verificarEscola, async (req, res) => {
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
      req.user?.usuario?.id ||
      req.user?.usuarioId;

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

    const cleanCpf = String(cpf).replace(/\D/g, "");
    // - Hoje seu modelo indica 1 disciplina por professor (professores.disciplina_id),
    //   mas retornamos como ARRAY para já nascer compatível com múltiplas no futuro.






    const [rows] = await pool.query(
      `
      SELECT d.id AS id, d.nome AS nome
      FROM professores p
      JOIN disciplinas d ON d.id = p.disciplina_id
      WHERE p.escola_id = ?
        AND REPLACE(REPLACE(p.cpf, '.', ''), '-', '') = ?
        AND p.disciplina_id IS NOT NULL
        
      UNION
      
      SELECT d.id AS id, d.nome AS nome
      FROM professores p
      JOIN modulacao m ON m.professor_id = p.id
      JOIN disciplinas d ON d.id = m.disciplina_id
      WHERE p.escola_id = ?
        AND REPLACE(REPLACE(p.cpf, '.', ''), '-', '') = ?
      
      ORDER BY nome ASC
      `,
      [escolaId, cleanCpf, escolaId, cleanCpf]
    );

    const disciplinas = Array.isArray(rows)
      ? rows
          .map((r) => ({
            id: Number(r?.id),
            nome: String(r?.nome || "").trim(),
          }))
          .filter((d) => Number.isFinite(d.id) && d.nome)
      : [];

    return res.json({ ok: true, disciplinas });







  } catch (err) {
    console.error("Erro ao buscar disciplinas do professor (me/disciplinas):", err);
    return res.status(500).json({ ok: false, message: "Erro ao buscar disciplinas do professor." });
  }
});


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

    const cpfLimpo = String(cpf || "").replace(/\D/g, "");

    if (!cpfLimpo || cpfLimpo.length !== 11 || !nome || !disciplina_id || !turno) {
      return res.status(400).json({ message: "CPF (11 dígitos), nome, disciplina e turno são obrigatórios." });
    }
    if (aulas < 0 || aulas > 40) {
      return res.status(400).json({ message: "Número de aulas deve estar entre 0 e 40." });
    }

    const [[existente]] = await pool.query(
      "SELECT id FROM professores WHERE REPLACE(REPLACE(cpf, '.', ''), '-', '') = ? AND escola_id = ? AND disciplina_id = ? AND turno = ? LIMIT 1",
      [cpfLimpo, escola_id, disciplina_id, turno]
    );

    if (existente) {
      return res.status(409).json({ message: "Já existe um pré-cadastro para este professor com esta mesma disciplina no mesmo turno." });
    }

    await pool.query(
      `
      INSERT INTO professores
        (cpf, nome, data_nascimento, sexo, disciplina_id, turma_id, aulas, turno, escola_id, status)
      VALUES
        (?,   UPPER(?), ?,               ?,   ?,             ?,        ?,     ?,     ?,         'ativo')
      `,
      [cpfLimpo, nome, data_nascimento || null, sexo || null, disciplina_id, turma_id, aulas, turno, escola_id]
    );

    await pool.query(
      `INSERT INTO usuarios (cpf, nome, perfil, escola_id, senha_hash)
         VALUES (?, UPPER(?), 'professor', ?, ?)
         ON DUPLICATE KEY UPDATE nome=VALUES(nome)`,
      [cpfLimpo, nome, escola_id, ""]
    );

    res.status(201).json({ message: "Professor cadastrado com sucesso." });
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") {
      return res
        .status(409)
        .json({ message: "Conflito de restrição no banco. Já existe este professor cadastrado com esta configuração exclusiva." });
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

    const [[profAtual]] = await pool.query(
      "SELECT cpf FROM professores WHERE id = ? AND escola_id = ?",
      [id, escola_id]
    );

    if (!profAtual) {
      return res.status(404).json({ message: "Professor não encontrado." });
    }

    const [[existente]] = await pool.query(
      "SELECT id FROM professores WHERE cpf = ? AND escola_id = ? AND disciplina_id = ? AND turno = ? AND id != ? LIMIT 1",
      [profAtual.cpf, escola_id, disciplina_id, turno, id]
    );

    if (existente) {
      return res.status(409).json({ message: "Já existe um pré-cadastro para este professor com esta mesma disciplina no mesmo turno." });
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
        .json({ message: "Conflito de restrição no banco. Já existe este professor cadastrado com esta configuração exclusiva." });
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
// PUT: Ativar professor (manual)
// ────────────────────────────────────────────────
router.put("/ativar/:id", async (req, res) => {
  try {
    const [result] = await pool.query(
      "UPDATE professores SET status = 'ativo' WHERE id = ?",
      [req.params.id]
    );
    if (!result.affectedRows) {
      return res.status(404).json({ message: "Professor não encontrado." });
    }
    res.json({ message: "Professor ativado com sucesso." });
  } catch (err) {
    console.error("Erro ao ativar professor:", err);
    res.status(500).json({ message: "Erro ao ativar professor." });
  }
});

// ────────────────────────────────────────────────
// DELETE: Excluir professor
// Limpa registros dependentes (modulação, preferências) antes de excluir
// ────────────────────────────────────────────────
router.delete("/:id", verificarEscola, async (req, res) => {
  try {
    const { id } = req.params;
    const { escola_id } = req.user;

    const [[prof]] = await pool.query(
      "SELECT cpf, nome FROM professores WHERE id = ? AND escola_id = ?",
      [id, escola_id]
    );
    if (!prof) return res.status(404).json({ message: "Professor não encontrado." });

    // 1) Limpa registros dependentes que impedem exclusão (FK sem CASCADE)
    await pool.query("DELETE FROM modulacao WHERE professor_id = ? AND escola_id = ?", [id, escola_id]);
    await pool.query("DELETE FROM prof_preferencias WHERE professor_id = ? AND escola_id = ?", [id, escola_id]);
    await pool.query("DELETE FROM grade_preferencias_professor WHERE professor_id = ?", [id]);
    await pool.query("DELETE FROM grade_alocacoes WHERE professor_id = ?", [id]);
    await pool.query("DELETE FROM grade_atribuicoes WHERE professor_id = ?", [id]);
    await pool.query("DELETE FROM grade_disponibilidades WHERE professor_id = ?", [id]);
    await pool.query("UPDATE grade_locks SET professor_id = NULL WHERE professor_id = ?", [id]);

    // 2) Exclui o professor
    await pool.query("DELETE FROM professores WHERE id = ? AND escola_id = ?", [id, escola_id]);

    // 3) Remove usuário vinculado (perfil professor)
    await pool.query(
      "DELETE FROM usuarios WHERE cpf = ? AND perfil = 'professor' AND escola_id = ?",
      [prof.cpf, escola_id]
    );

    res.json({ message: `Professor ${prof.nome} excluído com sucesso.` });
  } catch (err) {
    console.error("Erro ao excluir professor:", err);
    res.status(500).json({ message: "Erro ao excluir professor." });
  }
});

// ────────────────────────────────────────────────
// POST: Exclusão em lote de professores
// Body: { ids: [1, 2, 3, ...] }
// ────────────────────────────────────────────────
router.post("/excluir-lote", verificarEscola, async (req, res) => {
  try {
    const { ids } = req.body;
    const { escola_id } = req.user;

    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ message: "Nenhum professor selecionado." });
    }

    let excluidos = 0;
    const erros = [];

    for (const id of ids) {
      try {
        const [[prof]] = await pool.query(
          "SELECT cpf, nome FROM professores WHERE id = ? AND escola_id = ?",
          [id, escola_id]
        );
        if (!prof) continue;

        // Limpa dependências
        await pool.query("DELETE FROM modulacao WHERE professor_id = ? AND escola_id = ?", [id, escola_id]);
        await pool.query("DELETE FROM prof_preferencias WHERE professor_id = ? AND escola_id = ?", [id, escola_id]);
        await pool.query("DELETE FROM grade_preferencias_professor WHERE professor_id = ?", [id]);
        await pool.query("DELETE FROM grade_alocacoes WHERE professor_id = ?", [id]);
        await pool.query("DELETE FROM grade_atribuicoes WHERE professor_id = ?", [id]);
        await pool.query("DELETE FROM grade_disponibilidades WHERE professor_id = ?", [id]);
        await pool.query("UPDATE grade_locks SET professor_id = NULL WHERE professor_id = ?", [id]);

        // Exclui professor e usuário vinculado
        await pool.query("DELETE FROM professores WHERE id = ? AND escola_id = ?", [id, escola_id]);
        await pool.query(
          "DELETE FROM usuarios WHERE cpf = ? AND perfil = 'professor' AND escola_id = ?",
          [prof.cpf, escola_id]
        );
        excluidos++;
      } catch (innerErr) {
        erros.push({ id, erro: innerErr.message });
      }
    }

    res.json({
      message: `${excluidos} professor(es) excluído(s) com sucesso.`,
      excluidos,
      erros: erros.length > 0 ? erros : undefined,
    });
  } catch (err) {
    console.error("Erro na exclusão em lote:", err);
    res.status(500).json({ message: "Erro na exclusão em lote." });
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
// ────────────────────────────────────────────────
// PDF padrão do SIGeP (Secretaria de Educação) — layout ROTACIONADO 90°:
//   Eixo X = linha (cada pessoa tem X distinto)
//   Eixo Y = coluna:
//     y≈85 Nome do Servidor | y≈335 Cargo | y≈505 CPF
// Somente linhas com Cargo iniciando em "Professor" são importadas.
// CPFs com menos de 11 dígitos recebem zeros à esquerda.
// ────────────────────────────────────────────────
const uploadPdf = multer();
router.post("/importar-pdf", uploadPdf.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: "PDF não enviado." });

  // ── Multi-escola: escola_id obrigatório ──
  const escolaId = req.escola_id || req.user?.escola_id || (req.headers?.["x-escola-id"] ? Number(req.headers["x-escola-id"]) : null);
  if (!escolaId || Number.isNaN(Number(escolaId)) || Number(escolaId) <= 0) {
    return res.status(400).json({ message: "Escola não identificada. Faça login novamente." });
  }

  try {
    // ── PARSER POSICIONAL (layout rotacionado do SIGeP) ──
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
            page: pageData.pageNumber,
          });
        }
        return "";
      },
    };
    await pdfParse(req.file.buffer, parseOptions);

    // Colunas por faixa de Y (layout rotacionado)
    // Posições reais: Nome≈85, Cargo≈335, CPF≈505
    const COL_Y = {
      nome:  { min: 50,  max: 300 },
      cargo: { min: 300, max: 480 },
      cpf:   { min: 480, max: 560 },
    };

    function getCol(y) {
      for (const [col, range] of Object.entries(COL_Y)) {
        if (y >= range.min && y < range.max) return col;
      }
      return null;
    }

    // Agrupa items por linha (X + página) — cada pessoa tem X±1
    const rowsMap = {};
    for (const it of allItems) {
      if (it.x < 110) continue; // ignora headers (x≈99) e títulos
      const xKey = it.page * 10000 + Math.round(it.x / 3) * 3;
      if (!rowsMap[xKey]) rowsMap[xKey] = [];
      rowsMap[xKey].push(it);
    }

    const profs = [];
    const xKeys = Object.keys(rowsMap).map(Number).sort((a, b) => a - b);

    for (const xKey of xKeys) {
      const items = rowsMap[xKey];
      const rowData = {};
      for (const it of items) {
        const col = getCol(it.y);
        if (col) {
          rowData[col] = rowData[col] ? rowData[col] + " " + it.text : it.text;
        }
      }

      const nome  = (rowData.nome  || "").trim();
      const cargo = (rowData.cargo || "").trim();
      let cpf     = (rowData.cpf   || "").replace(/\D/g, "");

      if (!nome || !cargo) continue;

      // Filtra: somente cargos que iniciam com "Professor"
      if (!/^professor/i.test(cargo)) continue;

      // CPF com menos de 11 dígitos → zeros à esquerda
      if (cpf.length > 0 && cpf.length < 11) {
        cpf = cpf.padStart(11, "0");
      }

      if (cpf.length !== 11) continue; // sem CPF válido, pula

      profs.push({ cpf, nome, cargo });
    }

    // ── Fallback: se parser posicional não encontrou nada, tenta layout padrão ──
    if (profs.length === 0) {
      const { text } = await pdfParse(req.file.buffer);
      const linhas = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      for (const ln of linhas) {
        const m = ln.match(
          /^(\d[\d.]+[-\dxX])\s+([A-ZÁÉÍÓÚÂÊÔÃÕÇ\s.'-]+?)\s+(PROFESSOR[A-Z\s.]+?)\s+(\d{3,11})\s+/i
        );
        if (!m) continue;
        let cpf = m[4].replace(/\D/g, "");
        if (cpf.length < 11) cpf = cpf.padStart(11, "0");
        if (cpf.length !== 11) continue;
        profs.push({ cpf, nome: m[2].trim(), cargo: m[3].trim() });
      }
    }

    console.log(`[importar-pdf professores] Parser extraiu ${profs.length} professores`);

    // ── Sincronização com banco ──
    // Normaliza CPFs para comparação (banco pode ter pontos/traços)
    const normCpf = (c) => String(c || '').replace(/\D/g, '');
    const setCpfs = new Set(profs.map((p) => normCpf(p.cpf)));
    const [dbRowsAll] = await pool.query("SELECT id, cpf, status FROM professores WHERE escola_id = ?", [escolaId]);

    const dbActive = dbRowsAll.filter((r) => r.status === "ativo");
    const dbInactive = dbRowsAll.filter((r) => r.status !== "ativo");
    const setAllCpfs = new Set(dbRowsAll.map((r) => normCpf(r.cpf)));
    const setActiveCpfs = new Set(dbActive.map((r) => normCpf(r.cpf)));

    const jaExistiam = profs.filter((e) => setActiveCpfs.has(normCpf(e.cpf))).length;
    const toInsert = profs.filter((e) => !setAllCpfs.has(normCpf(e.cpf)));
    const toReactivate = profs.filter((e) =>
      dbInactive.some((r) => normCpf(r.cpf) === normCpf(e.cpf))
    );
    const toInactivate = dbActive.filter((r) => !setCpfs.has(normCpf(r.cpf)));

    // Insere novos
    let inseridos = 0;
    for (const e of toInsert) {
      await pool.query(
        "INSERT INTO professores (escola_id, cpf, nome, aulas, status) VALUES (?, ?, UPPER(?), 0, 'ativo')",
        [escolaId, e.cpf, e.nome]
      );
      await pool.query(
        `INSERT INTO usuarios (cpf, nome, perfil, escola_id, senha_hash) VALUES (?, UPPER(?), 'professor', ?, '')
           ON DUPLICATE KEY UPDATE nome=VALUES(nome)`,
        [e.cpf, e.nome, escolaId]
      );
      inseridos++;
    }

    // Reativa inativos
    let reativados = 0;
    for (const e of toReactivate) {
      await pool.query(
        "UPDATE professores SET status='ativo', nome=UPPER(?) WHERE cpf=? AND escola_id=?",
        [e.nome, e.cpf, escolaId]
      );
      await pool.query(
        `INSERT INTO usuarios (cpf, nome, perfil, escola_id, senha_hash) VALUES (?, UPPER(?), 'professor', ?, '')
           ON DUPLICATE KEY UPDATE nome=VALUES(nome)`,
        [e.cpf, e.nome, escolaId]
      );
      reativados++;
    }

    // Inativa ausentes
    let inativados = 0;
    for (const r of toInactivate) {
      await pool.query("UPDATE professores SET status='inativo' WHERE id=?", [r.id]);
      inativados++;
    }

    console.log(
      `[importar-pdf professores] → localizados: ${profs.length}, inseridos: ${inseridos}, reativados: ${reativados}, jáExistiam: ${jaExistiam}, inativados: ${inativados}`
    );

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

  // ── Multi-escola: escola_id obrigatório ──
  const escolaId = req.escola_id || req.user?.escola_id || (req.headers?.["x-escola-id"] ? Number(req.headers["x-escola-id"]) : null);
  if (!escolaId || Number.isNaN(Number(escolaId)) || Number(escolaId) <= 0) {
    return res.status(400).json({ message: "Escola não identificada. Faça login novamente." });
  }

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

    // Normaliza CPFs para comparação (banco pode ter pontos/traços)
    const normCpf = (c) => String(c || '').replace(/\D/g, '');
    const setCpfs = new Set(profs.map((p) => normCpf(p.cpf)));
    const [dbRowsAll] = await pool.query("SELECT id, cpf, status FROM professores WHERE escola_id = ?", [escolaId]);

    const dbActive = dbRowsAll.filter((r) => r.status === "ativo");
    const dbInactive = dbRowsAll.filter((r) => r.status !== "ativo");
    const setAllCpfs = new Set(dbRowsAll.map((r) => normCpf(r.cpf)));
    const setActiveCpfs = new Set(dbActive.map((r) => normCpf(r.cpf)));

    const jaExistiam = profs.filter((e) => setActiveCpfs.has(normCpf(e.cpf))).length;
    const toInsert = profs.filter((e) => !setAllCpfs.has(normCpf(e.cpf)));
    const toReactivate = profs.filter((e) =>
      dbInactive.some((r) => normCpf(r.cpf) === normCpf(e.cpf))
    );
    const toInactivate = dbActive.filter((r) => !setCpfs.has(normCpf(r.cpf)));

    // Inserir novos
    let inseridos = 0;
    for (const e of toInsert) {
      await pool.query(
        "INSERT INTO professores (escola_id, cpf, nome, aulas, status) VALUES (?, ?, UPPER(?), 0, 'ativo')",
        [escolaId, e.cpf, e.nome]
      );
      await pool.query(
        `INSERT INTO usuarios (cpf, nome, perfil, escola_id, senha_hash) VALUES (?, UPPER(?), 'professor', ?, '')
           ON DUPLICATE KEY UPDATE nome=VALUES(nome)`,
        [e.cpf, e.nome, escolaId]
      );
      inseridos++;
    }

    // Reativar inativos
    let reativados = 0;
    for (const e of toReactivate) {
      await pool.query(
        "UPDATE professores SET status='ativo', nome=UPPER(?) WHERE cpf=? AND escola_id=?",
        [e.nome, e.cpf, escolaId]
      );
      await pool.query(
        `INSERT INTO usuarios (cpf, nome, perfil, escola_id, senha_hash) VALUES (?, UPPER(?), 'professor', ?, '')
           ON DUPLICATE KEY UPDATE nome=VALUES(nome)`,
        [e.cpf, e.nome, escolaId]
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
