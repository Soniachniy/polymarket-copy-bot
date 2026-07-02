import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { blend, deVig, modelHomeWinProb } from './model.js';
import type { AdjustmentsFile, Prediction, TeamRating } from './types.js';

export const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
export const LOG_FILE = join(DATA_DIR, 'predictions.jsonl');
export const ADJUSTMENTS_FILE = join(DATA_DIR, 'adjustments.json');

/** Default confidence gate. A pick is only emitted when blended P(win) clears this. */
export const DEFAULT_THRESHOLD = 0.78;

/**
 * One game's inputs, however they were sourced (direct API or in-session research).
 * `homeDiff`/`awayDiff` are average point differentials per game (net-rating proxy).
 * `marketHome`/`marketAway` are the raw Polymarket outcome prices (they get de-vigged here).
 */
export interface ForecastInput {
  gameDate: string;
  slug: string;
  conditionId: string;
  question: string;
  homeAbbr: string;
  awayAbbr: string;
  homeDiff: number;
  awayDiff: number;
  marketHome: number;
  marketAway: number;
  /** Points added to a side's expected margin (negative = weaker). Keyed by abbr. */
  adjustments?: AdjustmentsFile;
  /** Free-text note (e.g. listed injuries) appended to the rationale. */
  extraNote?: string;
}

export type ForecastRow = Prediction & {
  pass: boolean;
  expectedMargin: number;
  notes: string[];
};

export function pct(p: number): string {
  return `${(p * 100).toFixed(1)}%`;
}

function ratingFor(abbr: string, pointDiff: number): TeamRating {
  // Only abbr + pointDiff feed the model; the rest are unused placeholders.
  return { abbr, wins: 0, losses: 0, pointDiff, winPct: 0.5 };
}

/**
 * Turn one game's inputs into a graded forecast row using the shared model:
 * ratings model -> blend with de-vigged market price -> pick the favored side.
 * This is the single source of truth for the math; both predict.ts (live API)
 * and compute.ts (in-session data) call it so results are identical.
 */
export function forecastGame(input: ForecastInput, threshold: number): ForecastRow {
  const adjustments = input.adjustments ?? {};
  const home = ratingFor(input.homeAbbr, input.homeDiff);
  const away = ratingFor(input.awayAbbr, input.awayDiff);
  const model = modelHomeWinProb({ home, away, adjustments });

  const fair = deVig([input.marketHome, input.marketAway]);
  const pMarketHome = fair[0] ?? 0.5;
  const pHome = blend(model.pHome, pMarketHome);

  const pickIsHome = pHome >= 0.5;
  const probability = pickIsHome ? pHome : 1 - pHome;
  const pModel = pickIsHome ? model.pHome : 1 - model.pHome;
  const pMarket = pickIsHome ? pMarketHome : 1 - pMarketHome;
  const pickTeam = pickIsHome ? input.homeAbbr : input.awayAbbr;
  const pickOutcome = pickTeam;

  const note = input.extraNote ? ` | ${input.extraNote}` : '';

  return {
    ts: new Date().toISOString(),
    gameDate: input.gameDate,
    slug: input.slug,
    conditionId: input.conditionId,
    question: input.question,
    pickTeam,
    pickOutcome,
    probability,
    pModel,
    pMarket,
    edge: probability - pMarket,
    threshold,
    rationale:
      `margin ${model.expectedMargin >= 0 ? '+' : ''}${model.expectedMargin.toFixed(1)} home; ` +
      `model ${pct(pModel)}, market ${pct(pMarket)}` +
      (model.notes.length ? ` | adj: ${model.notes.join('; ')}` : '') +
      note,
    status: 'pending',
    pass: probability >= threshold,
    expectedMargin: model.expectedMargin,
    notes: model.notes,
  };
}

export function loadAdjustments(): AdjustmentsFile {
  if (!existsSync(ADJUSTMENTS_FILE)) return {};
  return JSON.parse(readFileSync(ADJUSTMENTS_FILE, 'utf8')) as AdjustmentsFile;
}

/** Append passing picks to the JSONL log, skipping any market already recorded. */
export function savePicks(picks: ForecastRow[]): number {
  if (picks.length === 0) return 0;
  mkdirSync(DATA_DIR, { recursive: true });
  const existing = existsSync(LOG_FILE) ? readFileSync(LOG_FILE, 'utf8') : '';
  let saved = 0;
  for (const r of picks) {
    if (r.conditionId && existing.includes(r.conditionId)) continue; // don't double-log a market
    const { pass: _pass, expectedMargin: _m, notes: _n, ...record } = r;
    appendFileSync(LOG_FILE, JSON.stringify(record) + '\n');
    saved++;
  }
  return saved;
}

/** Human-readable one-block summary of a forecast row. */
export function formatRow(r: ForecastRow): string {
  const tag = r.pass ? 'PICK' : 'pass';
  return (
    `[${tag}] ${r.gameDate}  ${r.question}\n` +
    `       -> ${r.pickOutcome} (${r.pickTeam})  conf ${pct(r.probability)}  ` +
    `(model ${pct(r.pModel)} / market ${pct(r.pMarket)}, edge ${(r.edge * 100).toFixed(1)}pp)\n` +
    `       ${r.rationale}\n`
  );
}
