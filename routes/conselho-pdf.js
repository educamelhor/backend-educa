// routes/conselho-pdf.js
// Gera PDF institucional do Conselho de Classe — Resumo
import { Router } from "express";
import PDFDocument from "pdfkit";
import { PassThrough } from "stream";
import pool from "../db.js";
import { getEscolaLogos } from "../utils/logoHelper.js";

const router = Router();

const AZUL = "#1e3a5f";
const VERDE = "#0a6640";
const CINZA = "#555555";
const CINZA_CLARO = "#f8fafc";
const BORDER = "#e2e8f0";
const DOURADO = "#b8860b";

function anoLetivoPadrao() {
  const m = new Date().getMonth() + 1;
  return m <= 1 ? new Date().getFullYear() - 1 : new Date().getFullYear();
}

const PERFIL_LABEL = {
  professor: "Professor",
  coordenador: "Coordenador",
  diretor: "Diretor",
  vice_diretor: "Vice-Diretor",
  supervisor: "Supervisor",
  pedagogo: "Pedagogo",
};

// ─── Cabeçalho institucional (padrão do sistema) ──────────────────────────────
async function drawHeader(doc, escola, logos, L, PW) {
  const top = doc.y;
  const sz = 58;
  if (logos.hasLeft)  doc.image(logos.left,  L,          top, { width: sz, height: sz });
  if (logos.hasRight) doc.image(logos.right, L + PW - sz, top, { width: sz, height: sz });

  const hx = L + sz + 8;
  const hw = PW - (sz + 8) * 2;

  doc.font("Helvetica-Bold").fontSize(8.5).fillColor(AZUL)
    .text("SECRETARIA DE ESTADO DE EDUCAÇÃO DO DISTRITO FEDERAL", hx, top + 4, { width: hw, align: "center" });
  doc.font("Helvetica-Bold").fontSize(8).fillColor(AZUL)
    .text(`COORDENAÇÃO REGIONAL DE ENSINO DE ${(escola?.cidade || "PLANALTINA").toUpperCase()}`, hx, doc.y + 1, { width: hw, align: "center" });
  const nome = escola?.apelido ? `${escola.nome} — ${escola.apelido}` : (escola?.nome || "");
  doc.font("Helvetica-Bold").fontSize(9).fillColor(AZUL)
    .text(nome.toUpperCase(), hx, doc.y + 1, { width: hw, align: "center" });
  doc.font("Helvetica").fontSize(7.5).fillColor(CINZA)
    .text(escola?.endereco || "", hx, doc.y + 1, { width: hw, align: "center" });

  doc.y = top + sz + 4;
  doc.moveTo(L, doc.y).lineTo(L + PW, doc.y).strokeColor(DOURADO).lineWidth(2).stroke();
  doc.y += 3;
  doc.moveTo(L, doc.y).lineTo(L + PW, doc.y).strokeColor(AZUL).lineWidth(0.8).stroke();
  doc.y += 10;
}

// ─── Rodapé ──────────────────────────────────────────────────────────────────
function drawFooter(doc, pageNum, L, PW, PAGE_H) {
  const FOOTER_Y = PAGE_H - 25;
  doc.font("Helvetica").fontSize(6.5).fillColor("#aaa")
    .text(
      `Conselho de Classe — Resumo  •  Gerado em ${new Date().toLocaleDateString("pt-BR")} às ${new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}  •  EDUCA.MELHOR  •  Página ${pageNum}`,
      L, FOOTER_Y, { width: PW, align: "center", lineBreak: false }
    );
}

