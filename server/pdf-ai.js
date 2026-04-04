const axios = require('axios');

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

function mapRiscoToUrgencia(risco) {
  const r = String(risco || '').toLowerCase();
  if (r === 'alto') return { urgencia: 'Alta', urg: 'ALTA' };
  if (r === 'medio' || r === 'médio') return { urgencia: 'Média', urg: 'MÉDIA' };
  return { urgencia: 'Baixa', urg: 'BAIXA' };
}

function fallbackAnalysis(excerpt, matchedNames, extracaoPdf) {
  const low = /notifica|recomenda|ciência|publica/i;
  const high = /ação judicial|denúncia|improbidade|multa|prazo de.*hora|urgente|liminar/i;
  const mid = /procedimento|apuração|instaur|notícia de fato/i;
  let risco = 'medio';
  if (high.test(excerpt)) risco = 'alto';
  else if (low.test(excerpt) && !high.test(excerpt)) risco = 'baixo';
  else if (mid.test(excerpt)) risco = 'medio';
  const { urgencia, urg } = mapRiscoToUrgencia(risco);
  const docTipo = extracaoPdf && extracaoPdf.documentoTipo ? extracaoPdf.documentoTipo : null;
  const tipo =
    docTipo ||
    (high.test(excerpt) ? 'Possível contencioso / atuação ministerial' : 'Acompanhamento administrativo / ciência');
  const multaTxt =
    extracaoPdf && extracaoPdf.multa && extracaoPdf.multa.valorFormatado
      ? ` Multa no texto: ${extracaoPdf.multa.valorFormatado}${extracaoPdf.multa.tipoLabel ? ` (${extracaoPdf.multa.tipoLabel})` : ''}.`
      : '';
  const prazoTxt =
    extracaoPdf && extracaoPdf.prazo && extracaoPdf.prazo.label ? ` ${extracaoPdf.prazo.label}` : '';
  const riscoTxt =
    extracaoPdf && extracaoPdf.riscoFinanceiro && extracaoPdf.riscoFinanceiro.calculado
      ? ` Risco financeiro estimado (só com base no texto): ${extracaoPdf.riscoFinanceiro.valorFormatado}.`
      : '';
  return {
    resumo: `${excerpt.slice(0, 380).replace(/\s+/g, ' ').trim()}${excerpt.length > 380 ? '…' : ''}`,
    risco,
    tipoProcesso: tipo,
    recomendacao:
      risco === 'alto'
        ? 'Priorizar análise jurídica e resposta coordenada com a Procuradoria.'
        : 'Manter monitoramento e conferir os dados extraídos do PDF no painel.',
    urgencia,
    urg,
  };
}

/**
 * Analisa texto extraído do PDF e devolve campos para integrar em notificação.ia
 * @param {object} [options.extracaoPdf] - extração por regex (mpmaExtracao); a IA não deve inventar valores além disto
 */
async function analyzePdfText(rawText, { matchedNames = [], extracaoPdf = null } = {}) {
  const excerpt = String(rawText || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 14000);
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    const fb = fallbackAnalysis(excerpt, matchedNames, extracaoPdf);
    return {
      ...fb,
      fonteIa: 'heuristica',
    };
  }

  const extracaoStr = extracaoPdf
    ? JSON.stringify(extracaoPdf, null, 0).slice(0, 3500)
    : '{}';

  const system = `És um assistente jurídico-administrativo para a prefeitura. Analisas trechos do Diário Oficial do MPMA.
Responde SEMPRE com um único objeto JSON válido (sem markdown), chaves exatas:
{"resumo":"string em português (max 600 chars)","risco":"baixo"|"medio"|"alto","tipoProcesso":"string curta","recomendacao":"string em português (max 400 chars)"}
REGRAS:
- NÃO inventes valores em R$, prazos numéricos nem nomes de órgãos que não constem no trecho ou no objeto "extracaoRegex" abaixo.
- Se extracaoRegex trouxer multa/prazo/documento, menciona-os no resumo de forma fiel; se um campo for null, diz "não identificado no trecho analisado".
-risco: alto se houver risco claro de sanção, ação judicial iminente ou multa no texto; medio para apurações ou recomendações; baixo para mero registro ou ciência.`;

  const user = `Nomes monitorados detectados no documento: ${matchedNames.join(', ') || '(lista vazia)'}.

Extração automática por padrões no PDF (pode estar incompleta — não contradigas com valores inventados):
${extracaoStr}

Texto do documento (trecho):
${excerpt}`;

  try {
    const { data } = await axios.post(
      OPENAI_URL,
      {
        model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      },
      {
        timeout: 120000,
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
      }
    );
    const content = data?.choices?.[0]?.message?.content;
    if (!content) throw new Error('Resposta vazia da IA');
    const parsed = JSON.parse(content);
    const risco = ['baixo', 'medio', 'médio', 'alto'].includes(String(parsed.risco || '').toLowerCase())
      ? String(parsed.risco).toLowerCase().replace('médio', 'medio')
      : 'medio';
    const { urgencia, urg } = mapRiscoToUrgencia(risco);
    return {
      resumo: String(parsed.resumo || '').slice(0, 800),
      risco,
      tipoProcesso: String(parsed.tipoProcesso || 'Não classificado').slice(0, 200),
      recomendacao: String(parsed.recomendacao || '').slice(0, 500),
      urgencia,
      urg,
      fonteIa: 'openai',
    };
  } catch (e) {
    console.error('[pdf-ai] Falha na IA, usando fallback:', e.message);
    const fb = fallbackAnalysis(excerpt, matchedNames, extracaoPdf);
    return { ...fb, fonteIa: 'heuristica', erroIa: e.message };
  }
}

/**
 * Integra só metadados de IA (risco, urgência, recomendação).
 * Título/tema/resumo exibidos vêm do PDF (iaBase); não substituir por tipoProcesso/resumo da IA.
 */
function mergeIaIntoNotification(iaBase, aiResult) {
  const { urg, resumo, risco, tipoProcesso, recomendacao, fonteIa, erroIa } = aiResult;
  const temaPdf = iaBase.tema && String(iaBase.tema).trim() ? iaBase.tema : '';
  return {
    ...iaBase,
    tema: temaPdf,
    urg: urg || iaBase.urg,
    resumo: iaBase.resumo != null && String(iaBase.resumo).trim() ? iaBase.resumo : resumo,
    risco,
    tipoProcesso: iaBase.documentoTipo || tipoProcesso || iaBase.tipoProcesso,
    recomendacao,
    fonteIa: fonteIa || 'heuristica',
    ...(erroIa ? { erroIa } : {}),
  };
}

module.exports = {
  analyzePdfText,
  mergeIaIntoNotification,
  mapRiscoToUrgencia,
  fallbackAnalysis,
};
