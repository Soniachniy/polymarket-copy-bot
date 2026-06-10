import { getJson } from './http.js';
import { normalizeEspnAbbr } from './teams.js';
import type { GameInfo, InjuryReport, TeamRating } from './types.js';

const SITE = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba';
const SITE_V2 = 'https://site.api.espn.com/apis/v2/sports/basketball/nba';

/* eslint-disable @typescript-eslint/no-explicit-any */

export async function fetchScoreboard(dateYmd?: string): Promise<GameInfo[]> {
  const datesParam = dateYmd ? `?dates=${dateYmd.replaceAll('-', '')}` : '';
  const data = await getJson<any>(`${SITE}/scoreboard${datesParam}`);
  const games: GameInfo[] = [];
  for (const ev of data?.events ?? []) {
    const comp = ev?.competitions?.[0];
    if (!comp) continue;
    const competitors = comp.competitors ?? [];
    const home = competitors.find((c: any) => c.homeAway === 'home');
    const away = competitors.find((c: any) => c.homeAway === 'away');
    if (!home?.team?.abbreviation || !away?.team?.abbreviation) continue;
    const game: GameInfo = {
      espnId: String(ev.id ?? ''),
      date: String(ev.date ?? '').slice(0, 10),
      homeAbbr: normalizeEspnAbbr(home.team.abbreviation),
      awayAbbr: normalizeEspnAbbr(away.team.abbreviation),
      startTimeUtc: String(ev.date ?? ''),
      completed: Boolean(ev?.status?.type?.completed),
    };
    if (game.completed) {
      game.homeScore = Number(home.score);
      game.awayScore = Number(away.score);
    }
    games.push(game);
  }
  return games;
}

export async function fetchStandings(): Promise<Map<string, TeamRating>> {
  const data = await getJson<any>(`${SITE_V2}/standings`);
  const ratings = new Map<string, TeamRating>();
  const groups: any[] = data?.children ?? (data?.standings ? [data] : []);
  for (const group of groups) {
    for (const entry of group?.standings?.entries ?? []) {
      const abbr = normalizeEspnAbbr(String(entry?.team?.abbreviation ?? ''));
      if (!abbr) continue;
      const stats: any[] = entry?.stats ?? [];
      const stat = (name: string): number | undefined => {
        const s = stats.find((x) => x?.name === name || x?.type === name);
        return s !== undefined ? Number(s.value) : undefined;
      };
      const wins = stat('wins') ?? 0;
      const losses = stat('losses') ?? 0;
      const games = wins + losses;
      // ESPN exposes either per-game averages or season totals depending on endpoint version.
      let pointDiff = stat('avgPointsFor') !== undefined && stat('avgPointsAgainst') !== undefined
        ? stat('avgPointsFor')! - stat('avgPointsAgainst')!
        : 0;
      if (pointDiff === 0 && games > 0) {
        const totalDiff = stat('pointDifferential') ?? stat('differential');
        if (totalDiff !== undefined) {
          pointDiff = Math.abs(totalDiff) > 50 ? totalDiff / games : totalDiff;
        }
      }
      ratings.set(abbr, {
        abbr,
        wins,
        losses,
        pointDiff,
        winPct: games > 0 ? wins / games : 0.5,
      });
    }
  }
  if (ratings.size < 25) {
    throw new Error(
      `ESPN standings parse produced only ${ratings.size} teams — the response shape likely changed. ` +
        `Inspect ${SITE_V2}/standings and update prediction/src/espn.ts.`,
    );
  }
  return ratings;
}

export async function fetchInjuries(): Promise<InjuryReport[]> {
  const data = await getJson<any>(`${SITE}/injuries`);
  const reports: InjuryReport[] = [];
  for (const teamBlock of data?.injuries ?? []) {
    // Team abbreviation lives either on the block or on each injury's athlete.team.
    const blockAbbr = teamBlock?.team?.abbreviation ?? teamBlock?.abbreviation ?? '';
    for (const inj of teamBlock?.injuries ?? []) {
      const abbr = normalizeEspnAbbr(String(inj?.athlete?.team?.abbreviation ?? blockAbbr));
      const player = String(inj?.athlete?.displayName ?? inj?.athlete?.shortName ?? 'unknown');
      const status = String(inj?.status ?? inj?.type?.description ?? 'unknown');
      const report: InjuryReport = { teamAbbr: abbr, player, status };
      const detail = inj?.shortComment ?? inj?.longComment;
      if (detail) report.detail = String(detail);
      reports.push(report);
    }
  }
  return reports;
}
