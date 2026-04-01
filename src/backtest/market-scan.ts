/**
 * Market Scanner — Finds markets with tight spreads for GMM / sniper strategies.
 *
 * Usage: npx tsx src/backtest/market-scan.ts
 *
 * Key insight: Only markets in Polymarket's "sampling markets" have active
 * CLOB orderbooks with liquidity rewards. We use the CLOB /sampling-simplified-markets
 * endpoint to find these, then cross-reference with Gamma API for metadata.
 */

import axios from 'axios';
import { ClobClient } from '@polymarket/clob-client';

const GAMMA_API = 'https://gamma-api.polymarket.com';
const CLOB_URL = 'https://clob.polymarket.com';
const CHAIN_ID = 137;

// Filter thresholds
const MAX_SPREAD = 0.20;
const SNIPER_ASK_THRESHOLD = 0.90;
const MIN_DEPTH = 10;
const RATE_LIMIT_MS = 20;
const BATCH_SIZE = 10;

interface SamplingMarket {
  condition_id: string;
  tokens: Array<{ token_id: string; outcome: string }>;
  rewards?: {
    rates?: Array<{ rewards_daily_rate: number }>;
    min_size?: number;
    max_spread?: number;
  };
  minimum_tick_size?: number;
  [key: string]: any;
}

