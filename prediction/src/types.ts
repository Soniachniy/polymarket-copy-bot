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
