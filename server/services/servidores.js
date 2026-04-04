/**
 * Lista nominal de servidores — Prefeitura de Buriticupu/MA
 * Crawl: servidoresCrawler.js → site oficial.
 * Cache em data/servidores-nominal.json + cópia em memória.
 */
const fs = require('fs');
const path = require('path');
const servidoresCrawler = require('./servidoresCrawler');
const servidoresService = require('./servidoresService');

const NOMINAL_URL = servidoresCrawler.NOMINAL_URL;
const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const CACHE_FILE = path.join(DATA_DIR, 'servidores-nominal.json');
/** Nomeações / exonerações inferidas a partir de PDFs do DOM (texto real) */
const OVERLAY_DOM_FILE = path.join(DATA_DIR, 'secretarios-overlay-dom.json');

/** Nomes extras da lista MPMA (grafias alternativas) — unidos após o scraping */
let legacyNomes = [];

function norm(s) {
  return String(s)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

/**
 * @param {string[]} names - identificadores legados MPMA (opcional)
 */
function setLegacyMonitoredNames(names) {
  legacyNomes = Array.isArray(names) ? names.filter(Boolean).map(String) : [];
}

function parseLiderancaFromEnv() {
  const out = [];
  const pref = process.env.PREFEITO_NOME && String(process.env.PREFEITO_NOME).trim();
  if (pref) {
    out.push({
      nome: pref,
      cargo: (process.env.PREFEITO_CARGO && String(process.env.PREFEITO_CARGO).trim()) || 'Prefeito(a) Municipal',
      origem: 'Cadastro (.env)',
    });
  }
  const raw = process.env.SECRETARIOS_JSON;
  if (raw) {
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        for (const x of arr) {
          if (x && x.nome) {
            out.push({
              nome: String(x.nome).trim(),
              cargo: String(x.cargo || 'Secretário(a)').trim(),
              origem: 'Cadastro (.env)',
            });
          }
        }
      }
    } catch {
      console.warn('[servidores] SECRETARIOS_JSON inválido — ignorado.');
    }
  }
  return out;
}

/**
 * Junta listas e remove duplicados por nome; preserva cargo, setor, lotação e origem.
 */
function dedupeByNome(list) {
  const m = new Map();
  for (const x of list) {
    const k = norm(x.nome);
    if (!k || k.length < 3) continue;
    const nome = String(x.nome || '').trim();
    const cargo = String(x.cargo || '').trim();
    const origem = x.origem != null ? String(x.origem).trim() : '';
    const setor = x.setor != null ? String(x.setor).trim() : '';
    const departamento = x.departamento != null ? String(x.departamento).trim() : '';
    const lotacao = x.lotacao != null ? String(x.lotacao).trim() : '';
    if (!m.has(k)) {
      m.set(k, { nome, cargo, origem, setor, departamento, lotacao });
    } else {
      const cur = m.get(k);
      if (!cur.cargo && cargo) cur.cargo = cargo;
      if (!cur.origem && origem) cur.origem = origem;
      if (!cur.setor && setor) cur.setor = setor;
      if (!cur.departamento && departamento) cur.departamento = departamento;
      if (!cur.lotacao && lotacao) cur.lotacao = lotacao;
    }
  }
  return [...m.values()];
}

let memoria = [];
/** Linhas derivadas de atos publicados no DOM (PDF) */
let overlayDomRows = [];
let ultimaAtualizacao = null;
let ultimoErro = null;

function loadOverlayDomFromDisk() {
  try {
    if (!fs.existsSync(OVERLAY_DOM_FILE)) {
      overlayDomRows = [];
      return;
    }
    const j = JSON.parse(fs.readFileSync(OVERLAY_DOM_FILE, 'utf8'));
    overlayDomRows = Array.isArray(j.secretarios)
      ? j.secretarios
          .filter((x) => x && String(x.nome || '').trim().length > 3)
          .map((x) => ({
            nome: String(x.nome).trim(),
            cargo: String(x.cargo || '').trim(),
            origem: x.origem || 'DOM Buriticupu',
          }))
      : [];
  } catch (e) {
    console.warn('[servidores] Overlay DOM ilegível:', e.message);
    overlayDomRows = [];
  }
}

function saveOverlayDom() {
  ensureDataDir();
  fs.writeFileSync(
    OVERLAY_DOM_FILE,
    JSON.stringify(
      {
        atualizadoEm: new Date().toISOString(),
        fonte: 'DOM Buriticupu — texto extraído de PDF',
        total: overlayDomRows.length,
        secretarios: overlayDomRows,
      },
      null,
      2
    ),
    'utf8'
  );
}

