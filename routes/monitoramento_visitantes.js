// ============================================================================
// routes/monitoramento_visitantes.js
// Módulo: Monitoramento > Visitantes
// Endpoints:
//   GET    /api/monitoramento/visitantes/ping        (diagnóstico - deve responder 200 ok)
//   GET    /api/monitoramento/visitantes/historico   (lista + filtros + paginação)
//   POST   /api/monitoramento/visitantes             (registrar entrada)
//   PATCH  /api/monitoramento/visitantes/:id/saida   (marcar saída)
//   GET    /api/monitoramento/visitantes/debug       (diagnóstico do router - confirma caminho)
//   POST   /api/monitoramento/visitantes/debug       (diagnóstico do router - ecoa body)
// ============================================================================

import express from "express";
import pool from "../db.js";
import { autenticarToken } from "../middleware/autenticarToken.js";
import { verificarEscola } from "../middleware/verificarEscola.js";

// ---------- NOVO: libs para salvar imagem ----------
import fs from "fs";
import path from "path";
import sharp from "sharp";

const router = express.Router();

// ----------------------------------------------------------------------------
// Logger do Router (NÃO altera fluxo; apenas registra passagem pelo router)
// ----------------------------------------------------------------------------
router.use((req, _res, next) => {
  try {
    console.log(`[VISITANTES ROUTER] ${req.method} ${req.originalUrl}`);
  } catch (_) {}
  next();
});

// ---------- Helpers ----------
function getEscolaId(req) {
  const a = req.escola_id;
  const b = Number(req.headers["x-escola-id"]);
  const c = Number(req.body?.escola_id);
  return a || b || c || null;
}
function enumCategoria(cat) {
  if (!cat) return "OUTRO";
  const v = String(cat).trim().toUpperCase();
  const allow = new Set(["RESPONSAVEL", "ENTREGA", "PRESTADOR", "OUTRO"]);
  return allow.has(v) ? v : "OUTRO";
}
function safeStr(s, max = 255) {
  if (s == null) return null;
  const str = String(s);
  return str.length > max ? str.slice(0, max) : str;
}

// ---------- NOVO: helpers para arquivo ----------
function slugify(s) {
  if (!s) return "";
  return String(s)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
}
function resolveEscolaApelido(req) {
  // 1) header explícito
  const h = req.headers["x-escola-apelido"];
  if (h && String(h).trim()) return slugify(h);
  // 2) possíveis preenchimentos de middlewares
  if (req.escola_apelido) return slugify(req.escola_apelido);
  if (req.nome_escola) return slugify(req.nome_escola);
  // 3) fallback seguro (mantém seu ambiente atual funcionando)
  return "CEF04_PLAN";
}
function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}
function parseDataUrl(dataUrl) {
  const m = String(dataUrl || "").match(
    /^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/
  );
  if (!m) return null;
  return { mime: m[1].toLowerCase(), b64: m[2] };
}

// ============================================================================
// 🔎 Diagnóstico rápido de montagem do router
// ============================================================================
router.get("/visitantes/ping", (req, res) => {
  res.json({
    ok: true,
    message: "monitoramento_visitantes router MONTADO ✅",
    hint:
      "Se isso responde 200 no navegador, as rotas abaixo também estão montadas.",
  });
});

// ============================================================================
// 🔎 Endpoint de DEBUG (confirma caminho e ecoa dados)
// ============================================================================
router.get("/visitantes/debug", (req, res) => {
  res.json({
    ok: true,
    message: "DEBUG GET — router ativo e caminho correto.",
    method: req.method,
    url: req.originalUrl,
    query: req.query || {},
  });
});

router.post("/visitantes/debug", (req, res) => {
  res.json({
    ok: true,
    message: "DEBUG POST — body ecoado com sucesso.",
    method: req.method,
    url: req.originalUrl,
    body: req.body || {},
  });
});

