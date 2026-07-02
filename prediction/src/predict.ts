import { fetchInjuries, fetchScoreboard, fetchStandings } from './espn.js';
import { matchMarketsToGames } from './model.js';
import { fetchNbaMarkets, isMoneylineMarket } from './polymarket.js';
import {
  DEFAULT_THRESHOLD,
  forecastGame,
  formatRow,
  loadAdjustments,
  LOG_FILE,
  pct,
  savePicks,
  type ForecastRow,
} from './core.js';

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

  const rows: ForecastRow[] = [];
  for (const { market, game, homeIdx } of matched) {
    const home = ratings.get(game.homeAbbr);
    const away = ratings.get(game.awayAbbr);
    if (!home || !away) {
      console.error(`Skipping ${game.awayAbbr} @ ${game.homeAbbr}: missing standings data.`);
      continue;
    }

    const teamInjuries = injuries.filter(
      (r) =>
        (r.teamAbbr === game.homeAbbr || r.teamAbbr === game.awayAbbr) &&
        /out|doubtful/i.test(r.status),
    );
    const extraNote =
      teamInjuries.length > 0
        ? `listed Out/Doubtful: ${teamInjuries.map((r) => `${r.player} (${r.teamAbbr}, ${r.status})`).join(', ')}`
        : undefined;

    const awayIdx = 1 - homeIdx;
    rows.push(
      forecastGame(
        {
          gameDate: game.date,
          slug: market.slug,
          conditionId: market.conditionId,
          question: market.question || market.eventTitle,
          homeAbbr: game.homeAbbr,
          awayAbbr: game.awayAbbr,
          homeDiff: home.pointDiff,
          awayDiff: away.pointDiff,
          marketHome: market.prices[homeIdx] ?? 0.5,
          marketAway: market.prices[awayIdx] ?? 0.5,
          adjustments,
          ...(extraNote ? { extraNote } : {}),
        },
        opts.threshold,
      ),
    );
  }

  rows.sort((a, b) => b.probability - a.probability);
  const picks = rows.filter((r) => r.pass);

  if (opts.json) {
    console.log(JSON.stringify(opts.showAll ? rows : picks, null, 2));
  } else {
    console.log(`\n=== NBA predictions (threshold ${pct(opts.threshold)}) ===\n`);
    for (const r of opts.showAll ? rows : picks) console.log(formatRow(r));
    if (picks.length === 0) {
      console.log(
        'No games clear the confidence threshold today. Skipping is the correct output — ' +
          'forcing picks on coin-flip games is what destroys accuracy.\n',
      );
    }
    console.log(`${picks.length} pick(s) / ${rows.length} matched game(s).`);
  }

  if (opts.save) {
    const saved = savePicks(picks);
    console.error(`Saved ${saved} new prediction(s) to ${LOG_FILE}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
