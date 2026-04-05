require('dotenv').config();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const {
  authMiddleware,
  requireRoles,
  JWT_SECRET,
  extractJwtFromRequest,
} = require('./middlewares/authMiddleware');
const {
  validatePmVisitorPayload,
  visitorApiAllowed,
  visitorSpaAllowed,
  visitorSpaBlocked,
} = require('./services/accessTokenAuth');
const { createUserLifecycleHandlers } = require('./controllers/userController');
const { registerUserAdminRoutes } = require('./routes/userRoutes');
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
const { sendWhatsAppNewNotif, sendEmailNewNotif, sendRelatorioDiarioEmail } = require('./notify');
const { classifyDenunciaNivel } = require('./services/denunciaClassifier');
const { appendPlatformAudit } = require('./services/platformAuditLog');
const loginSecurity = require('./services/loginSecurity');
const tceCrawler = require('./services/tceCrawler');
const relatorioService = require('./services/relatorioService');

const PORT = process.env.PORT || 3780;

const ROLES_ALVO_EMAIL_NOTIF = ['admin_master', 'admin', 'executivo', 'prefeito', 'juridico'];
const ROLES_RELATORIOS_LEITURA = ['admin_master', 'admin', 'executivo', 'prefeito', 'juridico', 'auditor'];
/** Escuta em todas as interfaces (ex.: telemóvel na mesma Wi‑Fi). Use HOST=127.0.0.1 só para bloquear acesso externo. */
const HOST = (process.env.HOST || '0.0.0.0').trim();
const GOOGLE_CLIENT_ID = (process.env.GOOGLE_CLIENT_ID || '').trim();
const DATA_DIR = path.join(__dirname, '..', 'data');

const USERS_FILE = path.join(DATA_DIR, 'users.json');
const NOTS_FILE = path.join(DATA_DIR, 'notificacoes.json');
const CHATS_FILE = path.join(DATA_DIR, 'chats-por-notificacao.json');
const SEEN_DIARIO_FILE = path.join(DATA_DIR, 'monitoramento-diarios-seen.json');
const ACCESS_TOKENS_FILE = path.join(DATA_DIR, 'access-tokens.json');

function readAccessTokens() {
  const arr = readJson(ACCESS_TOKENS_FILE, []);
  return Array.isArray(arr) ? arr : [];
}

function writeAccessTokens(list) {
  writeJson(ACCESS_TOKENS_FILE, list);
}

function accessTokenRecordStatus(rec) {
  if (rec.revogado) return 'Revogado';
  const exp = new Date(rec.expiraEm).getTime();
  if (Number.isNaN(exp) || Date.now() > exp) return 'Expirado';
  return 'Ativo';
}

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
  if (o.ativo === undefined) o.ativo = true;
  if (!o.createdAt) o.createdAt = new Date().toISOString();
  return o;
}

