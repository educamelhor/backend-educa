// routes/escola-configuracao-grade.js
import express from express;
import pool from ../db.js;
const router = express.Router();

router.get(/, async (req, res) => {
  try {
    const { escola_id } = req.user;
    const [[row]] = await pool.query(SELECT id, turnos, dias_semana, periodos, criado_em, atualizado_em FROM escola_configuracao_grade WHERE escola_id = ? LIMIT 1, [escola_id]);
    if (!row) return res.json(null);
    return res.json({ id: row.id, turnos: parseJson(row.turnos, []), dias_semana: parseJson(row.dias_semana, [1,2,3,4,5]), periodos: parseJson(row.periodos, {}), criado_em: row.criado_em, atualizado_em: row.atualizado_em });
  } catch (err) {
    console.error([escola-config] GET erro:, err);
    return res.status(500).json({ message: Erro ao carregar configuracao. });
  }
});

router.post(/, async (req, res) => {
  try {
    const { escola_id } = req.user;
    const { turnos, dias_semana, periodos } = req.body || {};
    if (!Array.isArray(turnos) || turnos.length === 0) return res.status(400).json({ message: Informe ao menos um turno. });
    if (!Array.isArray(dias_semana) || dias_semana.length === 0) return res.status(400).json({ message: Informe os dias letivos. });
    if (!periodos || typeof periodos !== object) return res.status(400).json({ message: Informe os periodos por turno. });
    const turnosJson = JSON.stringify(turnos.map(t => String(t).toLowerCase()));
    const diasJson = JSON.stringify(dias_semana.map(Number));
    const periodosJson = JSON.stringify(periodos);
    const [[exists]] = await pool.query(SELECT id FROM escola_configuracao_grade WHERE escola_id = ? LIMIT 1, [escola_id]);
    if (exists && exists.id) {
      await pool.query(UPDATE escola_configuracao_grade SET turnos = ?, dias_semana = ?, periodos = ?, atualizado_em = NOW() WHERE escola_id = ?, [turnosJson, diasJson, periodosJson, escola_id]);
      return res.json({ ok: true, atualizado: true, id: exists.id });
    } else {
      const [ins] = await pool.query(INSERT INTO escola_configuracao_grade (escola_id, turnos, dias_semana, periodos, criado_em, atualizado_em) VALUES (?, ?, ?, ?, NOW(), NOW()), [escola_id, turnosJson, diasJson, periodosJson]);
      return res.json({ ok: true, atualizado: false, id: ins.insertId });
    }
  } catch (err) {
    console.error([escola-config] POST erro:, err);
    return res.status(500).json({ message: Erro ao salvar configuracao. });
  }
});

function parseJson(raw, fallback) {
  try {
    if (typeof raw === string) return JSON.parse(raw);
    if (Buffer.isBuffer(raw)) return JSON.parse(raw.toString(utf8));
    if (raw !== null && typeof raw === object) return raw;
  } catch { }
  return fallback;
}

export default router;
