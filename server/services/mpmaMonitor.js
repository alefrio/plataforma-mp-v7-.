/**
 * Monitor do Diário Oficial MPMA — apenas PDFs reais de https://apps.mpma.mp.br/diario/
 * Regras: domínio *.mpma.mp.br, Buriticupu + ≥1 nome da lista (Excel Sisponto + nominal + .env + DOM + legado).
 * Trechos exibidos: só para nomes confirmados neste PDF; ±200 palavras, fora do cabeçalho; mesmo pdfUrl.
 * Sem mistura entre PDFs: URL canónico, hash do binário e hash do texto extraído.
 */
const axios = require('axios');
const cheerio = require('cheerio');
const crypto = require('crypto');
const pdfParse = require('pdf-parse');
const path = require('path');

const DIARIO_URL = 'https://apps.mpma.mp.br/diario/';

/** Limite de páginas HTML do mesmo site a rastrear (evita loop infinito) */
const MAX_HTML_PAGES = 80;

/**
 * Liderança / secretarias — nomes oficiais + cargo para exibição e detecção com trecho no PDF.
 * Na lista de monitoramento: deteção por variantes (nome completo, sem partículas, primeiro+último);
 * na notificação grava-se sempre o nome completo vindo do cadastro (Excel/nominal/.env), não só o trecho do PDF.
 */
const LIDERANCA_MPMA_MONITORADA = [
  { nomeCompleto: 'João Carlos Teixeira da Silva', cargo: 'Prefeito' },
  { nomeCompleto: 'Afonso Barros Batista', cargo: 'Chefe de Gabinete do Prefeito' },
  { nomeCompleto: 'Whesley Nunes do Nascimento', cargo: 'Procuradoria-Geral do Município' },
  { nomeCompleto: 'Vandecleber Freitas Silva', cargo: 'Sec. Administração e Planejamento' },
  { nomeCompleto: 'Maria Celioneide da Luz', cargo: 'Sec. Fazenda e Orçamento' },
  { nomeCompleto: 'Denis Araujo da Silva', cargo: 'Sec. Transparência e Controle Interno' },
  { nomeCompleto: 'Clodilton Sousa Bonfim', cargo: 'Sec. Educação' },
  { nomeCompleto: 'Chrystiane Pianco Lima', cargo: 'Sec. Saúde' },
  { nomeCompleto: 'Lucas Rafael da Conceição Pereira', cargo: 'Sec. Infraestrutura' },
  { nomeCompleto: 'Vera Lucia Santos Costa', cargo: 'Sec. Meio Ambiente' },
  { nomeCompleto: 'Thiago Felipe Costa Sousa', cargo: 'Sec. Habitação' },
  { nomeCompleto: 'Frank Eron Nunes Araujo', cargo: 'Sec. Segurança Pública' },
  { nomeCompleto: 'Áurea Cristina Costa Flor', cargo: 'Sec. Desenvolvimento Social' },
  { nomeCompleto: 'Euzilene Gonçalves Lopes da Silva', cargo: 'Sec. da Mulher' },
  { nomeCompleto: 'Mateus Nobre da Silva', cargo: 'Sec. Cultura' },
  { nomeCompleto: 'Willas de Melo Sousa', cargo: 'Sec. Esporte' },
  { nomeCompleto: 'Marcos Almeida Lima', cargo: 'Sec. Agricultura' },
  { nomeCompleto: 'Thiago Silva Brito', cargo: 'Sec. Indústria e Comércio' },
  { nomeCompleto: 'Mauricio Cruz Marinho', cargo: 'Sec. Comunicação' },
];

/** Legado: nomes canónicos da liderança (alinha com .env / outras fontes). */
const MONITORED_NAMES = LIDERANCA_MPMA_MONITORADA.map((x) => x.nomeCompleto);

/** Palavras de contexto ao redor de cada ocorrência do nome (±200). */
const PALAVRAS_CONTEXTO_NOME = 200;

/** Texto útil mínimo após normalização de espaços (evita PDF vazio / OCR inválido). */
const MIN_MPMA_PDF_TEXT_CHARS = 500;

function norm(s) {
  return String(s)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function nameMatches(nt, name) {
  const raw = String(name || '').trim();
  const nn = norm(raw);
  if (!nn.length) return false;
  const oneWord = !raw.includes(' ');
  if (oneWord && nn.length <= 8) {
    const re = new RegExp(`(?:^|[^a-z0-9])${escapeRe(nn)}(?:[^a-z0-9]|$)`);
    return re.test(nt);
  }
  if (oneWord) {
    return nt.includes(nn);
  }
  /** Nomes compostos: qualquer variante significativa no texto → considera menção; exibição continua com nome completo do cadastro. */
  const variants = nameMatchVariantsFromDisplay(raw);
  for (const v of variants) {
    if (!v) continue;
    const parts = v.split(/\s+/).filter(Boolean);
    if (parts.length < 2 && v.length < 8) continue;
    if (nt.includes(v)) return true;
  }
  return false;
}

/**
 * @param {string} text - texto do PDF
 * @param {Array<{nome:string,cargo?:string,origem?:string,setor?:string,departamento?:string,lotacao?:string}>} listaEntries
 * @returns {Array<{nome:string,cargo:string,origem:string,setor:string,departamento:string,lotacao:string}>}
 */
function findMatchedNames(text, listaEntries) {
  const nt = norm(text);
  if (!listaEntries || !listaEntries.length) return [];
  const seen = new Set();
  const out = [];
  for (const entry of listaEntries) {
    const name = String(entry.nome || '').trim();
    if (!name) continue;
    if (!nameMatches(nt, name)) continue;
    const canon =
      /^chrystiane\s+pianc/i.test(name) || /^chrystiane\s+pianco/i.test(name)
        ? 'Chrystiane Pianco Lima'
        : name;
    const cargo = entry.cargo != null ? String(entry.cargo).trim() : '';
    const origem = entry.origem != null ? String(entry.origem).trim() : '';
    const setor = entry.setor != null ? String(entry.setor).trim() : '';
    const departamento = entry.departamento != null ? String(entry.departamento).trim() : '';
    const lotacao = entry.lotacao != null ? String(entry.lotacao).trim() : '';
    const key = norm(canon);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ nome: canon, cargo, origem, setor, departamento, lotacao });
  }
  return out;
}

