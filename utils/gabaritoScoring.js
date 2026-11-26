// ============================================================================
// Utilitário Central de Configuração e Pontuação OMR (Múltipla Escolha, C/E e Mista)
// ============================================================================

/**
 * Converte string compacta de intervalos (ex: "1-15,20,25-30") em array de inteiros 1-based.
 */
export function expandirFaixasCE(ceInput, numQuestoes = 100) {
  const nQ = Math.max(0, Number(numQuestoes) || 100);
  if (!ceInput) return [];

  if (Array.isArray(ceInput)) {
    return [...new Set(
      ceInput
        .map((n) => Number(n))
        .filter((n) => Number.isInteger(n) && n >= 1 && (nQ === 0 || n <= nQ))
    )].sort((a, b) => a - b);
  }

  if (typeof ceInput === "string") {
    const trimmed = ceInput.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith("[")) {
      try {
        return expandirFaixasCE(JSON.parse(trimmed), nQ);
      } catch {
        return [];
      }
    }
    const set = new Set();
    const parts = trimmed.split(",");
    for (const raw of parts) {
      const p = raw.trim();
      if (!p) continue;
      if (p.includes("-")) {
        const [aStr, bStr] = p.split("-");
        const start = parseInt(aStr, 10);
        const end = parseInt(bStr, 10);
        if (Number.isInteger(start) && Number.isInteger(end)) {
          const lo = Math.max(1, Math.min(start, end));
          const hi = nQ > 0 ? Math.min(nQ, Math.max(start, end)) : Math.max(start, end);
          for (let q = lo; q <= hi; q++) set.add(q);
        }
      } else {
        const num = parseInt(p, 10);
        if (Number.isInteger(num) && num >= 1 && (nQ === 0 || num <= nQ)) {
          set.add(num);
        }
      }
    }
    return [...set].sort((a, b) => a - b);
  }

  return [];
}

/**
 * Compacta um array de números de questões (ex: [1,2,3,4,8,10,11,12]) em "1-4,8,10-12"
 * para caber em poucos bytes dentro do QR Code OMR (80x80pt).
 */
export function compactarFaixasCE(questoesCeArray) {
  if (!Array.isArray(questoesCeArray) || questoesCeArray.length === 0) return "";
  const sorted = [...new Set(
    questoesCeArray.map(Number).filter((n) => Number.isInteger(n) && n >= 1)
  )].sort((a, b) => a - b);

  if (sorted.length === 0) return "";

  const ranges = [];
  let start = sorted[0];
  let prev = sorted[0];

  for (let i = 1; i < sorted.length; i++) {
    const curr = sorted[i];
    if (curr === prev + 1) {
      prev = curr;
    } else {
      ranges.push(start === prev ? `${start}` : `${start}-${prev}`);
      start = curr;
      prev = curr;
    }
  }
  ranges.push(start === prev ? `${start}` : `${start}-${prev}`);
  return ranges.join(",");
}

/**
 * Normaliza os parâmetros de formato de questões de uma avaliação.
 */
export function normalizarConfigFormato({
  formato_questoes,
  questoes_ce,
  penalidade_ce,
  num_questoes,
}) {
  const nQ = Math.max(1, Number(num_questoes) || 10);
  const fmtRaw = String(formato_questoes || "multipla_escolha").trim().toLowerCase();
  const formato = ["multipla_escolha", "certo_errado", "mista"].includes(fmtRaw)
    ? fmtRaw
    : "multipla_escolha";

  let questoesCe = [];
  if (formato === "certo_errado") {
    questoesCe = Array.from({ length: nQ }, (_, i) => i + 1);
  } else if (formato === "mista") {
    questoesCe = expandirFaixasCE(questoes_ce, nQ);
  }

  const ceSet = new Set(questoesCe);
  const penalidadeAtiva = ceSet.size > 0 && Boolean(Number(penalidade_ce));

  return {
    formato,
    questoesCe,
    ceSet,
    penalidadeAtiva,
    ceCompacto: formato === "mista" ? compactarFaixasCE(questoesCe) : "",
  };
}

/**
 * Calcula a correção oficial/display de um aluno suportando:
 *   - Múltipla Escolha (A..F)
 *   - Certo / Errado (C / E)
 *   - Prova Mista (ME + C/E na mesma prova)
 *   - Fator de correção opcional Cebraspe/PAS-UnB (1 errada anula 1 certa nos itens C/E;
 *     em branco ou dupla marcação 'N' = 0; nota líquida nunca menor que 0)
 *   - Questões canceladas ('bonificar' | 'desconsiderar')
 *   - Ajustes manuais por questão ('acerto' | 'erro')
 */
