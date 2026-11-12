// controllers/provaLatexController.js
// Gera PDF via LaTeX/Tectonic — qualidade gráfica profissional compatível com os 7 modelos e Smart Media
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

function textoParaTex(str = '') {
  const partes = String(str || '').split(/(\$\$[^$]+\$\$|\$[^$]+\$|\\\[[^\]]+\\\])/g);
  return partes.map((p) => {
    if (p.startsWith('$') || p.startsWith('\\[')) return p;
    return escapeTex(p);
  }).join('');
}

function parseJsonObj(raw, fallback = null) {
  if (!raw) return fallback;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return fallback; }
}

function parseAlts(raw) {
  if (Array.isArray(raw)) return raw;
  try { return JSON.parse(raw || '[]'); } catch { return []; }
}

async function salvarImagem(imgSource, jobDir, suffix) {
  if (!imgSource || typeof imgSource !== 'string') return null;

  const src = imgSource.trim();
  const imgPath = path.join(jobDir, `img_${suffix}`);

  if (/^https?:\/\//i.test(src)) {
    try {
      const resp = await fetch(src, { signal: AbortSignal.timeout(15000) });
      if (!resp.ok) {
        console.warn(`[provaLatex] Falha ao baixar imagem (${resp.status}): ${src}`);
        return null;
      }
      const buffer = Buffer.from(await resp.arrayBuffer());
      const jpgPath = `${imgPath}.jpg`;
      await sharp(buffer).rotate().flatten({ background: '#ffffff' }).jpeg({ quality: 92 }).toFile(jpgPath);
      return jpgPath;
    } catch (err) {
      console.warn(`[provaLatex] Erro ao baixar/converter imagem remota (${src}):`, err.message);
      return null;
    }
  }

  const match = src.match(/^data:image\/([a-zA-Z+]+);base64,(.+)$/);
  if (!match) return null;

  const [, tipo, dados] = match;
  const buffer = Buffer.from(dados, 'base64');

  if (tipo === 'svg+xml' || tipo === 'svg') {
    const pngPath = `${imgPath}.png`;
    await sharp(buffer).png().toFile(pngPath);
    return pngPath;
  }

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

function renderFiguraTex(imgPath, midia, temMuitasAlts) {
  if (!imgPath) return '';
  const imgPathTex = imgPath.replace(/\\/g, '/');
  const presetMap = { P: '0.36\\linewidth', M: '0.56\\linewidth', G: '0.84\\linewidth', '100%': '0.98\\linewidth' };
  const widthTex = presetMap[midia?.preset] || '0.58\\linewidth';
  const maxH = temMuitasAlts ? '4.8cm' : '6.5cm';
  const envMap = { left: 'flushleft', center: 'center', right: 'flushright' };
  const env = envMap[midia?.alinhamento] || 'center';

  const legendaTxt = [midia?.legenda, midia?.credito ? `Fonte: ${midia.credito}` : '']
    .filter(Boolean)
    .join(' — ');

  let tex = `\\begin{${env}}\n`;
  tex += `  \\includegraphics[width=${widthTex},height=${maxH},keepaspectratio]{${imgPathTex}}\n`;
  if (legendaTxt) {
    tex += `  \\\\ {\\footnotesize\\itshape\\color{gray} ${escapeTex(legendaTxt)}}\n`;
  }
  tex += `\\end{${env}}\n\n`;
  return tex;
}

function renderAlternativasTex(alts, altImgMap = {}) {
  if (!alts.length) return '';
  const temImgAlt = alts.some(a => Boolean(altImgMap[a.letra]));
  const numCols = !temImgAlt && alts.length <= 3 ? alts.length : 1;

  if (numCols > 1) {
    let tex = `\\begin{tasks}(${numCols})\n`;
    alts.forEach(a => { tex += `  \\task (${escapeTex(a.letra)}) ${textoParaTex(a.texto || '')}\n`; });
    tex += `\\end{tasks}\n`;
    return tex;
  }

  let tex = `\\begin{enumerate}[label=\\textbf{(\\Alph*)}]\n`;
  alts.forEach(a => {
    const pImg = altImgMap[a.letra];
    const imgInline = pImg
      ? `\\\\ \\includegraphics[width=0.38\\linewidth,height=2.8cm,keepaspectratio]{${pImg.replace(/\\/g, '/')}}`
      : '';
    tex += `  \\item ${textoParaTex(a.texto || '')}${imgInline}\n`;
  });
  tex += `\\end{enumerate}\n`;
  return tex;
}

function resumirGabaritoTex(item) {
  const est = parseJsonObj(item.estrutura_json, {}) || {};
  const tipo = item.tipo || est.modelo || 'objetiva';
  const alts = parseAlts(item.alternativas_json);
  const altCorreta = alts.find(a => a.correta)?.letra || item.correta;

  if (tipo === 'verdadeiro_falso' && (est.submodo || 'direto') === 'direto') {
    return (est.itens || []).map(i => i.gabarito || 'V').join('-') || altCorreta || '---';
  }
  if (tipo === 'associacao' && (est.submodo || 'direto') === 'direto') {
    return (est.coluna_b || []).map(b => b.vinculo_codigo || '-').join('-') || altCorreta || '---';
  }
  if (tipo === 'lacuna' && (est.submodo || 'direto') !== 'alternativas') {
    const matches = [...String(item.conteudo_bruto || '').matchAll(/\{\{([^}]+)\}\}/g)].map(m => m[1].trim());
    const lacs = matches.length ? matches : (est.lacunas || []);
    return lacs.length ? lacs.join(' / ') : '---';
  }
  if (tipo === 'somatoria') {
    const s = est.soma_correta ?? item.correta;
    return s !== undefined && s !== null && s !== '' ? String(s).padStart(2, '0') : '---';
  }
  if (tipo === 'discursiva') return 'Discursiva';
  return altCorreta || '---';
}

