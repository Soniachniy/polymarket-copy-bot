import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPickRow, marketHomeProb, renderRows, saveRows, type PickRow } from './core.js';
import { fetchInjuries, fetchScoreboard, fetchStandings } from './espn.js';
import { matchMarketsToGames } from './model.js';
import { rowsFromBundle } from './offline.js';
import { fetchNbaMarkets, isMoneylineMarket } from './polymarket.js';
import type { AdjustmentsFile, InputBundle } from './types.js';

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
  input?: string; // path to a session-provided InputBundle JSON
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
    else if (arg === '--input') opts.input = argv[++i]!;
  }
  return opts;
}

function loadAdjustments(): AdjustmentsFile {
  if (!existsSync(ADJUSTMENTS_FILE)) return {};
  return JSON.parse(readFileSync(ADJUSTMENTS_FILE, 'utf8')) as AdjustmentsFile;
}

/** Offline path: score a session-provided bundle with no network access. */
function computeFromInput(path: string, opts: CliOptions): PickRow[] {
  const bundle = JSON.parse(readFileSync(path, 'utf8')) as InputBundle;
  if (!Array.isArray(bundle.games)) {
    throw new Error(`Input file ${path} has no "games" array. See prediction/README.md for the schema.`);
  }
  console.error(
    `Offline mode: ${bundle.games.length} game(s) from ${path}` +
      (bundle.date ? ` (slate ${bundle.date})` : ''),
  );
  return rowsFromBundle(bundle, opts.threshold);
}

/** Live path: fetch Polymarket + ESPN and score every matched game. */
async function computeLive(opts: CliOptions): Promise<PickRow[]> {
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

  const rows: PickRow[] = [];
  for (const { market, game, homeIdx } of matched) {
    const home = ratings.get(game.homeAbbr);
    const away = ratings.get(game.awayAbbr);
    if (!home || !away) {
      console.error(`Skipping ${game.awayAbbr} @ ${game.homeAbbr}: missing standings data.`);
      continue;
    }
    const pHomeMarket = marketHomeProb(market.prices, homeIdx);
    rows.push(
      buildPickRow({
        gameDate: game.date,
        slug: market.slug,
        conditionId: market.conditionId,
        question: market.question || market.eventTitle,
        homeAbbr: game.homeAbbr,
        awayAbbr: game.awayAbbr,
        homeOutcome: market.outcomes[homeIdx]!,
        awayOutcome: market.outcomes[1 - homeIdx]!,
        homeRating: home,
        awayRating: away,
        ...(typeof pHomeMarket === 'number' ? { marketHomeProb: pHomeMarket } : {}),
        injuries,
        adjustments,
        threshold: opts.threshold,
      }),
    );
  }
  rows.sort((a, b) => b.probability - a.probability);
  return rows;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const rows = opts.input ? computeFromInput(opts.input, opts) : await computeLive(opts);
  const picks = rows.filter((r) => r.pass);

  if (opts.json) {
    console.log(JSON.stringify(opts.showAll ? rows : picks, null, 2));
  } else {
    console.log(renderRows(rows, opts.showAll, opts.threshold));
  }

  if (opts.save) {
    const saved = saveRows(rows, LOG_FILE);
    console.error(`Saved ${saved} new prediction(s) to ${LOG_FILE}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
