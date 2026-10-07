// routes/mapa-nota-pdf.js
// ============================================================================
// Geração de PDF Institucional do Mapa de Nota por Turma (A4 Paisagem)
// Padrão SEDF / CRE Planaltina / Escola Cívico-Militar
// ============================================================================

import PDFDocument from "pdfkit";
import { PassThrough } from "stream";
import pool from "../db.js";
import { getEscolaLogos } from "../utils/logoHelper.js";

const AZUL_HEADER = "#1e3a5f";
const AZUL_TABELA = "#1e3a8a";
const DOURADO = "#b8860b";
const CINZA_LABEL = "#555555";

function getNotaColors(nota, isFlagged) {
  if (nota === null || nota === undefined || isNaN(nota)) {
    return { bg: "#f8fafc", text: "#94a3b8", label: "—" };
  }
  const val = Number(nota);
  const formatted = val.toFixed(1).replace(".", ",");
  if (isFlagged) {
    return { bg: "#fef3c7", text: "#92400e", label: formatted }; // Amarelo
  }
  if (val >= 7.0) {
    return { bg: "#dcfce7", text: "#15803d", label: formatted }; // Verde
  }
  if (val < 5.0) {
    return { bg: "#fee2e2", text: "#b91c1c", label: formatted }; // Vermelho
  }
  return { bg: "#ffffff", text: "#334155", label: formatted }; // Neutro
}

async function drawHeader(doc, escola, logos, L, PW) {
  const top = doc.y;
  const sz = 44;
  if (logos.hasLeft) doc.image(logos.left, L, top, { width: sz, height: sz });
  if (logos.hasRight) doc.image(logos.right, L + PW - sz, top, { width: sz, height: sz });

  const hx = L + sz + 8;
  const hw = PW - (sz + 8) * 2;

  doc.font("Helvetica-Bold").fontSize(7.5).fillColor(AZUL_HEADER)
    .text("GOVERNO DO DISTRITO FEDERAL", hx, top, { width: hw, align: "center" });
  doc.font("Helvetica-Bold").fontSize(8.5).fillColor(AZUL_HEADER)
    .text("SECRETARIA DE ESTADO DE EDUCAÇÃO DO DISTRITO FEDERAL", hx, doc.y + 1, { width: hw, align: "center" });
  doc.font("Helvetica-Bold").fontSize(7.5).fillColor(AZUL_HEADER)
    .text(`COORDENAÇÃO REGIONAL DE ENSINO DE ${(escola?.cidade || "PLANALTINA").toUpperCase()}`, hx, doc.y + 1, { width: hw, align: "center" });
  
  const nome = escola?.apelido ? `${escola.nome} — ${escola.apelido}` : (escola?.nome || "CENTRO DE ENSINO FUNDAMENTAL 04");
  doc.font("Helvetica-Bold").fontSize(9.5).fillColor(AZUL_HEADER)
    .text(nome.toUpperCase(), hx, doc.y + 1, { width: hw, align: "center" });
  
  const enderecoInfo = escola?.endereco ? `${escola.endereco}  •  INEP 53006160` : "INEP 53006160";
  doc.font("Helvetica").fontSize(7).fillColor(CINZA_LABEL)
    .text(enderecoInfo, hx, doc.y + 1, { width: hw, align: "center" });

  doc.y = top + sz + 4;
  doc.moveTo(L, doc.y).lineTo(L + PW, doc.y).strokeColor(DOURADO).lineWidth(2).stroke();
  doc.y += 2.5;
  doc.moveTo(L, doc.y).lineTo(L + PW, doc.y).strokeColor(AZUL_HEADER).lineWidth(0.8).stroke();
  doc.y += 6;
}

