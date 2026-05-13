// routes/secretaria-relatorios-pdf.js
import { Router } from "express";
import PDFDocument from "pdfkit";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";
import pool from "../db.js";

const router = Router();
const __dirname = dirname(fileURLToPath(import.meta.url));

function anoLetivoPadrao() {
  const m = new Date().getMonth() + 1;
  return m <= 1 ? new Date().getFullYear() - 1 : new Date().getFullYear();
}

// Cores institucionais
const AZUL = "#1e3a5f";
const DOURADO = "#b8860b";
const CINZA = "#555";

// Logos
function getLogos() {
  const left = join(__dirname, "..", "assets", "images", "brasao-gdf.png");
  const right = join(__dirname, "..", "assets", "images", "logo-escola-right.png");
  return { left, right, hasLeft: existsSync(left), hasRight: existsSync(right) };
}

// Cabeçalho institucional
function drawHeader(doc, escola, logos, L, PW) {
  const top = doc.y;
  const sz = 58;
  if (logos.hasLeft) doc.image(logos.left, L, top, { width: sz, height: sz });
  if (logos.hasRight) doc.image(logos.right, L + PW - sz, top, { width: sz, height: sz });
  const hx = L + sz + 8, hw = PW - (sz + 8) * 2;
  doc.font("Helvetica-Bold").fontSize(9).fillColor(AZUL)
    .text("SECRETARIA DE ESTADO DE EDUCAÇÃO DO DISTRITO FEDERAL", hx, top + 4, { width: hw, align: "center" });
  doc.font("Helvetica-Bold").fontSize(8.5).fillColor(AZUL)
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
  doc.y += 8;
}

