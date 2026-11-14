// modules/questoes-ai/visionExtractor.agent.js
// EDUCA.STUDIO AI — Agentes Multimodais Especializados (Gemini 2.5 Flash)
// 1. Vision Extractor + Column-Aware Multi-BBox Detector (Clonagem 1 ou 2 Colunas nos 7 modelos)
// 2. Solver & Classifier Agent (Resolução passo a passo c/ blindagem LaTeX, BNCC e Temas)
// 3. Pedagogical Copilot Agent (Distratores, LaTeX, Metadados e Espelho de Correção)

import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';
import { processarMidiaQuestao } from './smartMediaEngine.js';

const PREFERENCIA_MODELOS_GEMINI = [
  'gemini-2.5-flash',
  'gemini-3-flash-preview',
  'gemini-3.8-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite-preview',
  'gemini-2.5-pro',
  'gemini-3.1-pro-preview',
];

const FALLBACK_ESTATICO_GEMINI = [
  'gemini-2.5-flash',
  'gemini-3-flash-preview',
  'gemini-3.8-flash',
  'gemini-3.5-flash-lite',
];

const ANTI_RECITACAO_INSTRUCAO = [
  'DIRETRIZ TÉCNICA DE ESTRUTURAÇÃO PEDAGÓGICA (CONTORNO DE FALSO-POSITIVO RECITATION):',
  '1. O professor titular enviou a imagem de sua própria folha de avaliação escolar para catalogação estruturada no banco da escola.',
  '2. Em "texto_apoio" e "textos_apoio_compartilhados", se houver excerto jornalístico, literário ou acadêmico extenso (> 45 palavras), insira quebras de linha ("\\n") entre os períodos/frases e preserve a citação da fonte/autor ao final.',
  '3. Redija OBRIGATORIAMENTE os campos "resolucao_passo_a_passo", "temas" e "tags" com síntese didática autoral e palavras 100% próprias.',
  '4. Responda EXCLUSIVAMENTE com o objeto JSON válido solicitado, sem texto antes ou depois.',
].join('\n');

let _modelosCache = { key: '', expiraEm: 0, lista: null, inflight: null };

/**
 * Descobre dinamicamente via /v1beta/models quais modelos Gemini com suporte a generateContent
 * estão ativos no projeto atual (cache de 6h em RAM), eliminando erros 404 por modelos aposentados.
 */