/**
 * Regista nomeação ou exoneração detetada no texto do diário municipal (dados reais do PDF).
 * @param {{ tipo: 'nomeacao'|'exoneracao', nome: string, cargo?: string }} ato
 */
function applyDomAto(ato) {
  if (!ato || !ato.nome) return;
  const nome = String(ato.nome).trim();
  if (nome.length < 4) return;
  const k = norm(nome);
  if (ato.tipo === 'exoneracao') {
    const before = overlayDomRows.length;
    overlayDomRows = overlayDomRows.filter((x) => norm(x.nome) !== k);
    if (overlayDomRows.length !== before) {
      saveOverlayDom();
      console.log('[servidores] DOM: exoneração — atualizado overlay:', nome);
    }
    return;
  }
  if (ato.tipo === 'nomeacao') {
    const cargo = String(ato.cargo || 'Conforme ato no DOM').trim();
    const idx = overlayDomRows.findIndex((x) => norm(x.nome) === k);
    const row = { nome, cargo, origem: 'DOM Buriticupu' };
    if (idx >= 0) overlayDomRows[idx] = row;
    else overlayDomRows.push(row);
    saveOverlayDom();
    console.log('[servidores] DOM: nomeação — overlay atualizado:', nome);
  }
}

function loadCacheFromDisk() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const j = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      if (Array.isArray(j.servidores) && j.servidores.length) {
        memoria = j.servidores.map((s) => ({
          nome: String(s.nome || '').trim(),
          cargo: String(s.cargo || '').trim(),
          origem: s.origem ? String(s.origem).trim() : servidoresCrawler.ORIGEM_PREFEITURA,
        }));
        ultimaAtualizacao = j.atualizadoEm || null;
      }
    }
  } catch (e) {
    console.warn('[servidores] Cache inválido ou ilegível:', e.message);
  }
  loadOverlayDomFromDisk();
}

function saveCache(servidores) {
  ensureDataDir();
  const payload = {
    atualizadoEm: new Date().toISOString(),
    fonte: NOMINAL_URL,
    origemRegistos: servidoresCrawler.ORIGEM_PREFEITURA,
    total: servidores.length,
    servidores,
  };
  fs.writeFileSync(CACHE_FILE, JSON.stringify(payload, null, 2), 'utf8');
  memoria = servidores;
  ultimaAtualizacao = payload.atualizadoEm;
}

/**
 * Baixa a página nominal (servidoresCrawler) e atualiza memória + JSON.
 */
async function refreshServidoresNominal() {
  ultimoErro = null;
  try {
    const limpo = await servidoresCrawler.fetchServidoresNominal();
    saveCache(limpo);
    ultimoErro = null;
    console.log('[servidores] Lista nominal atualizada:', limpo.length, 'servidores (site oficial)');
    return limpo;
  } catch (e) {
    ultimoErro = e.message || String(e);
    throw e;
  }
}

function buildListaCompleta() {
  servidoresService.ensureLoaded();
  const base = dedupeByNome([
    ...servidoresService.getServidoresExcel(),
    ...(memoria || []),
    ...parseLiderancaFromEnv(),
    ...overlayDomRows,
  ]);
  const legacyRows = legacyNomes.map((n) => ({
    nome: n,
    cargo: '',
    origem: 'Referência MPMA',
  }));
  return dedupeByNome([...base, ...legacyRows]);
}

/**
 * Lista usada pelo monitor MPMA: Excel Sisponto + site nominal + liderança (.env) + DOM + nomes legados.
 */
function getListaMonitoramento() {
  if (!memoria.length) loadCacheFromDisk();
  servidoresService.ensureLoaded();
  return buildListaCompleta();
}

function getMeta() {
  const ex = servidoresService.getExcelMeta();
  return {
    url: NOMINAL_URL,
    totalMemoria: memoria.length,
    totalOverlayDom: overlayDomRows.length,
    atualizadoEm: ultimaAtualizacao,
    ultimoErro,
    totalMonitoramento: getListaMonitoramento().length,
    excel: ex,
  };
}

module.exports = {
  NOMINAL_URL,
  setLegacyMonitoredNames,
  refreshServidoresNominal,
  getListaMonitoramento,
  getMeta,
  loadCacheFromDisk,
  parseHtmlTables: servidoresCrawler.parseHtmlTables,
  applyDomAto,
};
