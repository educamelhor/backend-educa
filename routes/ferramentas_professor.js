// routes/ferramentas_professor.js
// ============================================================================
// Ferramentas → PDF (Professores) → XLSX
// - Conversão com a mesma lógica do importador (Secretaria ▸ Professores),
//   mas aqui NÃO grava no banco: apenas retorna o .xlsx (somente localizados).
// - Caminhos efetivos (via agregador):
//     • POST /api/ferramentas/pdf-para-xlsx
//     • POST /api/ferramentas/professores/pdf-para-xlsx
// ============================================================================

import express from "express";
import multer from "multer";
import pdfParse from "pdf-parse";
import * as XLSX from "xlsx";
import mysql from "mysql2/promise";

// Upload em memória -----------------------------------------------------------
const upload = multer();
const router = express.Router();

// MySQL (histórico) -----------------------------------------------------------
async function getConn() {
  return mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
  });
}

async function registrarConversao({ req, tipo, nome_arquivo, total_registros = 0 }) {
  try {
    const conn = await getConn();
    await conn.execute(
      `INSERT INTO conversoes_historico
         (usuario_id, escola_id, tipo, nome_arquivo, total_registros, ip_origem)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        req.user?.id || null,
        req.user?.escola_id || null,
        tipo,
        nome_arquivo,
        total_registros,
        req.ip || null,
      ]
    );
    await conn.end();
  } catch (err) {
    console.error("[historico] falha ao gravar:", err.message);
  }
}

// Helpers --------------------------------------------------------------------
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

// Extrai professores do texto do PDF (mesma linha do importador) --------------
function extrairProfessoresDePDF(texto) {
  const linhas = texto.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const profs = [];

  // 🔎 Ajuste aqui conforme o layout do seu PDF, se necessário.
  // Ideia base: capturar NOME (caixa alta) + campo que indica "PROFESSOR".
  // Se o seu importador usa outra regex/heurística, replique aqui.
  for (let i = 0; i < linhas.length; i++) {
    // Exemplo de heurística:
    // ... NOME COMPLETO ...   PROFESSOR ...    (demais colunas)
    const nomeLinha = linhas[i];
    const cargoLinha = linhas[i + 1] || "";

    const nomeOK = /^[A-ZÁÉÍÓÚÂÊÔÃÕÇ\s.'-]{8,}$/.test(nomeLinha);
    const cargoOK = /PROFESSOR/i.test(cargoLinha);

    if (nomeOK && cargoOK) {
      profs.push({
        Nome: nomeLinha,
        Cargo: "PROFESSOR",
        CPF: "", // se o importador original extrai CPF, plugar a mesma lógica aqui
      });
      i++; // pula a linha do cargo
    }
  }

  return profs.filter((p) => p.Nome);
}

// Handler principal -----------------------------------------------------------
async function handlePdfParaXlsx(req, res) {
  if (!req.file) return res.status(400).json({ message: "PDF não enviado." });

  try {
    const { text } = await pdfParse(req.file.buffer);

    // 1) Extrai professores
    const professores = extrairProfessoresDePDF(text);
    if (!professores.length) {
      return res.status(400).json({ message: "Nenhum professor encontrado no PDF." });
    }

    // 2) Monta XLSX (apenas localizados)
    const ws = XLSX.utils.json_to_sheet(professores);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "PROFESSORES");
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

    // 3) Nome do arquivo = mesmo do PDF
    const { xlsxName, asciiFallback } = makeXlsxNameFromPdf(req.file.originalname);

    // 4) Histórico (best effort)
    await registrarConversao({
      req,
      tipo: "PDF→XLSX (Professores)",
      nome_arquivo: xlsxName,
      total_registros: professores.length,
    });

    // 5) Resposta
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
    return res.status(200).send(buf);
  } catch (err) {
    console.error("[pdf-para-xlsx] erro:", err);
    return res.status(500).json({ message: "Erro ao converter PDF para XLSX.", error: err.message });
  }
}

// Rota interna ÚNICA (funciona na raiz e no subcaminho via agregador)
router.post("/pdf-para-xlsx", upload.single("file"), handlePdfParaXlsx);

export default router;
