// routes/administrativo.js
// ============================================================================
// MÓDULO ADMINISTRATIVO — Persistência Real no MySQL (Multi-Tenant por escola_id)
// - administrativo_config_unidade : Cabeçalho da Folha SEEDF, Brasão, Horários,
//                                   Quadros de Assinatura, Lotação Padrão e Mensagens
// - administrativo_servidores     : Servidores Internos/Terceirizados/Voluntários (custom)
//                                   e Ficha Funcional SIGEP / Overrides de Professores/Equipe
// - administrativo_ocorrencias    : Lançamentos de Abonos, Atestados, Licenças,
//                                   Afastamentos, Faltas, Negociações e Lotes
// - administrativo_ponto_diario   : Registros diários de ponto / frequência
// ============================================================================

import express from "express";
import pool from "../db.js";

const router = express.Router();

const MOCK_STAFF_IDS = new Set([
  "adm-terc-1",
  "adm-terc-2",
  "adm-terc-3",
  "adm-serv-4",
]);

const MOCK_OCC_IDS = new Set([
  "occ-seed-1",
  "occ-seed-2",
  "occ-seed-3",
  "occ-seed-4",
]);

let tablesEnsured = false;

export async function ensureAdministrativoTables(dbConn = pool) {
  if (tablesEnsured) return;
  try {
    await dbConn.query(`
      CREATE TABLE IF NOT EXISTS administrativo_config_unidade (
        escola_id      INT NOT NULL,
        config_json    LONGTEXT NOT NULL,
        atualizado_por VARCHAR(200) DEFAULT NULL,
        atualizado_em  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (escola_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        COMMENT='Configurações de Cabeçalho SEEDF, Brasão, Horários e Assinaturas da Folha de Ponto por escola'
    `);

    await dbConn.query(`
      CREATE TABLE IF NOT EXISTS administrativo_servidores (
        id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
        escola_id     INT NOT NULL,
        servidor_uid  VARCHAR(100) NOT NULL,
        tipo_registro ENUM('custom','override') NOT NULL DEFAULT 'custom',
        cpf           VARCHAR(20) DEFAULT NULL,
        nome          VARCHAR(255) DEFAULT NULL,
        matricula     VARCHAR(60) DEFAULT NULL,
        categoria     VARCHAR(60) DEFAULT NULL,
        vinculo       VARCHAR(60) DEFAULT NULL,
        ativo         TINYINT(1) NOT NULL DEFAULT 1,
        excluido      TINYINT(1) NOT NULL DEFAULT 0,
        dados_json    LONGTEXT NOT NULL,
        criado_em     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        atualizado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_adm_srv_escola_uid (escola_id, servidor_uid),
        INDEX idx_adm_srv_escola (escola_id),
        INDEX idx_adm_srv_cpf (escola_id, cpf)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        COMMENT='Quadro de servidores customizados (terceirizados/voluntários) e overrides da ficha SIGEP'
    `);

    await dbConn.query(`
      CREATE TABLE IF NOT EXISTS administrativo_ocorrencias (
        id                 INT UNSIGNED NOT NULL AUTO_INCREMENT,
        escola_id          INT NOT NULL,
        ocorrencia_uid     VARCHAR(100) NOT NULL,
        lote_id            VARCHAR(100) DEFAULT NULL,
        servidor_id        VARCHAR(100) NOT NULL,
        servidor_nome      VARCHAR(255) DEFAULT NULL,
        servidor_cargo     VARCHAR(255) DEFAULT NULL,
        servidor_categoria VARCHAR(60) DEFAULT NULL,
        tipo               VARCHAR(50) NOT NULL,
        subtipo            VARCHAR(255) NOT NULL,
        status             VARCHAR(50) NOT NULL DEFAULT 'aprovado',
        data_inicio        DATE NOT NULL,
        data_fim           DATE NOT NULL,
        dias               INT NOT NULL DEFAULT 1,
        dados_json         LONGTEXT NOT NULL,
        criado_por         VARCHAR(200) DEFAULT NULL,
        criado_em          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        atualizado_em      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_adm_occ_escola_uid (escola_id, ocorrencia_uid),
        INDEX idx_adm_occ_escola_data (escola_id, data_inicio),
        INDEX idx_adm_occ_escola_srv (escola_id, servidor_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        COMMENT='Lançamentos de abonos, atestados, licenças, afastamentos, faltas e acordos de servidores'
    `);

    await dbConn.query(`
      CREATE TABLE IF NOT EXISTS administrativo_ponto_diario (
        id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
        escola_id     INT NOT NULL,
        data_iso      DATE NOT NULL,
        servidor_id   VARCHAR(100) NOT NULL,
        dados_json    TEXT NOT NULL,
        atualizado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_adm_ponto_escola_data_srv (escola_id, data_iso, servidor_id),
        INDEX idx_adm_ponto_escola_data (escola_id, data_iso)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        COMMENT='Registros de frequência e ponto diário de servidores'
    `);

    tablesEnsured = true;
  } catch (err) {
    console.error("[ADMINISTRATIVO][ENSURE_TABLES] Erro:", err?.message || err);
  }
}

