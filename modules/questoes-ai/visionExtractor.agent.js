// modules/questoes-ai/visionExtractor.agent.js
// EDUCA.STUDIO AI — Agentes Multimodais Especializados (Gemini 2.5 Flash)
// 1. Vision Extractor + Column-Aware Multi-BBox Detector (Clonagem 1 ou 2 Colunas nos 7 modelos)
// 2. Solver & Classifier Agent (Resolução passo a passo c/ blindagem LaTeX, BNCC e Temas)
// 3. Pedagogical Copilot Agent (Distratores, LaTeX, Metadados e Espelho de Correção)

import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';
import { processarMidiaQuestao } from './smartMediaEngine.js';

const DISCIPLINAS_OFICIAIS = [
  'Português', 'Matemática', 'Ciências', 'História', 'Geografia',
  'Inglês', 'Artes', 'Educação Física', 'Biologia', 'Física',
  'Química', 'Sociologia', 'Filosofia', 'Redação', 'PD',
];

const SERIES_OFICIAIS = [
  '6º Ano EF', '7º Ano EF', '8º Ano EF', '9º Ano EF',
  '1º EM', '2º EM', '3º EM', 'Ensino Superior',
];

let _gemini = null;
function getGemini() {
  if (!_gemini) {
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw new Error('GEMINI_API_KEY não configurada no ambiente.');
    _gemini = new GoogleGenerativeAI(key);
  }
  return _gemini;
}

/**
 * Restaura comandos LaTeX cujas barras invertidas foram convertidas em caracteres de controle
 * pelo JSON.parse (ex: "\text" -> TAB + "ext", "\frac" -> FF + "rac", "\beta" -> BS + "eta")
 * e garante que expressões LaTeX soltas (ex: \text{CH}_3 fora de $...$) fiquem entre cifrões.
 */
export function sanitizarTextoLatexIA(input) {
  if (typeof input !== 'string' || !input) return input;
  let s = input;

  // 1) Backspace (\x08) e FormFeed (\x0c) nunca existem em texto escolar real — são sempre \b e \f de LaTeX
  s = s.replace(/\x08/g, '\\b');
  s = s.replace(/\x0c/g, '\\f');

  // 2) Tab (\x09) antes de sufixos clássicos de comandos LaTeX iniciados por \t (\text, \times, \theta, \tau, \tan, \to, \triangle, \tilde, \tfrac)
  s = s.replace(/\x09(?=(?:ext|imes|heta|au\b|an\b|anh\b|o\b|op\b|riangle|ilde|frac|herefore|hickapprox|iny))/g, '\\t');

  // 3) Carriage Return isolado (\r sem \n) antes de comandos iniciados por \r (\rightarrow, \right, \rho, \rangle, \rceil, \rfloor)
  s = s.replace(/\r(?!\n)(?=(?:ight|ho\b|angle|ceil|floor|aise))/g, '\\r');

  // 4) Dentro de blocos $$...$$ (display) ou $...$ (inline), restaura \x09, \r e \n antes de comandos LaTeX
  // IMPORTANTE: casar $$...$$ ANTES de $...$ na mesma passada p/ nunca deslocar delimitadores!
  s = s.replace(/\$\$([^$]+)\$\$|\$([^$]+)\$/g, (_full, dispInner, inlInner) => {
    const isDisp = dispInner !== undefined;
    const inner = isDisp ? dispInner : inlInner;
    const fixed = inner
      .replace(/\x09/g, '\\t')
      .replace(/\r(?!\n)/g, '\\r')
      .replace(/\n(?=(?:abla|eq\b|u\b|otin|eg\b|atural|leq|geq|mid\b|parallel|sim\b|cong))/g, '\\n');
    return isDisp ? `$$${fixed}$$` : `$${fixed}$`;
  });

  // 5) Fora de $...$/$$...$$: limpa cursor de digitação de prints do Word/Docs ("meias-vidas|" -> "meias-vidas")
  //    e envolve automaticamente comandos LaTeX soltos (\text{...}, \frac{...}{...}, \sqrt{...}) em $...$
  const partes = s.split(/(\$\$[^$]+\$\$|\$[^$]+\$)/g);
  s = partes
    .map((parte) => {
      if (parte.startsWith('$')) return parte;
      return parte
        .replace(/([A-Za-zÀ-ÿ0-9)\]])\|(?=\s|$|[.,;:!?])/g, '$1')
        .replace(
          /(?:-\s*)?(?:(?:\\(?:text|mathrm|mathbf)\{[^{}]+\}|\\frac\{[^{}]+\}\{[^{}]+\}|\\sqrt\{[^{}]+\})(?:[_^](?:\{[^{}]+\}|[A-Za-z0-9+-]+))*)+(?:\s*(?:[-+=→⇌]|\\rightarrow)\s*(?:(?:\\(?:text|mathrm|mathbf)\{[^{}]+\}|\\frac\{[^{}]+\}\{[^{}]+\})(?:[_^](?:\{[^{}]+\}|[A-Za-z0-9+-]+))*)+)*/g,
          (match) => `$${match.trim()}$`
        );
    })
    .join('');

  return s;
}

