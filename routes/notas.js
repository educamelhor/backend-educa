// routes/notas.js
import express from "express";
const router = express.Router();

router.get("/alunos/:id/notas", async (req, res) => {
  try {
    const [rows] = await db.query(
  `SELECT 
     d.nome      AS disciplina,
     n.ano,
     n.bimestre,
     n.nota,
     n.faltas
   FROM notas n
   LEFT JOIN disciplinas d
     ON d.id = n.disciplina_id
   WHERE n.aluno_id = ?
   ORDER BY n.ano, n.bimestre, d.nome`,
  [alunoId]
);
    return res.status(200).json(rows);
  } catch (err) {
    console.warn("Notas não encontradas ou erro:", err.code, err.message);
    return res.status(200).json([]);
  }
});

export default router;


