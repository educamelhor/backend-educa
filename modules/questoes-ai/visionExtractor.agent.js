// modules/questoes-ai/visionExtractor.agent.js
// EDUCA.STUDIO AI — Agentes Multimodais Especializados (Gemini 2.5 Flash)
// 1. Vision Extractor + Bounding Box Detector (Clonagem de Print/Foto nos 7 modelos)
// 2. Solver & Classifier Agent (Resolução passo a passo, verificação de gabarito, BNCC e Temas)
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

// ── Schema Estrito para Extração Multimodal (7 Modelos + Bounding Box) ──────
const EXTRACTION_SCHEMA = {
  type: SchemaType.OBJECT,
  properties: {
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
      description: 'Texto principal do enunciado que vem ANTES da figura principal (ou enunciado completo caso não haja texto pós-figura). Sem número inicial da questão.',
    },
    comando_final: {
      type: SchemaType.STRING,
      description: 'Comando que aparece IMEDIATAMENTE ABAIXO da figura e antes das alternativas/itens (ex: "Considerando a figura acima, assinale..."). Vazio se não houver.',
    },
    figuras: {
      type: SchemaType.ARRAY,
      description: 'Ilustrações, gráficos, tirinhas, estruturas químicas, mapas ou tabelas não-textuais presentes na imagem.',
      items: {
        type: SchemaType.OBJECT,
        properties: {
          alvo: {
            type: SchemaType.STRING,
            description: 'principal | alt_A | alt_B | alt_C | alt_D | alt_E',
          },
          bbox: {
            type: SchemaType.ARRAY,
            items: { type: SchemaType.INTEGER },
            description: 'Coordenadas exatas [ymin, xmin, ymax, xmax] de 0 a 1000 englobando APENAS a ilustração/figura, excluindo parágrafos de texto do enunciado e alternativas.',
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
        required: ['alvo', 'bbox', 'posicao_sugerida', 'foto_papel_cinza'],
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
      description: 'Resolução comentada rigorosa e didática passo a passo, usando $...$ para expressões matemáticas LaTeX.',
    },
    confianca: {
      type: SchemaType.STRING,
      description: 'alta | media | baixa',
    },
  },
  required: [
    'tipo', 'disciplina', 'nivel', 'temas', 'enunciado',
    'gabarito_origem', 'resolucao_passo_a_passo', 'confianca',
  ],
};

/**
 * Extrai, classifica, resolve e recorta automaticamente figuras de um print/foto de questão.
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

1. MODELO DA QUESTÃO (campo "tipo"):
   - "objetiva": múltipla escolha clássica (A–D ou A–E).
   - "afirmativas": possui proposições em algarismos romanos (I, II, III...) seguidas de alternativas ("Apenas I e II", etc.). Separe as proposições em "proposicoes_romanas", o comando de fechamento em "comando_fechamento_afirmativas" e as opções A–E em "alternativas".
   - "verdadeiro_falso": julgamento de assertivas (V/F ou C/E). Se não houver alternativas A–E abaixo, use vf_submodo="direto"; se houver alternativas com a sequência (ex: V - F - V), use vf_submodo="sequencia" e preencha também "alternativas".
   - "associacao": duas colunas para relacionar/numerar (Coluna A × Coluna B). Preencha "coluna_a" e "coluna_b" com "vinculo_codigo" correto.
   - "lacuna": frases para completar espaços em branco. Em "texto_lacunado", escreva a frase substituindo cada lacuna por {{resposta_correta}}.
   - "somatoria": proposições numeradas em potências de 2 (01, 02, 04, 08, 16...) cuja resposta é a soma.
   - "discursiva": questão aberta sem alternativas (use formato_espaco_discursiva="quadro_calculo" se exigir conta/desenho ou "linhas" se textual).

2. FIDELIDADE ESPACIAL E FÓRMULAS:
   - Remova numeração inicial da prova original (ex: "04.", "Questão 12 -") e remova a sigla da banca do início do enunciado colocando-a em "fonte" (ex: "(UECE)" -> fonte: "UECE").
   - NUNCA invente banca em "fonte": se não houver sigla/cabeçalho nem for questão pública amplamente reconhecida, deixe "fonte": "" e "fonte_confirmada": false.
   - Use notação LaTeX inline entre cifrões ($...$) para TODAS as fórmulas matemáticas, frações ($\\frac{a}{b}$), raízes ($\\sqrt{x}$), potências ($10^{-3}$), vetores e fórmulas químicas ($\\text{H}_2\\text{O}$).
   - ATENÇÃO CRÍTICA À POSIÇÃO DA FIGURA: Se houver texto antes da figura (ex: "Atente à representação química:") e texto depois da figura (ex: "Considerando a figura acima, assinale a afirmação verdadeira."), coloque a primeira parte em "enunciado" e a parte pós-figura em "comando_final"!

3. DETECÇÃO E RECORTE DE FIGURAS ("figuras"):
   - Se a imagem contiver qualquer ilustração, gráfico, tirinha, circuito, estrutura química, mapa ou esquema visual, retorne-a em "figuras" com bbox [ymin, xmin, ymax, xmax] (escala inteira 0 a 1000).
   - O bbox DEVE envolver APENAS a figura/gráfico/ilustração (incluindo rótulos dos eixos da própria figura), SEM incluir as linhas de texto digitado do enunciado acima nem as alternativas abaixo!
   - Se a questão for 100% texto puro sem nenhuma figura/ilustração, retorne "figuras": [].

4. GABARITO E RESOLUÇÃO PASSO A PASSO:
   - Se o print já trouxer marcação clara de gabarito oficial (impressa ou destacada inequivocamente como gabarito), defina gabarito_origem="marcado_na_imagem" (mas confira matematicamente se uma marcação à caneta de aluno está certa; se for rascunho errado de aluno, corrija e use gabarito_origem="resolvido_pela_ia"!).
   - Se não houver gabarito marcado, resolva rigorosamente passo a passo em "resolucao_passo_a_passo" e defina gabarito_origem="resolvido_pela_ia".`;

  const imagePart = {
    inlineData: {
      data: fileBuffer.toString('base64'),
      mimeType,
    },
  };

  const result = await model.generateContent([prompt, imagePart]);
  const rawText = result.response.text().trim();
  const dados = JSON.parse(rawText);

  // ── Processamento independente das figuras detectadas via Sharp -> DO Spaces ──
  let midiaPrincipal = null;
  const midiasAlternativas = {};

  const figuras = Array.isArray(dados.figuras) ? dados.figuras : [];
  if (figuras.length > 0) {
    // Salva o print original apenas uma vez para permitir re-crop interativo no frontend
    let sharedOriginalUrl = null;

    for (const fig of figuras) {
      if (!Array.isArray(fig.bbox) || fig.bbox.length !== 4) continue;
      const [y1, x1, y2, x2] = fig.bbox.map(Number);
      if ((y2 - y1) < 20 || (x2 - x1) < 20) continue;

      try {
        const proc = await processarMidiaQuestao(fileBuffer, {
          bbox: [y1, x1, y2, x2],
          autoTrim: true,
          scannerClean: Boolean(fig.foto_papel_cinza),
          keepOriginal: !sharedOriginalUrl,
          existingOriginalUrl: sharedOriginalUrl,
          posicao: fig.posicao_sugerida || 'entre_enunciado_e_comando',
          legenda: fig.legenda_original || '',
          credito: dados.fonte || '',
        });
        sharedOriginalUrl = proc.midia.original_url;

        if (fig.alvo === 'principal' && !midiaPrincipal) {
          midiaPrincipal = proc.midia;
        } else if (/^alt_[A-E]$/i.test(fig.alvo)) {
          const letra = fig.alvo.split('_')[1].toUpperCase();
          midiasAlternativas[letra] = proc.url;
        }
      } catch (cropErr) {
        console.warn('[visionExtractor] Falha ao recortar figura:', cropErr.message);
      }
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
    return JSON.parse(res.response.text());
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
Dado o enunciado e a alternativa CORRETA abaixo, gere 4 distratores (alternativas incorretas) altamente plausíveis, baseados em erros conceituais ou algébricos reais dos estudantes, no mesmo tamanho e estilo gramatical da resposta correta. Use $...$ para fórmulas LaTeX quando aplicável. Gere também a resolução comentada.

DISCIPLINA: ${payload.disciplina || ''}
ENUNCIADO: ${payload.enunciado || ''} ${payload.comando_final || ''}
RESPOSTA CORRETA: ${payload.resposta_correta || ''}`;

    const res = await model.generateContent(prompt);
    return JSON.parse(res.response.text());
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
    const prompt = `Resolva rigorosamente passo a passo a questão abaixo para servir de gabarito comentado ao professor (use $...$ para LaTeX). Se for questão discursiva, preencha também "resposta_aberta_espelho" com os critérios objetivos de correção.

TIPO: ${payload.tipo || 'objetiva'}
ENUNCIADO: ${payload.enunciado || ''}
COMANDO: ${payload.comando_final || ''}
ESTRUTURA / ALTERNATIVAS: ${JSON.stringify(payload.alternativas || payload.estrutura_json || '')}`;

    const res = await model.generateContent(prompt);
    return JSON.parse(res.response.text());
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
    return JSON.parse(res.response.text());
  }

  throw new Error(`Ação de copiloto desconhecida: ${acao}`);
}
