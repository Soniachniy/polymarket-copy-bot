import { cachedFetch } from './cache.js';
import { getJson } from './http.js';
import { resolveTeam } from './teams.js';
import type { NbaMarket } from './types.js';

const GAMMA = 'https://gamma-api.polymarket.com';

function parseMaybeJsonArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      /* fall through */
    }
  }
  return [];
}

interface GammaMarket {
  question?: string;
  slug?: string;
  conditionId?: string;
  endDate?: string;
  gameStartTime?: string;
  liquidity?: string | number;
  volume?: string | number;
  outcomes?: unknown;
  outcomePrices?: unknown;
  bestBid?: number;
  bestAsk?: number;
  active?: boolean;
  closed?: boolean;
}

interface GammaEvent {
  title?: string;
  slug?: string;
  markets?: GammaMarket[];
}

export function normalizeMarkets(events: GammaEvent[]): NbaMarket[] {
  const out: NbaMarket[] = [];
  for (const ev of events) {
    for (const m of ev.markets ?? []) {
      if (m.closed === true || m.active === false) continue;
      const outcomes = parseMaybeJsonArray(m.outcomes);
      const prices = parseMaybeJsonArray(m.outcomePrices).map(Number);
      if (outcomes.length === 0 || outcomes.length !== prices.length) continue;
      const market: NbaMarket = {
        eventTitle: ev.title ?? '',
        question: m.question ?? '',
        slug: m.slug ?? ev.slug ?? '',
        conditionId: m.conditionId ?? '',
        outcomes,
        prices,
        teamAbbrs: outcomes.map((o) => resolveTeam(o) ?? ''),
      };
      if (m.endDate !== undefined) market.endDate = m.endDate;
      if (m.gameStartTime !== undefined) market.gameStartTime = m.gameStartTime;
      if (m.liquidity !== undefined) market.liquidity = Number(m.liquidity);
      if (m.volume !== undefined) market.volume = Number(m.volume);
      out.push(market);
    }
  }
  return out;
}

/** A moneyline game market: exactly two outcomes, both resolving to NBA teams. */
export function isMoneylineMarket(m: NbaMarket): boolean {
  return (
    m.outcomes.length === 2 &&
    m.teamAbbrs.length === 2 &&
    m.teamAbbrs[0] !== '' &&
    m.teamAbbrs[1] !== '' &&
    m.teamAbbrs[0] !== m.teamAbbrs[1]
  );
}

export async function fetchNbaMarkets(): Promise<NbaMarket[]> {
  // Cache key holds normalized markets so a manual snapshot can be hand-written too.
  return cachedFetch('markets', fetchNbaMarketsLive, { staleAfterHours: 12 });
}

async function fetchNbaMarketsLive(): Promise<NbaMarket[]> {
  const all: GammaEvent[] = [];
  const limit = 100;
  for (let offset = 0; offset < 500; offset += limit) {
    const url = `${GAMMA}/events?tag_slug=nba&closed=false&limit=${limit}&offset=${offset}`;
    const page = await getJson<GammaEvent[]>(url);
    if (!Array.isArray(page)) {
      throw new Error(
        `Unexpected Gamma API response shape at ${url} — expected an array of events. ` +
          `Inspect the endpoint manually and update prediction/src/polymarket.ts.`,
      );
    }
    all.push(...page);
    if (page.length < limit) break;
  }
  return normalizeMarkets(all);
}
