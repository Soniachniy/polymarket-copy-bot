import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchInjuries, fetchScoreboard, fetchStandings } from './espn.js';
import { blend, deVig, matchMarketsToGames, modelHomeWinProb } from './model.js';
import type { ModelOutput } from './model.js';
import { fetchNbaMarkets, isMoneylineMarket } from './polymarket.js';
import type { AdjustmentsFile, Prediction } from './types.js';

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
    const fair = deVig(market.prices);
    const pMarketHome = fair[homeIdx] ?? 0.5;
    const home = ratings.get(game.homeAbbr);
    const away = ratings.get(game.awayAbbr);
    let model: ModelOutput;
    if (home && away) {
      model = modelHomeWinProb({ home, away, adjustments });
    } else {
      // No power ratings (e.g. preseason, all-star break, or a standings-shape gap):
      // fall back to a market-only forecast instead of dropping the game entirely, so a
      // clearly-priced favorite still produces a pick. Manual adjustments still apply via margin.
      const adjMargin =
        (adjustments[game.homeAbbr]?.points ?? 0) - (adjustments[game.awayAbbr]?.points ?? 0);
      const notes: string[] = ['no standings data; market-only fallback'];
      if (adjustments[game.homeAbbr]) notes.push(`${game.homeAbbr}: ${adjustments[game.homeAbbr]!.reason}`);
      if (adjustments[game.awayAbbr]) notes.push(`${game.awayAbbr}: ${adjustments[game.awayAbbr]!.reason}`);
      model = { expectedMargin: adjMargin, pHome: pMarketHome, notes };
      console.error(`${game.awayAbbr} @ ${game.homeAbbr}: missing standings, using market-only forecast.`);
    }
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
      pass: probability >= opts.threshold,
      expectedMargin: model.expectedMargin,
      notes: model.notes,
    });
  }

  rows.sort((a, b) => b.probability - a.probability);
  const picks = rows.filter((r) => r.pass);

  if (opts.json) {
    console.log(JSON.stringify(opts.showAll ? rows : picks, null, 2));
  } else {
    console.log(`\n=== NBA predictions (threshold ${pct(opts.threshold)}) ===\n`);
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
