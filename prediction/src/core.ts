import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { blend, deVig, modelHomeWinProb } from './model.js';
import type {
  AdjustmentsFile,
  InjuryReport,
  Prediction,
  TeamRating,
} from './types.js';

/** A scored prediction plus the transient fields the CLI needs but does not persist. */
export type PickRow = Prediction & {
  pass: boolean;
  expectedMargin: number;
  notes: string[];
  /** false when no market price was available and the pick is model-only. */
  hasMarket: boolean;
};

export function pct(p: number): string {
  return `${(p * 100).toFixed(1)}%`;
}

export interface BuildRowInput {
  gameDate: string;
  slug: string;
  conditionId: string;
  question: string;
  homeAbbr: string;
  awayAbbr: string;
  homeOutcome: string;
  awayOutcome: string;
  homeRating: TeamRating;
  awayRating: TeamRating;
  /** De-vigged Polymarket probability that the HOME team wins, 0..1. Omit if no market. */
  marketHomeProb?: number;
  injuries: InjuryReport[];
  adjustments: AdjustmentsFile;
  threshold: number;
}

/**
 * The single scoring path shared by the live pipeline and the offline
 * session-injected pipeline. Blends the ratings model with the de-vigged
 * market price; when no market price exists it falls back to model-only.
 */
export function buildPickRow(inp: BuildRowInput): PickRow {
  const model = modelHomeWinProb({
    home: inp.homeRating,
    away: inp.awayRating,
    adjustments: inp.adjustments,
  });

  const hasMarket =
    typeof inp.marketHomeProb === 'number' &&
    inp.marketHomeProb > 0 &&
    inp.marketHomeProb < 1;
  const pMarketHome = hasMarket ? inp.marketHomeProb! : model.pHome;
  // Model-only when no market: marketWeight 0 so the blend returns the model.
  const pHome = hasMarket ? blend(model.pHome, pMarketHome) : model.pHome;

  const pickIsHome = pHome >= 0.5;
  const probability = pickIsHome ? pHome : 1 - pHome;
  const pModel = pickIsHome ? model.pHome : 1 - model.pHome;
  const pMarket = pickIsHome ? pMarketHome : 1 - pMarketHome;
  const pickTeam = pickIsHome ? inp.homeAbbr : inp.awayAbbr;
  const pickOutcome = pickIsHome ? inp.homeOutcome : inp.awayOutcome;

  const teamInjuries = inp.injuries.filter(
    (r) =>
      (r.teamAbbr === inp.homeAbbr || r.teamAbbr === inp.awayAbbr) &&
      /out|doubtful/i.test(r.status),
  );
  const injuryNote =
    teamInjuries.length > 0
      ? ` | listed Out/Doubtful: ${teamInjuries
          .map((r) => `${r.player} (${r.teamAbbr}, ${r.status})`)
          .join(', ')}`
      : '';

  const marketNote = hasMarket
    ? `model ${pct(pModel)}, market ${pct(pMarket)}`
    : `model ${pct(pModel)} (NO MARKET PRICE — model-only, treat with caution)`;

  return {
    ts: new Date().toISOString(),
    gameDate: inp.gameDate,
    slug: inp.slug,
    conditionId: inp.conditionId,
    question: inp.question,
    pickTeam,
    pickOutcome,
    probability,
    pModel,
    pMarket,
    edge: probability - pMarket,
    threshold: inp.threshold,
    rationale:
      `margin ${model.expectedMargin >= 0 ? '+' : ''}${model.expectedMargin.toFixed(1)} home; ` +
      marketNote +
      (model.notes.length ? ` | adj: ${model.notes.join('; ')}` : '') +
      injuryNote,
    status: 'pending',
    pass: probability >= inp.threshold && hasMarket,
    expectedMargin: model.expectedMargin,
    notes: model.notes,
    hasMarket,
  };
}

/** De-vig a two-outcome market and return the home-team probability. */
export function marketHomeProb(prices: number[], homeIdx: number): number | undefined {
  if (prices.length !== 2) return undefined;
  const fair = deVig(prices);
  return fair[homeIdx];
}

export function renderRows(rows: PickRow[], showAll: boolean, threshold: number): string {
  const out: string[] = [];
  out.push(`\n=== NBA predictions (threshold ${pct(threshold)}) ===\n`);
  const picks = rows.filter((r) => r.pass);
  const shown = showAll ? rows : picks;
  for (const r of shown) {
    const tag = r.pass ? 'PICK' : 'pass';
    out.push(
      `[${tag}] ${r.gameDate}  ${r.question}\n` +
        `       -> ${r.pickOutcome} (${r.pickTeam})  conf ${pct(r.probability)}  ` +
        `(model ${pct(r.pModel)} / market ${r.hasMarket ? pct(r.pMarket) : 'n/a'}, edge ${(r.edge * 100).toFixed(1)}pp)\n` +
        `       ${r.rationale}\n`,
    );
  }
  if (picks.length === 0) {
    out.push(
      'No games clear the confidence threshold today. Skipping is the correct output — ' +
        'forcing picks on coin-flip games is what destroys accuracy.\n',
    );
  }
  out.push(`${picks.length} pick(s) / ${rows.length} matched game(s).`);
  return out.join('\n');
}

/** Append passing picks to the JSONL log, de-duplicated by conditionId. */
export function saveRows(rows: PickRow[], logFile: string): number {
  const picks = rows.filter((r) => r.pass);
  if (picks.length === 0) return 0;
  mkdirSync(dirname(logFile), { recursive: true });
  const existing = existsSync(logFile) ? readFileSync(logFile, 'utf8') : '';
  let saved = 0;
  for (const r of picks) {
    if (r.conditionId && existing.includes(r.conditionId)) continue;
    const { pass: _p, expectedMargin: _m, notes: _n, hasMarket: _h, ...record } = r;
    appendFileSync(logFile, JSON.stringify(record) + '\n');
    saved++;
  }
  return saved;
}