export function calcularCorrecaoGabarito({
  respostasAluno = [],
  gabaritoOficial = [],
  numQuestoes,
  notaTotal = 10,
  disciplinasConfig = [],
  questoesCanceladas = [],
  ajustesMap = {},
  formatoQuestoes = "multipla_escolha",
  questoesCe = null,
  penalidadeCe = 0,
}) {
  const nQ = Number(numQuestoes) || gabaritoOficial.length || 0;
  const maxNota = Number(notaTotal) || 10;

  const { formato, ceSet, penalidadeAtiva } = normalizarConfigFormato({
    formato_questoes: formatoQuestoes,
    questoes_ce: questoesCe,
    penalidade_ce: penalidadeCe,
    num_questoes: nQ,
  });

  const canceladas = Array.isArray(questoesCanceladas) ? questoesCanceladas : [];
  const cancelMap = {};
  for (const c of canceladas) {
    if (c && c.numero) cancelMap[Number(c.numero)] = c.modo; // "bonificar" | "desconsiderar"
  }

  const numDesconsideradas = canceladas.filter((c) => c?.modo === "desconsiderar").length;
  const numQuestoesEfetivas = Math.max(1, nQ - numDesconsideradas);
  const valorQuestao = numQuestoesEfetivas > 0 ? maxNota / numQuestoesEfetivas : 0;

  const detalhes = [];

  for (let i = 0; i < nQ; i++) {
    const questaoNum = i + 1;
    const modoCancelada = cancelMap[questaoNum];
    if (modoCancelada === "desconsiderar") continue;

    const isCE = ceSet.has(questaoNum);
    const respRaw = respostasAluno[i] != null ? String(respostasAluno[i]).trim().toUpperCase() : "";
    const correto = gabaritoOficial[i] != null ? String(gabaritoOficial[i]).trim().toUpperCase() : "";
    const isBranco = !respRaw || respRaw === "-" || respRaw === "—";
    const isNulo = respRaw === "N";

    let acertou = false;
    let pontos = 0;

    if (ajustesMap && ajustesMap[questaoNum] !== undefined) {
      acertou = ajustesMap[questaoNum] === "acerto";
      pontos = acertou ? 1 : (isCE && penalidadeAtiva && !isBranco && !isNulo ? -1 : 0);
    } else if (modoCancelada === "bonificar") {
      acertou = true;
      pontos = 1;
    } else if (isBranco || isNulo) {
      // Em branco ou dupla marcação: 0 ponto (não penaliza no modelo Cebraspe/PAS)
      acertou = false;
      pontos = 0;
    } else if (correto && respRaw === correto) {
      acertou = true;
      pontos = 1;
    } else {
      acertou = false;
      pontos = isCE && penalidadeAtiva ? -1 : 0;
    }

    detalhes.push({
      numero: questaoNum,
      tipo_item: isCE ? "CE" : "ME",
      resposta: respRaw || null,
      correto,
      acertou,
      pontos,
      ...(pontos < 0 ? { penalizada: true } : {}),
      ...(modoCancelada === "bonificar" ? { cancelada: "bonificada" } : {}),
      ...(ajustesMap && ajustesMap[questaoNum] !== undefined ? { ajuste_manual: ajustesMap[questaoNum] } : {}),
    });
  }

  const acertos = detalhes.filter((d) => d.acertou).length;
  const errosPenalizados = detalhes.filter((d) => d.pontos < 0).length;
  const somaPontos = detalhes.reduce((acc, d) => acc + d.pontos, 0);
  const pontosLiquidos = Math.max(0, somaPontos);
  const nota = nQ > 0 ? parseFloat((pontosLiquidos * valorQuestao).toFixed(2)) : 0;

  let acertosPorDisciplina = null;
  if (Array.isArray(disciplinasConfig) && disciplinasConfig.length > 0) {
    acertosPorDisciplina = disciplinasConfig.map((dc) => {
      const questoesDc = detalhes.filter((d) => d.numero >= dc.de && d.numero <= dc.ate);
      const acertosDc = questoesDc.filter((d) => d.acertou).length;
      const penalidadesDc = questoesDc.filter((d) => d.pontos < 0).length;
      const liquidosDc = Math.max(0, questoesDc.reduce((s, d) => s + d.pontos, 0));
      return {
        nome: dc.nome,
        disciplina_id: dc.disciplina_id,
        de: dc.de,
        ate: dc.ate,
        total: questoesDc.length,
        acertos: acertosDc,
        ...(penalidadeAtiva ? { penalidades: penalidadesDc, pontos_liquidos: liquidosDc } : {}),
      };
    });
  }

  return {
    formato,
    penalidadeAtiva,
    acertos,
    errosPenalizados,
    pontosLiquidos,
    numQuestoesEfetivas,
    valorQuestao,
    nota,
    notaTotal: maxNota,
    detalhes,
    acertosPorDisciplina,
  };
}
