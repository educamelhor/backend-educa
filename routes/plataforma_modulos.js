// routes/plataforma_modulos.js
// ============================================================================
// Central Unificada de Licenciamento de Módulos (CEO) — EDUCA.MELHOR
// Governa as 3 Esferas Institucionais:
//   1. Escolas Públicas     (origem = 'publica')
//   2. Escolas Particulares (origem = 'particular')
//   3. Regionais de Ensino  (CREs — tabela regional_cargo_modulos)
// ============================================================================
import express from 'express';
import {
  CARGOS_CRE_LABELS,
  MODULOS_CRE_VALIDOS,
  ensureRegionalModulosTable,
  resolveModulosCre,
} from '../middleware/verificarRegional.js';

const router = express.Router();

// ── Conjuntos de Escopo de Módulos Escolares ──────────────────────────────────
const MODULOS_VALIDOS = new Set([
  // Secretaria
  'secretaria', 'secretaria.matriculas', 'secretaria.alunos', 'secretaria.responsaveis',
  'secretaria.cargas_horarias', 'secretaria.disciplinas', 'secretaria.turmas',
  'secretaria.professores', 'secretaria.boletim', 'secretaria.relatorios',
  'secretaria.horarios', 'secretaria.agente', 'secretaria.tabela_codigos',
  'secretaria.sincronizar_seedf', 'secretaria.modulacao',
  'secretaria.etapas', 'secretaria.conflitos_notas', 'secretaria.faltas', 'secretaria.liberacao',
  // Disciplinar (exclusivo CCMDF — gerido automaticamente para perfis militares)
  'disciplinar', 'disciplinar.alunos', 'disciplinar.historico',
  'disciplinar.atas', 'disciplinar.fo_coletivo', 'disciplinar.responsaveis',
  'disciplinar.liberacao', 'disciplinar.metadados', 'disciplinar.equipe',
  'disciplinar.regimentos', 'disciplinar.manual', 'disciplinar.suporte',
  'disciplinar.aph_cbmdf',
  // Pedagógico
  'pedagogico', 'pedagogico.conselho', 'pedagogico.conteudos',
  'pedagogico.relatorios', 'pedagogico.correcoes',
  'pedagogico.solicitacoes', 'pedagogico.provas', 'pedagogico.agenda',
  // Gabarito
  'gabarito', 'gabarito.gerar', 'gabarito.corrigir_lote',
  'gabarito.corrigir', 'gabarito.resultados',
  // Frequência
  'frequencia', 'frequencia.atestados', 'frequencia.relatorios',
  'frequencia.busca_ativa', 'frequencia.conselho_tutelar', 'frequencia.liberacao',
  // Biblioteca
  'biblioteca', 'biblioteca.acervo', 'biblioteca.emprestimos',
  'biblioteca.alunos', 'biblioteca.leitor_destaque',
  'biblioteca.concurso', 'biblioteca.metadados',
  // Professores
  'professores', 'professores.planos', 'professores.avaliacoes', 'professores.chamada',
  'professores.conteudos', 'professores.provas', 'professores.boletim',
  'professores.conselho', 'professores.sala_recurso',
  // Monitoramento
  'monitoramento', 'monitoramento.painel', 'monitoramento.alertas',
  'monitoramento.visitantes_registrar', 'monitoramento.visitantes_historico',
  'monitoramento.embeddings',
  // Questões
  'questoes',
  // Agente EDUCA (Exclusivo Rede Pública SEEDF)
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
  // Comunicação
  'comunicacao', 'comunicacao.avisos', 'comunicacao.comunicados', 'comunicacao.mural',
  // Sala de Recursos (AEE)
  'sala_recurso', 'sala_recurso.alunos', 'sala_recurso.adequacoes',
  'sala_recurso.impressao', 'sala_recurso.pdi', 'sala_recurso.atendimentos',
  // Administrativo
  'administrativo', 'administrativo.servidores', 'administrativo.frequencia',
  'administrativo.ocorrencias', 'administrativo.relatorios', 'administrativo.memorando',
  // Financeiro (Pai + Submódulos Rede Pública + Submódulos Rede Particular)
  'financeiro',
  'financeiro.pdaf', 'financeiro.pdde',
  'financeiro.mensalidades', 'financeiro.boletos_pix', 'financeiro.contratos',
  'financeiro.inadimplencia', 'financeiro.caixa_dre',
]);

const MODULOS_EXCLUSIVOS_PUBLICA = new Set([
  'agente_educa', 'agente_educa.credenciais', 'agente_educa.planos', 'agente_educa.notas',
  'secretaria.sincronizar_seedf', 'secretaria.agente', 'secretaria.tabela_codigos',
  'financeiro.pdaf', 'financeiro.pdde',
]);

const MODULOS_EXCLUSIVOS_PARTICULAR = new Set([
  'financeiro.mensalidades', 'financeiro.boletos_pix', 'financeiro.contratos',
  'financeiro.inadimplencia', 'financeiro.caixa_dre',
]);

