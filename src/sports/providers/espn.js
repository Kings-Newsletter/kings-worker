import { catalog } from '../catalog.js';
import { seasonLabel, slugify } from '../types.js';
/**
 * ESPN — fonte principal de placares, tabelas e escudos.
 *
 * API pública não documentada (a mesma usada pelo site da ESPN e por projetos
 * como o ha-teamtracker). Sem chave e sem cota, mas pode mudar sem aviso: por
 * isso a coleta cai para a SportAPI quando uma chamada falha.
 *
 *   Placar:  /apis/site/v2/sports/{esporte}/{liga}/scoreboard?dates=AAAAMMDD
 *   Tabela:  /apis/v2/sports/{esporte}/{liga}/standings
 *
 * Intervalos de datas (dates=A-B) respondem 400: consultamos dia a dia. O dia
 * da ESPN é o dia no horário de Nova York.
 */
const SITE = 'https://site.api.espn.com/apis/site/v2/sports';
const CORE = 'https://site.api.espn.com/apis/v2/sports';
const SOURCE = 'ESPN';
export function espnLeagues() {
  return catalog.filter((entry) => entry.providers.espn);
}
/** Data AAAAMMDD que a ESPN usa para um instante (fuso de Nova York). */
export function espnDateOf(instant) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  })
    .format(instant)
    .replaceAll('-', '');
}
const STAGES = {
  final: 'Final',
  semifinals: 'Semifinal',
  quarterfinals: 'Quartas de final',
  'round-of-16': 'Oitavas de final',
  'rd-of-16': 'Oitavas de final',
  'knockout-round-playoffs': 'Playoffs',
  'league-phase': 'Fase de liga',
  'group-stage': 'Fase de grupos'
};
function status(event) {
  const name = event.status.type.name;
  if (/POSTPONED|SUSPENDED|DELAYED/.test(name)) return 'postponed';
  if (/CANCELED|CANCELLED|ABANDONED|FORFEIT/.test(name)) return 'cancelled';
  if (event.status.type.state === 'in') return 'live';
  if (event.status.type.state === 'post') return 'finished';
  return 'scheduled';
}
function clock(event, sport, home, away) {
  const name = event.status.type.name;
  if (name === 'STATUS_HALFTIME') return 'Intervalo';
  // Fim de um período (basquete, NFL) ou do tempo normal antes da prorrogação.
  if (name === 'STATUS_END_PERIOD') return event.status.period ? `Fim do ${event.status.period}º P` : 'Intervalo';
  if (name === 'STATUS_END_OF_REGULATION' || name === 'STATUS_END_OF_EXTRATIME') return 'Intervalo';
  if (name === 'STATUS_FINAL_PEN' || name === 'STATUS_SHOOTOUT') {
    return home?.shootoutScore != null && away?.shootoutScore != null
      ? `Pênaltis ${home.shootoutScore}–${away.shootoutScore}`
      : 'Pênaltis';
  }
  if (name === 'STATUS_FINAL_AET' || name === 'STATUS_FINAL_OT') return 'Prorrogação';
  if (event.status.type.state !== 'in') return undefined;
  if (sport === 'futebol') return event.status.displayClock || undefined;
  // Basquete e futebol americano: "4º P · 5:12"
  const period = event.status.period ? `${event.status.period}º P` : '';
  return [period, event.status.displayClock].filter(Boolean).join(' · ') || event.status.type.shortDetail;
}
function score(value) {
  if (value === undefined || value === '') return undefined;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : undefined;
}
function mapEvent(event, entry) {
  const competition = event.competitions[0];
  const home = competition?.competitors.find((c) => c.homeAway === 'home');
  const away = competition?.competitors.find((c) => c.homeAway === 'away');
  if (!competition || !home || !away || !event.date) return null;
  const st = status(event);
  const homeScore = score(home.score);
  const awayScore = score(away.score);
  const hasScore = st !== 'scheduled' && homeScore !== undefined && awayScore !== undefined;
  const stage = event.season?.slug ? STAGES[event.season.slug] : undefined;
  const team = (c) => ({
    id: c.team.id,
    slug: slugify(c.team.displayName),
    name: c.team.displayName,
    shortName: c.team.abbreviation,
    sport: entry.sport,
    crest: c.team.logo
  });
  return {
    _id: `espn:${event.id}`,
    sport: entry.sport,
    competition: entry.slug,
    kind: 'match',
    round: stage,
    kickoff: new Date(event.date),
    status: st,
    home: team(home),
    away: team(away),
    ...(hasScore ? { score: { home: homeScore, away: awayScore } } : {}),
    clock: clock(event, entry.sport, home, away),
    venue: competition.venue?.fullName,
    source: SOURCE
  };
}
/** Partidas de uma liga num dia da ESPN (AAAAMMDD). 1 chamada. */
export async function espnScoreboard(client, entry, date) {
  return espnScoreboardQuery(client, entry, `dates=${date}`);
}
/** Placar com parâmetros livres (ex.: "dates=20261114" ou "seasontype=2&week=12"). 1 chamada. */
export async function espnScoreboardQuery(client, entry, query) {
  const body = await client.getJson('espn', `${SITE}/${entry.providers.espn}/scoreboard?${query}&limit=300`);
  return (body.events ?? []).map((event) => mapEvent(event, entry)).filter((f) => f !== null);
}
function ymdOf(iso) {
  return iso.slice(0, 10).replaceAll('-', '');
}
/** Dias entre duas datas ISO (inclusivo), em AAAAMMDD. */
function daysBetween(startIso, endIso) {
  const days = [];
  const start = new Date(`${startIso.slice(0, 10)}T12:00:00Z`);
  const end = new Date(`${endIso.slice(0, 10)}T12:00:00Z`);
  for (let d = start; d <= end; d = new Date(d.getTime() + 86_400_000)) {
    days.push(d.toISOString().slice(0, 10).replaceAll('-', ''));
  }
  return days;
}
/**
 * Todas as consultas necessárias para cobrir a temporada da liga, a partir do
 * calendário que a própria ESPN publica no placar (1 chamada):
 *  - ligas com calendário por dia (Brasileirão, NBA, ligas europeias): só os
 *    dias com jogo;
 *  - NFL: uma consulta por semana;
 *  - copas com calendário por fase (Champions, Copa do Brasil): todos os dias
 *    de cada fase entre `listFromDay` e `horizonDays` à frente (as datas exatas
 *    não vêm, então percorrer as fases já encerradas custaria centenas de chamadas).
 */
