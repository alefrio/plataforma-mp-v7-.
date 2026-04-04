/**
 * Diário Oficial da União (DOU) — busca por Buriticupu no portal IN.gov.
 * Estratégias: links .pdf na página de busca + URLs opcionais em DOU_EXTRA_PDF_URLS (env, separadas por vírgula).
 */
const cheerio = require('cheerio');
const { fetchHtml, downloadPdfText, norm, stableId, absolutize } = require('./diarioCrawlerCommon');
const { buildDiarioMonitorItem } = require('./diarioMonitorBuilder');

const FILTRO_LOCAL = 'buriticupu';

function extractPdfUrlsFromHtml(html, pageUrl) {
  const $ = cheerio.load(html);
  const set = new Set();
  $('a[href]').each((_, el) => {
    const h = $(el).attr('href');
    const abs = absolutize(h, pageUrl);
    if (abs && /\.pdf(\?|$)/i.test(abs) && /in\.gov\.br/i.test(abs)) set.add(abs.split('#')[0]);
  });
  const re = /https?:\/\/[^\s"'<>]+\.pdf/gi;
  let m;
  const shtml = String(html);
  while ((m = re.exec(shtml))) {
    const u = m[0].replace(/&amp;/g, '&');
    if (/in\.gov\.br/i.test(u)) set.add(u.split('#')[0]);
  }
  return [...set];
}

/**
 * @param {{ seenIds: Set<string>, maxItems?: number }} opts
 * @returns {Promise<Array<object>>}
 */
async function runDouCrawler(opts) {
  const seenIds = opts.seenIds;
  const maxItems = opts.maxItems != null ? opts.maxItems : 12;
  const searchUrl =
    process.env.DOU_SEARCH_URL ||
    'https://www.in.gov.br/consulta/-/buscar/dou?q=Buriticupu&delta=40&sortBy=0';
  const extra = String(process.env.DOU_EXTRA_PDF_URLS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const pdfUrls = new Set(extra);
  try {
    const html = await fetchHtml(searchUrl);
    extractPdfUrlsFromHtml(html, searchUrl).forEach((u) => pdfUrls.add(u));
  } catch (e) {
    console.warn('[DOU] busca IN.gov:', e.message);
  }

  const out = [];
  for (const pdfUrl of pdfUrls) {
    if (out.length >= maxItems) break;
    const id = stableId('DOU', pdfUrl);
    if (seenIds.has(id)) continue;

    let texto = '';
    try {
      texto = await downloadPdfText(pdfUrl);
    } catch (e) {
      console.warn('[DOU] PDF:', pdfUrl.slice(0, 80), e.message);
      continue;
    }
    if (!texto || texto.length < 80) continue;
    if (!norm(texto).includes(FILTRO_LOCAL)) continue;

    seenIds.add(id);
    const titulo = `DOU · Menção a Buriticupu · ${new URL(pdfUrl).pathname.split('/').pop() || 'documento.pdf'}`;
    out.push(
      buildDiarioMonitorItem('DOU', {
        titulo,
        texto,
        url: pdfUrl,
        pdfUrl,
        id,
      })
    );
  }

  if (out.length) console.log('[DOU] Novas publicações:', out.length);
  return out;
}

module.exports = { runDouCrawler, FILTRO_LOCAL };
