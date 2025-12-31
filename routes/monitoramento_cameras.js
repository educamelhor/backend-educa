// routes/monitoramento_cameras.js
// CRUD mínimo de câmeras de monitoramento (multi-escola)
// Retorna lista "segura" para o painel (sem expor rtsp_url por padrão)

import express from "express";
const router = express.Router();

// Util: obter escola_id do header ou token (ajuste se já houver middleware)
function getEscolaId(req) {
  const raw = req.headers["x-escola-id"] || req.headers["x-escolaid"];
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

// LISTAR (painel) - sem rtsp_url
router.get("/", async (req, res) => {
  try {
    const escola_id = getEscolaId(req);
    if (!escola_id) return res.status(400).json({ error: "x-escola-id ausente" });

    const [rows] = await req.db.query(
      `SELECT id, escola_id, nome, slug, tipo, enabled, ordem, created_at, updated_at
         FROM monitoramento_cameras
        WHERE escola_id = ?
        ORDER BY ordem ASC, id ASC`,
      [escola_id]
    );

    // status inicial "UNKNOWN" (worker ainda não reporta)
    const data = rows.map((c) => ({ ...c, status: "UNKNOWN" }));
    res.json({ items: data });
  } catch (err) {
    console.error("[monitoramento_cameras] GET / ::", err);
    res.status(500).json({ error: "Falha ao listar câmeras" });
  }
});

// OBTER (admin) - inclui rtsp_url (se precisar em tela de edição)
router.get("/:id", async (req, res) => {
  try {
    const escola_id = getEscolaId(req);
    if (!escola_id) return res.status(400).json({ error: "x-escola-id ausente" });

    const [rows] = await req.db.query(
      `SELECT * FROM monitoramento_cameras WHERE id = ? AND escola_id = ?`,
      [req.params.id, escola_id]
    );
    if (!rows.length) return res.status(404).json({ error: "Câmera não encontrada" });
    res.json(rows[0]);
  } catch (err) {
    console.error("[monitoramento_cameras] GET /:id ::", err);
    res.status(500).json({ error: "Falha ao carregar câmera" });
  }
});

// CRIAR
router.post("/", async (req, res) => {
  try {
    const escola_id = getEscolaId(req);
    if (!escola_id) return res.status(400).json({ error: "x-escola-id ausente" });

    const { nome, slug, rtsp_url = null, tipo = "rtsp", enabled = 1, ordem = 1 } = req.body || {};
    if (!nome || !slug) return res.status(422).json({ error: "nome e slug obrigatórios" });

    await req.db.query(
      `INSERT INTO monitoramento_cameras (escola_id, nome, slug, rtsp_url, tipo, enabled, ordem)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [escola_id, String(nome).trim(), String(slug).trim(), rtsp_url, String(tipo).trim(), Number(enabled) ? 1 : 0, Number(ordem) || 1]
    );

    res.status(201).json({ message: "Câmera criada" });
  } catch (err) {
    console.error("[monitoramento_cameras] POST / ::", err);
    if (String(err?.message || "").includes("uq_cameras_escola_slug")) {
      return res.status(409).json({ error: "Slug já utilizado nesta escola" });
    }
    res.status(500).json({ error: "Falha ao criar câmera" });
  }
});

// ATUALIZAR
router.patch("/:id", async (req, res) => {
  try {
    const escola_id = getEscolaId(req);
    if (!escola_id) return res.status(400).json({ error: "x-escola-id ausente" });

    const id = Number(req.params.id);
    const allowed = ["nome", "slug", "rtsp_url", "tipo", "enabled", "ordem"];
    const sets = [];
    const vals = [];
    for (const k of allowed) {
      if (k in req.body) {
        sets.push(`${k} = ?`);
        vals.push(k === "enabled" ? (req.body[k] ? 1 : 0) : req.body[k]);
      }
    }
    if (!sets.length) return res.status(400).json({ error: "Nada para atualizar" });

    vals.push(id, escola_id);
    const [r] = await req.db.query(
      `UPDATE monitoramento_cameras
          SET ${sets.join(", ")}, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND escola_id = ?`,
      vals
    );

    if (!r.affectedRows) return res.status(404).json({ error: "Câmera não encontrada" });
    res.json({ message: "Câmera atualizada" });
  } catch (err) {
    console.error("[monitoramento_cameras] PATCH /:id ::", err);
    res.status(500).json({ error: "Falha ao atualizar câmera" });
  }
});

// EXCLUIR
router.delete("/:id", async (req, res) => {
  try {
    const escola_id = getEscolaId(req);
    if (!escola_id) return res.status(400).json({ error: "x-escola-id ausente" });

    const [r] = await req.db.query(
      `DELETE FROM monitoramento_cameras WHERE id = ? AND escola_id = ?`,
      [req.params.id, escola_id]
    );
    if (!r.affectedRows) return res.status(404).json({ error: "Câmera não encontrada" });

    res.json({ message: "Câmera excluída" });
  } catch (err) {
    console.error("[monitoramento_cameras] DELETE /:id ::", err);
    res.status(500).json({ error: "Falha ao excluir câmera" });
  }
});

export default router;
