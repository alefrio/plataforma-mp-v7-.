/**
 * Registo append-only: exportações PDF e relatórios automáticos (JSON Lines).
 */
const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, '..', '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'platform-audit.jsonl');

function ensureDir() {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
}

/**
 * @param {object} entry - tipo, userId, detalhes…
 */
function appendPlatformAudit(entry) {
  try {
    ensureDir();
    const line =
      JSON.stringify({
        ...entry,
        dataISO: new Date().toISOString(),
      }) + '\n';
    fs.appendFileSync(LOG_FILE, line, 'utf8');
  } catch (e) {
    console.error('[platformAudit]', e.message);
  }
}

module.exports = {
  appendPlatformAudit,
  LOG_FILE,
};
