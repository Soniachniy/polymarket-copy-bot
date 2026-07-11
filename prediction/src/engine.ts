import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { blend, deVig, MARKET_FLOOR, modelHomeWinProb } from './model.js';
import type { AdjustmentsFile, Prediction, TeamRating } from './types.js';

/** A prediction plus the transient fields used for display/selection but not persisted. */
export type PredictionRow = Prediction & {
  pass: boolean;
  /** Cleared the confidence threshold but was blocked because the market wasn't a clear enough favorite. */
  floorGated: boolean;
  marketFloor: number;
  expectedMargin: number;
  notes: string[];
};

export interface BuildRowInput {
  gameDate: string;
  slug: string;
  conditionId: string;
  question: string;
  home: TeamRating;
  away: TeamRating;
  /** Outcome labels exactly as they appear on Polymarket, e.g. ["Lakers", "Celtics"]. */
  outcomes: string[];
  /** Team abbrs aligned with `outcomes`. */
  teamAbbrs: string[];
  /** Mid prices aligned with `outcomes`, each 0..1. */
  prices: number[];
  /** Index in `outcomes` of the home team. */
  homeIdx: number;
  adjustments: AdjustmentsFile;
  threshold: number;
  /** De-vigged market probability the picked side must also clear. Defaults to MARKET_FLOOR. */
  marketFloor?: number | undefined;
  /** Optional extra rationale text (e.g. listed injuries) appended verbatim. */
  extraNote?: string;
}

export function pct(p: number): string {
  return `${(p * 100).toFixed(1)}%`;
}

/**
 * Core of the service: run the ratings model, blend with the de-vigged market price,
 * pick the more-likely side, and decide whether it clears the confidence threshold.
 * Shared by the live-API path and the manual web-research (slate) path so both produce
 * identical, calibrated output.
 */
export function buildPredictionRow(input: BuildRowInput): PredictionRow {
  const model = modelHomeWinProb({ home: input.home, away: input.away, adjustments: input.adjustments });
  const fair = deVig(input.prices);
  const pMarketHome = fair[input.homeIdx] ?? 0.5;
  const pHome = blend(model.pHome, pMarketHome);

  const pickIsHome = pHome >= 0.5;
  const pickIdx = pickIsHome ? input.homeIdx : 1 - input.homeIdx;
  const probability = pickIsHome ? pHome : 1 - pHome;
  const pModel = pickIsHome ? model.pHome : 1 - model.pHome;
  const pMarket = pickIsHome ? pMarketHome : 1 - pMarketHome;

  const marketFloor = input.marketFloor ?? MARKET_FLOOR;
  const clearsThreshold = probability >= input.threshold;
  const clearsFloor = pMarket >= marketFloor;
  const pass = clearsThreshold && clearsFloor;
  const floorGated = clearsThreshold && !clearsFloor;

  return {
    ts: new Date().toISOString(),
    gameDate: input.gameDate,
    slug: input.slug,
    conditionId: input.conditionId,
    question: input.question,
    pickTeam: input.teamAbbrs[pickIdx]!,
    pickOutcome: input.outcomes[pickIdx]!,
    probability,
    pModel,
    pMarket,
    edge: probability - pMarket,
    threshold: input.threshold,
    rationale:
      `margin ${model.expectedMargin >= 0 ? '+' : ''}${model.expectedMargin.toFixed(1)} home; ` +
      `model ${pct(pModel)}, market ${pct(pMarket)}` +
      (floorGated ? ` | GATED: market ${pct(pMarket)} < floor ${pct(marketFloor)} (model-driven, skipped)` : '') +
      (model.notes.length ? ` | adj: ${model.notes.join('; ')}` : '') +
      (input.extraNote ?? ''),
    status: 'pending',
    pass,
    floorGated,
    marketFloor,
    expectedMargin: model.expectedMargin,
    notes: model.notes,
  };
}

/** Append passing picks to the JSONL log, skipping markets already recorded. Returns count saved. */
export function savePicks(logFile: string, dataDir: string, picks: PredictionRow[]): number {
  if (picks.length === 0) return 0;
  mkdirSync(dataDir, { recursive: true });
  const existing = existsSync(logFile) ? readFileSync(logFile, 'utf8') : '';
  let saved = 0;
  for (const r of picks) {
    if (r.conditionId && existing.includes(r.conditionId)) continue; // don't double-log a market
    if (!r.conditionId && existing.includes(`"slug":"${r.slug}"`) && r.slug) continue; // fall back to slug de-dup
    const { pass: _pass, floorGated: _fg, marketFloor: _mf, expectedMargin: _m, notes: _n, ...record } = r;
    appendFileSync(logFile, JSON.stringify(record) + '\n');
    saved++;
  }
  return saved;
}

/** Pretty-print a row to stdout. */
export function printRow(r: PredictionRow): void {
  const tag = r.pass ? 'PICK' : r.floorGated ? 'gate' : 'pass';
  console.log(
    `[${tag}] ${r.gameDate}  ${r.question}\n` +
      `       -> ${r.pickOutcome} (${r.pickTeam})  conf ${pct(r.probability)}  ` +
      `(model ${pct(r.pModel)} / market ${pct(r.pMarket)}, edge ${(r.edge * 100).toFixed(1)}pp)\n` +
      `       ${r.rationale}\n`,
  );
}
