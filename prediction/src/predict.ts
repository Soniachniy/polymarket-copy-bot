import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  bundleToInputs,
  computeRows,
  type InputBundle,
  type PredictionRow,
} from './engine.js';
import { fetchInjuries, fetchScoreboard, fetchStandings } from './espn.js';
import { matchMarketsToGames } from './model.js';
import { fetchNbaMarkets, isMoneylineMarket } from './polymarket.js';
import type { AdjustmentsFile } from './types.js';

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
export const LOG_FILE = join(DATA_DIR, 'predictions.jsonl');
const ADJUSTMENTS_FILE = join(DATA_DIR, 'adjustments.json');

const DEFAULT_THRESHOLD = 0.78;

interface CliOptions {
  threshold: number;
  save: boolean;
  json: boolean;
  dates: string[]; // YYYY-MM-DD
  showAll: boolean;
  input?: string; // path to a research/offline InputBundle JSON
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    threshold: DEFAULT_THRESHOLD,
    save: false,
    json: false,
    dates: [],
    showAll: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--save') opts.save = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--all') opts.showAll = true;
    else if (arg === '--threshold') opts.threshold = Number(argv[++i]);
    else if (arg === '--date') opts.dates.push(argv[++i]!);
    else if (arg === '--input') opts.input = argv[++i] ?? '';
  }
  return opts;
}

function loadAdjustments(): AdjustmentsFile {
  if (!existsSync(ADJUSTMENTS_FILE)) return {};
  return JSON.parse(readFileSync(ADJUSTMENTS_FILE, 'utf8')) as AdjustmentsFile;
}

function pct(p: number): string {
  return `${(p * 100).toFixed(1)}%`;
}

/** Live mode: fetch markets, schedule, standings and injuries from the public APIs. */
async function liveRows(opts: CliOptions): Promise<PredictionRow[]> {
  console.error('Fetching Polymarket NBA markets, ESPN scoreboard, standings, injuries...');
  const dates = opts.dates.length > 0 ? opts.dates : [undefined];
  const [markets, ratings, injuries, ...scoreboards] = await Promise.all([
    fetchNbaMarkets(),
    fetchStandings(),
    fetchInjuries().catch((e) => {
      console.error(`(injuries fetch failed, continuing without: ${e})`);
      return [];
    }),
    ...dates.map((d) => fetchScoreboard(d)),
  ]);
  const games = scoreboards.flat().filter((g) => !g.completed);
  const adjustments = loadAdjustments();

  const moneylines = markets.filter(isMoneylineMarket);
  const matched = matchMarketsToGames(moneylines, games);

  console.error(
    `${markets.length} NBA markets (${moneylines.length} moneyline), ` +
      `${games.length} upcoming ESPN games, ${matched.length} matched, ` +
      `${Object.keys(adjustments).length} manual adjustments loaded.`,
  );

  return computeRows(matched, {
    ratings,
    injuries,
    adjustments,
    threshold: opts.threshold,
    warn: (m) => console.error(m),
  });
}

/** Research/offline mode: score a session-written InputBundle with no live fetches. */
function inputRows(opts: CliOptions): PredictionRow[] {
  const path = opts.input!;
  const bundle = JSON.parse(readFileSync(path, 'utf8')) as InputBundle;
  if (!bundle.date || !Array.isArray(bundle.games)) {
    throw new Error(`Input bundle ${path} must have { "date": "YYYY-MM-DD", "games": [...] }.`);
  }
  const { matched, ratings, injuries, adjustments, warnings } = bundleToInputs(bundle);
  for (const w of warnings) console.error(`(input) ${w}`);
  console.error(
    `Research mode: ${bundle.games.length} game(s) in bundle, ${matched.length} scored, ` +
      `${Object.keys(adjustments).length} adjustment(s).`,
  );
  return computeRows(matched, {
    ratings,
    injuries,
    adjustments,
    threshold: opts.threshold,
    warn: (m) => console.error(m),
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  const rows = opts.input ? inputRows(opts) : await liveRows(opts);
  const picks = rows.filter((r) => r.pass);

  if (opts.json) {
    console.log(JSON.stringify(opts.showAll ? rows : picks, null, 2));
  } else {
    console.log(`\n=== NBA predictions (threshold ${pct(opts.threshold)}) ===\n`);
    const printRow = (r: PredictionRow) => {
      const tag = r.pass ? 'PICK' : 'pass';
      console.log(
        `[${tag}] ${r.gameDate}  ${r.question}\n` +
          `       -> ${r.pickOutcome} (${r.pickTeam})  conf ${pct(r.probability)}  ` +
          `(model ${pct(r.pModel)} / market ${pct(r.pMarket)}, edge ${(r.edge * 100).toFixed(1)}pp)\n` +
          `       ${r.rationale}\n`,
      );
    };
    for (const r of opts.showAll ? rows : picks) printRow(r);
    if (picks.length === 0) {
      console.log(
        'No games clear the confidence threshold today. Skipping is the correct output — ' +
          'forcing picks on coin-flip games is what destroys accuracy.\n',
      );
    }
    console.log(`${picks.length} pick(s) / ${rows.length} matched game(s).`);
  }

  if (opts.save && picks.length > 0) {
    mkdirSync(DATA_DIR, { recursive: true });
    const existing = existsSync(LOG_FILE) ? readFileSync(LOG_FILE, 'utf8') : '';
    let saved = 0;
    for (const r of picks) {
      if (r.conditionId && existing.includes(r.conditionId)) continue; // don't double-log a market
      const { pass: _pass, expectedMargin: _m, notes: _n, ...record } = r;
      appendFileSync(LOG_FILE, JSON.stringify(record) + '\n');
      saved++;
    }
    console.error(`Saved ${saved} new prediction(s) to ${LOG_FILE}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