function dedupeMencoes(people) {
  const m = new Map();
  for (const p of people || []) {
    const n = String(p.nome || '').trim();
    if (!n) continue;
    const k = norm(n);
    const nome =
      /^chrystiane\s+pianc/i.test(n) || /^chrystiane\s+pianco/i.test(n) ? 'Chrystiane Pianco Lima' : n;
    const origem = p.origem != null ? String(p.origem).trim() : '';
    const setor = p.setor != null ? String(p.setor).trim() : '';
    const departamento = p.departamento != null ? String(p.departamento).trim() : '';
    const lotacao = p.lotacao != null ? String(p.lotacao).trim() : '';
    if (!m.has(k)) {
      m.set(k, {
        nome,
        cargo: String(p.cargo || '').trim(),
        origem,
        setor,
        departamento,
        lotacao,
      });
    } else {
      const cur = m.get(k);
      if (!cur.cargo && p.cargo) cur.cargo = String(p.cargo).trim();
      if (!cur.origem && origem) cur.origem = origem;
      if (!cur.setor && setor) cur.setor = setor;
      if (!cur.departamento && departamento) cur.departamento = departamento;
      if (!cur.lotacao && lotacao) cur.lotacao = lotacao;
    }
  }
  return [...m.values()];
}

function stripEdgePunct(w) {
  return String(w || '').replace(/^[\s.,;:()[\]"'«»°º]+|[\s.,;:()[\]"'«»°º]+$/g, '');
}

function normToken(w) {
  return norm(stripEdgePunct(w));
}

function tokenizePdfWords(rawText) {
  return String(rawText || '')
    .replace(/\r/g, ' ')
    .replace(/\n+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0);
}

/** Índice da primeira palavra após cabeçalho típico de DO/MPMA (trechos de nome não usam esta zona). */
function computeHeaderEndWordIndex(normToks) {
  const n = normToks.length;
  if (!n) return 0;
  let end = 0;
  const headSample = normToks.slice(0, Math.min(120, n)).join(' ');
  if (
    /diario\s+oficial|estado\s+do\s+maranhao|ministerio\s+publico|minist[eé]rio|mpma|publicac|folha|edicao|poder\s+executivo|rep[uú]blica/.test(
      headSample
    )
  ) {
    end = Math.max(end, 48);
  }
  const scan = Math.min(300, n);
  for (let i = 16; i < scan; i++) {
    const t = normToks[i] || '';
    if (/^considerando|^resolve|^portaria|^recomenda|^notifica|^determina|^instaur|^fica|^ficam/.test(t)) {
      end = Math.max(end, i);
      break;
    }
  }
  return Math.min(Math.max(end, 0), Math.min(340, Math.floor(n * 0.33)));
}

function nameMatchVariantsFromDisplay(nomeCompleto) {
  const full = norm(String(nomeCompleto))
    .replace(/\s+/g, ' ')
    .trim();
  const parts = full.split(/\s+/).filter((p) => p.length > 0);
  const noParticle = parts.filter((p) => !['da', 'de', 'do', 'das', 'dos', 'e'].includes(p));
  const variants = [];
  if (parts.length) variants.push(parts.join(' '));
  if (noParticle.length >= 3 && noParticle.join(' ') !== parts.join(' ')) {
    variants.push(noParticle.join(' '));
  }
  if (noParticle.length >= 2) {
    variants.push(`${noParticle[0]} ${noParticle[noParticle.length - 1]}`);
  }
  const seen = new Set();
  const out = [];
  for (const v of variants) {
    if (!v || v.length < 8) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out.sort((a, b) => b.length - a.length);
}

function tokensMatchAt(normToks, wordStart, parts) {
  if (wordStart < 0 || wordStart + parts.length > normToks.length) return false;
  for (let j = 0; j < parts.length; j++) {
    const tk = normToks[wordStart + j] || '';
    const need = parts[j];
    if (!need) return false;
    if (tk === need) continue;
    if (need.length >= 4 && tk.length >= 4 && (tk.startsWith(need) || need.startsWith(tk))) continue;
    return false;
  }
  return true;
}

function findAllWordStartsForVariant(normToks, variantString) {
  const parts = variantString.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return { hits: [], partsLen: 0 };
  const hits = [];
  for (let i = 0; i <= normToks.length - parts.length; i++) {
    if (tokensMatchAt(normToks, i, parts)) hits.push(i);
  }
  return { hits, partsLen: parts.length };
}

/** Ocorrências de um único token (nome já confirmado no PDF pelo filtro global). */
function findSingleTokenHits(normToks, token) {
  if (!token || token.length < 4) return { hits: [], partsLen: 1 };
  const hits = [];
  for (let i = 0; i < normToks.length; i++) {
    const tk = normToks[i] || '';
    if (tk === token) hits.push(i);
    else if (token.length >= 6 && tk.length >= 4 && (tk.startsWith(token) || token.startsWith(tk))) hits.push(i);
  }
  return { hits, partsLen: 1 };
}

function nameMatchVariantsForPerson(nomeCompleto) {
  const base = nameMatchVariantsFromDisplay(nomeCompleto);
  const parts = norm(String(nomeCompleto))
    .replace(/\s+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const merged = [...base];
  if (parts.length === 1 && parts[0].length >= 6 && !merged.includes(parts[0])) merged.push(parts[0]);
  return merged.sort((a, b) => b.length - a.length);
}

/** Último recurso: nome normalizado dentro da sequência de tokens (espaços irregulares no PDF). */
function fallbackWordStartFromJoined(normToks, nomeDisplay) {
  const needle = norm(String(nomeDisplay))
    .replace(/\s+/g, ' ')
    .trim();
  if (needle.length < 10) return null;
  const hay = normToks.join(' ');
  const idx = hay.indexOf(needle);
  if (idx < 0) return null;
  const before = hay.slice(0, idx).trim();
  const wordStart = before ? before.split(/\s+/).filter(Boolean).length : 0;
  const partsLen = Math.max(2, needle.split(/\s+/).filter(Boolean).length);
  return { wordStart, partsLen };
}

function findHitsForNome(normToks, nomeDisplay) {
  const variants = nameMatchVariantsForPerson(nomeDisplay);
  for (const v of variants) {
    const p = v.split(/\s+/).filter(Boolean);
    if (p.length >= 2) {
      const { hits, partsLen } = findAllWordStartsForVariant(normToks, v);
      if (hits.length) return { hits, partsLen };
    }
    if (p.length === 1 && p[0].length >= 4) {
      const { hits, partsLen } = findSingleTokenHits(normToks, p[0]);
      if (hits.length) return { hits, partsLen };
    }
  }
  const fb = fallbackWordStartFromJoined(normToks, nomeDisplay);
  if (fb) return { hits: [fb.wordStart], partsLen: fb.partsLen };
  return { hits: [], partsLen: 0 };
}

function clampTrechoMpma(t, maxLen) {
  const t0 = String(t || '').trim();
  if (t0.length <= maxLen) return t0;
  const cut = t0.slice(0, maxLen - 1);
  const sp = cut.lastIndexOf(' ');
  return (sp > maxLen * 0.45 ? cut.slice(0, sp) : cut) + '…';
}

/**
 * Trechos reais (±PALAVRAS_CONTEXTO_NOME palavras) só para pessoas já confirmadas no texto pelo filtro MPMA.
 * Evita cabeçalho; um PDF → uma lista → mesmo pdfUrl (sem mistura).
 * @param {Array<{nome:string,cargo?:string,setor?:string}>} pessoasConfirmadas
 * @returns {Array<{ nomeCompleto: string, cargo: string, setor: string, trecho: string, pdfUrl: string }>}
 */
function extrairOcorrenciasConfirmadasMpma(rawText, pdfUrlCanon, pessoasConfirmadas) {
  const pdfU = String(pdfUrlCanon || '').trim();
  const tokens = tokenizePdfWords(rawText);
  if (!tokens.length || !pessoasConfirmadas || !pessoasConfirmadas.length) return [];
  const normToks = tokens.map((t) => normToken(t));
  const headerEnd = computeHeaderEndWordIndex(normToks);
  const out = [];
  const usedKeys = new Set();
  const maxPerPerson = 3;
  const maxTotal = 50;

  for (const p of pessoasConfirmadas) {
    if (out.length >= maxTotal) break;
    const nomeCompleto = String(p.nome || '').trim();
    if (!nomeCompleto) continue;
    const { hits, partsLen } = findHitsForNome(normToks, nomeCompleto);
    if (!hits.length || partsLen < 1) continue;
    const cargo = String(p.cargo || '').trim();
    const setor = String(p.setor || '').trim();
    let count = 0;
    for (const wordStart of hits) {
      if (out.length >= maxTotal || count >= maxPerPerson) break;
      if (wordStart + partsLen <= headerEnd) continue;
      const key = `${norm(nomeCompleto)}@${wordStart}`;
      if (usedKeys.has(key)) continue;
      usedKeys.add(key);
      const center = wordStart + Math.floor(partsLen / 2);
      const from = Math.max(headerEnd, center - PALAVRAS_CONTEXTO_NOME);
      const to = Math.min(tokens.length, center + PALAVRAS_CONTEXTO_NOME + partsLen);
      const trecho = tokens.slice(from, to).join(' ').replace(/\s+/g, ' ').trim();
      if (trecho.length < 40) continue;
      out.push({
        nomeCompleto,
        cargo,
        setor,
        trecho,
        pdfUrl: pdfU,
      });
      count++;
    }
  }
  return out;
}

/** @deprecated usar extrairOcorrenciasConfirmadasMpma com lista da liderança */
function detectarOcorrenciasLiderancaMpma(rawText, pdfUrlCanon) {
  const rows = LIDERANCA_MPMA_MONITORADA.map((r) => ({
    nome: r.nomeCompleto,
    cargo: r.cargo,
    setor: '',
  }));
  return extrairOcorrenciasConfirmadasMpma(rawText, pdfUrlCanon, rows);
}

function absolutize(href, baseUrl) {
  if (!href) return null;
  const b = baseUrl || DIARIO_URL;
  try {
    return new URL(href.trim(), b).href;
  } catch {
    return null;
  }
}

function shouldFollowHtml(absUrl) {
  try {
    const u = new URL(absUrl);
    if (u.hostname !== 'apps.mpma.mp.br') return false;
    if (!u.pathname.toLowerCase().includes('/diario')) return false;
    const lower = absUrl.toLowerCase();
    if (lower.endsWith('.pdf')) return false;
    if (/\.(zip|rar|7z|jpg|jpeg|png|gif|webp|doc|docx|xls|xlsx)$/i.test(u.pathname)) return false;
    return true;
  } catch {
    return false;
  }
}

function normalizePdfUrl(abs) {
  if (!abs) return null;
  const u = abs.split('?')[0].split('#')[0];
  return u;
}

/**
 * Coleta todos os links .pdf alcançáveis a partir da página do diário (mesmo host, /diario/).
 */
async function fetchDiarioPdfLinks() {
  const seeds = [DIARIO_URL];
  const visitedHtml = new Set();
  const queued = new Set(seeds);
  const pdfLinks = new Set();
  const queue = [...seeds];

  while (queue.length && visitedHtml.size < MAX_HTML_PAGES) {
    const pageUrl = queue.shift();
    if (pageUrl) queued.delete(pageUrl);
    if (!pageUrl || visitedHtml.has(pageUrl)) continue;
    visitedHtml.add(pageUrl);

    let html;
    try {
      const { data } = await axios.get(pageUrl, {
        timeout: 90000,
        headers: { 'User-Agent': 'PlataformaMP/7.2 (monitor MPMA; +https://apps.mpma.mp.br/diario/)' },
        maxRedirects: 5,
        validateStatus: (s) => s >= 200 && s < 400,
      });
      html = data;
    } catch (e) {
      console.error('[MPMA] Falha ao obter HTML:', pageUrl, e.message);
      continue;
    }

    const $ = cheerio.load(html);
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href');
      if (!href) return;
      const abs = absolutize(href, pageUrl);
      if (!abs) return;
      const lower = abs.toLowerCase();
      if (lower.includes('.pdf')) {
        const n = normalizePdfUrl(abs);
        const canon = n ? normalizeMpmaPdfUrl(n) : null;
        if (canon) pdfLinks.add(canon);
        return;
      }
      if (shouldFollowHtml(abs) && !visitedHtml.has(abs) && !queued.has(abs)) {
        queued.add(abs);
        queue.push(abs);
      }
    });
  }

  return [...pdfLinks];
}

/**
 * Baixa o PDF do URL dado e extrai texto no mesmo fluxo (o texto corresponde sempre a este binário).
 * @returns {{ text: string, pdfBinarioSha256: string }}
 */
async function downloadAndParsePdf(url) {
  const { data } = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 180000,
    headers: { 'User-Agent': 'PlataformaMP/7.2 (monitor MPMA)' },
    maxRedirects: 5,
  });
  const buf = Buffer.from(data);
  const pdfBinarioSha256 = crypto.createHash('sha256').update(buf).digest('hex');
  const parsed = await pdfParse(buf);
  const text = parsed.text || '';
  return { text, pdfBinarioSha256 };
}