// ─── PDF RELATÓRIO SINTÉTICO DE MATRÍCULAS ───────────────────────────────────
router.get("/sintetico-matriculas", async (req, res) => {
  try {
    const { escola_id } = req.user;
    const { ano_letivo, turno } = req.query;
    const ano = ano_letivo ? Number(ano_letivo) : anoLetivoPadrao();
    const turnoLabel = (!turno || turno === "todos") ? "Todos os Turnos" : turno.charAt(0) + turno.slice(1).toLowerCase();

    const [[escola]] = await pool.query(
      "SELECT nome, apelido, endereco, cidade FROM escolas WHERE id = ?", [escola_id]
    );

    const params = [escola_id, ano];
    let tf = "";
    if (turno && turno !== "todos") { tf = "AND UPPER(t.turno) = UPPER(?)"; params.push(turno); }

    const [rows] = await pool.query(`
      SELECT serie, turno, total FROM (
        SELECT CASE WHEN t.nome LIKE '6%' THEN '6º Ano' WHEN t.nome LIKE '7%' THEN '7º Ano'
          WHEN t.nome LIKE '8%' THEN '8º Ano' WHEN t.nome LIKE '9%' THEN '9º Ano' ELSE 'Outra' END AS serie,
          t.turno, COUNT(DISTINCT m.aluno_id) AS total
        FROM matriculas m INNER JOIN turmas t ON t.id = m.turma_id
        WHERE m.escola_id = ? AND m.ano_letivo = ? AND m.status = 'ativo' ${tf}
        GROUP BY CASE WHEN t.nome LIKE '6%' THEN '6º Ano' WHEN t.nome LIKE '7%' THEN '7º Ano'
          WHEN t.nome LIKE '8%' THEN '8º Ano' WHEN t.nome LIKE '9%' THEN '9º Ano' ELSE 'Outra' END, t.turno
      ) AS sub ORDER BY CASE serie WHEN '6º Ano' THEN 1 WHEN '7º Ano' THEN 2 WHEN '8º Ano' THEN 3 WHEN '9º Ano' THEN 4 ELSE 5 END, turno
    `, params);

    const total = rows.reduce((a, r) => a + Number(r.total), 0);
    const porSerie = {};
    for (const r of rows) {
      if (!porSerie[r.serie]) porSerie[r.serie] = { total: 0, turnos: [] };
      porSerie[r.serie].total += Number(r.total);
      porSerie[r.serie].turnos.push({ turno: r.turno, total: Number(r.total) });
    }

    const L = 40, R = 40, PW = 595.28 - L - R;
    const PAGE_H = 841.89, FOOTER_Y = PAGE_H - 25;
    const logos = getLogos();

    const doc = new PDFDocument({ size: "A4", margins: { top: 30, bottom: 0, left: L, right: R }, autoFirstPage: true,
      info: { Title: "Relatório Sintético de Matrículas", Author: "EDUCA.MELHOR" } });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="relatorio_matriculas_${ano}.pdf"`);

    const chunks = [];
    const { PassThrough } = await import("stream");
    const pt = new PassThrough();
    pt.on("data", c => chunks.push(c));
    doc.pipe(pt);

    let pageNum = 1;
    const footer = () => doc.font("Helvetica").fontSize(6.5).fillColor("#aaa")
      .text(`Relatório Sintético de Matrículas • ${ano} • Turno: ${turnoLabel} • EDUCA.MELHOR • Pág. ${pageNum}`, L, FOOTER_Y, { width: PW, align: "center", lineBreak: false });

    drawHeader(doc, escola, logos, L, PW);

    // Título
    doc.font("Helvetica-Bold").fontSize(16).fillColor(AZUL).text("RELATÓRIO SINTÉTICO DE MATRÍCULAS", L, doc.y, { width: PW, align: "center" });
    doc.y += 4;
    doc.moveTo(L, doc.y).lineTo(L + PW, doc.y).strokeColor("#ccc").lineWidth(0.5).stroke();
    doc.y += 8;

    // Info linha
    const infoY = doc.y;
    doc.roundedRect(L, infoY, PW, 20, 3).fill("#f0f4ff");
    doc.roundedRect(L, infoY, PW, 20, 3).strokeColor("#c7d2fe").lineWidth(0.5).stroke();
    const cw4 = PW / 4;
    [["Ano Letivo:", String(ano)], ["Turno:", turnoLabel], ["Total Geral:", `${total} alunos`], ["Emitido em:", new Date().toLocaleDateString("pt-BR")]].forEach(([l, v], i) => {
      const cx = L + cw4 * i + 6;
      doc.font("Helvetica-Bold").fontSize(7.5).fillColor(AZUL).text(l, cx, infoY + 6, { width: cw4 - 12, lineBreak: false, continued: true });
      doc.font("Helvetica").fontSize(7.5).fillColor("#334155").text(` ${v}`, { lineBreak: false });
    });
    doc.y = infoY + 20 + 12;

    // Tabela de série
    const TH = 18, TR = 26;
    const C1 = 130, C2 = 100, C3 = PW - C1 - C2 - 100, C4 = 100;
    const thY = doc.y;
    doc.rect(L, thY, PW, TH).fill(AZUL);
    let tx = L;
    [["SÉRIE", C1, "left"], ["TOTAL", C2, "center"], ["DISTRIBUIÇÃO POR TURNO", C3, "left"], ["% DO TOTAL", C4, "center"]].forEach(([t, w, al]) => {
      doc.font("Helvetica-Bold").fontSize(8).fillColor("#fff").text(t, tx + 4, thY + 5, { width: w - 8, align: al, lineBreak: false });
      tx += w;
    });
    doc.y = thY + TH;

    const CORES = { "6º Ano": "#6366f1", "7º Ano": "#0ea5e9", "8º Ano": "#10b981", "9º Ano": "#f59e0b", "Outra": "#94a3b8" };
    Object.entries(porSerie).forEach(([serie, info], i) => {
      const rowY = doc.y;
      if (i % 2 === 0) doc.rect(L, rowY, PW, TR).fill("#f8fafc");
      doc.moveTo(L, rowY + TR).lineTo(L + PW, rowY + TR).strokeColor("#cbd5e1").lineWidth(0.3).stroke();
      const cor = CORES[serie] || "#94a3b8";
      // Pill série
      doc.roundedRect(L + 6, rowY + 6, 90, 14, 7).fill(cor);
      doc.font("Helvetica-Bold").fontSize(9).fillColor("#fff").text(serie, L + 6, rowY + 9, { width: 90, align: "center", lineBreak: false });
      // Total
      doc.font("Helvetica-Bold").fontSize(13).fillColor(cor).text(String(info.total), L + C1, rowY + 5, { width: C2, align: "center", lineBreak: false });
      // Turnos
      const turnosStr = info.turnos.map(t => `${t.turno}: ${t.total}`).join("  |  ");
      doc.font("Helvetica").fontSize(8).fillColor("#475569").text(turnosStr, L + C1 + C2 + 4, rowY + 9, { width: C3 - 8, lineBreak: false });
      // Percentual
      const pct = total > 0 ? ((info.total / total) * 100).toFixed(1) : "0.0";
      doc.font("Helvetica-Bold").fontSize(11).fillColor(cor).text(`${pct}%`, L + C1 + C2 + C3, rowY + 5, { width: C4, align: "center", lineBreak: false });
      // Barra
      const barX = L + C1 + C2 + 4, barY = rowY + TR - 6, barW = C3 - 8;
      doc.rect(barX, barY, barW, 3).fill("#e2e8f0");
      doc.rect(barX, barY, barW * (info.total / total), 3).fill(cor);
      doc.y = rowY + TR;
    });

    // Linha totais
    doc.y += 4;
    const totY = doc.y;
    doc.rect(L, totY, PW, 22).fill("#1e293b");
    doc.font("Helvetica-Bold").fontSize(9).fillColor("#fff").text("TOTAL GERAL", L + 6, totY + 6, { width: C1 - 12, lineBreak: false });
    doc.font("Helvetica-Bold").fontSize(14).fillColor("#facc15").text(String(total), L + C1, totY + 3, { width: C2, align: "center", lineBreak: false });
    doc.font("Helvetica").fontSize(8).fillColor("#94a3b8").text("alunos matriculados ativos", L + C1 + C2 + 4, totY + 7, { width: C3, lineBreak: false });
    doc.font("Helvetica-Bold").fontSize(11).fillColor("#fff").text("100%", L + C1 + C2 + C3, totY + 5, { width: C4, align: "center", lineBreak: false });
    doc.y = totY + 22 + 16;

    // Nota de rodapé
    doc.font("Helvetica").fontSize(8).fillColor("#64748b")
      .text("* Considera apenas alunos com matrícula ativa no ano letivo informado.", L, doc.y, { width: PW });

    footer();
    pt.on("end", () => { const buf = Buffer.concat(chunks); res.setHeader("Content-Length", buf.length); res.end(buf); });
    doc.end();
  } catch (err) {
    console.error("[pdf] sintetico-matriculas:", err);
    if (!res.headersSent) res.status(500).json({ message: "Erro ao gerar PDF." });
  }
});

// ─── PDF IDADES ───────────────────────────────────────────────────────────────
router.get("/idades", async (req, res) => {
  try {
    const { escola_id } = req.user;
    const { ano_letivo, turno, serie } = req.query;
    const ano = ano_letivo ? Number(ano_letivo) : anoLetivoPadrao();
    const turnoLabel = (!turno || turno === "todos") ? "Todos os Turnos" : turno.charAt(0) + turno.slice(1).toLowerCase();

    const [[escola]] = await pool.query("SELECT nome, apelido, endereco, cidade FROM escolas WHERE id = ?", [escola_id]);

    const params = [escola_id, ano];
    let ef = "";
    if (turno && turno !== "todos") { ef += " AND UPPER(t.turno) = UPPER(?)"; params.push(turno); }
    if (serie && serie !== "todas") { ef += " AND t.nome LIKE ?"; params.push(`${serie}%`); }

    const [alunos] = await pool.query(`
      SELECT a.estudante, DATE_FORMAT(a.data_nascimento,'%Y-%m-%d') AS dn,
        TIMESTAMPDIFF(YEAR,a.data_nascimento,CURDATE()) AS idade,
        t.nome AS turma, t.turno,
        CASE WHEN t.nome LIKE '6%' THEN '6º Ano' WHEN t.nome LIKE '7%' THEN '7º Ano'
          WHEN t.nome LIKE '8%' THEN '8º Ano' WHEN t.nome LIKE '9%' THEN '9º Ano' ELSE 'Outra' END AS serie
      FROM matriculas m INNER JOIN alunos a ON a.id=m.aluno_id INNER JOIN turmas t ON t.id=m.turma_id
      WHERE m.escola_id=? AND m.ano_letivo=? AND m.status='ativo' AND a.data_nascimento IS NOT NULL ${ef}
      ORDER BY a.estudante
    `, params);

    const faixas = [
      {label:"Até 11 anos",min:0,max:11},{label:"12 anos",min:12,max:12},{label:"13 anos",min:13,max:13},
      {label:"14 anos",min:14,max:14},{label:"15 anos",min:15,max:15},{label:"16 anos",min:16,max:16},
      {label:"17 anos",min:17,max:17},{label:"18+ anos",min:18,max:999}
    ].map(f => ({ ...f, total: alunos.filter(a => Number(a.idade) >= f.min && Number(a.idade) <= f.max).length }));

    const L = 40, PW = 595.28 - 80, PAGE_H = 841.89, FOOTER_Y = PAGE_H - 25, MAX_Y = FOOTER_Y - 15;
    const logos = getLogos();
    const doc = new PDFDocument({ size:"A4", margins:{top:30,bottom:0,left:L,right:40}, autoFirstPage:true,
      info:{Title:"Relatório de Idades",Author:"EDUCA.MELHOR"} });
    res.setHeader("Content-Type","application/pdf");
    res.setHeader("Content-Disposition",`inline; filename="relatorio_idades_${ano}.pdf"`);
    const chunks=[]; const {PassThrough}=await import("stream"); const pt=new PassThrough();
    pt.on("data",c=>chunks.push(c)); doc.pipe(pt);
    let pageNum=1;
    const footer=()=>doc.font("Helvetica").fontSize(6.5).fillColor("#aaa")
      .text(`Relatório de Idades • ${ano} • EDUCA.MELHOR • Pág. ${pageNum}`,L,FOOTER_Y,{width:PW,align:"center",lineBreak:false});
    const ensureSpace=(n)=>{ if(doc.y+n>MAX_Y){footer();doc.addPage();pageNum++;doc.y=30;} };

    drawHeader(doc,escola,logos,L,PW);
    doc.font("Helvetica-Bold").fontSize(16).fillColor(AZUL).text("RELATÓRIO DE IDADES",L,doc.y,{width:PW,align:"center"});
    doc.y+=8;

    // Cards faixas etárias
    const CORES2=["#6366f1","#0ea5e9","#10b981","#f59e0b","#ef4444","#8b5cf6","#06b6d4","#f97316"];
    const cW=PW/4, cH=50, gap=6;
    faixas.forEach((f,i)=>{
      const col=i%4, row=Math.floor(i/4);
      const cx=L+col*(cW+gap), cy=doc.y+row*(cH+gap);
      const cor=CORES2[i];
      doc.roundedRect(cx,cy,cW-gap,cH,6).fill(cor+"22");
      doc.roundedRect(cx,cy,cW-gap,cH,6).strokeColor(cor).lineWidth(0.8).stroke();
      doc.font("Helvetica-Bold").fontSize(18).fillColor(cor).text(String(f.total),cx,cy+6,{width:cW-gap,align:"center",lineBreak:false});
      doc.font("Helvetica").fontSize(7).fillColor("#475569").text(f.label,cx,cy+cH-14,{width:cW-gap,align:"center",lineBreak:false});
    });
    doc.y += Math.ceil(faixas.length/4)*(cH+gap)+10;

    // Tabela nominal
    ensureSpace(60);
    const TH=16, TR=18;
    const thY=doc.y;
    doc.rect(L,thY,PW,TH).fill(AZUL);
    let tx=L;
    [["ESTUDANTE",220,"left"],["SÉRIE",70,"center"],["TURMA",100,"center"],["TURNO",80,"center"],["IDADE",PW-470,"center"]].forEach(([t,w,al])=>{
      doc.font("Helvetica-Bold").fontSize(7.5).fillColor("#fff").text(t,tx+3,thY+4,{width:w-6,align:al,lineBreak:false});
      tx+=w;
    });
    doc.y=thY+TH;
    const CORES3={"6º Ano":"#6366f1","7º Ano":"#0ea5e9","8º Ano":"#10b981","9º Ano":"#f59e0b","Outra":"#94a3b8"};
    alunos.forEach((a,i)=>{
      ensureSpace(TR+2);
      const rowY=doc.y;
      if(i%2===0) doc.rect(L,rowY,PW,TR).fill("#f8fafc");
      doc.moveTo(L,rowY+TR).lineTo(L+PW,rowY+TR).strokeColor("#e2e8f0").lineWidth(0.3).stroke();
      const dnFmt=a.dn?a.dn.split("-").reverse().join("/"):"—";
      doc.font("Helvetica").fontSize(8).fillColor("#1e293b").text(a.estudante||"—",L+3,rowY+5,{width:217,lineBreak:false});
      const cor=CORES3[a.serie]||"#94a3b8";
      doc.font("Helvetica-Bold").fontSize(7).fillColor(cor).text(a.serie,L+220+3,rowY+5,{width:64,align:"center",lineBreak:false});
      doc.font("Helvetica").fontSize(7.5).fillColor("#475569").text(a.turma,L+290+3,rowY+5,{width:94,align:"center",lineBreak:false});
      doc.font("Helvetica").fontSize(7.5).fillColor("#475569").text(a.turno,L+370+3,rowY+5,{width:74,align:"center",lineBreak:false});
      doc.font("Helvetica-Bold").fontSize(10).fillColor(AZUL).text(`${a.idade} anos`,L+450,rowY+3,{width:PW-450,align:"center",lineBreak:false});
      doc.y=rowY+TR;
    });
    footer();
    pt.on("end",()=>{const buf=Buffer.concat(chunks);res.setHeader("Content-Length",buf.length);res.end(buf);});
    doc.end();
  } catch(err){
    console.error("[pdf] idades:",err);
    if(!res.headersSent) res.status(500).json({message:"Erro ao gerar PDF."});
  }
});

export default router;
