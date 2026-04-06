/**
 * Entrada alternativa para produção (PM2, Docker, scripts que esperam server.js na raiz).
 * A app real vive em server/index.js — mantido como "main" no package.json.
 */
require('./server/index.js');
