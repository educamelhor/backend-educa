// controllers/provaLatexController.js
// Gera PDF via LaTeX/Tectonic — qualidade gráfica profissional
import pool   from '../db.js';
import fs     from 'fs';
import path   from 'path';
import os     from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { randomUUID } from 'crypto';
import sharp  from 'sharp';

const execFileAsync = promisify(execFile);

/* ── Helpers ────────────────────────────────────────────────────────────────── */

/** Escapa caracteres especiais do LaTeX no texto do usuário */
function escapeTex(str = '') {
  return String(str)
    .replace(/\\/g,  '\\textbackslash{}')
    .replace(/&/g,   '\\&')
    .replace(/%/g,   '\\%')
    .replace(/\$/g,  '\\$')
    .replace(/#/g,   '\\#')
    .replace(/\^/g,  '\\textasciicircum{}')
    .replace(/~/g,   '\\textasciitilde{}')
    .replace(/\{/g,  '\\{')
    .replace(/\}/g,  '\\}')
    .replace(/_/g,   '\\_');
}

/** Converte texto com fórmulas $...$ e \[...\] para LaTeX válido (já é LaTeX) */
function textoParaTex(str = '') {
  // O texto do usuário já usa $...$ para inline e \[...\] para display
  // Apenas escapa caracteres especiais FORA das fórmulas
  const partes = str.split(/(\$[^$]+\$|\\\[[^\]]+\\\])/g);
  return partes.map((p, i) => {
    // partes ímpares são fórmulas — não escapar
    if (p.startsWith('$') || p.startsWith('\\[')) return p;
    return escapeTex(p);
  }).join('');
}

/** Salva imagem Base64 como arquivo, converte SVG→PNG se necessário */
async function salvarImagem(base64Str, jobDir, index) {
  if (!base64Str) return null;

  const match = base64Str.match(/^data:image\/([a-zA-Z+]+);base64,(.+)$/);
  if (!match) return null;

  const [, tipo, dados] = match;
  const buffer = Buffer.from(dados, 'base64');
  const imgPath = path.join(jobDir, `img_${index}`);

  if (tipo === 'svg+xml' || tipo === 'svg') {
    // SVG não é suportado pelo \includegraphics — converte para PNG via sharp
    const pngPath = `${imgPath}.png`;
    await sharp(buffer).png().toFile(pngPath);
    return pngPath;
  }

  // PNG, JPG, WEBP — salva diretamente
  const ext = tipo === 'jpeg' ? 'jpg' : tipo === 'webp' ? 'jpg' : tipo;
  const filePath = `${imgPath}.${ext}`;

  if (tipo === 'webp') {
    await sharp(buffer).jpeg({ quality: 95 }).toFile(filePath);
  } else {
    fs.writeFileSync(filePath, buffer);
  }
  return filePath;
}

/* ── Gerador LaTeX ──────────────────────────────────────────────────────────── */

/** Gera bloco LaTeX de uma questão */
function gerarTexQuestao(item, idx, imgPath, colunas) {
  let alts = [];
  try { alts = JSON.parse(item.alternativas_json || '[]'); } catch {}

  const num    = String(idx + 1).padStart(2, '0');
  const pontos = Number(item.valor_pontos || 1).toFixed(1);
  // Largura da régua decorativa varia com 1 ou 2 colunas
  const regraW = colunas === 2 ? '7.1cm' : '15cm';

  let tex = '';
  tex += `\\noindent\n`;
  tex += `\\textbf{QUESTÃO-${num}} {\\color{laranja}\\rule{${regraW}}{0.3pt}} {\\small\\color{gray}(${pontos} pt)}\n\n`;

  // Texto de apoio (blockquote)
  if (item.texto_apoio) {
    tex += `\\begin{quote}\\itshape\n${textoParaTex(item.texto_apoio)}\n\\end{quote}\n\n`;
  }

  // Enunciado
  if (item.conteudo_bruto) {
    tex += `${textoParaTex(item.conteudo_bruto)}\n\n`;
  }

  // Imagem (se houver)
  if (imgPath) {
    const imgPathTex = imgPath.replace(/\\/g, '/');
    // max-height dinâmico: menos altura se tem muitas alternativas
    const imgH = alts.length > 3 ? '4cm' : alts.length > 0 ? '5cm' : '8cm';
    tex += `\\begin{center}\n`;
    tex += `  \\includegraphics[height=${imgH},width=\\linewidth,keepaspectratio]{${imgPathTex}}\n`;
    tex += `\\end{center}\n\n`;
  }

  // Alternativas
  if (alts.length > 0) {
    const numCols = alts.length <= 3 ? alts.length : 1;
    if (numCols > 1) {
      tex += `\\begin{tasks}(${numCols})\n`;
      alts.forEach(a => { tex += `  \\task (${a.letra}) ${textoParaTex(a.texto || '')}\n`; });
      tex += `\\end{tasks}\n`;
    } else {
      tex += `\\begin{enumerate}[label=\\textbf{(\\Alph*)}]\n`;
      alts.forEach(a => { tex += `  \\item ${textoParaTex(a.texto || '')}\n`; });
      tex += `\\end{enumerate}\n`;
    }
  } else if (item.tipo === 'discursiva') {
    // Linhas para resposta discursiva
    tex += `\\vspace{0.2cm}\n`;
    for (let i = 0; i < 5; i++) {
      tex += `\\noindent\\underline{\\hspace{\\linewidth}}\\vspace{0.2cm}\n\n`;
    }
  }

  tex += `\\vspace{0.4cm}\n\n`;
  return tex;
}

