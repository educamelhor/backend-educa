// routes/ferramentas_nota.js
// ============================================================================
// Ferramentas → NOTA (PDF) → NOTA (XLSX)
// - Converte o “Espelho de Notas” em planilha XLSX.
// - Mantém o NOME do download exatamente igual ao do PDF (troca .pdf→.xlsx).
// - Registra histórico na tabela conversoes_historico.
// - Espera receber o arquivo no campo "file" (multer.single("file")).
// ============================================================================

import express from "express";
import multer from "multer";
import pdfParse from "pdf-parse";
import XLSX from "xlsx";
import mysql from "mysql2/promise";







// DEBUG — remover depois
import { fileURLToPath } from "url";
import path from "path";
const __filename = fileURLToPath(import.meta.url);
console.log("[ferramentas_nota] carregado:", __filename);






const router = express.Router();
const upload = multer(); // memória

// ---------------------------------------------------------------------------
// Conexão MySQL simples (usa variáveis do .env)
// ---------------------------------------------------------------------------
async function getConn() {
  return mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
  });
}

// ---------------------------------------------------------------------------
// Registrar histórico de conversão
// ---------------------------------------------------------------------------
async function registrarConversao({ req, tipo, nome_arquivo, total_registros = 0 }) {
  try {
    const conn = await getConn();
    const sql = `
      INSERT INTO conversoes_historico
        (usuario_id, escola_id, tipo, nome_arquivo, total_registros, ip_origem)
      VALUES (?, ?, ?, ?, ?, ?)
    `;
    await conn.execute(sql, [
      req.user?.id || null,
      req.user?.escola_id || null,
      tipo,
      nome_arquivo,
      total_registros,
      req.ip || null,
    ]);
    await conn.end();
  } catch (err) {
    console.error("[registrarConversao] falha ao gravar histórico:", err.message);
  }
}

// ---------------------------------------------------------------------------
// Helper: nomeia .xlsx a partir do nome do .pdf (mantém o mesmo nome)
// ---------------------------------------------------------------------------
function makeXlsxNameFromPdf(originalPdfName) {
  const raw = String(originalPdfName || "arquivo.pdf").split(/[\\/]/).pop();
  const base = raw.replace(/\.[Pp][Dd][Ff]$/, "");
  const xlsxName = `${base}.xlsx`;

  const asciiFallback = xlsxName
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, "_")
    .replace(/[^\w.\-]/g, "_");

  return { xlsxName, asciiFallback };
}

// ============================================================================
// Helpers do Parser de NOTAS
// ============================================================================
const DISCIPLINAS = ["ART", "ATV", "CIE", "EDF", "GEO", "HIS", "ING", "LP", "MAT", "PD1", "PD2", "PD3", "REL"];
const HEADERS = ["COD.", "ESTUDANTE", ...DISCIPLINAS];
const QTD_MAT = DISCIPLINAS.length;

const normLine   = (s) => String(s ?? "").replace(/\u00A0/g, " ").trim();
const isOrdem    = (s) => /^\d{1,3}$/.test(String(s).trim());
const isCodigo   = (s) => /^\d{4,}$/.test(String(s).trim());
const isNotaTok  = (s) => /^(?:\d{1,2}(?:[.,]\d{1,2})?|---|--|—)$/.test(String(s).trim());

// -----------------------------
// Parser 1 — vertical (ordem → código → nome → 13 notas)
// -----------------------------
function parseNotasVertical(rawText) {
  const linhas = String(rawText || "")
    .split(/\r?\n/)
    .map((l) => normLine(l))
    .filter((l) => l !== "");

  let start = 0;
  for (let i = 0; i < linhas.length; i++) {
    const U = linhas[i].toUpperCase();
    if (U.includes("COD") && U.includes("ESTUDANTE") && /ART|MAT|LP|CIE|EDF|GEO|HIS|ING|PD1|PD2|PD3|REL/.test(U)) {
      start = i + 1;
      break;
    }
  }

  const rows = [];
  for (let i = start; i < linhas.length; i++) {
    if (!isOrdem(linhas[i])) continue;

    const codigo = linhas[i + 1] || "";
    if (!isCodigo(codigo)) continue;

    const nome = (linhas[i + 2] || "").replace(/\s+/g, " ").trim();
    if (!nome || /\d/.test(nome)) continue;

    const notas = [];
    let j = i + 3;
    while (j < linhas.length && notas.length < QTD_MAT) {
      const L = linhas[j];
      if (isOrdem(L) && isCodigo(linhas[j + 1] || "")) break;
      if (isNotaTok(L)) notas.push(L);
      j++;
    }

    const rec = { "COD.": codigo, ESTUDANTE: nome };
    for (let k = 0; k < QTD_MAT; k++) {
      const v = notas[k] || "";
      rec[DISCIPLINAS[k]] = !v || /^-+$|—$/.test(v) ? "" : v.replace(/\./g, ",");
    }
    rows.push(rec);

    i = j - 1;
  }

  return rows;
}

