/**
 * Datas no fuso de Brasília. O "dia" do portal é o dia de São Paulo,
 * não o dia UTC do servidor.
 */
export const TIME_ZONE = 'America/Sao_Paulo';
const ymdFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
});
const offsetFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: TIME_ZONE,
  timeZoneName: 'longOffset'
});
/** "2026-11-10" para o instante dado, no fuso de Brasília. */
export function toLocalYmd(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  return ymdFormatter.format(date);
}
/** Deslocamento do fuso naquele instante, ex.: "-03:00". */
function offsetAt(date) {
  const part = offsetFormatter.formatToParts(date).find((p) => p.type === 'timeZoneName');
  const match = part?.value.match(/GMT([+-]\d{2}:\d{2})/);
  return match?.[1] ?? '-03:00';
}
/** Soma dias a uma data "YYYY-MM-DD" (aritmética de calendário, sem fuso). */
export function addDays(ymd, days) {
  const [y = 1970, m = 1, d = 1] = ymd.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + days));
  return date.toISOString().slice(0, 10);
}
/** Início e fim (exclusivo) do dia de Brasília, em instantes UTC. */
export function localDayBounds(ymd) {
  const noon = new Date(`${ymd}T12:00:00Z`);
  const from = new Date(`${ymd}T00:00:00${offsetAt(noon)}`);
  const next = addDays(ymd, 1);
  const to = new Date(`${next}T00:00:00${offsetAt(new Date(`${next}T12:00:00Z`))}`);
  return { from, to };
}
export function isValidYmd(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
}
