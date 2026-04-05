/**
 * Registo append-only de ações sobre utilizadores (desativação / restauração).
 * Ficheiro: logs/users.log na raiz do projeto (JSON Lines).
 */
const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, '..', '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'users.log');

function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
}

/**
 * @param {object} entry - campos livres (acao, adminId, alvoId, email, etc.)
 */
function appendUserAuditLog(entry) {
  try {
    ensureLogDir();
    const line = JSON.stringify({
      ...entry,
      dataISO: new Date().toISOString(),
    });
    fs.appendFileSync(LOG_FILE, line + '\n', 'utf8');
  } catch (e) {
    console.error('[userAuditLog]', e.message);
  }
}

module.exports = {
  appendUserAuditLog,
  LOG_FILE,
  LOG_DIR,
};
