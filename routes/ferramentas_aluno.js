// src/routes/ferramentas_aluno.js
// ============================================================================
// Ferramentas → ALUNO (PDF) → ALUNO (XLSX)
// POST /api/ferramentas/converter-aluno
// - Extrai alunos de PDFs SEDF (ex.: "<codigo> <NOME> <dd/mm/aaaa>" ... "M|F <cpf>").
// - Cabeçalhos do XLSX: codigo | estudante | data | sexo
// - NENHUM acesso ao banco.
// - Headers de debug: X-Converter-Version: aluno-v3
//   • Se nada casar, retorna 400 com preview para diagnóstico rápido.
// ============================================================================

import express from "express";
import multer from "multer";
import * as XLSX from "xlsx";
import pdfParse from "pdf-parse";

console.info("[FerramentasAluno] rota carregada (aluno-v3)");

const router = express.Router();

// ---------------------------------------------------------------------------
// Upload em memória
// ---------------------------------------------------------------------------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok =
      file.mimetype === "application/pdf" ||
      /\.pdf$/i.test(file.originalname || "");
    if (!ok) return cb(new Error("Apenas arquivos PDF são aceitos."));
    cb(null, true);
  },
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function sanitizeFilename(name) {
  return String(name || "arquivo")
    .replace(/[\\/:*?"<>|\r\n]+/g, "_")
    .slice(0, 150);
}

// Estratégia A: bloco em 1 linha  → "<codigo> <NOME> <dd/mm/aaaa>"
const RE_LINHA_UNICA =
  /^(\d{3,})\s+([A-Za-zÀ-ÖØ-öø-ÿ'´`^~.\- ]+?)\s+(\d{2}\/\d{2}\/\d{4})$/;

// Estratégia B: linha com código + nome, e data na linha seguinte
const RE_LINHA_CODIGO_NOME =
  /^(\d{3,})\s+([A-Za-zÀ-ÖØ-öø-ÿ'´`^~.\- ]+)$/;
const RE_DATA = /^(\d{2}\/\d{2}\/\d{4})$/;
const RE_SEXO = /^(M|F)\b/i;

// Extrai alunos (tenta duas estratégias)
function extrairAlunos(text) {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const alunos = [];

  for (let i = 0; i < lines.length; i++) {
    const l1 = lines[i];

    // --- Estrategia A: tudo em 1 linha
    let m = l1.match(RE_LINHA_UNICA);
    if (m) {
      const codigo = m[1].trim();
      const estudante = m[2].replace(/\s+/g, " ").trim();
      const data = m[3];

      // sexo nas próximas linhas
      let sexo = "";
      for (let j = i + 1; j <= i + 4 && j < lines.length; j++) {
        const sx = lines[j].match(RE_SEXO);
        if (sx) {
          sexo = sx[1].toUpperCase();
          break;
        }
      }

      alunos.push({ codigo, estudante, data, sexo });
      continue;
    }

    // --- Estrategia B: código + nome, depois data
    m = l1.match(RE_LINHA_CODIGO_NOME);
    if (m) {
      const codigo = m[1].trim();
      const estudante = m[2].replace(/\s+/g, " ").trim();

      // procurar data nas próximas 1–3 linhas
      let data = "";
      let sexo = "";
      for (let j = i + 1; j <= i + 4 && j < lines.length; j++) {
        const lj = lines[j];
        if (!data) {
          const dm = lj.match(RE_DATA);
          if (dm) {
            data = dm[1];
            continue;
          }
        }
        if (!sexo) {
          const sm = lj.match(RE_SEXO);
          if (sm) sexo = sm[1].toUpperCase();
        }
        if (data && sexo) break;
      }

      if (data) alunos.push({ codigo, estudante, data, sexo });
    }
  }

  return alunos;
}

// ---------------------------------------------------------------------------
// POST /api/ferramentas/converter-aluno
// ---------------------------------------------------------------------------
router.post("/converter-aluno", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, error: "Envie o PDF no campo 'file'." });
    }

    const base =
      sanitizeFilename(req.file.originalname || "alunos")
        .replace(/\.[Pp][Dd][Ff]$/, "") || "alunos";
    const downloadName = `${base}_ALUNOS_v3.xlsx`;

    const { text } = await pdfParse(req.file.buffer);
    const alunos = extrairAlunos(text);

    res.setHeader("X-Converter-Version", "aluno-v3");
    res.setHeader("X-Row-Count", String(alunos.length));
    res.setHeader(
      "Access-Control-Expose-Headers",
      "Content-Disposition, X-Filename, X-Converter-Version, X-Row-Count"
    );

    if (!alunos.length) {
      // ajuda no diagnóstico quando nada casou
      const preview = text.split(/\r?\n/).slice(0, 40).join("\n");
      return res.status(400).json({
        ok: false,
        error: "Nenhum aluno localizado no PDF.",
        hint: "Verifique o layout das linhas (codigo, nome, data, sexo).",
        preview,
      });
    }

    // Monta XLSX com colunas exatas
    const headers = ["codigo", "estudante", "data", "sexo"];
    const rows = alunos.map((a) => [a.codigo, a.estudante, a.data, a.sexo]);

    const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
    ws["!cols"] = [{ wch: 10 }, { wch: 42 }, { wch: 12 }, { wch: 6 }];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "ALUNOS");
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

    const ascii = downloadName
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[^\w.\-]/g, "_");

    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(downloadName)}`
    );
    res.setHeader("X-Filename", encodeURIComponent(downloadName));
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );

    return res.status(200).send(buf);
  } catch (err) {
    console.error("[converter-aluno] erro:", err);
    return res.status(500).json({ ok: false, error: "Falha ao converter o arquivo de alunos." });
  }
});







// Diagnóstico: confirme qual rota está atendendo
router.get("/converter-aluno/ping", (req, res) => {
  res.setHeader("X-Converter-Version", "aluno-v3");
  res.json({ ok: true, version: "aluno-v3" });
});






export default router;