const PERFIS_GERENCIAVEIS = new Set([
  'diretor', 'vice_diretor', 'coordenacao', 'coordenador', 'secretaria', 'secretario',
  'orientador', 'supervisor_pedagogico', 'supervisor', 'supervisor_administrativo',
  'disciplinar', 'administrativo', 'financeiro', 'psicopedagogia', 'sala_recurso', 'sala_de_recurso',
  'apoio', 'educador_social', 'vigilancia', 'merenda', 'biblioteca', 'professor',
  'pedagogo', 'aluno', 'responsavel', 'psicologo', 'monitor', 'visitante',
  'subcomandante', 'supervisor_disciplinar', 'monitor_disciplinar',
]);

// ── Templates Automáticos de 1 Clique por Natureza Institucional ──────────────
const SECRETARIA_PUBLICA_ALL = [
  'secretaria', 'secretaria.matriculas', 'secretaria.alunos', 'secretaria.responsaveis',
  'secretaria.cargas_horarias', 'secretaria.disciplinas', 'secretaria.turmas',
  'secretaria.professores', 'secretaria.boletim', 'secretaria.relatorios',
  'secretaria.horarios', 'secretaria.agente', 'secretaria.tabela_codigos',
  'secretaria.sincronizar_seedf', 'secretaria.modulacao',
  'secretaria.etapas', 'secretaria.conflitos_notas', 'secretaria.faltas', 'secretaria.liberacao',
];
const PEDAGOGICO_ALL = [
  'pedagogico', 'pedagogico.agenda', 'pedagogico.conselho',
  'pedagogico.conteudos', 'pedagogico.relatorios', 'pedagogico.correcoes',
];
const GABARITO_ALL = [
  'gabarito', 'gabarito.gerar', 'gabarito.corrigir_lote', 'gabarito.corrigir', 'gabarito.resultados',
];
const FREQUENCIA_ALL = [
  'frequencia', 'frequencia.atestados', 'frequencia.relatorios',
  'frequencia.busca_ativa', 'frequencia.conselho_tutelar', 'frequencia.liberacao',
];
const BIBLIOTECA_ALL = [
  'biblioteca', 'biblioteca.acervo', 'biblioteca.emprestimos',
  'biblioteca.alunos', 'biblioteca.leitor_destaque', 'biblioteca.concurso', 'biblioteca.metadados',
];
const PROFESSORES_ALL = [
  'professores', 'professores.planos', 'professores.avaliacoes', 'professores.chamada',
  'professores.conteudos', 'professores.provas', 'professores.conselho',
  'professores.boletim', 'professores.sala_recurso',
];
const MONITORAMENTO_ALL = [
  'monitoramento', 'monitoramento.painel', 'monitoramento.alertas', 'monitoramento.embeddings',
];
const AGENTE_EDUCA_ALL = [
  'agente_educa', 'agente_educa.credenciais', 'agente_educa.planos', 'agente_educa.notas',
];
const IMPRESSAO_ALL = [
  'impressao', 'impressao.gabaritos', 'impressao.boletins', 'impressao.listas', 'impressao.documentos',
];
const DIRECAO_ALL = [
  'direcao', 'direcao.educa_capture', 'direcao.responsaveis', 'direcao.cadastro', 'direcao.governanca',
];
const MERENDA_ALL = [
  'merenda', 'merenda.cadastro', 'merenda.cardapio', 'merenda.relatorios',
];
const COMUNICACAO_ALL = [
  'comunicacao', 'comunicacao.avisos', 'comunicacao.comunicados', 'comunicacao.mural',
];
const SALA_RECURSO_ALL = [
  'sala_recurso', 'sala_recurso.alunos', 'sala_recurso.adequacoes',
  'sala_recurso.impressao', 'sala_recurso.pdi', 'sala_recurso.atendimentos',
];
const ADMINISTRATIVO_ALL = [
  'administrativo', 'administrativo.servidores', 'administrativo.frequencia',
  'administrativo.ocorrencias', 'administrativo.relatorios', 'administrativo.memorando',
];
const FINANCEIRO_PUBLICA_ALL = ['financeiro', 'financeiro.pdaf', 'financeiro.pdde'];
const FINANCEIRO_PARTICULAR_ALL = [
  'financeiro', 'financeiro.mensalidades', 'financeiro.boletos_pix',
  'financeiro.contratos', 'financeiro.inadimplencia', 'financeiro.caixa_dre',
];

const DIRETOR_PUBLICA_FULL = [
  ...SECRETARIA_PUBLICA_ALL,
  ...PEDAGOGICO_ALL,
  ...GABARITO_ALL,
  ...FREQUENCIA_ALL,
  ...BIBLIOTECA_ALL,
  ...PROFESSORES_ALL,
  ...MONITORAMENTO_ALL,
  'questoes',
  ...AGENTE_EDUCA_ALL,
  ...IMPRESSAO_ALL,
  'ferramentas',
  ...DIRECAO_ALL,
  'estudantes',
  ...MERENDA_ALL,
  ...COMUNICACAO_ALL,
  ...SALA_RECURSO_ALL,
  ...ADMINISTRATIVO_ALL,
  ...FINANCEIRO_PUBLICA_ALL,
];

