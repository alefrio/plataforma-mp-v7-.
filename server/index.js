require('dotenv').config();
const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { OAuth2Client } = require('google-auth-library');
const cron = require('node-cron');
const mpma = require('./services/mpmaMonitor');
const { runDouCrawler } = require('./services/douCrawler');
const { runDoeCrawler } = require('./services/doeCrawler');
const { runDomCrawler } = require('./services/domCrawler');
const servidores = require('./services/servidores');
const servidoresService = require('./services/servidoresService');
const mpmaService = require('./services/mpmaService');
servidores.setLegacyMonitoredNames(mpma.MONITORED_NAMES);
const { analyzePdfText, mergeIaIntoNotification } = require('./pdf-ai');
const { sendWhatsAppNewNotif, sendEmailNewNotif } = require('./notify');
const loginSecurity = require('./services/loginSecurity');
const tceCrawler = require('./services/tceCrawler');

const PORT = process.env.PORT || 3780;
const JWT_SECRET = process.env.JWT_SECRET || 'plataforma-mp-v7-dev-secret-change-in-production';
const GOOGLE_CLIENT_ID = (process.env.GOOGLE_CLIENT_ID || '').trim();
const DATA_DIR = path.join(__dirname, '..', 'data');

const USERS_FILE = path.join(DATA_DIR, 'users.json');
const NOTS_FILE = path.join(DATA_DIR, 'notificacoes.json');
const CHATS_FILE = path.join(DATA_DIR, 'chats-por-notificacao.json');
const SEEN_DIARIO_FILE = path.join(DATA_DIR, 'monitoramento-diarios-seen.json');

function ensureData() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function normalizeUser(u) {
  const o = { ...u };
  if (o.email === undefined) o.email = '';
  if (o.phone === undefined) o.phone = '';
  if (o.whatsapp === undefined) o.whatsapp = '';
  return o;
}

function initUsers() {
  ensureData();
  let users = readJson(USERS_FILE, null);
  if (!users || !users.length) {
    const hash = bcrypt.hashSync('@bur123', 10);
    users = [
      { id: 'u1', username: 'alef.mendes', nome: 'Alef Mendes', password: hash, role: 'admin_master', cargo: 'TI / Admin', init: 'AM', color: '#9b2a1b', email: '', phone: '', whatsapp: '' },
      { id: 'u2', username: 'denis', nome: 'Denis', password: hash, role: 'admin', cargo: 'Administrador', init: 'DN', color: '#1a3d78', email: '', phone: '', whatsapp: '' },
      { id: 'u3', username: 'whesley', nome: 'Whesley', password: hash, role: 'admin', cargo: 'Administrador', init: 'WH', color: '#175a36', email: '', phone: '', whatsapp: '' },
      { id: 'u4', username: 'joao.carlos', nome: 'João Carlos', password: hash, role: 'executivo', cargo: 'Executivo', init: 'JC', color: '#5b21b6', email: '', phone: '', whatsapp: '' },
      { id: 'u5', username: 'vandercleber', nome: 'Vandercleber', password: hash, role: 'usuario', cargo: 'Usuário', init: 'VC', color: '#8a6820', email: '', phone: '', whatsapp: '' },
      { id: 'u6', username: 'prefeito', nome: 'Prefeito (Executivo)', password: hash, role: 'prefeito', cargo: 'Prefeitura', init: 'PF', color: '#0f172a', email: '', phone: '', whatsapp: '' },
    ];
    writeJson(USERS_FILE, users);
  }
  let migrated = false;
  users = users.map((u) => {
    const n = normalizeUser(u);
    if (n !== u || u.email === undefined || u.phone === undefined || u.whatsapp === undefined) migrated = true;
    return n;
  });
  if (migrated) writeJson(USERS_FILE, users);
  return users;
}

function normalizeNotif(n) {
  const o = { ...n };
  if (o.responsavelId === undefined || o.responsavelId === '') o.responsavelId = null;
  if (o.responsavelNome === undefined) o.responsavelNome = null;
  if (typeof o.prioridade !== 'boolean') o.prioridade = !!o.prioridade;
  if (!Array.isArray(o.timeline)) o.timeline = [];
  if (o.gravidadePdf === undefined) o.gravidadePdf = null;
  if (o.monitoramentoOrigem === undefined) o.monitoramentoOrigem = 'MPMA';
  if (!Array.isArray(o.alertasInteligencia)) o.alertasInteligencia = [];
  if (o.diarioMetadados === undefined) o.diarioMetadados = null;
  if (o.domAnalise === undefined) o.domAnalise = null;
  if (o.classificacaoRiscoInstitucional === undefined) o.classificacaoRiscoInstitucional = null;
  if (o.mpmaTextoSha256 === undefined) o.mpmaTextoSha256 = null;
  if (o.mpmaPdfUrlMd5 === undefined) o.mpmaPdfUrlMd5 = null;
  if (o.mpmaPdfBinarioSha256 === undefined) o.mpmaPdfBinarioSha256 = null;
  if (o.mpmaPdfUrlCanonico === undefined) o.mpmaPdfUrlCanonico = o.pdfUrl || null;
  if (!Array.isArray(o.mpmaOcorrenciasNomes)) o.mpmaOcorrenciasNomes = [];
  if (!o.classificacaoRiscoInstitucional) {
    const txt = `${o.descricao || ''} ${o.titulo || ''}`.trim();
    if (txt.length > 15) {
      try {
        o.classificacaoRiscoInstitucional = mpma.classifyRiscoInstitucionalText(txt);
      } catch (_) {
        o.classificacaoRiscoInstitucional = null;
      }
    }
  }
  return o;
}

