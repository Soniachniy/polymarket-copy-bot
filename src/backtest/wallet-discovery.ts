#!/usr/bin/env tsx
/**
 * WALLET DISCOVERY PIPELINE
 *
 * Finds Polymarket wallets that grew from small balances ($1-$50) to hundreds+
 * with 80%+ win rate. These are the wallets worth copy-trading.
 *
 * Pipeline:
 *   1. Harvest unique wallet addresses from the global trades feed
 *   2. For each wallet, fetch positions with P&L data
 *   3. Score wallets: win rate, total profit, growth factor, consistency
 *   4. Rank and output top candidates
 *
 * Usage:
 *   npx tsx src/backtest/wallet-discovery.ts                 # default: whale discovery (top by volume)
 *   npx tsx src/backtest/wallet-discovery.ts --small          # find small-account growers ($1-$1000 volume)
 *   npx tsx src/backtest/wallet-discovery.ts --small --maxvol 500  # stricter volume cap
 *   npx tsx src/backtest/wallet-discovery.ts --trades 10000  # harvest more trades
 *   npx tsx src/backtest/wallet-discovery.ts --deep           # analyze all discovered wallets (slow)
 */

import axios from 'axios';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

const DATA_API = 'https://data-api.polymarket.com';

// ── Configuration ──────────────────────────────────────────────────────────

interface DiscoveryConfig {
  maxTradesToHarvest: number;
  maxWalletsToAnalyze: number;
  minWinRate: number;          // 0.80 = 80%
  minTotalProfit: number;      // minimum $ profit
  minPositions: number;        // minimum resolved positions
  minGrowthFactor: number;     // final / initial (e.g. 5 = 5x growth)
  requestDelayMs: number;      // rate limit between API calls
  cacheFile: string;           // cache discovered wallets
  smallAccountMode: boolean;   // find small-account growers instead of whales
  maxVolume: number;           // max harvest volume to consider (for small mode)
}

function loadConfig(): DiscoveryConfig {
  const args = process.argv.slice(2);
  const getArg = (name: string, def: string) => {
    const idx = args.indexOf(`--${name}`);
    return idx >= 0 && args[idx + 1] ? args[idx + 1] : def;
  };

  const isSmall = args.includes('--small');

  return {
    maxTradesToHarvest: parseInt(getArg('trades', '5000')),
    maxWalletsToAnalyze: args.includes('--deep') ? 9999 : parseInt(getArg('wallets', isSmall ? '800' : '200')),
    minWinRate: parseFloat(getArg('winrate', isSmall ? '0.70' : '0.80')),
    minTotalProfit: parseFloat(getArg('profit', isSmall ? '10' : '50')),
    minPositions: parseInt(getArg('positions', '5')),
    minGrowthFactor: parseFloat(getArg('growth', '3')),
    requestDelayMs: parseInt(getArg('delay', '250')),
    cacheFile: join(process.cwd(), 'backtest', 'data', 'wallet_cache.json'),
    smallAccountMode: isSmall,
    maxVolume: parseFloat(getArg('maxvol', '1000')),
  };
}

// ── Types ───────────────────────────────────────────────────────────────────

interface WalletScore {
  address: string;
  name: string;
  bio: string;

  // P&L
  totalProfit: number;
  totalLoss: number;
  netPnl: number;
  realizedPnl: number;

  // Win rate
  wins: number;
  losses: number;
  totalPositions: number;
  winRate: number;

  // Growth
  totalBought: number;
  biggestWin: number;
  biggestLoss: number;
  avgWin: number;
  avgLoss: number;

  // Activity
  markets: number;
  activePositions: number;
  latestTrade: number;

  // Growth
  roi: number;                // netPnl / totalBought

  // Composite score
  score: number;

  // Top positions (for review)
  topWins: Array<{ title: string; pnl: number; pct: number }>;
  topLosses: Array<{ title: string; pnl: number; pct: number }>;
}

interface TradeEntry {
  proxyWallet: string;
  name?: string;
  pseudonym?: string;
  size: number;
  price: number;
  side: string;
  timestamp: number;
}

interface PositionEntry {
  conditionId: string;
  title: string;
  slug: string;
  outcome: string;
  size: number;
  avgPrice: number;
  curPrice: number;
  initialValue: number;
  currentValue: number;
  cashPnl: number;
  percentPnl: number;
  realizedPnl: number;
  totalBought: number;
  endDate: string;
  redeemable: boolean;
}

