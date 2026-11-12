import { catalog } from '../catalog.js';
import { TIME_ZONE } from '../dates.js';
import { seasonLabel, slugify } from '../types.js';
/**
 * SportAPI (https://sportapi.ai) — futebol e basquete.
 * Documentação: https://sportapi.ai/pt/docs · Especificação: /api/openapi.json
 *
 * Uma chamada a /fixtures/date/{data} traz TODAS as ligas do dia, então o custo
 * do futebol é ~1 chamada por dia consultado, não por liga.
 */
const BASE = 'https://sportapi.ai/api';
const SOURCE = 'SportAPI';
export function sportapiEnabled() {
  return Boolean(process.env.SPORTAPI_KEY);
}
function headers() {
  return { 'X-Api-Key': process.env.SPORTAPI_KEY ?? '' };
}
const footballBySportapiName = new Map(
  catalog
    .filter((entry) => entry.providers.sportapiFootball)
    .map((entry) => [entry.providers.sportapiFootball.toLowerCase(), entry])
);
function footballStatus(status) {
  switch (status) {
    case 'LIVE':
      return 'live';
    case 'FT':
    case 'AET':
    case 'PENS':
      return 'finished';
    case 'Postponed':
    case 'Suspended':
      return 'postponed';
    case 'Cancelled':
      return 'cancelled';
    default:
      return 'scheduled';
  }
}
function footballClock(row) {
  if (row.status === 'AET') return 'Prorrogação';
  if (row.status === 'PENS') {
    return row.penalty_home != null && row.penalty_away != null
      ? `Pênaltis ${row.penalty_home}–${row.penalty_away}`
      : 'Pênaltis';
  }
  if (row.status !== 'LIVE' || row.minute == null || row.minute === '') return undefined;
  if (String(row.minute).toUpperCase() === 'HT') return 'Intervalo';
  return /^\d+(\+\d+)?$/.test(String(row.minute)) ? `${row.minute}'` : String(row.minute);
}
export async function sportapiFootballByDate(client, date) {
  const body = await client.getJson('sportapi', `${BASE}/fixtures/date/${date}`, headers());
  const rows = body.data ?? [];
  const result = [];
  for (const row of rows) {
    const entry = footballBySportapiName.get(row.league_name?.toLowerCase());
    if (!entry || !row.kickoff_utc) continue;
    const status = footballStatus(row.status);
    const hasScore = row.home_score != null && row.away_score != null && status !== 'scheduled';
    result.push({
      _id: `sportapi:football:${row.id}`,
      sport: entry.sport,
      competition: entry.slug,
      kind: 'match',
      round: row.stage || undefined,
      kickoff: new Date(row.kickoff_utc),
      status,
      home: { slug: slugify(row.home_team), name: row.home_team, shortName: row.home_short, sport: entry.sport },
      away: { slug: slugify(row.away_team), name: row.away_team, shortName: row.away_short, sport: entry.sport },
      ...(hasScore ? { score: { home: row.home_score, away: row.away_score } } : {}),
      clock: footballClock(row),
      source: SOURCE
    });
  }
  return result;
}
/** Data (YYYY-MM-DD) que o SportAPI usa para a partida: o dia no horário da Europa Central. */
export function sportapiFootballDateOf(kickoff) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Paris',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(kickoff);
}
/** Mapa slug do catálogo → ID da liga no SportAPI (1 chamada). */
export async function sportapiFootballLeagueIds(client) {
  const body = await client.getJson('sportapi', `${BASE}/leagues`, headers());
  const ids = {};
  for (const group of body.data ?? []) {
    for (const league of group.leagues) {
      const entry = footballBySportapiName.get(league.name.toLowerCase());
      if (entry && league.has_standings) ids[entry.slug] = league.id;
    }
  }
  return ids;
}
export async function sportapiFootballStandings(client, slug, leagueId) {
  const entry = catalog.find((item) => item.slug === slug);
  const body = await client.getJson('sportapi', `${BASE}/standings/${leagueId}`, headers());
  const groups = new Map();
  for (const row of body.data ?? []) {
    const key = row.group ?? '';
    const rows = groups.get(key) ?? [];
    rows.push({
      position: row.position,
      team: row.team.name,
      played: row.played,
      wins: row.won,
      draws: row.draw,
      losses: row.lost,
      goalsFor: row.goals_for,
      goalsAgainst: row.goals_against,
      points: row.points,
      form: row.form?.map((item) => item.result).filter((r) => r === 'W' || r === 'D' || r === 'L')
    });
    groups.set(key, rows);
  }
  return [...groups.entries()].map(([group, rows]) => ({
    _id: `table:${slug}:${group || 'geral'}`,
    competition: slug,
    season: seasonLabel(entry),
    format: 'football',
    ...(group ? { group } : {}),
    rows,
    source: SOURCE
  }));
}
const basketballBySlug = new Map(
  catalog
    .filter((entry) => entry.providers.sportapiBasketball)
    .map((entry) => [entry.providers.sportapiBasketball, entry])
);
export function basketballLeagues() {
  return [...basketballBySlug.keys()];
}
function basketballStatus(game) {
  const status = game.status?.toUpperCase();
  if (game.live) return 'live';
  if (status === 'FT' || status === 'AOT') return 'finished';
  if (status === 'POST' || status === 'PST' || status === 'PPD' || status === 'SUSP') return 'postponed';
  if (status === 'CANC') return 'cancelled';
  return 'scheduled';
}
function basketballClock(game) {
  const status = game.status?.toUpperCase();
  if (status === 'AOT') return 'Prorrogação';
  if (!game.live) return undefined;
  if (status === 'HT') return 'Intervalo';
  return [status, game.clock].filter(Boolean).join(' ') || undefined;
}
function mapBasketball(game) {
  const entry = basketballBySlug.get(game.league?.slug);
  if (!entry || !game.start) return null;
  const status = basketballStatus(game);
  const hasScore = game.home.score != null && game.away.score != null && status !== 'scheduled';
  return {
    _id: `sportapi:basketball:${game.id}`,
    sport: entry.sport,
    competition: entry.slug,
    kind: 'match',
    round: game.round || undefined,
    kickoff: new Date(game.start),
    status,
    home: { slug: game.home.slug, name: game.home.name, shortName: game.home.abbreviation, sport: entry.sport },
    away: { slug: game.away.slug, name: game.away.name, shortName: game.away.abbreviation, sport: entry.sport },
    ...(hasScore ? { score: { home: game.home.score, away: game.away.score } } : {}),
    clock: basketballClock(game),
    venue: game.venue || undefined,
    source: SOURCE
  };
}
/** Jogos de basquete de um dia de Brasília (o SportAPI aceita o fuso). */
export async function sportapiBasketballByDate(client, ymd) {
  const leagues = basketballLeagues().join(',');
  const body = await client.getJson(
    'sportapi',
    `${BASE}/basketball/games/date/${ymd}?league=${leagues}&tz=${encodeURIComponent(TIME_ZONE)}`,
    headers()
  );
  return (body.data ?? []).map(mapBasketball).filter((item) => item !== null);
}
export async function sportapiBasketballLive(client) {
  const leagues = basketballLeagues().join(',');
  const body = await client.getJson('sportapi', `${BASE}/basketball/games/live?league=${leagues}`, headers());
  return (body.data ?? []).map(mapBasketball).filter((item) => item !== null);
}
export async function sportapiBasketballStandings(client, leagueSlug) {
  const entry = basketballBySlug.get(leagueSlug);
  const body = await client.getJson('sportapi', `${BASE}/basketball/standings/${leagueSlug}`, headers());
  return (body.data ?? []).map((group) => ({
    _id: `table:${entry.slug}:${group.group || 'geral'}`,
    competition: entry.slug,
    season: seasonLabel(entry),
    format: 'basketball',
    group: group.group
      ?.replace('Eastern Conference', 'Conferência Leste')
      .replace('Western Conference', 'Conferência Oeste'),
    rows: group.table.map((row) => ({
      position: row.position,
      team: row.team.name,
      played: row.played,
      wins: row.won,
      losses: row.lost,
      winPct: row.win_pct,
      gamesBehind: row.games_behind ?? undefined,
      streak: row.streak ?? undefined
    })),
    source: SOURCE
  }));
}
