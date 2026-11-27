// api/routes/alunos.js

import express from "express";
import multer from "multer";
import pdfParse from "pdf-parse/lib/pdf-parse.js";
import pool from "../db.js";
import fs from "fs";
import path, { dirname as _dirname } from "path";
import { fileURLToPath } from "url";
import XLSX from "xlsx";
import { getInativos } from "../controllers/alunosController.js";
import { calcularEUpsertBonusMedia } from "./relatorio-disciplinar.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = _dirname(__filename);

const router = express.Router();

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Helper: ano letivo padrÃ£o com data de corte em 31/jan
// (se mÃªs <= 1 â†’ ano anterior; senÃ£o â†’ ano corrente)
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function anoLetivoPadrao() {
  const hoje = new Date();
  const mes = hoje.getMonth() + 1; // 1â€“12
  return mes <= 1 ? hoje.getFullYear() - 1 : hoje.getFullYear();
}

// Base pÃºblica do Spaces (sem depender do front â€œadivinharâ€ a URL)
// Ex.: https://nyc3.digitaloceanspaces.com/educa-melhor-uploads/
const SPACES_PUBLIC_BASE = String(
  process.env.SPACES_PUBLIC_BASE || "https://nyc3.digitaloceanspaces.com/educa-melhor-uploads/"
).replace(/\/+$/, "") + "/";

/*
 * Middleware local (defensivo) para garantir escola no req.user
 * OBS: O router jÃ¡ Ã© protegido por autenticaÃ§Ã£o + verificarEscola no server.js,
 * mas mantemos aqui para endpoints que o utilizam diretamente.
 */
function verificarEscola(req, res, next) {
  if (!req.user || !req.user.escola_id) {
    return res.status(403).json({ message: "Acesso negado: escola nÃ£o definida." });
  }
  next();
}

/*
 * Middleware de Governança: valida a chave 'secretaria.importa_alunos'
 * Direção tem permissão nata; Secretaria (e demais perfis não-direção) depende
 * de 'secretaria.importa_alunos' !== '0' em configuracoes_escola (default = '1').
 */
async function verificarGovernancaImportacaoAlunos(req, res, next) {
  const escolaId = Number(req.user?.escola_id || 0);
  if (!escolaId) {
    return res.status(403).json({ status: "erro", ok: false, message: "Acesso negado: escola não definida." });
  }

  const perfil = String(req.user?.perfil || "").toLowerCase().trim();
  const perfisDirecao = new Set([
    "diretor",
    "direcao",
    "vice_diretor",
    "admin",
    "administrador",
    "ceo",
    "super_admin",
    "admin_global",
  ]);
  if (perfisDirecao.has(perfil)) {
    return next();
  }

  try {
    const [[cfgRow]] = await pool.query(
      `SELECT valor FROM configuracoes_escola
       WHERE escola_id = ? AND chave = 'secretaria.importa_alunos'
       LIMIT 1`,
      [escolaId]
    );
    const val = cfgRow?.valor !== undefined && cfgRow?.valor !== null
      ? String(cfgRow.valor).toLowerCase().trim()
      : "1";

    if (val === "0" || val === "false") {
      return res.status(403).json({
        status: "erro",
        ok: false,
        message: "Acesso negado: a importação de alunos via planilha/lista pela Secretaria está desativada na Governança da escola.",
      });
    }
    return next();
  } catch (err) {
    console.warn("[alunos/importar] Aviso ao consultar secretaria.importa_alunos:", err.message);
    return next();
  }
}

// -----------------------------------------------------------------------------
// Governança de Nome Social (Resolução CNE/CP nº 1/2018 · Decreto DF nº 37.982/2017)
// - `nome_registro`: preserva o nome civil de registro do estudante.
// - `usa_nome_social` (0|1) e `nome_social`: controlam o uso de Nome Social.
// - `estudante`: reflete automaticamente o Nome Social quando ativo, garantindo
//   que 100% das listas online/impressas, diários, chamadas, boletins e app
//   exibam e ordenem pelo Nome Social sem expor o nome civil.
// -----------------------------------------------------------------------------
let _nomeSocialSchemaPromise = null;
let _alunosCodigoEhInt32 = true;

export function sanitizarCpfEstudante(rawCpf) {
  const texto = String(rawCpf ?? "").trim();
  if (!texto) return { ok: true, value: null };
  const digitos = texto.replace(/\D/g, "");
  if (!digitos || /^0+$/.test(digitos)) return { ok: true, value: null };
  if (digitos.length !== 11) {
    return {
      ok: false,
      message: "CPF do estudante inválido: informe os 11 dígitos numéricos ou deixe o campo em branco.",
    };
  }
  return { ok: true, value: digitos };
}

export function sanitizarDataNascimentoIso(rawData) {
  const texto = String(rawData ?? "").trim();
  if (!texto) return { ok: true, value: null };

  let ano;
  let mes;
  let dia;

  const mIso = texto.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s].*)?$/);
  const mBr = !mIso ? texto.match(/^(\d{2})\/(\d{2})\/(\d{4})$/) : null;

  if (mIso) {
    ano = Number(mIso[1]);
    mes = Number(mIso[2]);
    dia = Number(mIso[3]);
  } else if (mBr) {
    dia = Number(mBr[1]);
    mes = Number(mBr[2]);
    ano = Number(mBr[3]);
  } else {
    return { ok: false, message: "Data de nascimento inválida." };
  }

  const anoMax = new Date().getFullYear() + 1;
  if (ano < 1900 || ano > anoMax || mes < 1 || mes > 12 || dia < 1 || dia > 31) {
    return { ok: false, message: "Data de nascimento inválida." };
  }
  const dt = new Date(Date.UTC(ano, mes - 1, dia));
  if (
    dt.getUTCFullYear() !== ano ||
    dt.getUTCMonth() + 1 !== mes ||
    dt.getUTCDate() !== dia
  ) {
    return { ok: false, message: "Data de nascimento inválida." };
  }

  return {
    ok: true,
    value: `${String(ano).padStart(4, "0")}-${String(mes).padStart(2, "0")}-${String(dia).padStart(2, "0")}`,
  };
}

export function sanitizarCodigoReEstudante(rawCodigo, codigoEhInt32 = _alunosCodigoEhInt32) {
  const bruto = String(rawCodigo ?? "").trim();
  if (!bruto) {
    return { ok: false, message: "Informe o RE (Registro Estudantil) do estudante." };
  }
  const limpo = bruto.replace(/[.\-\s/]/g, "");
  if (!limpo) {
    return { ok: false, message: "Informe o RE (Registro Estudantil) do estudante." };
  }

  if (codigoEhInt32) {
    if (!/^\d+$/.test(limpo)) {
      return {
        ok: false,
        message: "RE (Registro Estudantil) inválido: informe apenas os dígitos numéricos do código do estudante.",
      };
    }
    const num = Number(limpo);
    if (!Number.isSafeInteger(num) || num <= 0 || num > 2147483647) {
      return {
        ok: false,
        message: "RE (Registro Estudantil) inválido ou fora da faixa permitida (informe o código RE do EducaDF, não o CPF).",
      };
    }
    return { ok: true, value: String(num) };
  }

  return { ok: true, value: limpo.slice(0, 30) };
}

function ensureNomeSocialReady() {
  if (!_nomeSocialSchemaPromise) {
    _nomeSocialSchemaPromise = (async () => {
      try {
        const [cols] = await pool.query(`
          SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH
            FROM INFORMATION_SCHEMA.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE()
             AND TABLE_NAME = 'alunos'
             AND COLUMN_NAME IN ('codigo', 'estudante', 'cpf', 'nome_registro', 'usa_nome_social', 'nome_social', 'atendimento_diferencial', 'anees')
        `);
        const colMap = new Map(cols.map((c) => [c.COLUMN_NAME, c]));
        const exist = new Set(cols.map((c) => c.COLUMN_NAME));

        const colCodigo = colMap.get("codigo");
        if (colCodigo) {
          const dt = String(colCodigo.DATA_TYPE || "").toLowerCase();
          _alunosCodigoEhInt32 = ["int", "mediumint", "smallint", "tinyint"].includes(dt);
        }

        const alters = [];
        const colEstudante = colMap.get("estudante");
        if (colEstudante && Number(colEstudante.CHARACTER_MAXIMUM_LENGTH || 0) > 0 && Number(colEstudante.CHARACTER_MAXIMUM_LENGTH) < 255) {
          alters.push(`MODIFY COLUMN estudante VARCHAR(255) DEFAULT NULL`);
        }
        if (!exist.has("cpf")) {
          alters.push(`ADD COLUMN cpf VARCHAR(14) DEFAULT NULL`);
        } else {
          const colCpf = colMap.get("cpf");
          if (colCpf && Number(colCpf.CHARACTER_MAXIMUM_LENGTH || 0) > 0 && Number(colCpf.CHARACTER_MAXIMUM_LENGTH) < 14) {
            alters.push(`MODIFY COLUMN cpf VARCHAR(14) DEFAULT NULL`);
          }
        }
        if (!exist.has("atendimento_diferencial")) {
          alters.push(`ADD COLUMN atendimento_diferencial TINYINT(1) NOT NULL DEFAULT 0`);
        }
        if (!exist.has("anees")) {
          alters.push(`ADD COLUMN anees TEXT DEFAULT NULL`);
        }
        if (!exist.has("nome_registro")) {
          alters.push(`ADD COLUMN nome_registro VARCHAR(255) DEFAULT NULL AFTER estudante`);
        }
        if (!exist.has("usa_nome_social")) {
          alters.push(`ADD COLUMN usa_nome_social TINYINT(1) NOT NULL DEFAULT 0`);
        }
        if (!exist.has("nome_social")) {
          alters.push(`ADD COLUMN nome_social VARCHAR(255) DEFAULT NULL`);
        }
        if (alters.length > 0) {
          await pool.query(`ALTER TABLE alunos ${alters.join(", ")}`);
        }
        await pool.query(`
          UPDATE alunos
             SET nome_registro = estudante
           WHERE nome_registro IS NULL OR TRIM(nome_registro) = ''
        `);

        // Auto-saneamento cirúrgico de registros legados onde `alunos.anees` recebeu
        // indevidamente Nome de Responsável / Filiação / Endereço / Outras Informações
        // em importações anteriores ou linhas CSV deslocadas.
        try {
          const [poluidosCandidatos] = await pool.query(`
            SELECT a.id,
                   a.estudante,
                   a.nome_registro,
                   a.nome_social,
                   a.anees,
                   a.atendimento_diferencial,
                   GROUP_CONCAT(DISTINCT r.nome SEPARATOR '|||') AS nomes_responsaveis,
                   (SELECT COUNT(*) FROM aee_laudos al WHERE al.aluno_id = a.id) AS qtd_laudos,
                   (SELECT COUNT(*) FROM aee_alunos_config cfg WHERE cfg.aluno_id = a.id) AS qtd_cfg
              FROM alunos a
              LEFT JOIN responsaveis_alunos ra ON ra.aluno_id = a.id
              LEFT JOIN responsaveis r ON r.id = ra.responsavel_id
             WHERE a.anees IS NOT NULL AND TRIM(a.anees) <> ''
             GROUP BY a.id
          `);

          const idsLimparApenasTexto = [];
          const idsLimparTextoEAee = [];

          for (const row of poluidosCandidatos) {
            const listaResp = String(row.nomes_responsaveis || "")
              .split("|||")
              .map((s) => s.trim())
              .filter(Boolean);
            const valido = ehValorAneesLegitimo(row.anees, {
              estudante: row.estudante,
              nomeRegistro: row.nome_registro,
              nomeSocial: row.nome_social,
              responsaveis: listaResp,
            });
            if (!valido) {
              const possuiVinculoSalaRecursos =
                Number(row.qtd_laudos || 0) > 0 || Number(row.qtd_cfg || 0) > 0;
              if (possuiVinculoSalaRecursos) {
                idsLimparApenasTexto.push(row.id);
              } else {
                idsLimparTextoEAee.push(row.id);
              }
            }
          }

          if (idsLimparApenasTexto.length > 0) {
            await pool.query(`UPDATE alunos SET anees = NULL WHERE id IN (?)`, [
              idsLimparApenasTexto,
            ]);
          }
          if (idsLimparTextoEAee.length > 0) {
            await pool.query(
              `UPDATE alunos SET anees = NULL, atendimento_diferencial = 0 WHERE id IN (?)`,
              [idsLimparTextoEAee]
            );
          }
          if (idsLimparApenasTexto.length > 0 || idsLimparTextoEAee.length > 0) {
            console.log(
              `[alunos] Saneamento automático de anees concluído: ${idsLimparTextoEAee.length} limpo(s) integralmente, ${idsLimparApenasTexto.length} preservando Sala de Recursos.`
            );
          }
        } catch (sanErr) {
          console.warn("[alunos] Aviso ao sanear anees legado:", sanErr.message);
        }
      } catch (e) {
        console.warn("[alunos] ensureNomeSocialReady warning:", e.message);
      }
    })();
  }
  return _nomeSocialSchemaPromise;
}

function registrarChavesNomeAluno(map, aluno, normFn) {
  for (const raw of [aluno?.estudante, aluno?.nome_registro, aluno?.nome_social]) {
    const k = normFn(raw);
    if (k && !map.has(k)) map.set(k, aluno);
  }
}

function nomeCorrespondeAoAluno(nomeEntrada, aluno, normFn) {
  const alvo = normFn(nomeEntrada);
  if (!alvo) return false;
  return (
    normFn(aluno?.estudante) === alvo ||
    normFn(aluno?.nome_registro) === alvo ||
    normFn(aluno?.nome_social) === alvo
  );
}

// -----------------------------------------------------------------------------
// Motor de Busca Inteligente de Alunos (Secretaria / Disciplinar / Biblioteca)
// Resolve com precisão cirúrgica:
//   1. Turmas exatas ("6º ANO A", "6° ANO A", "6 ANO A", "6A", "1ª SÉRIE B", códigos SEEDF)
//      sem falsos positivos entre letras de turmas ("6º ANO A" nunca vaza para "6º ANO G")
//   2. Grupos de série/ano ("6º ANO", "6º", "1ª SÉRIE", "ANO A")
//   3. Turnos ("VESPERTINO", "MATUTINO", "NOTURNO", "INTEGRAL" e prefixos >= 4 letras)
//   4. Combinações Turma + Turno ("2º ANO B NOTURNO") e Nome + Turma/Turno ("ANA 6º ANO C")
//   5. Nome de Registro, Nome Social e Nome de Exibição (termos contíguos ou não contíguos
//      sempre dentro do MESMO campo de nome, impedindo vazamento entre colunas)
//   6. RE (código), CPF (com ou sem pontuação), Data de Nascimento (DD/MM/AAAA ou ISO),
//      Ano e atalhos combináveis ("inativo"/"inativos"/"000000", "aee", "nome social")
// -----------------------------------------------------------------------------
function escapeSqlLike(str) {
  return String(str || "").replace(/[\\%_]/g, "\\$&");
}