// ============================================================================
// GET /api/monitoramento/visitantes/historico
// ============================================================================
router.get(
  "/visitantes/historico",
  autenticarToken,
  verificarEscola,
  async (req, res) => {
    try {
      const escola_id = getEscolaId(req);
      if (!escola_id)
        return res.status(400).json({ message: "escola_id ausente." });

      const {
        de,
        ate,
        categoria,
        status,
        q,
        // filtros finos
        nome,
        documento,
        empresa,
        autorizador,
        aluno_codigo,
        portao,
        com_foto,
        sem_saida,
        // paginação
        page = 1,
        pageSize = 10,
        // ordenação
        sort = "entrada",
        order = "desc",
      } = req.query;

      const offset = (Number(page) - 1) * Number(pageSize);

      const where = ["v.escola_id = ?"];
      const params = [escola_id];

      if (de) {
        where.push("DATE(v.entrada_em) >= ?");
        params.push(de);
      }
      if (ate) {
        where.push("DATE(v.entrada_em) <= ?");
        params.push(ate);
      }
      if (categoria) {
        where.push("v.categoria = ?");
        params.push(enumCategoria(categoria));
      }
      if (status) {
        where.push("v.status = ?");
        params.push(status);
      }

      if (q) {
        where.push(
          "(v.nome LIKE ? OR v.documento LIKE ? OR v.empresa LIKE ? OR v.autorizador LIKE ?)"
        );
        params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
      }

      if (nome) {
        where.push("v.nome LIKE ?");
        params.push(`%${nome}%`);
      }
      if (documento) {
        where.push("v.documento LIKE ?");
        params.push(`%${documento}%`);
      }
      if (empresa) {
        where.push("v.empresa LIKE ?");
        params.push(`%${empresa}%`);
      }
      if (autorizador) {
        where.push("v.autorizador LIKE ?");
        params.push(`%${autorizador}%`);
      }
      if (aluno_codigo) {
        where.push("v.aluno_codigo LIKE ?");
        params.push(`%${aluno_codigo}%`);
      }
      if (portao) {
        where.push("v.portao = ?");
        params.push(portao);
      }
      if (
        String(com_foto).toLowerCase() === "1" ||
        String(com_foto).toLowerCase() === "true"
      ) {
        where.push("(v.fotoUrl IS NOT NULL AND v.fotoUrl <> '')");
      }
      if (
        String(sem_saida).toLowerCase() === "1" ||
        String(sem_saida).toLowerCase() === "true"
      ) {
        where.push("v.saida_em IS NULL");
      }

      const whereSQL = "WHERE " + where.join(" AND ");

      const sortMap = {
        entrada: "v.entrada_em",
        saida: "v.saida_em",
        nome: "v.nome",
        categoria: "v.categoria",
        status: "v.status",
        criado: "v.criado_em",
      };
      const sortCol = sortMap[String(sort).toLowerCase()] || sortMap.entrada;
      const ord = String(order).toLowerCase() === "asc" ? "ASC" : "DESC";

      const [rows] = await pool.query(
        `
        SELECT
          v.*,
          u.nome AS usuario_nome
        FROM monitoramento_visitantes v
        LEFT JOIN usuarios u ON u.id = v.registrado_por
        ${whereSQL}
        ORDER BY ${sortCol} ${ord}
        LIMIT ? OFFSET ?
        `,
        [...params, Number(pageSize), Number(offset)]
      );

      const [[{ total }]] = await pool.query(
        `SELECT COUNT(*) AS total FROM monitoramento_visitantes v ${whereSQL}`,
        params
      );

      res.json({
        items: rows,
        total,
        page: Number(page),
        pageSize: Number(pageSize),
      });
    } catch (err) {
      console.error("❌ Erro ao listar visitantes:", err);
      res
        .status(500)
        .json({
          message: "Erro interno ao listar visitantes.",
          dev: String(err.message || err),
        });
    }
  }
);