// ─── GET /resumo-turma/pdf ─────────────────────────────────────────────────────
router.get("/resumo-turma/pdf", async (req, res) => {
  try {
    const escola_id = req.escola_id ?? req.user?.escola_id;
    if (!escola_id) return res.status(400).json({ ok: false, error: "escola_id ausente." });

    const { turma_id, ano_letivo } = req.query;
    if (!turma_id) return res.status(400).json({ ok: false, error: "turma_id é obrigatório." });

    const db = req.db || pool;
    const ano = ano_letivo ? Number(ano_letivo) : anoLetivoPadrao();

    // 1) Escola
    const [[escola]] = await db.query(
      "SELECT nome, apelido, endereco, cidade FROM escolas WHERE id = ? LIMIT 1", [escola_id]
    );

    // 2) Turma
    const [[turmaInfo]] = await db.query(
      `SELECT id, nome, turno, serie FROM turmas WHERE id = ? AND escola_id = ? LIMIT 1`,
      [turma_id, escola_id]
    );
    if (!turmaInfo) return res.status(404).json({ ok: false, error: "Turma não encontrada." });

    // 3) Alunos ativos
    const [alunos] = await db.query(
      `SELECT a.codigo, a.nome, m.numero_chamada
       FROM alunos a
       INNER JOIN matriculas m ON m.aluno_id = a.id AND m.turma_id = ? AND m.ano_letivo = ? AND m.status = 'ativo'
       WHERE a.escola_id = ?
       ORDER BY m.numero_chamada ASC, a.nome ASC`,
      [turma_id, ano, escola_id]
    );

    // 4) Registros de conselho
    let registrosPorAluno = {};
    if (alunos.length > 0) {
      const codigos = alunos.map(a => a.codigo);
      const ph = codigos.map(() => '?').join(',');
      const [registros] = await db.query(
        `SELECT aluno_codigo, texto, usuario_nome, usuario_perfil, criado_em
         FROM registro_conselho
         WHERE escola_id = ? AND turma_id = ? AND aluno_codigo IN (${ph}) AND (excluido IS NULL OR excluido = 0)
         ORDER BY aluno_codigo ASC, criado_em ASC`,
        [escola_id, turma_id, ...codigos]
      );
      for (const r of registros) {
        if (!registrosPorAluno[r.aluno_codigo]) registrosPorAluno[r.aluno_codigo] = [];
        registrosPorAluno[r.aluno_codigo].push(r);
      }
    }

    // 5) Logos
    const logos = await getEscolaLogos(escola_id);

    // 6) Montar PDF
    const L = 40, R = 40;
    const PW = 595.28 - L - R;
    const PAGE_H = 841.89;
    const CONTENT_MAX_Y = PAGE_H - 45;

    const doc = new PDFDocument({
      size: "A4",
      margins: { top: 30, bottom: 40, left: L, right: R },
      autoFirstPage: true,
      info: {
        Title: `Conselho de Classe — Resumo — ${turmaInfo.nome} — ${ano}`,
        Author: "EDUCA.MELHOR",
        Subject: "Conselho de Classe",
      },
    });

    const nomeTurmaArquivo = (turmaInfo.nome || "turma").replace(/\s/g, "_").replace(/[^a-zA-Z0-9_]/g, "");
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="Conselho_${nomeTurmaArquivo}_${ano}.pdf"`);

    const chunks = [];
    const pt = new PassThrough();
    pt.on("data", c => chunks.push(c));
    doc.pipe(pt);

    let pageNum = 1;
    const addFooter = () => drawFooter(doc, pageNum, L, PW, PAGE_H);
    const addPage = () => {
      addFooter();
      doc.addPage();
      pageNum++;
      drawHeader(doc, escola, logos, L, PW);
    };

    // Cabeçalho da primeira página
    await drawHeader(doc, escola, logos, L, PW);

    // Título principal
    doc.font("Helvetica-Bold").fontSize(14).fillColor(AZUL)
      .text("CONSELHO DE CLASSE — RESUMO", L, doc.y, { width: PW, align: "center" });
    doc.y += 4;
    doc.moveTo(L, doc.y).lineTo(L + PW, doc.y).strokeColor(DOURADO).lineWidth(1.5).stroke();
    doc.y += 8;

    // Info da turma
    const infoH = 22;
    doc.roundedRect(L, doc.y, PW, infoH, 4).fill("#f0f4ff");
    doc.roundedRect(L, doc.y, PW, infoH, 4).strokeColor("#c7d2fe").lineWidth(0.5).stroke();
    const colW = PW / 4;
    const infoY = doc.y + 5;
    [
      ["Turma:", turmaInfo.nome],
      ["Turno:", turmaInfo.turno || "—"],
      ["Ano Letivo:", String(ano)],
      ["Total de Alunos:", String(alunos.length)],
    ].forEach(([lbl, val], i) => {
      doc.font("Helvetica-Bold").fontSize(7).fillColor(CINZA).text(lbl, L + colW * i + 6, infoY);
      doc.font("Helvetica-Bold").fontSize(8).fillColor(AZUL).text(val, L + colW * i + 6, infoY + 8);
    });
    doc.y += infoH + 14;

    // ─── Por aluno ─────────────────────────────────────────────────────────────
    for (let idx = 0; idx < alunos.length; idx++) {
      const aluno = alunos[idx];
      const regs = registrosPorAluno[aluno.codigo] || [];
      const nChamada = aluno.numero_chamada ? String(aluno.numero_chamada).padStart(2, "0") : "--";

      // Estimativa de espaço: cabeçalho do aluno + registros
      const estimativa = 30 + (regs.length === 0 ? 24 : regs.length * 48) + 12;
      if (doc.y + estimativa > CONTENT_MAX_Y) addPage();

      // --- Card: cabeçalho do aluno ---
      const alunoHeaderH = 26;
      doc.rect(L, doc.y, PW, alunoHeaderH).fill(AZUL);
      doc.font("Helvetica-Bold").fontSize(10).fillColor("#ffffff")
        .text(`Nº ${nChamada}  —  ${aluno.nome.toUpperCase()}`, L + 10, doc.y + 8, { width: PW - 20 });
      doc.y += alunoHeaderH + 6;

      if (regs.length === 0) {
        // Sem registros
        doc.rect(L, doc.y, PW, 20).fill(CINZA_CLARO);
        doc.rect(L, doc.y, PW, 20).strokeColor(BORDER).lineWidth(0.5).stroke();
        doc.font("Helvetica").fontSize(8).fillColor("#94a3b8")
          .text("Nenhuma observação registrada para este aluno.", L + 10, doc.y + 6, { width: PW - 20 });
        doc.y += 20 + 10;
      } else {
        // Registros do aluno
        for (const reg of regs) {
          const perfilLabel = PERFIL_LABEL[reg.usuario_perfil] || (reg.usuario_perfil || "Usuário");
          const dataFormatada = reg.criado_em
            ? new Date(reg.criado_em).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })
            : "—";

          // estima linhas do texto
          const charsPerLine = Math.floor((PW - 32) / 5.5);
          const nLines = Math.ceil((reg.texto || "").length / charsPerLine);
          const regH = Math.max(40, 22 + nLines * 11);

          if (doc.y + regH + 4 > CONTENT_MAX_Y) addPage();

          // Borda esquerda colorida por perfil
          const perfilCor = reg.usuario_perfil === "professor" ? "#3b82f6"
            : reg.usuario_perfil === "coordenador" ? "#10b981"
            : reg.usuario_perfil === "diretor" ? "#8b5cf6" : "#64748b";

          doc.rect(L, doc.y, PW, regH).fill("#f8fafc");
          doc.rect(L, doc.y, PW, regH).strokeColor(BORDER).lineWidth(0.5).stroke();
          doc.rect(L, doc.y, 4, regH).fill(perfilCor); // barra colorida à esquerda

          // Texto do registro
          doc.font("Helvetica").fontSize(8.5).fillColor("#1e293b")
            .text(reg.texto || "", L + 12, doc.y + 8, { width: PW - 24, lineGap: 2 });

          // Rodapé do registro: Autor e data
          const rodapeY = doc.y - 11;
          doc.font("Helvetica-Bold").fontSize(7).fillColor(perfilCor)
            .text(`${reg.usuario_nome || "—"}  •  ${perfilLabel}`, L + 12, rodapeY, { width: PW / 2 - 12 });
          doc.font("Helvetica").fontSize(7).fillColor("#94a3b8")
            .text(dataFormatada, L + PW / 2, rodapeY, { width: PW / 2 - 12, align: "right" });

          doc.y += regH + 4;
        }
        doc.y += 6;
      }
    }

    // Rodapé da última página
    addFooter();
    doc.end();

    pt.on("end", () => {
      const buf = Buffer.concat(chunks);
      res.end(buf);
    });
    pt.on("error", err => {
      console.error("[CONSELHO-PDF] Stream error:", err);
      res.status(500).end();
    });
  } catch (err) {
    console.error("[CONSELHO-PDF] Erro:", err);
    if (!res.headersSent) res.status(500).json({ ok: false, error: "Erro ao gerar PDF." });
  }
});

export default router;
