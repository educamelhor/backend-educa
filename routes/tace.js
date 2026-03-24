// routes/tace.js
// ============================================================================
// Gera PDF do TACE — Termo de Ajuste de Conduta Escolar
// Documento oficial com cabeçalho institucional, registros disciplinares,
// reconhecimento dos fatos, compromisso e assinaturas.
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

// ── MOCK DATA ──────────────────────────────────────────────────────────
const MOCK_RECONHECIMENTO = `O(A) estudante acima identificado(a) apresentou, ao longo do período letivo, uma série de comportamentos que ferem diretamente o Regimento Interno e o Código de Conduta desta instituição de ensino. Os registros disciplinares demonstram um padrão reiterado de condutas incompatíveis com o ambiente escolar, incluindo desrespeito a professores e funcionários, envolvimento em situações de conflito com colegas, descumprimento de normas básicas de convivência e uso indevido de dispositivos eletrônicos durante as atividades pedagógicas.

A presente análise leva em consideração a totalidade dos registros lançados pelo corpo docente e pela equipe disciplinar, cujos detalhes estão discriminados na tabela acima. Destaca-se que o(a) estudante foi devidamente advertido(a) em cada ocorrência, tendo recebido orientação sobre as consequências de suas ações. Não obstante, verificou-se a persistência nas condutas irregulares, o que motivou a adoção de medidas progressivamente mais severas.

Diante do exposto, reconhece-se a necessidade de formalizar o presente Termo de Ajuste de Conduta Escolar como medida educativa e preventiva, visando a conscientização do(a) estudante e de sua família sobre a importância do respeito às normas institucionais.`;

const MOCK_COMPROMISSO = `Nesta data, na presença do(a) Comandante Disciplinar, do(a) estudante e de seu(sua) responsável legal, foram discutidas as ocorrências descritas neste documento. O(A) responsável legal tomou ciência de todos os registros disciplinares e das consequências decorrentes da continuidade das condutas irregulares.

Ficam, assim, estabelecidos os seguintes compromissos:

1. O(A) estudante compromete-se a respeitar integralmente o Regimento Interno, o Código de Conduta e as orientações do corpo docente e da equipe disciplinar;

2. O(A) estudante deverá manter postura compatível com o ambiente escolar, evitando qualquer conduta que prejudique o andamento das atividades pedagógicas ou a convivência harmônica;

3. O(A) responsável legal compromete-se a acompanhar de perto o comportamento do(a) estudante, comparecendo quando convocado(a) pela escola e implementando, no âmbito familiar, as medidas necessárias à correção das condutas;

4. Em caso de descumprimento dos termos aqui pactuados ou reincidência nas condutas irregulares, a instituição poderá adotar medidas mais severas, incluindo, mas não se limitando a: suspensão, transferência pedagógica ou encaminhamento ao Conselho Tutelar;

5. O presente termo possui validade para o ano letivo vigente, podendo ser renovado ou revogado pela Direção Disciplinar.

A assinatura deste documento não constitui punição, mas sim um ato de comprometimento mútuo entre a escola, o(a) estudante e sua família, visando a construção de um ambiente escolar mais justo e educativo.`;

