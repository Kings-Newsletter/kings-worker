import { normalizeTeam } from '../normalize.js';
/**
 * TheSportsDB (https://www.thesportsdb.com) — só escudos dos times.
 *
 * A chave pública gratuita (`123`) limita listas, mas a busca de time por nome
 * vem completa, com o link do escudo. Limite: 30 chamadas por minuto.
 */
const BASE = 'https://www.thesportsdb.com/api/v1/json';
const SPORT_NAME = {
  futebol: 'Soccer',
  basquete: 'Basketball'
};
export function crestSports() {
  return Object.keys(SPORT_NAME);
}
/** Link do escudo do time, ou null se não encontrado. 1 chamada. */
export async function findCrest(client, name, sport) {
  const key = process.env.THESPORTSDB_KEY || '123';
  const body = await client.getJson('thesportsdb', `${BASE}/${key}/searchteams.php?t=${encodeURIComponent(name)}`);
  const wanted = SPORT_NAME[sport];
  const candidates = (body.teams ?? []).filter((team) => team.strSport === wanted && team.strBadge);
  if (candidates.length === 0) return null;
  const target = normalizeTeam(name);
  const exact = candidates.find((team) =>
    [team.strTeam, ...(team.strTeamAlternate ?? '').split(',')].map((alias) => normalizeTeam(alias)).includes(target)
  );
  return (exact ?? candidates[0]).strBadge ?? null;
}
