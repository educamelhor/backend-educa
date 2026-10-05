// api/routes/disciplinas.js
import { Router } from "express";
import pool from "../db.js";

const router = Router();


// Middleware para verificar se o usuário tem escola associada
function verificarEscola(req, res, next) {
  if (!req.user || !req.user.escola_id) {
    return res.status(403).json({ message: "Acesso negado: escola não definida." });
  }
  next();
}




/**
 * Modo de oferta: TURMA (turma regular) | AGRUPAMENTO (turma de agrupamento).
 * Padrão derivado do tipo; PCA (Percurso Comum de Aprofundamento) é TURMA por padrão,
 * mas a escola pode optar por AGRUPAMENTO.
 */
const MODOS_OFERTA_VALIDOS = ['TURMA', 'AGRUPAMENTO'];
const modoPadraoDoTipo = (tipo) => (['IFA', 'ELETIVA', 'PROJETO'].includes(String(tipo || '').toUpperCase()) ? 'AGRUPAMENTO' : 'TURMA');
const resolverModoOferta = (modo, tipo) => {
  const m = String(modo || '').toUpperCase();
  return MODOS_OFERTA_VALIDOS.includes(m) ? m : modoPadraoDoTipo(tipo);
};

/**
 * GET /api/disciplinas
 * Lista todas as disciplinas da escola do usuário
 */
router.get("/", verificarEscola, async (req, res) => {
  try {
    const userEscolaId = req.user.escola_id;
    const targetEscolaId = req.query.escola_id ? Number(req.query.escola_id) : userEscolaId;
    const { etapa, turno } = req.query;

    let sql = `
      SELECT 
        id,
        nome AS nome,
        nome AS disciplina,
        abreviatura,
        nome_oficial,
        tipo,
        modo_oferta,
        etapa,
        turno,
        carga,
        escola_id
      FROM disciplinas
      WHERE escola_id = ? AND mesclada_em IS NULL
    `;
    const params = [targetEscolaId];

    if (etapa) {
      sql += " AND UPPER(TRIM(etapa)) = ?";
      params.push(String(etapa).trim().toUpperCase());
    }

    if (turno) {
      sql += " AND (UPPER(TRIM(turno)) = ? OR UPPER(TRIM(turno)) IN ('DIURNO', 'GERAL', 'INTEGRAL'))";
      params.push(String(turno).trim().toUpperCase());
    }

    sql += " ORDER BY nome";

    const [rows] = await pool.query(sql, params);
    res.json(rows);
  } catch (err) {
    console.error("Erro ao listar disciplinas:", err);
    res.status(500).json({ error: "Não foi possível carregar as disciplinas." });
  }
});




/**
 * POST /api/disciplinas
 * Cria uma nova disciplina para a escola do usuário
 */