function initUsers() {
  ensureData();
  let users = readJson(USERS_FILE, null);
  if (!users || !users.length) {
    const hash = bcrypt.hashSync('@bur123', 10);
    const t0 = new Date().toISOString();
    users = [
      { id: 'u1', username: 'alef.mendes', nome: 'Alef Mendes', password: hash, role: 'admin_master', cargo: 'TI / Admin', init: 'AM', color: '#9b2a1b', email: '', phone: '', whatsapp: '', ativo: true, createdAt: t0 },
      { id: 'u2', username: 'denis', nome: 'Denis', password: hash, role: 'admin', cargo: 'Administrador', init: 'DN', color: '#1a3d78', email: '', phone: '', whatsapp: '', ativo: true, createdAt: t0 },
      { id: 'u3', username: 'whesley', nome: 'Whesley', password: hash, role: 'admin', cargo: 'Administrador', init: 'WH', color: '#175a36', email: '', phone: '', whatsapp: '', ativo: true, createdAt: t0 },
      { id: 'u4', username: 'joao.carlos', nome: 'João Carlos', password: hash, role: 'executivo', cargo: 'Executivo', init: 'JC', color: '#5b21b6', email: '', phone: '', whatsapp: '', ativo: true, createdAt: t0 },
      { id: 'u5', username: 'vandercleber', nome: 'Vandercleber', password: hash, role: 'usuario', cargo: 'Usuário', init: 'VC', color: '#8a6820', email: '', phone: '', whatsapp: '', ativo: true, createdAt: t0 },
      { id: 'u6', username: 'prefeito', nome: 'Prefeito (Executivo)', password: hash, role: 'prefeito', cargo: 'Prefeitura', init: 'PF', color: '#0f172a', email: '', phone: '', whatsapp: '', ativo: true, createdAt: t0 },
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
  if (o.secretarioDetectado === undefined) o.secretarioDetectado = '';
  if (!Array.isArray(o.mpmaSecretarias)) o.mpmaSecretarias = [];
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
  if (o.nivelDenuncia === undefined || o.nivelDenuncia === null || o.nivelDenuncia === '') {
    const cl = classifyDenunciaNivel(o);
    o.nivelDenuncia = cl.nivelDenuncia;
    if (cl.keywordHits && cl.keywordHits.length) o.nivelDenunciaKeywords = cl.keywordHits;
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
  const execProcRoles = ['admin_master', 'admin', 'executivo', 'prefeito', 'juridico'];
  return {
    id: u.id,
    username: u.username,
    nome: u.nome,
    role: u.role,
    cargo: u.cargo,
    init: u.init,
    color: u.color,
    ativo: u.ativo !== false,
    exec: execProcRoles.includes(u.role),
    proc: execProcRoles.includes(u.role),
    isUsuario: u.role === 'usuario',
    isAuditor: u.role === 'auditor',
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
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS', 'HEAD'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);
app.use(express.json({ limit: '2mb' }));

/** Log de pedidos HTTP (opcional: ACCESS_LOG=1 ou true no .env) */
function accessLogMiddleware(req, res, next) {
  if (process.env.ACCESS_LOG !== '1' && process.env.ACCESS_LOG !== 'true') return next();
  const start = Date.now();
  const ip = req.ip || req.socket.remoteAddress || '-';
  res.on('finish', () => {
    console.log(`[acesso] ${new Date().toISOString()} ${ip} ${req.method} ${req.originalUrl || req.url} ${res.statusCode} ${Date.now() - start}ms`);
  });
  next();
}
app.use(accessLogMiddleware);

/** Visitante: só rotas API explicitamente permitidas (processos / visualizar vía API). */
app.use((req, res, next) => {
  if (!req.path.startsWith('/api')) return next();
  const token = extractJwtFromRequest(req);
  if (!token) return next();
  let decoded;
  try {
    decoded = jwt.verify(token, JWT_SECRET);
  } catch {
    return next();
  }
  if (decoded.type !== 'pm_visitor') return next();
  if (!validatePmVisitorPayload(decoded)) return next();
  if (!visitorApiAllowed(req.method, req.path)) {
    return res.status(403).json({ error: 'Visitante: rota não autorizada' });
  }
  next();
});

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

let users = initUsers();
let notificacoes = initNotificacoes();

/** Bloqueia tokens válidos de contas desativadas (soft delete). Visitante (link) passa sem users.json. */
function requireActiveUser(req, res, next) {
  if (req.user && req.user.visitante) return next();
  const u = users.find((x) => x.id === req.user.sub);
  if (!u) return res.status(401).json({ error: 'Utilizador não encontrado' });
  if (u.ativo === false) return res.status(403).json({ error: 'Conta desativada' });
  next();
}

/** Perfil auditor: não altera processos, comentários nem chat (mantém leitura e access-log). */
function auditorReadOnly(req, res, next) {
  if (!req.user || req.user.visitante) return next();
  const u = users.find((x) => x.id === req.user.sub);
  if (!u || u.role !== 'auditor') return next();
  return res.status(403).json({ error: 'Perfil auditor: apenas leitura.' });
}

function verifyJwtForSpaPath(token) {
  try {
    const decoded = jwt.verify(String(token), JWT_SECRET);
    if (decoded.type === 'pm_visitor') return validatePmVisitorPayload(decoded);
    const u = users.find((x) => x.id === decoded.sub);
    return !!(u && u.ativo !== false);
  } catch {
    return false;
  }
}

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
    if (u.ativo === false) continue;
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

function parseRecebidoToDate(s) {
  const m = String(s || '').match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (!m) return null;
  const d = new Date(+m[3], +m[2] - 1, +m[1]);
  return Number.isNaN(d.getTime()) ? null : d;
}

function notifSecretariaLabel(n) {
  const sec =
    n.secretaria || (Array.isArray(n.mpmaSecretarias) && n.mpmaSecretarias[0]) || n.secretarioDetectado || '—';
  return String(sec).trim() || '—';
}

function buildDashboardKpis() {
  const vis = notificacoes.filter((n) => (n.monitoramentoOrigem || 'MPMA') !== 'DOM');
  const risco = { normal: 0, atencao: 0, critico: 0 };
  for (const n of vis) {
    const nv = n.nivelDenuncia || 'normal';
    if (nv === 'critico') risco.critico += 1;
    else if (nv === 'atencao') risco.atencao += 1;
    else risco.normal += 1;
  }
  const secMap = new Map();
  for (const n of vis) {
    const label = notifSecretariaLabel(n);
    if (!secMap.has(label)) {
      secMap.set(label, { secretaria: label, total: 0, urgentes: 0, criticos: 0 });
    }
    const row = secMap.get(label);
    row.total += 1;
    if (n.status === 'urgente' || n.status === 'atrasada') row.urgentes += 1;
    if (n.nivelDenuncia === 'critico') row.criticos += 1;
  }
  const rankingSecretarias = [...secMap.values()].sort(
    (a, b) => b.total - a.total || a.secretaria.localeCompare(b.secretaria)
  );
  const now = new Date();
  const startWeek = new Date(now);
  startWeek.setDate(now.getDate() - 7);
  const startMonth = new Date(now);
  startMonth.setDate(now.getDate() - 30);
  let novos7 = 0;
  let novos30 = 0;
  for (const n of vis) {
    const d = parseRecebidoToDate(n.recebido);
    if (d && d >= startWeek) novos7 += 1;
    if (d && d >= startMonth) novos30 += 1;
  }
  const serieSemanal = [];
  for (let w = 7; w >= 0; w -= 1) {
    const end = new Date(now);
    end.setDate(end.getDate() - w * 7);
    end.setHours(23, 59, 59, 999);
    const start = new Date(end);
    start.setDate(start.getDate() - 6);
    start.setHours(0, 0, 0, 0);
    let c = 0;
    for (const n of vis) {
      const d = parseRecebidoToDate(n.recebido);
      if (d && d >= start && d <= end) c += 1;
    }
    serieSemanal.push({ label: `J-${w}`, count: c });
  }
  const serieMensal = [];
  for (let m = 5; m >= 0; m -= 1) {
    const ref = new Date(now.getFullYear(), now.getMonth() - m, 1);
    const y = ref.getFullYear();
    const mo = ref.getMonth();
    const label = `${String(mo + 1).padStart(2, '0')}/${String(y).slice(2)}`;
    let c = 0;
    for (const n of vis) {
      const d = parseRecebidoToDate(n.recebido);
      if (d && d.getFullYear() === y && d.getMonth() === mo) c += 1;
    }
    serieMensal.push({ label, count: c });
  }
  return {
    totalCarteira: vis.length,
    riscoPorNivel: risco,
    rankingSecretarias: rankingSecretarias.slice(0, 24),
    novosUltimos7Dias: novos7,
    novosUltimos30Dias: novos30,
    serieSemanal,
    serieMensal,
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
    if (!u || u.ativo === false) continue;
    byUser.set(uid, { userId: u.id, nome: u.nome, cargo: u.cargo || '', role: u.role || '' });
  }
  io.emit('presence:users', { users: [...byUser.values()] });
}

function findUserByUsername(username) {
  const u = String(username || '').trim().toLowerCase();
  return users.find((x) => x.username.toLowerCase() === u && x.ativo !== false);
}

function normEmail(e) {
  return String(e || '')
    .trim()
    .toLowerCase();
}

function findUserByEmail(email) {
  const n = normEmail(email);
  if (!n) return null;
  return users.find((x) => normEmail(x.email) === n && x.ativo !== false);
}

/** Verificação de alcance externo (IP público + port forwarding) — sem autenticação, sem dados sensíveis */
app.get('/status', (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || '-';
  console.log(`[status] ${new Date().toISOString()} ip=${ip} ${req.method} ${req.originalUrl || req.url}`);
  res.json({ status: 'online', acessoExterno: true });
});

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
    relatorioPdfSoffice: !!relatorioService.findSofficePath(),
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
  if (req.user.visitante) {
    try {
      const list = readAccessTokens();
      const idx = list.findIndex((x) => x.id === req.user.jti);
      if (idx >= 0 && !list[idx].acessadoEm) {
        list[idx].acessadoEm = new Date().toISOString();
        writeAccessTokens(list);
      }
    } catch (_) {
      /* ignorar */
    }
    const email = req.user.email || '';
    const nome = email.includes('@') ? email.split('@')[0] : email || 'Visitante';
    return res.json({
      id: req.user.jti,
      username: email,
      nome,
      role: 'visitante',
      cargo: 'Visitante',
      init: nome.slice(0, 2).toUpperCase(),
      color: '#64748b',
      ativo: true,
      exec: false,
      proc: false,
      isUsuario: true,
      email,
      accessNotifId: req.user.notifId,
    });
  }
  const u = users.find((x) => x.id === req.user.sub);
  if (!u) return res.status(404).json({ error: 'Usuário não encontrado' });
  if (u.ativo === false) return res.status(403).json({ error: 'Conta desativada. Contacte um administrador.' });
  res.json(publicUser(u));
});

/** Contadores e estado para o menu lateral (badges, sistema) — validado por JWT */
app.get('/api/menu-status', authMiddleware, requireActiveUser, (req, res) => {
  if (req.user.visitante) {
    return res.json({
      notificacoes: 1,
      notificacoesNovas: 0,
      auditoria: 0,
      relatoriosHoje: 0,
      sistema: 'online',
      mpmaMonitorAtivo: false,
      denunciaGrave: false,
    });
  }
  refreshAtrasadas();
  const vis = notificacoes.filter((n) => (n.monitoramentoOrigem || 'MPMA') !== 'DOM');
  const notificacoesPainel = vis.filter((n) => ['novo', 'urgente', 'atrasada'].includes(n.status)).length;
  const notificacoesNovas = vis.filter((n) => n.status === 'novo').length;
  const auditoria = vis.filter((n) => n.status === 'urgente' || n.status === 'atrasada' || n.prioridade).length;
  let relatoriosHoje = 0;
  try {
    const dir = relatorioService.RELATORIOS_DIR;
    if (fs.existsSync(dir)) {
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      for (const f of fs.readdirSync(dir)) {
        if (!/\.(pdf|docx)$/i.test(f)) continue;
        const st = fs.statSync(path.join(dir, f));
        if (st.mtime >= start) relatoriosHoje += 1;
      }
    }
  } catch (_) {
    relatoriosHoje = 0;
  }
  const denunciaGrave = vis.some((n) => {
    if (n.status === 'urgente' || n.status === 'atrasada') return true;
    if (n.nivelDenuncia === 'critico') return true;
    const g = n.gravidadePdf && String(n.gravidadePdf.nivel || '').toUpperCase();
    return g && (g.includes('CRIT') || g.includes('CRÍT'));
  });
  res.json({
    notificacoes: notificacoesPainel,
    notificacoesNovas,
    auditoria,
    relatoriosHoje,
    sistema: 'online',
    mpmaMonitorAtivo: process.env.MONITOR_DIARIOS_OFF !== '1' && String(process.env.MONITOR_DIARIOS_OFF).toLowerCase() !== 'true',
    denunciaGrave,
  });
});

/** Tokens JWT de acesso (convidado / link) — persistidos em data/access-tokens.json */
const accessTokenRoles = requireRoles('admin_master', 'admin', 'executivo', 'prefeito', 'juridico');

app.get('/api/access-tokens', authMiddleware, requireActiveUser, accessTokenRoles, (req, res) => {
  const list = readAccessTokens();
  const out = list.map((rec) => ({
    id: rec.id,
    notifId: rec.notifId || null,
    token: rec.token,
    email: rec.email || rec.destinatario || '',
    destinatario: rec.email || rec.destinatario || '',
    criadoEm: rec.criadoEm,
    expiraEm: rec.expiraEm,
    acessadoEm: rec.acessadoEm || null,
    status: accessTokenRecordStatus(rec),
  }));
  res.json(out);
});

app.post('/api/access-tokens', authMiddleware, requireActiveUser, accessTokenRoles, (req, res) => {
  const body = req.body || {};
  const email = String(body.email || body.destinatario || '')
    .trim()
    .toLowerCase();
  const notifId = String(body.notifId || '').trim();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'E-mail válido é obrigatório.' });
  }
  if (notifId) {
    const n = notificacoes.find((x) => x.id === notifId);
    if (!n) return res.status(404).json({ error: 'Processo não encontrado.' });
  }
  const jti = crypto.randomUUID();
  const payload = {
    type: 'pm_visitor',
    jti,
    email,
    role: 'visitante',
    ...(notifId ? { notifId } : {}),
  };
  const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '24h' });
  const decoded = jwt.decode(token);
  const expSec = decoded && decoded.exp;
  const expiraEm = expSec ? new Date(expSec * 1000).toISOString() : new Date(Date.now() + 24 * 3600 * 1000).toISOString();
  const criadoEm = new Date().toISOString();
  const record = {
    id: jti,
    email,
    notifId: notifId || null,
    token,
    criadoEm,
    expiraEm,
    acessadoEm: null,
    revogado: false,
  };
  const list = readAccessTokens();
  list.unshift(record);
  writeAccessTokens(list);
  res.json({
    token,
    email,
    destinatario: email,
    criadoEm,
    expiraEm,
    id: jti,
    notifId: notifId || null,
  });
});

