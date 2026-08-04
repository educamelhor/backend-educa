import express from 'express';
import { autenticarToken } from '../middleware/auth.js';
import {
  listarEventos,
  criarEvento,
  atualizarEvento,
  excluirEvento
} from '../controllers/agendaPedagogicaController.js';

const router = express.Router();

router.use(autenticarToken);

router.get('/', listarEventos);
router.post('/', criarEvento);
router.put('/:id', atualizarEvento);
router.delete('/:id', excluirEvento);

export default router;