function sanitizarObjetoIA(val) {
  if (typeof val === 'string') return sanitizarTextoLatexIA(val);
  if (Array.isArray(val)) return val.map(sanitizarObjetoIA);
  if (val && typeof val === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(val)) {
      out[k] = sanitizarObjetoIA(v);
    }
    return out;
  }
  return val;
}

function bboxIoU(a, b) {
  const y1 = Math.max(a[0], b[0]);
  const x1 = Math.max(a[1], b[1]);
  const y2 = Math.min(a[2], b[2]);
  const x2 = Math.min(a[3], b[3]);
  const inter = Math.max(0, y2 - y1) * Math.max(0, x2 - x1);
  if (inter <= 0) return 0;
  const areaA = Math.max(1, (a[2] - a[0]) * (a[3] - a[1]));
  const areaB = Math.max(1, (b[2] - b[0]) * (b[3] - b[1]));
  return inter / Math.min(areaA, areaB);
}

// ── Schema Estrito para Extração Multimodal (7 Modelos + 2 Colunas + Multi-BBox) ──
const EXTRACTION_SCHEMA = {
  type: SchemaType.OBJECT,
  properties: {
    layout_origem: {
      type: SchemaType.STRING,
      description: 'coluna_unica (questão diagramada em 1 coluna normal) | duas_colunas (mesma questão dividida em coluna esquerda e coluna direita lado a lado, padrão ENEM/Fuvest/bancos web).',
    },
    coluna_divisao_x: {
      type: SchemaType.INTEGER,
      description: 'Se layout_origem = duas_colunas, informe a coordenada X (0 a 1000, tipicamente entre 430 e 570) do corredor branco vertical que separa a coluna da esquerda da coluna da direita. Se coluna_unica, use 0.',
    },
    tipo: {
      type: SchemaType.STRING,
      description: 'Modelo estrutural exato: objetiva | afirmativas | verdadeiro_falso | associacao | lacuna | discursiva | somatoria',
    },
    disciplina: {
      type: SchemaType.STRING,
      description: `Uma das disciplinas: ${DISCIPLINAS_OFICIAIS.join(', ')}`,
    },
    serie: {
      type: SchemaType.STRING,
      description: `Série escolar mais adequada: ${SERIES_OFICIAIS.join(', ')}`,
    },
    nivel: {
      type: SchemaType.STRING,
      description: 'facil | medio | dificil | enem',
    },
    fonte: {
      type: SchemaType.STRING,
      description: 'Banca, instituição ou exame (ex: ENEM 2023, UECE, Acafe-SC, FUVEST, UnB). Vazio se não identificável com segurança.',
    },
    fonte_confirmada: {
      type: SchemaType.BOOLEAN,
      description: 'true apenas se a fonte estiver explícita na imagem ou for inequivocamente reconhecida.',
    },
    habilidade_bncc: {
      type: SchemaType.STRING,
      description: 'Código BNCC compatível (ex: EM13CNT202, EF09MA09)',
    },
    temas: {
      type: SchemaType.ARRAY,
      items: { type: SchemaType.STRING },
      description: 'Lista de 2 a 4 temas/conteúdos específicos da questão.',
    },
    tags: {
      type: SchemaType.ARRAY,
      items: { type: SchemaType.STRING },
      description: 'Palavras-chave curtas para indexação.',
    },
    texto_apoio: {
      type: SchemaType.STRING,
      description: 'Texto base, trecho literário ou reportagem introdutória ANTES do enunciado (vazio se não houver).',
    },
    enunciado: {
      type: SchemaType.STRING,
      description: 'Texto principal do enunciado que vem ANTES das figuras (ou enunciado completo caso não haja texto pós-figura). Sem número inicial da questão.',
    },
    comando_final: {
      type: SchemaType.STRING,
      description: 'Todo o texto e pergunta que aparecem APÓS as figuras e antes das alternativas/itens (ex: parágrafos complementares na 2ª coluna + "Os radicais R1 e R2 constituem..."). Vazio se não houver.',
    },
    figuras: {
      type: SchemaType.ARRAY,
      description: 'SOMENTE ilustrações gráficas reais (esquemas biológicos/físicos, gráficos cartesianos, figuras geométricas, estruturas químicas 2D com ligações desenhadas, tirinhas, charges, mapas ou tabelas visuais). PROIBIDO incluir equações matemáticas tipográficas, sistemas lineares, matrizes ou legendas de variáveis — esses elementos devem ser transcritos em LaTeX no enunciado com figuras=[].',
      items: {
        type: SchemaType.OBJECT,
        properties: {
          alvo: {
            type: SchemaType.STRING,
            description: 'principal (para cada figura/esquema gráfico real do enunciado — pode haver vários itens "principal") | alt_A | alt_B | alt_C | alt_D | alt_E',
          },
          natureza_visual: {
            type: SchemaType.STRING,
            description: 'Classificação obrigatória: grafico_cartesiano | geometria_desenho | esquema_cientifico | estrutura_quimica_2d | tirinha_charge_mapa | tabela_visual | equacao_puramente_tipografica',
          },
          ordem: {
            type: SchemaType.INTEGER,
            description: 'Ordem de leitura (1, 2, 3...). Em duas_colunas: numere primeiro todas as figuras da coluna esquerda (de cima para baixo) e depois todas da coluna direita (de cima para baixo).',
          },
          coluna: {
            type: SchemaType.STRING,
            description: 'unica | esquerda | direita',
          },
          continuacao_quebra_coluna: {
            type: SchemaType.BOOLEAN,
            description: 'true APENAS quando este recorte no topo da coluna direita é a metade inferior/continuação direta de uma MESMA fórmula/figura/tabela que foi cortada no rodapé da coluna esquerda.',
          },
          bbox: {
            type: SchemaType.ARRAY,
            items: { type: SchemaType.INTEGER },
            description: 'Coordenadas exatas [ymin, xmin, ymax, xmax] de 0 a 1000 englobando APENAS a ilustração/esquema/fórmula estrutural 2D, sem invadir a coluna vizinha nem parágrafos de texto.',
          },
          posicao_sugerida: {
            type: SchemaType.STRING,
            description: 'apos_texto_apoio | entre_enunciado_e_comando | abaixo_comando',
          },
          legenda_original: {
            type: SchemaType.STRING,
            description: 'Legenda ou crédito impresso logo abaixo da figura, se houver.',
          },
          foto_papel_cinza: {
            type: SchemaType.BOOLEAN,
            description: 'true se a imagem aparentar ser foto de celular de papel cinza/amarelado que se beneficia de limpeza de fundo.',
          },
        },
        required: ['alvo', 'natureza_visual', 'ordem', 'coluna', 'continuacao_quebra_coluna', 'bbox', 'posicao_sugerida', 'foto_papel_cinza'],
      },
    },
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
      description: 'Preencher quando tipo = afirmativas (itens I, II, III, IV).',
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
      description: 'Ex: "É correto apenas o que se afirma em:" (quando tipo = afirmativas).',
    },
    vf_submodo: {
      type: SchemaType.STRING,
      description: 'direto | sequencia (quando tipo = verdadeiro_falso)',
    },
    vf_rotulo: {
      type: SchemaType.STRING,
      description: 'VF | CE (Verdadeiro/Falso ou Certo/Errado)',
    },
    itens_vf: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          texto: { type: SchemaType.STRING },
          gabarito: { type: SchemaType.STRING, description: 'V ou F (ou C ou E)' },
        },
        required: ['texto', 'gabarito'],
      },
    },
    assoc_submodo: {
      type: SchemaType.STRING,
      description: 'direto | sequencia (quando tipo = associacao)',
    },
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
    lacuna_submodo: {
      type: SchemaType.STRING,
      description: 'direto | banco_palavras | alternativas (quando tipo = lacuna)',
    },
    texto_lacunado: {
      type: SchemaType.STRING,
      description: 'Enunciado/frase com cada lacuna substituída por {{resposta_correta}} (quando tipo = lacuna).',
    },
    distratores_banco: {
      type: SchemaType.ARRAY,
      items: { type: SchemaType.STRING },
    },
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
    soma_correta: {
      type: SchemaType.INTEGER,
    },
    formato_espaco_discursiva: {
      type: SchemaType.STRING,
      description: 'linhas | quadro_calculo (quando tipo = discursiva)',
    },
    linhas_resposta_sugeridas: {
      type: SchemaType.INTEGER,
    },
    resposta_aberta: {
      type: SchemaType.STRING,
      description: 'Espelho de correção / resposta esperada completa para questão discursiva.',
    },
    gabarito_letra: {
      type: SchemaType.STRING,
      description: 'Letra da alternativa correta (A, B, C, D ou E) quando houver alternativas.',
    },
    gabarito_origem: {
      type: SchemaType.STRING,
      description: 'marcado_na_imagem (se houver grifo/marcação/gabarito explícito no print) OU resolvido_pela_ia (se a IA resolveu por raciocínio próprio).',
    },
    resolucao_passo_a_passo: {
      type: SchemaType.STRING,
      description: 'Resolução comentada rigorosa e didática passo a passo (separe cada passo com quebra de linha \\n), usando sempre cifrões $...$ ao redor de qualquer comando LaTeX como $\\text{CH}_3$ ou $\\frac{a}{b}$.',
    },
    confianca: {
      type: SchemaType.STRING,
      description: 'alta | media | baixa',
    },
  },
  required: [
    'layout_origem', 'coluna_divisao_x', 'tipo', 'disciplina', 'nivel', 'temas',
    'enunciado', 'figuras', 'gabarito_origem', 'resolucao_passo_a_passo', 'confianca',
  ],
};

