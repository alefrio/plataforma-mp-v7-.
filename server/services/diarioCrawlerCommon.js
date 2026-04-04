/**
 * HTTP + PDF comuns aos crawlers de diários (DOU / DOE / DOM).
 */
const axios = require('axios');
const pdfParse = require('pdf-parse');
const crypto = require('crypto');

const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.5,en;q=0.4',
};

async function fetchHtml(url) {
  const { data, status } = await axios.get(url, {
    headers: BROWSER_HEADERS,
    timeout: 65000,
    maxRedirects: 6,
    validateStatus: (s) => s >= 200 && s < 400,
  });
  if (status >= 300) throw new Error(`HTTP ${status}`);
  return typeof data === 'string' ? data : String(data);
}

async function downloadPdfText(url) {
  const { data } = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 120000,
    headers: { ...BROWSER_HEADERS, Accept: 'application/pdf,*/*' },
    maxRedirects: 6,
  });
  const parsed = await pdfParse(Buffer.from(data));
  return parsed.text || '';
}

function norm(s) {
  return String(s)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function stableId(prefix, url) {
  const h = crypto.createHash('sha256').update(String(url)).digest('hex').slice(0, 18);
  return `${prefix}-${h}`;
}

function absolutize(href, base) {
  if (!href) return null;
  try {
    return new URL(href.trim(), base).href;
  } catch {
    return null;
  }
}

module.exports = {
  BROWSER_HEADERS,
  fetchHtml,
  downloadPdfText,
  norm,
  stableId,
  absolutize,
};
