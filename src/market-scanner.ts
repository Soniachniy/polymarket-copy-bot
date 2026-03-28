import axios from 'axios';
import { ClobClient } from '@polymarket/clob-client';

export interface ScannedMarket {
  conditionId: string;
  question: string;
  /** First outcome token (YES or Up) */
  yesTokenId: string;
  /** Second outcome token (NO or Down) */
  noTokenId: string;
  yesBestAsk: number;
  noBestAsk: number;
  yesBestBid: number;
  noBestBid: number;
  combinedCost: number;
  strikePrice: number;
  expiresAt: number;
  volume24h: number;
  negRisk: boolean;
  /** Market type: 'updown' for Up/Down 5m markets, 'price' for above/below */
  marketType: 'updown' | 'price';
  slug: string;
  /** Gamma implied probability for Up/Yes side (from outcomePrices) */
  yesOutcomePrice: number;
  /** Gamma implied probability for Down/No side (from outcomePrices) */
  noOutcomePrice: number;
}

interface GammaEventMarket {
  id: string;
  question: string;
  conditionId: string;
  slug: string;
  outcomes: string;        // JSON string: '["Up", "Down"]'
  outcomePrices: string;   // JSON string: '["0.495", "0.505"]'
  endDate: string;
  closed: boolean;
  active: boolean;
  clobTokenIds: string;    // JSON string: '["tokenId1", "tokenId2"]'
  volume: string;
  neg_risk?: boolean;
  negRisk?: boolean;
  acceptingOrders?: boolean;
  orderMinSize?: number;
  [key: string]: any;
}

interface GammaEvent {
  id: string;
  title: string;
  slug: string;
  endDate: string;
  active: boolean;
  closed: boolean;
  negRisk?: boolean;
  enableNegRisk?: boolean;
  markets: GammaEventMarket[];
  [key: string]: any;
}

interface GammaMarketToken {
  token_id: string;
  outcome: string;
}

interface GammaMarketResponse {
  condition_id: string;
  question: string;
  tokens: GammaMarketToken[];
  end_date_iso?: string;
  volume_24hr?: number;
  active?: boolean;
  closed?: boolean;
  neg_risk?: boolean;
  [key: string]: any;
}

const GAMMA_API = 'https://gamma-api.polymarket.com';

export class MarketScanner {
  private clobClient: ClobClient;
  private cache: ScannedMarket[] = [];
  private lastScanTime = 0;
  private readonly cacheTtlMs: number;

  constructor(clobClient: ClobClient, options: { cacheTtlMs?: number } = {}) {
    this.clobClient = clobClient;
    this.cacheTtlMs = options.cacheTtlMs || 60_000;
  }

  /**
   * Scan Gamma API for active Bitcoin markets:
   *   1. Short-term Up/Down 5m markets (btc-updown-5m-*)
   *   2. Traditional price-above markets (fallback)
   */
  async scan(forceRefresh = false): Promise<ScannedMarket[]> {
    const now = Date.now();
    if (!forceRefresh && this.cache.length > 0 && (now - this.lastScanTime) < this.cacheTtlMs) {
      return this.cache;
    }

    console.log('🔍 Scanning for BTC markets...');

    try {
      // Primary: find btc-updown-5m events via events endpoint
      const updownMarkets = await this.fetchUpDownMarkets();
      console.log(`   Found ${updownMarkets.length} BTC Up/Down market(s)`);

      // Enrich with real orderbook data
      const scanned: ScannedMarket[] = [];
      for (const market of updownMarkets) {
        try {
          const enriched = await this.enrichUpDownWithOrderbook(market);
          if (enriched) scanned.push(enriched);
        } catch (error: any) {
          // Skip silently
        }
      }

      // Fallback: also try traditional price markets if no updown found
      if (scanned.length === 0) {
        const priceMarkets = await this.fetchPriceMarkets();
        for (const market of priceMarkets) {
          try {
            const result = await this.enrichPriceMarketWithOrderbook(market);
            if (result) scanned.push(result);
          } catch {}
        }
      }

      this.cache = scanned;
      this.lastScanTime = now;

      console.log(`   ✅ ${scanned.length} market(s) ready for volatility strategy`);
      return scanned;
    } catch (error: any) {
      console.error(`❌ Market scan failed: ${error.message}`);
      return this.cache;
    }
  }

  // ── Up/Down 5m market discovery ─────────────────────────────────────────

