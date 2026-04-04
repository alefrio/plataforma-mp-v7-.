/**
 * Diário Oficial do Estado do Maranhão (DOE-MA) — diariooficial.ma.gov.br
 * Filtra publicações cujo PDF mencione Buriticupu.
 */
const cheerio = require('cheerio');
const { fetchHtml, downloadPdfText, norm, stableId, absolutize } = require('./diarioCrawlerCommon');
const { buildDiarioMonitorItem } = require('./diarioMonitorBuilder');

const FILTRO_LOCAL = 'buriticupu';

function collectPdfLinks(html, baseUrl) {
  const $ = cheerio.load(html);
  const set = new Set();
  $('a[href]').each((_, el) => {
    const h = $(el).attr('href');
    const abs = absolutize(h, baseUrl);
    if (!abs) return;
    if (/\.pdf(\?|$)/i.test(abs)) set.add(abs.split('#')[0]);
  });
  return [...set];
}

/**
 * @param {{ seenIds: Set<string>, maxItems?: number }} opts
 */
async function runDoeCrawler(opts) {
  const seenIds = opts.seenIds;
  const maxItems = opts.maxItems != null ? opts.maxItems : 12;
  const base = (process.env.DOE_BASE_URL || 'https://www.diariooficial.ma.gov.br').replace(/\/$/, '');
  const entry = process.env.DOE_ENTRY_PATH || '/';

  let html = '';
  try {
    html = await fetchHtml(base + entry);
  } catch (e) {
    console.warn('[DOE] página inicial:', e.message);
    return [];
  }

  let pdfUrls = collectPdfLinks(html, base + '/');
  if (pdfUrls.length < 3) {
    const extraPaths = ['/index.php', '/pesquisa', '/ultimas', '/home'].map((p) => base + p);
    for (const u of extraPaths) {
      try {
        const h = await fetchHtml(u);
        collectPdfLinks(h, u).forEach((x) => pdfUrls.push(x));
      } catch {
        /* ignore */
      }
    }
  }
  pdfUrls = [...new Set(pdfUrls)];

  const out = [];
  for (const pdfUrl of pdfUrls) {
    if (out.length >= maxItems) break;
    const id = stableId('DOE', pdfUrl);
    if (seenIds.has(id)) continue;

    let texto = '';
    try {
      texto = await downloadPdfText(pdfUrl);
    } catch (e) {
      console.warn('[DOE] PDF:', pdfUrl.slice(0, 90), e.message);
      continue;
    }
    if (!texto || texto.length < 60) continue;
    if (!norm(texto).includes(FILTRO_LOCAL)) continue;

    seenIds.add(id);
    const file = (() => {
      try {
        return decodeURIComponent(new URL(pdfUrl).pathname.split('/').pop() || 'doe.pdf');
      } catch {
        return 'doe.pdf';
      }
    })();
    out.push(
      buildDiarioMonitorItem('DOE', {
        titulo: `DOE-MA · Buriticupu · ${file}`,
        texto,
        url: pdfUrl,
        pdfUrl,
        id,
      })
    );
  }

  if (out.length) console.log('[DOE-MA] Novas publicações:', out.length);
  return out;
}

module.exports = { runDoeCrawler, FILTRO_LOCAL };
