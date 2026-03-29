import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Stack, router, useLocalSearchParams, useFocusEffect } from 'expo-router';

type Status = 'ATIVO' | 'INATIVO';

type Aluno = {
  id: number;
  nome: string;
  status: Status;
  codigo?: string | null;
  foto?: string | null;
};

const STORAGE_DEVICE_TOKEN = '@educa_capture:device_token';
const STORAGE_DEVICE_UID   = '@educa_capture:device_uid';

function dotColor(a: Aluno) {
  if (a.status === 'INATIVO') return '#6b7280';
  return a.foto ? '#17a34a' : '#6b7280';
}

function statusLabel(s: Status) {
  if (s === 'INATIVO') return 'Inativo';
  return 'Ativo';
}

export default function TurmaScreen() {
  const params = useLocalSearchParams<{ turmaId: string; nomeTurma?: string }>();
  const turmaId = String(params.turmaId || '');
  const nomeTurma = String(params.nomeTurma || '');

  const API_BASE = String(process.env.EXPO_PUBLIC_API_BASE_URL || '').trim();

  const [isLoading, setIsLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [alunosRaw, setAlunosRaw] = useState<Aluno[]>([]);
  // Timestamp de refresco — atualizado em cada foco para forçar cache-busting nas fotos
  const [refreshTs, setRefreshTs] = useState(() => Date.now());

  // useFocusEffect: dispara TODA VEZ que a tela ganha foco (inclusive ao voltar da captura)
  useFocusEffect(
    useCallback(() => {
      let alive = true;

      async function load() {
        try {
          setIsLoading(true);
          setErrorMsg(null);

          if (!API_BASE) throw new Error('EXPO_PUBLIC_API_BASE_URL não configurada.');

          const token = await AsyncStorage.getItem(STORAGE_DEVICE_TOKEN);
          const uid   = await AsyncStorage.getItem(STORAGE_DEVICE_UID);

          if (!token) throw new Error('Dispositivo não credenciado. Reinicie o app e faça o pareamento.');

          const url = `${API_BASE}/api/capture/alunos?turma_id=${encodeURIComponent(turmaId)}`;

          const resp = await fetch(url, {
            method: 'GET',
            headers: {
              Authorization: `Device ${token}`,
              'x-device-uid': uid || '',
              Accept: 'application/json',
            },
          });

          const data = await resp.json().catch(() => null);

          if (!resp.ok) {
            const msg = data?.message || `Falha ao carregar alunos (HTTP ${resp.status}).`;
            throw new Error(msg);
          }

          const list = Array.isArray(data?.alunos) ? data.alunos : [];
          const mapped: Aluno[] = list.map((r: any) => {
            const rawStatus = r?.status;
            let isInativo: boolean;
            if (typeof rawStatus === 'number' || typeof rawStatus === 'boolean') {
              isInativo = !rawStatus;
            } else {
              isInativo = String(rawStatus || '').trim().toLowerCase() === 'inativo';
            }
            return {
              id: Number(r?.id),
              nome: String(r?.estudante || '').trim(),
              status: isInativo ? 'INATIVO' : 'ATIVO',
              codigo: r?.codigo ?? null,
              foto: r?.foto ?? null,
            };
          }).filter((a: Aluno) => a.id > 0 && a.nome);

          if (alive) {
            setAlunosRaw(mapped);
            // Atualiza timestamp para cache-busting nas URLs de foto
            setRefreshTs(Date.now());
          }
        } catch (e: any) {
          if (alive) setErrorMsg(String(e?.message || e || 'Erro ao carregar alunos.'));
        } finally {
          if (alive) setIsLoading(false);
        }
      }

      load();
      return () => { alive = false; };
    }, [API_BASE, turmaId])
  );


  const alunos = useMemo(() => {
    return [...alunosRaw].sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
  }, [alunosRaw]);

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Stack.Screen options={{ title: nomeTurma || 'Turma' }} />
      <Text style={styles.title}>{nomeTurma || `Turma ${turmaId}`}</Text>

      <View style={styles.list}>
        {isLoading ? (
          <View style={styles.center}>
            <ActivityIndicator />
            <Text style={styles.meta}>Carregando alunos…</Text>
          </View>
        ) : errorMsg ? (
          <View style={styles.center}>
            <Text style={styles.helpTitle}>Falha ao carregar</Text>
            <Text style={styles.meta}>{errorMsg}</Text>
          </View>
        ) : alunos.length === 0 ? (
          <View style={styles.center}>
            <Text style={styles.meta}>Nenhum aluno encontrado para esta turma.</Text>
          </View>
        ) : (
          alunos.map((a) => {
            // Cache-busting: adiciona ?t=<timestamp> à URL da foto para forçar reload após captura
            const fotoUrl = a.foto
              ? (() => {
                  const raw = String(a.foto);
                  const base = /^https?:\/\//i.test(raw)
                    ? raw
                    : raw.startsWith('/')
                    ? `${API_BASE}${raw}`
                    : `${API_BASE}/${raw}`;
                  return `${base}?t=${refreshTs}`;
                })()
              : null;

            return (
              <Pressable
                key={String(a.id)}
                onPress={() =>
                  router.push(
                    `/capture/${encodeURIComponent(String(a.id))}?turma_id=${encodeURIComponent(
                      String(turmaId)
                    )}&nome=${encodeURIComponent(a.nome || '')}&foto=${encodeURIComponent(a.foto || '')}&nomeTurma=${encodeURIComponent(nomeTurma || '')}`
                  )
                }
                style={styles.row}
              >
                {fotoUrl ? (
                  <Image source={{ uri: fotoUrl }} style={styles.thumb} />
                ) : (
                  <View style={styles.noPhotoWrap}>
                    {/* Círculo vermelho com faixa diagonal — aluno sem foto */}
                    <View style={styles.noPhotoCircle}>
                      <View style={styles.noPhotoStripe} />
                    </View>
                  </View>
                )}
                <View style={styles.rowText}>
                  <Text style={styles.name}>{a.nome}</Text>
                  <Text style={styles.meta}>
                    {statusLabel(a.status)}
                    {a.codigo ? ` • cód ${a.codigo}` : ''}
                    {a.foto ? ' • foto OK' : ' • sem foto'}
                    {' • toque para capturar/atualizar'}
                  </Text>
                </View>
              </Pressable>
            );
          })
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: 16,
    paddingBottom: 32,
    gap: 12,
  },
  title: {
    fontSize: 22,
    fontWeight: '800',
  },
  list: {
    gap: 10,
  },
  row: {
    flexDirection: 'row',
    gap: 12,
    padding: 12,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#e3e3e3',
    backgroundColor: '#fff',
    alignItems: 'center',
  },

  rowText: {
    flex: 1,
  },
  name: {
    fontSize: 16,
    fontWeight: '800',
  },
  meta: {
    marginTop: 4,
    fontSize: 12,
    color: '#555',
  },
  center: {
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  helpTitle: {
    fontSize: 14,
    fontWeight: '800',
  },
  thumb: {
    width: 46,
    height: 46,
    borderRadius: 10,
    backgroundColor: '#e2e8f0',
  },
  // Placeholder "sem foto": círculo vermelho + faixa diagonal
  noPhotoWrap: {
    width: 46,
    height: 46,
    borderRadius: 10,
    backgroundColor: 'rgba(220,38,38,0.08)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  noPhotoCircle: {
    width: 30,
    height: 30,
    borderRadius: 15,
    borderWidth: 2.5,
    borderColor: '#dc2626',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  noPhotoStripe: {
    position: 'absolute',
    width: 2.5,
    height: 36,          // mais longa que o diâmetro para cobrir toda a extensão
    backgroundColor: '#dc2626',
    borderRadius: 2,
    transform: [{ rotate: '45deg' }],
  },
});