app.get('/api/notificacoes', authMiddleware, requireActiveUser, (req, res) => {
  refreshAtrasadas();
  let visivel = notificacoes.filter((n) => (n.monitoramentoOrigem || 'MPMA') !== 'DOM');
  if (req.user.visitante) {
    if (req.user.notifId) visivel = visivel.filter((n) => n.id === req.user.notifId);
    return res.json(visivel);
  }
  res.json(visivel);
});

app.get(
  '/api/relatorios/desempenho',
  authMiddleware,
  requireActiveUser,
  requireRoles(...ROLES_RELATORIOS_LEITURA),
  (req, res) => {
    const p = String(req.query.periodo || 'semana').toLowerCase();
    if (!['dia', 'semana', 'mes'].includes(p)) return res.status(400).json({ error: 'periodo: dia | semana | mes' });
    res.json(buildDesempenho(p));
  }
);

/** PDF institucional (.docx → LibreOffice → PDF) — mesmos perfis do relatório de desempenho */
app.get(
  '/api/relatorios/exportar-pdf',
  authMiddleware,
  requireActiveUser,
  requireRoles(...ROLES_RELATORIOS_LEITURA),
  async (req, res) => {
    try {
      const p = String(req.query.periodo || 'semana').toLowerCase();
      if (!['dia', 'semana', 'mes'].includes(p)) {
        return res.status(400).json({ error: 'periodo: dia | semana | mes' });
      }
      const aba = String(req.query.aba || 'desempenho').toLowerCase();
      const abasOk = ['semanal', 'mensal', 'produtividade', 'desempenho'];
      if (!abasOk.includes(aba)) return res.status(400).json({ error: 'aba inválida' });

      const actor = users.find((x) => x.id === req.user.sub);
      const cargo = actor?.cargo || '';
      const desempenho = aba === 'desempenho' ? buildDesempenho(p) : null;
      const visivel = notificacoes.filter((n) => (n.monitoramentoOrigem || 'MPMA') !== 'DOM');

      let recorteInicio = String(req.query.recorteInicio || '').trim();
      let recorteFim = String(req.query.recorteFim || '').trim();
      if (aba !== 'desempenho') {
        const ok =
          /^\d{4}-\d{2}-\d{2}$/.test(recorteInicio) && /^\d{4}-\d{2}-\d{2}$/.test(recorteFim);
        if (!ok) {
          const b = periodBounds(p);
          if (b) {
            recorteInicio = b.start.toISOString().slice(0, 10);
            recorteFim = b.end.toISOString().slice(0, 10);
          }
        }
        if (recorteInicio > recorteFim) {
          return res.status(400).json({
            error: 'Recorte temporal inválido (início após fim).',
            message: 'Recorte temporal inválido (início após fim).',
          });
        }
      }

      const dados = relatorioService.montarPayloadRelatorioPdf({
        emitente: { nome: req.user.nome || '—', cargo },
        aba,
        periodo: p,
        secretariaFiltro: String(req.query.secretaria || '').trim(),
        statusFiltro: String(req.query.status || '').trim(),
        desempenho,
        notificacoes: visivel,
        appPublicUrl: (process.env.APP_PUBLIC_URL || '').trim(),
        periodoLegenda: String(req.query.periodoLegenda || '').trim().slice(0, 240),
        recorteInicio: aba === 'desempenho' ? '' : recorteInicio,
        recorteFim: aba === 'desempenho' ? '' : recorteFim,
      });

      const result = await relatorioService.gerarRelatorioPDF(dados);
      if (!result || result.error || !result.buffer) {
        const msg = result?.error || 'Não foi possível gerar o PDF.';
        return res.status(503).json({ error: msg, message: msg });
      }

      res.setHeader('Content-Type', result.contentType || 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${result.fileName}"`);
      res.setHeader('X-PMP-Export', 'pdf');
      const actorId = req.user.sub;
      const actorNome = (users.find((x) => x.id === actorId) || {}).nome || '';
      res.on('finish', () => {
        try {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            appendPlatformAudit({
              tipo: 'export_pdf',
              userId: actorId,
              nome: actorNome,
              periodo: p,
              aba,
            });
          }
        } catch (_) {
          /* ignorar */
        }
      });
      res.send(result.buffer);
    } catch (e) {
      console.error('[relatorios/exportar-pdf]', e);
      res.status(500).json({ error: e.message || 'Erro ao exportar PDF' });
    }
  }
);

