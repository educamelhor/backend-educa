// routes/termo-consentimento.js
// ============================================================================
// Gera PDF do Termo de Consentimento — exatamente 2 páginas A4 (frente/verso)
// IMPORTANTE: bottom margin = 0 para DESABILITAR auto-paginação do pdfkit
// Versão sincronizada com termo_editado.pdf
// ============================================================================

import { Router } from "express";
import PDFDocument from "pdfkit";
import pool from "../db.js";

const router = Router();

function fmtCpf(cpf) {
  if (!cpf) return "";
  const d = String(cpf).replace(/\D/g, "").padStart(11, "0");
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
}
function fmtDate(date) {
  if (!date) return "";
  return new Date(date).toLocaleDateString("pt-BR");
}
function hoje() {
  const m = ["janeiro","fevereiro","março","abril","maio","junho","julho","agosto","setembro","outubro","novembro","dezembro"];
  const d = new Date();
  return `Planaltina, ${d.getDate()} de ${m[d.getMonth()]} de ${d.getFullYear()}`;
}

router.get("/:responsavelId/:alunoId", async (req, res) => {
  try {
    const { escola_id } = req.user;
    const { responsavelId, alunoId } = req.params;

    const [[escola]] = await pool.query("SELECT id, nome, apelido, endereco, cidade, estado, cnpj FROM escolas WHERE id = ?", [escola_id]);
    const [[resp]] = await pool.query("SELECT nome, cpf, email, telefone_celular FROM responsaveis WHERE id = ?", [responsavelId]);
    const [[aluno]] = await pool.query(
      `SELECT a.codigo, a.estudante, a.data_nascimento, t.nome AS turma
       FROM alunos a LEFT JOIN turmas t ON t.id = a.turma_id
       WHERE a.id = ? AND a.escola_id = ?`, [alunoId, escola_id]);
    const [[diretor]] = await pool.query(
      `SELECT u.nome FROM usuarios u WHERE u.escola_id = ? AND u.perfil = 'diretor' LIMIT 1`, [escola_id]);

    if (!resp || !aluno) return res.status(404).json({ error: "Dados não encontrados." });

    // ── IMPORTANTE: bottom margin = 0 para impedir auto-paginação ──
    const doc = new PDFDocument({
      size: "A4",
      margins: { top: 35, bottom: 0, left: 28, right: 28 },
      info: { Title: `Termo de Consentimento - ${aluno.estudante}`, Author: "EDUCA.MELHOR" },
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="Termo_${aluno.codigo || "aluno"}.pdf"`);
    doc.pipe(res);

    const L = 28;
    const PW = 595.28 - 56;
    const GAP = 16;
    const CW = (PW - GAP) / 2;
    const RX = L + CW + GAP;

    const S = { t: 12, st: 9.5, v: 6.5, h: 8.5, sh: 8, b: 7.8, sm: 5.5 };

    function heading(n, t, x, w) {
      doc.font("Helvetica-Bold").fontSize(S.h).fillColor("#111")
        .text(`${n} — ${t}`, x, doc.y, { width: w, lineGap: 0.2 });
    }
    function subH(n, t, x, w) {
      doc.font("Helvetica-Bold").fontSize(S.sh).fillColor("#222")
        .text(`${n} ${t}`, x, doc.y, { width: w, lineGap: 0.2 });
    }
    function body(t, x, w) {
      doc.font("Helvetica").fontSize(S.b).fillColor("#222")
        .text(t, x, doc.y, { width: w, lineGap: 0.3 });
    }
    function fld(l, v, x, w) {
      doc.font("Helvetica-Bold").fontSize(S.b).fillColor("#333")
        .text(`${l}: `, x, doc.y, { width: w, continued: true });
      doc.font("Helvetica").fillColor("#111").text(v || "—");
    }
    function blt(t, x, w) {
      doc.font("Helvetica").fontSize(S.b).fillColor("#222")
        .text(` •  ${t}`, x, doc.y, { width: w, lineGap: 0.2 });
    }
    function gap(p) { doc.y += p; }

    // ═══════════════════════════════════════════════════════════════
    // PÁGINA 1
    // ═══════════════════════════════════════════════════════════════

    // Título
    doc.font("Helvetica-Bold").fontSize(S.t).fillColor("#111")
      .text("TERMO DE CONSENTIMENTO ESPECÍFICO", { align: "center" });
    doc.font("Helvetica-Bold").fontSize(S.st).fillColor("#111")
      .text("PARA USO DE IMAGEM E DADOS BIOMÉTRICOS DE", { align: "center" });
    doc.text("ALUNO(A)", { align: "center" });
    doc.font("Helvetica").fontSize(S.v).fillColor("#999")
      .text(`Versão: 2.0                                  Última atualização: ${new Date().toLocaleDateString("pt-BR")}`, { align: "center" });
    gap(3);

    // 1 — IDENTIFICAÇÃO
    heading("1", "IDENTIFICAÇÃO DAS PARTES", L, PW); gap(1);
    subH("1.1", "INSTITUIÇÃO DE ENSINO", L, PW);
    fld("Razão social", escola?.nome || "—", L, PW);
    if (escola?.cnpj) fld("CNPJ", escola.cnpj, L, PW);
    const enderecoEscola = [escola?.endereco, escola?.cidade, escola?.estado].filter(Boolean).join(", ") || "—";
    fld("Endereço", enderecoEscola, L, PW);
    body("Doravante denominada ESCOLA.", L, PW); gap(2);

    subH("1.2", "RESPONSÁVEL LEGAL", L, PW);
    fld("Nome", resp.nome, L, PW);
    fld("CPF", fmtCpf(resp.cpf), L, PW);
    if (resp.telefone_celular) fld("Telefone", resp.telefone_celular, L, PW);
    if (resp.email) fld("E-mail", resp.email, L, PW);
    body("Doravante denominado RESPONSÁVEL LEGAL.", L, PW); gap(2);

    subH("1.3", "ALUNO(A)", L, PW);
    fld("Nome", aluno.estudante, L, PW);
    fld("Data de nascimento", fmtDate(aluno.data_nascimento), L, PW);
    fld("RE", aluno.codigo || "—", L, PW);
    fld("Turma", aluno.turma || "—", L, PW);
    body("Doravante denominado ALUNO(A).", L, PW); gap(3);

    doc.moveTo(L, doc.y).lineTo(L + PW, doc.y).strokeColor("#ddd").lineWidth(0.5).stroke();
    gap(3);

    // ━━━ COLUNAS P1 ━━━
    const c1 = doc.y;

    // ESQUERDA P1 (2, 3, 4, 5)
    doc.y = c1;
    heading("2", "BASE LEGAL E FUNDAMENTAÇÃO", L, CW); gap(1);
    body("Em conformidade com:", L, CW);
    for (const b of [
      "Lei nº 13.709/2018 (LGPD)",
      "Estatuto da Criança e do Adolescente (Lei nº 8.069/1990)",
      "Marco Civil da Internet",
      "Código Civil",
      "Princípios constitucionais de proteção da dignidade, privacidade e imagem."
    ]) blt(b, L, CW);
    body("Tratamento envolve dados pessoais sensíveis, exigindo salvaguardas reforçadas. O tratamento de dados objeto deste termo observará, em todas as hipóteses, o princípio do MELHOR INTERESSE DA CRIANÇA E DO ADOLESCENTE, conforme previsto no Estatuto da Criança e do Adolescente, devendo qualquer operação de tratamento ser realizada de forma a preservar sua dignidade, segurança e desenvolvimento.", L, CW); gap(2);

    heading("3", "OBJETO DO CONSENTIMENTO", L, CW); gap(1);
    body("Este termo autoriza, de forma específica, informada e destacada, o tratamento de:", L, CW);
    subH("3.1", "Imagem facial do(a) aluno(a)", L, CW);
    subH("3.2", "Dados biométricos derivados da imagem", L, CW);
    body("Podendo incluir:", L, CW);
    for (const b of [
      "padrões faciais",
      "templates biométricos",
      "vetores matemáticos",
      "embeddings faciais",
      "identificadores técnicos para comparação biométrica."
    ]) blt(b, L, CW);
    gap(2);

    heading("4", "PRINCÍPIOS DE TRATAMENTO", L, CW); gap(1);
    body("O tratamento observará obrigatoriamente os seguintes princípios:", L, CW);
    for (const p of ["finalidade","adequação","necessidade","transparência","segurança","prevenção","não discriminação","responsabilização e prestação de contas"]) blt(p, L, CW);
    body("conforme estabelecido pela LGPD.", L, CW); gap(2);

    heading("5", "FINALIDADES AUTORIZADAS", L, CW); gap(1);
    body("O uso de imagem e dados biométricos se justifica pela necessidade de garantir maior segurança institucional, prevenir fraudes de identidade, evitar registros indevidos de presença e aumentar a confiabilidade dos processos escolares, sendo adotado de forma proporcional, limitada e adequada às finalidades descritas. Uso exclusivo para:", L, CW);
    for (const [n, f] of [["5.1","Identificação institucional do aluno"],["5.2","Cadastro escolar"],["5.3","Controle de presença"],["5.4","Segurança institucional"],["5.5","Conferência de identidade em atividades escolares"],["5.6","Prevenção de fraudes de identidade"],["5.7","Registro de eventos administrativos"]]) subH(n, f, L, CW);

    // DIREITA P1 (6, 7, 8, 9, 10, 11.1)
    doc.y = c1;
    heading("6", "FINALIDADES EXPRESSAMENTE PROIBIDAS", RX, CW); gap(1);
    body("É expressamente vedado utilizar os dados para:", RX, CW);
    for (const p of [
      "publicidade",
      "marketing",
      "venda ou cessão de dados",
      "perfilhamento comercial",
      "vigilância comportamental abusiva",
      "discriminação automatizada",
      "treinamento irrestrito de IA",
      "análise psicológica automatizada",
      "ranking de alunos por biometria."
    ]) blt(p, RX, CW);
    gap(2);

    heading("7", "ALTERNATIVA SEM USO DE BIOMETRIA", RX, CW); gap(1);
    body("Existe alternativa operacional sem reconhecimento facial. Poderá incluir: identificação manual, cartão escolar, registro manual de presença, validação visual por funcionário. O RESPONSÁVEL LEGAL poderá solicitar a utilização dessa alternativa a qualquer momento. A eventual recusa do consentimento para uso de dados biométricos NÃO implicará qualquer prejuízo acadêmico, disciplinar ou administrativo ao ALUNO(A), sendo garantido tratamento isonômico e não discriminatório.", RX, CW);
    gap(2);

    heading("8", "LIMITAÇÃO DE DECISÕES AUTOMATIZADAS", RX, CW); gap(1);
    body("Nenhuma decisão relevante de natureza pedagógica, disciplinar ou administrativa será tomada exclusivamente com base em processamento automatizado de dados biométricos. Sempre será garantida revisão humana qualificada, especialmente em casos de inconsistência, dúvida, falso positivo ou falso negativo, sendo vedada a tomada de decisão automatizada isolada.", RX, CW);
    gap(2);

    heading("9", "RISCO DE FALSO POSITIVO E FALSO NEGATIVO", RX, CW); gap(1);
    body("O RESPONSÁVEL LEGAL declara ciência de que sistemas de reconhecimento facial podem apresentar:", RX, CW);
    subH("9.1", "Falso positivo", RX, CW);
    body("identificação incorreta de uma pessoa como outra.", RX, CW);
    subH("9.2", "Falso negativo", RX, CW);
    body("falha em reconhecer pessoa corretamente cadastrada.", RX, CW);
    body("Por esse motivo:", RX, CW);
    for (const p of [
      "resultados automatizados podem ser revisados",
      "validação humana poderá ocorrer",
      "registros poderão ser corrigidos."
    ]) blt(p, RX, CW);
    gap(2);

    heading("10", "SISTEMAS ENVOLVIDOS", RX, CW); gap(1);
    body("Os dados poderão ser tratados nos seguintes ambientes tecnológicos:", RX, CW);
    subH("10.1", "Plataforma EDUCA.MELHOR", RX, CW);
    subH("10.2", "Educa-Capture", RX, CW);
    body("Aplicativo de captura de imagem.", RX, CW);
    subH("10.3", "Educa-Mobile", RX, CW);
    body("Aplicativo para responsáveis.", RX, CW);
    subH("10.4", "Módulos de monitoramento institucional", RX, CW);
    subH("10.5", "Infraestrutura de processamento e armazenamento seguro.", RX, CW);
    gap(2);

    heading("11", "PAPÉIS NO TRATAMENTO", RX, CW); gap(1);
    subH("11.1", "ESCOLA", RX, CW);
    body("Atua como CONTROLADORA dos dados. Define finalidades e uso institucional.", RX, CW);

    // Rodapé P1 (posição absoluta)
    doc.fontSize(S.sm).font("Helvetica").fillColor("#bbb")
      .text("Documento gerado pelo sistema EDUCA.MELHOR", L, 841.89 - 20, { width: PW, align: "center" });

    // ═══════════════════════════════════════════════════════════════
    // PÁGINA 2
    // ═══════════════════════════════════════════════════════════════
    doc.addPage();
    const c2 = doc.y;

    // ESQUERDA P2 (11.2, 12-16)
    doc.y = c2;
    subH("11.2", "EDUCA.MELHOR", L, CW);
    body("Atua como OPERADORA, tratando dados em nome da escola para viabilizar funcionamento do sistema.", L, CW); gap(2);

    heading("12", "MINIMIZAÇÃO DE DADOS", L, CW); gap(1);
    body("Sempre que possível:", L, CW);
    for (const p of [
      "imagens poderão ser convertidas em templates biométricos",
      "dados brutos poderão ser reduzidos",
      "retenção será limitada ao necessário."
    ]) blt(p, L, CW);
    gap(2);

    heading("13", "PRAZOS DE RETENÇÃO", L, CW); gap(1);
    subH("13.1", "Durante vínculo escolar", L, CW);
    body("Dados poderão ser mantidos enquanto o aluno estiver matriculado.", L, CW); gap(1);
    subH("13.2", "Após desligamento", L, CW);
    body("Dados poderão ser:", L, CW);
    for (const p of ["excluídos","anonimizados","bloqueados"]) blt(p, L, CW);
    body("salvo obrigações legais de retenção.", L, CW);
    gap(2);

    heading("14", "SEGURANÇA DA INFORMAÇÃO", L, CW); gap(1);
    body("Serão adotadas medidas como:", L, CW);
    for (const p of [
      "controle de acesso",
      "autenticação forte",
      "logs de auditoria",
      "segregação por escola",
      "criptografia",
      "revisão periódica de permissões",
      "monitoramento de segurança."
    ]) blt(p, L, CW);
    gap(2);

    heading("15", "INCIDENTES DE SEGURANÇA", L, CW); gap(1);
    body("Em caso de incidente relevante envolvendo dados biométricos ou imagem:", L, CW);
    body("1. o incidente será investigado", L, CW);
    body("2. medidas de contenção serão aplicadas", L, CW);
    body("3. a ESCOLA será informada", L, CW);
    body("4. quando aplicável, titulares ou responsáveis poderão ser comunicados.", L, CW);
    gap(2);

    heading("16", "COMPARTILHAMENTO DE DADOS", L, CW); gap(1);
    body("Os dados poderão ser compartilhados apenas:", L, CW);
    for (const p of [
      "com a ESCOLA",
      "com fornecedores de infraestrutura tecnológica",
      "com autoridades legais quando exigido por lei."
    ]) blt(p, L, CW);
    body("É proibido compartilhamento para fins comerciais.", L, CW);

    const leftP2 = doc.y;

    // DIREITA P2 (17-22)
    doc.y = c2;
    heading("17", "DIREITOS DO TITULAR", RX, CW); gap(1);
    body("O RESPONSÁVEL LEGAL poderá solicitar:", RX, CW);
    for (const p of [
      "confirmação de tratamento",
      "acesso aos dados",
      "correção",
      "anonimização",
      "exclusão quando cabível",
      "informações sobre compartilhamento."
    ]) blt(p, RX, CW);
    gap(2);

    heading("18", "REVOGAÇÃO DO CONSENTIMENTO", RX, CW); gap(1);
    body("O consentimento pode ser revogado a qualquer momento. A revogação:", RX, CW);
    for (const p of [
      "não invalida tratamentos já realizados",
      "pode limitar certas funcionalidades",
      "poderá exigir adoção de método alternativo de identificação."
    ]) blt(p, RX, CW);
    gap(2);

    heading("19", "TREINAMENTO DE INTELIGÊNCIA ARTIFICIAL", RX, CW); gap(1);
    body("Os dados biométricos ou imagens não serão utilizados para treinamento aberto de modelos de inteligência artificial fora do contexto operacional da plataforma.", RX, CW);
    gap(2);

    heading("20", "AUDITORIA E GOVERNANÇA", RX, CW); gap(1);
    body("A ESCOLA e a plataforma poderão manter:", RX, CW);
    for (const p of [
      "registros de auditoria",
      "controle de acesso",
      "monitoramento de uso",
      "rastreabilidade de operações."
    ]) blt(p, RX, CW);
    gap(2);

    heading("21", "CONSENTIMENTO GRANULAR", RX, CW); gap(1);
    body("A ESCOLA e a plataforma EDUCA.MELHOR manterão registro eletrônico auditável do consentimento, incluindo data, hora, identificação do responsável legal, endereço IP e versão do termo aceito, para fins de comprovação legal e regulatória. O RESPONSÁVEL LEGAL manifesta sua concordância separadamente:", RX, CW); gap(1);
    for (const c of [
      "Autorizo uso de imagem para cadastro escolar.",
      "Autorizo uso de imagem para identificação institucional.",
      "Autorizo geração de template biométrico para controle de presença.",
      "Autorizo uso em sistemas de segurança institucional."
    ]) {
      doc.font("Helvetica").fontSize(S.b).fillColor("#222")
        .text(`[   ] ${c}`, RX, doc.y, { width: CW, lineGap: 0.3 });
    }
    gap(2);

    heading("22", "DECLARAÇÕES DO RESPONSÁVEL LEGAL", RX, CW); gap(1);
    body("O RESPONSÁVEL LEGAL declara que:", RX, CW);
    for (const p of [
      "leu integralmente o documento",
      "compreendeu suas disposições",
      "teve oportunidade de esclarecer dúvidas",
      "possui legitimidade para autorizar o tratamento."
    ]) blt(p, RX, CW);
    body("Declara ainda que o consentimento foi apresentado de forma destacada, clara e acessível, inclusive com explicação específica sobre o uso de dados biométricos e seus riscos, não havendo vício de consentimento, erro ou indução.", RX, CW);

    const rightP2 = doc.y;

    // ━━━ ASSINATURA (full width) ━━━
    doc.y = Math.max(leftP2, rightP2) + 8;
    doc.moveTo(L, doc.y).lineTo(L + PW, doc.y).strokeColor("#ddd").lineWidth(0.5).stroke();
    gap(4);

    heading("23", "ASSINATURA", L, PW); gap(1);
    doc.font("Helvetica").fontSize(S.b).fillColor("#333")
      .text(hoje(), L, doc.y, { width: PW, align: "right" }); gap(8);

    doc.font("Helvetica-Bold").fontSize(S.h).fillColor("#111")
      .text("RESPONSÁVEL LEGAL", L, doc.y, { width: PW }); gap(4);
    doc.font("Helvetica").fontSize(S.b).fillColor("#222")
      .text(`                                                        Nome: ${resp.nome}`, L, doc.y, { width: PW }); gap(10);
    doc.text("                                              Assinatura: _______________________________________________", L, doc.y, { width: PW }); gap(14);

    doc.font("Helvetica-Bold").fontSize(S.h).fillColor("#111")
      .text("ESCOLA", L, doc.y, { width: PW }); gap(3);
    doc.font("Helvetica").fontSize(S.b).fillColor("#222")
      .text(`Representante: ${diretor?.nome || "—"}`, L, doc.y, { width: PW });
    doc.text("Cargo: Diretor Pedagógico", L, doc.y, { width: PW }); gap(10);
    doc.text("Assinatura: _______________________________________________", L, doc.y, { width: PW });

    // Rodapé P2
    doc.fontSize(S.sm).font("Helvetica").fillColor("#bbb")
      .text("Documento gerado pelo sistema EDUCA.MELHOR", L, 841.89 - 20, { width: PW, align: "center" });

    doc.end();
  } catch (err) {
    console.error("[termo-consentimento] Erro:", err);
    if (!res.headersSent) res.status(500).json({ error: "Erro ao gerar PDF." });
  }
});

export default router;
