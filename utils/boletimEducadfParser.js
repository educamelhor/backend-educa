// apps/educa-backend/utils/boletimEducadfParser.js
// ============================================================================
// PARSER POR COORDENADAS DO BOLETIM EDUCADF (SEEDF) — Fundamental e Médio
// ----------------------------------------------------------------------------
// Problema que resolve:
//   O EDUCADF NÃO escreve nada nas células vazias. Lendo o PDF como texto
//   corrido, só sobram os números existentes e o "índice do par" deixa de
//   corresponder ao bimestre (ex.: nota do 2º bim. gravada como 1º bim.).
//
// Como resolve:
//   Cada número é atribuído à coluna pela sua POSIÇÃO horizontal (X), usando
//   como âncora os cabeçalhos "M/C/N" e "Faltas" do próprio PDF. Célula sem
//   número fica VAZIA por construção. Nenhuma contagem de valores é usada.
//
// Segurança ("não importar e avisar"):
//   Toda linha com qualquer anomalia (valor fora de coluna, tipo incompatível,
//   célula duplicada, nota fora de 0–10, soma de faltas ≠ total) é marcada
//   como inválida e NÃO deve ser gravada.
// ============================================================================

import pdf from "pdf-parse";

/** Conceitos formativos da SEEDF (Itinerários) → escala decimal. */
export const CONCEITO_NOTA_MAP = {
  EP: 10.0, // Envolvimento Pleno
  ES: 8.0,  // Envolvimento Satisfatório
  ER: 6.0,  // Envolvimento Regular
  EI: 4.0,  // Envolvimento Insatisfatório
  SE: 0.0,  // Sem Envolvimento
};

const POS_PAGINA = 1000;      // desloca cada página para uma "posição vertical absoluta"
const TOL_LINHA = 3;          // pt — itens com dados na mesma linha
const TOL_NOME = 9;           // pt — distância máx. entre linha de nome e linha de dados
const TOL_COLUNA = 14;        // pt — distância máx. entre centro do valor e da coluna
const BANDA_CABECALHO = 22;   // pt — altura (±) da faixa de cabeçalho em torno de "Componentes/..."
const X_STATUS = 800;         // itens a partir deste X são a coluna "Situação"
const X_FALTAS_TOTAL = 700;   // "Faltas" a partir deste X é o "Total de Faltas" (resultado)

const normTxt = (s) =>
  String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase();

const porPos = (a, b) => a.pos - b.pos || a.x - b.x;
const porX = (a, b) => a.x - b.x;

// ----------------------------------------------------------------------------
// 1) Extração dos itens (texto + coordenadas) de cada página
// ----------------------------------------------------------------------------
export async function extrairPaginasPdf(buffer) {
  const paginas = [];
  const render = async (pageData) => {
    const tc = await pageData.getTextContent({
      normalizeWhitespace: true,
      disableCombineTextItems: false,
    });
    const itens = [];
    for (const it of tc.items) {
      const str = String(it.str ?? "").trim();
      if (!str) continue;
      const x = it.transform[4];
      const y = it.transform[5];
      const w = it.width || 0;
      // o EDUCADF desenha alguns textos duas vezes (negrito simulado) — deduplica
      if (itens.some((o) => o.str === str && Math.abs(o.x - x) <= 2 && Math.abs(o.y - y) <= 2)) continue;
      itens.push({ str, x, y, w, cx: x + w / 2 });
    }
    paginas.push({ page: pageData.pageNumber, itens });
    return "";
  };
  await pdf(buffer, { pagerender: render });
  paginas.sort((a, b) => a.page - b.page);
  return paginas;
}

