import type { AdjustmentsFile, GameInfo, NbaMarket, TeamRating } from './types.js';

/** Home-court advantage in points (league-average, recent seasons). */
export const HOME_COURT_POINTS = 2.6;
/** Std dev of NBA game margin vs expectation, in points. */
export const MARGIN_SIGMA = 11.5;
/** Weight on the market's implied probability in the final blend. Markets are sharp; respect them. */
export const MARKET_WEIGHT = 0.65;

/** Standard normal CDF via Abramowitz-Stegun erf approximation. */
export function normCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  let p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  if (x > 0) p = 1 - p;
  return p;
}

export interface ModelInput {
  home: TeamRating;
  away: TeamRating;
  adjustments: AdjustmentsFile;
}

export interface ModelOutput {
  expectedMargin: number; // home minus away, points
  pHome: number;
  notes: string[];
}

export function modelHomeWinProb(input: ModelInput): ModelOutput {
  const { home, away, adjustments } = input;
  const notes: string[] = [];
  let margin = home.pointDiff - away.pointDiff + HOME_COURT_POINTS;
  const homeAdj = adjustments[home.abbr];
  if (homeAdj) {
    margin += homeAdj.points;
    notes.push(`${home.abbr} ${homeAdj.points >= 0 ? '+' : ''}${homeAdj.points}: ${homeAdj.reason}`);
  }
  const awayAdj = adjustments[away.abbr];
  if (awayAdj) {
    margin -= awayAdj.points;
    notes.push(`${away.abbr} ${awayAdj.points >= 0 ? '+' : ''}${awayAdj.points}: ${awayAdj.reason}`);
  }
  return { expectedMargin: margin, pHome: normCdf(margin / MARGIN_SIGMA), notes };
}

/** Market mid prices for a two-outcome market, normalized to remove any spread/vig. */
export function deVig(prices: number[]): number[] {
  const sum = prices.reduce((a, b) => a + b, 0);
  if (sum <= 0) return prices.map(() => 0.5);
  return prices.map((p) => p / sum);
}

export interface MatchedGame {
  market: NbaMarket;
  game: GameInfo;
  /** index in market.outcomes of the home team */
  homeIdx: number;
}

/** Match moneyline markets to ESPN games of the given dates by the pair of team abbrs. */
export function matchMarketsToGames(markets: NbaMarket[], games: GameInfo[]): MatchedGame[] {
  const out: MatchedGame[] = [];
  for (const market of markets) {
    const [a, b] = market.teamAbbrs;
    if (!a || !b) continue;
    const game = games.find(
      (g) =>
        (g.homeAbbr === a && g.awayAbbr === b) ||
        (g.homeAbbr === b && g.awayAbbr === a),
    );
    if (!game) continue;
    out.push({ market, game, homeIdx: market.teamAbbrs.indexOf(game.homeAbbr) });
  }
  return out;
}

export function blend(pModel: number, pMarket: number, marketWeight = MARKET_WEIGHT): number {
  return marketWeight * pMarket + (1 - marketWeight) * pModel;
}

/**
 * The selectivity rule that the ~80% target rests on: a pick qualifies only when the
 * blended confidence clears the threshold AND the de-vigged market also rates the pick
 * a genuine favorite (>= floor). The market gate stops the model from chasing a
 * contrarian edge on an underdog, which is where overconfidence loses games.
 */
export function qualifies(
  probability: number,
  pMarket: number,
  threshold: number,
  marketFloor: number,
): boolean {
  return probability >= threshold && pMarket >= marketFloor;
}
