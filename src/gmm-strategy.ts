#!/usr/bin/env tsx
/**
 * GMM — Grid Market Making for Polymarket btc-updown-5m markets.
 *
 * STRATEGY:
 *   Place BUY limit orders (GTC) on BOTH YES and NO sides below mid price.
 *   As market oscillates, orders fill → accumulate inventory on both sides.
 *   When paired YES+NO inventory >= threshold → merge on-chain for $1.00.
 *   Profit = $1.00 - combined average cost of paired shares.
 *   Additionally earn Polymarket maker rebates on all filled orders.
 *
 * NON-INTERFERENCE:
 *   GMM only cancels its own orders by specific ID (never cancelAll).
 *   Sniper uses FOK (instant fill-or-reject, never sits on book).
 *   Copy bot orders are separate. Safe to run all simultaneously.
 *
 * Usage:
 *   npm run gmm              # runs indefinitely
 *   npx tsx src/gmm-strategy.ts
 */

import dotenv from 'dotenv';
dotenv.config();

import { AssetType, OrderType, Side } from '@polymarket/clob-client';
import { appendFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { config } from './config.js';
import { TradeExecutor } from './trader.js';
import { MergeExecutor } from './merge-executor.js';
import { BinancePriceFeed } from './binance-feed.js';
import { MarketScanner, type ScannedMarket } from './market-scanner.js';

// ── Configuration ──────────────────────────────────────────────────────────

interface GmmConfig {
  gridLevels: number;
  gridSpacingCents: number;
  sharesPerLevel: number;
  maxBudgetUsdc: number;
  reserveUsdc: number;
  requoteIntervalMs: number;
  scanIntervalMs: number;
  maxInventoryPerSide: number;
  mergeThreshold: number;
  inventorySkewFactor: number;
  unwindBeforeExpirySec: number;
  sessionLossLimitUsdc: number;
  preferUpdown: boolean;
  minTtlMs: number;
  symbol: string;
}

function loadGmmConfig(): GmmConfig {
  const c = config.gmm;
  return {
    gridLevels: c.gridLevels,
    gridSpacingCents: c.gridSpacingCents,
    sharesPerLevel: c.sharesPerLevel,
    maxBudgetUsdc: c.maxBudgetUsdc,
    reserveUsdc: c.reserveUsdc,
    requoteIntervalMs: c.requoteIntervalMs,
    scanIntervalMs: c.scanIntervalMs,
    maxInventoryPerSide: c.maxInventoryPerSide,
    mergeThreshold: c.mergeThreshold,
    inventorySkewFactor: c.inventorySkewFactor,
    unwindBeforeExpirySec: c.unwindBeforeExpirySec,
    sessionLossLimitUsdc: c.sessionLossLimitUsdc,
    preferUpdown: c.preferUpdown,
    minTtlMs: c.minTtlMs,
    symbol: c.symbol,
  };
}

// ── Types ───────────────────────────────────────────────────────────────────

interface GmmInventory {
  yesShares: number;
  noShares: number;
  yesCost: number;
  noCost: number;
  mergedPairs: number;
  mergeProfit: number;
}

interface GmmGridOrder {
  orderId: string;
  tokenId: string;
  side: 'YES' | 'NO';
  price: number;
  shares: number;
  level: number;
  placedAt: number;
}

interface GmmTradeLog {
  timestamp: number;
  action: string;
  conditionId: string;
  question: string;
  side: string;
  price: number;
  shares: number;
  pnl: number;
  balance: number;
  orderId: string;
  reason: string;
}

interface ActiveMarket {
  conditionId: string;
  question: string;
  yesTokenId: string;
  noTokenId: string;
  expiresAt: number;
  negRisk: boolean;
}

// ── GMM Engine ──────────────────────────────────────────────────────────────

class GmmEngine {
  private cfg: GmmConfig;
  private executor: TradeExecutor;
  private mergeExecutor: MergeExecutor;
  private binanceFeed: BinancePriceFeed;
  private scanner: MarketScanner;

  private activeMarket: ActiveMarket | null = null;
  private inventory: GmmInventory = {
    yesShares: 0, noShares: 0,
    yesCost: 0, noCost: 0,
    mergedPairs: 0, mergeProfit: 0,
  };
  private liveOrders = new Map<string, GmmGridOrder>();

  // Balance
  private cachedBalance = 0;
  private balanceCacheTime = 0;
  private readonly BALANCE_CACHE_MS = 5000;

  // Session stats
  private sessionPnL = 0;
  private totalFills = 0;
  private totalMerges = 0;
  private marketsRotated = 0;
  private trades: GmmTradeLog[] = [];

  // Session control
  private sessionHalted = false;
  private haltReason = '';
  private isRequoting = false;
  private startTime = 0;
  private sessionId: string;

  // Timers
  private scanTimer: NodeJS.Timeout | null = null;
  private requoteTimer: NodeJS.Timeout | null = null;
  private dashTimer: NodeJS.Timeout | null = null;

  // Log path
  private logPath: string;
  private budgetCommitted = 0;

  constructor(
    executor: TradeExecutor,
    mergeExecutor: MergeExecutor,
    binanceFeed: BinancePriceFeed,
    scanner: MarketScanner,
    gmmConfig: GmmConfig,
  ) {
    this.cfg = gmmConfig;
    this.executor = executor;
    this.mergeExecutor = mergeExecutor;
    this.binanceFeed = binanceFeed;
    this.scanner = scanner;

    this.sessionId = new Date().toISOString().replace(/[:.]/g, '-');
    const dir = join(process.cwd(), 'backtest', 'data');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.logPath = join(dir, `gmm_trades_${this.sessionId}.jsonl`);
  }

  // ── Main Loop ─────────────────────────────────────────────────────────────

  async run(): Promise<void> {
    const c = this.cfg;
    console.log('\n📊 GMM — Grid Market Making');
    console.log('='.repeat(65));
    console.log(`   Grid levels:     ${c.gridLevels} per side`);
    console.log(`   Grid spacing:    ${c.gridSpacingCents} cents`);
    console.log(`   Shares/level:    ${c.sharesPerLevel}`);
    console.log(`   Max budget:      $${c.maxBudgetUsdc.toFixed(2)}`);
    console.log(`   Reserve:         $${c.reserveUsdc.toFixed(2)}`);
    console.log(`   Merge threshold: ${c.mergeThreshold} shares`);
    console.log(`   Skew factor:     ${c.inventorySkewFactor}`);
    console.log(`   Unwind before:   T-${c.unwindBeforeExpirySec}s`);
    console.log(`   Loss limit:      $${c.sessionLossLimitUsdc.toFixed(2)}`);
    console.log(`   Requote every:   ${(c.requoteIntervalMs / 1000).toFixed(0)}s`);
    console.log('='.repeat(65));

    // 1. Connect Binance
    console.log(`\n🔌 Connecting to Binance (${c.symbol})...`);
    await this.binanceFeed.initialize();
    await this.waitForPrice();
    console.log(`✅ Binance: BTC=$${this.binanceFeed.getPrice().toFixed(2)}`);

    // 2. Check CLOB balance
    console.log('\n💳 Checking Polymarket balance...');
    const balance = await this.fetchBalance();
    console.log(`   CLOB balance: $${balance.toFixed(2)} USDC`);

    const availableBudget = Math.min(balance - c.reserveUsdc, c.maxBudgetUsdc);
    if (availableBudget < c.sharesPerLevel * 0.5) {
      console.log(`\n❌ Insufficient budget. Available: $${availableBudget.toFixed(2)} (need ~$${(c.sharesPerLevel * 0.5).toFixed(2)} minimum)`);
      this.binanceFeed.close();
      return;
    }

    // 3. Initial scan
    console.log('\n🔍 Scanning for markets...');
    await this.selectMarket();

    if (!this.activeMarket) {
      console.log('⚠️  No suitable market found. Will keep scanning...');
    }

    // 4. Go live
    console.log(`\n🚀 GMM ACTIVE — placing grid orders...`);
    console.log(`   Budget: $${availableBudget.toFixed(2)} | Requoting every ${(c.requoteIntervalMs / 1000).toFixed(0)}s\n`);

    this.startTime = Date.now();
    this.scanTimer = setInterval(() => this.scanCycle(), c.scanIntervalMs);
    this.requoteTimer = setInterval(() => this.requoteCycle(), c.requoteIntervalMs);
    this.dashTimer = setInterval(() => this.printDashboard(), 5000);

    // Initial requote
    await this.requoteCycle();

    // Run until halt
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (this.sessionHalted) {
          clearInterval(check);
          resolve();
        }
      }, 1000);
    });

    this.shutdown();
  }

  shutdown(): void {
    console.log('\n\n⏹️  GMM shutting down...');
    if (this.scanTimer) clearInterval(this.scanTimer);
    if (this.requoteTimer) clearInterval(this.requoteTimer);
    if (this.dashTimer) clearInterval(this.dashTimer);

    // Cancel remaining orders
    this.cancelMyOrders().catch(() => {});

    this.binanceFeed.close();
    this.printFinalReport();
    this.saveSessionResults();
  }

  // ── Balance ─────────────────────────────────────────────────────────────

  private async fetchBalance(): Promise<number> {
    const now = Date.now();
    if (now - this.balanceCacheTime < this.BALANCE_CACHE_MS && this.cachedBalance > 0) {
      return this.cachedBalance;
    }

    try {
      const clobClient = this.executor.getClobClient();
      const allowances = await clobClient.getBalanceAllowance({
        asset_type: AssetType.COLLATERAL,
      });
      this.cachedBalance = parseFloat(allowances?.balance || '0') / 1e6;
      this.balanceCacheTime = now;
      return this.cachedBalance;
    } catch (err: any) {
      console.error(`   ⚠️  Balance check failed: ${err.message}`);
      return this.cachedBalance;
    }
  }

  private async waitForPrice(): Promise<void> {
    return new Promise((resolve) => {
      const check = setInterval(() => {
        if (this.binanceFeed.getPrice() > 0) {
          clearInterval(check);
          resolve();
        }
      }, 100);
    });
  }

  // ── Market Selection & Rotation ───────────────────────────────────────

  private async scanCycle(): Promise<void> {
    if (this.sessionHalted) return;

    try {
      // Check if current market is about to expire
      if (this.activeMarket) {
        const ttl = this.activeMarket.expiresAt - Date.now();
        if (ttl < this.cfg.unwindBeforeExpirySec * 1000) {
          console.log(`\n⏰ Market expiring in ${(ttl / 1000).toFixed(0)}s — unwinding...`);
          await this.unwindAndRotate();
          return;
        }
        // Market still active, check TTL is sufficient
        if (ttl > this.cfg.minTtlMs) return;
      }

      // Need a new market
      await this.selectMarket();
    } catch (err: any) {
      console.error(`   ⚠️  Scan error: ${err.message}`);
    }
  }

  private async selectMarket(): Promise<void> {
    const markets = await this.scanner.scan(true);
    const candidates = markets
      .filter(m => m.marketType === 'updown')
      .filter(m => (m.expiresAt - Date.now()) > this.cfg.minTtlMs)
      .sort((a, b) => b.expiresAt - a.expiresAt); // longest TTL first

    if (candidates.length === 0) {
      if (!this.activeMarket) {
        console.log('   No markets with sufficient TTL found.');
      }
      return;
    }

    const pick = candidates[0]!;
    const ttl = ((pick.expiresAt - Date.now()) / 1000).toFixed(0);

    // Don't switch if same market
    if (this.activeMarket?.conditionId === pick.conditionId) return;

    // If switching from another market, unwind first
    if (this.activeMarket) {
      await this.unwindAndRotate();
    }

    this.activeMarket = {
      conditionId: pick.conditionId,
      question: pick.question,
      yesTokenId: pick.yesTokenId,
      noTokenId: pick.noTokenId,
      expiresAt: pick.expiresAt,
      negRisk: pick.negRisk,
    };

    this.marketsRotated++;
    console.log(`\n📡 ACTIVE MARKET: "${pick.question.slice(0, 60)}"`);
    console.log(`   TTL=${ttl}s | conditionId=${pick.conditionId.slice(0, 14)}...`);
  }

  private async unwindAndRotate(): Promise<void> {
    // 1. Cancel all grid orders
    await this.cancelMyOrders();

    // 2. Try to merge what we can
    await this.tryMerge();

    // 3. Log unhedged exposure
    const unhedgedYes = this.inventory.yesShares;
    const unhedgedNo = this.inventory.noShares;
    if (unhedgedYes > 0 || unhedgedNo > 0) {
      console.log(`   📦 Unhedged inventory: YES=${unhedgedYes.toFixed(2)} NO=${unhedgedNo.toFixed(2)}`);
      console.log(`   These ride to resolution (win=$1/share, lose=$0).`);
    }

    // 4. Reset for next market
    this.resetInventory();
    this.activeMarket = null;
  }

  private resetInventory(): void {
    // Keep session-level stats but reset per-market inventory
    this.inventory.yesShares = 0;
    this.inventory.noShares = 0;
    this.inventory.yesCost = 0;
    this.inventory.noCost = 0;
    this.budgetCommitted = 0;
  }

  // ── Requote Cycle (core loop) ─────────────────────────────────────────

  private async requoteCycle(): Promise<void> {
    if (this.sessionHalted || this.isRequoting || !this.activeMarket) return;
    this.isRequoting = true;

    try {
      const market = this.activeMarket;
      const ttl = market.expiresAt - Date.now();

      // 1. Near expiry? Unwind.
      if (ttl < this.cfg.unwindBeforeExpirySec * 1000) {
        await this.unwindAndRotate();
        this.isRequoting = false;
        return;
      }

      // 2. Detect fills
      await this.detectFills();

      // 3. Try merge
      await this.tryMerge();

      // 4. Check loss limit
      if (this.checkLossLimit()) {
        this.isRequoting = false;
        return;
      }

      // 5. Fetch orderbooks
      const clobClient = this.executor.getClobClient();
      const [yesBook, noBook] = await Promise.all([
        clobClient.getOrderBook(market.yesTokenId).catch(() => null),
        clobClient.getOrderBook(market.noTokenId).catch(() => null),
      ]);

      if (!yesBook || !noBook) {
        this.isRequoting = false;
        return;
      }

      // 6. Compute grid
      const yesMid = this.computeMid(yesBook);
      const noMid = this.computeMid(noBook);

      if (yesMid <= 0 || noMid <= 0) {
        this.isRequoting = false;
        return;
      }

      const newGrid = this.computeGrid(yesMid, noMid);

      // 7. Cancel stale orders (those not matching new grid)
      await this.cancelStaleOrders(newGrid);

      // 8. Place missing grid orders
      await this.placeGridOrders(newGrid, market);

    } catch (err: any) {
      console.error(`   ⚠️  Requote error: ${err.message}`);
    }

    this.isRequoting = false;
  }

  // ── Orderbook Helpers ─────────────────────────────────────────────────

  private computeMid(orderbook: any): number {
    const bestBid = parseFloat(orderbook.bids?.[0]?.price || '0');
    const bestAsk = parseFloat(orderbook.asks?.[0]?.price || '0');

    if (bestBid > 0 && bestAsk > 0) {
      return (bestBid + bestAsk) / 2;
    }
    if (bestAsk > 0) return bestAsk - 0.01;
    if (bestBid > 0) return bestBid + 0.01;
    return 0;
  }

  // ── Grid Math ─────────────────────────────────────────────────────────

  private computeGrid(yesMid: number, noMid: number): Array<{
    side: 'YES' | 'NO';
    price: number;
    shares: number;
    level: number;
  }> {
    const c = this.cfg;
    const spacing = c.gridSpacingCents / 100;
    const imbalance = this.inventory.yesShares - this.inventory.noShares;
    const skewCents = imbalance * c.inventorySkewFactor * 0.01;

    const grid: Array<{ side: 'YES' | 'NO'; price: number; shares: number; level: number }> = [];

    // Check budget
    const balance = this.cachedBalance;
    const availableBudget = Math.min(balance - c.reserveUsdc, c.maxBudgetUsdc) - this.budgetCommitted;

    for (let level = 0; level < c.gridLevels; level++) {
      // YES BUY: below mid, less aggressive when long YES
      const yesRaw = yesMid - spacing * (level + 1) - skewCents;
      const yesPrice = this.roundToTick(Math.max(0.01, Math.min(0.99, yesRaw)));

      // NO BUY: below mid, more aggressive when long YES (to rebalance)
      const noRaw = noMid - spacing * (level + 1) + skewCents;
      const noPrice = this.roundToTick(Math.max(0.01, Math.min(0.99, noRaw)));

      const yesCost = yesPrice * c.sharesPerLevel;
      const noCost = noPrice * c.sharesPerLevel;

      // Skip if inventory cap reached
      if (this.inventory.yesShares >= c.maxInventoryPerSide) {
        // Skip YES orders
      } else if (yesCost <= availableBudget) {
        grid.push({ side: 'YES', price: yesPrice, shares: c.sharesPerLevel, level });
      }

      if (this.inventory.noShares >= c.maxInventoryPerSide) {
        // Skip NO orders
      } else if (noCost <= availableBudget) {
        grid.push({ side: 'NO', price: noPrice, shares: c.sharesPerLevel, level });
      }
    }

    return grid;
  }

  private roundToTick(price: number): number {
    // Polymarket uses 0.01 tick for most markets, 0.001 for some
    return Math.round(price * 100) / 100;
  }

  // ── Fill Detection ────────────────────────────────────────────────────

  private async detectFills(): Promise<void> {
    if (this.liveOrders.size === 0 || !this.activeMarket) return;

    try {
      const clobClient = this.executor.getClobClient();
      const market = this.activeMarket;

      // Fetch open orders for both tokens
      const [yesOrders, noOrders] = await Promise.all([
        clobClient.getOpenOrders({ asset_id: market.yesTokenId }).catch(() => [] as any[]),
        clobClient.getOpenOrders({ asset_id: market.noTokenId }).catch(() => [] as any[]),
      ]);

      const allOpen = [...(yesOrders || []), ...(noOrders || [])];
      const openIds = new Set(allOpen.map((o: any) => o.id));

      // Check each tracked order
      for (const [orderId, order] of this.liveOrders) {
        if (!openIds.has(orderId)) {
          // Order no longer open — it was filled (or cancelled by us, but we remove those immediately)
          console.log(`   ✅ FILL: ${order.side} ${order.shares} shares @$${order.price.toFixed(3)} (level ${order.level})`);

          if (order.side === 'YES') {
            this.inventory.yesShares += order.shares;
            this.inventory.yesCost += order.price * order.shares;
          } else {
            this.inventory.noShares += order.shares;
            this.inventory.noCost += order.price * order.shares;
          }

          this.budgetCommitted -= order.price * order.shares;
          this.totalFills++;
          this.liveOrders.delete(orderId);

          // Log fill
          this.logTrade({
            timestamp: Date.now(),
            action: `FILL_${order.side}`,
            conditionId: this.activeMarket!.conditionId,
            question: this.activeMarket!.question,
            side: order.side,
            price: order.price,
            shares: order.shares,
            pnl: 0,
            balance: this.cachedBalance,
            orderId,
            reason: `Grid fill level=${order.level}`,
          });
        }
      }
    } catch (err: any) {
      console.error(`   ⚠️  Fill detection error: ${err.message}`);
    }
  }

  // ── Merge ─────────────────────────────────────────────────────────────

  private async tryMerge(): Promise<void> {
    if (!this.activeMarket) return;

    const pairable = Math.min(this.inventory.yesShares, this.inventory.noShares);
    if (pairable < this.cfg.mergeThreshold) return;

    // Check profitability
    const yesAvg = this.inventory.yesCost / this.inventory.yesShares;
    const noAvg = this.inventory.noCost / this.inventory.noShares;
    const combinedAvgCost = yesAvg + noAvg;

    if (combinedAvgCost >= 1.0) {
      console.log(`   ⚠️  Merge not profitable: combined avg cost $${combinedAvgCost.toFixed(4)} >= $1.00`);
      return;
    }

    const mergeAmount = Math.floor(pairable);
    const profitPerPair = 1.0 - combinedAvgCost;
    const totalProfit = profitPerPair * mergeAmount;

    console.log(`\n🔄 MERGE: ${mergeAmount} pairs | cost=$${combinedAvgCost.toFixed(4)} | profit=$${totalProfit.toFixed(4)}`);

    try {
      const result = await this.mergeExecutor.merge({
        conditionId: this.activeMarket.conditionId,
        amount: mergeAmount,
        negRisk: this.activeMarket.negRisk,
      });

      // Update inventory
      const yesMergedCost = yesAvg * mergeAmount;
      const noMergedCost = noAvg * mergeAmount;

      this.inventory.yesShares -= mergeAmount;
      this.inventory.noShares -= mergeAmount;
      this.inventory.yesCost -= yesMergedCost;
      this.inventory.noCost -= noMergedCost;
      this.inventory.mergedPairs += mergeAmount;
      this.inventory.mergeProfit += totalProfit;

      this.sessionPnL += totalProfit;
      this.totalMerges++;

      console.log(`   ✅ Merged! Profit: $${totalProfit.toFixed(4)} | Tx: ${result.txHash.slice(0, 14)}...`);

      this.logTrade({
        timestamp: Date.now(),
        action: 'MERGE',
        conditionId: this.activeMarket.conditionId,
        question: this.activeMarket.question,
        side: 'BOTH',
        price: combinedAvgCost,
        shares: mergeAmount,
        pnl: totalProfit,
        balance: this.cachedBalance,
        orderId: result.txHash,
        reason: `Merged ${mergeAmount} pairs @ combined $${combinedAvgCost.toFixed(4)}`,
      });
    } catch (err: any) {
      console.error(`   ❌ Merge failed: ${err.message}`);
    }
  }

  // ── Order Management ──────────────────────────────────────────────────

  private async cancelStaleOrders(
    newGrid: Array<{ side: 'YES' | 'NO'; price: number; shares: number; level: number }>
  ): Promise<void> {
    if (this.liveOrders.size === 0) return;

    // Build set of desired grid positions
    const desired = new Set(newGrid.map(g => `${g.side}_${g.price.toFixed(2)}_${g.level}`));

    const staleIds: string[] = [];
    for (const [orderId, order] of this.liveOrders) {
      const key = `${order.side}_${order.price.toFixed(2)}_${order.level}`;
      if (!desired.has(key)) {
        staleIds.push(orderId);
      }
    }

    if (staleIds.length === 0) return;

    try {
      const clobClient = this.executor.getClobClient();
      await clobClient.cancelOrders(staleIds);

      for (const id of staleIds) {
        const order = this.liveOrders.get(id);
        if (order) {
          this.budgetCommitted -= order.price * order.shares;
        }
        this.liveOrders.delete(id);
      }

      console.log(`   🗑️  Cancelled ${staleIds.length} stale order(s)`);
    } catch (err: any) {
      console.error(`   ⚠️  Cancel error: ${err.message}`);
    }
  }

  private async cancelMyOrders(): Promise<void> {
    if (this.liveOrders.size === 0) return;

    const ids = [...this.liveOrders.keys()];
    try {
      const clobClient = this.executor.getClobClient();
      await clobClient.cancelOrders(ids);
      this.liveOrders.clear();
      this.budgetCommitted = 0;
      console.log(`   🗑️  Cancelled all ${ids.length} GMM order(s)`);
    } catch (err: any) {
      console.error(`   ⚠️  Cancel all error: ${err.message}`);
      // Clear anyway — they may have been cancelled already
      this.liveOrders.clear();
      this.budgetCommitted = 0;
    }
  }

  private async placeGridOrders(
    grid: Array<{ side: 'YES' | 'NO'; price: number; shares: number; level: number }>,
    market: ActiveMarket,
  ): Promise<void> {
    // Skip orders that already exist at same price+side+level
    const existingKeys = new Set<string>();
    for (const [, order] of this.liveOrders) {
      existingKeys.add(`${order.side}_${order.price.toFixed(2)}_${order.level}`);
    }

    const toPlace = grid.filter(g => {
      const key = `${g.side}_${g.price.toFixed(2)}_${g.level}`;
      return !existingKeys.has(key);
    });

    if (toPlace.length === 0) return;

    const clobClient = this.executor.getClobClient();

    for (const g of toPlace) {
      const tokenId = g.side === 'YES' ? market.yesTokenId : market.noTokenId;

      try {
        const orderOpts = await this.executor.getOrderOptions(tokenId);

        const response = await clobClient.createAndPostOrder(
          {
            tokenID: tokenId,
            price: g.price,
            size: g.shares,
            side: Side.BUY,
            feeRateBps: 0,
          },
          orderOpts,
          OrderType.GTC,
        );

        if (response.success && response.orderID) {
          this.liveOrders.set(response.orderID, {
            orderId: response.orderID,
            tokenId,
            side: g.side,
            price: g.price,
            shares: g.shares,
            level: g.level,
            placedAt: Date.now(),
          });
          this.budgetCommitted += g.price * g.shares;

          console.log(`   📝 ${g.side} BUY ${g.shares} @$${g.price.toFixed(3)} (L${g.level}) → ${response.orderID.slice(0, 10)}...`);
        } else {
          const err = response.errorMsg || response.error || 'unknown';
          console.log(`   ❌ ${g.side} L${g.level} failed: ${err}`);
        }
      } catch (err: any) {
        console.log(`   ❌ ${g.side} L${g.level} error: ${err.message}`);
      }
    }
  }

  // ── Risk ──────────────────────────────────────────────────────────────

  private checkLossLimit(): boolean {
    if (this.sessionPnL < -this.cfg.sessionLossLimitUsdc) {
      this.sessionHalted = true;
      this.haltReason = `Session loss limit: $${this.sessionPnL.toFixed(2)} (limit -$${this.cfg.sessionLossLimitUsdc.toFixed(2)})`;
      console.log(`\n🛑 ${this.haltReason}`);
      return true;
    }
    return false;
  }

  // ── Logging ───────────────────────────────────────────────────────────

  private logTrade(log: GmmTradeLog): void {
    this.trades.push(log);
    try {
      appendFileSync(this.logPath, JSON.stringify(log) + '\n');
    } catch {}
  }

  private printDashboard(): void {
    if (this.sessionHalted) return;

    const elapsed = ((Date.now() - this.startTime) / 60000).toFixed(1);
    const inv = this.inventory;
    const market = this.activeMarket;
    const ttl = market ? ((market.expiresAt - Date.now()) / 1000).toFixed(0) : '-';
    const btc = this.binanceFeed.getPrice();

    const yesAvg = inv.yesShares > 0 ? (inv.yesCost / inv.yesShares).toFixed(3) : '-';
    const noAvg = inv.noShares > 0 ? (inv.noCost / inv.noShares).toFixed(3) : '-';

    process.stdout.write(
      `\r  📊 GMM ${elapsed}m | BTC=$${btc.toFixed(0)} | ` +
      `YES=${inv.yesShares.toFixed(1)}@$${yesAvg} NO=${inv.noShares.toFixed(1)}@$${noAvg} | ` +
      `Fills=${this.totalFills} Merges=${this.totalMerges} PnL=$${this.sessionPnL.toFixed(4)} | ` +
      `Orders=${this.liveOrders.size} TTL=${ttl}s` +
      '   '
    );
  }

  private printFinalReport(): void {
    const elapsed = ((Date.now() - this.startTime) / 60000).toFixed(1);

    console.log('\n\n' + '='.repeat(65));
    console.log('📊 GMM SESSION REPORT');
    console.log('='.repeat(65));
    console.log(`   Duration:           ${elapsed} minutes`);
    console.log(`   Markets rotated:    ${this.marketsRotated}`);
    console.log(`   Total fills:        ${this.totalFills}`);
    console.log(`   Total merges:       ${this.totalMerges}`);
    console.log(`   Merged pairs:       ${this.inventory.mergedPairs}`);
    console.log(`   Merge profit:       $${this.inventory.mergeProfit.toFixed(4)}`);
    console.log(`   Session P&L:        $${this.sessionPnL.toFixed(4)}`);
    console.log(`   Remaining YES:      ${this.inventory.yesShares.toFixed(2)}`);
    console.log(`   Remaining NO:       ${this.inventory.noShares.toFixed(2)}`);
    if (this.sessionHalted) {
      console.log(`   ⛔ Halted:          ${this.haltReason}`);
    }
    console.log('='.repeat(65));
  }

  private saveSessionResults(): void {
    const dir = join(process.cwd(), 'backtest', 'data');
    const path = join(dir, `gmm_session_${this.sessionId}.json`);

    const results = {
      strategy: 'GMM',
      config: this.cfg,
      wallet: {
        initialBalance: this.cachedBalance,
        sessionPnL: this.sessionPnL,
      },
      results: {
        marketsRotated: this.marketsRotated,
        totalFills: this.totalFills,
        totalMerges: this.totalMerges,
        mergedPairs: this.inventory.mergedPairs,
        mergeProfit: this.inventory.mergeProfit,
        sessionPnL: this.sessionPnL,
        remainingYes: this.inventory.yesShares,
        remainingNo: this.inventory.noShares,
        sessionHalted: this.sessionHalted,
        haltReason: this.haltReason,
      },
      trades: this.trades,
    };

    writeFileSync(path, JSON.stringify(results, null, 2));
    console.log(`\n💾 Session saved: ${path}`);
  }
}

// ── Bootstrap ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const gmmConfig = loadGmmConfig();

  const executor = new TradeExecutor(config);
  await executor.initialize();

  const mergeExecutor = new MergeExecutor({
    privateKey: config.privateKey,
    rpcUrl: config.rpcUrl,
    contracts: {
      ctf: config.contracts.ctf,
      usdc: config.contracts.usdc,
      negRiskAdapter: config.contracts.negRiskAdapter,
    },
  });

  const binanceFeed = new BinancePriceFeed({
    symbol: gmmConfig.symbol,
    apiKey: config.volatility.binanceApiKey,
  });

  const scanner = new MarketScanner(executor.getClobClient(), {
    cacheTtlMs: gmmConfig.scanIntervalMs,
  });

  const engine = new GmmEngine(executor, mergeExecutor, binanceFeed, scanner, gmmConfig);

  let shutdownRequested = false;
  process.on('SIGINT', () => {
    if (shutdownRequested) {
      console.log('\nForce exit.');
      process.exit(1);
    }
    shutdownRequested = true;
    engine.shutdown();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    engine.shutdown();
    process.exit(0);
  });

  await engine.run();
}

main().catch((err) => {
  console.error('❌ GMM fatal error:', err);
  process.exit(1);
});