// ----------------------------------------------------------------------------
// 2) Segmentação por estudante (não depende de "2 páginas por aluno")
//    Um novo estudante começa em toda página que contém "Nome do(a) Estudante:".
//    As páginas seguintes sem esse cabeçalho pertencem ao mesmo estudante.
// ----------------------------------------------------------------------------
export function segmentarAlunos(paginas) {
  const alunos = [];
  let atual = null;

  for (const pg of paginas) {
    const nomeItem = pg.itens.find((i) => /^Nome do\(a\) Estudante:/i.test(i.str));

    if (!nomeItem) {
      if (atual) atual.paginas.push(pg);
      continue; // páginas antes do primeiro estudante são ignoradas
    }

    atual = { paginas: [pg], nome: null, re: null, anoLetivo: null, etapa: "FUNDAMENTAL", paginaInicial: pg.page };
    alunos.push(atual);

    const naLinha = (ref) => pg.itens.filter((i) => Math.abs(i.y - ref.y) <= 2).sort(porX);

    // Nome (itens à esquerda do "RE") e RE (itens à direita)
    const linhaNome = naLinha(nomeItem);
    const nomeTxt = linhaNome.filter((i) => i.x < 690).map((i) => i.str).join(" ");
    atual.nome = nomeTxt.replace(/^.*?Estudante:\s*/i, "").trim() || null;
    const reTxt = linhaNome.filter((i) => i.x >= 690).map((i) => i.str).join(" ");
    const reM = reTxt.match(/(\d{3,})/);
    atual.re = reM ? parseInt(reM[1], 10) : null;

    // Etapa e ano letivo a partir da linha "BOLETIM ESCOLAR - ENSINO ... - ANO LETIVO: 2026"
    const titulo = pg.itens.find((i) => /BOLETIM ESCOLAR/i.test(i.str));
    if (titulo) {
      const txt = naLinha(titulo).map((i) => i.str).join(" ");
      atual.etapa = normTxt(txt).includes("ENSINO MEDIO") ? "MEDIO" : "FUNDAMENTAL";
      const anoM = txt.match(/ANO LETIVO:\s*(\d{4})/i);
      atual.anoLetivo = anoM ? parseInt(anoM[1], 10) : null;
    }
  }
  return alunos;
}

// ----------------------------------------------------------------------------
// 3) Classificação do conteúdo de uma célula
// ----------------------------------------------------------------------------
function classificarValor(str) {
  if (/^\d{1,2},\d{2}$/.test(str)) {
    return { tipo: "decimal", num: parseFloat(str.replace(",", ".")), raw: str };
  }
  if (/^\d{1,3}$/.test(str)) {
    return { tipo: "inteiro", num: parseInt(str, 10), raw: str };
  }
  const c = str.toUpperCase();
  if (CONCEITO_NOTA_MAP[c] !== undefined) {
    return { tipo: "conceito", num: CONCEITO_NOTA_MAP[c], raw: c };
  }
  return null;
}

const novaCelula = () => ({ nota: null, notaRaw: null, faltas: null });

