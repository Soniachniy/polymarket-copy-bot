import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchInjuries, fetchScoreboard, fetchStandings } from './espn.js';
import { blend, deVig, matchMarketsToGames, modelHomeWinProb, qualifies } from './model.js';
import { fetchNbaMarkets, isMoneylineMarket } from './polymarket.js';
import type { AdjustmentsFile, Prediction } from './types.js';

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
export const LOG_FILE = join(DATA_DIR, 'predictions.jsonl');
const ADJUSTMENTS_FILE = join(DATA_DIR, 'adjustments.json');

const DEFAULT_THRESHOLD = 0.8;
/**
 * A pick must also have a de-vigged *market* probability at least this high.
 * This guards against the model loving an underdog: hitting 80% accuracy means
 * backing genuine favorites that the sharp market also rates highly, not chasing
 * a contrarian model edge. Coin-flip and lean games are skipped on purpose.
 */
const DEFAULT_MARKET_FLOOR = 0.7;

interface CliOptions {
  threshold: number;
  marketFloor: number;
  save: boolean;
  json: boolean;
  dates: string[]; // YYYY-MM-DD
  showAll: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    threshold: DEFAULT_THRESHOLD,
    marketFloor: DEFAULT_MARKET_FLOOR,
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
    else if (arg === '--market-floor') opts.marketFloor = Number(argv[++i]);
    else if (arg === '--date') opts.dates.push(argv[++i]!);
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

async function main() {
  const opts = parseArgs(process.argv.slice(2));

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

  const rows: Array<Prediction & { pass: boolean; expectedMargin: number; notes: string[] }> = [];
  for (const { market, game, homeIdx } of matched) {
    const home = ratings.get(game.homeAbbr);
    const away = ratings.get(game.awayAbbr);
    if (!home || !away) {
      console.error(`Skipping ${game.awayAbbr} @ ${game.homeAbbr}: missing standings data.`);
      continue;
    }
    const model = modelHomeWinProb({ home, away, adjustments });
    const fair = deVig(market.prices);
    const pMarketHome = fair[homeIdx] ?? 0.5;
    const pHome = blend(model.pHome, pMarketHome);

    const pickIsHome = pHome >= 0.5;
    const pickIdx = pickIsHome ? homeIdx : 1 - homeIdx;
    const probability = pickIsHome ? pHome : 1 - pHome;
    const pModel = pickIsHome ? model.pHome : 1 - model.pHome;
    const pMarket = pickIsHome ? pMarketHome : 1 - pMarketHome;

    const teamInjuries = injuries.filter(
      (r) =>
        (r.teamAbbr === game.homeAbbr || r.teamAbbr === game.awayAbbr) &&
        /out|doubtful/i.test(r.status),
    );
    const injuryNote =
      teamInjuries.length > 0
        ? ` | listed Out/Doubtful: ${teamInjuries.map((r) => `${r.player} (${r.teamAbbr}, ${r.status})`).join(', ')}`
        : '';

    rows.push({
      ts: new Date().toISOString(),
      gameDate: game.date,
      slug: market.slug,
      conditionId: market.conditionId,
      question: market.question || market.eventTitle,
      pickTeam: market.teamAbbrs[pickIdx]!,
      pickOutcome: market.outcomes[pickIdx]!,
      probability,
      pModel,
      pMarket,
      edge: probability - pMarket,
      threshold: opts.threshold,
      rationale:
        `margin ${model.expectedMargin >= 0 ? '+' : ''}${model.expectedMargin.toFixed(1)} home; ` +
        `model ${pct(pModel)}, market ${pct(pMarket)}` +
        (model.notes.length ? ` | adj: ${model.notes.join('; ')}` : '') +
        injuryNote,
      status: 'pending',
      pass: qualifies(probability, pMarket, opts.threshold, opts.marketFloor),
      expectedMargin: model.expectedMargin,
      notes: model.notes,
    });
  }

  rows.sort((a, b) => b.probability - a.probability);
  const picks = rows.filter((r) => r.pass);

  if (opts.json) {
    console.log(JSON.stringify(opts.showAll ? rows : picks, null, 2));
  } else {
    console.log(
      `\n=== NBA predictions (confidence ≥ ${pct(opts.threshold)}, market ≥ ${pct(opts.marketFloor)}) ===\n`,
    );
    const printRow = (r: (typeof rows)[number]) => {
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
