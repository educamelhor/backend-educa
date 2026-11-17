// modules/questoes-ai/catalogoEscolaQuestoes.js
// EDUCA.PROVA / EDUCA.STUDIO AI — Catálogo Dinâmico de Disciplinas, Séries e Turmas por Escola
// Consulta em tempo real as tabelas `turmas`, `disciplinas`, `modulacao`, `planos_avaliacao` e `questoes`
// da escola logada (`escola_id`), eliminando listas estáticas desconectadas da realidade escolar.

import pool from '../../db.js';

export const DISCIPLINAS_PADRAO_EF = [
  'Português',
  'Redação',
  'Inglês',
  'Espanhol',
  'Artes',
  'Educação Física',
  'Matemática',
  'Ciências',
  'História',
  'Geografia',
  'Ensino Religioso',
  'PD',
];

export const DISCIPLINAS_PADRAO_EM = [
  'Português',
  'Redação',
  'Inglês',
  'Espanhol',
  'Artes',
  'Educação Física',
  'Matemática',
  'Biologia',
  'Física',
  'Química',
  'História',
  'Geografia',
  'Filosofia',
  'Sociologia',
  'PCA',
  'Projeto de Vida',
];

export const SERIES_PADRAO_EF = [
  '6º Ano EF',
  '7º Ano EF',
  '8º Ano EF',
  '9º Ano EF',
];

export const SERIES_PADRAO_EM = [
  '1ª Série EM',
  '2ª Série EM',
  '3ª Série EM',
];

export const DISCIPLINAS_CATALOGO_GLOBAL = [
  'Português',
  'Redação',
  'Inglês',
  'Espanhol',
  'Artes',
  'Educação Física',
  'Matemática',
  'Geometria',
  'Ciências',
  'Biologia',
  'Física',
  'Química',
  'História',
  'Geografia',
  'Filosofia',
  'Sociologia',
  'Ensino Religioso',
  'Projeto de Vida',
  'PCA',
  'PD',
  'PD1',
  'PD2',
  'PD3',
];

export const SERIES_CATALOGO_GLOBAL = [
  ...SERIES_PADRAO_EF,
  ...SERIES_PADRAO_EM,
];

const ORDEM_PEDAGOGICA_DISCIPLINAS = [
  'Português',
  'Redação',
  'Inglês',
  'Espanhol',
  'Francês',
  'Artes',
  'Educação Física',
  'Matemática',
  'Geometria',
  'Ciências',
  'Biologia',
  'Física',
  'Química',
  'História',
  'Geografia',
  'Filosofia',
  'Sociologia',
  'Ensino Religioso',
  'Projeto de Vida',
  'PCA',
  'PD',
  'PD1',
  'PD2',
  'PD3',
];

// Códigos internos de grade horária/Urânia (ex: "IFA_ADRIANO", "IFA_DÉBORA_1ºB", "ELETIVA_JOAO")
// que representam slots de professores e não devem poluir o seletor de disciplinas de questões.
const REGEX_SLOT_INTERNO_HORARIO = /^(?:IFA|ELETIVA|PROJETO|AGRUP(?:AMENTO)?|TURMA|OFICINA)_+[A-ZÀ-Ú0-9]/i;

const PREPOSICOES_MINUSCULAS = new Set([
  'de', 'da', 'do', 'das', 'dos', 'e', 'em', 'na', 'no', 'nas', 'nos',
  'para', 'por', 'com', 'sem', 'sob', 'sobre', 'a', 'as', 'o', 'os', 'ao', 'aos', 'à', 'às',
]);

const SIGLAS_MAIUSCULAS = new Set([
  'IFA', 'PCA', 'PD', 'PD1', 'PD2', 'PD3', 'PV', 'EJA', 'TI', 'IA',
  'BNCC', 'ENEM', 'PAS', 'UNB', 'SEEDF', 'CCMDF', 'LEM', 'LP', 'LIBRAS',
  'I', 'II', 'III', 'IV', 'V', 'VI',
]);

