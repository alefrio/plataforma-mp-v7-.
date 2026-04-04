/**
 * Análise heurística de texto extraído de PDFs do DOM Buriticupu (dados reais, sem IA obrigatória).
 * Padrões típicos de atos administrativos municipais em português.
 */

function norm(s) {
  return String(s)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/** Nome plausível: 2+ tokens, letras e conectores */
function nomePlausivel(str) {
  const t = String(str || '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s,.;:]+|[\s,.;:]+$/g, '')
    .trim();
  if (t.length < 6 || t.length > 90) return null;
  const parts = t.split(/\s+/).filter((p) => p.length > 1);
  if (parts.length < 2) return null;
  if (!/^[A-Za-zÀ-ÿ]/.test(parts[0])) return null;
  return t.replace(/\s+/g, ' ');
}

/**
 * Extrai possível nome após verbos de nomeação/exoneração (uma linha ou trecho curto).
 */
function extrairNomeDeLinha(linha) {
  const L = String(linha || '').replace(/\s+/g, ' ').trim();
  if (!L) return null;

  const patterns = [
    /nomear\s+(?:o\s+|a\s+)?(?:senhor|senhora|sr\.?|sra\.?|dr\.?|dra\.?)?\s*([^,.\n]{6,90}?)\s+(?:como|para\s+o\s+cargo|no\s+cargo|para\s+exercer)/i,
    /fic[aá]\s+nomead[oa]\s+(?:o\s+|a\s+)?(?:senhor|senhora|sr\.?|sra\.?)?\s*([^,.\n]{6,90}?)\s+(?:como|para)/i,
    /exonerar\s+(?:o\s+|a\s+)?(?:senhor|senhora|sr\.?|sra\.?)?\s*([^,.\n]{6,90}?)\s*(?:,|do\s+cargo|\.)/i,
    /dispensar\s+(?:o\s+|a\s+)?(?:senhor|senhora)?\s*([^,.\n]{6,90}?)\s+(?:do\s+cargo)/i,
    /cessar\s+(?:o\s+|a\s+)?(?:efeitos\s+)?(?:da\s+)?(?:nomea..o|exonera..o)?[^,]*?\b([A-ZÀ-Ú][^,.\n]{5,80})/i,
  ];

  for (const re of patterns) {
    const m = L.match(re);
    if (m && m[1]) {
      const n = nomePlausivel(m[1]);
      if (n) return n;
    }
  }
  return null;
}

function extrairCargoDeLinha(linha) {
  const L = String(linha || '');
  const m = L.match(
    /(?:como|para\s+o\s+cargo\s+de|no\s+cargo\s+de|cargo\s+de)\s+([^.\n;]{8,120})/i
  );
  if (m && m[1]) return m[1].replace(/\s+/g, ' ').trim().slice(0, 120);
  const m2 = L.match(/secret[áa]ri[oa]\s+(?:municipal\s+)?(?:de\s+)?([^.\n;]{4,80})/i);
  if (m2 && m2[1]) return `Secretário(a) de ${m2[1].trim()}`;
  return '';
}

/**
 * @param {string} texto
 * @returns {{ denuncia: boolean, mencaoMunicipio: boolean, atos: Array<{ tipo: 'nomeacao'|'exoneracao', nome: string, cargo: string, trecho: string }> }}
 */
function analiseTextoDom(texto) {
  const raw = String(texto || '');
  const nt = norm(raw);

  const denuncia =
    /den[uú]ncia|notifica..o\s+ministerial|minist[eé]rio\s+p[uú]blico|promotoria|mpma/i.test(raw) &&
    /buriticupu|munic[ií]pio|prefeitura/i.test(nt);

  const mencaoMunicipio =
    /buriticupu/i.test(raw) ||
    /munic[ií]pio\s+de\s+buriticupu|prefeitura\s+municipal\s+de\s+buriticupu/i.test(nt);

  const linhas = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const atos = [];
  const visto = new Set();

  for (const linha of linhas) {
    const n = norm(linha);
    if (!/nomear|nomeia|exoner|dispensar\s+do\s+cargo|cessa\s+/i.test(linha)) continue;

    let tipo = null;
    if (/exoner|dispensar\s+do\s+cargo|cessa\s+(?:a\s+)?(?:fun|nomea)/i.test(linha)) tipo = 'exoneracao';
    else if (/nomear|nomeia|fic[aá]\s+nomead/i.test(linha)) tipo = 'nomeacao';
    if (!tipo) continue;

    const nome = extrairNomeDeLinha(linha);
    if (!nome) continue;
    const kn = norm(nome);
    if (visto.has(`${tipo}:${kn}`)) continue;
    visto.add(`${tipo}:${kn}`);

    const cargo = tipo === 'nomeacao' ? extrairCargoDeLinha(linha) : '';
    atos.push({
      tipo,
      nome,
      cargo,
      trecho: linha.slice(0, 280),
    });
  }

  return { denuncia, mencaoMunicipio, atos };
}

module.exports = { analiseTextoDom, norm, nomePlausivel };
