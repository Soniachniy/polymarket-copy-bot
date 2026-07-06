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
 * A self-contained per-game record produced by the session layer (Claude with
 * web search) when the sandbox cannot reach the live APIs directly. Everything
 * the deterministic model needs is inlined so no network access is required.
 */
export interface InputGame {
  gameDate: string; // YYYY-MM-DD
  homeAbbr: string;
  awayAbbr: string;
  /** Season net rating / point differential per game for each side. */
  homePointDiff: number;
  awayPointDiff: number;
  homeRecord?: [wins: number, losses: number];
  awayRecord?: [wins: number, losses: number];
  /** De-vigged Polymarket probability the HOME team wins (0..1). Omit if unknown. */
  marketHomeProb?: number;
  /** Outcome labels exactly as they appear on Polymarket (default: team abbr). */
  homeOutcome?: string;
  awayOutcome?: string;
  slug?: string;
  conditionId?: string;
  question?: string;
  injuries?: InjuryReport[];
  /** Per-game point adjustments keyed by team abbr (rest, motivation, late news). */
  adjustments?: AdjustmentsFile;
}

export interface InputBundle {
  /** Optional slate date for reference / logging. */
  date?: string;
  games: InputGame[];
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
