export function slugify(value) {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
/**
 * Rótulo da temporada: ano único no calendário sul-americano,
 * "2026/27" nas ligas europeias e na NBA.
 */
export function seasonLabel(entry, now = new Date()) {
  const year = now.getUTCFullYear();
  const singleYear =
    entry.sport === 'automobilismo' ||
    entry.sport === 'futebol-americano' ||
    entry.country === 'Brasil' ||
    entry.country === 'América do Sul';
  if (singleYear) return String(year);
  const start = now.getUTCMonth() >= 6 ? year : year - 1;
  return `${start}/${String(start + 1).slice(2)}`;
}
