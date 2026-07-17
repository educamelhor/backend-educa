import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Stack, router } from 'expo-router';

// ─── Tipos ────────────────────────────────────────────────────────────────────

type Turma = {
  id: number;
  nome: string;
  turno: string;
  serie?: string | null;
};

// ─── Constantes de storage ────────────────────────────────────────────────────

const STORAGE_DEVICE_TOKEN = '@educa_capture:device_token';
const STORAGE_DEVICE_UID   = '@educa_capture:device_uid';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function turnoLabel(raw: string) {
  const t = String(raw || '').trim();
  if (!t) return '';
  return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
}

// ─── Fase do app ──────────────────────────────────────────────────────────────

type AppPhase =
  | 'loading'          // verificando storage / carregando
  | 'ask_access_code'  // 1ª tela: usuário digita o access_code da escola
  | 'pairing'          // exibindo pair_code + QR para o diretor aprovar
  | 'polling'          // aguardando aprovação do diretor (polling silencioso)
  | 'ready';           // autenticado — exibe menu de turnos/turmas

// ─── Componente ───────────────────────────────────────────────────────────────

export default function MenuScreen() {
  const API_BASE  = String(process.env.EXPO_PUBLIC_API_BASE_URL || '').trim();
  const DEVICE_UID_ENV = String(process.env.EXPO_PUBLIC_CAPTURE_DEVICE_UID || '').trim();

  // ── Estado global ──────────────────────────────────────────────────────────
  const [phase, setPhase]           = useState<AppPhase>('loading');
  const [deviceToken, setDeviceToken] = useState<string | null>(null);
  const [deviceUid, setDeviceUid]   = useState<string>(DEVICE_UID_ENV);
  const [errorMsg, setErrorMsg]     = useState<string | null>(null);

  // ── Fase: ask_access_code ──────────────────────────────────────────────────
  const [accessCodeInput, setAccessCodeInput] = useState('');
  const [accessCodeLoading, setAccessCodeLoading] = useState(false);
  const [accessCodeError, setAccessCodeError]   = useState<string | null>(null);

  // ── Fase: pairing ──────────────────────────────────────────────────────────
  const [pairCode, setPairCode]         = useState<string | null>(null);
  const [pairExpiresAt, setPairExpiresAt] = useState<string | null>(null);
  const [qrPayload, setQrPayload]       = useState<string | null>(null);
  const [pairingMsg, setPairingMsg]     = useState<string | null>(null);

  // ── Fase: ready ────────────────────────────────────────────────────────────
  const [isLoading, setIsLoading]           = useState(false);
  const [isLoadingTurmas, setIsLoadingTurmas] = useState(false);
  const [turnos, setTurnos]       = useState<string[]>([]);
  const [turno, setTurno]         = useState<string>('');
  const [turmasRaw, setTurmasRaw] = useState<Turma[]>([]);
  const [turmaStats, setTurmaStats] = useState<
    Record<string, { ok: number; pend: number; loading: boolean }>
  >({});

  const escolaNome = 'EDUCA-CAPTURE';

  // ── Confirmação de desvinculação ───────────────────────────────────────────
  const [showUnlinkConfirm, setShowUnlinkConfirm] = useState(false);

  // ── Ref para polling ───────────────────────────────────────────────────────
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ─────────────────────────────────────────────────────────────────────────
  // 1) Inicialização: verificar se já existe device_token no storage
  // ─────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const storedToken = await AsyncStorage.getItem(STORAGE_DEVICE_TOKEN);
        const storedUid   = await AsyncStorage.getItem(STORAGE_DEVICE_UID);

        if (storedUid) setDeviceUid(storedUid);

        if (storedToken) {
          // Tem token — tentar autenticar
          setDeviceToken(storedToken);
          if (alive) setPhase('ready');
        } else {
          // Sem token — pedir access_code
          if (alive) setPhase('ask_access_code');
        }
      } catch {
        if (alive) setPhase('ask_access_code');
      }
    })();
    return () => { alive = false; };
  }, []);

  // ─────────────────────────────────────────────────────────────────────────
  // 2) Quando 'ready': carregar turnos (valida token)
  // ─────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (phase !== 'ready') return;
    let alive = true;

    (async () => {
      try {
        setIsLoading(true);
        setErrorMsg(null);

        if (!API_BASE) throw new Error('EXPO_PUBLIC_API_BASE_URL não configurada.');

        const token = deviceToken ?? await AsyncStorage.getItem(STORAGE_DEVICE_TOKEN);
        const uid   = deviceUid   || await AsyncStorage.getItem(STORAGE_DEVICE_UID) || '';

        const resp = await fetch(`${API_BASE}/api/capture/turnos`, {
          method: 'GET',
          headers: {
            Authorization: `Device ${token}`,
            'x-device-uid': uid,
            Accept: 'application/json',
          },
        });

        const data = await resp.json().catch(() => null);

        // Token inválido → limpa e volta ao início
        if (!resp.ok) {
          const msg = String(data?.message || '');
          if (resp.status === 401 && msg.toLowerCase().includes('device_token')) {
            await AsyncStorage.removeItem(STORAGE_DEVICE_TOKEN);
            if (alive) {
              setDeviceToken(null);
              setPhase('ask_access_code');
              setPairingMsg('Token inválido. Solicite novo credenciamento.');
            }
            return;
          }
          throw new Error(data?.message || `Falha ao carregar turnos (HTTP ${resp.status}).`);
        }

        if (!alive) return;
        const list    = Array.isArray(data?.turnos) ? data.turnos : [];
        const cleaned = list.map((x: any) => String(x || '').trim()).filter(Boolean);
        setTurnos(cleaned);
        setTurno((prev) => prev || cleaned[0] || '');
      } catch (e: any) {
        if (!alive) return;
        setErrorMsg(String(e?.message || e || 'Erro ao carregar turnos.'));
      } finally {
        if (!alive) return;
        setIsLoading(false);
      }
    })();

    return () => { alive = false; };
  }, [phase, deviceToken]);

  // ─────────────────────────────────────────────────────────────────────────
  // 3) Carregar turmas quando turno muda (fase 'ready')
  // ─────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (phase !== 'ready') return;
    let alive = true;

    (async () => {
      try {
        setIsLoadingTurmas(true);
        setErrorMsg(null);
        if (!turno) { if (alive) setTurmasRaw([]); return; }

        const token = deviceToken ?? await AsyncStorage.getItem(STORAGE_DEVICE_TOKEN);
        const uid   = deviceUid   || await AsyncStorage.getItem(STORAGE_DEVICE_UID) || '';

        const url  = `${API_BASE}/api/capture/turmas?turno=${encodeURIComponent(turno)}`;
        const resp = await fetch(url, {
          method: 'GET',
          headers: {
            Authorization: `Device ${token}`,
            'x-device-uid': uid,
            Accept: 'application/json',
          },
        });

        const data = await resp.json().catch(() => null);
        if (!resp.ok) throw new Error(data?.message || `Falha ao carregar turmas (HTTP ${resp.status}).`);

        const list: Turma[] = (Array.isArray(data?.turmas) ? data.turmas : [])
          .map((t: any) => ({
            id:    Number(t?.id),
            nome:  String(t?.nome  || '').trim(),
            turno: String(t?.turno || '').trim(),
            serie: t?.serie ?? null,
          }))
          .filter((t: Turma) => t.id > 0 && t.nome);

        if (alive) setTurmasRaw(list);
      } catch (e: any) {
        if (alive) setErrorMsg(String(e?.message || e || 'Erro ao carregar turmas.'));
      } finally {
        if (alive) setIsLoadingTurmas(false);
      }
    })();

    return () => { alive = false; };
  }, [phase, turno, deviceToken]);

  // ─────────────────────────────────────────────────────────────────────────
  // 4) Estatísticas das turmas
  // ─────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (phase !== 'ready') return;
    if (isLoading || errorMsg || !turmasRaw.length) return;
    let alive = true;

    (async () => {
      const token = deviceToken ?? await AsyncStorage.getItem(STORAGE_DEVICE_TOKEN);
      const uid   = deviceUid   || await AsyncStorage.getItem(STORAGE_DEVICE_UID) || '';

      const initial: Record<string, { ok: number; pend: number; loading: boolean }> = {};
      for (const t of turmasRaw) initial[String(t.id)] = { ok: 0, pend: 0, loading: true };
      if (alive) setTurmaStats(initial);

      for (const t of turmasRaw) {
        const tid  = String(t.id);
        const url  = `${API_BASE}/api/capture/alunos?turma_id=${encodeURIComponent(tid)}`;
        const resp = await fetch(url, {
          method: 'GET',
          headers: {
            Authorization: `Device ${token}`,
            'x-device-uid': uid,
            Accept: 'application/json',
          },
        });

        if (!alive) return;

        const data = await resp.json().catch(() => null);
        if (!resp.ok) {
          setTurmaStats((prev) => ({ ...prev, [tid]: { ok: 0, pend: 0, loading: false } }));
          continue;
        }

        const list = Array.isArray(data?.alunos) ? data.alunos : [];
        let ok = 0, pend = 0;
        for (const r of list) { if (r?.foto) ok++; else pend++; }

        if (alive) setTurmaStats((prev) => ({ ...prev, [tid]: { ok, pend, loading: false } }));
      }
    })();

    return () => { alive = false; };
  }, [phase, isLoading, errorMsg, turno, turmasRaw]);

  // ─────────────────────────────────────────────────────────────────────────
  // 5) Polling: aguarda aprovação do diretor após exibir pair_code
  // ─────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (phase !== 'polling' || !pairCode) return;

    async function checkApproval() {
      try {
        const resp = await fetch(`${API_BASE}/api/capture/pair/status/${encodeURIComponent(pairCode!)}`, {
          method: 'GET',
          headers: { Accept: 'application/json' },
        });
        const data = await resp.json().catch(() => null);

        if (resp.ok && data?.approved && data?.device_token) {
          // ✅ Aprovado! Salva token e uid no storage
          await AsyncStorage.setItem(STORAGE_DEVICE_TOKEN, String(data.device_token));
          if (data.device_uid) {
            await AsyncStorage.setItem(STORAGE_DEVICE_UID, String(data.device_uid));
            setDeviceUid(String(data.device_uid));
          }
          setDeviceToken(String(data.device_token));
          stopPolling();
          setPhase('ready');
        }
        // se ainda não aprovado, continua aguardando
      } catch {
        // silencioso — polling tenta novamente no próximo tick
      }
    }

    pollingRef.current = setInterval(checkApproval, 4000);
    checkApproval(); // executa imediatamente na primeira vez

    return () => stopPolling();
  }, [phase, pairCode]);

  function stopPolling() {
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Ação: submeter access_code → POST /api/capture/pair/request
  // ─────────────────────────────────────────────────────────────────────────
  async function handleSubmitAccessCode() {
    const code = accessCodeInput.trim().toUpperCase();
    if (!code) {
      setAccessCodeError('Digite o código de acesso da escola.');
      return;
    }

    if (!API_BASE) {
      setAccessCodeError('EXPO_PUBLIC_API_BASE_URL não configurada.');
      return;
    }

    if (!deviceUid) {
      setAccessCodeError('EXPO_PUBLIC_CAPTURE_DEVICE_UID não configurada.');
      return;
    }

    setAccessCodeLoading(true);
    setAccessCodeError(null);

    try {
      const resp = await fetch(`${API_BASE}/api/capture/pair/request`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          access_code: code,
          device_uid:  deviceUid,
          plataforma:  (Platform.OS || 'android').toUpperCase(),
          nome_dispositivo: 'EDUCA-CAPTURE (Expo)',
          app_version: '1.0.0',
        }),
      });

      const data = await resp.json().catch(() => null);

      if (!resp.ok) {
        setAccessCodeError(data?.message || `Erro ao solicitar pareamento (HTTP ${resp.status}).`);
        return;
      }

      const pc  = String(data?.pair_code || '').trim().toUpperCase();
      const exp = data?.expires_at ? String(data.expires_at) : null;

      if (!pc) {
        setAccessCodeError('pair_code não retornou do backend.');
        return;
      }

      setPairCode(pc);
      setPairExpiresAt(exp);
      setPairingMsg(null);

      // Busca QR payload
      try {
        const qrResp = await fetch(
          `${API_BASE}/api/capture/pair/qr/${encodeURIComponent(pc)}`,
          { method: 'GET', headers: { Accept: 'application/json' } }
        );
        const qrData = await qrResp.json().catch(() => null);
        if (qrResp.ok && qrData?.qr_payload) setQrPayload(String(qrData.qr_payload));
      } catch { /* silencioso */ }

      setPhase('polling');
    } catch (e: any) {
      setAccessCodeError(String(e?.message || e || 'Erro de rede.'));
    } finally {
      setAccessCodeLoading(false);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Ação: esquecer device (debug / reset)
  // ─────────────────────────────────────────────────────────────────────────
  async function handleForgetDevice() {
    await AsyncStorage.multiRemove([STORAGE_DEVICE_TOKEN, STORAGE_DEVICE_UID]);
    setDeviceToken(null);
    setPairCode(null);
    setPairExpiresAt(null);
    setQrPayload(null);
    setTurnos([]);
    setTurno('');
    setTurmasRaw([]);
    setTurmaStats({});
    setAccessCodeInput('');
    setAccessCodeError(null);
    setPhase('ask_access_code');
  }

  const turmas = useMemo(
    () => [...turmasRaw].sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR')),
    [turmasRaw]
  );

  // Ano letivo corrente (para mensagens informativas)
  const currentYear = new Date().getFullYear();

  // ─────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────

  // 🔄 Carregando storage inicial
  if (phase === 'loading') {
    return (
      <>
        <Stack.Screen options={{ title: 'EDUCA-CAPTURE' }} />
        <View style={styles.fullCenter}>
          <ActivityIndicator size="large" color="#0b3d2e" />
          <Text style={styles.loadingText}>Verificando credenciais…</Text>
        </View>
      </>
    );
  }

  // 🔑 Tela 1: digitar access_code
  if (phase === 'ask_access_code') {
    return (
      <>
        <Stack.Screen options={{ title: 'EDUCA-CAPTURE — Primeiro Acesso' }} />
        <ScrollView contentContainerStyle={styles.authContainer} keyboardShouldPersistTaps="handled">
          <Text style={styles.authTitle}>EDUCA-CAPTURE</Text>
          <Text style={styles.authSubtitle}>
            Digite o código de acesso fornecido pelo EDUCA.MELHOR para vincular este dispositivo à sua escola.
          </Text>

          <TextInput
            style={[styles.codeInput, !!accessCodeError && styles.codeInputError]}
            value={accessCodeInput}
            onChangeText={(v) => { setAccessCodeInput(v); setAccessCodeError(null); }}
            placeholder="Ex.: CEF04-CCMDF"
            placeholderTextColor="#aaa"
            autoCapitalize="characters"
            autoCorrect={false}
            maxLength={24}
            editable={!accessCodeLoading}
            returnKeyType="done"
            onSubmitEditing={handleSubmitAccessCode}
          />

          {!!accessCodeError && (
            <Text style={styles.errorText}>{accessCodeError}</Text>
          )}

          <Pressable
            style={[styles.primaryBtn, accessCodeLoading && styles.primaryBtnDisabled]}
            onPress={handleSubmitAccessCode}
            disabled={accessCodeLoading}
          >
            {accessCodeLoading
              ? <ActivityIndicator color="#fff" />
              : <Text style={styles.primaryBtnText}>Conectar à Escola</Text>
            }
          </Pressable>

          {!!pairingMsg && (
            <Text style={styles.warningText}>{pairingMsg}</Text>
          )}
        </ScrollView>
      </>
    );
  }

  // 📋 Tela 2: pair_code gerado — aguardando aprovação do diretor
  if (phase === 'pairing' || phase === 'polling') {
    const isPolling = phase === 'polling';
    return (
      <>
        <Stack.Screen options={{ title: 'Aguardando Aprovação' }} />
        <ScrollView contentContainerStyle={styles.authContainer}>
          <Text style={styles.authTitle}>Credenciamento</Text>
          <Text style={styles.authSubtitle}>
            Apresente o código abaixo ao diretor no EDUCA.MELHOR (Direção → Educa-Capture) para aprovar este dispositivo.
          </Text>

          {/* Pair code em destaque */}
          <View style={styles.pairCodeBox}>
            <Text style={styles.pairCodeLabel}>Código de Pareamento</Text>
            <Text style={styles.pairCodeValue}>{pairCode || '—'}</Text>
            {!!pairExpiresAt && (
              <Text style={styles.pairExpiry}>
                Expira em: {new Date(pairExpiresAt).toLocaleTimeString('pt-BR')}
              </Text>
            )}
          </View>

          {/* QR payload (texto — pode virar QRCode depois) */}
          {!!qrPayload && (
            <View style={styles.qrBox}>
              <Text style={styles.qrLabel}>QR Payload (para leitura no app do diretor):</Text>
              <Text style={styles.qrText} selectable>{qrPayload}</Text>
            </View>
          )}

          {/* Indicador de espera */}
          {isPolling && (
            <View style={styles.pollingRow}>
              <ActivityIndicator size="small" color="#0b3d2e" />
              <Text style={styles.pollingText}>Aguardando aprovação do diretor…</Text>
            </View>
          )}

          {/* Botão de voltar e digitar outro código */}
          <Pressable style={styles.secondaryBtn} onPress={() => {
            stopPolling();
            setPairCode(null);
            setPairExpiresAt(null);
            setQrPayload(null);
            setPhase('ask_access_code');
          }}>
            <Text style={styles.secondaryBtnText}>← Usar outro código</Text>
          </Pressable>
        </ScrollView>
      </>
    );
  }

  // ✅ Tela 3: Menu normal (turnos + turmas)
  return (
    <>
      <Stack.Screen options={{ title: 'Turno' }} />
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.escolaTitle}>{escolaNome}</Text>

        {/* Botão de desvincular — abre modal de confirmação */}
        <Pressable style={styles.resetBtn} onPress={() => setShowUnlinkConfirm(true)}>
          <Text style={styles.resetBtnText}>🔓 Desvincular dispositivo</Text>
        </Pressable>

        {/* Modal de confirmação de desvinculação */}
        <Modal
          visible={showUnlinkConfirm}
          transparent
          animationType="fade"
          onRequestClose={() => setShowUnlinkConfirm(false)}
        >
          <View style={styles.modalOverlay}>
            <View style={styles.modalCard}>
              <Text style={styles.modalTitle}>Desvincular dispositivo?</Text>
              <Text style={styles.modalBody}>
                Esta ação irá remover o credenciamento deste dispositivo.
                Será necessário realizar um novo pareamento com o EDUCA.MELHOR para voltar a usar o app.
              </Text>
              <View style={styles.modalBtns}>
                <Pressable
                  style={[styles.modalBtn, styles.modalBtnCancel]}
                  onPress={() => setShowUnlinkConfirm(false)}
                >
                  <Text style={styles.modalBtnCancelText}>Cancelar</Text>
                </Pressable>
                <Pressable
                  style={[styles.modalBtn, styles.modalBtnConfirm]}
                  onPress={() => { setShowUnlinkConfirm(false); handleForgetDevice(); }}
                >
                  <Text style={styles.modalBtnConfirmText}>Sim, desvincular</Text>
                </Pressable>
              </View>
            </View>
          </View>
        </Modal>

        {/* Seletor de turnos — segmented control */}
        {!isLoading && !errorMsg && turnos.length > 0 && (
          <View style={styles.turnosTrack}>
            {turnos.map((t) => {
              const active = t === turno;
              const icon = t.toLowerCase().includes('manut') || t.toLowerCase().includes('morn')
                ? '☀️'
                : t.toLowerCase().includes('vesp') || t.toLowerCase().includes('aftern')
                ? '🌅'
                : t.toLowerCase().includes('not') || t.toLowerCase().includes('night')
                ? '🌙'
                : '🕒';
              return (
                <Pressable
                  key={t}
                  onPress={() => setTurno(t)}
                  style={[styles.turnoBtn, active && styles.turnoBtnActive]}
                >
                  <Text style={styles.turnoBtnIcon}>{icon}</Text>
                  <Text style={[styles.turnoTxt, active && styles.turnoTxtActive]}>
                    {turnoLabel(t)}
                  </Text>
                  {active && <View style={styles.turnoBtnDot} />}
                </Pressable>
              );
            })}
          </View>
        )}

        {/* Grid de turmas */}
        <View style={styles.grid}>
          {(isLoading || isLoadingTurmas || !turno) ? (
            <View style={styles.center}>
              <ActivityIndicator size="small" color="#17a34a" />
              <Text style={styles.cardSub}>Carregando turmas…</Text>
            </View>
          ) : !isLoadingTurmas && turnos.length === 0 ? (
            <View style={styles.center}>
              <Text style={styles.emptyYear}>📅 {currentYear}</Text>
              <Text style={styles.emptyTitle}>Nenhuma turma cadastrada</Text>
              <Text style={styles.emptySub}>
                {'Ainda não há turmas registradas para ' + currentYear + '.'}
              </Text>
              <Text style={styles.emptySub}>
                Aguarde o cadastro das turmas no EDUCA.MELHOR.
              </Text>
            </View>
          ) : !errorMsg && turmas.length === 0 ? (
            <View style={styles.center}>
              <Text style={styles.emptyYear}>📅 {currentYear}</Text>
              <Text style={styles.emptyTitle}>Nenhuma turma neste turno</Text>
              <Text style={styles.emptySub}>
                Não há turmas em {currentYear} para o turno selecionado.
              </Text>
            </View>
          ) : (
            turmas.map((turma) => (
              <Pressable
                key={String(turma.id)}
                onPress={() => router.push(`/turma/${encodeURIComponent(String(turma.id))}?nomeTurma=${encodeURIComponent(turma.nome || '')}`)}
                style={styles.card}
              >
                <Text style={styles.cardTitle}>{turma.nome}</Text>

                {turmaStats[String(turma.id)]?.loading ? (
                  <Text style={styles.cardSub}>Carregando…</Text>
                ) : (
                  <View style={styles.cardStatsRow}>
                    <View style={styles.cardStatItem}>
                      <View style={[styles.cardDot, styles.cardDotGreen]} />
                      <Text style={styles.cardStatText}>
                        {turmaStats[String(turma.id)]?.ok ?? 0}
                      </Text>
                    </View>
                    <View style={styles.cardStatItem}>
                      <View style={[styles.cardDot, styles.cardDotGray]} />
                      <Text style={styles.cardStatText}>
                        {turmaStats[String(turma.id)]?.pend ?? 0}
                      </Text>
                    </View>
                  </View>
                )}
              </Pressable>
            ))
          )}
        </View>
      </ScrollView>
    </>
  );
}