async function obterCascataModelosAtivos(apiKey) {
  if (!apiKey) return FALLBACK_ESTATICO_GEMINI;
  const agora = Date.now();
  if (_modelosCache.lista && _modelosCache.key === apiKey && agora < _modelosCache.expiraEm) {
    return _modelosCache.lista;
  }
  if (_modelosCache.inflight && _modelosCache.key === apiKey) {
    return _modelosCache.inflight;
  }

  const promise = (async () => {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}&pageSize=100`;
      const resp = await fetch(url, { signal: AbortSignal.timeout(4000) });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      const rawModels = Array.isArray(data?.models) ? data.models : [];

      const disponiveis = new Set();
      for (const m of rawModels) {
        const id = String(m?.name || '').replace(/^models\//, '').trim();
        const methods = Array.isArray(m?.supportedGenerationMethods) ? m.supportedGenerationMethods : [];
        if (!id || !methods.includes('generateContent')) continue;
        if (/tts|image|imagen|veo|embedding|aqa|robotics|computer-use|live|audio|gemma|learnlm/i.test(id)) continue;
        if (!id.startsWith('gemini-')) continue;
        disponiveis.add(id);
      }

      if (disponiveis.size === 0) return FALLBACK_ESTATICO_GEMINI;

      const ordenados = PREFERENCIA_MODELOS_GEMINI.filter((id) => disponiveis.has(id));
      if (ordenados.length < 4) {
        const extras = [...disponiveis]
          .filter((id) => !ordenados.includes(id) && !/gemini-1\.|gemini-2\.0/i.test(id))
          .sort((a, b) => {
            const score = (s) => (s.includes('flash') ? 0 : 1) + (s.includes('exp') ? 2 : 0);
            return score(a) - score(b);
          });
        for (const ex of extras) {
          if (ordenados.length >= 4) break;
          ordenados.push(ex);
        }
      }

      const listaFinal = ordenados.length > 0 ? ordenados.slice(0, 4) : FALLBACK_ESTATICO_GEMINI;
      _modelosCache = { key: apiKey, expiraEm: Date.now() + 6 * 3600 * 1000, lista: listaFinal, inflight: null };
      return listaFinal;
    } catch (err) {
      console.warn('[visionExtractor] Aviso ao listar /v1beta/models, usando cascata padrão:', err?.message);
      _modelosCache = { key: apiKey, expiraEm: Date.now() + 10 * 60 * 1000, lista: FALLBACK_ESTATICO_GEMINI, inflight: null };
      return FALLBACK_ESTATICO_GEMINI;
    }
  })();

  _modelosCache = { ..._modelosCache, key: apiKey, inflight: promise };
  return promise;
}

export const DISCIPLINAS_OFICIAIS = [
  'Português', 'Matemática', 'Ciências', 'História', 'Geografia',
  'Inglês', 'Artes', 'Educação Física', 'Biologia', 'Física',
  'Química', 'Sociologia', 'Filosofia', 'Redação', 'PD',
];

export const SERIES_OFICIAIS = [
  '6º Ano EF', '7º Ano EF', '8º Ano EF', '9º Ano EF',
  '1º EM', '2º EM', '3º EM', 'Ensino Superior',
];

let _gemini = null;
let _geminiKeyCached = null;
function getGeminiOrNull() {
  const key = (process.env.GEMINI_API_KEY || '').trim();
  if (!key) return null;
  if (!_gemini || _geminiKeyCached !== key) {
    _gemini = new GoogleGenerativeAI(key);
    _geminiKeyCached = key;
  }
  return _gemini;
}

function getOpenAIKeyOrNull() {
  const key = (process.env.OPENAI_API_KEY || '').trim();
  return key || null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Impõe timeout rígido com AbortController sobre chamadas SDK (evita sockets HTTP/2 meio-abertos
 * na API do Gemini travarem indefinidamente sem acionar failover para o próximo modelo).
 */
function comTimeoutRigido(promiseFactory, timeoutMs, label) {
  const ac = new AbortController();
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      try { ac.abort(); } catch { /* ignore */ }
      const err = new Error(`Timeout de ${Math.round(timeoutMs / 1000)}s excedido no socket de ${label}`);
      err.status = 504;
      reject(err);
    }, timeoutMs);
  });

  return Promise.race([promiseFactory(ac.signal), timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Repara escapes LaTeX inválidos dentro de strings JSON (ex: "\cdot", "\sin", "\alpha", "\leq")
 * e cercas markdown ```json ... ``` antes do JSON.parse, evitando erro 500 por SyntaxError.
 */
export function parseJsonResilienteIA(rawText) {
  let cleaned = String(rawText || '').trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

  // Caso haja texto lixo antes da primeira chave '{'/'[' ou depois da última '}'/']'
  const firstBrace = cleaned.indexOf('{');
  const firstBracket = cleaned.indexOf('[');
  const useBracket = firstBracket >= 0 && (firstBrace < 0 || firstBracket < firstBrace);
  if (useBracket) {
    const lastBracket = cleaned.lastIndexOf(']');
    if (lastBracket > firstBracket) cleaned = cleaned.slice(firstBracket, lastBracket + 1);
  } else if (firstBrace >= 0) {
    const lastBrace = cleaned.lastIndexOf('}');
    if (lastBrace > firstBrace) cleaned = cleaned.slice(firstBrace, lastBrace + 1);
  }

  try {
    return JSON.parse(cleaned);
  } catch {
    let repaired = '';
    let inStr = false;
    for (let i = 0; i < cleaned.length; i++) {
      const ch = cleaned[i];
      if (!inStr) {
        if (ch === '"') inStr = true;
        repaired += ch;
        continue;
      }
      if (ch === '"') {
        inStr = false;
        repaired += ch;
        continue;
      }
      if (ch === '\n') { repaired += '\\n'; continue; }
      if (ch === '\r') { repaired += '\\r'; continue; }
      if (ch === '\t') { repaired += '\\t'; continue; }
      if (ch === '\\') {
        const nxt = cleaned[i + 1] || '';
        if ('"\\/bfnrt'.includes(nxt)) {
          repaired += '\\' + nxt;
          i++;
          continue;
        }
        if (nxt === 'u' && /^[0-9a-fA-F]{4}$/.test(cleaned.slice(i + 2, i + 6))) {
          repaired += cleaned.slice(i, i + 6);
          i += 5;
          continue;
        }
        repaired += '\\\\';
        continue;
      }
      repaired += ch;
    }
    return JSON.parse(repaired);
  }
}

/**
 * Executa geração estruturada JSON com cascata dinâmica de modelos Gemini ativos,
 * recuperação automática contra bloqueios RECITATION e fallback OpenAI Vision/JSON.
 */
export async function gerarJsonComFailover({
  contents,
  promptTextOnly = '',
  imagePart = null,
  responseSchema = null,
  temperature = 0.15,
  openAiJsonHint = '',
  maxOutputTokens = 8192,
  timeoutMs = 55000,
  thinkingBudget = 1536,
  onProgress = null,
}) {
  const genAI = getGeminiOrNull();
  const openAIKey = getOpenAIKeyOrNull();
  const geminiKey = (process.env.GEMINI_API_KEY || '').trim();

  if (!genAI && !openAIKey) {
    throw new Error('GEMINI_API_KEY não configurada no ambiente.');
  }

  const errosTentativas = [];
  const cascataModelos = genAI ? await obterCascataModelosAtivos(geminiKey) : [];

  if (genAI && cascataModelos.length > 0) {
    let abortGemini = false;
    for (let idxModelo = 0; idxModelo < cascataModelos.length; idxModelo++) {
      if (abortGemini) break;
      const nomeModelo = cascataModelos[idxModelo];
      if (idxModelo > 0 && typeof onProgress === 'function') {
        try { onProgress(`Alternando leitura para o modelo ${nomeModelo}...`); } catch { /* ignore */ }
      }

      let usarSchema = Boolean(responseSchema);
      let desativarThinking = false;
      let desativarTemperatura = false;
      let modoAntiRecitacao = false;
      let tentativasModelo = 0;

      while (tentativasModelo < 3) {
        tentativasModelo++;
        try {
          const generationConfig = {
            responseMimeType: modoAntiRecitacao ? 'text/plain' : 'application/json',
            maxOutputTokens,
          };
          if (!desativarTemperatura) {
            generationConfig.temperature = modoAntiRecitacao
              ? Math.max(0.65, Number(temperature) || 0.65)
              : temperature;
          }
          if (
            !desativarThinking &&
            Number.isFinite(thinkingBudget) &&
            (nomeModelo.startsWith('gemini-2.5') || nomeModelo.startsWith('gemini-3'))
          ) {
            generationConfig.thinkingConfig = { thinkingBudget };
          }

          const usarSchemaAgora = usarSchema && !modoAntiRecitacao && Boolean(responseSchema);
          if (usarSchemaAgora) {
            generationConfig.responseSchema = responseSchema;
          }

          let basePrompt = promptTextOnly;
          if (!usarSchemaAgora && openAiJsonHint) {
            basePrompt = `${basePrompt}\n\n${openAiJsonHint}`;
          }
          if (modoAntiRecitacao) {
            basePrompt = `${ANTI_RECITACAO_INSTRUCAO}\n\n${basePrompt}`;
          }

          let callContents = contents;
          if (!usarSchemaAgora || modoAntiRecitacao) {
            callContents = Array.isArray(contents)
              ? [basePrompt, ...contents.slice(1)]
              : basePrompt;
          }

          const model = genAI.getGenerativeModel({
            model: nomeModelo,
            generationConfig,
          });

          const perAttemptTimeoutMs = Math.min(Math.max(30000, Number(timeoutMs) || 68000), 75000);
          const result = await comTimeoutRigido(
            (signal) => model.generateContent(callContents, { timeout: perAttemptTimeoutMs, signal }),
            perAttemptTimeoutMs + 1500,
            nomeModelo
          );

          const finishReason = String(result?.response?.candidates?.[0]?.finishReason || '').toUpperCase();
          if (finishReason === 'RECITATION') {
            throw new Error('Candidate was blocked due to RECITATION');
          }

          const rawText = result?.response?.text?.() || '';
          if (!rawText.trim()) {
            throw new Error(`Resposta vazia do modelo ${nomeModelo} (finishReason=${finishReason || 'N/A'}).`);
          }
          const parsed = parseJsonResilienteIA(rawText);
          return { parsed, modeloUsado: nomeModelo };
        } catch (err) {
          const msg = String(err?.message || err || '');
          const status = err?.status || (msg.includes('429') ? 429 : msg.includes('503') ? 503 : msg.includes('404') ? 404 : msg.includes('400') ? 400 : 500);
          console.warn(
            `[visionExtractor] Falha no modelo ${nomeModelo} (tentativa=${tentativasModelo}, schema=${usarSchema && !modoAntiRecitacao}, antiRec=${modoAntiRecitacao}, status=${status}): ${msg.slice(0, 240)}`
          );

          // 1) Auto-recuperação imediata contra bloqueio RECITATION (citações de jornais/livros na prova)
          if (/RECITATION/i.test(msg) && !modoAntiRecitacao) {
            modoAntiRecitacao = true;
            usarSchema = false;
            if (typeof onProgress === 'function') {
              try { onProgress(`Citação literal longa detectada · Reprocessando em modo anti-recitação (${nomeModelo})...`); } catch { /* ignore */ }
            }
            continue;
          }

          // 2) Ajuste imediato caso o modelo rejeite thinkingConfig, temperature ou complexidade de schema (400)
          if (status === 400 && /thinking/i.test(msg) && !desativarThinking) {
            desativarThinking = true;
            continue;
          }
          if (status === 400 && /temperature/i.test(msg) && !desativarTemperatura) {
            desativarTemperatura = true;
            continue;
          }
          if (usarSchema && status === 400 && /schema|state|constraint|property/i.test(msg)) {
            usarSchema = false;
            continue;
          }

          errosTentativas.push({ modelo: nomeModelo, status, msg });

          if (/API_KEY_INVALID|API key not valid/i.test(msg)) {
            abortGemini = true;
            break;
          }
          if (status === 404) {
            _modelosCache.expiraEm = 0;
          }
          if (status === 503) {
            await sleep(650);
          }
          break; // avança para o próximo modelo da cascata
        }
      }
    }
  }

  // Fallback multi-provedor automático via OpenAI REST nativa (gpt-4o-mini) se OPENAI_API_KEY estiver configurada
  if (openAIKey) {
    try {
      if (typeof onProgress === 'function') {
        try { onProgress('Alternando leitura de contingência para OpenAI (gpt-4o-mini)...'); } catch { /* ignore */ }
      }
      const userContent = [];
      const fullPrompt = openAiJsonHint ? `${promptTextOnly}\n\n${openAiJsonHint}` : promptTextOnly;
      userContent.push({ type: 'text', text: fullPrompt });
      if (imagePart?.inlineData?.data) {
        userContent.push({
          type: 'image_url',
          image_url: {
            url: `data:${imagePart.inlineData.mimeType || 'image/png'};base64,${imagePart.inlineData.data}`,
            detail: 'high',
          },
        });
      }

      const oaResp = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${openAIKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          response_format: { type: 'json_object' },
          temperature,
          max_tokens: Math.min(16384, Math.max(4096, Number(maxOutputTokens) || 8192)),
          messages: [
            {
              role: 'system',
              content: 'Você é um extrator e solucionador educacional científico rigoroso. Responda estritamente em um único objeto JSON válido.',
            },
            {
              role: 'user',
              content: userContent,
            },
          ],
        }),
        signal: AbortSignal.timeout(Math.min(Math.max(35000, Number(timeoutMs) || 68000), 80000)),
      });

      if (!oaResp.ok) {
        const errBody = await oaResp.text().catch(() => '');
        throw new Error(`OpenAI HTTP ${oaResp.status}: ${errBody.slice(0, 180)}`);
      }
      const oaJson = await oaResp.json();
      const rawOpenAi = oaJson?.choices?.[0]?.message?.content || '';
      const parsed = parseJsonResilienteIA(rawOpenAi);
      console.log('[visionExtractor] Recuperado automaticamente via fallback OpenAI (gpt-4o-mini)!');
      return { parsed, modeloUsado: 'gpt-4o-mini (fallback)' };
    } catch (oaErr) {
      console.warn('[visionExtractor] Fallback OpenAI também falhou:', oaErr?.message);
      errosTentativas.push({ modelo: 'gpt-4o-mini', status: 500, msg: String(oaErr?.message || oaErr) });
    }
  }

  // Consolida diagnóstico claro e sem URLs técnicas cruas para o frontend
  const todosQuota = errosTentativas.length > 0 && errosTentativas.every((e) => e.status === 429 || /quota|exhausted|rate.?limit/i.test(e.msg));
  const algumQuota = errosTentativas.some((e) => e.status === 429 || /quota|exhausted|rate.?limit/i.test(e.msg));
  const todosOverload = errosTentativas.length > 0 && errosTentativas.every((e) => e.status === 503 || /overloaded|unavailable/i.test(e.msg));
  const algumRecitacao = errosTentativas.some((e) => /RECITATION/i.test(e.msg));
  const algumTimeout = errosTentativas.some((e) => e.status === 504 || /timeout|aborted/i.test(e.msg));
  const ultimo = errosTentativas[errosTentativas.length - 1];
  const modelosTestados = [...new Set(errosTentativas.map((e) => e.modelo).filter(Boolean))].join(', ');

  let msgLimpa;
  if (todosQuota || (algumQuota && ultimo?.status === 404)) {
    msgLimpa = 'Limite de cota da chave GEMINI_API_KEY atingido nos modelos disponíveis (429). Aguarde alguns instantes e tente novamente.';
  } else if (todosOverload) {
    msgLimpa = 'Os servidores de Visão Computacional estão temporariamente sobrecarregados (503). Tente novamente em alguns segundos.';
  } else if (algumRecitacao) {
    msgLimpa = `Filtro de direitos autorais da IA (RECITATION) acionado por citação literal extensa nesta página (${modelosTestados || 'IA'}). Reimporte apenas esta página.`;
  } else if (algumTimeout) {
    msgLimpa = `Tempo limite excedido na leitura de alta densidade desta página (${modelosTestados || 'IA'}). Reimporte apenas esta página.`;
  } else {
    const resumoUltimo = String(ultimo?.msg || 'erro inesperado')
      .replace(/\[GoogleGenerativeAI Error\]:\s*/gi, '')
      .replace(/Error fetching from https?:\/\/\S+/gi, 'Falha de comunicação com o modelo')
      .trim()
      .slice(0, 180);
    msgLimpa = `Falha no processamento multimodal (${ultimo?.modelo || 'IA'}): ${resumoUltimo}`;
  }

  const finalErr = new Error(msgLimpa);
  finalErr.httpStatus = todosQuota || (algumQuota && ultimo?.status === 404) ? 429 : todosOverload ? 503 : 500;
  finalErr.detail = errosTentativas.map((e) => `${e.modelo}: [${e.status}] ${e.msg.slice(0, 140)}`).join(' | ');
  throw finalErr;
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
        .replace(/([a-zà-ÿ])\|([a-zà-ÿ])/g, '$1$2')
        .replace(/([A-Za-zÀ-ÿ0-9)\]])\|(?=\s|$|[.,;:!?])/g, '$1')
        .replace(
          /(?:-\s*)?(?:(?:\\(?:text|mathrm|mathbf)\{[^{}]+\}|\\frac\{[^{}]+\}\{[^{}]+\}|\\sqrt\{[^{}]+\})(?:[_^](?:\{[^{}]+\}|[A-Za-z0-9+-]+))*)+(?:\s*(?:[-+=→⇌]|\\rightarrow)\s*(?:(?:\\(?:text|mathrm|mathbf)\{[^{}]+\}|\\frac\{[^{}]+\}\{[^{}]+\})(?:[_^](?:\{[^{}]+\}|[A-Za-z0-9+-]+))*)+)*/g,
          (match) => `$${match.trim()}$`
        );
    })
    .join('');

  return s;
}

export function sanitizarObjetoIA(val) {
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

export function bboxIoU(a, b) {
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

const BANCAS_OFICIAIS_RE = /\b(ENEM|FUVEST|UNICAMP|UNESP|UNB|PAS|CESPE|CEBRASPE|FGV|VUNESP|FCC|PUC|UFMG|UFRGS|UFPR|UFSC|UFPE|UFC|UECE|UERJ|UEMA|UFU|UFG|UFBA|UFPB|UFRN|UFAM|UFPA|UFMS|UFMT|ITA|IME|EPCAR|ESPCEX|AFA|OBMEP|OBA|OBF|OBQ|SAEB|SAEPE|SARESP|SPAECE|SIMAVE|PAEBES|PISA|IBGE|IPEA|ONU|OIM|OMS|UNESCO)\b/i;

/**
 * Remove falsas "fontes" capturadas de cabeçalhos/rodapés de cadernos escolares (ex: "HUMANAS-8ºANO", "1º BIMESTRE").
 */
export function limparFonteFalsaCaderno(rawFonte = '') {
  const s = String(rawFonte || '').trim();
  if (!s) return '';
  if (BANCAS_OFICIAIS_RE.test(s)) return s;
  if (
    /^(?:caderno|bloco|[aá]rea|prova|avalia[çc][aã]o|simulado|lista|atividade|exerc[ií]cios?|humanas|ci[êe]ncias(?:\s+humanas|\s+da\s+natureza)?|linguagens|matem[aá]tica|hist[oó]ria|geografia|portugu[êe]s|ingl[êe]s|artes|biologia|f[ií]sica|qu[ií]mica|ensino\s+(?:fundamental|m[eé]dio)|\d+[º°oª]?\s*(?:ano|s[eé]rie|bimestre|trimestre|semestre|em|ef))[\s\-–—_/.,:;()0-9º°ªa-zà-ÿ]*$/i.test(s) &&
    s.length <= 44
  ) {
    return '';
  }
  return s;
}

function normalizarComparacaoTexto(str = '') {
  return String(str || '')
    .replace(/[“”«»]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Elimina duplicação quando a IA copia a frase inicial da questão tanto em `texto_apoio` quanto em `enunciado`
 * (ex: Questão 11 "Se não têm pão, que comam brioches!").
 */
export function deduplicarTextoApoioEnunciado(textoApoioRaw = '', enunciadoRaw = '', opts = {}) {
  const { temIdCompartilhado = false, fonteLimpa = '' } = opts || {};
  const apoio = String(textoApoioRaw || '').trim();
  const enunc = String(enunciadoRaw || '').trim();
  if (!apoio || !enunc) return { textoApoio: apoio, enunciado: enunc };

  const apoioNorm = normalizarComparacaoTexto(apoio);
  const enuncNorm = normalizarComparacaoTexto(enunc);
  if (!apoioNorm || !enuncNorm) return { textoApoio: apoio, enunciado: enunc };

  if (apoioNorm === enuncNorm) {
    return temIdCompartilhado ? { textoApoio: apoio, enunciado: '' } : { textoApoio: '', enunciado: enunc };
  }

  if (apoioNorm.length >= 20 && enuncNorm.startsWith(apoioNorm)) {
    // Constrói regex tolerante a aspas/espaços/negrito para remover o prefixo duplicado do enunciado
    const palavras = apoio
      .replace(/[“”«»"‘’'*_]/g, ' ')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

    let restoEnunc = '';
    if (palavras.length > 0) {
      const prefixRe = new RegExp(
        `^[\\s“”«»"‘’'*_]*${palavras.join('[\\s“”«»"‘’\'*_]+')}[\\s“”«»"‘’'*_.,;:!?-]*`,
        'i'
      );
      restoEnunc = enunc.replace(prefixRe, '').trim();
    }

    const temReferenciaBibliografica =
      /\([^()\n]{10,}\)\s*\.?$/.test(apoio) ||
      /\b(?:dispon[ií]vel\s+em|acesso\s+em|adaptado\s+de|edi[çc][aã]o\s+\d+|in:\s+[A-ZÀ-Ÿ])/i.test(apoio);

    if ((temIdCompartilhado || Boolean(fonteLimpa) || temReferenciaBibliografica) && restoEnunc.length >= 12) {
      return { textoApoio: apoio, enunciado: restoEnunc };
    }
    return { textoApoio: '', enunciado: enunc };
  }

  if (enuncNorm.length >= 20 && apoioNorm.startsWith(enuncNorm) && !temIdCompartilhado && !fonteLimpa) {
    return { textoApoio: '', enunciado: apoio };
  }

  return { textoApoio: apoio, enunciado: enunc };
}

