import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPredictionRow, pct, printRow, savePicks, type PredictionRow } from './engine.js';
import { NBA_TEAMS, resolveTeam } from './teams.js';
import type { AdjustmentsFile, ManualAdjustment, TeamRating } from './types.js';

/**
 * The manual "slate" path. When ESPN / Polymarket hosts are blocked by the environment's
 * network egress policy (or you simply prefer to drive it by hand), the Claude session layer
 * researches the slate via web search and writes a slate JSON, then this runs the *exact same*
 * engine the live-API path uses — same model, same market blend, same selectivity and logging.
 *
 * Slate JSON shape (all fields per game unless marked optional):
 * {
 *   "threshold": 0.78,                 // optional, defaults to 0.78
 *   "games": [
 *     {
 *       "date": "2026-11-15",          // YYYY-MM-DD, US/Eastern game date
 *       "home": "Lakers",              // team name / alias / abbr — resolved to an abbr
 *       "away": "Celtics",
 *       "homeNetRating": 3.2,          // season point differential per game (from web research)
 *       "awayNetRating": 5.1,
 *       "marketHomePrice": 0.42,       // Polymarket price on the HOME team (0..1)
 *       "marketAwayPrice": 0.58,       // optional; if omitted, 1 - marketHomePrice is used
 *       "slug": "nba-lal-bos-2026-11-15",   // optional, for de-dup + traceability
 *       "conditionId": "0x...",              // optional, for de-dup
 *       "note": "Tatum questionable — see adjustments"   // optional, appended to rationale
 *     }
 *   ],
 *   "adjustments": { "BOS": { "points": -3, "reason": "Tatum out" } }   // optional, by abbr
 * }
 */
export interface SlateGame {
  date: string;
  home: string;
  away: string;
  homeNetRating: number;
  awayNetRating: number;
  marketHomePrice: number;
  marketAwayPrice?: number;
  homeRecord?: string; // "10-5" — cosmetic, parsed into wins/losses if present
  awayRecord?: string;
  slug?: string;
  conditionId?: string;
  note?: string;
}

export interface SlateFile {
  threshold?: number;
  games: SlateGame[];
  adjustments?: Record<string, ManualAdjustment>;
}

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
export const LOG_FILE = join(DATA_DIR, 'predictions.jsonl');

function parseRecord(rec: string | undefined): { wins: number; losses: number } {
  if (!rec) return { wins: 0, losses: 0 };
  const m = /(\d+)\s*-\s*(\d+)/.exec(rec);
  return m ? { wins: Number(m[1]), losses: Number(m[2]) } : { wins: 0, losses: 0 };
}

function ratingFor(abbr: string, netRating: number, record?: string): TeamRating {
  const { wins, losses } = parseRecord(record);
  const games = wins + losses;
  return { abbr, wins, losses, pointDiff: netRating, winPct: games > 0 ? wins / games : 0.5 };
}

function teamLabel(abbr: string): string {
  return NBA_TEAMS.find((t) => t.abbr === abbr)?.name ?? abbr;
}

export function rowsFromSlate(slate: SlateFile): PredictionRow[] {
  const threshold = slate.threshold ?? 0.78;
  const adjustments: AdjustmentsFile = slate.adjustments ?? {};
  const rows: PredictionRow[] = [];

  for (const g of slate.games) {
    const homeAbbr = resolveTeam(g.home);
    const awayAbbr = resolveTeam(g.away);
    if (!homeAbbr || !awayAbbr) {
      console.error(`Skipping "${g.away} @ ${g.home}": could not resolve team name(s) to abbrs.`);
      continue;
    }
    if (!(g.marketHomePrice > 0 && g.marketHomePrice < 1)) {
      console.error(`Skipping ${awayAbbr} @ ${homeAbbr}: marketHomePrice must be strictly between 0 and 1.`);
      continue;
    }
    const homePrice = g.marketHomePrice;
    const awayPrice = g.marketAwayPrice ?? 1 - g.marketHomePrice;

    // outcomes[0] = home, outcomes[1] = away, so homeIdx = 0.
    rows.push(
      buildPredictionRow({
        gameDate: g.date,
        slug: g.slug ?? `${g.date}-${awayAbbr}-${homeAbbr}`,
        conditionId: g.conditionId ?? '',
        question: `${teamLabel(awayAbbr)} @ ${teamLabel(homeAbbr)}`,
        home: ratingFor(homeAbbr, g.homeNetRating, g.homeRecord),
        away: ratingFor(awayAbbr, g.awayNetRating, g.awayRecord),
        outcomes: [teamLabel(homeAbbr), teamLabel(awayAbbr)],
        teamAbbrs: [homeAbbr, awayAbbr],
        prices: [homePrice, awayPrice],
        homeIdx: 0,
        adjustments,
        threshold,
        extraNote: g.note ? ` | note: ${g.note}` : '',
      }),
    );
  }
  return rows;
}

function main() {
  const argv = process.argv.slice(2);
  const save = argv.includes('--save');
  const showAll = argv.includes('--all');
  const json = argv.includes('--json');
  const fileArg = argv.find((a) => a.endsWith('.json'));
  if (!fileArg) {
    console.error(
      'Usage: npm run predict:slate -- <slate.json> [--save] [--all] [--json]\n' +
        'Build the slate JSON from web research when live APIs are blocked. See prediction/src/slate.ts for the schema.',
    );
    process.exit(1);
  }
  if (!existsSync(fileArg)) {
    console.error(`Slate file not found: ${fileArg}`);
    process.exit(1);
  }
  const slate = JSON.parse(readFileSync(fileArg, 'utf8')) as SlateFile;
  const threshold = slate.threshold ?? 0.78;
  const rows = rowsFromSlate(slate).sort((a, b) => b.probability - a.probability);
  const picks = rows.filter((r) => r.pass);

  if (json) {
    console.log(JSON.stringify(showAll ? rows : picks, null, 2));
  } else {
    console.log(`\n=== NBA predictions from slate (threshold ${pct(threshold)}) ===\n`);
    for (const r of showAll ? rows : picks) printRow(r);
    if (picks.length === 0) {
      console.log(
        'No games clear the confidence threshold. Skipping is the correct output — ' +
          'forcing picks on coin-flip games is what destroys accuracy.\n',
      );
    }
    console.log(`${picks.length} pick(s) / ${rows.length} game(s) in slate.`);
  }

  if (save) {
    const saved = savePicks(LOG_FILE, DATA_DIR, picks);
    console.error(`Saved ${saved} new prediction(s) to ${LOG_FILE}`);
  }
}

// Only run as a CLI when invoked directly (keeps rowsFromSlate importable in tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