// ============================================================================
// POST /api/monitoramento/visitantes
//   • Trata foto_base64 -> JPEG (max 1024, q=0.8) e salva em
//     /uploads/<APELIDO>/monitoramento/YYYY/MM/<arquivo>.jpg
//   • E.6.5.5 — Segurança e limites:
//       - Limite ~5MB (Buffer) para foto_base64;
//       - MIME permitido (jpeg/jpg/png/webp);
//       - Caminho seguro (normalize + prefix check);
//       - Falhas de imagem NÃO quebram o POST (segue sem foto).
//   • Mantém a persistência já validada; após o INSERT, faz UPDATE apenas
//     dos campos opcionais que existirem no payload (inclui fotoUrl).
// ============================================================================
router.post(
  "/visitantes",
  autenticarToken,
  verificarEscola,
  async (req, res) => {
    try {
      const escola_id = getEscolaId(req);
      const usuario_id = req.usuario_id || req.usuarioId || null;
      if (!escola_id)
        return res.status(400).json({ message: "escola_id é obrigatório." });

      const {
        nome,
        documento,
        categoria,
        observacao,
        empresa,
        motivo,
        aluno_codigo,
        autorizador,
        portao,
        fotoUrl, // pode vir nulo
        foto_base64, // prioridade sobre fotoUrl
      } = req.body || {};

      if (!nome || !String(nome).trim()) {
        return res.status(400).json({ message: "Campo 'nome' é obrigatório." });
      }

      // Normalizações (mantidas)
      const cat = enumCategoria(categoria);
      const doc = safeStr(documento, 30);
      const obs = safeStr(observacao, 255);
      const emp = safeStr(empresa, 120);
      const mot = safeStr(motivo, 120);
      const port = safeStr(portao, 50);
      const aut = safeStr(autorizador, 120);
      const aluno = safeStr(aluno_codigo, 30);

      // ================== Foto (com segurança/limites) ==================
      let finalFotoUrl = safeStr(fotoUrl, 255) || null;

      if (foto_base64) {
        // Tudo de imagem protegido por try/catch — falhas não quebram o POST
        try {
          const parsed = parseDataUrl(foto_base64);
          if (!parsed) {
            throw new Error(
              "foto_base64 inválido. Esperado data:image/...;base64,..."
            );
          }

          const allowed = new Set([
            "image/jpeg",
            "image/jpg",
            "image/png",
            "image/webp",
          ]);
          if (!allowed.has(parsed.mime)) {
            throw new Error(`Formato de imagem não suportado (${parsed.mime}).`);
          }

          // Limite de ~5MB (após decodificação base64)
          const buf = Buffer.from(parsed.b64, "base64");
          const MAX_BYTES = 5 * 1024 * 1024; // 5 MB
          if (!buf.length || buf.length > MAX_BYTES) {
            throw new Error(
              `Imagem excede o limite (~5MB). Tamanho recebido: ${buf.length} bytes.`
            );
          }

          // Pasta final segura: /uploads/<APELIDO>/monitoramento/YYYY/MM
          const apelido = resolveEscolaApelido(req); // ex.: CEF04_PLAN
          const yyyy = String(new Date().getFullYear());
          const mm = String(new Date().getMonth() + 1).padStart(2, "0");

          const baseUploads = path.resolve(process.cwd(), "uploads");
          const safeBase = baseUploads; // prefixo permitido
          const targetDir = path.join(
            baseUploads,
            apelido,
            "monitoramento",
            yyyy,
            mm
          );

          // normalize + verificação de prefixo para evitar path traversal
          const normTargetDir = path.normalize(targetDir);
          if (!normTargetDir.startsWith(safeBase)) {
            throw new Error("Caminho de upload inválido.");
          }

          ensureDir(normTargetDir);

          // Nome de arquivo (timestamp + rand)
          const rand = Math.random().toString(36).slice(2, 8);
          const filename = `visit_${Date.now()}_${rand}.jpg`;
          const absPath = path.join(normTargetDir, filename);

          // Conversão/normalização com sharp -> jpeg, max 1024px
          const img = sharp(buf, { failOnError: false });
          const meta = await img.metadata();
          const w = meta.width || 0;
          const h = meta.height || 0;
          const needResize = Math.max(w, h) > 1024;

          let pipeline = img.rotate(); // respeita EXIF
          if (needResize) {
            pipeline = pipeline.resize({
              width: w >= h ? 1024 : null,
              height: w < h ? 1024 : null,
              fit: "inside",
              withoutEnlargement: true,
            });
          }
          pipeline = pipeline.jpeg({ quality: 80 });

          await pipeline.toFile(absPath);

          // URL pública (servida pelo express static em /uploads)
          finalFotoUrl = `/uploads/${apelido}/monitoramento/${yyyy}/${mm}/${filename}`;
        } catch (imgErr) {
          // Falhou a imagem? Não aborta o cadastro — apenas segue sem foto.
          finalFotoUrl = null;
          console.warn(
            "[MONITORAMENTO] Foto ignorada:",
            imgErr?.message || imgErr
          );
        }
      }
      // ================== /Foto (com segurança/limites) ==================

      // Log no console para debug
      console.log("🟢 Novo visitante recebido:");
      console.table({
        escola_id,
        nome,
        doc,
        cat,
        obs,
        empresa: emp,
        motivo: mot,
        portao: port,
        autorizador: aut,
        aluno_codigo: aluno,
        fotoUrl: finalFotoUrl || "(null)",
        usuario_id,
      });

      // Inserção simples (mantida) — mantém compatibilidade
      const [result] = await pool.query(
        `
        INSERT INTO monitoramento_visitantes
          (escola_id, nome, documento, categoria, observacao, registrado_por)
        VALUES (?, ?, ?, ?, ?, ?)
        `,
        [escola_id, String(nome).trim(), doc, cat, obs, usuario_id]
      );

      const novoId = result.insertId;

      // UPDATE complementar apenas dos campos opcionais que vierem
      const updates = [];
      const uParams = [];

      if (emp != null) {
        updates.push("empresa = ?");
        uParams.push(emp);
      }
      if (mot != null) {
        updates.push("motivo = ?");
        uParams.push(mot);
      }
      if (aluno != null) {
        updates.push("aluno_codigo = ?");
        uParams.push(aluno);
      }
      if (aut != null) {
        updates.push("autorizador = ?");
        uParams.push(aut);
      }
      if (port != null) {
        updates.push("portao = ?");
        uParams.push(port);
      }
      if (finalFotoUrl) {
        updates.push("fotoUrl = ?");
        uParams.push(finalFotoUrl);
      }

      if (updates.length) {
        await pool.query(
          `UPDATE monitoramento_visitantes SET ${updates.join(
            ", "
          )} WHERE id = ? AND escola_id = ?`,
          [...uParams, novoId, escola_id]
        );
      }

      res.status(201).json({
        message: "Visitante registrado com sucesso.",
        id: novoId,
        fotoUrl: finalFotoUrl || null,
      });
    } catch (err) {
      console.error("❌ Erro ao registrar visitante:", err);
      res.status(500).json({
        message: "Erro interno ao registrar visitante.",
        dev: String(err.message || err),
      });
    }
  }
);

// ============================================================================
// PATCH /api/monitoramento/visitantes/:id/saida
// ============================================================================
router.patch(
  "/visitantes/:id/saida",
  autenticarToken,
  verificarEscola,
  async (req, res) => {
    try {
      const id = Number(req.params.id);
      const escola_id = getEscolaId(req);
      if (!id || !escola_id)
        return res.status(400).json({ message: "Parâmetros inválidos." });

      const [result] = await pool.query(
        `
        UPDATE monitoramento_visitantes
        SET status = 'FINALIZADO', saida_em = NOW()
        WHERE id = ? AND escola_id = ?
        `,
        [id, escola_id]
      );

      if (result.affectedRows === 0)
        return res.status(404).json({ message: "Visitante não encontrado." });

      res.json({ message: "Saída registrada com sucesso." });
    } catch (err) {
      console.error("❌ Erro ao registrar saída:", err);
      res.status(500).json({
        message: "Erro interno ao atualizar saída.",
        dev: String(err.message || err),
      });
    }
  }
);

export default router;