export function normChave(valor = '') {
  return String(valor || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const MAPA_CANONICO_DISCIPLINAS = new Map([
  ['PORTUGUES', 'Português'],
  ['LINGUA PORTUGUESA', 'Português'],
  ['L PORTUGUESA', 'Português'],
  ['PORTUGUESA', 'Português'],
  ['LP', 'Português'],
  ['REDACAO', 'Redação'],
  ['PRODUCAO DE TEXTO', 'Redação'],
  ['PRODUCAO TEXTUAL', 'Redação'],
  ['MATEMATICA', 'Matemática'],
  ['MAT', 'Matemática'],
  ['GEOMETRIA', 'Geometria'],
  ['CIENCIAS', 'Ciências'],
  ['CIENCIAS NATURAIS', 'Ciências'],
  ['CIENCIA', 'Ciências'],
  ['HISTORIA', 'História'],
  ['GEOGRAFIA', 'Geografia'],
  ['INGLES', 'Inglês'],
  ['LEM INGLES', 'Inglês'],
  ['LINGUA INGLESA', 'Inglês'],
  ['LINGUA ESTRANGEIRA INGLES', 'Inglês'],
  ['ESPANHOL', 'Espanhol'],
  ['LEM ESPANHOL', 'Espanhol'],
  ['LINGUA ESPANHOLA', 'Espanhol'],
  ['LINGUA ESTRANGEIRA ESPANHOL', 'Espanhol'],
  ['FRANCES', 'Francês'],
  ['LEM FRANCES', 'Francês'],
  ['LINGUA FRANCESA', 'Francês'],
  ['ARTES', 'Artes'],
  ['ARTE', 'Artes'],
  ['EDUCACAO FISICA', 'Educação Física'],
  ['ED FISICA', 'Educação Física'],
  ['ENSINO RELIGIOSO', 'Ensino Religioso'],
  ['BIOLOGIA', 'Biologia'],
  ['FISICA', 'Física'],
  ['QUIMICA', 'Química'],
  ['SOCIOLOGIA', 'Sociologia'],
  ['FILOSOFIA', 'Filosofia'],
  ['PROJETO DE VIDA', 'Projeto de Vida'],
  ['PCA', 'PCA'],
  ['PERCURSO COMUM DE APROFUNDAMENTO', 'PCA'],
  ['PD', 'PD'],
  ['PARTE DIVERSIFICADA', 'PD'],
  ['PD1', 'PD1'],
  ['PD 1', 'PD1'],
  ['PD I', 'PD1'],
  ['PARTE DIVERSIFICADA I', 'PD1'],
  ['PARTE DIVERSIFICADA 1', 'PD1'],
  ['PRATICA DIVERSIFICADA I', 'PD1'],
  ['PRATICA DIVERSIFICADA 1', 'PD1'],
  ['PD2', 'PD2'],
  ['PD 2', 'PD2'],
  ['PD II', 'PD2'],
  ['PARTE DIVERSIFICADA II', 'PD2'],
  ['PARTE DIVERSIFICADA 2', 'PD2'],
  ['PRATICA DIVERSIFICADA II', 'PD2'],
  ['PRATICA DIVERSIFICADA 2', 'PD2'],
  ['PD3', 'PD3'],
  ['PD 3', 'PD3'],
  ['PD III', 'PD3'],
  ['PARTE DIVERSIFICADA III', 'PD3'],
  ['PARTE DIVERSIFICADA 3', 'PD3'],
  ['PRATICA DIVERSIFICADA III', 'PD3'],
  ['PRATICA DIVERSIFICADA 3', 'PD3'],
]);

function capitalizarTituloPortugues(texto = '') {
  const limpo = String(texto || '').replace(/\s+/g, ' ').trim();
  if (!limpo) return '';

  // Se já possui letras minúsculas misturadas com maiúsculas, preserva a grafia da escola
  const temMinuscula = /[a-zà-ú]/.test(limpo);
  if (temMinuscula) return limpo;

  return limpo
    .split(' ')
    .map((palavra, idx) => {
      const semPontuacao = normChave(palavra);
      if (SIGLAS_MAIUSCULAS.has(semPontuacao)) return palavra.toUpperCase();
      const lower = palavra.toLowerCase();
      if (idx > 0 && PREPOSICOES_MINUSCULAS.has(lower)) return lower;
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(' ');
}

/**
 * Normaliza o nome de uma disciplina cadastrada na escola para exibição limpa e consistente.
 * Retorna `null` para códigos técnicos internos de grade horária (ex: `IFA_ADRIANO`).
 */
export function formatarNomeDisciplinaCatalogo(nomeRaw = '') {
  const txt = String(nomeRaw || '').replace(/\s+/g, ' ').trim();
  if (!txt) return null;
  if (REGEX_SLOT_INTERNO_HORARIO.test(txt)) return null;

  const chave = normChave(txt);
  if (!chave) return null;

  if (MAPA_CANONICO_DISCIPLINAS.has(chave)) {
    return MAPA_CANONICO_DISCIPLINAS.get(chave);
  }

  return capitalizarTituloPortugues(txt);
}

/**
 * Converte `serie` / `nome` / `etapa` de uma turma do BD em rótulo canônico de Série/Ano.
 * Ex:
 * - ("7º ANO", "FUNDAMENTAL") -> "7º Ano EF"
 * - ("1ª SÉRIE", "MÉDIO")     -> "1ª Série EM"
 * - ("2º EM", "")             -> "2ª Série EM"
 */
export function normalizarSerieCatalogo(serieOuTurmaRaw = '', etapaRaw = '') {
  const bruto = String(serieOuTurmaRaw || '').replace(/\s+/g, ' ').trim();
  if (!bruto) return null;

  const chave = normChave(bruto);
  const etapaChave = normChave(etapaRaw);
  const ehMedioExplicito =
    /\b(?:EM|EMI|MEDIO|SERIE)\b/.test(chave) ||
    /\bMEDIO\b/.test(etapaChave) ||
    /^EM[_I\s]/i.test(bruto);

  if (chave === 'ENSINO SUPERIOR' || chave === 'SUPERIOR') {
    return 'Ensino Superior';
  }

  // Ensino Médio: 1ª a 3ª Série (ou 4ª em cursos técnicos integrados)
  const matchMedio = chave.match(/^(?:EM\s*)?([1-4])\s*(?:A|O)?\s*(?:SERIE|ANO\s+EM|EM)\b/);
  if (matchMedio || (ehMedioExplicito && /^[1-4]\b/.test(chave))) {
    const num = matchMedio ? Number(matchMedio[1]) : Number(chave.match(/^([1-4])/)[1]);
    if (num >= 1 && num <= 4) {
      return `${num}ª Série EM`;
    }
  }

  // Ensino Fundamental: 1º ao 9º Ano
  const matchFund = chave.match(/^([1-9])\s*(?:O|A)?\s*ANO(?:\s+EF)?\b/);
  if (matchFund && !ehMedioExplicito) {
    const num = Number(matchFund[1]);
    return `${num}º Ano EF`;
  }

  // Caso o campo traga nome de turma tipo "8º ANO B" ou "1ª SÉRIE C"
  const matchTurmaMedio = bruto.match(/([1-4])[ªº°]?\s*S[ÉE]RIE/i);
  if (matchTurmaMedio) {
    return `${Number(matchTurmaMedio[1])}ª Série EM`;
  }
  const matchTurmaFund = bruto.match(/([1-9])[º°ª]?\s*ANO/i);
  if (matchTurmaFund && !ehMedioExplicito) {
    return `${Number(matchTurmaFund[1])}º Ano EF`;
  }

  // EJA / Segmentos
  if (/\b(?:EJA|SEGMENTO)\b/.test(chave)) {
    return capitalizarTituloPortugues(bruto);
  }

  return capitalizarTituloPortugues(bruto);
}

function pesoOrdemSerie(serie = '') {
  const mEf = String(serie).match(/^([1-9])º Ano EF$/i);
  if (mEf) return Number(mEf[1]);
  const mEm = String(serie).match(/^([1-4])ª Série EM$/i);
  if (mEm) return 10 + Number(mEm[1]);
  if (/EJA|Segmento/i.test(serie)) return 30;
  if (/Superior/i.test(serie)) return 40;
  return 25;
}

export function ordenarSeriesPedagogicamente(lista = []) {
  return [...lista].sort((a, b) => {
    const pa = pesoOrdemSerie(a);
    const pb = pesoOrdemSerie(b);
    if (pa !== pb) return pa - pb;
    return String(a).localeCompare(String(b), 'pt-BR', { numeric: true });
  });
}

export function ordenarDisciplinasPedagogicamente(lista = []) {
  return [...lista].sort((a, b) => {
    const ia = ORDEM_PEDAGOGICA_DISCIPLINAS.indexOf(a);
    const ib = ORDEM_PEDAGOGICA_DISCIPLINAS.indexOf(b);
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    return String(a).localeCompare(String(b), 'pt-BR', { sensitivity: 'base' });
  });
}

/**
 * Expande aliases equivalentes de série para filtros SQL (`q.serie IN (...)`),
 * garantindo compatibilidade retroativa entre `"1ª Série EM"`, `"1º EM"`, `"1º Ano EM"`, `"8º Ano EF"`, `"8º ANO"`, etc.
 */
export function expandirAliasesSerieFiltro(serieFiltro = '') {
  const raw = String(serieFiltro || '').trim();
  if (!raw) return [];

  const canon = normalizarSerieCatalogo(raw) || raw;
  const variantes = new Set([raw, canon]);

  const mEm = canon.match(/^([1-4])ª Série EM$/i);
  if (mEm) {
    const n = mEm[1];
    variantes.add(`${n}ª Série EM`);
    variantes.add(`${n}º EM`);
    variantes.add(`${n}º Ano EM`);
    variantes.add(`${n}ª Série`);
    variantes.add(`${n}ª SÉRIE`);
  }

  const mEf = canon.match(/^([1-9])º Ano EF$/i);
  if (mEf) {
    const n = mEf[1];
    variantes.add(`${n}º Ano EF`);
    variantes.add(`${n}º Ano`);
    variantes.add(`${n}º ANO`);
  }

  return [...variantes];
}

/**
 * Expande aliases equivalentes de disciplina para filtros SQL (`LOWER(TRIM(q.disciplina)) IN (...)`).
 */
export function expandirAliasesDisciplinaFiltro(discFiltro = '') {
  const raw = String(discFiltro || '').trim();
  if (!raw) return [];

  const canon = formatarNomeDisciplinaCatalogo(raw) || raw;
  const chaveCanon = normChave(canon);
  const variantes = new Set([raw.toLowerCase(), canon.toLowerCase()]);

  for (const [aliasNorm, destinoCanon] of MAPA_CANONICO_DISCIPLINAS.entries()) {
    if (normChave(destinoCanon) === chaveCanon) {
      variantes.add(aliasNorm.toLowerCase());
      variantes.add(destinoCanon.toLowerCase());
    }
  }

  if (chaveCanon === 'ESPANHOL') {
    variantes.add('lem/espanhol');
    variantes.add('língua espanhola');
  } else if (chaveCanon === 'INGLES') {
    variantes.add('lem/inglês');
    variantes.add('lem/ingles');
    variantes.add('língua inglesa');
  } else if (chaveCanon === 'PORTUGUES') {
    variantes.add('língua portuguesa');
    variantes.add('lingua portuguesa');
  } else if (chaveCanon === 'EDUCACAO FISICA') {
    variantes.add('ed. física');
    variantes.add('ed. fisica');
  } else if (chaveCanon === 'CIENCIAS') {
    variantes.add('ciências naturais');
  }

  return [...variantes];
}

// ── Cache curto em memória por escola_id (45s) para performance em lotes multi-página ──
const _cacheCatalogoEscola = new Map();
const CACHE_TTL_MS = 45 * 1000;

export function invalidarCacheCatalogoEscola(escolaId) {
  if (escolaId) _cacheCatalogoEscola.delete(Number(escolaId));
  else _cacheCatalogoEscola.clear();
}

/**
 * Constrói o catálogo real de Disciplinas, Itinerários, Séries e Turmas da escola logada.
 */
export async function obterCatalogoEscolaQuestoes(escolaId, { forceRefresh = false } = {}) {
  const idNum = Number(escolaId);
  if (!idNum || Number.isNaN(idNum)) {
    return {
      ok: true,
      escola_id: null,
      escola_nome: '',
      escola_apelido: '',
      ano_letivo: new Date().getFullYear(),
      etapas: ['FUNDAMENTAL', 'MEDIO'],
      origem_disciplinas: 'padrao_global',
      disciplinas: ordenarDisciplinasPedagogicamente(DISCIPLINAS_CATALOGO_GLOBAL),
      itinerarios: [],
      todas_disciplinas: ordenarDisciplinasPedagogicamente(DISCIPLINAS_CATALOGO_GLOBAL),
      series: [...SERIES_CATALOGO_GLOBAL],
      turmas: [],
    };
  }

  if (!forceRefresh) {
    const hit = _cacheCatalogoEscola.get(idNum);
    if (hit && hit.expiraEm > Date.now()) {
      return hit.dados;
    }
  }

  const [
    [escolaRows],
    [turmasRows],
    [discRows],
    [modRows],
    [questoesDiscRows],
  ] = await Promise.all([
    pool.query('SELECT id, nome, apelido FROM escolas WHERE id = ? LIMIT 1', [idNum]).catch(() => [[]]),
    pool.query(
      `SELECT id, nome, serie, etapa, turno, ano
         FROM turmas
        WHERE escola_id = ?
        ORDER BY ano DESC, serie ASC, nome ASC`,
      [idNum]
    ).catch(() => [[]]),
    pool.query(
      `SELECT id, nome, nome_oficial, abreviatura, tipo, modo_oferta, etapa
         FROM disciplinas
        WHERE escola_id = ? AND mesclada_em IS NULL
        ORDER BY nome ASC`,
      [idNum]
    ).catch(() => [[]]),
    pool.query(
      `SELECT DISTINCT d.id, d.nome, d.nome_oficial, d.tipo
         FROM modulacao m
         JOIN disciplinas d ON d.id = m.disciplina_id
        WHERE m.escola_id = ? AND d.mesclada_em IS NULL`,
      [idNum]
    ).catch(() => [[]]),
    pool.query(
      `SELECT DISTINCT disciplina, serie
         FROM questoes
        WHERE escola_id = ? AND status != 'arquivada'`,
      [idNum]
    ).catch(() => [[]]),
  ]);

  const escola = escolaRows?.[0] || {};

  // 1) Filtra turmas do ano letivo mais recente cadastrado na escola
  const anosValidos = (turmasRows || [])
    .map((t) => Number(t.ano) || 0)
    .filter((a) => a > 2000);
  const anoReferencia = anosValidos.length > 0 ? Math.max(...anosValidos) : new Date().getFullYear();

  const turmasAtivas = anosValidos.length > 0
    ? turmasRows.filter((t) => Number(t.ano) === anoReferencia)
    : (turmasRows || []);

  const etapasSet = new Set();
  const seriesMap = new Map();
  const turmasUnicasMap = new Map();

  for (const t of turmasAtivas) {
    const etapaNorm = normChave(t.etapa || '');
    const serieCanon = normalizarSerieCatalogo(t.serie || t.nome, t.etapa);

    if (/\bMEDIO\b/.test(etapaNorm) || (serieCanon && /Série EM$/i.test(serieCanon))) {
      etapasSet.add('MEDIO');
    } else if (/\bFUNDAMENTAL\b/.test(etapaNorm) || (serieCanon && /Ano EF$/i.test(serieCanon))) {
      etapasSet.add('FUNDAMENTAL');
    } else if (/\bEJA\b/.test(etapaNorm)) {
      etapasSet.add('EJA');
    }

    if (serieCanon) {
      const kSerie = normChave(serieCanon);
      if (!seriesMap.has(kSerie)) seriesMap.set(kSerie, serieCanon);
    }

    const nomeTurma = String(t.nome || '').replace(/\s+/g, ' ').trim();
    if (nomeTurma) {
      const kTurma = normChave(nomeTurma);
      if (!turmasUnicasMap.has(kTurma)) {
        turmasUnicasMap.set(kTurma, {
          id: t.id,
          nome: nomeTurma,
          serie: serieCanon || String(t.serie || '').trim(),
          turno: String(t.turno || '').trim(),
          etapa: String(t.etapa || '').trim(),
        });
      }
    }
  }

  // Inclui séries eventualmente já salvas em questões ativas da escola (normalizadas)
  for (const qRow of (questoesDiscRows || [])) {
    if (qRow?.serie) {
      const sc = normalizarSerieCatalogo(qRow.serie);
      if (sc && !seriesMap.has(normChave(sc))) {
        seriesMap.set(normChave(sc), sc);
      }
    }
  }

  let seriesFinais = ordenarSeriesPedagogicamente([...seriesMap.values()]);
  if (seriesFinais.length === 0) {
    if (etapasSet.has('MEDIO') && !etapasSet.has('FUNDAMENTAL')) {
      seriesFinais = [...SERIES_PADRAO_EM];
    } else if (etapasSet.has('FUNDAMENTAL') && !etapasSet.has('MEDIO')) {
      seriesFinais = [...SERIES_PADRAO_EF];
    } else {
      seriesFinais = [...SERIES_CATALOGO_GLOBAL];
    }
  }

  // 2) Constrói lista de disciplinas regulares e itinerários/projetos da escola
  const regularesMap = new Map();
  const itinerariosMap = new Map();

  const registrarDisciplinaRow = (nomeBruto, tipoBruto = 'REGULAR') => {
    const nomeLimpo = formatarNomeDisciplinaCatalogo(nomeBruto);
    if (!nomeLimpo) return;
    const chave = normChave(nomeLimpo);
    if (!chave) return;

    const tipoUp = String(tipoBruto || 'REGULAR').trim().toUpperCase();
    const ehItinerario = ['IFA', 'ELETIVA', 'PROJETO', 'OFICINA', 'TRILHA'].includes(tipoUp);

    if (ehItinerario) {
      if (!regularesMap.has(chave) && !itinerariosMap.has(chave)) {
        itinerariosMap.set(chave, nomeLimpo);
      }
    } else {
      regularesMap.set(chave, nomeLimpo);
      itinerariosMap.delete(chave);
    }
  };

  for (const d of (discRows || [])) {
    registrarDisciplinaRow(d.nome, d.tipo);
  }
  for (const m of (modRows || [])) {
    registrarDisciplinaRow(m.nome, m.tipo);
  }

  let origemDisciplinas = regularesMap.size > 0 || itinerariosMap.size > 0 ? 'banco_escola' : '';

  // Se a escola ainda não cadastrou linhas em `disciplinas`, verifica `planos_avaliacao`
  if (regularesMap.size === 0) {
    const [planosRows] = await pool
      .query(
        `SELECT DISTINCT disciplina
           FROM planos_avaliacao
          WHERE escola_id = ? AND disciplina IS NOT NULL AND TRIM(disciplina) != ''`,
        [idNum]
      )
      .catch(() => [[]]);

    for (const p of (planosRows || [])) {
      registrarDisciplinaRow(p.disciplina, 'REGULAR');
    }
    if (regularesMap.size > 0) {
      origemDisciplinas = 'planos_escola';
    }
  }

  // Também garante qualquer disciplina já utilizada em questões ativas do banco da escola
  for (const qRow of (questoesDiscRows || [])) {
    if (qRow?.disciplina) {
      registrarDisciplinaRow(qRow.disciplina, 'REGULAR');
    }
  }

  // Fallback inteligente derivado das etapas reais das `turmas` da escola quando `disciplinas` está vazia
  if (regularesMap.size === 0) {
    origemDisciplinas = 'etapas_turmas_escola';
    const temFund = etapasSet.has('FUNDAMENTAL');
    const temMedio = etapasSet.has('MEDIO');

    if (temMedio && !temFund) {
      DISCIPLINAS_PADRAO_EM.forEach((d) => registrarDisciplinaRow(d, 'REGULAR'));
    } else if (temFund && !temMedio) {
      DISCIPLINAS_PADRAO_EF.forEach((d) => registrarDisciplinaRow(d, 'REGULAR'));
    } else {
      [...DISCIPLINAS_PADRAO_EF, ...DISCIPLINAS_PADRAO_EM].forEach((d) => registrarDisciplinaRow(d, 'REGULAR'));
    }
  }

  const disciplinasOrdenadas = ordenarDisciplinasPedagogicamente([...regularesMap.values()]);
  const itinerariosOrdenados = [...itinerariosMap.values()].sort((a, b) =>
    a.localeCompare(b, 'pt-BR', { sensitivity: 'base' })
  );
  const todasDisciplinas = [...disciplinasOrdenadas, ...itinerariosOrdenados];

  const turmasOrdenadas = [...turmasUnicasMap.values()].sort((a, b) => {
    const pa = pesoOrdemSerie(a.serie);
    const pb = pesoOrdemSerie(b.serie);
    if (pa !== pb) return pa - pb;
    return a.nome.localeCompare(b.nome, 'pt-BR', { numeric: true });
  });

  const payload = {
    ok: true,
    escola_id: idNum,
    escola_nome: escola.nome || '',
    escola_apelido: escola.apelido || '',
    ano_letivo: anoReferencia,
    etapas: [...etapasSet],
    origem_disciplinas: origemDisciplinas || 'banco_escola',
    disciplinas: disciplinasOrdenadas,
    itinerarios: itinerariosOrdenados,
    todas_disciplinas: todasDisciplinas,
    series: seriesFinais,
    turmas: turmasOrdenadas,
  };

  _cacheCatalogoEscola.set(idNum, {
    expiraEm: Date.now() + CACHE_TTL_MS,
    dados: payload,
  });

  return payload;
}

/**
 * Reconcilia a disciplina sugerida/detectada pela IA com o catálogo real da escola,
 * NUNCA sobrescrevendo uma disciplina escolhida pelo professor (ex: "Espanhol", "Geometria", "PCA") com "Matemática"!
 */
export function resolverDisciplinaCatalogoIA({
  iaDisciplina = '',
  disciplinaSugerida = '',
  disciplinaPredominante = '',
  disciplinasPermitidas = [],
  fallbackVazio = '',
} = {}) {
  const listaEscola = Array.isArray(disciplinasPermitidas) && disciplinasPermitidas.length > 0
    ? disciplinasPermitidas
    : DISCIPLINAS_CATALOGO_GLOBAL;

  const encontrarNaLista = (valorBruto) => {
    const limpo = String(valorBruto || '').trim();
    if (!limpo) return '';
    const chaveBruta = normChave(limpo);
    const formatada = formatarNomeDisciplinaCatalogo(limpo) || limpo;
    const chaveFormatada = normChave(formatada);

    const matchEscola = listaEscola.find((d) => {
      const kd = normChave(d);
      return kd === chaveBruta || kd === chaveFormatada;
    });
    if (matchEscola) return matchEscola;

    const matchGlobal = DISCIPLINAS_CATALOGO_GLOBAL.find((d) => {
      const kd = normChave(d);
      return kd === chaveBruta || kd === chaveFormatada;
    });
    if (matchGlobal) return matchGlobal;

    return formatada;
  };

  // 1) Se o professor selecionou explicitamente a disciplina padrão no modal, respeita 100% a escolha!
  if (String(disciplinaSugerida || '').trim()) {
    return encontrarNaLista(disciplinaSugerida);
  }

  // 2) Caso contrário ("Detectar automaticamente"), prioriza a disciplina detectada na questão pela IA
  if (String(iaDisciplina || '').trim()) {
    const resolvidaIA = encontrarNaLista(iaDisciplina);
    if (resolvidaIA) return resolvidaIA;
  }

  // 3) Fallback para disciplina predominante da folha
  if (String(disciplinaPredominante || '').trim()) {
    const resolvidaPred = encontrarNaLista(disciplinaPredominante);
    if (resolvidaPred) return resolvidaPred;
  }

  return fallbackVazio;
}

/**
 * Reconcilia a série sugerida/detectada pela IA com as séries reais ofertadas pelas turmas da escola.
 */
export function resolverSerieCatalogoIA({
  iaSerie = '',
  serieSugerida = '',
  seriePredominante = '',
  seriesPermitidas = [],
} = {}) {
  const listaSeries = Array.isArray(seriesPermitidas) && seriesPermitidas.length > 0
    ? seriesPermitidas
    : SERIES_CATALOGO_GLOBAL;

  const encontrarSerie = (valorBruto, exigirPertencerAEscola = false) => {
    const limpo = String(valorBruto || '').trim();
    if (!limpo) return '';
    const canon = normalizarSerieCatalogo(limpo) || limpo;
    const kCanon = normChave(canon);
    const kBruto = normChave(limpo);

    const match = listaSeries.find((s) => {
      const ks = normChave(s);
      return ks === kCanon || ks === kBruto;
    });
    if (match) return match;

    return exigirPertencerAEscola ? '' : canon;
  };

  // 1) Se o professor selecionou explicitamente a série padrão no modal, preserva integralmente!
  if (String(serieSugerida || '').trim()) {
    return encontrarSerie(serieSugerida, false);
  }

  // 2) Série detectada pela IA (validada contra as séries reais ofertadas pela escola)
  if (String(iaSerie || '').trim()) {
    const s = encontrarSerie(iaSerie, true);
    if (s) return s;
  }

  if (String(seriePredominante || '').trim()) {
    const sp = encontrarSerie(seriePredominante, true);
    if (sp) return sp;
  }

  return '';
}
