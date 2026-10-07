// routes/media-anual-pdf.js
// ============================================================================
// Geração de PDF Institucional da Média Anual / Pontos Faltantes por Turma
// Padrão SEDF / CRE Planaltina / Escola Cívico-Militar (A4 Paisagem)
// ============================================================================

import PDFDocument from "pdfkit";
import { PassThrough } from "stream";
import pool from "../db.js";
import { getEscolaLogos } from "../utils/logoHelper.js";

const AZUL_HEADER = "#1e3a5f";
const AZUL_TABELA = "#1e3a8a";
const DOURADO = "#b8860b";
const CINZA_LABEL = "#555555";

function drawCheckmark(doc, x, y, size = 8, color = "#15803d") {
  doc.save();
  doc.lineWidth(1.6).strokeColor(color).lineCap("round").lineJoin("round");
  doc.moveTo(x, y + size * 0.52)
     .lineTo(x + size * 0.36, y + size * 0.88)
     .lineTo(x + size, y + size * 0.16)
     .stroke();
  doc.restore();
}

function calcularPontosFaltantes(media, soma) {
  if (media === null || media === undefined || isNaN(media)) return null;
  if (media >= 5.0) return 0;
  const somaAtual = soma !== undefined && soma !== null ? soma : (media * 4);
  const faltam = Math.max(0, 20.0 - somaAtual);
  return Number(faltam.toFixed(1));
}

function getMediaColors(media) {
  if (media === null || media === undefined || isNaN(media)) {
    return { bg: "#f8fafc", text: "#94a3b8", label: "—" };
  }
  const val = Number(media);
  const formatted = val.toFixed(1).replace(".", ",");
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
  const sz = 46;
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
    .text(enderecoInfo, hx, doc.y + 1.5, { width: hw, align: "center" });

  doc.y = Math.max(doc.y + 7, top + sz + 7);
  doc.moveTo(L, doc.y).lineTo(L + PW, doc.y).strokeColor(DOURADO).lineWidth(2).stroke();
  doc.y += 2.5;
  doc.moveTo(L, doc.y).lineTo(L + PW, doc.y).strokeColor(AZUL_HEADER).lineWidth(0.8).stroke();
  doc.y += 6;
}

