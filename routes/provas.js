import express from 'express';
import {
  listarProvas, obterProva, criarProva, atualizarProva, excluirProva,
  addQuestaoProva, removeQuestaoProva, atualizarItemProva, reordenarProva,
} from '../controllers/provasController.js';

const router = express.Router();

router.get('/',                           listarProvas);
router.get('/:id',                        obterProva);
router.post('/',                          criarProva);
router.put('/:id',                        atualizarProva);
router.delete('/:id',                     excluirProva);

// Itens da prova
router.post('/:id/questoes',              addQuestaoProva);
router.put('/:id/questoes/:itemId',       atualizarItemProva);
router.delete('/:id/questoes/:itemId',    removeQuestaoProva);
router.post('/:id/reordenar',             reordenarProva);

export default router;