function gerarTexQuestao(item, idx, imgBundle, colunas) {
  const alts = parseAlts(item.alternativas_json);
  const est  = parseJsonObj(item.estrutura_json, {}) || {};
  const midia = parseJsonObj(item.midia_json, null);
  const tipo = item.tipo || est.modelo || 'objetiva';
  const posicao = ['apos_texto_apoio', 'entre_enunciado_e_comando', 'abaixo_comando'].includes(midia?.posicao)
    ? midia.posicao
    : 'entre_enunciado_e_comando';

  const num    = String(idx + 1).padStart(2, '0');
  const pontos = Number(item.valor_pontos || 1).toFixed(1);
  const regraW = colunas === 2 ? '6.6cm' : '14.5cm';

  let tex = `\\noindent\n`;
  const fonteHdr = item.fonte && !item.texto_apoio ? ` {\\small (${escapeTex(item.fonte)})}` : '';
  tex += `\\textbf{QUESTÃO-${num}}${fonteHdr} {\\color{laranja}\\rule{${regraW}}{0.3pt}} {\\small\\color{gray}(${pontos} pt)}\n\n`;

  if (item.texto_apoio) {
    const refFonte = item.fonte ? `\\\\ {\\footnotesize\\normalfont — ${escapeTex(item.fonte)}}` : '';
    tex += `\\begin{quote}\\itshape\n${textoParaTex(item.texto_apoio)}${refFonte}\n\\end{quote}\n\n`;
  }

  const figTex = renderFiguraTex(imgBundle?.main || null, midia, alts.length > 3);

  if (posicao === 'apos_texto_apoio') tex += figTex;

  if (item.conteudo_bruto) {
    if (tipo === 'lacuna') {
      const partes = String(item.conteudo_bruto).split(/(\{\{[^}]+\}\})/g);
      const texLac = partes.map(p => {
        if (p.startsWith('{{') && p.endsWith('}}')) {
          return '\\underline{\\hspace{2.4cm}}';
        }
        return textoParaTex(p);
      }).join('');
      tex += `${texLac}\n\n`;
    } else {
      tex += `${textoParaTex(item.conteudo_bruto)}\n\n`;
    }
  }

  if (posicao === 'entre_enunciado_e_comando') tex += figTex;

  if (item.comando_final) {
    tex += `\\textbf{${textoParaTex(item.comando_final)}}\n\n`;
  }

  if (posicao === 'abaixo_comando') tex += figTex;

  // Renderização por modelo estrutural
  if (tipo === 'afirmativas') {
    const props = Array.isArray(est.proposicoes) ? est.proposicoes : [];
    props.forEach((p, i) => {
      const rom = escapeTex(p.romano || ['I', 'II', 'III', 'IV', 'V'][i] || String(i + 1));
      tex += `\\noindent \\textbf{${rom}.} ${textoParaTex(p.texto || '')}\\\\[2pt]\n`;
    });
    if (est.comando_fechamento) {
      tex += `\\vspace{2pt}\\noindent \\textbf{${textoParaTex(est.comando_fechamento)}}\n\n`;
    }
    tex += renderAlternativasTex(alts, imgBundle?.alts || {});
  } else if (tipo === 'verdadeiro_falso') {
    const itensVf = Array.isArray(est.itens) ? est.itens : [];
    itensVf.forEach(it => {
      tex += `\\noindent \\texttt{(\\hspace{0.45cm})} ${textoParaTex(it.texto || '')}\\\\[3pt]\n`;
    });
    if ((est.submodo || 'direto') === 'sequencia') {
      tex += renderAlternativasTex(alts, imgBundle?.alts || {});
    } else if (est.exigir_justificativa_falsas) {
      const nLin = Math.max(1, Math.min(8, Number(est.linhas_justificativa) || 3));
      tex += `\\vspace{2pt}\\noindent{\\small\\textbf{Justifique as falsas:}}\\\\[2pt]\n`;
      for (let i = 0; i < nLin; i++) {
        tex += `\\noindent\\underline{\\hspace{\\linewidth}}\\vspace{0.18cm}\n\n`;
      }
    }
  } else if (tipo === 'associacao') {
    const colA = Array.isArray(est.coluna_a) ? est.coluna_a : [];
    const colB = Array.isArray(est.coluna_b) ? est.coluna_b : [];
    const maxR = Math.max(colA.length, colB.length);
    if (maxR > 0) {
      tex += `\\noindent\\begin{tabular}{|p{0.45\\linewidth}|p{0.45\\linewidth}|}\\hline\n`;
      tex += `\\textbf{${escapeTex(est.titulo_coluna_a || 'Coluna A')}} & \\textbf{${escapeTex(est.titulo_coluna_b || 'Coluna B')}} \\\\ \\hline\n`;
      for (let i = 0; i < maxR; i++) {
        const a = colA[i];
        const b = colB[i];
        const cellA = a ? `\\textbf{(${escapeTex(a.codigo || i + 1)})} ${textoParaTex(a.texto || '')}` : '';
        const cellB = b ? `\\texttt{(\\hspace{0.35cm})} ${textoParaTex(b.texto || '')}` : '';
        tex += `${cellA} & ${cellB} \\\\ \\hline\n`;
      }
      tex += `\\end{tabular}\n\n`;
    }
    if ((est.submodo || 'direto') === 'sequencia') {
      tex += renderAlternativasTex(alts, imgBundle?.alts || {});
    }
  } else if (tipo === 'lacuna') {
    if ((est.submodo || 'direto') === 'banco_palavras') {
      const banco = [...(est.lacunas || []), ...(est.distratores_banco || [])].filter(Boolean)
        .sort((a, b) => a.localeCompare(b, 'pt-BR'));
      if (banco.length) {
        tex += `\\noindent\\fbox{\\parbox{0.96\\linewidth}{\\small\\textbf{Banco de palavras:} ${banco.map(escapeTex).join(' \\textbullet{} ')}}}\n\n`;
      }
    } else if (est.submodo === 'alternativas') {
      tex += renderAlternativasTex(alts, imgBundle?.alts || {});
    }
  } else if (tipo === 'somatoria') {
    const props = Array.isArray(est.proposicoes) ? est.proposicoes : [];
    props.forEach(p => {
      const cod = escapeTex(p.codigo || String(p.valor || '').padStart(2, '0'));
      tex += `\\noindent \\textbf{(${cod})} ${textoParaTex(p.texto || '')}\\\\[2pt]\n`;
    });
    tex += `\\begin{flushright}\\textbf{SOMA:} \\framebox[1.4cm]{\\rule{0pt}{0.45cm}}\\end{flushright}\n\n`;
  } else if (tipo === 'discursiva') {
    const formato = est.formato_espaco || 'linhas';
    if (formato === 'quadro_calculo') {
      const altCm = Math.max(2.5, Math.min(7.5, ((Number(est.altura_quadro_px) || 140) / 38))).toFixed(1);
      tex += `\\vspace{0.15cm}\\noindent\\framebox[\\linewidth]{\\rule{0pt}{${altCm}cm}}\n\n`;
    } else if (formato !== 'nenhum') {
      const nLin = Math.max(2, Math.min(18, Number(est.linhas_resposta) || 6));
      tex += `\\vspace{0.2cm}\n`;
      for (let i = 0; i < nLin; i++) {
        tex += `\\noindent\\underline{\\hspace{\\linewidth}}\\vspace{0.2cm}\n\n`;
      }
    }
  } else {
    tex += renderAlternativasTex(alts, imgBundle?.alts || {});
  }

  tex += `\\vspace{0.35cm}\n\n`;
  return tex;
}