function getEscolaId(req) {
  return Number(
    req.escola_id ||
      req.user?.escola_id ||
      req.headers?.["x-escola-id"] ||
      req.query?.escola_id ||
      req.body?.escola_id ||
      0
  );
}

function safeJsonParse(raw, fallback = null) {
  if (!raw) return fallback;
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function limparCPF(v) {
  return String(v || "").replace(/\D/g, "").slice(0, 14);
}

function normalizarDataIso(val) {
  const s = String(val || "").trim().slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return new Date().toISOString().slice(0, 10);
}

// ── GET /api/administrativo/bootstrap ────────────────────────────────────────
// Carrega em uma única requisição todos os dados persistidos da escola no MySQL
router.get("/bootstrap", async (req, res) => {
  const db = req.db || pool;
  const escolaId = getEscolaId(req);
  if (!escolaId) {
    return res.status(400).json({ ok: false, message: "escola_id é obrigatório." });
  }

  try {
    await ensureAdministrativoTables(db);

    const [
      [cfgRows],
      [srvRows],
      [occRows],
      [pontoRows],
    ] = await Promise.all([
      db.query(
        "SELECT config_json, atualizado_em FROM administrativo_config_unidade WHERE escola_id = ? LIMIT 1",
        [escolaId]
      ),
      db.query(
        "SELECT servidor_uid, tipo_registro, ativo, excluido, dados_json FROM administrativo_servidores WHERE escola_id = ? ORDER BY id ASC",
        [escolaId]
      ),
      db.query(
        "SELECT ocorrencia_uid, dados_json FROM administrativo_ocorrencias WHERE escola_id = ? ORDER BY data_inicio DESC, id DESC",
        [escolaId]
      ),
      db.query(
        "SELECT DATE_FORMAT(data_iso, '%Y-%m-%d') AS data_iso, servidor_id, dados_json FROM administrativo_ponto_diario WHERE escola_id = ?",
        [escolaId]
      ),
    ]);

    const configUnidade =
      cfgRows.length > 0 ? safeJsonParse(cfgRows[0].config_json, null) : null;

    const customStaff = [];
    const overrides = {};

    for (const row of srvRows) {
      const uid = String(row.servidor_uid || "");
      if (!uid || MOCK_STAFF_IDS.has(uid)) continue;
      const parsed = safeJsonParse(row.dados_json, {});
      if (!parsed || typeof parsed !== "object") continue;

      if (row.tipo_registro === "override" || uid.startsWith("sys-") || uid.startsWith("cpf:")) {
        overrides[uid] = {
          ...parsed,
          id: uid,
          ...(Number(row.excluido) === 1 ? { _deleted: true } : {}),
        };
      } else if (Number(row.excluido) !== 1 && !parsed._deleted) {
        customStaff.push({
          ...parsed,
          id: uid,
          ativo:
            parsed.ativo !== undefined
              ? Boolean(parsed.ativo)
              : Number(row.ativo) === 1,
        });
      }
    }

    const ocorrencias = [];
    for (const row of occRows) {
      const uid = String(row.ocorrencia_uid || "");
      if (!uid || MOCK_OCC_IDS.has(uid)) continue;
      const parsed = safeJsonParse(row.dados_json, null);
      if (parsed && typeof parsed === "object") {
        ocorrencias.push({
          ...parsed,
          id: uid,
        });
      }
    }

    const pontoDiario = {};
    for (const row of pontoRows) {
      const dt = String(row.data_iso || "").slice(0, 10);
      const srvId = String(row.servidor_id || "");
      if (!dt || !srvId) continue;
      const parsed = safeJsonParse(row.dados_json, null);
      if (parsed && typeof parsed === "object") {
        if (!pontoDiario[dt]) pontoDiario[dt] = {};
        pontoDiario[dt][srvId] = parsed;
      }
    }

    return res.json({
      ok: true,
      escola_id: escolaId,
      configUnidade,
      customStaff,
      overrides,
      ocorrencias,
      pontoDiario,
    });
  } catch (err) {
    console.error("[ADMINISTRATIVO][BOOTSTRAP]", err);
    return res.status(500).json({
      ok: false,
      message: "Erro ao carregar dados do módulo administrativo.",
    });
  }
});

// ── PUT /api/administrativo/config-unidade ───────────────────────────────────
// Salva a configuração de cabeçalho, brasão, horários e assinaturas da unidade
router.put("/config-unidade", async (req, res) => {
  const db = req.db || pool;
  const escolaId = getEscolaId(req);
  if (!escolaId) {
    return res.status(400).json({ ok: false, message: "escola_id é obrigatório." });
  }

  const config = req.body?.config || req.body;
  if (!config || typeof config !== "object") {
    return res.status(400).json({ ok: false, message: "Objeto de configuração inválido." });
  }

  const usuarioNome =
    req.user?.nome || req.body?.atualizado_por || "Gestão Escolar";

  try {
    await ensureAdministrativoTables(db);

    const payloadJson = JSON.stringify(config);
    await db.query(
      `INSERT INTO administrativo_config_unidade (escola_id, config_json, atualizado_por)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE
         config_json = VALUES(config_json),
         atualizado_por = VALUES(atualizado_por),
         atualizado_em = CURRENT_TIMESTAMP`,
      [escolaId, payloadJson, String(usuarioNome).slice(0, 200)]
    );

    return res.json({
      ok: true,
      message: "Configurações da unidade escolar salvas com sucesso.",
    });
  } catch (err) {
    console.error("[ADMINISTRATIVO][CONFIG_UNIDADE]", err);
    return res.status(500).json({
      ok: false,
      message: "Erro ao salvar configurações da unidade escolar.",
    });
  }
});

// ── POST /api/administrativo/servidores ──────────────────────────────────────
// Cria ou atualiza um servidor customizado (terceirizado/voluntário) ou override SIGEP
router.post("/servidores", async (req, res) => {
  const db = req.db || pool;
  const escolaId = getEscolaId(req);
  if (!escolaId) {
    return res.status(400).json({ ok: false, message: "escola_id é obrigatório." });
  }

  const dados = req.body?.servidor || req.body;
  if (!dados || typeof dados !== "object") {
    return res.status(400).json({ ok: false, message: "Dados do servidor inválidos." });
  }

  const uid = String(dados.id || `adm-serv-${Date.now()}`).trim();
  const isOverride =
    req.body?.tipo_registro === "override" ||
    uid.startsWith("sys-") ||
    uid.startsWith("cpf:");
  const tipoRegistro = isOverride ? "override" : "custom";

  const cpfLimpo = limparCPF(dados.cpf);
  const nome = dados.nome ? String(dados.nome).trim().slice(0, 255) : null;
  const matricula = dados.matricula ? String(dados.matricula).trim().slice(0, 60) : null;
  const categoria = dados.categoria ? String(dados.categoria).trim().slice(0, 60) : null;
  const vinculo = dados.vinculo ? String(dados.vinculo).trim().slice(0, 60) : null;
  const ativo = dados.ativo === false ? 0 : 1;
  const excluido = dados._deleted ? 1 : 0;

  const objetoFinal = {
    ...dados,
    id: uid,
    ...(cpfLimpo ? { cpf: cpfLimpo } : {}),
    atualizado_em: new Date().toISOString(),
  };

  try {
    await ensureAdministrativoTables(db);

    await db.query(
      `INSERT INTO administrativo_servidores
        (escola_id, servidor_uid, tipo_registro, cpf, nome, matricula, categoria, vinculo, ativo, excluido, dados_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         tipo_registro = VALUES(tipo_registro),
         cpf = COALESCE(VALUES(cpf), cpf),
         nome = COALESCE(VALUES(nome), nome),
         matricula = COALESCE(VALUES(matricula), matricula),
         categoria = COALESCE(VALUES(categoria), categoria),
         vinculo = COALESCE(VALUES(vinculo), vinculo),
         ativo = VALUES(ativo),
         excluido = VALUES(excluido),
         dados_json = VALUES(dados_json),
         atualizado_em = CURRENT_TIMESTAMP`,
      [
        escolaId,
        uid,
        tipoRegistro,
        cpfLimpo || null,
        nome,
        matricula,
        categoria,
        vinculo,
        ativo,
        excluido,
        JSON.stringify(objetoFinal),
      ]
    );

    return res.json({
      ok: true,
      servidor_uid: uid,
      tipo_registro: tipoRegistro,
      servidor: objetoFinal,
    });
  } catch (err) {
    console.error("[ADMINISTRATIVO][SALVAR_SERVIDOR]", err);
    return res.status(500).json({
      ok: false,
      message: "Erro ao salvar servidor no banco de dados.",
    });
  }
});

// ── DELETE /api/administrativo/servidores/:uid ───────────────────────────────
// Remove servidor customizado ou marca servidor sincronizado como oculto (_deleted)
router.delete("/servidores/:uid", async (req, res) => {
  const db = req.db || pool;
  const escolaId = getEscolaId(req);
  const uid = String(req.params.uid || "").trim();

  if (!escolaId || !uid) {
    return res.status(400).json({ ok: false, message: "Parâmetros inválidos." });
  }

  try {
    await ensureAdministrativoTables(db);

    if (uid.startsWith("sys-") || uid.startsWith("cpf:")) {
      const [rows] = await db.query(
        "SELECT dados_json FROM administrativo_servidores WHERE escola_id = ? AND servidor_uid = ? LIMIT 1",
        [escolaId, uid]
      );
      const atual = rows.length ? safeJsonParse(rows[0].dados_json, {}) : {};
      const novoJson = JSON.stringify({
        ...atual,
        id: uid,
        _deleted: true,
        atualizado_em: new Date().toISOString(),
      });

      await db.query(
        `INSERT INTO administrativo_servidores
          (escola_id, servidor_uid, tipo_registro, ativo, excluido, dados_json)
         VALUES (?, ?, 'override', 0, 1, ?)
         ON DUPLICATE KEY UPDATE
           excluido = 1,
           ativo = 0,
           dados_json = VALUES(dados_json),
           atualizado_em = CURRENT_TIMESTAMP`,
        [escolaId, uid, novoJson]
      );
    } else {
      await db.query(
        "DELETE FROM administrativo_servidores WHERE escola_id = ? AND servidor_uid = ?",
        [escolaId, uid]
      );
    }

    return res.json({ ok: true, servidor_uid: uid });
  } catch (err) {
    console.error("[ADMINISTRATIVO][EXCLUIR_SERVIDOR]", err);
    return res.status(500).json({
      ok: false,
      message: "Erro ao excluir servidor.",
    });
  }
});

// ── POST /api/administrativo/ocorrencias ─────────────────────────────────────
// Salva 1 ocorrência ou um lote de ocorrências (Lançamento em Lote por categoria)
router.post("/ocorrencias", async (req, res) => {
  const db = req.db || pool;
  const escolaId = getEscolaId(req);
  if (!escolaId) {
    return res.status(400).json({ ok: false, message: "escola_id é obrigatório." });
  }

  const listaEntrada = Array.isArray(req.body?.ocorrencias)
    ? req.body.ocorrencias
    : req.body?.ocorrencia
    ? [req.body.ocorrencia]
    : [req.body];

  const itensValidos = listaEntrada.filter(
    (item) => item && typeof item === "object" && item.servidor_id
  );

  if (itensValidos.length === 0) {
    return res.status(400).json({
      ok: false,
      message: "Nenhuma ocorrência válida informada.",
    });
  }

  try {
    await ensureAdministrativoTables(db);

    const salvos = [];
    for (let i = 0; i < itensValidos.length; i++) {
      const item = itensValidos[i];
      const uid = String(
        item.id ||
          `occ-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 6)}`
      ).trim();
      const loteId = item.lote_id ? String(item.lote_id).trim().slice(0, 100) : null;
      const servidorId = String(item.servidor_id).trim().slice(0, 100);
      const servidorNome = item.servidor_nome
        ? String(item.servidor_nome).trim().slice(0, 255)
        : null;
      const servidorCargo = item.servidor_cargo
        ? String(item.servidor_cargo).trim().slice(0, 255)
        : null;
      const servidorCategoria = item.servidor_categoria
        ? String(item.servidor_categoria).trim().slice(0, 60)
        : null;
      const tipo = String(item.tipo || "abono").trim().slice(0, 50);
      const subtipo = String(item.subtipo || "Abono").trim().slice(0, 255);
      const status = String(item.status || "aprovado").trim().slice(0, 50);
      const dataInicio = normalizarDataIso(item.data_inicio);
      const dataFim = normalizarDataIso(item.data_fim || dataInicio);
      const dias = Math.max(1, Number(item.dias) || 1);
      const criadoPor = item.autorizado_por
        ? String(item.autorizado_por).trim().slice(0, 200)
        : req.user?.nome || null;

      const objetoFinal = {
        ...item,
        id: uid,
        servidor_id: servidorId,
        tipo,
        subtipo,
        status,
        data_inicio: dataInicio,
        data_fim: dataFim,
        dias,
        criado_em: item.criado_em || new Date().toISOString().slice(0, 10),
        atualizado_em: new Date().toISOString(),
      };

      await db.query(
        `INSERT INTO administrativo_ocorrencias
          (escola_id, ocorrencia_uid, lote_id, servidor_id, servidor_nome, servidor_cargo, servidor_categoria, tipo, subtipo, status, data_inicio, data_fim, dias, dados_json, criado_por)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           lote_id = VALUES(lote_id),
           servidor_id = VALUES(servidor_id),
           servidor_nome = VALUES(servidor_nome),
           servidor_cargo = VALUES(servidor_cargo),
           servidor_categoria = VALUES(servidor_categoria),
           tipo = VALUES(tipo),
           subtipo = VALUES(subtipo),
           status = VALUES(status),
           data_inicio = VALUES(data_inicio),
           data_fim = VALUES(data_fim),
           dias = VALUES(dias),
           dados_json = VALUES(dados_json),
           criado_por = COALESCE(VALUES(criado_por), criado_por),
           atualizado_em = CURRENT_TIMESTAMP`,
        [
          escolaId,
          uid,
          loteId,
          servidorId,
          servidorNome,
          servidorCargo,
          servidorCategoria,
          tipo,
          subtipo,
          status,
          dataInicio,
          dataFim,
          dias,
          JSON.stringify(objetoFinal),
          criadoPor,
        ]
      );

      salvos.push(objetoFinal);
    }

    return res.json({
      ok: true,
      quantidade: salvos.length,
      ocorrencias: salvos,
    });
  } catch (err) {
    console.error("[ADMINISTRATIVO][SALVAR_OCORRENCIA]", err);
    return res.status(500).json({
      ok: false,
      message: "Erro ao salvar ocorrência administrativa.",
    });
  }
});

// ── PATCH /api/administrativo/ocorrencias/:uid/status ────────────────────────
router.patch("/ocorrencias/:uid/status", async (req, res) => {
  const db = req.db || pool;
  const escolaId = getEscolaId(req);
  const uid = String(req.params.uid || "").trim();
  const novoStatus = String(req.body?.status || "").trim();

  if (!escolaId || !uid || !novoStatus) {
    return res.status(400).json({ ok: false, message: "Parâmetros inválidos." });
  }

  try {
    await ensureAdministrativoTables(db);

    const [rows] = await db.query(
      "SELECT dados_json FROM administrativo_ocorrencias WHERE escola_id = ? AND ocorrencia_uid = ? LIMIT 1",
      [escolaId, uid]
    );

    if (!rows.length) {
      return res.status(404).json({ ok: false, message: "Ocorrência não encontrada." });
    }

    const atual = safeJsonParse(rows[0].dados_json, {});
    const atualizado = {
      ...atual,
      id: uid,
      status: novoStatus,
      atualizado_em: new Date().toISOString(),
    };

    await db.query(
      "UPDATE administrativo_ocorrencias SET status = ?, dados_json = ?, atualizado_em = CURRENT_TIMESTAMP WHERE escola_id = ? AND ocorrencia_uid = ?",
      [novoStatus, JSON.stringify(atualizado), escolaId, uid]
    );

    return res.json({ ok: true, ocorrencia_uid: uid, status: novoStatus });
  } catch (err) {
    console.error("[ADMINISTRATIVO][STATUS_OCORRENCIA]", err);
    return res.status(500).json({
      ok: false,
      message: "Erro ao atualizar status da ocorrência.",
    });
  }
});

// ── DELETE /api/administrativo/ocorrencias/:uid ──────────────────────────────
router.delete("/ocorrencias/:uid", async (req, res) => {
  const db = req.db || pool;
  const escolaId = getEscolaId(req);
  const uid = String(req.params.uid || "").trim();

  if (!escolaId || !uid) {
    return res.status(400).json({ ok: false, message: "Parâmetros inválidos." });
  }

  try {
    await ensureAdministrativoTables(db);
    await db.query(
      "DELETE FROM administrativo_ocorrencias WHERE escola_id = ? AND ocorrencia_uid = ?",
      [escolaId, uid]
    );
    return res.json({ ok: true, ocorrencia_uid: uid });
  } catch (err) {
    console.error("[ADMINISTRATIVO][EXCLUIR_OCORRENCIA]", err);
    return res.status(500).json({
      ok: false,
      message: "Erro ao excluir ocorrência.",
    });
  }
});

// ── POST /api/administrativo/ponto ───────────────────────────────────────────
// Salva 1 ou vários registros de ponto diário
router.post("/ponto", async (req, res) => {
  const db = req.db || pool;
  const escolaId = getEscolaId(req);
  if (!escolaId) {
    return res.status(400).json({ ok: false, message: "escola_id é obrigatório." });
  }

  const entries = Array.isArray(req.body?.entries)
    ? req.body.entries
    : req.body?.data_iso && req.body?.servidor_id
    ? [req.body]
    : [];

  if (entries.length === 0) {
    return res.status(400).json({ ok: false, message: "Nenhum registro de ponto informado." });
  }

  try {
    await ensureAdministrativoTables(db);

    for (const entry of entries) {
      const dt = normalizarDataIso(entry.data_iso);
      const srvId = String(entry.servidor_id || "").trim().slice(0, 100);
      if (!dt || !srvId) continue;
      const dados = entry.dados || {};

      await db.query(
        `INSERT INTO administrativo_ponto_diario (escola_id, data_iso, servidor_id, dados_json)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           dados_json = VALUES(dados_json),
           atualizado_em = CURRENT_TIMESTAMP`,
        [escolaId, dt, srvId, JSON.stringify(dados)]
      );
    }

    return res.json({ ok: true, quantidade: entries.length });
  } catch (err) {
    console.error("[ADMINISTRATIVO][SALVAR_PONTO]", err);
    return res.status(500).json({
      ok: false,
      message: "Erro ao salvar registro de ponto.",
    });
  }
});

// ── POST /api/administrativo/sync-local ──────────────────────────────────────
// Migração automática transparente: sincroniza dados reais já salvos no navegador
// da escola (ignorando os mocks antigos) para o banco MySQL sem sobrescrever o que
// já estiver salvo no banco.
router.post("/sync-local", async (req, res) => {
  const db = req.db || pool;
  const escolaId = getEscolaId(req);
  if (!escolaId) {
    return res.status(400).json({ ok: false, message: "escola_id é obrigatório." });
  }

  const {
    configUnidade,
    customStaff = [],
    overrides = {},
    ocorrencias = [],
  } = req.body || {};

  try {
    await ensureAdministrativoTables(db);

    // 1. Config da Unidade (só insere se ainda não houver no banco)
    if (configUnidade && typeof configUnidade === "object") {
      await db.query(
        `INSERT IGNORE INTO administrativo_config_unidade (escola_id, config_json, atualizado_por)
         VALUES (?, ?, ?)`,
        [
          escolaId,
          JSON.stringify(configUnidade),
          req.user?.nome || "Sincronização Automática",
        ]
      );
    }

    // 2. Custom Staff (ignora mocks adm-terc-1..adm-serv-4)
    if (Array.isArray(customStaff)) {
      for (const srv of customStaff) {
        if (!srv || !srv.id || MOCK_STAFF_IDS.has(String(srv.id))) continue;
        const uid = String(srv.id).trim();
        await db.query(
          `INSERT IGNORE INTO administrativo_servidores
            (escola_id, servidor_uid, tipo_registro, cpf, nome, matricula, categoria, vinculo, ativo, excluido, dados_json)
           VALUES (?, ?, 'custom', ?, ?, ?, ?, ?, ?, 0, ?)`,
          [
            escolaId,
            uid,
            limparCPF(srv.cpf) || null,
            srv.nome ? String(srv.nome).slice(0, 255) : null,
            srv.matricula ? String(srv.matricula).slice(0, 60) : null,
            srv.categoria ? String(srv.categoria).slice(0, 60) : null,
            srv.vinculo ? String(srv.vinculo).slice(0, 60) : null,
            srv.ativo === false ? 0 : 1,
            JSON.stringify(srv),
          ]
        );
      }
    }

    // 3. Overrides de servidores do sistema
    if (overrides && typeof overrides === "object") {
      for (const [uid, ov] of Object.entries(overrides)) {
        if (!uid || !ov || typeof ov !== "object") continue;
        await db.query(
          `INSERT IGNORE INTO administrativo_servidores
            (escola_id, servidor_uid, tipo_registro, cpf, nome, matricula, categoria, vinculo, ativo, excluido, dados_json)
           VALUES (?, ?, 'override', ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            escolaId,
            String(uid).trim(),
            limparCPF(ov.cpf) || null,
            ov.nome ? String(ov.nome).slice(0, 255) : null,
            ov.matricula ? String(ov.matricula).slice(0, 60) : null,
            ov.categoria ? String(ov.categoria).slice(0, 60) : null,
            ov.vinculo ? String(ov.vinculo).slice(0, 60) : null,
            ov.ativo === false ? 0 : 1,
            ov._deleted ? 1 : 0,
            JSON.stringify({ ...ov, id: uid }),
          ]
        );
      }
    }

    // 4. Ocorrências (ignora mocks occ-seed-1..occ-seed-4)
    if (Array.isArray(ocorrencias)) {
      for (const occ of ocorrencias) {
        if (!occ || !occ.id || !occ.servidor_id || MOCK_OCC_IDS.has(String(occ.id))) {
          continue;
        }
        const uid = String(occ.id).trim();
        const dtIni = normalizarDataIso(occ.data_inicio);
        const dtFim = normalizarDataIso(occ.data_fim || dtIni);
        await db.query(
          `INSERT IGNORE INTO administrativo_ocorrencias
            (escola_id, ocorrencia_uid, lote_id, servidor_id, servidor_nome, servidor_cargo, servidor_categoria, tipo, subtipo, status, data_inicio, data_fim, dias, dados_json, criado_por)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            escolaId,
            uid,
            occ.lote_id ? String(occ.lote_id).slice(0, 100) : null,
            String(occ.servidor_id).slice(0, 100),
            occ.servidor_nome ? String(occ.servidor_nome).slice(0, 255) : null,
            occ.servidor_cargo ? String(occ.servidor_cargo).slice(0, 255) : null,
            occ.servidor_categoria ? String(occ.servidor_categoria).slice(0, 60) : null,
            String(occ.tipo || "abono").slice(0, 50),
            String(occ.subtipo || "Abono").slice(0, 255),
            String(occ.status || "aprovado").slice(0, 50),
            dtIni,
            dtFim,
            Math.max(1, Number(occ.dias) || 1),
            JSON.stringify(occ),
            occ.autorizado_por ? String(occ.autorizado_por).slice(0, 200) : null,
          ]
        );
      }
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error("[ADMINISTRATIVO][SYNC_LOCAL]", err);
    return res.status(500).json({ ok: false, message: "Erro ao sincronizar dados locais." });
  }
});

export default router;