function normalizarTextoFiltroAluno(str) {
  return String(str || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/(\d)\s*[º°ª]/g, "$1")
    .replace(/[º°ª]/g, " ")
    .replace(/[^a-z0-9_]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

const TURNOS_CANONICOS = ["matutino", "vespertino", "noturno", "integral"];

function detectarTurnoToken(tokenNorm) {
  const t = String(tokenNorm || "").replace(/_/g, "").trim();
  if (t.length < 4) return null;
  for (const turno of TURNOS_CANONICOS) {
    if (turno.startsWith(t)) return turno;
  }
  return null;
}

function indexarTurmasEscolaParaBusca(turmasRows = []) {
  return (turmasRows || []).map((t) => {
    const nomeNorm = normalizarTextoFiltroAluno(t.nome)
      .replace(/_/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const oficialNorm = normalizarTextoFiltroAluno(t.nome_oficial);
    const oficialSpaced = oficialNorm.replace(/_/g, " ").replace(/\s+/g, " ").trim();
    const turnoNorm = normalizarTextoFiltroAluno(t.turno).replace(/_/g, " ").trim();

    const aliasesExatos = new Set();
    if (nomeNorm) aliasesExatos.add(nomeNorm);
    if (oficialNorm) aliasesExatos.add(oficialNorm);
    if (oficialSpaced) aliasesExatos.add(oficialSpaced);

    // Ex.: "6 ano a", "1 serie b", "3 ano unico", "2 serie a"
    const mPadrao = nomeNorm.match(
      /^(\d+)\s+(?:ano|serie|etapa|segmento|bloco|periodo|termo|em|ef)(?:\s+[a-z]+)*\s+([a-z0-9]{1,4})$/
    );
    if (mPadrao) {
      const [, num, sufixo] = mPadrao;
      aliasesExatos.add(`${num} ${sufixo}`);
      aliasesExatos.add(`${num}${sufixo}`);
    }

    // Caso a turma esteja cadastrada de forma curta no banco (ex.: "6A" ou "6º A")
    const mCurta = nomeNorm.match(/^(\d+)\s*([a-z])$/);
    if (mCurta) {
      const [, num, letra] = mCurta;
      aliasesExatos.add(`${num} ${letra}`);
      aliasesExatos.add(`${num}${letra}`);
      aliasesExatos.add(`${num} ano ${letra}`);
      aliasesExatos.add(`${num} serie ${letra}`);
    }

    return {
      id: Number(t.id),
      nomeRaw: String(t.nome || ""),
      nomeNorm,
      oficialNorm,
      turnoNorm,
      aliasesExatos,
    };
  });
}

function resolverTurmasPorFrase(fraseSpaced, fraseComUnderscore, rawTeveOrdinal, turmasIdx) {
  if (!fraseSpaced) {
    return { matchedIds: null, especificaInexistente: false };
  }

  // 1. Match exato de turma (ex.: "6 ano a", "6a", "ef_6_v_a")
  const exatas = turmasIdx.filter(
    (ti) =>
      ti.aliasesExatos.has(fraseSpaced) ||
      (fraseComUnderscore && ti.aliasesExatos.has(fraseComUnderscore))
  );
  if (exatas.length > 0) {
    return {
      matchedIds: exatas.map((h) => h.id),
      especificaInexistente: false,
    };
  }

  // 2. Designação explícita de turma específica que não existe nesta escola (ex.: "6º ANO I" quando só há A..H)
  const ehTurmaEspecifica =
    /^\d+\s+(?:ano|serie|etapa|segmento|bloco|periodo|termo|em|ef)\s+[a-z0-9]{1,3}$/.test(fraseSpaced) ||
    (rawTeveOrdinal && /^\d+\s*[a-z]$/.test(fraseSpaced));
  if (ehTurmaEspecifica) {
    return { matchedIds: [], especificaInexistente: true };
  }

  // 3. Match de grupo de turmas (ex.: "6º ANO", "1ª SÉRIE", "ANO A", "6º", "EJA")
  const palavras = fraseSpaced.split(" ").filter(Boolean);
  if (palavras.length >= 2) {
    const grupo = turmasIdx.filter(
      (ti) => ti.nomeNorm && ` ${ti.nomeNorm} `.includes(` ${fraseSpaced} `)
    );
    if (grupo.length > 0) {
      return { matchedIds: grupo.map((h) => h.id), especificaInexistente: false };
    }
    if (/^\d+\s+(?:ano|serie|etapa|segmento|bloco|periodo|termo)$/.test(fraseSpaced)) {
      return { matchedIds: [], especificaInexistente: true };
    }
  } else if (palavras.length === 1) {
    if (/^\d+$/.test(fraseSpaced) && rawTeveOrdinal) {
      const porSerie = turmasIdx.filter(
        (ti) => ti.nomeNorm === fraseSpaced || ti.nomeNorm.startsWith(`${fraseSpaced} `)
      );
      return {
        matchedIds: porSerie.map((h) => h.id),
        especificaInexistente: porSerie.length === 0,
      };
    }
    if (/^[a-z]{3,}$/.test(fraseSpaced)) {
      const porPalavra = turmasIdx.filter(
        (ti) => ti.nomeNorm && ` ${ti.nomeNorm} `.includes(` ${fraseSpaced} `)
      );
      if (porPalavra.length > 0) {
        return { matchedIds: porPalavra.map((h) => h.id), especificaInexistente: false };
      }
    }
  }

  return { matchedIds: null, especificaInexistente: false };
}

function montarSqlNomeEstudante(rawTokens) {
  const tokensLimpos = (rawTokens || [])
    .map((t) => String(t || "").replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter(Boolean);

  if (tokensLimpos.length === 0) return null;

  const colunas = [
    "a.estudante",
    "COALESCE(a.nome_registro, '')",
    "COALESCE(a.nome_social, '')",
  ];

  const orColunas = [];
  const sqlParams = [];

  for (const col of colunas) {
    const andTokens = [];
    for (const tk of tokensLimpos) {
      if (tk.length === 1) {
        // Token de 1 caractere (inicial): exige início de palavra dentro do próprio nome
        andTokens.push(
          `CONCAT(' ', REPLACE(REPLACE(${col}, '.', ' '), '-', ' ')) COLLATE utf8mb4_unicode_ci LIKE ?`
        );
        sqlParams.push(`% ${escapeSqlLike(tk)}%`);
      } else {
        andTokens.push(`${col} COLLATE utf8mb4_unicode_ci LIKE ?`);
        sqlParams.push(`%${escapeSqlLike(tk)}%`);
      }
    }
    orColunas.push(`(${andTokens.join(" AND ")})`);
  }

  return {
    sql: `(${orColunas.join(" OR ")})`,
    params: sqlParams,
  };
}

function montarSqlIdentificadoresAluno(rawStr, anoEfetivo) {
  const s = String(rawStr || "").trim();
  if (!s) return null;

  const conds = [];
  const sqlParams = [];

  // RE / Código do estudante (sem espaços)
  if (!/\s/.test(s)) {
    conds.push("a.codigo LIKE ?");
    sqlParams.push(`%${escapeSqlLike(s)}%`);
  }

  // CPF (com ou sem pontos e traço, sem barras de data)
  if (/^(?=.*\d)[\d.\-\s]+$/.test(s) && !/^\d{4}-\d{1,2}-\d{1,2}$/.test(s)) {
    const digits = s.replace(/\D/g, "");
    if (digits.length >= 3) {
      conds.push("REPLACE(REPLACE(COALESCE(a.cpf, ''), '.', ''), '-', '') LIKE ?");
      sqlParams.push(`%${digits}%`);
    }
  }

  // Data de nascimento em formato brasileiro (DD/MM/AAAA ou DD/MM)
  if (/^\d{1,2}\/\d{1,2}(\/\d{1,4})?$/.test(s)) {
    conds.push("DATE_FORMAT(a.data_nascimento, '%d/%m/%Y') LIKE ?");
    sqlParams.push(`%${escapeSqlLike(s)}%`);
  }

  // Data de nascimento em formato ISO (AAAA-MM-DD)
  if (/^\d{4}-\d{1,2}(-\d{1,2})?$/.test(s)) {
    conds.push("DATE_FORMAT(a.data_nascimento, '%Y-%m-%d') LIKE ?");
    sqlParams.push(`%${escapeSqlLike(s)}%`);
  }

  // Ano com 4 dígitos (ano de nascimento ou ano letivo exibido na tabela)
  if (/^\d{4}$/.test(s)) {
    const anoNum = Number(s);
    conds.push("YEAR(a.data_nascimento) = ?");
    sqlParams.push(anoNum);
    conds.push(`COALESCE(m.ano_letivo, ${Number(anoEfetivo)}) = ?`);
    sqlParams.push(anoNum);
  }

  if (conds.length === 0) return null;
  return {
    sql: `(${conds.join(" OR ")})`,
    params: sqlParams,
  };
}

export function construirCondicoesFiltroAlunos({
  filtroRaw = "",
  statusParam = "",
  aeeParam = "",
  nomeSocialParam = "",
  anoEfetivo,
  turmasEscola = [],
}) {
  const whereExtra = [];
  const paramsExtra = [];

  let texto = String(filtroRaw || "").trim();
  let forcarInativo = false;
  let forcarAEE = String(aeeParam || "") === "1";
  let forcarNomeSocial = String(nomeSocialParam || "") === "1";

  // 1. Extrai atalhos especiais preservando eventual complemento (ex.: "inativos 6º ANO A", "aee vespertino")
  if (texto === "000000") {
    forcarInativo = true;
    texto = "";
  } else if (texto) {
    if (/(?:^|\s)nome\s+social(?=\s|$)/i.test(texto)) {
      forcarNomeSocial = true;
      texto = texto.replace(/(?:^|\s)nome\s+social(?=\s|$)/gi, " ").trim();
    }
    if (/(?:^|\s)inativos?(?=\s|$)/i.test(texto)) {
      forcarInativo = true;
      texto = texto.replace(/(?:^|\s)inativos?(?=\s|$)/gi, " ").trim();
    }
    if (/(?:^|\s)aee(?=\s|$)/i.test(texto)) {
      forcarAEE = true;
      texto = texto.replace(/(?:^|\s)aee(?=\s|$)/gi, " ").trim();
    }
    texto = texto.replace(/\s+/g, " ").trim();
  }

  const statusNorm = String(statusParam || "").trim().toLowerCase();
  const statusEfetivo =
    statusNorm === "ativo" || statusNorm === "inativo"
      ? statusNorm
      : forcarInativo
      ? "inativo"
      : "";

  if (statusEfetivo) {
    whereExtra.push("COALESCE(m.status, a.status, 'ativo') = ?");
    paramsExtra.push(statusEfetivo);
  }
  if (forcarAEE) {
    whereExtra.push("a.atendimento_diferencial = 1");
  }
  if (forcarNomeSocial) {
    whereExtra.push("a.usa_nome_social = 1");
  }

  if (!texto) {
    return { whereExtra, paramsExtra };
  }

  const turmasIdx = indexarTurmasEscolaParaBusca(turmasEscola);
  const rawTeveOrdinal = /[º°ª]/.test(texto);
  const qComUnderscore = normalizarTextoFiltroAluno(texto);
  const qSpaced = qComUnderscore.replace(/_/g, " ").replace(/\s+/g, " ").trim();
  const rawTokens = texto.split(/\s+/).filter(Boolean);
  const normWords = qSpaced ? qSpaced.split(" ").filter(Boolean) : [];

  // 2. Detecta token de turno (se presente)
  let turnoDetectado = null;
  const normWordsSemTurno = [];
  const rawTokensSemTurno = [];

  for (let i = 0; i < rawTokens.length; i++) {
    const rk = rawTokens[i];
    const nk = normalizarTextoFiltroAluno(rk).replace(/_/g, " ").trim();
    const tMatch = !nk.includes(" ") ? detectarTurnoToken(nk) : null;
    if (tMatch && !turnoDetectado) {
      turnoDetectado = tMatch;
    } else {
      rawTokensSemTurno.push(rk);
      if (nk) normWordsSemTurno.push(...nk.split(" ").filter(Boolean));
    }
  }

  const fraseSemTurno = normWordsSemTurno.join(" ");
  const rawSemTurno = rawTokensSemTurno.join(" ");
  const rawSemTurnoComUnderscore = normalizarTextoFiltroAluno(rawSemTurno);

  // 3. Verifica se o texto (sem turno) é integralmente uma Turma / Série
  let resolucaoTurma =
    fraseSemTurno.length > 0
      ? resolverTurmasPorFrase(
          fraseSemTurno,
          rawSemTurnoComUnderscore,
          /[º°ª]/.test(rawSemTurno),
          turmasIdx
        )
      : { matchedIds: null, especificaInexistente: false };

  let tokensAlunoRestantes = [];

  // 4. Caso misto: Nome do Aluno + Turma (ex.: "ANA 6º ANO C" ou "6º ANO C ANA")
  if (
    resolucaoTurma.matchedIds === null &&
    !resolucaoTurma.especificaInexistente &&
    rawTokensSemTurno.length >= 2
  ) {
    const tentarFatia = (inicioTurma, tamTurma) => {
      const fatiaRaw = rawTokensSemTurno
        .slice(inicioTurma, inicioTurma + tamTurma)
        .join(" ");
      const restoRaw = [
        ...rawTokensSemTurno.slice(0, inicioTurma),
        ...rawTokensSemTurno.slice(inicioTurma + tamTurma),
      ];
      const fatiaNorm = normalizarTextoFiltroAluno(fatiaRaw)
        .replace(/_/g, " ")
        .replace(/\s+/g, " ")
        .trim();

      // Em busca mista, exige dígito na fatia de turma (ex.: "6º ANO C", "6º ANO", "6A")
      // e tokens de nome com pelo menos 2 letras para jamais confundir iniciais com turma.
      if (!/\d/.test(fatiaNorm)) return null;
      const restoValido =
        restoRaw.length > 0 &&
        restoRaw.every((tk) => {
          const limpo = normalizarTextoFiltroAluno(tk).replace(/_/g, "");
          return limpo.length >= 2;
        });
      if (!restoValido) return null;

      const res = resolverTurmasPorFrase(
        fatiaNorm,
        normalizarTextoFiltroAluno(fatiaRaw),
        /[º°ª]/.test(fatiaRaw),
        turmasIdx
      );
      if (res.matchedIds !== null || res.especificaInexistente) {
        return { res, restoRaw };
      }
      return null;
    };

    outerMix: for (
      let tam = Math.min(4, rawTokensSemTurno.length - 1);
      tam >= 1;
      tam--
    ) {
      // Testa sufixo (ex.: "ANA SILVA 6º ANO C") e prefixo (ex.: "6º ANO C ANA SILVA")
      for (const inicio of [rawTokensSemTurno.length - tam, 0]) {
        const achado = tentarFatia(inicio, tam);
        if (achado) {
          resolucaoTurma = achado.res;
          tokensAlunoRestantes = achado.restoRaw;
          break outerMix;
        }
      }
    }
  } else if (
    turnoDetectado &&
    resolucaoTurma.matchedIds === null &&
    !resolucaoTurma.especificaInexistente &&
    rawTokensSemTurno.length > 0
  ) {
    // Ex.: "ALICE VESPERTINO"
    tokensAlunoRestantes = rawTokensSemTurno;
  }

  // Se houve filtro de turno junto com turmas encontradas, refina também pelo turno da turma
  let idsTurmaFinais = resolucaoTurma.matchedIds;
  if (Array.isArray(idsTurmaFinais) && idsTurmaFinais.length > 0 && turnoDetectado) {
    idsTurmaFinais = idsTurmaFinais.filter((id) => {
      const info = turmasIdx.find((x) => x.id === id);
      return info && info.turnoNorm.includes(turnoDetectado);
    });
  }

  const fullNomeMatch = montarSqlNomeEstudante(rawTokens);
  const fullIdMatch = montarSqlIdentificadoresAluno(texto, anoEfetivo);

  // Caso A: Usuário digitou uma turma específica que não existe na escola (ex.: "6º ANO I")
  if (resolucaoTurma.especificaInexistente) {
    if (fullNomeMatch) {
      whereExtra.push(fullNomeMatch.sql);
      paramsExtra.push(...fullNomeMatch.params);
    } else {
      whereExtra.push("1 = 0");
    }
    return { whereExtra, paramsExtra };
  }

  // Monta cláusula de Turma / Turno quando aplicável
  let sqlTurmaTurno = null;
  const paramsTurmaTurno = [];

  if (idsTurmaFinais !== null) {
    if (idsTurmaFinais.length === 0) {
      sqlTurmaTurno = "1 = 0";
    } else {
      const ph = idsTurmaFinais.map(() => "?").join(", ");
      sqlTurmaTurno = `COALESCE(m.turma_id, a.turma_id) IN (${ph})`;
      paramsTurmaTurno.push(...idsTurmaFinais);
    }
  } else if (turnoDetectado) {
    sqlTurmaTurno = "COALESCE(t.turno, '') COLLATE utf8mb4_unicode_ci LIKE ?";
    paramsTurmaTurno.push(`%${escapeSqlLike(turnoDetectado)}%`);
  }

  // Caso B: Busca pura por Turma e/ou Turno (ex.: "6º ANO A", "6A", "6º ANO", "VESPERTINO", "2º ANO B NOTURNO")
  if (sqlTurmaTurno && tokensAlunoRestantes.length === 0) {
    const alternativas = [sqlTurmaTurno];
    const altParams = [...paramsTurmaTurno];

    if (fullNomeMatch) {
      alternativas.push(fullNomeMatch.sql);
      altParams.push(...fullNomeMatch.params);
    }
    if (fullIdMatch && !rawTeveOrdinal) {
      alternativas.push(fullIdMatch.sql);
      altParams.push(...fullIdMatch.params);
    }

    whereExtra.push(`(${alternativas.join(" OR ")})`);
    paramsExtra.push(...altParams);
    return { whereExtra, paramsExtra };
  }

  // Caso C: Busca combinada Nome/RE + Turma/Turno (ex.: "ANA 6º ANO C", "ALICE VESPERTINO")
  if (sqlTurmaTurno && tokensAlunoRestantes.length > 0) {
    const subPartes = [];
    const subParams = [];

    const subNome = montarSqlNomeEstudante(tokensAlunoRestantes);
    const subId = montarSqlIdentificadoresAluno(tokensAlunoRestantes.join(" "), anoEfetivo);
    if (subNome) {
      subPartes.push(subNome.sql);
      subParams.push(...subNome.params);
    }
    if (subId) {
      subPartes.push(subId.sql);
      subParams.push(...subId.params);
    }

    const ramos = [];
    const ramosParams = [];
    if (subPartes.length > 0) {
      ramos.push(`(${sqlTurmaTurno} AND (${subPartes.join(" OR ")}))`);
      ramosParams.push(...paramsTurmaTurno, ...subParams);
    }
    if (fullNomeMatch) {
      ramos.push(fullNomeMatch.sql);
      ramosParams.push(...fullNomeMatch.params);
    }

    whereExtra.push(ramos.length > 0 ? `(${ramos.join(" OR ")})` : "1 = 0");
    paramsExtra.push(...ramosParams);
    return { whereExtra, paramsExtra };
  }

  // Caso D: Busca geral (Nome civil, Nome social, RE, CPF, Data de nascimento ou termo único >= 3 chars em turma/turno)
  const ramosGerais = [];
  const paramsGerais = [];

  if (fullNomeMatch) {
    ramosGerais.push(fullNomeMatch.sql);
    paramsGerais.push(...fullNomeMatch.params);
  }
  if (fullIdMatch) {
    ramosGerais.push(fullIdMatch.sql);
    paramsGerais.push(...fullIdMatch.params);
  }

  // Fallback seguro para 1 único termo de >= 3 caracteres (ex.: pedaço de nome personalizado de turma)
  if (rawTokens.length === 1 && normWords.length === 1 && normWords[0].length >= 3) {
    const likeUnico = `%${escapeSqlLike(rawTokens[0])}%`;
    ramosGerais.push("COALESCE(t.nome, '') COLLATE utf8mb4_unicode_ci LIKE ?");
    paramsGerais.push(likeUnico);
    ramosGerais.push("COALESCE(t.turno, '') COLLATE utf8mb4_unicode_ci LIKE ?");
    paramsGerais.push(likeUnico);
  }

  if (ramosGerais.length > 0) {
    whereExtra.push(`(${ramosGerais.join(" OR ")})`);
    paramsExtra.push(...paramsGerais);
  }

  return { whereExtra, paramsExtra };
}

/* ============================================================================
 * 1) CONFIGURAÃ‡ÃƒO DE UPLOAD DE FOTOS (MULTER)
 * - Grava em /uploads/CEF04_PLAN/alunos (pasta servida pelo server.js)
 * ========================================================================== */
const uploadDir = path.resolve(__dirname, "../uploads/CEF04_PLAN/alunos");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const codigo = req.params.id; // usamos :id da rota como "cÃ³digo do aluno"
    cb(null, `${codigo}.jpg`);
  },
});
const upload = multer({ storage });

/* ============================================================================
 * 2) ROTA PÃšBLICA PARA IMPRESSÃƒO (por turma, via secret)
 * GET /api/alunos/publico?turma_id=123&secret=xxxx
 * - NÃ£o depende de req.user
 * ========================================================================== */
router.get("/publico", async (req, res) => {
  try {
    const { turma_id, secret } = req.query;

    const PRINT_SECRET = process.env.PRINT_SECRET || "123456";
    if (!secret || secret !== PRINT_SECRET) {
      return res.status(403).json({ message: "Acesso negado (secret invÃ¡lido)." });
    }
    if (!turma_id) {
      return res.status(400).json({ message: "turma_id obrigatÃ³rio." });
    }

    const [rows] = await pool.query(
      `
      SELECT a.id, a.codigo, a.estudante,
             DATE_FORMAT(a.data_nascimento, '%Y-%m-%d') AS data_nascimento,
             a.sexo, a.status,
             t.nome AS turma, t.turno
      FROM alunos a
      LEFT JOIN turmas t ON t.id = a.turma_id
      WHERE a.turma_id = ?
      ORDER BY a.estudante
      `,
      [turma_id]
    );

    return res.json({ alunos: rows, total: rows.length });
  } catch (err) {
    console.error("[publico] Erro ao listar alunos:", err);
    res.status(500).json({ message: "Erro no servidor ao listar alunos (publico)." });
  }
});

/* ============================================================================
 * 3) LISTAR ALUNOS (com filtros)
 * GET /api/alunos?turma_id=&filtro=&status=&limit=&offset=
 * - Filtra por escola do usuário (req.user.escola_id) em alunos ou matriculas
 * - Filtros: turma_id, busca textual (nome/código/turma/turno) e status (ativo/inativo)
 * ========================================================================== */
router.get("/", verificarEscola, async (req, res) => {
  try {
    await ensureNomeSocialReady();
    const {
      turma_id,
      turma: turmaNomeParam = "",
      filtro = "",
      status = "",
      aee = "",
      nome_social = "",
      ano_letivo,
      contexto = "",
      limit = 100,
      offset = 0,
    } = req.query;
    const { escola_id } = req.user;

    // Ano letivo efetivo: usa o parâmetro ou calcula o padrão (corte 31/jan)
    const anoEfetivo = ano_letivo ? Number(ano_letivo) : anoLetivoPadrao();

    // Auto-repair em background: ajusta a.escola_id para alunos que possuem matricula mas a.escola_id e nulo/0/divergente
    pool.query(`
      UPDATE alunos a
      INNER JOIN matriculas m ON m.aluno_id = a.id
      SET a.escola_id = m.escola_id
      WHERE (a.escola_id IS NULL OR a.escola_id = 0 OR a.escola_id != m.escola_id)
        AND m.escola_id = ?
    `, [Number(escola_id)]).catch(e => console.error("Auto-sync escola_id err:", e.message));

    // DEBUG: o que chegou do front e do token
    console.log("🔎 /api/alunos → filtros:", { turma_id, turmaNomeParam, filtro, status, ano_letivo, contexto, limit, offset });
    console.log("🔎 /api/alunos → req.user:", req.user);

    const where = ["(a.escola_id = ? OR m.escola_id = ?)"];
    // ⚠️ ordem dos params importa: o SQL abaixo usa SPACES_PUBLIC_BASE no primeiro "?"
    const params = [SPACES_PUBLIC_BASE, Number(escola_id), Number(escola_id)];

    if (turma_id) {
      where.push("COALESCE(m.turma_id, a.turma_id) = ?");
      params.push(Number(turma_id));
    } else if (String(turmaNomeParam || "").trim()) {
      where.push("COALESCE(t.nome, '') COLLATE utf8mb4_unicode_ci = ?");
      params.push(String(turmaNomeParam).trim());
    }

    const filtroTrim = String(filtro || "").trim();
    let turmasEscola = [];
    if (filtroTrim) {
      const [tRows] = await pool.query(
        `SELECT DISTINCT t.id, t.nome, t.nome_oficial, t.turno, t.serie, t.etapa
           FROM turmas t
          WHERE t.escola_id = ?
             OR t.id IN (SELECT DISTINCT turma_id FROM matriculas WHERE escola_id = ? AND ano_letivo = ?)
             OR t.id IN (SELECT DISTINCT turma_id FROM alunos WHERE escola_id = ? AND turma_id IS NOT NULL)`,
        [Number(escola_id), Number(escola_id), anoEfetivo, Number(escola_id)]
      );
      turmasEscola = tRows || [];
    }

    const { whereExtra, paramsExtra } = construirCondicoesFiltroAlunos({
      filtroRaw: filtroTrim,
      statusParam: status,
      aeeParam: aee,
      nomeSocialParam: nome_social,
      anoEfetivo,
      turmasEscola,
    });

    if (whereExtra.length > 0) {
      where.push(...whereExtra);
      params.push(...paramsExtra);
    }

    const whereSql = `WHERE ${where.join(" AND ")}`;

    // LEFT JOIN para incluir alunos sem matrícula formal no ano (ex: importados via IEDUCAR).
    const countSql = `
      SELECT COUNT(DISTINCT a.id) AS total
      FROM alunos AS a
      LEFT JOIN matriculas AS m ON m.aluno_id = a.id AND m.ano_letivo = ${anoEfetivo} AND m.escola_id = ${Number(escola_id)}
      LEFT JOIN turmas AS t ON t.id = COALESCE(m.turma_id, a.turma_id)
      LEFT JOIN escolas AS e ON e.id = COALESCE(a.escola_id, m.escola_id)
      ${whereSql}
    `;

    // paramsCount: pula SPACES_PUBLIC_BASE (params[0]) pois countSql nao tem CONCAT
    const paramsCount = params.slice(1);
    const [countRows] = await pool.query(countSql, paramsCount);
    const total = countRows[0] ? countRows[0].total : 0;

    const sql = `
      SELECT
             a.id,
             a.codigo,
             a.estudante,
             COALESCE(NULLIF(TRIM(a.nome_registro), ''), a.estudante) AS nome_registro,
             a.usa_nome_social,
             a.nome_social,
             DATE_FORMAT(a.data_nascimento, '%Y-%m-%d') AS data_nascimento,
             a.sexo,
             a.cpf,
             a.atendimento_diferencial,
             a.anees,
             COALESCE(m.status, a.status, 'ativo') AS status,
             a.foto,

             -- URL canônica do Spaces (novo padrão do EDUCA-CAPTURE):
             CASE
               WHEN a.foto LIKE 'http%' THEN a.foto
               ELSE CONCAT(?, 'uploads/', COALESCE(e.apelido, CONCAT('escola_', COALESCE(a.escola_id, m.escola_id))), '/alunos/', a.codigo, '.jpg')
             END AS foto_url,

             t.nome  AS turma,
             t.turno,
             COALESCE(m.turma_id, a.turma_id) AS turma_id,
             COALESCE(m.ano_letivo, ${anoEfetivo}) AS ano_letivo,

             -- LGPD: consentimento de imagem pelo responsável
             COALESCE(
               (SELECT MAX(CASE WHEN ra.consentimento_imagem = 1 AND ra.ativo = 1 THEN 1 ELSE 0 END)
                  FROM responsaveis_alunos ra
                 WHERE ra.aluno_id = a.id AND (ra.escola_id = a.escola_id OR ra.escola_id = m.escola_id)),
               0
             ) AS consentimento_imagem

      FROM alunos AS a
      LEFT JOIN matriculas AS m ON m.aluno_id = a.id AND m.ano_letivo = ${anoEfetivo} AND m.escola_id = ${Number(escola_id)}
      LEFT JOIN turmas AS t ON t.id = COALESCE(m.turma_id, a.turma_id)
      LEFT JOIN escolas AS e ON e.id = COALESCE(a.escola_id, m.escola_id)
      ${whereSql}
      ORDER BY a.estudante
      LIMIT ? OFFSET ?
    `;
    // params: [SPACES_PUBLIC_BASE, escola_id, ...filtros, limit, offset]
    // anoEfetivo esta embutido como literal no SQL (JOIN ON e COALESCE) — nao usa ?
    params.push(Number(limit), Number(offset));

    console.log("🔎 /api/alunos → SQL:", sql.replace(/\s+/g, " ").trim());
    console.log("🔎 /api/alunos → params:", params);

    const [rows] = await pool.query(sql, params);

    // Governança Pedagógica: se contexto === 'conselho', verifica se a direção liberou fotos
    let fotosLiberadasConselhoDirecao = false;
    if (contexto === "conselho") {
      try {
        const [[cfgPedagogico]] = await pool.query(
          "SELECT valor FROM configuracoes_escola WHERE escola_id = ? AND chave = 'pedagogico.liberar_fotos_conselho'",
          [escola_id]
        );
        fotosLiberadasConselhoDirecao = cfgPedagogico?.valor === "1";
      } catch (errCfg) {
        console.error("Erro ao verificar governanca pedagogica em /api/alunos:", errCfg);
      }
    }

    // LGPD + Governança Direção (Regra de Ouro):
    // 1) Se o responsável assinou (consentimento_imagem = 1): foto é SEMPRE VISÍVEL.
    // 2) Se o responsável NÃO assinou: foto fica oculta, a menos que contexto === 'conselho' E direção ativou governança.
    const alunosComConsentimento = rows.map((a) => {
      const consentimentoResp = Number(a.consentimento_imagem) === 1;
      const podeExibirFoto = consentimentoResp || (contexto === "conselho" && fotosLiberadasConselhoDirecao);
      const aneesSanitizado =
        a.anees &&
        ehValorAneesLegitimo(a.anees, {
          estudante: a.estudante,
          nomeRegistro: a.nome_registro,
          nomeSocial: a.nome_social,
        })
          ? a.anees
          : null;
      return {
        ...a,
        anees: aneesSanitizado,
        foto: podeExibirFoto ? a.foto : null,
        foto_url: podeExibirFoto ? a.foto_url : null,
        consentimento_imagem: consentimentoResp,
        foto_liberada_diretor: podeExibirFoto && !consentimentoResp,
      };
    });

    res.json({ alunos: alunosComConsentimento, total });

  } catch (err) {
    console.error("Erro ao listar alunos:", err);
    res.status(500).json({ message: "Erro ao listar alunos." });
  }
});

/* ============================================================================
 * 4) CRIAR ALUNO
 * POST /api/alunos
 * Body: { codigo, estudante, data_nascimento(YYYY-MM-DD), sexo, turma_id }
 * - status padrÃ£o: "ativo"
 * ========================================================================== */
router.post("/", verificarEscola, async (req, res) => {
  try {
    await ensureNomeSocialReady();
    const {
      codigo,
      estudante,
      nome_registro,
      usa_nome_social,
      nome_social,
      data_nascimento,
      sexo,
      turma_id,
      cpf,
      atendimento_diferencial,
      anees,
    } = req.body;
    const { escola_id } = req.user;

    const nomeRegistroLimpo = String(nome_registro ?? estudante ?? "").trim();
    const codigoCheck = sanitizarCodigoReEstudante(codigo);
    if (!codigoCheck.ok) {
      return res.status(400).json({ message: codigoCheck.message });
    }
    const codigoLimpo = codigoCheck.value;

    if (!nomeRegistroLimpo) {
      return res.status(400).json({ message: "Código (RE) e nome do estudante são obrigatórios." });
    }

    const cpfCheck = sanitizarCpfEstudante(cpf);
    if (!cpfCheck.ok) {
      return res.status(400).json({ message: cpfCheck.message });
    }
    const cpfLimpo = cpfCheck.value;

    const dataCheck = sanitizarDataNascimentoIso(data_nascimento);
    if (!dataCheck.ok) {
      return res.status(400).json({ message: dataCheck.message });
    }
    const dataIso = dataCheck.value;

    const turmaNum = Number(turma_id);
    if (!turmaNum || turmaNum <= 0) {
      return res.status(400).json({ message: "Selecione a turma do estudante." });
    }

    const [[turmaValidada]] = await pool.query(
      "SELECT id, nome, turno, ano FROM turmas WHERE id = ? AND escola_id = ? LIMIT 1",
      [turmaNum, escola_id]
    );
    if (!turmaValidada) {
      return res.status(400).json({ message: "Turma selecionada não encontrada nesta escola." });
    }

    const usaSocialFlag =
      Number(usa_nome_social) === 1 || usa_nome_social === true ? 1 : 0;
    const nomeSocialLimpo = usaSocialFlag
      ? String(nome_social || "").trim()
      : "";
    if (usaSocialFlag && !nomeSocialLimpo) {
      return res.status(400).json({ message: "Informe o Nome Social do estudante." });
    }
    const estudanteExibicao = (usaSocialFlag ? nomeSocialLimpo : nomeRegistroLimpo).slice(0, 255);
    const nomeRegistroFinal = nomeRegistroLimpo.slice(0, 255);
    const nomeSocialFinal = usaSocialFlag ? nomeSocialLimpo.slice(0, 255) : null;
    const sexoLimpo = sexo ? String(sexo).trim().slice(0, 10) || null : null;
    const aeeAtivoFlag = atendimento_diferencial ? 1 : 0;
    const aneesLimpo =
      aeeAtivoFlag && anees ? String(anees).trim().slice(0, 500) || null : null;

    const anoLetivoAtual = anoLetivoPadrao();
    const anoMatriculaAlvo =
      turmaValidada.ano && Number(turmaValidada.ano) > 2000
        ? Number(turmaValidada.ano)
        : anoLetivoAtual;

    // IMPORTANTE: `alunos` possui UNIQUE KEY global `unq_codigo (codigo)` (sem escola_id).
    // Por isso consultamos globalmente pelo `codigo` (RE SEEDF) para tratar tanto alunos
    // inativos desta escola quanto estudantes vindos transferidos de outra escola na base.
    const [[existe]] = await pool.query(
      `SELECT a.id, a.codigo, a.estudante, a.escola_id, a.status, a.turma_id
         FROM alunos a
        WHERE a.codigo = ?
        ORDER BY (a.escola_id = ?) DESC, a.id DESC
        LIMIT 1`,
      [codigoLimpo, escola_id]
    );

    if (cpfLimpo) {
      const [[cpfConflito]] = await pool.query(
        `SELECT id, codigo, estudante, escola_id
           FROM alunos
          WHERE REPLACE(REPLACE(COALESCE(cpf, ''), '.', ''), '-', '') = ?
          LIMIT 1`,
        [cpfLimpo]
      );
      if (cpfConflito && (!existe || Number(cpfConflito.id) !== Number(existe.id))) {
        return res.status(409).json({
          message: `Já existe outro estudante cadastrado com este CPF (RE ${cpfConflito.codigo} — ${cpfConflito.estudante}).`,
        });
      }
    }

    let alunoId;

    if (existe) {
      alunoId = existe.id;

      // Verifica se já está matriculado ATIVO nesta escola no ano letivo da turma
      const [matrRows] = await pool.query(
        `SELECT m.id, m.status, m.turma_id, t.nome AS turma_nome, t.turno AS turma_turno
           FROM matriculas m
           LEFT JOIN turmas t ON t.id = m.turma_id
          WHERE m.aluno_id = ? AND m.ano_letivo = ? AND m.escola_id = ?
          ORDER BY (m.status = 'ativo') DESC, m.id DESC`,
        [alunoId, anoMatriculaAlvo, escola_id]
      );
      const matrAtiva = matrRows.find((r) => String(r.status || "").toLowerCase() === "ativo");
      if (matrAtiva) {
        const descTurma = matrAtiva.turma_nome
          ? ` na turma ${matrAtiva.turma_nome}${matrAtiva.turma_turno ? ` — ${matrAtiva.turma_turno}` : ""}`
          : "";
        return res.status(409).json({
          message: `O estudante ${existe.estudante || nomeRegistroFinal} (RE ${codigoLimpo}) já possui matrícula ativa nesta escola${descTurma} (${anoMatriculaAlvo}).`,
        });
      }

      // Fallback legado: aluno ativo na mesma escola sem linha em `matriculas`, mas já vinculado a turma ativa do mesmo ano
      if (
        matrRows.length === 0 &&
        Number(existe.escola_id) === Number(escola_id) &&
        String(existe.status || "").toLowerCase() === "ativo" &&
        Number(existe.turma_id) > 0
      ) {
        const [[turmaLegada]] = await pool.query(
          "SELECT id, nome, turno, ano FROM turmas WHERE id = ? AND escola_id = ? LIMIT 1",
          [existe.turma_id, escola_id]
        );
        if (turmaLegada && Number(turmaLegada.ano) === Number(anoMatriculaAlvo)) {
          return res.status(409).json({
            message: `O estudante ${existe.estudante || nomeRegistroFinal} (RE ${codigoLimpo}) já está ativo nesta escola na turma ${turmaLegada.nome}${turmaLegada.turno ? ` — ${turmaLegada.turno}` : ""} (${anoMatriculaAlvo}).`,
          });
        }
      }

      // Atualiza/reativa o registro existente (inclusive se veio transferido de outra escola)
      await pool.query(
        `UPDATE alunos
            SET estudante = ?,
                nome_registro = ?,
                usa_nome_social = ?,
                nome_social = ?,
                data_nascimento = COALESCE(?, data_nascimento),
                sexo = COALESCE(?, sexo),
                turma_id = ?,
                cpf = COALESCE(?, cpf),
                atendimento_diferencial = ?,
                anees = ?,
                escola_id = ?,
                status = 'ativo'
          WHERE id = ?`,
        [
          estudanteExibicao,
          nomeRegistroFinal,
          usaSocialFlag,
          nomeSocialFinal,
          dataIso,
          sexoLimpo,
          turmaValidada.id,
          cpfLimpo,
          aeeAtivoFlag,
          aneesLimpo,
          escola_id,
          alunoId,
        ]
      );
    } else {
      // Inserção inédita na base global (protegida contra concorrência via ON DUPLICATE KEY)
      const [result] = await pool.query(
        `INSERT INTO alunos
          (codigo, estudante, nome_registro, usa_nome_social, nome_social, data_nascimento, sexo, turma_id, cpf, atendimento_diferencial, anees, escola_id, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ativo')
        ON DUPLICATE KEY UPDATE
          id = LAST_INSERT_ID(id),
          estudante = VALUES(estudante),
          nome_registro = VALUES(nome_registro),
          usa_nome_social = VALUES(usa_nome_social),
          nome_social = VALUES(nome_social),
          data_nascimento = COALESCE(VALUES(data_nascimento), data_nascimento),
          sexo = COALESCE(VALUES(sexo), sexo),
          turma_id = VALUES(turma_id),
          cpf = COALESCE(VALUES(cpf), cpf),
          atendimento_diferencial = VALUES(atendimento_diferencial),
          anees = VALUES(anees),
          escola_id = VALUES(escola_id),
          status = 'ativo'`,
        [
          codigoLimpo,
          estudanteExibicao,
          nomeRegistroFinal,
          usaSocialFlag,
          nomeSocialFinal,
          dataIso,
          sexoLimpo,
          turmaValidada.id,
          cpfLimpo,
          aeeAtivoFlag,
          aneesLimpo,
          escola_id,
        ]
      );
      alunoId = result.insertId;
    }

    // Sincroniza matrícula ativa no ano letivo da turma (evitando registros órfãos em outra turma do mesmo ano)
    if (alunoId) {
      const [matrAno] = await pool.query(
        `SELECT id, turma_id
           FROM matriculas
          WHERE aluno_id = ? AND escola_id = ? AND ano_letivo = ?
          ORDER BY (turma_id = ?) DESC, id DESC`,
        [alunoId, escola_id, anoMatriculaAlvo, turmaValidada.id]
      );

      if (matrAno.length > 0) {
        const principalId = matrAno[0].id;
        await pool.query(
          `UPDATE matriculas
              SET turma_id = ?, status = 'ativo', updated_at = CURRENT_TIMESTAMP
            WHERE id = ?`,
          [turmaValidada.id, principalId]
        );
        if (matrAno.length > 1) {
          const extras = matrAno.slice(1).map((r) => r.id);
          await pool.query(
            `UPDATE matriculas SET status = 'inativo', updated_at = CURRENT_TIMESTAMP WHERE id IN (?)`,
            [extras]
          );
        }
      } else {
        await pool.query(
          `INSERT INTO matriculas (escola_id, aluno_id, turma_id, ano_letivo, status)
           VALUES (?, ?, ?, ?, 'ativo')
           ON DUPLICATE KEY UPDATE status = 'ativo', turma_id = VALUES(turma_id), updated_at = CURRENT_TIMESTAMP`,
          [escola_id, alunoId, turmaValidada.id, anoMatriculaAlvo]
        );
      }
    }

    res.status(201).json({ id: alunoId, message: "Aluno cadastrado com sucesso." });
  } catch (err) {
    console.error("Erro ao criar aluno:", err);
    if (err?.code === "ER_DUP_ENTRY") {
      return res.status(409).json({
        message: "Já existe um estudante cadastrado com este RE ou CPF no sistema.",
      });
    }
    res.status(500).json({ message: "Erro ao criar aluno." });
  }
});

/* ============================================================================
 * 5) ATUALIZAR ALUNO
 * PUT /api/alunos/:id
 * Body pode conter: { estudante, nome_registro, usa_nome_social, nome_social, data_nascimento, sexo, turma_id, status }
 * ========================================================================== */
router.put("/:id", verificarEscola, async (req, res) => {
  try {
    await ensureNomeSocialReady();
    const { id } = req.params;
    const { escola_id } = req.user;
    const {
      estudante,
      nome_registro,
      usa_nome_social,
      nome_social,
      data_nascimento,
      sexo,
      turma_id,
      status,
      cpf,
      atendimento_diferencial,
      anees,
    } = req.body;

    const campos = [];
    const valores = [];

    const alterouNomes =
      typeof estudante !== "undefined" ||
      typeof nome_registro !== "undefined" ||
      typeof usa_nome_social !== "undefined" ||
      typeof nome_social !== "undefined";

    if (alterouNomes) {
      const [[atual]] = await pool.query(
        `SELECT id, estudante, nome_registro, usa_nome_social, nome_social
           FROM alunos
          WHERE id = ? AND escola_id = ?
          LIMIT 1`,
        [id, escola_id]
      );
      if (!atual) {
        return res.status(404).json({ message: "Aluno não encontrado." });
      }

      const civilAtual = String(atual.nome_registro || atual.estudante || "").trim();
      let novoNomeRegistro = civilAtual;

      if (typeof nome_registro !== "undefined" && String(nome_registro).trim()) {
        novoNomeRegistro = String(nome_registro).trim();
      } else if (typeof estudante !== "undefined" && String(estudante).trim()) {
        const estEnviado = String(estudante).trim();
        const eraSocialEco =
          Number(atual.usa_nome_social) === 1 &&
          typeof nome_registro === "undefined" &&
          typeof usa_nome_social === "undefined" &&
          estEnviado === String(atual.nome_social || "").trim();
        if (!eraSocialEco) {
          novoNomeRegistro = estEnviado;
        }
      }

      const novoUsaSocial =
        typeof usa_nome_social !== "undefined"
          ? Number(usa_nome_social) === 1 || usa_nome_social === true
            ? 1
            : 0
          : Number(atual.usa_nome_social) === 1
          ? 1
          : 0;

      const novoNomeSocial = novoUsaSocial
        ? String(
            typeof nome_social !== "undefined" ? nome_social || "" : atual.nome_social || ""
          ).trim()
        : "";

      if (novoUsaSocial && !novoNomeSocial) {
        return res.status(400).json({ message: "Informe o Nome Social do estudante." });
      }

      const novoEstudanteExibicao = novoUsaSocial ? novoNomeSocial : novoNomeRegistro;

      campos.push("estudante = ?", "nome_registro = ?", "usa_nome_social = ?", "nome_social = ?");
      valores.push(
        novoEstudanteExibicao,
        novoNomeRegistro,
        novoUsaSocial,
        novoUsaSocial ? novoNomeSocial : null
      );
    }

    let turmaValidada = null;
    if (typeof turma_id !== "undefined") {
      const novaTurmaNum = Number(turma_id);
      if (novaTurmaNum > 0) {
        const [[tRow]] = await pool.query(
          "SELECT id, nome, turno, ano FROM turmas WHERE id = ? AND escola_id = ? LIMIT 1",
          [novaTurmaNum, escola_id]
        );
        if (!tRow) {
          return res.status(400).json({ message: "Turma selecionada não encontrada nesta escola." });
        }
        turmaValidada = tRow;
        campos.push("turma_id = ?");
        valores.push(novaTurmaNum);
      } else {
        campos.push("turma_id = ?");
        valores.push(null);
      }
    }

    if (typeof data_nascimento !== "undefined") {
      const dCheck = sanitizarDataNascimentoIso(data_nascimento);
      if (!dCheck.ok) {
        return res.status(400).json({ message: dCheck.message });
      }
      campos.push("data_nascimento = ?");
      valores.push(dCheck.value);
    }
    if (typeof sexo !== "undefined") { campos.push("sexo = ?"); valores.push(sexo ? String(sexo).trim().slice(0, 10) || null : null); }
    if (typeof cpf !== "undefined") {
      const cCheck = sanitizarCpfEstudante(cpf);
      if (!cCheck.ok) {
        return res.status(400).json({ message: cCheck.message });
      }
      if (cCheck.value) {
        const [[cpfDupl]] = await pool.query(
          `SELECT id, codigo, estudante
             FROM alunos
            WHERE REPLACE(REPLACE(COALESCE(cpf, ''), '.', ''), '-', '') = ?
              AND id <> ?
            LIMIT 1`,
          [cCheck.value, id]
        );
        if (cpfDupl) {
          return res.status(409).json({
            message: `Já existe outro estudante cadastrado com este CPF (RE ${cpfDupl.codigo} — ${cpfDupl.estudante}).`,
          });
        }
      }
      campos.push("cpf = ?");
      valores.push(cCheck.value);
    }
    if (typeof atendimento_diferencial !== "undefined") { campos.push("atendimento_diferencial = ?"); valores.push(atendimento_diferencial ? 1 : 0); }
    if (typeof anees !== "undefined") {
      const desmarcouAee = typeof atendimento_diferencial !== "undefined" && !atendimento_diferencial;
      const aneesAtualizado = desmarcouAee ? null : (anees ? String(anees).trim().slice(0, 500) || null : null);
      campos.push("anees = ?");
      valores.push(aneesAtualizado);
    }
    if (typeof status !== "undefined") { campos.push("status = ?"); valores.push(status); }

    if (campos.length === 0) {
      return res.status(400).json({ message: "Nada para atualizar." });
    }

    campos.push("escola_id = COALESCE(NULLIF(escola_id, 0), ?)");
    valores.push(escola_id);

    valores.push(id, escola_id, escola_id);
    await pool.query(
      `UPDATE alunos
          SET ${campos.join(", ")}
        WHERE id = ?
          AND (escola_id = ? OR id IN (SELECT aluno_id FROM matriculas WHERE escola_id = ?))`,
      valores
    );

    // Sincroniza turma_id e/ou status na tabela `matriculas` do ano letivo correspondente,
    // pois GET /api/alunos, diários, chamadas, Sala de Recursos e Educa Mobile leem `COALESCE(m.turma_id, a.turma_id)`.
    const anoLetivoAtual = anoLetivoPadrao();
    const anoMatriculaAlvo =
      turmaValidada?.ano && Number(turmaValidada.ano) > 2000
        ? Number(turmaValidada.ano)
        : anoLetivoAtual;

    if (turmaValidada) {
      const statusNovoMatr =
        typeof status !== "undefined" && (status === "ativo" || status === "inativo")
          ? status
          : null;

      const [matrExistente] = await pool.query(
        "SELECT id FROM matriculas WHERE aluno_id = ? AND escola_id = ? AND ano_letivo = ?",
        [id, escola_id, anoMatriculaAlvo]
      );

      if (matrExistente.length > 0) {
        if (statusNovoMatr) {
          await pool.query(
            `UPDATE matriculas
                SET turma_id = ?, status = ?, updated_at = CURRENT_TIMESTAMP
              WHERE id = ?`,
            [turmaValidada.id, statusNovoMatr, matrExistente[0].id]
          );
        } else {
          await pool.query(
            `UPDATE matriculas
                SET turma_id = ?, updated_at = CURRENT_TIMESTAMP
              WHERE id = ?`,
            [turmaValidada.id, matrExistente[0].id]
          );
        }
      } else {
        await pool.query(
          `INSERT INTO matriculas (escola_id, aluno_id, turma_id, ano_letivo, status)
           VALUES (?, ?, ?, ?, ?)`,
          [escola_id, id, turmaValidada.id, anoMatriculaAlvo, statusNovoMatr || "ativo"]
        );
      }
    } else if (typeof status !== "undefined" && (status === "ativo" || status === "inativo")) {
      await pool.query(
        `UPDATE matriculas
            SET status = ?, updated_at = CURRENT_TIMESTAMP
          WHERE aluno_id = ? AND escola_id = ? AND ano_letivo = ?`,
        [status, id, escola_id, anoLetivoAtual]
      );
    }

    res.json({ message: "Aluno atualizado com sucesso." });
  } catch (err) {
    console.error("Erro ao atualizar aluno:", err);
    if (err?.code === "ER_DUP_ENTRY") {
      return res.status(409).json({
        message: "Já existe outro estudante cadastrado com este CPF ou código no sistema.",
      });
    }
    res.status(500).json({ message: "Erro ao atualizar aluno." });
  }
});

/* ============================================================================
 * 6) INATIVAR ALUNO
 * PUT /api/alunos/inativar/:id
 * ========================================================================== */
router.put("/inativar/:id", verificarEscola, async (req, res) => {
  try {
    const { id } = req.params;
    const { escola_id } = req.user;
    const anoLetivoAtual = anoLetivoPadrao();

    // Inativa o cadastro do aluno
    await pool.query(
      `UPDATE alunos SET status='inativo' WHERE id = ? AND escola_id = ?`,
      [id, escola_id]
    );

    // Propaga para a matrícula do ano letivo atual
    await pool.query(
      `UPDATE matriculas SET status = 'inativo', updated_at = CURRENT_TIMESTAMP
        WHERE aluno_id = ? AND escola_id = ? AND ano_letivo = ?`,
      [id, escola_id, anoLetivoAtual]
    );

    res.json({ message: "Aluno inativado." });
  } catch (err) {
    console.error("Erro ao inativar aluno:", err);
    res.status(500).json({ message: "Erro ao inativar aluno." });
  }
});

/* ============================================================================
 * 7) EXCLUIR ALUNO
 * DELETE /api/alunos/:id
 * ========================================================================== */
router.delete("/:id", verificarEscola, async (req, res) => {
  try {
    const { id } = req.params;
    const { escola_id } = req.user;
    await pool.query(
      "DELETE FROM alunos WHERE id = ? AND escola_id = ?",
      [id, escola_id]
    );
    res.json({ message: "Aluno excluÃ­do." });
  } catch (err) {
    console.error("Erro ao excluir aluno:", err);
    res.status(500).json({ message: "Erro ao excluir aluno." });
  }
});

/* ============================================================================
 * 8) BUSCAR POR CÃ“DIGO
 * GET /api/alunos/por-codigo/:codigo
 * - Ãštil para verificar reativaÃ§Ã£o/criaÃ§Ã£o no frontend
 * ========================================================================== */
router.get("/por-codigo/:codigo", verificarEscola, async (req, res) => {
  try {
    await ensureNomeSocialReady();
    const { codigo } = req.params;
    const { escola_id } = req.user;
    const anoLetivoAtual = anoLetivoPadrao();
    const [[aluno]] = await pool.query(
      `SELECT a.id, a.codigo, a.estudante AS nome,
              COALESCE(NULLIF(TRIM(a.nome_registro), ''), a.estudante) AS nome_registro,
              a.usa_nome_social, a.nome_social,
              DATE_FORMAT(a.data_nascimento, '%Y-%m-%d') AS data_nascimento,
              a.sexo, a.atendimento_diferencial, a.anees, a.foto, COALESCE(m.status, a.status, 'ativo') AS status,
              t.nome AS turma, t.turno
       FROM alunos a
       LEFT JOIN matriculas m ON m.aluno_id = a.id AND m.escola_id = ? AND m.ano_letivo = ?
       LEFT JOIN turmas t ON t.id = COALESCE(m.turma_id, a.turma_id)
       WHERE a.codigo = ? AND (a.escola_id = ? OR m.escola_id = ?)`,
      [Number(escola_id), anoLetivoAtual, codigo, Number(escola_id), Number(escola_id)]
    );
    if (!aluno) {
      return res.status(404).json({ message: "Aluno não encontrado." });
    }
    res.json(aluno);
  } catch (err) {
    console.error("Erro ao buscar aluno por cÃ³digo:", err);
    res.status(500).json({ message: "Erro no servidor ao buscar por cÃ³digo." });
  }
});

/* ============================================================================
 * 8.1) NOTAS SIMPLES DO ALUNO
 * GET /api/alunos/:id/notas
 * ========================================================================== */
router.get("/:id/notas", async (req, res) => {
  try {
    const { id } = req.params;
    const [notas] = await pool.query(
      `SELECT n.id, n.nota, d.nome AS disciplina
       FROM notas n
       JOIN disciplinas d ON n.disciplina_id = d.id
       WHERE n.aluno_id = ?
       ORDER BY d.nome`,
      [id]
    );
    return res.json(notas);
  } catch (err) {
    console.error("Erro ao buscar notas do aluno:", err);
    return res.status(500).json({ message: "Erro no servidor ao buscar notas." });
  }
});

/* ============================================================================
 * 8.2) NOTAS DETALHADAS
 * GET /api/alunos/:id/notas-detalhadas
 * ========================================================================== */
router.get("/:id/notas-detalhadas", async (req, res) => {
  try {
    const { id } = req.params;
    const [notas] = await pool.query(
      `SELECT
         n.id,
         n.nota      AS nota,
         n.ano,
         n.bimestre,
         n.faltas,
         n.disciplina_id,
         d.nome       AS disciplina
       FROM notas n
       JOIN disciplinas d ON d.id = n.disciplina_id
       WHERE n.aluno_id = ?
       ORDER BY n.ano, n.bimestre, d.nome`,
      [id]
    );
    return res.json(notas);
  } catch (err) {
    console.error("Erro ao buscar notas detalhadas:", err);
    return res.status(500).json({ message: "Erro no servidor ao buscar notas." });
  }
});

/* ============================================================================
 * 9) BUSCAR UM ALUNO ESPECÃFICO (por cÃ³digo)
 * GET /api/alunos/:id
 * - Aqui ":id" Ã© o CÃ“DIGO do aluno (mantido conforme uso no frontend)
 * ========================================================================== */
router.get("/:id", async (req, res) => {
  const { id } = req.params;
  try {
    await ensureNomeSocialReady();
    const anoLetivoAtual = anoLetivoPadrao();
    const [[aluno]] = await pool.query(
      `
      SELECT
        a.id,
        a.escola_id,
        a.codigo,
        a.estudante AS estudante,
        COALESCE(NULLIF(TRIM(a.nome_registro), ''), a.estudante) AS nome_registro,
        a.usa_nome_social,
        a.nome_social,
        DATE_FORMAT(a.data_nascimento, '%Y-%m-%d') AS data_nascimento,
        a.sexo,
        a.cpf,
        a.atendimento_diferencial,
        a.anees,
        a.foto,
        COALESCE(m.status, a.status, 'ativo') AS status,
        t.id AS turma_id,
        t.nome AS turma,
        t.turno,
        t.etapa AS etapa,
        t.regime,
        -- Verifica se algum responsÃ¡vel ativo concedeu consentimento de imagem
        COALESCE(
          (SELECT MAX(CASE WHEN ra.consentimento_imagem = 1 AND ra.ativo = 1 THEN 1 ELSE 0 END)
             FROM responsaveis_alunos ra
            WHERE ra.aluno_id = a.id AND ra.escola_id = a.escola_id),
          0
        ) AS consentimento_imagem
      FROM alunos AS a
      LEFT JOIN matriculas AS m ON m.aluno_id = a.id AND m.escola_id = a.escola_id AND m.ano_letivo = ?
      LEFT JOIN turmas AS t ON t.id = COALESCE(m.turma_id, a.turma_id)
      WHERE a.codigo = ?
      `,
      [anoLetivoAtual, id]
    );
    if (!aluno) {
      return res.status(404).json({ message: "Aluno nÃ£o encontrado." });
    }

    // LGPD/Consentimento: sÃ³ expÃµe a foto se o responsÃ¡vel autorizou
    const consentimento_ok = Number(aluno.consentimento_imagem) === 1;
    const aneesSanitizado =
      aluno.anees &&
      ehValorAneesLegitimo(aluno.anees, {
        estudante: aluno.estudante,
        nomeRegistro: aluno.nome_registro,
        nomeSocial: aluno.nome_social,
      })
        ? aluno.anees
        : null;
    return res.json({
      ...aluno,
      anees: aneesSanitizado,
      foto: consentimento_ok ? aluno.foto : null,
      consentimento_imagem: consentimento_ok,
    });
  } catch (err) {
    console.error("Erro ao buscar aluno:", err);
    return res.status(500).json({ message: "Erro no servidor ao buscar aluno." });
  }
});


/* ============================================================================
 * 10) RECEBER FOTO RECORTADA
 * POST /api/alunos/:id/foto
 * - Salva em /uploads/CEF04_PLAN/alunos/<codigo>.jpg
 * - Atualiza coluna 'foto' com o caminho pÃºblico
 * ========================================================================== */
router.post("/:id/foto", upload.single("foto"), async (req, res) => {
  const { id } = req.params; // cÃ³digo do aluno
  if (!req.file) {
    return res.status(400).json({ message: "Nenhuma foto enviada." });
  }
  try {
    const fotoPath = `/uploads/CEF04_PLAN/alunos/${req.file.filename}`;
    await pool.query("UPDATE alunos SET foto = ? WHERE codigo = ?", [fotoPath, id]);
    return res.status(200).json({ foto: fotoPath });
  } catch (err) {
    console.error("Erro ao atualizar foto no DB:", err);
    return res.status(500).json({ message: "Erro ao inserir foto no servidor." });
  }
});

/* ============================================================================
 * 11) IMPORTAR PDF â€” Formato EDUCADF 2025 (novo portal da SEEDF)
 * POST /api/alunos/importar-pdf (arquivo: file)
 *
 * Novo formato: 11 colunas
 *   RE do Estudante | Estudante | Data de Nascimento | CPF | Sexo |
 *   Turma | Turno | SÃ©rie | Contato Emergencial | Nome ResponsÃ¡vel | CPF ResponsÃ¡vel
 *
 * Novidades vs. formato antigo:
 *   - Turma identificada pela coluna "Turma" do PDF (nÃ£o pelo nome do arquivo)
 *   - Novos campos: CPF do aluno, Sexo, SÃ©rie, Telefone do responsÃ¡vel
 *   - Parser com separaÃ§Ã£o por pÃ¡gina (evita colisÃ£o de Y entre pÃ¡ginas)
 *   - Nomes longos que quebram para linha abaixo/acima sÃ£o corretamente montados
 *
 * flags opcionais no body:
 *   semTurma=true â†’ importa sem turma (turma_id=null) quando turma nÃ£o existe
 * ========================================================================== */
const uploadPdf = multer(); // usa buffer
router.post("/importar-pdf", verificarGovernancaImportacaoAlunos, uploadPdf.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: "PDF nÃ£o enviado." });
  }

  try {
    const { escola_id } = req.user;
    const anoLetivoAtual = typeof anoLetivoPadrao === "function" ? anoLetivoPadrao() : String(new Date().getFullYear());
    const semTurma = req.body.semTurma === "true" || req.body.semTurma === true;

    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // FASE 1: ExtraÃ§Ã£o posicional com separaÃ§Ã£o por pÃ¡gina
    // Evita que Y=600 da pÃ¡gina 1 colida com Y=600 da pÃ¡gina 2
    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const allItems = [];
    let pageCounter = 0;

    await pdfParse(req.file.buffer, {
      pagerender: async (pageData) => {
        pageCounter++;
        const pg = pageCounter;
        const tc = await pageData.getTextContent();
        for (const item of tc.items) {
          const txt = (item.str || "").trim();
          if (!txt) continue;
          allItems.push({
            text: txt,
            x: Math.round(item.transform[4]),
            y: Math.round(item.transform[5]),
            page: pg,
          });
        }
        return "";
      },
    });

    // Agrupa por chave "pÃ¡gina-Y" (tolerÃ¢ncia 3px no Y)
    const rowsMap = {};
    for (const it of allItems) {
      const yKey = Math.round(it.y / 3) * 3;
      const key = `${it.page}-${yKey}`;
      if (!rowsMap[key]) rowsMap[key] = [];
      rowsMap[key].push(it);
    }

    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // FASE 2: Detecta cabeÃ§alho por pÃ¡gina
    // O cabeÃ§alho tem "RE do Estudante" (ou "RE") + "Turma" + "CPF"
    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const headerYByPage = {};
    for (const [key, items] of Object.entries(rowsMap)) {
      const [pgStr, yStr] = key.split("-");
      const pg = Number(pgStr);
      const y = Number(yStr);
      const textos = items.map((it) => it.text.toUpperCase());
      const hasRE = textos.some((t) => /^RE(\s|$)/.test(t) || t.startsWith("RE DO"));
      const hasTurma = textos.some((t) => t === "TURMA");
      const hasCPF = textos.some((t) => t === "CPF");
      if (hasRE && hasTurma && hasCPF) {
        if (!(pg in headerYByPage) || y > headerYByPage[pg]) {
          headerYByPage[pg] = y;
        }
      }
    }
    console.log(`[importar-pdf-novo] ${pageCounter} pÃ¡gina(s), cabeÃ§alhos:`, headerYByPage);

    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // FASE 3: Ranges de colunas calibrados nas posiÃ§Ãµes reais dos dados
    // (os dados tÃªm X diferentes dos cabeÃ§alhos pelo zoom de renderizaÃ§Ã£o)
    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const COL_RANGES = {
      re:       { min:  68, max: 130 },   // RE: ~80
      nome:     { min: 130, max: 270 },   // Estudante: ~154-165
      dataNasc: { min: 270, max: 373 },   // Data Nasc: ~279-281
      cpfAluno: { min: 373, max: 487 },   // CPF aluno: ~375-376
      sexo:     { min: 480, max: 590 },   // Sexo: ~487-489
      turma:    { min: 580, max: 690 },   // Turma: ~591
      turno:    { min: 680, max: 800 },   // Turno: ~689
      serie:    { min: 793, max: 865 },   // SÃ©rie: ~802
      contato:  { min: 865, max: 960 },   // Contato Emergencial: ~895
      nomeResp: { min: 960, max: 1090 },  // Nome ResponsÃ¡vel: ~971-984
      cpfResp:  { min: 1090, max: 1300 }, // CPF ResponsÃ¡vel: ~1100-1102
    };

    function getCol(x) {
      for (const [col, range] of Object.entries(COL_RANGES)) {
        if (x >= range.min && x < range.max) return col;
      }
      return null;
    }

    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // FASE 4: Classifica cada linha como "data row" ou "continuation"
    // Ordena por pÃ¡gina asc, depois Y desc (topâ†’bottom dentro de cada pÃ¡gina)
    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const sortedKeys = Object.keys(rowsMap).sort((a, b) => {
      const [pa, ya] = a.split("-").map(Number);
      const [pb, yb] = b.split("-").map(Number);
      if (pa !== pb) return pa - pb;
      return yb - ya; // Y maior = mais alto na pÃ¡gina
    });

    const classifiedRows = [];
    for (const key of sortedKeys) {
      const [pgStr, yStr] = key.split("-");
      const pg = Number(pgStr);
      const yKey = Number(yStr);
      const headerY = headerYByPage[pg];
      // Ignora cabeÃ§alho, tÃ­tulo, rodapÃ© (Y >= headerY ou ausente)
      if (!headerY || yKey >= headerY) continue;

      const lineItems = rowsMap[key].sort((a, b) => a.x - b.x);
      const rowData = {};
      for (const it of lineItems) {
        const col = getCol(it.x);
        if (col) {
          rowData[col] = rowData[col] ? rowData[col] + " " + it.text : it.text;
        }
      }
      const reRaw = (rowData.re || "").replace(/\D/g, "").trim();
      const isDataRow = /^\d{4,7}$/.test(reRaw);
      classifiedRows.push({ key, pg, yKey, rowData, isDataRow });
    }

    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // FASE 5: Merge de continuation rows
    // Nomes longos podem ter fragmentos ACIMA ou ABAIXO do data row.
    // Algoritmo: para cada data row, tudo entre ela e o data row
    // adjacente (anterior/posterior da mesma pÃ¡gina) Ã© continuaÃ§Ã£o.
    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    // Agrupa data rows por pÃ¡gina
    const dataRowsByPage = {};
    for (const row of classifiedRows) {
      if (!row.isDataRow) continue;
      if (!dataRowsByPage[row.pg]) dataRowsByPage[row.pg] = [];
      dataRowsByPage[row.pg].push(row);
    }

    const mergedRows = [];

    for (const pg of Object.keys(dataRowsByPage)) {
      const dRows = dataRowsByPage[pg]; // jÃ¡ ordenados topâ†’bottom (Y desc)
      const allPageRows = classifiedRows.filter((r) => r.pg === Number(pg));

      for (let i = 0; i < dRows.length; i++) {
        const currentRow = dRows[i];
        // Limites do "bloco" deste aluno: entre o data row anterior e o prÃ³ximo
        const upperBound = i > 0 ? dRows[i - 1].yKey : Infinity;
        const lowerBound = i < dRows.length - 1 ? dRows[i + 1].yKey : -Infinity;

        // Coleta continuations dentro dos limites (exclui os data rows)
        const continuations = allPageRows.filter(
          (r) => !r.isDataRow && r.yKey < upperBound && r.yKey > lowerBound
        );

        const merged = { ...currentRow.rowData };
        for (const cont of continuations) {
          for (const [col, text] of Object.entries(cont.rowData)) {
            if (col === "re") continue; // nunca mescla RE
            merged[col] = merged[col] ? merged[col] + " " + text : text;
          }
        }
        mergedRows.push(merged);
      }
    }

    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // FASE 6: Limpeza e normalizaÃ§Ã£o de cada registro
    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const pdfEntries = [];
    let turmaNomePdf = null; // turma identificada pela coluna "Turma" do PDF

    for (const r of mergedRows) {
      const re = (r.re || "").replace(/\D/g, "").trim();
      if (!/^\d{4,7}$/.test(re)) continue;

      // Nome: remove fragmentos de data e nÃºmeros que possam ter vazado
      const estudante = (r.nome || "")
        .replace(/\d{2}\/\d{2}\/\d{4}/g, "")
        .replace(/\s{2,}/g, " ")
        .trim();
      if (!estudante) continue;

      // Data de nascimento (extrai dd/mm/yyyy, ignora lixo)
      const dataMatch = (r.dataNasc || "").match(/(\d{2}\/\d{2}\/\d{4})/);
      const dataBr = dataMatch ? dataMatch[1] : "";

      // CPF do aluno (11 dÃ­gitos)
      const cpfAlunoDigitos = (r.cpfAluno || "").replace(/\D/g, "");
      const cpfAluno = cpfAlunoDigitos.length === 11 ? cpfAlunoDigitos : null;

      // Sexo: armazena como "Masculino"/"Feminino" (varchar(10) no BD)
      const sexoRaw = (r.sexo || "").trim();
      const sexo = /masculino/i.test(sexoRaw) ? "Masculino"
                 : /feminino/i.test(sexoRaw)  ? "Feminino"
                 : null;

      // SÃ©rie
      const serie = (r.serie || "").trim() || null;

      // Turma: captura uma vez (todas as linhas terÃ£o o mesmo valor)
      const turmaRaw = (r.turma || "").trim();
      if (turmaRaw && !turmaNomePdf) {
        // Normaliza "7Âº Ano - A" â†’ "7Âº ANO A"
        turmaNomePdf = turmaRaw
          .toUpperCase()
          .replace(/\s*-\s*/g, " ")
          .replace(/\s+/g, " ")
          .trim();
      }

      // Contato Emergencial = telefone do responsÃ¡vel
      const contatoRaw = (r.contato || "").trim();
      const telefone = contatoRaw && contatoRaw !== "-"
        ? contatoRaw.replace(/\D/g, "").substring(0, 20) || null
        : null;

      // Nome do responsÃ¡vel
      const nomeResp = (r.nomeResp || "").trim() || null;

      // CPF do responsÃ¡vel
      const cpfRespDigitos = (r.cpfResp || "").replace(/\D/g, "");
      const cpfResponsavel = cpfRespDigitos.length === 11 ? cpfRespDigitos : null;

      pdfEntries.push({
        codigo: re,
        estudante,
        dataBr,
        cpfAluno,
        sexo,
        serie,
        telefone,
        responsavel: nomeResp,
        cpfResponsavel,
      });
    }

    console.log(
      `[importar-pdf-novo] ExtraÃ­dos: ${pdfEntries.length} alunos | Turma PDF: "${turmaNomePdf}"`
    );

    if (pdfEntries.length === 0) {
      return res.status(400).json({
        message:
          "Nenhum aluno encontrado no PDF. Verifique se o arquivo estÃ¡ no formato EDUCADF 2025.",
      });
    }

    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // FASE 7: IdentificaÃ§Ã£o da turma no BD via coluna "Turma" do PDF
    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    let turma_id = null;

    if (!semTurma) {
      if (!turmaNomePdf) {
        return res.status(400).json({
          message: "NÃ£o foi possÃ­vel identificar a turma no PDF.",
        });
      }

      // Busca exata (UPPER + TRIM + normaliza " - " â†’ " ")
      const [[turma]] = await pool.query(
        `SELECT id, nome FROM turmas
         WHERE UPPER(TRIM(REPLACE(nome, ' - ', ' '))) = ?
           AND escola_id = ?
           AND ano = ?
         ORDER BY id DESC LIMIT 1`,
        [turmaNomePdf, escola_id, anoLetivoAtual]
      );

      if (!turma) {
        // Retorna estruturado para o frontend exibir modal premium
        return res.status(404).json({
          code: "TURMA_NAO_ENCONTRADA",
          message: `Turma "${turmaNomePdf}" nÃ£o encontrada no sistema para o ano letivo ${anoLetivoAtual}.`,
          turmaNaoEncontrada: turmaNomePdf,
        });
      }

      turma_id = turma.id;
      console.log(`[importar-pdf-novo] Turma encontrada: id=${turma_id} nome="${turma.nome}"`);
    }

    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // FASE 8: SituaÃ§Ã£o atual no BD para a turma (duas fontes)
    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    await ensureNomeSocialReady();
    const atuaisIdSet = new Set();
    const atuais = [];

    if (turma_id) {
      const [atuaisMatricula] = await pool.query(
        `SELECT a.id, a.codigo, a.estudante, a.nome_registro, a.usa_nome_social, a.nome_social, 'ativo' AS status
         FROM matriculas m
         INNER JOIN alunos a ON a.id = m.aluno_id
         WHERE m.turma_id = ? AND m.ano_letivo = ? AND m.escola_id = ? AND m.status = 'ativo'`,
        [turma_id, anoLetivoAtual, escola_id]
      );
      const [atuaisAlunos] = await pool.query(
        `SELECT a.id, a.codigo, a.estudante, a.nome_registro, a.usa_nome_social, a.nome_social, a.status
         FROM alunos a
         WHERE a.turma_id = ? AND a.escola_id = ? AND a.status = 'ativo'`,
        [turma_id, escola_id]
      );
      for (const a of atuaisMatricula) {
        if (!atuaisIdSet.has(a.id)) { atuaisIdSet.add(a.id); atuais.push(a); }
      }
      for (const a of atuaisAlunos) {
        if (!atuaisIdSet.has(a.id)) { atuaisIdSet.add(a.id); atuais.push(a); }
      }
    }

    const normName = (s) =>
      (s || "").toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim();

    const atuaisMap = new Map(atuais.map((a) => [String(a.codigo), a]));
    const atuaisNomeMap = new Map();
    for (const a of atuais) {
      registrarChavesNomeAluno(atuaisNomeMap, a, normName);
    }

    const entradaSet = new Set(pdfEntries.map((e) => String(e.codigo)));
    const toInsert = [];
    const toReactivate = [];
    let jaExistiam = 0;
    let atualizadosCodigo = 0;

    for (const e of pdfEntries) {
      const cod = String(e.codigo);
      let atual = atuaisMap.get(cod);

      // Fallback: match por nome (cobre migraÃ§Ã£o ieducarâ†’educadf com RE diferente)
      if (!atual) {
        const nomeKey = normName(e.estudante);
        const porNome = atuaisNomeMap.get(nomeKey);
        if (porNome) {
          console.log(
            `[importar-pdf-novo] Match por nome: "${e.estudante}" â€” cÃ³digo ${porNome.codigo} â†’ ${e.codigo}`
          );
          await pool.query(
            "UPDATE alunos SET codigo = ? WHERE id = ? AND escola_id = ?",
            [e.codigo, porNome.id, escola_id]
          );
          atualizadosCodigo++;
          atual = porNome;
          atuaisMap.set(cod, porNome);
          atuaisNomeMap.delete(nomeKey);
          entradaSet.add(String(porNome.codigo));
        }
      }

      if (!atual) {
        toInsert.push(e);
      } else if (atual.status === "inativo") {
        toReactivate.push(e);
      } else {
        // Aluno jÃ¡ existe e estÃ¡ ativo â€” complementa campos NULL
        jaExistiam++;
        const sets = [];
        const params = [];

        const dataValida = e.dataBr && /^\d{2}\/\d{2}\/\d{4}$/.test(e.dataBr);
        if (dataValida) {
          sets.push("data_nascimento = COALESCE(data_nascimento, STR_TO_DATE(?, '%d/%m/%Y'))");
          params.push(e.dataBr);
        }
        if (e.sexo) {
          sets.push("sexo = IF(sexo IS NULL OR sexo = '', ?, sexo)");
          params.push(e.sexo);
        }
        if (e.cpfAluno) {
          sets.push("cpf = IF(cpf IS NULL OR cpf = '', ?, cpf)");
          params.push(e.cpfAluno);
        }
        if (e.serie) {
          sets.push("serie = IF(serie IS NULL OR serie = '', ?, serie)");
          params.push(e.serie);
        }
        if (sets.length > 0) {
          params.push(atual.id, escola_id);
          await pool.query(
            `UPDATE alunos SET ${sets.join(", ")} WHERE id = ? AND escola_id = ?`,
            params
          );
        }

        await upsertResponsavelPdf(pool, e, atual.id, escola_id);
      }
    }

    if (atualizadosCodigo > 0) {
      console.log(`[importar-pdf-novo] ${atualizadosCodigo} cÃ³digo(s) atualizado(s) (ieducarâ†’educadf)`);
    }

    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // FASE 9: Inserir novos alunos
    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    let inseridos = 0;
    for (const e of toInsert) {
      const dataValida = e.dataBr && /^\d{2}\/\d{2}\/\d{4}$/.test(e.dataBr);
      const baseParams = [e.codigo, e.estudante, e.estudante];
      let insertSql;

      if (dataValida) {
        insertSql = `INSERT INTO alunos (codigo, estudante, nome_registro, data_nascimento, sexo, cpf, serie, turma_id, escola_id, status)
          VALUES (?, ?, ?, STR_TO_DATE(?, '%d/%m/%Y'), ?, ?, ?, ?, ?, 'ativo')
          ON DUPLICATE KEY UPDATE
            id = LAST_INSERT_ID(id),
            nome_registro = VALUES(nome_registro),
            estudante = IF(usa_nome_social = 1 AND nome_social IS NOT NULL AND TRIM(nome_social) <> '', nome_social, VALUES(estudante)),
            data_nascimento = COALESCE(data_nascimento, VALUES(data_nascimento)),
            sexo  = IF(sexo  IS NULL OR sexo  = '', VALUES(sexo),  sexo),
            cpf   = IF(cpf   IS NULL OR cpf   = '', VALUES(cpf),   cpf),
            serie = IF(serie IS NULL OR serie = '', VALUES(serie),  serie),
            turma_id = VALUES(turma_id),
            status = 'ativo'`;
        baseParams.push(e.dataBr, e.sexo || null, e.cpfAluno || null, e.serie || null, turma_id, escola_id);
      } else {
        insertSql = `INSERT INTO alunos (codigo, estudante, nome_registro, sexo, cpf, serie, turma_id, escola_id, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ativo')
          ON DUPLICATE KEY UPDATE
            id = LAST_INSERT_ID(id),
            nome_registro = VALUES(nome_registro),
            estudante = IF(usa_nome_social = 1 AND nome_social IS NOT NULL AND TRIM(nome_social) <> '', nome_social, VALUES(estudante)),
            sexo  = IF(sexo  IS NULL OR sexo  = '', VALUES(sexo),  sexo),
            cpf   = IF(cpf   IS NULL OR cpf   = '', VALUES(cpf),   cpf),
            serie = IF(serie IS NULL OR serie = '', VALUES(serie),  serie),
            turma_id = VALUES(turma_id),
            status = 'ativo'`;
        baseParams.push(e.sexo || null, e.cpfAluno || null, e.serie || null, turma_id, escola_id);
      }

      const [result] = await pool.query(insertSql, baseParams);
      const alunoId = result.insertId;

      if (alunoId && turma_id) {
        const [matr] = await pool.query(
          "SELECT id FROM matriculas WHERE aluno_id = ? AND ano_letivo = ? AND escola_id = ?",
          [alunoId, anoLetivoAtual, escola_id]
        );
        if (matr.length > 0) {
          await pool.query(
            "UPDATE matriculas SET status = 'ativo', turma_id = ? WHERE id = ?",
            [turma_id, matr[0].id]
          );
        } else {
          await pool.query(
            "INSERT INTO matriculas (escola_id, aluno_id, turma_id, ano_letivo, status) VALUES (?, ?, ?, ?, 'ativo')",
            [escola_id, alunoId, turma_id, anoLetivoAtual]
          );
        }
      }

      if (alunoId) await upsertResponsavelPdf(pool, e, alunoId, escola_id);
      inseridos++;
    }

    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // FASE 10: Reativar inativos que voltaram
    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    let reativados = 0;
    for (const e of toReactivate) {
      const atualObj = atuaisMap.get(String(e.codigo));
      const dataValida = e.dataBr && /^\d{2}\/\d{2}\/\d{4}$/.test(e.dataBr);

      const sets = ["status = 'ativo'", "turma_id = ?"];
      const params = [turma_id];

      if (dataValida) {
        sets.push("data_nascimento = COALESCE(data_nascimento, STR_TO_DATE(?, '%d/%m/%Y'))");
        params.push(e.dataBr);
      }
      if (e.sexo) {
        sets.push("sexo = IF(sexo IS NULL OR sexo = '', ?, sexo)");
        params.push(e.sexo);
      }
      if (e.cpfAluno) {
        sets.push("cpf = IF(cpf IS NULL OR cpf = '', ?, cpf)");
        params.push(e.cpfAluno);
      }
      if (e.serie) {
        sets.push("serie = IF(serie IS NULL OR serie = '', ?, serie)");
        params.push(e.serie);
      }
      params.push(e.codigo, escola_id);

      await pool.query(
        `UPDATE alunos SET ${sets.join(", ")} WHERE codigo = ? AND escola_id = ?`,
        params
      );

      const alunoId = atualObj?.id;
      if (alunoId && turma_id) {
        const [matr] = await pool.query(
          "SELECT id FROM matriculas WHERE aluno_id = ? AND ano_letivo = ? AND escola_id = ?",
          [alunoId, anoLetivoAtual, escola_id]
        );
        if (matr.length > 0) {
          await pool.query(
            "UPDATE matriculas SET status = 'ativo', turma_id = ? WHERE id = ?",
            [turma_id, matr[0].id]
          );
        } else {
          await pool.query(
            "INSERT INTO matriculas (escola_id, aluno_id, turma_id, ano_letivo, status) VALUES (?, ?, ?, ?, 'ativo')",
            [escola_id, alunoId, turma_id, anoLetivoAtual]
          );
        }
      }
      if (alunoId) await upsertResponsavelPdf(pool, e, alunoId, escola_id);
      reativados++;
    }

    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // FASE 11: Detectar ausentes (alunos no BD que nÃ£o estÃ£o no PDF)
    // NÃ£o inativa automaticamente â€” retorna para confirmaÃ§Ã£o manual
    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const pendentesInativacao = [];
    for (const atual of atuais) {
      if (atual.status !== "ativo") continue;
      const cod = String(atual.codigo);
      const noCodigoPdf = entradaSet.has(cod);
      const noNomePdf = pdfEntries.some((e) => nomeCorrespondeAoAluno(e.estudante, atual, normName));
      if (!noCodigoPdf && !noNomePdf) {
        pendentesInativacao.push({
          id: atual.id,
          codigo: atual.codigo,
          estudante: atual.estudante,
        });
      }
    }

    if (pendentesInativacao.length > 0) {
      console.log(
        `[importar-pdf-novo] âš  ${pendentesInativacao.length} aluno(s) ausente(s) â€” pendentes de confirmaÃ§Ã£o`
      );
    }

    console.log(
      `[importar-pdf-novo] localizados:${pdfEntries.length} inseridos:${inseridos} reativados:${reativados} jaExistiam:${jaExistiam} pendentes:${pendentesInativacao.length}`
    );

    return res.json({
      localizados: pdfEntries.length,
      inseridos,
      reativados,
      jaExistiam,
      codigosAtualizados: atualizadosCodigo,
      inativados: 0,
      pendentesInativacao,
      listaAlunos: pdfEntries,
    });
  } catch (err) {
    console.error("Erro ao processar /importar-pdf:", err);
    return res.status(500).json({ message: "Erro ao processar PDF.", error: err.message });
  }
});

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Helper: Upsert de responsÃ¡vel com telefone (novo campo)
// Regra de proteÃ§Ã£o: nÃ£o sobrescreve nome/telefone jÃ¡ existente no BD
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function upsertResponsavelPdf(pool, e, alunoId, escola_id) {
  if (!e.cpfResponsavel) return; // CPF Ã© chave natural â€” sem ele nÃ£o hÃ¡ upsert seguro
  const nomeResp = (e.responsavel || "").trim();
  try {
    const [respResult] = await pool.query(
      `INSERT INTO responsaveis (nome, cpf, telefone)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE
         id       = LAST_INSERT_ID(id),
         nome     = IF(nome     IS NULL OR nome     = '', VALUES(nome),     nome),
         telefone = IF(telefone IS NULL OR telefone = '', VALUES(telefone), telefone)`,
      [nomeResp || null, e.cpfResponsavel, e.telefone || null]
    );
    const responsavelId = respResult.insertId;
    if (responsavelId && alunoId) {
      const [[vinculo]] = await pool.query(
        "SELECT id FROM responsaveis_alunos WHERE responsavel_id = ? AND aluno_id = ? AND escola_id = ?",
        [responsavelId, alunoId, escola_id]
      );
      if (!vinculo) {
        await pool.query(
          "INSERT INTO responsaveis_alunos (escola_id, responsavel_id, aluno_id, relacionamento, ativo) VALUES (?, ?, ?, 'RESPONSAVEL', 1)",
          [escola_id, responsavelId, alunoId]
        );
      }
    }
  } catch (err) {
    console.warn(`[importar-pdf] Falha ao vincular responsÃ¡vel do aluno ${e.codigo}:`, err.message);
  }
}


