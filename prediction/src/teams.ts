import type { TeamInfo } from './types.js';

export const NBA_TEAMS: TeamInfo[] = [
  { abbr: 'ATL', name: 'Atlanta Hawks', aliases: ['hawks', 'atlanta'] },
  { abbr: 'BOS', name: 'Boston Celtics', aliases: ['celtics', 'boston'] },
  { abbr: 'BKN', name: 'Brooklyn Nets', aliases: ['nets', 'brooklyn'] },
  { abbr: 'CHA', name: 'Charlotte Hornets', aliases: ['hornets', 'charlotte'] },
  { abbr: 'CHI', name: 'Chicago Bulls', aliases: ['bulls', 'chicago'] },
  { abbr: 'CLE', name: 'Cleveland Cavaliers', aliases: ['cavaliers', 'cavs', 'cleveland'] },
  { abbr: 'DAL', name: 'Dallas Mavericks', aliases: ['mavericks', 'mavs', 'dallas'] },
  { abbr: 'DEN', name: 'Denver Nuggets', aliases: ['nuggets', 'denver'] },
  { abbr: 'DET', name: 'Detroit Pistons', aliases: ['pistons', 'detroit'] },
  { abbr: 'GSW', name: 'Golden State Warriors', aliases: ['warriors', 'golden state', 'gs'] },
  { abbr: 'HOU', name: 'Houston Rockets', aliases: ['rockets', 'houston'] },
  { abbr: 'IND', name: 'Indiana Pacers', aliases: ['pacers', 'indiana'] },
  { abbr: 'LAC', name: 'LA Clippers', aliases: ['clippers', 'la clippers', 'los angeles clippers'] },
  { abbr: 'LAL', name: 'Los Angeles Lakers', aliases: ['lakers', 'la lakers', 'los angeles lakers'] },
  { abbr: 'MEM', name: 'Memphis Grizzlies', aliases: ['grizzlies', 'memphis'] },
  { abbr: 'MIA', name: 'Miami Heat', aliases: ['heat', 'miami'] },
  { abbr: 'MIL', name: 'Milwaukee Bucks', aliases: ['bucks', 'milwaukee'] },
  { abbr: 'MIN', name: 'Minnesota Timberwolves', aliases: ['timberwolves', 'wolves', 'minnesota'] },
  { abbr: 'NOP', name: 'New Orleans Pelicans', aliases: ['pelicans', 'new orleans'] },
  { abbr: 'NYK', name: 'New York Knicks', aliases: ['knicks', 'new york'] },
  { abbr: 'OKC', name: 'Oklahoma City Thunder', aliases: ['thunder', 'oklahoma city', 'okc'] },
  { abbr: 'ORL', name: 'Orlando Magic', aliases: ['magic', 'orlando'] },
  { abbr: 'PHI', name: 'Philadelphia 76ers', aliases: ['76ers', 'sixers', 'philadelphia'] },
  { abbr: 'PHX', name: 'Phoenix Suns', aliases: ['suns', 'phoenix', 'phx'] },
  { abbr: 'POR', name: 'Portland Trail Blazers', aliases: ['trail blazers', 'blazers', 'portland'] },
  { abbr: 'SAC', name: 'Sacramento Kings', aliases: ['kings', 'sacramento'] },
  { abbr: 'SAS', name: 'San Antonio Spurs', aliases: ['spurs', 'san antonio', 'sa'] },
  { abbr: 'TOR', name: 'Toronto Raptors', aliases: ['raptors', 'toronto'] },
  { abbr: 'UTA', name: 'Utah Jazz', aliases: ['jazz', 'utah'] },
  { abbr: 'WAS', name: 'Washington Wizards', aliases: ['wizards', 'washington', 'wsh'] },
];

/** ESPN occasionally uses different abbreviations than ours. */
const ESPN_ABBR_MAP: Record<string, string> = {
  GS: 'GSW',
  NO: 'NOP',
  NY: 'NYK',
  SA: 'SAS',
  UTAH: 'UTA',
  WSH: 'WAS',
  PHO: 'PHX',
};

export function normalizeEspnAbbr(abbr: string): string {
  const upper = abbr.toUpperCase();
  return ESPN_ABBR_MAP[upper] ?? upper;
}

/** Resolve a free-text team reference ("Lakers", "Los Angeles Lakers", "LAL") to an abbr, or null. */
export function resolveTeam(text: string): string | null {
  const t = text.trim().toLowerCase();
  if (!t) return null;
  for (const team of NBA_TEAMS) {
    if (t === team.abbr.toLowerCase() || t === team.name.toLowerCase()) return team.abbr;
  }
  for (const team of NBA_TEAMS) {
    if (team.aliases.some((a) => t === a)) return team.abbr;
  }
  // Substring match as a last resort (longest alias first to avoid "la" style collisions).
  const candidates: { abbr: string; len: number }[] = [];
  for (const team of NBA_TEAMS) {
    for (const a of [team.name.toLowerCase(), ...team.aliases]) {
      if (a.length >= 4 && t.includes(a)) candidates.push({ abbr: team.abbr, len: a.length });
    }
  }
  candidates.sort((a, b) => b.len - a.len);
  return candidates[0]?.abbr ?? null;
}
