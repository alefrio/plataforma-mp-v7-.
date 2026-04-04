/**
 * Diário Oficial do Município de Buriticupu (DOM) — PDFs reais.
 * Não cria entradas na caixa de entrada: apenas atualiza nomeações/exonerações (overlay de secretários).
 */
const cheerio = require('cheerio');
const { fetchHtml, downloadPdfText, stableId, absolutize } = require('./diarioCrawlerCommon');
const { analiseTextoDom } = require('./domAtosParser');
const servidores = require('./servidores');

function collectPdfLinks(html, baseUrl) {
  const $ = cheerio.load(html);
  const set = new Set();
  $('a[href]').each((_, el) => {
    const h = $(el).attr('href');
    const abs = absolutize(h, baseUrl);
    if (!abs) return;
    if (/\.pdf(\?|$)/i.test(abs)) set.add(abs.split('#')[0]);
  });
  const re = /https?:\/\/[^\s"'<>]+\.pdf/gi;
  let m;
  const s = String(html);
  while ((m = re.exec(s))) {
    const u = m[0].replace(/&amp;/g, '&');
    try {
      const abs = absolutize(u, baseUrl);
      if (abs) set.add(abs);
    } catch {
      /* */
    }
  }
  return [...set];
}

function seedUrls() {
  const base = (process.env.DOM_BASE_URL || 'https://buriticupu.ma.gov.br/diariooficial.php').trim();
  const urls = new Set([base]);
  const extra = String(process.env.DOM_EXTRA_PAGES || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  for (const e of extra) {
    try {
      urls.add(new URL(e, base).href);
    } catch {
      /* */
    }
  }
  const defaults = ['https://buriticupu.ma.gov.br/diariolista.php', 'https://www.buriticupu.ma.gov.br/diariolista.php'];
  for (const d of defaults) {
    if (![...urls].some((u) => u.replace(/^www\./, '') === d.replace(/^www\./, ''))) {
      try {
        urls.add(new URL(d, base).href);
      } catch {
        /* */
      }
    }
  }
  return [...urls];
}

/**
 * Processa PDFs do DOM: detecta nomeações/exonerações e atualiza lista de secretários.
 * Não devolve itens para a caixa de entrada (denúncias).
 * @param {{ seenIds: Set<string>, maxItems?: number }} opts
 */
async function runDomCrawler(opts) {
  const seenIds = opts.seenIds;
  const maxItems = opts.maxItems != null ? opts.maxItems : 25;

  const pdfSet = new Set();
  for (const pageUrl of seedUrls()) {
    let html = '';
    try {
      html = await fetchHtml(pageUrl);
    } catch (e) {
      console.warn('[DOM] página indisponível:', pageUrl.slice(0, 80), e.message);
      continue;
    }
    collectPdfLinks(html, pageUrl).forEach((u) => pdfSet.add(u));
  }

  const pdfUrls = [...pdfSet].sort();
  let processed = 0;

  for (const pdfUrl of pdfUrls) {
    if (processed >= maxItems) break;
    const id = stableId('DOM', pdfUrl);
    if (seenIds.has(id)) continue;

    let texto = '';
    try {
      texto = await downloadPdfText(pdfUrl);
    } catch (e) {
      console.warn('[DOM] PDF:', pdfUrl.slice(0, 90), e.message);
      continue;
    }
    if (!texto || texto.length < 40) continue;

    const analise = analiseTextoDom(texto);
    for (const ato of analise.atos) {
      try {
        servidores.applyDomAto(ato);
      } catch (e) {
        console.warn('[DOM] overlay servidores:', e.message);
      }
    }

    seenIds.add(id);
    processed += 1;
    const atosN = analise.atos.length;
    const file = (() => {
      try {
        return decodeURIComponent(new URL(pdfUrl).pathname.split('/').pop() || 'dom.pdf');
      } catch {
        return 'dom.pdf';
      }
    })();
    console.log(
      `[DOM] Processado (sem caixa de entrada): ${file}${atosN ? ` — ${atosN} ato(s) nomeação/exoneração` : ''}${analise.denuncia ? ' — alerta texto (apenas log)' : ''}`
    );
  }

  if (processed) console.log('[DOM] PDFs municipais processados (só servidores):', processed);
  return [];
}

module.exports = { runDomCrawler, seedUrls };
