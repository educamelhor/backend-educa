// routes/sala_recursos_pdf.js
// Gera PDF institucional da Ficha de Adequações Curriculares e PDI da Sala de Recursos
import PDFDocument from "pdfkit";
import { PassThrough } from "stream";
import pool from "../db.js";
import { getEscolaLogos } from "../utils/logoHelper.js";

const AZUL_ESCURO = "#1e3a5f";
const AZUL_MEDIO  = "#2563eb";
const VERDE_ESCURO = "#065f46";
const CINZA_TEXTO = "#374151";
const CINZA_LABEL = "#6b7280";
const CINZA_FUNDO = "#f8fafc";
const BORDA       = "#cbd5e1";
const DOURADO     = "#b8860b";

function formatDate(val) {
  if (!val) return "—";
  try {
    const s = String(val).slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
      const [y, m, d] = s.split("-");
      return `${d}/${m}/${y}`;
    }
    const d = new Date(val);
    return isNaN(d) ? "—" : d.toLocaleDateString("pt-BR");
  } catch {
    return "—";
  }
}

// ─── Cabeçalho Institucional Padrão SEEDF / Escola ───────────────────────────
async function drawInstitutionalHeader(doc, escola, logos, L, PW) {
  const top = doc.y;
  const sz = 52;
  if (logos.hasLeft)  doc.image(logos.left,  L, top, { width: sz, height: sz });
  if (logos.hasRight) doc.image(logos.right, L + PW - sz, top, { width: sz, height: sz });

  const hx = L + sz + 8;
  const hw = PW - (sz + 8) * 2;

  doc.font("Helvetica-Bold").fontSize(8.5).fillColor(AZUL_ESCURO)
    .text("GOVERNO DO DISTRITO FEDERAL — SECRETARIA DE ESTADO DE EDUCAÇÃO", hx, top + 2, { width: hw, align: "center" });
  doc.font("Helvetica-Bold").fontSize(8).fillColor(AZUL_ESCURO)
    .text(`COORDENAÇÃO REGIONAL DE ENSINO DE ${(escola?.cidade || "PLANALTINA").toUpperCase()}`, hx, doc.y + 1, { width: hw, align: "center" });
  
  const nomeEscola = escola?.apelido ? `${escola.nome} (${escola.apelido})` : (escola?.nome || "UNIDADE DE ENSINO");
  doc.font("Helvetica-Bold").fontSize(9).fillColor(AZUL_ESCURO)
    .text(nomeEscola.toUpperCase(), hx, doc.y + 1, { width: hw, align: "center" });
  
  doc.font("Helvetica").fontSize(7.5).fillColor(CINZA_LABEL)
    .text(escola?.endereco || "Distrito Federal — Brasil", hx, doc.y + 1, { width: hw, align: "center" });

  doc.y = top + sz + 6;
  doc.moveTo(L, doc.y).lineTo(L + PW, doc.y).strokeColor(DOURADO).lineWidth(2).stroke();
  doc.y += 3;
  doc.moveTo(L, doc.y).lineTo(L + PW, doc.y).strokeColor(AZUL_ESCURO).lineWidth(0.8).stroke();
  doc.y += 8;
}

// ─── Rodapé Institucional ─────────────────────────────────────────────────────
function drawInstitutionalFooter(doc, pageNum, L, PW, PAGE_H) {
  const footY = PAGE_H - 32;
  doc.moveTo(L, footY).lineTo(L + PW, footY).strokeColor(BORDA).lineWidth(0.5).stroke();
  doc.font("Helvetica").fontSize(7).fillColor(CINZA_LABEL)
    .text("SISTEMA EDUCA MELHOR — Módulo de Atendimento Educacional Especializado (AEE / Sala de Recursos)", L, footY + 4, { align: "left" });
  doc.font("Helvetica").fontSize(7).fillColor(CINZA_LABEL)
    .text(`Página ${pageNum} • Documento gerado em ${new Date().toLocaleDateString("pt-BR")} às ${new Date().toLocaleTimeString("pt-BR")}`, L, footY + 4, { width: PW, align: "right" });
}

// ─── Bloco com Caixa / Seção Estilizada ─────────────────────────────────────────
function drawSectionBox(doc, title, content, L, PW, PAGE_H, checkPageBreak) {
  checkPageBreak(50);
  
  // Título da Seção
  doc.font("Helvetica-Bold").fontSize(9.5).fillColor(AZUL_ESCURO);
  doc.rect(L, doc.y, PW, 16).fillAndStroke("#e0e7ff", "#c7d2fe");
  doc.fillColor(AZUL_ESCURO).text(title, L + 8, doc.y - 12, { width: PW - 16 });
  doc.y += 3;

  // Conteúdo da Seção
  const boxTop = doc.y;
  doc.font("Helvetica").fontSize(8.5).fillColor(CINZA_TEXTO);
  const textContent = content && String(content).trim().length > 0 ? String(content).trim() : "— Não informado / Não se aplica —";
  
  const textHeight = doc.heightOfString(textContent, { width: PW - 16, align: "justify" });
  checkPageBreak(textHeight + 10);

  doc.rect(L, doc.y, PW, textHeight + 10).fillAndStroke("#ffffff", BORDA);
  doc.fillColor(CINZA_TEXTO).text(textContent, L + 8, doc.y - (textHeight + 6), { width: PW - 16, align: "justify", lineGap: 1.5 });
  doc.y += 8;
}

