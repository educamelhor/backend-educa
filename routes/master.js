import express from 'express';
import { autenticarToken } from '../middleware/autenticarToken.js';
import {
  listarMaster, obterMaster, criarMasterQuestao,
  editarMaster, publicarMaster, excluirMaster,
  buscarMaster, importarLoteMaster
} from '../controllers/masterController.js';

const router = express.Router();

router.get('/buscar', buscarMaster);                       // pública
router.get('/', autenticarToken, listarMaster);
router.get('/:id', autenticarToken, obterMaster);
router.post('/', autenticarToken, criarMasterQuestao);
router.post('/importar-lote', autenticarToken, importarLoteMaster);
router.patch('/:id/publicar', autenticarToken, publicarMaster);
router.patch('/:id', autenticarToken, editarMaster);
router.delete('/:id', autenticarToken, excluirMaster);

export default router;