/** Risco institucional por palavras-chave (improbidade, erário, irregularidade, etc.) */
function classifyRiscoInstitucionalText(rawText) {
  const s = norm(String(rawText || '').slice(0, 12000));
  const termos = [];
  const push = (t) => {
    if (!termos.includes(t)) termos.push(t);
  };
  if (/irregularidade|ato\s+irregular|irregularidades/.test(s)) push('irregularidade');
  if (/improbidade|lei\s*8\.?429|lei\s*14\.?230/.test(s)) push('improbidade');
  if (/dano\s+ao\s+er[aá]rio|er[aá]rio\s+p[uú]blico|les[aã]o\s+ao\s+patrim[oô]nio/.test(s)) push('dano ao erário');
  if (/corrup[cç][aã]o|conluio|superfaturamento/.test(s)) push('corrupção / conluio');
  if (/lavagem\s+de\s+dinheiro|oculta[cç][aã]o\s+de\s+bens/.test(s)) push('lavagem / ocultação');
  if (/prevarica[cç][aã]o|concuss[aã]o|peculato/.test(s)) push('crime contra a administração');
  let score = 0;
  termos.forEach((t) => {
    if (t.includes('improbidade') || t.includes('erário')) score += 3;
    else if (t.includes('irregularidade') || t.includes('corrupção')) score += 2;
    else score += 1;
  });
  let nivel = 'baixo';
  if (score >= 5 || termos.some((x) => x.includes('improbidade') || x.includes('erário'))) nivel = 'alto';
  else if (score >= 2) nivel = 'medio';
  return { nivel, termos };
}