// ─── GERAÇÃO DO PDF DE ADEQUAÇÃO CURRICULAR ──────────────────────────────────
export async function gerarPdfAdequacaoCurricular(adequacaoId, escolaId) {
  const [rows] = await pool.query(`
    SELECT 
      ac.*,
      a.codigo AS aluno_codigo,
      a.estudante AS aluno_nome,
      DATE_FORMAT(a.data_nascimento, '%Y-%m-%d') AS aluno_nascimento,
      t.nome AS turma_nome,
      t.turno AS turma_turno,
      e.nome AS escola_nome,
      e.apelido AS escola_apelido,
      e.cidade AS escola_cidade,
      e.endereco AS escola_endereco
    FROM aee_adequacoes_curriculares ac
    INNER JOIN alunos a ON a.id = ac.aluno_id
    INNER JOIN escolas e ON e.id = ac.escola_id
    LEFT JOIN matriculas m ON m.aluno_id = a.id AND m.escola_id = ac.escola_id AND m.ano_letivo = ac.ano_letivo
    LEFT JOIN turmas t ON t.id = m.turma_id
    WHERE ac.id = ? AND ac.escola_id = ?
    LIMIT 1
  `, [adequacaoId, escolaId]);

  if (!rows || rows.length === 0) {
    throw new Error("Adequação curricular não encontrada.");
  }

  const adeq = rows[0];

  // Busca laudos médicos do aluno
  const [laudos] = await pool.query(`
    SELECT cid, diagnostico, medico_nome, medico_crm
    FROM aee_laudos
    WHERE aluno_id = ? AND escola_id = ?
    ORDER BY id DESC
  `, [adeq.aluno_id, escolaId]);

  // Busca config AEE
  const [[aeeCfg]] = await pool.query(`
    SELECT tipo_atendimento, turno_atendimento, professor_aee
    FROM aee_alunos_config
    WHERE aluno_id = ? AND escola_id = ? AND ano_letivo = ?
    LIMIT 1
  `, [adeq.aluno_id, escolaId, adeq.ano_letivo]);

  const escola = {
    id: escolaId,
    nome: adeq.escola_nome,
    apelido: adeq.escola_apelido,
    cidade: adeq.escola_cidade,
    endereco: adeq.escola_endereco,
  };

  const logos = await getEscolaLogos(escolaId);

  return new Promise(async (resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: "A4",
        margins: { top: 30, bottom: 40, left: 36, right: 36 },
        bufferPages: true,
      });

      const pass = new PassThrough();
      const chunks = [];
      pass.on("data", (c) => chunks.push(c));
      pass.on("end", () => resolve(Buffer.concat(chunks)));
      pass.on("error", reject);
      doc.pipe(pass);

      const L = 36;
      const R = 36;
      const PW = 595.28 - L - R;
      const PAGE_H = 841.89;

      const checkPageBreak = (neededHeight) => {
        if (doc.y + neededHeight > PAGE_H - 50) {
          doc.addPage();
        }
      };

      // 1. Cabeçalho Institucional
      await drawInstitutionalHeader(doc, escola, logos, L, PW);

      // 2. Título do Documento
      doc.font("Helvetica-Bold").fontSize(12).fillColor(AZUL_ESCURO)
        .text("PLANO DE ADEQUAÇÃO CURRICULAR INDIVIDUALIZADA", L, doc.y, { width: PW, align: "center" });
      doc.font("Helvetica-Bold").fontSize(9.5).fillColor(VERDE_ESCURO)
        .text(`SALA DE RECURSOS / AEE — ANO LETIVO ${adeq.ano_letivo} • ${adeq.bimestre.toUpperCase()}`, L, doc.y + 2, { width: PW, align: "center" });
      doc.y += 10;

      // 3. Caixa de Identificação do Estudante
      doc.font("Helvetica-Bold").fontSize(9.5).fillColor(AZUL_ESCURO);
      doc.rect(L, doc.y, PW, 16).fillAndStroke("#f1f5f9", BORDA);
      doc.fillColor(AZUL_ESCURO).text("1. IDENTIFICAÇÃO DO ESTUDANTE E COMPONENTE CURRICULAR", L + 8, doc.y - 12, { width: PW - 16 });
      doc.y += 3;

      const cidsText = laudos.length > 0 
        ? laudos.map(l => l.cid ? `${l.cid} - ${l.diagnostico || ''}` : l.diagnostico).filter(Boolean).join(" | ")
        : "Em avaliação diagnóstica / Não informado";

      const infoLines = [
        [
          { label: "Estudante:", value: adeq.aluno_nome, width: PW * 0.6 },
          { label: "Código / Matrícula:", value: String(adeq.aluno_codigo || "—"), width: PW * 0.4 }
        ],
        [
          { label: "Turma:", value: `${adeq.turma_nome || "—"} (${adeq.turma_turno || "—"})`, width: PW * 0.35 },
          { label: "Data de Nasc.:", value: formatDate(adeq.aluno_nascimento), width: PW * 0.3 },
          { label: "Disciplina:", value: String(adeq.disciplina || "Geral").toUpperCase(), width: PW * 0.35 }
        ],
        [
          { label: "Diagnóstico / CID:", value: cidsText, width: PW }
        ],
        [
          { label: "Professor(a) Regente:", value: adeq.professor_regente || "—", width: PW * 0.5 },
          { label: "Professor(a) Sala de Recursos:", value: adeq.professor_aee || aeeCfg?.professor_aee || "—", width: PW * 0.5 }
        ]
      ];

      const infoBoxY = doc.y;
      doc.rect(L, infoBoxY, PW, 74).fillAndStroke("#ffffff", BORDA);
      let curY = infoBoxY + 6;

      infoLines.forEach(row => {
        let curX = L + 8;
        row.forEach(col => {
          doc.font("Helvetica-Bold").fontSize(8).fillColor(CINZA_LABEL)
            .text(col.label, curX, curY, { width: 90, continued: false });
          doc.font("Helvetica").fontSize(8.5).fillColor(CINZA_TEXTO)
            .text(col.value, curX + doc.widthOfString(col.label) + 4, curY, { width: col.width - doc.widthOfString(col.label) - 10, lineBreak: false });
          curX += col.width;
        });
        curY += 16;
      });

      doc.y = infoBoxY + 74 + 10;

      // 4. Seções da Adequação Curricular
      drawSectionBox(
        doc,
        "2. OBJETIVOS E HABILIDADES PRIORITÁRIAS / ADAPTADAS (BNCC / SEEDF)",
        adeq.habilidades_prioritarias,
        L, PW, PAGE_H, checkPageBreak
      );

      drawSectionBox(
        doc,
        "3. METODOLOGIAS, ESTRATÉGIAS PEDAGÓGICAS E MEDIAÇÃO",
        adeq.metodologias_estrategias,
        L, PW, PAGE_H, checkPageBreak
      );

      drawSectionBox(
        doc,
        "4. RECURSOS DIDÁTICOS, ACESSIBILIDADE E TECNOLOGIA ASSISTIVA",
        adeq.recursos_didaticos,
        L, PW, PAGE_H, checkPageBreak
      );

      drawSectionBox(
        doc,
        "5. CRITÉRIOS, INSTRUMENTOS E FORMAS DE AVALIAÇÃO DIFERENCIADA",
        adeq.avaliacao_adaptada,
        L, PW, PAGE_H, checkPageBreak
      );

      if (adeq.parecer_conclusivo && adeq.parecer_conclusivo.trim().length > 0) {
        drawSectionBox(
          doc,
          "6. PARECER DE ALINHAMENTO / OBSERVAÇÕES FINAIS",
          adeq.parecer_conclusivo,
          L, PW, PAGE_H, checkPageBreak
        );
      }

      // 5. Bloco de Assinaturas Oficiais
      checkPageBreak(90);
      doc.y += 10;
      const sigY = doc.y;
      const colW = (PW - 20) / 3;

      const sigs = [
        { cargo: "Professor(a) Regente", nome: adeq.professor_regente || "______________________" },
        { cargo: "Professor(a) Sala de Recursos (AEE)", nome: adeq.professor_aee || aeeCfg?.professor_aee || "______________________" },
        { cargo: "Coordenação Pedagógica / Direção", nome: "Coordenação / Equipe Gestora" }
      ];

      sigs.forEach((s, idx) => {
        const sx = L + idx * (colW + 10);
        doc.moveTo(sx, sigY + 30).lineTo(sx + colW, sigY + 30).strokeColor(CINZA_LABEL).lineWidth(0.8).stroke();
        doc.font("Helvetica-Bold").fontSize(7.5).fillColor(AZUL_ESCURO)
          .text(s.cargo, sx, sigY + 34, { width: colW, align: "center" });
        doc.font("Helvetica").fontSize(7).fillColor(CINZA_LABEL)
          .text(s.nome, sx, sigY + 44, { width: colW, align: "center" });
      });

      // Rodapés em todas as páginas
      const range = doc.bufferedPageRange();
      for (let i = range.start; i < range.start + range.count; i++) {
        doc.switchToPage(i);
        drawInstitutionalFooter(doc, i + 1, L, PW, PAGE_H);
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}
