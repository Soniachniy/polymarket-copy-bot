import { buildPickRow, type PickRow } from './core.js';
import { normalizeEspnAbbr } from './teams.js';
import type { InputBundle, InputGame, TeamRating } from './types.js';

function ratingFrom(abbr: string, pointDiff: number, record?: [number, number]): TeamRating {
  const [wins, losses] = record ?? [0, 0];
  const games = wins + losses;
  return { abbr, wins, losses, pointDiff, winPct: games > 0 ? wins / games : 0.5 };
}

function slugFor(g: InputGame): string {
  return g.slug ?? `${g.awayAbbr}-${g.homeAbbr}-${g.gameDate}`.toLowerCase();
}

/** Turn a session-provided input bundle into scored prediction rows (no network). */
export function rowsFromBundle(bundle: InputBundle, threshold: number): PickRow[] {
  const rows: PickRow[] = [];
  for (const raw of bundle.games) {
    const homeAbbr = normalizeEspnAbbr(raw.homeAbbr);
    const awayAbbr = normalizeEspnAbbr(raw.awayAbbr);
    rows.push(
      buildPickRow({
        gameDate: raw.gameDate,
        slug: slugFor(raw),
        conditionId: raw.conditionId ?? slugFor(raw),
        question: raw.question ?? `${awayAbbr} @ ${homeAbbr}`,
        homeAbbr,
        awayAbbr,
        homeOutcome: raw.homeOutcome ?? homeAbbr,
        awayOutcome: raw.awayOutcome ?? awayAbbr,
        homeRating: ratingFrom(homeAbbr, raw.homePointDiff, raw.homeRecord),
        awayRating: ratingFrom(awayAbbr, raw.awayPointDiff, raw.awayRecord),
        ...(typeof raw.marketHomeProb === 'number' ? { marketHomeProb: raw.marketHomeProb } : {}),
        injuries: raw.injuries ?? [],
        adjustments: raw.adjustments ?? {},
        threshold,
      }),
    );
  }
  rows.sort((a, b) => b.probability - a.probability);
  return rows;
}