const MOCK_REGISTROS = [
  { registro: "0001", data: "05/02/2026", tipo: "Leve",  medida: "Advertência Oral",    motivo: "Uso indevido de celular em sala de aula",     pontos: -0.1 },
  { registro: "0003", data: "12/02/2026", tipo: "Leve",  medida: "Advertência Oral",    motivo: "Atraso reiterado na chegada à escola",          pontos: -0.1 },
  { registro: "0005", data: "20/02/2026", tipo: "Média", medida: "Advertência Escrita", motivo: "Desacato ao professor ou funcionário",           pontos: -0.3 },
  { registro: "0008", data: "28/02/2026", tipo: "Leve",  medida: "Advertência Oral",    motivo: "Sair da sala de aula sem autorização",           pontos: -0.1 },
  { registro: "0012", data: "05/03/2026", tipo: "Média", medida: "Advertência Escrita", motivo: "Bullying ou intimidação de colegas",              pontos: -0.3 },
  { registro: "0014", data: "08/03/2026", tipo: "Grave", medida: "Suspensão",           motivo: "Envolver-se em rixa ou luta corporal",           pontos: -0.5 },
  { registro: "0016", data: "12/03/2026", tipo: "Leve",  medida: "Advertência Oral",    motivo: "Porte de material não permitido",                pontos: -0.1 },
  { registro: "0019", data: "15/03/2026", tipo: "Média", medida: "Ações Educativas",    motivo: "Vandalismo ou depredação do patrimônio",         pontos: -0.3 },
  { registro: "0021", data: "18/03/2026", tipo: "Leve",  medida: "Advertência Oral",    motivo: "Uso indevido de celular em sala de aula",        pontos: -0.1 },
  { registro: "0023", data: "20/03/2026", tipo: "Grave", medida: "Suspensão",           motivo: "Desacato ao professor ou funcionário (reincidência)", pontos: -0.5 },
];