function gerarTexCompleto({ prova, itens, cfg, escola, colunas, imgBundles, comGabarito }) {
  const is2col    = colunas === 2;
  const comCab    = cfg.com_cabecalho ?? true;
  const comMarg   = cfg.com_margem   ?? true;
  const rodapeTxt = cfg.rodape_texto || '';
  const cab       = cfg.cabecalho_itens ?? {};
  const sh        = (k) => cab[k] ?? true;

  const margem = comMarg ? '0.7cm' : '0.3cm';

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

  tex += `\\definecolor{laranja}{HTML}{FF6600}\n`;
  tex += `\\definecolor{azul}{HTML}{0066FF}\n`;
  tex += `\\definecolor{amarelo}{HTML}{FCFB85}\n`;
  tex += `\\definecolor{gray}{HTML}{888888}\n`;

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

  const totalPts = itens.reduce((s, it) => s + Number(it.valor_pontos || 1), 0).toFixed(1);
  const rodapeStr = rodapeTxt ? `EDUCA.PROVA · ${rodapeTxt}` : 'EDUCA.PROVA';

  tex += `\\begin{document}\n`;
  tex += `\\fontsize{11pt}{13.5pt}\\selectfont\n\n`;

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

    if (sh('cab_instrucoes')) {
      tex += `\\vspace{4pt}\n`;
      tex += `\\fbox{\\parbox{\\linewidth}{\\textbf{INSTRUÇÕES:} `;
      tex += `Esta avaliação contém \\textbf{${itens.length} questão(ões)} `;
      tex += `no total de \\textbf{${totalPts} ponto(s)}. `;
      tex += `Leia cada questão com atenção antes de responder.}}\n\n`;
    }
  }

  tex += `\\vspace{0.3cm}\n\n`;

  if (is2col) {
    tex += `\\begin{multicols}{2}\n\\setlength{\\columnseprule}{0.8pt}\n\n`;
  }

  itens.forEach((item, idx) => {
    tex += gerarTexQuestao(item, idx, imgBundles[idx] || null, colunas);
  });

  if (is2col) {
    tex += `\\end{multicols}\n\n`;
  }

  if (comGabarito) {
    tex += `\\newpage\n`;
    tex += `\\begin{center}{\\large\\bfseries GABARITO — ${escapeTex(prova.titulo || '')}}\\end{center}\n\n`;
    tex += `\\begin{center}\n`;
    tex += `\\begin{tabular}{|c|c|p{5.5cm}|c|c|}\\hline\n`;
    tex += `\\textbf{Nº} & \\textbf{Código} & \\textbf{Resposta / Gabarito} & \\textbf{Pts} & \\textbf{Disciplina} \\\\ \\hline\n`;
    itens.forEach((it, i) => {
      const corr = escapeTex(resumirGabaritoTex(it));
      const cod  = escapeTex(it.codigo || `Q-${i + 1}`);
      const pts  = Number(it.valor_pontos || 1).toFixed(1);
      tex += `${String(i + 1).padStart(2, '0')} & ${cod} & \\textbf{${corr}} & ${pts} & ${escapeTex(it.disciplina || '---')} \\\\ \\hline\n`;
    });
    tex += `\\multicolumn{3}{|r|}{\\textbf{TOTAL}} & ${totalPts} & \\\\ \\hline\n`;
    tex += `\\end{tabular}\n`;
    tex += `\\end{center}\n\n`;
  }

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
              CONCAT('EMQE-', LPAD(COALESCE(q.numero_q, q.id), 5, '0')) AS codigo,
              q.conteudo_bruto, q.comando_final, q.tipo, q.nivel, q.disciplina,
              q.alternativas_json, q.estrutura_json, q.correta, q.resposta_aberta,
              q.imagem_url, q.imagem_base64, q.midia_json,
              q.texto_apoio, q.fonte
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

  const jobId  = randomUUID();
  const jobDir = path.join(os.tmpdir(), 'latex-jobs', jobId);
  fs.mkdirSync(jobDir, { recursive: true });

  try {
    const cfg    = (() => { try { return typeof prova.config_json === 'string' ? JSON.parse(prova.config_json) : (prova.config_json || {}); } catch { return {}; } })();
    const escola = req.query.escola || prova.escola_nome || 'EDUCA.MELHOR';
    const template = prova.template_slug || 'objetiva_2col';
    const colunas  = ['objetiva_2col', 'enem'].includes(template) ? 2 : 1;

    const imgBundles = await Promise.all(
      itens.map(async (it, idx) => {
        const midia = parseJsonObj(it.midia_json, null);
        const mainSrc = midia?.url || it.imagem_url || it.imagem_base64;
        const main = await salvarImagem(mainSrc, jobDir, `${idx}_main`);
        const alts = {};
        const altsArr = parseAlts(it.alternativas_json);
        for (const a of altsArr) {
          if (a.imagem_url && a.letra) {
            const pAlt = await salvarImagem(a.imagem_url, jobDir, `${idx}_alt_${a.letra}`);
            if (pAlt) alts[a.letra] = pAlt;
          }
        }
        return { main, alts };
      })
    );

    const texContent = gerarTexCompleto({ prova, itens, cfg, escola, colunas, imgBundles, comGabarito });
    const texFile = path.join(jobDir, 'prova.tex');
    fs.writeFileSync(texFile, texContent, 'utf-8');

    await execFileAsync('tectonic', [
      '--outdir', jobDir,
      '--keep-logs',
      '--synctex', '0',
      texFile,
    ], {
      timeout: 60000,
      env: {
        ...process.env,
        TECTONIC_CACHE_DIR: '/tmp/tectonic-cache',
      },
    });

    const pdfPath = path.join(jobDir, 'prova.pdf');
    if (!fs.existsSync(pdfPath)) {
      const logPath = path.join(jobDir, 'prova.log');
      const logContent = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf-8').slice(-2000) : 'sem log';
      throw new Error(`PDF não gerado. Log: ${logContent}`);
    }

    const pdfBuffer = fs.readFileSync(pdfPath);
    const nomeArq   = `${(prova.titulo || 'prova').toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-')}-latex.pdf`;

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
    try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch {}
  }
}
