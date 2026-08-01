// seed_noticias.js
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import fs from 'fs';
import path from 'path';
import pool from './db.js';
import 'dotenv/config';

const IMAGENS_DIR = 'C:/projetos/sistema_educacional/geral/IMAGENS/card_noticias';

const TITULOS = [
  'Bem-vinda, Equipe! 2o Semestre',
  'Comunicado Escolar',
  'Informativo da Escola',
  'Aviso Importante',
  'Novidades do Semestre',
  'Evento Escolar',
  'Recado da Direcao',
  'Comunicado aos Pais',
];

const args = process.argv.slice(2);
const escolaArg = args.find(a => a.startsWith('--escola-id='));
const ESCOLA_ID = escolaArg ? parseInt(escolaArg.split('=')[1]) : null;

if (!ESCOLA_ID) {
  console.error('ERRO: Informe --escola-id=<ID>. Ex: node seed_noticias.js --escola-id=1');
  process.exit(1);
}

const S3_ENDPOINT = process.env.DO_SPACES_ENDPOINT || process.env.SPACES_ENDPOINT;
const S3_KEY      = process.env.DO_SPACES_KEY      || process.env.SPACES_KEY;
const S3_SECRET   = process.env.DO_SPACES_SECRET   || process.env.SPACES_SECRET;
const S3_BUCKET   = process.env.DO_SPACES_BUCKET   || process.env.SPACES_BUCKET;
const S3_REGION   = process.env.DO_SPACES_REGION   || process.env.SPACES_REGION || 'nyc3';

const s3 = new S3Client({
  endpoint: S3_ENDPOINT.startsWith('http') ? S3_ENDPOINT : 'https://' + S3_ENDPOINT,
  region: S3_REGION,
  credentials: { accessKeyId: S3_KEY, secretAccessKey: S3_SECRET },
  forcePathStyle: false,
});

async function uploadImagem(filePath, s3Key) {
  const buffer = fs.readFileSync(filePath);
  await s3.send(new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: s3Key,
    Body: buffer,
    ContentType: 'image/jpeg',
    ACL: 'public-read',
  }));
  return 'https://' + S3_BUCKET + '.' + S3_ENDPOINT.replace('https://', '') + '/uploads/' + s3Key.replace('uploads/', '');
}

async function main() {
  const files = fs.readdirSync(IMAGENS_DIR).filter(f => /\.(jpg|jpeg|png)$/i.test(f)).sort();
  console.log('[SEED] ' + files.length + ' imagens encontradas.');
  if (!files.length) { console.error('Nenhuma imagem em ' + IMAGENS_DIR); process.exit(1); }

  const db = pool;
  let count = 0;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const filePath = path.join(IMAGENS_DIR, file);
    const s3Key = 'uploads/noticias/escola_' + ESCOLA_ID + '/' + Date.now() + '_' + (i+1) + '.jpg';

    console.log('[SEED] Fazendo upload: ' + file + ' ...');
    let imagemUrl;
    try {
      imagemUrl = await uploadImagem(filePath, s3Key);
      console.log('  => ' + imagemUrl);
    } catch (e) {
      console.error('  ERRO no upload de ' + file + ':', e.message);
      continue;
    }

    const titulo = TITULOS[i] || 'Comunicado ' + (i + 1);

    await db.query(
      'INSERT INTO noticias (escola_id, titulo, imagem_url, ativo) VALUES (?, ?, ?, 1)',
      [ESCOLA_ID, titulo, imagemUrl]
    );
    count++;
    console.log('  Inserida: ' + titulo);
  }

  console.log('[SEED] Concluido! ' + count + ' noticias inseridas.');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
