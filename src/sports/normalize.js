/**
 * Normaliza nomes de times para casar fontes diferentes
 * ("Atlético-MG", "Atletico Mineiro", "CA Mineiro"…).
 */
const NOISE = new Set(['fc', 'ec', 'sc', 'cf', 'ac', 'afc', 'clube', 'club', 'de', 'da', 'do', 'the']);
export function normalizeTeam(name) {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((word) => word && !NOISE.has(word))
    .join(' ');
}
/** Verdadeiro se um nome normalizado contém o outro (ex.: "flamengo" ⊂ "flamengo rj"). */
export function sameTeam(a, b) {
  const x = normalizeTeam(a);
  const y = normalizeTeam(b);
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}