// ─── Estilos ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  // ── Telas de auth ────────────────────────────────────────────────────────
  fullCenter: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 14,
    padding: 24,
  },
  loadingText: {
    fontSize: 14,
    color: '#555',
  },
  authContainer: {
    padding: 24,
    gap: 16,
    flexGrow: 1,
    justifyContent: 'center',
  },
  authTitle: {
    fontSize: 24,
    fontWeight: '900',
    textAlign: 'center',
    color: '#0b3d2e',
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  authSubtitle: {
    fontSize: 14,
    color: '#555',
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: 8,
  },
  codeInput: {
    borderWidth: 1.5,
    borderColor: '#9ad1ff',
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: 22,
    fontWeight: '800',
    letterSpacing: 6,
    textAlign: 'center',
    backgroundColor: '#f0f9ff',
    color: '#0b2a4a',
  },
  codeInputError: {
    borderColor: '#e74c3c',
    backgroundColor: '#fff5f5',
  },
  errorText: {
    fontSize: 13,
    color: '#e74c3c',
    textAlign: 'center',
  },
  warningText: {
    fontSize: 13,
    color: '#b45309',
    textAlign: 'center',
  },
  primaryBtn: {
    backgroundColor: '#0b3d2e',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 4,
  },
  primaryBtnDisabled: {
    opacity: 0.6,
  },
  primaryBtnText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '800',
  },
  secondaryBtn: {
    borderWidth: 1,
    borderColor: '#9ad1ff',
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
    marginTop: 8,
  },
  secondaryBtnText: {
    color: '#0b3d2e',
    fontSize: 14,
    fontWeight: '700',
  },

  // ── Pair code box ─────────────────────────────────────────────────────────
  pairCodeBox: {
    backgroundColor: '#f0fdf4',
    borderWidth: 1.5,
    borderColor: '#86efac',
    borderRadius: 14,
    padding: 20,
    alignItems: 'center',
    gap: 6,
  },
  pairCodeLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: '#166534',
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  pairCodeValue: {
    fontSize: 36,
    fontWeight: '900',
    color: '#0b3d2e',
    letterSpacing: 8,
  },
  pairExpiry: {
    fontSize: 12,
    color: '#555',
    marginTop: 2,
  },

  // ── QR box ───────────────────────────────────────────────────────────────
  qrBox: {
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 12,
    padding: 14,
    gap: 6,
  },
  qrLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: '#64748b',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  qrText: {
    fontSize: 11,
    color: '#334155',
    fontFamily: 'monospace',
  },

  // ── Polling ──────────────────────────────────────────────────────────────
  pollingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    paddingVertical: 8,
  },
  pollingText: {
    fontSize: 13,
    color: '#555',
  },

  // ── Menu: turnos + turmas ─────────────────────────────────────────────────
  container: {
    padding: 16,
    paddingBottom: 32,
    gap: 16,
  },
  escolaTitle: {
    fontSize: 18,
    fontWeight: '800',
    textAlign: 'center',
    letterSpacing: 0.3,
    marginTop: 4,
    opacity: 0.9,
  },
  resetBtn: {
    alignSelf: 'center',
    paddingVertical: 6,
    paddingHorizontal: 14,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#fca5a5',
    backgroundColor: '#fff5f5',
  },
  resetBtnText: {
    fontSize: 12,
    color: '#b91c1c',
    fontWeight: '600',
  },
  turnosTrack: {
    flexDirection: 'row',
    backgroundColor: 'rgba(255,255,255,0.07)',
    borderRadius: 18,
    padding: 5,
    gap: 4,
    marginVertical: 4,
  },
  turnoBtn: {
    flex: 1,
    paddingVertical: 12,
    paddingHorizontal: 8,
    borderRadius: 14,
    alignItems: 'center',
    gap: 4,
    position: 'relative',
  },
  turnoBtnActive: {
    backgroundColor: '#17a34a',
    shadowColor: '#17a34a',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.5,
    shadowRadius: 10,
    elevation: 8,
  },
  turnoBtnIcon: {
    fontSize: 20,
  },
  turnoBtnDot: {
    position: 'absolute',
    bottom: 5,
    width: 4,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.8)',
  },
  turnoTxt: {
    fontSize: 13,
    fontWeight: '700',
    color: 'rgba(255,255,255,0.35)',
    letterSpacing: 0.3,
  },
  turnoTxtActive: {
    color: '#fff',
    fontWeight: '900',
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  card: {
    width: '48%',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#e3e3e3',
    padding: 14,
    backgroundColor: '#fff',
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: '800',
  },
  cardSub: {
    marginTop: 6,
    fontSize: 12,
    color: '#555',
  },
  cardStatsRow: {
    marginTop: 8,
    flexDirection: 'row',
    gap: 14,
    alignItems: 'center',
  },
  cardStatItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  cardDot: {
    width: 12,
    height: 12,
    borderRadius: 999,
  },
  cardDotGreen: {
    backgroundColor: '#17a34a',
  },
  cardDotGray: {
    backgroundColor: '#6b7280',
  },
  cardStatText: {
    fontSize: 12,
    fontWeight: '800',
    color: '#111',
  },
  center: {
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    width: '100%',
  },
  helpTitle: {
    fontSize: 14,
    fontWeight: '800',
  },
  emptyYear: {
    fontSize: 32,
    fontWeight: '900',
    color: '#0b3d2e',
    letterSpacing: 1,
    marginBottom: 2,
  },
  emptyTitle: {
    fontSize: 16,
    fontWeight: '800',
    color: '#111',
    textAlign: 'center',
  },
  emptySub: {
    fontSize: 13,
    color: '#64748b',
    textAlign: 'center',
    lineHeight: 19,
    maxWidth: 280,
  },
  // ── Modal de confirmação ──────────────────────────────────────────────────
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    padding: 24,
  },
  modalCard: {
    width: '100%',
    backgroundColor: '#fff',
    borderRadius: 20,
    padding: 24,
    gap: 14,
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 12,
    elevation: 8,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '900' as const,
    color: '#0b3d2e',
    textAlign: 'center' as const,
  },
  modalBody: {
    fontSize: 14,
    color: '#444',
    textAlign: 'center' as const,
    lineHeight: 20,
  },
  modalBtns: {
    flexDirection: 'row' as const,
    gap: 10,
    marginTop: 4,
  },
  modalBtn: {
    flex: 1,
    paddingVertical: 13,
    borderRadius: 12,
    alignItems: 'center' as const,
  },
  modalBtnCancel: {
    backgroundColor: '#f3f4f6',
  },
  modalBtnCancelText: {
    fontSize: 15,
    fontWeight: '700' as const,
    color: '#374151',
  },
  modalBtnConfirm: {
    backgroundColor: '#dc2626',
  },
  modalBtnConfirmText: {
    fontSize: 15,
    fontWeight: '700' as const,
    color: '#fff',
  },
});