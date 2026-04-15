// controllers/provaHtmlController.js
// EDUCA.PROVA — Sprint 4: Gerador de HTML/PDF via Playwright
// Fiel à estrutura dos templates LaTeX (PACOTES.tex + PROJETO_PROVA.tex)

import pool from '../db.js';

// ── Helpers ──────────────────────────────────────────────────────────────────
const escolaFilter = (escola_id) =>
  escola_id ? '(p.escola_id = ? OR p.escola_id IS NULL)' : '1=1';
const escolaParam = (escola_id) => (escola_id ? [escola_id] : []);

// Embaralha array (Fisher-Yates) — Sprint 5
function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Converte LaTeX inline ($...$) e símbolos para HTML
function ltx(text = '') {
  if (!text) return '';
  return text
    .replace(/\$([^$]+)\$/g, '<span class="math">$1</span>')
    .replace(/\\textbf\{([^}]+)\}/g, '<strong>$1</strong>')
    .replace(/\\emph\{([^}]+)\}/g, '<em>$1</em>')
    .replace(/\\text\{([^}]+)\}/g, '$1')
    .replace(/&/g, '&amp;')
    .replace(/>/g, '&gt;')
    .replace(/</g, '&lt;')
    .replace(/\n/g, '<br>');
}

// Limpa texto simples sem latex
function txt(text = '') {
  return (text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Renderiza bloco de alternativas como LaTeX \begin{itemize}
function renderAlternativas(altsJson, correta, template, showGabarito = false) {
  let alts = [];
  try { alts = JSON.parse(altsJson || '[]'); } catch {}
  if (!alts.length) return '';

  const isTempMista = template === 'discursiva' || template === 'mista';

  return `<div class="alternativas">
    ${alts.map(a => {
      const isCorr = showGabarito && (a.correta || a.letra === correta);
      return `<div class="alt${isCorr ? ' correta' : ''}">
        <span class="alt-letra">(${a.letra || '?'})</span>
        <span class="alt-texto">${ltx(a.texto)}</span>
        ${isCorr ? '<span class="corr-mark">✔</span>' : ''}
      </div>`;
    }).join('')}
  </div>`;
}

// Renderiza linhas de resposta (questão discursiva)
function renderLinhasResposta(n = 8) {
  return `<div class="linhas-resposta">${Array.from({ length: n }, () =>
    '<div class="linha-resp"></div>'
  ).join('')}</div>`;
}

// Renderiza uma questão
function renderQuestao(item, idx, template, showGabarito) {
  const num = String(idx + 1).padStart(2, '0');
  const enunciado = ltx(item.conteudo_bruto);
  const isDisc = template === 'discursiva' || (template === 'mista' && item.tipo === 'discursiva');
  const pontos = item.valor_pontos || 1;
  const bncc = item.habilidade_bncc ? `<span class="bncc-tag">${item.habilidade_bncc}</span>` : '';

  const imagem = item.imagem_base64
    ? `<div class="questao-img"><img src="${item.imagem_base64}" alt="Figura" /></div>`
    : '';

  const textoApoio = item.texto_apoio
    ? `<blockquote class="texto-apoio">${ltx(item.texto_apoio)}${item.fonte ? `<footer>— ${txt(item.fonte)}</footer>` : ''}</blockquote>`
    : '';

  return `
  <div class="questao" data-nivel="${item.nivel || 'medio'}">
    <div class="questao-header">
      <span class="questao-num">QUESTÃO ${num}</span>
      <span class="questao-meta">
        ${item.disciplina ? `<span class="disc-tag">${txt(item.disciplina)}</span>` : ''}
        ${bncc}
        <span class="pts-tag">${pontos} pt${pontos != 1 ? 's' : ''}</span>
      </span>
    </div>
    ${textoApoio}
    <div class="questao-enunciado">${enunciado || '(sem enunciado)'}</div>
    ${imagem}
    ${isDisc
      ? renderLinhasResposta(6)
      : renderAlternativas(item.alternativas_json, item.correta, template, showGabarito)
    }
  </div>`;
}

// CSS da prova (fiel ao PACOTES.tex)
function buildCSS(template) {
  const is2col = template === 'objetiva_2col' || template === 'enem';
  return `
    @import url('https://fonts.googleapis.com/css2?family=IM+Fell+English:ital@0;1&family=Source+Serif+4:ital,wght@0,300;0,400;0,600;0,700;1,400&display=swap');

    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: 'Source Serif 4', 'Times New Roman', serif;
      font-size: 11pt;
      line-height: 1.55;
      color: #000;
      background: #fff;
    }

    /* A4 preview (tela) */
    .pagina {
      width: 210mm;
      min-height: 297mm;
      margin: 0 auto;
      padding: 10mm 12mm 14mm;
      background: #fff;
      position: relative;
    }

    /* ── CABEÇALHO ── */
    .cabecalho {
      border: 2px solid #000;
      padding: 6px 10px;
      margin-bottom: 6px;
    }
    .cabecalho-top {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 4px;
    }
    .cabecalho-logo {
      width: 52px; height: 52px;
      display: flex; align-items: center; justify-content: center;
      border: 1.5px solid #333;
      font-size: 20px;
      flex-shrink: 0;
    }
    .cabecalho-escola {
      flex: 1;
      text-align: center;
    }
    .escola-nome {
      font-size: 11.5pt;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.03em;
    }
    .escola-sub {
      font-size: 8.5pt;
      color: #333;
    }
    .cabecalho-titulo {
      text-align: center;
      font-size: 13pt;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      border-top: 1px solid #000;
      padding-top: 5px;
      margin-top: 4px;
    }
    .cabecalho-campos {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 4px;
      margin-top: 5px;
      border-top: 1px solid #ccc;
      padding-top: 5px;
    }
    .campo-linha {
      display: flex;
      align-items: flex-end;
      gap: 5px;
      font-size: 9pt;
      padding-bottom: 2px;
      border-bottom: 0.5px solid #555;
    }
    .campo-label { font-weight: 700; white-space: nowrap; flex-shrink: 0; }

    /* ── INSTRUCOES ── */
    .instrucoes {
      border: 1px solid #000;
      padding: 5px 10px;
      margin-bottom: 8px;
      font-size: 8.5pt;
    }
    .instrucoes strong { font-size: 9pt; }
    .instrucoes ol { margin-left: 18px; margin-top: 3px; }
    .instrucoes li { margin-bottom: 1px; }

    /* ── GRID DE QUESTÕES ── */
    .questoes-grid {
      ${is2col ? `
        column-count: 2;
        column-gap: 10mm;
        column-rule: 0.8pt solid #555;
      ` : ''}
    }

    /* ── QUESTÃO ── */
    .questao {
      break-inside: avoid;
      margin-bottom: 11px;
      padding-bottom: 8px;
      border-bottom: 0.5px dashed #ccc;
    }
    .questao:last-child { border-bottom: none; }

    .questao-header {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      margin-bottom: 3px;
    }
    .questao-num {
      font-weight: 700;
      font-size: 10pt;
      text-transform: uppercase;
      letter-spacing: 0.02em;
    }
    .questao-meta {
      display: flex; gap: 5px; align-items: center;
    }
    .disc-tag, .bncc-tag, .pts-tag {
      font-size: 7pt;
      padding: 1px 5px;
      border: 0.7pt solid;
      border-radius: 3px;
      font-family: sans-serif;
    }
    .disc-tag { color: #1d4ed8; border-color: #1d4ed8; }
    .bncc-tag { color: #7c3aed; border-color: #7c3aed; }
    .pts-tag  { color: #666; border-color: #999; }

    .questao-enunciado {
      font-size: 10.5pt;
      line-height: 1.6;
      margin-bottom: 4px;
      text-align: justify;
    }

    .texto-apoio {
      background: #f9f9f9;
      border-left: 3px solid #555;
      padding: 5px 8px;
      margin-bottom: 5px;
      font-size: 9.5pt;
      font-style: italic;
      color: #222;
    }
    .texto-apoio footer {
      font-size: 8pt; font-style: normal; margin-top: 3px; color: #555;
    }

    .questao-img img {
      max-width: 100%; max-height: 120px;
      display: block; margin: 4px auto;
      border: 0.5pt solid #ccc;
    }

    /* ── ALTERNATIVAS ── */
    .alternativas { margin-top: 3px; }
    .alt {
      display: flex;
      gap: 5px;
      padding: 2px 0;
      font-size: 10pt;
      align-items: flex-start;
    }
    .alt-letra { font-weight: 700; flex-shrink: 0; min-width: 20px; }
    .alt-texto { flex: 1; }
    .alt.correta { background: #f0fdf4; }
    .alt.correta .alt-letra { color: #166534; }
    .corr-mark { color: #166534; font-size: 9pt; flex-shrink: 0; }

    /* ── LINHAS RESPOSTA (discursiva) ── */
    .linhas-resposta { margin-top: 4px; }
    .linha-resp {
      height: 16px;
      border-bottom: 0.6pt dotted #999;
      margin-bottom: 3px;
      width: 100%;
    }

    /* ── MATH INLINE ── */
    .math {
      font-family: 'IM Fell English', serif;
      font-style: italic;
      letter-spacing: 0.01em;
    }

    /* ── GABARITO ── */
    .gabarito-tabela {
      width: 100%;
      border-collapse: collapse;
      font-size: 9.5pt;
      margin-top: 8px;
    }
    .gabarito-tabela th {
      background: #333;
      color: #fff;
      padding: 4px 6px;
      text-align: center;
      font-size: 8.5pt;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    .gabarito-tabela td {
      padding: 3px 6px;
      border: 0.5pt solid #ccc;
      text-align: center;
      font-size: 9pt;
    }
    .gabarito-tabela tr:nth-child(even) td { background: #f5f5f5; }
    .gabarito-tabela .resp-ok { color: #166534; font-weight: 700; }

    /* ── RODAPÉ ── */
    .rodape {
      position: fixed;
      bottom: 8mm;
      left: 12mm; right: 12mm;
      font-size: 7.5pt;
      color: #666;
      border-top: 0.5pt solid #999;
      padding-top: 3px;
      display: flex;
      justify-content: space-between;
    }

    /* ── PRINT ── */
    @media print {
      @page {
        size: A4;
        margin: 10mm 12mm 14mm;
      }
      body { print-color-adjust: exact; -webkit-print-color-adjust: exact; }
      .pagina { width: 100%; margin: 0; padding: 0; min-height: unset; }
      .rodape { position: fixed; }
      .questao { break-inside: avoid; }
      .cabecalho { break-after: avoid; }
    }
  `;
}

// Monta o HTML completo (fiel ao PROJETO_PROVA.tex)
export function buildProvaHTML(prova, itens, escolaNome = '', showGabarito = false, embaralhar = false) {
  const template   = prova.template_slug || 'objetiva_2col';

  // Sprint 5: embaralha alternativas (mantém gabarito correto conforme campo `correta`)
  const itensRender = embaralhar ? itens.map(it => {
    let alts = [];
    try { alts = JSON.parse(it.alternativas_json || '[]'); } catch {}
    if (alts.length > 1) {
      const shuffled = shuffleArray(alts).map((a, i) => ({
        ...a, letra: String.fromCharCode(65 + i),
      }));
      return { ...it, alternativas_json: JSON.stringify(shuffled) };
    }
    return it;
  }) : itens;

  const isEnem     = template === 'enem';
  const disc       = txt(prova.disciplina || '');
  const turma      = txt(prova.turma || '');
  const bimestre   = prova.bimestre ? `${prova.bimestre}º Bimestre` : '';
  const anoLetivo  = prova.ano_letivo || new Date().getFullYear();
  const titulo     = txt(prova.titulo || 'Avaliação');
  const escolaTxt  = txt(escolaNome || 'EDUCA.MELHOR');
  const totalPts   = itens.reduce((s, it) => s + Number(it.valor_pontos || 1), 0).toFixed(1);

  const qtdQuestoes = itens.length;

  // ── Cabeçalho ──────────────────────────────────────────────────────────────
  const cabecalho = `
  <div class="cabecalho">
    <div class="cabecalho-top">
      <div class="cabecalho-logo">🏫</div>
      <div class="cabecalho-escola">
        <div class="escola-nome">${escolaTxt}</div>
        <div class="escola-sub">Sistema de Ensino EDUCA.MELHOR</div>
      </div>
    </div>
    <div class="cabecalho-titulo">${titulo}</div>
    <div class="cabecalho-campos">
      <div class="campo-linha">
        <span class="campo-label">Nome:</span><span style="flex:1"></span>
      </div>
      <div class="campo-linha">
        <span class="campo-label">Turma:</span>&nbsp;${turma}&nbsp;&nbsp;&nbsp;
        <span class="campo-label">Data:</span>&nbsp;___/___/______
      </div>
      <div class="campo-linha">
        <span class="campo-label">Disciplina:</span>&nbsp;${disc}
      </div>
      <div class="campo-linha">
        <span class="campo-label">${bimestre}</span>&nbsp;&nbsp;
        <span class="campo-label">${anoLetivo}</span>&nbsp;&nbsp;
        <span class="campo-label">Nota:</span>&nbsp;_________
      </div>
    </div>
  </div>`;

  // ── Instruções ─────────────────────────────────────────────────────────────
  const instrucoes = `
  <div class="instrucoes">
    <strong>INSTRUÇÕES:</strong>
    <ol>
      <li>Esta avaliação contém <strong>${qtdQuestoes} questão(ões)</strong> no total de <strong>${totalPts} ponto(s)</strong>.</li>
      ${isEnem ? '<li>Utilize caneta azul ou preta para marcar as alternativas no gabarito.</li>' : ''}
      <li>Leia cada questão com atenção antes de responder.</li>
      <li>${template === 'discursiva' || template === 'mista' ? 'Responda nas linhas abaixo de cada questão com letra legível.' : 'Marque apenas uma alternativa por questão.'}</li>
    </ol>
  </div>`;

  // ── Questões ───────────────────────────────────────────────────────────────
  const questoesHtml = itensRender
    .map((item, idx) => renderQuestao(item, idx, template, showGabarito))
    .join('');

  // ── Gabarito ───────────────────────────────────────────────────────────────
  const gabaritoHtml = showGabarito ? `
  <div style="page-break-before: always; margin-top: 20px;">
    <div class="cabecalho">
      <div class="cabecalho-titulo">GABARITO — ${txt(prova.titulo || 'Avaliação')}</div>
    </div>
    <table class="gabarito-tabela">
      <thead><tr>
        <th>Nº</th><th>Resp.</th><th>Pts</th><th>Disciplina</th><th>Nível</th>
        ${itensRender[0]?.habilidade_bncc ? '<th>BNCC</th>' : ''}
      </tr></thead>
      <tbody>
        ${itensRender.map((it, idx) => {
          let corr = it.correta || '—';
          try {
            const alts = JSON.parse(it.alternativas_json || '[]');
            const c = alts.find(a => a.correta);
            if (c) corr = c.letra;
          } catch {}
          const nivel = { facil: 'Fácil', medio: 'Médio', dificil: 'Difícil', enem: 'ENEM' }[it.nivel] || it.nivel || '—';
          return `<tr>
            <td>${String(idx + 1).padStart(2, '0')}</td>
            <td class="resp-ok">${corr}</td>
            <td>${Number(it.valor_pontos || 1).toFixed(1)}</td>
            <td>${txt(it.disciplina || '—')}</td>
            <td>${nivel}</td>
            ${it.habilidade_bncc ? `<td>${txt(it.habilidade_bncc)}</td>` : (itensRender[0]?.habilidade_bncc ? '<td>—</td>' : '')}
          </tr>`;
        }).join('')}
        <tr style="border-top: 2px solid #333; font-weight:700;">
          <td colspan="2" style="text-align:right">TOTAL</td>
          <td>${itensRender.reduce((s,it) => s + Number(it.valor_pontos||1), 0).toFixed(1)}</td>
          <td colspan="${itensRender[0]?.habilidade_bncc ? 3 : 2}"></td>
        </tr>
      </tbody>
    </table>
  </div>` : '';

  // ── Rodapé ─────────────────────────────────────────────────────────────────
  const rodape = `
  <div class="rodape">
    <span>${escolaTxt} — ${disc} — ${bimestre} ${anoLetivo}</span>
    <span>EDUCA.PROVA</span>
  </div>`;

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${titulo}</title>
  <style>${buildCSS(template)}</style>
</head>
<body>
  <div class="pagina">
    ${cabecalho}
    ${instrucoes}
    <div class="questoes-grid">
      ${questoesHtml}
    </div>
    ${gabaritoHtml}
    ${rodape}
  </div>
</body>
</html>`;
}

// ── Buscar prova + itens do banco ──────────────────────────────────────────
async function fetchProvaCompleta(id, escola_id) {
  const [[prova]] = await pool.query(
    `SELECT * FROM provas p WHERE p.id = ? AND ${escolaFilter(escola_id)}`,
    [id, ...escolaParam(escola_id)]
  );
  if (!prova) return null;

  const [itens] = await pool.query(
    `SELECT pq.id AS item_id, pq.ordem, pq.valor_pontos,
            q.id AS questao_id, q.conteudo_bruto, q.tipo, q.nivel,
            q.disciplina, q.alternativas_json, q.correta, q.tags,
            q.habilidade_bncc, q.imagem_base64, q.texto_apoio, q.fonte
     FROM prova_questoes pq
     JOIN questoes q ON q.id = pq.questao_id
     WHERE pq.prova_id = ?
     ORDER BY pq.ordem ASC`,
    [id]
  );
  return { prova, itens };
}

// ── GET /api/provas/:id/html ── Preview HTML ──────────────────────────────
export async function previewHtml(req, res) {
  const { id } = req.params;
  const { escola_id } = req.user;
  const showGab = req.query.gabarito === '1';
  try {
    const data = await fetchProvaCompleta(id, escola_id);
    if (!data) return res.status(404).json({ message: 'Prova não encontrada.' });

    const escolaNome = localStorage?.getItem?.('escola_nome') || 'EDUCA.MELHOR';
    const html = buildProvaHTML(data.prova, data.itens, escolaNome, showGab);
    res.setHeader('Content-Type', 'text/html; charset=UTF-8');
    res.send(html);
  } catch (err) {
    console.error('previewHtml:', err);
    res.status(500).json({ message: 'Erro ao gerar HTML.', detail: err.message });
  }
}

// ── POST /api/provas/:id/pdf ── Gera PDF via Playwright ──────────────────
export async function gerarPdf(req, res) {
  const { id } = req.params;
  const { escola_id } = req.user;
  const showGab = req.query.gabarito === '1';

  let browser = null;
  try {
    const data = await fetchProvaCompleta(id, escola_id);
    if (!data) return res.status(404).json({ message: 'Prova não encontrada.' });

    const escolaNome = req.query.escola || 'EDUCA.MELHOR';
    const embaralhar = req.query.embaralhar === '1' || data.prova.embaralhar_alternativas === 1;
    const html = buildProvaHTML(data.prova, data.itens, escolaNome, showGab, embaralhar);

    // Playwright → PDF
    const { chromium } = await import('playwright');
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle', timeout: 30_000 });

    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '10mm', right: '12mm', bottom: '14mm', left: '12mm' },
    });

    const slug = (data.prova.titulo || 'prova')
      .toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').slice(0, 40);
    const filename = `${slug}-${Date.now()}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', pdfBuffer.length);
    res.send(pdfBuffer);
  } catch (err) {
    console.error('gerarPdf:', err);
    res.status(500).json({ message: 'Erro ao gerar PDF.', detail: err.message });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}
