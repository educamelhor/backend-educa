// modules/questoes-ai/sheetSplitter.agent.js
// EDUCA.STUDIO AI — Fase 2: Importador Inteligente de Listas, Páginas e PDFs
// Individualiza páginas inteiras de provas/listas (1 ou 2 colunas, PDF renderizado ou foto)
// e listas em texto bruto nos 7 modelos universais, vinculando textos de apoio compartilhados,
// recortando figuras independentes no DO Spaces e resolvendo o gabarito passo a passo.

import { SchemaType } from '@google/generative-ai';
import { processarMidiaQuestao, publicarPaginaOriginalLista } from './smartMediaEngine.js';
import {
  DISCIPLINAS_OFICIAIS,
  SERIES_OFICIAIS,
  gerarJsonComFailover,
  sanitizarObjetoIA,
  bboxIoU,
  montarEstruturaInicialExtraida,
  limparFonteFalsaCaderno,
  deduplicarTextoApoioEnunciado,
  normalizarLetraAlternativa,
  reconciliarGabaritoQuestao,
  ehFiguraNaoGraficaIgnorada,
  extrairAlternativasEmbutidasEmTexto,
  questaoExigeAlternativasVisiveis,
  resgatarAlternativasOmitidasDaImagem,
} from './visionExtractor.agent.js';

const TIPOS_VALIDOS = [
  'objetiva',
  'afirmativas',
  'verdadeiro_falso',
  'associacao',
  'lacuna',
  'discursiva',
  'somatoria',
];

function clampNorm(v, min = 0, max = 1000) {
  const n = Number(v);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function limparCabecalhoTextoCompartilhado(txt = '') {
  return String(txt || '')
    .replace(/^\s*(?:leia|considere|analise|utilize)\s+o\s+texto\s+(?:a\s+seguir|abaixo)\s+para\s+responder\s+[àa]s?\s+quest[õo]es\s+[^\n.:]+[:.]?\s*/i, '')
    .replace(/^\s*texto\s+(?:base\s+)?para\s+as?\s+quest[õo]es\s+[^\n.:]+[:.]?\s*/i, '')
    .trim();
}

// ── Schema enxuto e de baixa profundidade de estado para suportar até 10 questões por página no Gemini ──
const QUESTAO_ITEM_SCHEMA = {
  type: SchemaType.OBJECT,
  properties: {
    numero_original: {
      type: SchemaType.STRING,
      description: 'Número impresso da questão na prova/lista (ex: "01", "2", "Questão 15"). Vazio se sem número.',
    },
    questao_bbox: {
      type: SchemaType.ARRAY,
      items: { type: SchemaType.INTEGER },
      description: 'Bounding box [ymin, xmin, ymax, xmax] (0 a 1000) englobando a região visual desta questão na página.',
    },
    id_texto_apoio_vinculado: {
      type: SchemaType.STRING,
      description: 'ID do texto compartilhado (ex: "T1") caso esta questão dependa de um texto comum da página. Vazio se não houver.',
    },
    usa_texto_pagina_anterior: {
      type: SchemaType.BOOLEAN,
      description: 'true APENAS se a questão mencionar explicitamente um texto base vindo da página anterior.',
    },
    tipo: {
      type: SchemaType.STRING,
      description: 'objetiva | afirmativas | verdadeiro_falso | associacao | lacuna | discursiva | somatoria',
    },
    disciplina: { type: SchemaType.STRING },
    serie: { type: SchemaType.STRING },
    nivel: { type: SchemaType.STRING, description: 'facil | medio | dificil | enem' },
    fonte: { type: SchemaType.STRING },
    fonte_confirmada: { type: SchemaType.BOOLEAN },
    habilidade_bncc: { type: SchemaType.STRING },
    temas: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
    tags: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
    texto_apoio: {
      type: SchemaType.STRING,
      description: 'Texto de apoio exclusivo desta questão (se não for um texto compartilhado em textos_apoio_compartilhados).',
    },
    enunciado: { type: SchemaType.STRING },
    comando_final: { type: SchemaType.STRING },
    figuras: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          alvo: { type: SchemaType.STRING, description: 'principal | alt_A | alt_B | alt_C | alt_D | alt_E' },
          natureza_visual: {
            type: SchemaType.STRING,
            description: 'grafico_cartesiano | geometria_desenho | esquema_cientifico | estrutura_quimica_2d | tirinha_charge_mapa | tabela_visual | equacao_puramente_tipografica',
          },
          ordem: { type: SchemaType.INTEGER },
          coluna: { type: SchemaType.STRING, description: 'unica | esquerda | direita' },
          continuacao_quebra_coluna: { type: SchemaType.BOOLEAN },
          bbox: { type: SchemaType.ARRAY, items: { type: SchemaType.INTEGER } },
          posicao_sugerida: { type: SchemaType.STRING },
          legenda_original: { type: SchemaType.STRING },
          foto_papel_cinza: { type: SchemaType.BOOLEAN },
        },
        required: ['alvo', 'natureza_visual', 'bbox'],
      },
    },
    proposicoes_romanas: {
      type: SchemaType.ARRAY,
      description: 'Proposições em algarismos romanos (I, II, III, IV...) quando tipo = afirmativas.',
      items: {
        type: SchemaType.OBJECT,
        properties: {
          romano: { type: SchemaType.STRING },
          texto: { type: SchemaType.STRING },
          correta: { type: SchemaType.BOOLEAN },
        },
        required: ['romano', 'texto', 'correta'],
      },
    },
    comando_fechamento_afirmativas: {
      type: SchemaType.STRING,
      description: 'Frase imediatamente antes das opções A–E em tipo = afirmativas (ex: "Está correto apenas o que se afirma em:", "Estão corretas:").',
    },
    vf_submodo: { type: SchemaType.STRING },
    vf_rotulo: { type: SchemaType.STRING },
    itens_vf: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          texto: { type: SchemaType.STRING },
          gabarito: { type: SchemaType.STRING },
        },
        required: ['texto', 'gabarito'],
      },
    },
    assoc_submodo: { type: SchemaType.STRING },
    coluna_a: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          codigo: { type: SchemaType.STRING },
          texto: { type: SchemaType.STRING },
        },
        required: ['codigo', 'texto'],
      },
    },
    coluna_b: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          texto: { type: SchemaType.STRING },
          vinculo_codigo: { type: SchemaType.STRING },
        },
        required: ['texto', 'vinculo_codigo'],
      },
    },
    lacuna_submodo: { type: SchemaType.STRING },
    texto_lacunado: { type: SchemaType.STRING },
    distratores_banco: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
    proposicoes_somatoria: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          valor: { type: SchemaType.INTEGER },
          codigo: { type: SchemaType.STRING },
          texto: { type: SchemaType.STRING },
          correta: { type: SchemaType.BOOLEAN },
        },
        required: ['valor', 'codigo', 'texto', 'correta'],
      },
    },
    soma_correta: { type: SchemaType.INTEGER },
    alternativas: {
      type: SchemaType.ARRAY,
      description: 'Lista OBRIGATÓRIA de todas as alternativas impressas (A, B, C, D, E) em TODAS as questões dos tipos "objetiva", "afirmativas" (ex: "I e II.", "apenas I, II e III."), "verdadeiro_falso" em sequência e "associacao" em sequência. Retorne [] APENAS quando não existirem letras A–E na questão (ex: discursiva ou somatória).',
      items: {
        type: SchemaType.OBJECT,
        properties: {
          letra: { type: SchemaType.STRING },
          texto: { type: SchemaType.STRING },
        },
        required: ['letra', 'texto'],
      },
    },
    formato_espaco_discursiva: { type: SchemaType.STRING },
    linhas_resposta_sugeridas: { type: SchemaType.INTEGER },
    resposta_aberta: { type: SchemaType.STRING },
    questao_incompleta_fim_pagina: {
      type: SchemaType.BOOLEAN,
      description: 'true APENAS se esta questão no fim da página estiver cortada/incompleta porque suas demais alternativas continuam na próxima página.',
    },
    gabarito_letra: { type: SchemaType.STRING },
    gabarito_origem: {
      type: SchemaType.STRING,
      description: 'marcado_na_imagem | resolvido_pela_ia',
    },
    resolucao_passo_a_passo: { type: SchemaType.STRING },
    confianca: { type: SchemaType.STRING, description: 'alta | media | baixa' },
  },
  required: [
    'numero_original',
    'tipo',
    'disciplina',
    'nivel',
    'temas',
    'enunciado',
    'alternativas',
    'gabarito_origem',
    'resolucao_passo_a_passo',
    'confianca',
  ],
};

