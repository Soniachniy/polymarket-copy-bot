import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateGame, type EvalInput, type EvalRow } from './evaluate.js';
import { loadManualInputs } from './manual.js';
import { matchMarketsToGames } from './model.js';
import { isMoneylineMarket } from './polymarket.js';
import { loadInjuries, loadMarkets, loadScoreboard, loadStandings } from './sources.js';
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
  offline: boolean;
  manual?: string; // path to a manual slate file
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    threshold: DEFAULT_THRESHOLD,
    save: false,
    json: false,
    dates: [],
    showAll: false,
    offline: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--save') opts.save = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--all') opts.showAll = true;
    else if (arg === '--offline') opts.offline = true;
    else if (arg === '--threshold') opts.threshold = Number(argv[++i]);
    else if (arg === '--date') opts.dates.push(argv[++i]!);
    else if (arg === '--manual') opts.manual = argv[++i] ?? join(DATA_DIR, 'manual.json');
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

/** Build evaluation inputs from live/snapshot Polymarket + ESPN data. */
async function liveInputs(opts: CliOptions): Promise<EvalInput[]> {
  console.error('Fetching Polymarket NBA markets, ESPN scoreboard, standings, injuries...');
  const dates = opts.dates.length > 0 ? opts.dates : [undefined];
  const [markets, ratings, injuries, ...scoreboards] = await Promise.all([
    loadMarkets(opts.offline),
    loadStandings(opts.offline).catch((e) => {
      console.error(`(standings unavailable, continuing market-only: ${e})`);
      return new Map();
    }),
    loadInjuries(opts.offline),
    ...dates.map((d) => loadScoreboard(d, opts.offline)),
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

  const inputs: EvalInput[] = [];
  for (const { market, game, homeIdx } of matched) {
    inputs.push({
      gameDate: game.date,
      slug: market.slug,
      conditionId: market.conditionId,
      question: market.question || market.eventTitle,
      homeAbbr: game.homeAbbr,
      awayAbbr: game.awayAbbr,
      outcomes: market.outcomes,
      teamAbbrs: market.teamAbbrs,
      homeIdx,
      prices: market.prices,
      homeRating: ratings.get(game.homeAbbr),
      awayRating: ratings.get(game.awayAbbr),
      adjustments,
      injuries,
      threshold: opts.threshold,
    });
  }
  return inputs;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  const inputs = opts.manual
    ? loadManualInputs(opts.manual, opts.threshold)
    : await liveInputs(opts);
  if (opts.manual) console.error(`Loaded ${inputs.length} game(s) from manual slate ${opts.manual}.`);

  const rows: EvalRow[] = inputs.map(evaluateGame);
  rows.sort((a, b) => b.probability - a.probability);
  const picks = rows.filter((r) => r.pass);

  if (opts.json) {
    console.log(JSON.stringify(opts.showAll ? rows : picks, null, 2));
  } else {
    console.log(`\n=== NBA predictions (threshold ${pct(opts.threshold)}) ===\n`);
    const printRow = (r: EvalRow) => {
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
      // Don't double-log the same market: match on conditionId when present,
      // otherwise on the exact slug string as it appears in the log.
      const key = r.conditionId || `"slug":${JSON.stringify(r.slug)}`;
      if (existing.includes(key)) continue;
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
