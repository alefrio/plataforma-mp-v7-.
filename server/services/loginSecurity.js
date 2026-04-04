/**
 * Bloqueio após tentativas falhadas e registo de logins (IP + horário).
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const FILE = path.join(DATA_DIR, 'login-security.json');
const MAX_FAIL = 5;
const LOCK_MIN = Number(process.env.LOGIN_LOCK_MINUTES) > 0 ? Number(process.env.LOGIN_LOCK_MINUTES) : 15;
const LOCK_MS = LOCK_MIN * 60 * 1000;
const MAX_LOGS = 800;

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadState() {
  try {
    if (!fs.existsSync(FILE)) return { attempts: {}, logs: [] };
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (!j || typeof j !== 'object') return { attempts: {}, logs: [] };
    if (!j.attempts || typeof j.attempts !== 'object') j.attempts = {};
    if (!Array.isArray(j.logs)) j.logs = [];
    return j;
  } catch {
    return { attempts: {}, logs: [] };
  }
}

function saveState(state) {
  ensureDir();
  fs.writeFileSync(FILE, JSON.stringify(state, null, 2), 'utf8');
}

function getClientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (xf) return String(xf).split(',')[0].trim();
  if (req.ip) return String(req.ip);
  return req.socket?.remoteAddress || '';
}

function userKey(username) {
  return String(username || '').trim().toLowerCase();
}

function isLocked(username) {
  const k = userKey(username);
  if (!k) return { locked: false, msLeft: 0 };
  const state = loadState();
  const a = state.attempts[k];
  if (!a || !a.lockedUntil) return { locked: false, msLeft: 0 };
  const left = a.lockedUntil - Date.now();
  if (left > 0) return { locked: true, msLeft: left };
  a.count = 0;
  a.lockedUntil = null;
  saveState(state);
  return { locked: false, msLeft: 0 };
}

function recordFailure(username, ip, motivo) {
  const k = userKey(username);
  const state = loadState();
  if (!state.attempts[k]) state.attempts[k] = { count: 0 };
  state.attempts[k].count += 1;
  let lockedUntil = state.attempts[k].lockedUntil || null;
  if (state.attempts[k].count >= MAX_FAIL) {
    lockedUntil = Date.now() + LOCK_MS;
    state.attempts[k].lockedUntil = lockedUntil;
  }
  state.logs.unshift({
    t: new Date().toISOString(),
    ip: ip || '',
    user: k,
    ok: false,
    motivo: motivo || 'credencial_invalida',
  });
  state.logs = state.logs.slice(0, MAX_LOGS);
  saveState(state);
  return { failCount: state.attempts[k].count, lockedUntil };
}

function recordSuccess(username, ip) {
  const k = userKey(username);
  const state = loadState();
  if (state.attempts[k]) {
    state.attempts[k] = { count: 0, lockedUntil: null };
  }
  state.logs.unshift({
    t: new Date().toISOString(),
    ip: ip || '',
    user: k,
    ok: true,
    motivo: 'login_ok',
  });
  state.logs = state.logs.slice(0, MAX_LOGS);
  saveState(state);
}

function getLogsSlice(max = 200) {
  const state = loadState();
  return (state.logs || []).slice(0, max);
}

module.exports = {
  getClientIp,
  isLocked,
  recordFailure,
  recordSuccess,
  getLogsSlice,
  MAX_FAIL,
};
