// routes/monitoramento_painel.js
// ============================================================================
// Monitoramento — Painel de Turno (modo TV/mural)
// ----------------------------------------------------------------------------
// GET /api/monitoramento/painel?turno=matutino|vespertino|noturno
//   -> { ok, entraramAgora:[], atrasados:[], ausentes:[] }
//
// Regras (mínimas e escaláveis):
// - Multi-escola: filtra por req.user.escola_id (autenticarToken + verificarEscola)
// - "Entraram agora": reconhecidos na janela (N minutos, default 10)
// - "Atrasados": primeira entrada do dia após (horaInicioTurno + tolerânciaMin, default 15)
// - "Ausentes": alunos do turno que ainda não têm reconhecimento no dia
//
// Observações de dependência:
// - Usa tabela `monitoramento_eventos` (campos esperados):
//     id, escola_id, aluno_id, reconhecido (TINYINT 0/1), camera, created_at
//   Se sua tabela tiver nomes diferentes, ajuste as consultas abaixo.
// - Usa tabelas `alunos (id, codigo, estudante, turma_id, escola_id)` e
//   `turmas (id, nome, turno)`
// ============================================================================

import { Router } from "express";
import pool from "../db.js";
import { autenticarToken } from "../middleware/autenticarToken.js";
import { verificarEscola } from "../middleware/verificarEscola.js";

const router = Router();

// ---------------------------------------------------------------------------
// Configurações de hora de início dos turnos (podem ser sobrescritas via .env)
// ---------------------------------------------------------------------------
const TURNOS_INICIO = {
  matutino: process.env.TURNO_MATUTINO_INICIO || "07:00:00",
  vespertino: process.env.TURNO_VESPERTINO_INICIO || "13:00:00",
  noturno: process.env.TURNO_NOTURNO_INICIO || "19:00:00",
};

// Parâmetros padrão
const DEFAULT_JANELA_MIN = Number(process.env.PAINEL_JANELA_MIN || 10);       // "entraram agora"
const DEFAULT_TOL_MIN   = Number(process.env.PAINEL_TOLERANCIA_MIN || 15);    // atrasos

// Helper para gerar "YYYY-MM-DD HH:mm:ss" usando a data do servidor
function hojeHoraCompleta(hhmmss) {
  const agora = new Date();
  const yyyy = String(agora.getFullYear());
  const mm = String(agora.getMonth() + 1).padStart(2, "0");
  const dd = String(agora.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hhmmss}`;
}

// ---------------------------------------------------------------------------
// GET /painel
// ---------------------------------------------------------------------------
router.get("/painel", autenticarToken, verificarEscola, async (req, res) => {
  const { escola_id } = req.user;

  // Validação do turno
  const turno = String(req.query.turno || "").toLowerCase();
  if (!["matutino", "vespertino", "noturno"].includes(turno)) {
    return res.status(400).json({ ok: false, message: "Parametro 'turno' inválido." });
  }

  // Janela "entraram agora" e tolerância de atraso
  const janelaMin = Number(req.query.janelaMin || DEFAULT_JANELA_MIN);
  const toleranciaMin = Number(req.query.toleranciaMin || DEFAULT_TOL_MIN);

  // Hora de início do turno (string HH:mm:ss -> YYYY-MM-DD HH:mm:ss)
  const horaInicioTurno = TURNOS_INICIO[turno];
  const cutoffStr = hojeHoraCompleta(horaInicioTurno); // início do turno, hoje

  try {
    // -----------------------------------------------------------------------
    // 1) ENTRARAM AGORA (últimos X minutos no mesmo turno)
    // -----------------------------------------------------------------------
    const [entraramRows] = await pool.query(
      `
      SELECT 
        a.codigo,
        a.estudante AS nome,
        t.nome      AS turma,
        DATE_FORMAT(me.created_at, '%H:%i') AS \`when\`
      FROM monitoramento_eventos me
      INNER JOIN alunos a    ON a.id = me.aluno_id AND a.escola_id = ?
      LEFT  JOIN turmas t    ON t.id = a.turma_id
      WHERE 
        me.escola_id = ?
        AND me.reconhecido = 1
        AND DATE(me.created_at) = CURDATE()
        AND (t.turno = ? OR ? IS NULL)  -- segurança: se turma.turno vier nulo, não filtra
        AND me.created_at >= (NOW() - INTERVAL ? MINUTE)
      ORDER BY me.created_at DESC
      LIMIT 200
      `,
      [escola_id, escola_id, turno, turno, janelaMin]
    );

    // -----------------------------------------------------------------------
    // 2) ATRASADOS (primeira entrada depois de inicioTurno + tolerância)
    //     - pega a primeira entrada do aluno no dia e compara com cutoff+tol
    // -----------------------------------------------------------------------
    const [atrasadosRows] = await pool.query(
      `
      SELECT 
        x.aluno_id,
        x.codigo,
        x.nome,
        x.turma,
        DATE_FORMAT(x.primeira, '%H:%i') AS atraso
      FROM (
        SELECT 
          a.id         AS aluno_id,
          a.codigo,
          a.estudante  AS nome,
          t.nome       AS turma,
          MIN(me.created_at) AS primeira
        FROM monitoramento_eventos me
        INNER JOIN alunos a ON a.id = me.aluno_id AND a.escola_id = ?
        LEFT  JOIN turmas t ON t.id = a.turma_id
        WHERE 
          me.escola_id = ?
          AND me.reconhecido = 1
          AND DATE(me.created_at) = CURDATE()
          AND (t.turno = ? OR ? IS NULL)
        GROUP BY a.id, a.codigo, a.estudante, t.nome
      ) x
      WHERE x.primeira > (TIMESTAMP(?) + INTERVAL ? MINUTE)
      ORDER BY x.primeira ASC
      LIMIT 400
      `,
      [escola_id, escola_id, turno, turno, cutoffStr, toleranciaMin]
    );

    // -----------------------------------------------------------------------
    // 3) AUSENTES (no turno: não possuem reconhecimento no dia)
    // -----------------------------------------------------------------------
    const [ausentesRows] = await pool.query(
      `
      SELECT 
        a.codigo,
        a.estudante AS nome,
        t.nome      AS turma
      FROM alunos a
      INNER JOIN turmas t ON t.id = a.turma_id
      WHERE 
        a.escola_id = ?
        AND t.turno = ?
        AND a.id NOT IN (
          SELECT DISTINCT me.aluno_id
          FROM monitoramento_eventos me
          WHERE me.escola_id = ?
            AND me.reconhecido = 1
            AND DATE(me.created_at) = CURDATE()
        )
      ORDER BY t.nome, a.estudante
      LIMIT 2000
      `,
      [escola_id, turno, escola_id]
    );

    return res.json({
      ok: true,
      turno,
      entraramAgora: entraramRows,
      atrasados: atrasadosRows,
      ausentes: ausentesRows,
      meta: {
        janelaMin,
        toleranciaMin,
        inicioTurno: horaInicioTurno,
      },
    });
  } catch (err) {
    console.error("[monitoramento_painel] erro:", err);
    // Fallback seguro (sem derrubar a TV)
    return res.status(500).json({
      ok: false,
      message: "Erro ao montar painel do turno.",
      entraramAgora: [],
      atrasados: [],
      ausentes: [],
    });
  }
});

export default router;