const SHEET_EXTRACTION_SCHEMA = {
  type: SchemaType.OBJECT,
  properties: {
    layout_pagina: {
      type: SchemaType.STRING,
      description: 'coluna_unica | duas_colunas',
    },
    coluna_divisao_x: {
      type: SchemaType.INTEGER,
      description: 'Coordenada X (0 a 1000) do corredor vertical entre as colunas quando layout_pagina = duas_colunas (0 se coluna_unica).',
    },
    disciplina_predominante: { type: SchemaType.STRING },
    serie_predominante: { type: SchemaType.STRING },
    fonte_geral: { type: SchemaType.STRING },
    continuacao_questao_anterior: {
      type: SchemaType.OBJECT,
      description: 'Fragmentos órfãos no TOPO desta página (antes da 1ª questão numerada) que continuam a última questão da página anterior (ex: alternativas B, C, D).',
      properties: {
        possui_continuacao: { type: SchemaType.BOOLEAN },
        texto_complementar: { type: SchemaType.STRING },
        comando_final: { type: SchemaType.STRING },
        alternativas: {
          type: SchemaType.ARRAY,
          items: {
            type: SchemaType.OBJECT,
            properties: {
              letra: { type: SchemaType.STRING },
              texto: { type: SchemaType.STRING },
            },
            required: ['letra', 'texto'],
          },
        },
        proposicoes_romanas: {
          type: SchemaType.ARRAY,
          items: {
            type: SchemaType.OBJECT,
            properties: {
              romano: { type: SchemaType.STRING },
              texto: { type: SchemaType.STRING },
              correta: { type: SchemaType.BOOLEAN },
            },
            required: ['romano', 'texto', 'correta'],
          },
        },
      },
      required: ['possui_continuacao'],
    },
    textos_apoio_compartilhados: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          id_texto: { type: SchemaType.STRING, description: 'Ex: T1, T2' },
          alcance_questoes: { type: SchemaType.STRING, description: 'Ex: "1 a 3"' },
          conteudo: { type: SchemaType.STRING },
        },
        required: ['id_texto', 'conteudo'],
      },
    },
    questoes: {
      type: SchemaType.ARRAY,
      items: QUESTAO_ITEM_SCHEMA,
    },
  },
  required: ['layout_pagina', 'coluna_divisao_x', 'textos_apoio_compartilhados', 'questoes'],
};

function normalizarContinuacaoQuestaoAnterior(rawCont) {
  if (!rawCont || typeof rawCont !== 'object') return null;
  const altsRaw = Array.isArray(rawCont.alternativas) ? rawCont.alternativas : [];
  const alternativas = altsRaw
    .map((a, idx) => ({
      letra: normalizarLetraAlternativa(a?.letra, idx + 1),
      texto: String(a?.texto || '').trim(),
    }))
    .filter((a) => a.texto);

  const propsRaw = Array.isArray(rawCont.proposicoes_romanas) ? rawCont.proposicoes_romanas : [];
  const proposicoes_romanas = propsRaw
    .map((p, idx) => ({
      romano: String(p?.romano || ['I', 'II', 'III', 'IV', 'V'][idx] || '').trim(),
      texto: String(p?.texto || '').trim(),
      correta: Boolean(p?.correta),
    }))
    .filter((p) => p.texto);

  const texto_complementar = String(rawCont.texto_complementar || '').trim();
  const comando_final = String(rawCont.comando_final || '').trim();

  const temConteudoReal =
    alternativas.length > 0 ||
    proposicoes_romanas.length > 0 ||
    Boolean(texto_complementar) ||
    Boolean(comando_final);

  if (!temConteudoReal) return null;

  return {
    possui_continuacao: true,
    texto_complementar,
    comando_final,
    alternativas,
    proposicoes_romanas,
  };
}

/**
 * Ordena geometricamente os itens brutos quando a folha tem 2 colunas,
 * corrigindo leituras em "Z" da IA (ex: 18, 20, 19, 21 -> 18, 19, [muro], 20, 21, [pirâmide]).
 */
function ordenarQuestoesBrutasGeometricamente(questoesBrutas = [], layoutPagina = 'coluna_unica', colunaDivisaoX = 0) {
  if (layoutPagina !== 'duas_colunas' || colunaDivisaoX <= 0 || questoesBrutas.length < 2) {
    return questoesBrutas;
  }

  const extrairCaixa = (q) => {
    if (Array.isArray(q?.questao_bbox) && q.questao_bbox.length === 4) {
      const [y1, x1, y2, x2] = q.questao_bbox.map(Number);
      if (Number.isFinite(y1) && Number.isFinite(x1) && Number.isFinite(y2) && Number.isFinite(x2) && y2 > y1 && x2 > x1) {
        return [y1, x1, y2, x2];
      }
    }
    const fig0 = Array.isArray(q?.figuras) ? q.figuras[0] : null;
    if (Array.isArray(fig0?.bbox) && fig0.bbox.length === 4) {
      const [fy1, fx1, fy2, fx2] = fig0.bbox.map(Number);
      if (Number.isFinite(fy1) && Number.isFinite(fx1) && Number.isFinite(fy2) && Number.isFinite(fx2) && fy2 > fy1 && fx2 > fx1) {
        return [fy1, fx1, fy2, fx2];
      }
    }
    return null;
  };

  const enriquecidas = questoesBrutas.map((q, origIdx) => {
    const box = extrairCaixa(q);
    if (!box) return { q, origIdx, hasBox: false, colGroup: 9, yTop: origIdx * 1000 };
    const [y1, x1, , x2] = box;
    const cx = (x1 + x2) / 2;
    const atravessaColunas = x1 < colunaDivisaoX - 70 && x2 > colunaDivisaoX + 70;
    // colGroup: 0 = coluna esquerda pura | 1 = transição col. esq -> topo col. dir | 2 = coluna direita pura
    const colGroup = atravessaColunas ? 1 : (cx < colunaDivisaoX ? 0 : 2);
    return { q, origIdx, hasBox: true, colGroup, yTop: y1 };
  });

  if (!enriquecidas.every((it) => it.hasBox)) {
    return questoesBrutas;
  }

  enriquecidas.sort((a, b) => {
    if (a.colGroup !== b.colGroup) return a.colGroup - b.colGroup;
    if (Math.abs(a.yTop - b.yTop) > 12) return a.yTop - b.yTop;
    return a.origIdx - b.origIdx;
  });

  return enriquecidas.map((it) => it.q);
}

