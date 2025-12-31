// ============================================================================
// routes/ferramentasNotaUnificar.js
// Unificar XLSX (NOTA): recebe múltiplos .xlsx, concatena e devolve 1 arquivo.
// Montagem recomendada no server.js:
//   app.use("/api/ferramentas/unir", autenticarToken, verificarEscola, ferramentasNotaUnificarRouter);
//
// Este router expõe ambos os paths internos (compat):
//   POST /unificar-xlsx           -> /api/ferramentas/unir/unificar-xlsx
//   POST /nota/unificar-xlsx      -> /api/ferramentas/unir/nota/unificar-xlsx
// Assim evitamos 404 por pequeno desvio de prefixo.
// ============================================================================

import express from "express";
import multer from "multer";
import pool from "../db.js";
import { buildUnifiedWorkbookBuffer } from "../services/xlsxUnifierService.js";

const router = express.Router();

// ---------------------------------------------------------------------------
// Diagnóstico rápido (precisa de token pois o prefixo está protegido no server)
// ---------------------------------------------------------------------------
router.get("/ping", (req, res) => {
  res.json({ ok: true, router: "unir", when: new Date().toISOString() });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function requireEscola(req, res, next) {
  const escolaId = req.user?.escola_id || Number(req.headers["x-escola-id"]);
  if (!escolaId) return res.status(403).json({ error: "Acesso negado: escola não definida." });
  req.escolaId = Number(escolaId);
  next();
}
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { files: 100, fileSize: 20 * 1024 * 1024 },
});
function asInt(v, def = null) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : def;
}
function ts() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return (
    d.getFullYear().toString() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    "-" +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
}

// ---------------------------------------------------------------------------
// Handler principal (fiz função para reutilizar nos dois paths)
// ---------------------------------------------------------------------------
async function handleUnificarXlsx(req, res) {
  try {
    console.log("[UNIR] POST", req.originalUrl);

    const { ano, bimestre, observacao } = req.body || {};
    const escolaId = req.escolaId;

    // Filtra somente .xlsx
    const all = Array.isArray(req.files) ? req.files : [];
    const xlsxFiles = all.filter(
      (f) =>
        /\.xlsx$/i.test(f.originalname || "") ||
        (f.mimetype && /spreadsheetml/.test(f.mimetype))
    );
    if (xlsxFiles.length === 0) {
      return res.status(400).json({ error: "Nenhum arquivo .xlsx recebido." });
    }

    // Unifica
    const { buffer, alunosTotal, colunas, linhasTotais } = await buildUnifiedWorkbookBuffer(xlsxFiles);

    // Versionamento opcional por ano/bimestre
    const anoInt = asInt(ano);
    const bimestreInt = asInt(bimestre);
    let versao = 1;
    if (anoInt && bimestreInt) {
      const [rows] = await pool.query(
        `SELECT COALESCE(MAX(versao),0) AS v FROM nota_unificacoes
         WHERE escola_id=? AND ano=? AND bimestre=?`,
        [escolaId, anoInt, bimestreInt]
      );
      versao = Number(rows?.[0]?.v || 0) + 1;
    }

    await pool.query(
      `INSERT INTO nota_unificacoes
         (escola_id, ano, bimestre, versao, arquivos_qtd, alunos_total, colunas_json, observacao, arquivo_mime, arquivo_nome, created_by)
       VALUES (?, ?, ?, ?, ?, ?, CAST(? AS JSON), ?, ?, ?, ?)`,
      [
        escolaId,
        anoInt,
        bimestreInt,
        versao,
        xlsxFiles.length,
        alunosTotal,
        JSON.stringify(colunas),
        observacao || null,
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        `Notas_Unificado_${ts()}.xlsx`,
        req.user?.id || null,
      ]
    );

    const filename = `Notas_Unificado_${ts()}.xlsx`;
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(filename)}"`);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("X-Xlsx-Count", String(xlsxFiles.length));
    res.setHeader("X-Alunos-Total", String(alunosTotal ?? linhasTotais ?? 0));
    return res.status(200).send(buffer);
  } catch (e) {
    console.error("POST /unificar-xlsx ERROR:", e);
    return res.status(500).json({ error: "Falha ao unificar planilhas." });
  }
}

// ---------------------------------------------------------------------------
// Rotas (duas assinaturas compatíveis)
// ---------------------------------------------------------------------------
router.post("/unificar-xlsx", requireEscola, upload.array("files"), handleUnificarXlsx);
router.post("/nota/unificar-xlsx", requireEscola, upload.array("files"), handleUnificarXlsx);

export default router;
