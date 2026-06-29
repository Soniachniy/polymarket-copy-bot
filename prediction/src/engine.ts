import { blend, deVig, type MatchedGame, modelHomeWinProb } from './model.js';
import { resolveTeam } from './teams.js';
import type {
  AdjustmentsFile,
  GameInfo,
  InjuryReport,
  NbaMarket,
  Prediction,
  TeamRating,
} from './types.js';

/** A scored row: a Prediction plus the working fields the CLI prints but does not log. */
export type PredictionRow = Prediction & {
  pass: boolean;
  expectedMargin: number;
  notes: string[];
};

function pct(p: number): string {
  return `${(p * 100).toFixed(1)}%`;
}

export interface ComputeContext {
  ratings: Map<string, TeamRating>;
  injuries: InjuryReport[];
  adjustments: AdjustmentsFile;
  threshold: number;
  /** When false, a game is skipped instead of model-only (used by live mode messaging). */
  warn?: (msg: string) => void;
}

/**
 * Pure scoring core shared by live mode and research/input mode. Given matched
 * (market, game) pairs plus ratings/injuries/adjustments, produce sorted rows.
 */
export function computeRows(matched: MatchedGame[], ctx: ComputeContext): PredictionRow[] {
  const warn = ctx.warn ?? (() => {});
  const rows: PredictionRow[] = [];

  for (const { market, game, homeIdx } of matched) {
    const home = ctx.ratings.get(game.homeAbbr);
    const away = ctx.ratings.get(game.awayAbbr);
    if (!home || !away) {
      warn(`Skipping ${game.awayAbbr} @ ${game.homeAbbr}: missing ratings data.`);
      continue;
    }
    const model = modelHomeWinProb({ home, away, adjustments: ctx.adjustments });

    // A market with no usable prices (both zero / missing) can't anchor the blend.
    const haveMarket = market.prices.some((p) => p > 0);
    const fair = haveMarket ? deVig(market.prices) : [];
    const pMarketHome = haveMarket ? (fair[homeIdx] ?? 0.5) : model.pHome;
    const pHome = haveMarket ? blend(model.pHome, pMarketHome) : model.pHome;

    const pickIsHome = pHome >= 0.5;
    const pickIdx = pickIsHome ? homeIdx : 1 - homeIdx;
    const probability = pickIsHome ? pHome : 1 - pHome;
    const pModel = pickIsHome ? model.pHome : 1 - model.pHome;
    const pMarket = pickIsHome ? pMarketHome : 1 - pMarketHome;

    const teamInjuries = ctx.injuries.filter(
      (r) =>
        (r.teamAbbr === game.homeAbbr || r.teamAbbr === game.awayAbbr) &&
        /out|doubtful/i.test(r.status),
    );
    const injuryNote =
      teamInjuries.length > 0
        ? ` | listed Out/Doubtful: ${teamInjuries
            .map((r) => `${r.player} (${r.teamAbbr}, ${r.status})`)
            .join(', ')}`
        : '';
    const marketNote = haveMarket ? '' : ' | NO MARKET PRICE (model-only, not a confident pick)';

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
      threshold: ctx.threshold,
      rationale:
        `margin ${model.expectedMargin >= 0 ? '+' : ''}${model.expectedMargin.toFixed(1)} home; ` +
        `model ${pct(pModel)}, market ${haveMarket ? pct(pMarket) : 'n/a'}` +
        (model.notes.length ? ` | adj: ${model.notes.join('; ')}` : '') +
        injuryNote +
        marketNote,
      status: 'pending',
      // A model-only game can never be a confident pick: require a market anchor.
      pass: haveMarket && probability >= ctx.threshold,
      expectedMargin: model.expectedMargin,
      notes: model.notes,
    });
  }

  rows.sort((a, b) => b.probability - a.probability);
  return rows;
}

