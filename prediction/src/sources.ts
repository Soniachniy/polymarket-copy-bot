import { fetchInjuries, fetchScoreboard, fetchStandings } from './espn.js';
import { fetchNbaMarkets } from './polymarket.js';
import { readSnapshot, writeSnapshot } from './snapshot.js';
import type { GameInfo, InjuryReport, NbaMarket, TeamRating } from './types.js';

/**
 * Data-source resolution with a snapshot fallback so the engine runs whether or
 * not the live hosts are reachable.
 *
 * - offline=false: fetch live, cache the result to a snapshot, and on any live
 *   failure fall back to the last cached snapshot (warning to stderr).
 * - offline=true: read the snapshot only; never touch the network. This is the
 *   path to use after Claude has written snapshots from its own web research.
 */

function warn(msg: string): void {
  console.error(msg);
}

async function resolve<T>(
  name: string,
  live: () => Promise<T>,
  offline: boolean,
  fromSnapshot: (raw: unknown) => T,
): Promise<T> {
  if (offline) {
    const snap = readSnapshot<unknown>(name);
    if (snap === null) {
      throw new Error(
        `--offline set but no snapshot at data/snapshot/${name}.json. ` +
          `Write it (via web research) before running offline.`,
      );
    }
    return fromSnapshot(snap);
  }
  try {
    const data = await live();
    writeSnapshot(name, data);
    return data;
  } catch (err) {
    const snap = readSnapshot<unknown>(name);
    if (snap !== null) {
      warn(`(live ${name} fetch failed: ${err}; using cached snapshot data/snapshot/${name}.json)`);
      return fromSnapshot(snap);
    }
    throw err;
  }
}

export function loadMarkets(offline: boolean): Promise<NbaMarket[]> {
  return resolve('markets', fetchNbaMarkets, offline, (raw) => raw as NbaMarket[]);
}

export async function loadStandings(offline: boolean): Promise<Map<string, TeamRating>> {
  const toMap = (raw: unknown): Map<string, TeamRating> =>
    new Map(Object.entries(raw as Record<string, TeamRating>));
  if (offline) {
    const snap = readSnapshot<Record<string, TeamRating>>('standings');
    if (snap === null) {
      throw new Error(
        '--offline set but no snapshot at data/snapshot/standings.json. ' +
          'Write it (via web research) before running offline, or drop it to run market-only.',
      );
    }
    return toMap(snap);
  }
  try {
    const ratings = await fetchStandings();
    // A Map serializes to {}; cache the object form so offline reload works.
    writeSnapshot('standings', Object.fromEntries(ratings));
    return ratings;
  } catch (err) {
    const snap = readSnapshot<Record<string, TeamRating>>('standings');
    if (snap !== null) {
      warn(`(live standings fetch failed: ${err}; using cached data/snapshot/standings.json)`);
      return toMap(snap);
    }
    throw err;
  }
}

export function loadInjuries(offline: boolean): Promise<InjuryReport[]> {
  return resolve('injuries', fetchInjuries, offline, (raw) => raw as InjuryReport[]).catch((e) => {
    warn(`(injuries unavailable, continuing without: ${e})`);
    return [];
  });
}

export function loadScoreboard(dateYmd: string | undefined, offline: boolean): Promise<GameInfo[]> {
  const name = `scoreboard-${dateYmd ?? 'latest'}`;
  return resolve(name, () => fetchScoreboard(dateYmd), offline, (raw) => raw as GameInfo[]);
}
