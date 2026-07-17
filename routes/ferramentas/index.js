// src/routes/ferramentas/index.js
// ============================================================================
// Agregador das rotas de FERRAMENTAS
// Subcaminhos sob /api/ferramentas:
//   • /nota            → ferramentas_nota.js
//   • /unir            → ferramentasNotaUnificar.js
//   • /professores     → ferramentas_professor.js
//   • (raiz)           → ferramentas_aluno.js  → /converter-aluno
// Compatibilidade: mantém também /api/ferramentas/pdf-para-xlsx na RAIZ.
//   (o subrouter de professores expõe internamente "/pdf-para-xlsx")
// ============================================================================

import { Router } from "express";

import ferramentasNotaRouter from "../ferramentas_nota.js";
import ferramentasNotaUnificarRouter from "../ferramentasNotaUnificar.js";
import ferramentasProfessorRouter from "../ferramentas_professor.js";
import ferramentasAlunoRoutes from "../ferramentas_aluno.js";

const router = Router();

// Namespacing padrão
router.use("/nota", ferramentasNotaRouter);               // /api/ferramentas/nota/...
router.use("/unir", ferramentasNotaUnificarRouter);       // /api/ferramentas/unir/...
router.use("/professores", ferramentasProfessorRouter);   // /api/ferramentas/professores/...

// ⚠️ Monte primeiro as rotas de ALUNO na raiz (evita qualquer sombra)
router.use("/", ferramentasAlunoRoutes);

// Compatibilidade (LEGADO) para /api/ferramentas/pdf-para-xlsx
router.use("/", ferramentasProfessorRouter);

export default router;
