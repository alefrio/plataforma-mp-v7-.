/**
 * Relatórios PMP — preenchimento de template .docx e conversão para PDF (LibreOffice).
 * Template: /templates/RelatorioPMP.docx (placeholders {{data}}, {{hora}}, {{nome}}, …)
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { pathToFileURL } = require('url');
const PizZip = require('pizzip');
const Docxtemplater = require('docxtemplater');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const TEMPLATE_PATH = path.join(PROJECT_ROOT, 'templates', 'RelatorioPMP.docx');
const RELATORIOS_DIR = path.join(PROJECT_ROOT, 'relatorios');

function ensureRelatoriosDir() {
  if (!fs.existsSync(RELATORIOS_DIR)) fs.mkdirSync(RELATORIOS_DIR, { recursive: true });
}

/** Procura pastas LibreOffice 7/24/25… em Program Files (instalações com nome de versão). */
function findSofficeUnderProgramFiles(baseDir) {
  if (!baseDir || !fs.existsSync(baseDir)) return null;
  try {
    const names = fs.readdirSync(baseDir);
    const hits = names.filter((n) => /^LibreOffice/i.test(n));
    hits.sort();
    for (let i = hits.length - 1; i >= 0; i--) {
      const exe = path.join(baseDir, hits[i], 'program', 'soffice.exe');
      if (fs.existsSync(exe)) return exe;
    }
  } catch (_) {
    /* ignorar */
  }
  return null;
}

/** Evita `libreoffice-convert`: o `.finally()` dele pode lançar ENOTEMPTY no Windows e derrubar o Node. */
function findSofficePath() {
  const envPath = (process.env.SOFFICE_PATH || process.env.LIBREOFFICE_PATH || '').trim();
  if (envPath && fs.existsSync(envPath)) return envPath;
  const candidates = [];
  if (process.platform === 'win32') {
    const pf = process.env.PROGRAMFILES || 'C:\\Program Files';
    const pf86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
    const local = process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'Programs', 'LibreOffice', 'program', 'soffice.exe')
      : '';
    if (local && fs.existsSync(local)) return local;
    const scanPf = findSofficeUnderProgramFiles(pf);
    if (scanPf) return scanPf;
    const scan86 = findSofficeUnderProgramFiles(pf86);
    if (scan86) return scan86;
    candidates.push(
      path.join(pf86, 'LibreOffice', 'program', 'soffice.exe'),
      path.join(pf, 'LibreOffice', 'program', 'soffice.exe')
    );
  } else if (process.platform === 'linux') {
    candidates.push(
      '/usr/bin/soffice',
      '/usr/bin/libreoffice',
      '/snap/bin/libreoffice',
      '/opt/libreoffice/program/soffice'
    );
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/LibreOffice.app/Contents/MacOS/soffice');
  }
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

function isValidPdfBuffer(buf) {
  if (!buf || !Buffer.isBuffer(buf) || buf.length < 5) return false;
  return buf.toString('ascii', 0, 5) === '%PDF-';
}

function convertDocxToPdfBuffer(docxBuffer) {
  return new Promise((resolve, reject) => {
    const soffice = findSofficePath();
    if (!soffice) {
      reject(new Error('Could not find soffice binary'));
      return;
    }
    const id = crypto.randomBytes(8).toString('hex');
    const workDir = path.join(os.tmpdir(), `pmp-relatorio-${id}`);
    const userInst = path.join(workDir, 'lo-profile');
    const docxPath = path.join(workDir, 'input.docx');
    const pdfPath = path.join(workDir, 'input.pdf');

    const cleanup = () => {
      try {
        fs.rmSync(workDir, { recursive: true, force: true });
      } catch (_) {
        /* ignorar */
      }
    };

    try {
      fs.mkdirSync(userInst, { recursive: true });
      fs.writeFileSync(docxPath, docxBuffer);
    } catch (e) {
      cleanup();
      reject(e);
      return;
    }

    const userInstUrl = pathToFileURL(userInst).href;
    const args = [
      `-env:UserInstallation=${userInstUrl}`,
      '--headless',
      '--invisible',
      '--norestore',
      '--nologo',
      '--nofirststartwizard',
      '--convert-to',
      'pdf',
      '--outdir',
      workDir,
      docxPath,
    ];

    execFile(soffice, args, { timeout: 120000, windowsHide: true }, (err) => {
      if (err) {
        cleanup();
        reject(err);
        return;
      }
      try {
        let pdfBuffer = null;
        if (fs.existsSync(pdfPath)) {
          pdfBuffer = fs.readFileSync(pdfPath);
        } else {
          const pdfs = fs
            .readdirSync(workDir)
            .filter((f) => f.toLowerCase().endsWith('.pdf'))
            .map((f) => path.join(workDir, f));
          for (const p of pdfs) {
            const b = fs.readFileSync(p);
            if (isValidPdfBuffer(b)) {
              pdfBuffer = b;
              break;
            }
          }
        }
        if (!pdfBuffer || !isValidPdfBuffer(pdfBuffer)) {
          cleanup();
          reject(
            new Error(
              'LibreOffice não gerou um PDF válido (ficheiro ausente ou corrompido). Verifique a instalação do LibreOffice e tente SOFFICE_PATH no .env.'
            )
          );
          return;
        }
        cleanup();
        resolve(pdfBuffer);
      } catch (e) {
        cleanup();
        reject(e);
      }
    });
  });
}