/**
 * Normaliza um item bruto da lista extraída para o formato canônico do EDUCA.STUDIO AI.
 */
function normalizarQuestaoIndividualizada({
  qRaw: qRawEntrada,
  idx,
  mapaTextosCompartilhados,
  ultimoTextoApoio,
  disciplinaFallback,
  serieFallback,
  layoutPagina,
  paginaOriginalUrl,
  paginaNumero,
  midiaPrincipal = null,
  midiasAlternativas = {},
  modeloUsado = '',
}) {
  const qRaw = extrairAlternativasEmbutidasEmTexto(qRawEntrada || {});
  const tipo = TIPOS_VALIDOS.includes(qRaw.tipo) ? qRaw.tipo : 'objetiva';

  // Resolve texto de apoio (compartilhado na página > próprio da questão > herdado da página anterior)
  const idVinc = String(qRaw.id_texto_apoio_vinculado || '').trim();
  const temIdCompartilhado = Boolean(idVinc && mapaTextosCompartilhados.has(idVinc));
  let textoApoioCandidato = String(qRaw.texto_apoio || '').trim();
  if (temIdCompartilhado) {
    const compartilhado = mapaTextosCompartilhados.get(idVinc);
    textoApoioCandidato = textoApoioCandidato
      ? `${compartilhado}\n\n${textoApoioCandidato}`
      : compartilhado;
  } else if (!textoApoioCandidato && qRaw.usa_texto_pagina_anterior && ultimoTextoApoio) {
    textoApoioCandidato = limparCabecalhoTextoCompartilhado(ultimoTextoApoio);
  }

  const discCandidata = qRaw.disciplina || disciplinaFallback || '';
  const disciplina = DISCIPLINAS_OFICIAIS.includes(discCandidata)
    ? discCandidata
    : (DISCIPLINAS_OFICIAIS.includes(disciplinaFallback) ? disciplinaFallback : 'Matemática');

  const serieCandidata = qRaw.serie || serieFallback || '';
  const serie = SERIES_OFICIAIS.includes(serieCandidata)
    ? serieCandidata
    : (SERIES_OFICIAIS.includes(serieFallback) ? serieFallback : '');

  const nivel = ['facil', 'medio', 'dificil', 'enem'].includes(qRaw.nivel) ? qRaw.nivel : 'medio';
  // Usa estritamente a fonte específica da questão (sem herdar fonte_geral de outra questão nem cabeçalhos de caderno)
  const fonte = limparFonteFalsaCaderno(qRaw.fonte);

  const temasExtraidos = Array.isArray(qRaw.temas) ? qRaw.temas.map((t) => String(t || '').trim()).filter(Boolean).slice(0, 5) : [];
  const temas = temasExtraidos.length > 0 ? temasExtraidos : [disciplina];
  const tags = Array.isArray(qRaw.tags) ? qRaw.tags.map((t) => String(t || '').trim()).filter(Boolean).slice(0, 6) : [];

  const enunciadoBruto = tipo === 'lacuna' && qRaw.texto_lacunado ? qRaw.texto_lacunado : (qRaw.enunciado || '');
  const { textoApoio: textoApoioFinal, enunciado: enunciadoFinal } = deduplicarTextoApoioEnunciado(
    textoApoioCandidato,
    enunciadoBruto,
    { temIdCompartilhado, fonteLimpa: fonte }
  );

  const estrutura = montarEstruturaInicialExtraida(tipo, qRaw);

  const baseTs = Date.now() + idx * 20;
  const alternativasBase = Array.isArray(qRaw.alternativas)
    ? qRaw.alternativas.map((a, aIdx) => {
        const letra = normalizarLetraAlternativa(a.letra, aIdx);
        return {
          id: baseTs + aIdx,
          letra,
          texto: String(a.texto || '').trim(),
          imagem_url: midiasAlternativas[letra] || null,
          correta: false,
        };
      })
    : [];

  const incompletaFimPagina = Boolean(qRaw.questao_incompleta_fim_pagina);
  const { gabarito: gabaritoReconciliado, alternativas } = reconciliarGabaritoQuestao({
    tipo,
    estrutura,
    alternativas: alternativasBase,
    gabaritoLetraBruto: incompletaFimPagina && alternativasBase.length < 3 ? '' : qRaw.gabarito_letra,
    explicacao: incompletaFimPagina && alternativasBase.length < 3 ? '' : qRaw.resolucao_passo_a_passo,
    comandoContexto: `${enunciadoFinal} ${qRaw.comando_final || ''}`,
  });

  let questaoBbox = null;
  if (Array.isArray(qRaw.questao_bbox) && qRaw.questao_bbox.length === 4) {
    const [y1, x1, y2, x2] = qRaw.questao_bbox.map((v) => clampNorm(v, 0, 1000));
    if (y2 - y1 >= 25 && x2 - x1 >= 40) {
      questaoBbox = [y1, x1, y2, x2];
    }
  }

  return {
    id_fila: `fila_p${paginaNumero || 1}_q${idx + 1}_${Math.random().toString(36).slice(2, 7)}`,
    pagina_origem: Number(paginaNumero) || 1,
    pagina_original_url: paginaOriginalUrl || null,
    numero_original: String(qRaw.numero_original || `${idx + 1}`).trim(),
    questao_bbox: questaoBbox,
    questao_incompleta_fim_pagina: incompletaFimPagina,
    modelo_ia: modeloUsado,
    layout_origem: layoutPagina,
    tipo,
    disciplina,
    serie,
    nivel,
    fonte,
    fonte_confirmada: Boolean(fonte && qRaw.fonte_confirmada),
    habilidade_bncc: String(qRaw.habilidade_bncc || '').toUpperCase().trim(),
    temas,
    tags,
    texto_apoio: textoApoioFinal,
    enunciado: enunciadoFinal,
    comando_final: qRaw.comando_final || '',
    alternativas,
    estrutura_json: estrutura,
    midia: midiaPrincipal,
    imagem_url: midiaPrincipal?.url || null,
    resposta_aberta: qRaw.resposta_aberta || '',
    gabarito: gabaritoReconciliado,
    gabarito_origem: qRaw.gabarito_origem === 'marcado_na_imagem' ? 'marcado_na_imagem' : 'resolvido_pela_ia',
    explicacao: qRaw.resolucao_passo_a_passo || '',
    confianca: ['alta', 'media', 'baixa'].includes(qRaw.confianca) ? qRaw.confianca : 'alta',
  };
}

/**
 * Extrai TODAS as questões presentes em uma página (PDF renderizado em alta definição ou foto de prova/lista),
 * recortando as figuras individuais de cada questão no DO Spaces.
 */
