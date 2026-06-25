export interface TeamInfo {
  abbr: string;
  name: string;
  aliases: string[];
}

export interface TeamRating {
  abbr: string;
  wins: number;
  losses: number;
  /** Average point differential per game (net rating proxy). */
  pointDiff: number;
  winPct: number;
}

export interface GameInfo {
  espnId: string;
  date: string; // YYYY-MM-DD (US/Eastern game date)
  homeAbbr: string;
  awayAbbr: string;
  startTimeUtc: string;
  completed: boolean;
  homeScore?: number;
  awayScore?: number;
}

export interface InjuryReport {
  teamAbbr: string;
  player: string;
  status: string; // Out, Doubtful, Questionable, Day-To-Day...
  detail?: string;
}

export interface NbaMarket {
  eventTitle: string;
  question: string;
  slug: string;
  conditionId: string;
  endDate?: string;
  gameStartTime?: string;
  liquidity?: number;
  volume?: number;
  /** Outcome labels, e.g. ["Lakers", "Celtics"] */
  outcomes: string[];
  /** Mid prices aligned with outcomes, each 0..1 */
  prices: number[];
  /** Resolved team abbrs aligned with outcomes; empty string when not a team. */
  teamAbbrs: string[];
}

export interface ManualAdjustment {
  /** Points added to the team's expected margin (negative = weaker, e.g. star out ≈ -2..-6). */
  points: number;
  reason: string;
}

export type AdjustmentsFile = Record<string, ManualAdjustment>;

/**
 * Manually-supplied data for one game. The session layer fills this from web
 * research when the live ESPN/Polymarket APIs are not reachable (blocked egress,
 * rate limits, etc.), so the calibrated model + threshold + logging stay identical.
 */
export interface ManualGameInput {
  /** Home team — abbreviation or any resolvable name ("Lakers", "LAL"). */
  home: string;
  /** Away team — abbreviation or any resolvable name. */
  away: string;
  /**
   * Polymarket prices for the two teams. Either keyed by team
   * ({ "LAL": 0.62, "BOS": 0.38 }) or as a [homePrice, awayPrice] tuple.
   * Need not sum to 1 — they are de-vigged before use.
   */
  marketPrices: Record<string, number> | [number, number];
  /** Home team's season average point differential per game (net-rating proxy). */
  homeNetRating: number;
  /** Away team's season average point differential per game. */
  awayNetRating: number;
  /** Optional home W-L, for display only. */
  homeRecord?: [number, number];
  /** Optional away W-L, for display only. */
  awayRecord?: [number, number];
  /**
   * Game-day point adjustments keyed by team, e.g. { "LAL": -3.5 } or
   * { "LAL": { points: -3.5, reason: "AD out" } }. Negative = team weaker tonight.
   */
  adjustments?: Record<string, number | ManualAdjustment>;
  /** Players to surface as listed Out/Doubtful in the rationale. */
  injuries?: Array<{ team: string; player: string; status: string }>;
  /** Optional Polymarket identifiers so saved picks can be graded/deduped. */
  slug?: string;
  conditionId?: string;
  question?: string;
}

/** A full manual slate the session layer hands to the model when APIs are blocked. */
export interface ManualInputFile {
  /** Game date in YYYY-MM-DD (US/Eastern). */
  date: string;
  games: ManualGameInput[];
}

export interface Prediction {
  ts: string;
  gameDate: string;
  slug: string;
  conditionId: string;
  question: string;
  pickTeam: string; // abbr
  pickOutcome: string; // outcome label as on Polymarket
  probability: number; // blended final probability of pick winning
  pModel: number;
  pMarket: number;
  edge: number; // probability - pMarket (positive = model likes pick more than market)
  threshold: number;
  rationale: string;
  status: 'pending' | 'correct' | 'incorrect' | 'void';
  actualWinner?: string;
}