function initNotificacoes() {
  ensureData();
  const nots = readJson(NOTS_FILE, []);
  if (!Array.isArray(nots)) {
    writeJson(NOTS_FILE, []);
    return [];
  }
  return nots.map(normalizeNotif);
}

function timelinePush(n, acao, actor) {
  if (!Array.isArray(n.timeline)) n.timeline = [];
  const nome = actor && (actor.nome || actor.username) ? String(actor.nome || actor.username) : 'Sistema';
  const uid = actor && actor.sub != null ? actor.sub : actor && actor.id != null ? actor.id : null;
  n.timeline.push({
    acao,
    hora: new Date().toLocaleString('pt-BR'),
    iso: new Date().toISOString(),
    user: nome,
    userId: uid,
    done: true,
    current: false,
  });
}

function buildNomesRecorrentes() {
  const map = new Map();
  function normKey(s) {
    return String(s || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }
  for (const n of notificacoes) {
    if ((n.monitoramentoOrigem || 'MPMA') === 'DOM') continue;
    const people = n.mencoesDetalhe || [];
    for (const p of people) {
      const key = normKey(p.nome);
      if (!key || key.length < 4) continue;
      if (!map.has(key)) map.set(key, { nome: p.nome, count: 0, processos: [] });
      const row = map.get(key);
      row.count += 1;
      if (!row.processos.includes(n.id)) row.processos.push(n.id);
    }
  }
  return [...map.values()]
    .filter((x) => x.count >= 2)
    .sort((a, b) => b.count - a.count || a.nome.localeCompare(b.nome));
}

function getSeenSet() {
  return mpmaService.loadSeenPdfSet();
}

function saveSeenSet(set) {
  mpmaService.saveSeenPdfSet(set);
}

function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    nome: u.nome,
    role: u.role,
    cargo: u.cargo,
    init: u.init,
    color: u.color,
    exec: ['admin_master', 'admin', 'executivo', 'prefeito'].includes(u.role),
    proc: ['admin_master', 'admin', 'executivo', 'prefeito'].includes(u.role),
    isUsuario: u.role === 'usuario',
  };
}

function authMiddleware(req, res, next) {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token ausente' });
  }
  try {
    req.user = jwt.verify(h.slice(7), JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Token inválido' });
  }
}

function requireRoles(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Sem permissão' });
    }
    next();
  };
}

const app = express();
if (process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true') {
  app.set('trust proxy', 1);
}
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

