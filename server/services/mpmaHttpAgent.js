/**
 * Agent opcional para pedidos ao domínio MPMA — datacenters fora do Brasil
 * muitas vezes não conseguem TCP à 443 de apps.mpma.mp.br; um proxy HTTP com saída no BR contorna.
 *
 * .env: MPMA_HTTPS_PROXY=http://host:porta ou http://user:senha@host:porta
 * (alias: MPMA_PROXY_URL)
 */
const { HttpsProxyAgent } = require('https-proxy-agent');

let cachedUrl = '';
let cachedAgent = null;

function proxyUrlFromEnv() {
  const a = (process.env.MPMA_HTTPS_PROXY || '').trim();
  const b = (process.env.MPMA_PROXY_URL || '').trim();
  return a || b || '';
}

/** Opções extra para axios (httpsAgent, httpAgent, proxy:false) ou {} */
function axiosProxyOpts() {
  const url = proxyUrlFromEnv();
  if (!url) return {};
  if (url === cachedUrl && cachedAgent) {
    return { httpsAgent: cachedAgent, httpAgent: cachedAgent, proxy: false };
  }
  try {
    cachedAgent = new HttpsProxyAgent(url);
    cachedUrl = url;
    const safe = url.replace(/\/\/([^:]+):([^@]+)@/, '//$1:****@');
    console.log('[MPMA] Proxy HTTP ativo para pedidos ao MPMA:', safe);
    return { httpsAgent: cachedAgent, httpAgent: cachedAgent, proxy: false };
  } catch (e) {
    console.warn('[MPMA] MPMA_HTTPS_PROXY inválido:', e.message || e);
    cachedAgent = null;
    cachedUrl = '';
    return {};
  }
}

module.exports = {
  axiosProxyOpts,
  proxyUrlFromEnv,
};