const TEMPLATE_ESCOLA_PUBLICA = {
  diretor: DIRETOR_PUBLICA_FULL,
  vice_diretor: DIRETOR_PUBLICA_FULL,
  secretaria: [...SECRETARIA_PUBLICA_ALL, ...FREQUENCIA_ALL, ...IMPRESSAO_ALL, ...COMUNICACAO_ALL, 'estudantes'],
  coordenacao: [...PEDAGOGICO_ALL, ...GABARITO_ALL, 'questoes', ...FREQUENCIA_ALL, ...PROFESSORES_ALL, ...IMPRESSAO_ALL, ...COMUNICACAO_ALL, ...SALA_RECURSO_ALL],
  supervisor_pedagogico: [...PEDAGOGICO_ALL, ...GABARITO_ALL, 'questoes', ...FREQUENCIA_ALL, ...IMPRESSAO_ALL, ...COMUNICACAO_ALL],
  supervisor_administrativo: [...ADMINISTRATIVO_ALL, ...FINANCEIRO_PUBLICA_ALL, ...MERENDA_ALL, ...COMUNICACAO_ALL],
  administrativo: [...ADMINISTRATIVO_ALL, ...COMUNICACAO_ALL],
  financeiro: [...FINANCEIRO_PUBLICA_ALL],
  professor: [...PROFESSORES_ALL, 'gabarito', 'gabarito.corrigir', 'gabarito.resultados', 'questoes', ...AGENTE_EDUCA_ALL],
  orientador: [...FREQUENCIA_ALL, 'pedagogico', 'pedagogico.agenda', 'pedagogico.conselho', ...SALA_RECURSO_ALL, ...COMUNICACAO_ALL],
  psicopedagogia: [...SALA_RECURSO_ALL, 'pedagogico', 'pedagogico.conselho'],
  sala_recurso: [...SALA_RECURSO_ALL],
  biblioteca: [...BIBLIOTECA_ALL],
  merenda: [...MERENDA_ALL],
  vigilancia: [...MONITORAMENTO_ALL],
};

// Whitelist estrita p/ Escola Particular: ativa APENAS o núcleo homologado p/ rede privada,
// sem despejar módulos construídos com fluxo/jargão da rede pública (SEEDF).
const TEMPLATE_ESCOLA_PARTICULAR = {
  diretor: [...DIRECAO_ALL, ...FINANCEIRO_PARTICULAR_ALL, ...COMUNICACAO_ALL, ...MONITORAMENTO_ALL],
  vice_diretor: [...DIRECAO_ALL, ...FINANCEIRO_PARTICULAR_ALL, ...COMUNICACAO_ALL, ...MONITORAMENTO_ALL],
  financeiro: [...FINANCEIRO_PARTICULAR_ALL],
  secretaria: [...COMUNICACAO_ALL],
};

// ── Auto-migrate: tabelas e retrocompatibilidade de financeiro público ─────────
let _tablesMigrated = false;
router.use(async (req, _res, next) => {
  if (_tablesMigrated) return next();
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
    await ensureRegionalModulosTable(req.db);

    // Retrocompatibilidade: escolas públicas que já tinham 'financeiro' = 1 herdam 'financeiro.pdaf' e 'financeiro.pdde'
    await req.db.query(`
      INSERT IGNORE INTO escola_perfil_modulos (escola_id, perfil, modulo, ativo)
      SELECT epm.escola_id, epm.perfil, 'financeiro.pdaf', 1
      FROM escola_perfil_modulos epm
      INNER JOIN escolas e ON e.id = epm.escola_id
      WHERE epm.modulo = 'financeiro' AND epm.ativo = 1
        AND COALESCE(LOWER(TRIM(e.origem)), 'publica') <> 'particular'
    `).catch(() => {});
    await req.db.query(`
      INSERT IGNORE INTO escola_perfil_modulos (escola_id, perfil, modulo, ativo)
      SELECT epm.escola_id, epm.perfil, 'financeiro.pdde', 1
      FROM escola_perfil_modulos epm
      INNER JOIN escolas e ON e.id = epm.escola_id
      WHERE epm.modulo = 'financeiro' AND epm.ativo = 1
        AND COALESCE(LOWER(TRIM(e.origem)), 'publica') <> 'particular'
    `).catch(() => {});
    await req.db.query(`
      INSERT IGNORE INTO escola_modulos (escola_id, modulo, ativo)
      SELECT em.escola_id, 'financeiro.pdaf', 1
      FROM escola_modulos em
      INNER JOIN escolas e ON e.id = em.escola_id
      WHERE em.modulo = 'financeiro' AND em.ativo = 1
        AND COALESCE(LOWER(TRIM(e.origem)), 'publica') <> 'particular'
    `).catch(() => {});
    await req.db.query(`
      INSERT IGNORE INTO escola_modulos (escola_id, modulo, ativo)
      SELECT em.escola_id, 'financeiro.pdde', 1
      FROM escola_modulos em
      INNER JOIN escolas e ON e.id = em.escola_id
      WHERE em.modulo = 'financeiro' AND em.ativo = 1
        AND COALESCE(LOWER(TRIM(e.origem)), 'publica') <> 'particular'
    `).catch(() => {});

    _tablesMigrated = true;
    console.log('[plataforma_modulos] Tabelas escola_modulos, escola_perfil_modulos e regional_cargo_modulos verificadas ✅');
  } catch (e) {
    _tablesMigrated = true;
    console.warn('[plataforma_modulos] Auto-migrate aviso:', e.message);
  }
  next();
});

