const { detectarTermosInstitucionais } = require('./diarioInteligencia');
const { stableId } = require('./diarioCrawlerCommon');

const SEC_POR_FONTE = { DOU: 'Federal', DOE: 'Estado MA', DOM: 'Municipal' };

/**
 * @param {'DOU'|'DOE'|'DOM'} fonte
 * @param {{ titulo: string, texto: string, url: string, pdfUrl?: string|null, id?: string }} p
 */
function buildDiarioMonitorItem(fonte, p) {
  const texto = String(p.texto || '');
  const { rotulos, temAlerta } = detectarTermosInstitucionais(texto);
  const id = p.id || stableId(fonte, p.pdfUrl || p.url);
  const urgencia = temAlerta ? 'Alta' : 'Média';
  const titulo = String(p.titulo || 'Publicação oficial').slice(0, 220);
  const sec = SEC_POR_FONTE[fonte] || '—';

  return {
    id,
    titulo,
    secretaria: sec,
    servidor: `${fonte} · Monitoramento institucional`,
    mencoesDetalhe: [],
    status: urgencia === 'Alta' ? 'urgente' : 'novo',
    urgencia,
    prazo: '2099-12-31',
    recebido: new Date().toLocaleString('pt-BR'),
    multa: 0,
    descricao: texto.slice(0, 4500),
    ia: {
      tema: titulo.slice(0, 120),
      resumo: texto.slice(0, 650),
      sec,
    },
    comentarios: [],
    timeline: [
      {
        acao: `Ingestão automática — ${fonte}`,
        hora: new Date().toLocaleString('pt-BR'),
        done: true,
        current: true,
      },
    ],
    viewers: [],
    accessLog: [],
    reenvioEtapa: 0,
    fonte: p.url,
    ofNr: null,
    assinado: false,
    pdfUrl: p.pdfUrl || null,
    origemDiario: true,
    monitoramentoOrigem: fonte,
    alertasInteligencia: rotulos,
    diarioMetadados: { urlPublicacao: p.url, pdfUrl: p.pdfUrl || null },
    mpmaExtracao: null,
    gravidadePdf: null,
    responsavelId: null,
    responsavelNome: null,
    prioridade: !!temAlerta,
  };
}

module.exports = { buildDiarioMonitorItem, SEC_POR_FONTE };
