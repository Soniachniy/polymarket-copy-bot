import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchInjuries, fetchScoreboard, fetchStandings } from './espn.js';
import { loadManualInput } from './manual.js';
import { blend, deVig, matchMarketsToGames, modelHomeWinProb, type MatchedGame } from './model.js';
import { fetchNbaMarkets, isMoneylineMarket } from './polymarket.js';
import type { AdjustmentsFile, InjuryReport, Prediction, TeamRating } from './types.js';

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
  input?: string; // path to a manual slate file (offline / API-blocked mode)
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
    else if (arg === '--input') {
      const v = argv[++i];
      if (v) opts.input = v;
    }
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

type Row = Prediction & { pass: boolean; expectedMargin: number; notes: string[] };

/** Run the calibrated model over matched games. Identical for live and manual modes. */
export function buildRows(
  matched: MatchedGame[],
  ratings: Map<string, TeamRating>,
  adjustments: AdjustmentsFile,
  injuries: InjuryReport[],
  threshold: number,
): Row[] {
  const rows: Row[] = [];
  for (const { market, game, homeIdx } of matched) {
    const home = ratings.get(game.homeAbbr);
    const away = ratings.get(game.awayAbbr);
    if (!home || !away) {
      console.error(`Skipping ${game.awayAbbr} @ ${game.homeAbbr}: missing ratings data.`);
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
      threshold,
      rationale:
        `margin ${model.expectedMargin >= 0 ? '+' : ''}${model.expectedMargin.toFixed(1)} home; ` +
        `model ${pct(pModel)}, market ${pct(pMarket)}` +
        (model.notes.length ? ` | adj: ${model.notes.join('; ')}` : '') +
        injuryNote,
      status: 'pending',
      pass: probability >= threshold,
      expectedMargin: model.expectedMargin,
      notes: model.notes,
    });
  }
  return rows;
}

async function gatherLive(opts: CliOptions): Promise<{
  matched: MatchedGame[];
  ratings: Map<string, TeamRating>;
  adjustments: AdjustmentsFile;
  injuries: InjuryReport[];
}> {
  console.error('Fetching Polymarket NBA markets, ESPN scoreboard, standings, injuries...');
  const dates = opts.dates.length > 0 ? opts.dates : [undefined];
  const [markets, ratings, injuries, ...scoreboards] = await Promise.all([
    fetchNbaMarkets(),
    fetchStandings(),
    fetchInjuries().catch((e) => {
      console.error(`(injuries fetch failed, continuing without: ${e})`);
      return [] as InjuryReport[];
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
  return { matched, ratings, adjustments, injuries };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  let matched: MatchedGame[];
  let ratings: Map<string, TeamRating>;
  let adjustments: AdjustmentsFile;
  let injuries: InjuryReport[];

  if (opts.input) {
    console.error(`Loading manual slate from ${opts.input} (offline mode, no API calls)...`);
    const slate = loadManualInput(opts.input);
    ({ matched, ratings, adjustments, injuries } = slate);
    console.error(
      `${matched.length} game(s) loaded from manual input for ${slate.date}, ` +
        `${Object.keys(adjustments).length} adjustment(s), ${injuries.length} injury note(s).`,
    );
  } else {
    ({ matched, ratings, adjustments, injuries } = await gatherLive(opts));
  }

  const rows = buildRows(matched, ratings, adjustments, injuries, opts.threshold);

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