/**
 * Extrai, classifica, resolve e recorta automaticamente figuras (1 ou 2 colunas) de um print/foto.
 */
export async function extrairQuestaoMultimodal(fileBuffer, mimeType) {
  const genAI = getGemini();
  const model = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: EXTRACTION_SCHEMA,
      temperature: 0.15,
    },
  });

  const prompt = `Você é o Agente Extrator Multimodal e Solucionador Científico do EDUCA.STUDIO AI.
Analise a imagem da questão educacional enviada e estruture TODOS os campos com precisão cirúrgica:

0. DETECÇÃO DE DIAGRAMAÇÃO EM DUAS COLUNAS ("layout_origem" e "coluna_divisao_x"):
   - Verifique primeiro se o print mostra a MESMA questão dividida em DUAS COLUNAS lado a lado (início na coluna da esquerda e continuação + alternativas na coluna da direita, muito comum em ENEM, Fuvest, Unesp e portais de exercícios).
   - Se estiver em 2 colunas: defina layout_origem="duas_colunas", informe em "coluna_divisao_x" a coordenada X (0..1000, ex: 495) do corredor branco vertical entre as colunas e siga OBRIGATORIAMENTE a ordem de leitura:
     1º) Toda a COLUNA DA ESQUERDA de cima até embaixo (texto E todas as figuras da esquerda!);
     2º) Toda a COLUNA DA DIREITA de cima até embaixo (figuras do topo direito + continuação do texto + alternativas).
   - NUNCA ignore esquemas, desenhos celulares, gráficos ou fórmulas da coluna da esquerda!

1. MODELO DA QUESTÃO (campo "tipo"):
   - "objetiva": múltipla escolha clássica (A–D ou A–E).
   - "afirmativas": possui proposições em algarismos romanos (I, II, III...) seguidas de alternativas ("Apenas I e II", etc.). Separe as proposições em "proposicoes_romanas", o comando de fechamento em "comando_fechamento_afirmativas" e as opções A–E em "alternativas".
   - "verdadeiro_falso": julgamento de assertivas (V/F ou C/E). Se não houver alternativas A–E abaixo, use vf_submodo="direto"; se houver alternativas com a sequência (ex: V - F - V), use vf_submodo="sequencia" e preencha também "alternativas".
   - "associacao": duas colunas para relacionar/numerar (Coluna A × Coluna B). Preencha "coluna_a" e "coluna_b" com "vinculo_codigo" correto.
   - "lacuna": frases para completar espaços em branco. Em "texto_lacunado", escreva a frase substituindo cada lacuna por {{resposta_correta}}.
   - "somatoria": proposições numeradas em potências de 2 (01, 02, 04, 08, 16...) cuja resposta é a soma.
   - "discursiva": questão aberta sem alternativas (use formato_espaco_discursiva="quadro_calculo" se exigir conta/desenho ou "linhas" se textual).

2. FIDELIDADE ESPACIAL, EQUAÇÕES EM DESTAQUE ($$...$$) E ARTEFATOS DE EDITOR:
   - Remova numeração inicial da prova original (ex: "6.", "04.", "Questão 12 -") e remova a sigla da banca do início do enunciado colocando-a em "fonte" (ex: "(UECE)" -> fonte: "UECE").
   - NUNCA invente banca em "fonte": se não houver sigla/cabeçalho explícito, deixe "fonte": "" e "fonte_confirmada": false.
   - Ignore artefatos de interface de editores de texto (Word/Google Docs) em prints de tela, como barra vertical de cursor de digitação colada no fim de palavras ("meias-vidas|" -> transcreva "meias-vidas") e sublinhados ondulados de corretor ortográfico.
   - Use notação LaTeX inline SEMPRE envolvida por cifrões simples ($...$) para variáveis ($m_0$, $f(x)$), frações inline ($\\frac{a}{b}$), raízes ($\\sqrt{x}$), potências ($10^{-3}$), setas ($\\rightarrow$) e fórmulas químicas lineares ($\\text{H}_2\\text{O}$, $\\text{CH}_3$). NUNCA escreva \\text{} ou _0 fora de $...$!
   - EQUAÇÕES EM DESTAQUE E LEGENDAS DE VARIÁVEIS NÃO SÃO FIGURAS: quando a questão apresentar uma função/equação centralizada em destaque (ex: $f(x) = \\frac{m_0}{2^x}$), sistema linear, matriz ou definições de variáveis (ex: "$x \\rightarrow$ quantidade de meias-vidas", "$m_0 \\rightarrow$ massa inicial", "$f(x) \\rightarrow$ massa final"), NUNCA recorte isso em "figuras" (retorne "figuras": [] se não houver ilustração gráfica real!). Transcreva a equação centralizada usando cifrão duplo \`$$...$$\` em linha própria dentro de "enunciado" (ex: \`\\n$$f(x) = \\\\frac{m_0}{2^x}$$\\n\`) seguida em linhas separadas (\`\\n\`) de TODAS as linhas de legenda/significado das variáveis sem omitir nenhuma!
   - Separe o texto que vem ANTES das figuras reais em "enunciado", e o comando/pergunta de fechamento em "comando_final".

3. DETECÇÃO COMPLETA E RECORTE MULTI-FIGURA ("figuras"):
   - Retorne em "figuras" SOMENTE blocos visuais genuinamente gráficos/ilustrativos: esquemas biológicos/físicos, gráficos com eixos, desenhos geométricos, estruturas químicas 2D com ligações desenhadas (traços/anéis), circuitos, tirinhas, charges, mapas ou tabelas complexas. NUNCA inclua equações algébricas tipográficas nem texto de variáveis em "figuras"!
   - Se a questão possuir 2 ou 3 regiões visuais gráficas separadas (ex: um esquema de membrana celular na coluna esquerda + fórmulas estruturais 2D de aminoácidos no rodapé esquerdo e/ou topo da coluna direita), retorne UM ITEM SEPARADO em "figuras" (com alvo="principal") para CADA região visual!
   - Se na virada da coluna esquerda para a coluna direita uma MESMA fórmula estrutural 2D ou tabela foi partida ao meio (ex: cadeia principal —N—C—C— no rodapé da coluna esquerda e radicais |CH3 alanina, serina, aspartato no topo da coluna direita), retorne o bbox da metade no rodapé esquerdo (coluna="esquerda", continuacao_quebra_coluna=false) E o bbox da metade no topo direito (coluna="direita", continuacao_quebra_coluna=true)!
   - Em cada bbox [ymin, xmin, ymax, xmax] (0 a 1000): englobe 100% dos rótulos periféricos daquela ilustração (ex: siglas nas pontas superiores/inferiores como "R1" e "R2", segundas linhas de legendas com setas como "Proteína / transmembrana" e fórmulas encostadas no limite inferior y=1000 da coluna), mas NÃO invada parágrafos de texto nem ultrapasse "coluna_divisao_x" para a coluna vizinha.
   - Se a questão contiver apenas texto e equações matemáticas/químicas tipográficas sem desenho/gráfico/estrutura 2D, retorne OBRIGATORIAMENTE "figuras": [].

4. GABARITO E RESOLUÇÃO PASSO A PASSO:
   - Se o print trouxer gabarito oficial inequívoco destacado, use gabarito_origem="marcado_na_imagem".
   - Caso contrário, resolva com rigor científico passo a passo (quebrando linhas entre Passo 1, Passo 2, Conclusão) em "resolucao_passo_a_passo" e defina gabarito_origem="resolvido_pela_ia".`;

  const imagePart = {
    inlineData: {
      data: fileBuffer.toString('base64'),
      mimeType,
    },
  };

  const result = await model.generateContent([prompt, imagePart]);
  const rawText = result.response.text().trim();
  const dados = sanitizarObjetoIA(JSON.parse(rawText));

  // ── Processamento independente das figuras detectadas (1 ou 2 colunas) via Sharp -> DO Spaces ──
  let midiaPrincipal = null;
  const midiasAlternativas = {};

  const layoutOrigem = dados.layout_origem === 'duas_colunas' ? 'duas_colunas' : 'coluna_unica';
  const colunaDivisaoX = layoutOrigem === 'duas_colunas'
    ? (Number(dados.coluna_divisao_x) >= 300 && Number(dados.coluna_divisao_x) <= 700 ? Number(dados.coluna_divisao_x) : 500)
    : 0;

  const figurasRaw = Array.isArray(dados.figuras) ? dados.figuras : [];
  const validFiguras = figurasRaw.filter((f) => {
    // Trava determinística v2.2: equações puramente tipográficas pertencem ao LaTeX do enunciado, nunca a recorte JPEG
    if (String(f?.natureza_visual || '').toLowerCase() === 'equacao_puramente_tipografica') return false;
    if (!Array.isArray(f?.bbox) || f.bbox.length !== 4) return false;
    const [y1, x1, y2, x2] = f.bbox.map(Number);
    return Number.isFinite(y1) && Number.isFinite(x1) && (y2 - y1) >= 16 && (x2 - x1) >= 16;
  });

  const principaisRaw = validFiguras.filter(
    (f) => f.alvo === 'principal' || String(f.alvo || '').toLowerCase().startsWith('principal')
  );
  const alternativasRaw = validFiguras.filter((f) => /^alt_[A-E]$/i.test(String(f.alvo || '')));

  // Ordenação geométrica determinística: em 2 colunas, SEMPRE coluna esquerda (topo->base) antes da direita (topo->base)
  if (principaisRaw.length > 1) {
    principaisRaw.sort((a, b) => {
      if (layoutOrigem === 'duas_colunas' && colunaDivisaoX > 0) {
        const cxA = (Number(a.bbox[1]) + Number(a.bbox[3])) / 2;
        const cxB = (Number(b.bbox[1]) + Number(b.bbox[3])) / 2;
        const colA = a.coluna === 'esquerda' ? 0 : a.coluna === 'direita' ? 1 : (cxA < colunaDivisaoX ? 0 : 1);
        const colB = b.coluna === 'esquerda' ? 0 : b.coluna === 'direita' ? 1 : (cxB < colunaDivisaoX ? 0 : 1);
        if (colA !== colB) return colA - colB;
        return Number(a.bbox[0]) - Number(b.bbox[0]);
      }
      const ordA = Number(a.ordem) || 99;
      const ordB = Number(b.ordem) || 99;
      if (ordA !== ordB) return ordA - ordB;
      return Number(a.bbox[0]) - Number(b.bbox[0]);
    });
  }

  // Remove eventuais caixas duplicadas sobrepostas (IoU > 0.80)
  const principaisUnicas = [];
  for (const fig of principaisRaw) {
    const boxNum = fig.bbox.map(Number);
    const duplicada = principaisUnicas.some((prev) => bboxIoU(prev.bbox, boxNum) > 0.8);
    if (!duplicada) {
      const cx = (boxNum[1] + boxNum[3]) / 2;
      const colInferida = layoutOrigem === 'duas_colunas'
        ? (fig.coluna === 'esquerda' || fig.coluna === 'direita' ? fig.coluna : (cx < colunaDivisaoX ? 'esquerda' : 'direita'))
        : 'unica';
      principaisUnicas.push({
        ...fig,
        bbox: boxNum,
        coluna: colInferida,
      });
    }
  }

  let sharedOriginalUrl = null;

  if (principaisUnicas.length > 0) {
    try {
      const usarScannerClean = principaisUnicas.some((f) => Boolean(f.foto_papel_cinza));
      const posicaoSugerida = principaisUnicas[0]?.posicao_sugerida || 'entre_enunciado_e_comando';
      const legendas = principaisUnicas.map((f) => String(f.legenda_original || '').trim()).filter(Boolean);

      const procPrincipal = await processarMidiaQuestao(fileBuffer, {
        bboxes: principaisUnicas.map((f) => ({
          bbox: f.bbox,
          coluna: f.coluna,
          coluna_divisao_x: colunaDivisaoX,
          continuacao_quebra_coluna: Boolean(f.continuacao_quebra_coluna),
        })),
        layoutOrigem,
        colunaDivisaoX,
        composicaoLayout: 'auto',
        autoTrim: true,
        scannerClean: usarScannerClean,
        keepOriginal: true,
        posicao: posicaoSugerida,
        legenda: legendas.join(' · '),
        credito: dados.fonte || '',
      });

      midiaPrincipal = procPrincipal.midia;
      sharedOriginalUrl = procPrincipal.midia.original_url;
    } catch (cropErr) {
      console.warn('[visionExtractor] Falha ao compor figura(s) principal(is):', cropErr.message);
    }
  }

  for (const fig of alternativasRaw) {
    try {
      const procAlt = await processarMidiaQuestao(fileBuffer, {
        bbox: fig.bbox.map(Number),
        colunaDivisaoX,
        layoutOrigem,
        autoTrim: true,
        scannerClean: Boolean(fig.foto_papel_cinza),
        keepOriginal: !sharedOriginalUrl,
        existingOriginalUrl: sharedOriginalUrl,
        posicao: 'entre_enunciado_e_comando',
      });
      sharedOriginalUrl = procAlt.midia.original_url;
      const letra = String(fig.alvo).split('_')[1].toUpperCase();
      midiasAlternativas[letra] = procAlt.url;
    } catch (altErr) {
      console.warn('[visionExtractor] Falha ao recortar figura de alternativa:', altErr.message);
    }
  }

  // Normaliza alternativas (injetando imagem por alternativa se detectada)
  const gabaritoUpper = String(dados.gabarito_letra || '').toUpperCase().trim();
  const alternativas = Array.isArray(dados.alternativas)
    ? dados.alternativas.map((a, idx) => {
        const letra = String(a.letra || String.fromCharCode(65 + idx)).toUpperCase().trim();
        return {
          id: Date.now() + idx,
          letra,
          texto: String(a.texto || '').trim(),
          imagem_url: midiasAlternativas[letra] || null,
          correta: Boolean(gabaritoUpper && letra === gabaritoUpper),
        };
      })
    : [];

  // Monta estrutura_json canônica conforme o modelo detectado
  const tipo = [
    'objetiva', 'afirmativas', 'verdadeiro_falso',
    'associacao', 'lacuna', 'discursiva', 'somatoria',
  ].includes(dados.tipo) ? dados.tipo : 'objetiva';

  const estrutura = montarEstruturaInicialExtraida(tipo, dados);

  return {
    ok: true,
    layout_origem: layoutOrigem,
    tipo,
    disciplina: DISCIPLINAS_OFICIAIS.includes(dados.disciplina) ? dados.disciplina : '',
    serie: SERIES_OFICIAIS.includes(dados.serie) ? dados.serie : '',
    nivel: ['facil', 'medio', 'dificil', 'enem'].includes(dados.nivel) ? dados.nivel : 'medio',
    fonte: dados.fonte || '',
    fonte_confirmada: Boolean(dados.fonte_confirmada),
    habilidade_bncc: String(dados.habilidade_bncc || '').toUpperCase().trim(),
    temas: Array.isArray(dados.temas) ? dados.temas.filter(Boolean).slice(0, 5) : [],
    tags: Array.isArray(dados.tags) ? dados.tags.filter(Boolean).slice(0, 6) : [],
    texto_apoio: dados.texto_apoio || '',
    enunciado: tipo === 'lacuna' && dados.texto_lacunado ? dados.texto_lacunado : (dados.enunciado || ''),
    comando_final: dados.comando_final || '',
    alternativas,
    estrutura_json: estrutura,
    midia: midiaPrincipal,
    imagem_url: midiaPrincipal?.url || null,
    resposta_aberta: dados.resposta_aberta || '',
    gabarito: gabaritoUpper || null,
    gabarito_origem: dados.gabarito_origem === 'marcado_na_imagem' ? 'marcado_na_imagem' : 'resolvido_pela_ia',
    explicacao: dados.resolucao_passo_a_passo || '',
    confianca: ['alta', 'media', 'baixa'].includes(dados.confianca) ? dados.confianca : 'alta',
  };
}

