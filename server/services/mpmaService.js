/**
 * Serviço MPMA — crawler, PDF, normalização, deteção, vistos persistentes, concorrência limitada.
 * Integra com mpmaMonitor.js (URLs canónicas, download fiável). Sem dados fictícios.
 */
const fs = require('fs');
const path = require('path');
const axios = require('axios');
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

function encontrarServidores(texto, servidores) {
  const textoNorm = normalizar(texto);
  if (!servidores || !servidores.length) return [];
  return servidores.filter((s) => {
    const n = normalizar(s.nome || '');
    return n.length >= 4 && textoNorm.includes(n);
  });
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
 * Análise de um PDF (memória). URL canónica MPMA. Só retorna entradas com trecho obtido.
 */
async function processarPDF(pdfUrl, servidores) {
  const canon = mpma.normalizeMpmaPdfUrl(pdfUrl);
  if (!canon) return null;

  const texto = await extrairTextoPDF(canon);
  if (!texto || texto.length < 500) return null;

  const textoNorm = normalizar(texto);
  if (!textoNorm.includes('buriticupu')) return null;

  const encontrados = encontrarServidores(texto, servidores);
  if (!encontrados.length) return null;

  const linhas = encontrados
    .map((p) => {
      const trecho = extrairTrecho(texto, p.nome);
      if (!trecho || trecho.length < 40) return null;
      return {
        nome: p.nome,
        cargo: p.cargo || '',
        setor: p.setor || '',
        trecho,
        pdfUrl: canon,
      };
    })
    .filter(Boolean);

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
        console.log('🚨 [mpmaService] Match (diagnóstico):', canon.slice(0, 80), dados.length, 'pessoa(s)');
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
 * Produção: agenda callback (ex.: runMpmaMonitor) a cada 10 min.
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
  encontrarServidores,
  extrairTrecho,
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
