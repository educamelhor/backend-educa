// routes/plataforma_modulos.js
// Sistema de Licenciamento de Módulos por Escola — EDUCA.MELHOR
import express from 'express';

const router = express.Router();

// ── Auto-migrate: garante que a tabela escola_modulos existe ──────────────────
// Executado uma única vez quando o módulo é importado pelo server.js.
// Seguro: usa IF NOT EXISTS, não altera dados existentes.
// ─────────────────────────────────────────────────────────────────────────────
let _tableMigrated = false;
router.use(async (req, _res, next) => {
  if (_tableMigrated) return next();
  try {
    await req.db.query(`
      CREATE TABLE IF NOT EXISTS escola_modulos (
        id         INT AUTO_INCREMENT PRIMARY KEY,
        escola_id  INT NOT NULL,
        modulo     VARCHAR(100) NOT NULL,
        ativo      TINYINT(1) NOT NULL DEFAULT 0,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uk_escola_modulo (escola_id, modulo),
        INDEX      idx_em_escola (escola_id)
      )
    `);
    _tableMigrated = true;
    console.log('[plataforma_modulos] Tabela escola_modulos verificada/criada ✅');
  } catch (e) {
    _tableMigrated = true;
    if (!String(e.message || '').includes('already exists')) {
      console.warn('[plataforma_modulos] Auto-migrate aviso:', e.message);
    }
  }
  next();
});

const MODULOS_VALIDOS = new Set([
  // Secretaria
  'secretaria', 'secretaria.alunos', 'secretaria.responsaveis',
  'secretaria.cargas_horarias', 'secretaria.disciplinas', 'secretaria.turmas',
  'secretaria.professores', 'secretaria.boletim', 'secretaria.relatorios',
  'secretaria.horarios', 'secretaria.agente', 'secretaria.tabela_codigos',
  'secretaria.sincronizar_seedf', 'secretaria.modulacao',
  // Disciplinar
  'disciplinar', 'disciplinar.alunos', 'disciplinar.historico',
  'disciplinar.atas', 'disciplinar.fo_coletivo', 'disciplinar.responsaveis',
  'disciplinar.liberacao', 'disciplinar.metadados', 'disciplinar.equipe',
  'disciplinar.regimentos', 'disciplinar.manual', 'disciplinar.suporte',
  'disciplinar.aph_cbmdf',

  // Pedagógico
  'pedagogico', 'pedagogico.conselho', 'pedagogico.conteudos',
  'pedagogico.relatorios', 'pedagogico.correcoes',
  'pedagogico.solicitacoes', 'pedagogico.provas',
  // Gabarito
  'gabarito', 'gabarito.gerar', 'gabarito.corrigir_lote',
  'gabarito.corrigir', 'gabarito.resultados',
  // Frequência
  'frequencia', 'frequencia.atestados', 'frequencia.relatorios',
  'frequencia.busca_ativa', 'frequencia.conselho_tutelar',
  // Biblioteca
  'biblioteca', 'biblioteca.acervo', 'biblioteca.emprestimos',
  'biblioteca.alunos', 'biblioteca.leitor_destaque',
  'biblioteca.concurso', 'biblioteca.metadados',
  // Professores
  'professores', 'professores.planos', 'professores.avaliacoes',
  'professores.conteudos', 'professores.provas', 'professores.boletim',
  'professores.conselho',
  // Monitoramento
  'monitoramento', 'monitoramento.painel', 'monitoramento.alertas',
  'monitoramento.visitantes_registrar', 'monitoramento.visitantes_historico',
  'monitoramento.embeddings',
  // Questões
  'questoes',
  // Agente EDUCA
  'agente_educa', 'agente_educa.credenciais', 'agente_educa.planos', 'agente_educa.notas',
  // Impressão
  'impressao', 'impressao.gabaritos', 'impressao.boletins',
  'impressao.listas', 'impressao.documentos',
  // Ferramentas
  'ferramentas',
  // Direção
  'direcao', 'direcao.educa_capture', 'direcao.responsaveis',
  'direcao.cadastro', 'direcao.governanca',
  // Estudantes
  'estudantes',
  // Merenda
  'merenda', 'merenda.cadastro', 'merenda.cardapio', 'merenda.relatorios',
]);

/**
 * GET /api/plataforma/modulos/:escolaId
 * Retorna todos os módulos de uma escola com status ativo.
 * Se não houver registros, retorna todos com ativo=false.
 */