/* ---------------------------------------------------------------------------
 * Research / offline input mode
 *
 * When the direct ESPN + Polymarket endpoints are blocked by a network egress
 * allowlist (or you simply want the session to drive everything via web
 * research), the session layer writes a bundle of everything the model needs
 * into a JSON file and the CLI scores it with no live fetches.
 * ------------------------------------------------------------------------- */

export interface InputGame {
  /** Home/away as team name, alias, or abbreviation — resolved to an abbr. */
  home: string;
  away: string;
  /** Net rating / season point differential per game. Higher = better. */
  homeRating: number;
  awayRating: number;
  /** Polymarket de-vigged-or-raw prices for the home/away moneyline, 0..1. Optional. */
  marketHomePrice?: number;
  marketAwayPrice?: number;
  /** Optional Polymarket identifiers, carried into the saved log. */
  slug?: string;
  conditionId?: string;
  /** Per-game point adjustments keyed by team abbr (star out, rest, B2B...). */
  adjustments?: AdjustmentsFile;
  /** Per-game injury notes surfaced in the rationale. */
  injuries?: Array<{ team: string; player: string; status: string }>;
}

export interface InputBundle {
  /** Game date (YYYY-MM-DD, US/Eastern). */
  date: string;
  games: InputGame[];
}

export interface BundledInputs {
  matched: MatchedGame[];
  ratings: Map<string, TeamRating>;
  injuries: InjuryReport[];
  adjustments: AdjustmentsFile;
  warnings: string[];
}

function ratingFrom(abbr: string, pointDiff: number): TeamRating {
  return { abbr, wins: 0, losses: 0, pointDiff, winPct: 0.5 };
}

/** Convert a session-written InputBundle into the structures computeRows expects. */
export function bundleToInputs(bundle: InputBundle): BundledInputs {
  const ratings = new Map<string, TeamRating>();
  const injuries: InjuryReport[] = [];
  const adjustments: AdjustmentsFile = {};
  const matched: MatchedGame[] = [];
  const warnings: string[] = [];

  bundle.games.forEach((g, i) => {
    const homeAbbr = resolveTeam(g.home);
    const awayAbbr = resolveTeam(g.away);
    if (!homeAbbr || !awayAbbr) {
      warnings.push(`game ${i}: could not resolve "${g.away}" @ "${g.home}" to NBA teams — skipped.`);
      return;
    }
    if (homeAbbr === awayAbbr) {
      warnings.push(`game ${i}: home and away resolved to the same team (${homeAbbr}) — skipped.`);
      return;
    }
    ratings.set(homeAbbr, ratingFrom(homeAbbr, g.homeRating));
    ratings.set(awayAbbr, ratingFrom(awayAbbr, g.awayRating));

    for (const [abbrText, adj] of Object.entries(g.adjustments ?? {})) {
      const abbr = resolveTeam(abbrText) ?? abbrText.toUpperCase();
      adjustments[abbr] = adj;
    }
    for (const inj of g.injuries ?? []) {
      injuries.push({
        teamAbbr: resolveTeam(inj.team) ?? inj.team.toUpperCase(),
        player: inj.player,
        status: inj.status,
      });
    }

    const homePrice = g.marketHomePrice ?? 0;
    const awayPrice = g.marketAwayPrice ?? 0;
    const market: NbaMarket = {
      eventTitle: `${g.away} @ ${g.home}`,
      question: `${g.away} @ ${g.home}`,
      slug: g.slug ?? `input-${bundle.date}-${awayAbbr}-${homeAbbr}`,
      conditionId: g.conditionId ?? '',
      // Outcomes ordered home-first so homeIdx is 0.
      outcomes: [homeAbbr, awayAbbr],
      prices: [homePrice, awayPrice],
      teamAbbrs: [homeAbbr, awayAbbr],
    };
    const game: GameInfo = {
      espnId: '',
      date: bundle.date,
      homeAbbr,
      awayAbbr,
      startTimeUtc: '',
      completed: false,
    };
    matched.push({ market, game, homeIdx: 0 });
  });

  return { matched, ratings, injuries, adjustments, warnings };
}
