// routes/termo-consentimento.js
// ============================================================================
// Gera PDF do Termo de Consentimento — exatamente 2 páginas A4 (frente/verso)
// Versão 3.0 — Ajustes Jurídicos: LGPD, ECA, Marco Civil, Código Civil
// Incorpora: DPO, autorização de fotografia, direito de imagem (CC art.20),
//            RIPD, consentimento granular apps, prazo 72h incidentes,
//            prazo 15 dias dir. titular, prazo 90 dias pós-desligamento,
//            hipótese legal art.11 LGPD, transferência internacional, CPF mascarado
// ============================================================================

import { Router } from "express";
import PDFDocument from "pdfkit";
import pool from "../db.js";

const router = Router();

// ─── Helpers de formatação ────────────────────────────────────────────────────

function fmtCpf(cpf) {
  if (!cpf) return "—";
  const d = String(cpf).replace(/\D/g, "").padStart(11, "0");
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
}
function fmtDate(date) {
  if (!date) return "—";
  return new Date(date).toLocaleDateString("pt-BR");
}
function hoje() {
  const m = ["janeiro","fevereiro","março","abril","maio","junho","julho","agosto","setembro","outubro","novembro","dezembro"];
  const d = new Date();
  return `Planaltina, ${d.getDate()} de ${m[d.getMonth()]} de ${d.getFullYear()}`;
}

// ─── Rota principal ───────────────────────────────────────────────────────────