router.get('/:escolaId', async (req, res) => {
  const db = req.db;
  const escolaId = Number(req.params.escolaId);

  if (!escolaId || isNaN(escolaId)) {
    return res.status(400).json({ ok: false, message: 'escolaId inválido.' });
  }

  try {
    const [rows] = await db.query(
      'SELECT modulo, ativo FROM escola_modulos WHERE escola_id = ?',
      [escolaId]
    );

    let modulos;
    if (!rows || rows.length === 0) {
      // Sem registros: retorna todos com ativo=false
      modulos = Array.from(MODULOS_VALIDOS).map(modulo => ({ modulo, ativo: false }));
    } else {
      // Monta mapa dos existentes
      const mapa = new Map(rows.map(r => [r.modulo, Number(r.ativo) === 1]));
      // Retorna todos os módulos válidos, com status do banco ou false
      modulos = Array.from(MODULOS_VALIDOS).map(modulo => ({
        modulo,
        ativo: mapa.has(modulo) ? mapa.get(modulo) : false,
      }));
    }

    return res.json({ ok: true, escola_id: escolaId, modulos });
  } catch (err) {
    console.error('[plataforma_modulos] GET erro:', err.message);
    return res.status(500).json({ ok: false, message: 'Erro ao buscar módulos da escola.' });
  }
});

/**
 * PUT /api/plataforma/modulos/:escolaId
 * body: { modulos: [{ modulo: 'gabarito.gerar', ativo: true }, ...] }
 * Faz upsert de cada módulo. Valida contra MODULOS_VALIDOS.
 */
router.put('/:escolaId', async (req, res) => {
  const db = req.db;
  const escolaId = Number(req.params.escolaId);

  if (!escolaId || isNaN(escolaId)) {
    return res.status(400).json({ ok: false, message: 'escolaId inválido.' });
  }

  const { modulos } = req.body;
  if (!Array.isArray(modulos) || modulos.length === 0) {
    return res.status(400).json({ ok: false, message: 'Campo modulos deve ser um array não vazio.' });
  }

  // Valida módulos
  const invalidos = modulos.filter(m => !MODULOS_VALIDOS.has(m?.modulo));
  if (invalidos.length > 0) {
    return res.status(400).json({
      ok: false,
      message: `Módulos inválidos: ${invalidos.map(m => m?.modulo).join(', ')}`,
    });
  }

  try {
    let total_ativados = 0;
    let total_desativados = 0;

    for (const { modulo, ativo } of modulos) {
      const ativoVal = ativo ? 1 : 0;
      await req.db.query(
        `INSERT INTO escola_modulos (escola_id, modulo, ativo)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE ativo = ?`,
        [escolaId, modulo, ativoVal, ativoVal]
      );
      if (ativoVal) total_ativados++;
      else total_desativados++;
    }

    return res.json({ ok: true, total_ativados, total_desativados });
  } catch (err) {
    console.error('[plataforma_modulos] PUT erro:', err.message);
    return res.status(500).json({ ok: false, message: 'Erro ao salvar módulos da escola.' });
  }
});

/**
 * POST /api/plataforma/modulos/:escolaId/copiar-de/:origemId
 * Copia todas as configurações de módulos da escola origemId para escolaId.
 */
router.post('/:escolaId/copiar-de/:origemId', async (req, res) => {
  const db = req.db;
  const escolaId = Number(req.params.escolaId);
  const origemId = Number(req.params.origemId);

  if (!escolaId || isNaN(escolaId) || !origemId || isNaN(origemId)) {
    return res.status(400).json({ ok: false, message: 'escolaId ou origemId inválido.' });
  }

  if (escolaId === origemId) {
    return res.status(400).json({ ok: false, message: 'escola destino e origem não podem ser iguais.' });
  }

  try {
    // Busca módulos da origem
    const [origemRows] = await db.query(
      'SELECT modulo, ativo FROM escola_modulos WHERE escola_id = ?',
      [origemId]
    );

    // Remove registros existentes do destino
    await db.query('DELETE FROM escola_modulos WHERE escola_id = ?', [escolaId]);

    // Copia registros da origem para o destino
    let total_copiados = 0;
    for (const { modulo, ativo } of origemRows) {
      await db.query(
        'INSERT INTO escola_modulos (escola_id, modulo, ativo) VALUES (?, ?, ?)',
        [escolaId, modulo, ativo]
      );
      total_copiados++;
    }

    return res.json({ ok: true, total_copiados });
  } catch (err) {
    console.error('[plataforma_modulos] POST copiar-de erro:', err.message);
    return res.status(500).json({ ok: false, message: 'Erro ao copiar módulos.' });
  }
});

export default router;

// ══════════════════════════════════════════════════════════════════════════════
// MÓDULOS POR PERFIL — CEO define o teto de módulos para cada perfil por escola
// Hierarquia: CEO (teto) → Diretor (pode manter ou restringir)
// ══════════════════════════════════════════════════════════════════════════════