export async function espnSeasonQueries(client, entry, { horizonDays, listFromDay }) {
  const body = await client.getJson('espn', `${SITE}/${entry.providers.espn}/scoreboard`);
  const calendar = body.leagues?.[0]?.calendar ?? [];
  const limit = ymdOf(new Date(Date.now() + horizonDays * 86_400_000).toISOString());
  const queries = new Map();
  for (const item of calendar) {
    if (typeof item === 'string') {
      const day = ymdOf(item);
      queries.set(day, { query: `dates=${day}`, day });
      continue;
    }
    for (const phase of item.entries ?? []) {
      if (!phase.startDate || !phase.endDate) continue;
      if (entry.sport === 'futebol-americano' && item.value && phase.value) {
        const key = `seasontype=${item.value}&week=${phase.value}`;
        queries.set(key, { query: key, day: ymdOf(phase.startDate) });
        continue;
      }
      for (const day of daysBetween(phase.startDate, phase.endDate)) {
        if (day <= limit && day >= listFromDay) queries.set(day, { query: `dates=${day}`, day });
      }
    }
  }
  return [...queries.values()].sort((a, b) => a.day.localeCompare(b.day));
}
const GROUP_NAMES = {
  'Eastern Conference': 'Conferência Leste',
  'Western Conference': 'Conferência Oeste',
  'American Football Conference': 'AFC',
  'National Football Conference': 'NFC'
};
function groupName(name) {
  if (!name) return undefined;
  if (GROUP_NAMES[name]) return GROUP_NAMES[name];
  return name.replace(/^Group /, 'Grupo ');
}
/** Traduz a zona da tabela informada pela ESPN. */
function noteLabel(description) {
  const rules = [
    [/relegat/i, 'Rebaixamento'],
    [/libertadores.*(qualif|prelim|second|segunda)/i, 'Pré-Libertadores'],
    [/libertadores/i, 'Libertadores'],
    [/sudamericana/i, 'Sul-Americana'],
    [/champions league.*(qualif|play)/i, 'Pré-Champions'],
    [/champions league/i, 'Champions League'],
    [/europa league/i, 'Europa League'],
    [/conference league/i, 'Conference League'],
    [/promot/i, 'Acesso'],
    [/round of 16|knockout round/i, 'Mata-mata'],
    [/play-?in/i, 'Play-in'],
    [/playoff/i, 'Playoffs'],
    [/eliminat/i, 'Eliminado']
  ];
  return rules.find(([re]) => re.test(description))?.[1] ?? description;
}
function stat(stats, name) {
  const item = stats.find((s) => s.name === name);
  if (!item) return undefined;
  if (typeof item.value === 'number' && Number.isFinite(item.value)) return item.value;
  const parsed = Number.parseFloat(item.displayValue ?? '');
  return Number.isFinite(parsed) ? parsed : undefined;
}
function standingsFormat(entry) {
  return entry.sport === 'futebol' ? 'football' : 'basketball';
}
function mapRows(group, format) {
  const entries = group.standings?.entries ?? [];
  const order = (stats) => stat(stats, 'rank') ?? stat(stats, 'playoffSeed') ?? 999;
  return [...entries]
    .sort((a, b) => order(a.stats) - order(b.stats))
    .map((row, index) => {
      const s = row.stats;
      const crest = row.team.logos?.[0]?.href;
      const note =
        row.note?.color && row.note.description
          ? { color: row.note.color.replace('#', ''), label: noteLabel(row.note.description) }
          : undefined;
      if (format === 'football') {
        return {
          position: index + 1,
          team: row.team.displayName,
          teamId: row.team.id,
          crest,
          played: stat(s, 'gamesPlayed'),
          wins: stat(s, 'wins'),
          draws: stat(s, 'ties'),
          losses: stat(s, 'losses'),
          goalsFor: stat(s, 'pointsFor'),
          goalsAgainst: stat(s, 'pointsAgainst'),
          points: stat(s, 'points'),
          note
        };
      }
      const wins = stat(s, 'wins');
      const losses = stat(s, 'losses');
      const streak = s.find((x) => x.name === 'streak')?.displayValue;
      return {
        position: index + 1,
        team: row.team.displayName,
        teamId: row.team.id,
        crest,
        played: wins !== undefined && losses !== undefined ? wins + losses + (stat(s, 'ties') ?? 0) : undefined,
        wins,
        losses,
        winPct: stat(s, 'winPercent'),
        gamesBehind: stat(s, 'gamesBehind'),
        streak: streak && streak !== '-' ? streak : undefined,
        note
      };
    });
}
/** Tabelas de uma liga (um documento por grupo/conferência). 1 chamada. */
export async function espnStandings(client, entry) {
  const body = await client.getJson('espn', `${CORE}/${entry.providers.espn}/standings`);
  const format = standingsFormat(entry);
  const groups = body.children && body.children.length > 0 ? body.children : [body];
  const multi = groups.length > 1;
  return groups
    .map((group) => {
      const rows = mapRows(group, format);
      const name = multi ? groupName(group.name) : undefined;
      return {
        _id: `table:${entry.slug}:${name ?? 'geral'}`,
        competition: entry.slug,
        season: seasonLabel(entry),
        format,
        ...(name ? { group: name } : {}),
        rows,
        source: SOURCE
      };
    })
    .filter((table) => table.rows.length > 0);
}
const WEB = 'https://site.web.api.espn.com/apis/site/v3/sports';
/** Métricas exibidas por esporte: chave da ESPN → [slug, rótulo]. */
const LEADER_METRICS = {
  basquete: {
    pointsPerGame: ['pontos', 'Pontos por jogo'],
    reboundsPerGame: ['rebotes', 'Rebotes por jogo'],
    assistsPerGame: ['assistencias', 'Assistências por jogo'],
    '3PointsMadePerGame': ['bolas-de-3', 'Bolas de 3 por jogo'],
    stealsPerGame: ['roubos', 'Roubos de bola por jogo'],
    blocksPerGame: ['tocos', 'Tocos por jogo']
  },
  'futebol-americano': {
    passingYards: ['jardas-passe', 'Jardas de passe'],
    rushingYards: ['jardas-corrida', 'Jardas corridas'],
    receivingYards: ['jardas-recepcao', 'Jardas de recepção'],
    totalTouchdowns: ['touchdowns', 'Touchdowns'],
    sacks: ['sacks', 'Sacks']
  }
};
const SOCCER_METRICS = {
  goalsLeaders: ['gols', 'Artilharia'],
  assistsLeaders: ['assistencias', 'Assistências']
};
/** "Matches: 32, Goals: 21" → "32 jogos" */
function matchesOf(displayValue) {
  const games = displayValue?.match(/Matches:\s*(\d+)/i)?.[1];
  return games ? `${games} jogos` : undefined;
}
/** Artilharia e assistências de uma liga de futebol. 1 chamada. */
export async function espnSoccerLeaders(client, entry) {
  const body = await client.getJson('espn', `${SITE}/${entry.providers.espn}/statistics`);
  return (body.stats ?? [])
    .filter((category) => SOCCER_METRICS[category.name])
    .map((category) => {
      const [metric, label] = SOCCER_METRICS[category.name];
      return {
        _id: `stats:${entry.slug}:${metric}`,
        competition: entry.slug,
        season: seasonLabel(entry),
        sport: entry.sport,
        metric,
        label,
        leaders: (category.leaders ?? []).slice(0, 10).map((item) => ({
          athlete: item.athlete?.displayName,
          athleteId: item.athlete?.id,
          teamId: item.athlete?.team?.id,
          team: item.athlete?.team?.displayName ?? '',
          value: item.value,
          display: String(item.value),
          extra: matchesOf(item.displayValue),
          // A ESPN não tem foto da maioria dos jogadores de futebol: usa o escudo do time.
          crest: item.athlete?.team?.logos?.[0]?.href
        })),
        source: SOURCE
      };
    })
    .filter((board) => board.leaders.length > 0);
}
/** Líderes por fundamento (NBA, NFL). 1 chamada. */
export async function espnLeaders(client, entry) {
  const metrics = LEADER_METRICS[entry.sport];
  if (!metrics) return [];
  const body = await client.getJson('espn', `${WEB}/${entry.providers.espn}/leaders?limit=10`);
  return (body.leaders?.categories ?? [])
    .filter((category) => metrics[category.name])
    .map((category) => {
      const [metric, label] = metrics[category.name];
      return {
        _id: `stats:${entry.slug}:${metric}`,
        competition: entry.slug,
        season: seasonLabel(entry),
        sport: entry.sport,
        metric,
        label,
        leaders: (category.leaders ?? []).slice(0, 10).map((item) => ({
          athlete: item.athlete?.displayName,
          athleteId: item.athlete?.id,
          teamId: item.athlete?.team?.id,
          team: item.athlete?.team?.displayName ?? item.team?.displayName ?? '',
          value: item.value,
          display: item.displayValue,
          photo: item.athlete?.headshot?.href,
          crest: item.athlete?.team?.logos?.[0]?.href
        })),
        source: SOURCE
      };
    })
    .filter((board) => board.leaders.length > 0);
}
