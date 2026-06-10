const UA = 'nba-prediction-service/1.0 (research tool)';

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
