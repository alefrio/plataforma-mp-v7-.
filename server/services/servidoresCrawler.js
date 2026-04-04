/**
 * Crawler da lista nominal de servidores — Prefeitura de Buriticupu/MA
 * Fonte oficial: servidores_nominal.php (HTML com tabelas).
 * Sem dados simulados: só o que consta na página.
 */
const axios = require('axios');
const cheerio = require('cheerio');

const NOMINAL_URL = 'https://www.buriticupu.ma.gov.br/servidores_nominal.php';
const ORIGEM_PREFEITURA = 'Prefeitura Buriticupu';

function norm(s) {
  return String(s)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

/** Heurística: matrícula/CPF na 1.ª coluna → nome no meio, cargo por último ou 2.º */
function cellsToNomeCargo(cells) {
  const c = cells.map((t) => String(t || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (c.length < 2) return null;
  if (c.length === 2) return { nome: c[0], cargo: c[1] };
  const firstIsId = /^\d[\d.\-\s/]{4,}$/.test(c[0]) || /^\d{4,}$/.test(c[0].replace(/\D/g, ''));
  if (firstIsId && c.length >= 3) {
    return { nome: c[1], cargo: c.slice(2).join(' — ') || c[2] || '' };
  }
  if (c.length >= 3) {
    return { nome: c[1], cargo: c[2] };
  }
  return { nome: c[0], cargo: c[1] };
}

function isHeaderRow(cells) {
  const j = cells.join(' ').toLowerCase();
  if (/^nome$/i.test(cells[0]) || /^cargo$/i.test(cells[0])) return true;
  if (/matr[ií]cula|cpf|nome\s+do\s+servidor|fun[cç][aã]o|cargo|lotac/i.test(j) && cells.length <= 6) return true;
  return false;
}

/**
 * Extrai linhas { nome, cargo } de todas as tabelas da página.
 */
function parseHtmlTables(html) {
  const $ = cheerio.load(html);
  const out = [];
  $('table').each((_, table) => {
    $(table)
      .find('tr')
      .each((_, tr) => {
        const cells = $(tr)
          .find('th,td')
          .map((__, el) => $(el).text())
          .get()
          .map((t) => String(t || '').replace(/\s+/g, ' ').trim())
          .filter((t) => t.length > 0);
        if (cells.length < 2) return;
        if (isHeaderRow(cells)) return;
        const row = cellsToNomeCargo(cells);
        if (!row || !row.nome || row.nome.length < 4) return;
        if (/^total|^subtotal|^fonte|^prefeitura/i.test(row.nome)) return;
        out.push({ nome: row.nome, cargo: row.cargo || '' });
      });
  });
  return out;
}

/**
 * Remove duplicados por nome normalizado; mantém cargo mais completo quando possível.
 */
function dedupeByNome(list) {
  const m = new Map();
  for (const x of list) {
    const k = norm(x.nome);
    if (!k || k.length < 3) continue;
    const nome = String(x.nome || '').trim();
    const cargo = String(x.cargo || '').trim();
    const origem = x.origem != null ? String(x.origem).trim() : ORIGEM_PREFEITURA;
    if (!m.has(k)) m.set(k, { nome, cargo, origem });
    else {
      const cur = m.get(k);
      if (!cur.cargo && cargo) cur.cargo = cargo;
      if (!cur.origem && origem) cur.origem = origem;
    }
  }
  return [...m.values()];
}

/**
 * Obtém servidores diretamente do site oficial e devolve registos com origem explícita.
 * @returns {Promise<Array<{ nome: string, cargo: string, origem: string }>>}
 */
async function fetchServidoresNominal() {
  const res = await axios.get(NOMINAL_URL, {
    timeout: 90000,
    maxRedirects: 5,
    responseType: 'text',
    validateStatus: (s) => s >= 200 && s < 500,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
    },
  });
  if (res.status >= 400) {
    throw new Error(`HTTP ${res.status}`);
  }
  const html = typeof res.data === 'string' ? res.data : String(res.data || '');
  if (html.length < 200) {
    throw new Error('Resposta HTML muito curta');
  }
  const parsed = parseHtmlTables(html);
  const withOrigem = parsed.map((r) => ({
    nome: r.nome,
    cargo: r.cargo || '',
    origem: ORIGEM_PREFEITURA,
  }));
  const limpo = dedupeByNome(withOrigem);
  if (!limpo.length) {
    throw new Error('Nenhuma linha extraída das tabelas (verifique o layout HTML)');
  }
  return limpo;
}

module.exports = {
  NOMINAL_URL,
  ORIGEM_PREFEITURA,
  fetchServidoresNominal,
  parseHtmlTables,
  cellsToNomeCargo,
  isHeaderRow,
  dedupeByNome,
  norm,
};
