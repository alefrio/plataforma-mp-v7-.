/**
 * Integração com conteúdo público do TCE-MA (www.tcema.tc.br).
 * Filtra apenas menções a Buriticupu / Prefeitura de Buriticupu — sem dados inventados.
 */
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const { fetchHtml, norm, stableId, absolutize } = require('./diarioCrawlerCommon');

const BASE = (process.env.TCEMA_BASE_URL || 'https://www.tcema.tc.br').replace(/\/$/, '');
const DATA_FILE = path.join(__dirname, '..', '..', 'data', 'tcema-buriticupu.json');

const SEED_PAGES = [
  `${BASE}/`,
  `${BASE}/index.php/comunicacao/tce-em-pauta/tce-em-pauta-2026`,
  `${BASE}/index.php/comunicacao/tce-em-pauta/tce-em-pauta-2025`,
  `${BASE}/index.php/comunicacao/tce-em-pauta/tce-em-pauta-2024`,
  `${BASE}/index.php/comunicacao/tce-em-pauta/tce-em-pauta-2023`,
];

function isBuriticupuRelated(text) {
  const n = norm(text);
  if (!n.includes('buriticupu')) return false;
  if (n.includes('prefeitura') && n.includes('buriticupu')) return true;
  return true;
}

function detectTipo(text) {
  const n = norm(text);
  if (/multa|debito|pena\s+de|titulo\s+executivo|valor\s+de\s+r\$/.test(n)) return 'multa';
  if (/irregular|conta\s+irregular|julgad.*irregular|improbidade/.test(n)) return 'irregularidade';
  if (/contrato|convenio|licita|contrata[cç][aã]o|preg[aã]o/.test(n)) return 'contrato';
  if (/auditor|fiscaliz|tomada\s+de\s+contas|inspe[cç][aã]o|controle\s+externo/.test(n)) return 'auditoria';
  if (/relatorio|parecer|decis[aã]o\s+normativa|acord[aã]o|instru[cç][aã]o/.test(n)) return 'relatorio';
  return 'alerta';
}

function detectIntel(text) {
  const n = norm(text);
  const t = [];
  if (/irregularidade/.test(n)) t.push('irregularidade');
  if (/multa|pena\s+de\s+multa/.test(n)) t.push('multa');
  if (/dano\s+ao\s+erario|erario\s+publico|lesao\s+ao\s+patrim[oô]nio/.test(n)) t.push('dano ao erário');
  return [...new Set(t)];
}

function parseBRLToken(token) {
  const s = String(token || '')
    .replace(/\s/g, '')
    .replace(/\./g, '')
    .replace(',', '.');
  const n = parseFloat(s, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Valor em reais (número) ou null — só quando detectável no texto */
function extractValorReais(text) {
  const flat = String(text || '').replace(/\s+/g, ' ');
  const mil = flat.match(/R\$\s*([\d.,]+)\s*milh[aã]o(?:es)?/i);
  if (mil) {
    const n = parseBRLToken(mil[1]);
    if (n != null) return Math.round(n * 1_000_000 * 100) / 100;
  }
  const milhares = flat.match(/R\$\s*([\d.,]+)\s*mil\b/i);
  if (milhares) {
    const n = parseBRLToken(milhares[1]);
    if (n != null) return Math.round(n * 1000 * 100) / 100;
  }
  const std = flat.match(/R\$\s*((?:\d{1,3}(?:\.\d{3})+|\d+),\d{2})\b/);
  if (std) {
    const n = parseBRLToken(std[1]);
    if (n != null) return n;
  }
  return null;
}

function extractDateRef(text, pageUrl) {
  const t = String(text || '');
  const dm = t.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
  if (dm) {
    const d = parseInt(dm[1], 10);
    const mo = parseInt(dm[2], 10);
    const y = parseInt(dm[3], 10);
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && y >= 1990 && y <= 2100)
      return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  const urlM = String(pageUrl || '').match(/tce-em-pauta-(\d{4})/i);
  if (urlM) return `${urlM[1]}-01-01`;
  return null;
}

function skipNavLink(titulo, abs) {
  const t = norm(titulo);
  if (t.length < 4) return true;
  const nav = /^(home|menu|voltar|institucional|servicos|comunicacao|transparencia|mapa|ouvidoria|intranet|login)$/;
  if (nav.test(t)) return true;
  if (/^https?:\/\/www\.tcema\.tc\.br\/?$/i.test(abs) && t.length < 20) return true;
  return false;
}

function collectFromPage(html, pageUrl) {
  const $ = cheerio.load(html);
  const out = [];
  const seenSnippet = new Set();

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href || href.startsWith('#') || href.toLowerCase().startsWith('javascript')) return;
    let abs;
    try {
      abs = absolutize(href, pageUrl);
    } catch {
      return;
    }
    if (!abs || !/tcema\.tc\.br/i.test(abs)) return;

    const titulo = $(el).text().replace(/\s+/g, ' ').trim();
    if (skipNavLink(titulo, abs)) return;

    let $ctx = $(el).closest('li, article, tr, .item, .blog, .leading, .readmore, p').first();
    if (!$ctx.length) $ctx = $(el).parent().parent();
    const snippet = $ctx.text().replace(/\s+/g, ' ').trim().slice(0, 2800);
    const combined = `${titulo} ${snippet}`;

    if (!isBuriticupuRelated(combined)) return;

    const key = `${abs.slice(0, 200)}|${snippet.slice(0, 120)}`;
    if (seenSnippet.has(key)) return;
    seenSnippet.add(key);

    const descricao = (titulo ? `${titulo}. ` : '') + snippet.slice(0, 1900);
    const tipo = detectTipo(combined);
    const termosDestaque = detectIntel(combined);
    const valorReais = extractValorReais(combined);
    const dataRef = extractDateRef(combined, pageUrl) || extractDateRef(titulo, pageUrl);

    out.push({
      id: stableId('TCE', abs + '|' + titulo.slice(0, 80)),
      tipo,
      titulo: titulo.slice(0, 220) || 'Buriticupu — TCE-MA (site oficial)',
      descricao,
      valorReais,
      dataRef,
      linkOficial: abs.split('#')[0],
      fontePagina: pageUrl,
      capturadoEm: new Date().toISOString(),
      termosDestaque,
      alertaAtivo: termosDestaque.length > 0 || tipo === 'irregularidade' || tipo === 'multa',
    });
  });

  const bodyText = $('body').text().replace(/\s+/g, ' ');
  if (isBuriticupuRelated(bodyText)) {
    const re = /[^.!?\n]{15,350}(buriticupu|prefeitura\s+de\s+buriticupu)[^.!?\n]{15,350}[.!?]?/gi;
    let m;
    let n = 0;
    while ((m = re.exec(bodyText)) !== null && n < 8) {
      n += 1;
      const sentence = m[0].trim();
      if (sentence.length < 40) continue;
      const id = stableId('TCE', pageUrl + '|snippet|' + sentence.slice(0, 100));
      if (out.some((x) => x.descricao.includes(sentence.slice(0, 50)))) continue;
      const tipo = detectTipo(sentence);
      const termosDestaque = detectIntel(sentence);
      out.push({
        id,
        tipo,
        titulo: sentence.slice(0, 200),
        descricao: sentence.slice(0, 2000),
        valorReais: extractValorReais(sentence),
        dataRef: extractDateRef(sentence, pageUrl),
        linkOficial: pageUrl.split('#')[0],
        fontePagina: pageUrl,
        capturadoEm: new Date().toISOString(),
        termosDestaque,
        alertaAtivo: termosDestaque.length > 0 || tipo === 'irregularidade' || tipo === 'multa',
      });
    }
  }

  const byId = new Map();
  for (const it of out) {
    if (!byId.has(it.id)) byId.set(it.id, it);
  }
  return [...byId.values()];
}