/* ============================================================================
 * 11b) IMPORTAR CSV — Formato EDUCADF (portal oficial SEEDF)
 * POST /api/alunos/importar-csv (arquivo: file)
 *
 * Padrão atual EDUCADF (11 colunas, separador ;):
 *   Linha título: "... - Lista de alunos da Turma 6º Ano - A"
 *   Cabeçalho:    Nº | RE do Estudante | NOME | DATA_DE_NASCIMENTO | CPF | SEXO |
 *                 CONTATO_EMERGENCIAL | NOME RESPONSÁVEL | CPF RESPONSÁVEL |
 *                 ENDEREÇO | ANEES
 *
 * Também mantém retrocompatibilidade automática com variações do EDUCADF:
 *   - Cabeçalho em qualquer linha inicial (0..15), com ou sem linha de título
 *   - Separador ';', ',' ou '\t' e codificação UTF-8 (com/sem BOM) ou Windows-1252 (Excel)
 *   - Colunas extras opcionais (STATUS_MATRÍCULA, NOME SOCIAL, FILIAÇÃO 1/2, etc.)
 *   - Deduplicação inteligente de linhas repetidas do mesmo aluno no CSV
 *   - Ativação automática de `atendimento_diferencial = 1` (AEE) quando `ANEES` vier preenchido
 * ========================================================================== */