/** Classificação do tipo de documento a partir do texto (heurística, texto real) */
function detectDocumentKind(rawText) {
  const sample = String(rawText || '').slice(0, 3500);
  const s = norm(sample);
  if (/inqu[eé]rito|investiga[cç][aã]o|procedimento\s+investigat[oó]rio|apura[cç][aã]o\s+administrativa/.test(s))
    return 'Investigação / inquérito';
  if (/ministerio\s+publico|promotoria\s+de\s+justica|mpma|parquet/.test(s)) return 'Comunicação / atuação MPMA';
  if (/recomendacao|recomenda..o\s+ministerial/.test(s)) return 'Recomendação ministerial';
  if (/notificacao|notifica..o/.test(s)) return 'Notificação';
  if (/portaria\s+n/.test(s) || /\bportaria\b/.test(s)) return 'Portaria';
  if (/edital/.test(s)) return 'Edital';
  if (/ato\s+normativo|decreto\s+municipal/.test(s)) return 'Ato normativo';
  if (/diario\s+oficial|\bdoe\b|dom\s+n/.test(s)) return 'Diário Oficial';
  if (/termo\s+de\s+ajustamento|tac\b/.test(s)) return 'TAC / ajustamento de conduta';
  if (/acao\s+civil|ACP|improbidade/.test(s)) return 'Ação civil / improbidade';
  return 'Documento oficial MPMA';
}

/**
 * Título dinâmico: tipo do documento + nomes monitorados + trecho contextual (só texto do PDF).
 * @param {string} [docKindOverride] - classificação jurídica detectada no texto (prioritária)
 */