app.get('/api/admin/login-logs', authMiddleware, requireActiveUser, requireRoles('admin_master', 'admin', 'auditor'), (req, res) => {
  res.json({ logs: loginSecurity.getLogsSlice(300) });
});

/** Dados reais do site TCE-MA filtrados para Buriticupu (crawler periódico) */
app.get('/api/tcema/buriticupu', authMiddleware, requireActiveUser, (req, res) => {
  res.json(tceCrawler.getTceMaState());
});

app.get(
  '/api/insights/nomes-recorrentes',
  authMiddleware,
  requireActiveUser,
  requireRoles(...ROLES_RELATORIOS_LEITURA),
  (req, res) => {
    res.json({ itens: buildNomesRecorrentes() });
  }
);

app.get(
  '/api/dashboard/kpis',
  authMiddleware,
  requireActiveUser,
  requireRoles(...ROLES_RELATORIOS_LEITURA),
  (req, res) => {
    refreshAtrasadas();
    res.json(buildDashboardKpis());
  }
);

app.get(
  '/api/auditoria/plataforma',
  authMiddleware,
  requireActiveUser,
  requireRoles('admin_master', 'admin', 'auditor'),
  (req, res) => {
    try {
      const f = path.join(__dirname, '..', '..', 'logs', 'platform-audit.jsonl');
      if (!fs.existsSync(f)) return res.json({ linhas: [] });
      const raw = fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean);
      const lim = Math.min(200, raw.length);
      const linhas = raw.slice(-lim).map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return { raw: line };
        }
      });
      res.json({ linhas });
    } catch (e) {
      res.status(500).json({ error: e.message || 'Erro ao ler auditoria' });
    }
  }
);