router.get("/:responsavelId/:alunoId", async (req, res) => {
  try {
    const { escola_id } = req.user;
    const { responsavelId, alunoId } = req.params;

    const [[escola]] = await pool.query(
      "SELECT id, nome, apelido, endereco, cidade, estado, cnpj FROM escolas WHERE id = ?",
      [escola_id]
    );
    const [[resp]] = await pool.query(
      "SELECT nome, cpf, email, telefone_celular FROM responsaveis WHERE id = ?",
      [responsavelId]
    );
    const [[aluno]] = await pool.query(
      `SELECT a.codigo, a.estudante, a.data_nascimento, t.nome AS turma
       FROM alunos a LEFT JOIN turmas t ON t.id = a.turma_id
       WHERE a.id = ? AND a.escola_id = ?`,
      [alunoId, escola_id]
    );
    const [[diretor]] = await pool.query(
      `SELECT u.nome FROM usuarios u WHERE u.escola_id = ? AND u.perfil = 'diretor' LIMIT 1`,
      [escola_id]
    );

    if (!resp || !aluno) return res.status(404).json({ error: "Dados não encontrados." });

    // ─── Documento PDFKit ──────────────────────────────────────────────────────
    // bottom margin = 0 → desabilita auto-paginação do pdfkit
    const doc = new PDFDocument({
      size: "A4",
      margins: { top: 32, bottom: 0, left: 26, right: 26 },
      info: {
        Title: `Termo de Consentimento - ${aluno.estudante}`,
        Author: "EDUCA.MELHOR",
        Subject: "Termo de Consentimento para Uso de Imagem e Dados Biométricos",
        Keywords: "LGPD, ECA, Marco Civil, consentimento, biometria",
      },
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="Termo_${aluno.codigo || "aluno"}.pdf"`);
    doc.pipe(res);

    // ─── Layout constants ──────────────────────────────────────────────────────
    const L  = 26;          // left margin
    const PW = 595.28 - 52; // usable width
    const GAP = 14;         // gap between columns
    const CW = (PW - GAP) / 2; // column width
    const RX = L + CW + GAP;   // right column X

    // Font sizes
    const S = { t: 13, st: 10.5, v: 7, h: 10, sh: 9, b: 9.5, sm: 6, tiny: 8.5 };

    // ─── Drawing helpers ───────────────────────────────────────────────────────
    function heading(n, t, x, w) {
      doc.font("Helvetica-Bold").fontSize(S.h).fillColor("#0a4a7a")
        .text(`${n} — ${t}`, x, doc.y, { width: w, lineGap: 0.1 });
    }
    function subH(n, t, x, w) {
      doc.font("Helvetica-Bold").fontSize(S.sh).fillColor("#1a1a2e")
        .text(`${n} ${t}`, x, doc.y, { width: w, lineGap: 0.1 });
    }
    function body(t, x, w, opts = {}) {
      doc.font("Helvetica").fontSize(S.b).fillColor("#2d2d2d")
        .text(t, x, doc.y, { width: w, lineGap: 0.8, ...opts });
    }
    function fld(l, v, x, w) {
      doc.font("Helvetica-Bold").fontSize(S.b).fillColor("#444")
        .text(`${l}: `, x, doc.y, { width: w, continued: true });
      doc.font("Helvetica").fillColor("#111").text(v || "—");
    }
    function blt(t, x, w) {
      doc.font("Helvetica").fontSize(S.b).fillColor("#2d2d2d")
        .text(` •  ${t}`, x, doc.y, { width: w, lineGap: 0.6 });
    }
    function chk(t, x, w) {
      doc.font("Helvetica").fontSize(S.b).fillColor("#111")
        .text(`[ ] ${t}`, x, doc.y, { width: w, lineGap: 1.2 });
    }
    function gap(p) { doc.y += p; }
    function hdivider(x, w) {
      doc.moveTo(x, doc.y).lineTo(x + w, doc.y).strokeColor("#c0d8f0").lineWidth(0.4).stroke();
      gap(1.5);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // PÁGINA 1
    // ──────────────────────────────────────────────────────────────────────────

    // ── Cabeçalho / Título ──
    // Barra azul de topo
    doc.rect(L - 2, doc.y - 4, PW + 4, 26).fill("#0a4a7a");
    doc.font("Helvetica-Bold").fontSize(S.t).fillColor("#ffffff")
      .text("TERMO DE CONSENTIMENTO ESPECÍFICO", L, doc.y - 1, { width: PW, align: "center", lineGap: 0.2 });
    doc.font("Helvetica-Bold").fontSize(S.st).fillColor("#d0e8ff")
      .text("PARA USO DE IMAGEM, FOTOGRAFIA E DADOS BIOMÉTRICOS DE ALUNO(A)", L, doc.y, { width: PW, align: "center" });
    gap(3);
    doc.font("Helvetica").fontSize(S.v).fillColor("#999")
      .text(`Versão: 3.0   |   Emitido em: ${new Date().toLocaleDateString("pt-BR")}   |   Base Legal: LGPD · ECA · Marco Civil · Código Civil`, L, doc.y, { width: PW, align: "center" });
    gap(4);

    // ── Seção 1: Identificação (full-width) ──
    doc.rect(L - 2, doc.y, PW + 4, 8.5).fill("#e8f0fb");
    doc.font("Helvetica-Bold").fontSize(S.h).fillColor("#0a4a7a")
      .text("1 — IDENTIFICAÇÃO DAS PARTES", L, doc.y + 1, { width: PW });
    gap(10);

    // Três sub-blocos em linha: Escola | Responsável | Aluno
    const idColW = (PW - GAP * 2) / 3;
    const idX2 = L + idColW + GAP;
    const idX3 = idX2 + idColW + GAP;
    const idTop = doc.y;

    // 1.1 Escola
    subH("1.1", "INSTITUIÇÃO DE ENSINO", L, idColW);
    fld("Razão Social", escola?.nome || "—", L, idColW);
    if (escola?.cnpj) fld("CNPJ", escola.cnpj, L, idColW);
    const addr = [escola?.endereco, escola?.cidade, escola?.estado].filter(Boolean).join(", ") || "—";
    fld("Endereço", addr, L, idColW);
    body("Denominada ESCOLA.", L, idColW);

    // 1.2 Responsável
    doc.y = idTop;
    subH("1.2", "RESPONSÁVEL LEGAL", idX2, idColW);
    fld("Nome", resp.nome, idX2, idColW);
    fld("CPF", fmtCpf(resp.cpf), idX2, idColW);
    if (resp.telefone_celular) fld("Telefone", resp.telefone_celular, idX2, idColW);
    if (resp.email) fld("E-mail", resp.email, idX2, idColW);
    body("Denominado RESPONSÁVEL LEGAL.", idX2, idColW);

    // 1.3 Aluno
    doc.y = idTop;
    subH("1.3", "ALUNO(A)", idX3, idColW);
    fld("Nome", aluno.estudante, idX3, idColW);
    fld("Nasc.", fmtDate(aluno.data_nascimento), idX3, idColW);
    fld("RE", aluno.codigo || "—", idX3, idColW);
    fld("Turma", aluno.turma || "—", idX3, idColW);
    body("Denominado ALUNO(A).", idX3, idColW);

    gap(3);
    // 1.4 DPO
    const dpoY = doc.y;
    doc.rect(L - 2, dpoY, PW + 4, 8).fill("#fff3cd");
    doc.font("Helvetica-Bold").fontSize(S.tiny).fillColor("#7a5700")
      .text("1.4  ENCARREGADO DE DADOS (DPO) — Art. 41 LGPD: ", L, dpoY + 1.5, { width: PW, continued: true });
    doc.font("Helvetica").fillColor("#2d2d2d")
      .text("dpo@sistemaeducamelhor.com.br  |  Responsável pelo tratamento de dados — acessível para exercício de direitos e esclarecimentos.");
    gap(2);

    doc.moveTo(L, doc.y).lineTo(L + PW, doc.y).strokeColor("#c0d8f0").lineWidth(0.5).stroke();
    gap(3);

    // ──────────────────────────────────────────────────────────────
    // COLUNAS PÁGINA 1  (cláusulas 2 a 11.1)
    // ──────────────────────────────────────────────────────────────
    const c1 = doc.y;

    // ── COLUNA ESQUERDA P1 ──
    doc.y = c1;

    heading("2", "BASE LEGAL E FUNDAMENTAÇÃO", L, CW); gap(1);
    body("O tratamento de dados biométricos (dados sensíveis, art. 5º, II, LGPD) fundamenta-se no:", L, CW);
    blt("Art. 11, I, LGPD: consentimento específico e destacado (cláusulas 3, 5)", L, CW);
    blt("Art. 11, II, 'f', LGPD: tutela da segurança dos titulares (controle de acesso)", L, CW);
    blt("ECA (Lei 8.069/1990): princípio do melhor interesse da criança", L, CW);
    blt("Marco Civil da Internet (Lei 12.965/2014): arts. 7º e 45", L, CW);
    blt("Código Civil: art. 20 (direito de imagem), art. 17 (personalidade)", L, CW);
    blt("Princípios constitucionais: dignidade, privacidade e imagem (CF, art. 5º, X)", L, CW);
    body("O tratamento observará, em todas as hipóteses, o princípio do MELHOR INTERESSE DA CRIANÇA E DO ADOLESCENTE.", L, CW);
    gap(2);

    heading("3", "OBJETO DO CONSENTIMENTO", L, CW); gap(1);
    body("Este termo autoriza, de forma específica, informada e destacada:", L, CW);
    subH("3.1", "Imagem facial do(a) aluno(a)", L, CW);
    subH("3.2", "Dados biométricos derivados (padrões, templates, embeddings faciais)", L, CW);
    subH("3.3", "AUTORIZAÇÃO PARA FOTOGRAFAR — art. 79 ECA + CF art. 5º, X", L, CW);
    body("O RESPONSÁVEL LEGAL autoriza expressamente o registro fotográfico do(a) ALUNO(A) para fins exclusivamente institucionais, realizado por profissional credenciado nas dependências da escola.", L, CW);
    subH("3.4", "DIREITO DE IMAGEM — art. 20 Cód. Civil + art. 17 ECA", L, CW);
    body("Autoriza uso da imagem exclusivamente para: perfil no EDUCA.MELHOR (acesso restrito), documentos internos e confirmação de identidade nos apps EDUCA-MOBILE e EDUCA-CAPTURE. Vedado uso público, em redes sociais ou publicidade sem novo consentimento.", L, CW);
    gap(2);

    heading("4", "PRINCÍPIOS DE TRATAMENTO — art. 6º LGPD", L, CW); gap(1);
    for (const p of ["finalidade","adequação","necessidade","transparência","segurança","prevenção","não discriminação","responsabilização e prestação de contas"])
      blt(p, L, CW);
    gap(2);

    heading("5", "FINALIDADES AUTORIZADAS", L, CW); gap(1);
    body("Uso proporcional, limitado e adequado. Uso exclusivo para:", L, CW);
    for (const [n, f] of [["5.1","Identificação institucional do aluno"],["5.2","Cadastro escolar"],["5.3","Controle de presença"],["5.4","Segurança institucional"],["5.5","Conferência de identidade em atividades escolares"],["5.6","Prevenção de fraudes de identidade"],["5.7","Registro de eventos administrativos"]])
      subH(n, f, L, CW);

    // ── COLUNA DIREITA P1 ──
    doc.y = c1;

    heading("6", "FINALIDADES EXPRESSAMENTE PROIBIDAS", RX, CW); gap(1);
    body("É expressamente vedado utilizar os dados para:", RX, CW);
    for (const p of ["publicidade ou marketing","venda ou cessão de dados","perfilhamento comercial","vigilância comportamental abusiva","discriminação automatizada","treinamento irrestrito de IA","análise psicológica automatizada","ranking de alunos por biometria"])
      blt(p, RX, CW);
    gap(2);

    heading("7", "ALTERNATIVA SEM BIOMETRIA — art. 11, §2º, LGPD", RX, CW); gap(1);
    body("Existe alternativa sem reconhecimento facial (identificação manual, cartão escolar, chamada manual). O RESPONSÁVEL LEGAL pode optar a qualquer momento. A recusa NÃO implicará qualquer prejuízo acadêmico, disciplinar ou administrativo ao(à) ALUNO(A).", RX, CW);
    gap(2);

    heading("8", "LIMITAÇÃO DE DECISÕES AUTOMATIZADAS — art. 20 LGPD", RX, CW); gap(1);
    body("Nenhuma decisão pedagógica, disciplinar ou administrativa será tomada exclusivamente com base em processamento automatizado. Sempre será garantida revisão humana qualificada.", RX, CW);
    gap(2);

    heading("9", "RISCO DE FALSO POSITIVO/NEGATIVO", RX, CW); gap(1);
    subH("9.1", "Falso positivo:", RX, CW);
    body("Identificação incorreta de uma pessoa como outra.", RX, CW);
    subH("9.2", "Falso negativo:", RX, CW);
    body("Falha em reconhecer pessoa cadastrada. Resultados serão revisados com validação humana.", RX, CW);
    gap(2);

    heading("10", "SISTEMAS ENVOLVIDOS", RX, CW); gap(1);
    subH("10.1", "Plataforma EDUCA.MELHOR", RX, CW);
    subH("10.2", "EDUCA-CAPTURE — app de captura de imagem", RX, CW);
    subH("10.3", "EDUCA-MOBILE — app para responsáveis", RX, CW);
    subH("10.4", "Módulos de monitoramento institucional", RX, CW);
    subH("10.5", "Infraestrutura de processamento e armazenamento seguro", RX, CW);
    body("Mudanças substanciais nos sistemas implicarão notificação ao RESPONSÁVEL LEGAL e renovação do consentimento quando necessário.", RX, CW);
    gap(2);

    heading("11", "PAPÉIS NO TRATAMENTO — arts. 5º, VI e VII, LGPD", RX, CW); gap(1);
    subH("11.1", "ESCOLA — CONTROLADORA", RX, CW);
    body("Define finalidades e uso institucional dos dados.", RX, CW);

    // Rodapé P1
    doc.fontSize(S.sm).font("Helvetica").fillColor("#aaa")
      .text("EDUCA.MELHOR · Versão 3.0 · LGPD · ECA · Marco Civil da Internet · Página 1/2", L, 841.89 - 16, { width: PW, align: "center" });

    // ──────────────────────────────────────────────────────────────────────────
    // PÁGINA 2
    // ──────────────────────────────────────────────────────────────────────────
    doc.addPage();
    const c2 = doc.y;

    // ── COLUNA ESQUERDA P2 ──
    doc.y = c2;

    subH("11.2", "EDUCA.MELHOR — OPERADORA", L, CW);
    body("Trata dados em nome da escola para viabilizar o funcionamento do sistema.", L, CW);
    gap(3);

    heading("12", "MINIMIZAÇÃO DE DADOS — art. 6º, III, LGPD", L, CW); gap(2);
    for (const p of ["imagens poderão ser convertidas em templates biométricos","dados brutos poderão ser descartados após processamento","retenção limitada ao estritamente necessário"])
      blt(p, L, CW);
    gap(3);

    heading("13", "PRAZOS DE RETENÇÃO — art. 16 LGPD", L, CW); gap(2);
    subH("13.1", "Durante vínculo escolar:", L, CW);
    body("Dados mantidos enquanto o aluno estiver matriculado.", L, CW);
    subH("13.2", "Após desligamento:", L, CW);
    body("Dados biométricos e de imagem serão eliminados ou anonimizados em até 90 (noventa) dias. Logs de auditoria poderão ser mantidos por até 5 (cinco) anos, salvo obrigação legal.", L, CW);
    gap(3);

    heading("14", "SEGURANÇA DA INFORMAÇÃO — art. 46 LGPD", L, CW); gap(2);
    for (const p of ["controle de acesso e autenticação forte","logs de auditoria e rastreabilidade","segregação por escola","criptografia em trânsito e repouso","revisão periódica de permissões","monitoramento de segurança contínuo"])
      blt(p, L, CW);
    gap(3);

    heading("15", "INCIDENTES DE SEGURANÇA — art. 48 LGPD", L, CW); gap(2);
    body("Em caso de incidente relevante:", L, CW);
    body("1. Investigação imediata e contenção", L, CW);
    body("2. ESCOLA notificada em até 72 (setenta e duas) horas — conforme orientação da ANPD", L, CW);
    body("3. ANPD e titulares comunicados conforme gravidade e art. 48 LGPD", L, CW);
    gap(3);

    heading("16", "COMPARTILHAMENTO DE DADOS — art. 7º, IX, Marco Civil", L, CW); gap(2);
    body("Dados compartilhados apenas com:", L, CW);
    blt("ESCOLA (controladora)", L, CW);
    blt("Fornecedores de infraestrutura tecnológica com cláusulas de sigilo", L, CW);
    blt("Autoridades legais quando exigido por lei", L, CW);
    body("Proibido compartilhamento para fins comerciais.", L, CW);
    gap(3);

    heading("17", "TRANSFERÊNCIA INTERNACIONAL — art. 33 LGPD", L, CW); gap(2);
    body("Caso dados sejam processados em infraestrutura de nuvem fora do Brasil, será exigido nível de proteção equivalente à LGPD (cláusulas padrão ou certificações). O RESPONSÁVEL LEGAL poderá consultar os países de destino junto ao DPO.", L, CW);
    gap(3);

    heading("18", "RIPD — RELATÓRIO DE IMPACTO — art. 38 LGPD", L, CW); gap(2);
    body("Em razão do tratamento de dados biométricos de crianças (alto risco — Resolução ANPD nº 2/2022), é mantido Relatório de Impacto à Proteção de Dados Pessoais, disponível mediante solicitação ao DPO.", L, CW);
    gap(3);

    heading("19", "DIREITOS DO TITULAR — art. 18 LGPD", L, CW); gap(2);
    body("O RESPONSÁVEL LEGAL poderá solicitar ao DPO (dpo@sistemaeducamelhor.com.br):", L, CW);
    for (const p of ["confirmação de tratamento","acesso aos dados","correção de dados incompletos","anonimização ou exclusão quando cabível","informações sobre compartilhamento","portabilidade quando regulamentada"])
      blt(p, L, CW);
    body("Resposta em até 15 (quinze) dias úteis — art. 19, §3º, LGPD.", L, CW);

    // ── captura fim da coluna esquerda ANTES de resetar doc.y ──
    const leftP2 = doc.y;

    // ── COLUNA DIREITA P2 ──
    doc.y = c2;

    heading("20", "REVOGAÇÃO — art. 8º, §5º, LGPD", RX, CW); gap(2);
    for (const p of ["A qualquer momento, sem ônus","Não invalida tratamentos anteriores","Pode limitar funcionalidades — será adotado método alternativo","App EDUCA-MOBILE: revogar via DPO ou desinstalação"])
      blt(p, RX, CW);
    gap(3);

    heading("21", "LIMITAÇÃO DE IA — art. 20 LGPD", RX, CW); gap(2);
    body("Dados biométricos não serão usados para treinamento aberto de IA fora do contexto operacional da plataforma. Auditabilidade garantida.", RX, CW);
    gap(3);

    heading("22", "CONSENTIMENTO GRANULAR — art. 7º, IX, Marco Civil", RX, CW); gap(2);
    body("Registro eletrônico auditável (data, hora, IP, versão). O RESPONSÁVEL LEGAL manifesta concordância separadamente:", RX, CW);
    gap(2);
    chk("Autorizo captura de FOTOGRAFIA para cadastro escolar.", RX, CW);
    chk("Autorizo uso de IMAGEM no sistema EDUCA.MELHOR (perfil e documentos internos).", RX, CW);
    chk("Autorizo geração de TEMPLATE BIOMÉTRICO para controle de presença.", RX, CW);
    chk("Autorizo uso em SISTEMAS DE SEGURANÇA institucional.", RX, CW);
    chk("Autorizo instalação e uso do app EDUCA-MOBILE (câmera, internet, notificações).", RX, CW);
    chk("Autorizo captura via app EDUCA-CAPTURE por profissional credenciado.", RX, CW);
    gap(3);

    heading("23", "DECLARAÇÕES DO RESPONSÁVEL LEGAL", RX, CW); gap(2);
    body("O RESPONSÁVEL LEGAL declara que:", RX, CW);
    for (const p of [
      "leu integralmente o documento e compreendeu suas disposições",
      "teve oportunidade de esclarecer dúvidas com o DPO",
      "é guardião legal, pai/mãe detentor(a) do poder familiar ou tutor(a) legalmente constituído(a)",
      "apresentou ou disponibilizou documento comprobatório de sua condição quando solicitado",
      "o consentimento foi apresentado de forma destacada, clara e acessível, sem vício de consentimento"
    ]) blt(p, RX, CW);

    // ── captura fim da coluna direita e posiciona assinatura abaixo de AMBAS ──
    const rightP2 = doc.y;
    doc.y = Math.max(leftP2, rightP2) + 8;

    doc.moveTo(L, doc.y).lineTo(L + PW, doc.y).strokeColor("#0a4a7a").lineWidth(0.6).stroke();
    gap(4);

    heading("24", "ASSINATURA", L, PW); gap(1);
    doc.font("Helvetica").fontSize(S.b).fillColor("#333")
      .text(hoje(), L, doc.y, { width: PW, align: "right" });
    gap(7);

    // Assinaturas lado a lado
    const sigW = (PW - GAP) / 2;
    const sigR = L + sigW + GAP;
    const sigTop = doc.y;

    // Responsável
    doc.font("Helvetica-Bold").fontSize(S.h).fillColor("#0a4a7a").text("RESPONSÁVEL LEGAL", L, sigTop, { width: sigW });
    gap(3);
    fld("Nome", resp.nome, L, sigW);
    gap(8);
    doc.font("Helvetica").fontSize(S.b).fillColor("#555")
      .text("Assinatura: ___________________________________", L, doc.y, { width: sigW });

    // Escola
    doc.y = sigTop;
    doc.font("Helvetica-Bold").fontSize(S.h).fillColor("#0a4a7a").text("ESCOLA", sigR, sigTop, { width: sigW });
    gap(3);
    fld("Representante", diretor?.nome || "—", sigR, sigW);
    doc.font("Helvetica").fontSize(S.b).fillColor("#555")
      .text("Cargo: Diretor(a) Pedagógico(a)", sigR, doc.y, { width: sigW });
    gap(5);
    doc.text("Assinatura: ___________________________________", sigR, doc.y, { width: sigW });

    // Rodapé P2
    doc.fontSize(S.sm).font("Helvetica").fillColor("#aaa")
      .text("EDUCA.MELHOR · Versão 3.0 · LGPD · ECA · Marco Civil da Internet · Página 2/2  |  dpo@sistemaeducamelhor.com.br", L, 841.89 - 16, { width: PW, align: "center" });

    doc.end();
  } catch (err) {
    console.error("[termo-consentimento] Erro:", err);
    if (!res.headersSent) res.status(500).json({ error: "Erro ao gerar PDF." });
  }
});

export default router;