function normTxt(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

/** Caracteres de controlo ilegais em XML 1.0 — quebram o .docx e o PDF gerado pelo LibreOffice. */
function sanitizeForWordXml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
    .replace(/\uFFFE|\uFFFF/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
}

function sanitizePayloadStrings(obj) {
  const keys = [
    'data',
    'hora',
    'nome',
    'cargo',
    'secretaria',
    'trecho',
    'pdfUrl',
    'documentoSigiloso',
    'tituloRelatorio',
    'assinanteNome',
    'assinanteCargo',
    'prefeitura',
    'municipio',
    'orgaoInstitucional',
  ];
  const o = { ...obj };
  for (const k of keys) {
    if (typeof o[k] === 'string') o[k] = sanitizeForWordXml(o[k]);
  }
  if (Array.isArray(o.linhas)) {
    o.linhas = o.linhas.map((row) => ({
      linha: typeof row.linha === 'string' ? sanitizeForWordXml(row.linha) : row.linha,
    }));
  }
  return o;
}

/** Data principal da notificação para filtro de período (recebido pt-BR ou prazo ISO). */
function parseRecebidoBR(s) {
  const m = String(s || '')
    .trim()
    .match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return null;
  const dd = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  const yyyy = parseInt(m[3], 10);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  const d = new Date(yyyy, mm - 1, dd, 12, 0, 0, 0);
  if (d.getFullYear() !== yyyy || d.getMonth() !== mm - 1 || d.getDate() !== dd) return null;
  return d;
}

function dataReferenciaNotificacao(n) {
  const r = parseRecebidoBR(n.recebido);
  if (r) return r;
  const p = String(n.prazo || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(p)) {
    const [y, mo, da] = p.split('-').map((x) => parseInt(x, 10));
    return new Date(y, mo - 1, da, 12, 0, 0, 0);
  }
  return null;
}

function notifNoRecorte(n, inicioStr, fimStr) {
  if (!inicioStr || !fimStr) return true;
  const d = dataReferenciaNotificacao(n);
  if (!d) return true;
  const t0 = new Date(`${inicioStr}T00:00:00`).getTime();
  const t1 = new Date(`${fimStr}T23:59:59.999`).getTime();
  const t = d.getTime();
  return t >= t0 && t <= t1;
}

function displaySecretariaNotif(n) {
  const amb = 'Não identificada no texto';
  let s = String(n.secretaria || '').trim();
  if (s && s !== amb) return s;
  const a = Array.isArray(n.mpmaSecretarias) && n.mpmaSecretarias.length ? n.mpmaSecretarias.filter(Boolean) : null;
  if (a && a.length) return a.join(' · ');
  const ex =
    n.mpmaExtracao && Array.isArray(n.mpmaExtracao.secretariasInstitucionais)
      ? n.mpmaExtracao.secretariasInstitucionais.filter(Boolean)
      : null;
  if (ex && ex.length) return ex.join(' · ');
  const iasec = n.ia && String(n.ia.sec || '').trim();
  if (iasec && iasec !== amb) return iasec;
  return s || amb;
}

function matchesSecretariaFilter(n, filtro) {
  if (!filtro) return true;
  const blob = normTxt(
    [
      displaySecretariaNotif(n),
      Array.isArray(n.mpmaSecretarias) ? n.mpmaSecretarias.join(' ') : '',
      n.mpmaExtracao && Array.isArray(n.mpmaExtracao.secretariasInstitucionais)
        ? n.mpmaExtracao.secretariasInstitucionais.join(' ')
        : '',
      n.secretaria || '',
    ].join(' ')
  );
  return blob.includes(normTxt(filtro));
}

function matchesStatusFilter(n, filtro) {
  if (!filtro) return true;
  if (filtro === 'Urgentes') return n.status === 'urgente';
  if (filtro === 'Em Análise') return n.status === 'analise';
  if (filtro === 'Respondidas') return n.status === 'respondido';
  return true;
}

/** DOCX mínimo com placeholders (se não existir template copiado). */
function buildFallbackDocxBuffer() {
  const zip = new PizZip();
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`
  );
  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`
  );
  zip.file(
    'word/_rels/document.xml.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>'
  );
  const inner = `<w:body>
<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="24"/></w:rPr><w:t>{{documentoSigiloso}}</w:t></w:r></w:p>
<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>{{tituloRelatorio}}</w:t></w:r></w:p>
<w:p><w:r><w:t xml:space="preserve"> </w:t></w:r></w:p>
<w:p><w:r><w:t>{{prefeitura}} · {{municipio}}</w:t></w:r></w:p>
<w:p><w:r><w:t>{{orgaoInstitucional}}</w:t></w:r></w:p>
<w:p><w:r><w:t xml:space="preserve"> </w:t></w:r></w:p>
<w:p><w:r><w:t>Data de geração: {{data}} · Hora: {{hora}}</w:t></w:r></w:p>
<w:p><w:r><w:t>Emitente: {{nome}} — {{cargo}}</w:t></w:r></w:p>
<w:p><w:r><w:t>Secretaria (filtro): {{secretaria}}</w:t></w:r></w:p>
<w:p><w:r><w:t>Referência / URL: {{pdfUrl}}</w:t></w:r></w:p>
<w:p><w:r><w:t xml:space="preserve"> </w:t></w:r></w:p>
<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Conteúdo</w:t></w:r></w:p>
<w:p><w:r><w:t>{{trecho}}</w:t></w:r></w:p>
<w:p><w:r><w:t xml:space="preserve"> </w:t></w:r></w:p>
<w:p><w:r><w:br w:type="page"/></w:r></w:p>
<w:p><w:r><w:t>_____________________________________</w:t></w:r></w:p>
<w:p><w:r><w:t>{{assinanteNome}}</w:t></w:r></w:p>
<w:p><w:r><w:t>{{assinanteCargo}}</w:t></w:r></w:p>
<w:p><w:r><w:t>Data: {{data}} — {{hora}}</w:t></w:r></w:p>
<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>
</w:body>`;
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${inner}</w:document>`
  );
  return zip.generate({ type: 'nodebuffer' });
}

/** True se document.xml contém marcadores {{ (modelo docxtemplater). Word partido em vários <w:t> pode falhar — aí usamos fallback. */
function docxHasPlaceholderSyntax(buf) {
  try {
    const z = new PizZip(buf);
    const xml = z.files['word/document.xml']?.asText();
    if (!xml) return false;
    return /\{\{[^{}]+\}\}/.test(xml) || xml.includes('{{');
  } catch {
    return false;
  }
}

function loadTemplateBuffer() {
  if (fs.existsSync(TEMPLATE_PATH)) {
    const buf = fs.readFileSync(TEMPLATE_PATH);
    if (docxHasPlaceholderSyntax(buf)) return buf;
    console.warn(
      '[relatorioService] O ficheiro templates/RelatorioPMP.docx não contém placeholders {{variável}} legíveis pelo motor. A usar modelo interno com todos os campos.'
    );
    return buildFallbackDocxBuffer();
  }
  return buildFallbackDocxBuffer();
}

/**
 * @param {object} opts
 * @param {{nome:string,cargo?:string}} opts.emitente
 * @param {string} opts.aba - semanal | mensal | produtividade | desempenho
 * @param {string} opts.periodo - dia | semana | mes (só desempenho)
 * @param {string} [opts.secretariaFiltro]
 * @param {string} [opts.statusFiltro]
 * @param {object|null} [opts.desempenho] - só aba desempenho
 * @param {object[]} opts.notificacoes
 * @param {string} [opts.appPublicUrl]
 * @param {string} [opts.periodoLegenda]
 * @param {string} [opts.recorteInicio] - YYYY-MM-DD (semanal/mensal/produtividade)
 * @param {string} [opts.recorteFim] - YYYY-MM-DD
 */
function montarPayloadRelatorioPdf(opts) {
  const {
    emitente,
    aba,
    periodo,
    secretariaFiltro = '',
    statusFiltro = '',
    desempenho,
    notificacoes = [],
    appPublicUrl = '',
    periodoLegenda = '',
    recorteInicio = '',
    recorteFim = '',
  } = opts;

  const agora = new Date();
  const data = agora.toLocaleDateString('pt-BR');
  const hora = agora.toLocaleTimeString('pt-BR');

  const prefeitura = (process.env.RELATORIO_PREFEITURA || 'Prefeitura Municipal de Buriticupu').trim();
  const municipio = (process.env.RELATORIO_MUNICIPIO || 'Buriticupu — MA').trim();
  const orgaoInstitucional = (process.env.RELATORIO_ORGAO || 'Procuradoria Municipal de Buriticupu — MA').trim();

  const assinanteNome = (process.env.RELATORIO_ASSINANTE_NOME || 'Whesley Nunes do Nascimento').trim();
  const assinanteCargo = (process.env.RELATORIO_ASSINANTE_CARGO || 'Procuradoria-Geral do Município').trim();

  const abaLabel = {
    semanal: 'Semanal',
    mensal: 'Mensal',
    produtividade: 'Produtividade',
    desempenho: 'Desempenho por advogado',
  }[aba] || aba;
  const perLabel = { dia: 'Hoje', semana: 'Esta semana', mes: 'Este mês' }[periodo] || periodo;

  let vis = (notificacoes || []).filter((n) => (n.monitoramentoOrigem || 'MPMA') !== 'DOM');
  vis = vis.filter((n) => matchesSecretariaFilter(n, secretariaFiltro));
  vis = vis.filter((n) => matchesStatusFilter(n, statusFiltro));

  const ini = String(recorteInicio || '').trim();
  const fim = String(recorteFim || '').trim();
  if (aba !== 'desempenho' && /^\d{4}-\d{2}-\d{2}$/.test(ini) && /^\d{4}-\d{2}-\d{2}$/.test(fim)) {
    vis = vis.filter((n) => notifNoRecorte(n, ini, fim));
  }

  let tituloRelatorio = `Relatório — ${abaLabel}`;
  if (aba === 'desempenho') {
    tituloRelatorio += ` (${perLabel})`;
  } else if (String(periodoLegenda || '').trim()) {
    tituloRelatorio += ` · ${String(periodoLegenda).trim()}`;
  }

  const linhas = [];
  let trecho = '';

  if (aba === 'desempenho') {
    if (!desempenho) {
      trecho += 'Sem dados de desempenho para o período solicitado.\n';
    } else {
      trecho += `Tipo: exclusivo desempenho por advogado (sem listagem de processos).\n`;
      trecho += `Período analisado: ${new Date(desempenho.inicioISO).toLocaleString('pt-BR')} — ${new Date(desempenho.fimISO).toLocaleString('pt-BR')}\n`;
      const r = desempenho.resumoExecutivo || {};
      trecho += `Resumo denúncias MPMA (total sistema): ${r.totalDenuncias ?? '—'} totais, ${r.urgentes ?? '—'} urgentes, ${r.atrasadas ?? '—'} atrasadas, ${r.respondidas ?? '—'} respondidas.\n`;
      if (desempenho.advogadoDestaque) {
        const d = desempenho.advogadoDestaque;
        trecho += `Advogado destaque: ${d.nome} — eficiência ${d.eficienciaPct}% (${d.respondeu} respostas / ${d.visualizou} visualizações).\n`;
      }
      trecho += '\nQuadro sintético (ordenado por eficiência):\n';
      (desempenho.advogados || []).forEach((u, i) => {
        linhas.push(
          `${i + 1}. ${u.nome} | ${u.role || '—'} | visualizou ${u.visualizou} | respondeu ${u.respondeu} | ignorou ${u.ignorou ?? '—'} | eficiência ${u.eficienciaPct}% | t. médio ${u.tempoMedioRespostaHoras != null ? `${u.tempoMedioRespostaHoras} h` : '—'}`
        );
      });
      if (!linhas.length) linhas.push('Sem linhas de desempenho no período (sem registos de acesso).');
    }
  } else {
    if (ini && fim) {
      trecho += `Recorte temporal: ${ini} a ${fim} (critério: data em «recebido» ou prazo ISO; sem data reconhecida mantém-se no conjunto).\n`;
    }
    if (String(periodoLegenda || '').trim()) {
      trecho += `Referência (interface): ${String(periodoLegenda).trim()}\n`;
    }
    trecho += `Tipo: ${abaLabel} — apenas listagem e resumos desta aba (sem dados de desempenho por advogado).\n`;
    const cnt = {
      novo: vis.filter((n) => n.status === 'novo').length,
      analise: vis.filter((n) => n.status === 'analise').length,
      urgente: vis.filter((n) => n.status === 'urgente').length,
      atrasada: vis.filter((n) => n.status === 'atrasada').length,
      respondido: vis.filter((n) => n.status === 'respondido').length,
    };
    trecho += `Filtros: secretaria "${secretariaFiltro || 'todas'}" · status "${statusFiltro || 'todos'}".\n`;
    trecho += `Totais no recorte: ${vis.length} processo(s) — novo ${cnt.novo}, análise ${cnt.analise}, urgente ${cnt.urgente}, atrasada ${cnt.atrasada}, respondido ${cnt.respondido}.\n`;

    if (aba === 'produtividade') {
      trecho += '\n--- Indicadores de produtividade (mesmo recorte) ---\n';
      const bySec = new Map();
      vis.forEach((n) => {
        const s = displaySecretariaNotif(n);
        if (!bySec.has(s)) bySec.set(s, { tot: 0, resp: 0 });
        const z = bySec.get(s);
        z.tot += 1;
        if (n.status === 'respondido') z.resp += 1;
      });
      [...bySec.entries()]
        .sort((a, b) => b[1].tot - a[1].tot)
        .forEach(([s, z]) => {
          const pct = z.tot ? Math.round((z.resp / z.tot) * 1000) / 10 : 0;
          trecho += `${s}: ${z.resp}/${z.tot} respondidas (${pct}%)\n`;
        });
      const comReenvio = vis.filter((n) => (n.reenvioEtapa || 0) > 0).length;
      trecho += `Processos com reenvio automático (etapa > 0): ${comReenvio}\n`;
    }

    trecho += `\nListagem de processos (máx. 100 linhas):\n`;
    vis.slice(0, 100).forEach((n) => {
      linhas.push(
        `${n.id} | ${String(n.titulo || '—').slice(0, 72)} | ${displaySecretariaNotif(n)} | ${n.status || '—'} | prazo ${n.prazo || '—'}`
      );
    });
    if (vis.length > 100) {
      linhas.push(`… e mais ${vis.length - 100} processo(s). Detalhe completo na PlataformaMP.`);
    }
    if (!vis.length) linhas.push('Nenhum processo no recorte dos filtros / período.');
  }

  const linhasObj = linhas.map((linha) => ({ linha }));
  const trechoCompleto =
    trecho + (linhasObj.length ? `\n\n${linhasObj.map((x) => x.linha).join('\n')}` : '');

  const nomeEmit = String(emitente?.nome || '').trim() || '—';
  const trechoFinal = String(trechoCompleto || '').trim();
  if (!trechoFinal) {
    console.warn('[relatorioService] Trecho vazio após montagem — a aplicar texto mínimo.');
  }

  return {
    data,
    hora,
    nome: nomeEmit,
    cargo: String(emitente?.cargo || '').trim() || '—',
    secretaria: secretariaFiltro || 'Todas as secretarias',
    trecho: trechoFinal || 'Sem conteúdo textual no recorte (ajuste filtros ou confira dados no sistema).',
    pdfUrl: appPublicUrl || '—',
    documentoSigiloso: 'DOCUMENTO SIGILOSO',
    tituloRelatorio,
    assinanteNome,
    assinanteCargo,
    prefeitura,
    municipio,
    orgaoInstitucional,
    linhas: linhasObj,
  };
}

/**
 * Preenche o .docx e converte para PDF (obrigatório LibreOffice no servidor).
 * @returns {Promise<{ buffer: Buffer, fileName: string, contentType: string, exportFormat: 'pdf' }|{ error: string }>}
 */
async function gerarRelatorioPDF(dados) {
  try {
    if (!dados || typeof dados !== 'object' || !Object.keys(dados).length) {
      throw new Error('Dados do relatório estão vazios');
    }
    const trechoOk = String(dados.trecho || '').trim();
    const nomeOk = String(dados.nome || '').trim();
    if (!nomeOk || nomeOk === '—') {
      console.warn('[relatorioService] Nome do emitente ausente ou genérico.');
    }
    if (!trechoOk) {
      throw new Error('Trecho do relatório vazio — não é possível gerar o documento.');
    }

    const logPayload = {
      ...dados,
      trecho: `[${String(dados.trecho).length} caracteres]`,
      linhas: Array.isArray(dados.linhas) ? `${dados.linhas.length} linha(s)` : '—',
    };
    console.log('[relatorioService] DADOS RELATÓRIO:', logPayload);

    const dadosSan = sanitizePayloadStrings(dados);

    ensureRelatoriosDir();
    const content = loadTemplateBuffer();
    const zip = new PizZip(content);
    const doc = new Docxtemplater(zip, {
      paragraphLoop: true,
      linebreaks: true,
      delimiters: { start: '{{', end: '}}' },
      nullGetter: () => '',
    });
    try {
      doc.render(dadosSan);
    } catch (renderErr) {
      const em = renderErr && renderErr.message ? String(renderErr.message) : String(renderErr);
      console.error('[relatorioService] Erro docxtemplater:', em);
      throw new Error(
        'O modelo Word não corresponde aos campos esperados. Use placeholders {{data}}, {{hora}}, {{nome}}, {{cargo}}, {{secretaria}}, {{trecho}}, {{pdfUrl}} (e opcionais no modelo interno). Detalhe: ' +
          em.slice(0, 180)
      );
    }

    const docxBuffer = doc.getZip().generate({ type: 'nodebuffer' });
    const ts = Date.now();
    const base = `Relatorio_PMP_${ts}`;

    if (!findSofficePath()) {
      return {
        error:
          'LibreOffice não está instalado ou o executável soffice não foi encontrado neste servidor. Instale o LibreOffice (Windows/Linux) ou defina SOFFICE_PATH no ficheiro .env com o caminho completo para soffice.',
      };
    }

    try {
      const pdfBuffer = await convertDocxToPdfBuffer(docxBuffer);
      if (!isValidPdfBuffer(pdfBuffer)) {
        return {
          error:
            'O ficheiro gerado não é um PDF válido. Confirme o LibreOffice, reinstale-o ou defina SOFFICE_PATH. Se o problema persistir, reduza o tamanho do relatório (filtros).',
        };
      }
      const fileName = `${base}.pdf`;
      const outPath = path.join(RELATORIOS_DIR, fileName);
      fs.writeFileSync(outPath, pdfBuffer);
      return {
        buffer: pdfBuffer,
        fileName,
        savedPath: outPath,
        contentType: 'application/pdf',
        exportFormat: 'pdf',
      };
    } catch (convErr) {
      const cm = convErr && convErr.message ? String(convErr.message) : String(convErr);
      console.error('[relatorioService] Falha na conversão PDF:', cm);
      const low = cm.toLowerCase();
      if (low.includes('soffice') || low.includes('libreoffice') || low.includes('spawn')) {
        return {
          error:
            'Erro ao gerar PDF com o LibreOffice. Confirme que o LibreOffice está instalado, que o processo soffice pode executar em modo headless e reinicie o servidor.',
        };
      }
      return { error: 'Erro ao gerar PDF: ' + cm.slice(0, 200) };
    }
  } catch (err) {
    const msg = err && err.message ? String(err.message) : String(err);
    console.error('[relatorioService] Erro ao gerar relatório:', msg);
    return { error: msg || 'Falha ao gerar relatório' };
  }
}

module.exports = {
  gerarRelatorioPDF,
  montarPayloadRelatorioPdf,
  ensureRelatoriosDir,
  findSofficePath,
  TEMPLATE_PATH,
  RELATORIOS_DIR,
};
