/**
 * Detecção de termos sensíveis em textos de diários oficiais.
 */
function detectarTermosInstitucionais(text) {
  const raw = String(text || '');
  const n = raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  const rotulos = [];
  const rules = [
    { re: /dispensa\s+de\s+licitacao|dispensa\s+licitacao|dispensa\s+de\s+licita/i, label: 'Dispensa de licitação' },
    {
      re: /contratacao\s+emergencial|contrata[çc]ao\s+emergencial|contratacao\s+direta\s+emergencial|regime\s+de\s+emergencia|estado\s+de\s+emergencia/i,
      label: 'Contratação emergencial',
    },
    { re: /irregularidade|atos?\s+irregular|improbidade|ilegalidade\s+grave/i, label: 'Irregularidade / risco' },
  ];
  for (const { re, label } of rules) {
    if (re.test(n) && !rotulos.includes(label)) rotulos.push(label);
  }
  return { rotulos, temAlerta: rotulos.length > 0 };
}

module.exports = { detectarTermosInstitucionais };
