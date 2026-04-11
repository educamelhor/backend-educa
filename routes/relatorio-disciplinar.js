// routes/relatorio-disciplinar.js
// ============================================================================
// Gera PDF do Relatório de Registros Disciplinares
// Baseado no layout do TACE mas com diferenças:
// - Sem "Reconhecimento dos Fatos" e "Compromisso de Ajuste de Conduta"
// - Apenas assinatura do Responsável Legal
// - Cada registro tem sublinha com a Descrição da ocorrência
// - Apenas registros com status FINALIZADA (exclui REGISTRADA e CANCELADA)
// ============================================================================

import { Router } from "express";
import PDFDocument from "pdfkit";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";
import pool from "../db.js";

const router = Router();
const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Helpers ────────────────────────────────────────────────────────────
function fmtCpf(cpf) {
  if (!cpf) return "—";
  const d = String(cpf).replace(/\D/g, "").padStart(11, "0");
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
}
function fmtTel(tel) {
  if (!tel) return "—";
  const d = String(tel).replace(/\D/g, "");
  if (d.length === 11) return `(${d.slice(0,2)}) ${d.slice(2,7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0,2)}) ${d.slice(2,6)}-${d.slice(6)}`;
  return tel;
}
function fmtDataNasc(val) {
  if (!val) return "—";
  const d = new Date(val);
  if (isNaN(d.getTime())) return String(val);
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}
function hoje() {
  const m = ["janeiro","fevereiro","março","abril","maio","junho","julho","agosto","setembro","outubro","novembro","dezembro"];
  const d = new Date();
  return `${d.getDate()} de ${m[d.getMonth()]} de ${d.getFullYear()}`;
}

function getConceito(pontos) {
  const p = Number(pontos);
  if (p >= 10) return "I - Excepcional";
  if (p >= 9) return "II - Ótimo";
  if (p >= 7) return "III - Bom";
  if (p >= 5) return "IV - Regular";
  if (p >= 2) return "V - Insuficiente";
  return "VI - Incompatível";
}