export function normalizarLetraAlternativa(rawLetra = '', fallbackIdx = 0) {
  const clean = String(rawLetra || '')
    .replace(/[^A-Za-z]/g, '')
    .toUpperCase()
    .slice(0, 1);
  return clean || String.fromCharCode(65 + fallbackIdx);
}

function extrairLetraGabaritoLimpa(rawGab = '', explicacao = '') {
  const s = String(rawGab || '').trim();
  if (s) {
    const mDireto = s.match(/^\(?([A-E])\)?[.)]?$/i) || s.match(/(?:alternativa|letra|op[çc][aã]o|gabarito)\s*\(?([A-E])\)?\b/i);
    if (mDireto) return mDireto[1].toUpperCase();
  }
  const exp = String(explicacao || '').slice(-340);
  if (exp) {
    const matches = [
      ...exp.matchAll(/(?:alternativa|op[çc][aã]o|letra|resposta(?:\s+correta)?|gabarito)\s*(?:correta\s*)?(?:[eé:]|\s)\s*\(?([A-E])\)?(?=[\s.,;:)!\n*]|$)/gi),
    ];
    if (matches.length > 0) {
      return matches[matches.length - 1][1].toUpperCase();
    }
  }
  return '';
}

/**
 * Reconcilia e infere deterministicamente a alternativa correta (A–E) a partir das proposições
 * julgadas (I, II, III... / V-F / Colunas), evitando que questões estruturadas fiquem sem letra marcada (ex: Q2).
 */
