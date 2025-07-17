import express from "express";
import { salvarHorarios, listarHorariosPorTurno } from "../controllers/horariosController.js";

const router = express.Router();

// GET /api/horarios?turno=Vespertino
router.get("/", listarHorariosPorTurno);

// POST /api/horarios
router.post("/", salvarHorarios);

export default router;
