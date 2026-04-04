/**
 * Servidores a partir do Excel Sisponto (dados reais do ficheiro — sem invenção).
 * Colunas esperadas: NOME, NOME_CARGO, NOME_SETOR, NOME_DEPARTAMENTO, NOME_LOTACAO.
 */
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const DEFAULT_FILENAME = 'servidores-sisponto.xlsx';

let excelRows = [];
let excelLoaded = false;
let excelSourcePath = '';
let excelLastError = null;
let excelLinhasBrutas = 0;

function normKey(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function toStr(v) {
  if (v == null || v === '') return '';
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return String(v).replace(/\s+/g, ' ').trim();
}

/**
 * Lê o Excel e preenche a lista em memória. Idempotente após primeira carga (reiniciar o servidor para recarregar).
 */
function loadExcelServidores() {
  excelLastError = null;
  const envPath = process.env.SERVIDORES_XLSX_PATH && String(process.env.SERVIDORES_XLSX_PATH).trim();
  const filePath = envPath ? path.resolve(envPath) : path.join(DATA_DIR, DEFAULT_FILENAME);
  excelSourcePath = filePath;

  if (!fs.existsSync(filePath)) {
    excelRows = [];
    excelLinhasBrutas = 0;
    excelLoaded = true;
    excelLastError = `Ficheiro Excel não encontrado: ${filePath}`;
    console.warn('[servidoresService]', excelLastError);
    return excelRows;
  }

  try {
    const wb = XLSX.readFile(filePath, { cellDates: false, raw: false });
    const sheetName = wb.SheetNames[0];
    if (!sheetName) {
      throw new Error('Workbook sem folhas');
    }
    const sheet = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });
    excelLinhasBrutas = rows.length;

    const byNome = new Map();
    for (const row of rows) {
      const nome = toStr(row.NOME);
      if (nome.length < 4) continue;
      const sit = toStr(row.SITUACAO).toLowerCase();
      if (sit && sit !== 'ativo') continue;
      const dem = toStr(row.DATA_DEMISSAO);
      if (dem) continue;

      const k = normKey(nome);
      if (!k) continue;

      const rec = {
        nome,
        cargo: toStr(row.NOME_CARGO),
        setor: toStr(row.NOME_SETOR),
        departamento: toStr(row.NOME_DEPARTAMENTO),
        lotacao: toStr(row.NOME_LOTACAO),
        origem: 'Excel Sisponto',
      };

      if (!byNome.has(k)) {
        byNome.set(k, rec);
      } else {
        const cur = byNome.get(k);
        if (!cur.cargo && rec.cargo) cur.cargo = rec.cargo;
        if (!cur.setor && rec.setor) cur.setor = rec.setor;
        if (!cur.departamento && rec.departamento) cur.departamento = rec.departamento;
        if (!cur.lotacao && rec.lotacao) cur.lotacao = rec.lotacao;
      }
    }

    excelRows = [...byNome.values()];
    excelLoaded = true;
    console.log(
      '[servidoresService] Excel:',
      excelRows.length,
      'servidores ativos (únicos) de',
      excelLinhasBrutas,
      'linhas —',
      path.basename(filePath)
    );
    return excelRows;
  } catch (e) {
    excelLastError = e.message || String(e);
    excelRows = [];
    excelLoaded = true;
    console.error('[servidoresService] Erro ao ler Excel:', excelLastError);
    return excelRows;
  }
}

function ensureLoaded() {
  if (!excelLoaded) loadExcelServidores();
}

function getServidoresExcel() {
  ensureLoaded();
  return excelRows;
}

function getExcelMeta() {
  ensureLoaded();
  return {
    excelPath: excelSourcePath,
    excelTotal: excelRows.length,
    excelLinhasArquivo: excelLinhasBrutas,
    excelErro: excelLastError,
  };
}

/** Carrega o Excel e devolve as linhas (alias pedido para integração externa). */
function carregarServidores() {
  loadExcelServidores();
  return getServidoresExcel();
}

module.exports = {
  loadExcelServidores,
  carregarServidores,
  ensureLoaded,
  getServidoresExcel,
  getExcelMeta,
  DEFAULT_FILENAME,
};