// ── Phase 1: Harvest Wallets from Global Trades Feed ────────────────────

async function harvestWallets(cfg: DiscoveryConfig): Promise<Map<string, { name: string; tradeCount: number; totalVolume: number; latestTrade: number }>> {
  const wallets = new Map<string, { name: string; tradeCount: number; totalVolume: number; latestTrade: number }>();
  let harvested = 0;
  let offset = 0;
  const batchSize = 1000;

  console.log(`\n📡 Phase 1: Harvesting wallets from global trades feed...`);
  console.log(`   Target: ${cfg.maxTradesToHarvest} trades\n`);

  while (harvested < cfg.maxTradesToHarvest) {
    try {
      const resp = await axios.get(`${DATA_API}/trades`, {
        params: { limit: batchSize, offset },
        timeout: 15000,
      });

      const trades: TradeEntry[] = Array.isArray(resp.data) ? resp.data : [];
      if (trades.length === 0) break;

      for (const t of trades) {
        const addr = t.proxyWallet;
        if (!addr) continue;

        const usdcValue = (t.size || 0) * (t.price || 0);
        const existing = wallets.get(addr);
        if (existing) {
          existing.tradeCount++;
          existing.totalVolume += usdcValue;
          existing.latestTrade = Math.max(existing.latestTrade, t.timestamp || 0);
        } else {
          wallets.set(addr, {
            name: t.name || t.pseudonym || '',
            tradeCount: 1,
            totalVolume: usdcValue,
            latestTrade: t.timestamp || 0,
          });
        }
      }

      harvested += trades.length;
      offset += trades.length;
      process.stdout.write(`\r   Harvested ${harvested} trades → ${wallets.size} unique wallets`);

      await sleep(cfg.requestDelayMs);
    } catch (err: any) {
      // API returns 400 when offset is too large — stop harvesting
      console.log(`\n   ⚠️  Harvest stopped at offset ${offset} (API limit reached)`);
      break;
    }
  }

  console.log(`\n   ✅ Harvested ${harvested} trades → ${wallets.size} unique wallets\n`);
  return wallets;
}

// ── Phase 2: Analyze Individual Wallets ─────────────────────────────────

