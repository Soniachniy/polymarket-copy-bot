import { readFileSync } from 'node:fs';
import type { EvalInput } from './evaluate.js';
import { resolveTeam } from './teams.js';
import type { AdjustmentsFile, InjuryReport, ManualFile, ManualGame, TeamRating } from './types.js';

/** Resolve a name/abbr to an abbr, throwing a clear error if it can't. */
function abbrOf(text: string, context: string): string {
  const abbr = resolveTeam(text);
  if (!abbr) throw new Error(`Could not resolve team "${text}" in ${context}. Use a name or abbr.`);
  return abbr;
}

function ratingFor(abbr: string, netRating: number | undefined): TeamRating | undefined {
  if (netRating === undefined) return undefined;
  return { abbr, wins: 0, losses: 0, pointDiff: netRating, winPct: 0.5 };
}

/**
 * Convert one hand-authored game into the engine's evaluation input.
 * Outcomes are ordered [home, away] so `homeIdx` is always 0 here.
 */
export function manualGameToInput(g: ManualGame, date: string, threshold: number): EvalInput {
  const homeAbbr = abbrOf(g.home, 'manual game');
  const awayAbbr = abbrOf(g.away, 'manual game');

  const marketHome = g.marketHome ?? (g.marketAway !== undefined ? 1 - g.marketAway : 0.5);
  const marketAway = g.marketAway ?? 1 - marketHome;

  const adjustments: AdjustmentsFile = {};
  for (const a of g.adjustments ?? []) {
    const t = abbrOf(a.team, 'adjustment');
    adjustments[t] = { points: a.points, reason: a.reason };
  }

  const injuries: InjuryReport[] = []; // manual adjustments already encode injury impact

  return {
    gameDate: date,
    slug: g.slug ?? `manual-${awayAbbr.toLowerCase()}-${homeAbbr.toLowerCase()}-${date}`,
    conditionId: g.conditionId ?? '',
    question: g.question ?? `${awayAbbr} @ ${homeAbbr}`,
    homeAbbr,
    awayAbbr,
    outcomes: [homeAbbr, awayAbbr],
    teamAbbrs: [homeAbbr, awayAbbr],
    homeIdx: 0,
    prices: [marketHome, marketAway],
    homeRating: ratingFor(homeAbbr, g.homeNetRating),
    awayRating: ratingFor(awayAbbr, g.awayNetRating),
    adjustments,
    injuries,
    threshold,
  };
}

export function loadManualInputs(path: string, threshold: number): EvalInput[] {
  const file = JSON.parse(readFileSync(path, 'utf8')) as ManualFile;
  if (!file.date) throw new Error(`Manual file ${path} is missing a top-level "date" (YYYY-MM-DD).`);
  if (!Array.isArray(file.games) || file.games.length === 0) {
    throw new Error(`Manual file ${path} has no games.`);
  }
  return file.games.map((g) => manualGameToInput(g, file.date, threshold));
}