export function reconciliarGabaritoQuestao({
  tipo = 'objetiva',
  estrutura = {},
  alternativas = [],
  gabaritoLetraBruto = '',
  explicacao = '',
  comandoContexto = '',
}) {
  let letraInferidaEstrutura = '';

  if (Array.isArray(alternativas) && alternativas.length >= 2) {
    if (tipo === 'afirmativas') {
      const props = Array.isArray(estrutura?.proposicoes) ? estrutura.proposicoes : [];
      if (props.length >= 2) {
        const ctx = `${comandoContexto || ''} ${estrutura?.comando_fechamento || ''}`;
        const pedeIncorretas = /\b(incorreta|incorretas|falsa|falsas|errada|erradas|exceto)\b/i.test(ctx);
        const todosRomanos = props.map((p) => String(p.romano || '').toUpperCase().trim()).filter(Boolean);
        const alvoSet = new Set(
          props
            .filter((p) => Boolean(p.correta) === !pedeIncorretas)
            .map((p) => String(p.romano || '').toUpperCase().trim())
            .filter(Boolean)
        );

        const candidatas = [];
        for (const alt of alternativas) {
          const txtSemSeculo = String(alt.texto || '')
            .replace(/\*\*([^*]+)\*\*/g, '$1')
            .replace(/\bs[eé]culos?\s+[IVXLCDM]+\b/gi, ' ');
          let altSet = null;
          if (/\btodas\b/i.test(txtSemSeculo) && !/\bexceto\b/i.test(txtSemSeculo)) {
            altSet = new Set(todosRomanos);
          } else if (/\bnenhuma\b/i.test(txtSemSeculo)) {
            altSet = new Set();
          } else {
            const roms = [...txtSemSeculo.matchAll(/\b(I|II|III|IV|V|VI|VII|VIII)\b/g)].map((m) => m[1].toUpperCase());
            if (roms.length > 0) altSet = new Set(roms);
          }

          if (altSet && altSet.size === alvoSet.size && [...alvoSet].every((r) => altSet.has(r))) {
            candidatas.push(alt.letra);
          }
        }
        if (candidatas.length === 1) {
          letraInferidaEstrutura = candidatas[0];
        }
      }
    } else if (tipo === 'verdadeiro_falso' && estrutura?.submodo === 'sequencia') {
      const seqAlvo = (estrutura?.itens || []).map((i) => String(i.gabarito || '').toUpperCase().trim()).filter(Boolean);
      if (seqAlvo.length >= 2) {
        const candidatas = [];
        for (const alt of alternativas) {
          const tokens = [...String(alt.texto || '').toUpperCase().matchAll(/\b([VFCE])\b/g)].map((m) => m[1]);
          if (tokens.length === seqAlvo.length && tokens.every((t, k) => t === seqAlvo[k])) {
            candidatas.push(alt.letra);
          }
        }
        if (candidatas.length === 1) letraInferidaEstrutura = candidatas[0];
      }
    } else if (tipo === 'associacao' && estrutura?.submodo === 'sequencia') {
      const seqAlvo = (estrutura?.coluna_b || []).map((b) => String(b.vinculo_codigo || '').toUpperCase().trim()).filter(Boolean);
      if (seqAlvo.length >= 2) {
        const candidatas = [];
        for (const alt of alternativas) {
          const tokens = [...String(alt.texto || '').toUpperCase().matchAll(/[A-Z0-9]+/g)].map((m) => m[0]);
          if (tokens.length === seqAlvo.length && tokens.every((t, k) => t === seqAlvo[k])) {
            candidatas.push(alt.letra);
          }
        }
        if (candidatas.length === 1) letraInferidaEstrutura = candidatas[0];
      }
    }
  }

  const letraBrutaLimpa = extrairLetraGabaritoLimpa(gabaritoLetraBruto, explicacao);
  const letrasDisponiveis = new Set((alternativas || []).map((a) => a.letra));
  const letraFinal =
    (letraInferidaEstrutura && letrasDisponiveis.has(letraInferidaEstrutura) ? letraInferidaEstrutura : '') ||
    (letraBrutaLimpa && letrasDisponiveis.has(letraBrutaLimpa) ? letraBrutaLimpa : '') ||
    letraInferidaEstrutura ||
    letraBrutaLimpa ||
    '';

  const alternativasAtualizadas = Array.isArray(alternativas)
    ? alternativas.map((a) => ({
        ...a,
        correta: Boolean(letraFinal && a.letra === letraFinal),
      }))
    : [];

  return {
    gabarito: letraFinal || null,
    alternativas: alternativasAtualizadas,
  };
}

