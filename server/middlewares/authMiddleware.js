const jwt = require('jsonwebtoken');
const { validatePmVisitorPayload, normEmail } = require('../services/accessTokenAuth');

const JWT_SECRET = process.env.JWT_SECRET || 'plataforma-mp-v7-dev-secret-change-in-production';

/**
 * Extrai JWT de Authorization: Bearer ou ?token= (útil para links e testes).
 */
function extractJwtFromRequest(req) {
  const h = req.headers.authorization;
  if (h && typeof h === 'string' && h.startsWith('Bearer ')) {
    const t = h.slice(7).trim();
    if (t) return t;
  }
  if (req.query && req.query.token) {
    const q = String(req.query.token).trim();
    if (q) return q;
  }
  return null;
}

function authMiddleware(req, res, next) {
  const token = extractJwtFromRequest(req);
  if (!token) {
    return res.status(401).json({ error: 'Token ausente' });
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.type === 'pm_visitor') {
      if (!validatePmVisitorPayload(decoded)) {
        return res.status(401).json({ error: 'Token de visitante inválido ou expirado' });
      }
      const nid = decoded.notifId ? String(decoded.notifId).trim() : '';
      req.user = {
        sub: decoded.jti,
        jti: decoded.jti,
        email: normEmail(decoded.email),
        role: 'visitante',
        visitante: true,
        notifId: nid || null,
      };
      return next();
    }
    req.user = decoded;
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

module.exports = {
  authMiddleware,
  requireRoles,
  JWT_SECRET,
  extractJwtFromRequest,
};