async function obterOrigemEscola(db, escolaId) {
  const [[row]] = await db.query(
    "SELECT id, COALESCE(NULLIF(LOWER(TRIM(origem)), ''), 'publica') AS origem FROM escolas WHERE id = ? LIMIT 1",
    [escolaId]
  );
  return row || null;
}

function moduloPermitidoParaOrigem(modulo, origem) {
  if (origem === 'particular' && MODULOS_EXCLUSIVOS_PUBLICA.has(modulo)) return false;
  if (origem !== 'particular' && MODULOS_EXCLUSIVOS_PARTICULAR.has(modulo)) return false;
  return true;
}

// ══════════════════════════════════════════════════════════════════════════════
// 0) RESUMO DE MÓDULOS POR ESCOLA (para contadores instantâneos na coluna esquerda)
// GET /api/plataforma/modulos/resumo-escolas
// ══════════════════════════════════════════════════════════════════════════════
router.get('/resumo-escolas', async (req, res) => {
  const db = req.db;
  try {
    const [rows] = await db.query(`
      SELECT
        escola_id,
        COUNT(DISTINCT CASE WHEN ativo = 1 THEN modulo END) AS modulos_ativos,
        COUNT(DISTINCT CASE WHEN ativo = 1 THEN perfil END) AS perfis_ativos
      FROM escola_perfil_modulos
      GROUP BY escola_id
    `);
    const resumo = {};
    for (const r of rows || []) {
      resumo[Number(r.escola_id)] = {
        modulos_ativos: Number(r.modulos_ativos || 0),
        perfis_ativos: Number(r.perfis_ativos || 0),
      };
    }
    return res.json({ ok: true, resumo });
  } catch (err) {
    console.error('[plataforma_modulos] GET resumo-escolas erro:', err.message);
    return res.status(500).json({ ok: false, message: 'Erro ao carregar resumo de módulos.' });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// 1) ESFERA CRE — MODULAÇÃO POR REGIONAL E CARGO ORGÂNICO
//    (Rotas /cre/* declaradas ANTES de /:escolaId)
// ══════════════════════════════════════════════════════════════════════════════

router.get('/cre/resumo', async (req, res) => {
  const db = req.db;
  try {
    await ensureRegionalModulosTable(db);
    const [rows] = await db.query(`
      SELECT
        regional_id,
        COUNT(*) AS total_registros,
        COUNT(DISTINCT CASE WHEN ativo = 1 THEN cargo_regional END) AS cargos_ativos,
        COUNT(DISTINCT CASE WHEN ativo = 1 AND modulo LIKE 'cre.%' THEN modulo END) AS modulos_ativos
      FROM regional_cargo_modulos
      GROUP BY regional_id
    `);
    const resumo = {};
    for (const r of rows || []) {
      resumo[Number(r.regional_id)] = {
        customizado: Number(r.total_registros || 0) > 0,
        cargos_ativos: Number(r.cargos_ativos || 0),
        modulos_ativos: Number(r.modulos_ativos || 0),
      };
    }
    return res.json({ ok: true, resumo });
  } catch (err) {
    console.error('[plataforma_modulos] GET cre/resumo erro:', err.message);
    return res.status(500).json({ ok: false, message: 'Erro ao carregar resumo das CREs.' });
  }
});

router.get('/cre/:regionalId/cargo/:cargo', async (req, res) => {
  const db = req.db;
  const regionalId = Number(req.params.regionalId);
  const cargo = String(req.params.cargo || '').toLowerCase().trim();

  if (!regionalId || Number.isNaN(regionalId)) {
    return res.status(400).json({ ok: false, message: 'regionalId inválido.' });
  }
  if (!CARGOS_CRE_LABELS[cargo]) {
    return res.status(400).json({ ok: false, message: `Cargo regional '${cargo}' inválido.` });
  }

  try {
    await ensureRegionalModulosTable(db);
    const [rows] = await db.query(
      'SELECT modulo, ativo FROM regional_cargo_modulos WHERE regional_id = ? AND cargo_regional = ?',
      [regionalId, cargo]
    );

    const customizado = Boolean(rows && rows.length > 0);
    let ativosSet;
    if (!customizado) {
      ativosSet = new Set(resolveModulosCre(cargo));
    } else {
      ativosSet = new Set(rows.filter((r) => Number(r.ativo) === 1).map((r) => r.modulo));
    }

    const modulos = Array.from(MODULOS_CRE_VALIDOS).map((modulo) => ({
      modulo,
      ativo: ativosSet.has(modulo),
    }));

    return res.json({ ok: true, regional_id: regionalId, cargo, customizado, modulos });
  } catch (err) {
    console.error('[plataforma_modulos] GET cre cargo erro:', err.message);
    return res.status(500).json({ ok: false, message: 'Erro ao carregar módulos do cargo regional.' });
  }
});

router.put('/cre/:regionalId/cargo/:cargo', async (req, res) => {
  const db = req.db;
  const regionalId = Number(req.params.regionalId);
  const cargo = String(req.params.cargo || '').toLowerCase().trim();

  if (!regionalId || Number.isNaN(regionalId)) {
    return res.status(400).json({ ok: false, message: 'regionalId inválido.' });
  }
  if (!CARGOS_CRE_LABELS[cargo]) {
    return res.status(400).json({ ok: false, message: `Cargo regional '${cargo}' inválido.` });
  }

  const { modulos } = req.body || {};
  if (!Array.isArray(modulos) || modulos.length === 0) {
    return res.status(400).json({ ok: false, message: 'Campo modulos deve ser um array não vazio.' });
  }

  const invalidos = modulos.filter((m) => !MODULOS_CRE_VALIDOS.has(m?.modulo));
  if (invalidos.length > 0) {
    return res.status(400).json({
      ok: false,
      message: `Módulos CRE inválidos: ${invalidos.map((m) => m?.modulo).join(', ')}`,
    });
  }

  try {
    await ensureRegionalModulosTable(db);
    let total_ativados = 0;
    let total_desativados = 0;

    for (const { modulo, ativo } of modulos) {
      const ativoVal = ativo ? 1 : 0;
      await db.query(
        `INSERT INTO regional_cargo_modulos (regional_id, cargo_regional, modulo, ativo)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE ativo = ?`,
        [regionalId, cargo, modulo, ativoVal, ativoVal]
      );
      if (ativoVal) total_ativados++;
      else total_desativados++;
    }

    return res.json({ ok: true, regional_id: regionalId, cargo, total_ativados, total_desativados });
  } catch (err) {
    console.error('[plataforma_modulos] PUT cre cargo erro:', err.message);
    return res.status(500).json({ ok: false, message: 'Erro ao salvar módulos do cargo regional.' });
  }
});

async function gravarTemplatePadraoCre(db, regionalId) {
  const cargos = Object.keys(CARGOS_CRE_LABELS);
  const todosModulosCre = Array.from(MODULOS_CRE_VALIDOS);
  const valores = [];

  for (const cargo of cargos) {
    const padraoSet = new Set(resolveModulosCre(cargo));
    for (const modulo of todosModulosCre) {
      valores.push([regionalId, cargo, modulo, padraoSet.has(modulo) ? 1 : 0]);
    }
  }

  if (valores.length > 0) {
    await db.query(
      `INSERT INTO regional_cargo_modulos (regional_id, cargo_regional, modulo, ativo)
       VALUES ?
       ON DUPLICATE KEY UPDATE ativo = VALUES(ativo)`,
      [valores]
    );
  }
}

router.post('/cre/:regionalId/aplicar-template', async (req, res) => {
  const db = req.db;
  const regionalId = Number(req.params.regionalId);
  if (!regionalId || Number.isNaN(regionalId)) {
    return res.status(400).json({ ok: false, message: 'regionalId inválido.' });
  }

  try {
    await ensureRegionalModulosTable(db);
    await gravarTemplatePadraoCre(db, regionalId);
    return res.json({
      ok: true,
      regional_id: regionalId,
      message: 'Pacote padrão CRE aplicado aos 6 cargos desta Regional.',
    });
  } catch (err) {
    console.error('[plataforma_modulos] POST cre aplicar-template erro:', err.message);
    return res.status(500).json({ ok: false, message: 'Erro ao aplicar pacote padrão na CRE.' });
  }
});

router.post('/cre/aplicar-template-todas', async (req, res) => {
  const db = req.db;
  const origemRegionalId = req.body?.origem_regional_id ? Number(req.body.origem_regional_id) : null;

  try {
    await ensureRegionalModulosTable(db);
    const [regRows] = await db.query("SELECT id FROM regionais WHERE status <> 'cancelada'");
    const ids = (regRows || []).map((r) => Number(r.id)).filter((id) => id > 0);

    if (origemRegionalId) {
      const [origRows] = await db.query(
        'SELECT cargo_regional, modulo, ativo FROM regional_cargo_modulos WHERE regional_id = ?',
        [origemRegionalId]
      );
      if (origRows && origRows.length > 0) {
        for (const rid of ids) {
          if (rid === origemRegionalId) continue;
          const valores = origRows.map((r) => [rid, r.cargo_regional, r.modulo, Number(r.ativo) ? 1 : 0]);
          await db.query(
            `INSERT INTO regional_cargo_modulos (regional_id, cargo_regional, modulo, ativo)
             VALUES ?
             ON DUPLICATE KEY UPDATE ativo = VALUES(ativo)`,
            [valores]
          );
        }
        return res.json({
          ok: true,
          total_regionais: ids.length,
          message: `Configuração replicada com sucesso para ${ids.length} Regionais (CREs).`,
        });
      }
    }

    for (const rid of ids) {
      await gravarTemplatePadraoCre(db, rid);
    }

    return res.json({
      ok: true,
      total_regionais: ids.length,
      message: `Pacote padrão aplicado com sucesso nas ${ids.length} Regionais (CREs).`,
    });
  } catch (err) {
    console.error('[plataforma_modulos] POST cre aplicar-template-todas erro:', err.message);
    return res.status(500).json({ ok: false, message: 'Erro ao replicar padrão nas CREs.' });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// 2) TEMPLATE AUTOMÁTICO DE 1 CLIQUE POR ESCOLA (PÚBLICA VS PARTICULAR)
// POST /api/plataforma/modulos/:escolaId/aplicar-template
// body opcional: { perfil?: string }
// ══════════════════════════════════════════════════════════════════════════════
router.post('/:escolaId/aplicar-template', async (req, res) => {
  const db = req.db;
  const escolaId = Number(req.params.escolaId);
  const perfilAlvo = req.body?.perfil ? String(req.body.perfil).toLowerCase().trim() : null;

  if (!escolaId || Number.isNaN(escolaId)) {
    return res.status(400).json({ ok: false, message: 'escolaId inválido.' });
  }

  try {
    const esc = await obterOrigemEscola(db, escolaId);
    if (!esc) {
      return res.status(404).json({ ok: false, message: 'Escola não encontrada.' });
    }

    const origem = esc.origem === 'particular' ? 'particular' : 'publica';
    const templateMapa = origem === 'particular' ? TEMPLATE_ESCOLA_PARTICULAR : TEMPLATE_ESCOLA_PUBLICA;
    const todosModulos = Array.from(MODULOS_VALIDOS);

    const perfisParaAplicar = perfilAlvo ? [perfilAlvo] : Object.keys(templateMapa);
    const valoresPerfil = [];
    const tetoEscolaSet = new Set();

    for (const perf of perfisParaAplicar) {
      if (!PERFIS_GERENCIAVEIS.has(perf)) continue;
      const listaAtivos = templateMapa[perf] || [];
      const setAtivos = new Set(listaAtivos.filter((m) => moduloPermitidoParaOrigem(m, origem)));
      for (const m of setAtivos) tetoEscolaSet.add(m);

      for (const mod of todosModulos) {
        valoresPerfil.push([escolaId, perf, mod, setAtivos.has(mod) ? 1 : 0]);
      }
    }

    if (valoresPerfil.length > 0) {
      // Insere em blocos para evitar pacotes SQL muito grandes
      const CHUNK = 400;
      for (let i = 0; i < valoresPerfil.length; i += CHUNK) {
        const slice = valoresPerfil.slice(i, i + CHUNK);
        await db.query(
          `INSERT INTO escola_perfil_modulos (escola_id, perfil, modulo, ativo)
           VALUES ?
           ON DUPLICATE KEY UPDATE ativo = VALUES(ativo)`,
          [slice]
        );
      }
    }

    if (!perfilAlvo && tetoEscolaSet.size > 0) {
      const valoresTeto = todosModulos.map((mod) => [escolaId, mod, tetoEscolaSet.has(mod) ? 1 : 0]);
      await db.query(
        `INSERT INTO escola_modulos (escola_id, modulo, ativo)
         VALUES ?
         ON DUPLICATE KEY UPDATE ativo = VALUES(ativo)`,
        [valoresTeto]
      );
    }

    return res.json({
      ok: true,
      escola_id: escolaId,
      origem,
      perfis_aplicados: perfisParaAplicar.length,
      message:
        origem === 'particular'
          ? 'Pacote Inicial (Rede Particular) aplicado com sucesso!'
          : 'Pacote Padrão (Rede Pública) aplicado com sucesso!',
    });
  } catch (err) {
    console.error('[plataforma_modulos] POST aplicar-template erro:', err.message);
    return res.status(500).json({ ok: false, message: 'Erro ao aplicar pacote padrão na escola.' });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// 3) TETO GERAL DA ESCOLA (LEGADO + COMPATIBILIDADE)
// ══════════════════════════════════════════════════════════════════════════════
router.get('/:escolaId', async (req, res) => {
  const db = req.db;
  const escolaId = Number(req.params.escolaId);

  if (!escolaId || isNaN(escolaId)) {
    return res.status(400).json({ ok: false, message: 'escolaId inválido.' });
  }

  try {
    const esc = await obterOrigemEscola(db, escolaId);
    const origem = esc?.origem === 'particular' ? 'particular' : 'publica';

    const [rows] = await db.query(
      'SELECT modulo, ativo FROM escola_modulos WHERE escola_id = ?',
      [escolaId]
    );

    const mapa = new Map((rows || []).map((r) => [r.modulo, Number(r.ativo) === 1]));
    const modulos = Array.from(MODULOS_VALIDOS).map((modulo) => ({
      modulo,
      ativo: moduloPermitidoParaOrigem(modulo, origem) && mapa.has(modulo) ? mapa.get(modulo) : false,
    }));

    return res.json({ ok: true, escola_id: escolaId, origem, modulos });
  } catch (err) {
    console.error('[plataforma_modulos] GET erro:', err.message);
    return res.status(500).json({ ok: false, message: 'Erro ao buscar módulos da escola.' });
  }
});

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

  const invalidos = modulos.filter((m) => !MODULOS_VALIDOS.has(m?.modulo));
  if (invalidos.length > 0) {
    return res.status(400).json({
      ok: false,
      message: `Módulos inválidos: ${invalidos.map((m) => m?.modulo).join(', ')}`,
    });
  }

  try {
    const esc = await obterOrigemEscola(db, escolaId);
    const origem = esc?.origem === 'particular' ? 'particular' : 'publica';

    let total_ativados = 0;
    let total_desativados = 0;

    const valores = modulos.map(({ modulo, ativo }) => {
      const permitido = moduloPermitidoParaOrigem(modulo, origem);
      const ativoVal = permitido && ativo ? 1 : 0;
      if (ativoVal) total_ativados++;
      else total_desativados++;
      return [escolaId, modulo, ativoVal];
    });

    await db.query(
      `INSERT INTO escola_modulos (escola_id, modulo, ativo)
       VALUES ?
       ON DUPLICATE KEY UPDATE ativo = VALUES(ativo)`,
      [valores]
    );

    return res.json({ ok: true, total_ativados, total_desativados });
  } catch (err) {
    console.error('[plataforma_modulos] PUT erro:', err.message);
    return res.status(500).json({ ok: false, message: 'Erro ao salvar módulos da escola.' });
  }
});

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
    const [destEsc, origEsc] = await Promise.all([
      obterOrigemEscola(db, escolaId),
      obterOrigemEscola(db, origemId),
    ]);
    if (!destEsc || !origEsc) {
      return res.status(404).json({ ok: false, message: 'Escola de origem ou destino não encontrada.' });
    }
    if (destEsc.origem !== origEsc.origem) {
      return res.status(400).json({
        ok: false,
        message: 'Operação bloqueada: não é permitido copiar módulos entre Escola Pública e Escola Particular.',
      });
    }

    const [origemRows] = await db.query(
      'SELECT modulo, ativo FROM escola_modulos WHERE escola_id = ?',
      [origemId]
    );
    const [origemPerfilRows] = await db.query(
      'SELECT perfil, modulo, ativo FROM escola_perfil_modulos WHERE escola_id = ?',
      [origemId]
    );

    await db.query('DELETE FROM escola_modulos WHERE escola_id = ?', [escolaId]);
    await db.query('DELETE FROM escola_perfil_modulos WHERE escola_id = ?', [escolaId]);

    if (origemRows && origemRows.length > 0) {
      const vals = origemRows
        .filter((r) => moduloPermitidoParaOrigem(r.modulo, destEsc.origem))
        .map((r) => [escolaId, r.modulo, r.ativo]);
      if (vals.length > 0) {
        await db.query('INSERT INTO escola_modulos (escola_id, modulo, ativo) VALUES ?', [vals]);
      }
    }

    if (origemPerfilRows && origemPerfilRows.length > 0) {
      const valsPerfil = origemPerfilRows
        .filter((r) => moduloPermitidoParaOrigem(r.modulo, destEsc.origem))
        .map((r) => [escolaId, r.perfil, r.modulo, r.ativo]);
      const CHUNK = 400;
      for (let i = 0; i < valsPerfil.length; i += CHUNK) {
        await db.query(
          'INSERT INTO escola_perfil_modulos (escola_id, perfil, modulo, ativo) VALUES ?',
          [valsPerfil.slice(i, i + CHUNK)]
        );
      }
    }

    return res.json({ ok: true, total_copiados: (origemPerfilRows?.length || origemRows?.length || 0) });
  } catch (err) {
    console.error('[plataforma_modulos] POST copiar-de erro:', err.message);
    return res.status(500).json({ ok: false, message: 'Erro ao copiar módulos.' });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// 4) MÓDULOS POR PERFIL DE ESCOLA (TETO CEO)
// ══════════════════════════════════════════════════════════════════════════════
router.get('/:escolaId/perfil/:perfil', async (req, res) => {
  const db = req.db;
  const escolaId = Number(req.params.escolaId);
  const perfil = String(req.params.perfil || '').toLowerCase().trim();

  if (!escolaId || isNaN(escolaId)) {
    return res.status(400).json({ ok: false, message: 'escolaId inválido.' });
  }
  if (!PERFIS_GERENCIAVEIS.has(perfil)) {
    return res.status(400).json({ ok: false, message: `Perfil '${perfil}' não gerenciável pelo CEO.` });
  }

  try {
    const esc = await obterOrigemEscola(db, escolaId);
    const origem = esc?.origem === 'particular' ? 'particular' : 'publica';

    const [rows] = await db.query(
      'SELECT modulo, ativo FROM escola_perfil_modulos WHERE escola_id = ? AND perfil = ?',
      [escolaId, perfil]
    );

    const mapa = new Map((rows || []).map((r) => [r.modulo, Number(r.ativo) === 1]));

    // Se for pública e 'financeiro' legado estiver ativo sem filhos explícitos no mapa, reflete PDAF + PDDE ativos
    if (
      origem === 'publica' &&
      mapa.get('financeiro') === true &&
      !mapa.has('financeiro.pdaf') &&
      !mapa.has('financeiro.pdde')
    ) {
      mapa.set('financeiro.pdaf', true);
      mapa.set('financeiro.pdde', true);
    }

    const modulos = Array.from(MODULOS_VALIDOS).map((modulo) => ({
      modulo,
      ativo: moduloPermitidoParaOrigem(modulo, origem) && mapa.has(modulo) ? mapa.get(modulo) : false,
    }));

    return res.json({ ok: true, escola_id: escolaId, origem, perfil, modulos });
  } catch (err) {
    console.error('[plataforma_modulos] GET perfil erro:', err.message);
    return res.status(500).json({ ok: false, message: 'Erro ao buscar módulos do perfil.' });
  }
});

router.put('/:escolaId/perfil/:perfil', async (req, res) => {
  const db = req.db;
  const escolaId = Number(req.params.escolaId);
  const perfil = String(req.params.perfil || '').toLowerCase().trim();

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

  const invalidos = modulos.filter((m) => !MODULOS_VALIDOS.has(m?.modulo));
  if (invalidos.length > 0) {
    return res.status(400).json({
      ok: false,
      message: `Módulos inválidos: ${invalidos.map((m) => m?.modulo).join(', ')}`,
    });
  }

  try {
    const esc = await obterOrigemEscola(db, escolaId);
    const origem = esc?.origem === 'particular' ? 'particular' : 'publica';

    let total_ativados = 0;
    let total_desativados = 0;

    const valores = modulos.map(({ modulo, ativo }) => {
      const permitido = moduloPermitidoParaOrigem(modulo, origem);
      const ativoVal = permitido && ativo ? 1 : 0;
      if (ativoVal) total_ativados++;
      else total_desativados++;
      return [escolaId, perfil, modulo, ativoVal];
    });

    await db.query(
      `INSERT INTO escola_perfil_modulos (escola_id, perfil, modulo, ativo)
       VALUES ?
       ON DUPLICATE KEY UPDATE ativo = VALUES(ativo)`,
      [valores]
    );

    return res.json({ ok: true, escola_id: escolaId, origem, perfil, total_ativados, total_desativados });
  } catch (err) {
    console.error('[plataforma_modulos] PUT perfil erro:', err.message);
    return res.status(500).json({ ok: false, message: 'Erro ao salvar módulos do perfil.' });
  }
});

router.post('/:escolaId/copiar-de/:origemId/perfil/:perfil', async (req, res) => {
  const db = req.db;
  const escolaId = Number(req.params.escolaId);
  const origemId = Number(req.params.origemId);
  const perfil = String(req.params.perfil || '').toLowerCase().trim();

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
    const [destEsc, origEsc] = await Promise.all([
      obterOrigemEscola(db, escolaId),
      obterOrigemEscola(db, origemId),
    ]);
    if (!destEsc || !origEsc) {
      return res.status(404).json({ ok: false, message: 'Escola de origem ou destino não encontrada.' });
    }
    if (destEsc.origem !== origEsc.origem) {
      return res.status(400).json({
        ok: false,
        message: 'Operação bloqueada: não é permitido copiar módulos entre Escola Pública e Escola Particular.',
      });
    }

    const [origemRows] = await db.query(
      'SELECT modulo, ativo FROM escola_perfil_modulos WHERE escola_id = ? AND perfil = ?',
      [origemId, perfil]
    );

    await db.query(
      'DELETE FROM escola_perfil_modulos WHERE escola_id = ? AND perfil = ?',
      [escolaId, perfil]
    );

    let total_copiados = 0;
    if (origemRows && origemRows.length > 0) {
      const valores = origemRows
        .filter((r) => moduloPermitidoParaOrigem(r.modulo, destEsc.origem))
        .map((r) => [escolaId, perfil, r.modulo, r.ativo]);
      if (valores.length > 0) {
        await db.query(
          'INSERT INTO escola_perfil_modulos (escola_id, perfil, modulo, ativo) VALUES ?',
          [valores]
        );
        total_copiados = valores.length;
      }
    }

    return res.json({ ok: true, escola_id: escolaId, perfil, origem_id: origemId, total_copiados });
  } catch (err) {
    console.error('[plataforma_modulos] POST copiar-de perfil erro:', err.message);
    return res.status(500).json({ ok: false, message: 'Erro ao copiar módulos do perfil.' });
  }
});

export default router;
