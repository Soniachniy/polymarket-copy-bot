import { blend, deVig, marginFromProb, modelHomeWinProb, normCdf, MARGIN_SIGMA } from './model.js';
import type { AdjustmentsFile, InjuryReport, Prediction, TeamRating } from './types.js';

export interface EvalInput {
  gameDate: string;
  slug: string;
  conditionId: string;
  question: string;
  homeAbbr: string;
  awayAbbr: string;
  /** Outcome labels aligned to `prices`, as shown on Polymarket. */
  outcomes: string[];
  /** Team abbrs aligned to `outcomes` ('' when an outcome is not a team). */
  teamAbbrs: string[];
  /** Index in `outcomes` of the home team. */
  homeIdx: number;
  /** Raw market prices aligned to `outcomes`, each 0..1. */
  prices: number[];
  homeRating?: TeamRating | undefined;
  awayRating?: TeamRating | undefined;
  adjustments: AdjustmentsFile;
  injuries: InjuryReport[];
  threshold: number;
}

export type EvalRow = Prediction & { pass: boolean; expectedMargin: number; notes: string[] };

function pct(p: number): string {
  return `${(p * 100).toFixed(1)}%`;
}

/**
 * Evaluate one matched game into a prediction row. Handles two regimes:
 *  - Ratings available: blend a normal-margin ratings model with the de-vigged market.
 *  - Ratings missing: fall back to the market price (already a sharp forecast) and,
 *    if adjustments are supplied, apply them to the market-implied margin so late
 *    news Claude believes is unpriced still moves the number.
 */
export function evaluateGame(input: EvalInput): EvalRow {
  const { homeRating, awayRating, adjustments, homeAbbr, awayAbbr, homeIdx } = input;
  const fair = deVig(input.prices);
  const pMarketHome = fair[homeIdx] ?? 0.5;

  const notes: string[] = [];
  let pModelHome: number;
  let expectedMargin: number;

  if (homeRating && awayRating) {
    const model = modelHomeWinProb({ home: homeRating, away: awayRating, adjustments });
    pModelHome = model.pHome;
    expectedMargin = model.expectedMargin;
    notes.push(...model.notes);
  } else {
    // Market-only: the price already encodes team strength. Apply any adjustments
    // to the market-implied margin so they still take effect.
    let margin = marginFromProb(pMarketHome);
    const homeAdj = adjustments[homeAbbr];
    if (homeAdj) {
      margin += homeAdj.points;
      notes.push(`${homeAbbr} ${homeAdj.points >= 0 ? '+' : ''}${homeAdj.points}: ${homeAdj.reason}`);
    }
    const awayAdj = adjustments[awayAbbr];
    if (awayAdj) {
      margin -= awayAdj.points;
      notes.push(`${awayAbbr} ${awayAdj.points >= 0 ? '+' : ''}${awayAdj.points}: ${awayAdj.reason}`);
    }
    notes.push('no season ratings; market-anchored');
    pModelHome = normCdf(margin / MARGIN_SIGMA);
    expectedMargin = margin;
  }

  const pHome = blend(pModelHome, pMarketHome);
  const pickIsHome = pHome >= 0.5;
  const pickIdx = pickIsHome ? homeIdx : 1 - homeIdx;
  const probability = pickIsHome ? pHome : 1 - pHome;
  const pModel = pickIsHome ? pModelHome : 1 - pModelHome;
  const pMarket = pickIsHome ? pMarketHome : 1 - pMarketHome;

  const teamInjuries = input.injuries.filter(
    (r) => (r.teamAbbr === homeAbbr || r.teamAbbr === awayAbbr) && /out|doubtful/i.test(r.status),
  );
  const injuryNote =
    teamInjuries.length > 0
      ? ` | listed Out/Doubtful: ${teamInjuries.map((r) => `${r.player} (${r.teamAbbr}, ${r.status})`).join(', ')}`
      : '';

  return {
    ts: new Date().toISOString(),
    gameDate: input.gameDate,
    slug: input.slug,
    conditionId: input.conditionId,
    question: input.question,
    pickTeam: input.teamAbbrs[pickIdx] || (pickIsHome ? homeAbbr : awayAbbr),
    pickOutcome: input.outcomes[pickIdx] ?? (pickIsHome ? homeAbbr : awayAbbr),
    probability,
    pModel,
    pMarket,
    edge: probability - pMarket,
    threshold: input.threshold,
    rationale:
      `margin ${expectedMargin >= 0 ? '+' : ''}${expectedMargin.toFixed(1)} home; ` +
      `model ${pct(pModel)}, market ${pct(pMarket)}` +
      (notes.length ? ` | ${notes.join('; ')}` : '') +
      injuryNote,
    status: 'pending',
    pass: probability >= input.threshold,
    expectedMargin,
    notes,
  };
}
