import { readFileSync } from 'node:fs';
import { resolveTeam } from './teams.js';
import type { GameInfo, InjuryReport, NbaMarket, TeamRating } from './types.js';

/**
 * Session-gathered slate. Produced by the /nba-predict skill using WebSearch /
 * WebFetch when the live Polymarket + ESPN endpoints are blocked by the
 * environment's network egress policy. The shape is deliberately loose and
 * human-authorable: team references may be abbreviations ("BOS") or names
 * ("Boston Celtics"); prices may be probabilities (0.72) or cents (72).
 */
export interface SessionInputGame {
  date: string; // YYYY-MM-DD, the game's US/Eastern date
  home: string; // team name or abbreviation
  away: string;
  /** Polymarket implied win probability for the home side. 0..1, or cents (>1). */
  homePrice: number;
  /** Polymarket implied win probability for the away side. 0..1, or cents (>1). */
  awayPrice: number;
  question?: string;
  slug?: string;
  conditionId?: string;
}

export interface SessionInputRating {
  /** Season average point differential per game (net rating proxy), home-team convention. */
  pointDiff: number;
  wins?: number;
  losses?: number;
}

export interface SessionInput {
  games: SessionInputGame[];
  ratings: Record<string, SessionInputRating>;
  injuries?: InjuryReport[];
}

export interface LoadedSlate {
  markets: NbaMarket[];
  ratings: Map<string, TeamRating>;
  injuries: InjuryReport[];
  games: GameInfo[];
}

/** Normalize a price that may be given as a probability (0..1) or as cents (0..100). */
function normalizePrice(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return value > 1 ? value / 100 : value;
}

function requireAbbr(ref: string, context: string): string {
  const abbr = resolveTeam(ref);
  if (!abbr) {
    throw new Error(
      `Could not resolve team "${ref}" (${context}). Use an NBA team name or abbreviation, e.g. "BOS" or "Boston Celtics".`,
    );
  }
  return abbr;
}

export function parseSessionInput(raw: SessionInput): LoadedSlate {
  if (!raw || !Array.isArray(raw.games)) {
    throw new Error('Session input must be an object with a "games" array. See prediction/README.md.');
  }
  if (!raw.ratings || typeof raw.ratings !== 'object') {
    throw new Error('Session input must include a "ratings" object keyed by team.');
  }

  const ratings = new Map<string, TeamRating>();
  for (const [key, r] of Object.entries(raw.ratings)) {
    const abbr = requireAbbr(key, 'ratings key');
    const wins = r.wins ?? 0;
    const losses = r.losses ?? 0;
    const total = wins + losses;
    ratings.set(abbr, {
      abbr,
      wins,
      losses,
      pointDiff: Number(r.pointDiff) || 0,
      winPct: total > 0 ? wins / total : 0.5,
    });
  }

  const markets: NbaMarket[] = [];
  const games: GameInfo[] = [];
  for (const g of raw.games) {
    const homeAbbr = requireAbbr(g.home, `game ${g.away} @ ${g.home} home`);
    const awayAbbr = requireAbbr(g.away, `game ${g.away} @ ${g.home} away`);
    const homePrice = normalizePrice(g.homePrice);
    const awayPrice = normalizePrice(g.awayPrice);
    const conditionId = g.conditionId || g.slug || `${g.date}-${awayAbbr}-at-${homeAbbr}`;
    const question = g.question || `${awayAbbr} @ ${homeAbbr}`;

    games.push({
      espnId: '',
      date: g.date,
      homeAbbr,
      awayAbbr,
      startTimeUtc: '',
      completed: false,
    });

    // Outcomes are listed home-first so homeIdx resolves to 0 in matching.
    markets.push({
      eventTitle: question,
      question,
      slug: g.slug || conditionId,
      conditionId,
      outcomes: [homeAbbr, awayAbbr],
      prices: [homePrice, awayPrice],
      teamAbbrs: [homeAbbr, awayAbbr],
    });
  }

  const injuries: InjuryReport[] = (raw.injuries ?? []).map((r) => ({
    teamAbbr: resolveTeam(r.teamAbbr) ?? r.teamAbbr,
    player: r.player,
    status: r.status,
    ...(r.detail ? { detail: r.detail } : {}),
  }));

  return { markets, ratings, injuries, games };
}

export function loadSessionInput(path: string): LoadedSlate {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as SessionInput;
  return parseSessionInput(raw);
}
