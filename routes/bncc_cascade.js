// routes/bncc_cascade.js — importado estaticamente (sem feature flag)
import { Router } from "express";
import { autorizarPermissao } from "../middleware/autorizarPermissao.js";

const router = Router();

function normTxt(s) {
  return String(s || "").trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

async function resolveComponenteByNome(db, nomeDisc) {
  const n = normTxt(nomeDisc || "");
  let keyword = null;
  if      (n.includes("matemat"))  keyword = "matem";
  else if (n.includes("portugues")) keyword = "portugu";
  else if (n.includes("cienc"))    keyword = "cienc";
  else if (n.includes("geograf"))  keyword = "geogr";
  else if (n.includes("histor"))   keyword = "hist";
  else if (n.includes("arte"))     keyword = "arte";
  else if (n.includes("fisica") || (n.includes("ed") && n.includes("fis"))) keyword = "sica";
  else if (n.includes("ingl"))     keyword = "ingl";
  if (!keyword) return null;
  try {
    const [rows] = await db.query(
      `SELECT id, disciplina_id FROM bncc_componentes
       WHERE ativo = 1 AND LOWER(CONVERT(nome USING ASCII)) LIKE ? LIMIT 1`,
      [`%${keyword}%`]
    );
    return rows?.[0] || null;
  } catch { return null; }
}

/**
 * GET /api/conteudos/admin/bncc/unidades
 * ?disciplina_nome=MATEMÁTICA&ano_id=6
 */
router.get(
  "/conteudos/admin/bncc/unidades",
  autorizarPermissao("conteudos.visualizar"),
  async (req, res) => {
    try {
      const disciplina_nome = req.query.disciplina_nome || "";
      const ano_id = Number(req.query.ano_id);
      if (!disciplina_nome || !ano_id)
        return res.status(400).json({ ok: false, message: "disciplina_nome e ano_id são obrigatórios." });
      const db = req.db;
      const comp = await resolveComponenteByNome(db, disciplina_nome);
      if (!comp) return res.json({ ok: true, unidades: [] });
      const [rows] = await db.query(
        `SELECT id, nome AS texto FROM bncc_unidades_tematicas
         WHERE componente_id = ? AND ano_id = ? ORDER BY nome ASC LIMIT 500`,
        [comp.id, ano_id]
      );
      return res.json({ ok: true, unidades: rows || [] });
    } catch (err) {
      console.error("Erro GET /bncc/unidades:", err);
      return res.status(500).json({ ok: false, message: "Erro interno." });
    }
  }
);

/**
 * GET /api/conteudos/admin/bncc/objetos
 * ?unidade_tematica_id=X
 */
router.get(
  "/conteudos/admin/bncc/objetos",
  autorizarPermissao("conteudos.visualizar"),
  async (req, res) => {
    try {
      const unidade_tematica_id = Number(req.query.unidade_tematica_id);
      if (!unidade_tematica_id)
        return res.status(400).json({ ok: false, message: "unidade_tematica_id é obrigatório." });
      const db = req.db;
      const [rows] = await db.query(
        `SELECT id, nome AS texto FROM bncc_objetos_conhecimento
         WHERE unidade_tematica_id = ? ORDER BY nome ASC LIMIT 500`,
        [unidade_tematica_id]
      );
      return res.json({ ok: true, objetos: rows || [] });
    } catch (err) {
      console.error("Erro GET /bncc/objetos:", err);
      return res.status(500).json({ ok: false, message: "Erro interno." });
    }
  }
);

/**
 * GET /api/conteudos/admin/seedf/conteudos
 * ?disciplina_nome=PORTUGUÊS&serie=6º ANO[&unidade_tematica_id=Z]
 */
router.get(
  "/conteudos/admin/seedf/conteudos",
  autorizarPermissao("conteudos.visualizar"),
  async (req, res) => {
    try {
      const disciplina_nome = req.query.disciplina_nome || "";
      const serie = String(req.query.serie || "").trim();
      const unidade_tematica_id = req.query.unidade_tematica_id ? Number(req.query.unidade_tematica_id) : null;
      if (!disciplina_nome || !serie)
        return res.status(400).json({ ok: false, message: "disciplina_nome e serie são obrigatórios." });
      const db = req.db;
      const comp = await resolveComponenteByNome(db, disciplina_nome);
      if (!comp) return res.json({ ok: true, conteudos: [] });
      const params = [comp.disciplina_id, serie];
      let whereExtra = "";
      if (unidade_tematica_id) { whereExtra = " AND bncc_unidade_tematica_id = ?"; params.push(unidade_tematica_id); }
      const [rows] = await db.query(
        `SELECT id, texto FROM seedf_conteudos
         WHERE disciplina_id = ? AND serie = ? AND ativo = 1 ${whereExtra}
         ORDER BY texto ASC LIMIT 800`,
        params
      );
      return res.json({ ok: true, conteudos: rows || [] });
    } catch (err) {
      console.error("Erro GET /seedf/conteudos:", err);
      return res.status(500).json({ ok: false, message: "Erro interno." });
    }
  }
);

export default router;