app.get('/api/usuarios/assignable', authMiddleware, requireActiveUser, requireRoles('admin_master', 'admin', 'executivo', 'prefeito', 'juridico'), (req, res) => {
  res.json(
    users
      .filter((u) => u.ativo !== false)
      .map((u) => ({
        id: u.id,
        nome: u.nome,
        init: u.init,
        whatsapp: u.whatsapp || '',
      }))
  );
});

app.patch('/api/notificacoes/:id', authMiddleware, requireActiveUser, auditorReadOnly, (req, res) => {
  const { id } = req.params;
  const n = notificacoes.find((x) => x.id === id);
  if (!n) return res.status(404).json({ error: 'Notificação não encontrada' });
  if (req.user.visitante && !req.user.notifId) {
    return res.status(403).json({ error: 'Token só leitura: associe um processo ao gerar o link para alterar estado.' });
  }
  if (req.user.visitante && req.user.notifId && id !== req.user.notifId) {
    return res.status(403).json({ error: 'Acesso restrito ao processo do convite.' });
  }
  const prevStatus = n.status;
  const actor = req.user.visitante
    ? { sub: req.user.jti, nome: req.user.email || 'Visitante', username: 'visitante' }
    : { sub: req.user.sub, nome: req.user.nome, username: req.user.username };
  if (req.user.role === 'usuario' || req.user.visitante) {
    const extra = Object.keys(req.body || {}).filter((k) => !['status'].includes(k));
    if (extra.length) return res.status(403).json({ error: 'Apenas atualização de status permitida' });
  }
  if (req.body.status) {
    let allowed = ['novo', 'analise', 'urgente', 'respondido', 'atrasada'];
    if (req.user.role === 'usuario' || req.user.visitante) allowed = ['novo', 'analise', 'urgente', 'respondido'];
    if (!allowed.includes(req.body.status)) return res.status(400).json({ error: 'Status inválido' });
    n.status = req.body.status;
    if (req.body.status !== prevStatus) timelinePush(n, `Status alterado → ${req.body.status}`, actor);
  }
  if (['admin_master', 'admin', 'executivo', 'prefeito', 'juridico'].includes(req.user.role) && !req.user.visitante) {
    if (req.body.comentarios) n.comentarios = req.body.comentarios;
    if (req.body.responsavelId !== undefined) {
      const rid = req.body.responsavelId;
      if (rid === null || rid === '') {
        if (n.responsavelId) timelinePush(n, 'Responsável removido', actor);
        n.responsavelId = null;
        n.responsavelNome = null;
      } else {
        const ru = users.find((x) => x.id === rid);
        if (ru && ru.ativo !== false) {
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
    const nomeEmit = req.user.visitante
      ? req.user.email || 'Visitante'
      : users.find((x) => x.id === req.user.sub)?.nome || '';
    io.emit('processo_respondido', {
      notifId: n.id,
      titulo: n.titulo,
      userId: req.user.visitante ? req.user.jti : req.user.sub,
      nome: nomeEmit,
    });
  }
  res.json(n);
});

/** Log de acesso persistente (PDF / resposta) */
app.post('/api/notificacoes/:id/access-log', authMiddleware, requireActiveUser, (req, res) => {
  const n = notificacoes.find((x) => x.id === req.params.id);
  if (!n) return res.status(404).json({ error: 'Notificação não encontrada' });
  if (req.user.visitante && !req.user.notifId) {
    return res.status(403).json({ error: 'Token só leitura: sem processo associado.' });
  }
  if (req.user.visitante && req.user.notifId && req.params.id !== req.user.notifId) {
    return res.status(403).json({ error: 'Acesso restrito ao processo do convite.' });
  }
  let u = users.find((x) => x.id === req.user.sub);
  if (req.user.visitante) {
    const em = req.user.email || 'visitante';
    const nome = em.includes('@') ? em.split('@')[0] : em;
    u = {
      id: req.user.jti,
      nome,
      init: nome.slice(0, 2).toUpperCase(),
      color: '#64748b',
    };
  }
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
app.post('/api/notificacoes/:id/comentarios', authMiddleware, requireActiveUser, auditorReadOnly, (req, res) => {
  const n = notificacoes.find((x) => x.id === req.params.id);
  if (!n) return res.status(404).json({ error: 'Notificação não encontrada' });
  if (req.user.visitante && !req.user.notifId) {
    return res.status(403).json({ error: 'Token só leitura: sem processo associado.' });
  }
  if (req.user.visitante && req.user.notifId && req.params.id !== req.user.notifId) {
    return res.status(403).json({ error: 'Acesso restrito ao processo do convite.' });
  }
  const texto = String(req.body?.texto || '').trim();
  if (!texto) return res.status(400).json({ error: 'Texto vazio' });
  let u = users.find((x) => x.id === req.user.sub);
  if (req.user.visitante) {
    const em = req.user.email || 'visitante';
    const nome = em.includes('@') ? em.split('@')[0] : em;
    u = {
      id: req.user.jti,
      nome,
      init: nome.slice(0, 2).toUpperCase(),
      color: '#64748b',
    };
  }
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
app.get('/api/notificacoes/:id/chat', authMiddleware, requireActiveUser, (req, res) => {
  const n = notificacoes.find((x) => x.id === req.params.id);
  if (!n) return res.status(404).json({ error: 'Notificação não encontrada' });
  if (req.user.visitante && req.user.notifId && req.params.id !== req.user.notifId) {
    return res.status(403).json({ error: 'Acesso restrito ao processo do convite.' });
  }
  const msgs = getChatMessages(req.params.id);
  res.json(msgs.slice(-200));
});

app.post('/api/notificacoes/:id/chat', authMiddleware, requireActiveUser, auditorReadOnly, (req, res) => {
  const notifId = req.params.id;
  const n = notificacoes.find((x) => x.id === notifId);
  if (!n) return res.status(404).json({ error: 'Notificação não encontrada' });
  if (req.user.visitante && !req.user.notifId) {
    return res.status(403).json({ error: 'Token só leitura: sem processo associado.' });
  }
  if (req.user.visitante && req.user.notifId && notifId !== req.user.notifId) {
    return res.status(403).json({ error: 'Acesso restrito ao processo do convite.' });
  }
  const texto = String(req.body?.texto || '').trim();
  if (!texto) return res.status(400).json({ error: 'Texto vazio' });
  let u = users.find((x) => x.id === req.user.sub);
  if (req.user.visitante) {
    const em = req.user.email || 'visitante';
    const nome = em.includes('@') ? em.split('@')[0] : em;
    u = {
      id: req.user.jti,
      nome,
      init: nome.slice(0, 2).toUpperCase(),
      color: '#64748b',
    };
  }
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
  return {
    ...publicUser(u),
    hasPassword: true,
    email: u.email || '',
    phone: u.phone || '',
    whatsapp: u.whatsapp || '',
    createdAt: u.createdAt || null,
    desativadoEm: u.desativadoEm || null,
  };
}

function persistUsers() {
  writeJson(USERS_FILE, users);
}

const userLifecycleHandlers = createUserLifecycleHandlers({
  getUsers: () => users,
  persistUsers,
  userRowForAdmin,
});

registerUserAdminRoutes(app, {
  authMiddleware,
  requireActiveUser,
  requireRoles,
  handlers: userLifecycleHandlers,
});

app.get('/api/usuarios', authMiddleware, requireActiveUser, requireRoles('admin_master', 'admin', 'prefeito'), (req, res) => {
  res.json(users.filter((u) => u.ativo !== false).map((u) => userRowForAdmin(u)));
});

app.post('/api/usuarios', authMiddleware, requireActiveUser, requireRoles('admin_master', 'admin', 'prefeito'), (req, res) => {
  const { username, nome, password, role, cargo, init, color, email, phone, whatsapp } = req.body || {};
  if (!username || !nome || !password || !role) return res.status(400).json({ error: 'Campos obrigatórios: username, nome, password, role' });
  const allowedRoles = ['admin_master', 'admin', 'executivo', 'usuario', 'prefeito', 'juridico', 'auditor'];
  if (!allowedRoles.includes(role)) return res.status(400).json({ error: 'Role inválida' });
  if (req.user.role === 'prefeito' && !['executivo', 'usuario'].includes(role)) {
    return res.status(403).json({ error: 'Prefeito só pode criar perfis executivo ou usuario' });
  }
  if (req.user.role === 'admin' && role === 'admin_master') return res.status(403).json({ error: 'Apenas admin_master pode criar outro admin_master' });
  const unLower = String(username).trim().toLowerCase();
  if (users.some((x) => String(x.username || '').trim().toLowerCase() === unLower)) {
    return res.status(409).json({ error: 'Username já existe (restaure ou escolha outro)' });
  }
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
  persistUsers();
  res.status(201).json(publicUser(nu));
});

app.patch('/api/usuarios/:id', authMiddleware, requireActiveUser, requireRoles('admin_master', 'admin', 'prefeito'), (req, res) => {
  const u = users.find((x) => x.id === req.params.id);
  if (!u) return res.status(404).json({ error: 'Não encontrado' });
  if (u.ativo === false) return res.status(404).json({ error: 'Utilizador inativo — use restauração se aplicável' });
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
    const allowedRoles = ['admin_master', 'admin', 'executivo', 'usuario', 'prefeito', 'juridico', 'auditor'];
    if (!allowedRoles.includes(role)) return res.status(400).json({ error: 'Role inválida' });
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
  persistUsers();
  res.json(publicUser(u));
});

app.get('/api/monitor/servidores', authMiddleware, requireActiveUser, requireRoles('admin_master', 'admin'), (req, res) => {
  const lista = servidores.getListaMonitoramento();
  res.json({
    ...servidores.getMeta(),
    totalLista: lista.length,
    amostra: lista.slice(0, 30),
  });
});

app.post('/api/monitor/servidores/refresh', authMiddleware, requireActiveUser, requireRoles('admin_master', 'admin'), async (req, res) => {
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
    const clIn = classifyDenunciaNivel(novo);
    novo.nivelDenuncia = clIn.nivelDenuncia;
    if (clIn.keywordHits.length) novo.nivelDenunciaKeywords = clIn.keywordHits;
    notificacoes.unshift(novo);
    any = true;
    io.emit('nova_notificacao', {
      id: novo.id,
      titulo: novo.titulo,
      pdfUrl: novo.pdfUrl,
      monitoramentoOrigem: novo.monitoramentoOrigem,
    });
    sendWhatsAppNewNotif(
      novo,
      users.filter((u) => u.ativo !== false)
    ).catch((e) => console.error('[notify] WA diário:', e.message));
    sendEmailNewNotif(
      novo,
      users.filter((u) => u.ativo !== false && ROLES_ALVO_EMAIL_NOTIF.includes(u.role))
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
    console.warn(
      '[MPMA] Lista de servidores vazia — PDFs só entram com menção a Buriticupu e secretaria/secretário no texto (catálogo mpmaService) até haver nominal/Excel.'
    );
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
    const secInst = mpmaService.encontrarSecretarias(text);
    const secMencoes = mpmaService.detectarSecretario(text);
    if (!matched.length && !secInst.length && !secMencoes.length) continue;

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
    const clMp = classifyDenunciaNivel(novo);
    novo.nivelDenuncia = clMp.nivelDenuncia;
    if (clMp.keywordHits.length) novo.nivelDenunciaKeywords = clMp.keywordHits;
    notificacoes.unshift(novo);
    persistNots();
    io.emit('nova_notificacao', { id: novo.id, titulo: novo.titulo, pdfUrl: novo.pdfUrl, monitoramentoOrigem: 'MPMA' });
    console.log('[MPMA] Nova notificação criada:', novo.id, matched.map((p) => p.nome).join(', '));
    sendWhatsAppNewNotif(
      novo,
      users.filter((u) => u.ativo !== false)
    ).catch((e) => console.error('[notify] WA:', e.message));
    sendEmailNewNotif(
      novo,
      users.filter((u) => u.ativo !== false && ROLES_ALVO_EMAIL_NOTIF.includes(u.role))
    ).catch((e) => console.error('[notify] Mail:', e.message));
  }
}

async function runRelatorioDiarioJob() {
  if (process.env.RELATORIO_DIARIO_ENABLED === 'false') return;
  try {
    const dir = relatorioService.RELATORIOS_DIR;
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const hoje = new Date().toISOString().slice(0, 10);
    const fname = `relatorio-diario-${hoje}.pdf`;
    const full = path.join(dir, fname);
    if (fs.existsSync(full)) return;
    refreshAtrasadas();
    const desempenho = buildDesempenho('dia');
    const visivel = notificacoes.filter((n) => (n.monitoramentoOrigem || 'MPMA') !== 'DOM');
    const dados = relatorioService.montarPayloadRelatorioPdf({
      emitente: { nome: 'PlataformaMP', cargo: 'Relatório automático diário' },
      aba: 'desempenho',
      periodo: 'dia',
      secretariaFiltro: '',
      statusFiltro: '',
      desempenho,
      notificacoes: visivel,
      appPublicUrl: (process.env.APP_PUBLIC_URL || '').trim(),
      periodoLegenda: `Consolidação automática ${hoje}`,
      recorteInicio: '',
      recorteFim: '',
    });
    const result = await relatorioService.gerarRelatorioPDF(dados);
    if (!result || !result.buffer) {
      console.error('[relatorio-diario]', result?.error || 'sem buffer');
      return;
    }
    fs.writeFileSync(full, result.buffer);
    appendPlatformAudit({
      tipo: 'relatorio_diario_pdf',
      ficheiro: fname,
      bytes: result.buffer.length,
    });
    await sendRelatorioDiarioEmail(users, {
      buffer: result.buffer,
      fileName: fname,
      legenda: `Gerado automaticamente em ${new Date().toLocaleString('pt-BR')} · processos na carteira: ${visivel.length}`,
    });
    console.log('[relatorio-diario] OK', fname);
  } catch (e) {
    console.error('[relatorio-diario]', e.message);
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

cron.schedule('5 7 * * *', () => {
  runRelatorioDiarioJob().catch((e) => console.error('[relatorio-diario cron]', e.message));
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
  const pNorm = (req.path || '/').replace(/\/$/, '') || '/';
  const tokEarly = extractJwtFromRequest(req);
  if (tokEarly) {
    try {
      const d = jwt.verify(tokEarly, JWT_SECRET);
      if (d.type === 'pm_visitor' && validatePmVisitorPayload(d)) {
        if (visitorSpaBlocked(pNorm)) {
          return res.redirect(302, '/acesso-negado.html');
        }
        if (!visitorSpaAllowed(pNorm)) {
          return res.redirect(302, '/acesso-negado.html');
        }
      }
    } catch {
      if (req.query && req.query.token) {
        return res.redirect(302, '/token-expirado.html');
      }
    }
  }
  const spaProtected = ['/dashboard', '/relatorios', '/relatorio', '/auditoria'];
  const needsToken = spaProtected.some((x) => pNorm === x || pNorm.startsWith(`${x}/`));
  if (needsToken) {
    const tok = extractJwtFromRequest(req);
    if (!tok) return res.status(401).json({ error: 'Token obrigatório para este caminho (?token= ou Authorization)' });
    if (!verifyJwtForSpaPath(tok)) return res.status(401).json({ error: 'Token inválido' });
  }
  const indexFile = path.join(PUBLIC_DIR, 'index.html');
  if (fs.existsSync(indexFile)) return res.sendFile(indexFile);
  next();
});

io.use((socket, next) => {
  try {
    const token = socket.handshake.auth?.token || socket.handshake.query?.token;
    if (!token) return next(new Error('unauthorized'));
    const p = jwt.verify(String(token), JWT_SECRET);
    if (p.type === 'pm_visitor') {
      if (!validatePmVisitorPayload(p)) return next(new Error('unauthorized'));
      const em = String(p.email || '').trim();
      const short = em.includes('@') ? em.split('@')[0] : em || 'Visitante';
      socket.userId = `guest:${p.jti}`;
      socket.userNome = short;
      socket.visitante = true;
      socket.accessNotifId = p.notifId || null;
      socket.guestInit = short.slice(0, 2).toUpperCase();
      socket.guestColor = '#64748b';
      return next();
    }
    const u = users.find((x) => x.id === p.sub);
    if (!u || u.ativo === false) return next(new Error('unauthorized'));
    socket.userId = u.id;
    socket.userNome = u.nome || p.nome || p.username;
    socket.visitante = false;
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
    if (socket.visitante && socket.accessNotifId && notifId !== socket.accessNotifId) return;
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
    if (socket.visitante && socket.accessNotifId && notifId !== socket.accessNotifId) return;
    let msg;
    if (socket.visitante) {
      msg = {
        id: 'm' + Date.now() + Math.random().toString(36).slice(2, 9),
        userId: socket.userId,
        nome: socket.userNome,
        init: socket.guestInit || 'CV',
        color: socket.guestColor || '#64748b',
        texto: texto.slice(0, 4000),
        hora: new Date().toLocaleString('pt-BR'),
        iso: new Date().toISOString(),
      };
    } else {
      const u = users.find((x) => x.id === socket.userId);
      if (!u || u.ativo === false) return;
      msg = {
        id: 'm' + Date.now() + Math.random().toString(36).slice(2, 9),
        userId: u.id,
        nome: u.nome,
        init: u.init,
        color: u.color,
        texto: texto.slice(0, 4000),
        hora: new Date().toLocaleString('pt-BR'),
        iso: new Date().toISOString(),
      };
    }
    const arr = getChatMessages(notifId);
    arr.push(msg);
    if (arr.length > 500) arr.splice(0, arr.length - 500);
    persistChats();
    io.emit('chat:message', { notifId, message: msg });
  });
});

function lanUrlsForPort(port) {
  const out = [];
  try {
    const ifs = os.networkInterfaces();
    for (const name of Object.keys(ifs)) {
      for (const a of ifs[name] || []) {
        if (a.family === 'IPv4' && !a.internal) out.push(a.address);
      }
    }
  } catch (_) {
    /* ignorar */
  }
  return [...new Set(out)].map((ip) => `http://${ip}:${port}`);
}

function lanIpv4List(port) {
  return lanUrlsForPort(port).map((u) => u.replace(/^http:\/\//, '').replace(`:${port}`, ''));
}

function logAcessoExternoInstrucoes(port) {
  const lanIps = lanIpv4List(port);
  const ipLan = lanIps[0] || '(obtenha o IPv4 desta máquina com ipconfig)';
  console.log('');
  console.log('========== Servidor (acesso externo sem túnel) ==========');
  console.log(`Porta em uso: ${port}`);
  console.log(`Bind: ${HOST === '0.0.0.0' ? '0.0.0.0 (todas as interfaces)' : HOST}`);
  if (lanIps.length) {
    console.log('IP(s) local(is) (LAN) — use no router como destino do encaminhamento:');
    lanIps.forEach((ip) => console.log(`  → http://${ip}:${port}`));
  } else {
    console.log('Não foi detetado IPv4 LAN; use ipconfig / ifconfig para o IP interno.');
  }
  console.log('');
  console.log('--- Port forwarding no router (NAT) ---');
  console.log(`  • Encaminhe a porta TCP EXTERNA (ex.: ${port}) para o IP interno desta máquina.`);
  console.log(`  • Destino sugerido: ${ipLan}:${port}`);
  console.log('  • O nome do menu varia: "Port Forwarding", "Virtual Server", "NAT", "Regras IPv4".');
  console.log('');
  console.log('--- Firewall Windows ---');
  console.log(`  • Permita entrada TCP na porta ${port} (ou execute como Administrador):`);
  console.log(`    New-NetFirewallRule -DisplayName "PlataformaMP" -Direction Inbound -LocalPort ${port} -Protocol TCP -Action Allow`);
  console.log('');
  console.log('--- Teste a partir da Internet ---');
  console.log(`  • Descubra o seu IP público (ex.: painel do router ou https://ifconfig.me ).`);
  console.log(`  • No telemóvel com dados móveis: http://SEU_IP_PUBLICO:${port}`);
  console.log(`  • Verificação JSON: http://SEU_IP_PUBLICO:${port}/status`);
  console.log('');
  console.log('--- CGNAT ---');
  console.log('  Se não funcionar fora da rede, a sua internet pode estar em CGNAT (sem IP público');
  console.log('  dedicado). Nesse caso é necessário IP público fixo da operadora ou outra solução de rede.');
  console.log('========================================================');
  console.log('');
}

server.listen(PORT, HOST, () => {
  console.log(`PlataformaMP → http://127.0.0.1:${PORT} e http://localhost:${PORT} (bind ${HOST}:${PORT})`);
  const lan = lanUrlsForPort(PORT);
  if (lan.length) {
    console.log('Rede local (telefone na mesma Wi‑Fi):');
    lan.forEach((u) => console.log(`  → ${u}`));
  }
  if (HOST === '0.0.0.0') {
    logAcessoExternoInstrucoes(PORT);
  }
  servidores.loadCacheFromDisk();
  servidoresService.carregarServidores();
  servidores.refreshServidoresNominal().catch((e) => console.warn('[servidores] Carga inicial:', e.message));
  setTimeout(() => runMpmaMonitor().catch(console.error), 3000);
  setTimeout(() => runDomMunicipalMonitor().catch((e) => console.warn('[DOM] arranque:', e.message)), 12000);
  setTimeout(() => runDiariosFederaisEstaduaisMonitor().catch((e) => console.warn('[DOU/DOE] arranque:', e.message)), 20000);
  setTimeout(() => tceCrawler.runTceMaBuriticupuCrawl().catch((e) => console.warn('[TCE-MA] arranque:', e.message)), 25000);
});
