import express from 'express';
import { autenticarToken } from '../middleware/autenticarToken.js';
import {
  listarMaster, obterMaster, criarMasterQuestao,
  editarMaster, publicarMaster, excluirMaster,
  buscarMaster, importarLoteMaster
} from '../controllers/masterController.js';

const router = express.Router();

router.get('/buscar',                           buscarMaster);                       // pública
router.get('/questoes',        autenticarToken, listarMaster);
router.get('/questoes/:id',    autenticarToken, obterMaster);
router.post('/questoes',       autenticarToken, criarMasterQuestao);
router.post('/importar-lote',  autenticarToken, importarLoteMaster);
router.patch('/questoes/:id/publicar', autenticarToken, publicarMaster);
router.patch('/questoes/:id',          autenticarToken, editarMaster);
router.delete('/questoes/:id',         autenticarToken, excluirMaster);

export default router;