async function analyzeWallet(address: string, name: string, cfg: DiscoveryConfig, harvestVolume?: number): Promise<WalletScore | null> {
  try {
    // Fetch all positions
    const positions = await fetchAllPositions(address, cfg.requestDelayMs);
    if (positions.length < cfg.minPositions) return null;

    // Separate resolved vs open
    const now = Date.now();
    const resolved: PositionEntry[] = [];
    const open: PositionEntry[] = [];

    for (const p of positions) {
      const endMs = p.endDate ? new Date(p.endDate).getTime() : 0;
      if (endMs > 0 && endMs < now) {
        resolved.push(p);
      } else if (p.redeemable) {
        resolved.push(p);
      } else {
        open.push(p);
      }
    }

    if (resolved.length < cfg.minPositions) return null;

    // Compute stats from resolved positions
    let wins = 0, losses = 0;
    let totalProfit = 0, totalLoss = 0, realizedPnl = 0;
    let totalBought = 0;
    let biggestWin = 0, biggestLoss = 0;
    const winList: Array<{ title: string; pnl: number; pct: number }> = [];
    const lossList: Array<{ title: string; pnl: number; pct: number }> = [];

    for (const p of resolved) {
      const pnl = p.cashPnl || 0;
      realizedPnl += p.realizedPnl || 0;
      totalBought += p.totalBought || 0;

      if (pnl > 0) {
        wins++;
        totalProfit += pnl;
        if (pnl > biggestWin) biggestWin = pnl;
        winList.push({ title: p.title, pnl, pct: p.percentPnl || 0 });
      } else if (pnl < 0) {
        losses++;
        totalLoss += Math.abs(pnl);
        if (Math.abs(pnl) > biggestLoss) biggestLoss = Math.abs(pnl);
        lossList.push({ title: p.title, pnl, pct: p.percentPnl || 0 });
      }
      // pnl === 0 → skip (breakeven)
    }

    const totalPositions = wins + losses;
    if (totalPositions === 0) return null;

    const winRate = wins / totalPositions;
    const netPnl = totalProfit - totalLoss;
    const avgWin = wins > 0 ? totalProfit / wins : 0;
    const avgLoss = losses > 0 ? totalLoss / losses : 0;

    // Sort top wins/losses
    winList.sort((a, b) => b.pnl - a.pnl);
    lossList.sort((a, b) => a.pnl - b.pnl);

    // Unique markets
    const uniqueMarkets = new Set(positions.map(p => p.conditionId)).size;

    // Latest trade timestamp
    let latestTrade = 0;
    for (const p of positions) {
      const endMs = p.endDate ? new Date(p.endDate).getTime() : 0;
      if (endMs > latestTrade) latestTrade = endMs;
    }

    // Composite score
    const profitFactor = avgLoss > 0 ? avgWin / avgLoss : avgWin > 0 ? 10 : 0;
    const roi = totalBought > 0 ? netPnl / totalBought : 0;

    let score: number;
    if (cfg.smallAccountMode) {
      // Small account scoring: heavily weight ROI and win rate
      score =
        (winRate * 30) +                              // 30% weight: win rate
        (Math.min(roi * 10, 25)) +                    // 25% weight: ROI (capped at 250% ROI)
        (Math.min(netPnl / 10, 20)) +                 // 20% weight: net profit (lower cap for small accts)
        (Math.min(profitFactor, 5) * 3) +             // 15% weight: profit factor
        (Math.min(totalPositions / 5, 10));            // 10% weight: sample size
    } else {
      // Whale scoring: weight absolute profit
      score =
        (winRate * 40) +                              // 40% weight: win rate
        (Math.min(netPnl / 100, 30)) +                // 30% weight: net profit (capped)
        (Math.min(profitFactor, 5) * 4) +             // 20% weight: profit factor
        (Math.min(totalPositions / 10, 10));           // 10% weight: sample size
    }

    return {
      address,
      name: name || '',
      bio: '',
      totalProfit,
      totalLoss,
      netPnl,
      realizedPnl,
      wins,
      losses,
      totalPositions,
      winRate,
      totalBought,
      biggestWin,
      biggestLoss,
      avgWin,
      avgLoss,
      markets: uniqueMarkets,
      activePositions: open.length,
      latestTrade,
      roi,
      score,
      topWins: winList.slice(0, 3),
      topLosses: lossList.slice(0, 3),
    };
  } catch (err: any) {
    return null;
  }
}

async function fetchAllPositions(address: string, delayMs: number): Promise<PositionEntry[]> {
  const all: PositionEntry[] = [];
  let offset = 0;
  const limit = 200;
  const maxPages = 5; // Cap at 1000 positions to avoid hanging on whale wallets
  let page = 0;

  while (page < maxPages) {
    try {
      const resp = await axios.get(`${DATA_API}/positions`, {
        params: {
          user: address,
          limit,
          offset,
          sortBy: 'CASHPNL',
          sortOrder: 'desc',
          sizeThreshold: 0,
        },
        timeout: 10000,
      });

      const data = Array.isArray(resp.data) ? resp.data : [];
      if (data.length === 0) break;

      for (const p of data) {
        all.push({
          conditionId: p.conditionId || '',
          title: p.title || '',
          slug: p.slug || '',
          outcome: p.outcome || '',
          size: parseFloat(p.size || '0'),
          avgPrice: parseFloat(p.avgPrice || '0'),
          curPrice: parseFloat(p.curPrice || '0'),
          initialValue: parseFloat(p.initialValue || '0'),
          currentValue: parseFloat(p.currentValue || '0'),
          cashPnl: parseFloat(p.cashPnl || '0'),
          percentPnl: parseFloat(p.percentPnl || '0'),
          realizedPnl: parseFloat(p.realizedPnl || '0'),
          totalBought: parseFloat(p.totalBought || '0'),
          endDate: p.endDate || '',
          redeemable: p.redeemable === true,
        });
      }

      if (data.length < limit) break;
      offset += limit;
      page++;
      await sleep(delayMs);
    } catch {
      break;
    }
  }

  return all;
}

// ── Phase 3: Print & Save Results ───────────────────────────────────────

