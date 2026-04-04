import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  View,
  Modal,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import { WebView } from 'react-native-webview';
import { StatusBar } from 'expo-status-bar';

const TOKEN_KEY = 'plataforma_mp_jwt';

function getApiBase() {
  if (typeof process !== 'undefined' && process.env?.EXPO_PUBLIC_API_URL) {
    return process.env.EXPO_PUBLIC_API_URL.replace(/\/$/, '');
  }
  const extra = Constants.expoConfig?.extra?.apiUrl;
  return (extra || 'http://127.0.0.1:3780').replace(/\/$/, '');
}

export default function App() {
  const [apiBase] = useState(getApiBase);
  const [token, setToken] = useState(null);
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');
  const [err, setErr] = useState('');
  const [nots, setNots] = useState([]);
  const [pdfUrl, setPdfUrl] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const t = await AsyncStorage.getItem(TOKEN_KEY);
        setToken(t);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const loadNots = useCallback(async () => {
    const t = token || (await AsyncStorage.getItem(TOKEN_KEY));
    if (!t) return;
    const r = await fetch(`${apiBase}/api/notificacoes`, {
      headers: { Authorization: `Bearer ${t}` },
    });
    if (!r.ok) {
      if (r.status === 401) {
        await AsyncStorage.removeItem(TOKEN_KEY);
        setToken(null);
      }
      return;
    }
    const data = await r.json();
    setNots(Array.isArray(data) ? data : []);
  }, [apiBase, token]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await loadNots();
    } finally {
      setRefreshing(false);
    }
  }, [loadNots]);

  useEffect(() => {
    if (token) loadNots();
  }, [token, loadNots]);

  async function login() {
    setErr('');
    try {
      const r = await fetch(`${apiBase}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: user.trim(), password: pass }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setErr(j.error || 'Usuário ou senha inválidos');
        return;
      }
      await AsyncStorage.setItem(TOKEN_KEY, j.token);
      setToken(j.token);
      setPass('');
    } catch {
      setErr('Não foi possível conectar. Verifique a URL da API (emulador: use o IP da máquina, ex. http://192.168.x.x:3780).');
    }
  }

  async function logout() {
    await AsyncStorage.removeItem(TOKEN_KEY);
    setToken(null);
    setNots([]);
  }

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#9b2a1b" />
        <Text style={styles.muted}>Carregando…</Text>
      </View>
    );
  }

  if (!token) {
    return (
      <SafeAreaView style={styles.safe}>
        <StatusBar style="light" />
        <View style={styles.loginBox}>
          <Text style={styles.title}>PlataformaMP</Text>
          <Text style={styles.sub}>API: {apiBase}</Text>
          <TextInput
            style={styles.input}
            placeholder="Usuário"
            autoCapitalize="none"
            value={user}
            onChangeText={setUser}
          />
          <TextInput
            style={styles.input}
            placeholder="Senha"
            secureTextEntry
            value={pass}
            onChangeText={setPass}
          />
          {err ? <Text style={styles.error}>{err}</Text> : null}
          <Pressable style={styles.btn} onPress={login}>
            <Text style={styles.btnText}>Entrar</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="dark" />
      <View style={styles.bar}>
        <Text style={styles.barTitle}>Notificações</Text>
        <Pressable onPress={logout}>
          <Text style={styles.barLink}>Sair</Text>
        </Pressable>
      </View>
      <FlatList
        data={nots}
        keyExtractor={(item) => item.id}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={['#9b2a1b']} />}
        ListHeaderComponent={
          <Text style={styles.mutedSmall}>Puxe para atualizar · {nots.length} itens</Text>
        }
        renderItem={({ item }) => (
          <Pressable
            style={styles.card}
            onPress={() => item.pdfUrl && setPdfUrl(item.pdfUrl)}
          >
            <Text style={styles.cardId}>{item.id}</Text>
            <Text style={styles.cardTitle}>{item.titulo}</Text>
            {item.ia?.risco ? (
              <Text style={styles.risco}>Risco: {item.ia.risco}</Text>
            ) : null}
            {item.pdfUrl ? (
              <Text style={styles.link}>Toque para abrir PDF</Text>
            ) : null}
          </Pressable>
        )}
      />
      <Modal visible={!!pdfUrl} animationType="slide" onRequestClose={() => setPdfUrl(null)}>
        <View style={styles.pdfBar}>
          <Pressable onPress={() => setPdfUrl(null)}>
            <Text style={styles.link}>Fechar</Text>
          </Pressable>
        </View>
        {pdfUrl ? (
          <WebView source={{ uri: pdfUrl }} style={{ flex: 1 }} />
        ) : null}
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#f6f2ec' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#0c1017' },
  muted: { color: '#888', marginTop: 12 },
  mutedSmall: { fontSize: 12, color: '#6b6058', marginBottom: 8 },
  loginBox: { flex: 1, padding: 24, justifyContent: 'center', backgroundColor: '#0c1017' },
  title: { fontSize: 26, fontWeight: '700', color: '#fff', marginBottom: 4 },
  sub: { fontSize: 11, color: 'rgba(255,255,255,.45)', marginBottom: 24 },
  input: {
    backgroundColor: '#fdfbf8',
    borderWidth: 1,
    borderColor: '#d8cfc1',
    padding: 12,
    marginBottom: 12,
    borderRadius: 4,
  },
  btn: { backgroundColor: '#9b2a1b', padding: 14, alignItems: 'center', borderRadius: 4, marginTop: 8 },
  btnText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  error: { color: '#fca5a5', marginBottom: 8, fontSize: 13 },
  bar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    borderBottomWidth: 2,
    borderColor: '#9b2a1b',
    backgroundColor: '#0f1520',
  },
  barTitle: { color: '#fff', fontSize: 18, fontWeight: '600' },
  link: { color: '#1a3d78', fontWeight: '600' },
  barLink: { color: 'rgba(255,255,255,.85)', fontWeight: '600' },
  card: {
    backgroundColor: '#fff',
    marginHorizontal: 16,
    marginBottom: 10,
    padding: 14,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#d8cfc1',
  },
  cardId: { fontFamily: 'monospace', fontSize: 11, color: '#6b6058' },
  cardTitle: { fontSize: 15, fontWeight: '600', marginTop: 4 },
  risco: { fontSize: 12, color: '#8a6820', marginTop: 6 },
  pdfBar: { padding: 12, backgroundColor: '#0f1520' },
});
