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

/** Inverse standard normal CDF (Acklam's rational approximation), for p in (0,1). */
export function invNormCdf(p: number): number {
  const pc = Math.min(Math.max(p, 1e-9), 1 - 1e-9);
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pLow = 0.02425;
  const pHigh = 1 - pLow;
  let q: number, r: number;
  if (pc < pLow) {
    q = Math.sqrt(-2 * Math.log(pc));
    return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
      ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  if (pc <= pHigh) {
    q = pc - 0.5;
    r = q * q;
    return (((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q /
      (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
  }
  q = Math.sqrt(-2 * Math.log(1 - pc));
  return -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
    ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
}

/** The point margin implied by a win probability, using the league margin sigma. */
export function marginFromProb(p: number): number {
  return MARGIN_SIGMA * invNormCdf(p);
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
