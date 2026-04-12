/**
 * Serviço MPMA — crawler, PDF, normalização, deteção, vistos persistentes, concorrência limitada.
 * Integra com mpmaMonitor.js (URLs canónicas, download fiável). Sem dados fictícios.
 */
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { axiosProxyOpts } = require('./mpmaHttpAgent');
const pdfParse = require('pdf-parse');
const cron = require('node-cron');
const pLimit = require('p-limit');
const mpma = require('./mpmaMonitor');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
/** Mesmo ficheiro que server/index.js — um único conjunto de PDFs já processados */
const VISTOS_FILE = path.join(DATA_DIR, 'diario-pdfs-processados.json');

const CRAWL_TIMEOUT_MS = Number(process.env.MPMA_CRAWL_TIMEOUT_MS || 120000);
const PDF_DOWNLOAD_TIMEOUT_MS = Number(process.env.MPMA_PDF_DOWNLOAD_MS || 120000);
const DEFAULT_LINK_CONCURRENCY = Math.max(
  1,
  Math.min(8, parseInt(process.env.MPMA_LINK_CONCURRENCY || '3', 10) || 3)
);

let monitorAgendado = false;

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

/**
 * Conjunto de URLs canónicas já vistas (anti-duplicado persistente).
 */
function loadSeenPdfSet() {
  if (!fs.existsSync(VISTOS_FILE)) return new Set();
  try {
    const raw = fs.readFileSync(VISTOS_FILE, 'utf8');
    const arr = JSON.parse(raw);
    const set = new Set();
    if (!Array.isArray(arr)) return set;
    for (const u of arr) {
      if (!u || typeof u !== 'string') continue;
      const c = mpma.normalizeMpmaPdfUrl(u) || u.trim();
      set.add(c);
    }
    return set;
  } catch {
    return new Set();
  }
}

function saveSeenPdfSet(set) {
  ensureDataDir();
  fs.writeFileSync(VISTOS_FILE, JSON.stringify([...set], null, 2), 'utf8');
}

/** Aliases pedidos na especificação */
function carregarVistos() {
  return loadSeenPdfSet();
}

function salvarVistos(vistos) {
  saveSeenPdfSet(vistos instanceof Set ? vistos : new Set(vistos));
}

/**
 * Lista de links PDF (rastreio completo do diário MPMA).
 */