function printResults(wallets: WalletScore[], cfg: DiscoveryConfig): void {
  // Filter by criteria
  let candidates: WalletScore[];
  if (cfg.smallAccountMode) {
    // Small account mode: find wallets with small invested capital but good returns
    candidates = wallets.filter(w =>
      w.winRate >= cfg.minWinRate &&
      w.netPnl >= cfg.minTotalProfit &&
      w.totalPositions >= cfg.minPositions &&
      w.totalBought <= cfg.maxVolume &&    // actually small account
      w.roi > 0.05                          // at least 5% ROI
    );
  } else {
    candidates = wallets.filter(w =>
      w.winRate >= cfg.minWinRate &&
      w.netPnl >= cfg.minTotalProfit &&
      w.totalPositions >= cfg.minPositions
    );
  }

  // Sort by score
  candidates.sort((a, b) => b.score - a.score);

  console.log('\n' + '='.repeat(120));
  console.log(`🏆 WALLET DISCOVERY RESULTS — Win Rate >= ${(cfg.minWinRate * 100).toFixed(0)}%, Profit >= $${cfg.minTotalProfit}`);
  console.log('='.repeat(120));

  if (candidates.length === 0) {
    console.log('\n   No wallets matched all criteria. Showing top 20 by score instead:\n');

    // Fallback: show top 20 by score regardless of filters
    const top = [...wallets].sort((a, b) => b.score - a.score).slice(0, 20);
    printWalletTable(top);

    // Also show best by win rate
    const byWinRate = [...wallets]
      .filter(w => w.totalPositions >= 5)
      .sort((a, b) => b.winRate - a.winRate)
      .slice(0, 10);

    if (byWinRate.length > 0) {
      console.log('\n\n📊 TOP 10 BY WIN RATE (min 5 positions):');
      console.log('-'.repeat(120));
      printWalletTable(byWinRate);
    }

    // Best by net PnL
    const byPnl = [...wallets]
      .sort((a, b) => b.netPnl - a.netPnl)
      .slice(0, 10);

    if (byPnl.length > 0) {
      console.log('\n\n💰 TOP 10 BY NET P&L:');
      console.log('-'.repeat(120));
      printWalletTable(byPnl);
    }

    return;
  }

  console.log(`\n   Found ${candidates.length} wallets matching criteria:\n`);
  printWalletTable(candidates.slice(0, 30));

  // Detailed view for top 5
  console.log('\n\n📋 DETAILED VIEW — Top 5 Candidates:\n');
  for (const w of candidates.slice(0, 5)) {
    printWalletDetail(w);
  }
}

function printWalletTable(wallets: WalletScore[]): void {
  console.log(
    '#'.padStart(3) + ' | ' +
    'Score'.padStart(5) + ' | ' +
    'Address'.padEnd(14) + ' | ' +
    'Name'.padEnd(20) + ' | ' +
    'Win%'.padStart(5) + ' | ' +
    'W/L'.padStart(7) + ' | ' +
    'Net PnL'.padStart(10) + ' | ' +
    'Invested'.padStart(10) + ' | ' +
    'ROI'.padStart(7) + ' | ' +
    'Avg Win'.padStart(8) + ' | ' +
    'Avg Loss'.padStart(8) + ' | ' +
    'Markets'.padStart(7)
  );
  console.log('-'.repeat(130));

  wallets.forEach((w, i) => {
    console.log(
      String(i + 1).padStart(3) + ' | ' +
      w.score.toFixed(1).padStart(5) + ' | ' +
      (w.address.slice(0, 6) + '...' + w.address.slice(-4)).padEnd(14) + ' | ' +
      (w.name || '-').slice(0, 20).padEnd(20) + ' | ' +
      (w.winRate * 100).toFixed(0).padStart(4) + '% | ' +
      `${w.wins}/${w.losses}`.padStart(7) + ' | ' +
      `$${w.netPnl.toFixed(0)}`.padStart(10) + ' | ' +
      `$${w.totalBought.toFixed(0)}`.padStart(10) + ' | ' +
      `${(w.roi * 100).toFixed(0)}%`.padStart(7) + ' | ' +
      `$${w.avgWin.toFixed(0)}`.padStart(8) + ' | ' +
      `$${w.avgLoss.toFixed(0)}`.padStart(8) + ' | ' +
      String(w.markets).padStart(7)
    );
  });
}

