import { useEffect, useMemo, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ActivityIndicator, Alert, Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { router, useLocalSearchParams } from 'expo-router';

type AlunoResumo = {
  id: number;
  codigo: string | null;
  estudante: string;
  status: string; // "ativo" | "inativo"
  foto: string | null;
  turma_id: number | null;
};

const STORAGE_DEVICE_TOKEN = '@educa_capture:device_token';
const STORAGE_DEVICE_UID   = '@educa_capture:device_uid';

export default function CapturaScreen() {
  const params = useLocalSearchParams<{
    alunoId: string;
    turma_id?: string;
    nome?: string;
    foto?: string;
    nomeTurma?: string;
  }>();
  const alunoId    = String(params.alunoId || '');
  const turmaId    = String(params.turma_id || '').trim();
  // Dados pré-carregados via params (não precisam de fetch extra)
  const nomeParam     = String(params.nome     || '').trim();
  const fotoParam     = String(params.foto     || '').trim();
  const nomeTurmaParam = String(params.nomeTurma || '').trim();

  // Credenciais do dispositivo (AsyncStorage)
  const [deviceToken, setDeviceToken] = useState<string>('');
  const [deviceUid,   setDeviceUid]   = useState<string>('');

  useEffect(() => {
    async function loadCreds() {
      const tk = await AsyncStorage.getItem(STORAGE_DEVICE_TOKEN).catch(() => null);
      const uid = await AsyncStorage.getItem(STORAGE_DEVICE_UID).catch(() => null);
      if (tk)  setDeviceToken(tk);
      if (uid) setDeviceUid(uid);
    }
    loadCreds();
  }, []);

  const [alunoInfo, setAlunoInfo] = useState<AlunoResumo | null>(null);
  const [isLoadingAluno, setIsLoadingAluno] = useState(false);
  const [alunoErr, setAlunoErr] = useState<string | null>(null);

  const cameraRef = useRef<CameraView | null>(null);
  const [permission, requestPermission] = useCameraPermissions();

  const [frameSize, setFrameSize] = useState({ w: 0, h: 0 });
  const [isCapturing, setIsCapturing] = useState(false);

  const [photoUri, setPhotoUri] = useState<string | null>(null);

  // Cache-busting: fixado ao montar a tela para forçar reload da foto no RN
  const [mountTs] = useState(() => Date.now());

  // Upload (PASSO 3.3.5)
  const [isUploading, setIsUploading] = useState(false);

  const API_BASE = String(process.env.EXPO_PUBLIC_API_BASE_URL || '').trim();
  // DEVICE_UID e DEVICE_TOKEN vêm do AsyncStorage (ver useEffect acima)
  const DEVICE_UID = deviceUid;
  const DEVICE_TOKEN = deviceToken;

  // Turma (PASSO 1.6) — buscar via endpoint dedicado /api/capture/turmas/:id
  const [turmaInfo, setTurmaInfo] = useState<null | {
    id: number;
    nome: string;
    serie: string | null;
    turno: string | null;
  }>(null);
  const [isLoadingTurma, setIsLoadingTurma] = useState(false);
  const [turmaErr, setTurmaErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;

    async function loadTurma() {
      try {
        setTurmaErr(null);
        setTurmaInfo(null);

        const turmaIdNum = Number(turmaId);
        if (!turmaIdNum || turmaIdNum <= 0) return;

        if (!API_BASE || !DEVICE_UID || !DEVICE_TOKEN) return;

        setIsLoadingTurma(true);

        const url = `${API_BASE}/api/capture/turmas/${encodeURIComponent(String(turmaIdNum))}`;

        const resp = await fetch(url, {
          method: 'GET',
          headers: {
            Authorization: `Device ${DEVICE_TOKEN}`,
            'x-device-uid': DEVICE_UID,
            Accept: 'application/json',
          },
        });

        const data = await resp.json().catch(() => null);

        if (!resp.ok || !data?.ok) {
          const msg = data?.message || `Falha ao carregar turma (HTTP ${resp.status}).`;
          throw new Error(msg);
        }

        const t = data?.turma || null;
        if (!t) throw new Error('Resposta sem turma.');

        const normalized = {
          id: Number(t.id),
          nome: String(t.nome || '').trim(),
          serie: t.serie != null ? String(t.serie) : null,
          turno: t.turno != null ? String(t.turno) : null,
        };

        if (alive) setTurmaInfo(normalized);
      } catch (e: any) {
        if (alive) setTurmaErr(String(e?.message || e || 'Erro ao carregar turma.'));
      } finally {
        if (alive) setIsLoadingTurma(false);
      }
    }

    loadTurma();
    return () => {
      alive = false;
    };
  }, [API_BASE, DEVICE_UID, DEVICE_TOKEN, turmaId]);;

  const fotoUrl = useMemo(() => {
    const raw = alunoInfo?.foto ? String(alunoInfo.foto) : '';
    if (!raw || !API_BASE) return null;
    // Cache-busting: ?t=mountTs garante que o RN não use a versão em cache
    const base = /^https?:\/\//i.test(raw)
      ? raw
      : raw.startsWith('/')
      ? `${API_BASE}${raw}`
      : `${API_BASE}/${raw}`;
    return `${base}?t=${mountTs}`;
  }, [API_BASE, alunoInfo?.foto, mountTs]);

  useEffect(() => {
    let alive = true;

    async function loadAluno() {
      try {
        setAlunoErr(null);
        setAlunoInfo(null);

        const alunoIdNum = Number(alunoId);
        const turmaIdNum = Number(turmaId);

        // Sem turma_id não conseguimos buscar o aluno com precisão sem endpoint próprio.
        if (!alunoIdNum || alunoIdNum <= 0) return;
        if (!turmaIdNum || turmaIdNum <= 0) return;

        if (!API_BASE || !DEVICE_UID || !DEVICE_TOKEN) return;

        setIsLoadingAluno(true);

        const url = `${API_BASE}/api/capture/alunos?turma_id=${encodeURIComponent(String(turmaIdNum))}`;

        const resp = await fetch(url, {
          method: 'GET',
          headers: {
            Authorization: `Device ${DEVICE_TOKEN}`,
            'x-device-uid': DEVICE_UID,
            Accept: 'application/json',
          },
        });

        const data = await resp.json().catch(() => null);

        if (!resp.ok || !data?.ok) {
          const msg = data?.message || `Falha ao carregar aluno (HTTP ${resp.status}).`;
          throw new Error(msg);
        }

        const list = Array.isArray(data?.alunos) ? data.alunos : [];
        const found = list.find((a: any) => Number(a?.id) === alunoIdNum) || null;

        if (!found) {
          throw new Error('Aluno não encontrado nesta turma (verifique turma_id).');
        }

        const normalized: AlunoResumo = {
          id: Number(found.id),
          codigo: found.codigo != null ? String(found.codigo) : null,
          estudante: String(found.estudante || '').trim(),
          status: String(found.status || '').trim().toLowerCase(),
          foto: found.foto != null ? String(found.foto) : null,
          turma_id: found.turma_id != null ? Number(found.turma_id) : null,
        };

        if (alive) setAlunoInfo(normalized);
      } catch (e: any) {
        if (alive) setAlunoErr(String(e?.message || e || 'Erro ao carregar aluno.'));
      } finally {
        if (alive) setIsLoadingAluno(false);
      }
    }

    loadAluno();
    return () => {
      alive = false;
    };
  }, [API_BASE, DEVICE_UID, DEVICE_TOKEN, alunoId, turmaId]);

  // Zoom (pinça)
  const [zoom, setZoom] = useState(0); // 0..1 (depende do device)
  const pinchRef = useRef<{ startDist: number; startZoom: number }>({ startDist: 0, startZoom: 0 });

  const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

  const dist2 = (t1: any, t2: any) => {
    const dx = t1.pageX - t2.pageX;
    const dy = t1.pageY - t2.pageY;
    return Math.sqrt(dx * dx + dy * dy);
  };

  const overlay = useMemo(() => {
    const w = frameSize.w;
    const h = frameSize.h;

    const minSide = Math.min(w, h);

    // Elipse menor (print 2): permite maior distância do aluno
    const ellipseW = Math.floor(minSide * 0.52);
    const ellipseH = Math.floor(ellipseW * 1.25);

    const left = Math.floor((w - ellipseW) / 2);
    const top = Math.floor((h - ellipseH) / 2);

    return { w, h, ellipseW, ellipseH, left, top };
  }, [frameSize]);

  return (
    <View style={styles.container}>
      {/* Cabeçalho: nome do aluno em destaque + miniatura e detalhes */}
      <View style={styles.alunoCard}>
        {/* Nome — exibido com prioridade máxima */}
        <Text style={styles.alunoNome} numberOfLines={2}>
          {alunoInfo?.estudante || nomeParam || `Aluno #${alunoId}`}
        </Text>

        {/* Row: miniatura + detalhes secundários */}
        <View style={styles.alunoHeader}>
          {(fotoUrl || fotoParam) ? (
            <Image
              source={{ uri: fotoUrl || (fotoParam && API_BASE ? (fotoParam.startsWith('/') ? `${API_BASE}${fotoParam}` : `${API_BASE}/${fotoParam}`) : fotoParam) }}
              style={styles.foto}
            />
          ) : (
            <View style={[styles.foto, styles.fotoPlaceholder]}>
              <Text style={styles.fotoPlaceholderTxt}>📷</Text>
            </View>
          )}
          <View style={styles.alunoHeaderText}>
            {(turmaInfo?.nome || nomeTurmaParam) ? (
              <Text style={styles.sub}>
                Turma: {turmaInfo?.nome || nomeTurmaParam}
                {turmaInfo?.turno ? ` • ${turmaInfo.turno}` : ''}
              </Text>
            ) : null}
            {alunoInfo?.codigo ? (
              <Text style={styles.sub}>Cód: {alunoInfo.codigo}</Text>
            ) : null}
          </View>
        </View>
      </View>

      {/* Área de câmera + overlay */}
      <View
        style={styles.cameraFrame}
        onLayout={(e) => {
          const { width, height } = e.nativeEvent.layout;
          setFrameSize({ w: Math.floor(width), h: Math.floor(height) });
        }}
      >
        {/* Permissão */}
        {!permission ? (
          <View style={styles.center}>
            <ActivityIndicator />
            <Text style={styles.helpText}>Carregando permissão da câmera…</Text>
          </View>
        ) : !permission.granted ? (
          <View style={styles.center}>
            <Text style={styles.helpTitle}>Permissão necessária</Text>
            <Text style={styles.helpText}>
              Para capturar a foto do aluno, permita o acesso à câmera.
            </Text>
            <Pressable onPress={requestPermission} style={styles.primaryBtn}>
              <Text style={styles.primaryBtnTxt}>Permitir câmera</Text>
            </Pressable>
          </View>
        ) : (
          <>
            <CameraView
              ref={(r) => (cameraRef.current = r)}
              style={styles.camera}
              facing="back"
              zoom={zoom}
            />

            {/* Camada de gesto (pinça) — fica acima da câmera e abaixo do overlay visual */}
            <View
              style={StyleSheet.absoluteFill}
              pointerEvents={photoUri ? 'none' : 'auto'}
              onTouchStart={(e) => {
                const touches = e.nativeEvent.touches;
                if (touches && touches.length === 2) {
                  pinchRef.current.startDist = dist2(touches[0], touches[1]);
                  pinchRef.current.startZoom = zoom;
                }
              }}
              onTouchMove={(e) => {
                const touches = e.nativeEvent.touches;
                if (touches && touches.length === 2) {
                  const d = dist2(touches[0], touches[1]);
                  if (pinchRef.current.startDist > 0) {
                    const ratio = d / pinchRef.current.startDist;

                    // Ajuste suave: cada ~1.0 de ratio altera zoom moderadamente
                    const next = pinchRef.current.startZoom + (ratio - 1) * 0.35;

                    // Range seguro (evita zoom digital exagerado)
                    setZoom(clamp(next, 0, 0.8));
                  }
                }
              }}
              onTouchEnd={() => {
                pinchRef.current.startDist = 0;
              }}
            />

            {/* Máscara escurecida fora da elipse (4 blocos) */}
            {overlay.w > 0 && overlay.h > 0 ? (
              <View pointerEvents="none" style={StyleSheet.absoluteFill}>
                <View style={[styles.mask, { height: overlay.top }]} />
                <View style={styles.row}>
                  <View style={[styles.mask, { width: overlay.left, height: overlay.ellipseH }]} />
                  <View style={{ width: overlay.ellipseW, height: overlay.ellipseH }} />
                  <View style={[styles.mask, { width: overlay.left, height: overlay.ellipseH }]} />
                </View>
                <View style={[styles.mask, { flex: 1 }]} />

                {/* Borda da elipse + guia */}
                <View
                  style={[
                    styles.ellipse,
                    {
                      width: overlay.ellipseW,
                      height: overlay.ellipseH,
                      left: overlay.left,
                      top: overlay.top,
                      borderRadius: Math.floor(overlay.ellipseW / 2),
                    },
                  ]}
                />

                <Text
                  style={[
                    styles.guideText,
                    { top: overlay.top + overlay.ellipseH + 18 },
                  ]}
                >
                  Centralize o rosto dentro da elipse
                </Text>

                <Text
                  style={[
                    styles.zoomText,
                    { top: overlay.top + overlay.ellipseH + 40 },
                  ]}
                >
                  Zoom: {(1 + zoom * 2).toFixed(1)}x (pinça)
                </Text>
              </View>
            ) : null}
          </>
        )}
      </View>

      {/* Botões */}
      {!photoUri ? (
        <Pressable
          onPress={async () => {
            if (!cameraRef.current || isCapturing) return;
            try {
              setIsCapturing(true);
              const photo = await cameraRef.current.takePictureAsync({
                quality: 0.9,
                skipProcessing: false,
              });

              const uri = photo?.uri || null;
              setPhotoUri(uri);

              await (cameraRef.current as any)?.pausePreview?.();

              console.log('[CAPTURE] alunoId=', alunoId, 'uri=', uri);
            } finally {
              setIsCapturing(false);
            }
          }}
          style={[styles.captureBtn, isCapturing && styles.captureBtnDisabled]}
          disabled={isCapturing || !permission?.granted}
        >
          <Text style={styles.captureBtnTxt}>
            {isCapturing ? 'Capturando…' : 'Capturar'}
          </Text>
        </Pressable>
      ) : (
        <View style={styles.actionRow}>
          <Pressable
            onPress={async () => {
              setPhotoUri(null);
              await (cameraRef.current as any)?.resumePreview?.();
            }}
            style={styles.secondaryBtn}
          >
            <Text style={styles.secondaryBtnTxt}>Refazer</Text>
          </Pressable>

          <Pressable
            onPress={async () => {
              if (!photoUri || isUploading) return;

              const alunoIdNum = Number(alunoId);
              if (!alunoIdNum || alunoIdNum <= 0) {
                Alert.alert('Erro', 'alunoId inválido para upload.');
                return;
              }

              // Validação factual (sem vazar segredo)
              const uidLen = DEVICE_UID.length;
              const tokenLen = DEVICE_TOKEN.length;

              const apiLower = API_BASE.toLowerCase();
              const isPlaceholder = (v: string) => /seu_/i.test(v);

              if (!API_BASE) {
                Alert.alert(
                  'Configuração ausente',
                  'API_BASE_URL não configurada (EXPO_PUBLIC_API_BASE_URL).'
                );
                return;
              }

              // Bloqueia URLs inválidas/placeholder (evita "funcionar errado" silenciosamente)
              if (isPlaceholder(API_BASE) || apiLower.includes('seu_ip') || apiLower.includes('seu_host')) {
                Alert.alert(
                  'Configuração inválida',
                  'API_BASE_URL ainda está com placeholder (SEU_IP/SEU_HOST). Ajuste o .env do app.'
                );
                return;
              }

              // Em dispositivo físico, localhost/127.0.0.1 não apontam para o PC
              if (apiLower.includes('localhost') || apiLower.includes('127.0.0.1')) {
                Alert.alert(
                  'Configuração inválida',
                  'API_BASE_URL está usando localhost/127.0.0.1. Em iPhone isso não funciona — use o IP do PC.'
                );
                return;
              }

              // Bloqueia UID placeholder comum
              if (isPlaceholder(DEVICE_UID) || DEVICE_UID === 'SEU_DEVICE_UID' || DEVICE_UID === 'DEVICE_UID') {
                Alert.alert(
                  'Configuração inválida',
                  'DEVICE_UID está com placeholder. Ajuste o .env do app.'
                );
                return;
              }

              if (uidLen < 6 || tokenLen < 20) {
                console.log('[CONFIG] invalid device config', {
                  apiBase: API_BASE,
                  deviceUidLen: uidLen,
                  deviceTokenLen: tokenLen,
                });

                Alert.alert(
                  'Configuração inválida',
                  `DEVICE_UID/DEVICE_TOKEN inválidos. (uidLen=${uidLen}, tokenLen=${tokenLen})\nVerifique o .env do app.`
                );
                return;
              }

              try {
                setIsUploading(true);

                const url = `${API_BASE}/api/capture/upload`;

                console.log('[UPLOAD] POST', url);
                console.log('[UPLOAD] alunoId=', alunoIdNum, 'photoUri=', photoUri);
                console.log('[UPLOAD] device_uid=', DEVICE_UID, 'tokenLen=', String(DEVICE_TOKEN || '').length);

                const form = new FormData();
                form.append('aluno_id', String(alunoIdNum));
                form.append('file', {
                  uri: photoUri,
                  name: `aluno_${alunoIdNum}.jpg`,
                  type: 'image/jpeg',
                } as any);

                const resp = await fetch(url, {
                  method: 'POST',
                  headers: {
                    Authorization: `Device ${DEVICE_TOKEN}`,
                    'x-device-uid': DEVICE_UID,
                    Accept: 'application/json',
                    // NÃO setar Content-Type aqui (RN/fetch define boundary do multipart)
                  },
                  body: form,
                });

                const data = await resp.json().catch(() => null);

                if (!resp.ok || !data?.ok) {
                  const msg = data?.message || `Falha no upload (HTTP ${resp.status})`;
                  Alert.alert('Upload falhou', msg);
                  return;
                }

                Alert.alert('Sucesso', 'Foto enviada e atualizada no servidor.');
                setPhotoUri(null);
                await (cameraRef.current as any)?.resumePreview?.();
                router.back();
              } catch (e: any) {
                Alert.alert('Erro', e?.message || 'Erro inesperado no upload.');
              } finally {
                setIsUploading(false);
              }
            }}
            style={[styles.captureBtn, isUploading && styles.captureBtnDisabled]}
            disabled={isUploading}
          >
            <Text style={styles.captureBtnTxt}>{isUploading ? 'Enviando…' : 'Usar foto'}</Text>
          </Pressable>
        </View>
      )}

      <Pressable onPress={() => router.back()} style={styles.btn}>
        <Text style={styles.btnTxt}>Voltar</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 16,
    gap: 14,
  },
  title: {
    fontSize: 22,
    fontWeight: '800',
  },
  sub: {
    fontSize: 13,
    color: '#555',
  },
  alunoCard: {
    gap: 8,
  },
  alunoNome: {
    fontSize: 15,
    fontWeight: '800',
    color: '#fff',
    lineHeight: 21,
  },
  fotoBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  foto: {
    width: 54,
    height: 54,
    borderRadius: 12,
    backgroundColor: '#111',
  },
  fotoTxt: {
    fontSize: 12,
    color: '#555',
    fontWeight: '700',
  },
  alunoHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingBottom: 4,
  },
  alunoHeaderText: {
    flex: 1,
    gap: 2,
  },
  fotoPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#e2e8f0',
  },
  fotoPlaceholderTxt: {
    fontSize: 22,
  },
  cameraFrame: {
    flex: 1,
    borderRadius: 18,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#1f1f1f',
    backgroundColor: '#000',
  },
  camera: {
    flex: 1,
  },
  mask: {
    backgroundColor: 'rgba(0,0,0,0.65)',
  },
  row: {
    flexDirection: 'row',
  },
  ellipse: {
    position: 'absolute',
    borderWidth: 3,
    borderColor: '#ffffff',
  },
  zoomText: {
    position: 'absolute',
    alignSelf: 'center',
    color: 'rgba(255,255,255,0.8)',
    fontSize: 12,
    fontWeight: '700',
  },
  guideText: {
    position: 'absolute',
    alignSelf: 'center',
    color: '#fff',
    fontSize: 13,
    fontWeight: '700',
    opacity: 0.9,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    padding: 16,
  },
  helpTitle: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '800',
    textAlign: 'center',
  },
  helpText: {
    color: 'rgba(255,255,255,0.85)',
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 18,
  },
  primaryBtn: {
    marginTop: 6,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 14,
    backgroundColor: '#fff',
    alignItems: 'center',
  },
  primaryBtnTxt: {
    color: '#111',
    fontWeight: '900',
  },
  captureBtn: {
    paddingVertical: 14,
    borderRadius: 14,
    backgroundColor: '#16a34a',
    alignItems: 'center',
  },
  captureBtnDisabled: {
    opacity: 0.5,
  },
  captureBtnTxt: {
    color: '#fff',
    fontWeight: '900',
    fontSize: 16,
  },
  actionRow: {
    flexDirection: 'row',
    gap: 10,
  },
  secondaryBtn: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 14,
    backgroundColor: '#334155',
    alignItems: 'center',
  },
  secondaryBtnTxt: {
    color: '#fff',
    fontWeight: '900',
    fontSize: 16,
  },
  btn: {
    paddingVertical: 12,
    borderRadius: 14,
    backgroundColor: '#111',
    alignItems: 'center',
  },
  btnTxt: {
    color: '#fff',
    fontWeight: '800',
  },
});