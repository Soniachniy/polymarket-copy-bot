import { existsSync, readFileSync } from 'node:fs';
import type { MatchedGame } from './model.js';
import { resolveTeam } from './teams.js';
import type {
  AdjustmentsFile,
  GameInfo,
  InjuryReport,
  ManualAdjustment,
  ManualGameInput,
  ManualInputFile,
  NbaMarket,
  TeamRating,
} from './types.js';

export interface ManualSlate {
  date: string;
  matched: MatchedGame[];
  ratings: Map<string, TeamRating>;
  adjustments: AdjustmentsFile;
  injuries: InjuryReport[];
}

function resolveOrThrow(text: string, where: string): string {
  const abbr = resolveTeam(text);
  if (!abbr) {
    throw new Error(
      `Manual input: could not resolve team "${text}" in ${where}. ` +
        `Use a full team name or NBA abbreviation (e.g. "Lakers" or "LAL").`,
    );
  }
  return abbr;
}

/** Pull [homePrice, awayPrice] out of either keyed or tuple market-price input. */
function readPrices(
  prices: ManualGameInput['marketPrices'],
  homeAbbr: string,
  awayAbbr: string,
  where: string,
): [number, number] {
  if (Array.isArray(prices)) {
    const [h, a] = prices;
    if (typeof h !== 'number' || typeof a !== 'number') {
      throw new Error(`Manual input: marketPrices tuple in ${where} must be two numbers [home, away].`);
    }
    return [h, a];
  }
  // Keyed by team name/abbr — resolve each key so "Lakers"/"LAL" both work.
  let home: number | undefined;
  let away: number | undefined;
  for (const [key, value] of Object.entries(prices)) {
    const abbr = resolveTeam(key);
    if (abbr === homeAbbr) home = Number(value);
    else if (abbr === awayAbbr) away = Number(value);
  }
  if (home === undefined || away === undefined) {
    throw new Error(
      `Manual input: marketPrices in ${where} must include both teams (${homeAbbr} and ${awayAbbr}).`,
    );
  }
  return [home, away];
}

function readAdjustments(game: ManualGameInput): AdjustmentsFile {
  const out: AdjustmentsFile = {};
  for (const [key, raw] of Object.entries(game.adjustments ?? {})) {
    const abbr = resolveTeam(key);
    if (!abbr) continue;
    const adj: ManualAdjustment =
      typeof raw === 'number' ? { points: raw, reason: 'manual adjustment' } : raw;
    out[abbr] = adj;
  }
  return out;
}

/** Convert a parsed manual slate into the same shapes the live pipeline produces. */
export function buildManualSlate(input: ManualInputFile): ManualSlate {
  if (!input || !Array.isArray(input.games)) {
    throw new Error('Manual input: file must be an object with a "games" array.');
  }
  const date = input.date;
  const ratings = new Map<string, TeamRating>();
  const adjustments: AdjustmentsFile = {};
  const injuries: InjuryReport[] = [];
  const matched: MatchedGame[] = [];

  input.games.forEach((g, i) => {
    const where = `games[${i}]`;
    const homeAbbr = resolveOrThrow(g.home, `${where}.home`);
    const awayAbbr = resolveOrThrow(g.away, `${where}.away`);
    if (homeAbbr === awayAbbr) {
      throw new Error(`Manual input: ${where} has the same team on both sides (${homeAbbr}).`);
    }
    const [homePrice, awayPrice] = readPrices(g.marketPrices, homeAbbr, awayAbbr, where);

    const setRating = (abbr: string, net: number, record?: [number, number]) => {
      const [wins, losses] = record ?? [0, 0];
      const games = wins + losses;
      ratings.set(abbr, {
        abbr,
        wins,
        losses,
        pointDiff: net,
        winPct: games > 0 ? wins / games : 0.5,
      });
    };
    setRating(homeAbbr, g.homeNetRating, g.homeRecord);
    setRating(awayAbbr, g.awayNetRating, g.awayRecord);

    Object.assign(adjustments, readAdjustments(g));

    for (const inj of g.injuries ?? []) {
      const abbr = resolveTeam(inj.team);
      if (abbr) injuries.push({ teamAbbr: abbr, player: inj.player, status: inj.status });
    }

    const market: NbaMarket = {
      eventTitle: g.question ?? `${g.away} @ ${g.home}`,
      question: g.question ?? `${g.away} @ ${g.home}`,
      slug: g.slug ?? `manual-${awayAbbr}-${homeAbbr}-${date}`,
      conditionId: g.conditionId ?? '',
      // Outcomes ordered [home, away]; prices align with outcomes.
      outcomes: [homeAbbr, awayAbbr],
      prices: [homePrice, awayPrice],
      teamAbbrs: [homeAbbr, awayAbbr],
    };
    const game: GameInfo = {
      espnId: '',
      date,
      homeAbbr,
      awayAbbr,
      startTimeUtc: '',
      completed: false,
    };
    matched.push({ market, game, homeIdx: 0 });
  });

  return { date, matched, ratings, adjustments, injuries };
}

export function loadManualInput(file: string): ManualSlate {
  if (!existsSync(file)) {
    throw new Error(`Manual input file not found: ${file}`);
  }
  let parsed: ManualInputFile;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8')) as ManualInputFile;
  } catch (e) {
    throw new Error(`Manual input file ${file} is not valid JSON: ${e}`);
  }
  return buildManualSlate(parsed);
}