function printWalletDetail(w: WalletScore): void {
  console.log(`  ┌─ ${w.address}`);
  console.log(`  │  Name: ${w.name || 'Anonymous'}  |  Score: ${w.score.toFixed(1)}`);
  console.log(`  │  Win Rate: ${(w.winRate * 100).toFixed(1)}% (${w.wins}W / ${w.losses}L / ${w.totalPositions} total)`);
  console.log(`  │  Net P&L: $${w.netPnl.toFixed(2)}  |  Profit: $${w.totalProfit.toFixed(2)}  |  Loss: $${w.totalLoss.toFixed(2)}`);
  console.log(`  │  Avg Win: $${w.avgWin.toFixed(2)}  |  Avg Loss: $${w.avgLoss.toFixed(2)}  |  Biggest Win: $${w.biggestWin.toFixed(2)}`);
  console.log(`  │  Total Bought: $${w.totalBought.toFixed(2)}  |  Markets: ${w.markets}  |  Active: ${w.activePositions}`);

  if (w.topWins.length > 0) {
    console.log(`  │  Top wins:`);
    for (const tw of w.topWins) {
      console.log(`  │    +$${tw.pnl.toFixed(2)} (${tw.pct > 0 ? '+' : ''}${(tw.pct * 100).toFixed(0)}%) — ${tw.title.slice(0, 60)}`);
    }
  }
  if (w.topLosses.length > 0) {
    console.log(`  │  Top losses:`);
    for (const tl of w.topLosses) {
      console.log(`  │    -$${Math.abs(tl.pnl).toFixed(2)} (${(tl.pct * 100).toFixed(0)}%) — ${tl.title.slice(0, 60)}`);
    }
  }
  console.log(`  └${'─'.repeat(80)}`);
}

