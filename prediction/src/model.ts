import type { AdjustmentsFile, GameInfo, NbaMarket, TeamRating } from './types.js';

/** Home-court advantage in points (league-average, recent seasons). */
export const HOME_COURT_POINTS = 2.6;
/** Std dev of NBA game margin vs expectation, in points. */
export const MARGIN_SIGMA = 11.5;
/** Weight on the market's implied probability in the final blend. Markets are sharp; respect them. */
export const MARKET_WEIGHT = 0.65;
/**
 * Hard floor on the de-vigged market probability of the picked side. A game may clear the
 * blended-confidence threshold on the strength of the model alone (35% weight) even when the
 * market only rates the team a mild favorite — e.g. blend 0.78 is reachable with the market at
 * just 0.66, which loses ~1 in 3, blowing the 1-in-5 budget. The market is the sharpest public
 * forecast, so we additionally require it to call the pick a clear favorite. This turns the
 * skill's "trust the market, skip model-driven outliers" guidance into a code invariant enforced
 * identically on the live and slate paths. Overridable per-run.
 */
export const MARKET_FLOOR = 0.7;

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