// ── Auto-migrate: garante que a tabela escola_perfil_modulos existe ──────────
let _perfilTableMigrated = false;
router.use(async (req, _res, next) => {
  if (_perfilTableMigrated) return next();
  try {
    await req.db.query(`
      CREATE TABLE IF NOT EXISTS escola_perfil_modulos (
        id         INT AUTO_INCREMENT PRIMARY KEY,
        escola_id  INT NOT NULL,
        perfil     VARCHAR(60) NOT NULL,
        modulo     VARCHAR(100) NOT NULL,
        ativo      TINYINT(1) NOT NULL DEFAULT 0,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uk_epm (escola_id, perfil, modulo),
        INDEX      idx_epm_escola_perfil (escola_id, perfil)
      )
    `);
    _perfilTableMigrated = true;
    console.log('[plataforma_modulos] Tabela escola_perfil_modulos verificada/criada ✅');
  } catch (e) {
    _perfilTableMigrated = true;
    if (!String(e.message || '').includes('already exists')) {
      console.warn('[plataforma_modulos] Auto-migrate perfil aviso:', e.message);
    }
  }
  next();
});

// Perfis gerenciáveis pelo CEO (militares fixos não entram aqui)
// 'diretor' incluído: necessário para configurar escolas CCMDF (ex: CELAN).
// No backend resolveModulosAtivos, o Diretor recebe a UNIÃO de todos os perfis,
// mas também pode ter configuração direta via este endpoint.
const PERFIS_GERENCIAVEIS = new Set([
  'diretor',                                              // ← adicionado (essencial CCMDF)
  'professor', 'coordenador', 'supervisor', 'pedagogo',
  'secretario', 'secretaria', 'orientador',
  'aluno', 'biblioteca', 'educador_social', 'merenda',
  'psicologo', 'responsavel', 'vice_diretor', 'vigilancia', 'visitante',
  'subcomandante', 'supervisor_disciplinar', 'monitor_disciplinar',
]);

/**
 * GET /api/plataforma/modulos/:escolaId/perfil/:perfil
 * Retorna módulos ativos para este perfil nesta escola (teto CEO).
 * Se não houver registros, retorna todos com ativo=false.
 */
router.get('/:escolaId/perfil/:perfil', async (req, res) => {
  const db = req.db;
  const escolaId = Number(req.params.escolaId);
  const perfil   = String(req.params.perfil || '').toLowerCase().trim();

  if (!escolaId || isNaN(escolaId)) {
    return res.status(400).json({ ok: false, message: 'escolaId inválido.' });
  }
  if (!PERFIS_GERENCIAVEIS.has(perfil)) {
    return res.status(400).json({ ok: false, message: `Perfil '${perfil}' não gerenciável pelo CEO.` });
  }

  try {
    const [rows] = await db.query(
      'SELECT modulo, ativo FROM escola_perfil_modulos WHERE escola_id = ? AND perfil = ?',
      [escolaId, perfil]
    );

    // ── DIAGNÓSTICO TEMP ── remover após resolver
    const ativosDbCount = rows ? rows.filter(r => Number(r.ativo) === 1).length : 0;
    const secretariaAtivos = rows ? rows.filter(r => r.modulo.startsWith('secretaria') && Number(r.ativo) === 1).map(r => r.modulo) : [];
    console.log(`[DIAG-GET] escola_id=${escolaId} perfil=${perfil} rows=${rows?.length || 0} ativos=${ativosDbCount} secretaria_ativos=${JSON.stringify(secretariaAtivos)}`);

    let modulos;
    if (!rows || rows.length === 0) {
      modulos = Array.from(MODULOS_VALIDOS).map(modulo => ({ modulo, ativo: false }));
    } else {
      const mapa = new Map(rows.map(r => [r.modulo, Number(r.ativo) === 1]));
      modulos = Array.from(MODULOS_VALIDOS).map(modulo => ({
        modulo,
        ativo: mapa.has(modulo) ? mapa.get(modulo) : false,
      }));
    }

    return res.json({ ok: true, escola_id: escolaId, perfil, modulos });
  } catch (err) {
    console.error('[plataforma_modulos] GET perfil erro:', err.message);
    return res.status(500).json({ ok: false, message: 'Erro ao buscar módulos do perfil.' });
  }
});

/**
 * PUT /api/plataforma/modulos/:escolaId/perfil/:perfil
 * body: { modulos: [{ modulo: 'gabarito.gerar', ativo: true }, ...] }
 * Salva o teto de módulos para este perfil nesta escola.
 */
