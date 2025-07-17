import pool from "../db.js";

// Função para salvar horários (inserir/atualizar várias alocações)
export const salvarHorarios = async (req, res) => {
  const horarios = req.body; // array de objetos { escola_id, professor_id, turma_id, disciplina_id, aulas }

  if (!horarios.length) {
    return res.status(400).json({ message: "Nenhum horário enviado." });
  }

  // Descubra o turno atual (pelo menos um registro deve ter turma_id ou ser null)
  let turno = null;
  if (horarios[0].turma_id) {
    // Buscar o turno da primeira turma
    const [rows] = await pool.query("SELECT turno FROM turmas WHERE id = ?", [horarios[0].turma_id]);
    turno = rows.length ? rows[0].turno : null;
  } else {
    // Se todos são turma_id null, pode pedir o turno via body, ou buscar pelo frontend (ajustável)
    // Exemplo: turno = horarios[0].turno;
    // Aqui, apenas por segurança, não faz nada se não encontrar turno
  }

  try {
    // 1. Se souber o turno, apague TODOS os horários dessa escola + turno antes de salvar os novos!
    if (turno) {
      // Descobre todas as turmas desse turno
      const [turmas] = await pool.query("SELECT id FROM turmas WHERE turno = ?", [turno]);
      const turmaIds = turmas.map(t => t.id);

      // Apaga todos os horários dessas turmas + registros turma_id null para a escola
      if (turmaIds.length) {
        await pool.query(
          `DELETE FROM horarios WHERE escola_id = ? AND (turma_id IN (${turmaIds.map(() => "?").join(",")}) OR turma_id IS NULL)`,
          [horarios[0].escola_id, ...turmaIds]
        );
      }
    }

    // 2. Agora, insere todos os horários novos normalmente
    for (const h of horarios) {
      await pool.query(
        `
        INSERT INTO horarios (escola_id, professor_id, turma_id, disciplina_id, aulas)
        VALUES (?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE aulas = VALUES(aulas)
        `,
        [h.escola_id, h.professor_id, h.turma_id, h.disciplina_id, h.aulas]
      );
    }

    res.json({ message: "Horários salvos com sucesso!" });
  } catch (err) {
    console.error("Erro ao salvar horários:", err);
    res.status(500).json({ message: "Erro ao salvar horários." });
  }
};




export const listarHorariosPorTurno = async (req, res) => {
  const { turno } = req.query;






              console.log("Recebido query turno:", turno);






  if (!turno) {
    return res.status(400).json({ erro: "Turno é obrigatório" });
  }
  try {
    // Turmas do turno
    const [turmas] = await pool.query(
      "SELECT id, nome FROM turmas WHERE turno = ?",
      [turno]
    );





         console.log("Turmas encontradas:", turmas);





    if (!turmas.length) {
      return res.json({ turmas: [], alocacoes: [] });
    }

    // IDs das turmas desse turno
    const turmaIds = turmas.map(t => t.id);






                       console.log("IDs das turmas:", turmaIds);
               






    // Alocações do turno (agora buscando por turma_id)
    let alocacoes = [];
    if (turmaIds.length) {
      // 1) pega todos com turma_id do turno
      const [resultComTurma] = await pool.query(
        `SELECT h.professor_id, h.disciplina_id, h.turma_id, h.aulas,
                p.nome AS professor_nome, d.nome AS disciplina_nome
           FROM horarios h
           JOIN professores p ON h.professor_id = p.id
           JOIN disciplinas d ON h.disciplina_id = d.id
          WHERE h.turma_id IN (${turmaIds.map(() => "?").join(",")})`,
        turmaIds
      );
      // 2) pega todos com turma_id null (professores apenas inseridos, sem alocação)
      const [resultSemTurma] = await pool.query(
        `SELECT h.professor_id, h.disciplina_id, h.turma_id, h.aulas,
                p.nome AS professor_nome, d.nome AS disciplina_nome
           FROM horarios h
           JOIN professores p ON h.professor_id = p.id
           JOIN disciplinas d ON h.disciplina_id = d.id
          WHERE h.turma_id IS NULL`
      );
      // Junta os dois
      alocacoes = [...resultComTurma, ...resultSemTurma];
    }













    res.json({ turmas, alocacoes });
  } catch (err) {









               console.error("Erro no backend listarHorariosPorTurno:", err);








    console.error(err);
    res.status(500).json({ erro: "Erro ao buscar horários" });
  }
};
