/**
 * Classificação automática por palavras-chave (PT-BR): normal | atencao | critico.
 * Complementa urgência manual e IA; urgência "Alta" força nível crítico.
 */

const CRITICO = [
  'homicídio',
  'homicidio',
  'violência sexual',
  'violencia sexual',
  'estupro',
  'tráfico',
  'trafico de drogas',
  'lavagem de dinheiro',
  'organização criminosa',
  'ameaça à vida',
  'ameaca a vida',
  'desvio milionário',
  'superfaturamento grave',
  'colapso',
  'óbito',
  'obito',
  'morte de paciente',
  'improbidade grave',
  'crime contra a administração',
  'coação',
  'coacao',
  'extorsão',
  'extorsao',
  'sequestro',
  'fraude eleitoral',
];

const ATENCAO = [
  'irregularidade',
  'dano ao erário',
  'dano ao erario',
  'improbidade',
  'licitação',
  'licitacao',
  'dispensa ilegal',
  'nepotismo',
  'conflito de interesse',
  'acúmulo ilegal',
  'acumulo ilegal',
  'sobrepreço',
  'sobrepreco',
  'inexecução',
  'inexecucao',
  'descumprimento',
  'atraso reiterado',
  'falta grave',
  'servidor fantasma',
  'ponto irregular',
  'desvio de verba',
  'obra parada',
  'súmula vinculante',
  'sumula vinculante',
  'multa aplicada',
  'tce',
  'tcu',
  'mpma',
  'ministério público',
  'ministerio publico',
  'ação civil pública',
  'acao civil publica',
  'inquérito',
  'inquerito',
  'denúncia',
  'denuncia',
];

function normText(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function hitsInText(norm, keywords) {
  const found = [];
  for (const k of keywords) {
    const nk = normText(k);
    if (nk.length >= 3 && norm.includes(nk)) found.push(k);
  }
  return found;
}

/**
 * @param {object} n - notificação parcial ou completa
 * @returns {{ nivelDenuncia: 'normal'|'atencao'|'critico', keywordHits: string[] }}
 */
function classifyDenunciaNivel(n) {
  const text = normText(`${n.descricao || ''} ${n.titulo || ''} ${(n.ia && n.ia.tema) || ''}`);
  if (!text.trim()) {
    return { nivelDenuncia: 'normal', keywordHits: [] };
  }
  if (String(n.urgencia || '') === 'Alta') {
    return { nivelDenuncia: 'critico', keywordHits: ['urgência Alta'] };
  }
  const crit = hitsInText(text, CRITICO);
  if (crit.length) {
    return { nivelDenuncia: 'critico', keywordHits: crit.slice(0, 12) };
  }
  const att = hitsInText(text, ATENCAO);
  if (att.length) {
    return { nivelDenuncia: 'atencao', keywordHits: att.slice(0, 12) };
  }
  return { nivelDenuncia: 'normal', keywordHits: [] };
}

module.exports = {
  classifyDenunciaNivel,
  CRITICO,
  ATENCAO,
};