router.put('/:escolaId/perfil/:perfil', async (req, res) => {
  const db = req.db;
  const escolaId = Number(req.params.escolaId);
  const perfil   = String(req.params.perfil || '').toLowerCase().trim();

  if (!escolaId || isNaN(escolaId)) {
    return res.status(400).json({ ok: false, message: 'escolaId inválido.' });
  }
  if (!PERFIS_GERENCIAVEIS.has(perfil)) {
    return res.status(400).json({ ok: false, message: `Perfil '${perfil}' não gerenciável pelo CEO.` });
  }

  const { modulos } = req.body;
  if (!Array.isArray(modulos) || modulos.length === 0) {
    return res.status(400).json({ ok: false, message: 'Campo modulos deve ser um array não vazio.' });
  }

  const invalidos = modulos.filter(m => !MODULOS_VALIDOS.has(m?.modulo));
  if (invalidos.length > 0) {
    return res.status(400).json({
      ok: false,
      message: `Módulos inválidos: ${invalidos.map(m => m?.modulo).join(', ')}`,
    });
  }

  try {
    let total_ativados = 0;
    let total_desativados = 0;

    for (const { modulo, ativo } of modulos) {
      const ativoVal = ativo ? 1 : 0;
      await db.query(
        `INSERT INTO escola_perfil_modulos (escola_id, perfil, modulo, ativo)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE ativo = ?`,
        [escolaId, perfil, modulo, ativoVal, ativoVal]
      );
      if (ativoVal) total_ativados++;
      else total_desativados++;
    }

    // ── DIAGNÓSTICO TEMP ── remover após resolver
    console.log(`[DIAG-PUT] escola_id=${escolaId} perfil=${perfil} total_ativados=${total_ativados} total_desativados=${total_desativados}`);
    // Verificar o que ficou salvo para secretaria
    const [dbCheck] = await db.query(
      "SELECT modulo, ativo FROM escola_perfil_modulos WHERE escola_id = ? AND perfil = ? AND modulo LIKE 'secretaria%' ORDER BY modulo",
      [escolaId, perfil]
    ).catch(() => [[]]);
    console.log(`[DIAG-PUT] secretaria rows salvas:`, JSON.stringify(dbCheck));

    return res.json({ ok: true, escola_id: escolaId, perfil, total_ativados, total_desativados });
  } catch (err) {
    console.error('[plataforma_modulos] PUT perfil erro:', err.message);
    return res.status(500).json({ ok: false, message: 'Erro ao salvar módulos do perfil.' });
  }
});

/**
 * POST /api/plataforma/modulos/:escolaId/copiar-de/:origemId/perfil/:perfil
 * Copia configuração de módulos do perfil da escola origem para a escola destino.
 */
router.post('/:escolaId/copiar-de/:origemId/perfil/:perfil', async (req, res) => {
  const db = req.db;
  const escolaId = Number(req.params.escolaId);
  const origemId = Number(req.params.origemId);
  const perfil   = String(req.params.perfil || '').toLowerCase().trim();

  if (!escolaId || isNaN(escolaId) || !origemId || isNaN(origemId)) {
    return res.status(400).json({ ok: false, message: 'escolaId ou origemId inválido.' });
  }
  if (escolaId === origemId) {
    return res.status(400).json({ ok: false, message: 'Escola destino e origem não podem ser iguais.' });
  }
  if (!PERFIS_GERENCIAVEIS.has(perfil)) {
    return res.status(400).json({ ok: false, message: `Perfil '${perfil}' não gerenciável pelo CEO.` });
  }

  try {
    const [origemRows] = await db.query(
      'SELECT modulo, ativo FROM escola_perfil_modulos WHERE escola_id = ? AND perfil = ?',
      [origemId, perfil]
    );

    // Remove configuração existente do perfil no destino
    await db.query(
      'DELETE FROM escola_perfil_modulos WHERE escola_id = ? AND perfil = ?',
      [escolaId, perfil]
    );

    // Copia registros da origem
    let total_copiados = 0;
    for (const { modulo, ativo } of origemRows) {
      await db.query(
        'INSERT INTO escola_perfil_modulos (escola_id, perfil, modulo, ativo) VALUES (?, ?, ?, ?)',
        [escolaId, perfil, modulo, ativo]
      );
      total_copiados++;
    }

    return res.json({ ok: true, escola_id: escolaId, perfil, origem_id: origemId, total_copiados });
  } catch (err) {
    console.error('[plataforma_modulos] POST copiar-de perfil erro:', err.message);
    return res.status(500).json({ ok: false, message: 'Erro ao copiar módulos do perfil.' });
  }
});