let _csvSchemaReadyPromise = null;
function ensureCsvColumnsReady() {
  if (!_csvSchemaReadyPromise) {
    _csvSchemaReadyPromise = (async () => {
      try {
        const [colsAlunos] = await pool.query(`
          SELECT COLUMN_NAME
            FROM INFORMATION_SCHEMA.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE()
             AND TABLE_NAME = 'alunos'
             AND COLUMN_NAME IN ('anees', 'atendimento_diferencial')
        `);
        const setAlunos = new Set(colsAlunos.map((c) => c.COLUMN_NAME));
        if (!setAlunos.has("anees")) {
          await pool.query("ALTER TABLE alunos ADD COLUMN anees TEXT DEFAULT NULL");
        }
        if (!setAlunos.has("atendimento_diferencial")) {
          await pool.query(
            "ALTER TABLE alunos ADD COLUMN atendimento_diferencial TINYINT(1) NOT NULL DEFAULT 0"
          );
        }
      } catch (e) {
        console.warn("[importar-csv] ensureCsvColumnsReady warning:", e.message);
      }
    })();
  }
  return _csvSchemaReadyPromise;
}

function decodificarBufferCsvEducaDF(buffer) {
  let texto = "";
  try {
    texto = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    try {
      texto = new TextDecoder("windows-1252").decode(buffer);
    } catch {
      texto = buffer.toString("latin1");
    }
  }
  return texto
    .replace(/^\uFEFF/, "")
    .replace(/Ã‚Âº/g, "º")
    .replace(/Ã‚Âª/g, "ª")
    .replace(/Âº/g, "º")
    .replace(/Âª/g, "ª");
}

function limparTextoCsv(valor) {
  return String(valor ?? "")
    .replace(/[\u00A0\t\r\n]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function parseLinhaCsvEducaDF(line, delimiter = ";") {
  const campos = [];
  let campo = "";
  let emAspas = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (emAspas && line[i + 1] === '"') {
        campo += '"';
        i++;
        continue;
      }
      emAspas = !emAspas;
      continue;
    }
    if (c === delimiter && !emAspas) {
      campos.push(limparTextoCsv(campo));
      campo = "";
      continue;
    }
    campo += c;
  }
  campos.push(limparTextoCsv(campo));
  return campos;
}