function montarEstruturaInicialExtraida(tipo, dados) {
  switch (tipo) {
    case 'afirmativas':
      return {
        modelo: 'afirmativas',
        proposicoes: (dados.proposicoes_romanas || []).map((p, i) => ({
          id: i + 1,
          romano: p.romano || ['I', 'II', 'III', 'IV', 'V'][i] || String(i + 1),
          texto: p.texto || '',
          correta: Boolean(p.correta),
        })),
        comando_fechamento: dados.comando_fechamento_afirmativas || 'É correto apenas o que se afirma em:',
      };

    case 'verdadeiro_falso':
      return {
        modelo: 'verdadeiro_falso',
        submodo: dados.vf_submodo === 'sequencia' ? 'sequencia' : 'direto',
        rotulo: dados.vf_rotulo === 'CE' ? 'CE' : 'VF',
        exigir_justificativa_falsas: false,
        linhas_justificativa: 3,
        itens: (dados.itens_vf || []).map((it, i) => ({
          id: i + 1,
          texto: it.texto || '',
          gabarito: ['V', 'F', 'C', 'E'].includes(String(it.gabarito || '').toUpperCase())
            ? String(it.gabarito).toUpperCase()
            : 'V',
        })),
      };

    case 'associacao':
      return {
        modelo: 'associacao',
        submodo: dados.assoc_submodo === 'sequencia' ? 'sequencia' : 'direto',
        titulo_coluna_a: 'Coluna A',
        titulo_coluna_b: 'Coluna B',
        coluna_a: (dados.coluna_a || []).map((c, i) => ({
          id: i + 1,
          codigo: String(c.codigo || i + 1),
          texto: c.texto || '',
        })),
        coluna_b: (dados.coluna_b || []).map((c, i) => ({
          id: 101 + i,
          texto: c.texto || '',
          vinculo_codigo: String(c.vinculo_codigo || ''),
        })),
      };

    case 'lacuna': {
      const textoBase = dados.texto_lacunado || dados.enunciado || '';
      const matches = [...textoBase.matchAll(/\{\{([^}]+)\}\}/g)].map((m) => m[1].trim()).filter(Boolean);
      return {
        modelo: 'lacuna',
        submodo: ['direto', 'banco_palavras', 'alternativas'].includes(dados.lacuna_submodo)
          ? dados.lacuna_submodo
          : 'direto',
        lacunas: matches,
        distratores_banco: Array.isArray(dados.distratores_banco) ? dados.distratores_banco.filter(Boolean) : [],
      };
    }

    case 'somatoria': {
      const props = (dados.proposicoes_somatoria || []).map((p, i) => {
        const val = Number(p.valor) || (1 << i);
        return {
          valor: val,
          codigo: String(val).padStart(2, '0'),
          texto: p.texto || '',
          correta: Boolean(p.correta),
        };
      });
      const soma = props.reduce((acc, p) => acc + (p.correta ? p.valor : 0), 0);
      return {
        modelo: 'somatoria',
        proposicoes: props,
        soma_correta: soma || Number(dados.soma_correta) || 0,
      };
    }

    case 'discursiva':
      return {
        modelo: 'discursiva',
        formato_espaco: dados.formato_espaco_discursiva === 'quadro_calculo' ? 'quadro_calculo' : 'linhas',
        linhas_resposta: Number(dados.linhas_resposta_sugeridas) || 6,
        altura_quadro_px: 140,
      };

    default:
      return {
        modelo: 'objetiva',
        layout_alternativas: 'lista',
      };
  }
}