export async function extrairListaDePaginaMultimodal(fileBuffer, mimeType, opcoes = {}) {
  const {
    disciplinaSugerida = '',
    serieSugerida = '',
    paginaNumero = 1,
    ultimoTextoApoio = '',
    onProgress = null,
  } = opcoes || {};

  const report = (msg) => {
    if (typeof onProgress === 'function') {
      try { onProgress(msg); } catch { /* ignore */ }
    }
  };

  const contextoHints = [
    disciplinaSugerida ? `- Disciplina informada pelo professor (use como padrão caso a questão não seja claramente de outra área): "${disciplinaSugerida}".` : '',
    serieSugerida ? `- Série escolar informada pelo professor: "${serieSugerida}".` : '',
    ultimoTextoApoio
      ? `- Último texto de apoio da página anterior (caso a 1ª questão desta página continue referenciando-o sem repeti-lo, marque usa_texto_pagina_anterior=true): """${String(ultimoTextoApoio).slice(0, 1200)}"""`
      : '',
  ].filter(Boolean).join('\n');

  const prompt = `Você é o Agente Individualizador de Provas e Listas do EDUCA.STUDIO AI.
Analise esta PÁGINA INTEIRA de prova/lista de exercícios (Página ${paginaNumero}) e INDIVIDUALIZE TODAS as questões visíveis com fidelidade editorial absoluta:

1. DIAGRAMAÇÃO DA PÁGINA, ORDEM DE COLUNAS E QUESTÕES PARTIDAS ENTRE PÁGINAS:
   - Se a folha estiver diagramada em 2 colunas lado a lado (padrão ENEM, vestibulares, apostilas), defina layout_pagina="duas_colunas" e informe em "coluna_divisao_x" o X (0..1000, ex: 495) do corredor branco vertical central.
   - Em duas_colunas, leia ESTRITAMENTE: 1º toda a coluna da esquerda (de cima até embaixo), depois 2º toda a coluna da direita (de cima até embaixo). NUNCA alterne esquerda-direita em zigue-zague ("Z")!
   - Se uma mesma questão começar no fim da coluna esquerda e terminar no topo da coluna direita da MESMA página, UNIFIQUE-A em um único item de "questoes"!
   - CONTINUAÇÃO NO TOPO DESTA PÁGINA ("continuacao_questao_anterior"):
     * Se logo no TOPO da página (tipicamente no alto da coluna esquerda, ANTES da primeira questão numerada desta página) houver alternativas órfãs (ex: "b) ...", "c) ...", "d) ..." ou "B)", "C)", "D)", "E)"), proposições romanas finais ou pergunta final pertencentes à última questão da página anterior, capture TODAS elas em "continuacao_questao_anterior" com "possui_continuacao": true!
     * NUNCA ignore nem descarte alternativas órfãs do topo da página e NUNCA crie um item falso em "questoes" para elas! Se não houver continuação órfã no topo, retorne "continuacao_questao_anterior": { "possui_continuacao": false }.
   - QUESTÃO CORTADA NO RODAPÉ DA PÁGINA ("questao_incompleta_fim_pagina"):
     * Se a última questão desta página terminar cortada no fim da página (por exemplo: traz apenas o enunciado ou apenas a alternativa "(a)", porque "(b), (c), (d)" estão na página seguinte), extraia SOMENTE as alternativas literalmente impressas nesta imagem, marque "questao_incompleta_fim_pagina": true e PROIBIDO INVENTAR, COMPLETAR OU REESCREVER ALTERNATIVAS FALTANTES! O sistema unirá automaticamente as alternativas reais vindas da próxima página.
   - ATENÇÃO CRÍTICA A CHAMADAS DE IMAGEM/TEXTO NO FIM DE COLUNA OU DE PÁGINA:
     * Se no final da coluna esquerda houver uma chamada introdutória (ex: "Observe a imagem do muro... e responda à questão a seguir", "Analise o gráfico:") acompanhada de figura/texto SEM alternativas próprias, VINCULE essa figura e esse texto diretamente à questão que começa no topo da coluna direita! NUNCA crie uma questão falsa/vazia para uma chamada "Observe a imagem"!
     * Se no final da coluna direita (rodapé da página) houver uma chamada "Observe a imagem:" + figura/texto cuja pergunta só aparecerá na PRÓXIMA página, retorne-a com numero_original="PENDENTE_PROXIMA_PAGINA" para que o sistema a anexe automaticamente à 1ª questão da página seguinte!
   - Ignore cabeçalhos institucionais da escola e cartões motivacionais/decorativos de fim de prova ("BOA PROVA!", frases filosóficas sem pergunta) que não sejam questões avaliativas.

2. TEXTOS DE APOIO COMPARTILHADOS E PROIBIÇÃO DE DUPLICAÇÃO ("textos_apoio_compartilhados", "texto_apoio", "fonte"):
   - Quando houver um texto base, tirinha ou artigo com instrução do tipo "Leia o texto a seguir para responder às questões 1 a 3", registre esse texto em "textos_apoio_compartilhados" com um "id_texto" (ex: "T1") SEM a frase "Texto para as questões 1 a 3", e vincule "id_texto_apoio_vinculado": "T1" em TODAS as questões abrangidas (1, 2 e 3) para que cada questão fique 100% autônoma no banco!
   - PROIBIDO DUPLICAR TEXTO ENTRE "texto_apoio" E "enunciado": quando uma questão começar diretamente com uma frase entre aspas ou parágrafo introdutório próprio (ex: "“Se não têm pão, que comam brioches”! A frase... Assinale a alternativa..."), coloque o texto APENAS em "enunciado" e deixe "texto_apoio": "". Só preencha "texto_apoio" individual quando houver um bloco/excerto claramente separado com referência bibliográfica própria, e nesse caso NUNCA repita esse parágrafo dentro de "enunciado"!
   - PROIBIDO USAR CABEÇALHOS/RODAPÉS DE CADERNO COMO "fonte": ignore cabeçalhos/rodapés escolares genéricos (ex: "HUMANAS-8ºANO", "1º BIMESTRE", "HISTÓRIA"), deixando "fonte": "" e "fonte_geral": "". Preencha "fonte" na questão SOMENTE quando aquela questão específica tiver banca oficial (ex: ENEM 2023, FUVEST) ou crédito bibliográfico próprio impresso nela.

3. CLASSIFICAÇÃO NOS 7 MODELOS UNIVERSAIS ("tipo"):
   - "objetiva": múltipla escolha clássica (A–D ou A–E) preenchida em "alternativas".
   - "afirmativas": proposições romanas (I, II, III...) em "proposicoes_romanas", frase de fechamento (ex: "Está correto apenas o que se afirma em:", "Estão corretas:") em "comando_fechamento_afirmativas" E OBRIGATORIAMENTE TODAS as opções de resposta impressas abaixo (ex: "(a) I e II.", "(b) II e III.", "(c) II e IV.", "(d) I e IV." ou "(a) apenas I, II e III.") preenchidas em "alternativas"! NUNCA omita "alternativas" em questões do tipo "afirmativas"!
   - "verdadeiro_falso": assertivas V/F ou C/E em "itens_vf" (vf_submodo="sequencia" se houver alternativas A–E abaixo com a sequência, preenchendo OBRIGATORIAMENTE "alternativas" e colocando a frase "Assinale a alternativa..." em "comando_final").
   - "associacao": duas colunas para relacionar ("coluna_a" e "coluna_b" com "vinculo_codigo"). Se houver alternativas A–E com a sequência numérica abaixo, use assoc_submodo="sequencia", preencha OBRIGATORIAMENTE "alternativas" e coloque a frase "Assinale a alternativa que apresenta a sequência correta:" em "comando_final".
   - "lacuna": frase com lacunas substituídas por {{resposta_correta}} em "texto_lacunado".
   - "somatoria": proposições em potências de 2 (01, 02, 04, 08...) em "proposicoes_somatoria".
   - "discursiva": questão aberta sem alternativas (preencha "resposta_aberta" com o espelho esperado).

4. PRESERVAÇÃO DE NEGRITO (**...**), LATEX CIENTÍFICO E RECORTE INTEGRAL DE FIGURAS ("figuras"):
   - Remova o número original do início de "enunciado" (guarde-o em "numero_original", ex: "01", "Questão 4") e extraia a sigla da banca oficial para "fonte" se existir.
   - PRESERVAÇÃO FIEL DE NEGRITO (**...**) E ITÁLICO (*...*): sempre que o documento original tiver uma frase, pergunta final ou palavra destacada em **negrito** dentro do enunciado, texto de apoio, proposições ou alternativas (ex: "...muito elevados. **Qual continente possui o crescimento demográfico mais intenso na atualidade?**" ou "Assinale a opção **INCORRETA**:"), envolva EXATAMENTE esse trecho com duplo asterisco \`**trecho em negrito**\` (e \`*trecho*\` para itálico relevante). NUNCA coloque o enunciado inteiro em negrito se no original apenas uma parte estiver em negrito, e não aplique negrito ao cabeçalho removido "QUESTÃO X".
   - Remova cursores de edição "|" colados em palavras ("aproxim|arem" -> "aproximarem").
   - Envolva toda fórmula matemática, física ou química linear em cifrões simples $...$ (ex: $m_0$, $\\frac{a}{b}$, $\\text{H}_2\\text{SO}_4$) ou cifrão duplo \`$$...$$\` em linha própria para equações centralizadas em destaque.
   - REGRA DE OURO DE FIGURAS E BBOX 100% INTEGRAL:
     * NUNCA inclua citações textuais, parágrafos introdutórios, faixas "QUESTÃO X", equações algébricas tipográficas ou legendas de variáveis em "figuras" (para questões apenas textuais, retorne "figuras": []).
     * Inclua em "figuras" APENAS ilustrações gráficas reais (gravuras históricas, fotografias, charges/tirinhas, mapas, gráficos, desenhos geométricos, esquemas científicos, estruturas químicas 2D ou tabelas visuais complexas) pertencentes especificamente àquela questão!
     * Em cada "bbox": [ymin, xmin, ymax, xmax] (0..1000), englobe 100% da ilustração do TOPO À BASE — \`ymin\` deve começar ACIMA da borda superior completa da gravura/personagens/título interno da imagem (jamais corte metade superior ou cabeças de gravuras!) e \`ymax\` deve ir até a base completa da figura!
   - Informe também "questao_bbox": [ymin, xmin, ymax, xmax] (0..1000) delimitando toda a região vertical e horizontal onde cada questão aparece na página.

5. GABARITO OBRIGATÓRIO ("gabarito_letra") E RESOLUÇÃO OBJETIVA PASSO A PASSO:
   - Sempre que a questão possuir "alternativas" (e "questao_incompleta_fim_pagina" não for true), inclusive em questões do tipo "afirmativas" (itens I, II, III, IV), "verdadeiro_falso" em sequência e "associacao" em sequência, preencha OBRIGATORIAMENTE "gabarito_letra" ("A", "B", "C", "D" ou "E") com a letra exata da alternativa correspondente aos itens verdadeiros!
   - Se houver gabarito marcado/impresso na folha para a questão, use gabarito_origem="marcado_na_imagem"; caso contrário, resolva com rigor científico em 2 a 4 passos objetivos em "resolucao_passo_a_passo" (sempre fechando $...$ em qualquer LaTeX) e defina gabarito_origem="resolvido_pela_ia".
   - Disciplinas oficiais aceitas: [${DISCIPLINAS_OFICIAIS.join(', ')}]. Séries oficiais: [${SERIES_OFICIAIS.join(', ')}].
${contextoHints ? `\nCONTEXTO ADICIONAL:\n${contextoHints}` : ''}`;

  const imagePart = {
    inlineData: {
      data: fileBuffer.toString('base64'),
      mimeType: mimeType || 'image/jpeg',
    },
  };

  const openAiSchemaHint = `Retorne ESTRITAMENTE um objeto JSON com as chaves:
{
  "layout_pagina": "coluna_unica" | "duas_colunas",
  "coluna_divisao_x": 0,
  "disciplina_predominante": "Matemática",
  "serie_predominante": "1º EM",
  "fonte_geral": "",
  "continuacao_questao_anterior": {
    "possui_continuacao": false,
    "texto_complementar": "",
    "comando_final": "",
    "alternativas": [{ "letra": "B", "texto": "..." }],
    "proposicoes_romanas": []
  },
  "textos_apoio_compartilhados": [{ "id_texto": "T1", "alcance_questoes": "1 a 2", "conteudo": "..." }],
  "questoes": [
    {
      "numero_original": "01",
      "questao_bbox": [ymin, xmin, ymax, xmax],
      "questao_incompleta_fim_pagina": false,
      "id_texto_apoio_vinculado": "",
      "usa_texto_pagina_anterior": false,
      "tipo": "objetiva",
      "disciplina": "Matemática",
      "serie": "1º EM",
      "nivel": "medio",
      "fonte": "",
      "fonte_confirmada": false,
      "habilidade_bncc": "",
      "temas": ["..."],
      "tags": ["..."],
      "texto_apoio": "",
      "enunciado": "...",
      "comando_final": "",
      "figuras": [{ "alvo": "principal", "natureza_visual": "grafico_cartesiano", "ordem": 1, "coluna": "unica", "continuacao_quebra_coluna": false, "bbox": [ymin, xmin, ymax, xmax], "posicao_sugerida": "entre_enunciado_e_comando", "legenda_original": "", "foto_papel_cinza": false }],
      "proposicoes_romanas": [{ "romano": "I", "texto": "...", "correta": true }],
      "comando_fechamento_afirmativas": "",
      "alternativas": [{ "letra": "A", "texto": "..." }],
      "gabarito_letra": "A",
      "gabarito_origem": "resolvido_pela_ia",
      "resolucao_passo_a_passo": "...",
      "confianca": "alta"
    }
  ]
}`;

  report(`Página ${paginaNumero}: Lendo colunas, textos e questões com Visão Computacional...`);

  // Executa upload único da página original ao DO Spaces em paralelo com a inferência multimodal
  const [uploadPagRes, aiRes] = await Promise.all([
    publicarPaginaOriginalLista(fileBuffer).catch((err) => {
      console.warn('[sheetSplitter] Aviso: falha ao publicar página original no DO Spaces:', err?.message);
      return { paginaUrl: null };
    }),
    gerarJsonComFailover({
      contents: [prompt, imagePart],
      promptTextOnly: prompt,
      imagePart,
      responseSchema: SHEET_EXTRACTION_SCHEMA,
      temperature: 0.15,
      openAiJsonHint: openAiSchemaHint,
      maxOutputTokens: 16384,
      timeoutMs: 90000,
      thinkingBudget: 1024,
      onProgress: (subMsg) => report(`Página ${paginaNumero}: ${subMsg}`),
    }),
  ]);

  let paginaOriginalUrl = uploadPagRes?.paginaUrl || null;
  const modeloUsado = aiRes.modeloUsado;
  const dados = sanitizarObjetoIA(aiRes.parsed || {});

  const layoutPagina = dados.layout_pagina === 'duas_colunas' ? 'duas_colunas' : 'coluna_unica';
  const colunaDivisaoX = layoutPagina === 'duas_colunas'
    ? (Number(dados.coluna_divisao_x) >= 280 && Number(dados.coluna_divisao_x) <= 720 ? Number(dados.coluna_divisao_x) : 500)
    : 0;

  const continuacaoAnterior = normalizarContinuacaoQuestaoAnterior(dados.continuacao_questao_anterior);

  const mapaTextosCompartilhados = new Map();
  let ultimoTextoDestaPagina = ultimoTextoApoio || '';
  for (const tc of (Array.isArray(dados.textos_apoio_compartilhados) ? dados.textos_apoio_compartilhados : [])) {
    const idT = String(tc?.id_texto || '').trim();
    const conteudoLimpo = limparCabecalhoTextoCompartilhado(tc?.conteudo || '');
    if (idT && conteudoLimpo) {
      mapaTextosCompartilhados.set(idT, conteudoLimpo);
      ultimoTextoDestaPagina = conteudoLimpo;
    }
  }

  const questoesBrutasOrig = Array.isArray(dados.questoes) ? dados.questoes : [];
  const questoesBrutas = ordenarQuestoesBrutasGeometricamente(questoesBrutasOrig, layoutPagina, colunaDivisaoX);
  const questoesProcessadas = [];
  let contextoPendenteBuffer = null; // { texto: string, midia: object|null }

  report(`Página ${paginaNumero}: ${questoesBrutas.length} questão(ões) identificada(s) · Estruturando itens e recortando figuras...`);

  for (let i = 0; i < questoesBrutas.length; i++) {
    const qRaw = questoesBrutas[i];
    if (!qRaw || (!String(qRaw.enunciado || '').trim() && !String(qRaw.texto_lacunado || '').trim())) {
      continue;
    }

    let midiaPrincipal = null;
    const midiasAlternativas = {};

    const figurasRaw = Array.isArray(qRaw.figuras) ? qRaw.figuras : [];
    const validFiguras = figurasRaw.filter((f) => {
      if (ehFiguraNaoGraficaIgnorada(f)) return false;
      if (!Array.isArray(f?.bbox) || f.bbox.length !== 4) return false;
      const [y1, x1, y2, x2] = f.bbox.map(Number);
      return Number.isFinite(y1) && Number.isFinite(x1) && (y2 - y1) >= 14 && (x2 - x1) >= 14;
    });

    const principaisRaw = validFiguras.filter(
      (f) => !f.alvo || f.alvo === 'principal' || String(f.alvo).toLowerCase().startsWith('principal')
    );
    const alternativasRaw = validFiguras.filter((f) => /^alt_[A-E]$/i.test(String(f.alvo || '')));

    if (principaisRaw.length > 1) {
      principaisRaw.sort((a, b) => {
        if (layoutPagina === 'duas_colunas' && colunaDivisaoX > 0) {
          const cxA = (Number(a.bbox[1]) + Number(a.bbox[3])) / 2;
          const cxB = (Number(b.bbox[1]) + Number(b.bbox[3])) / 2;
          const colA = a.coluna === 'esquerda' ? 0 : a.coluna === 'direita' ? 1 : (cxA < colunaDivisaoX ? 0 : 1);
          const colB = b.coluna === 'esquerda' ? 0 : b.coluna === 'direita' ? 1 : (cxB < colunaDivisaoX ? 0 : 1);
          if (colA !== colB) return colA - colB;
          return Number(a.bbox[0]) - Number(b.bbox[0]);
        }
        return (Number(a.ordem) || 99) - (Number(b.ordem) || 99) || (Number(a.bbox[0]) - Number(b.bbox[0]));
      });
    }

    const principaisUnicas = [];
    for (const fig of principaisRaw) {
      const boxNum = fig.bbox.map(Number);
      const duplicada = principaisUnicas.some((prev) => bboxIoU(prev.bbox, boxNum) > 0.8);
      if (!duplicada) {
        const cx = (boxNum[1] + boxNum[3]) / 2;
        const colInferida = layoutPagina === 'duas_colunas'
          ? (fig.coluna === 'esquerda' || fig.coluna === 'direita' ? fig.coluna : (cx < colunaDivisaoX ? 'esquerda' : 'direita'))
          : 'unica';
        principaisUnicas.push({ ...fig, bbox: boxNum, coluna: colInferida });
      }
    }

    // Limites verticais protetores derivados do questao_bbox + união das figuras vinculadas
    // (preserva charges/gráficos compartilhados no topo da página ou no rodapé da coluna anterior sem colapsar o recorte)
    let qMinTop = 0;
    let qMaxBottom = 1000;
    if (Array.isArray(qRaw.questao_bbox) && qRaw.questao_bbox.length === 4) {
      const [qy1, , qy2] = qRaw.questao_bbox.map(Number);
      const atravessaColunas = principaisUnicas.length > 1
        && principaisUnicas.some((f) => f.coluna === 'esquerda')
        && principaisUnicas.some((f) => f.coluna === 'direita');
      if (!atravessaColunas && Number.isFinite(qy1) && Number.isFinite(qy2) && qy2 - qy1 >= 30) {
        const todasBoxesY = [qy1, qy2];
        for (const f of principaisUnicas) {
          if (Number.isFinite(f.bbox?.[0]) && Number.isFinite(f.bbox?.[2])) {
            todasBoxesY.push(Number(f.bbox[0]), Number(f.bbox[2]));
          }
        }
        qMinTop = clampNorm(Math.min(...todasBoxesY) - 24, 0, 980);
        qMaxBottom = clampNorm(Math.max(...todasBoxesY) + 24, 20, 1000);
      }
    }

    if (principaisUnicas.length > 0) {
      try {
        report(`Página ${paginaNumero}: Recortando figura em alta definição da questão ${qRaw.numero_original || i + 1}...`);
        const usarScannerClean = principaisUnicas.some((f) => Boolean(f.foto_papel_cinza));
        const posicaoSugerida = principaisUnicas[0]?.posicao_sugerida || 'entre_enunciado_e_comando';
        const legendas = principaisUnicas.map((f) => String(f.legenda_original || '').trim()).filter(Boolean);
        const legendaUnificada = legendas.join(' · ');
        const fonteQuestaoLimpa = limparFonteFalsaCaderno(qRaw.fonte);
        const creditoFigura =
          fonteQuestaoLimpa && !legendaUnificada.toLowerCase().includes(fonteQuestaoLimpa.toLowerCase())
            ? fonteQuestaoLimpa
            : '';

        const procPrincipal = await processarMidiaQuestao(fileBuffer, {
          bboxes: principaisUnicas.map((f) => ({
            bbox: f.bbox,
            coluna: f.coluna,
            coluna_divisao_x: colunaDivisaoX,
            continuacao_quebra_coluna: Boolean(f.continuacao_quebra_coluna),
            minTopNorm: qMinTop,
            maxBottomNorm: qMaxBottom,
          })),
          layoutOrigem: layoutPagina,
          colunaDivisaoX,
          minTopNorm: qMinTop,
          maxBottomNorm: qMaxBottom,
          composicaoLayout: 'auto',
          autoTrim: true,
          scannerClean: usarScannerClean,
          keepOriginal: !paginaOriginalUrl,
          existingOriginalUrl: paginaOriginalUrl,
          posicao: posicaoSugerida,
          legenda: legendaUnificada,
          credito: creditoFigura,
        });

        midiaPrincipal = procPrincipal.midia;
        if (!paginaOriginalUrl && procPrincipal.midia?.original_url) {
          paginaOriginalUrl = procPrincipal.midia.original_url;
        }
      } catch (cropErr) {
        console.warn(`[sheetSplitter] Falha ao recortar figura da questão #${i + 1}:`, cropErr?.message);
      }
    }

    for (const fig of alternativasRaw) {
      try {
        const procAlt = await processarMidiaQuestao(fileBuffer, {
          bbox: fig.bbox.map(Number),
          colunaDivisaoX,
          layoutOrigem: layoutPagina,
          minTopNorm: qMinTop,
          maxBottomNorm: qMaxBottom,
          autoTrim: true,
          scannerClean: Boolean(fig.foto_papel_cinza),
          keepOriginal: !paginaOriginalUrl,
          existingOriginalUrl: paginaOriginalUrl,
          posicao: 'entre_enunciado_e_comando',
        });
        if (!paginaOriginalUrl && procAlt.midia?.original_url) {
          paginaOriginalUrl = procAlt.midia.original_url;
        }
        const letra = String(fig.alvo).split('_')[1].toUpperCase();
        midiasAlternativas[letra] = procAlt.url;
      } catch (altErr) {
        console.warn(`[sheetSplitter] Falha ao recortar alternativa da questão #${i + 1}:`, altErr?.message);
      }
    }

    let qParaNormalizar = extrairAlternativasEmbutidasEmTexto(qRaw);
    const tipoPre = TIPOS_VALIDOS.includes(qParaNormalizar.tipo) ? qParaNormalizar.tipo : 'objetiva';
    const qtdAltsTexto = Array.isArray(qParaNormalizar.alternativas)
      ? qParaNormalizar.alternativas.filter((a) => String(a?.texto || '').trim()).length
      : 0;

    if (
      questaoExigeAlternativasVisiveis(tipoPre, qParaNormalizar, { modoPagina: true }) &&
      qtdAltsTexto < 2 &&
      alternativasRaw.length < 2
    ) {
      report(`Página ${paginaNumero}: Resgatando alternativas da questão ${qParaNormalizar.numero_original || i + 1}...`);
      const resgate = await resgatarAlternativasOmitidasDaImagem(fileBuffer, mimeType, {
        numeroOriginal: qParaNormalizar.numero_original || `${i + 1}`,
        enunciado: qParaNormalizar.enunciado,
        comandoFechamento: qParaNormalizar.comando_fechamento_afirmativas || qParaNormalizar.comando_final,
        proposicoesResumo: Array.isArray(qParaNormalizar.proposicoes_romanas)
          ? qParaNormalizar.proposicoes_romanas.map((p) => `${p.romano}: ${p.texto}`).join(' | ')
          : '',
      });
      if (resgate && (resgate.alternativas.length >= 2 || (resgate.questao_incompleta_fim_pagina && resgate.alternativas.length >= 1))) {
        qParaNormalizar = {
          ...qParaNormalizar,
          alternativas: resgate.alternativas,
          questao_incompleta_fim_pagina: Boolean(qParaNormalizar.questao_incompleta_fim_pagina || resgate.questao_incompleta_fim_pagina),
          gabarito_letra: qParaNormalizar.gabarito_letra || resgate.gabarito_letra || '',
        };
      }
    }

    const itemNormalizado = normalizarQuestaoIndividualizada({
      qRaw: qParaNormalizar,
      idx: i,
      mapaTextosCompartilhados,
      ultimoTextoApoio,
      disciplinaFallback: disciplinaSugerida || dados.disciplina_predominante || '',
      serieFallback: serieSugerida || dados.serie_predominante || '',
      layoutPagina,
      paginaOriginalUrl,
      paginaNumero,
      midiaPrincipal,
      midiasAlternativas,
      modeloUsado,
    });

    if (itemNormalizado.texto_apoio) {
      ultimoTextoDestaPagina = itemNormalizado.texto_apoio;
    }

    // Detecta chamadas órfãs de imagem/texto sem pergunta ("Observe a imagem...", "PENDENTE_PROXIMA_PAGINA")
    const numUpper = String(qRaw.numero_original || '').toUpperCase().trim();
    const semCorpoEstruturado =
      !itemNormalizado.questao_incompleta_fim_pagina &&
      itemNormalizado.tipo !== 'discursiva' &&
      itemNormalizado.tipo !== 'lacuna' &&
      (!Array.isArray(itemNormalizado.alternativas) || itemNormalizado.alternativas.length === 0) &&
      (!Array.isArray(qRaw.proposicoes_romanas) || qRaw.proposicoes_romanas.length === 0) &&
      (!Array.isArray(qRaw.itens_vf) || qRaw.itens_vf.length === 0) &&
      (!Array.isArray(qRaw.coluna_a) || qRaw.coluna_a.length === 0) &&
      (!Array.isArray(qRaw.proposicoes_somatoria) || qRaw.proposicoes_somatoria.length === 0);

    const isChamadaPendente = numUpper.includes('PENDENTE') || semCorpoEstruturado;

    if (isChamadaPendente) {
      const txtTeaser = [itemNormalizado.texto_apoio, itemNormalizado.enunciado]
        .map((s) => limparCabecalhoTextoCompartilhado(s))
        .filter((s) => s && !/^observe\s+a\s+(?:imagem|figura|charge|tirinha)\s*:?$/i.test(s.trim()))
        .join('\n\n')
        .trim();

      contextoPendenteBuffer = {
        texto: [contextoPendenteBuffer?.texto, txtTeaser].filter(Boolean).join('\n\n').trim(),
        midia: itemNormalizado.midia || contextoPendenteBuffer?.midia || null,
      };
      continue;
    }

    // Se havia contexto/figura pendente imediatamente antes desta questão na mesma página (ex: fim da col. 1 -> topo da col. 2), acopla!
    if (contextoPendenteBuffer) {
      if (contextoPendenteBuffer.texto) {
        itemNormalizado.texto_apoio = [contextoPendenteBuffer.texto, itemNormalizado.texto_apoio]
          .filter(Boolean)
          .join('\n\n')
          .trim();
      }
      if (contextoPendenteBuffer.midia && !itemNormalizado.midia) {
        itemNormalizado.midia = contextoPendenteBuffer.midia;
        itemNormalizado.imagem_url = contextoPendenteBuffer.midia.url || null;
      }
      contextoPendenteBuffer = null;
    }

    questoesProcessadas.push(itemNormalizado);
  }

  return {
    ok: true,
    modelo_ia: modeloUsado,
    pagina_numero: Number(paginaNumero) || 1,
    pagina_original_url: paginaOriginalUrl,
    layout_pagina: layoutPagina,
    ultimo_texto_apoio: ultimoTextoDestaPagina,
    contexto_proxima_pagina: contextoPendenteBuffer,
    continuacao_questao_anterior: continuacaoAnterior,
    total_questoes: questoesProcessadas.length,
    questoes: questoesProcessadas,
  };
}

