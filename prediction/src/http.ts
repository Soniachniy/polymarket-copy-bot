const UA = 'nba-prediction-service/1.0 (research tool)';

/** Every host the pipeline must reach. Surfaced when a request is blocked by an egress allowlist. */
export const REQUIRED_HOSTS = [
  'gamma-api.polymarket.com',
  'site.api.espn.com',
] as const;

function isAllowlistBlock(status: number, body: string): boolean {
  // The agent proxy returns 403 with this phrasing when a host isn't permitted by egress settings.
  return status === 403 && /not in allowlist|egress/i.test(body);
}

export async function getJson<T = unknown>(url: string, retries = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: 'application/json' },
        signal: AbortSignal.timeout(20_000),
      });
      if (res.status === 429 || res.status >= 500) {
        throw new Error(`HTTP ${res.status} from ${url}`);
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        if (isAllowlistBlock(res.status, body)) {
          throw new FatalHttpError(
            `Network egress blocked this request (${new URL(url).host}).\n` +
              `This session's network policy must allow these hosts before the predictor can fetch data:\n` +
              REQUIRED_HOSTS.map((h) => `  - ${h}`).join('\n') +
              `\nAdd them to the environment's network egress / allowlist settings, then re-run. ` +
              `No picks can be produced without live data — the pipeline will not fabricate a slate.`,
          );
        }
        throw new FatalHttpError(`HTTP ${res.status} from ${url}: ${body.slice(0, 200)}`);
      }
      return (await res.json()) as T;
    } catch (err) {
      if (err instanceof FatalHttpError) throw err;
      lastError = err;
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      }
    }
  }
  throw new Error(`Failed to fetch ${url} after ${retries + 1} attempts: ${lastError}`);
}

export class FatalHttpError extends Error {}