/**
 * Copiloto Pedagógico para a Montagem Guiada (sugestão de BNCC/Temas, distratores, resolução e LaTeX).
 */
export async function executarCopilotoQuestao(acao, payload = {}) {
  const genAI = getGemini();

  if (acao === 'sugerir_metadados') {
    const model = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: SchemaType.OBJECT,
          properties: {
            disciplina: { type: SchemaType.STRING },
            serie: { type: SchemaType.STRING },
            nivel: { type: SchemaType.STRING },
            habilidade_bncc: { type: SchemaType.STRING },
            temas: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
            tags: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
          },
          required: ['disciplina', 'serie', 'nivel', 'habilidade_bncc', 'temas', 'tags'],
        },
        temperature: 0.2,
      },
    });
    const prompt = `Classifique pedagogicamente a questão abaixo seguindo estritamente:
- disciplina: uma entre [${DISCIPLINAS_OFICIAIS.join(', ')}]
- serie: uma entre [${SERIES_OFICIAIS.join(', ')}]
- nivel: facil | medio | dificil | enem
- habilidade_bncc: código oficial BNCC mais aderente (ex: EF08CI07, EM13MAT302)
- temas: 2 a 4 temas específicos do currículo
- tags: 3 a 5 palavras-chave curtas

ENUNCIADO: ${payload.enunciado || ''}
COMANDO: ${payload.comando_final || ''}
ITENS/ALTERNATIVAS: ${JSON.stringify(payload.alternativas || payload.estrutura_json || '')}`;

    const res = await model.generateContent(prompt);
    return sanitizarObjetoIA(JSON.parse(res.response.text()));
  }

  if (acao === 'gerar_distratores') {
    const model = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: SchemaType.OBJECT,
          properties: {
            distratores: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
            explicacao: { type: SchemaType.STRING },
          },
          required: ['distratores', 'explicacao'],
        },
        temperature: 0.45,
      },
    });
    const prompt = `Você é especialista em avaliação educacional (TRI/ENEM).
Dado o enunciado e a alternativa CORRETA abaixo, gere 4 distratores (alternativas incorretas) altamente plausíveis, baseados em erros conceituais ou algébricos reais dos estudantes, no mesmo tamanho e estilo gramatical da resposta correta. Use sempre $...$ ao redor de fórmulas LaTeX quando aplicável. Gere também a resolução comentada.

DISCIPLINA: ${payload.disciplina || ''}
ENUNCIADO: ${payload.enunciado || ''} ${payload.comando_final || ''}
RESPOSTA CORRETA: ${payload.resposta_correta || ''}`;

    const res = await model.generateContent(prompt);
    return sanitizarObjetoIA(JSON.parse(res.response.text()));
  }

  if (acao === 'resolver_e_comentar') {
    const model = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: SchemaType.OBJECT,
          properties: {
            resolucao_comentada: { type: SchemaType.STRING },
            resposta_aberta_espelho: { type: SchemaType.STRING },
            gabarito_sugerido: { type: SchemaType.STRING },
          },
          required: ['resolucao_comentada', 'resposta_aberta_espelho', 'gabarito_sugerido'],
        },
        temperature: 0.2,
      },
    });
    const prompt = `Resolva rigorosamente passo a passo a questão abaixo para servir de gabarito comentado ao professor (envolva toda expressão matemática ou química em $...$). Se for questão discursiva, preencha também "resposta_aberta_espelho" com os critérios objetivos de correção.

TIPO: ${payload.tipo || 'objetiva'}
ENUNCIADO: ${payload.enunciado || ''}
COMANDO: ${payload.comando_final || ''}
ESTRUTURA / ALTERNATIVAS: ${JSON.stringify(payload.alternativas || payload.estrutura_json || '')}`;

    const res = await model.generateContent(prompt);
    return sanitizarObjetoIA(JSON.parse(res.response.text()));
  }

  if (acao === 'converter_latex') {
    const model = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: SchemaType.OBJECT,
          properties: {
            texto_formatado: { type: SchemaType.STRING },
          },
          required: ['texto_formatado'],
        },
        temperature: 0.1,
      },
    });
    const prompt = `Reescreva o texto educacional abaixo preservando 100% das palavras em português, mas convertendo todas as expressões matemáticas, físicas ou fórmulas químicas informais (ex: "x^2 + 3x/4 = raiz(2)", "H2SO4", "10^-5 m/s^2") para notação LaTeX limpa entre cifrões ($...$). Não altere o sentido do texto.

TEXTO:
${payload.texto || ''}`;

    const res = await model.generateContent(prompt);
    return sanitizarObjetoIA(JSON.parse(res.response.text()));
  }

  throw new Error(`Ação de copiloto desconhecida: ${acao}`);
}