function saveResults(wallets: WalletScore[], cfg: DiscoveryConfig): void {
  const dir = join(process.cwd(), 'backtest', 'data');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const path = join(dir, `wallet_discovery_${timestamp}.json`);

  const output = {
    discoveredAt: new Date().toISOString(),
    config: cfg,
    totalAnalyzed: wallets.length,
    matchingCriteria: wallets.filter(w =>
      w.winRate >= cfg.minWinRate &&
      w.netPnl >= cfg.minTotalProfit &&
      w.totalPositions >= cfg.minPositions
    ).length,
    wallets: wallets
      .sort((a, b) => b.score - a.score)
      .map(w => ({
        ...w,
        topWins: w.topWins,
        topLosses: w.topLosses,
      })),
  };

  writeFileSync(path, JSON.stringify(output, null, 2));
  console.log(`\n💾 Results saved: ${path}`);

  // Also save a simple list of top wallet addresses for easy copy-paste into .env
  const topAddresses = wallets
    .filter(w => w.winRate >= 0.70 && w.netPnl > 0 && w.totalPositions >= 5)
    .sort((a, b) => b.score - a.score)
    .slice(0, 20)
    .map(w => w.address);

  if (topAddresses.length > 0) {
    const envLine = `TARGET_WALLETS=${topAddresses.join(',')}`;
    const envPath = join(dir, `top_wallets_${timestamp}.txt`);
    writeFileSync(envPath, envLine + '\n\n# Individual wallets:\n' +
      topAddresses.map((a, i) => `# ${i + 1}. ${a}`).join('\n') + '\n');
    console.log(`📋 Top wallet addresses: ${envPath}`);
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function main(): Promise<void> {
  const cfg = loadConfig();

  console.log('🔍 POLYMARKET WALLET DISCOVERY PIPELINE');
  console.log('='.repeat(65));
  console.log(`   Mode:        ${cfg.smallAccountMode ? 'SMALL ACCOUNT GROWERS' : 'WHALE DISCOVERY'}`);
  console.log(`   Harvest:     ${cfg.maxTradesToHarvest} trades from global feed`);
  console.log(`   Analyze:     up to ${cfg.maxWalletsToAnalyze} wallets`);
  console.log(`   Min win rate: ${(cfg.minWinRate * 100).toFixed(0)}%`);
  console.log(`   Min profit:  $${cfg.minTotalProfit}`);
  console.log(`   Min positions: ${cfg.minPositions}`);
  if (cfg.smallAccountMode) console.log(`   Max volume:  $${cfg.maxVolume} (filter out whales)`);
  console.log(`   API delay:   ${cfg.requestDelayMs}ms`);
  console.log('='.repeat(65));

  // Phase 1: Harvest wallets
  const discovered = await harvestWallets(cfg);

  // Print volume distribution for debugging
  const volumes = [...discovered.values()].map(v => v.totalVolume).sort((a, b) => a - b);
  const p10 = volumes[Math.floor(volumes.length * 0.1)] || 0;
  const p25 = volumes[Math.floor(volumes.length * 0.25)] || 0;
  const p50 = volumes[Math.floor(volumes.length * 0.5)] || 0;
  const p75 = volumes[Math.floor(volumes.length * 0.75)] || 0;
  const p90 = volumes[Math.floor(volumes.length * 0.9)] || 0;
  console.log(`   Volume distribution: p10=$${p10.toFixed(0)} p25=$${p25.toFixed(0)} p50=$${p50.toFixed(0)} p75=$${p75.toFixed(0)} p90=$${p90.toFixed(0)}`);
  const underThreshold = volumes.filter(v => v <= cfg.maxVolume).length;
  console.log(`   Wallets with volume <= $${cfg.maxVolume}: ${underThreshold}/${volumes.length}\n`);

  let sorted: [string, { name: string; tradeCount: number; totalVolume: number; latestTrade: number }][];

  if (cfg.smallAccountMode) {
    // Small account mode: analyze all wallets, sort by trade count (active traders)
    // We filter by actual totalBought (from positions API) after analysis, not harvest volume
    sorted = [...discovered.entries()]
      .filter(([, info]) => info.tradeCount >= 2)
      .sort((a, b) => b[1].tradeCount - a[1].tradeCount) // most active first
      .slice(0, cfg.maxWalletsToAnalyze);

    console.log(`📊 Phase 2: Analyzing ${sorted.length} wallets (will filter by totalBought <= $${cfg.maxVolume} after)...\n`);
  } else {
    // Default: highest volume first (whale mode)
    sorted = [...discovered.entries()]
      .sort((a, b) => b[1].totalVolume - a[1].totalVolume)
      .slice(0, cfg.maxWalletsToAnalyze);

    console.log(`📊 Phase 2: Analyzing top ${sorted.length} wallets by volume...\n`);
  }

  // Phase 2: Analyze each wallet
  const scores: WalletScore[] = [];
  let analyzed = 0;
  let skipped = 0;

  for (const [address, info] of sorted) {
    analyzed++;
    process.stdout.write(`\r   Analyzing ${analyzed}/${sorted.length}... (${scores.length} scored, ${skipped} skipped)`);

    const score = await analyzeWallet(address, info.name, cfg, info.totalVolume);
    if (score) {
      scores.push(score);
    } else {
      skipped++;
    }

    await sleep(cfg.requestDelayMs);
  }

  console.log(`\n   ✅ Analyzed ${analyzed} wallets → ${scores.length} scored\n`);

  // Phase 3: Results
  printResults(scores, cfg);
  saveResults(scores, cfg);

  // Summary
  const matching = scores.filter(w =>
    w.winRate >= cfg.minWinRate &&
    w.netPnl >= cfg.minTotalProfit &&
    w.totalPositions >= cfg.minPositions
  );

  console.log('\n' + '='.repeat(65));
  console.log(`📈 SUMMARY`);
  console.log(`   Trades harvested:    ${cfg.maxTradesToHarvest}`);
  console.log(`   Unique wallets:      ${discovered.size}`);
  console.log(`   Wallets analyzed:    ${analyzed}`);
  console.log(`   Wallets scored:      ${scores.length}`);
  console.log(`   Matching criteria:   ${matching.length}`);
  if (matching.length > 0) {
    console.log(`\n   🎯 Best candidate: ${matching[0].address}`);
    console.log(`      Win rate: ${(matching[0].winRate * 100).toFixed(1)}% | Net PnL: $${matching[0].netPnl.toFixed(2)} | Score: ${matching[0].score.toFixed(1)}`);
  }
  console.log('='.repeat(65));
}

main().catch((err) => {
  console.error('❌ Fatal:', err.message);
  process.exit(1);
});