/* Dev: permite preview do Cursor, file://, localhost e 127.0.0.1 sem bloqueio CORS */
app.use(
  cors({
    origin: '*',
    methods: ['GET', 'POST', 'PATCH', 'OPTIONS', 'HEAD'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);
app.use(express.json({ limit: '2mb' }));

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

let users = initUsers();
let notificacoes = initNotificacoes();

/** IDs já processados pelos crawlers DOU/DOE/DOM (persistente) */
let diarioSeenIds = new Set();

function initDiarioSeenFromDisk() {
  const d = readJson(SEEN_DIARIO_FILE, { ids: [] });
  diarioSeenIds = new Set(Array.isArray(d.ids) ? d.ids : []);
  for (const n of notificacoes) {
    if (typeof n.id === 'string' && /^(DOU|DOE|DOM)-/.test(n.id)) diarioSeenIds.add(n.id);
  }
}

function persistDiarioSeen() {
  writeJson(SEEN_DIARIO_FILE, { ids: [...diarioSeenIds] });
}

initDiarioSeenFromDisk();

/** Chat por notificação — evita duplicar arrays grandes dentro de cada notificação */
let chatsByNotif = readJson(CHATS_FILE, {});
if (!chatsByNotif || typeof chatsByNotif !== 'object') chatsByNotif = {};

function persistChats() {
  writeJson(CHATS_FILE, chatsByNotif);
}

function getChatMessages(notifId) {
  if (!chatsByNotif[notifId]) chatsByNotif[notifId] = [];
  return chatsByNotif[notifId];
}

function persistNots() {
  writeJson(NOTS_FILE, notificacoes);
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

/** Prazo vencido e não respondido → status atrasada (automático) */
function refreshAtrasadas() {
  const t = todayISO();
  let changed = false;
  for (const n of notificacoes) {
    if (!n.prazo || n.prazo === '2099-12-31') continue;
    if (n.prazo >= t) continue;
    if (n.status === 'respondido') continue;
    if (n.status !== 'atrasada') {
      n.status = 'atrasada';
      changed = true;
    }
  }
  if (changed) persistNots();
  return changed;
}

/** Limites do período para relatórios (calendário local do servidor) */
function periodBounds(periodo) {
  const now = new Date();
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
  let start;
  if (periodo === 'dia') {
    start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  } else if (periodo === 'semana') {
    const day = now.getDay();
    const mondayOffset = day === 0 ? -6 : 1 - day;
    start = new Date(now.getFullYear(), now.getMonth(), now.getDate() + mondayOffset, 0, 0, 0, 0);
  } else if (periodo === 'mes') {
    start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
  } else return null;
  return { start, end };
}

function isoInRange(iso, start, end) {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  return t >= start.getTime() && t <= end.getTime();
}

function tempoMedioRespostaHorasForNome(nome, start, end) {
  const deltas = [];
  for (const n of notificacoes) {
    const logs = [...(n.accessLog || [])].filter((a) => a.user === nome);
    if (!logs.length) continue;
    logs.sort((a, b) => new Date(a.iso) - new Date(b.iso));
    let firstView = null;
    let firstResp = null;
    for (const a of logs) {
      if ((a.pdf === true || a.abriuDenuncia) && !firstView) firstView = a.iso;
    }
    for (const a of logs) {
      if (a.respondeu === true && !firstResp) firstResp = a.iso;
    }
    if (!firstView || !firstResp) continue;
    const t0 = new Date(firstView).getTime();
    const t1 = new Date(firstResp).getTime();
    if (t1 < t0) continue;
    if (!isoInRange(firstResp, start, end)) continue;
    const h = (t1 - t0) / 36e5;
    if (h >= 0 && h <= 2160) deltas.push(h);
  }
  if (!deltas.length) return null;
  const avg = deltas.reduce((a, b) => a + b, 0) / deltas.length;
  return Math.round(avg * 10) / 10;
}

function buildDesempenho(periodo) {
  const b = periodBounds(periodo);
  if (!b) return null;
  const { start, end } = b;
  const byUser = new Map();
  for (const u of users) {
    byUser.set(u.nome, {
      userId: u.id,
      nome: u.nome,
      username: u.username,
      role: u.role,
      visualizouSet: new Set(),
      respondeuSet: new Set(),
      comentouSet: new Set(),
    });
  }
  for (const n of notificacoes) {
    const logs = n.accessLog || [];
    for (const a of logs) {
      if (!isoInRange(a.iso, start, end)) continue;
      const nome = a.user;
      if (!nome) continue;
      if (!byUser.has(nome)) {
        byUser.set(nome, {
          userId: a.userId || null,
          nome,
          username: '',
          role: '',
          visualizouSet: new Set(),
          respondeuSet: new Set(),
          comentouSet: new Set(),
        });
      }
      const row = byUser.get(nome);
      if (a.abriuDenuncia || a.pdf === true) row.visualizouSet.add(n.id);
      if (a.respondeu === true) row.respondeuSet.add(n.id);
      if (a.comentou === true) row.comentouSet.add(n.id);
    }
  }
  const advogados = [];
  for (const row of byUser.values()) {
    const v = row.visualizouSet.size;
    const r = row.respondeuSet.size;
    const c = row.comentouSet.size;
    let ignorou = 0;
    for (const nid of row.visualizouSet) {
      if (!row.respondeuSet.has(nid)) ignorou++;
    }
    const eff = v > 0 ? Math.round((Math.min(r, v) / v) * 1000) / 10 : 0;
    const tempoMedioRespostaHoras = tempoMedioRespostaHorasForNome(row.nome, start, end);
    advogados.push({
      userId: row.userId,
      nome: row.nome,
      username: row.username,
      role: row.role,
      visualizou: v,
      respondeu: r,
      comentou: c,
      ignorou,
      eficienciaPct: eff,
      denunciasAnalisadas: r,
      numRespostas: r,
      tempoMedioRespostaHoras,
    });
  }
  advogados.sort((x, y) => y.eficienciaPct - x.eficienciaPct || y.visualizou - x.visualizou || x.nome.localeCompare(y.nome));
  const comAtividade = advogados.filter((x) => x.visualizou > 0 || x.respondeu > 0);
  const advogadoDestaque = comAtividade[0] || null;
  const rankingDesempenho = [...advogados]
    .filter((x) => x.respondeu > 0 || x.visualizou > 0)
    .sort((a, b) => b.eficienciaPct - a.eficienciaPct || (a.tempoMedioRespostaHoras || 9999) - (b.tempoMedioRespostaHoras || 9999));
  const mpmaOnly = notificacoes.filter((n) => (n.monitoramentoOrigem || 'MPMA') === 'MPMA');
  const resumoExecutivo = {
    totalDenuncias: mpmaOnly.length,
    urgentes: mpmaOnly.filter((n) => n.status === 'urgente').length,
    atrasadas: mpmaOnly.filter((n) => n.status === 'atrasada').length,
    respondidas: mpmaOnly.filter((n) => n.status === 'respondido').length,
  };
  return {
    periodo,
    inicioISO: start.toISOString(),
    fimISO: end.toISOString(),
    advogados,
    advogadoDestaque,
    rankingDesempenho,
    resumoExecutivo,
  };
}

const onlineSockets = new Map();

function broadcastPresence() {
  io.emit('presence:count', { count: onlineSockets.size });
  const byUser = new Map();
  for (const [, v] of onlineSockets) {
    const uid = v.userId;
    if (!uid || byUser.has(uid)) continue;
    const u = users.find((x) => x.id === uid);
    if (!u) continue;
    byUser.set(uid, { userId: u.id, nome: u.nome, cargo: u.cargo || '', role: u.role || '' });
  }
  io.emit('presence:users', { users: [...byUser.values()] });
}

function findUserByUsername(username) {
  const u = String(username || '').trim().toLowerCase();
  return users.find((x) => x.username.toLowerCase() === u);
}

function normEmail(e) {
  return String(e || '')
    .trim()
    .toLowerCase();
}

function findUserByEmail(email) {
  const n = normEmail(email);
  if (!n) return null;
  return users.find((x) => normEmail(x.email) === n);
}

app.get('/api/health', (req, res) => {
  let nom = {};
  try {
    nom = servidores.getMeta();
  } catch {
    nom = {};
  }
  res.json({
    ok: true,
    service: 'plataforma-mp-v7',
    port: PORT,
    auth: 'jwt+bcrypt' + (GOOGLE_CLIENT_ID ? '+google' : ''),
    googleLogin: !!GOOGLE_CLIENT_ID,
    ia: !!process.env.OPENAI_API_KEY,
    email: !!(process.env.SMTP_HOST && process.env.SMTP_USER),
    whatsapp:
      !!(
        (process.env.WHATSAPP_CLOUD_ACCESS_TOKEN && process.env.WHATSAPP_CLOUD_PHONE_NUMBER_ID) ||
        (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_WHATSAPP_FROM)
      ),
    whatsappProvider: process.env.WHATSAPP_CLOUD_ACCESS_TOKEN ? 'meta_cloud' : process.env.TWILIO_WHATSAPP_FROM ? 'twilio' : null,
    servidoresNominal: {
      url: nom.url,
      totalScraped: nom.totalMemoria,
      totalMonitoramento: nom.totalMonitoramento,
      atualizadoEm: nom.atualizadoEm,
      erro: nom.ultimoErro || null,
    },
    publicUrl: process.env.APP_PUBLIC_URL || null,
    monitorDiarios: process.env.MONITOR_DIARIOS_OFF !== '1',
    monitorCron: '*/10 * * * *',
    tcema: (() => {
      try {
        const s = tceCrawler.getTceMaState();
        return {
          itens: (s.itens || []).length,
          atualizadoEm: s.atualizadoEm || null,
          ultimoErro: s.ultimoErro || null,
        };
      } catch {
        return { itens: 0, atualizadoEm: null, ultimoErro: null };
      }
    })(),
  });
});

/** Configuração pública para o cliente (ID OAuth Google — não é segredo, mas centralizado) */
app.get('/api/public/config', (req, res) => {
  res.json({
    googleClientId: GOOGLE_CLIENT_ID || '',
  });
});

app.post('/api/auth/google', async (req, res) => {
  const credential = req.body && req.body.credential;
  if (!GOOGLE_CLIENT_ID) {
    return res.status(503).json({ error: 'Login com Google não está configurado (defina GOOGLE_CLIENT_ID no servidor).' });
  }
  if (!credential || typeof credential !== 'string') {
    return res.status(400).json({ error: 'Credencial Google ausente.' });
  }
  try {
    const oAuth2 = new OAuth2Client(GOOGLE_CLIENT_ID);
    const ticket = await oAuth2.verifyIdToken({
      idToken: credential,
      audience: GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    if (!payload || !payload.email) {
      return res.status(403).json({ error: 'Não foi possível obter o e-mail da conta Google.' });
    }
    if (!payload.email_verified) {
      return res.status(403).json({ error: 'O e-mail da conta Google precisa estar verificado.' });
    }
    const u = findUserByEmail(payload.email);
    if (!u) {
      return res.status(403).json({
        error:
          'Este e-mail não está associado a um utilizador autorizado. Peça ao administrador para registar o mesmo e-mail no seu utilizador (data/users.json).',
      });
    }
    loginSecurity.recordSuccess(u.username, loginSecurity.getClientIp(req));
    const expiresIn = process.env.JWT_EXPIRES_IN || '12h';
    const token = jwt.sign({ sub: u.id, username: u.username, role: u.role, nome: u.nome }, JWT_SECRET, {
      expiresIn,
    });
    res.json({ token, user: publicUser(u), tokenExpiresIn: expiresIn });
  } catch (e) {
    console.warn('[auth/google]', e.message);
    return res.status(401).json({ error: 'Token Google inválido ou expirado. Tente novamente.' });
  }
});

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  const ip = loginSecurity.getClientIp(req);
  const uLookup = findUserByUsername(username);
  const lockKey = uLookup ? uLookup.username : String(username || '').trim();
  const locked = loginSecurity.isLocked(lockKey);
  if (locked.locked) {
    const min = Math.max(1, Math.ceil(locked.msLeft / 60000));
    return res.status(423).json({
      error: `Conta temporariamente bloqueada após ${loginSecurity.MAX_FAIL} tentativas falhadas. Tente novamente em ~${min} min.`,
    });
  }
  const u = findUserByUsername(username);
  if (!u || !bcrypt.compareSync(String(password || ''), u.password)) {
    loginSecurity.recordFailure(username || '', ip, 'credencial_invalida');
    return res.status(401).json({ error: 'Usuário ou senha inválidos' });
  }
  loginSecurity.recordSuccess(u.username, ip);
  const expiresIn = process.env.JWT_EXPIRES_IN || '12h';
  const token = jwt.sign({ sub: u.id, username: u.username, role: u.role, nome: u.nome }, JWT_SECRET, {
    expiresIn,
  });
  res.json({ token, user: publicUser(u), tokenExpiresIn: expiresIn });
});

app.get('/api/me', authMiddleware, (req, res) => {
  const u = users.find((x) => x.id === req.user.sub);
  if (!u) return res.status(404).json({ error: 'Usuário não encontrado' });
  res.json(publicUser(u));
});

app.get('/api/notificacoes', authMiddleware, (req, res) => {
  refreshAtrasadas();
  const visivel = notificacoes.filter((n) => (n.monitoramentoOrigem || 'MPMA') !== 'DOM');
  res.json(visivel);
});

app.get('/api/relatorios/desempenho', authMiddleware, requireRoles('admin_master', 'admin', 'executivo', 'prefeito'), (req, res) => {
  const p = String(req.query.periodo || 'semana').toLowerCase();
  if (!['dia', 'semana', 'mes'].includes(p)) return res.status(400).json({ error: 'periodo: dia | semana | mes' });
  res.json(buildDesempenho(p));
});

app.get('/api/admin/login-logs', authMiddleware, requireRoles('admin_master', 'admin'), (req, res) => {
  res.json({ logs: loginSecurity.getLogsSlice(300) });
});

/** Dados reais do site TCE-MA filtrados para Buriticupu (crawler periódico) */
app.get('/api/tcema/buriticupu', authMiddleware, (req, res) => {
  res.json(tceCrawler.getTceMaState());
});

app.get('/api/insights/nomes-recorrentes', authMiddleware, requireRoles('admin_master', 'admin', 'executivo', 'prefeito'), (req, res) => {
  res.json({ itens: buildNomesRecorrentes() });
});

app.get('/api/usuarios/assignable', authMiddleware, requireRoles('admin_master', 'admin', 'executivo', 'prefeito'), (req, res) => {
  res.json(
    users.map((u) => ({
      id: u.id,
      nome: u.nome,
      init: u.init,
      whatsapp: u.whatsapp || '',
    }))
  );
});

app.patch('/api/notificacoes/:id', authMiddleware, (req, res) => {
  const { id } = req.params;
  const n = notificacoes.find((x) => x.id === id);
  if (!n) return res.status(404).json({ error: 'Notificação não encontrada' });
  const prevStatus = n.status;
  const actor = { sub: req.user.sub, nome: req.user.nome, username: req.user.username };
  if (req.user.role === 'usuario') {
    const extra = Object.keys(req.body || {}).filter((k) => !['status'].includes(k));
    if (extra.length) return res.status(403).json({ error: 'Apenas atualização de status permitida' });
  }
  if (req.body.status) {
    let allowed = ['novo', 'analise', 'urgente', 'respondido', 'atrasada'];
    if (req.user.role === 'usuario') allowed = ['novo', 'analise', 'urgente', 'respondido'];
    if (!allowed.includes(req.body.status)) return res.status(400).json({ error: 'Status inválido' });
    n.status = req.body.status;
    if (req.body.status !== prevStatus) timelinePush(n, `Status alterado → ${req.body.status}`, actor);
  }
  if (['admin_master', 'admin', 'executivo', 'prefeito'].includes(req.user.role)) {
    if (req.body.comentarios) n.comentarios = req.body.comentarios;
    if (req.body.responsavelId !== undefined) {
      const rid = req.body.responsavelId;
      if (rid === null || rid === '') {
        if (n.responsavelId) timelinePush(n, 'Responsável removido', actor);
        n.responsavelId = null;
        n.responsavelNome = null;
      } else {
        const ru = users.find((x) => x.id === rid);
        if (ru) {
          n.responsavelId = rid;
          n.responsavelNome = ru.nome;
          timelinePush(n, `Responsável definido: ${ru.nome}`, actor);
        }
      }
    }
    if (req.body.prioridade !== undefined) {
      const was = !!n.prioridade;
      n.prioridade = !!req.body.prioridade;
      if (was !== n.prioridade) {
        timelinePush(n, n.prioridade ? 'Marcada como prioridade máxima' : 'Prioridade máxima revogada', actor);
      }
    }
  }
  persistNots();
  if (req.body.status === 'respondido' && prevStatus !== 'respondido') {
    const u = users.find((x) => x.id === req.user.sub);
    io.emit('processo_respondido', {
      notifId: n.id,
      titulo: n.titulo,
      userId: req.user.sub,
      nome: u ? u.nome : '',
    });
  }
  res.json(n);
});

/** Log de acesso persistente (PDF / resposta) */
app.post('/api/notificacoes/:id/access-log', authMiddleware, (req, res) => {
  const n = notificacoes.find((x) => x.id === req.params.id);
  if (!n) return res.status(404).json({ error: 'Notificação não encontrada' });
  const u = users.find((x) => x.id === req.user.sub);
  if (!u) return res.status(404).json({ error: 'Usuário não encontrado' });
  if (!Array.isArray(n.accessLog)) n.accessLog = [];
  const { tipo } = req.body || {};
  const hora = new Date().toLocaleString('pt-BR');
  const iso = new Date().toISOString();
  if (tipo === 'abriu_denuncia') {
    n.accessLog.push({
      user: u.nome,
      userId: u.id,
      init: u.init,
      color: u.color,
      hora,
      iso,
      acao: `${u.nome} acessou o link da denúncia`,
      abriuDenuncia: true,
      pdf: false,
      respondeu: false,
    });
    if (n.status === 'novo') {
      n.status = 'analise';
    }
  } else if (tipo === 'pdf_view') {
    const dup = n.accessLog.some((a) => a.user === u.nome && a.pdf && !a.respondeu);
    if (!dup) {
      n.accessLog.push({
        user: u.nome,
        userId: u.id,
        init: u.init,
        color: u.color,
        hora,
        iso,
        acao: 'Visualizou PDF',
        pdf: true,
        respondeu: false,
      });
      timelinePush(n, `${u.nome} visualizou o PDF`, { sub: u.id, nome: u.nome });
    }
  } else if (tipo === 'resposta') {
    const row = n.accessLog.find((a) => a.user === u.nome);
    if (row) {
      row.respondeu = true;
      row.hora = hora;
      row.iso = iso;
    } else {
      n.accessLog.push({
        user: u.nome,
        userId: u.id,
        init: u.init,
        color: u.color,
        hora,
        iso,
        acao: 'Respondeu',
        pdf: false,
        respondeu: true,
      });
    }
    timelinePush(n, `${u.nome} registou resposta formal`, { sub: u.id, nome: u.nome });
  } else {
    return res.status(400).json({ error: 'tipo inválido (abriu_denuncia | pdf_view | resposta)' });
  }
  persistNots();
  res.json(n);
});

/** Comentários internos — qualquer utilizador autenticado pode adicionar */
app.post('/api/notificacoes/:id/comentarios', authMiddleware, (req, res) => {
  const n = notificacoes.find((x) => x.id === req.params.id);
  if (!n) return res.status(404).json({ error: 'Notificação não encontrada' });
  const texto = String(req.body?.texto || '').trim();
  if (!texto) return res.status(400).json({ error: 'Texto vazio' });
  const u = users.find((x) => x.id === req.user.sub);
  if (!u) return res.status(404).json({ error: 'Usuário não encontrado' });
  if (!Array.isArray(n.comentarios)) n.comentarios = [];
  n.comentarios.push({
    autor: u.nome,
    hora: new Date().toLocaleString('pt-BR'),
    texto,
  });
  const hora = new Date().toLocaleString('pt-BR');
  const iso = new Date().toISOString();
  if (!Array.isArray(n.accessLog)) n.accessLog = [];
  n.accessLog.push({
    user: u.nome,
    userId: u.id,
    init: u.init,
    color: u.color,
    hora,
    iso,
    acao: `${u.nome} comentou (interno)`,
    pdf: false,
    respondeu: false,
    comentou: true,
  });
  if (n.status === 'novo') n.status = 'analise';
  const prev = texto.slice(0, 80) + (texto.length > 80 ? '…' : '');
  timelinePush(n, `Comentário interno: ${prev}`, { sub: u.id, nome: u.nome });
  persistNots();
  res.json(n);
});

/** Chat por denúncia */
app.get('/api/notificacoes/:id/chat', authMiddleware, (req, res) => {
  const n = notificacoes.find((x) => x.id === req.params.id);
  if (!n) return res.status(404).json({ error: 'Notificação não encontrada' });
  const msgs = getChatMessages(req.params.id);
  res.json(msgs.slice(-200));
});

app.post('/api/notificacoes/:id/chat', authMiddleware, (req, res) => {
  const notifId = req.params.id;
  const n = notificacoes.find((x) => x.id === notifId);
  if (!n) return res.status(404).json({ error: 'Notificação não encontrada' });
  const texto = String(req.body?.texto || '').trim();
  if (!texto) return res.status(400).json({ error: 'Texto vazio' });
  const u = users.find((x) => x.id === req.user.sub);
  if (!u) return res.status(404).json({ error: 'Usuário não encontrado' });
  const msg = {
    id: 'm' + Date.now() + Math.random().toString(36).slice(2, 9),
    userId: u.id,
    nome: u.nome,
    init: u.init,
    color: u.color,
    texto: texto.slice(0, 4000),
    hora: new Date().toLocaleString('pt-BR'),
    iso: new Date().toISOString(),
  };
  const arr = getChatMessages(notifId);
  arr.push(msg);
  if (arr.length > 500) arr.splice(0, arr.length - 500);
  persistChats();
  io.emit('chat:message', { notifId, message: msg });
  res.json({ message: msg });
});

/** Gestão de usuários */
function userRowForAdmin(u) {
  return { ...publicUser(u), hasPassword: true, email: u.email || '', phone: u.phone || '', whatsapp: u.whatsapp || '' };
}

app.get('/api/usuarios', authMiddleware, requireRoles('admin_master', 'admin', 'prefeito'), (req, res) => {
  res.json(users.map((u) => userRowForAdmin(u)));
});

app.post('/api/usuarios', authMiddleware, requireRoles('admin_master', 'admin', 'prefeito'), (req, res) => {
  const { username, nome, password, role, cargo, init, color, email, phone, whatsapp } = req.body || {};
  if (!username || !nome || !password || !role) return res.status(400).json({ error: 'Campos obrigatórios: username, nome, password, role' });
  const allowedRoles = ['admin_master', 'admin', 'executivo', 'usuario', 'prefeito'];
  if (!allowedRoles.includes(role)) return res.status(400).json({ error: 'Role inválida' });
  if (req.user.role === 'prefeito' && !['executivo', 'usuario'].includes(role)) {
    return res.status(403).json({ error: 'Prefeito só pode criar perfis executivo ou usuario' });
  }
  if (req.user.role === 'admin' && role === 'admin_master') return res.status(403).json({ error: 'Apenas admin_master pode criar outro admin_master' });
  if (findUserByUsername(username)) return res.status(409).json({ error: 'Username já existe' });
  const nu = normalizeUser({
    id: 'u' + Date.now(),
    username: String(username).trim().toLowerCase(),
    nome: String(nome).trim(),
    password: bcrypt.hashSync(String(password), 10),
    role,
    cargo: cargo || 'Servidor',
    init: (init || nome).slice(0, 2).toUpperCase(),
    color: color || '#1a3d78',
    email: email != null ? String(email).trim() : '',
    phone: phone != null ? String(phone).trim() : '',
    whatsapp: whatsapp != null ? String(whatsapp).trim() : '',
  });
  users.push(nu);
  writeJson(USERS_FILE, users);
  res.status(201).json(publicUser(nu));
});

app.patch('/api/usuarios/:id', authMiddleware, requireRoles('admin_master', 'admin', 'prefeito'), (req, res) => {
  const u = users.find((x) => x.id === req.params.id);
  if (!u) return res.status(404).json({ error: 'Não encontrado' });
  if (req.user.role === 'prefeito' && ['admin_master', 'admin', 'prefeito'].includes(u.role)) {
    return res.status(403).json({ error: 'Prefeito não pode alterar administradores ou outro prefeito' });
  }
  if (req.user.role === 'admin' && u.role === 'admin_master') return res.status(403).json({ error: 'Sem permissão' });
  const { nome, cargo, role, password, email, phone, whatsapp } = req.body || {};
  if (nome) u.nome = nome;
  if (cargo) u.cargo = cargo;
  if (email !== undefined) u.email = String(email || '').trim();
  if (phone !== undefined) u.phone = String(phone || '').trim();
  if (whatsapp !== undefined) u.whatsapp = String(whatsapp || '').trim();
  if (role) {
    if (req.user.role === 'prefeito' && !['executivo', 'usuario'].includes(role)) {
      return res.status(403).json({ error: 'Prefeito só pode atribuir perfil executivo ou usuario' });
    }
    if (req.user.role === 'admin' && role === 'admin_master') return res.status(403).json({ error: 'Sem permissão' });
    u.role = role;
  }
  if (password) {
    const self = u.id === req.user.sub;
    if (!self && !['admin_master', 'admin', 'prefeito'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Sem permissão para alterar senha de outro usuário' });
    }
    if (req.user.role === 'prefeito' && !self && ['admin_master', 'admin', 'prefeito'].includes(u.role)) {
      return res.status(403).json({ error: 'Sem permissão' });
    }
    u.password = bcrypt.hashSync(String(password), 10);
  }
  writeJson(USERS_FILE, users);
  res.json(publicUser(u));
});

app.get('/api/monitor/servidores', authMiddleware, requireRoles('admin_master', 'admin'), (req, res) => {
  const lista = servidores.getListaMonitoramento();
  res.json({
    ...servidores.getMeta(),
    totalLista: lista.length,
    amostra: lista.slice(0, 30),
  });
});

app.post('/api/monitor/servidores/refresh', authMiddleware, requireRoles('admin_master', 'admin'), async (req, res) => {
  try {
    const rows = await servidores.refreshServidoresNominal();
    res.json({ ok: true, total: rows.length, meta: servidores.getMeta() });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message, meta: servidores.getMeta() });
  }
});

app.use(express.static(PUBLIC_DIR));

function ingestNotificacoesDiario(novos) {
  let any = false;
  for (const novo of novos) {
    if (notificacoes.some((x) => x.id === novo.id)) {
      diarioSeenIds.add(novo.id);
      continue;
    }
    notificacoes.unshift(novo);
    any = true;
    io.emit('nova_notificacao', {
      id: novo.id,
      titulo: novo.titulo,
      pdfUrl: novo.pdfUrl,
      monitoramentoOrigem: novo.monitoramentoOrigem,
    });
    sendWhatsAppNewNotif(novo, users).catch((e) => console.error('[notify] WA diário:', e.message));
    sendEmailNewNotif(
      novo,
      users.filter((u) => ['admin_master', 'admin', 'executivo', 'prefeito'].includes(u.role))
    ).catch((e) => console.error('[notify] Mail diário:', e.message));
  }
  if (any) persistNots();
  persistDiarioSeen();
}

/** DOM municipal Buriticupu — PDFs reais, texto real, atualização overlay de secretários */
async function runDomMunicipalMonitor() {
  if (process.env.MONITOR_DIARIOS_OFF === '1' || String(process.env.MONITOR_DIARIOS_OFF).toLowerCase() === 'true') {
    return;
  }
  if (process.env.MONITOR_DOM_OFF === '1') return;
  const maxDom = Math.min(60, Math.max(1, parseInt(process.env.MONITOR_DOM_MAX || '25', 10) || 25));
  let novos = [];
  try {
    novos = await runDomCrawler({ seenIds: diarioSeenIds, maxItems: maxDom });
  } catch (e) {
    console.warn('[DOM municipal]', e.message);
    return;
  }
  ingestNotificacoesDiario(novos);
}

/** DOU + DOE — opcional (MONITOR_DOU_DOE=1) */
async function runDiariosFederaisEstaduaisMonitor() {
  if (process.env.MONITOR_DIARIOS_OFF === '1' || String(process.env.MONITOR_DIARIOS_OFF).toLowerCase() === 'true') {
    return;
  }
  if (process.env.MONITOR_DOU_DOE !== '1') return;
  const maxDou = Math.min(50, Math.max(1, parseInt(process.env.MONITOR_DOU_MAX || '12', 10) || 12));
  const maxDoe = Math.min(50, Math.max(1, parseInt(process.env.MONITOR_DOE_MAX || '12', 10) || 12));
  const runners = [
    () => runDouCrawler({ seenIds: diarioSeenIds, maxItems: maxDou }),
    () => runDoeCrawler({ seenIds: diarioSeenIds, maxItems: maxDoe }),
  ];
  for (const run of runners) {
    let novos = [];
    try {
      novos = await run();
    } catch (e) {
      console.warn('[DOU/DOE]', e.message);
      continue;
    }
    ingestNotificacoesDiario(novos);
  }
}

async function runMpmaMonitor() {
  let seen = getSeenSet();
  let links = [];
  try {
    links = await mpma.carregarHistoricoMPMA();
  } catch (e) {
    console.error('[MPMA] Erro ao listar diário:', e.message);
    return;
  }
  const listaMonitoramento = servidores.getListaMonitoramento();
  if (!listaMonitoramento.length) {
    console.warn('[MPMA] Lista de servidores vazia — nenhum PDF será aceite até haver dados do nominal (site) ou .env.');
  }
  for (const pdfUrl of links) {
    const canonicalUrl = mpma.normalizeMpmaPdfUrl(pdfUrl);
    if (!canonicalUrl) {
      console.warn('[MPMA] URL inválida ou fora de *.mpma.mp.br — ignorado:', String(pdfUrl).slice(0, 96));
      continue;
    }
    if (seen.has(canonicalUrl)) continue;

    let text = '';
    let pdfBinarioSha256 = null;
    try {
      const parsed = await mpma.downloadAndParsePdf(canonicalUrl);
      text = parsed.text;
      pdfBinarioSha256 = parsed.pdfBinarioSha256;
    } catch (e) {
      console.error('[MPMA] Falha ao baixar/ler PDF:', canonicalUrl, e.message);
      seen.add(canonicalUrl);
      saveSeenSet(seen);
      continue;
    }
    seen.add(canonicalUrl);
    saveSeenSet(seen);

    if (!mpma.validateMpmaPdfContentForDenuncia(text, listaMonitoramento)) {
      console.warn(
        `[MPMA] PDF rejeitado (Buriticupu + ≥1 nome da lista de monitoramento + ≥${mpma.MIN_MPMA_PDF_TEXT_CHARS} caracteres) — não gravado:`,
        String(canonicalUrl).slice(0, 96)
      );
      continue;
    }

    const matched = mpma.findMatchedNames(text, listaMonitoramento);
    if (!matched.length) continue;

    const novo = mpma.buildDiarioNotification(canonicalUrl, matched, text, pdfBinarioSha256);
    if (notificacoes.some((x) => x.id === novo.id)) continue;

    novo.ia.resumo = novo.descricao;
    delete novo.ia.recomendacao;
    novo.classificacaoRisco = null;
    if (process.env.MPMA_OPENAI_ANALISE === '1') {
      try {
        const aiResult = await analyzePdfText(text, {
          matchedNames: matched.map((p) => p.nome),
          extracaoPdf: novo.mpmaExtracao,
        });
        novo.ia = mergeIaIntoNotification(novo.ia, aiResult);
        novo.urgencia = aiResult.urgencia || novo.urgencia;
        novo.classificacaoRisco = aiResult.risco;
        delete novo.ia.recomendacao;
        novo.ia.resumo = novo.descricao;
      } catch (e) {
        console.error('[MPMA] IA:', e.message);
      }
    }
    if (novo.urgencia === 'Alta') novo.status = 'urgente';
    notificacoes.unshift(novo);
    persistNots();
    io.emit('nova_notificacao', { id: novo.id, titulo: novo.titulo, pdfUrl: novo.pdfUrl, monitoramentoOrigem: 'MPMA' });
    console.log('[MPMA] Nova notificação criada:', novo.id, matched.map((p) => p.nome).join(', '));
    sendWhatsAppNewNotif(novo, users).catch((e) => console.error('[notify] WA:', e.message));
    sendEmailNewNotif(
      novo,
      users.filter((u) => ['admin_master', 'admin', 'executivo', 'prefeito'].includes(u.role))
    ).catch((e) => console.error('[notify] Mail:', e.message));
  }
}

cron.schedule('*/10 * * * *', () => {
  runDomMunicipalMonitor().catch((e) => console.error('[DOM cron]', e));
  runDiariosFederaisEstaduaisMonitor().catch((e) => console.error('[DOU/DOE cron]', e));
});

mpmaService.iniciarMonitoramento(() => runMpmaMonitor().catch((e) => console.error('[MPMA cron]', e)));

cron.schedule('*/30 * * * *', () => {
  tceCrawler.runTceMaBuriticupuCrawl().catch((e) => console.error('[TCE-MA cron]', e.message));
});

/** Lista nominal da prefeitura: atualização automática ~1×/24h (site oficial). */
cron.schedule('0 6 * * *', () => {
  servidores.refreshServidoresNominal().catch((e) => console.warn('[servidores] agendado:', e.message));
});

cron.schedule('5 * * * *', () => {
  try {
    if (refreshAtrasadas()) io.emit('prazos_atualizados', { t: todayISO() });
  } catch (e) {
    console.warn('[prazos] cron:', e.message);
  }
});

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  const indexFile = path.join(PUBLIC_DIR, 'index.html');
  if (fs.existsSync(indexFile)) return res.sendFile(indexFile);
  next();
});

io.use((socket, next) => {
  try {
    const token = socket.handshake.auth?.token || socket.handshake.query?.token;
    if (!token) return next(new Error('unauthorized'));
    const p = jwt.verify(String(token), JWT_SECRET);
    socket.userId = p.sub;
    socket.userNome = p.nome || p.username;
    next();
  } catch {
    next(new Error('unauthorized'));
  }
});

io.on('connection', (socket) => {
  onlineSockets.set(socket.id, { userId: socket.userId, nome: socket.userNome });
  broadcastPresence();

  socket.on('disconnect', () => {
    onlineSockets.delete(socket.id);
    broadcastPresence();
  });

  socket.on('join:notif', (notifId) => {
    if (!notifId || typeof notifId !== 'string') return;
    socket.join(`notif:${notifId}`);
    const msgs = getChatMessages(notifId);
    socket.emit('chat:history', { notifId, messages: msgs.slice(-200) });
  });

  socket.on('leave:notif', (notifId) => {
    if (notifId) socket.leave(`notif:${notifId}`);
  });

  socket.on('chat:send', (payload) => {
    const notifId = payload?.notifId;
    const texto = String(payload?.texto || '').trim();
    if (!notifId || !texto) return;
    const n = notificacoes.find((x) => x.id === notifId);
    if (!n) return;
    const u = users.find((x) => x.id === socket.userId);
    if (!u) return;
    const msg = {
      id: 'm' + Date.now() + Math.random().toString(36).slice(2, 9),
      userId: u.id,
      nome: u.nome,
      init: u.init,
      color: u.color,
      texto: texto.slice(0, 4000),
      hora: new Date().toLocaleString('pt-BR'),
      iso: new Date().toISOString(),
    };
    const arr = getChatMessages(notifId);
    arr.push(msg);
    if (arr.length > 500) arr.splice(0, arr.length - 500);
    persistChats();
    io.emit('chat:message', { notifId, message: msg });
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`PlataformaMP → http://127.0.0.1:${PORT} e http://localhost:${PORT}`);
  servidores.loadCacheFromDisk();
  servidoresService.carregarServidores();
  servidores.refreshServidoresNominal().catch((e) => console.warn('[servidores] Carga inicial:', e.message));
  setTimeout(() => runMpmaMonitor().catch(console.error), 3000);
  setTimeout(() => runDomMunicipalMonitor().catch((e) => console.warn('[DOM] arranque:', e.message)), 12000);
  setTimeout(() => runDiariosFederaisEstaduaisMonitor().catch((e) => console.warn('[DOU/DOE] arranque:', e.message)), 20000);
  setTimeout(() => tceCrawler.runTceMaBuriticupuCrawl().catch((e) => console.warn('[TCE-MA] arranque:', e.message)), 25000);
});