/**
 * Individualiza uma lista de questões colada em texto bruto (Word, Google Docs, PDF texto)
 * estruturando cada questão nos 7 modelos universais com LaTeX e gabarito comentado.
 */
export async function extrairListaPorTextoIA(textoBruto, opcoes = {}) {
  const { disciplinaSugerida = '', serieSugerida = '', onProgress = null } = opcoes || {};
  const report = (msg) => {
    if (typeof onProgress === 'function') {
      try { onProgress(msg); } catch { /* ignore */ }
    }
  };
  const textoLimpo = String(textoBruto || '').trim();
  if (textoLimpo.length < 20) {
    throw new Error('Cole o texto contendo ao menos uma questão completa.');
  }

  report('Analisando texto bruto da lista e convertendo fórmulas para LaTeX...');

  // Limite seguro de caracteres por requisição para evitar truncamento de saída
  const trecho = textoLimpo.slice(0, 28000);

  const prompt = `Você é o Agente Individualizador de Listas Educacionais do EDUCA.STUDIO AI.
Receba o texto bruto abaixo (copiado de prova/lista no Word, Docs ou PDF) e INDIVIDUALIZE cada questão nos 7 modelos universais ("objetiva", "afirmativas", "verdadeiro_falso", "associacao", "lacuna", "somatoria", "discursiva"):

REGRAS OBRIGATÓRIAS:
1. Separe cada questão individualmente na ordem em que aparece, guardando seu número em "numero_original" (sem deixá-lo colado no início do "enunciado").
2. Se houver textos de apoio compartilhados ("Texto para as questões 1 a 3"), cadastre em "textos_apoio_compartilhados" (id_texto="T1") e vincule "id_texto_apoio_vinculado": "T1" nas questões correspondentes. Nunca repita o mesmo parágrafo simultaneamente em "texto_apoio" e "enunciado".
3. Converta expressões matemáticas, físicas ou químicas informais para LaTeX limpo entre cifrões simples $...$ (ou \`$$...$$\` para equações destacadas em linha própria) e preserve eventuais trechos em negrito com \`**trecho**\`. Como é texto puro, retorne "figuras": [] em todas as questões.
4. Se o texto trouxer um bloco de "GABARITO" no final da lista ou marcação explícita (ex: "[X]", "*", "Gabarito: C"), use esse gabarito oficial com gabarito_origem="marcado_na_imagem". Caso a questão não tenha gabarito informado no texto, resolva-a com rigor científico e defina gabarito_origem="resolvido_pela_ia". Sempre que houver "alternativas", preencha OBRIGATORIAMENTE "gabarito_letra" ("A" a "E").
5. Em ambos os casos, escreva a resolução passo a passo objetiva em "resolucao_passo_a_passo".
6. Disciplinas oficiais aceitas: [${DISCIPLINAS_OFICIAIS.join(', ')}]. Séries oficiais: [${SERIES_OFICIAIS.join(', ')}].
${disciplinaSugerida ? `- Disciplina padrão sugerida pelo professor: "${disciplinaSugerida}".` : ''}
${serieSugerida ? `- Série padrão sugerida pelo professor: "${serieSugerida}".` : ''}

TEXTO BRUTO DA LISTA:
"""
${trecho}
"""`;

  const openAiSchemaHint = `Retorne ESTRITAMENTE um objeto JSON com as chaves: layout_pagina ("coluna_unica"), coluna_divisao_x (0), disciplina_predominante, serie_predominante, fonte_geral, textos_apoio_compartilhados ([{id_texto, conteudo}]), questoes ([{numero_original, id_texto_apoio_vinculado, tipo, disciplina, serie, nivel, fonte, habilidade_bncc, temas, tags, texto_apoio, enunciado, comando_final, proposicoes_romanas, comando_fechamento_afirmativas, vf_submodo, vf_rotulo, itens_vf, assoc_submodo, coluna_a, coluna_b, lacuna_submodo, texto_lacunado, distratores_banco, proposicoes_somatoria, soma_correta, alternativas:[{letra, texto}], formato_espaco_discursiva, linhas_resposta_sugeridas, resposta_aberta, gabarito_letra, gabarito_origem, resolucao_passo_a_passo, confianca}]).`;

  const { parsed: rawParsed, modeloUsado } = await gerarJsonComFailover({
    contents: prompt,
    promptTextOnly: prompt,
    responseSchema: SHEET_EXTRACTION_SCHEMA,
    temperature: 0.15,
    openAiJsonHint: openAiSchemaHint,
    maxOutputTokens: 16384,
    timeoutMs: 90000,
    thinkingBudget: 1024,
    onProgress: (subMsg) => report(subMsg),
  });

  const dados = sanitizarObjetoIA(rawParsed || {});
  const mapaTextosCompartilhados = new Map();
  for (const tc of (Array.isArray(dados.textos_apoio_compartilhados) ? dados.textos_apoio_compartilhados : [])) {
    const idT = String(tc?.id_texto || '').trim();
    const conteudoLimpo = limparCabecalhoTextoCompartilhado(tc?.conteudo || '');
    if (idT && conteudoLimpo) mapaTextosCompartilhados.set(idT, conteudoLimpo);
  }

  const questoesBrutas = Array.isArray(dados.questoes) ? dados.questoes : [];
  const questoesProcessadas = [];

  report(`Estruturando ${questoesBrutas.length} questão(ões) nos 7 modelos universais...`);

  for (let i = 0; i < questoesBrutas.length; i++) {
    const qRaw = questoesBrutas[i];
    if (!qRaw || (!String(qRaw.enunciado || '').trim() && !String(qRaw.texto_lacunado || '').trim())) {
      continue;
    }
    questoesProcessadas.push(
      normalizarQuestaoIndividualizada({
        qRaw,
        idx: i,
        mapaTextosCompartilhados,
        ultimoTextoApoio: '',
        disciplinaFallback: disciplinaSugerida || dados.disciplina_predominante || '',
        serieFallback: serieSugerida || dados.serie_predominante || '',
        layoutPagina: 'coluna_unica',
        paginaOriginalUrl: null,
        paginaNumero: 1,
        midiaPrincipal: null,
        midiasAlternativas: {},
        modeloUsado,
      })
    );
  }

  return {
    ok: true,
    modelo_ia: modeloUsado,
    total_questoes: questoesProcessadas.length,
    questoes: questoesProcessadas,
  };
}