async function buscarLinksMPMA() {
  try {
    const links = await Promise.race([
      mpma.fetchDiarioPdfLinks(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout crawl')), CRAWL_TIMEOUT_MS)),
    ]);
    return Array.isArray(links) ? links : [];
  } catch (err) {
    console.error('[mpmaService] Erro ao buscar MPMA:', err.message);
    return [];
  }
}

/**
 * Extrai texto do PDF remoto (timeout próprio; não mistura buffers entre URLs).
 */
async function extrairTextoPDF(url) {
  const canon = mpma.normalizeMpmaPdfUrl(url) || String(url || '').trim();
  if (!canon) return null;
  try {
    const res = await axios.get(canon, {
      ...axiosProxyOpts(),
      responseType: 'arraybuffer',
      timeout: PDF_DOWNLOAD_TIMEOUT_MS,
      maxRedirects: 5,
      headers: { 'User-Agent': 'PlataformaMP/7.2 (mpmaService)' },
      validateStatus: (s) => s >= 200 && s < 400,
    });
    const buf = Buffer.from(res.data);
    const parsed = await pdfParse(buf);
    const text = parsed.text || '';
    return text;
  } catch (err) {
    console.error('[mpmaService] Erro ao ler PDF:', String(canon).slice(0, 96), err.message);
    return null;
  }
}

function normalizar(texto) {
  return String(texto || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/** Catálogo institucional — Buriticupu / PM; variações normalizadas na deteção. */
const SECRETARIAS_MPMA = [
  {
    nome: 'Secretaria Municipal de Saúde',
    variacoes: ['secretaria de saude', 'semus', 'sec saude'],
  },
  {
    nome: 'Secretaria Municipal de Educação',
    variacoes: ['secretaria de educacao', 'semed', 'sec educacao'],
  },
  {
    nome: 'Secretaria Municipal de Administração',
    variacoes: ['secretaria de administracao', 'sec administracao'],
  },
  {
    nome: 'Secretaria Municipal de Obras',
    variacoes: ['secretaria de obras', 'infraestrutura', 'sec obras'],
  },
  {
    nome: 'Secretaria Municipal de Assistência Social',
    variacoes: ['assistencia social', 'semass', 'sec assistencia'],
  },
  {
    nome: 'Secretaria Municipal de Finanças',
    variacoes: ['financas', 'sec financas'],
  },
  {
    nome: 'Secretaria Municipal de Agricultura',
    variacoes: ['agricultura'],
  },
  {
    nome: 'Secretaria Municipal de Meio Ambiente',
    variacoes: ['meio ambiente'],
  },
  {
    nome: 'Secretaria Municipal de Cultura',
    variacoes: ['cultura'],
  },
  {
    nome: 'Secretaria Municipal de Esporte e Lazer',
    variacoes: ['esporte', 'lazer'],
  },
  {
    nome: 'Gabinete do Prefeito',
    variacoes: ['gabinete', 'prefeito'],
  },
  {
    nome: 'Procuradoria Geral do Município',
    variacoes: ['procuradoria'],
  },
  {
    nome: 'Controladoria Geral do Município',
    variacoes: ['controladoria'],
  },
];

/** Acrónimos / siglas: aceite directo no texto normalizado (baixo risco de ruído). */
const VARIACAO_SIGLA_DIRETA = new Set(['semus', 'semed', 'semass']);

/** Para variações curtas ambíguas, exige proximidade lexical institucional. */
const INSTITUICAO_PROX_RE =
  /secretari|secretario|municipal|prefeitur|executivo|buriticupu|prefeita|prefeito|administrac|municipio|camara\s+municipal|semus|semed|semass|procurador|controlador|fazenda|infraestrutura/i;

function variacaoMatchSeguro(textoNorm, vNorm) {
  const v = String(vNorm || '').trim();
  if (v.length < 2) return false;
  if (VARIACAO_SIGLA_DIRETA.has(v)) return textoNorm.includes(v);
  if (v.length >= 12) return textoNorm.includes(v);
  let idx = 0;
  while ((idx = textoNorm.indexOf(v, idx)) !== -1) {
    const win = textoNorm.slice(
      Math.max(0, idx - 140),
      Math.min(textoNorm.length, idx + v.length + 140)
    );
    if (INSTITUICAO_PROX_RE.test(win)) return true;
    idx += 1;
  }
  return false;
}

/**
 * @returns {Array<{ nome: string, variacaoUsada: string }>}
 */
function encontrarSecretarias(texto) {
  const textoNorm = normalizar(texto);
  const out = [];
  const seen = new Set();
  for (const sec of SECRETARIAS_MPMA) {
    for (const raw of sec.variacoes || []) {
      const vn = normalizar(raw);
      if (!vn) continue;
      if (!variacaoMatchSeguro(textoNorm, vn)) continue;
      const key = normalizar(sec.nome);
      if (seen.has(key)) break;
      seen.add(key);
      out.push({ nome: sec.nome, variacaoUsada: raw });
      break;
    }
  }
  return out;
}

/**
 * Frases do tipo "Secretário Municipal de X" no texto bruto (sem inventar nomes próprios).
 * @returns {string[]}
 */
function detectarSecretario(texto) {
  const t = String(texto || '');
  const re = /secret[aá]rio\s+(?:municipal\s+)?de\s+([^\n\r.;]{3,120})/gi;
  const found = [];
  const seen = new Set();
  let m;
  while ((m = re.exec(t)) !== null) {
    const frag = (m[0] || '').replace(/\s+/g, ' ').trim();
    if (frag.length < 12) continue;
    const k = normalizar(frag);
    if (seen.has(k)) continue;
    seen.add(k);
    found.push(frag);
    if (found.length >= 25) break;
  }
  return found;
}

/**
 * Servidor: prioriza nome completo — exige ≥2 tokens OU nome normalizado longo (reduz falso positivo).
 */
function encontrarServidores(texto, servidores) {
  const textoNorm = normalizar(texto);
  if (!servidores || !servidores.length) return [];
  return servidores.filter((s) => {
    const raw = String(s.nome || '').trim();
    const n = normalizar(raw);
    if (n.length < 4) return false;
    const partes = raw.split(/\s+/).filter(Boolean);
    const nomeCompletoOuLongo = partes.length >= 2 || n.length >= 14;
    if (!nomeCompletoOuLongo) return false;
    if (!textoNorm.includes(n)) return false;
    return true;
  });
}

function extrairTrechoPorPalavrasChave(texto, chavesNorm) {
  const palavras = String(texto || '')
    .split(/\s+/)
    .filter(Boolean);
  if (!palavras.length) return null;
  const textoNorm = normalizar(texto);
  let index = -1;
  for (const chRaw of chavesNorm) {
    const ch = String(chRaw || '').trim();
    if (ch.length < 4) continue;
    if (textoNorm.includes(ch)) {
      const needle = ch.split(/\s+/)[0];
      if (needle.length < 3) continue;
      const i = palavras.findIndex((p) => normalizar(p).includes(needle));
      if (i !== -1) {
        index = i;
        break;
      }
    }
  }
  if (index === -1) return null;
  const inicio = Math.max(0, index - 200);
  const fim = Math.min(palavras.length, index + 200);
  return palavras.slice(inicio, fim).join(' ');
}

function extrairTrecho(texto, nome) {
  const palavras = String(texto || '').split(/\s+/).filter(Boolean);
  if (!palavras.length) return null;
  const partesNome = String(nome || '').trim().split(/\s+/).filter(Boolean);
  const nomeBase = partesNome[0] || '';
  if (nomeBase.length < 2) return null;
  const index = palavras.findIndex((p) => normalizar(p).includes(normalizar(nomeBase)));
  if (index === -1) return null;
  const inicio = Math.max(0, index - 200);
  const fim = Math.min(palavras.length, index + 200);
  return palavras.slice(inicio, fim).join(' ');
}

/**
 * Análise de um PDF (memória). URL canónica MPMA.
 * Válido: Buriticupu + (servidor na lista OU secretaria do catálogo OU menção "secretário … de …").
 * Cada linha relaciona contexto institucional (secretarias[], secretário) com trecho real.
 */
async function processarPDF(pdfUrl, servidores) {
  const canon = mpma.normalizeMpmaPdfUrl(pdfUrl);
  if (!canon) return null;

  const texto = await extrairTextoPDF(canon);
  if (!texto || texto.length < 500) return null;

  const textoNorm = normalizar(texto);
  if (!textoNorm.includes('buriticupu')) return null;

  const secretariasObjs = encontrarSecretarias(texto);
  const secretariosFrases = detectarSecretario(texto);
  const secretariasNomes = secretariasObjs.map((s) => s.nome);
  const secretarioDetectadoGlobal =
    secretariosFrases.length > 0 ? secretariosFrases.join(' | ') : '';
  const dataDeteccao = new Date().toISOString();

  const encontrados = encontrarServidores(texto, servidores || []);
  const temServidor = encontrados.length > 0;
  const temSecretaria = secretariasNomes.length > 0;
  const temSecretario = secretariosFrases.length > 0;

  if (!temServidor && !temSecretaria && !temSecretario) return null;

  const baseInstit = {
    secretaria: secretariasNomes[0] || '',
    secretarias: [...secretariasNomes],
    secretarioDetectado: secretarioDetectadoGlobal,
    pdfUrl: canon,
    dataDeteccao,
  };

  const linhas = [];

  if (temServidor) {
    for (const p of encontrados) {
      const trecho = extrairTrecho(texto, p.nome);
      if (!trecho || trecho.length < 40) continue;
      linhas.push({
        nome: p.nome,
        cargo: p.cargo || '',
        setor: p.setor || '',
        ...baseInstit,
        trecho,
      });
    }
  }

  if (!linhas.length && (temSecretaria || temSecretario)) {
    const chaves = [
      ...secretariasObjs.map((o) => normalizar(o.variacaoUsada || '').slice(0, 24)),
      ...secretariosFrases.map((f) => normalizar(f).slice(0, 30)),
    ].filter(Boolean);
    const trechoCtx = extrairTrechoPorPalavrasChave(texto, chaves) || extrairTrecho(texto, 'Secretaria');
    if (trechoCtx && trechoCtx.length >= 40) {
      linhas.push({
        nome: '',
        cargo: '',
        setor: '',
        ...baseInstit,
        trecho: trechoCtx,
      });
    }
  }

  if (secretariasNomes.length || secretarioDetectadoGlobal) {
    console.log('[mpmaService] Contexto institucional:', {
      pdf: String(canon).slice(0, 72),
      secretarias: secretariasNomes,
      secretarioFrases: secretariosFrases.length,
    });
  }

  return linhas.length ? linhas : null;
}

/**
 * Processa links com limite de concorrência (não bloqueia o event loop indefinidamente).
 * @param {string[]} links
 * @param {number} concurrency
 * @param {(link: string) => Promise<void>} worker
 */
async function processarComLimite(links, concurrency, worker) {
  const limit = pLimit(Math.max(1, concurrency));
  const unique = [...new Set(links.map((u) => mpma.normalizeMpmaPdfUrl(u) || String(u).trim()).filter(Boolean))];
  await Promise.all(unique.map((link) => limit(() => worker(link))));
}

/**
 * Varredura opcional: processa PDFs novos, marca vistos só quando há match (não grava notificações).
 * Útil para diagnóstico ou extensão futura. A persistência oficial continua em runMpmaMonitor (index.js).
 */
async function rodarVarreduraDiagnostico(servidores, options = {}) {
  const conc = options.concurrency ?? DEFAULT_LINK_CONCURRENCY;
  const vistos = options.vistos instanceof Set ? options.vistos : loadSeenPdfSet();
  const links = await buscarLinksMPMA();
  const limit = pLimit(conc);

  const tarefas = links.map((link) =>
    limit(async () => {
      const canon = mpma.normalizeMpmaPdfUrl(link) || String(link).trim();
      if (!canon || !canon.includes('http')) return;
      if (vistos.has(canon)) return;
      let dados;
      try {
        dados = await processarPDF(canon, servidores);
      } catch (e) {
        console.warn('[mpmaService] processarPDF:', canon.slice(0, 80), e.message);
        return;
      }
      if (dados && dados.length > 0) {
        const s0 = dados[0] || {};
        console.log('🚨 [mpmaService] Match (diagnóstico):', canon.slice(0, 80), dados.length, 'linha(s)', {
          secretarias: s0.secretarias || [],
          temSecretario: !!(s0.secretarioDetectado && String(s0.secretarioDetectado).trim()),
        });
        vistos.add(canon);
        saveSeenPdfSet(vistos);
        if (typeof options.onMatch === 'function') {
          try {
            await options.onMatch(dados, canon);
          } catch (e) {
            console.error('[mpmaService] onMatch:', e.message);
          }
        }
      }
    })
  );

  await Promise.all(tarefas);
}

/**
 * Produção: o agendamento a cada 10 min é feito por `server/crawlerMPMA.js` (scheduleMpmaProductionMonitor).
 * Esta função mantém o modo diagnóstico com array e o modo legado por callback (testes / integrações antigas).
 * Modo array: `iniciarMonitoramento(servidores)` agenda só varredura diagnóstica (sem notificações) — evite em conjunto com runMpmaMonitor.
 */
function iniciarMonitoramento(primeiro, segundo) {
  if (monitorAgendado) return;

  if (typeof primeiro === 'function') {
    monitorAgendado = true;
    cron.schedule('*/10 * * * *', () => {
      console.log('🔍 Buscando denúncias MPMA...');
      Promise.resolve(primeiro()).catch((e) => console.error('[MPMA]', e.message));
    });
    return;
  }

  if (Array.isArray(primeiro)) {
    const servidores = primeiro;
    const opts = typeof segundo === 'object' && segundo !== null ? segundo : {};
    monitorAgendado = true;
    console.warn(
      '[mpmaService] Modo array: varredura diagnóstica a cada 10 min (não cria notificações). Para produção use iniciarMonitoramento(() => runMpmaMonitor()).'
    );
    cron.schedule('*/10 * * * *', async () => {
      console.log('🔍 Buscando denúncias MPMA (diagnóstico + p-limit)...');
      try {
        await rodarVarreduraDiagnostico(servidores, {
          concurrency: opts.concurrency ?? DEFAULT_LINK_CONCURRENCY,
          onMatch: opts.onMatch,
        });
      } catch (e) {
        console.error('[MPMA]', e.message);
      }
    });
    return;
  }

  console.warn(
    '[mpmaService] Use iniciarMonitoramento(() => runMpmaMonitor()) ou carregarServidores() + modo diagnóstico com array.'
  );
}

module.exports = {
  buscarLinksMPMA,
  extrairTextoPDF,
  normalizar,
  SECRETARIAS_MPMA,
  encontrarSecretarias,
  detectarSecretario,
  encontrarServidores,
  extrairTrecho,
  extrairTrechoPorPalavrasChave,
  processarPDF,
  processarComLimite,
  rodarVarreduraDiagnostico,
  loadSeenPdfSet,
  saveSeenPdfSet,
  carregarVistos,
  salvarVistos,
  iniciarMonitoramento,
  VISTOS_FILE,
  DEFAULT_LINK_CONCURRENCY,
};
