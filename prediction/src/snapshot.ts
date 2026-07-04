import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Snapshot layer: lets the prediction engine run even when the live data hosts
 * (gamma-api.polymarket.com, site.api.espn.com) are not on the environment's
 * network egress allowlist.
 *
 * Every live fetch is cached to `data/snapshot/<name>.json` on success. When a
 * live fetch fails (403 host-not-allowed, timeout, ...) the engine falls back to
 * the most recent snapshot. In `--offline` mode the snapshot is used directly and
 * the network is never touched — the intended path when Claude has already
 * gathered the data via its own web tools and written it into the snapshot files.
 */

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
export const SNAPSHOT_DIR = join(DATA_DIR, 'snapshot');

export function snapshotPath(name: string): string {
  return join(SNAPSHOT_DIR, `${name}.json`);
}

export function readSnapshot<T>(name: string): T | null {
  const p = snapshotPath(name);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as T;
  } catch (err) {
    throw new Error(`Snapshot ${p} is not valid JSON: ${err}`);
  }
}

export function writeSnapshot(name: string, data: unknown): void {
  mkdirSync(SNAPSHOT_DIR, { recursive: true });
  writeFileSync(snapshotPath(name), JSON.stringify(data, null, 2) + '\n');
}

export function hasSnapshot(name: string): boolean {
  return existsSync(snapshotPath(name));
}