function normalizarColunaHeaderCsv(col) {
  return limparTextoCsv(col)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizarTurmaComparacaoCsv(s) {
  return limparTextoCsv(s)
    .replace(/Ã‚Âº|Âº/g, "º")
    .replace(/Ã‚Âª|Âª/g, "ª")
    .replace(/\(\d+\)\s*$/g, "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[º°ª]/g, "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function validarCpf11Csv(raw) {
  const d = String(raw || "").replace(/\D/g, "");
  if (d.length !== 11 || /^(\d)\1+$/.test(d)) return null;
  return d;
}

function extrairDataBrCsv(raw) {
  const s = limparTextoCsv(raw);
  const mBr = s.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (mBr) return `${mBr[1]}/${mBr[2]}/${mBr[3]}`;
  const mIso = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (mIso) return `${mIso[3]}/${mIso[2]}/${mIso[1]}`;
  return "";
}

function extrairSexoCsv(raw) {
  const s = limparTextoCsv(raw);
  if (!s) return null;
  if (/^(masculino|masc|m)$/i.test(s) || /masculino/i.test(s)) return "Masculino";
  if (/^(feminino|fem|f)$/i.test(s) || /feminino/i.test(s)) return "Feminino";
  return null;
}

export function ehValorAneesLegitimo(raw, contexto = {}) {
  const s = limparTextoCsv(raw);
  if (!s) return false;

  const norm = (v) =>
    limparTextoCsv(v)
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toUpperCase()
      .replace(/\s+/g, " ")
      .trim();

  const sNorm = norm(s);
  if (!sNorm) return false;

  // 1. Marcadores vazios / status cadastrais / sexo
  if (
    /^(-+|NAO(\s+POSSUI|\s+CONSTA|\s+INFORMADO|\s+SE\s+APLICA|\s+DECLARADO)?|NENHUM[A]?|SEM(\s+NECESSIDADE.*|\s+LAUDO|\s+ATENDIMENTO|\s+DEFICIENCIA)?|N\/?A|NULL|ATIVO|INATIVO|MATRICULADO|CURSANDO|TRANSFERIDO|MASCULINO|FEMININO|PENDENTE|RESPONSAVEL)$/.test(
      sNorm
    )
  ) {
    return false;
  }

  // 2. Números puros, CPF, telefone, CEP ou datas
  if (
    /^\d+$/.test(sNorm.replace(/[\s.()/-]+/g, "")) ||
    /^\d{2}\/\d{2}\/\d{4}$/.test(sNorm) ||
    /^\d{4}-\d{2}-\d{2}$/.test(sNorm)
  ) {
    return false;
  }

  // 3. Comparação direta com nome do estudante ou de qualquer responsável/filiação
  const nomesProibidos = [
    contexto.estudante,
    contexto.nomeRegistro,
    contexto.nomeSocial,
    ...(Array.isArray(contexto.responsaveis) ? contexto.responsaveis : []),
  ]
    .map(norm)
    .filter((n) => n.length >= 3);

  for (const nomeProibido of nomesProibidos) {
    if (sNorm === nomeProibido) return false;
  }

  // 4. Padrões típicos de endereço residencial (ex.: Quadra, Conjunto, Lote, Casa, SRL, Arapoanga)
  if (
    /\b(QUADRA|QD|CONJUNTO|CONJ|CJ|CASA|LOTE|LT|CHACARA|APTO|APARTAMENTO|BLOCO|AVENIDA|ESTRADA|RODOVIA|CONDOMINIO|RESIDENCIAL|FAZENDA|ESTANCIA|ARAPOANGA|PLANALTINA|JARDIM\s+RORIZ|MESTRE\s+D\s*ARMAS|SRL)\b/.test(
      sNorm
    )
  ) {
    return false;
  }

  // 5. Verifica se cada segmento contém sigla oficial isolada, código CID ou termo clínico/educacional AEE
  const sProtegido = sNorm.replace(/\bAH\s*\/\s*SD\b/g, "AH_SD");
  const segmentos = sProtegido
    .split(/[,;|/]+/)
    .map((seg) => seg.trim())
    .filter(Boolean);

  if (segmentos.length === 0) return false;

  const REGEX_SIGLA_ISOLADA =
    /^(TEA|TGD|DF|DI|DA|DV|BV|VM|SC|DMU|AH_SD|AH\s+SD|SD|TDAH|TDA|TOD|TC|TPAC|DPAC|PAC|TDL|DEL|TFE|SURDEZ|CEGUEIRA)(\s*[-–:(].*)?$/;

  const REGEX_CID = /\b(CID\s*[-:]?\s*[A-Z0-9]{2,6}|[FGHQ]\d{2}(\.\d+)?|6A\d{2}(\.\w+)?)\b/;

  const REGEX_CLINICO_AEE =
    /\b(TRANSTORN|DEFICIEN|AUTISM|ESPECTRO|ASPERGER|SINDROME\s+DE\s+RETT|DESINTEGRATIVO|SURDOCEGUEIR|SURDEZ|SURDO|SURDA|HIPOACUS|AUDITIV|AUDICAO|CEGUEIR|BAIXA\s+VISAO|VISAO\s+SUBNORMAL|VISAO\s+MONOCULAR|VISUAL|INTELECTUAL|MENTAL|FISIC|MOTOR|PARALISIA|OSTOMIA|MOBILIDADE|MULTIPL|ALTAS\s+HABILIDADES|SUPERDOT|SINDROME|TRISSOMIA|HIPERATIV|DEFICIT|ATENCAO|OPOSIT|DESAFIADOR|PROCESSAMENTO|LINGUAGEM|APRENDIZAGEM|DISLEX|DISCALCUL|DISGRAF|DISORTOGRAF|DISLAL|AFASIA|APRAXIA|DISFASIA|DISARTRIA|DISFLUENC|GAGUEIRA|MUTISMO|EPILEPS|CONVULS|ESQUIZOFREN|PSICOS|BIPOLAR|ANSIEDADE|DEPRESS|TOC|TOURETTE|NEURO|COGNITIV|ATRASO\s+(GLOBAL|NEURO|PSICOMOTOR|COGNITIV|DE\s+LINGUAGEM|DO\s+DESENVOLVIMENTO|MENTAL)|CADEIRANTE|CADEIRA\s+DE\s+RODAS|NANISMO|BAIXA\s+ESTATURA|MALFORMAC|AMPUTAC|HIDROCEFAL|MICROCEFAL|MIELOMENINGOCELE|DISTROFIA|ATROFIA|DISPLASIA|ESCLEROSE|FIBROSE|FIBROMIALG|ESCOLIOSE|CIFOSE|ARTRO|OSTEO|PLEGIA|PARESIA|ATAXIA|FISSURA|LABIOPALATIN|CARDIOPAT|NEFROPAT|HEPATOPAT|DIABET|HEMOFIL|FALCIFORME|CELIAC|COCLEAR|PROTESE|ORTESE|LIBRAS|BRAILLE|NECESSIDADES?\s+ESPECIAIS|EDUCACIONAL\s+ESPECIALIZAD|ATENDIMENTO\s+DIFERENCIAL|AEE|ANEE|ANEES)/;

  return segmentos.some(
    (seg) =>
      REGEX_SIGLA_ISOLADA.test(seg) ||
      REGEX_CID.test(seg) ||
      REGEX_CLINICO_AEE.test(seg)
  );
}

export function abreviarAneesEducaDF(raw, opcoes = {}) {
  const textoLimpo = limparTextoCsv(raw);
  if (!textoLimpo) {
    return { siglas: [], textoSiglas: "", itens: [], valido: false };
  }

  const permitirTextoLivreManual = Boolean(opcoes.permitirTextoLivreManual);
  const valido = ehValorAneesLegitimo(textoLimpo, opcoes.contexto || {});
  if (!valido && !permitirTextoLivreManual) {
    return { siglas: [], textoSiglas: "", itens: [], valido: false };
  }

  const REGRAS_ANEES = [
    {
      sigla: "SC",
      descricao: "Surdocegueira",
      regexFrase: /SURDOCEGUEIR/,
      regexSigla: /^SC(\s*[-–:(].*)?$/,
    },
    {
      sigla: "TEA",
      descricao: "Transtorno do Espectro Autista",
      regexFrase:
        /ESPECTRO AUTISTA|\bAUTISM|\bASPERGER\b|SINDROME DE RETT|DESINTEGRATIVO DA INFANCIA/,
      regexSigla: /^TEA(\s*[-–:(].*)?$/,
    },
    {
      sigla: "TGD",
      descricao: "Transtorno Global do Desenvolvimento",
      regexFrase: /GLOBAL DO DESENVOLVIMENTO/,
      regexSigla: /^TGD(\s*[-–:(].*)?$/,
    },
    {
      sigla: "DF",
      descricao: "Deficiência Física",
      regexFrase:
        /DEFICIENCIA FISICA|DEFICIENCIA MOTORA|PARALISIA CEREBRAL|OSTOMIA|MOBILIDADE REDUZIDA|\bCADEIRANTE\b/,
      regexSigla: /^DF(\s*[-–:(].*)?$/,
    },
    {
      sigla: "DI",
      descricao: "Deficiência Intelectual",
      regexFrase: /DEFICIENCIA INTELECTUAL|DEFICIENCIA MENTAL|ATRASO COGNITIVO/,
      regexSigla: /^DI(\s*[-–:(].*)?$/,
    },
    {
      sigla: "DA",
      descricao: "Deficiência Auditiva",
      regexFrase: /DEFICIENCIA AUDITIVA|HIPOACUSIA/,
      regexSigla: /^DA(\s*[-–:(].*)?$/,
    },
    {
      sigla: "SURDEZ",
      descricao: "Surdez",
      regexFrase: /\bSURDEZ\b/,
      regexSigla: /^SURDEZ(\s*[-–:(].*)?$/,
      skipIfSurdocegueira: true,
    },
    {
      sigla: "BV",
      descricao: "Baixa Visão",
      regexFrase: /BAIXA VISAO|VISAO SUBNORMAL/,
      regexSigla: /^BV(\s*[-–:(].*)?$/,
    },
    {
      sigla: "VM",
      descricao: "Visão Monocular",
      regexFrase: /VISAO MONOCULAR/,
      regexSigla: /^VM(\s*[-–:(].*)?$/,
    },
    {
      sigla: "DV",
      descricao: "Deficiência Visual",
      regexFrase: /DEFICIENCIA VISUAL|\bCEGUEIRA\b/,
      regexSigla: /^DV(\s*[-–:(].*)?$/,
      skipIfSurdocegueira: true,
    },
    {
      sigla: "DMU",
      descricao: "Deficiência Múltipla",
      regexFrase: /DEFICIENCIAS? MULTIPLAS?/,
      regexSigla: /^DMU(\s*[-–:(].*)?$/,
    },
    {
      sigla: "AH/SD",
      descricao: "Altas Habilidades / Superdotação",
      regexFrase: /ALTAS HABILIDADES|SUPERDOTAC/,
      regexSigla: /^(AH_SD|AH\s+SD)(\s*[-–:(].*)?$/,
    },
    {
      sigla: "SD",
      descricao: "Síndrome de Down",
      regexFrase: /SINDROME DE DOWN|TRISSOMIA DO 21/,
      regexSigla: /^SD(\s*[-–:(].*)?$/,
    },
    {
      sigla: "TDAH",
      descricao: "Transtorno do Déficit de Atenção e Hiperatividade",
      regexFrase: /\bTDAH\b|DEFICIT DE ATENCAO|HIPERATIVIDADE/,
      regexSigla: /^(TDAH|TDA)(\s*[-–:(].*)?$/,
    },
    {
      sigla: "TOD",
      descricao: "Transtorno Opositivo Desafiador",
      regexFrase: /\bTOD\b|OPOSITOR DESAFIADOR|OPOSITIVO DESAFIADOR|DESAFIADOR OPOSITIVO/,
      regexSigla: /^TOD(\s*[-–:(].*)?$/,
    },
    {
      sigla: "TC",
      descricao: "Transtorno de Conduta",
      regexFrase: /TRANSTORNO DE CONDUTA/,
      regexSigla: /^TC(\s*[-–:(].*)?$/,
    },
    {
      sigla: "TPAC",
      descricao: "Transtorno do Processamento Auditivo Central",
      regexFrase: /\bTPAC\b|\bDPAC\b|PROCESSAMENTO AUDITIVO CENTRAL/,
      regexSigla: /^(TPAC|DPAC|PAC)(\s*[-–:(].*)?$/,
    },
    {
      sigla: "TDL",
      descricao: "Transtorno do Desenvolvimento da Linguagem",
      regexFrase: /DESENVOLVIMENTO DA LINGUAGEM|ESPECIFICO DE LINGUAGEM|TRANSTORNO DE LINGUAGEM/,
      regexSigla: /^(TDL|DEL)(\s*[-–:(].*)?$/,
    },
    { sigla: "DISLEXIA", descricao: "Dislexia", regexFrase: /\bDISLEXIA\b/ },
    { sigla: "DISCALCULIA", descricao: "Discalculia", regexFrase: /\bDISCALCULIA\b/ },
    { sigla: "DISGRAFIA", descricao: "Disgrafia", regexFrase: /\bDISGRAFIA\b/ },
    { sigla: "DISORTOGRAFIA", descricao: "Disortografia", regexFrase: /\bDISORTOGRAFIA\b/ },
    { sigla: "DISLALIA", descricao: "Dislalia", regexFrase: /\bDISLALIA\b/ },
    {
      sigla: "TFE",
      descricao: "Transtorno Funcional Específico",
      regexFrase: /FUNCIONAL ESPECIFICO|ESPECIFICO DE APRENDIZAGEM/,
      regexSigla: /^TFE(\s*[-–:(].*)?$/,
    },
  ];

  // Protege "AH/SD" e "ALTAS HABILIDADES/SUPERDOTAÇÃO" antes de dividir por separadores
  const textoProtegido = textoLimpo
    .replace(/\bAH\s*\/\s*SD\b/gi, "AH_SD")
    .replace(/ALTAS\s+HABILIDADES\s*\/\s*SUPERDOTA/gi, "ALTAS HABILIDADES E SUPERDOTA");

  const segmentos = textoProtegido
    .split(/[,;|/]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const vistos = new Set();
  const itens = [];

  for (const segBruto of segmentos) {
    const seg = segBruto.replace(/\bAH_SD\b/gi, "AH/SD");
    const segNorm = segBruto
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toUpperCase()
      .replace(/\s+/g, " ")
      .trim();
    if (!segNorm) continue;

    const temSurdocegueira = /SURDOCEGUEIR/.test(segNorm);
    let bateuRegra = false;

    for (const r of REGRAS_ANEES) {
      if (r.skipIfSurdocegueira && temSurdocegueira) continue;
      const matchFrase = r.regexFrase ? r.regexFrase.test(segNorm) : false;
      const matchSigla = r.regexSigla ? r.regexSigla.test(segNorm) : false;
      if (matchFrase || matchSigla) {
        bateuRegra = true;
        if (!vistos.has(r.sigla)) {
          vistos.add(r.sigla);
          itens.push({ sigla: r.sigla, descricao: r.descricao });
        }
      }
    }

    if (!bateuRegra && (permitirTextoLivreManual || ehValorAneesLegitimo(seg, opcoes.contexto || {}))) {
      const fallback = seg
        .replace(/\s*[-–]?\s*(BAIXAS?|M[EÉ]DIAS?|ALTAS?)\s+NECESSIDADES?\s+ESPECIAIS?/gi, "")
        .trim();
      const siglaFallback = (fallback || seg).toUpperCase();
      if (siglaFallback && !vistos.has(siglaFallback)) {
        vistos.add(siglaFallback);
        itens.push({ sigla: siglaFallback, descricao: seg });
      }
    }
  }

  const siglas = itens.map((i) => i.sigla);
  return {
    siglas,
    textoSiglas: siglas.join(", "),
    itens,
    valido: itens.length > 0,
  };
}

function extrairAneesCsv(raw, contexto = {}) {
  const s = limparTextoCsv(raw);
  if (!s) return { anees: null, aneesSigla: null, temAnees: false };
  if (!ehValorAneesLegitimo(s, contexto)) {
    return { anees: null, aneesSigla: null, temAnees: false };
  }
  const anees = s.slice(0, 500);
  const aneesSigla = abreviarAneesEducaDF(anees, { contexto }).textoSiglas || anees;
  return { anees, aneesSigla, temAnees: true };
}

function statusMatriculaInativaCsv(raw) {
  const s = limparTextoCsv(raw);
  if (!s) return false;
  return /\b(TRANSFERID|CANCELAD|REMANEJAD|DESISTENT|EVADID|ABANDON|ENCERRAD|INATIV|BAIXAD|FALECID)/i.test(
    s
  );
}

export function parseEducaDfCsvBuffer(buffer, originalname = "") {
  const raw = decodificarBufferCsvEducaDF(buffer);
  const lines = raw.split(/\r?\n/).filter((l) => l.trim());

  if (lines.length < 2) {
    return {
      ok: false,
      status: 400,
      message: "CSV inválido ou vazio.",
    };
  }

  const isColRE = (h) =>
    /^(RE|RE DO ESTUDANTE|RE ESTUDANTE|RE DO ALUNO|RE ALUNO|REGISTRO ESTUDANTIL|COD|CODIGO|CODIGO DO ESTUDANTE|CODIGO ESTUDANTE|CODIGO DO ALUNO)$/.test(
      h
    ) || /\bRE\s+DO\s+ESTUDANTE\b|\bREGISTRO\s+ESTUDANTIL\b/.test(h);

  const isColNome = (h) =>
    /^(NOME|NOME DO ESTUDANTE|NOME ESTUDANTE|NOME DO ALUNO|NOME ALUNO|NOME COMPLETO|NOME CIVIL|NOME DE REGISTRO|ESTUDANTE|ALUNO)$/.test(
      h
    );

  let headerLineIndex = -1;
  let delimiter = ";";
  let headerCols = [];
  let headerNorm = [];

  const maxScan = Math.min(lines.length - 1, 15);
  outer: for (let idx = 0; idx <= maxScan; idx++) {
    for (const candDelim of [";", ",", "\t"]) {
      const cols = parseLinhaCsvEducaDF(lines[idx], candDelim);
      if (cols.length < 2) continue;
      const norm = cols.map(normalizarColunaHeaderCsv);
      const rIdx = norm.findIndex(isColRE);
      const nIdx = norm.findIndex(isColNome);
      if (rIdx >= 0 && nIdx >= 0 && rIdx !== nIdx) {
        headerLineIndex = idx;
        delimiter = candDelim;
        headerCols = cols;
        headerNorm = norm;
        break outer;
      }
    }
  }

  if (headerLineIndex < 0) {
    return {
      ok: false,
      status: 400,
      message:
        "CSV fora do formato esperado (colunas de RE e Nome não localizadas). Verifique se é o arquivo exportado pelo portal EDUCADF.",
    };
  }

  // Extrai nome da turma das linhas de metadados anteriores ao cabeçalho (ex.: Linha 0)
  let turmaTituloCsv = "";
  for (let m = 0; m < headerLineIndex; m++) {
    const metaLimpa = limparTextoCsv(lines[m].replace(/"/g, "").replace(/;+$/g, ""));
    const matchLista = metaLimpa.match(/Lista\s+de\s+alunos\s+da\s+Turma\s+(.+?)$/i);
    if (matchLista && matchLista[1]) {
      turmaTituloCsv = limparTextoCsv(matchLista[1]);
      break;
    }
    const matchGenerico = metaLimpa.match(/\bTurma\s*[:\-]\s*(.+?)$/i);
    if (matchGenerico && matchGenerico[1]) {
      turmaTituloCsv = limparTextoCsv(matchGenerico[1]);
    }
  }

  const turmaArquivo = limparTextoCsv(
    String(originalname || "")
      .replace(/\.csv$/i, "")
      .replace(/Ã‚Âº|Âº/g, "º")
      .replace(/Ã‚Âª|Âª/g, "ª")
      .replace(/\s*\(\d+\)\s*$/g, "")
  );

  const idxRE = headerNorm.findIndex(isColRE);
  const idxNome = headerNorm.findIndex(isColNome);
  const idxNomeSocial = headerNorm.findIndex((h) => /\bNOME\s+SOCIAL\b/.test(h));
  const idxNasc = headerNorm.findIndex((h) => /DATA.*NASC|NASCIMENTO|^DT\s*NASC/.test(h));
  const idxCPF = headerNorm.findIndex((h) => /^CPF(\s+DO\s+(ESTUDANTE|ALUNO))?$/.test(h));
  const idxSexo = headerNorm.findIndex((h) => /^(SEXO|GENERO)$/.test(h));
  const idxTel = headerNorm.findIndex((h) =>
    /CONTATO.*EMERGENCIAL|TELEFONE.*RESPONS|CELULAR.*RESPONS|^CONTATO$|^TELEFONE$|^CELULAR$/.test(h)
  );
  const idxStatus = headerNorm.findIndex((h) =>
    /STATUS.*MATR|^SITUACAO(\s+DA\s+MATRICULA)?$/.test(h)
  );
  const idxResp = headerNorm.findIndex((h) => /NOME\s+(DO\s+)?RESPONS/.test(h));
  const idxCPFR = headerNorm.findIndex((h) => /CPF\s+(DO\s+)?RESPONS/.test(h));
  const idxFil1Nome = headerNorm.findIndex((h) => /NOME\s+(DA\s+)?FILIACAO\s*1|^FILIACAO\s*1$/.test(h));
  const idxFil1CPF = headerNorm.findIndex((h) => /CPF\s+(DA\s+)?FILIACAO\s*1/.test(h));
  const idxFil2Nome = headerNorm.findIndex((h) => /NOME\s+(DA\s+)?FILIACAO\s*2|^FILIACAO\s*2$/.test(h));
  const idxFil2CPF = headerNorm.findIndex((h) => /CPF\s+(DA\s+)?FILIACAO\s*2/.test(h));
  const idxEnd = headerNorm.findIndex((h) => /^ENDERECO|LOGRADOURO/.test(h));
  const idxAnees = headerNorm.findIndex(
    (h) =>
      !/RESPONS|FILIACAO|ENDERECO|CONTATO|OUTRAS/.test(h) &&
      /^ANEES$|\bANEES\b|\bAEE\b|NECESSIDADES?\s+ESPECIAIS|ATENDIMENTO\s+EDUCACIONAL|ATENDIMENTO\s+DIFERENCIAL/.test(
        h
      )
  );

  const normNomeChave = (s) =>
    limparTextoCsv(s)
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toUpperCase();

  const entriesByRe = new Map();
  const reByCpfNome = new Map();
  let totalLinhasValidas = 0;
  let duplicadosIgnorados = 0;
  let ignoradosPorStatus = 0;

  const anexarResponsavelUnico = (lista, cand) => {
    if (!cand || !cand.cpf) return;
    const existente = lista.find((r) => r.cpf === cand.cpf);
    if (existente) {
      if (!existente.nome && cand.nome) existente.nome = cand.nome;
      if (!existente.telefone && cand.telefone) existente.telefone = cand.telefone;
      if (!existente.endereco && cand.endereco) existente.endereco = cand.endereco;
    } else {
      lista.push({ ...cand });
    }
  };

  for (let i = headerLineIndex + 1; i < lines.length; i++) {
    const campos = parseLinhaCsvEducaDF(lines[i], delimiter);
    const re = String(campos[idxRE] || "").replace(/\D/g, "").trim();
    if (!/^\d{3,12}$/.test(re)) continue;

    const estudante = limparTextoCsv(campos[idxNome]);
    if (!estudante) continue;

    if (idxStatus >= 0 && statusMatriculaInativaCsv(campos[idxStatus])) {
      ignoradosPorStatus++;
      continue;
    }

    totalLinhasValidas++;

    let nomeSocial = idxNomeSocial >= 0 ? limparTextoCsv(campos[idxNomeSocial]) : "";
    if (
      !nomeSocial ||
      /^(-+|n[aã]o|nenhum[a]?|sem|null|n\/?a)$/i.test(nomeSocial) ||
      normNomeChave(nomeSocial) === normNomeChave(estudante)
    ) {
      nomeSocial = null;
    }

    const dataBr = idxNasc >= 0 ? extrairDataBrCsv(campos[idxNasc]) : "";
    const cpfAluno = idxCPF >= 0 ? validarCpf11Csv(campos[idxCPF]) : null;
    const sexo = idxSexo >= 0 ? extrairSexoCsv(campos[idxSexo]) : null;

    const telDigits = idxTel >= 0 ? String(campos[idxTel] || "").replace(/\D/g, "") : "";
    const telefone =
      telDigits.length >= 8 && !/^(\d)\1+$/.test(telDigits)
        ? telDigits.substring(0, 20)
        : null;

    // Proteção contra deslocamento de colunas quando algum campo anterior do CSV
    // contiver ";" sem aspas (ex.: múltiplos telefones ou complemento de endereço)
    const houveDeslocamentoColunas = campos.length > headerCols.length;
    const idxAneesEfetivo =
      idxAnees >= 0
        ? houveDeslocamentoColunas && idxAnees === headerCols.length - 1
          ? campos.length - 1
          : idxAnees
        : -1;

    let nomeRespPrincipal =
      idxResp >= 0 ? limparTextoCsv(campos[idxResp]).slice(0, 150) || null : null;
    let cpfRespPrincipal = idxCPFR >= 0 ? validarCpf11Csv(campos[idxCPFR]) : null;
    let enderecoRaw = idxEnd >= 0 ? limparTextoCsv(campos[idxEnd]) : "";

    if (
      houveDeslocamentoColunas &&
      idxCPFR >= 0 &&
      (!cpfRespPrincipal || !/[A-Za-zÀ-ÿ]{2,}/.test(nomeRespPrincipal || ""))
    ) {
      const inicioScanCpfResp = Math.max(idxSexo >= 0 ? idxSexo + 1 : 6, idxCPF >= 0 ? idxCPF + 1 : 5, 5);
      const limiteScanCpfResp = idxAneesEfetivo > 0 ? idxAneesEfetivo - 1 : campos.length - 1;
      for (let k = limiteScanCpfResp; k >= inicioScanCpfResp; k--) {
        const candCpf = validarCpf11Csv(campos[k]);
        const candNome = k - 1 > idxNome ? limparTextoCsv(campos[k - 1]).slice(0, 150) : "";
        if (candCpf && candCpf !== cpfAluno && /[A-Za-zÀ-ÿ]{2,}/.test(candNome) && !/\d{4,}/.test(candNome)) {
          cpfRespPrincipal = candCpf;
          nomeRespPrincipal = candNome;
          if (idxEnd > idxCPFR && k + 1 < (idxAneesEfetivo > 0 ? idxAneesEfetivo : campos.length)) {
            const partesEnd = campos
              .slice(k + 1, idxAneesEfetivo > 0 ? idxAneesEfetivo : campos.length)
              .map(limparTextoCsv)
              .filter(Boolean);
            if (partesEnd.length > 0) {
              enderecoRaw = partesEnd.join(" - ");
            }
          }
          break;
        }
      }
    }

    const endereco = enderecoRaw ? enderecoRaw.slice(0, 255) : null;

    const cpfFil1 = idxFil1CPF >= 0 ? validarCpf11Csv(campos[idxFil1CPF]) : null;
    const nomeFil1 = idxFil1Nome >= 0 ? limparTextoCsv(campos[idxFil1Nome]).slice(0, 150) || null : null;
    const cpfFil2 = idxFil2CPF >= 0 ? validarCpf11Csv(campos[idxFil2CPF]) : null;
    const nomeFil2 = idxFil2Nome >= 0 ? limparTextoCsv(campos[idxFil2Nome]).slice(0, 150) || null : null;

    const responsaveisLinha = [];
    if (cpfRespPrincipal) {
      anexarResponsavelUnico(responsaveisLinha, {
        cpf: cpfRespPrincipal,
        nome: nomeRespPrincipal,
        telefone,
        endereco,
        relacionamento: "RESPONSAVEL",
      });
    } else {
      // Fallback para Filiação 1 / Filiação 2 caso o CSV não traga CPF RESPONSÁVEL preenchido
      if (cpfFil1) {
        anexarResponsavelUnico(responsaveisLinha, {
          cpf: cpfFil1,
          nome: nomeFil1,
          telefone,
          endereco,
          relacionamento: "RESPONSAVEL",
        });
      }
      if (cpfFil2) {
        anexarResponsavelUnico(responsaveisLinha, {
          cpf: cpfFil2,
          nome: nomeFil2,
          telefone,
          endereco,
          relacionamento: "RESPONSAVEL",
        });
      }
    }

    const { anees, aneesSigla, temAnees } =
      idxAneesEfetivo >= 0
        ? extrairAneesCsv(campos[idxAneesEfetivo], {
            estudante,
            nomeSocial,
            responsaveis: [nomeRespPrincipal, nomeFil1, nomeFil2].filter(Boolean),
          })
        : { anees: null, aneesSigla: null, temAnees: false };

    const chaveCpfNome = cpfAluno ? `${cpfAluno}|${normNomeChave(estudante)}` : null;
    const reCanonica =
      entriesByRe.has(re)
        ? re
        : chaveCpfNome && reByCpfNome.has(chaveCpfNome)
        ? reByCpfNome.get(chaveCpfNome)
        : re;

    if (entriesByRe.has(reCanonica)) {
      duplicadosIgnorados++;
      const existente = entriesByRe.get(reCanonica);
      if (!existente.dataBr && dataBr) existente.dataBr = dataBr;
      if (!existente.cpfAluno && cpfAluno) existente.cpfAluno = cpfAluno;
      if (!existente.sexo && sexo) existente.sexo = sexo;
      if (!existente.nomeSocial && nomeSocial) existente.nomeSocial = nomeSocial;
      if (!existente.telefone && telefone) existente.telefone = telefone;
      if (!existente.endereco && endereco) existente.endereco = endereco;
      if (!existente.cpfResponsavel && responsaveisLinha[0]?.cpf) {
        existente.cpfResponsavel = responsaveisLinha[0].cpf;
        existente.responsavel = responsaveisLinha[0].nome || existente.responsavel;
      }
      if (temAnees && anees) {
        existente.temAnees = true;
        if (!existente.anees) {
          existente.anees = anees;
        } else if (!existente.anees.toUpperCase().includes(anees.toUpperCase())) {
          existente.anees = `${existente.anees}, ${anees}`.slice(0, 500);
        }
        existente.aneesSigla = abreviarAneesEducaDF(existente.anees).textoSiglas || existente.anees;
      }
      for (const r of responsaveisLinha) {
        anexarResponsavelUnico(existente.responsaveis, r);
      }
      continue;
    }

    const primeiroResp = responsaveisLinha[0] || null;
    const novoRegistro = {
      codigo: re,
      estudante,
      nomeSocial,
      dataBr,
      cpfAluno,
      sexo,
      telefone,
      responsavel: primeiroResp?.nome || nomeRespPrincipal || null,
      cpfResponsavel: primeiroResp?.cpf || null,
      endereco,
      anees,
      aneesSigla,
      temAnees,
      responsaveis: responsaveisLinha,
    };

    entriesByRe.set(re, novoRegistro);
    if (chaveCpfNome) reByCpfNome.set(chaveCpfNome, re);
  }

  const entries = Array.from(entriesByRe.values());
  const aeeIdentificados = entries.filter((e) => e.temAnees).length;

  return {
    ok: true,
    delimiter,
    headerLineIndex,
    headerCols,
    turmaArquivo,
    turmaTituloCsv,
    totalLinhasValidas,
    duplicadosIgnorados,
    ignoradosPorStatus,
    aeeIdentificados,
    entries,
  };
}

router.post("/importar-csv", verificarGovernancaImportacaoAlunos, uploadPdf.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: "CSV não enviado." });
  }

  try {
    const { escola_id } = req.user;
    const anoLetivoAtual =
      typeof anoLetivoPadrao === "function"
        ? anoLetivoPadrao()
        : String(new Date().getFullYear());

    await ensureNomeSocialReady();
    await ensureCsvColumnsReady();

    // ─────────────────────────────────────────────────────────────────
    // FASE 1 & 3: Decodificação, detecção dinâmica de cabeçalho e deduplicação
    // ─────────────────────────────────────────────────────────────────
    const parsed = parseEducaDfCsvBuffer(req.file.buffer, req.file.originalname);
    if (!parsed.ok) {
      return res.status(parsed.status || 400).json({ message: parsed.message });
    }

    const {
      turmaArquivo,
      turmaTituloCsv,
      totalLinhasValidas,
      duplicadosIgnorados,
      ignoradosPorStatus,
      aeeIdentificados,
      entries: pdfEntries,
    } = parsed;

    // ─────────────────────────────────────────────────────────────────
    // FASE 2: Identificação da turma
    // Prioridade: turma_id explícito no body > nome do arquivo > título interno do CSV
    // ─────────────────────────────────────────────────────────────────
    let turma = null;
    const turmaIdExplicito = req.body?.turma_id ? Number(req.body.turma_id) : null;

    if (turmaIdExplicito) {
      const [[turmaRow]] = await pool.query(
        "SELECT id, nome, serie, turno FROM turmas WHERE id = ? AND escola_id = ?",
        [turmaIdExplicito, escola_id]
      );
      if (!turmaRow) {
        return res.status(404).json({
          code: "TURMA_NAO_ENCONTRADA",
          message: `Turma id=${turmaIdExplicito} não encontrada.`,
        });
      }
      turma = turmaRow;
      console.log(
        `[importar-csv] Turma via turma_id explícito: id=${turma.id} nome="${turma.nome}" turno="${turma.turno}"`
      );
    } else {
      const [todasTurmasEscola] = await pool.query(
        "SELECT id, nome, serie, turno FROM turmas WHERE escola_id = ? AND ano = ? ORDER BY id DESC",
        [escola_id, anoLetivoAtual]
      );

      const candidatosNome = [turmaArquivo, turmaTituloCsv].filter(Boolean);
      if (candidatosNome.length === 0) {
        return res.status(400).json({
          message: "Não foi possível identificar a turma pelo nome ou cabeçalho do arquivo CSV.",
        });
      }

      let turmasEncontradas = [];
      for (const cand of candidatosNome) {
        const alvoNorm = normalizarTurmaComparacaoCsv(cand);
        if (!alvoNorm) continue;
        const matches = todasTurmasEscola.filter(
          (t) => normalizarTurmaComparacaoCsv(t.nome) === alvoNorm
        );
        if (matches.length > 0) {
          turmasEncontradas = matches;
          break;
        }
      }

      if (turmasEncontradas.length === 0) {
        const nomeReferencia = turmaTituloCsv || turmaArquivo;
        return res.status(404).json({
          code: "TURMA_NAO_ENCONTRADA",
          message: `Turma "${nomeReferencia}" não encontrada no sistema para o ano letivo ${anoLetivoAtual}.`,
          turmaNaoEncontrada: nomeReferencia,
        });
      }

      turma = turmasEncontradas[0];
      console.log(
        `[importar-csv] Turma por nome/título: id=${turma.id} nome="${turma.nome}" turno="${turma.turno}"`
      );
    }

    const turma_id = turma.id;

    console.log(
      `[importar-csv] Turma "${turma.nome}" | Linhas válidas: ${totalLinhasValidas} | Únicos: ${pdfEntries.length} | Duplicados ignorados: ${duplicadosIgnorados} | AEE: ${aeeIdentificados}`
    );

    if (pdfEntries.length === 0) {
      return res.status(400).json({
        message: "Nenhum aluno ativo encontrado no CSV. Verifique se o arquivo está no formato correto.",
      });
    }

    // ─────────────────────────────────────────────────────────────────
    // FASE 4: Situação atual no BD (alinhada com GET /api/alunos)
    // ─────────────────────────────────────────────────────────────────
    const [atuais] = await pool.query(
      `SELECT DISTINCT
         a.id,
         a.codigo,
         a.estudante,
         a.nome_registro,
         a.usa_nome_social,
         a.nome_social,
         a.anees,
         a.atendimento_diferencial,
         'ativo' AS status
       FROM alunos a
       LEFT JOIN matriculas m
         ON m.aluno_id = a.id AND m.ano_letivo = ? AND m.escola_id = ?
       WHERE (a.escola_id = ? OR m.escola_id = ?)
         AND COALESCE(m.turma_id, a.turma_id) = ?
         AND COALESCE(m.status, a.status, 'ativo') = 'ativo'`,
      [anoLetivoAtual, escola_id, escola_id, escola_id, turma_id]
    );

    const codigosEntrada = pdfEntries.map((e) => String(e.codigo));
    const [existentesRows] = await pool.query(
      `SELECT
         a.id,
         a.escola_id,
         a.codigo,
         a.estudante,
         a.nome_registro,
         a.usa_nome_social,
         a.nome_social,
         a.anees,
         a.atendimento_diferencial,
         a.status AS aluno_status,
         a.turma_id AS aluno_turma_id,
         m.id AS matricula_id,
         m.turma_id AS matr_turma_id,
         m.status AS matr_status,
         t_atual.id AS turma_efetiva_id,
         t_atual.nome AS turma_atual_nome,
         t_atual.turno AS turma_atual_turno,
         t_atual.ano AS turma_atual_ano
       FROM alunos a
       LEFT JOIN matriculas m
         ON m.aluno_id = a.id AND m.ano_letivo = ? AND m.escola_id = ?
       LEFT JOIN turmas t_atual
         ON t_atual.id = COALESCE(m.turma_id, a.turma_id)
       WHERE a.codigo IN (?)
       ORDER BY (a.escola_id = ?) DESC, (m.id IS NOT NULL) DESC`,
      [anoLetivoAtual, escola_id, codigosEntrada, escola_id]
    );

    const existentesMap = new Map();
    for (const r of existentesRows) {
      const k = String(r.codigo);
      if (!existentesMap.has(k)) existentesMap.set(k, r);
    }

    const normName = (s) =>
      (s || "")
        .toUpperCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/\s+/g, " ")
        .trim();

    const atuaisMap = new Map(atuais.map((a) => [String(a.codigo), a]));
    const atuaisNomeMap = new Map();
    for (const a of atuais) {
      registrarChavesNomeAluno(atuaisNomeMap, a, normName);
    }

    const garantirMatriculaAtiva = async (alunoId) => {
      if (!alunoId) return;
      const [matr] = await pool.query(
        "SELECT id, status, turma_id FROM matriculas WHERE aluno_id = ? AND ano_letivo = ? AND escola_id = ?",
        [alunoId, anoLetivoAtual, escola_id]
      );
      if (matr.length > 0) {
        if (matr[0].status !== "ativo" || Number(matr[0].turma_id) !== Number(turma_id)) {
          await pool.query(
            "UPDATE matriculas SET status = 'ativo', turma_id = ? WHERE id = ?",
            [turma_id, matr[0].id]
          );
        }
      } else {
        await pool.query(
          "INSERT INTO matriculas (escola_id, aluno_id, turma_id, ano_letivo, status) VALUES (?, ?, ?, ?, 'ativo')",
          [escola_id, alunoId, turma_id, anoLetivoAtual]
        );
      }
    };

    const entradaSet = new Set(codigosEntrada);
    const toInsert = [];
    const toReactivate = [];
    const conflitosOutraTurma = [];
    let jaExistiam = 0;
    let atualizadosCodigo = 0;

    for (const e of pdfEntries) {
      const cod = String(e.codigo);
      let atual = atuaisMap.get(cod);
      const existenteGlobal = existentesMap.get(cod);

      if (!atual && !existenteGlobal) {
        const nomeKey = normName(e.estudante);
        const porNome = atuaisNomeMap.get(nomeKey);
        if (porNome) {
          console.log(
            `[importar-csv] Match por nome: "${e.estudante}" — código ${porNome.codigo} → ${e.codigo}`
          );
          await pool.query(
            "UPDATE alunos SET codigo = ? WHERE id = ? AND escola_id = ?",
            [e.codigo, porNome.id, escola_id]
          );
          atualizadosCodigo++;
          atual = porNome;
          atuaisMap.set(cod, porNome);
          atuaisNomeMap.delete(nomeKey);
          entradaSet.add(String(porNome.codigo));
        }
      }

      if (atual) {
        // Aluno já ativo nesta turma — complementa campos e sincroniza AEE/matrícula/responsável
        jaExistiam++;
        const sets = [
          "status = 'ativo'",
          "turma_id = ?",
          "nome_registro = ?",
          "estudante = IF(usa_nome_social = 1 AND nome_social IS NOT NULL AND TRIM(nome_social) <> '', nome_social, ?)",
        ];
        const params = [turma_id, e.estudante, e.estudante];

        if (e.nomeSocial) {
          sets.push(
            "usa_nome_social = IF(usa_nome_social = 1, 1, 1)",
            "nome_social = IF(nome_social IS NULL OR TRIM(nome_social) = '', ?, nome_social)",
            "estudante = IF(nome_social IS NULL OR TRIM(nome_social) = '', ?, estudante)"
          );
          params.push(e.nomeSocial, e.nomeSocial);
        }

        const dataValida = e.dataBr && /^\d{2}\/\d{2}\/\d{4}$/.test(e.dataBr);
        if (dataValida) {
          sets.push("data_nascimento = COALESCE(data_nascimento, STR_TO_DATE(?, '%d/%m/%Y'))");
          params.push(e.dataBr);
        }
        if (e.sexo) {
          sets.push("sexo = IF(sexo IS NULL OR sexo = '', ?, sexo)");
          params.push(e.sexo);
        }
        if (e.cpfAluno) {
          sets.push("cpf = IF(cpf IS NULL OR cpf = '', ?, cpf)");
          params.push(e.cpfAluno);
        }
        if (e.temAnees && e.anees) {
          sets.push("anees = ?", "atendimento_diferencial = 1");
          params.push(e.anees);
        } else if (
          atual.anees &&
          !ehValorAneesLegitimo(atual.anees, {
            estudante: e.estudante,
            nomeRegistro: atual.nome_registro,
            nomeSocial: atual.nome_social || e.nomeSocial,
            responsaveis: [
              e.responsavel,
              ...((e.responsaveis || []).map((r) => r.nome).filter(Boolean)),
            ].filter(Boolean),
          })
        ) {
          sets.push("anees = NULL", "atendimento_diferencial = 0");
        }

        params.push(atual.id, escola_id);
        await pool.query(
          `UPDATE alunos SET ${sets.join(", ")} WHERE id = ? AND escola_id = ?`,
          params
        );
        await garantirMatriculaAtiva(atual.id);
        await upsertResponsavelCsv(pool, e, atual.id, escola_id);
        continue;
      }

      const pertenceMesmaEscola =
        existenteGlobal && Number(existenteGlobal.escola_id) === Number(escola_id);
      const statusEfetivoExistente = pertenceMesmaEscola
        ? String(existenteGlobal.matr_status || existenteGlobal.aluno_status || "ativo").toLowerCase()
        : "";
      const turmaEfetivaExistenteId = pertenceMesmaEscola
        ? Number(existenteGlobal.matr_turma_id || existenteGlobal.aluno_turma_id || 0)
        : 0;
      const enturmadoNoAnoCorrente =
        pertenceMesmaEscola &&
        (Boolean(existenteGlobal.matricula_id) ||
          Number(existenteGlobal.turma_atual_ano) === Number(anoLetivoAtual));

      // PROTEÇÃO CRÍTICA CONTRA CONFLITO ENTRE TURMAS (ex.: 9º ANO A ↔ 9º ANO B):
      // Se o estudante já está ATIVO em OUTRA turma desta escola no ano letivo corrente,
      // NÃO sobrescreve `turma_id` silenciosamente! Complementa apenas dados cadastrais
      // vazios e retorna em `conflitosOutraTurma` para decisão explícita da secretaria.
      if (
        pertenceMesmaEscola &&
        statusEfetivoExistente === "ativo" &&
        enturmadoNoAnoCorrente &&
        turmaEfetivaExistenteId > 0 &&
        turmaEfetivaExistenteId !== Number(turma_id)
      ) {
        const setsComp = [];
        const paramsComp = [];
        const dataValida = e.dataBr && /^\d{2}\/\d{2}\/\d{4}$/.test(e.dataBr);
        if (dataValida) {
          setsComp.push("data_nascimento = COALESCE(data_nascimento, STR_TO_DATE(?, '%d/%m/%Y'))");
          paramsComp.push(e.dataBr);
        }
        if (e.sexo) {
          setsComp.push("sexo = IF(sexo IS NULL OR sexo = '', ?, sexo)");
          paramsComp.push(e.sexo);
        }
        if (e.cpfAluno) {
          setsComp.push("cpf = IF(cpf IS NULL OR cpf = '', ?, cpf)");
          paramsComp.push(e.cpfAluno);
        }
        if (e.temAnees && e.anees) {
          setsComp.push("anees = ?", "atendimento_diferencial = 1");
          paramsComp.push(e.anees);
        }
        if (setsComp.length > 0) {
          paramsComp.push(existenteGlobal.id, escola_id);
          await pool.query(
            `UPDATE alunos SET ${setsComp.join(", ")} WHERE id = ? AND escola_id = ?`,
            paramsComp
          );
        }
        await upsertResponsavelCsv(pool, e, existenteGlobal.id, escola_id);

        conflitosOutraTurma.push({
          id: existenteGlobal.id,
          codigo: e.codigo,
          estudante: existenteGlobal.estudante || e.estudante,
          turmaAtualId: turmaEfetivaExistenteId,
          turmaAtualNome:
            existenteGlobal.turma_atual_nome || `Turma #${turmaEfetivaExistenteId}`,
          turmaAtualTurno: existenteGlobal.turma_atual_turno || "",
        });
        continue;
      }

      if (pertenceMesmaEscola && statusEfetivoExistente === "inativo") {
        toReactivate.push({ ...e, existingId: existenteGlobal.id });
      } else {
        toInsert.push(e);
      }
    }

    if (atualizadosCodigo > 0) {
      console.log(`[importar-csv] ${atualizadosCodigo} código(s) atualizado(s)`);
    }

    // ─────────────────────────────────────────────────────────────────
    // FASE 5: Inserir novos alunos (ou remanejados para esta turma)
    // ─────────────────────────────────────────────────────────────────
    let inseridos = 0;
    for (const e of toInsert) {
      const dataValida = e.dataBr && /^\d{2}\/\d{2}\/\d{4}$/.test(e.dataBr);
      const usaSocialInicial = e.nomeSocial ? 1 : 0;
      const nomeExibicaoInicial = e.nomeSocial ? e.nomeSocial : e.estudante;
      const aeeFlag = e.temAnees ? 1 : 0;

      let insertSql, baseParams;
      if (dataValida) {
        insertSql = `INSERT INTO alunos
          (codigo, estudante, nome_registro, usa_nome_social, nome_social, data_nascimento, sexo, cpf, anees, atendimento_diferencial, turma_id, escola_id, status)
          VALUES (?, ?, ?, ?, ?, STR_TO_DATE(?, '%d/%m/%Y'), ?, ?, ?, ?, ?, ?, 'ativo')
          ON DUPLICATE KEY UPDATE
            id = LAST_INSERT_ID(id),
            nome_registro = VALUES(nome_registro),
            usa_nome_social = IF(usa_nome_social = 1, 1, VALUES(usa_nome_social)),
            nome_social = IF(nome_social IS NOT NULL AND TRIM(nome_social) <> '', nome_social, VALUES(nome_social)),
            estudante = IF(usa_nome_social = 1 AND nome_social IS NOT NULL AND TRIM(nome_social) <> '', nome_social, VALUES(estudante)),
            data_nascimento = COALESCE(data_nascimento, VALUES(data_nascimento)),
            sexo  = IF(sexo  IS NULL OR sexo  = '', VALUES(sexo),  sexo),
            cpf   = IF(cpf   IS NULL OR cpf   = '', VALUES(cpf),   cpf),
            anees = IF(VALUES(anees) IS NOT NULL AND VALUES(anees) <> '', VALUES(anees), anees),
            atendimento_diferencial = IF(atendimento_diferencial = 1, 1, VALUES(atendimento_diferencial)),
            turma_id = VALUES(turma_id),
            escola_id = VALUES(escola_id),
            status = 'ativo'`;
        baseParams = [
          e.codigo,
          nomeExibicaoInicial,
          e.estudante,
          usaSocialInicial,
          e.nomeSocial || null,
          e.dataBr,
          e.sexo || null,
          e.cpfAluno || null,
          e.anees || null,
          aeeFlag,
          turma_id,
          escola_id,
        ];
      } else {
        insertSql = `INSERT INTO alunos
          (codigo, estudante, nome_registro, usa_nome_social, nome_social, sexo, cpf, anees, atendimento_diferencial, turma_id, escola_id, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ativo')
          ON DUPLICATE KEY UPDATE
            id = LAST_INSERT_ID(id),
            nome_registro = VALUES(nome_registro),
            usa_nome_social = IF(usa_nome_social = 1, 1, VALUES(usa_nome_social)),
            nome_social = IF(nome_social IS NOT NULL AND TRIM(nome_social) <> '', nome_social, VALUES(nome_social)),
            estudante = IF(usa_nome_social = 1 AND nome_social IS NOT NULL AND TRIM(nome_social) <> '', nome_social, VALUES(estudante)),
            sexo  = IF(sexo  IS NULL OR sexo  = '', VALUES(sexo),  sexo),
            cpf   = IF(cpf   IS NULL OR cpf   = '', VALUES(cpf),   cpf),
            anees = IF(VALUES(anees) IS NOT NULL AND VALUES(anees) <> '', VALUES(anees), anees),
            atendimento_diferencial = IF(atendimento_diferencial = 1, 1, VALUES(atendimento_diferencial)),
            turma_id = VALUES(turma_id),
            escola_id = VALUES(escola_id),
            status = 'ativo'`;
        baseParams = [
          e.codigo,
          nomeExibicaoInicial,
          e.estudante,
          usaSocialInicial,
          e.nomeSocial || null,
          e.sexo || null,
          e.cpfAluno || null,
          e.anees || null,
          aeeFlag,
          turma_id,
          escola_id,
        ];
      }

      const [result] = await pool.query(insertSql, baseParams);
      const alunoId = result.insertId;

      if (alunoId) {
        await garantirMatriculaAtiva(alunoId);
        await upsertResponsavelCsv(pool, e, alunoId, escola_id);
      }
      inseridos++;
    }

    // ─────────────────────────────────────────────────────────────────
    // FASE 6: Reativar inativos
    // ─────────────────────────────────────────────────────────────────
    let reativados = 0;
    for (const e of toReactivate) {
      const dataValida = e.dataBr && /^\d{2}\/\d{2}\/\d{4}$/.test(e.dataBr);

      const sets = [
        "status = 'ativo'",
        "turma_id = ?",
        "nome_registro = ?",
        "estudante = IF(usa_nome_social = 1 AND nome_social IS NOT NULL AND TRIM(nome_social) <> '', nome_social, ?)",
      ];
      const params = [turma_id, e.estudante, e.estudante];

      if (dataValida) {
        sets.push("data_nascimento = COALESCE(data_nascimento, STR_TO_DATE(?, '%d/%m/%Y'))");
        params.push(e.dataBr);
      }
      if (e.sexo) {
        sets.push("sexo = IF(sexo IS NULL OR sexo = '', ?, sexo)");
        params.push(e.sexo);
      }
      if (e.cpfAluno) {
        sets.push("cpf = IF(cpf IS NULL OR cpf = '', ?, cpf)");
        params.push(e.cpfAluno);
      }
      if (e.temAnees && e.anees) {
        sets.push("anees = ?", "atendimento_diferencial = 1");
        params.push(e.anees);
      }
      params.push(e.existingId, escola_id);

      await pool.query(
        `UPDATE alunos SET ${sets.join(", ")} WHERE id = ? AND escola_id = ?`,
        params
      );

      if (e.existingId) {
        await garantirMatriculaAtiva(e.existingId);
        await upsertResponsavelCsv(pool, e, e.existingId, escola_id);
      }
      reativados++;
    }

    // ─────────────────────────────────────────────────────────────────
    // FASE 7: Detectar ausentes (alunos ativos na turma no BD mas não no CSV)
    // ─────────────────────────────────────────────────────────────────
    const pendentesInativacao = [];
    for (const atual of atuais) {
      if (atual.status !== "ativo") continue;
      const cod = String(atual.codigo);
      const noCodigoCsv = entradaSet.has(cod);
      const noNomeCsv = pdfEntries.some((e) => nomeCorrespondeAoAluno(e.estudante, atual, normName));
      if (!noCodigoCsv && !noNomeCsv) {
        pendentesInativacao.push({
          id: atual.id,
          codigo: atual.codigo,
          estudante: atual.estudante,
        });
      }
    }

    if (pendentesInativacao.length > 0) {
      console.log(
        `[importar-csv] ⚠ ${pendentesInativacao.length} aluno(s) ausente(s) — pendentes de confirmação`
      );
    }

    if (conflitosOutraTurma.length > 0) {
      console.log(
        `[importar-csv] ⚠ ${conflitosOutraTurma.length} aluno(s) já ativo(s) em outra turma — protegidos contra remanejamento silencioso`
      );
    }

    console.log(
      `[importar-csv] localizados:${pdfEntries.length} totalLinhas:${totalLinhasValidas} duplicados:${duplicadosIgnorados} inseridos:${inseridos} reativados:${reativados} jaExistiam:${jaExistiam} conflitosOutraTurma:${conflitosOutraTurma.length} aee:${aeeIdentificados} pendentes:${pendentesInativacao.length}`
    );

    return res.json({
      localizados: pdfEntries.length,
      totalLinhasCsv: totalLinhasValidas,
      duplicadosIgnorados,
      ignoradosPorStatus,
      aeeIdentificados,
      inseridos,
      reativados,
      jaExistiam,
      conflitosOutraTurma,
      conflitosCount: conflitosOutraTurma.length,
      remanejados: 0,
      codigosAtualizados: atualizadosCodigo,
      inativados: 0,
      pendentesInativacao,
      listaAlunos: pdfEntries,
    });
  } catch (err) {
    console.error("Erro ao processar /importar-csv:", err);
    return res.status(500).json({ message: "Erro ao processar CSV.", error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Helper: Upsert de responsável(is) com endereço e telefone (via CSV)
// Regras de proteção:
//   1. Suporta 1 ou múltiplos responsáveis deduplicados por CPF de 11 dígitos
//   2. Garante `nome` NOT NULL (evita falha quando CPF vier sem nome) e substitui
//      marcadores provisórios ('PENDENTE', 'RESPONSAVEL') pelo nome oficial do EDUCADF
//   3. Salva em telefone_celular ignorando sequências fictícias (ex.: 99999999999)
//   4. Preserva dados já cadastrados no BD sem sobrescrevê-los
// ─────────────────────────────────────────────────────────────────────────────
async function upsertResponsavelCsv(pool, e, alunoId, escola_id) {
  const listaResponsaveis =
    Array.isArray(e.responsaveis) && e.responsaveis.length > 0
      ? e.responsaveis
      : e.cpfResponsavel
      ? [
          {
            cpf: e.cpfResponsavel,
            nome: e.responsavel,
            telefone: e.telefone,
            endereco: e.endereco,
            relacionamento: "RESPONSAVEL",
          },
        ]
      : [];

  if (listaResponsaveis.length === 0) return;

  for (const r of listaResponsaveis) {
    const cpfLimpo = validarCpf11Csv(r.cpf);
    if (!cpfLimpo) continue;

    const nomeReal = limparTextoCsv(r.nome || "").slice(0, 150);
    const nomeInsert = nomeReal || "RESPONSÁVEL";

    const telDigits = String(r.telefone ?? e.telefone ?? "").replace(/\D/g, "");
    const telValido =
      telDigits.length >= 8 && !/^(\d)\1+$/.test(telDigits)
        ? telDigits.substring(0, 20)
        : null;

    const enderecoValido = limparTextoCsv(r.endereco ?? e.endereco ?? "").slice(0, 255) || null;
    const relacionamento = r.relacionamento || "RESPONSAVEL";

    try {
      const [respResult] = await pool.query(
        `INSERT INTO responsaveis (nome, cpf, telefone_celular, endereco)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           id               = LAST_INSERT_ID(id),
           nome             = IF(
                                (nome IS NULL OR TRIM(nome) = '' OR UPPER(TRIM(nome)) IN ('PENDENTE', 'RESPONSAVEL', 'RESPONSÁVEL'))
                                AND ? <> '',
                                ?,
                                nome
                              ),
           telefone_celular = IF(telefone_celular IS NULL OR telefone_celular = '', VALUES(telefone_celular), telefone_celular),
           endereco         = IF(endereco         IS NULL OR endereco         = '', VALUES(endereco),         endereco)`,
        [nomeInsert, cpfLimpo, telValido, enderecoValido, nomeReal, nomeReal]
      );

      let responsavelId = respResult.insertId;
      if (!responsavelId) {
        const [[existing]] = await pool.query(
          "SELECT id FROM responsaveis WHERE cpf = ?",
          [cpfLimpo]
        );
        responsavelId = existing?.id || null;
      }

      if (responsavelId && alunoId) {
        const [[vinculo]] = await pool.query(
          "SELECT id, ativo FROM responsaveis_alunos WHERE responsavel_id = ? AND aluno_id = ? AND escola_id = ?",
          [responsavelId, alunoId, escola_id]
        );
        if (!vinculo) {
          await pool.query(
            "INSERT INTO responsaveis_alunos (escola_id, responsavel_id, aluno_id, relacionamento, ativo) VALUES (?, ?, ?, ?, 1)",
            [escola_id, responsavelId, alunoId, relacionamento]
          );
        }
      }
    } catch (err) {
      console.warn(
        `[importar-csv] Falha ao vincular responsável (${cpfLimpo}) do aluno ${e.codigo}:`,
        err.message
      );
    }
  }
}

/* ============================================================================
 * 11c) INATIVAR EM LOTE (confirmaÃ§Ã£o manual pelo secretÃ¡rio)
 * POST /api/alunos/inativar-lote
 * Body: { alunoIds: [1, 2, 3] }
 *
 * Inativa alunos selecionados pelo secretÃ¡rio apÃ³s importaÃ§Ã£o de PDF.
 * Usado quando o PDF nÃ£o contÃ©m alunos que estÃ£o no banco (transferidos).
 * ========================================================================== */
router.post("/inativar-lote", verificarGovernancaImportacaoAlunos, async (req, res) => {
  try {
    const { escola_id } = req.user;
    const { alunoIds } = req.body || {};

    if (!Array.isArray(alunoIds) || alunoIds.length === 0) {
      return res.status(400).json({ message: "Lista de alunos vazia." });
    }

    // SeguranÃ§a: sÃ³ inativa alunos que pertencem Ã  escola do usuÃ¡rio
    const ids = alunoIds.map(Number).filter(n => n > 0);
    if (ids.length === 0) {
      return res.status(400).json({ message: "IDs invÃ¡lidos." });
    }

    const [result] = await pool.query(
      `UPDATE alunos SET status = 'inativo' WHERE id IN (?) AND escola_id = ? AND status = 'ativo'`,
      [ids, escola_id]
    );

    // Inativa matrÃ­culas correspondentes
    const anoLetivoAtual = typeof anoLetivoPadrao === "function" ? anoLetivoPadrao() : String(new Date().getFullYear());
    await pool.query(
      `UPDATE matriculas SET status = 'inativo' WHERE aluno_id IN (?) AND escola_id = ? AND ano_letivo = ?`,
      [ids, escola_id, anoLetivoAtual]
    ).catch(() => {});

    console.log(`[inativar-lote] ${result.affectedRows} aluno(s) inativado(s) (escola_id=${escola_id})`);

    return res.json({
      ok: true,
      inativados: result.affectedRows,
      message: `${result.affectedRows} aluno(s) inativado(s) com sucesso.`,
    });
  } catch (err) {
    console.error("Erro ao inativar em lote:", err);
    return res.status(500).json({ message: "Erro ao inativar alunos.", error: err.message });
  }
});

/* ============================================================================
 * 11d) REMANEJAR EM LOTE (confirmação explícita pela secretaria)
 * POST /api/alunos/remanejar-lote
 * Body: { turmaDestinoId: number, alunoIds: [1, 2, ...] }
 *
 * Move apenas os alunos explicitamente confirmados pela secretaria quando um
 * CSV do EDUCADF contém alunos que já estavam ativos em outra turma da escola.
 * ========================================================================== */
router.post("/remanejar-lote", verificarEscola, verificarGovernancaImportacaoAlunos, async (req, res) => {
  try {
    const { escola_id } = req.user;
    const { turmaDestinoId, alunoIds } = req.body || {};

    const destinoId = Number(turmaDestinoId || 0);
    if (!destinoId) {
      return res.status(400).json({ message: "Turma de destino inválida." });
    }
    if (!Array.isArray(alunoIds) || alunoIds.length === 0) {
      return res.status(400).json({ message: "Nenhum estudante selecionado para remanejamento." });
    }

    const ids = [...new Set(alunoIds.map(Number).filter((n) => n > 0))];
    if (ids.length === 0) {
      return res.status(400).json({ message: "IDs de estudantes inválidos." });
    }

    const [[turmaDestino]] = await pool.query(
      "SELECT id, nome, turno FROM turmas WHERE id = ? AND escola_id = ? LIMIT 1",
      [destinoId, escola_id]
    );
    if (!turmaDestino) {
      return res.status(404).json({ message: "Turma de destino não encontrada nesta escola." });
    }

    const anoLetivoAtual =
      typeof anoLetivoPadrao === "function" ? anoLetivoPadrao() : Number(new Date().getFullYear());

    const [alunosValidos] = await pool.query(
      "SELECT id FROM alunos WHERE id IN (?) AND escola_id = ?",
      [ids, escola_id]
    );
    const idsValidos = alunosValidos.map((a) => Number(a.id));
    if (idsValidos.length === 0) {
      return res.status(404).json({ message: "Estudantes não encontrados nesta escola." });
    }

    await pool.query(
      "UPDATE alunos SET turma_id = ?, status = 'ativo' WHERE id IN (?) AND escola_id = ?",
      [destinoId, idsValidos, escola_id]
    );

    for (const alunoId of idsValidos) {
      const [matr] = await pool.query(
        "SELECT id FROM matriculas WHERE aluno_id = ? AND ano_letivo = ? AND escola_id = ?",
        [alunoId, anoLetivoAtual, escola_id]
      );
      if (matr.length > 0) {
        await pool.query(
          "UPDATE matriculas SET turma_id = ?, status = 'ativo', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
          [destinoId, matr[0].id]
        );
      } else {
        await pool.query(
          "INSERT INTO matriculas (escola_id, aluno_id, turma_id, ano_letivo, status) VALUES (?, ?, ?, ?, 'ativo')",
          [escola_id, alunoId, destinoId, anoLetivoAtual]
        );
      }
    }

    console.log(
      `[remanejar-lote] ${idsValidos.length} aluno(s) remanejado(s) para turma id=${destinoId} ("${turmaDestino.nome}") (escola_id=${escola_id})`
    );

    return res.json({
      ok: true,
      remanejados: idsValidos.length,
      turmaDestino: turmaDestino.nome,
      message: `${idsValidos.length} estudante(s) remanejado(s) para ${turmaDestino.nome}.`,
    });
  } catch (err) {
    console.error("Erro ao remanejar em lote:", err);
    return res.status(500).json({ message: "Erro ao remanejar estudantes.", error: err.message });
  }
});

/* ============================================================================
 * 12) IMPORTAR XLSX (lÃ³gica similar ao PDF; converte datas e processa status)
 * POST /api/alunos/importar-xlsx (arquivo: file)
 * - Nome do arquivo (sem extensÃ£o) = nome da turma
 * ========================================================================== */
const uploadXlsx = multer(); // usa buffer
router.post("/importar-xlsx", verificarGovernancaImportacaoAlunos, uploadXlsx.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: "XLSX nÃ£o enviado." });
  }

  try {
    const { escola_id } = req.user;
    const anoLetivoAtual = typeof anoLetivoPadrao === "function" ? anoLetivoPadrao() : String(new Date().getFullYear());

    const workbook = XLSX.read(req.file.buffer, { type: "buffer" });
    const primeiraAbaNome = workbook.SheetNames[0];
    const sheet = workbook.Sheets[primeiraAbaNome];

    const dados = XLSX.utils.sheet_to_json(sheet, {
      header: ["codigo", "estudante", "data_nascimento", "sexo"],
      range: 1,  // pula cabeÃ§alho (linha 0)
      defval: "",
    });

    let turmaNomeStr = req.body.turmaNome || req.file.originalname.replace(/\.[^.]+$/i, "").trim();
    // Corrige erro de parse do multer (latin1 vs utf-8) que causa 6Ã‚Âº em vez de 6Âº
    const turmaNome = turmaNomeStr.replace(/Ã‚Âº/g, 'Âº').replace(/Ã‚Âª/g, 'Âª');

    const [[turma]] = await pool.query("SELECT id FROM turmas WHERE nome = ? AND escola_id = ?", [turmaNome, escola_id]);
    if (!turma) {
      return res.status(404).json({ message: `Turma "${turmaNome}" nÃ£o encontrada.` });
    }
    const turma_id = turma.id;

    const xlsxEntries = [];
    for (const linha of dados) {
      const codigo = String(linha.codigo).trim();
      const estudante = String(linha.estudante).trim();
      const sexoRaw = String(linha.sexo).trim().toUpperCase();

      // Data pode vir como serial do Excel ou texto; convertemos para dd/mm/yyyy
      let dataBr = "";
      if (typeof linha.data_nascimento === "number") {
        dataBr = XLSX.SSF.format("dd/mm/yyyy", linha.data_nascimento);
      } else {
        const str = String(linha.data_nascimento).trim().replace(/-/g, "/");
        const partes = str.split("/");
        if (partes.length === 3) {
          // heurÃ­stica de dia/mÃªs/ano
          const [p0, p1, p2] = partes;
          if (p0.length === 2 && p1.length === 2 && p2.length === 4) {
            dataBr = `${p0}/${p1}/${p2}`;
          } else if (p0.length === 4 && p1.length === 2 && p2.length === 2) {
            dataBr = `${p2}/${p1}/${p0}`;
          }
        }
      }

      if (!codigo || !estudante) continue;

      xlsxEntries.push({
        codigo,
        estudante,
        dataBr: dataBr || null,
        sexo: /^[MF]$/.test(sexoRaw) ? sexoRaw : null,
      });
    }

    const [atuais] = await pool.query(
      "SELECT id, codigo, status, data_nascimento, sexo, estudante FROM alunos WHERE turma_id = ? AND escola_id = ?",
      [turma_id, escola_id]
    );
    const atuaisMap = new Map(atuais.map((a) => [String(a.codigo), a]));
    const entradaSet = new Set(xlsxEntries.map((e) => String(e.codigo)));

    const toInsert = [];
    const toReactivate = [];
    const toUpdate = [];   // ativos com dados faltantes a completar
    let jaExistiam = 0;

    for (const e of xlsxEntries) {
      const cod = String(e.codigo);
      const atual = atuaisMap.get(cod);
      if (!atual) {
        toInsert.push(e);
      } else if (atual.status === "inativo") {
        toReactivate.push({ entry: e, atual });
      } else {
        // Ativo: verifica se hÃ¡ dados faltantes no banco que o XLSX pode preencher
        const precisaAtualizar =
          (e.dataBr && !atual.data_nascimento) ||
          (e.sexo   && !atual.sexo);
        if (precisaAtualizar) {
          toUpdate.push({ entry: e, atual });
        } else {
          jaExistiam++;
        }
      }
    }

    const toInactivate = atuais.filter((a) => !entradaSet.has(String(a.codigo)));

    await ensureNomeSocialReady();
    // Inserir novos
    let inseridos = 0;
    for (const e of toInsert) {
      const [result] = await pool.query(
        `INSERT INTO alunos (codigo, estudante, nome_registro, data_nascimento, sexo, turma_id, escola_id, status)
         VALUES (?, ?, ?, ${e.dataBr ? "STR_TO_DATE(?, '%d/%m/%Y')" : "NULL"}, ?, ?, ?, 'ativo')
         ON DUPLICATE KEY UPDATE 
           id = LAST_INSERT_ID(id),
           nome_registro = VALUES(nome_registro),
           estudante = IF(usa_nome_social = 1 AND nome_social IS NOT NULL AND TRIM(nome_social) <> '', nome_social, VALUES(estudante)),
           turma_id = VALUES(turma_id),
           status = 'ativo'`,
        e.dataBr
          ? [e.codigo, e.estudante, e.estudante, e.dataBr, e.sexo, turma_id, escola_id]
          : [e.codigo, e.estudante, e.estudante, e.sexo, turma_id, escola_id]
      );
      
      const alunoId = result.insertId;
      if (alunoId) {
        const [matr] = await pool.query(
          "SELECT id FROM matriculas WHERE aluno_id = ? AND ano_letivo = ? AND escola_id = ?",
          [alunoId, anoLetivoAtual, escola_id]
        );
        if (matr.length > 0) {
          await pool.query("UPDATE matriculas SET status = 'ativo', turma_id = ? WHERE id = ?", [turma_id, matr[0].id]);
        } else {
          await pool.query(
            "INSERT INTO matriculas (escola_id, aluno_id, turma_id, ano_letivo, status) VALUES (?, ?, ?, ?, 'ativo')",
            [escola_id, alunoId, turma_id, anoLetivoAtual]
          );
        }
      }
      
      inseridos++;
    }

    // Reativar
    let reativados = 0;
    for (const { entry: e, atual: atualObj } of toReactivate) {
      await pool.query(
        "UPDATE alunos SET status='ativo', turma_id = ? WHERE codigo = ? AND escola_id = ?",
        [turma_id, e.codigo, escola_id]
      );

      const alunoId = atualObj.id;
      if (alunoId) {
        const [matr] = await pool.query(
          "SELECT id FROM matriculas WHERE aluno_id = ? AND ano_letivo = ? AND escola_id = ?",
          [alunoId, anoLetivoAtual, escola_id]
        );
        if (matr.length > 0) {
          await pool.query("UPDATE matriculas SET status = 'ativo', turma_id = ? WHERE id = ?", [turma_id, matr[0].id]);
        } else {
          await pool.query(
            "INSERT INTO matriculas (escola_id, aluno_id, turma_id, ano_letivo, status) VALUES (?, ?, ?, ?, 'ativo')",
            [escola_id, alunoId, turma_id, anoLetivoAtual]
          );
        }
      }

      reativados++;
    }

    // Atualizar dados faltantes de alunos ativos
    let atualizados = 0;
    for (const { entry: e, atual } of toUpdate) {
      const sets = [];
      const vals = [];

      if (e.dataBr && !atual.data_nascimento) {
        sets.push("data_nascimento = STR_TO_DATE(?, '%d/%m/%Y')");
        vals.push(e.dataBr);
      }
      if (e.sexo && !atual.sexo) {
        sets.push("sexo = ?");
        vals.push(e.sexo);
      }

      if (sets.length > 0) {
        vals.push(atual.id);
        await pool.query(
          `UPDATE alunos SET ${sets.join(", ")} WHERE id = ?`,
          vals
        );
        atualizados++;
      } else {
        jaExistiam++; // sem dados novos para preencher
      }
    }

    // Inativar nÃ£o listados
    let inativados = 0;
    for (const r of toInactivate) {
      const correspondente = xlsxEntries.find((e) => e.codigo === String(r.codigo));
      if (correspondente && correspondente.dataBr && /^\d{2}\/\d{2}\/\d{4}$/.test(correspondente.dataBr)) {
        await pool.query(
          `UPDATE alunos
           SET status='inativo', data_nascimento = STR_TO_DATE(?, '%d/%m/%Y'), turma_id = ?
           WHERE id = ?`,
          [correspondente.dataBr, turma_id, r.id]
        );
      } else {
        await pool.query("UPDATE alunos SET status='inativo' WHERE id = ?", [r.id]);
      }
      
      await pool.query(
        "UPDATE matriculas SET status='inativo' WHERE aluno_id = ? AND ano_letivo = ? AND escola_id = ?",
        [r.id, anoLetivoAtual, escola_id]
      );
      inativados++;
    }

    console.log(
      `[importar-xlsx] localizados: ${xlsxEntries.length}, inseridos: ${inseridos}, reativados: ${reativados}, atualizados: ${atualizados}, jaExistiam: ${jaExistiam}, inativados: ${inativados}`
    );
    return res.json({ localizados: xlsxEntries.length, inseridos, reativados, atualizados, jaExistiam, inativados });
  } catch (err) {
    console.error("Erro ao processar /importar-xlsx:", err);
    return res.status(500).json({ message: "Erro ao processar XLSX.", error: err.message });
  }
});

/* ============================================================================
 * 13) LISTAR INATIVOS
 * GET /api/alunos/inativos
 * ========================================================================== */
router.get("/inativos", verificarEscola, async (req, res) => {
  try {
    const { escola_id } = req.user;
    const [rows] = await pool.query(
      `SELECT a.id, a.codigo, a.estudante,
              DATE_FORMAT(a.data_nascimento, '%Y-%m-%d') AS data_nascimento,
              a.sexo, a.status,
              t.nome AS turma, t.turno
       FROM alunos a
       LEFT JOIN turmas t ON t.id = a.turma_id
       WHERE a.status='inativo' AND a.escola_id = ?
       ORDER BY a.estudante`,
      [escola_id]
    );
    res.json(rows);
  } catch (err) {
    console.error("Erro ao buscar alunos inativos:", err);
    res.status(500).json({ message: "Erro ao buscar alunos inativos." });
  }
});

/* ============================================================================
 * 14) ROTA DE TESTE (opcional)
 * GET /api/alunos/testetodosalunos
 * ========================================================================== */
router.get("/testetodosalunos", async (req, res) => {
  const [rows] = await pool.query("SELECT * FROM alunos");
  res.json(rows);
});

/* ============================================================================
 * 15) OCORRÃŠNCIAS DISCIPLINARES
 * GET /api/alunos/:id/ocorrencias
 * POST /api/alunos/:id/ocorrencias
 * ========================================================================== */
router.get("/:id/proxima-ocorrencia", verificarEscola, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT AUTO_INCREMENT
       FROM information_schema.tables
       WHERE table_name = 'ocorrencias_disciplinares'
       AND table_schema = DATABASE()`
    );

    const proximoId = rows[0]?.AUTO_INCREMENT || 1;
    const registroFormatado = String(proximoId).padStart(4, '0');

    res.json({ proximoRegistro: registroFormatado });
  } catch (err) {
    console.error("Erro ao buscar proximo registro:", err);
    res.status(500).json({ message: "Erro ao buscar prÃ³ximo registro de ocorrÃªncia." });
  }
});
router.get("/:id/ocorrencias", verificarEscola, async (req, res) => {
  try {
    const { id } = req.params;
    const { escola_id } = req.user;

    // Atualiza bÃ´nus de mÃ©dia bimestral em tempo real antes de retornar ocorrÃªncias
    await calcularEUpsertBonusMedia(id, escola_id);

    // Query principal: inclui atenuantes/agravantes (Art. 34/35)
    // Fallback automÃ¡tico caso a migration ainda nÃ£o tenha sido executada no servidor
    const QUERY_FULL = `
      SELECT o.id,
              (
                SELECT JSON_ARRAYAGG(
                  JSON_OBJECT(
                    'responsavel_id', resp.id,
                    'nome', resp.nome,
                    'parentesco', ra.parentesco,
                    'master', ra.principal,
                    'data', DATE_FORMAT(ov.visualizado_em, '%d/%m/%Y %H:%i')
                  )
                )
                FROM ocorrencias_visualizacoes ov
                JOIN responsaveis resp ON resp.id = ov.responsavel_id
                LEFT JOIN responsaveis_alunos ra ON ra.responsavel_id = resp.id AND ra.aluno_id = o.aluno_id
                WHERE ov.ocorrencia_id = o.id
              ) AS visualizacoes,
              LPAD(o.id, 4, '0') AS registro,
              DATE_FORMAT(o.data_ocorrencia, '%d/%m/%Y') AS data_ocorrencia,
              o.motivo,
              r.medida_disciplinar,
              r.tipo_ocorrencia AS tipo,
              r.pontos,
              o.descricao,
              o.registro_interno,
              o.convocar_responsavel,
              DATE_FORMAT(o.data_convocacao, '%d/%m/%Y') AS data_convocacao,
              o.dias_suspensao,
              o.atenuantes,
              o.agravantes,
              DATE_FORMAT(o.data_comparecimento_responsavel, '%d/%m/%Y %H:%i') AS data_comparecimento_responsavel,
              o.status,
              ur.nome  AS nome_usuario_registro,
              uf.nome  AS nome_usuario_finalizacao,
              ui.nome  AS nome_usuario_impressao,
              ue.nome  AS nome_usuario_edicao
       FROM ocorrencias_disciplinares o
       LEFT JOIN usuarios ur ON ur.id = o.usuario_registro_id
       LEFT JOIN usuarios uf ON uf.id = o.usuario_finalizacao_id
       LEFT JOIN usuarios ui ON ui.id = o.usuario_impressao_id
       LEFT JOIN usuarios ue ON ue.id = o.usuario_edicao_id
       LEFT JOIN registros_ocorrencias r
         ON r.descricao_ocorrencia = o.motivo
         AND (o.tipo_ocorrencia IS NULL OR o.tipo_ocorrencia = '' OR r.tipo_ocorrencia = o.tipo_ocorrencia)
       WHERE o.aluno_id = ? AND o.escola_id = ?
       ORDER BY o.data_ocorrencia DESC, o.id DESC`;

    const QUERY_COMPAT = `
      SELECT o.id,
              (
                SELECT JSON_ARRAYAGG(
                  JSON_OBJECT(
                    'responsavel_id', resp.id,
                    'nome', resp.nome,
                    'parentesco', ra.parentesco,
                    'master', ra.principal,
                    'data', DATE_FORMAT(ov.visualizado_em, '%d/%m/%Y %H:%i')
                  )
                )
                FROM ocorrencias_visualizacoes ov
                JOIN responsaveis resp ON resp.id = ov.responsavel_id
                LEFT JOIN responsaveis_alunos ra ON ra.responsavel_id = resp.id AND ra.aluno_id = o.aluno_id
                WHERE ov.ocorrencia_id = o.id
              ) AS visualizacoes,
              LPAD(o.id, 4, '0') AS registro,
              DATE_FORMAT(o.data_ocorrencia, '%d/%m/%Y') AS data_ocorrencia,
              o.motivo,
              r.medida_disciplinar,
              r.tipo_ocorrencia AS tipo,
              r.pontos,
              o.descricao,
              o.registro_interno,
              o.convocar_responsavel,
              DATE_FORMAT(o.data_convocacao, '%d/%m/%Y') AS data_convocacao,
              o.dias_suspensao,
              NULL AS atenuantes,
              NULL AS agravantes,
              DATE_FORMAT(o.data_comparecimento_responsavel, '%d/%m/%Y %H:%i') AS data_comparecimento_responsavel,
              o.status,
              ur.nome  AS nome_usuario_registro,
              uf.nome  AS nome_usuario_finalizacao,
              ui.nome  AS nome_usuario_impressao,
              ue.nome  AS nome_usuario_edicao
       FROM ocorrencias_disciplinares o
       LEFT JOIN usuarios ur ON ur.id = o.usuario_registro_id
       LEFT JOIN usuarios uf ON uf.id = o.usuario_finalizacao_id
       LEFT JOIN usuarios ui ON ui.id = o.usuario_impressao_id
       LEFT JOIN usuarios ue ON ue.id = o.usuario_edicao_id
       LEFT JOIN registros_ocorrencias r
         ON r.descricao_ocorrencia = o.motivo
         AND (o.tipo_ocorrencia IS NULL OR o.tipo_ocorrencia = '' OR r.tipo_ocorrencia = o.tipo_ocorrencia)
       WHERE o.aluno_id = ? AND o.escola_id = ?
       ORDER BY o.data_ocorrencia DESC, o.id DESC`;

    let rows;
    try {
      [rows] = await pool.query(QUERY_FULL, [id, escola_id]);
    } catch (queryErr) {
      if (queryErr.code === 'ER_BAD_FIELD_ERROR') {
        // Migration atenuantes/agravantes ainda nÃ£o rodou â€” fallback compatÃ­vel
        console.warn('[disciplinar] Colunas atenuantes/agravantes ausentes â€” usando query de compatibilidade. Execute run_migration_atenuantes_agravantes.js no servidor.');
        [rows] = await pool.query(QUERY_COMPAT, [id, escola_id]);
      } else {
        throw queryErr;
      }
    }

    res.json(rows);
  } catch (err) {
    console.error("Erro ao buscar ocorrÃªncias:", err);
    res.status(500).json({ message: "Erro ao buscar ocorrÃªncias disciplinares." });
  }
});

router.post("/:id/ocorrencias", verificarEscola, async (req, res) => {
  try {
    const { id } = req.params;
    const { escola_id } = req.user;
    const usuarioRegistroId = req.user.usuarioId || req.user.id || req.user.usuario_id;
    const { data, motivo, tipoOcorrencia, descricao, registroInterno, convocarResponsavel, diasSuspensao, atenuantes, agravantes, dataConvocacao } = req.body;

    if (!data || !motivo) {
      return res.status(400).json({ message: "Preencha os campos obrigatÃ³rios." });
    }

    // Serializar atenuantes/agravantes como JSON (Art. 34/35)
    const atenuantesJson = Array.isArray(atenuantes) && atenuantes.length > 0 ? JSON.stringify(atenuantes) : null;
    const agravantesJson = Array.isArray(agravantes) && agravantes.length > 0 ? JSON.stringify(agravantes) : null;
    // Normalizar data de convocaÃ§Ã£o (aceita YYYY-MM-DD ou null/undefined)
    const dataConvocacaoVal = dataConvocacao || null;

    // Fallback: se atenuantes/agravantes ou data_convocacao ainda nÃ£o existirem no BD, insere sem elas
    let result;
    try {
      [result] = await pool.query(
        `INSERT INTO ocorrencias_disciplinares
           (aluno_id, escola_id, data_ocorrencia, motivo, tipo_ocorrencia, descricao, registro_interno,
            convocar_responsavel, data_convocacao, dias_suspensao, atenuantes, agravantes, usuario_registro_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, escola_id, data, motivo, tipoOcorrencia || null, descricao || null,
         registroInterno || null, convocarResponsavel ? 1 : 0, dataConvocacaoVal,
         diasSuspensao || null, atenuantesJson, agravantesJson, usuarioRegistroId]
      );
    } catch (insertErr) {
      if (insertErr.code === 'ER_BAD_FIELD_ERROR') {
        // Colunas ausentes â€” insere sem elas
        [result] = await pool.query(
          `INSERT INTO ocorrencias_disciplinares
             (aluno_id, escola_id, data_ocorrencia, motivo, tipo_ocorrencia, descricao, registro_interno,
              convocar_responsavel, dias_suspensao, usuario_registro_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [id, escola_id, data, motivo, tipoOcorrencia || null, descricao || null,
           registroInterno || null, convocarResponsavel ? 1 : 0, diasSuspensao || null,
           usuarioRegistroId]
        );
      } else {
        throw insertErr;
      }
    }

    res.status(201).json({
      message: "OcorrÃªncia registrada com sucesso.",
      id: result.insertId
    });
  } catch (err) {
    console.error("Erro ao registrar ocorrÃªncia:", err);
    res.status(500).json({ message: "Erro ao registrar ocorrÃªncia." });
  }
});

// â”€â”€â”€ F.O. COLETIVO: Registro em Lote â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// POST /api/alunos/ocorrencias/lote
// Body: { data, motivo, tipoOcorrencia, descricao, registroInterno, diasSuspensao, alunos:[{alunoId, convocarResponsavel}] }
router.post("/ocorrencias/lote", verificarEscola, async (req, res) => {
  try {
    const { escola_id } = req.user;
    const usuarioRegistroId = req.user.usuarioId || req.user.id || req.user.usuario_id;
    const { data, motivo, tipoOcorrencia, descricao, registroInterno, diasSuspensao, alunos } = req.body;

    if (!data || !motivo) {
      return res.status(400).json({ message: "Campos obrigatÃ³rios: data e motivo." });
    }
    if (!Array.isArray(alunos) || alunos.length === 0) {
      return res.status(400).json({ message: "Informe ao menos um aluno no lote." });
    }

    // UUID Ãºnico que vincula todos os registros deste lote
    const { randomUUID } = await import("crypto");
    const loteId = randomUUID();

    let sucesso = 0;
    let falhas  = 0;
    const erros = [];

    // Detectar se atenuantes/agravantes existem (teste Ãºnico antes do loop)
    let colunasExtrasExistem = true;
    try {
      await pool.query(
        `INSERT INTO ocorrencias_disciplinares
           (aluno_id, escola_id, data_ocorrencia, motivo, tipo_ocorrencia, descricao, registro_interno,
            convocar_responsavel, dias_suspensao, usuario_registro_id, lote_id, origem, atenuantes, agravantes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'coletivo', NULL, NULL)
         LIMIT 0`,
        [0, 0, data, motivo, null, null, null, 0, null, usuarioRegistroId, loteId]
      );
    } catch (testErr) {
      if (testErr.code === 'ER_BAD_FIELD_ERROR') colunasExtrasExistem = false;
    }

    for (const item of alunos) {
      const { alunoId, convocarResponsavel } = item;
      if (!alunoId) { falhas++; continue; }
      try {
        if (colunasExtrasExistem) {
          await pool.query(
            `INSERT INTO ocorrencias_disciplinares
               (aluno_id, escola_id, data_ocorrencia, motivo, tipo_ocorrencia, descricao, registro_interno,
                convocar_responsavel, dias_suspensao, usuario_registro_id, lote_id, origem)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'coletivo')`,
            [alunoId, escola_id, data, motivo, tipoOcorrencia || null,
             descricao || null, registroInterno || null,
             convocarResponsavel ? 1 : 0, diasSuspensao || null,
             usuarioRegistroId, loteId]
          );
        } else {
          // Fallback: sem atenuantes/agravantes
          await pool.query(
            `INSERT INTO ocorrencias_disciplinares
               (aluno_id, escola_id, data_ocorrencia, motivo, tipo_ocorrencia, descricao, registro_interno,
                convocar_responsavel, dias_suspensao, usuario_registro_id, lote_id, origem)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'coletivo')`,
            [alunoId, escola_id, data, motivo, tipoOcorrencia || null,
             descricao || null, registroInterno || null,
             convocarResponsavel ? 1 : 0, diasSuspensao || null,
             usuarioRegistroId, loteId]
          );
        }
        sucesso++;
      } catch (innerErr) {
        console.error(`[Lote] Erro aluno ${alunoId}:`, innerErr);
        falhas++;
        erros.push({ alunoId, err: innerErr.message });
      }
    }

    return res.status(201).json({
      message: `${sucesso} registros criados com sucesso.${falhas > 0 ? ` ${falhas} falharam.` : ''}`,
      total: alunos.length,
      sucesso,
      falhas,
      lote_id: loteId,
      erros: erros.length > 0 ? erros : undefined,
    });
} catch (err) {
    console.error("[Lote] Erro geral:", err);
    return res.status(500).json({ message: "Erro ao registrar lote." });
  }
});
// â”€â”€â”€ FIM F.O. COLETIVO â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// â”€â”€â”€ F.O. COLETIVO: Buscar registros por data (impressÃ£o em lote) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// GET /api/alunos/ocorrencias/coletivos?data=YYYY-MM-DD
router.get("/ocorrencias/coletivos", verificarEscola, async (req, res) => {
  try {
    const { escola_id } = req.user;
    const dataParam = req.query.data || (() => {
      const d = new Date(Date.now() - 3 * 60 * 60 * 1000);
      return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    })();

    const [rows] = await pool.query(
      `SELECT
         o.lote_id,
         o.id                                                       AS ocorrencia_id,
         DATE_FORMAT(o.data_ocorrencia, '%d/%m/%Y')                 AS data_ocorrencia,
         o.motivo,
         o.tipo_ocorrencia,
         o.status,
         o.descricao,
         a.id                                                        AS aluno_id,
         a.estudante,
         a.codigo,
         t.nome                                                      AS turma,
         t.turno,
         COALESCE(r.medida_disciplinar, o.tipo_ocorrencia, 'N/D')   AS medida_disciplinar,
         ur.nome                                                     AS registrado_por
       FROM ocorrencias_disciplinares o
       JOIN  alunos a  ON a.id = o.aluno_id AND a.escola_id = o.escola_id
       LEFT JOIN turmas t ON t.id = a.turma_id
       LEFT JOIN registros_ocorrencias r
         ON r.descricao_ocorrencia = o.motivo
       LEFT JOIN usuarios ur ON ur.id = o.usuario_registro_id
       WHERE o.escola_id = ?
         AND o.origem    = 'coletivo'
         AND DATE(o.data_ocorrencia) = ?
         AND o.status   != 'CANCELADA'
       ORDER BY o.lote_id, a.estudante ASC`,
      [escola_id, dataParam]
    );

    // Agrupar por lote_id
    const lotesMap = new Map();
    for (const row of rows) {
      const key = row.lote_id || `_${row.ocorrencia_id}`;
      if (!lotesMap.has(key)) {
        lotesMap.set(key, {
          lote_id:           key,
          data_ocorrencia:   row.data_ocorrencia,
          motivo:            row.motivo,
          tipo_ocorrencia:   row.tipo_ocorrencia,
          medida_disciplinar: row.medida_disciplinar,
          descricao:         row.descricao,
          registrado_por:    row.registrado_por,
          alunos:            [],
        });
      }
      lotesMap.get(key).alunos.push({
        aluno_id:      row.aluno_id,
        ocorrencia_id: row.ocorrencia_id,
        estudante:     row.estudante,
        codigo:        row.codigo,
        turma:         row.turma,
        turno:         row.turno,
        status:        row.status,
      });
    }

    res.json({
      data: dataParam,
      lotes: Array.from(lotesMap.values()),
      total_alunos: rows.length,
    });
  } catch (err) {
    console.error("[Coletivos] Erro:", err);
    res.status(500).json({ message: "Erro ao buscar registros coletivos." });
  }
});
// â”€â”€â”€ FIM COLETIVOS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

router.put("/:id/ocorrencias/:ocorrenciaId", verificarEscola, async (req, res) => {
  try {
    const { id, ocorrenciaId } = req.params;
    const { escola_id } = req.user;
    const usuarioEdicaoId = req.user.usuarioId || req.user.id || req.user.usuario_id;
    const { descricao, registroInterno, convocarResponsavel, atenuantes, agravantes, dataConvocacao } = req.body;

    // Serializar atenuantes/agravantes como JSON (Art. 34/35)
    const atenuantesJson = Array.isArray(atenuantes) && atenuantes.length > 0 ? JSON.stringify(atenuantes) : null;
    const agravantesJson = Array.isArray(agravantes) && agravantes.length > 0 ? JSON.stringify(agravantes) : null;
    const dataConvocacaoVal = dataConvocacao || null;

    try {
      await pool.query(
        `UPDATE ocorrencias_disciplinares
         SET descricao = ?, registro_interno = ?, convocar_responsavel = ?,
             data_convocacao = ?, atenuantes = ?, agravantes = ?, usuario_edicao_id = ?
         WHERE id = ? AND aluno_id = ? AND escola_id = ?`,
        [descricao, registroInterno || null, convocarResponsavel ? 1 : 0,
         dataConvocacaoVal, atenuantesJson, agravantesJson, usuarioEdicaoId, ocorrenciaId, id, escola_id]
      );
    } catch (updErr) {
      if (updErr.code === 'ER_BAD_FIELD_ERROR') {
        // Fallback sem data_convocacao/atenuantes/agravantes
        await pool.query(
          `UPDATE ocorrencias_disciplinares
           SET descricao = ?, registro_interno = ?, convocar_responsavel = ?, usuario_edicao_id = ?
           WHERE id = ? AND aluno_id = ? AND escola_id = ?`,
          [descricao, registroInterno || null, convocarResponsavel ? 1 : 0,
           usuarioEdicaoId, ocorrenciaId, id, escola_id]
        );
      } else {
        throw updErr;
      }
    }

    res.json({ message: "OcorrÃªncia atualizada com sucesso." });
  } catch (err) {
    console.error("Erro ao atualizar ocorrÃªncia:", err);
    res.status(500).json({ message: "Erro ao atualizar ocorrÃªncia." });
  }
});

router.put("/:id/ocorrencias/:ocorrenciaId/comparecimento", verificarEscola, async (req, res) => {
  try {
    const { id, ocorrenciaId } = req.params;
    const { escola_id } = req.user;
    const usuarioFinalizacaoId = req.user.usuarioId || req.user.id || req.user.usuario_id;
    const modo = req.body?.modo || 'presenca'; // 'presenca' | 'telefone' | 'nao_compareceu'
    const observacaoInterna = req.body?.observacao_interna?.trim() || '';

    // Texto de rastreabilidade para registro interno
    const agora = new Date(Date.now() - 3 * 60 * 60 * 1000); // UTC-3
    const dataStr = agora.toLocaleDateString('pt-BR') + ' ' + agora.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

    let registroFinal = '';
    if (modo === 'telefone') {
      registroFinal = `[FINALIZAÇÃO] Contato realizado via telefone em ${dataStr}.`;
    } else if (modo === 'nao_compareceu') {
      registroFinal = `[FINALIZAÇÃO] Responsável convocado e não compareceu. Registro finalizado em ${dataStr}.`;
    } else if (modo === 'nao_convocado') {
      registroFinal = `[FINALIZAÇÃO] Responsável tomou conhecimento do registro disciplinar através do aplicativo. Registro finalizado em ${dataStr}.`;
    } else if (modo === 'presenca' && observacaoInterna) {
      registroFinal = `[FINALIZAÇÃO] Presença confirmada em ${dataStr}.`;
    }

    if (observacaoInterna) {
      if (registroFinal) {
        registroFinal += `\n[OBSERVAÇÕES INTERNAS] ${observacaoInterna}`;
      } else {
        registroFinal = `[FINALIZAÇÃO] ${dataStr}\n[OBSERVAÇÕES INTERNAS] ${observacaoInterna}`;
      }
    }

    // modo = 'presenca' -> data_comparecimento_responsavel já registra


    // Se modo = 'presenca' â†’ grava data de comparecimento (quando hÃ¡ convocaÃ§Ã£o)
    // Se modo = 'telefone' ou 'nao_compareceu' â†’ NÃƒO grava data de comparecimento
    const setComparecimento = modo === 'presenca'
      ? `data_comparecimento_responsavel = CASE WHEN convocar_responsavel = 1 THEN DATE_SUB(NOW(), INTERVAL 3 HOUR) ELSE data_comparecimento_responsavel END,`
      : '';

    // Append ao registro_interno existente (nÃ£o sobrescreve)
    const setRegistroInterno = registroFinal
      ? `registro_interno = CASE 
           WHEN registro_interno IS NULL OR registro_interno = '' THEN ?
           ELSE CONCAT(registro_interno, '\\n', ?)
         END,`
      : '';

    const params = [];
    if (registroFinal) {
      params.push(registroFinal, registroFinal);
    }
    params.push(usuarioFinalizacaoId, ocorrenciaId, id, escola_id);

    const [result] = await pool.query(
      `UPDATE ocorrencias_disciplinares 
       SET ${setComparecimento}
           ${setRegistroInterno}
           status = 'FINALIZADA',
           usuario_finalizacao_id = ?
       WHERE id = ? AND aluno_id = ? AND escola_id = ?`,
      params
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "OcorrÃªncia nÃ£o encontrada." });
    }

    res.json({ message: "OcorrÃªncia finalizada com sucesso.", modo });
  } catch (err) {
    console.error("Erro ao finalizar ocorrÃªncia:", err);
    res.status(500).json({ message: "Erro ao finalizar ocorrÃªncia." });
  }
});

// ============================================================================
// PUT /api/alunos/:id/ocorrencias/:ocorrenciaId/cancelamento
// Cancela uma medida disciplinar â€” reverte a pontuaÃ§Ã£o do aluno
// Registra o usuÃ¡rio que realizou o cancelamento
// ============================================================================
router.put("/:id/ocorrencias/:ocorrenciaId/cancelamento", verificarEscola, async (req, res) => {
  try {
    const { id, ocorrenciaId } = req.params;
    const { escola_id } = req.user;
    const usuarioCancelamentoId = req.user.usuarioId || req.user.id || req.user.usuario_id;

    const [result] = await pool.query(
      `UPDATE ocorrencias_disciplinares 
       SET status = 'CANCELADA',
           usuario_finalizacao_id = ?
       WHERE id = ? AND aluno_id = ? AND escola_id = ? AND status IN ('FINALIZADA', 'REGISTRADA')`,
      [usuarioCancelamentoId, ocorrenciaId, id, escola_id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "OcorrÃªncia nÃ£o encontrada ou jÃ¡ cancelada." });
    }

    res.json({ message: "Medida disciplinar cancelada com sucesso." });
  } catch (err) {
    console.error("Erro ao cancelar medida disciplinar:", err);
    res.status(500).json({ message: "Erro ao cancelar medida disciplinar." });
  }
});

router.delete("/:id/ocorrencias/:ocorrenciaId", verificarEscola, async (req, res) => {
  try {
    const { id, ocorrenciaId } = req.params;
    const { escola_id } = req.user;

    const [result] = await pool.query(
      `DELETE FROM ocorrencias_disciplinares 
       WHERE id = ? AND aluno_id = ? AND escola_id = ? AND status != 'FINALIZADA'`,
      [ocorrenciaId, id, escola_id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "OcorrÃªncia nÃ£o encontrada ou nÃ£o pode ser excluÃ­da." });
    }

    res.json({ message: "OcorrÃªncia excluÃ­da com sucesso." });
  } catch (err) {
    console.error("Erro ao excluir ocorrÃªncia:", err);
    res.status(500).json({ message: "Erro ao excluir ocorrÃªncia." });
  }
});

/* ============================================================================
 * 16) OCORRÃŠNCIAS PEDAGÃ“GICAS
 * CRUD completo â€” mesma lÃ³gica de status das disciplinares (sem pontuaÃ§Ã£o)
 * ========================================================================== */

// GET â€” listar ocorrÃªncias pedagÃ³gicas de um aluno
router.get("/:id/ocorrencias-pedagogicas", verificarEscola, async (req, res) => {
  try {
    const { id } = req.params;
    const { escola_id } = req.user;

    const [rows] = await pool.query(
      `SELECT o.id,
              LPAD(o.id, 4, '0') AS registro,
              DATE_FORMAT(o.data_ocorrencia, '%d/%m/%Y') AS data_ocorrencia,
              o.categoria,
              o.motivo,
              o.descricao,
              o.registro_interno,
              o.convocar_responsavel,
              DATE_FORMAT(o.data_comparecimento_responsavel, '%d/%m/%Y %H:%i') AS data_comparecimento_responsavel,
              o.status,
              o.usuario_registro_id,
              ur.nome AS nome_usuario_registro,
              uf.nome AS nome_usuario_finalizacao,
              (
                  SELECT JSON_ARRAYAGG(
                    JSON_OBJECT(
                      'responsavel_id', resp.id,
                      'nome', resp.nome,
                      'parentesco', ra.parentesco,
                      'master', ra.principal,
                      'data', DATE_FORMAT(ov.visualizado_em, '%d/%m/%Y %H:%i')
                    )
                  )
                FROM ocorrencias_pedagogicas_visualizacoes ov
                  JOIN responsaveis resp ON resp.id = ov.responsavel_id
                  LEFT JOIN responsaveis_alunos ra ON ra.responsavel_id = resp.id AND ra.aluno_id = o.aluno_id
                  WHERE ov.ocorrencia_id = o.id
              ) AS visualizacoes
       FROM ocorrencias_pedagogicas o
       LEFT JOIN usuarios ur ON ur.id = o.usuario_registro_id
       LEFT JOIN usuarios uf ON uf.id = o.usuario_finalizacao_id
       WHERE o.aluno_id = ? AND o.escola_id = ?
       ORDER BY o.data_ocorrencia DESC, o.id DESC`,
      [id, escola_id]
    );

    res.json(rows);
  } catch (err) {
    console.error("Erro ao buscar ocorrÃªncias pedagÃ³gicas:", err);
    res.status(500).json({ message: "Erro ao buscar ocorrÃªncias pedagÃ³gicas." });
  }
});

// GET â€” prÃ³ximo registro (auto-increment)
router.get("/:id/proxima-ocorrencia-pedagogica", verificarEscola, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT AUTO_INCREMENT
       FROM information_schema.tables
       WHERE table_name = 'ocorrencias_pedagogicas'
       AND table_schema = DATABASE()`
    );
    const proximoId = rows[0]?.AUTO_INCREMENT || 1;
    res.json({ proximoRegistro: String(proximoId).padStart(4, '0') });
  } catch (err) {
    console.error("Erro ao buscar prÃ³ximo registro pedagÃ³gico:", err);
    res.status(500).json({ message: "Erro ao buscar prÃ³ximo registro." });
  }
});

// POST â€” criar nova ocorrÃªncia pedagÃ³gica
router.post("/:id/ocorrencias-pedagogicas", verificarEscola, async (req, res) => {
  try {
    const { id } = req.params;
    const { escola_id } = req.user;
    const usuarioId = req.user.usuarioId || req.user.id || req.user.usuario_id;
    const { data, categoria, motivo, descricao, registroInterno, convocarResponsavel } = req.body;

    if (!data || !motivo || !categoria) {
      return res.status(400).json({ message: "Preencha os campos obrigatÃ³rios (data, categoria, motivo)." });
    }

    const [result] = await pool.query(
      `INSERT INTO ocorrencias_pedagogicas
         (aluno_id, escola_id, data_ocorrencia, categoria, motivo, descricao, registro_interno, convocar_responsavel, usuario_registro_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, escola_id, data, categoria, motivo, descricao || null, registroInterno || null, convocarResponsavel ? 1 : 0, usuarioId]
    );

    res.status(201).json({
      message: "Registro pedagÃ³gico criado com sucesso.",
      id: result.insertId,
    });
  } catch (err) {
    console.error("Erro ao registrar ocorrÃªncia pedagÃ³gica:", err);
    res.status(500).json({ message: "Erro ao registrar ocorrÃªncia pedagÃ³gica." });
  }
});

// PUT — editar ocorrência pedagógica (apenas pelo autor do registro)
router.put("/:id/ocorrencias-pedagogicas/:ocorrenciaId", verificarEscola, async (req, res) => {
  try {
    const { id, ocorrenciaId } = req.params;
    const { escola_id } = req.user;
    const usuarioId = req.user.usuarioId || req.user.id || req.user.usuario_id;
    const { descricao, registroInterno, convocarResponsavel } = req.body;

    // Valida autoria: apenas quem criou pode editar
    const [[registro]] = await pool.query(
      'SELECT usuario_registro_id FROM ocorrencias_pedagogicas WHERE id = ? AND aluno_id = ? AND escola_id = ?',
      [ocorrenciaId, id, escola_id]
    );
    if (!registro) {
      return res.status(404).json({ message: 'Registro não encontrado.' });
    }
    if (registro.usuario_registro_id && registro.usuario_registro_id !== usuarioId) {
      return res.status(403).json({ message: 'Sem permissão: você não é o autor deste registro.' });
    }

    await pool.query(
      `UPDATE ocorrencias_pedagogicas
       SET descricao = ?, registro_interno = ?, convocar_responsavel = ?
       WHERE id = ? AND aluno_id = ? AND escola_id = ?`,
      [descricao, registroInterno || null, convocarResponsavel ? 1 : 0, ocorrenciaId, id, escola_id]
    );

    res.json({ message: 'Registro pedagógico atualizado.' });
  } catch (err) {
    console.error('Erro ao atualizar ocorrência pedagógica:', err);
    res.status(500).json({ message: 'Erro ao atualizar registro pedagógico.' });
  }
});

// PUT â€” finalizar ocorrÃªncia pedagÃ³gica
router.put("/:id/ocorrencias-pedagogicas/:ocorrenciaId/finalizar", verificarEscola, async (req, res) => {
  try {
    const { id, ocorrenciaId } = req.params;
    const { escola_id } = req.user;
    const usuarioFinalizacaoId = req.user.usuarioId || req.user.id || req.user.usuario_id;

    const [result] = await pool.query(
      `UPDATE ocorrencias_pedagogicas
       SET data_comparecimento_responsavel = CASE WHEN convocar_responsavel = 1 THEN DATE_SUB(NOW(), INTERVAL 3 HOUR) ELSE data_comparecimento_responsavel END,
           status = 'FINALIZADA',
           usuario_finalizacao_id = ?
       WHERE id = ? AND aluno_id = ? AND escola_id = ?`,
      [usuarioFinalizacaoId, ocorrenciaId, id, escola_id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Registro pedagÃ³gico nÃ£o encontrado." });
    }

    res.json({ message: "Registro pedagÃ³gico finalizado." });
  } catch (err) {
    console.error("Erro ao finalizar registro pedagÃ³gico:", err);
    res.status(500).json({ message: "Erro ao finalizar registro pedagÃ³gico." });
  }
});

// PUT â€” cancelar ocorrÃªncia pedagÃ³gica
router.put("/:id/ocorrencias-pedagogicas/:ocorrenciaId/cancelamento", verificarEscola, async (req, res) => {
  try {
    const { id, ocorrenciaId } = req.params;
    const { escola_id } = req.user;
    const usuarioCancelamentoId = req.user.usuarioId || req.user.id || req.user.usuario_id;

    const [result] = await pool.query(
      `UPDATE ocorrencias_pedagogicas
       SET status = 'CANCELADA',
           usuario_finalizacao_id = ?
       WHERE id = ? AND aluno_id = ? AND escola_id = ? AND status IN ('FINALIZADA', 'REGISTRADA')`,
      [usuarioCancelamentoId, ocorrenciaId, id, escola_id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Registro nÃ£o encontrado ou jÃ¡ cancelado." });
    }

    res.json({ message: "Registro pedagÃ³gico cancelado." });
  } catch (err) {
    console.error("Erro ao cancelar registro pedagÃ³gico:", err);
    res.status(500).json({ message: "Erro ao cancelar registro pedagÃ³gico." });
  }
});

// DELETE — excluir ocorrência pedagógica (apenas REGISTRADA e pelo autor)
router.delete("/:id/ocorrencias-pedagogicas/:ocorrenciaId", verificarEscola, async (req, res) => {
  try {
    const { id, ocorrenciaId } = req.params;
    const { escola_id } = req.user;
    const usuarioId = req.user.usuarioId || req.user.id || req.user.usuario_id;

    // Valida autoria antes de excluir
    const [[registro]] = await pool.query(
      'SELECT usuario_registro_id, status FROM ocorrencias_pedagogicas WHERE id = ? AND aluno_id = ? AND escola_id = ?',
      [ocorrenciaId, id, escola_id]
    );
    if (!registro) {
      return res.status(404).json({ message: 'Registro não encontrado.' });
    }
    if (registro.usuario_registro_id && registro.usuario_registro_id !== usuarioId) {
      return res.status(403).json({ message: 'Sem permissão: você não é o autor deste registro.' });
    }

    const [result] = await pool.query(
      `DELETE FROM ocorrencias_pedagogicas
       WHERE id = ? AND aluno_id = ? AND escola_id = ? AND status = 'REGISTRADA'`,
      [ocorrenciaId, id, escola_id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Registro não encontrado ou não pode ser excluído.' });
    }

    res.json({ message: 'Registro pedagógico excluído.' });
  } catch (err) {
    console.error('Erro ao excluir registro pedagógico:', err);
    res.status(500).json({ message: 'Erro ao excluir registro pedagógico.' });
  }
});

// =========================================================================
// Rota EXCLUSIVA para a Lista IEDUCAR
// =========================================================================
router.post("/importar-pdf-ieducar", verificarGovernancaImportacaoAlunos, uploadPdf.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: "PDF não enviado." });
  }

  try {
    const { escola_id } = req.user;
    const anoLetivoAtual = typeof anoLetivoPadrao === "function" ? anoLetivoPadrao() : String(new Date().getFullYear());
    const semTurma = req.body.semTurma === "true" || req.body.semTurma === true;

    // FASE 1: Extração posicional com separação por página
    const allItems = [];
    let pageCounter = 0;

    await pdfParse(req.file.buffer, {
      pagerender: async (pageData) => {
        pageCounter++;
        const pg = pageCounter;
        const tc = await pageData.getTextContent();
        for (const item of tc.items) {
          const txt = (item.str || "").trim();
          if (!txt) continue;
          allItems.push({
            text: txt,
            x: Math.round(item.transform[4]),
            y: Math.round(item.transform[5]),
            page: pg,
          });
        }
        return "";
      },
    });

    // Agrupa por chave "página-Y" (tolerância 3px no Y)
    const rowsMap = {};
    for (const it of allItems) {
      const yKey = Math.round(it.y / 3) * 3;
      const key = `${it.page}-${yKey}`;
      if (!rowsMap[key]) rowsMap[key] = [];
      rowsMap[key].push(it);
    }

    // FASE 2: Detecta cabeçalho por página para IEDUCAR
    const headerYByPage = {};
    for (const [key, items] of Object.entries(rowsMap)) {
      const [pgStr, yStr] = key.split("-");
      const pg = Number(pgStr);
      const y = Number(yStr);
      const textos = items.map((it) => it.text.toUpperCase());
      const hasCodigo = textos.some((t) => t === "CÓDIGO" || t === "CODIGO");
      const hasNome = textos.some((t) => t.includes("NOME DO ESTUDANTE"));
      if (hasCodigo && hasNome) {
        if (!(pg in headerYByPage) || y > headerYByPage[pg]) {
          headerYByPage[pg] = y;
        }
      }
    }
    console.log(`[importar-pdf-ieducar] ${pageCounter} página(s), cabeçalhos:`, headerYByPage);

    // FASE 3: Ranges de colunas calibrados nas posições reais do IEDUCAR
    const COL_RANGES = {
      re:       { min: 20, max: 80 },     // Código
      nome:     { min: 80, max: 280 },    // Nome do Estudante/Nome Social
      dataNasc: { min: 280, max: 380 },   // Dt Nasc / Idade
      sexo:     { min: 380, max: 410 },   // Sexo
      contato:  { min: 410, max: 500 },   // Telefone
      nomeResp: { min: 500, max: 1200 },  // Nome do Responsável
    };

    function getCol(x) {
      for (const [col, range] of Object.entries(COL_RANGES)) {
        if (x >= range.min && x < range.max) return col;
      }
      return null;
    }

    // FASE 4: Classifica cada linha como "data row" ou "continuation"
    const sortedKeys = Object.keys(rowsMap).sort((a, b) => {
      const [pa, ya] = a.split("-").map(Number);
      const [pb, yb] = b.split("-").map(Number);
      if (pa !== pb) return pa - pb;
      return yb - ya; 
    });

    const classifiedRows = [];
    for (const key of sortedKeys) {
      const [pgStr, yStr] = key.split("-");
      const pg = Number(pgStr);
      const yKey = Number(yStr);
      const headerY = headerYByPage[pg];
      if (!headerY || yKey >= headerY) continue;

      const lineItems = rowsMap[key].sort((a, b) => a.x - b.x);
      const rowData = {};
      for (const it of lineItems) {
        const col = getCol(it.x);
        if (col) {
          rowData[col] = rowData[col] ? rowData[col] + " " + it.text : it.text;
        }
      }
      const reRaw = (rowData.re || "").replace(/\D/g, "").trim();
      const isDataRow = /^\d{4,8}$/.test(reRaw);
      classifiedRows.push({ key, pg, yKey, rowData, isDataRow });
    }

    // FASE 5: Merge
    const dataRowsByPage = {};
    for (const row of classifiedRows) {
      if (!row.isDataRow) continue;
      if (!dataRowsByPage[row.pg]) dataRowsByPage[row.pg] = [];
      dataRowsByPage[row.pg].push(row);
    }

    const mergedRows = [];
    for (const pg of Object.keys(dataRowsByPage)) {
      const dRows = dataRowsByPage[pg]; 
      const allPageRows = classifiedRows.filter((r) => r.pg === Number(pg));

      for (let i = 0; i < dRows.length; i++) {
        const currentRow = dRows[i];
        const upperBound = i > 0 ? dRows[i - 1].yKey : Infinity;
        const lowerBound = i < dRows.length - 1 ? dRows[i + 1].yKey : -Infinity;

        const continuations = allPageRows.filter(
          (r) => !r.isDataRow && r.yKey < upperBound && r.yKey > lowerBound
        );

        const merged = { ...currentRow.rowData };
        // Merge telefone da linha de continuação (IEDUCAR coloca celular na linha de baixo)
        for (const cont of continuations) {
          if (cont.rowData.contato) {
            merged.contato = merged.contato ? merged.contato + " | " + cont.rowData.contato : cont.rowData.contato;
          }
        }
        mergedRows.push(merged);
      }
    }

    // FASE 6: Limpeza e normalização
    const pdfEntries = [];
    let turmaNomePdf = null;
    
    // Tenta encontrar a turma pelo nome do arquivo PDF (que vem no req.file.originalname)
    if (req.file && req.file.originalname) {
       // O Multer costuma entregar o originalname em latin1. Precisamos converter para utf8 para evitar o "Âº".
       const decodedName = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
       turmaNomePdf = decodedName.replace(/\.pdf$/i, '').trim();
    }

    for (const r of mergedRows) {
      const re = (r.re || "").replace(/\D/g, "").trim();
      if (!/^\d{4,8}$/.test(re)) continue;

      const estudante = (r.nome || "").replace(/\s{2,}/g, " ").trim();
      if (!estudante) continue;

      const dataMatch = (r.dataNasc || "").match(/(\d{2}\/\d{2}\/\d{4})/);
      const dataBr = dataMatch ? dataMatch[1] : "";

      const sexoRaw = (r.sexo || "").trim();
      const sexo = /M/i.test(sexoRaw) || /masculino/i.test(sexoRaw) ? "Masculino"
                 : /F/i.test(sexoRaw) || /feminino/i.test(sexoRaw)  ? "Feminino"
                 : null;

      // Telefone: Prioriza celular (11 dígitos). Se tiver vários, procura o celular.
      const contatoRaw = (r.contato || "").trim();
      let telefone = null;
      if (contatoRaw && contatoRaw !== "-") {
        // Divide por | (linha de baixo) ou / (mesma linha)
        const parts = contatoRaw.split(/[|\/]/);
        let bestPhone = "";
        for (const p of parts) {
           const nums = p.replace(/\D/g, "");
           if (nums.length === 11) {
              bestPhone = nums;
              break; // Achou celular, para a busca
           } else if (nums.length >= 8 && !bestPhone) {
              bestPhone = nums; // Guarda fixo caso não ache celular
           }
        }
        telefone = bestPhone.substring(0, 20) || null;
      }

      const nomeResp = (r.nomeResp || "").trim() || null;

      pdfEntries.push({
        codigo: re,
        estudante,
        dataBr,
        cpfAluno: null, // Não usamos CPF no IEDUCAR
        sexo,
        serie: null,
        telefone,
        responsavel: nomeResp,
        cpfResponsavel: null, // Não usamos CPF
      });
    }

    console.log(
      `[importar-pdf-ieducar] Extraídos: ${pdfEntries.length} alunos | Turma PDF: "${turmaNomePdf}"`
    );

    if (pdfEntries.length === 0) {
      return res.status(400).json({
        message: "Nenhum aluno encontrado no PDF. Verifique se o arquivo está no formato IEDUCAR.",
      });
    }

    // FASE 7: Identificação da turma
    let turma_id = null;
    if (!semTurma) {
      if (!turmaNomePdf) {
        return res.status(400).json({
          message: "Não foi possível identificar a turma pelo nome do arquivo PDF.",
        });
      }

      const [[turma]] = await pool.query(
        `SELECT id, nome FROM turmas
         WHERE UPPER(TRIM(REPLACE(nome, ' - ', ' '))) = ?
           AND escola_id = ?
           AND ano = ?
         ORDER BY id DESC LIMIT 1`,
        [turmaNomePdf.toUpperCase().replace(/\s*-\s*/g, " ").replace(/\s+/g, " ").trim(), escola_id, anoLetivoAtual]
      );

      if (!turma) {
        return res.status(404).json({
          code: "TURMA_NAO_ENCONTRADA",
          message: `Turma "${turmaNomePdf}" não encontrada no sistema para o ano letivo ${anoLetivoAtual}.`,
          turmaNaoEncontrada: turmaNomePdf,
        });
      }
      turma_id = turma.id;
      console.log(`[importar-pdf-ieducar] Turma encontrada: id=${turma_id} nome="${turma.nome}"`);
    }

    // FASE 8: Situação atual no BD para a turma
    await ensureNomeSocialReady();
    const atuaisIdSet = new Set();
    const atuais = [];

    if (turma_id) {
      const [atuaisMatricula] = await pool.query(
        `SELECT a.id, a.codigo, a.estudante, a.nome_registro, a.usa_nome_social, a.nome_social, 'ativo' AS status
         FROM matriculas m
         INNER JOIN alunos a ON a.id = m.aluno_id
         WHERE m.turma_id = ? AND m.ano_letivo = ? AND m.escola_id = ? AND m.status = 'ativo'`,
        [turma_id, anoLetivoAtual, escola_id]
      );
      const [atuaisAlunos] = await pool.query(
        `SELECT a.id, a.codigo, a.estudante, a.nome_registro, a.usa_nome_social, a.nome_social, a.status
         FROM alunos a
         WHERE a.turma_id = ? AND a.escola_id = ? AND a.status = 'ativo'`,
        [turma_id, escola_id]
      );
      for (const a of atuaisMatricula) {
        if (!atuaisIdSet.has(a.id)) { atuaisIdSet.add(a.id); atuais.push(a); }
      }
      for (const a of atuaisAlunos) {
        if (!atuaisIdSet.has(a.id)) { atuaisIdSet.add(a.id); atuais.push(a); }
      }
    }

    const normName = (s) =>
      (s || "").toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim();

    const atuaisMap = new Map(atuais.map((a) => [String(a.codigo), a]));
    const atuaisNomeMap = new Map();
    for (const a of atuais) {
      registrarChavesNomeAluno(atuaisNomeMap, a, normName);
    }

    const entradaSet = new Set(pdfEntries.map((e) => String(e.codigo)));
    const toInsert = [];
    const toReactivate = [];
    let jaExistiam = 0;
    let atualizadosCodigo = 0;

    for (const e of pdfEntries) {
      const cod = String(e.codigo);
      let atual = atuaisMap.get(cod);

      if (!atual) {
        const nomeKey = normName(e.estudante);
        const porNome = atuaisNomeMap.get(nomeKey);
        if (porNome) {
          console.log(
            `[importar-pdf-ieducar] Match por nome: "${e.estudante}" — código ${porNome.codigo} -> ${e.codigo}`
          );
          await pool.query(
            "UPDATE alunos SET codigo = ? WHERE id = ? AND escola_id = ?",
            [e.codigo, porNome.id, escola_id]
          );
          atualizadosCodigo++;
          atual = porNome;
          atuaisMap.set(cod, porNome);
          atuaisNomeMap.delete(nomeKey);
          entradaSet.add(String(porNome.codigo));
        }
      }

      if (!atual) {
        toInsert.push(e);
      } else if (atual.status === "inativo") {
        toReactivate.push(e);
      } else {
        jaExistiam++;
        const sets = [];
        const params = [];

        const dataValida = e.dataBr && /^\d{2}\/\d{2}\/\d{4}$/.test(e.dataBr);
        if (dataValida) {
          sets.push("data_nascimento = COALESCE(data_nascimento, STR_TO_DATE(?, '%d/%m/%Y'))");
          params.push(e.dataBr);
        }
        if (e.sexo) {
          sets.push("sexo = IF(sexo IS NULL OR sexo = '', ?, sexo)");
          params.push(e.sexo);
        }
        if (sets.length > 0) {
          params.push(atual.id, escola_id);
          await pool.query(
            `UPDATE alunos SET ${sets.join(", ")} WHERE id = ? AND escola_id = ?`,
            params
          );
        }
        
        await upsertResponsavelSemCpf(pool, e, atual.id, escola_id);
      }
    }

    // FASE 9: Inserir novos alunos
    let inseridos = 0;
    for (const e of toInsert) {
      const dataValida = e.dataBr && /^\d{2}\/\d{2}\/\d{4}$/.test(e.dataBr);
      const baseParams = [e.codigo, e.estudante, e.estudante];
      let insertSql;

      if (dataValida) {
        insertSql = `INSERT INTO alunos (codigo, estudante, nome_registro, data_nascimento, sexo, turma_id, escola_id, status)
          VALUES (?, ?, ?, STR_TO_DATE(?, '%d/%m/%Y'), ?, ?, ?, 'ativo')
          ON DUPLICATE KEY UPDATE
            id = LAST_INSERT_ID(id),
            nome_registro = VALUES(nome_registro),
            estudante = IF(usa_nome_social = 1 AND nome_social IS NOT NULL AND TRIM(nome_social) <> '', nome_social, VALUES(estudante)),
            data_nascimento = COALESCE(data_nascimento, VALUES(data_nascimento)),
            sexo  = IF(sexo  IS NULL OR sexo  = '', VALUES(sexo),  sexo),
            turma_id = VALUES(turma_id),
            status = 'ativo'`;
        baseParams.push(e.dataBr, e.sexo || null, turma_id, escola_id);
      } else {
        insertSql = `INSERT INTO alunos (codigo, estudante, nome_registro, sexo, turma_id, escola_id, status)
          VALUES (?, ?, ?, ?, ?, ?, 'ativo')
          ON DUPLICATE KEY UPDATE
            id = LAST_INSERT_ID(id),
            nome_registro = VALUES(nome_registro),
            estudante = IF(usa_nome_social = 1 AND nome_social IS NOT NULL AND TRIM(nome_social) <> '', nome_social, VALUES(estudante)),
            sexo  = IF(sexo  IS NULL OR sexo  = '', VALUES(sexo),  sexo),
            turma_id = VALUES(turma_id),
            status = 'ativo'`;
        baseParams.push(e.sexo || null, turma_id, escola_id);
      }

      const [result] = await pool.query(insertSql, baseParams);
      const alunoId = result.insertId;

      if (alunoId && turma_id) {
        const [matr] = await pool.query(
          "SELECT id FROM matriculas WHERE aluno_id = ? AND ano_letivo = ? AND escola_id = ?",
          [alunoId, anoLetivoAtual, escola_id]
        );
        if (matr.length > 0) {
          await pool.query(
            "UPDATE matriculas SET status = 'ativo', turma_id = ? WHERE id = ?",
            [turma_id, matr[0].id]
          );
        } else {
          await pool.query(
            "INSERT INTO matriculas (escola_id, aluno_id, turma_id, ano_letivo, status) VALUES (?, ?, ?, ?, 'ativo')",
            [escola_id, alunoId, turma_id, anoLetivoAtual]
          );
        }
      }

      if (alunoId) await upsertResponsavelSemCpf(pool, e, alunoId, escola_id);
      inseridos++;
    }

    // FASE 10: Reativar
    let reativados = 0;
    for (const e of toReactivate) {
      const atualObj = atuaisMap.get(String(e.codigo));
      const dataValida = e.dataBr && /^\d{2}\/\d{2}\/\d{4}$/.test(e.dataBr);

      const sets = ["status = 'ativo'", "turma_id = ?"];
      const params = [turma_id];

      if (dataValida) {
        sets.push("data_nascimento = COALESCE(data_nascimento, STR_TO_DATE(?, '%d/%m/%Y'))");
        params.push(e.dataBr);
      }
      if (e.sexo) {
        sets.push("sexo = IF(sexo IS NULL OR sexo = '', ?, sexo)");
        params.push(e.sexo);
      }
      params.push(e.codigo, escola_id);

      await pool.query(
        `UPDATE alunos SET ${sets.join(", ")} WHERE codigo = ? AND escola_id = ?`,
        params
      );

      const alunoId = atualObj?.id;
      if (alunoId && turma_id) {
        const [matr] = await pool.query(
          "SELECT id FROM matriculas WHERE aluno_id = ? AND ano_letivo = ? AND escola_id = ?",
          [alunoId, anoLetivoAtual, escola_id]
        );
        if (matr.length > 0) {
          await pool.query(
            "UPDATE matriculas SET status = 'ativo', turma_id = ? WHERE id = ?",
            [turma_id, matr[0].id]
          );
        } else {
          await pool.query(
            "INSERT INTO matriculas (escola_id, aluno_id, turma_id, ano_letivo, status) VALUES (?, ?, ?, ?, 'ativo')",
            [escola_id, alunoId, turma_id, anoLetivoAtual]
          );
        }
      }
      if (alunoId) await upsertResponsavelSemCpf(pool, e, alunoId, escola_id);
      reativados++;
    }

    const pendentesInativacao = [];
    for (const atual of atuais) {
      if (atual.status !== "ativo") continue;
      const cod = String(atual.codigo);
      const noCodigoPdf = entradaSet.has(cod);
      const noNomePdf = pdfEntries.some((e) => nomeCorrespondeAoAluno(e.estudante, atual, normName));
      if (!noCodigoPdf && !noNomePdf) {
        pendentesInativacao.push({
          id: atual.id,
          codigo: atual.codigo,
          estudante: atual.estudante,
        });
      }
    }

    console.log(
      `[importar-pdf-ieducar] localizados:${pdfEntries.length} inseridos:${inseridos} reativados:${reativados} jaExistiam:${jaExistiam} pendentes:${pendentesInativacao.length}`
    );

    return res.json({
      localizados: pdfEntries.length,
      inseridos,
      reativados,
      jaExistiam,
      codigosAtualizados: atualizadosCodigo,
      inativados: 0,
      pendentesInativacao,
      listaAlunos: pdfEntries,
    });
  } catch (err) {
    console.error("Erro ao processar /importar-pdf-ieducar:", err);
    return res.status(500).json({ message: "Erro ao processar PDF IEDUCAR.", error: err.message });
  }
});

async function upsertResponsavelSemCpf(pool, e, alunoId, escola_id) {
  if (!e.responsavel) return; // Se não tem nome do responsável, não cadastra
  const nomeResp = (e.responsavel || "").trim();
  // O campo principal do sistema é telefone_celular (não o campo legado 'telefone')
  const telefoneResp = (e.telefone || "").replace(/\D/g, "").substring(0, 20) || null;
  try {
    // Busca responsável existente pelo nome E pelo telefone_celular
    const [[existente]] = await pool.query(
      `SELECT id FROM responsaveis
       WHERE nome = ?
         AND (telefone_celular = ? OR (telefone_celular IS NULL AND ? IS NULL))
       LIMIT 1`,
      [nomeResp, telefoneResp, telefoneResp]
    );

    let responsavelId = null;
    if (existente) {
       responsavelId = existente.id;
    } else {
       const [respResult] = await pool.query(
         `INSERT INTO responsaveis (nome, telefone_celular)
          VALUES (?, ?)
          ON DUPLICATE KEY UPDATE
            id = LAST_INSERT_ID(id),
            telefone_celular = IF(telefone_celular IS NULL OR telefone_celular = '', VALUES(telefone_celular), telefone_celular)`,
         [nomeResp, telefoneResp]
       );
       responsavelId = respResult.insertId;
    }

    if (responsavelId && alunoId) {
      const [[vinculo]] = await pool.query(
        "SELECT id FROM responsaveis_alunos WHERE responsavel_id = ? AND aluno_id = ? AND escola_id = ?",
        [responsavelId, alunoId, escola_id]
      );
      if (!vinculo) {
        await pool.query(
          "INSERT INTO responsaveis_alunos (escola_id, responsavel_id, aluno_id, relacionamento, ativo) VALUES (?, ?, ?, 'RESPONSAVEL', 1)",
          [escola_id, responsavelId, alunoId]
        );
      }
    }
  } catch (err) {
    console.warn(`[importar-pdf-ieducar] Falha ao vincular responsável do aluno ${e.codigo}:`, err.message);
  }
}


export default router;





