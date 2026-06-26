import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CACHE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'cache');

interface CacheEnvelope<T> {
  savedAt: string;
  data: T;
}

function cachePath(key: string): string {
  return join(CACHE_DIR, `${key}.json`);
}

function ageHours(savedAt: string): number {
  const t = Date.parse(savedAt);
  if (Number.isNaN(t)) return Infinity;
  return (Date.now() - t) / 3_600_000;
}

/**
 * Fetch with an on-disk fallback so picks still come out when the live host is
 * unreachable (e.g. a sandbox egress allowlist blocks ESPN / Polymarket).
 *
 * - On a successful fetch the result is written to `data/cache/<key>.json`.
 * - If the fetch throws, the last cached value is returned with a staleness warning.
 * - A hand-written `data/cache/<key>.json` (see prediction/README.md for the shape)
 *   is therefore enough to run the whole pipeline fully offline / from manual input.
 */
export async function cachedFetch<T>(
  key: string,
  fetcher: () => Promise<T>,
  opts: { staleAfterHours?: number } = {},
): Promise<T> {
  try {
    const data = await fetcher();
    writeCache(key, data);
    return data;
  } catch (err) {
    const cached = readCache<T>(key);
    if (cached) {
      const age = ageHours(cached.savedAt);
      const stale = opts.staleAfterHours !== undefined && age > opts.staleAfterHours;
      console.error(
        `(live fetch for "${key}" failed: ${err instanceof Error ? err.message : err})\n` +
          `  -> using cached snapshot from ${cached.savedAt} (${age.toFixed(1)}h old)` +
          (stale ? ' [STALE — data may be out of date, refresh when network is available]' : ''),
      );
      return cached.data;
    }
    throw new Error(
      `Live fetch for "${key}" failed and no cached snapshot exists at ${cachePath(key)}.\n` +
        `  Original error: ${err instanceof Error ? err.message : err}\n` +
        `  Fix: allowlist the data host for network egress, OR drop a snapshot file at\n` +
        `  ${cachePath(key)} (see prediction/README.md "Offline / snapshot mode").`,
    );
  }
}

export function readCache<T>(key: string): CacheEnvelope<T> | null {
  const path = cachePath(key);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as CacheEnvelope<T>;
  } catch {
    return null;
  }
}

export function writeCache<T>(key: string, data: T): void {
  mkdirSync(CACHE_DIR, { recursive: true });
  const envelope: CacheEnvelope<T> = { savedAt: new Date().toISOString(), data };
  writeFileSync(cachePath(key), JSON.stringify(envelope, null, 2));
}