// ── Rota GET /validar/:alunoId — verifica dados obrigatórios para gerar PDF ──
router.get("/validar/:alunoId", async (req, res) => {
  try {
    const { escola_id } = req.user;
    const { alunoId } = req.params;
    const ausentes = [];

    // 1) Dados do estudante
    const [[aluno]] = await pool.query(
      `SELECT a.codigo, a.estudante, a.data_nascimento,
              t.nome AS turma, t.turno
       FROM alunos a
       LEFT JOIN turmas t ON t.id = a.turma_id
       WHERE a.id = ? AND a.escola_id = ?`,
      [alunoId, escola_id]
    );

    if (!aluno) {
      return res.json({ valido: false, ausentes: [{ categoria: "Estudante", campos: ["Estudante não encontrado no sistema"] }] });
    }

    const camposAluno = [];
    if (!aluno.estudante || !aluno.estudante.trim()) camposAluno.push("Nome do Estudante");
    if (!aluno.codigo || !String(aluno.codigo).trim()) camposAluno.push("Código / RE");
    if (!aluno.data_nascimento) camposAluno.push("Data de Nascimento");
    if (!aluno.turma || !aluno.turma.trim()) camposAluno.push("Turma");
    if (!aluno.turno || !aluno.turno.trim()) camposAluno.push("Turno");

    if (camposAluno.length > 0) {
      ausentes.push({ categoria: "Estudante", campos: camposAluno });
    }

    // 2) Dados do responsável
    const [[resp]] = await pool.query(
      `SELECT r.nome, r.cpf, r.telefone_celular, r.endereco, r.email
       FROM responsaveis r
       JOIN responsaveis_alunos ra ON ra.responsavel_id = r.id
       WHERE ra.aluno_id = ? AND ra.escola_id = ? AND ra.ativo = 1
       ORDER BY ra.id ASC LIMIT 1`,
      [alunoId, escola_id]
    );

    if (!resp) {
      ausentes.push({ categoria: "Responsável Legal", campos: ["Nenhum responsável vinculado ao estudante"] });
    } else {
      const camposResp = [];
      if (!resp.nome || !resp.nome.trim()) camposResp.push("Nome do Responsável");
      if (!resp.cpf || !resp.cpf.trim()) camposResp.push("CPF");
      if (!resp.telefone_celular || !resp.telefone_celular.trim()) camposResp.push("Telefone");
      if (!resp.endereco || !resp.endereco.trim()) camposResp.push("Endereço");

      if (camposResp.length > 0) {
        ausentes.push({ categoria: "Responsável Legal", campos: camposResp });
      }
    }

    // 3) Verifica se há registros finalizados
    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total FROM ocorrencias_disciplinares
       WHERE aluno_id = ? AND escola_id = ? AND status = 'FINALIZADA'`,
      [alunoId, escola_id]
    );

    if (total === 0) {
      ausentes.push({ categoria: "Registros Disciplinares", campos: ["Nenhum registro com status FINALIZADA encontrado"] });
    }

    res.json({ valido: ausentes.length === 0, ausentes });
  } catch (err) {
    console.error("[RELATORIO] Erro ao validar dados:", err);
    res.status(500).json({ error: "Erro ao validar dados." });
  }
});

// ── Rota GET /validar/:alunoId/registro/:ocorrenciaId — dados obrigatórios para registro individual ──
router.get("/validar/:alunoId/registro/:ocorrenciaId", async (req, res) => {
  try {
    const { escola_id } = req.user;
    const { alunoId, ocorrenciaId } = req.params;
    const ausentes = [];

    // 1) Dados do estudante
    const [[aluno]] = await pool.query(
      `SELECT a.codigo, a.estudante, a.data_nascimento,
              t.nome AS turma, t.turno
       FROM alunos a
       LEFT JOIN turmas t ON t.id = a.turma_id
       WHERE a.id = ? AND a.escola_id = ?`,
      [alunoId, escola_id]
    );

    if (!aluno) {
      return res.json({ valido: false, ausentes: [{ categoria: "Estudante", campos: ["Estudante não encontrado no sistema"] }] });
    }

    const camposAluno = [];
    if (!aluno.estudante || !aluno.estudante.trim()) camposAluno.push("Nome do Estudante");
    if (!aluno.codigo || !String(aluno.codigo).trim()) camposAluno.push("Código / RE");
    if (!aluno.data_nascimento) camposAluno.push("Data de Nascimento");
    if (!aluno.turma || !aluno.turma.trim()) camposAluno.push("Turma");
    if (!aluno.turno || !aluno.turno.trim()) camposAluno.push("Turno");

    if (camposAluno.length > 0) {
      ausentes.push({ categoria: "Estudante", campos: camposAluno });
    }

    // 2) Dados do responsável
    const [[resp]] = await pool.query(
      `SELECT r.nome, r.cpf, r.telefone_celular, r.endereco, r.email
       FROM responsaveis r
       JOIN responsaveis_alunos ra ON ra.responsavel_id = r.id
       WHERE ra.aluno_id = ? AND ra.escola_id = ? AND ra.ativo = 1
       ORDER BY ra.id ASC LIMIT 1`,
      [alunoId, escola_id]
    );

    if (!resp) {
      ausentes.push({ categoria: "Responsável Legal", campos: ["Nenhum responsável vinculado ao estudante"] });
    } else {
      const camposResp = [];
      if (!resp.nome || !resp.nome.trim()) camposResp.push("Nome do Responsável");
      if (!resp.cpf || !resp.cpf.trim()) camposResp.push("CPF");
      if (!resp.telefone_celular || !resp.telefone_celular.trim()) camposResp.push("Telefone");
      if (!resp.endereco || !resp.endereco.trim()) camposResp.push("Endereço");

      if (camposResp.length > 0) {
        ausentes.push({ categoria: "Responsável Legal", campos: camposResp });
      }
    }

    // 3) Verifica se o registro existe e está finalizado
    const [[oc]] = await pool.query(
      `SELECT id, status FROM ocorrencias_disciplinares
       WHERE id = ? AND aluno_id = ? AND escola_id = ?`,
      [ocorrenciaId, alunoId, escola_id]
    );

    if (!oc) {
      ausentes.push({ categoria: "Registro Disciplinar", campos: ["Registro não encontrado no sistema"] });
    } else if (oc.status !== 'FINALIZADA') {
      ausentes.push({ categoria: "Registro Disciplinar", campos: [`Registro com status "${oc.status}" — apenas registros finalizados podem ser impressos`] });
    }

    res.json({ valido: ausentes.length === 0, ausentes });
  } catch (err) {
    console.error("[RELATORIO] Erro ao validar registro individual:", err);
    res.status(500).json({ error: "Erro ao validar dados." });
  }
});

// ── Rota GET /:alunoId/registro/:ocorrenciaId — PDF de registro individual ──
router.get("/:alunoId/registro/:ocorrenciaId", async (req, res) => {
  try {
    const { escola_id } = req.user;
    const { alunoId, ocorrenciaId } = req.params;

    // ── Dados do banco ───────────────────────────────────────────────
    const [[escola]] = await pool.query(
      "SELECT id, nome, apelido, endereco, cidade, estado FROM escolas WHERE id = ?",
      [escola_id]
    );

    const [[aluno]] = await pool.query(
      `SELECT a.id, a.codigo, a.estudante, a.data_nascimento,
              t.nome AS turma, t.turno
       FROM alunos a
       LEFT JOIN turmas t ON t.id = a.turma_id
       WHERE a.id = ? AND a.escola_id = ?`,
      [alunoId, escola_id]
    );

    if (!aluno) return res.status(404).json({ error: "Aluno não encontrado." });

    const [[resp]] = await pool.query(
      `SELECT r.id, r.nome, r.cpf, r.email, r.telefone_celular, r.telefone_secundario, r.endereco
       FROM responsaveis r
       JOIN responsaveis_alunos ra ON ra.responsavel_id = r.id
       WHERE ra.aluno_id = ? AND ra.escola_id = ? AND ra.ativo = 1
       ORDER BY ra.id ASC LIMIT 1`,
      [alunoId, escola_id]
    );

    // Registro individual — exclui apenas CANCELADA (frontend já avisa sobre REGISTRADA)
    const [rows] = await pool.query(
      `SELECT LPAD(o.id, 4, '0') AS registro,
              DATE_FORMAT(o.data_ocorrencia, '%d/%m/%Y') AS data,
              COALESCE(r.tipo_ocorrencia, 'N/D') AS tipo,
              COALESCE(r.medida_disciplinar, o.tipo_ocorrencia, 'N/D') AS medida,
              o.motivo,
              o.descricao,
              COALESCE(r.pontos, 0) AS pontos,
              o.status,
              o.convocar_responsavel,
              DATE_FORMAT(o.data_comparecimento_responsavel, '%d/%m/%Y') AS data_comparecimento
       FROM ocorrencias_disciplinares o
       LEFT JOIN registros_ocorrencias r
         ON r.descricao_ocorrencia = o.motivo AND r.tipo_ocorrencia = o.tipo_ocorrencia
       WHERE o.id = ? AND o.aluno_id = ? AND o.escola_id = ? AND o.status != 'CANCELADA'`,
      [ocorrenciaId, alunoId, escola_id]
    );

    if (!rows.length) return res.status(404).json({ error: "Registro não encontrado ou possui status cancelado." });

    const registros = rows;

    // Pontuação de TODOS finalizados para manter consistência no cabeçalho
    const PONTUACAO_INICIAL = 8.00;
    const [allRows] = await pool.query(
      `SELECT COALESCE(r.pontos, 0) AS pontos
       FROM ocorrencias_disciplinares o
       LEFT JOIN registros_ocorrencias r
         ON r.descricao_ocorrencia = o.motivo AND r.tipo_ocorrencia = o.tipo_ocorrencia
       WHERE o.aluno_id = ? AND o.escola_id = ? AND o.status = 'FINALIZADA'`,
      [alunoId, escola_id]
    );
    const totalPontosGeral = allRows.reduce((s, r) => s + Number(r.pontos || 0), 0);
    const pontuacaoFinal = Math.max(0, Math.min(10, PONTUACAO_INICIAL + totalPontosGeral)).toFixed(2);
    const conceito = getConceito(pontuacaoFinal);

    // Pontos apenas deste registro
    const pontosRegistro = Number(registros[0].pontos || 0);

    // ── Logos ────────────────────────────────────────────────────────
    const logoLeft = join(__dirname, "..", "assets", "images", "brasao-gdf.png");
    const logoRight = join(__dirname, "..", "assets", "images", "logo-escola-right.png");
    const hasLogoLeft = existsSync(logoLeft);
    const hasLogoRight = existsSync(logoRight);

    // ══════════════════════════════════════════════════════════════════
    // GERAR PDF
    // ══════════════════════════════════════════════════════════════════
    const L = 40;
    const R = 40;
    const PW = 595.28 - L - R;
    const PAGE_H = 841.89;
    const FOOTER_Y = PAGE_H - 25;
    const MAX_Y = FOOTER_Y - 15;

    const doc = new PDFDocument({
      size: "A4",
      margins: { top: 30, bottom: 0, left: L, right: R },
      autoFirstPage: true,
      info: {
        Title: `Registro Disciplinar ${registros[0].registro} - ${aluno.estudante}`,
        Author: "EDUCA.MELHOR — Sistema Educacional",
        Subject: "Impressão de Registro Disciplinar",
      },
    });

    res.setHeader("Content-Type", "application/pdf");
    const nomeArquivo = `registro_${registros[0].registro}_${aluno.codigo || aluno.id}.pdf`;
    res.setHeader("Content-Disposition", `inline; filename="${nomeArquivo}"`);

    const pdfChunks = [];
    const { PassThrough } = await import("stream");
    const passThrough = new PassThrough();
    passThrough.on("data", chunk => pdfChunks.push(chunk));
    doc.pipe(passThrough);

    let pageNum = 1;

    // ── Cores ──
    const COR_AZUL = "#1e3a5f";
    const COR_DOURADO = "#b8860b";
    const COR_CINZA = "#555";
    const COR_VERMELHO = "#c62828";
    const COR_VERDE = "#2e7d32";

    // ── Funções auxiliares ────────────────────────────────────────────
    function drawFooter() {
      doc.font("Helvetica").fontSize(6.5).fillColor("#aaa")
        .text(
          `Impressão de Registro Disciplinar • Documento gerado pelo EDUCA.MELHOR • Página ${pageNum}`,
          L, FOOTER_Y, { width: PW, align: "center", lineBreak: false }
        );
    }

    function drawLine(cor = "#ccc") {
      doc.moveTo(L, doc.y).lineTo(L + PW, doc.y).strokeColor(cor).lineWidth(0.5).stroke();
    }

    function label(text, x, y, w) {
      doc.font("Helvetica-Bold").fontSize(8).fillColor("#888").text(text.toUpperCase(), x, y, { width: w, lineBreak: false });
    }

    function value(text, x, y, w) {
      doc.font("Helvetica-Bold").fontSize(10).fillColor("#111").text(text || "—", x, y, { width: w, lineBreak: false });
    }

    function ensureSpace(needed) {
      if (doc.y + needed > MAX_Y) {
        drawFooter();
        doc.addPage();
        pageNum++;
        doc.y = 30;
      }
    }

    function drawSigLine(x, y, w, nome, cargo) {
      const lineY = y + 28;
      doc.moveTo(x, lineY).lineTo(x + w, lineY).strokeColor("#333").lineWidth(0.5).stroke();
      if (nome) {
        doc.font("Helvetica-Bold").fontSize(8).fillColor("#333")
          .text(nome, x, lineY + 3, { width: w, align: "center", lineBreak: false });
      }
      doc.font("Helvetica").fontSize(7).fillColor("#666")
        .text(cargo, x, lineY + (nome ? 13 : 3), { width: w, align: "center", lineBreak: false });
    }

    // ══════════════════════════════════════════════════════════════════
    // CABEÇALHO INSTITUCIONAL
    // ══════════════════════════════════════════════════════════════════
    const headerTop = doc.y;
    const logoSize = 58;

    if (hasLogoLeft) {
      doc.image(logoLeft, L, headerTop, { width: logoSize, height: logoSize });
    }
    if (hasLogoRight) {
      doc.image(logoRight, L + PW - logoSize, headerTop, { width: logoSize, height: logoSize });
    }

    const hx = L + logoSize + 8;
    const hw = PW - (logoSize + 8) * 2;

    doc.font("Helvetica-Bold").fontSize(9).fillColor(COR_AZUL)
      .text("SECRETARIA DE ESTADO DE EDUCAÇÃO DO DISTRITO FEDERAL", hx, headerTop + 4, { width: hw, align: "center" });

    doc.font("Helvetica-Bold").fontSize(8.5).fillColor(COR_AZUL)
      .text(
        `COORDENAÇÃO REGIONAL DE ENSINO DE ${(escola?.cidade || "PLANALTINA").toUpperCase()}`,
        hx, doc.y + 1, { width: hw, align: "center" }
      );

    const escolaNome = escola?.nome || "CENTRO DE ENSINO FUNDAMENTAL 04";
    const escolaApelido = escola?.apelido || "";
    const nomeCompleto = escolaApelido ? `${escolaNome} — ${escolaApelido}` : escolaNome;
    doc.font("Helvetica-Bold").fontSize(9).fillColor(COR_AZUL)
      .text(nomeCompleto.toUpperCase(), hx, doc.y + 1, { width: hw, align: "center" });

    const enderecoEscola = escola?.endereco || "Endereço não cadastrado";
    doc.font("Helvetica").fontSize(7.5).fillColor(COR_CINZA)
      .text(enderecoEscola, hx, doc.y + 1, { width: hw, align: "center" });

    doc.y = headerTop + logoSize + 4;

    // Linhas decorativas
    doc.moveTo(L, doc.y).lineTo(L + PW, doc.y).strokeColor(COR_DOURADO).lineWidth(2).stroke();
    doc.y += 3;
    doc.moveTo(L, doc.y).lineTo(L + PW, doc.y).strokeColor(COR_AZUL).lineWidth(0.8).stroke();
    doc.y += 8;

    // TÍTULO
    doc.font("Helvetica-Bold").fontSize(14).fillColor(COR_AZUL)
      .text("IMPRESSÃO DE REGISTRO DISCIPLINAR", L, doc.y, { width: PW, align: "center" });
    doc.y += 6;

    drawLine(); doc.y += 6;

    // ══════════════════════════════════════════════════════════════════
    // 1. IDENTIFICAÇÃO DO ESTUDANTE
    // ══════════════════════════════════════════════════════════════════
    doc.font("Helvetica-Bold").fontSize(10).fillColor(COR_AZUL)
      .text("1. IDENTIFICAÇÃO DO ESTUDANTE", L, doc.y, { width: PW });
    doc.y += 4;

    const yS1 = doc.y;
    label("Nome do Estudante", L, yS1, PW * 0.65);
    value(aluno.estudante, L, yS1 + 10, PW * 0.65);
    label("RE (Registro)", L + PW * 0.68, yS1, PW * 0.32);
    value(aluno.codigo || "—", L + PW * 0.68, yS1 + 10, PW * 0.32);
    doc.y = yS1 + 26;

    const yS1b = doc.y;
    label("Data de Nascimento", L, yS1b, PW * 0.35);
    value(fmtDataNasc(aluno.data_nascimento), L, yS1b + 10, PW * 0.35);
    doc.y = yS1b + 26;

    const yS2 = doc.y;
    label("Turma", L, yS2, PW * 0.35);
    value(aluno.turma || "—", L, yS2 + 10, PW * 0.35);
    label("Turno", L + PW * 0.38, yS2, PW * 0.25);
    value(aluno.turno || "—", L + PW * 0.38, yS2 + 10, PW * 0.25);

    // Boxes Pontuação + Comportamento
    const pontoX = L + PW * 0.66;
    const pontoW = PW * 0.16;
    const compX = L + PW * 0.83;
    const compW = PW * 0.17;
    const boxH = 28;

    doc.roundedRect(pontoX, yS2 - 2, pontoW, boxH, 4)
      .fillAndStroke(Number(pontuacaoFinal) >= 7 ? "#e8f5e9" : Number(pontuacaoFinal) >= 5 ? "#fff8e1" : "#ffebee",
                     Number(pontuacaoFinal) >= 7 ? COR_VERDE : Number(pontuacaoFinal) >= 5 ? COR_DOURADO : COR_VERMELHO);
    doc.font("Helvetica").fontSize(6.5).fillColor("#888")
      .text("PONTUAÇÃO", pontoX + 3, yS2, { width: pontoW - 6, align: "center" });
    doc.font("Helvetica-Bold").fontSize(12)
      .fillColor(Number(pontuacaoFinal) >= 7 ? COR_VERDE : Number(pontuacaoFinal) >= 5 ? COR_DOURADO : COR_VERMELHO)
      .text(String(pontuacaoFinal).replace(".", ","), pontoX + 3, yS2 + 10, { width: pontoW - 6, align: "center" });

    doc.roundedRect(compX, yS2 - 2, compW, boxH, 4)
      .fillAndStroke("#e3f2fd", COR_AZUL);
    doc.font("Helvetica").fontSize(6.5).fillColor("#888")
      .text("COMPORTAMENTO", compX + 3, yS2, { width: compW - 6, align: "center" });
    doc.font("Helvetica-Bold").fontSize(7.5).fillColor(COR_AZUL)
      .text(conceito, compX + 3, yS2 + 12, { width: compW - 6, align: "center" });

    doc.y = yS2 + boxH + 4;
    drawLine(); doc.y += 6;

    // ══════════════════════════════════════════════════════════════════
    // 2. IDENTIFICAÇÃO DO RESPONSÁVEL
    // ══════════════════════════════════════════════════════════════════
    doc.font("Helvetica-Bold").fontSize(10).fillColor(COR_AZUL)
      .text("2. IDENTIFICAÇÃO DO RESPONSÁVEL LEGAL", L, doc.y, { width: PW });
    doc.y += 4;

    const yR1 = doc.y;
    label("Nome do Responsável", L, yR1, PW * 0.55);
    value(resp?.nome || "—", L, yR1 + 10, PW * 0.55);
    label("CPF", L + PW * 0.58, yR1, PW * 0.42);
    value(fmtCpf(resp?.cpf), L + PW * 0.58, yR1 + 10, PW * 0.42);
    doc.y = yR1 + 26;

    const yR2 = doc.y;
    label("Endereço", L, yR2, PW * 0.55);
    value(resp?.endereco || "—", L, yR2 + 10, PW * 0.55);
    label("Telefone", L + PW * 0.58, yR2, PW * 0.42);
    value(fmtTel(resp?.telefone_celular), L + PW * 0.58, yR2 + 10, PW * 0.42);
    doc.y = yR2 + 26;

    drawLine(); doc.y += 6;

    // ══════════════════════════════════════════════════════════════════
    // 3. REGISTRO DISCIPLINAR (INDIVIDUAL)
    // ══════════════════════════════════════════════════════════════════
    doc.font("Helvetica-Bold").fontSize(10).fillColor(COR_AZUL)
      .text("3. REGISTRO DISCIPLINAR", L, doc.y, { width: PW });
    doc.y += 4;

    const cols = [
      { label: "Nº",         w: 32,  align: "center" },
      { label: "DATA",       w: 55,  align: "center" },
      { label: "TIPO",       w: 45,  align: "center" },
      { label: "MEDIDA",     w: 105, align: "left"   },
      { label: "OCORRÊNCIA", w: PW - 32 - 55 - 45 - 105 - 40, align: "left" },
      { label: "PTS",        w: 40,  align: "center" },
    ];

    const TH = 16;
    const TR = 14;

    // Cabeçalho da tabela
    function drawTableHeader() {
      const headerY2 = doc.y;
      let tx = L;
      doc.rect(L, headerY2, PW, TH).fill(COR_AZUL);
      cols.forEach(c => {
        doc.font("Helvetica-Bold").fontSize(7).fillColor("#fff")
          .text(c.label, tx + 2, headerY2 + 4, { width: c.w - 4, align: c.align, lineBreak: false });
        tx += c.w;
      });
      doc.y = headerY2 + TH;
    }

    drawTableHeader();

    const nomeResp = resp?.nome || "Responsavel";

    // Linha de dados do registro individual
    registros.forEach((r, i) => {
      let descricaoText = r.descricao ? String(r.descricao).trim() : "";

      if (Number(r.convocar_responsavel) === 1 && r.data_comparecimento) {
        const infoComparecimento = `${nomeResp} compareceu dia ${r.data_comparecimento} para tomar conhecimento deste registro.`;
        descricaoText = descricaoText
          ? `${descricaoText} ${infoComparecimento}`
          : infoComparecimento;
      }

      const descH = descricaoText
        ? Math.max(12, doc.font("Helvetica").fontSize(6.5).heightOfString(descricaoText, { width: PW - 16 }) + 6)
        : 0;

      // Linha principal do registro
      doc.rect(L, doc.y, PW, TR).fill("#f8f9fa");

      let tx = L;
      const rowY = doc.y + 3;
      const vals = [
        r.registro,
        r.data,
        r.tipo,
        r.medida,
        r.motivo,
        String(r.pontos).replace(".", ","),
      ];

      cols.forEach((c, ci) => {
        const isNeg = ci === 5 && Number(r.pontos) < 0;
        const isPos = ci === 5 && Number(r.pontos) > 0;
        doc.font(ci === 5 ? "Helvetica-Bold" : "Helvetica").fontSize(7)
          .fillColor(isNeg ? COR_VERMELHO : isPos ? COR_VERDE : "#333")
          .text(vals[ci] || "—", tx + 2, rowY, { width: c.w - 4, align: c.align });
        tx += c.w;
      });
      doc.y += TR;

      // Sublinha com a Descricao da ocorrencia
      if (descricaoText) {
        const descY = doc.y;
        doc.rect(L, descY, PW, descH).fill("#eef2f7");
        doc.font("Helvetica-Oblique").fontSize(6.5).fillColor("#555")
          .text(descricaoText, L + 10, descY + 3, { width: PW - 16, lineGap: 1 });
        doc.y = descY + descH;
      }
    });

    // Linha resumo
    const resumoH = TR + 4;
    const resumoY = doc.y;
    doc.rect(L, resumoY, PW, resumoH).fill("#e8eaf6");
    const resumoTextY = resumoY + (resumoH - 9) / 2;
    doc.font("Helvetica-Bold").fontSize(8).fillColor(COR_AZUL)
      .text("REGISTRO: " + registros[0].registro, L + 4, resumoTextY, { width: PW * 0.5, lineBreak: false });
    doc.y = resumoTextY;
    doc.font("Helvetica-Bold").fontSize(9)
      .fillColor(pontosRegistro < 0 ? COR_VERMELHO : COR_VERDE)
      .text(`Pontos deste Registro: ${pontosRegistro.toFixed(1).replace(".", ",")}`, L + PW * 0.5, resumoTextY, {
        width: PW * 0.5 - 4, align: "right", lineBreak: false,
      });
    doc.y = resumoY + resumoH + 4;

    drawLine(); doc.y += 6;

    // ══════════════════════════════════════════════════════════════════
    // 4. CIÊNCIA DO RESPONSÁVEL
    // ══════════════════════════════════════════════════════════════════
    ensureSpace(120);
    doc.font("Helvetica-Bold").fontSize(10).fillColor(COR_AZUL)
      .text("4. CIÊNCIA DO RESPONSÁVEL LEGAL", L, doc.y, { width: PW });
    doc.y += 4;

    doc.font("Helvetica").fontSize(8.5).fillColor("#333")
      .text(
        `Declaro que tomei ciência do registro disciplinar nº ${registros[0].registro} ` +
        `vinculado ao(à) estudante ${aluno.estudante}, ` +
        `conforme detalhado na seção 3 deste documento.`,
        L, doc.y, { width: PW, lineGap: 2, align: "justify" }
      );
    doc.y += 8;

    const cidadeEscola = escola?.cidade || "Planaltina";
    doc.font("Helvetica").fontSize(9).fillColor("#333")
      .text(`${cidadeEscola} — DF, ${hoje()}.`, L, doc.y, { width: PW, align: "right" });
    doc.y += 20;

    // Assinatura centralizada do Responsável
    const sigW = PW * 0.50;
    const sigX = L + (PW - sigW) / 2;
    drawSigLine(sigX, doc.y, sigW, resp?.nome || "—", "Responsável Legal");
    doc.y += 50;

    // Rodapé da última página
    drawFooter();

    // Aguardar finalização e enviar buffer completo
    passThrough.on("end", () => {
      const pdfBuffer = Buffer.concat(pdfChunks);
      res.setHeader("Content-Length", pdfBuffer.length);
      res.end(pdfBuffer);
    });
    doc.end();

  } catch (err) {
    console.error("[RELATORIO-DISCIPLINAR] Erro ao gerar PDF individual:", err);
    if (!res.headersSent) res.status(500).json({ error: "Erro ao gerar impressão do registro disciplinar." });
  }
});

// ── Rota principal (PDF) ──────────────────────────────────────────────
router.get("/:alunoId", async (req, res) => {
  try {
    const { escola_id } = req.user;
    const { alunoId } = req.params;

    // ── Dados do banco ───────────────────────────────────────────────
    const [[escola]] = await pool.query(
      "SELECT id, nome, apelido, endereco, cidade, estado FROM escolas WHERE id = ?",
      [escola_id]
    );

    const [[aluno]] = await pool.query(
      `SELECT a.id, a.codigo, a.estudante, a.data_nascimento,
              t.nome AS turma, t.turno
       FROM alunos a
       LEFT JOIN turmas t ON t.id = a.turma_id
       WHERE a.id = ? AND a.escola_id = ?`,
      [alunoId, escola_id]
    );

    if (!aluno) return res.status(404).json({ error: "Aluno não encontrado." });

    const [[resp]] = await pool.query(
      `SELECT r.id, r.nome, r.cpf, r.email, r.telefone_celular, r.telefone_secundario, r.endereco
       FROM responsaveis r
       JOIN responsaveis_alunos ra ON ra.responsavel_id = r.id
       WHERE ra.aluno_id = ? AND ra.escola_id = ? AND ra.ativo = 1
       ORDER BY ra.id ASC LIMIT 1`,
      [alunoId, escola_id]
    );

    // Registros disciplinares — APENAS FINALIZADOS (exclui registrados e cancelados)
    const [rows] = await pool.query(
      `SELECT LPAD(o.id, 4, '0') AS registro,
              DATE_FORMAT(o.data_ocorrencia, '%d/%m/%Y') AS data,
              COALESCE(r.tipo_ocorrencia, 'N/D') AS tipo,
              COALESCE(r.medida_disciplinar, o.tipo_ocorrencia, 'N/D') AS medida,
              o.motivo,
              o.descricao,
              COALESCE(r.pontos, 0) AS pontos,
              o.status,
              o.convocar_responsavel,
              DATE_FORMAT(o.data_comparecimento_responsavel, '%d/%m/%Y') AS data_comparecimento
       FROM ocorrencias_disciplinares o
       LEFT JOIN registros_ocorrencias r
         ON r.descricao_ocorrencia = o.motivo AND r.tipo_ocorrencia = o.tipo_ocorrencia
       WHERE o.aluno_id = ? AND o.escola_id = ? AND o.status = 'FINALIZADA'
       ORDER BY o.data_ocorrencia ASC, o.id ASC`,
      [alunoId, escola_id]
    );

    const registros = rows;

    // Pontuação: soma dos pontos de TODOS os registros finalizados
    const PONTUACAO_INICIAL = 8.00;
    const totalPontos = rows.reduce((s, r) => s + Number(r.pontos || 0), 0);
    const pontuacaoFinal = Math.max(0, Math.min(10, PONTUACAO_INICIAL + totalPontos)).toFixed(2);
    const conceito = getConceito(pontuacaoFinal);

    // ── Logos ────────────────────────────────────────────────────────
    const logoLeft = join(__dirname, "..", "assets", "images", "brasao-gdf.png");
    const logoRight = join(__dirname, "..", "assets", "images", "logo-escola-right.png");
    const hasLogoLeft = existsSync(logoLeft);
    const hasLogoRight = existsSync(logoRight);

    // ══════════════════════════════════════════════════════════════════
    // GERAR PDF
    // ══════════════════════════════════════════════════════════════════
    const L = 40;
    const R = 40;
    const PW = 595.28 - L - R;
    const PAGE_H = 841.89;
    const FOOTER_Y = PAGE_H - 25;
    const MAX_Y = FOOTER_Y - 15;

    const doc = new PDFDocument({
      size: "A4",
      margins: { top: 30, bottom: 0, left: L, right: R },
      autoFirstPage: true,
      info: {
        Title: `Relatório Disciplinar - ${aluno.estudante}`,
        Author: "EDUCA.MELHOR — Sistema Educacional",
        Subject: "Relatório de Registros Disciplinares",
      },
    });

    res.setHeader("Content-Type", "application/pdf");
    const nomeArquivo = `relatorio_${aluno.codigo || aluno.id}.pdf`;
    res.setHeader("Content-Disposition", `inline; filename="${nomeArquivo}"`);

    const pdfChunks = [];
    const { PassThrough } = await import("stream");
    const passThrough = new PassThrough();
    passThrough.on("data", chunk => pdfChunks.push(chunk));
    doc.pipe(passThrough);

    let pageNum = 1;

    // ── Cores ──
    const COR_AZUL = "#1e3a5f";
    const COR_DOURADO = "#b8860b";
    const COR_CINZA = "#555";
    const COR_VERMELHO = "#c62828";
    const COR_VERDE = "#2e7d32";

    // ── Funções auxiliares ────────────────────────────────────────────
    function drawFooter() {
      doc.font("Helvetica").fontSize(6.5).fillColor("#aaa")
        .text(
          `Relatório de Registros Disciplinares • Documento gerado pelo EDUCA.MELHOR • Página ${pageNum}`,
          L, FOOTER_Y, { width: PW, align: "center", lineBreak: false }
        );
    }

    function drawLine(cor = "#ccc") {
      doc.moveTo(L, doc.y).lineTo(L + PW, doc.y).strokeColor(cor).lineWidth(0.5).stroke();
    }

    function label(text, x, y, w) {
      doc.font("Helvetica-Bold").fontSize(8).fillColor("#888").text(text.toUpperCase(), x, y, { width: w, lineBreak: false });
    }

    function value(text, x, y, w) {
      doc.font("Helvetica-Bold").fontSize(10).fillColor("#111").text(text || "—", x, y, { width: w, lineBreak: false });
    }

    function ensureSpace(needed) {
      if (doc.y + needed > MAX_Y) {
        drawFooter();
        doc.addPage();
        pageNum++;
        doc.y = 30;
      }
    }

    function drawSigLine(x, y, w, nome, cargo) {
      const lineY = y + 28;
      doc.moveTo(x, lineY).lineTo(x + w, lineY).strokeColor("#333").lineWidth(0.5).stroke();
      if (nome) {
        doc.font("Helvetica-Bold").fontSize(8).fillColor("#333")
          .text(nome, x, lineY + 3, { width: w, align: "center", lineBreak: false });
      }
      doc.font("Helvetica").fontSize(7).fillColor("#666")
        .text(cargo, x, lineY + (nome ? 13 : 3), { width: w, align: "center", lineBreak: false });
    }

    // ══════════════════════════════════════════════════════════════════
    // CABEÇALHO INSTITUCIONAL (idêntico ao TACE)
    // ══════════════════════════════════════════════════════════════════
    const headerTop = doc.y;
    const logoSize = 58;

    if (hasLogoLeft) {
      doc.image(logoLeft, L, headerTop, { width: logoSize, height: logoSize });
    }
    if (hasLogoRight) {
      doc.image(logoRight, L + PW - logoSize, headerTop, { width: logoSize, height: logoSize });
    }

    const hx = L + logoSize + 8;
    const hw = PW - (logoSize + 8) * 2;

    doc.font("Helvetica-Bold").fontSize(9).fillColor(COR_AZUL)
      .text("SECRETARIA DE ESTADO DE EDUCAÇÃO DO DISTRITO FEDERAL", hx, headerTop + 4, { width: hw, align: "center" });

    doc.font("Helvetica-Bold").fontSize(8.5).fillColor(COR_AZUL)
      .text(
        `COORDENAÇÃO REGIONAL DE ENSINO DE ${(escola?.cidade || "PLANALTINA").toUpperCase()}`,
        hx, doc.y + 1, { width: hw, align: "center" }
      );

    const escolaNome = escola?.nome || "CENTRO DE ENSINO FUNDAMENTAL 04";
    const escolaApelido = escola?.apelido || "";
    const nomeCompleto = escolaApelido ? `${escolaNome} — ${escolaApelido}` : escolaNome;
    doc.font("Helvetica-Bold").fontSize(9).fillColor(COR_AZUL)
      .text(nomeCompleto.toUpperCase(), hx, doc.y + 1, { width: hw, align: "center" });

    const enderecoEscola = escola?.endereco || "Endereço não cadastrado";
    doc.font("Helvetica").fontSize(7.5).fillColor(COR_CINZA)
      .text(enderecoEscola, hx, doc.y + 1, { width: hw, align: "center" });

    doc.y = headerTop + logoSize + 4;

    // Linhas decorativas
    doc.moveTo(L, doc.y).lineTo(L + PW, doc.y).strokeColor(COR_DOURADO).lineWidth(2).stroke();
    doc.y += 3;
    doc.moveTo(L, doc.y).lineTo(L + PW, doc.y).strokeColor(COR_AZUL).lineWidth(0.8).stroke();
    doc.y += 8;

    // TÍTULO
    doc.font("Helvetica-Bold").fontSize(14).fillColor(COR_AZUL)
      .text("RELATÓRIO DE REGISTROS DISCIPLINARES", L, doc.y, { width: PW, align: "center" });
    doc.y += 6;

    drawLine(); doc.y += 6;

    // ══════════════════════════════════════════════════════════════════
    // 1. IDENTIFICAÇÃO DO ESTUDANTE
    // ══════════════════════════════════════════════════════════════════
    doc.font("Helvetica-Bold").fontSize(10).fillColor(COR_AZUL)
      .text("1. IDENTIFICAÇÃO DO ESTUDANTE", L, doc.y, { width: PW });
    doc.y += 4;

    const yS1 = doc.y;
    label("Nome do Estudante", L, yS1, PW * 0.65);
    value(aluno.estudante, L, yS1 + 10, PW * 0.65);
    label("RE (Registro)", L + PW * 0.68, yS1, PW * 0.32);
    value(aluno.codigo || "—", L + PW * 0.68, yS1 + 10, PW * 0.32);
    doc.y = yS1 + 26;

    const yS1b = doc.y;
    label("Data de Nascimento", L, yS1b, PW * 0.35);
    value(fmtDataNasc(aluno.data_nascimento), L, yS1b + 10, PW * 0.35);
    doc.y = yS1b + 26;

    const yS2 = doc.y;
    label("Turma", L, yS2, PW * 0.35);
    value(aluno.turma || "—", L, yS2 + 10, PW * 0.35);
    label("Turno", L + PW * 0.38, yS2, PW * 0.25);
    value(aluno.turno || "—", L + PW * 0.38, yS2 + 10, PW * 0.25);

    // Boxes Pontuação + Comportamento
    const pontoX = L + PW * 0.66;
    const pontoW = PW * 0.16;
    const compX = L + PW * 0.83;
    const compW = PW * 0.17;
    const boxH = 28;

    doc.roundedRect(pontoX, yS2 - 2, pontoW, boxH, 4)
      .fillAndStroke(Number(pontuacaoFinal) >= 7 ? "#e8f5e9" : Number(pontuacaoFinal) >= 5 ? "#fff8e1" : "#ffebee",
                     Number(pontuacaoFinal) >= 7 ? COR_VERDE : Number(pontuacaoFinal) >= 5 ? COR_DOURADO : COR_VERMELHO);
    doc.font("Helvetica").fontSize(6.5).fillColor("#888")
      .text("PONTUAÇÃO", pontoX + 3, yS2, { width: pontoW - 6, align: "center" });
    doc.font("Helvetica-Bold").fontSize(12)
      .fillColor(Number(pontuacaoFinal) >= 7 ? COR_VERDE : Number(pontuacaoFinal) >= 5 ? COR_DOURADO : COR_VERMELHO)
      .text(String(pontuacaoFinal).replace(".", ","), pontoX + 3, yS2 + 10, { width: pontoW - 6, align: "center" });

    doc.roundedRect(compX, yS2 - 2, compW, boxH, 4)
      .fillAndStroke("#e3f2fd", COR_AZUL);
    doc.font("Helvetica").fontSize(6.5).fillColor("#888")
      .text("COMPORTAMENTO", compX + 3, yS2, { width: compW - 6, align: "center" });
    doc.font("Helvetica-Bold").fontSize(7.5).fillColor(COR_AZUL)
      .text(conceito, compX + 3, yS2 + 12, { width: compW - 6, align: "center" });

    doc.y = yS2 + boxH + 4;
    drawLine(); doc.y += 6;

    // ══════════════════════════════════════════════════════════════════
    // 2. IDENTIFICAÇÃO DO RESPONSÁVEL
    // ══════════════════════════════════════════════════════════════════
    doc.font("Helvetica-Bold").fontSize(10).fillColor(COR_AZUL)
      .text("2. IDENTIFICAÇÃO DO RESPONSÁVEL LEGAL", L, doc.y, { width: PW });
    doc.y += 4;

    const yR1 = doc.y;
    label("Nome do Responsável", L, yR1, PW * 0.55);
    value(resp?.nome || "—", L, yR1 + 10, PW * 0.55);
    label("CPF", L + PW * 0.58, yR1, PW * 0.42);
    value(fmtCpf(resp?.cpf), L + PW * 0.58, yR1 + 10, PW * 0.42);
    doc.y = yR1 + 26;

    const yR2 = doc.y;
    label("Endereço", L, yR2, PW * 0.55);
    value(resp?.endereco || "—", L, yR2 + 10, PW * 0.55);
    label("Telefone", L + PW * 0.58, yR2, PW * 0.42);
    value(fmtTel(resp?.telefone_celular), L + PW * 0.58, yR2 + 10, PW * 0.42);
    doc.y = yR2 + 26;

    drawLine(); doc.y += 6;

    // ══════════════════════════════════════════════════════════════════
    // 3. TABELA DE REGISTROS DISCIPLINARES (COM SUBLINHA DE DESCRIÇÃO)
    // ══════════════════════════════════════════════════════════════════
    doc.font("Helvetica-Bold").fontSize(10).fillColor(COR_AZUL)
      .text("3. REGISTROS DISCIPLINARES VINCULADOS", L, doc.y, { width: PW });
    doc.y += 4;

    const cols = [
      { label: "Nº",         w: 32,  align: "center" },
      { label: "DATA",       w: 55,  align: "center" },
      { label: "TIPO",       w: 45,  align: "center" },
      { label: "MEDIDA",     w: 105, align: "left"   },
      { label: "OCORRÊNCIA", w: PW - 32 - 55 - 45 - 105 - 40, align: "left" },
      { label: "PTS",        w: 40,  align: "center" },
    ];

    const TH = 16;
    const TR = 14;

    // Cabeçalho da tabela
    function drawTableHeader() {
      const headerY = doc.y;
      let tx = L;
      doc.rect(L, headerY, PW, TH).fill(COR_AZUL);
      cols.forEach(c => {
        doc.font("Helvetica-Bold").fontSize(7).fillColor("#fff")
          .text(c.label, tx + 2, headerY + 4, { width: c.w - 4, align: c.align, lineBreak: false });
        tx += c.w;
      });
      doc.y = headerY + TH;
    }

    drawTableHeader();

    // Nome do responsável para usar na info de comparecimento
    const nomeResp = resp?.nome || "Responsavel";

    // Linhas de dados — com paginacao manual
    registros.forEach((r, i) => {
      // Montar texto da sublinha: descricao + info de comparecimento
      let descricaoText = r.descricao ? String(r.descricao).trim() : "";

      // Se houve convocacao do responsavel, concatenar info de comparecimento
      if (Number(r.convocar_responsavel) === 1 && r.data_comparecimento) {
        const infoComparecimento = `${nomeResp} compareceu dia ${r.data_comparecimento} para tomar conhecimento deste registro.`;
        descricaoText = descricaoText
          ? `${descricaoText} ${infoComparecimento}`
          : infoComparecimento;
      }

      const descH = descricaoText
        ? Math.max(12, doc.font("Helvetica").fontSize(6.5).heightOfString(descricaoText, { width: PW - 16 }) + 6)
        : 0;
      const totalRowH = TR + descH;

      // Se nao cabe, rodape + nova pagina + repete header
      if (doc.y + totalRowH > MAX_Y) {
        drawFooter();
        doc.addPage();
        pageNum++;
        doc.y = 30;
        drawTableHeader();
      }

      // Linha principal do registro
      const bgColor = i % 2 === 0 ? "#f8f9fa" : "#ffffff";
      doc.rect(L, doc.y, PW, TR).fill(bgColor);

      let tx = L;
      const rowY = doc.y + 3;
      const vals = [
        r.registro,
        r.data,
        r.tipo,
        r.medida,
        r.motivo,
        String(r.pontos).replace(".", ","),
      ];

      cols.forEach((c, ci) => {
        const isNeg = ci === 5 && Number(r.pontos) < 0;
        const isPos = ci === 5 && Number(r.pontos) > 0;
        doc.font(ci === 5 ? "Helvetica-Bold" : "Helvetica").fontSize(7)
          .fillColor(isNeg ? COR_VERMELHO : isPos ? COR_VERDE : "#333")
          .text(vals[ci] || "—", tx + 2, rowY, { width: c.w - 4, align: c.align });
        tx += c.w;
      });
      doc.y += TR;

      // Sublinha com a Descricao da ocorrencia
      if (descricaoText) {
        const descY = doc.y;
        // Fundo levemente diferente para a descricao
        const descBg = i % 2 === 0 ? "#eef2f7" : "#f5f7fa";
        doc.rect(L, descY, PW, descH).fill(descBg);

        doc.font("Helvetica-Oblique").fontSize(6.5).fillColor("#555")
          .text(descricaoText, L + 10, descY + 3, { width: PW - 16, lineGap: 1 });
        doc.y = descY + descH;
      }
    });

    // Linha resumo
    const resumoH = TR + 4;
    const resumoY = doc.y;
    doc.rect(L, resumoY, PW, resumoH).fill("#e8eaf6");
    const resumoTextY = resumoY + (resumoH - 9) / 2;
    doc.font("Helvetica-Bold").fontSize(8).fillColor(COR_AZUL)
      .text("TOTAL DE REGISTROS: " + registros.length, L + 4, resumoTextY, { width: PW * 0.5, lineBreak: false });
    doc.y = resumoTextY;
    doc.font("Helvetica-Bold").fontSize(9)
      .fillColor(totalPontos < 0 ? COR_VERMELHO : COR_VERDE)
      .text(`Pontuação Total: ${totalPontos.toFixed(1).replace(".", ",")}`, L + PW * 0.6, resumoTextY, {
        width: PW * 0.4 - 4, align: "right", lineBreak: false,
      });
    doc.y = resumoY + resumoH + 4;

    drawLine(); doc.y += 6;

    // ══════════════════════════════════════════════════════════════════
    // 4. CIÊNCIA DO RESPONSÁVEL (apenas assinatura do responsável)
    // ══════════════════════════════════════════════════════════════════
    ensureSpace(120);
    doc.font("Helvetica-Bold").fontSize(10).fillColor(COR_AZUL)
      .text("4. CIÊNCIA DO RESPONSÁVEL LEGAL", L, doc.y, { width: PW });
    doc.y += 4;

    doc.font("Helvetica").fontSize(8.5).fillColor("#333")
      .text(
        `Declaro que tomei ciência de todos os registros disciplinares ` +
        `vinculados ao(à) estudante ${aluno.estudante}, ` +
        `conforme detalhado na seção 3 deste relatório, até a presente data.`,
        L, doc.y, { width: PW, lineGap: 2, align: "justify" }
      );
    doc.y += 8;

    const cidadeEscola = escola?.cidade || "Planaltina";
    doc.font("Helvetica").fontSize(9).fillColor("#333")
      .text(`${cidadeEscola} — DF, ${hoje()}.`, L, doc.y, { width: PW, align: "right" });
    doc.y += 20;

    // Assinatura centralizada do Responsável
    const sigW = PW * 0.50;
    const sigX = L + (PW - sigW) / 2;
    drawSigLine(sigX, doc.y, sigW, resp?.nome || "—", "Responsável Legal");
    doc.y += 50;

    // Rodapé da última página
    drawFooter();

    // Aguardar finalização e enviar buffer completo
    passThrough.on("end", () => {
      const pdfBuffer = Buffer.concat(pdfChunks);
      res.setHeader("Content-Length", pdfBuffer.length);
      res.end(pdfBuffer);
    });
    doc.end();

  } catch (err) {
    console.error("[RELATORIO-DISCIPLINAR] Erro ao gerar PDF:", err);
    if (!res.headersSent) res.status(500).json({ error: "Erro ao gerar Relatório Disciplinar." });
  }
});

export default router;