  /**
   * Find active btc-updown-5m events via the /events endpoint.
   * These are short-term (5 min) "Bitcoin Up or Down" markets with outcomes ["Up", "Down"].
   * Discovery: query events sorted by endDate ascending with end_date_min=now.
   */
  private async fetchUpDownMarkets(): Promise<GammaEventMarket[]> {
    const now = new Date().toISOString();
    const results: GammaEventMarket[] = [];

    try {
      const resp = await axios.get(`${GAMMA_API}/events`, {
        params: {
          active: true,
          closed: false,
          end_date_min: now,
          limit: 50,
          order: 'endDate',
          ascending: true,
        },
        timeout: 10000,
      });

      const events: GammaEvent[] = Array.isArray(resp.data) ? resp.data : [];

      for (const event of events) {
        const slug = event.slug || '';
        // Match btc-updown-5m-* pattern
        if (!slug.startsWith('btc-updown-5m-')) continue;
        if (event.closed) continue;

        for (const market of event.markets || []) {
          if (market.closed) continue;
          if (market.acceptingOrders === false) continue;
          results.push(market);
        }
      }
    } catch (error: any) {
      console.log(`   ⚠️  Events query failed: ${error.message}`);
    }

    return results;
  }

  private async enrichUpDownWithOrderbook(market: GammaEventMarket): Promise<ScannedMarket | null> {
    // Parse token IDs from JSON string
    let tokenIds: string[] = [];
    try {
      tokenIds = JSON.parse(market.clobTokenIds || '[]');
    } catch { return null; }

    if (tokenIds.length < 2) return null;

    // Parse outcomes to identify Up/Down
    let outcomes: string[] = [];
    try {
      outcomes = JSON.parse(market.outcomes || '[]');
    } catch { return null; }

    // Up = first outcome (index 0), Down = second (index 1)
    const upIdx = outcomes.findIndex(o => o.toLowerCase() === 'up');
    const downIdx = outcomes.findIndex(o => o.toLowerCase() === 'down');
    if (upIdx < 0 || downIdx < 0) return null;

    const upTokenId = tokenIds[upIdx]!;
    const downTokenId = tokenIds[downIdx]!;

    // Parse Gamma outcomePrices (implied probabilities)
    let outcomePrices: number[] = [];
    try {
      outcomePrices = JSON.parse(market.outcomePrices || '[]').map(Number);
    } catch {}
    const upOutcomePrice = outcomePrices[upIdx] ?? 0.5;
    const downOutcomePrice = outcomePrices[downIdx] ?? 0.5;

    // Parse expiry
    const expiresAt = market.endDate ? new Date(market.endDate).getTime() : 0;
    if (expiresAt <= 0 || expiresAt <= Date.now()) return null;

    // Fetch REAL orderbooks
    const [upBook, downBook] = await Promise.all([
      this.clobClient.getOrderBook(upTokenId).catch(() => null),
      this.clobClient.getOrderBook(downTokenId).catch(() => null),
    ]);

    if (!upBook || !downBook) return null;

    const upBestAsk = parseFloat(upBook.asks?.[0]?.price || '0');
    const downBestAsk = parseFloat(downBook.asks?.[0]?.price || '0');
    const upBestBid = parseFloat(upBook.bids?.[0]?.price || '0');
    const downBestBid = parseFloat(downBook.bids?.[0]?.price || '0');

    if (upBestAsk <= 0 || downBestAsk <= 0) return null;

    const combinedCost = upBestAsk + downBestAsk;

    return {
      conditionId: market.conditionId,
      question: market.question,
      yesTokenId: upTokenId,      // Up = "Yes" equivalent
      noTokenId: downTokenId,     // Down = "No" equivalent
      yesBestAsk: upBestAsk,
      noBestAsk: downBestAsk,
      yesBestBid: upBestBid,
      noBestBid: downBestBid,
      combinedCost,
      strikePrice: 0,             // Up/Down markets don't have a strike — they track direction
      expiresAt,
      volume24h: parseFloat(String(market.volume || '0')),
      negRisk: market.neg_risk === true || market.negRisk === true,
      marketType: 'updown',
      slug: market.slug,
      yesOutcomePrice: upOutcomePrice,
      noOutcomePrice: downOutcomePrice,
    };
  }

  // ── Traditional price market discovery (fallback) ───────────────────────

