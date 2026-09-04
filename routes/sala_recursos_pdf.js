// routes/sala_recursos_pdf.js
// Gera PDF institucional da Ficha de Adequações Curriculares (Padrão SEEDF), Ficha Individual e Prontuário AEE
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
const BORDA_ESCURA = "#475569";
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
  const sz = 50;
  if (logos?.hasLeft)  doc.image(logos.left,  L, top, { width: sz, height: sz });
  if (logos?.hasRight) doc.image(logos.right, L + PW - sz, top, { width: sz, height: sz });

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
    .text("SISTEMA EDUCA MELHOR — Módulo Sala de Recursos / AEE (Padrão SEEDF)", L, footY + 4, { align: "left" });
  doc.font("Helvetica").fontSize(7).fillColor(CINZA_LABEL)
    .text(`Página ${pageNum} • Emissão: ${new Date().toLocaleDateString("pt-BR")} às ${new Date().toLocaleTimeString("pt-BR")}`, L, footY + 4, { width: PW, align: "right" });
}

// ─── 1. GERAÇÃO DO PDF DE ADEQUAÇÃO CURRICULAR (PADRÃO OFICIAL SEEDF) ─────────
// Espelho fiel do documento "Adequação em branco.docx"
export async function gerarPdfAdequacaoSEEDF({
  escolaId,
  alunoId,
  adequacaoId,
  anoLetivo = new Date().getFullYear(),
  bimestre = "",
  disciplina = "",
  professorRegente = "",
  emBranco = false,
}) {
  // 1. Busca dados da escola
  const [[escola]] = await pool.query(
    "SELECT id, nome, apelido, cidade, endereco FROM escolas WHERE id = ? LIMIT 1",
    [escolaId]
  );

  // 2. Busca dados do aluno se alunoId for informado
  let aluno = null;
  let laudos = [];
  let aeeCfg = null;
  let adeq = null;

  if (adequacaoId) {
    const [[adeqDb]] = await pool.query(`
      SELECT ac.*, t.nome AS turma_nome, t.turno AS turma_turno, t.serie AS turma_serie
      FROM aee_adequacoes_curriculares ac
      INNER JOIN alunos a ON a.id = ac.aluno_id
      LEFT JOIN matriculas m ON m.aluno_id = a.id AND m.escola_id = ac.escola_id AND m.ano_letivo = ac.ano_letivo
      LEFT JOIN turmas t ON t.id = m.turma_id
      WHERE ac.id = ? AND ac.escola_id = ?
      LIMIT 1
    `, [adequacaoId, escolaId]);
    if (adeqDb) {
      adeq = adeqDb;
      alunoId = adeq.aluno_id;
      anoLetivo = adeq.ano_letivo || anoLetivo;
      bimestre = adeq.bimestre || bimestre;
      disciplina = adeq.disciplina || disciplina;
      professorRegente = adeq.professor_regente || professorRegente;
    }
  }

  if (alunoId) {
    const [[alunoDb]] = await pool.query(`
      SELECT 
        a.id, a.codigo, a.estudante, 
        DATE_FORMAT(a.data_nascimento, '%Y-%m-%d') AS data_nascimento,
        t.id AS turma_id, t.nome AS turma_nome, t.turno AS turma_turno, t.serie AS turma_serie
      FROM alunos a
      LEFT JOIN matriculas m ON m.aluno_id = a.id AND m.escola_id = a.escola_id AND m.ano_letivo = ?
      LEFT JOIN turmas t ON t.id = m.turma_id
      WHERE a.id = ? AND a.escola_id = ?
      LIMIT 1
    `, [anoLetivo, alunoId, escolaId]);
    aluno = alunoDb || null;

    if (aluno) {
      const [laudosDb] = await pool.query(
        "SELECT cid, diagnostico FROM aee_laudos WHERE aluno_id = ? AND escola_id = ? ORDER BY id DESC",
        [alunoId, escolaId]
      );
      laudos = laudosDb || [];

      const [[cfgDb]] = await pool.query(
        "SELECT tipo_atendimento, professor_aee FROM aee_alunos_config WHERE aluno_id = ? AND escola_id = ? AND ano_letivo = ? LIMIT 1",
        [alunoId, escolaId, anoLetivo]
      );
      aeeCfg = cfgDb || null;
    }
  }

  // Se não veio adeq preenchido mas temos alunoId, busca adequação correspondente se existir
  if (!adeq && !emBranco && alunoId && disciplina && bimestre) {
    const [[adeqFound]] = await pool.query(`
      SELECT * FROM aee_adequacoes_curriculares
      WHERE aluno_id = ? AND escola_id = ? AND ano_letivo = ? AND bimestre = ? AND disciplina = ?
      LIMIT 1
    `, [alunoId, escolaId, anoLetivo, bimestre, disciplina]);
    if (adeqFound) adeq = adeqFound;
  }

  return new Promise(async (resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: "A4",
        layout: "landscape",
        margins: { top: 20, bottom: 20, left: 24, right: 24 },
        bufferPages: true,
      });

      const pass = new PassThrough();
      const chunks = [];
      pass.on("data", (c) => chunks.push(c));
      pass.on("end", () => resolve(Buffer.concat(chunks)));
      pass.on("error", reject);
      doc.pipe(pass);

      // A4 Landscape: 841.89 x 595.28 pt
      const L = 24;
           // 1. Bloco de Identificação do Estudante (sem cabeçalho da escola, espelho fiel SEEDF)
      const PRETO = "#000000";
      const CINZA_PAUTA = "#d1d5db";
      const FUNDO_CABECALHO = "#f8fafc";

      const cidsText = laudos.length > 0
        ? laudos.map((l) => (l.cid ? `CID ${l.cid} (${l.diagnostico || ""})` : l.diagnostico)).filter(Boolean).join("; ")
        : (emBranco ? "____________________________________________________________" : "Em avaliação / Não informado");

      const studentBoxY = 20;
      const studentBoxH = 44;
      doc.rect(L, studentBoxY, PW, studentBoxH).fillAndStroke("#ffffff", PRETO);

      // Linha 1: Nome do Estudante e Matrícula
      doc.font("Helvetica-Bold").fontSize(8.5).fillColor(PRETO)
        .text("ESTUDANTE:", L + 6, studentBoxY + 5, { width: 70 });
      doc.font("Helvetica-Bold").fontSize(9).fillColor(PRETO)
        .text(aluno?.estudante || (emBranco ? "____________________________________________________________________" : "—"), L + 76, studentBoxY + 5, { width: PW * 0.58, lineBreak: false });

      doc.font("Helvetica-Bold").fontSize(8.5).fillColor(PRETO)
        .text("CÓDIGO / MATRÍCULA:", L + PW * 0.68, studentBoxY + 5, { width: 120 });
      doc.font("Helvetica-Bold").fontSize(9).fillColor(PRETO)
        .text(String(aluno?.codigo || (emBranco ? "____________" : "—")), L + PW * 0.68 + 122, studentBoxY + 5, { width: PW * 0.3 - 122 });

      // Linha 2: Turma, Turno, Data Nasc
      const turmaStr = aluno?.turma_nome ? `${aluno.turma_nome} (${aluno.turma_turno || ""})` : (emBranco ? "____________________" : "—");
      doc.font("Helvetica-Bold").fontSize(8.5).fillColor(PRETO)
        .text("TURMA / TURNO:", L + 6, studentBoxY + 18, { width: 95 });
      doc.font("Helvetica").fontSize(8.5).fillColor(PRETO)
        .text(turmaStr, L + 101, studentBoxY + 18, { width: PW * 0.45 });

      doc.font("Helvetica-Bold").fontSize(8.5).fillColor(PRETO)
        .text("DATA DE NASC.:", L + PW * 0.68, studentBoxY + 18, { width: 90 });
      doc.font("Helvetica").fontSize(8.5).fillColor(PRETO)
        .text(formatDate(aluno?.data_nascimento), L + PW * 0.68 + 92, studentBoxY + 18, { width: 80 });

      // Linha 3: Diagnóstico / CID
      doc.font("Helvetica-Bold").fontSize(8.5).fillColor(PRETO)
        .text("DIAGNÓSTICO / CID:", L + 6, studentBoxY + 31, { width: 105 });
      doc.font("Helvetica").fontSize(8.5).fillColor(PRETO)
        .text(cidsText, L + 111, studentBoxY + 31, { width: PW - 117, lineBreak: false });

      // 2. SEÇÃO 8 — TABELA OFICIAL SEEDF (ADEQUAÇÕES CURRICULARES)
      const sec8Top = studentBoxY + studentBoxH + 4;
      const sec8H = 40;
      doc.rect(L, sec8Top, PW, sec8H).fillAndStroke(FUNDO_CABECALHO, PRETO);

      // Detecta etapa da turma
      const serie = String(aluno?.turma_serie || aluno?.turma_nome || "").toLowerCase();
      const isInfantil = serie.includes("infantil") || serie.includes("creche");
      const isIniciais = /1[ºª\s]|2[ºª\s]|3[ºª\s]|4[ºª\s]|5[ºª\s]/.test(serie) && !serie.includes("ensino médio");
      const isFinais = /6[ºª\s]|7[ºª\s]|8[ºª\s]|9[ºª\s]/.test(serie);
      const isMedio = serie.includes("médio") || (/1ª|2ª|3ª/.test(serie) && serie.includes("méd"));

      const checkInfantil = isInfantil ? "( X )" : "(   )";
      const checkIniciais = isIniciais ? "( X )" : "(   )";
      const checkFinais   = isFinais || (!isInfantil && !isIniciais && !isMedio) ? "( X )" : "(   )";
      const checkMedio    = isMedio ? "( X )" : "(   )";

      const vigenciaTexto = bimestre || adeq?.bimestre || "1°, 2°, 3° E 4° BIMESTRES";

      doc.font("Helvetica-Bold").fontSize(9).fillColor(PRETO)
        .text("8. ADEQUAÇÕES CURRICULARES", L + 6, sec8Top + 4, { width: PW - 12 });

      doc.font("Helvetica").fontSize(8.5).fillColor(PRETO)
        .text(
          `ETAPA:   ${checkInfantil} Educação Infantil     ${checkIniciais} Ensino Fundamental - Anos Iniciais     ${checkFinais} Ensino Fundamental - Anos Finais     ${checkMedio} Ensino Médio`,
          L + 6, sec8Top + 16, { width: PW - 12 }
        );

      doc.font("Helvetica-Bold").fontSize(8.5).fillColor(PRETO)
        .text("Período de vigência da Adequação Curricular (Bimestral): ", L + 6, sec8Top + 27, { continued: true });
      doc.font("Helvetica-Bold").fontSize(8.5).fillColor(PRETO)
        .text(vigenciaTexto.toUpperCase());

      // 3. Seção 9 — Áreas do Conhecimento e Professor Responsável (duas linhas bem espaçadas)
      const sec9Top = sec8Top + sec8H;
      const sec9H = 30;
      doc.rect(L, sec9Top, PW, sec9H).fillAndStroke("#ffffff", PRETO);

      const discNome = disciplina || adeq?.disciplina || (emBranco ? "____________________________________________________________________" : "Todas as Áreas / Geral");
      const profNome = professorRegente || adeq?.professor_regente || (emBranco ? "____________________________________________________________________" : "—");

      // Linha 1: Componente Curricular
      doc.font("Helvetica-Bold").fontSize(8.5).fillColor(PRETO)
        .text("9. Áreas do conhecimento/Componentes Curriculares: ", L + 6, sec9Top + 4, { continued: true });
      doc.font("Helvetica-Bold").fontSize(8.5).fillColor(PRETO)
        .text(discNome);

      // Linha 2: Professor Responsável
      doc.font("Helvetica-Bold").fontSize(8.5).fillColor(PRETO)
        .text("PROFESSOR RESPONSÁVEL: ", L + 6, sec9Top + 16, { continued: true });
      doc.font("Helvetica").fontSize(8.5).fillColor(PRETO)
        .text(profNome);

      // 4. Grade de 4 Colunas (Grid SEEDF)
      const colW = PW / 4; // ~198.47 pt cada coluna
      const gridHeaderTop = sec9Top + sec9H;
      const gridHeaderH = 32;

      const colHeaders = [
        {
          title: "Objetivos para as aprendizagens",
          sub: "(Descrever o foco principal do processo de ensino-aprendizagem)",
        },
        {
          title: "Conteúdos/Unidades Didáticas",
          sub: "(Mencionar os conteúdos a serem trabalhados)",
        },
        {
          title: "Estratégias Pedagógicas/ Recursos Didáticos",
          sub: "(Metodologias, tecnologia assistiva e adequações)",
        },
        {
          title: "Estratégias de Avaliação para a aprendizagem",
          sub: "(Portfólios, observações, diário de bordo, linha do tempo, etc.)",
        },
      ];

      colHeaders.forEach((col, i) => {
        const colX = L + i * colW;
        doc.rect(colX, gridHeaderTop, colW, gridHeaderH).fillAndStroke(FUNDO_CABECALHO, PRETO);
        doc.font("Helvetica-Bold").fontSize(8).fillColor(PRETO)
          .text(col.title, colX + 4, gridHeaderTop + 3, { width: colW - 8, align: "center" });
        doc.font("Helvetica-Oblique").fontSize(6.5).fillColor(PRETO)
          .text(col.sub, colX + 4, gridHeaderTop + 14, { width: colW - 8, align: "center" });
      });

      // 5. Conteúdo da Grade (sem assinaturas no rodapé, aproveitando todo o espaço disponível da página)
      const contentTop = gridHeaderTop + gridHeaderH;
      const bottomLimit = PAGE_H - 20; // 595.28 - 20 = 575.28 pt
      const availableContentH = bottomLimit - contentTop; // ~401 pt

      if (emBranco) {
        colHeaders.forEach((_, i) => {
          const colX = L + i * colW;
          doc.rect(colX, contentTop, colW, availableContentH).fillAndStroke("#ffffff", PRETO);

          // Linhas pautadas para apoio de escrita manual
          const lineGap = 16;
          for (let ly = contentTop + lineGap; ly < contentTop + availableContentH - 4; ly += lineGap) {
            doc.moveTo(colX + 3, ly).lineTo(colX + colW - 3, ly).strokeColor(CINZA_PAUTA).lineWidth(0.5).stroke();
          }
        });
        doc.y = contentTop + availableContentH;
      } else {
        const objetivosText = adeq?.habilidades_prioritarias || "—";
        const conteudosText = adeq?.metodologias_estrategias 
          ? (adeq?.conteudos_adaptados || adeq?.metodologias_estrategias) 
          : "—";
        const estrategiasText = [adeq?.recursos_didaticos, adeq?.metodologias_estrategias].filter(Boolean).join("\n\n") || "—";
        const avaliacaoText = adeq?.avaliacao_adaptada || "—";

        const texts = [objetivosText, conteudosText, estrategiasText, avaliacaoText];

        // Calcula altura necessária
        doc.font("Helvetica").fontSize(8);
        let maxTextH = availableContentH;
        texts.forEach((txt) => {
          const h = doc.heightOfString(txt, { width: colW - 12, align: "justify", lineGap: 1.4 });
          if (h + 16 > maxTextH) maxTextH = h + 16;
        });

        // Se passar do espaço da página, divide se necessário
        if (maxTextH > availableContentH) {
          colHeaders.forEach((_, i) => {
            const colX = L + i * colW;
            doc.rect(colX, contentTop, colW, maxTextH).fillAndStroke("#ffffff", PRETO);
            doc.font("Helvetica").fontSize(8).fillColor(PRETO)
              .text(texts[i] || "—", colX + 6, contentTop + 6, { width: colW - 12, align: "justify", lineGap: 1.4 });
          });
          doc.y = contentTop + maxTextH;
        } else {
          colHeaders.forEach((_, i) => {
            const colX = L + i * colW;
            doc.rect(colX, contentTop, colW, availableContentH).fillAndStroke("#ffffff", PRETO);
            doc.font("Helvetica").fontSize(8).fillColor(PRETO)
              .text(texts[i] || "—", colX + 6, contentTop + 6, { width: colW - 12, align: "justify", lineGap: 1.4 });
          });
          doc.y = contentTop + availableContentH;
        }
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}


// ─── 2. GERAÇÃO DO PDF DE ADEQUAÇÃO CURRICULAR (INDIVIDUAL / PADRÃO DETALHADO) ──
export async function gerarPdfAdequacaoCurricular(adequacaoId, escolaId) {
  return gerarPdfAdequacaoSEEDF({
    escolaId,
    adequacaoId,
    emBranco: false,
  });
}

// ─── 3. GERAÇÃO DO PDF DE PRONTUÁRIO COMPLETO DO ALUNO AEE ─────────────────────
export async function gerarPdfProntuarioAEE(alunoId, escolaId, anoLetivo = new Date().getFullYear()) {
  const [[aluno]] = await pool.query(`
    SELECT 
      a.id, a.codigo, a.estudante,
      DATE_FORMAT(a.data_nascimento, '%Y-%m-%d') AS data_nascimento,
      a.sexo, a.atendimento_diferencial,
      t.nome AS turma_nome, t.turno AS turma_turno, t.serie AS turma_serie,
      e.nome AS escola_nome, e.apelido AS escola_apelido, e.cidade AS escola_cidade, e.endereco AS escola_endereco
    FROM alunos a
    INNER JOIN escolas e ON e.id = a.escola_id
    LEFT JOIN matriculas m ON m.aluno_id = a.id AND m.escola_id = a.escola_id AND m.ano_letivo = ?
    LEFT JOIN turmas t ON t.id = m.turma_id
    WHERE a.id = ? AND a.escola_id = ?
    LIMIT 1
  `, [anoLetivo, alunoId, escolaId]);

  if (!aluno) throw new Error("Estudante não encontrado.");

  const [laudos] = await pool.query(`
    SELECT cid, diagnostico, medico_nome, medico_crm, especialidade, DATE_FORMAT(data_laudo, '%Y-%m-%d') AS data_laudo, medicamentos_em_uso
    FROM aee_laudos WHERE aluno_id = ? AND escola_id = ? ORDER BY id DESC
  `, [alunoId, escolaId]);

  const [[cfg]] = await pool.query(`
    SELECT tipo_atendimento, turno_atendimento, dias_semana, horario_atendimento, professor_aee, necessidades_especificas, status
    FROM aee_alunos_config WHERE aluno_id = ? AND escola_id = ? AND ano_letivo = ? LIMIT 1
  `, [alunoId, escolaId, anoLetivo]);

  const [adequacoes] = await pool.query(`
    SELECT disciplina, bimestre, professor_regente, habilidades_prioritarias, metodologias_estrategias, recursos_didaticos, avaliacao_adaptada
    FROM aee_adequacoes_curriculares WHERE aluno_id = ? AND escola_id = ? AND ano_letivo = ? ORDER BY bimestre, disciplina
  `, [alunoId, escolaId, anoLetivo]);

  const [atendimentos] = await pool.query(`
    SELECT DATE_FORMAT(data_atendimento, '%Y-%m-%d') AS data_atendimento, presenca, tipo_sessao, resumo_atividades, evolucao_observacoes, professor_responsavel
    FROM aee_atendimentos WHERE aluno_id = ? AND escola_id = ? ORDER BY data_atendimento DESC LIMIT 20
  `, [alunoId, escolaId]);

  const escola = {
    nome: aluno.escola_nome,
    apelido: aluno.escola_apelido,
    cidade: aluno.escola_cidade,
    endereco: aluno.escola_endereco,
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

      // 2. Título
      doc.font("Helvetica-Bold").fontSize(12).fillColor(AZUL_ESCURO)
        .text("PRONTUÁRIO INTEGRADO — SALA DE RECURSOS (AEE)", L, doc.y, { width: PW, align: "center" });
      doc.font("Helvetica-Bold").fontSize(9).fillColor(VERDE_ESCURO)
        .text(`RELATÓRIO INSTITUCIONAL DO ESTUDANTE • ANO LETIVO ${anoLetivo}`, L, doc.y + 2, { width: PW, align: "center" });
      doc.y += 10;

      // 3. Identificação
      doc.font("Helvetica-Bold").fontSize(9).fillColor(AZUL_ESCURO);
      doc.rect(L, doc.y, PW, 15).fillAndStroke("#f1f5f9", BORDA);
      doc.fillColor(AZUL_ESCURO).text("1. IDENTIFICAÇÃO DO ESTUDANTE", L + 6, doc.y - 11);
      doc.y += 3;

      const infoBoxY = doc.y;
      doc.rect(L, infoBoxY, PW, 58).fillAndStroke("#ffffff", BORDA);
      
      doc.font("Helvetica-Bold").fontSize(8).fillColor(CINZA_LABEL).text("Nome:", L + 8, infoBoxY + 6);
      doc.font("Helvetica-Bold").fontSize(8.5).fillColor(CINZA_TEXTO).text(aluno.estudante, L + 40, infoBoxY + 6);

      doc.font("Helvetica-Bold").fontSize(8).fillColor(CINZA_LABEL).text("Matrícula:", L + PW * 0.65, infoBoxY + 6);
      doc.font("Helvetica").fontSize(8.5).fillColor(CINZA_TEXTO).text(String(aluno.codigo || "—"), L + PW * 0.65 + 48, infoBoxY + 6);

      doc.font("Helvetica-Bold").fontSize(8).fillColor(CINZA_LABEL).text("Turma:", L + 8, infoBoxY + 22);
      doc.font("Helvetica").fontSize(8.5).fillColor(CINZA_TEXTO).text(`${aluno.turma_nome || "—"} (${aluno.turma_turno || "—"})`, L + 44, infoBoxY + 22);

      doc.font("Helvetica-Bold").fontSize(8).fillColor(CINZA_LABEL).text("Nascimento:", L + PW * 0.65, infoBoxY + 22);
      doc.font("Helvetica").fontSize(8.5).fillColor(CINZA_TEXTO).text(formatDate(aluno.data_nascimento), L + PW * 0.65 + 60, infoBoxY + 22);

      doc.font("Helvetica-Bold").fontSize(8).fillColor(CINZA_LABEL).text("Atendimento:", L + 8, infoBoxY + 38);
      doc.font("Helvetica").fontSize(8.5).fillColor(CINZA_TEXTO).text(`${cfg?.tipo_atendimento || "Não configurado"} (${cfg?.turno_atendimento || "Contraturno"}) • Prof: ${cfg?.professor_aee || "—"}`, L + 70, infoBoxY + 38);

      doc.y = infoBoxY + 58 + 10;

      // 4. Laudos Médicos
      doc.font("Helvetica-Bold").fontSize(9).fillColor(AZUL_ESCURO);
      doc.rect(L, doc.y, PW, 15).fillAndStroke("#f1f5f9", BORDA);
      doc.fillColor(AZUL_ESCURO).text("2. LAUDOS MÉDICOS E DIAGNÓSTICOS CLÍNICOS", L + 6, doc.y - 11);
      doc.y += 3;

      if (laudos.length === 0) {
        doc.rect(L, doc.y, PW, 22).fillAndStroke("#ffffff", BORDA);
        doc.font("Helvetica-Oblique").fontSize(8).fillColor(CINZA_LABEL).text("Nenhum laudo médico anexado no momento.", L + 8, doc.y + 6);
        doc.y += 26;
      } else {
        laudos.forEach((l) => {
          const lBoxY = doc.y;
          doc.rect(L, lBoxY, PW, 36).fillAndStroke("#ffffff", BORDA);
          doc.font("Helvetica-Bold").fontSize(8.5).fillColor(AZUL_ESCURO).text(`CID ${l.cid || "—"}: ${l.diagnostico || ""}`, L + 8, lBoxY + 6);
          doc.font("Helvetica").fontSize(7.5).fillColor(CINZA_LABEL).text(`Médico: ${l.medico_nome || "—"} (CRM: ${l.medico_crm || "—"}) • Especialidade: ${l.especialidade || "—"} • Data: ${formatDate(l.data_laudo)}`, L + 8, lBoxY + 20);
          doc.y = lBoxY + 40;
        });
      }

      // 5. Adequações Registradas
      checkPageBreak(50);
      doc.font("Helvetica-Bold").fontSize(9).fillColor(AZUL_ESCURO);
      doc.rect(L, doc.y, PW, 15).fillAndStroke("#f1f5f9", BORDA);
      doc.fillColor(AZUL_ESCURO).text(`3. ADEQUAÇÕES CURRICULARES (${adequacoes.length} cadastradas no ano)`, L + 6, doc.y - 11);
      doc.y += 3;

      if (adequacoes.length === 0) {
        doc.rect(L, doc.y, PW, 22).fillAndStroke("#ffffff", BORDA);
        doc.font("Helvetica-Oblique").fontSize(8).fillColor(CINZA_LABEL).text("Nenhuma adequação curricular registrada para este ano letivo.", L + 8, doc.y + 6);
        doc.y += 26;
      } else {
        adequacoes.forEach((ad) => {
          checkPageBreak(40);
          const aBoxY = doc.y;
          doc.rect(L, aBoxY, PW, 32).fillAndStroke("#ffffff", BORDA);
          doc.font("Helvetica-Bold").fontSize(8).fillColor(AZUL_ESCURO).text(`${ad.bimestre} — ${ad.disciplina}`, L + 8, aBoxY + 5);
          doc.font("Helvetica").fontSize(7.5).fillColor(CINZA_LABEL).text(`Prof. Regente: ${ad.professor_regente || "—"} • Objetivos: ${String(ad.habilidades_prioritarias || "—").slice(0, 75)}...`, L + 8, aBoxY + 18);
          doc.y = aBoxY + 36;
        });
      }

      // 6. Atendimentos Recentes
      checkPageBreak(50);
      doc.font("Helvetica-Bold").fontSize(9).fillColor(AZUL_ESCURO);
      doc.rect(L, doc.y, PW, 15).fillAndStroke("#f1f5f9", BORDA);
      doc.fillColor(AZUL_ESCURO).text(`4. REGISTRO RECENTE DE ATENDIMENTOS (Últimos ${atendimentos.length})`, L + 6, doc.y - 11);
      doc.y += 3;

      if (atendimentos.length === 0) {
        doc.rect(L, doc.y, PW, 22).fillAndStroke("#ffffff", BORDA);
        doc.font("Helvetica-Oblique").fontSize(8).fillColor(CINZA_LABEL).text("Nenhum atendimento registrado até o momento.", L + 8, doc.y + 6);
        doc.y += 26;
      } else {
        atendimentos.forEach((at) => {
          checkPageBreak(35);
          const atBoxY = doc.y;
          doc.rect(L, atBoxY, PW, 30).fillAndStroke("#ffffff", BORDA);
          const presencaBadge = at.presenca === 1 ? "PRESENTE" : "FALTOU";
          doc.font("Helvetica-Bold").fontSize(7.5).fillColor(at.presenca === 1 ? VERDE_ESCURO : "#b91c1c")
            .text(`[${presencaBadge}] ${formatDate(at.data_atendimento)} — ${at.tipo_sessao || "Individual"}`, L + 8, atBoxY + 5);
          doc.font("Helvetica").fontSize(7.5).fillColor(CINZA_TEXTO)
            .text(`Atividades: ${String(at.resumo_atividades || "—").slice(0, 90)}...`, L + 8, atBoxY + 16);
          doc.y = atBoxY + 34;
        });
      }

      // Rodapés
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
