export const catalog = [
  // ------------------------------------------------------------ Futebol
  {
    slug: 'brasileirao-serie-a',
    logo: 'https://a.espncdn.com/i/leaguelogos/soccer/500-dark/85.png',
    name: 'Campeonato Brasileiro Série A',
    shortName: 'Brasileirão',
    sport: 'futebol',
    scope: 'nacional',
    country: 'Brasil',
    format: 'Pontos corridos, 20 clubes',
    priority: 1,
    providers: { espn: 'soccer/bra.1', sportapiFootball: 'Brazilian Serie A', footballDataCoUk: 'Serie A' }
  },
  {
    slug: 'copa-do-brasil',
    logo: 'https://a.espncdn.com/i/leaguelogos/soccer/500-dark/528.png',
    name: 'Copa do Brasil',
    shortName: 'Copa do Brasil',
    sport: 'futebol',
    scope: 'nacional',
    country: 'Brasil',
    format: 'Mata-mata',
    priority: 2,
    providers: { espn: 'soccer/bra.copa_do_brazil' }
  },
  {
    slug: 'libertadores',
    logo: 'https://a.espncdn.com/i/leaguelogos/soccer/500-dark/58.png',
    name: 'CONMEBOL Libertadores',
    shortName: 'Libertadores',
    sport: 'futebol',
    scope: 'internacional',
    country: 'América do Sul',
    priority: 3,
    providers: { espn: 'soccer/conmebol.libertadores', sportapiFootball: 'CONMEBOL Libertadores' }
  },
  {
    slug: 'sul-americana',
    logo: 'https://a.espncdn.com/i/leaguelogos/soccer/500-dark/1208.png',
    name: 'CONMEBOL Sul-Americana',
    shortName: 'Sul-Americana',
    sport: 'futebol',
    scope: 'internacional',
    country: 'América do Sul',
    priority: 4,
    providers: { espn: 'soccer/conmebol.sudamericana', sportapiFootball: 'CONMEBOL Sudamericana' }
  },
  {
    slug: 'brasileirao-serie-b',
    logo: 'https://a.espncdn.com/i/leaguelogos/soccer/500-dark/2299.png',
    name: 'Campeonato Brasileiro Série B',
    shortName: 'Série B',
    sport: 'futebol',
    scope: 'nacional',
    country: 'Brasil',
    priority: 5,
    providers: { espn: 'soccer/bra.2', sportapiFootball: 'Brazilian Serie B' }
  },
  {
    slug: 'champions-league',
    logo: 'https://a.espncdn.com/i/leaguelogos/soccer/500-dark/2.png',
    name: 'UEFA Champions League',
    shortName: 'Champions',
    sport: 'futebol',
    scope: 'internacional',
    country: 'Europa',
    priority: 10,
    providers: { espn: 'soccer/uefa.champions', sportapiFootball: 'UEFA Champions League' }
  },
  {
    slug: 'europa-league',
    logo: 'https://a.espncdn.com/i/leaguelogos/soccer/500-dark/2310.png',
    name: 'UEFA Europa League',
    shortName: 'Europa League',
    sport: 'futebol',
    scope: 'internacional',
    country: 'Europa',
    priority: 10.5,
    providers: { espn: 'soccer/uefa.europa' }
  },
  {
    slug: 'premier-league',
    logo: 'https://a.espncdn.com/i/leaguelogos/soccer/500-dark/23.png',
    name: 'Premier League',
    shortName: 'Premier League',
    sport: 'futebol',
    scope: 'internacional',
    country: 'Inglaterra',
    priority: 11,
    providers: { espn: 'soccer/eng.1', sportapiFootball: 'Premier League' }
  },
  {
    slug: 'la-liga',
    logo: 'https://a.espncdn.com/i/leaguelogos/soccer/500-dark/15.png',
    name: 'La Liga',
    shortName: 'La Liga',
    sport: 'futebol',
    scope: 'internacional',
    country: 'Espanha',
    priority: 12,
    providers: { espn: 'soccer/esp.1', sportapiFootball: 'Spanish La Liga' }
  },
  {
    slug: 'serie-a-italia',
    logo: 'https://a.espncdn.com/i/leaguelogos/soccer/500-dark/12.png',
    name: 'Serie A (Itália)',
    shortName: 'Serie A',
    sport: 'futebol',
    scope: 'internacional',
    country: 'Itália',
    priority: 13,
    providers: { espn: 'soccer/ita.1', sportapiFootball: 'Italian Serie A' }
  },
  {
    slug: 'bundesliga',
    logo: 'https://a.espncdn.com/i/leaguelogos/soccer/500-dark/10.png',
    name: 'Bundesliga',
    shortName: 'Bundesliga',
    sport: 'futebol',
    scope: 'internacional',
    country: 'Alemanha',
    priority: 14,
    providers: { espn: 'soccer/ger.1', sportapiFootball: 'German Bundesliga' }
  },
  {
    slug: 'ligue-1',
    logo: 'https://a.espncdn.com/i/leaguelogos/soccer/500-dark/9.png',
    name: 'Ligue 1',
    shortName: 'Ligue 1',
    sport: 'futebol',
    scope: 'internacional',
    country: 'França',
    priority: 15,
    providers: { espn: 'soccer/fra.1', sportapiFootball: 'French Ligue 1' }
  },
  {
    slug: 'primeira-liga',
    logo: 'https://a.espncdn.com/i/leaguelogos/soccer/500-dark/14.png',
    name: 'Primeira Liga (Portugal)',
    shortName: 'Liga Portugal',
    sport: 'futebol',
    scope: 'internacional',
    country: 'Portugal',
    priority: 16,
    providers: { espn: 'soccer/por.1' }
  },
  // ------------------------------------------------------------ Basquete
  {
    slug: 'nba',
    logo: 'https://a.espncdn.com/i/teamlogos/leagues/500-dark/nba.png',
    name: 'NBA',
    shortName: 'NBA',
    sport: 'basquete',
    scope: 'internacional',
    country: 'Estados Unidos',
    priority: 20,
    providers: { espn: 'basketball/nba', sportapiBasketball: 'nba' }
  },
  // ---------------------------------------------------- Futebol americano
  {
    slug: 'nfl',
    logo: 'https://a.espncdn.com/i/teamlogos/leagues/500-dark/nfl.png',
    name: 'NFL',
    shortName: 'NFL',
    sport: 'futebol-americano',
    scope: 'internacional',
    country: 'Estados Unidos',
    priority: 25,
    providers: { espn: 'football/nfl' }
  },
  // ------------------------------------------------------- Automobilismo
  {
    slug: 'formula-1',
    logo: 'https://a.espncdn.com/i/teamlogos/leagues/500/f1.png',
    name: 'Fórmula 1',
    shortName: 'F1',
    sport: 'automobilismo',
    scope: 'internacional',
    priority: 30,
    providers: { f1: true }
  }
];
const bySlug = new Map(catalog.map((entry) => [entry.slug, entry]));
export function getCatalogEntry(slug) {
  return bySlug.get(slug);
}
/** Competição pública (sem o mapa de provedores). */
export function toCompetition(entry) {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { providers, ...competition } = entry;
  return competition;
}
/**
 * Seleções nacionais: não é uma competição acompanhada (não entra na coleta),
 * mas tem fichas de time e de atleta na ESPN, lidas sob demanda.
 */
export const NATIONAL_TEAMS = {
  slug: 'selecoes',
  name: 'Seleções',
  shortName: 'Seleções',
  sport: 'futebol',
  priority: 900,
  providers: { espn: 'soccer/fifa.world' }
};
/** Competição do catálogo ou a entrada das seleções. */
export function getLeague(slug) {
  return slug === NATIONAL_TEAMS.slug ? NATIONAL_TEAMS : getCatalogEntry(slug);
}