export function ehFiguraNaoGraficaIgnorada(fig) {
  const nat = String(fig?.natureza_visual || '').toLowerCase().trim();
  return (
    nat === 'equacao_puramente_tipografica' ||
    nat === 'texto_puro' ||
    nat === 'citacao_textual' ||
    nat === 'paragrafo_texto' ||
    nat === 'cabecalho_questao'
  );
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

2. FIDELIDADE ESPACIAL, DESTAQUES EM NEGRITO (**...**), EQUAÇÕES ($$...$$) E FONTES:
   - Remova numeração inicial da prova original (ex: "6.", "04.", "Questão 12 -") e remova a sigla de banca oficial do início do enunciado colocando-a em "fonte" (ex: "(UECE)" -> fonte: "UECE").
   - NUNCA invente banca em "fonte" e NUNCA use cabeçalhos/rodapés escolares genéricos (ex: "HUMANAS-8ºANO", "1º BIMESTRE", " HISTÓRIA ") como "fonte" — nesses casos deixe "fonte": "" e "fonte_confirmada": false.
   - PRESERVAÇÃO DE NEGRITO E ITÁLICO ORIGINAIS: quando uma frase, expressão ou pergunta dentro do enunciado, texto de apoio, proposições ou alternativas estiver impressa em **negrito** no original (ex: "...muito elevados. **Qual continente possui o crescimento demográfico mais intenso na atualidade?**" ou "Assinale a alternativa **INCORRETA**:"), preserve exatamente esse destaque usando duplo asterisco \`**trecho em negrito**\` (e \`*trecho*\` para itálico editorial relevante, como títulos de obras). NUNCA coloque o enunciado inteiro em negrito e não aplique negrito ao título removido "QUESTÃO X".
   - PROIBIDO DUPLICAR TEXTO ENTRE "texto_apoio" E "enunciado": se a questão começa diretamente com uma citação curta ou parágrafo introdutório sem bloco externo separado, mantenha o texto APENAS em "enunciado" (deixando "texto_apoio": ""). Se houver um texto-base separado real em "texto_apoio", NUNCA repita esse mesmo parágrafo no início de "enunciado"!
   - Ignore artefatos de interface de editores de texto (Word/Google Docs) em prints de tela, como barra vertical de cursor de digitação colada no fim de palavras ("meias-vidas|" -> transcreva "meias-vidas") e sublinhados ondulados de corretor ortográfico.
   - Use notação LaTeX inline SEMPRE envolvida por cifrões simples ($...$) para variáveis ($m_0$, $f(x)$), frações inline ($\\frac{a}{b}$), raízes ($\\sqrt{x}$), potências ($10^{-3}$), setas ($\\rightarrow$) e fórmulas químicas lineares ($\\text{H}_2\\text{O}$, $\\text{CH}_3$). NUNCA escreva \\text{} ou _0 fora de $...$!
   - EQUAÇÕES EM DESTAQUE E LEGENDAS DE VARIÁVEIS NÃO SÃO FIGURAS: quando a questão apresentar uma função/equação centralizada em destaque (ex: $f(x) = \\frac{m_0}{2^x}$), sistema linear, matriz ou definições de variáveis (ex: "$x \\rightarrow$ quantidade de meias-vidas", "$m_0 \\rightarrow$ massa inicial", "$f(x) \\rightarrow$ massa final"), NUNCA recorte isso em "figuras" (retorne "figuras": [] se não houver ilustração gráfica real!). Transcreva a equação centralizada usando cifrão duplo \`$$...$$\` em linha própria dentro de "enunciado" (ex: \`\\n$$f(x) = \\\\frac{m_0}{2^x}$$\\n\`) seguida em linhas separadas (\`\\n\`) de TODAS as linhas de legenda/significado das variáveis sem omitir nenhuma!
   - Separe o texto que vem ANTES das figuras reais em "enunciado", e o comando/pergunta de fechamento em "comando_final".

3. DETECÇÃO COMPLETA E RECORTE INTEGRAL MULTI-FIGURA ("figuras"):
   - Retorne em "figuras" SOMENTE blocos visuais genuinamente gráficos/ilustrativos: gravuras históricas, fotografias, esquemas biológicos/físicos, gráficos com eixos, desenhos geométricos, estruturas químicas 2D com ligações desenhadas (traços/anéis), circuitos, tirinhas, charges, mapas ou tabelas visuais complexas. NUNCA inclua citações em texto puro, parágrafos introdutórios, faixas de título "QUESTÃO X" nem equações algébricas tipográficas em "figuras"!
   - Se a questão possuir 2 ou 3 regiões visuais gráficas separadas (ex: um esquema de membrana celular na coluna esquerda + fórmulas estruturais 2D de aminoácidos no rodapé esquerdo e/ou topo da coluna direita), retorne UM ITEM SEPARADO em "figuras" (com alvo="principal") para CADA região visual!
   - Se na virada da coluna esquerda para a coluna direita uma MESMA fórmula estrutural 2D ou tabela foi partida ao meio (ex: cadeia principal —N—C—C— no rodapé da coluna esquerda e radicais |CH3 alanina, serina, aspartato no topo da coluna direita), retorne o bbox da metade no rodapé esquerdo (coluna="esquerda", continuacao_quebra_coluna=false) E o bbox da metade no topo direito (coluna="direita", continuacao_quebra_coluna=true)!
   - RECORTE 100% INTEGRAL (DO TOPO À BASE DA ILUSTRAÇÃO): em cada bbox [ymin, xmin, ymax, xmax] (0 a 1000), garanta que \`ymin\` comece ACIMA da borda superior completa da gravura/desenho/foto (nunca corte cabeças de personagens ou metade superior de gravuras!) e que \`ymax\` vá até o limite inferior completo da imagem/rótulos periféricos, sem invadir parágrafos de texto nem ultrapassar "coluna_divisao_x" para a coluna vizinha.
   - Se a questão contiver apenas texto e equações matemáticas/químicas tipográficas sem desenho/gráfico/estrutura 2D, retorne OBRIGATORIAMENTE "figuras": [].

4. GABARITO OBRIGATÓRIO E RESOLUÇÃO PASSO A PASSO:
   - Sempre que houver "alternativas" (inclusive em questões do tipo "afirmativas" com itens I, II, III, IV, "verdadeiro_falso" em sequência ou "associacao" em sequência), preencha OBRIGATORIAMENTE "gabarito_letra" ("A", "B", "C", "D" ou "E") com a letra exata da alternativa correspondente aos itens corretos!
   - Se o print trouxer gabarito oficial inequívoco destacado, use gabarito_origem="marcado_na_imagem".
   - Caso contrário, resolva com rigor científico passo a passo (quebrando linhas entre Passo 1, Passo 2, Conclusão) em "resolucao_passo_a_passo" e defina gabarito_origem="resolvido_pela_ia".`;

  const imagePart = {
    inlineData: {
      data: fileBuffer.toString('base64'),
      mimeType,
    },
  };

  const openAiSchemaHint = `ESTRUTURA EXATA DO OBJETO JSON DE RESPOSTA:
{
  "layout_origem": "coluna_unica" | "duas_colunas",
  "coluna_divisao_x": 0,
  "tipo": "objetiva" | "afirmativas" | "verdadeiro_falso" | "associacao" | "lacuna" | "discursiva" | "somatoria",
  "disciplina": "uma entre [${DISCIPLINAS_OFICIAIS.join(', ')}]",
  "serie": "uma entre [${SERIES_OFICIAIS.join(', ')}]",
  "nivel": "facil" | "medio" | "dificil" | "enem",
  "fonte": "",
  "fonte_confirmada": false,
  "habilidade_bncc": "",
  "temas": ["..."],
  "tags": ["..."],
  "texto_apoio": "",
  "enunciado": "...",
  "comando_final": "",
  "figuras": [{ "alvo": "principal", "natureza_visual": "esquema_cientifico", "ordem": 1, "coluna": "unica", "continuacao_quebra_coluna": false, "bbox": [ymin, xmin, ymax, xmax], "posicao_sugerida": "entre_enunciado_e_comando", "legenda_original": "", "foto_papel_cinza": false }],
  "alternativas": [{ "letra": "A", "texto": "..." }],
  "proposicoes_romanas": [{ "romano": "I", "texto": "...", "correta": true }],
  "comando_fechamento_afirmativas": "",
  "vf_submodo": "direto" | "sequencia",
  "vf_rotulo": "VF" | "CE",
  "itens_vf": [{ "texto": "...", "gabarito": "V" }],
  "assoc_submodo": "direto" | "sequencia",
  "coluna_a": [{ "codigo": "1", "texto": "..." }],
  "coluna_b": [{ "texto": "...", "vinculo_codigo": "1" }],
  "lacuna_submodo": "direto" | "banco_palavras" | "alternativas",
  "texto_lacunado": "",
  "distratores_banco": [],
  "proposicoes_somatoria": [{ "valor": 1, "codigo": "01", "texto": "...", "correta": true }],
  "soma_correta": 0,
  "formato_espaco_discursiva": "linhas" | "quadro_calculo",
  "linhas_resposta_sugeridas": 6,
  "resposta_aberta": "",
  "gabarito_letra": "A",
  "gabarito_origem": "marcado_na_imagem" | "resolvido_pela_ia",
  "resolucao_passo_a_passo": "...",
  "confianca": "alta" | "media" | "baixa"
}`;

  const { parsed: rawParsed, modeloUsado } = await gerarJsonComFailover({
    contents: [prompt, imagePart],
    promptTextOnly: prompt,
    imagePart,
    responseSchema: EXTRACTION_SCHEMA,
    temperature: 0.15,
    openAiJsonHint: openAiSchemaHint,
  });
  const dados = sanitizarObjetoIA(rawParsed);

  // ── Processamento independente das figuras detectadas (1 ou 2 colunas) via Sharp -> DO Spaces ──
  let midiaPrincipal = null;
  const midiasAlternativas = {};

  const layoutOrigem = dados.layout_origem === 'duas_colunas' ? 'duas_colunas' : 'coluna_unica';
  const colunaDivisaoX = layoutOrigem === 'duas_colunas'
    ? (Number(dados.coluna_divisao_x) >= 300 && Number(dados.coluna_divisao_x) <= 700 ? Number(dados.coluna_divisao_x) : 500)
    : 0;

  const fonteLimpa = limparFonteFalsaCaderno(dados.fonte);

  const figurasRaw = Array.isArray(dados.figuras) ? dados.figuras : [];
  const validFiguras = figurasRaw.filter((f) => {
    // Trava determinística v2.3: equações tipográficas, citações textuais e cabeçalhos nunca viram recorte JPEG
    if (ehFiguraNaoGraficaIgnorada(f)) return false;
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
        credito: fonteLimpa,
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

  // Monta estrutura_json canônica conforme o modelo detectado
  const tipo = [
    'objetiva', 'afirmativas', 'verdadeiro_falso',
    'associacao', 'lacuna', 'discursiva', 'somatoria',
  ].includes(dados.tipo) ? dados.tipo : 'objetiva';

  const estrutura = montarEstruturaInicialExtraida(tipo, dados);

  const enunciadoBruto = tipo === 'lacuna' && dados.texto_lacunado ? dados.texto_lacunado : (dados.enunciado || '');
  const { textoApoio: textoApoioLimpo, enunciado: enunciadoLimpo } = deduplicarTextoApoioEnunciado(
    dados.texto_apoio || '',
    enunciadoBruto,
    { temIdCompartilhado: false, fonteLimpa }
  );

  // Normaliza alternativas e reconcilia deterministicamente o gabarito (ex: proposições I–IV -> letra D)
  const alternativasBase = Array.isArray(dados.alternativas)
    ? dados.alternativas.map((a, idx) => {
        const letra = normalizarLetraAlternativa(a.letra, idx);
        return {
          id: Date.now() + idx,
          letra,
          texto: String(a.texto || '').trim(),
          imagem_url: midiasAlternativas[letra] || null,
          correta: false,
        };
      })
    : [];

  const { gabarito: gabaritoReconciliado, alternativas } = reconciliarGabaritoQuestao({
    tipo,
    estrutura,
    alternativas: alternativasBase,
    gabaritoLetraBruto: dados.gabarito_letra,
    explicacao: dados.resolucao_passo_a_passo,
    comandoContexto: `${enunciadoLimpo} ${dados.comando_final || ''}`,
  });

  return {
    ok: true,
    modelo_ia: modeloUsado,
    layout_origem: layoutOrigem,
    tipo,
    disciplina: DISCIPLINAS_OFICIAIS.includes(dados.disciplina) ? dados.disciplina : '',
    serie: SERIES_OFICIAIS.includes(dados.serie) ? dados.serie : '',
    nivel: ['facil', 'medio', 'dificil', 'enem'].includes(dados.nivel) ? dados.nivel : 'medio',
    fonte: fonteLimpa,
    fonte_confirmada: Boolean(fonteLimpa && dados.fonte_confirmada),
    habilidade_bncc: String(dados.habilidade_bncc || '').toUpperCase().trim(),
    temas: Array.isArray(dados.temas) ? dados.temas.filter(Boolean).slice(0, 5) : [],
    tags: Array.isArray(dados.tags) ? dados.tags.filter(Boolean).slice(0, 6) : [],
    texto_apoio: textoApoioLimpo,
    enunciado: enunciadoLimpo,
    comando_final: dados.comando_final || '',
    alternativas,
    estrutura_json: estrutura,
    midia: midiaPrincipal,
    imagem_url: midiaPrincipal?.url || null,
    resposta_aberta: dados.resposta_aberta || '',
    gabarito: gabaritoReconciliado,
    gabarito_origem: dados.gabarito_origem === 'marcado_na_imagem' ? 'marcado_na_imagem' : 'resolvido_pela_ia',
    explicacao: dados.resolucao_passo_a_passo || '',
    confianca: ['alta', 'media', 'baixa'].includes(dados.confianca) ? dados.confianca : 'alta',
  };
}

export function montarEstruturaInicialExtraida(tipo, dados) {
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
  if (acao === 'sugerir_metadados') {
    const schema = {
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
    };
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

    const { parsed } = await gerarJsonComFailover({
      contents: prompt,
      promptTextOnly: prompt,
      responseSchema: schema,
      temperature: 0.2,
      openAiJsonHint: 'Retorne JSON com as chaves: disciplina, serie, nivel, habilidade_bncc, temas (array), tags (array).',
    });
    return sanitizarObjetoIA(parsed);
  }

  if (acao === 'gerar_distratores') {
    const schema = {
      type: SchemaType.OBJECT,
      properties: {
        distratores: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
        explicacao: { type: SchemaType.STRING },
      },
      required: ['distratores', 'explicacao'],
    };
    const prompt = `Você é especialista em avaliação educacional (TRI/ENEM).
Dado o enunciado e a alternativa CORRETA abaixo, gere 4 distratores (alternativas incorretas) altamente plausíveis, baseados em erros conceituais ou algébricos reais dos estudantes, no mesmo tamanho e estilo gramatical da resposta correta. Use sempre $...$ ao redor de fórmulas LaTeX quando aplicável. Gere também a resolução comentada.

DISCIPLINA: ${payload.disciplina || ''}
ENUNCIADO: ${payload.enunciado || ''} ${payload.comando_final || ''}
RESPOSTA CORRETA: ${payload.resposta_correta || ''}`;

    const { parsed } = await gerarJsonComFailover({
      contents: prompt,
      promptTextOnly: prompt,
      responseSchema: schema,
      temperature: 0.45,
      openAiJsonHint: 'Retorne JSON com as chaves: distratores (array de 4 strings), explicacao (string).',
    });
    return sanitizarObjetoIA(parsed);
  }

  if (acao === 'resolver_e_comentar') {
    const schema = {
      type: SchemaType.OBJECT,
      properties: {
        resolucao_comentada: { type: SchemaType.STRING },
        resposta_aberta_espelho: { type: SchemaType.STRING },
        gabarito_sugerido: { type: SchemaType.STRING },
      },
      required: ['resolucao_comentada', 'resposta_aberta_espelho', 'gabarito_sugerido'],
    };
    const prompt = `Resolva rigorosamente passo a passo a questão abaixo para servir de gabarito comentado ao professor (envolva toda expressão matemática ou química em $...$). Se for questão discursiva, preencha também "resposta_aberta_espelho" com os critérios objetivos de correção.

TIPO: ${payload.tipo || 'objetiva'}
ENUNCIADO: ${payload.enunciado || ''}
COMANDO: ${payload.comando_final || ''}
ESTRUTURA / ALTERNATIVAS: ${JSON.stringify(payload.alternativas || payload.estrutura_json || '')}`;

    const { parsed } = await gerarJsonComFailover({
      contents: prompt,
      promptTextOnly: prompt,
      responseSchema: schema,
      temperature: 0.2,
      openAiJsonHint: 'Retorne JSON com as chaves: resolucao_comentada, resposta_aberta_espelho, gabarito_sugerido.',
    });
    return sanitizarObjetoIA(parsed);
  }

  if (acao === 'converter_latex') {
    const schema = {
      type: SchemaType.OBJECT,
      properties: {
        texto_formatado: { type: SchemaType.STRING },
      },
      required: ['texto_formatado'],
    };
    const prompt = `Reescreva o texto educacional abaixo preservando 100% das palavras em português, mas convertendo todas as expressões matemáticas, físicas ou fórmulas químicas informais (ex: "x^2 + 3x/4 = raiz(2)", "H2SO4", "10^-5 m/s^2") para notação LaTeX limpa entre cifrões ($...$). Não altere o sentido do texto.

TEXTO:
${payload.texto || ''}`;

    const { parsed } = await gerarJsonComFailover({
      contents: prompt,
      promptTextOnly: prompt,
      responseSchema: schema,
      temperature: 0.1,
      openAiJsonHint: 'Retorne JSON com a chave: texto_formatado (string).',
    });
    return sanitizarObjetoIA(parsed);
  }

  throw new Error(`Ação de copiloto desconhecida: ${acao}`);
}