function drawMetaBar(doc, turmaInfo, bimestre, ano, totalAlunos, L, PW) {
  const barY = doc.y;
  const barH = 19;
  doc.roundedRect(L, barY, PW, barH, 4).fillAndStroke("#f1f5f9", "#cbd5e1");

  const titleW = 220;
  doc.font("Helvetica-Bold").fontSize(8.5).fillColor(AZUL_TABELA)
    .text(`MAPA DE NOTA — ${bimestre}º BIMESTRE`, L + 8, barY + 5.5, { width: titleW, lineBreak: false });

  const infoX = L + titleW;
  const infoW = PW - titleW - 10;
  const metaItems = [
    `TURMA: ${turmaInfo?.nome || "—"}`,
    `TURNO: ${(turmaInfo?.turno || "—").toUpperCase()}`,
    `ANO LETIVO: ${ano}`,
    `TOTAL DE ESTUDANTES: ${totalAlunos}`,
    `EMISSÃO: ${new Date().toLocaleDateString("pt-BR")}`,
  ];

  doc.font("Helvetica").fontSize(7.2).fillColor("#334155")
    .text(metaItems.join("   •   "), infoX, barY + 6, { width: infoW, align: "right", lineBreak: false });

  doc.y = barY + barH + 4;
}

function drawLegend(doc, L, PW) {
  const legY = doc.y;
  const legH = 13;

  const items = [
    { bg: "#dcfce7", border: "#86efac", text: "#15803d", label: "Nota ≥ 7,0 (Destaque)" },
    { bg: "#fef3c7", border: "#f59e0b", text: "#92400e", label: "Sinalizado" },
    { bg: "#fee2e2", border: "#fca5a5", text: "#b91c1c", label: "Nota < 5,0 (Atenção)" },
    { bg: "#ffffff", border: "#cbd5e1", text: "#475569", label: "5,0 ≤ Nota < 7,0" },
  ];

  let curX = L;
  for (const it of items) {
    doc.rect(curX, legY + 1.5, 9, 9).fillAndStroke(it.bg, it.border);
    doc.font("Helvetica-Bold").fontSize(6.8).fillColor(it.text)
      .text(it.label, curX + 12, legY + 2.5, { lineBreak: false });
    curX += doc.font("Helvetica-Bold").fontSize(6.8).widthOfString(it.label) + 22;
  }

  doc.font("Helvetica-Oblique").fontSize(6.5).fillColor("#94a3b8")
    .text("Visão consolidada da turma  •  Registro Institucional", L, legY + 2.5, { width: PW, align: "right", lineBreak: false });

  doc.y = legY + legH + 3;
}