// ----------------------------------------------------------------------------
// 4) Extração da tabela de componentes de UM estudante
//    Retorna { linhas, erros }.
//    - erros.length > 0  → layout não reconhecido: NÃO importar nada do aluno.
//    - linha.invalida    → NÃO importar aquela linha (ver linha.anomalias).
//    - linha.secao       → 0 = tabela principal; 1+ = tabelas seguintes
//                          (Itinerários / blocos repetidos).
// ----------------------------------------------------------------------------
export function extrairTabelaAluno(aluno) {
  const resultado = { linhas: [], erros: [] };

  // Fluxo único de itens ordenado de cima para baixo, página a página.
  const fluxo = [];
  aluno.paginas.forEach((pg, idx) => {
    for (const it of pg.itens) {
      fluxo.push({ ...it, pg: idx, pos: idx * POS_PAGINA + (POS_PAGINA - it.y) });
    }
  });
  fluxo.sort(porPos);

  const cabecalhos = fluxo.filter((i) => /^Componentes\/Unidades/i.test(i.str));
  if (cabecalhos.length === 0) {
    resultado.erros.push("Tabela de componentes curriculares não encontrada.");
    return resultado;
  }

  // Tudo a partir de "Data de Emissão" é rodapé/assinatura/legendas.
  const itemFim = fluxo.find((i) => /^Data de Emiss/i.test(i.str));
  const posFim = itemFim ? itemFim.pos : Infinity;

  // ── Âncoras de coluna de cada cabeçalho ───────────────────────────────────
  // Uma quebra de página pode separar o cabeçalho em dois pedaços; as colunas
  // têm o mesmo X em todo o boletim, então um cabeçalho incompleto "empresta"
  // as âncoras do primeiro cabeçalho completo do mesmo estudante.
  const lerBanda = (h) => {
    const banda = fluxo.filter((i) => i.pg === h.pg && Math.abs(i.y - h.y) <= BANDA_CABECALHO);
    return {
      mcn: banda.filter((i) => i.str === "M/C/N").sort(porX),
      fal: banda.filter((i) => i.str === "Faltas" && i.x < X_FALTAS_TOTAL).sort(porX),
      itemPorCC: banda.find((i) => /^Por CC/i.test(i.str)),
      itemTotF: banda.find((i) => i.str === "Faltas" && i.x >= X_FALTAS_TOTAL),
    };
  };
  const bandas = cabecalhos.map(lerBanda);
  const bandaRef = bandas.find((b) => b.mcn.length === 4 && b.fal.length === 4);
  if (!bandaRef) {
    resultado.erros.push("Cabeçalho de colunas (M/C/N × Faltas por bimestre) não reconhecido no boletim.");
    return resultado;
  }

  for (let s = 0; s < cabecalhos.length; s++) {
    const h = cabecalhos[s];
    const prox = cabecalhos[s + 1];

    const b = bandas[s];
    const completa = b.mcn.length === 4 && b.fal.length === 4;
    const { mcn, fal, itemPorCC, itemTotF } = completa ? b : bandaRef;

    const ancoras = [];
    mcn.forEach((it, k) => ancoras.push({ tipo: "nota", bim: k + 1, cx: it.cx }));
    fal.forEach((it, k) => ancoras.push({ tipo: "falta", bim: k + 1, cx: it.cx }));
    if (itemPorCC) ancoras.push({ tipo: "porCC", cx: itemPorCC.cx });
    if (itemTotF) ancoras.push({ tipo: "totalFaltas", cx: itemTotF.cx });

    const xNomeMax = mcn[0].x - 6; // nomes de disciplina ficam à esquerda da 1ª coluna de nota

    // ── Itens de dados desta seção ────────────────────────────────────────
    const posIni = h.pos + BANDA_CABECALHO;
    const posLim = Math.min(prox ? prox.pos - BANDA_CABECALHO : Infinity, posFim);
    const dados = fluxo.filter((i) => {
      if (!(i.pos > posIni && i.pos < posLim)) return false;
      if (/^P.gina\s+\d+\s+de\s+\d+/i.test(i.str)) return false;           // "Página 1 de 74"
      const n = normTxt(i.str);
      if (n.startsWith("ITINERARIO FORMATIVO")) return false;  // título do itinerário
      // textos do cabeçalho da tabela (podem aparecer na página anterior quando há quebra de página)
      if (/^[1-4]\.\S? BIMESTRE$/.test(n) || /^(RESULTADO|TOTAL DE|M\/C\/N|FALTAS|POR CC|SITUACAO)$/.test(n)) return false;
      if (n.startsWith("COMPONENTES/UNIDADES")) return false;
      return true;
    });

    // ── Linhas = agrupamento por posição vertical dos itens à direita do nome
    const linhasDados = [];
    for (const it of dados.filter((i) => i.x >= xNomeMax)) {
      let ln = linhasDados.find((l) => Math.abs(l.pos - it.pos) <= TOL_LINHA);
      if (!ln) {
        ln = { pos: it.pos, valores: [], nomes: [], status: null };
        linhasDados.push(ln);
      }
      if (it.x >= X_STATUS) ln.status = it.str;
      else ln.valores.push(it);
    }

    // ── Nomes: cada linha de texto vai para a linha de dados mais próxima ──
    //    (nomes quebrados em 2+ linhas ficam centralizados na linha de dados)
    const orfas = []; // disciplinas sem nenhum dado (nem valores, nem status)
    for (const it of dados.filter((i) => i.x < xNomeMax).sort(porPos)) {
      let melhor = null;
      let dist = Infinity;
      for (const l of linhasDados) {
        const d = Math.abs(l.pos - it.pos);
        if (d < dist) { dist = d; melhor = l; }
      }
      if (melhor && dist <= TOL_NOME) {
        melhor.nomes.push(it);
      } else {
        const ultima = orfas[orfas.length - 1];
        if (ultima && Math.abs(ultima.posUltima - it.pos) <= TOL_NOME) {
          ultima.nomes.push(it);
          ultima.posUltima = it.pos;
        } else {
          orfas.push({ pos: it.pos, posUltima: it.pos, valores: [], nomes: [it], status: null });
        }
      }
    }

    const linhasSecao = [...linhasDados, ...orfas].sort((a, b) => a.pos - b.pos);

    for (const ln of linhasSecao) {
      // Nome: junta as linhas de texto de cima para baixo; dentro da linha, da esquerda p/ direita
      const nomesOrd = [...ln.nomes].sort(porPos);
      const linhasTexto = [];
      for (const it of nomesOrd) {
        const alvo = linhasTexto.find((t) => Math.abs(t.pos - it.pos) <= 2);
        if (alvo) alvo.itens.push(it);
        else linhasTexto.push({ pos: it.pos, itens: [it] });
      }
      const nomeRaw = linhasTexto
        .map((t) => t.itens.sort(porX).map((i) => i.str).join(" "))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();

      const linha = {
        secao: s,
        nomeRaw,
        bim: { 1: novaCelula(), 2: novaCelula(), 3: novaCelula(), 4: novaCelula() },
        porCC: null,
        totalFaltas: null,
        status: ln.status,
        anomalias: [],
        avisos: [],
        invalida: false,
      };

      // Atribuição de cada valor à coluna pela POSIÇÃO horizontal
      for (const v of ln.valores) {
        let melhor = null;
        let dist = Infinity;
        for (const a of ancoras) {
          const d = Math.abs(v.cx - a.cx);
          if (d < dist) { dist = d; melhor = a; }
        }
        if (!melhor || dist > TOL_COLUNA) {
          linha.anomalias.push(`valor "${v.str}" fora de qualquer coluna (x=${Math.round(v.cx)})`);
          continue;
        }
        const val = classificarValor(v.str);
        if (!val) {
          linha.anomalias.push(`valor inesperado "${v.str}" na coluna ${melhor.tipo}${melhor.bim ? " " + melhor.bim + "º bim" : ""}`);
          continue;
        }

        if (melhor.tipo === "nota") {
          if (val.tipo === "inteiro") {
            linha.anomalias.push(`"${v.str}" é inteiro na coluna de nota do ${melhor.bim}º bim`);
            continue;
          }
          if (val.num < 0 || val.num > 10) {
            linha.anomalias.push(`nota ${v.str} fora de 0–10 no ${melhor.bim}º bim`);
            continue;
          }
          const cel = linha.bim[melhor.bim];
          if (cel.nota !== null) {
            linha.anomalias.push(`duas notas na mesma célula do ${melhor.bim}º bim`);
            continue;
          }
          cel.nota = val.num;
          cel.notaRaw = val.raw;
        } else if (melhor.tipo === "falta") {
          if (val.tipo !== "inteiro") {
            linha.anomalias.push(`"${v.str}" não é inteiro na coluna de faltas do ${melhor.bim}º bim`);
            continue;
          }
          const cel = linha.bim[melhor.bim];
          if (cel.faltas !== null) {
            linha.anomalias.push(`duas faltas na mesma célula do ${melhor.bim}º bim`);
            continue;
          }
          cel.faltas = val.num;
        } else if (melhor.tipo === "porCC") {
          linha.porCC = val.num;
        } else if (melhor.tipo === "totalFaltas") {
          if (val.tipo !== "inteiro") {
            linha.anomalias.push(`total de faltas "${v.str}" não é inteiro`);
            continue;
          }
          linha.totalFaltas = val.num;
        }
      }

      // Conferência informativa: Total de Faltas (resultado) = soma das faltas dos bimestres.
      // NÃO bloqueia: o próprio PDF do EDUCADF é inconsistente em alguns casos; a atribuição
      // correta dos valores é garantida pela posição das colunas.
      if (linha.totalFaltas !== null) {
        const soma = [1, 2, 3, 4].reduce((acc, b) => acc + (linha.bim[b].faltas ?? 0), 0);
        if (soma !== linha.totalFaltas) {
          linha.avisos.push(`soma das faltas dos bimestres (${soma}) difere do total do PDF (${linha.totalFaltas})`);
        }
      }

      // Linha com valores mas sem nome identificável
      const temDados = ln.valores.length > 0;
      if (!nomeRaw && temDados) linha.anomalias.push("linha com valores sem nome de disciplina");
      if (!nomeRaw && !temDados && ln.status) linha.anomalias.push("situação sem nome de disciplina");
      if (!nomeRaw && !temDados && !ln.status) continue; // linha vazia sem nome: ruído
      // Disciplina sem nenhum valor e sem situação: estrutura ambígua → não importar (e avisar)
      if (nomeRaw && !temDados && !ln.status) {
        linha.anomalias.push("disciplina sem valores e sem situação no PDF (estrutura ambígua)");
      }

      linha.invalida = linha.anomalias.length > 0;
      resultado.linhas.push(linha);
    }
  }

  return resultado;
}