  private async fetchPriceMarkets(): Promise<GammaMarketResponse[]> {
    const results: GammaMarketResponse[] = [];

    for (const tag of ['crypto', 'bitcoin']) {
      try {
        const resp = await axios.get(`${GAMMA_API}/markets`, {
          params: { tag, active: true, closed: false, limit: 100 },
          timeout: 10000,
        });
        const data = Array.isArray(resp.data) ? resp.data : [];
        results.push(...data);
      } catch {}
    }

    try {
      const resp = await axios.get(`${GAMMA_API}/markets`, {
        params: { text_query: 'bitcoin price', active: true, closed: false, limit: 100 },
        timeout: 10000,
      });
      const data = Array.isArray(resp.data) ? resp.data : [];
      results.push(...data);
    } catch {}

    const seen = new Set<string>();
    const unique: GammaMarketResponse[] = [];
    for (const m of results) {
      const id = m.condition_id;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const q = (m.question || '').toLowerCase();
      if (!q.includes('bitcoin') && !q.includes('btc')) continue;
      if (!m.tokens || m.tokens.length < 2) continue;
      if (m.closed === true) continue;
      unique.push(m);
    }

    return unique;
  }

  private async enrichPriceMarketWithOrderbook(market: GammaMarketResponse): Promise<ScannedMarket | null> {
    const yesToken = market.tokens.find((t) => t.outcome.toUpperCase() === 'YES');
    const noToken = market.tokens.find((t) => t.outcome.toUpperCase() === 'NO');
    if (!yesToken || !noToken) return null;

    const strikePrice = this.parseStrikePrice(market.question);
    const expiresAt = this.parseExpiry(market);
    if (strikePrice <= 0) return null;

    const [yesBook, noBook] = await Promise.all([
      this.clobClient.getOrderBook(yesToken.token_id).catch(() => null),
      this.clobClient.getOrderBook(noToken.token_id).catch(() => null),
    ]);
    if (!yesBook || !noBook) return null;

    const yesBestAsk = parseFloat(yesBook.asks?.[0]?.price || '0');
    const noBestAsk = parseFloat(noBook.asks?.[0]?.price || '0');
    const yesBestBid = parseFloat(yesBook.bids?.[0]?.price || '0');
    const noBestBid = parseFloat(noBook.bids?.[0]?.price || '0');
    if (yesBestAsk <= 0 || noBestAsk <= 0) return null;

    return {
      conditionId: market.condition_id,
      question: market.question,
      yesTokenId: yesToken.token_id,
      noTokenId: noToken.token_id,
      yesBestAsk, noBestAsk, yesBestBid, noBestBid,
      combinedCost: yesBestAsk + noBestAsk,
      strikePrice,
      expiresAt,
      volume24h: parseFloat(String(market.volume_24hr || '0')),
      negRisk: market.neg_risk === true,
      marketType: 'price',
      slug: '',
      yesOutcomePrice: yesBestAsk,
      noOutcomePrice: noBestAsk,
    };
  }

  parseStrikePrice(question: string): number {
    if (!question) return 0;
    const dollarMatch = question.match(/\$\s*([\d,]+(?:\.\d+)?)/);
    if (dollarMatch?.[1]) {
      const value = parseFloat(dollarMatch[1].replace(/,/g, ''));
      if (Number.isFinite(value) && value > 0) return value;
    }
    const kMatch = question.match(/([\d,]+(?:\.\d+)?)\s*[kK]/);
    if (kMatch?.[1]) {
      const value = parseFloat(kMatch[1].replace(/,/g, '')) * 1000;
      if (Number.isFinite(value) && value > 0) return value;
    }
    return 0;
  }

  private parseExpiry(market: GammaMarketResponse): number {
    if (market.end_date_iso) {
      const ts = new Date(market.end_date_iso).getTime();
      if (Number.isFinite(ts)) return ts;
    }
    const question = market.question || '';
    const dateMatch = question.match(/(\w+ \d{1,2},?\s*\d{4}[\s,]+\d{1,2}:\d{2}\s*(?:AM|PM|am|pm)?)/);
    if (dateMatch?.[1]) {
      const ts = new Date(dateMatch[1]).getTime();
      if (Number.isFinite(ts)) return ts;
    }
    return 0;
  }

  getCachedMarkets(): ScannedMarket[] {
    return [...this.cache];
  }
}