function mergeItens(existing, incoming) {
  const map = new Map();
  for (const x of existing || []) {
    if (x && x.id) map.set(x.id, x);
  }
  for (const x of incoming) {
    if (!x || !x.id) continue;
    const prev = map.get(x.id);
    if (!prev || new Date(x.capturadoEm) >= new Date(prev.capturadoEm || 0)) map.set(x.id, x);
  }
  return [...map.values()].sort((a, b) => String(b.capturadoEm).localeCompare(String(a.capturadoEm)));
}

function buildResumo(itens) {
  const list = Array.isArray(itens) ? itens : [];
  const irregularidades = list.filter(
    (i) => i.tipo === 'irregularidade' || (i.termosDestaque || []).includes('irregularidade')
  ).length;
  const valorTotal = list.reduce((s, i) => s + (Number(i.valorReais) || 0), 0);
  const alertasAtivos = list.filter((i) => i.alertaAtivo).length;
  const porTipo = {};
  for (const i of list) {
    const t = i.tipo || 'outro';
    porTipo[t] = (porTipo[t] || 0) + 1;
  }
  return {
    totalItens: list.length,
    irregularidades,
    valorTotal,
    alertasAtivos,
    porTipo,
  };
}

function loadState() {
  try {
    if (!fs.existsSync(DATA_FILE)) return { itens: [], atualizadoEm: null, ultimoErro: null };
    const j = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (!j || typeof j !== 'object') return { itens: [], atualizadoEm: null, ultimoErro: null };
    if (!Array.isArray(j.itens)) j.itens = [];
    return j;
  } catch {
    return { itens: [], atualizadoEm: null, ultimoErro: null };
  }
}

function saveState(state) {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2), 'utf8');
}

/**
 * Executa crawl nas páginas oficiais, filtra Buriticupu, persiste e devolve estado.
 */
async function runTceMaBuriticupuCrawl() {
  if (process.env.TCEMA_CRAWL_OFF === '1' || String(process.env.TCEMA_CRAWL_OFF).toLowerCase() === 'true') {
    return loadState();
  }
  const prev = loadState();
  let allIncoming = [];
  let ultimoErro = null;

  const extra = String(process.env.TCEMA_EXTRA_PAGES || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const urls = [...new Set([...SEED_PAGES, ...extra])];

  for (const pageUrl of urls) {
    try {
      const html = await fetchHtml(pageUrl);
      const chunk = collectFromPage(html, pageUrl);
      allIncoming = allIncoming.concat(chunk);
    } catch (e) {
      ultimoErro = `${pageUrl.slice(0, 80)}: ${e.message}`;
      console.warn('[TCE-MA]', ultimoErro);
    }
  }

  const merged = mergeItens(prev.itens, allIncoming);
  const state = {
    fonteBase: BASE,
    atualizadoEm: new Date().toISOString(),
    itens: merged,
    ultimoErro,
    resumo: buildResumo(merged),
  };
  saveState(state);
  if (merged.length) console.log('[TCE-MA] Itens Buriticupu no arquivo:', merged.length);
  return state;
}

function getTceMaState() {
  const s = loadState();
  return {
    ...s,
    resumo: buildResumo(s.itens),
  };
}

module.exports = {
  runTceMaBuriticupuCrawl,
  getTceMaState,
  buildResumo,
  isBuriticupuRelated,
  DATA_FILE,
};
