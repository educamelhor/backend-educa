// ==================================================================================
// backend/services/xlsxUnifierService.js
// Lê várias planilhas .xlsx em memória e retorna um Workbook unificado (Buffer).
// Regras:
//  - Primeira aba por padrão; se existir aba chamada "Notas" usa preferencialmente.
//  - União de colunas (superconjunto). Quem não tiver coluna → campo vazio.
//  - Normalização leve de cabeçalhos: trim, lower, sem acento, troca espaços por _,
//    remove pontuação comum. Mantém também o cabeçalho original para auditoria.
//  - Conta "linhas de dados" = total de linhas não totalmente vazias (exclui header).
// ==================================================================================

import * as XLSX from "xlsx";

// Remove acentos + normaliza
function normHeader(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // acentos
    .replace(/[^\w\s]/g, "")         // pontuação
    .trim()
    .replace(/\s+/g, "_")
    .toLowerCase();
}

function isRowEmpty(obj) {
  if (!obj || typeof obj !== "object") return true;
  return Object.values(obj).every((v) => v === null || v === undefined || String(v).trim() === "");
}

function pickSheetNamePrefer(sheetNames = []) {
  if (!Array.isArray(sheetNames) || sheetNames.length === 0) return null;
  const prefer = sheetNames.find((n) => /^notas$/i.test(n));
  return prefer || sheetNames[0];
}

/**
 * @param {Array<{buffer?: Buffer, originalname?: string}>} files
 * @returns {Promise<{buffer: Buffer, alunosTotal: number, colunas: string[], linhasTotais: number}>}
 */
export async function buildUnifiedWorkbookBuffer(files = []) {
  // --- 1) Ler todas as planilhas em objetos "linhas" + coletar cabeçalhos normalizados
  const dataRows = [];  // linhas já normalizadas
  const headerUnion = new Set(); // superconjunto de colunas

  for (const f of files) {
    const buf = f.buffer || f; // defensivo
    if (!buf || !Buffer.isBuffer(buf)) continue;

    const wb = XLSX.read(buf, { type: "buffer" });
    const sheetName = pickSheetNamePrefer(wb.SheetNames);
    if (!sheetName) continue;

    const ws = wb.Sheets[sheetName];
    // header: 1 → 1ª linha é header; defval "" para células vazias
    const rows = XLSX.utils.sheet_to_json(ws, { defval: "", raw: false });

    if (!Array.isArray(rows) || rows.length === 0) continue;

    // Normaliza cabeçalhos
    const rawHeaders = Object.keys(rows[0]);
    const mapHeader = new Map(); // original -> normalizado
    rawHeaders.forEach((h) => {
      const norm = normHeader(h);
      mapHeader.set(h, norm);
      headerUnion.add(norm);
    });

    // Normaliza linhas e ignora completamente vazias
    rows.forEach((r) => {
      const o = {};
      for (const [orig, norm] of mapHeader.entries()) {
        o[norm] = r[orig];
      }
      if (!isRowEmpty(o)) dataRows.push(o);
    });
  }

  const colunas = Array.from(headerUnion);
  // --- 2) Monta array 2D para XLSX (primeira linha = headers "bonitos")
  const prettyHeader = colunas.map((c) =>
    c
      .replace(/_/g, " ")
      .replace(/\b\w/g, (m) => m.toUpperCase())
  );

  const matrix = [prettyHeader];
  for (const r of dataRows) {
    const row = colunas.map((c) => (r[c] ?? ""));
    matrix.push(row);
  }

  // --- 3) Cria Workbook em memória
  const outWb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(matrix);
  XLSX.utils.book_append_sheet(outWb, ws, "Unificado");

  const buffer = XLSX.write(outWb, { type: "buffer", bookType: "xlsx" });

  return {
    buffer,
    alunosTotal: dataRows.length,
    colunas,
    linhasTotais: dataRows.length,
  };
}