router.post("/", verificarEscola, async (req, res) => {
  const { nome, carga, etapa, turno, abreviatura, nome_oficial } = req.body;
  const { escola_id } = req.user;

  if (!nome || carga == null) {
    return res.status(400).json({ message: "Nome e carga são obrigatórios." });
  }

  const etapaFinal = etapa?.trim().toUpperCase() || "GERAL";
  const turnoFinal = turno?.trim().toUpperCase() || "INTEGRAL";
  const abreviaturaFinal = abreviatura && typeof abreviatura === 'string' && abreviatura.trim()
    ? abreviatura.trim().toUpperCase()
    : null;
  const nomeOficialFinal = nome_oficial && typeof nome_oficial === 'string' && nome_oficial.trim()
    ? nome_oficial.trim()
    : null;

  try {
    // ✅ Validação de unicidade: nome normalizado + escola_id (ignora mescladas)
    const nomeNormalizado = nome.trim();
    const tipoNovo = req.body.tipo || 'REGULAR';
    const [[existente]] = await pool.query(
       `SELECT id FROM disciplinas
        WHERE LOWER(TRIM(nome)) = LOWER(?) AND escola_id = ? AND mesclada_em IS NULL LIMIT 1`,
       [nomeNormalizado, escola_id]
    );
    if (existente) {
      return res.status(409).json({
        message: `Já existe a disciplina "${nomeNormalizado}" cadastrada nesta escola.`
      });
    }

    const [result] = await pool.query(
      `INSERT INTO disciplinas (nome, abreviatura, nome_oficial, tipo, modo_oferta, etapa, turno, carga, escola_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [nomeNormalizado, abreviaturaFinal, nomeOficialFinal, tipoNovo, resolverModoOferta(req.body.modo_oferta, tipoNovo), etapaFinal, turnoFinal, carga, escola_id]
    );

    const [rows] = await pool.query(
      `SELECT id, nome AS disciplina, abreviatura, nome_oficial, tipo, modo_oferta, etapa, turno, carga, escola_id
       FROM disciplinas
       WHERE id = ?`,
      [result.insertId]
    );

    res.status(201).json(rows[0]);
  } catch (err) {
    console.error("Erro ao criar disciplina:", err);
    res.status(500).json({ message: "Não foi possível criar a disciplina." });
  }
});




/**
 * DELETE /api/disciplinas/:id
 * Remove disciplina da escola do usuário
 */
router.delete("/:id", verificarEscola, async (req, res) => {
  try {
    const { id } = req.params;
    const { escola_id } = req.user;

    const [result] = await pool.query(
      "DELETE FROM disciplinas WHERE id = ? AND escola_id = ?",
      [id, escola_id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Disciplina não encontrada ou não pertence à sua escola." });
    }

    return res.json({ message: "Disciplina excluída com sucesso." });
  } catch (err) {
    // ✅ FIX ALTO 3: trata FK constraint — disciplina vinculada não pode ser excluída
    if (err.code === 'ER_ROW_IS_REFERENCED_2' || err.code === 'ER_ROW_IS_REFERENCED') {
      return res.status(409).json({
        message: "Não é possível excluir: esta disciplina está vinculada a professores, modulação ou planos de avaliação."
      });
    }
    console.error("Erro ao excluir disciplina:", err);
    return res.status(500).json({ message: "Erro ao excluir disciplina." });
  }
});




/**
 * PUT /api/disciplinas/:id
 * Atualiza disciplina da escola do usuário
 */
router.put("/:id", verificarEscola, async (req, res) => {
  try {
    const { id } = req.params;
    const { nome, carga, etapa, turno, abreviatura, nome_oficial } = req.body;
    const { escola_id } = req.user;

    if (!nome || carga == null) {
      return res.status(400).json({ message: "Nome e carga são obrigatórios." });
    }

    const etapaFinal = etapa?.trim().toUpperCase() || "GERAL";
    const turnoFinal = turno?.trim().toUpperCase() || "INTEGRAL";
    const abreviaturaFinal = abreviatura && typeof abreviatura === 'string' && abreviatura.trim()
      ? abreviatura.trim().toUpperCase()
      : null;

    // ✅ Validação de unicidade ao editar: exclui o próprio registro e registros mesclados
    const nomeNormalizado = nome.trim();
    const [[duplicada]] = await pool.query(
      `SELECT id FROM disciplinas
       WHERE LOWER(TRIM(nome)) = LOWER(?) AND escola_id = ? AND id != ? AND mesclada_em IS NULL LIMIT 1`,
      [nomeNormalizado, escola_id, id]
    );
    if (duplicada) {
      return res.status(409).json({
        message: `Já existe outra disciplina "${nomeNormalizado}" cadastrada nesta escola.`
      });
    }

    const tipoFinal = req.body.tipo || 'REGULAR';
    let updateSql = `UPDATE disciplinas SET nome = ?, abreviatura = ?, tipo = ?, etapa = ?, turno = ?, carga = ?`;
    const updateParams = [nomeNormalizado, abreviaturaFinal, tipoFinal, etapaFinal, turnoFinal, carga];

    if (nome_oficial !== undefined) {
      const nomeOficialFinal = typeof nome_oficial === 'string' && nome_oficial.trim() ? nome_oficial.trim() : null;
      updateSql = `UPDATE disciplinas SET nome = ?, abreviatura = ?, nome_oficial = ?, tipo = ?, etapa = ?, turno = ?, carga = ?`;
      updateParams.splice(2, 0, nomeOficialFinal);
    }

    // modo_oferta: respeita o enviado; se só o tipo veio, deriva do tipo; senão não altera
    if (req.body.modo_oferta !== undefined || req.body.tipo !== undefined) {
      updateSql += `, modo_oferta = ?`;
      updateParams.push(resolverModoOferta(req.body.modo_oferta, tipoFinal));
    }

    updateSql += `, updated_at = NOW() WHERE id = ? AND escola_id = ?`;
    updateParams.push(id, escola_id);

    const [result] = await pool.query(updateSql, updateParams);

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Disciplina não encontrada ou não pertence à sua escola." });
    }

    return res.json({ message: "Disciplina atualizada com sucesso." });
  } catch (err) {
    console.error("Erro ao atualizar disciplina:", err);
    res.status(500).json({ message: "Erro ao atualizar disciplina." });
  }
});

/**
 * ===============================================
 * ATUALIZAR NOME OFICIAL DA DISCIPLINA (Mapeamento)
 * PATCH /api/disciplinas/:id/nome-oficial
 * ===============================================
 */
router.patch("/:id/nome-oficial", verificarEscola, async (req, res) => {
  try {
    const { id } = req.params;
    const { nome_oficial } = req.body;
    const { escola_id } = req.user;

    await pool.query(
      "UPDATE disciplinas SET nome_oficial = ? WHERE id = ? AND escola_id = ?",
      [nome_oficial, id, escola_id]
    );

    return res.status(200).json({ success: true, message: "Nome oficial da disciplina atualizado com sucesso." });
  } catch (err) {
    console.error("Erro ao atualizar nome oficial da disciplina:", err);
    return res.status(500).json({ error: "Não foi possível atualizar o nome oficial da disciplina." });
  }
});

export default router;