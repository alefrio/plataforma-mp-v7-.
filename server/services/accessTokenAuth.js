const path = require('path');
const fs = require('fs');

const ACCESS_TOKENS_FILE = path.join(__dirname, '..', '..', 'data', 'access-tokens.json');

function readTokensFile() {
  try {
    if (!fs.existsSync(ACCESS_TOKENS_FILE)) return [];
    const j = JSON.parse(fs.readFileSync(ACCESS_TOKENS_FILE, 'utf8'));
    return Array.isArray(j) ? j : [];
  } catch {
    return [];
  }
}

function normEmail(e) {
  return String(e || '')
    .trim()
    .toLowerCase();
}

/**
 * Valida JWT type=pm_visitor contra registo persistido (email, opcional notifId, não revogado).
 */
function validatePmVisitorPayload(decoded) {
  if (!decoded || decoded.type !== 'pm_visitor' || !decoded.jti || !decoded.email) return false;
  const emailJwt = normEmail(decoded.email);
  if (!emailJwt) return false;
  const list = readTokensFile();
  const rec = list.find((x) => x.id === decoded.jti);
  if (!rec || rec.revogado) return false;
  const emailRec = normEmail(rec.email || rec.destinatario);
  if (!emailRec || emailRec !== emailJwt) return false;
  const recN = rec.notifId != null && String(rec.notifId).trim() !== '' ? String(rec.notifId).trim() : '';
  const decN = decoded.notifId != null && String(decoded.notifId).trim() !== '' ? String(decoded.notifId).trim() : '';
  if (recN && recN !== decN) return false;
  if (recN && !decN) return false;
  /* Prazo: jwt.verify já validou exp; ficheiro pode ficar desfasado após cópia de data/ */
  return true;
}

/** Rotas API permitidas para token visitante (método + path). */
function visitorApiAllowed(method, reqPath) {
  const p = String(reqPath || '').split('?')[0];
  const m = method.toUpperCase();
  if (p === '/api/health' && m === 'GET') return true;
  if (p === '/api/me' && m === 'GET') return true;
  if (p === '/api/menu-status' && m === 'GET') return true;
  if (p === '/api/public/config' && m === 'GET') return true;
  if (p === '/api/notificacoes' && m === 'GET') return true;
  const sub = p.match(/^\/api\/notificacoes\/([^/]+)\/(access-log|comentarios|chat)$/);
  if (sub) {
    if (sub[2] === 'chat' && (m === 'GET' || m === 'POST')) return true;
    if (sub[2] === 'access-log' && m === 'POST') return true;
    if (sub[2] === 'comentarios' && m === 'POST') return true;
  }
  if (/^\/api\/notificacoes\/[^/]+$/.test(p) && m === 'PATCH') return true;
  return false;
}

/** Caminhos SPA permitidos para visitante (sem ficheiros estáticos). */
function visitorSpaAllowed(pNorm) {
  const allow = ['/', '/index.html', '/processos', '/visualizar', '/token-expirado.html', '/acesso-negado.html'];
  if (allow.includes(pNorm)) return true;
  if (pNorm.startsWith('/visualizar/')) return true;
  return false;
}

const VISITANTE_SPA_BLOCKED = [
  '/usuarios',
  '/tokens',
  '/links',
  '/auditoria',
  '/audit',
  '/admin',
  '/dashboard',
  '/relatorio',
  '/relatorios',
  '/executivo',
  '/reenvio',
  '/tce',
  '/calendario',
  '/inbox',
  '/juri',
];

function visitorSpaBlocked(pNorm) {
  return VISITANTE_SPA_BLOCKED.some((x) => pNorm === x || pNorm.startsWith(`${x}/`));
}

module.exports = {
  validatePmVisitorPayload,
  readTokensFile,
  ACCESS_TOKENS_FILE,
  normEmail,
  visitorApiAllowed,
  visitorSpaAllowed,
  visitorSpaBlocked,
};