// ── Auto-create table ─────────────────────────────────────────────────
async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tace_dados (
      id INT AUTO_INCREMENT PRIMARY KEY,
      aluno_id INT NOT NULL,
      escola_id INT NOT NULL,
      reconhecimento_fatos TEXT,
      compromisso_conduta TEXT,
      criado_em DATETIME DEFAULT CURRENT_TIMESTAMP,
      atualizado_em DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uk_aluno_escola (aluno_id, escola_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}
ensureTable().catch(err => console.error("[TACE] Erro ao criar tabela:", err));

// ── Rota GET /dados/:alunoId — buscar textos salvos ───────────────────
router.get("/dados/:alunoId", async (req, res) => {
  try {
    const { escola_id } = req.user;
    const { alunoId } = req.params;
    const [[row]] = await pool.query(
      "SELECT reconhecimento_fatos, compromisso_conduta FROM tace_dados WHERE aluno_id = ? AND escola_id = ?",
      [alunoId, escola_id]
    );
    res.json(row || { reconhecimento_fatos: "", compromisso_conduta: "" });
  } catch (err) {
    console.error("[TACE] Erro ao buscar dados:", err);
    res.status(500).json({ error: "Erro ao buscar dados do TACE." });
  }
});

// ── Rota POST /dados/:alunoId — salvar textos + criar ocorrência TACE ──
router.post("/dados/:alunoId", async (req, res) => {
  try {
    const { escola_id } = req.user;
    const { alunoId } = req.params;
    const { reconhecimento_fatos, compromisso_conduta } = req.body;

    // 1) Salvar/atualizar os textos do TACE
    await pool.query(
      `INSERT INTO tace_dados (aluno_id, escola_id, reconhecimento_fatos, compromisso_conduta)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         reconhecimento_fatos = VALUES(reconhecimento_fatos),
         compromisso_conduta  = VALUES(compromisso_conduta)`,
      [alunoId, escola_id, reconhecimento_fatos || "", compromisso_conduta || ""]
    );

    // 2) Inserir registro disciplinar do TACE (apenas se ainda não existir para este aluno)
    //    Tipo: TACE  |  Medida: Ajuste  |  Ocorrência: Termo de Ajuste de Conduta Escolar  |  PTS: -1,0
    const [[taceExistente]] = await pool.query(
      `SELECT id FROM ocorrencias_disciplinares
       WHERE aluno_id = ? AND escola_id = ? AND motivo = 'Termo de Ajuste de Conduta Escolar' AND tipo_ocorrencia = 'TACE'
       LIMIT 1`,
      [alunoId, escola_id]
    );

    let ocorrenciaId = taceExistente?.id || null;

    if (!taceExistente) {
      const hoje = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
      const [result] = await pool.query(
        `INSERT INTO ocorrencias_disciplinares
           (aluno_id, escola_id, data_ocorrencia, motivo, tipo_ocorrencia, descricao, convocar_responsavel)
         VALUES (?, ?, ?, 'Termo de Ajuste de Conduta Escolar', 'TACE', 'Registro de TACE — Termo de Ajuste de Conduta Escolar', 1)`,
        [alunoId, escola_id, hoje]
      );
      ocorrenciaId = result.insertId;
    }

    res.json({ ok: true, ocorrenciaId });
  } catch (err) {
    console.error("[TACE] Erro ao salvar dados:", err);
    res.status(500).json({ error: "Erro ao salvar dados do TACE." });
  }
});

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
      `SELECT r.nome, r.cpf, r.telefone_celular, r.telefone_secundario, r.endereco, r.email
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

    res.json({ valido: ausentes.length === 0, ausentes });
  } catch (err) {
    console.error("[TACE] Erro ao validar dados:", err);
    res.status(500).json({ error: "Erro ao validar dados." });
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

    const [[comandante]] = await pool.query(
      `SELECT u.nome FROM usuarios u
       WHERE u.escola_id = ? AND u.perfil IN ('militar', 'diretor') AND u.ativo = 1
       ORDER BY FIELD(u.perfil, 'militar', 'diretor') ASC LIMIT 1`,
      [escola_id]
    );

    // Registros disciplinares — apenas FINALIZADOS (registrados e cancelados não aparecem)
    const [rows] = await pool.query(
      `SELECT LPAD(o.id, 4, '0') AS registro,
              DATE_FORMAT(o.data_ocorrencia, '%d/%m/%Y') AS data,
              COALESCE(r.tipo_ocorrencia, 'N/D') AS tipo,
              COALESCE(r.medida_disciplinar, o.tipo_ocorrencia, 'N/D') AS medida,
              o.motivo,
              COALESCE(r.pontos, 0) AS pontos,
              o.status
       FROM ocorrencias_disciplinares o
       LEFT JOIN registros_ocorrencias r
         ON r.descricao_ocorrencia = o.motivo AND r.tipo_ocorrencia = o.tipo_ocorrencia
       WHERE o.aluno_id = ? AND o.escola_id = ? AND o.status = 'FINALIZADA'
       ORDER BY o.data_ocorrencia ASC, o.id ASC`,
      [alunoId, escola_id]
    );

    const registros = rows;

    // Pontuação: soma dos pontos de TODOS os registros exibidos na tabela
    const PONTUACAO_INICIAL = 8.00;
    const totalPontos = rows.reduce((s, r) => s + Number(r.pontos || 0), 0);

    const pontuacaoFinal = Math.max(0, Math.min(10, PONTUACAO_INICIAL + totalPontos)).toFixed(2);
    const conceito = getConceito(pontuacaoFinal);

    // ── Logos ────────────────────────────────────────────────────────
    // Esquerda = Brasão do GDF (Governo do Distrito Federal)
    const logoLeft = join(__dirname, "..", "assets", "images", "brasao-gdf.png");
    // Direita = Brasão da CCMDF (escola)
    const logoRight = join(__dirname, "..", "assets", "images", "logo-escola-right.png");
    const hasLogoLeft = existsSync(logoLeft);
    const hasLogoRight = existsSync(logoRight);

    // ══════════════════════════════════════════════════════════════════
    // GERAR PDF — bottom margin = 0 para DESABILITAR auto-paginação
    // do PDFKit (mesmo padrão do termo-consentimento.js que funciona)
    // ══════════════════════════════════════════════════════════════════
    const L = 40;
    const R = 40;
    const PW = 595.28 - L - R;
    const PAGE_H = 841.89;
    const FOOTER_Y = PAGE_H - 25;
    const MAX_Y = FOOTER_Y - 15;

    // IMPORTANTE: bottom = 0 desabilita completamente o auto-page do PDFKit
    const doc = new PDFDocument({
      size: "A4",
      margins: { top: 30, bottom: 0, left: L, right: R },
      autoFirstPage: true,
      info: {
        Title: `TACE - ${aluno.estudante}`,
        Author: "EDUCA.MELHOR — Sistema Educacional",
        Subject: "Termo de Ajuste de Conduta Escolar",
      },
    });

    res.setHeader("Content-Type", "application/pdf");
    const nomeArquivo = `tace_${aluno.codigo || aluno.id}.pdf`;
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${nomeArquivo}"`
    );

    // Coletar PDF em buffer para enviar tudo de uma vez
    const pdfChunks = [];
    const { PassThrough } = await import("stream");
    const passThrough = new PassThrough();
    passThrough.on("data", chunk => pdfChunks.push(chunk));
    doc.pipe(passThrough);

    let pageNum = 1;
    // Rastrear total de páginas para rodapé retroativo
    const pageStarts = [1]; // página 1 já existe

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
          `TACE — Termo de Ajuste de Conduta Escolar • Documento gerado pelo EDUCA.MELHOR • Página ${pageNum}`,
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

    // Garante espaço — se não couber, desenha rodapé e pula página
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

    // Logo esquerda = Brasão do GDF
    if (hasLogoLeft) {
      doc.image(logoLeft, L, headerTop, { width: logoSize, height: logoSize });
    }

    // Logo direita = CCMDF
    if (hasLogoRight) {
      doc.image(logoRight, L + PW - logoSize, headerTop, { width: logoSize, height: logoSize });
    }

    // Textos centralizados entre logos
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
      .text("TERMO DE AJUSTE DE CONDUTA ESCOLAR", L, doc.y, { width: PW, align: "center" });
    doc.font("Helvetica-Bold").fontSize(10).fillColor(COR_DOURADO)
      .text("— T.A.C.E. —", L, doc.y + 1, { width: PW, align: "center" });
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
    // 3. TABELA DE REGISTROS DISCIPLINARES
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

    // Linhas de dados — com paginação manual
    registros.forEach((r, i) => {
      // Se não cabe mais uma linha, rodapé + nova página + repete header
      if (doc.y + TR > MAX_Y) {
        drawFooter();
        doc.addPage();
        pageNum++;
        doc.y = 30;
        drawTableHeader();
      }

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
    });

    // Linha resumo — ambos os textos centralizados verticalmente na barra
    const resumoH = TR + 4;
    const resumoY = doc.y;
    doc.rect(L, resumoY, PW, resumoH).fill("#e8eaf6");
    const resumoTextY = resumoY + (resumoH - 9) / 2;
    doc.font("Helvetica-Bold").fontSize(8).fillColor(COR_AZUL)
      .text("TOTAL DE REGISTROS: " + registros.length, L + 4, resumoTextY, { width: PW * 0.5, lineBreak: false });
    // IMPORTANTE: resetar doc.y para que o segundo .text() não use posição deslocada
    doc.y = resumoTextY;
    doc.font("Helvetica-Bold").fontSize(9)
      .fillColor(totalPontos < 0 ? COR_VERMELHO : COR_VERDE)
      .text(`Pontuação Total: ${totalPontos.toFixed(1).replace(".", ",")}`, L + PW * 0.6, resumoTextY, {
        width: PW * 0.4 - 4, align: "right", lineBreak: false,
      });
    doc.y = resumoY + resumoH + 4;

    drawLine(); doc.y += 6;

    // ══════════════════════════════════════════════════════════════════
    // Função p/ renderizar texto longo parágrafo a parágrafo.
    // Calcula a altura ANTES de renderizar e faz paginação manual.
    // ══════════════════════════════════════════════════════════════════
    function renderLongText(text, fontSize, lineGap) {
      const paragraphs = text.split("\n").filter(Boolean);
      for (const para of paragraphs) {
        doc.font("Helvetica").fontSize(fontSize);
        const h = doc.heightOfString(para, { width: PW, lineGap, align: "justify" });
        // Se o parágrafo inteiro cabe, renderiza normalmente
        if (doc.y + h + 4 <= MAX_Y) {
          doc.font("Helvetica").fontSize(fontSize).fillColor("#333")
            .text(para, L, doc.y, { width: PW, lineGap, align: "justify" });
          doc.y += 2;
        } else {
          // Se não cabe, quebrar em sentenças para evitar corte abrupto
          // Primeiro tenta pular de página se já estamos muito embaixo
          if (doc.y > MAX_Y - 60) {
            drawFooter();
            doc.addPage();
            pageNum++;
            doc.y = 30;
          }
          doc.font("Helvetica").fontSize(fontSize).fillColor("#333")
            .text(para, L, doc.y, { width: PW, lineGap, align: "justify" });
          doc.y += 2;
          // Se o texto fez doc.y ultrapassar MAX_Y, não tem problema — bottom: 0
          // não gera páginas fantasmas. A próxima ensureSpace cuida.
        }
      }
    }

    // Buscar textos salvos do TACE (banco) — sem fallback para texto padrão
    let textoReconhecimento = "";
    let textoCompromisso = "";
    try {
      const [[taceDados]] = await pool.query(
        "SELECT reconhecimento_fatos, compromisso_conduta FROM tace_dados WHERE aluno_id = ? AND escola_id = ?",
        [alunoId, escola_id]
      );
      if (taceDados) {
        textoReconhecimento = taceDados.reconhecimento_fatos || "";
        textoCompromisso = taceDados.compromisso_conduta || "";
      }
    } catch (e) {
      console.warn("[TACE] Não foi possível buscar tace_dados:", e.message);
    }

    // ══════════════════════════════════════════════════════════════════
    // 4. RECONHECIMENTO DOS FATOS
    // ══════════════════════════════════════════════════════════════════
    ensureSpace(40);
    doc.font("Helvetica-Bold").fontSize(10).fillColor(COR_AZUL)
      .text("4. RECONHECIMENTO DOS FATOS", L, doc.y, { width: PW });
    doc.y += 4;

    renderLongText(textoReconhecimento, 8.5, 2);
    doc.y += 4;

    drawLine(); doc.y += 6;

    // ══════════════════════════════════════════════════════════════════
    // 5. COMPROMISSO DE AJUSTE DE CONDUTA
    // ══════════════════════════════════════════════════════════════════
    ensureSpace(40);
    doc.font("Helvetica-Bold").fontSize(10).fillColor(COR_AZUL)
      .text("5. COMPROMISSO DE AJUSTE DE CONDUTA", L, doc.y, { width: PW });
    doc.y += 4;

    renderLongText(textoCompromisso, 8.5, 2);
    doc.y += 4;

    drawLine(); doc.y += 6;

    // ══════════════════════════════════════════════════════════════════
    // 6. ASSINATURAS — todo o bloco junto (~170px)
    // ══════════════════════════════════════════════════════════════════
    ensureSpace(170);
    doc.font("Helvetica-Bold").fontSize(10).fillColor(COR_AZUL)
      .text("6. ASSINATURAS", L, doc.y, { width: PW });
    doc.y += 2;

    const cidadeEscola = escola?.cidade || "Planaltina";
    doc.font("Helvetica").fontSize(9).fillColor("#333")
      .text(`${cidadeEscola} — DF, ${hoje()}.`, L, doc.y, { width: PW, align: "right" });
    doc.y += 16;

    const sigLineW = PW * 0.42;
    const sigGap = PW * 0.16;

    // Estudante + Responsável
    const ySig1 = doc.y;
    drawSigLine(L, ySig1, sigLineW, aluno.estudante, "Estudante");
    drawSigLine(L + sigLineW + sigGap, ySig1, sigLineW, resp?.nome || "—", "Responsável Legal");
    doc.y = ySig1 + 46;

    // Comandante
    const cmdW = PW * 0.50;
    const cmdX = L + (PW - cmdW) / 2;
    drawSigLine(cmdX, doc.y, cmdW, comandante?.nome || "Diretor(a) Disciplinar", "Comandante Disciplinar");
    doc.y += 48;

    // Testemunhas — se não couber aqui, pula (mas junto com CPF)
    ensureSpace(60);
    const yTest = doc.y;
    drawSigLine(L, yTest, sigLineW, "", "1ª Testemunha");
    drawSigLine(L + sigLineW + sigGap, yTest, sigLineW, "", "2ª Testemunha");
    doc.y = yTest + 36;

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
    console.error("[TACE] Erro ao gerar PDF:", err);
    if (!res.headersSent) res.status(500).json({ error: "Erro ao gerar TACE." });
  }
});

export default router;
