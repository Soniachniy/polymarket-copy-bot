import { readFileSync } from 'node:fs';
import {
  DEFAULT_THRESHOLD,
  forecastGame,
  formatRow,
  LOG_FILE,
  pct,
  savePicks,
  type ForecastInput,
  type ForecastRow,
} from './core.js';
import type { AdjustmentsFile } from './types.js';

/**
 * Offline / in-session predictor.
 *
 * When the Polymarket and ESPN hosts are not reachable from the runtime (e.g. a
 * network-restricted web session), the direct-API `predict` CLI can't run. In that
 * case the Claude session gathers the same inputs via web search/fetch and writes
 * them to a JSON file; this CLI applies the identical model math deterministically.
 *
 * Input file shape:
 * {
 *   "date": "2026-04-15",          // YYYY-MM-DD, applied to any game without its own date
 *   "threshold": 0.78,             // optional, overrides default
 *   "games": [
 *     {
 *       "question": "Lakers @ Celtics",
 *       "home": "BOS", "away": "LAL",
 *       "homeDiff": 4.2,           // avg point differential per game (net rating proxy)
 *       "awayDiff": 1.1,
 *       "marketHome": 0.62,        // raw Polymarket price for the home outcome (de-vigged internally)
 *       "marketAway": 0.38,
 *       "adjHome": 0,              // optional manual point adjustment for home side
 *       "adjAway": -3,             // e.g. star out
 *       "adjHomeReason": "",
 *       "adjAwayReason": "Doncic questionable",
 *       "slug": "...",             // optional; used for de-dup in the log
 *       "conditionId": "...",      // optional; used for de-dup in the log
 *       "note": "back-to-back for LAL"
 *     }
 *   ]
 * }
 */

interface RawGame {
  question?: string;
  date?: string;
  home: string;
  away: string;
  homeDiff: number;
  awayDiff: number;
  marketHome: number;
  marketAway: number;
  adjHome?: number;
  adjAway?: number;
  adjHomeReason?: string;
  adjAwayReason?: string;
  slug?: string;
  conditionId?: string;
  note?: string;
}

interface InputFile {
  date?: string;
  threshold?: number;
  games: RawGame[];
}

interface CliOptions {
  input: string;
  save: boolean;
  json: boolean;
  showAll: boolean;
  threshold?: number;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: Partial<CliOptions> = { save: false, json: false, showAll: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--input' || arg === '-i') opts.input = argv[++i]!;
    else if (arg === '--save') opts.save = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--all') opts.showAll = true;
    else if (arg === '--threshold') opts.threshold = Number(argv[++i]);
    else if (!arg.startsWith('-') && !opts.input) opts.input = arg;
  }
  if (!opts.input) {
    console.error(
      'Usage: npm run predict:compute -- --input <games.json> [--save] [--all] [--threshold 0.78]\n' +
        'See prediction/src/compute.ts for the input file schema.',
    );
    process.exit(1);
  }
  return opts as CliOptions;
}

function toForecastInput(g: RawGame, fallbackDate: string): ForecastInput {
  const adjustments: AdjustmentsFile = {};
  if (g.adjHome) adjustments[g.home] = { points: g.adjHome, reason: g.adjHomeReason ?? '' };
  if (g.adjAway) adjustments[g.away] = { points: g.adjAway, reason: g.adjAwayReason ?? '' };
  const input: ForecastInput = {
    gameDate: g.date ?? fallbackDate,
    slug: g.slug ?? `${g.away}-at-${g.home}-${g.date ?? fallbackDate}`,
    conditionId: g.conditionId ?? '',
    question: g.question ?? `${g.away} @ ${g.home}`,
    homeAbbr: g.home,
    awayAbbr: g.away,
    homeDiff: g.homeDiff,
    awayDiff: g.awayDiff,
    marketHome: g.marketHome,
    marketAway: g.marketAway,
    adjustments,
  };
  if (g.note) input.extraNote = g.note;
  return input;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const parsed = JSON.parse(readFileSync(opts.input, 'utf8')) as InputFile;
  if (!Array.isArray(parsed.games)) {
    console.error(`Input file ${opts.input} has no "games" array.`);
    process.exit(1);
  }
  const threshold = opts.threshold ?? parsed.threshold ?? DEFAULT_THRESHOLD;
  const fallbackDate = parsed.date ?? new Date().toISOString().slice(0, 10);

  const rows: ForecastRow[] = parsed.games.map((g) =>
    forecastGame(toForecastInput(g, fallbackDate), threshold),
  );
  rows.sort((a, b) => b.probability - a.probability);
  const picks = rows.filter((r) => r.pass);

  if (opts.json) {
    console.log(JSON.stringify(opts.showAll ? rows : picks, null, 2));
  } else {
    console.log(`\n=== NBA predictions (offline, threshold ${pct(threshold)}) ===\n`);
    for (const r of opts.showAll ? rows : picks) console.log(formatRow(r));
    if (picks.length === 0) {
      console.log(
        'No games clear the confidence threshold. Skipping is the correct output — ' +
          'forcing picks on coin-flip games is what destroys accuracy.\n',
      );
    }
    console.log(`${picks.length} pick(s) / ${rows.length} game(s).`);
  }

  if (opts.save) {
    const saved = savePicks(picks);
    console.error(`Saved ${saved} new prediction(s) to ${LOG_FILE}`);
  }
}

main();