function extractSmartTitle(rawText, matchedNames, docKindOverride) {
  const kind = docKindOverride || detectDocumentKind(rawText);
  const uniq = [...new Set(matchedNames || [])].filter(Boolean);
  const namesShort = uniq.slice(0, 3).join(', ') + (uniq.length > 3 ? '…' : '');
  const flat = String(rawText || '')
    .replace(/\r/g, ' ')
    .replace(/\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  let ctx = '';
  if (flat.length > 120) {
    const low = flat.toLowerCase();
    let start = Math.min(120, Math.floor(flat.length * 0.06));
    const considerando = low.indexOf('considerando');
    if (considerando >= 0 && considerando < flat.length - 80) start = considerando + 12;
    const slice = flat.slice(start, start + 620);
    const m =
      slice.match(/(?:ato|recomenda|notifica|portaria|inqu[eé]rito|investiga|determina|resolve)[^.]{25,220}/i) ||
      slice.match(/[A-Za-zÀ-ú]{4}[^\n]{35,}/);
    ctx = (m ? m[0] : slice).replace(/\s+/g, ' ').trim();
  } else {
    ctx = flat;
  }
  if (ctx.length > 110) ctx = ctx.slice(0, 107).replace(/\s+\S*$/, '') + '…';
  const namePart = namesShort ? `Citados no texto: ${namesShort}` : 'Documento (MPMA)';
  let title = `${kind} · ${namePart}`;
  if (ctx && ctx.length > 18) title += ` · ${ctx}`;
  if (title.length > 240) title = title.slice(0, 237) + '…';
  return title || 'Documento oficial MPMA';
}

/**
 * Corpo principal do texto (após cabeçalho típico de DO), só para localizar frases — ainda é texto do PDF.
 */
function slicePdfBodyForResumo(rawText) {
  let t = String(rawText || '')
    .replace(/\r/g, ' ')
    .replace(/\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (t.length > 12000) t = t.slice(0, 12000);
  let start = 0;
  const head = t.slice(0, 500).toLowerCase();
  if (
    /diário oficial|diario oficial|estado do maranhão|maranhão|mpma|publicaç|folha|edição/.test(head) &&
    t.length > 400
  ) {
    const dot = t.indexOf('. ', 80);
    const sec = t.indexOf('. ', dot + 2);
    if (sec > 100) start = sec + 2;
    else if (dot > 60) start = dot + 2;
    else start = Math.min(200, Math.floor(t.length * 0.12));
  }
  const body = t.slice(start).trim();
  return body.length >= 80 ? body : t;
}

/**
 * Resumo = 3 a 4 frases consecutivas copiadas do texto do PDF (sem síntese nem conteúdo externo).
 */
function extractResumoFromText(rawText) {
  const body = slicePdfBodyForResumo(rawText);
  const re = /[^.!?…]{25,}?[.!?…]+/g;
  const sentences = [];
  let m;
  while ((m = re.exec(body)) !== null && sentences.length < 4) {
    const s = m[0].replace(/\s+/g, ' ').trim();
    if (s.length < 28) continue;
    sentences.push(s);
  }
  let out = sentences.join(' ');
  const maxChars = 920;
  if (out.length > maxChars) {
    out = out.slice(0, maxChars);
    const sp = out.lastIndexOf(' ');
    if (sp > maxChars * 0.55) out = out.slice(0, sp);
    out = out.replace(/[;,:\s]+$/, '') + '…';
  }
  if (out.length >= 40) return out;
  const fallback = body.slice(0, Math.min(680, body.length)).trim();
  return fallback.length > 45 ? `${fallback.replace(/\s+\S*$/, '')}…` : body.slice(0, 400);
}

/**
 * URL canónica do PDF MPMA — mesma string para hash do ID, armazenamento e download (evita mistura entre PDFs).
 */
function normalizeMpmaPdfUrl(url) {
  try {
    let s = String(url || '').trim();
    if (!s) return null;
    if (/^\/\//.test(s)) s = 'https:' + s;
    const u = new URL(s);
    if (u.protocol === 'http:') u.protocol = 'https:';
    u.hash = '';
    if (u.protocol !== 'https:') return null;
    const host = u.hostname.toLowerCase();
    if (host !== 'mpma.mp.br' && !host.endsWith('.mpma.mp.br')) return null;
    return u.href;
  } catch {
    return null;
  }
}

/** Apenas HTTPS do domínio oficial MPMA (ex.: apps.mpma.mp.br). */
function isAllowedMpmaPdfUrl(pdfUrl) {
  return !!normalizeMpmaPdfUrl(pdfUrl);
}

/**
 * Gate: texto suficiente, Buriticupu, e pelo menos um sinal — nome na lista OU secretaria (catálogo) OU frase "secretário … de …".
 * Lista vazia não impede validação se secretaria/secretário estiverem no texto (require lazy de mpmaService evita ciclo de carga).
 * @param {Array<{nome:string,cargo?:string,origem?:string}>} listaMonitoramento
 */
function validateMpmaPdfContentForDenuncia(rawText, listaMonitoramento) {
  const compact = String(rawText || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (compact.length < MIN_MPMA_PDF_TEXT_CHARS) return false;
  const nt = norm(rawText);
  if (!nt.includes('buriticupu')) return false;
  let mpmaSvc;
  try {
    mpmaSvc = require('./mpmaService');
  } catch {
    mpmaSvc = null;
  }
  const secretariasNoTexto = mpmaSvc && mpmaSvc.encontrarSecretarias ? mpmaSvc.encontrarSecretarias(rawText) : [];
  const secretariosNoTexto = mpmaSvc && mpmaSvc.detectarSecretario ? mpmaSvc.detectarSecretario(rawText) : [];
  const matchedLista =
    listaMonitoramento && listaMonitoramento.length
      ? findMatchedNames(rawText, listaMonitoramento)
      : [];
  return (
    matchedLista.length > 0 ||
    secretariasNoTexto.length > 0 ||
    secretariosNoTexto.length > 0
  );
}

/** Assinatura do texto extraído (deteção de alterações / consistência com o PDF processado). */
function sha256TextoPdf(rawText) {
  const slice = String(rawText || '').slice(0, 120000);
  return crypto.createHash('sha256').update(slice, 'utf8').digest('hex');
}

/**
 * Converte trecho "10.000,00" ou "1000,50" (padrão BR) para centavos.
 */
function parseBRLToCentavos(token) {
  const s = String(token || '')
    .replace(/\s/g, '')
    .replace(/\./g, '')
    .replace(',', '.');
  const n = parseFloat(s, 10);
  if (!Number.isFinite(n) || n < 0 || n > 1e12) return null;
  return Math.round(n * 100);
}

function formatBRLFromCentavos(centavos) {
  if (centavos == null || !Number.isFinite(centavos)) return null;
  const r = centavos / 100;
  return r.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

/**
 * Extrai multa em R$ do texto: classifica diária, por cláusula ou única (só o que o PDF permite inferir).
 */
function extractMultaInfo(rawText) {
  const flat = String(rawText || '').replace(/\s+/g, ' ');
  const result = {
    tipo: null,
    valorCentavos: null,
    trecho: null,
  };
  if (!flat.length) return result;

  const re = /R\$\s*((?:\d{1,3}(?:\.\d{3})*|\d+),\d{2})/gi;
  const candidates = [];
  let m;
  while ((m = re.exec(flat)) !== null) {
    const cents = parseBRLToCentavos(m[1]);
    if (cents == null) continue;
    const idx = m.index;
    const ctx = flat.slice(Math.max(0, idx - 120), Math.min(flat.length, idx + m[0].length + 120));
    const nt = norm(ctx);
    let score = 0;
    if (/multa|sanc|astreint|penalidade|valor.*aplic|enforcement/i.test(ctx)) score += 6;
    if (/diaria|diária|por\s+dia|\/\s*dia|d\/dia|valor\s+diario/i.test(ctx)) score += 4;
    if (/clausula|cláusula|infra[cç][aã]o|descumprimento|viola/.test(ctx)) score += 3;
    candidates.push({ cents, ctx, score, match: m[0] });
  }

  if (!candidates.length) return result;
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  const ctxN = norm(best.ctx);
  let tipo = 'unica';
  if (/diaria|diária|por\s+dia|\/\s*dia|d\/dia|valor\s+diario|multa\s+diaria/.test(ctxN)) {
    tipo = 'diaria';
  } else if (/clausula|cláusula|por\s+clausula|por\s+cláusula|infra[cç][aã]o|descumprimento/.test(ctxN)) {
    tipo = 'por_clausula';
  }

  result.tipo = tipo;
  result.valorCentavos = best.cents;
  result.trecho = best.ctx.length > 220 ? `${best.ctx.slice(0, 217)}…` : best.ctx;
  return result;
}

/**
 * Classificação jurídica objetiva (somente se o texto contiver padrões claros).
 */
function classifyDocumentoJuridico(rawText) {
  const s = norm(String(rawText || '').slice(0, 8000));
  if (/termo\s+de\s+ajustamento|\btac\b|ajustamento\s+de\s+conduta/.test(s)) {
    return { codigo: 'TAC', rotulo: 'Termo de Ajustamento de Conduta (TAC)' };
  }
  if (
    /procedimento\s+investigat[oó]rio|inqu[eé]rito\s+civil|pci\b|not[ií]cia\s+de\s+fato|instaura[cç][aã]o\s+de\s+procedimento/.test(s)
  ) {
    return { codigo: 'PROCEDIMENTO_INVESTIGATIVO', rotulo: 'Procedimento investigativo' };
  }
  if (/recomenda[cç][aã]o\s+ministerial|recomenda\s+o\s+cumprimento|recomenda[cç][aã]o\s+n/.test(s)) {
    return { codigo: 'RECOMENDACAO', rotulo: 'Recomendação ministerial' };
  }
  return { codigo: null, rotulo: null };
}

/**
 * Órgão do MP (Promotoria / Ministério Público) citado no texto.
 */
function extractOrgaoMP(rawText) {
  const t = String(rawText || '').replace(/\s+/g, ' ');
  let m = t.match(
    /(\d+[ªº°]?\s*)?Promotoria\s+de\s+Justi[çc]a(?:\s+de\s+|\s+d[''])([^\n\r.;]{2,55})/i
  );
  if (m) {
    const p1 = (m[1] || '').trim();
    let p2 = m[2].replace(/\s+/g, ' ').trim();
    p2 = p2.replace(/\s+(notifica|requer|determina|cumprir|fica|vem|informa)\b.*$/i, '').trim();
    if (p2.length < 2) return null;
    return `${p1 ? `${p1} ` : ''}Promotoria de Justiça de ${p2}`.replace(/\s+/g, ' ').trim();
  }
  m = t.match(/Minist[eé]rio\s+P[uú]blico[^.\n\r]{0,120}/i);
  if (m) return m[0].replace(/\s+/g, ' ').trim().slice(0, 160);
  m = t.match(/Parquet\s+[^\n\r.;]{2,80}/i);
  if (m) return m[0].replace(/\s+/g, ' ').trim().slice(0, 140);
  return null;
}

/**
 * Risco financeiro: só calcula multa diária × dias corridos quando ambos são claros (sem inventar conversão de dias úteis).
 */
function computeRiscoFinanceiro(multaInfo, prazoInfo) {
  if (!multaInfo || multaInfo.tipo !== 'diaria' || !multaInfo.valorCentavos) return null;
  if (!prazoInfo || prazoInfo.days == null || prazoInfo.days < 1) return null;
  if (prazoInfo.diasUteis) {
    return {
      calculado: false,
      motivo: 'Prazo em dias úteis — não se aplica multiplicação automática por multa diária.',
    };
  }
  if (prazoInfo.days > 3650) return null;
  const totalCentavos = multaInfo.valorCentavos * prazoInfo.days;
  const diariaFmt = formatBRLFromCentavos(multaInfo.valorCentavos);
  return {
    calculado: true,
    totalCentavos,
    dias: prazoInfo.days,
    formula: `${diariaFmt} × ${prazoInfo.days} dia(s) corridos (multa diária declarada no texto)`,
  };
}

/**
 * Extrai prazo em dias do texto. Dias úteis: não gera data ISO automática (evita dado falso).
 */
function extractPrazoInfo(rawText) {
  const t = String(rawText || '');
  const patternsUteis = [
    /no\s+prazo\s+de\s+(\d+)\s*dias?\s*úteis/i,
    /prazo\s+de\s+(\d+)\s*dias?\s*úteis/i,
    /(?:em|dentro\s+de)\s+(\d+)\s*dias?\s*úteis/i,
    /(\d+)\s*dias?\s*úteis/i,
  ];
  const patternsCorridos = [
    /no\s+prazo\s+de\s+(\d+)\s*dias?\s*(?:corridos|consecutivos)?/i,
    /prazo\s+(?:de\s+)?(?:de\s+)?(\d+)\s*dias?\s*(?:corridos|consecutivos)?/i,
    /prazo\s+(?:de\s+)?(?:de\s+)?(\d+)\s*(?:dia|dias)(?!\s*úteis)/i,
    /(?:em|dentro\s+de)\s+(\d+)\s*(?:dia|dias)(?!\s*úteis)/i,
    /prazo\s+de\s+(\d+)\s*(?:hora|horas)/i,
  ];

  let days = null;
  let label = null;
  let diasUteis = false;
  let horas = false;

  for (const re of patternsUteis) {
    const m = t.match(re);
    if (m && m[1]) {
      const n = parseInt(m[1], 10);
      if (!Number.isNaN(n) && n >= 0 && n < 5000) {
        days = n;
        diasUteis = true;
        label = `Prazo declarado no texto: ${n} dia(s) úteis (data limite não calculada automaticamente)`;
        break;
      }
    }
  }

  if (days == null) {
    for (const re of patternsCorridos) {
      const m = t.match(re);
      if (m && m[1]) {
        const n = parseInt(m[1], 10);
        if (!Number.isNaN(n)) {
          if (/hora/i.test(re.source)) {
            horas = true;
            days = Math.max(1, Math.ceil(n / 24));
            label = `Prazo declarado: ${n} hora(s) (≈ ${days} dia(s) corridos para referência)`;
          } else if (n >= 0 && n < 5000) {
            days = n;
            label = `Prazo declarado no texto: ${n} dia(s) corridos`;
          }
          break;
        }
      }
    }
  }

  let prazoIso = null;
  if (days != null && days >= 0 && days < 3650 && !diasUteis) {
    const d = new Date();
    d.setHours(12, 0, 0, 0);
    d.setDate(d.getDate() + days);
    prazoIso = d.toISOString().slice(0, 10);
  }

  return { days, prazoIso, label, diasUteis: !!diasUteis, horas: !!horas };
}

/** Data de publicação no texto do PDF (quando detectável) — base para prazo final = publicação + N dias corridos */
function extractDataPublicacaoDO(rawText) {
  const t = String(rawText || '');
  const patterns = [
    /(?:publicad[oa]|publica[cç][aã]o)\s*(?:em|no\s+dia|:)?\s*(\d{1,2})[\/\.\-](\d{1,2})[\/\.\-](\d{2,4})\b/i,
    /(\d{1,2})[\/\.\-](\d{1,2})[\/\.\-](\d{4})\b.{0,50}(?:di[aá]rio\s+oficial|d\.?\s*o\.?\s*e|edi[cç][aã]o)/i,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (!m) continue;
    const d = parseInt(m[1], 10);
    const mo = parseInt(m[2], 10);
    let y = parseInt(m[3], 10);
    if (y < 100) y += 2000;
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      const dt = new Date(y, mo - 1, d);
      if (!Number.isNaN(dt.getTime())) return dt.toISOString().slice(0, 10);
    }
  }
  return null;
}

/** Tenta obter secretaria mencionada no próprio texto do PDF */
function extractSecretariaFromText(rawText) {
  const t = String(rawText || '');
  const m =
    t.match(/Secretaria\s+Municipal\s+de\s+([^\n\r.]{2,80})/i) ||
    t.match(/Secretaria\s+de\s+([^\n\r.]{2,80})/i) ||
    t.match(/Secretaria\s+Municipal\s+([^\n\r.]{2,80})/i);
  if (m && m[1]) return m[1].replace(/\s+/g, ' ').trim();
  return null;
}

function urgencyFromDays(days) {
  if (days == null) return { urgencia: 'Média', urg: 'MÉDIA' };
  if (days <= 7) return { urgencia: 'Alta', urg: 'ALTA' };
  if (days <= 30) return { urgencia: 'Média', urg: 'MÉDIA' };
  return { urgencia: 'Baixa', urg: 'BAIXA' };
}

/** Gravidade inferida do texto do PDF (palavras-chave — complementa IA e urgência) */
function detectGravidadePdf(rawText) {
  const t = String(rawText || '').toLowerCase();
  const sinais = [];
  let score = 0;
  const rules = [
    [/improbidade|lavagem de dinheiro|organiza[cç][aã]o criminosa|crime contra a administra[cç][aã]o/i, 'Conduta grave / improbidade', 4],
    [/gaeco|opera[cç][aã]o.{0,12}policial|busca e apreens[aã]o|mandado de busca/i, 'GAECO / diligência', 4],
    [/a[cç][aã]o.{0,20}judicial|ajuizad|den[uú]ncia.{0,25}criminal|inquerito|inqu[eé]rito/i, 'Ação judicial / inquérito', 3],
    [/multa.{0,50}di[aá]ria|multa.{0,25}por dia/i, 'Multa diária', 3],
    [/prazo.{0,30}24\s*horas|prazo.{0,30}48\s*horas|imediata|urgente|intima[cç][aã]o/i, 'Urgência no texto', 2],
    [/nepotismo|licita[cç][aã]o|fraude|desvio|superfaturamento|cartel/i, 'Tema sensível (licitação / desvio)', 2],
    [/tac|termo de ajustamento|descumprimento/i, 'TAC / descumprimento', 2],
  ];
  for (const [re, label, w] of rules) {
    if (re.test(t)) {
      if (!sinais.includes(label)) sinais.push(label);
      score += w;
    }
  }
  let nivel = 'BAIXA';
  if (score >= 9) nivel = 'CRÍTICA';
  else if (score >= 6) nivel = 'ALTA';
  else if (score >= 3) nivel = 'MÉDIA';
  return { nivel, score, sinais };
}

function stableIdFromPdfUrl(pdfUrl) {
  const canon = normalizeMpmaPdfUrl(pdfUrl) || String(pdfUrl || '').trim();
  const h = crypto.createHash('sha256').update(canon, 'utf8').digest('hex').slice(0, 16);
  return `MP-DIO-${h}`;
}

/**
 * Monta notificação no formato da caixa de entrada — dados derivados do PDF e do URL reais.
 */
/**
 * @param {Array<{nome:string,cargo?:string,origem?:string,setor?:string,departamento?:string,lotacao?:string}>} matchedPeople
 */
function buildDiarioNotification(pdfUrl, matchedPeople, rawText, pdfBinarioSha256) {
  let mpmaSvc;
  try {
    mpmaSvc = require('./mpmaService');
  } catch {
    mpmaSvc = null;
  }
  const secretariasInstit =
    mpmaSvc && mpmaSvc.encontrarSecretarias ? mpmaSvc.encontrarSecretarias(rawText) : [];
  const secretariosDetectadosList =
    mpmaSvc && mpmaSvc.detectarSecretario ? mpmaSvc.detectarSecretario(rawText) : [];
  const secretariasCatalogoNomes = secretariasInstit.map((s) => s.nome).filter(Boolean);
  const secretarioDetectado =
    secretariosDetectadosList.length > 0 ? secretariosDetectadosList.join(' | ') : '';
  const dataDeteccaoContexto = new Date().toISOString();

  const pdfUrlCanon = normalizeMpmaPdfUrl(pdfUrl) || String(pdfUrl || '').trim();
  const file = path.basename(new URL(pdfUrlCanon).pathname) || 'documento.pdf';
  const id = stableIdFromPdfUrl(pdfUrlCanon);
  const textoAssinatura = sha256TextoPdf(rawText);
  const mpmaPdfUrlMd5 = crypto.createHash('md5').update(pdfUrlCanon, 'utf8').digest('hex');
  const pdfBinHash =
    pdfBinarioSha256 && /^[a-f0-9]{64}$/i.test(pdfBinarioSha256)
      ? pdfBinarioSha256.toLowerCase()
      : null;
  const uniq = dedupeMencoes(matchedPeople);
  const namesOnly = uniq.map((p) => p.nome);
  const juridico = classifyDocumentoJuridico(rawText);
  const kindLabel = juridico.rotulo || detectDocumentKind(rawText);
  const titulo = extractSmartTitle(rawText, namesOnly, kindLabel);
  const resumoFallback = extractResumoFromText(rawText);
  const mpmaOcorrenciasNomes = extrairOcorrenciasConfirmadasMpma(rawText, pdfUrlCanon, uniq);
  const resumo =
    mpmaOcorrenciasNomes[0]?.trecho && mpmaOcorrenciasNomes[0].trecho.length >= 80
      ? clampTrechoMpma(mpmaOcorrenciasNomes[0].trecho, 1400)
      : resumoFallback;
  const multaEx = extractMultaInfo(rawText);
  const prazoFull = extractPrazoInfo(rawText);
  const { days, label, diasUteis } = prazoFull;
  const pubIso = extractDataPublicacaoDO(rawText);
  const ingestIso = new Date().toISOString().slice(0, 10);
  let prazoFinalISO = null;
  if (days != null && !diasUteis && days >= 0 && days < 3650) {
    const base = pubIso || ingestIso;
    const d = new Date(base + 'T12:00:00');
    d.setDate(d.getDate() + days);
    prazoFinalISO = d.toISOString().slice(0, 10);
  }
  const orgaoMp = extractOrgaoMP(rawText);
  const riscoFin = computeRiscoFinanceiro(multaEx, prazoFull);
  const secFromPdf = extractSecretariaFromText(rawText);
  let secretaria = 'Não identificada no texto';
  if (secretariasCatalogoNomes.length) {
    secretaria = secretariasCatalogoNomes.join(' · ');
  } else if (secFromPdf) {
    secretaria = secFromPdf.match(/^secretaria/i) ? secFromPdf : `Secretaria: ${secFromPdf}`;
  }
  const { urgencia, urg } = urgencyFromDays(days);
  const gravidadePdf = detectGravidadePdf(rawText);
  const classificacaoRiscoInstitucional = classifyRiscoInstitucionalText(rawText);

  /** Prazo final: data publicação (se houver) ou data de ingestão no sistema + dias corridos do texto; senão sentinela */
  const prazoCampo = prazoFinalISO || '2099-12-31';

  let multaReais = 0;
  if (riscoFin && riscoFin.calculado && riscoFin.totalCentavos != null) {
    multaReais = riscoFin.totalCentavos / 100;
  } else if (multaEx.valorCentavos != null) {
    multaReais = multaEx.valorCentavos / 100;
  }

  const multaFmt = multaEx.valorCentavos != null ? formatBRLFromCentavos(multaEx.valorCentavos) : null;
  const tipoMultaLabel =
    multaEx.tipo === 'diaria' ? 'diária' : multaEx.tipo === 'por_clausula' ? 'por cláusula / infração' : multaEx.tipo === 'unica' ? 'única' : null;

  const mpmaExtracao = {
    documentoTipo: juridico.rotulo,
    documentoCodigo: juridico.codigo,
    orgao: orgaoMp,
    multa:
      multaEx.valorCentavos != null
        ? {
            tipo: multaEx.tipo,
            tipoLabel: tipoMultaLabel,
            valorReais: multaEx.valorCentavos / 100,
            valorFormatado: multaFmt,
            trecho: multaEx.trecho || null,
          }
        : null,
    prazo:
      days != null
        ? {
            dias: days,
            diasUteis: !!diasUteis,
            label: label || null,
            dataPublicacaoISO: pubIso,
            prazoFinalISO: prazoFinalISO || null,
            dataISO: prazoFinalISO || null,
          }
        : null,
    riscoFinanceiro:
      riscoFin && riscoFin.calculado
        ? {
            calculado: true,
            valorReais: riscoFin.totalCentavos / 100,
            valorFormatado: formatBRLFromCentavos(riscoFin.totalCentavos),
            formula: riscoFin.formula,
          }
        : riscoFin && riscoFin.calculado === false
          ? { calculado: false, motivo: riscoFin.motivo }
          : null,
    nomesEnvolvidos: uniq.map((p) => ({
      nome: p.nome,
      cargo: p.cargo || null,
      setor: p.setor || null,
      departamento: p.departamento || null,
      lotacao: p.lotacao || null,
      origemLista: p.origem || null,
    })),
    secretariasInstitucionais: secretariasCatalogoNomes,
    secretariosDetectados: secretariosDetectadosList,
    fragmentoSecretariaRegex: secFromPdf || null,
    dataDeteccaoContextoISO: dataDeteccaoContexto,
  };

  const servidorLinha = uniq
    .slice(0, 6)
    .map((p) => {
      const bits = [p.cargo, p.setor].filter(Boolean);
      return bits.length ? `${p.nome} (${bits.join(' · ')})` : p.nome;
    })
    .join(' · ');
  let servidor = servidorLinha + (uniq.length > 6 ? '…' : '');
  if (!servidor.trim()) {
    if (secretarioDetectado) servidor = `Menção no texto: ${secretarioDetectado.slice(0, 280)}${secretarioDetectado.length > 280 ? '…' : ''}`;
    else if (secretariasCatalogoNomes.length)
      servidor = `Contexto: ${secretariasCatalogoNomes.slice(0, 4).join(' · ')}${secretariasCatalogoNomes.length > 4 ? '…' : ''}`;
    else servidor = 'Sem nome da lista de monitoramento no trecho analisado';
  }

  return {
    id,
    titulo,
    secretaria,
    secretarioDetectado: secretarioDetectado || '',
    mpmaSecretarias: [...secretariasCatalogoNomes],
    servidor,
    mencoesDetalhe: uniq.map((p) => ({
      nome: p.nome,
      cargo: p.cargo || null,
      setor: p.setor || null,
      departamento: p.departamento || null,
      lotacao: p.lotacao || null,
      origemLista: p.origem || null,
    })),
    mpmaExtracao,
    status: urgencia === 'Alta' ? 'urgente' : 'novo',
    urgencia,
    prazo: prazoCampo,
    mpmaPrazoExtraidoDoPdf: !!(prazoFinalISO && prazoCampo !== '2099-12-31'),
    mpmaDataPublicacaoISO: pubIso,
    recebido: new Date().toLocaleString('pt-BR'),
    multa: multaReais,
    descricao: resumo,
    ia: {
      sec: secretaria,
      secretarioDetectado: secretarioDetectado || null,
      tema: titulo.slice(0, 120),
      resumo,
      urg,
      prazo: label || (days != null ? `${days} dia(s)` : 'Não detectado no texto'),
      resp: 'Procurador',
      documentoTipo: juridico.rotulo,
      orgaoMp,
      multaReal: multaFmt
        ? `${multaFmt}${tipoMultaLabel ? ` — multa ${tipoMultaLabel}` : ''}`
        : null,
      prazoReal: label || (days != null ? `${days} dia(s)${diasUteis ? ' úteis' : ' corridos'}` : null),
      riscoEstimado:
        riscoFin && riscoFin.calculado ? formatBRLFromCentavos(riscoFin.totalCentavos) : null,
      riscoFinanceiroFormula: riscoFin && riscoFin.calculado ? riscoFin.formula : null,
    },
    comentarios: [],
    timeline: [
      {
        acao: `PDF oficial: ${file} · URL MD5 ${mpmaPdfUrlMd5.slice(0, 8)}… · binário SHA256 ${pdfBinHash ? pdfBinHash.slice(0, 12) + '…' : '—'} · texto SHA256 ${textoAssinatura.slice(0, 12)}…`,
        hora: new Date().toLocaleString('pt-BR'),
        done: true,
        current: true,
      },
    ],
    viewers: [],
    accessLog: [],
    reenvioEtapa: 0,
    fonte: pdfUrlCanon,
    ofNr: null,
    assinado: false,
    pdfUrl: pdfUrlCanon,
    mpmaTextoSha256: textoAssinatura,
    mpmaPdfUrlMd5: mpmaPdfUrlMd5,
    mpmaPdfBinarioSha256: pdfBinHash,
    mpmaPdfUrlCanonico: pdfUrlCanon,
    origemDiario: true,
    mpmaPrazoDias: days,
    mpmaPrazoLabel: label,
    mpmaPrazoDiasUteis: !!diasUteis,
    gravidadePdf,
    responsavelId: null,
    responsavelNome: null,
    prioridade: false,
    monitoramentoOrigem: 'MPMA',
    alertasInteligencia: [],
    classificacaoRiscoInstitucional,
    mpmaOcorrenciasNomes,
  };
}

/**
 * Primeira carga: todos os PDFs encontrados no site (histórico).
 * Reutiliza a mesma lógica de processamento; PDFs já em `seen` são ignorados pelo caller.
 */
async function carregarHistoricoMPMA() {
  return fetchDiarioPdfLinks();
}

/** Alias explícito para o cron — mesma lista de links */
async function monitorarNovosPDFs() {
  return fetchDiarioPdfLinks();
}

module.exports = {
  DIARIO_URL,
  MONITORED_NAMES,
  LIDERANCA_MPMA_MONITORADA,
  MIN_MPMA_PDF_TEXT_CHARS,
  PALAVRAS_CONTEXTO_NOME,
  detectarOcorrenciasLiderancaMpma,
  extrairOcorrenciasConfirmadasMpma,
  clampTrechoMpma,
  norm,
  findMatchedNames,
  dedupeMencoes,
  fetchDiarioPdfLinks,
  carregarHistoricoMPMA,
  monitorarNovosPDFs,
  downloadAndParsePdf,
  buildDiarioNotification,
  extractResumoFromText,
  extractSmartTitle,
  detectDocumentKind,
  extractMultaInfo,
  extractPrazoInfo,
  extractDataPublicacaoDO,
  detectGravidadePdf,
  classifyRiscoInstitucionalText,
  classifyDocumentoJuridico,
  extractOrgaoMP,
  computeRiscoFinanceiro,
  formatBRLFromCentavos,
  isAllowedMpmaPdfUrl,
  normalizeMpmaPdfUrl,
  validateMpmaPdfContentForDenuncia,
  sha256TextoPdf,
};