export async function gerarMapaNotaPdf(req, res) {
  try {
    const escola_id = req.user?.escola_id || req.escola_id;
    if (!escola_id) {
      return res.status(400).json({ ok: false, error: "escola_id ausente." });
    }

    const { turmaId } = req.params;
    const bimestre = parseInt(req.query.bimestre) || 1;
    const ano = parseInt(req.query.ano) || new Date().getFullYear();
    const db = req.db || pool;

    // 1) Dados da Escola
    const [[escola]] = await db.query(
      "SELECT id, nome, apelido, endereco, cidade FROM escolas WHERE id = ? LIMIT 1",
      [escola_id]
    );

    // 2) Dados da Turma
    const [[turmaInfo]] = await db.query(
      "SELECT id, nome, turno, serie FROM turmas WHERE id = ? AND escola_id = ? LIMIT 1",
      [turmaId, escola_id]
    );
    if (!turmaInfo) {
      return res.status(404).json({ ok: false, error: "Turma não encontrada." });
    }

    // 3) Alunos matriculados
    const [alunos] = await db.query(
      `SELECT DISTINCT a.id, a.estudante AS nome, a.codigo
       FROM matriculas m
       JOIN alunos a ON a.id = m.aluno_id
       WHERE m.turma_id = ? AND m.escola_id = ? AND m.ano_letivo = ?
       ORDER BY a.estudante ASC`,
      [turmaId, escola_id, ano]
    );

    // 4) Notas da turma
    let notasRows = [];
    if (alunos.length > 0) {
      const alunoIds = alunos.map(a => a.id);
      const placeholders = alunoIds.map(() => "?").join(",");
      const [rows] = await db.query(
        `SELECT n.aluno_id, n.disciplina_id, d.nome AS disciplina, d.abreviatura, n.nota
         FROM notas n
         JOIN disciplinas d ON d.id = n.disciplina_id
         WHERE n.aluno_id IN (${placeholders})
           AND n.bimestre = ?
           AND n.ano = ?
         ORDER BY d.nome ASC`,
        [...alunoIds, bimestre, ano]
      );
      notasRows = rows;
    }

    // 5) Flags
    const [flagsRows] = await db.query(
      `SELECT aluno_id, disciplina_id
       FROM mapa_nota_flags
       WHERE escola_id = ? AND bimestre = ? AND ano = ? AND flagged = 1`,
      [escola_id, bimestre, ano]
    );
    const flagsSet = new Set(flagsRows.map(f => `${f.aluno_id}_${f.disciplina_id}`));

    // 6) Lista de disciplinas
    const discMap = new Map();
    for (const n of notasRows) {
      if (!discMap.has(n.disciplina_id)) {
        discMap.set(n.disciplina_id, {
          id: n.disciplina_id,
          nome: n.disciplina,
          abreviatura: n.abreviatura || null,
        });
      }
    }

    // Complementa com disciplinas da modulação da turma (caso algum professor ainda não tenha lançado)
    try {
      const [modDiscs] = await db.query(
        `SELECT DISTINCT d.id, d.nome, d.abreviatura
         FROM modulacao mo
         JOIN disciplinas d ON d.id = mo.disciplina_id
         WHERE mo.turma_id = ? AND mo.escola_id = ?
         ORDER BY d.nome ASC`,
        [turmaId, escola_id]
      );
      for (const d of modDiscs) {
        if (!discMap.has(d.id)) {
          discMap.set(d.id, {
            id: d.id,
            nome: d.nome,
            abreviatura: d.abreviatura || null,
          });
        }
      }
    } catch {
      // Modulação opcional
    }

    const disciplinas = [...discMap.values()];

    // Mapa de notas: { "alunoId_disciplinaId": nota }
    const notasMap = {};
    for (const n of notasRows) {
      notasMap[`${n.aluno_id}_${n.disciplina_id}`] = Number(n.nota);
    }

    // 7) Logos da Escola
    const logos = await getEscolaLogos(escola_id);

    // 8) Configuração do Documento PDFKit (A4 Paisagem)
    const L = 25;
    const R = 25;
    const PAGE_W = 841.89; // Paisagem A4
    const PAGE_H = 595.28;
    const PW = PAGE_W - L - R; // 791.89 pt
    const CONTENT_MAX_Y = PAGE_H - 26;

    const doc = new PDFDocument({
      size: "A4",
      layout: "landscape",
      margins: { top: 16, bottom: 16, left: L, right: R },
      bufferPages: true,
      info: {
        Title: `Mapa de Nota — ${turmaInfo.nome} — ${bimestre}º Bimestre — ${ano}`,
        Author: "EDUCA.MELHOR",
        Subject: "Mapa de Nota Institucional",
      },
    });

    const chunks = [];
    const pt = new PassThrough();
    pt.on("data", c => chunks.push(c));
    doc.pipe(pt);

    // Cabeçalho da página 1
    await drawHeader(doc, escola, logos, L, PW);
    drawMetaBar(doc, turmaInfo, bimestre, ano, alunos.length, L, PW);
    drawLegend(doc, L, PW);

    // 9) Cálculo das colunas da tabela
    const colNumW = 22;
    const numDisc = disciplinas.length;
    let discColW = 46;
    let colNomeW = 220;

    if (numDisc > 0) {
      const maxDiscW = 50;
      const minDiscW = 34;
      discColW = Math.floor((PW - colNumW - 190) / numDisc);
      if (discColW > maxDiscW) discColW = maxDiscW;
      if (discColW < minDiscW) discColW = minDiscW;
      colNomeW = PW - colNumW - (discColW * numDisc);
    } else {
      colNomeW = PW - colNumW;
    }

    // Função para desenhar o cabeçalho da tabela
    const drawTableHeader = (y) => {
      const thH = 17;
      // Coluna Nº
      doc.rect(L, y, colNumW, thH).fillAndStroke(AZUL_TABELA, AZUL_TABELA);
      doc.font("Helvetica-Bold").fontSize(7).fillColor("#ffffff")
        .text("Nº", L, y + 4.5, { width: colNumW, align: "center", lineBreak: false });

      // Coluna Estudante
      doc.rect(L + colNumW, y, colNomeW, thH).fillAndStroke(AZUL_TABELA, AZUL_TABELA);
      doc.font("Helvetica-Bold").fontSize(7.5).fillColor("#ffffff")
        .text("ESTUDANTE", L + colNumW + 6, y + 4.5, { width: colNomeW - 12, align: "left", lineBreak: false });

      // Colunas Disciplinas
      let x = L + colNumW + colNomeW;
      for (const d of disciplinas) {
        doc.rect(x, y, discColW, thH).fillAndStroke(AZUL_TABELA, AZUL_TABELA);
        const sigla = (d.abreviatura || d.nome || "").slice(0, 6).toUpperCase();
        doc.font("Helvetica-Bold").fontSize(7).fillColor("#ffffff")
          .text(sigla, x, y + 4.5, { width: discColW, align: "center", lineBreak: false });
        x += discColW;
      }
      return thH;
    };

    let currentY = doc.y;
    drawTableHeader(currentY);
    currentY += 17;

    const rowH = 14;

    if (alunos.length === 0) {
      doc.rect(L, currentY, PW, 30).fillAndStroke("#f8fafc", "#cbd5e1");
      doc.font("Helvetica").fontSize(9).fillColor("#64748b")
        .text("Nenhum estudante matriculado nesta turma.", L, currentY + 10, { width: PW, align: "center" });
      currentY += 30;
    } else {
      for (let i = 0; i < alunos.length; i++) {
        const aluno = alunos[i];
        const nSeq = String(i + 1).padStart(2, "0");

        // Quebra de página automática
        if (currentY + rowH > CONTENT_MAX_Y) {
          doc.addPage();
          await drawHeader(doc, escola, logos, L, PW);

          // Faixa de continuação
          const cY = doc.y;
          doc.rect(L, cY, PW, 16).fillAndStroke("#f1f5f9", "#cbd5e1");
          doc.font("Helvetica-Bold").fontSize(7.5).fillColor(AZUL_TABELA)
            .text(`MAPA DE NOTA — ${turmaInfo.nome} — ${bimestre}º BIMESTRE (Continuação)`, L + 8, cY + 4, { lineBreak: false });
          doc.font("Helvetica").fontSize(7).fillColor("#64748b")
            .text(`TURNO: ${(turmaInfo.turno || "").toUpperCase()}   •   ANO: ${ano}`, L, cY + 4.5, { width: PW - 8, align: "right", lineBreak: false });
          doc.y = cY + 20;

          currentY = doc.y;
          drawTableHeader(currentY);
          currentY += 17;
        }

        const rowBg = i % 2 === 0 ? "#ffffff" : "#f8fafc";

        // Verifica se o estudante é destaque (todas as notas >= 7 e não flagged)
        const notasAluno = disciplinas.map(d => ({
          nota: notasMap[`${aluno.id}_${d.id}`],
          flagged: flagsSet.has(`${aluno.id}_${d.id}`),
        })).filter(x => x.nota !== undefined && x.nota !== null);
        const isDestaque = notasAluno.length > 0 && notasAluno.every(x => x.nota >= 7.0 && !x.flagged);

        // Nº
        doc.rect(L, currentY, colNumW, rowH).fillAndStroke("#f1f5f9", "#cbd5e1");
        doc.font("Helvetica-Bold").fontSize(6.8).fillColor("#475569")
          .text(nSeq, L, currentY + 3.2, { width: colNumW, align: "center", lineBreak: false });

        // Estudante
        const studentBg = isDestaque ? "#f0fdf4" : rowBg;
        const studentText = isDestaque ? "#15803d" : "#0f172a";
        doc.rect(L + colNumW, currentY, colNomeW, rowH).fillAndStroke(studentBg, "#cbd5e1");
        const displayNome = isDestaque ? `★  ${aluno.nome.toUpperCase()}` : aluno.nome.toUpperCase();
        doc.font(isDestaque ? "Helvetica-Bold" : "Helvetica").fontSize(7.2).fillColor(studentText)
          .text(displayNome, L + colNumW + 5, currentY + 3.2, { width: colNomeW - 10, lineBreak: false, ellipsis: true });

        // Células de Notas
        let cellX = L + colNumW + colNomeW;
        for (const d of disciplinas) {
          const key = `${aluno.id}_${d.id}`;
          const notaVal = notasMap[key];
          const isFlag = flagsSet.has(key);
          const cellInfo = getNotaColors(notaVal, isFlag);

          doc.rect(cellX, currentY, discColW, rowH).fillAndStroke(cellInfo.bg, "#cbd5e1");
          doc.font("Helvetica-Bold").fontSize(7).fillColor(cellInfo.text)
            .text(cellInfo.label, cellX, currentY + 3.2, { width: discColW, align: "center", lineBreak: false });

          cellX += discColW;
        }

        currentY += rowH;
      }

      // Linha de Resumo Institucional (Notas abaixo de 5,0)
      if (disciplinas.length > 0) {
        if (currentY + 16 > CONTENT_MAX_Y) {
          doc.addPage();
          await drawHeader(doc, escola, logos, L, PW);
          currentY = doc.y;
        }

        doc.rect(L, currentY, colNumW + colNomeW, 15).fillAndStroke("#fee2e2", "#fca5a5");
        doc.font("Helvetica-Bold").fontSize(7).fillColor("#b91c1c")
          .text("TOTAL ABAIXO DA MÉDIA (< 5,0):", L + 6, currentY + 4, { width: colNumW + colNomeW - 12, align: "right", lineBreak: false });

        let cellX = L + colNumW + colNomeW;
        for (const d of disciplinas) {
          let countAbaixo = 0;
          for (const a of alunos) {
            const val = notasMap[`${a.id}_${d.id}`];
            if (val !== undefined && val !== null && Number(val) < 5.0) {
              countAbaixo++;
            }
          }
          doc.rect(cellX, currentY, discColW, 15).fillAndStroke("#fee2e2", "#fca5a5");
          doc.font("Helvetica-Bold").fontSize(7).fillColor("#b91c1c")
            .text(String(countAbaixo), cellX, currentY + 4, { width: discColW, align: "center", lineBreak: false });
          cellX += discColW;
        }
        currentY += 15;
      }
    }

    // 10) Rodapés em todas as páginas com numeração "Página X de Y"
    const range = doc.bufferedPageRange();
    const dataEmissao = `${new Date().toLocaleDateString("pt-BR")} às ${new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`;
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      const FOOTER_Y = PAGE_H - 18;
      doc.moveTo(L, FOOTER_Y - 3).lineTo(L + PW, FOOTER_Y - 3).strokeColor("#cbd5e1").lineWidth(0.5).stroke();
      doc.font("Helvetica").fontSize(6.5).fillColor("#64748b")
        .text(
          `Mapa de Nota  •  Turma: ${turmaInfo.nome}  •  ${bimestre}º Bimestre  •  Ano Letivo: ${ano}  •  Emissão: ${dataEmissao}  •  EDUCA.MELHOR  •  Página ${i + 1} de ${range.count}`,
          L, FOOTER_Y, { width: PW, align: "center", lineBreak: false }
        );
    }

    doc.end();

    await new Promise(resolve => pt.on("end", resolve));
    const pdfBuffer = Buffer.concat(chunks);

    const nomeTurmaArquivo = (turmaInfo.nome || "turma").replace(/\s+/g, "_").replace(/[^a-zA-Z0-9_]/g, "");
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="Mapa_Nota_${nomeTurmaArquivo}_${bimestre}Bim_${ano}.pdf"`);
    res.setHeader("Content-Length", pdfBuffer.length);
    return res.end(pdfBuffer);
  } catch (err) {
    console.error("[MAPA-NOTA-PDF] Erro ao gerar PDF:", err);
    if (!res.headersSent) {
      return res.status(500).json({ ok: false, error: "Erro ao gerar PDF do mapa de notas." });
    }
  }
}
