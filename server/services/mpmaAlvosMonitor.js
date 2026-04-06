/**
 * Monitor de alvos fixos — cúpula Prefeitura de Buriticupu no texto do Diário MPMA.
 * Persistência dedicada (não confundir com data/notificacoes.json = caixa de entrada).
 */
const fs = require('fs');
const path = require('path');
const mpmaMonitor = require('./mpmaMonitor');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const DATA_DIR = path.join(PROJECT_ROOT, 'data');
/** Log de detecções nome + urgência + PDF (lista fixa; separado da inbox principal). */
const DETECOES_FILE = path.join(DATA_DIR, 'mpma-notificacoes-alvos.json');

const ALVOS_MONITORAMENTO = [
  'JOAO CARLOS TEIXEIRA DA SILVA',
  'AFONSO BARROS BATISTA',
  'WHESLEY NUNES DO NASCIMENTO',
  'VANDECLEBER FREITAS SILVA',
  'MARIA CELIONEIDE DA LUZ',
  'DENIS ARAUJO DA SILVA',
  'CLODILTON SOUSA BONFIM',
  'CHRYSTIANE PIANCO LIMA',
  'LUCAS RAFAEL DA CONCEICAO PEREIRA',
  'VERA LUCIA SANTOS COSTA',
  'THIAGO FELIPE COSTA SOUSA',
  'FRANK ERON NUNES ARAUJO',
  'ÁUREA CRISTINA COSTA FLOR',
  'EUZILENE GONCALVES LOPES DA SILVA',
  'MATEUS NOBRE DA SILVA',
  'WILLAS DE MELO SOUSA',
  'MARCOS ALMEIDA LIMA',
  'THIAGO SILVA BRITO',
  'MAURICIO CRUZ MARINHO',
];

const TERMOS_ALERTA = [
  'NEPOTISMO',
  'IMPROBIDADE',
  'IMPROBIDADE ADMINISTRATIVA',
  'INQUÉRITO CIVIL',
  'DANO AO ERÁRIO',
  'AÇÃO CIVIL PÚBLICA',
  'RECOMENDAÇÃO MPMA',
];

const MAX_REGISTOS = 2500;

function fold(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase();
}

const cargoByNomeFold = new Map();
const nomeCanonicoByFold = new Map();
for (const row of mpmaMonitor.LIDERANCA_MPMA_MONITORADA || []) {
  const k = fold(row.nomeCompleto);
  cargoByNomeFold.set(k, String(row.cargo || '').trim());
  nomeCanonicoByFold.set(k, String(row.nomeCompleto || '').trim());
}

function nomeDisplayCanonico(nomeAlvo) {
  const k = fold(nomeAlvo);
  return nomeCanonicoByFold.get(k) || String(nomeAlvo || '').trim();
}

function cargoParaAlvo(nomeAlvo) {
  return cargoByNomeFold.get(fold(nomeAlvo)) || '';
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

/**
 * @param {string} textoDiario
 * @returns {Promise<Array<{ nome: string, urgente: boolean, data: string, termosUrgencia: string[] }>>}
 */
async function verificarNotificacao(textoDiario) {
  const textoFolded = fold(textoDiario);
  const notificacoes = [];
  const termosFolded = TERMOS_ALERTA.map((t) => ({ raw: t, f: fold(t) }));

  for (const nome of ALVOS_MONITORAMENTO) {
    const nFold = fold(nome);
    if (!nFold || !textoFolded.includes(nFold)) continue;

    const termosMatch = [];
    for (const { raw, f } of termosFolded) {
      if (f && textoFolded.includes(f)) termosMatch.push(raw);
    }
    const urgente = termosMatch.length > 0;

    console.log(`[ALERTA] Nome encontrado: ${nomeDisplayCanonico(nome)} | Urgente: ${urgente}`);

    notificacoes.push({
      nome: nomeDisplayCanonico(nome),
      urgente,
      data: new Date().toISOString(),
      termosUrgencia: termosMatch,
    });
  }

  return notificacoes;
}

function lerDeteccoes() {
  ensureDataDir();
  if (!fs.existsSync(DETECOES_FILE)) return [];
  try {
    const dados = JSON.parse(fs.readFileSync(DETECOES_FILE, 'utf8'));
    return Array.isArray(dados) ? dados : [];
  } catch {
    return [];
  }
}

/**
 * Grava deteção se não existir duplicado (mesmo PDF + mesmo nome).
 * @param {object} nova — { nome, urgente, data?, pdfUrl?, textoSha256?, termosUrgencia? }
 * @returns {boolean} true se gravou
 */
function salvarNotificacao(nova) {
  if (!nova || !String(nova.nome || '').trim()) return false;
  ensureDataDir();

  let dados = lerDeteccoes();

  const nomeKey = fold(nova.nome);
  const pdfUrl = String(nova.pdfUrl || '').trim();
  const textoSha = String(nova.textoSha256 || '').trim();

  const duplicado = dados.some((e) => {
    if (fold(e.nome) !== nomeKey) return false;
    if (pdfUrl && String(e.pdfUrl || '') === pdfUrl) return true;
    if (textoSha && textoSha.length >= 16 && String(e.textoSha256 || '') === textoSha) return true;
    return false;
  });
  if (duplicado) return false;

  const registo = {
    nome: String(nova.nome).trim(),
    urgente: !!nova.urgente,
    data: nova.data ? String(nova.data) : new Date().toISOString(),
    pdfUrl: pdfUrl || null,
    textoSha256: textoSha || null,
    termosUrgencia: Array.isArray(nova.termosUrgencia) ? nova.termosUrgencia : [],
  };

  dados.push(registo);
  if (dados.length > MAX_REGISTOS) dados = dados.slice(-MAX_REGISTOS);

  fs.writeFileSync(DETECOES_FILE, JSON.stringify(dados, null, 2), 'utf8');
  return true;
}

/** Entradas { nome, cargo, origem } para cruzamento MPMA (lista oficial fixa). */
function getListaEntradasParaMpma() {
  return ALVOS_MONITORAMENTO.map((n) => ({
    nome: nomeDisplayCanonico(n),
    cargo: cargoParaAlvo(n),
    origem: 'Lista fixa — cúpula Buriticupu',
  }));
}

module.exports = {
  ALVOS_MONITORAMENTO,
  TERMOS_ALERTA,
  DETECOES_FILE,
  verificarNotificacao,
  salvarNotificacao,
  lerDeteccoes,
  getListaEntradasParaMpma,
  fold,
};