// -----------------------------
// Parser 2 — em linha (várias colunas na mesma linha)
// -----------------------------
function parseNotasEmLinha(rawText) {
  const linhas = String(rawText || "")
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+$/g, "").replace(/^\s+/g, ""))
    .filter((l) => l !== "");

  let headerIdx = -1;
  for (let i = 0; i < linhas.length; i++) {
    const L = linhas[i].toUpperCase();
    if (L.includes("COD.") && L.includes("ESTUDANTE") && /ART|LP|MAT|CIE|EDF|GEO|HIS|ING|PD1|PD2|PD3|REL/.test(L)) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) return [];

  const rows = [];
  for (let i = headerIdx + 1; i < linhas.length; i++) {
    const parts = linhas[i].split(/\s{2,}|\t+/).filter(Boolean);
    let codigo = null;
    let startIdx = 0;
    for (let k = 0; k < parts.length; k++) {
      if (isCodigo(parts[k])) { codigo = parts[k]; startIdx = k + 1; break; }
    }
    if (!codigo) continue;

    const nomeTokens = [];
    const notasTokens = [];
    for (let k = startIdx; k < parts.length; k++) {
      const p = parts[k].trim();
      if (isNotaTok(p)) notasTokens.push(p);
      else nomeTokens.push(p);
    }

    let j = i + 1;
    while (notasTokens.length < QTD_MAT && j < linhas.length) {
      const more = linhas[j].split(/\s{2,}|\t+/).filter(Boolean);
      if (isCodigo(more[0] || "")) break;
      for (const p of more) {
        const t = p.trim();
        if (isNotaTok(t)) notasTokens.push(t);
        else if (!notasTokens.length) nomeTokens.push(t);
      }
      j++;
    }
    i = Math.max(i, j - 1);

    const nome = nomeTokens.join(" ").replace(/\s+/g, " ").trim();
    if (!nome) continue;

    const rec = { "COD.": codigo, ESTUDANTE: nome };
    for (let k = 0; k < QTD_MAT; k++) {
      const v = notasTokens[k] || "";
      rec[DISCIPLINAS[k]] = !v || /^-+$|—$/.test(v) ? "" : v.replace(/\./g, ",");
    }
    rows.push(rec);
  }

  return rows;
}

// -----------------------------
// Parser 3 — tokens (fallback tolerante)
// -----------------------------
function parseNotasTokens(rawText) {
  const tokens = String(rawText || "").replace(/\u00A0/g, " ").split(/\s+/).filter(Boolean);
  const rows = [];
  for (let i = 0; i < tokens.length; i++) {
    if (!isCodigo(tokens[i])) continue;
    const codigo = tokens[i];

    let j = i + 1;
    const nomeTokens = [];
    while (j < tokens.length && !isNotaTok(tokens[j])) {
      if (/^\d{1,3}$/.test(tokens[j])) break;
      nomeTokens.push(tokens[j]);
      j++;
    }
    if (!nomeTokens.length) continue;

    const notas = [];
    while (j < tokens.length && notas.length < QTD_MAT && isNotaTok(tokens[j])) {
      notas.push(tokens[j]); j++;
    }
    if (notas.length < 6) continue;

    const rec = { "COD.": codigo, ESTUDANTE: nomeTokens.join(" ") };
    for (let k = 0; k < QTD_MAT; k++) {
      const v = notas[k] || "";
      rec[DISCIPLINAS[k]] = !v || /^-+$|—$/.test(v) ? "" : v.replace(/\./g, ",");
    }
    rows.push(rec);
    i = j - 1;
  }
  return rows;
}

// ============================================================================
// POST /api/ferramentas/nota-pdf-para-xlsx  (NOTAS)
// ============================================================================
router.post("/nota-pdf-para-xlsx", upload.single("file"), async (req, res) => {
  try {
    if (!req.file?.buffer) {
      return res.status(400).json({ message: "PDF não enviado." });
    }

    // Parse do PDF
    const parsed = await pdfParse(req.file.buffer);
    const text = parsed.text || "";

    // Tenta os 3 parsers em cascata
    let rows = parseNotasVertical(text);
    if (!rows.length) rows = parseNotasEmLinha(text);
    if (!rows.length) rows = parseNotasTokens(text);

    if (!rows.length) {
      return res.status(422).json({ message: "Não foi possível extrair linhas de notas do PDF." });
    }

    // Monta planilha (AOA) com cabeçalho + linhas
    const aoa = [
      HEADERS,
      ...rows.map((r) => [r["COD."], r["ESTUDANTE"], ...DISCIPLINAS.map((d) => r[d])]),
    ];
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws["!cols"] = HEADERS.map((h) => ({ wch: h === "ESTUDANTE" ? 38 : 10 }));
    XLSX.utils.book_append_sheet(wb, ws, "Notas");

    const buf = XLSX.write(wb, { bookType: "xlsx", type: "buffer", compression: true });

    // Nome final = mesmo nome do PDF, com extensão .xlsx
    const { xlsxName, asciiFallback } = makeXlsxNameFromPdf(req.file.originalname);

    // Histórico
    await registrarConversao({
      req,
      tipo: "PDF→XLSX (Notas)",
      nome_arquivo: xlsxName,
      total_registros: rows.length,
    });

    // Headers de download
    res.setHeader("Access-Control-Expose-Headers", "Content-Disposition, X-Filename");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(xlsxName)}`
    );
    res.setHeader("X-Filename", encodeURIComponent(xlsxName));
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader("Content-Length", Buffer.byteLength(buf));

    return res.status(200).send(buf);
  } catch (err) {
    console.error("[nota-pdf-para-xlsx] erro:", err);
    return res.status(500).json({
      message: "Erro ao converter NOTA (PDF) para NOTA (XLSX).",
      error: err.message,
    });
  }
});






// DEBUG — remover depois
router.get("/__routes-nota", (req, res) => {
  const list = (router.stack || [])
    .filter(l => l.route)
    .map(l => {
      const m = Object.keys(l.route.methods || {}).find(Boolean)?.toUpperCase() || "";
      return `${m} ${l.route.path}`;
    });
  res.json({ file: __filename, routes: list });
});






export default router;