/** Gera o documento .tex completo */
function gerarTexCompleto({ prova, itens, cfg, escola, colunas, imgPaths, comGabarito }) {
  const is2col    = colunas === 2;
  const comCab    = cfg.com_cabecalho ?? true;
  const comMarg   = cfg.com_margem   ?? true;
  const rodapeTxt = cfg.rodape_texto || '';
  const cab       = cfg.cabecalho_itens ?? {};
  const sh        = (k) => cab[k] ?? true;

  const margem = comMarg ? '0.7cm' : '0.3cm';

  // ── Pacotes ──
  let tex = `\\documentclass{article}\n`;
  tex += `\\usepackage[brazil]{babel}\n`;
  tex += `\\usepackage[utf8]{inputenc}\n`;
  tex += `\\usepackage[T1]{fontenc}\n`;
  tex += `\\usepackage{times}\n`;
  tex += `\\usepackage[a4paper,lmargin=${margem},tmargin=${margem},bmargin=${margem},rmargin=${margem}]{geometry}\n`;
  tex += `\\usepackage{multicol}\n`;
  tex += `\\usepackage{multirow}\n`;
  tex += `\\usepackage{enumerate}\n`;
  tex += `\\usepackage[shortlabels]{enumitem}\n`;
  tex += `\\usepackage{tasks}\n`;
  tex += `\\usepackage{tikz,pgfplots}\n`;
  tex += `\\usetikzlibrary{calc,arrows}\n`;
  tex += `\\pgfplotsset{compat=1.18}\n`;
  tex += `\\usepackage{fancyhdr}\n`;
  tex += `\\usepackage{xcolor,graphicx}\n`;
  tex += `\\usepackage{amsmath,amssymb,amsthm,mathtools}\n`;
  tex += `\\usepackage{anyfontsize}\n`;
  tex += `\\usepackage{float}\n`;
  tex += `\\usepackage[indent=1cm,skip=0.1cm]{parskip}\n`;

  // Cores do projeto do usuário
  tex += `\\definecolor{laranja}{HTML}{FF6600}\n`;
  tex += `\\definecolor{azul}{HTML}{0066FF}\n`;
  tex += `\\definecolor{amarelo}{HTML}{FCFB85}\n`;
  tex += `\\definecolor{gray}{HTML}{888888}\n`;

  // Borda da página via TikZ (replicando BORDAS.tex do usuário)
  tex += `\n\\pagestyle{fancy}\n`;
  tex += `\\lhead{\\begin{tikzpicture}[overlay, remember picture]\n`;
  tex += `  \\draw [draw=laranja, line width=1.5pt]($(current page.north west) + (0.4,-0.4)$) rectangle ($(current page.south east) + (-0.4,0.4)$);\n`;
  tex += `\\end{tikzpicture}}\n`;
  tex += `\\chead{} \\rhead{}\n`;
  tex += `\\lfoot{\\begin{tikzpicture}[overlay, remember picture]\n`;
  tex += `  \\draw [fill=azul]($(current page.south east) + (-0.5,0.5)$) circle (.35cm);\n`;
  tex += `  \\node at ($(current page.south east) + (-0.5,0.5)$){\\fontsize{14pt}{14pt}\\selectfont\\color{white}\\textbf{\\thepage}};\n`;
  tex += `\\end{tikzpicture}}\n`;
  tex += `\\cfoot{} \\rfoot{}\n`;
  tex += `\\renewcommand{\\headrulewidth}{0pt}\n\n`;

  // Rodapé texto
  const totalPts = itens.reduce((s, it) => s + Number(it.valor_pontos || 1), 0).toFixed(1);
  const rodapeStr = rodapeTxt ? `EDUCA.PROVA · ${rodapeTxt}` : 'EDUCA.PROVA';

  tex += `\\begin{document}\n`;
  tex += `\\fontsize{12pt}{14pt}\\selectfont\n\n`;

  // ── Cabeçalho ──
  if (comCab) {
    tex += `\\begin{center}\n`;
    if (sh('cab_escola')) {
      tex += `  {\\large\\bfseries\\MakeUppercase{${escapeTex(escola)}}}\\\\\n`;
      tex += `  {\\small Sistema de Ensino EDUCA.MELHOR}\\\\\n`;
    }
    if (sh('cab_titulo')) {
      tex += `  \\vspace{4pt}\\rule{\\linewidth}{1pt}\\\\\n`;
      tex += `  {\\large\\bfseries\\MakeUppercase{${escapeTex(prova.titulo || 'Avaliação')}}}\\\\\n`;
      tex += `  \\rule{\\linewidth}{1pt}\n`;
    }
    tex += `\\end{center}\n\n`;

    // Grade de identificação
    tex += `\\begin{tabular}{|p{0.55\\linewidth}|p{0.2\\linewidth}|p{0.15\\linewidth}|}\n\\hline\n`;
    if (sh('cab_nome')) tex += `Nome: \\hfill & `;
    if (sh('cab_turma')) tex += `Turma: ${escapeTex(prova.turma || '')} & `;
    if (sh('cab_nota')) tex += `Nota: `;
    tex += `\\\\ \\hline\n`;
    const linha2 = [];
    if (sh('cab_disc') && prova.disciplina) linha2.push(`Disciplina: ${escapeTex(prova.disciplina)}`);
    if (sh('cab_bimestre') && prova.bimestre) linha2.push(`${prova.bimestre}º Bimestre`);
    if (sh('cab_ano') && prova.ano_letivo) linha2.push(String(prova.ano_letivo));
    if (sh('cab_data')) linha2.push('Data: \\underline{\\hspace{3cm}}');
    tex += `\\multicolumn{3}{|l|}{${linha2.join(' \\quad ')}} \\\\ \\hline\n`;
    tex += `\\end{tabular}\n\n`;

    // Instruções
    if (sh('cab_instrucoes')) {
      tex += `\\vspace{4pt}\n`;
      tex += `\\fbox{\\parbox{\\linewidth}{\\textbf{INSTRUÇÕES:} `;
      tex += `Esta avaliação contém \\textbf{${itens.length} questão(ões)} `;
      tex += `no total de \\textbf{${totalPts} ponto(s)}. `;
      tex += `Leia cada questão com atenção antes de responder.}}\n\n`;
    }
  }

  tex += `\\vspace{0.3cm}\n\n`;

  // ── Questões ──
  if (is2col) {
    tex += `\\begin{multicols}{2}\n\\setlength{\\columnseprule}{0.8pt}\n\n`;
  }

  itens.forEach((item, idx) => {
    tex += gerarTexQuestao(item, idx, imgPaths[idx] || null, colunas);
  });

  if (is2col) {
    tex += `\\end{multicols}\n\n`;
  }

  // ── Gabarito (página nova) ──
  if (comGabarito) {
    tex += `\\newpage\n`;
    tex += `\\begin{center}{\\large\\bfseries GABARITO — ${escapeTex(prova.titulo || '')}}\\end{center}\n\n`;
    tex += `\\begin{center}\n`;
    tex += `\\begin{tabular}{|c|c|c|c|c|}\\hline\n`;
    tex += `\\textbf{Nº} & \\textbf{Resposta} & \\textbf{Pts} & \\textbf{Disciplina} & \\textbf{Nível} \\\\ \\hline\n`;
    itens.forEach((it, i) => {
      let alts2 = []; try { alts2 = JSON.parse(it.alternativas_json || '[]'); } catch {}
      const corr  = alts2.find(a => a.correta)?.letra || it.correta || '---';
      const niv   = { facil: 'Fácil', medio: 'Médio', dificil: 'Difícil', enem: 'ENEM' }[it.nivel] || '---';
      const pts   = Number(it.valor_pontos || 1).toFixed(1);
      tex += `${String(i+1).padStart(2,'0')} & \\textbf{${corr}} & ${pts} & ${escapeTex(it.disciplina || '---')} & ${niv} \\\\ \\hline\n`;
    });
    const total = itens.reduce((s, it) => s + Number(it.valor_pontos || 1), 0).toFixed(1);
    tex += `\\multicolumn{2}{|r|}{\\textbf{TOTAL}} & ${total} & \\multicolumn{2}{c|}{} \\\\ \\hline\n`;
    tex += `\\end{tabular}\n`;
    tex += `\\end{center}\n\n`;
  }

  // Rodapé informativo
  tex += `\\vspace{1cm}\n`;
  tex += `{\\small\\color{gray}\\centering ${escapeTex(escola)} — ${escapeTex(rodapeStr)}\\par}\n`;
  tex += `\\end{document}\n`;

  return tex;
}