interface ScanResult {
  question: string;
  conditionId: string;
  yesBid: number;
  yesAsk: number;
  yesSpread: number;
  yesDepthBid: number;
  yesDepthAsk: number;
  noBid: number;
  noAsk: number;
  noSpread: number;
  noDepthBid: number;
  noDepthAsk: number;
  combinedCost: number;
  volume: number;
  ttl: string;
  negRisk: boolean;
  rewardRate: number;
  maxSpreadReq: number;
  tickSize: number;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const truncate = (s: string, len: number) => s.length > len ? s.slice(0, len - 3) + '...' : s;

function formatTTL(endDate: string): string {
  if (!endDate) return 'N/A';
  const ms = new Date(endDate).getTime() - Date.now();
  if (ms <= 0) return 'expired';
  const h = ms / 3.6e6;
  if (h < 1) return `${Math.round(h * 60)}m`;
  if (h < 48) return `${Math.round(h)}h`;
  return `${Math.round(h / 24)}d`;
}

function fmtVol(v: number): string {
  if (v >= 1e6) return '$' + (v / 1e6).toFixed(1) + 'M';
  if (v >= 1e3) return '$' + (v / 1e3).toFixed(1) + 'K';
  return '$' + v.toFixed(0);
}

/** Fetch all sampling-simplified-markets from CLOB (paginated) */
async function fetchSamplingMarkets(): Promise<SamplingMarket[]> {
  const all: SamplingMarket[] = [];
  let nextCursor = '';

  console.log('Fetching CLOB sampling markets (active orderbooks with rewards)...');

  while (true) {
    const params: any = { limit: 100 };
    if (nextCursor) params.next_cursor = nextCursor;

    try {
      const resp = await axios.get(`${CLOB_URL}/sampling-simplified-markets`, {
        params,
        timeout: 15000,
      });

      const data = resp.data?.data || [];
      if (!Array.isArray(data) || data.length === 0) break;
      all.push(...data);

      nextCursor = resp.data?.next_cursor || '';
      if (!nextCursor || nextCursor === 'LTE=') break;

      await sleep(100);
    } catch (e: any) {
      console.error(`  Sampling fetch error: ${e.message}`);
      break;
    }
  }

  console.log(`  Found ${all.length} sampling markets\n`);
  return all;
}

/** Fetch metadata from Gamma for a set of condition IDs */
async function fetchGammaMetadata(conditionIds: string[]): Promise<Map<string, any>> {
  const meta = new Map<string, any>();

  console.log('Fetching market metadata from Gamma API...');

  // Gamma /markets endpoint supports filtering by condition_id
  // But we need to batch since there could be many
  const batchSize = 20;
  for (let i = 0; i < conditionIds.length; i += batchSize) {
    const batch = conditionIds.slice(i, i + batchSize);

    for (const cid of batch) {
      try {
        const resp = await axios.get(`${GAMMA_API}/markets`, {
          params: { clob_token_ids: undefined, condition_id: cid, limit: 1 },
          timeout: 10000,
        });
        const data = Array.isArray(resp.data) ? resp.data : [];
        if (data.length > 0) {
          meta.set(cid, data[0]);
        }
      } catch {}
      await sleep(50);
    }

    if (i % 100 === 0 && i > 0) {
      console.log(`  Fetched metadata for ${i}/${conditionIds.length}...`);
    }
  }

  console.log(`  Got metadata for ${meta.size}/${conditionIds.length} markets\n`);
  return meta;
}

async function main(): Promise<void> {
  console.log('Polymarket Market Scanner');
  console.log('========================');
  console.log('Scanning CLOB sampling markets for tight spreads\n');

  const client = new ClobClient(CLOB_URL, CHAIN_ID);

  // Step 1: Get sampling markets
  const samplingMarkets = await fetchSamplingMarkets();
  if (samplingMarkets.length === 0) {
    console.log('No sampling markets found.');
    return;
  }

  // Step 2: Scan orderbooks
  const conditionIds: string[] = [];
  const results: ScanResult[] = [];
  let processed = 0;

  const estSec = Math.round(samplingMarkets.length / BATCH_SIZE * RATE_LIMIT_MS / 1000);
  console.log(`Scanning ${samplingMarkets.length} orderbooks in batches of ${BATCH_SIZE} (~${estSec}s estimated)...\n`);

  for (let i = 0; i < samplingMarkets.length; i += BATCH_SIZE) {
    const batch = samplingMarkets.slice(i, i + BATCH_SIZE);

    const batchPromises = batch.map(async (sm) => {
      const tokens = sm.tokens || [];
      if (tokens.length < 2) return null;

      const token0 = tokens[0];
      const token1 = tokens[1];

      try {
        const [book0, book1] = await Promise.all([
          client.getOrderBook(token0.token_id),
          client.getOrderBook(token1.token_id),
        ]);

        const bid0 = parseFloat((book0 as any)?.bids?.[0]?.price || '0');
        const ask0 = parseFloat((book0 as any)?.asks?.[0]?.price || '0');
        const bidSize0 = parseFloat((book0 as any)?.bids?.[0]?.size || '0');
        const askSize0 = parseFloat((book0 as any)?.asks?.[0]?.size || '0');
        const spread0 = (ask0 > 0 && bid0 > 0) ? ask0 - bid0 : 999;

        const bid1 = parseFloat((book1 as any)?.bids?.[0]?.price || '0');
        const ask1 = parseFloat((book1 as any)?.asks?.[0]?.price || '0');
        const bidSize1 = parseFloat((book1 as any)?.bids?.[0]?.size || '0');
        const askSize1 = parseFloat((book1 as any)?.asks?.[0]?.size || '0');
        const spread1 = (ask1 > 0 && bid1 > 0) ? ask1 - bid1 : 999;

        const minSpread = Math.min(spread0, spread1);

        const hasTightSpread = minSpread < MAX_SPREAD;
        const hasSniperOpp = ask0 < SNIPER_ASK_THRESHOLD || ask1 < SNIPER_ASK_THRESHOLD;
        const hasDepth = Math.max(bidSize0, askSize0, bidSize1, askSize1) > MIN_DEPTH;

        if (hasDepth && (hasTightSpread || hasSniperOpp)) {
          const combinedCost = (ask0 > 0 ? ask0 : 0) + (ask1 > 0 ? ask1 : 0);
          const rewardRate = sm.rewards?.rates?.[0]?.rewards_daily_rate || 0;
          const maxSpreadReq = sm.rewards?.max_spread || 0;
          const tickSize = sm.minimum_tick_size || 0.01;

          return {
            question: '',
            conditionId: sm.condition_id,
            yesBid: bid0, yesAsk: ask0, yesSpread: spread0,
            yesDepthBid: bidSize0, yesDepthAsk: askSize0,
            noBid: bid1, noAsk: ask1, noSpread: spread1,
            noDepthBid: bidSize1, noDepthAsk: askSize1,
            combinedCost,
            volume: 0,
            ttl: '',
            negRisk: false,
            rewardRate,
            maxSpreadReq,
            tickSize,
          } as ScanResult;
        }
      } catch {}
      return null;
    });

    const batchResults = await Promise.all(batchPromises);
    for (const r of batchResults) {
      if (r) {
        results.push(r);
        conditionIds.push(r.conditionId);
      }
    }

    processed += batch.length;
    if (processed % 100 === 0 || i + BATCH_SIZE >= samplingMarkets.length) {
      console.log(`  ${processed}/${samplingMarkets.length} scanned (${results.length} matches)...`);
    }
    await sleep(RATE_LIMIT_MS);
  }

  console.log(`\nOrderbook scan: ${processed} checked, ${results.length} matches\n`);

  // Step 3: Fetch Gamma metadata for matches
  if (results.length > 0) {
    const meta = await fetchGammaMetadata(conditionIds);
    for (const r of results) {
      const m = meta.get(r.conditionId);
      if (m) {
        r.question = m.question || r.conditionId.slice(0, 12);
        r.volume = parseFloat(m.volume || '0');
        r.ttl = formatTTL(m.endDate || '');
        r.negRisk = m.neg_risk === true || m.negRisk === true;
      } else {
        r.question = r.conditionId.slice(0, 12) + '...';
        r.ttl = 'N/A';
      }
    }
  }

  // Print results
  printResults(results);
}

function printResults(results: ScanResult[]): void {
  results.sort((a, b) => Math.min(a.yesSpread, a.noSpread) - Math.min(b.yesSpread, b.noSpread));

  const W = 190;
  const sep = '-'.repeat(W);

  const header = [
    'Question'.padEnd(45),
    'Y Bid'.padStart(7),
    'Y Ask'.padStart(7),
    'YSprd'.padStart(7),
    'N Bid'.padStart(7),
    'N Ask'.padStart(7),
    'NSprd'.padStart(7),
    'Comb'.padStart(7),
    'Volume'.padStart(10),
    'TTL'.padStart(7),
    'Reward'.padStart(8),
    'MaxSprd'.padStart(7),
    'Tick'.padStart(6),
    'NR'.padStart(3),
  ].join(' | ');

  console.log('\n' + '='.repeat(W));
  console.log('MARKET SCAN RESULTS -- Sorted by tightest spread');
  console.log(`Filters: spread < $${MAX_SPREAD.toFixed(2)} OR ask < $${SNIPER_ASK_THRESHOLD.toFixed(2)}, depth > ${MIN_DEPTH} shares`);
  console.log('='.repeat(W));
  console.log(header);
  console.log(sep);

  const fmtP = (v: number) => v > 0 ? v.toFixed(3).padStart(7) : '  N/A  ';
  const fmtS = (v: number) => v < 999 ? v.toFixed(3).padStart(7) : '  N/A  ';

  for (const r of results) {
    const flag = (r.yesAsk < SNIPER_ASK_THRESHOLD || r.noAsk < SNIPER_ASK_THRESHOLD) ? ' *' : '';

    const row = [
      truncate(r.question, 45).padEnd(45),
      fmtP(r.yesBid), fmtP(r.yesAsk), fmtS(r.yesSpread),
      fmtP(r.noBid), fmtP(r.noAsk), fmtS(r.noSpread),
      r.combinedCost.toFixed(3).padStart(7),
      fmtVol(r.volume).padStart(10),
      r.ttl.padStart(7),
      (r.rewardRate > 0 ? r.rewardRate.toFixed(4) : '   -   ').padStart(8),
      (r.maxSpreadReq > 0 ? r.maxSpreadReq.toFixed(1) : '  -  ').padStart(7),
      r.tickSize.toFixed(3).padStart(6),
      (r.negRisk ? 'Y' : 'N').padStart(3),
    ].join(' | ');

    console.log(row + flag);
  }

  console.log(sep);
  console.log(`\nTotal: ${results.length} markets matching criteria`);

  if (results.length > 0) {
    const spreads = results.map(r => Math.min(r.yesSpread, r.noSpread)).filter(s => s < 999);
    const avgSpread = spreads.length ? spreads.reduce((a, b) => a + b, 0) / spreads.length : 0;
    const sniperCount = results.filter(r => r.yesAsk < SNIPER_ASK_THRESHOLD || r.noAsk < SNIPER_ASK_THRESHOLD).length;
    const gmmCandidates = results.filter(r => Math.min(r.yesSpread, r.noSpread) < 0.05).length;
    const arbCandidates = results.filter(r => r.combinedCost < 0.98).length;
    const rewardMarkets = results.filter(r => r.rewardRate > 0).length;

    console.log('\n--- Summary ---');
    console.log(`Average min spread:              $${avgSpread.toFixed(4)}`);
    console.log(`GMM candidates (spread < $0.05): ${gmmCandidates}`);
    console.log(`Sniper candidates (ask < $0.90): ${sniperCount}`);
    console.log(`Arb candidates (combined < $0.98): ${arbCandidates}`);
    console.log(`Markets with liquidity rewards:  ${rewardMarkets}`);
    console.log(`* = sniper opportunity`);
  }
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