function drawMetaBar(doc, turmaInfo, ano, totalAlunos, isPontosFaltantes, L, PW) {
  const barY = doc.y;
  const barH = 19;
  doc.roundedRect(L, barY, PW, barH, 4).fillAndStroke("#f1f5f9", "#cbd5e1");

  const titleW = 270;
  const titulo = isPontosFaltantes ? "PONTOS FALTANTES (META 5,0)" : "MÉDIA ANUAL ACUMULADA";
  doc.font("Helvetica-Bold").fontSize(8.5).fillColor(AZUL_TABELA)
    .text(titulo, L + 8, barY + 5.5, { width: titleW, lineBreak: false });

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

function drawLegend(doc, isPontosFaltantes, L, PW) {
  const legY = doc.y;
  const legH = 13;

  const items = isPontosFaltantes
    ? [
        { bg: "#dcfce7", border: "#86efac", text: "#15803d", label: "Meta atingida (Média >= 5,0)", isCheck: true },
        { bg: "#fee2e2", border: "#fca5a5", text: "#b91c1c", label: "Pontos faltantes para média 5,0", isCheck: false },
      ]
    : [
        { bg: "#dcfce7", border: "#86efac", text: "#15803d", label: "Média >= 7,0 (Destaque)", isCheck: false },
        { bg: "#fee2e2", border: "#fca5a5", text: "#b91c1c", label: "Média < 5,0 (Atenção)", isCheck: false },
        { bg: "#ffffff", border: "#cbd5e1", text: "#475569", label: "5,0 a 6,9 (Regular)", isCheck: false },
      ];

  let curX = L;
  for (const it of items) {
    doc.rect(curX, legY + 1.5, 9, 9).fillAndStroke(it.bg, it.border);
    if (it.isCheck) {
      drawCheckmark(doc, curX + 1.5, legY + 2.5, 6, "#15803d");
    }
    doc.font("Helvetica-Bold").fontSize(6.8).fillColor(it.text)
      .text(it.label, curX + 12, legY + 2.5, { lineBreak: false });
    curX += doc.font("Helvetica-Bold").fontSize(6.8).widthOfString(it.label) + 22;
  }

  const subtitulo = isPontosFaltantes
    ? "Cálculo: Meta anual de 20 pontos (5,0 x 4)  •  Registro Institucional"
    : "Cálculo contínuo: Soma das notas lançadas / 4  •  Registro Institucional";

  doc.font("Helvetica-Oblique").fontSize(6.5).fillColor("#94a3b8")
    .text(subtitulo, L, legY + 2.5, { width: PW, align: "right", lineBreak: false });

  doc.y = legY + legH + 3;
}

export async function gerarMediaAnualPdf(req, res) {
  try {
    const escola_id = req.user?.escola_id || req.escola_id;
    if (!escola_id) {
      return res.status(400).json({ ok: false, error: "escola_id ausente." });
    }

    const { turmaId } = req.params;
    const ano = parseInt(req.query.ano) || new Date().getFullYear();
    const modo = String(req.query.modo || "media").toLowerCase();
    const isPontosFaltantes = modo === "faltantes" || modo === "pontos";
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

    // 4) Médias e somas da turma no ano
    let rows = [];
    if (alunos.length > 0) {
      const alunoIds = alunos.map(a => a.id);
      const placeholders = alunoIds.map(() => "?").join(",");
      const [notaRows] = await db.query(
        `SELECT n.aluno_id, n.disciplina_id, d.nome AS disciplina, d.abreviatura,
                ROUND(SUM(n.nota), 1) AS soma,
                ROUND(SUM(n.nota) / 4.0, 1) AS media
         FROM notas n
         JOIN disciplinas d ON d.id = n.disciplina_id
         WHERE n.aluno_id IN (${placeholders})
           AND n.ano = ?
         GROUP BY n.aluno_id, n.disciplina_id, d.nome, d.abreviatura
         ORDER BY d.nome ASC`,
        [...alunoIds, ano]
      );
      rows = notaRows;
    }

    // 5) Lista de disciplinas
    const discMap = new Map();
    for (const r of rows) {
      if (!discMap.has(r.disciplina_id)) {
        discMap.set(r.disciplina_id, {
          id: r.disciplina_id,
          nome: r.disciplina,
          abreviatura: r.abreviatura || null,
        });
      }
    }

    // Complementa com disciplinas da modulação da turma
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

    // Mapas de médias e somas: { "alunoId_disciplinaId": valor }
    const mediasMap = {};
    const somasMap = {};
    for (const r of rows) {
      mediasMap[`${r.aluno_id}_${r.disciplina_id}`] = Number(r.media);
      somasMap[`${r.aluno_id}_${r.disciplina_id}`] = Number(r.soma);
    }

    // 6) Logos da Escola
    const logos = await getEscolaLogos(escola_id);

    // 7) Configuração do Documento PDFKit (A4 Paisagem)
    const L = 25;
    const R = 25;
    const PAGE_W = 841.89; // Paisagem A4
    const PAGE_H = 595.28;
    const PW = PAGE_W - L - R; // 791.89 pt
    const CONTENT_MAX_Y = PAGE_H - 30;

    const doc = new PDFDocument({
      size: "A4",
      layout: "landscape",
      margins: { top: 16, bottom: 0, left: L, right: R },
      bufferPages: true,
      info: {
        Title: `${isPontosFaltantes ? "Pontos Faltantes" : "Média Anual"} — ${turmaInfo.nome} — ${ano}`,
        Author: "EDUCA.MELHOR",
        Subject: "Relatório Pedagógico Institucional",
      },
    });

    const chunks = [];
    const pt = new PassThrough();
    pt.on("data", c => chunks.push(c));
    doc.pipe(pt);

    // Cabeçalho da página 1
    await drawHeader(doc, escola, logos, L, PW);
    drawMetaBar(doc, turmaInfo, ano, alunos.length, isPontosFaltantes, L, PW);
    drawLegend(doc, isPontosFaltantes, L, PW);

    // 8) Cálculo das colunas da tabela
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
            .text(`${isPontosFaltantes ? "PONTOS FALTANTES" : "MÉDIA ANUAL"} — ${turmaInfo.nome} (Continuação)`, L + 8, cY + 4, { lineBreak: false });
          doc.font("Helvetica").fontSize(7).fillColor("#64748b")
            .text(`TURNO: ${(turmaInfo.turno || "").toUpperCase()}   •   ANO: ${ano}`, L, cY + 4.5, { width: PW - 8, align: "right", lineBreak: false });
          doc.y = cY + 20;

          currentY = doc.y;
          drawTableHeader(currentY);
          currentY += 17;
        }

        const rowBg = i % 2 === 0 ? "#ffffff" : "#f8fafc";

        // Verifica destaque do aluno
        const mediasAluno = disciplinas
          .map(d => mediasMap[`${aluno.id}_${d.id}`])
          .filter(m => m !== undefined && m !== null);
        
        const isDestaque = isPontosFaltantes
          ? mediasAluno.length > 0 && mediasAluno.every(m => m >= 5.0)
          : mediasAluno.length > 0 && mediasAluno.every(m => m >= 7.0);

        // Nº
        doc.rect(L, currentY, colNumW, rowH).fillAndStroke("#f1f5f9", "#cbd5e1");
        doc.font("Helvetica-Bold").fontSize(6.8).fillColor("#475569")
          .text(nSeq, L, currentY + 3.2, { width: colNumW, align: "center", lineBreak: false });

        // Estudante
        const studentBg = isDestaque ? "#f0fdf4" : rowBg;
        const studentText = isDestaque ? "#15803d" : "#0f172a";
        doc.rect(L + colNumW, currentY, colNomeW, rowH).fillAndStroke(studentBg, "#cbd5e1");
        doc.font(isDestaque ? "Helvetica-Bold" : "Helvetica").fontSize(7.2).fillColor(studentText)
          .text(aluno.nome.toUpperCase(), L + colNumW + 5, currentY + 3.2, { width: colNomeW - 10, lineBreak: false, ellipsis: true });

        // Células
        let cellX = L + colNumW + colNomeW;
        for (const d of disciplinas) {
          const key = `${aluno.id}_${d.id}`;
          const media = mediasMap[key];
          const soma = somasMap[key];

          if (isPontosFaltantes) {
            const pontos = calcularPontosFaltantes(media, soma);
            if (media === undefined || media === null) {
              doc.rect(cellX, currentY, discColW, rowH).fillAndStroke("#f8fafc", "#cbd5e1");
              doc.font("Helvetica-Bold").fontSize(7).fillColor("#94a3b8")
                .text("—", cellX, currentY + 3.2, { width: discColW, align: "center", lineBreak: false });
            } else if (pontos === 0) {
              doc.rect(cellX, currentY, discColW, rowH).fillAndStroke("#dcfce7", "#cbd5e1");
              drawCheckmark(doc, cellX + (discColW / 2) - 4, currentY + 3, 8, "#15803d");
            } else {
              doc.rect(cellX, currentY, discColW, rowH).fillAndStroke("#fee2e2", "#cbd5e1");
              doc.font("Helvetica-Bold").fontSize(7).fillColor("#b91c1c")
                .text(pontos.toFixed(1).replace(".", ","), cellX, currentY + 3.2, { width: discColW, align: "center", lineBreak: false });
            }
          } else {
            const cellInfo = getMediaColors(media);
            doc.rect(cellX, currentY, discColW, rowH).fillAndStroke(cellInfo.bg, "#cbd5e1");
            doc.font("Helvetica-Bold").fontSize(7).fillColor(cellInfo.text)
              .text(cellInfo.label, cellX, currentY + 3.2, { width: discColW, align: "center", lineBreak: false });
          }

          cellX += discColW;
        }

        currentY += rowH;
      }

      // Linha de Resumo Institucional
      if (disciplinas.length > 0) {
        if (currentY + 16 > CONTENT_MAX_Y) {
          doc.addPage();
          await drawHeader(doc, escola, logos, L, PW);
          const cY = doc.y;
          doc.rect(L, cY, PW, 16).fillAndStroke("#f1f5f9", "#cbd5e1");
          doc.font("Helvetica-Bold").fontSize(7.5).fillColor(AZUL_TABELA)
            .text(`${isPontosFaltantes ? "PONTOS FALTANTES" : "MÉDIA ANUAL"} — ${turmaInfo.nome} (Continuação)`, L + 8, cY + 4, { lineBreak: false });
          doc.font("Helvetica").fontSize(7).fillColor("#64748b")
            .text(`TURNO: ${(turmaInfo.turno || "").toUpperCase()}   •   ANO: ${ano}`, L, cY + 4.5, { width: PW - 8, align: "right", lineBreak: false });
          doc.y = cY + 20;
          currentY = doc.y;
          drawTableHeader(currentY);
          currentY += 17;
        }

        const labelResumo = isPontosFaltantes
          ? "TOTAL COM PONTOS FALTANTES (< 5,0):"
          : "TOTAL ABAIXO DA MÉDIA (< 5,0):";

        doc.rect(L, currentY, colNumW + colNomeW, 15).fillAndStroke("#fee2e2", "#fca5a5");
        doc.font("Helvetica-Bold").fontSize(7).fillColor("#b91c1c")
          .text(labelResumo, L + 6, currentY + 4, { width: colNumW + colNomeW - 12, align: "right", lineBreak: false });

        let cellX = L + colNumW + colNomeW;
        for (const d of disciplinas) {
          let countAbaixo = 0;
          for (const a of alunos) {
            const val = mediasMap[`${a.id}_${d.id}`];
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

    // 9) Rodapés em todas as páginas com numeração "Página X de Y"
    const range = doc.bufferedPageRange();
    const dataEmissao = `${new Date().toLocaleDateString("pt-BR")} às ${new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`;
    const docTipo = isPontosFaltantes ? "Pontos Faltantes (Meta 5,0)" : "Média Anual";
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      const FOOTER_Y = PAGE_H - 18;
      doc.moveTo(L, FOOTER_Y - 3).lineTo(L + PW, FOOTER_Y - 3).strokeColor("#cbd5e1").lineWidth(0.5).stroke();
      doc.font("Helvetica").fontSize(6.5).fillColor("#64748b")
        .text(
          `${docTipo}  •  Turma: ${turmaInfo.nome}  •  Ano Letivo: ${ano}  •  Emissão: ${dataEmissao}  •  EDUCA.MELHOR  •  Página ${i + 1} de ${range.count}`,
          L, FOOTER_Y, { width: PW, align: "center", lineBreak: false }
        );
    }

    doc.end();

    await new Promise(resolve => pt.on("end", resolve));
    const pdfBuffer = Buffer.concat(chunks);

    const nomeTurmaArquivo = (turmaInfo.nome || "turma").replace(/\s+/g, "_").replace(/[^a-zA-Z0-9_]/g, "");
    const prefixo = isPontosFaltantes ? "Pontos_Faltantes" : "Media_Anual";
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${prefixo}_${nomeTurmaArquivo}_${ano}.pdf"`);
    res.setHeader("Content-Length", pdfBuffer.length);
    return res.end(pdfBuffer);
  } catch (err) {
    console.error("[MEDIA-ANUAL-PDF] Erro ao gerar PDF:", err);
    if (!res.headersSent) {
      return res.status(500).json({ ok: false, error: "Erro ao gerar PDF da média anual." });
    }
  }
}