/* ── Controller principal ───────────────────────────────────────────────────── */

export async function exportarPdfLatex(req, res) {
  const { id } = req.params;
  const { escola_id } = req.user;
  const comGabarito = req.query.gabarito === '1';

  // 1. Busca prova + itens
  let prova, itens;
  try {
    const [[p]] = await pool.query(
      'SELECT * FROM provas WHERE id = ? AND (escola_id = ? OR escola_id IS NULL)',
      [id, escola_id]
    );
    if (!p) return res.status(404).json({ message: 'Prova não encontrada.' });
    prova = p;

    const [rows] = await pool.query(
      `SELECT pq.valor_pontos, pq.ordem,
              q.conteudo_bruto, q.tipo, q.nivel, q.disciplina,
              q.alternativas_json, q.correta, q.imagem_base64,
              q.texto_apoio
       FROM prova_questoes pq
       JOIN questoes q ON q.id = pq.questao_id
       WHERE pq.prova_id = ?
       ORDER BY pq.ordem ASC`,
      [id]
    );
    itens = rows;
  } catch (err) {
    console.error('exportarPdfLatex DB:', err);
    return res.status(500).json({ message: 'Erro ao carregar prova.', detail: err.message });
  }

  // 2. Cria diretório de trabalho
  const jobId  = randomUUID();
  const jobDir = path.join('/tmp/latex-jobs', jobId);
  fs.mkdirSync(jobDir, { recursive: true });

  try {
    // 3. Salva imagens como arquivos e coleta caminhos
    const cfg    = (() => { try { return typeof prova.config_json === 'string' ? JSON.parse(prova.config_json) : (prova.config_json || {}); } catch { return {}; } })();
    const escola = req.query.escola || prova.escola_nome || 'EDUCA.MELHOR';
    const template = prova.template_slug || 'objetiva_2col';
    const colunas  = ['objetiva_2col', 'enem'].includes(template) ? 2 : 1;

    const imgPaths = await Promise.all(
      itens.map((it, idx) => salvarImagem(it.imagem_base64, jobDir, idx))
    );

    // 4. Gera o .tex
    const texContent = gerarTexCompleto({ prova, itens, cfg, escola, colunas, imgPaths, comGabarito });
    const texFile = path.join(jobDir, 'prova.tex');
    fs.writeFileSync(texFile, texContent, 'utf-8');

    // 5. Compila com Tectonic (2 passagens para referências)
    await execFileAsync('tectonic', [
      '--outdir', jobDir,
      '--keep-logs',
      '--synctex', '0',
      texFile,
    ], {
      timeout: 60000, // 60s timeout
      env: {
        ...process.env,
        TECTONIC_CACHE_DIR: '/tmp/tectonic-cache', // cache compartilhado entre jobs
      },
    });

    // 6. Lê o PDF gerado
    const pdfPath = path.join(jobDir, 'prova.pdf');
    if (!fs.existsSync(pdfPath)) {
      // Lê o log para diagnóstico
      const logPath = path.join(jobDir, 'prova.log');
      const logContent = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf-8').slice(-2000) : 'sem log';
      throw new Error(`PDF não gerado. Log: ${logContent}`);
    }

    const pdfBuffer = fs.readFileSync(pdfPath);
    const nomeArq   = `${(prova.titulo || 'prova').toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-')}-latex.pdf`;

    // 7. Envia o PDF
    res.set({
      'Content-Type':        'application/pdf',
      'Content-Disposition': `attachment; filename="${nomeArq}"`,
      'Content-Length':      pdfBuffer.length,
      'Cache-Control':       'no-store',
    });
    res.end(pdfBuffer);

  } catch (err) {
    console.error('exportarPdfLatex Tectonic:', err.message?.slice(0, 500));
    res.status(500).json({
      message: 'Erro na compilação LaTeX.',
      detail:  err.message?.slice(0, 300),
    });
  } finally {
    // 8. Limpa diretório temporário
    try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch {}
  }
}
