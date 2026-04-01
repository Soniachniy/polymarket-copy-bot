#!/usr/bin/env tsx
/**
 * GMM PAPER TRADER — Grid Market Making simulation for btc-updown-5m markets.
 *
 * Simulates grid market making using REAL orderbook data from the CLOB,
 * but does NOT place actual orders. Instead, it checks if the market's
 * best ask price <= our limit buy price to simulate fills.
 *
 * This is more realistic than using Gamma outcomePrices (which lag),
 * but still optimistic — real fills depend on queue position, not just price.
 *
 * Usage:
 *   npm run gmm:paper           # runs for 60 minutes
 *   npm run gmm:paper -- 120    # runs for 2 hours
 */

import dotenv from 'dotenv';
dotenv.config();

import { ClobClient } from '@polymarket/clob-client';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { BinancePriceFeed } from '../binance-feed.js';
import { MarketScanner, type ScannedMarket } from '../market-scanner.js';
import { config } from '../config.js';

// ── Configuration ──────────────────────────────────────────────────────────

interface GmmPaperConfig {
  startingBalance: number;
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
  minTtlMs: number;
  durationMs: number;
  symbol: string;
}

function loadConfig(): GmmPaperConfig {
  const c = config.gmm;
  const durationMin = parseFloat(process.argv[2] || '60');
  return {
    startingBalance: parseFloat(process.env.GMM_STARTING_BALANCE || '5'),
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
    // Paper uses shorter minTTL to catch markets closer to expiry where spreads tighten
    minTtlMs: parseInt(process.env.GMM_PAPER_MIN_TTL_MS || '45000'),
    durationMs: durationMin * 60_000,
    symbol: c.symbol,
  };
}

// ── Types ───────────────────────────────────────────────────────────────────

interface PaperInventory {
  yesShares: number;
  noShares: number;
  yesCost: number;
  noCost: number;
  mergedPairs: number;
  mergeProfit: number;
}

interface PaperGridOrder {
  id: string;
  tokenId: string;
  side: 'YES' | 'NO';
  price: number;
  shares: number;
  level: number;
  placedAt: number;
}

interface ActiveMarket {
  conditionId: string;
  question: string;
  yesTokenId: string;
  noTokenId: string;
  expiresAt: number;
  negRisk: boolean;
}

interface TradeLog {
  timestamp: number;
  action: string;
  conditionId: string;
  question: string;
  side: string;
  price: number;
  shares: number;
  pnl: number;
  balance: number;
  reason: string;
}

// ── Paper GMM Engine ────────────────────────────────────────────────────────

class GmmPaperEngine {
  private cfg: GmmPaperConfig;
  private binanceFeed: BinancePriceFeed;
  private scanner: MarketScanner;
  private clobClient: ClobClient;

  private activeMarket: ActiveMarket | null = null;
  private inventory: PaperInventory = {
    yesShares: 0, noShares: 0,
    yesCost: 0, noCost: 0,
    mergedPairs: 0, mergeProfit: 0,
  };
  private virtualOrders = new Map<string, PaperGridOrder>();
  private nextOrderId = 1;

  // Orderbook cache for grid computation
  private lastYesBestBid = 0;
  private lastYesBestAsk = 0;
  private lastNoBestBid = 0;
  private lastNoBestAsk = 0;

  // Wallet
  private balance: number;
  private budgetCommitted = 0;

  // Session stats
  private sessionPnL = 0;
  private totalFills = 0;
  private totalMerges = 0;
  private marketsRotated = 0;
  private trades: TradeLog[] = [];
  private peakBalance: number;
  private maxDrawdown = 0;

  // Session control
  private sessionHalted = false;
  private haltReason = '';
  private isRequoting = false;
  private startTime = 0;

  // Timers
  private scanTimer: NodeJS.Timeout | null = null;
  private requoteTimer: NodeJS.Timeout | null = null;
  private dashTimer: NodeJS.Timeout | null = null;

  constructor(cfg: GmmPaperConfig) {
    this.cfg = cfg;
    this.balance = cfg.startingBalance;
    this.peakBalance = cfg.startingBalance;
    this.binanceFeed = new BinancePriceFeed({ symbol: cfg.symbol });
    this.clobClient = new ClobClient('https://clob.polymarket.com', 137);
    this.scanner = new MarketScanner(this.clobClient, { cacheTtlMs: cfg.scanIntervalMs });
  }

  // ── Main Loop ─────────────────────────────────────────────────────────────

  async run(): Promise<void> {
    const c = this.cfg;
    console.log('\n📊 GMM PAPER TRADER — Grid Market Making Simulation');
    console.log('='.repeat(65));
    console.log(`   Balance:         $${c.startingBalance.toFixed(2)} (simulated)`);
    console.log(`   Duration:        ${(c.durationMs / 60_000).toFixed(0)} minutes`);
    console.log(`   Grid levels:     ${c.gridLevels} per side`);
    console.log(`   Grid spacing:    ${c.gridSpacingCents} cents`);
    console.log(`   Shares/level:    ${c.sharesPerLevel}`);
    console.log(`   Max budget:      $${c.maxBudgetUsdc.toFixed(2)}`);
    console.log(`   Merge threshold: ${c.mergeThreshold} shares`);
    console.log(`   Skew factor:     ${c.inventorySkewFactor}`);
    console.log(`   Unwind before:   T-${c.unwindBeforeExpirySec}s`);
    console.log(`   Requote every:   ${(c.requoteIntervalMs / 1000).toFixed(0)}s`);
    console.log('='.repeat(65));

    // 1. Connect Binance
    console.log(`\n🔌 Connecting to Binance (${c.symbol})...`);
    await this.binanceFeed.initialize();
    await this.waitForPrice();
    console.log(`✅ Binance: BTC=$${this.binanceFeed.getPrice().toFixed(2)}`);

    // 2. Initial scan
    console.log('\n🔍 Scanning for markets...');
    await this.selectMarket();

    if (!this.activeMarket) {
      console.log('⚠️  No suitable market found. Will keep scanning...');
    }

    // 3. Go
    console.log(`\n🚀 GMM PAPER ACTIVE — simulating grid orders...\n`);

    this.startTime = Date.now();
    this.scanTimer = setInterval(() => this.scanCycle(), c.scanIntervalMs);
    this.requoteTimer = setInterval(() => this.requoteCycle(), c.requoteIntervalMs);
    this.dashTimer = setInterval(() => this.printDashboard(), 5000);

    // Initial requote
    await this.requoteCycle();

    // Wait for duration or halt
    await new Promise<void>((resolve) => {
      const end = setTimeout(() => resolve(), c.durationMs);
      const check = setInterval(() => {
        if (this.sessionHalted) {
          clearTimeout(end);
          clearInterval(check);
          resolve();
        }
      }, 1000);
      setTimeout(() => clearInterval(check), c.durationMs + 1000);
    });

    this.stop();
    this.resolveUnhedged();
    this.printFinalReport();
    this.saveResults();
  }

  shutdown(): void {
    console.log('\n\n⚠️  Interrupted — saving session...');
    this.stop();
    this.resolveUnhedged();
    this.printFinalReport();
    this.saveResults();
  }

  private stop(): void {
    if (this.scanTimer) clearInterval(this.scanTimer);
    if (this.requoteTimer) clearInterval(this.requoteTimer);
    if (this.dashTimer) clearInterval(this.dashTimer);
    this.binanceFeed.close();
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
      if (this.activeMarket) {
        const ttl = this.activeMarket.expiresAt - Date.now();
        if (ttl < this.cfg.unwindBeforeExpirySec * 1000) {
          console.log(`\n⏰ Market expiring in ${(ttl / 1000).toFixed(0)}s — unwinding...`);
          await this.unwindAndRotate();
          return;
        }
        if (ttl > this.cfg.minTtlMs) return;
      }

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
      .sort((a, b) => a.expiresAt - b.expiresAt); // shortest TTL first — closer to expiry = tighter spreads

    if (candidates.length === 0) {
      if (!this.activeMarket) {
        console.log('   No markets with sufficient TTL found.');
      }
      return;
    }

    const pick = candidates[0]!;
    const ttl = ((pick.expiresAt - Date.now()) / 1000).toFixed(0);

    if (this.activeMarket?.conditionId === pick.conditionId) return;

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
    console.log(`   TTL=${ttl}s | Up=$${pick.yesBestAsk.toFixed(3)} Down=$${pick.noBestAsk.toFixed(3)}`);
  }

  private async unwindAndRotate(): Promise<void> {
    // Cancel all virtual orders — return committed budget
    this.virtualOrders.clear();
    this.balance += this.budgetCommitted;
    this.budgetCommitted = 0;

    // Merge what we can
    this.tryMerge();

    // Log unhedged
    if (this.inventory.yesShares > 0 || this.inventory.noShares > 0) {
      console.log(`   📦 Unhedged: YES=${this.inventory.yesShares.toFixed(2)} NO=${this.inventory.noShares.toFixed(2)} (ride to resolution)`);
    }

    this.resetInventory();
    this.activeMarket = null;
  }

  private resetInventory(): void {
    this.inventory.yesShares = 0;
    this.inventory.noShares = 0;
    this.inventory.yesCost = 0;
    this.inventory.noCost = 0;
    this.budgetCommitted = 0;
  }

  // ── Requote Cycle ─────────────────────────────────────────────────────

  private async requoteCycle(): Promise<void> {
    if (this.sessionHalted || this.isRequoting || !this.activeMarket) return;
    this.isRequoting = true;

    try {
      const market = this.activeMarket;
      const ttl = market.expiresAt - Date.now();

      // Near expiry? Unwind.
      if (ttl < this.cfg.unwindBeforeExpirySec * 1000) {
        await this.unwindAndRotate();
        this.isRequoting = false;
        return;
      }

      // Fetch real orderbooks
      const [yesBook, noBook] = await Promise.all([
        this.clobClient.getOrderBook(market.yesTokenId).catch(() => null),
        this.clobClient.getOrderBook(market.noTokenId).catch(() => null),
      ]);

      if (!yesBook || !noBook) {
        this.isRequoting = false;
        return;
      }

      // Simulate fill detection: check if market ask <= our buy price
      this.detectSimulatedFills(yesBook, noBook);

      // Try merge
      this.tryMerge();

      // Check loss limit
      if (this.checkLossLimit()) {
        this.isRequoting = false;
        return;
      }

      // Cache orderbook state for grid computation
      const yesBestBid = this.lastYesBestBid = parseFloat(yesBook.bids?.[0]?.price || '0');
      const yesBestAsk = this.lastYesBestAsk = parseFloat(yesBook.asks?.[0]?.price || '0');
      const noBestBid = this.lastNoBestBid = parseFloat(noBook.bids?.[0]?.price || '0');
      const noBestAsk = this.lastNoBestAsk = parseFloat(noBook.asks?.[0]?.price || '0');

      const yesMid = this.computeMid(yesBook);
      const noMid = this.computeMid(noBook);

      if (yesMid <= 0 || noMid <= 0) {
        this.isRequoting = false;
        return;
      }

      // Always log orderbook state for analysis
      const ttlSec = (ttl / 1000).toFixed(0);
      const yesSpread = yesBestAsk > 0 && yesBestBid > 0 ? (yesBestAsk - yesBestBid).toFixed(3) : 'N/A';
      const noSpread = noBestAsk > 0 && noBestBid > 0 ? (noBestAsk - noBestBid).toFixed(3) : 'N/A';

      // Log full depth (top 3 levels) for analysis
      const yesAsks = (yesBook.asks || []).slice(0, 3).map((a: any) => `$${a.price}×${parseFloat(a.size).toFixed(0)}`).join(', ');
      const noAsks = (noBook.asks || []).slice(0, 3).map((a: any) => `$${a.price}×${parseFloat(a.size).toFixed(0)}`).join(', ');
      const yesBids = (yesBook.bids || []).slice(0, 3).map((b: any) => `$${b.price}×${parseFloat(b.size).toFixed(0)}`).join(', ');
      const noBids = (noBook.bids || []).slice(0, 3).map((b: any) => `$${b.price}×${parseFloat(b.size).toFixed(0)}`).join(', ');

      console.log(`\n   📖 TTL=${ttlSec}s | YES: asks=[${yesAsks}] bids=[${yesBids}] spread=${yesSpread}`);
      console.log(`   📖         | NO:  asks=[${noAsks}] bids=[${noBids}] spread=${noSpread}`);

      const newGrid = this.computeGrid(yesMid, noMid);

      // Replace virtual orders
      this.replaceVirtualOrders(newGrid);

    } catch (err: any) {
      console.error(`   ⚠️  Requote error: ${err.message}`);
    }

    this.isRequoting = false;
  }

  // ── Orderbook Helpers ─────────────────────────────────────────────────

  private computeMid(orderbook: any): number {
    const bestBid = parseFloat(orderbook.bids?.[0]?.price || '0');
    const bestAsk = parseFloat(orderbook.asks?.[0]?.price || '0');

    if (bestBid > 0 && bestAsk > 0) return (bestBid + bestAsk) / 2;
    if (bestAsk > 0) return bestAsk - 0.01;
    if (bestBid > 0) return bestBid + 0.01;
    return 0;
  }

  // ── Grid Math ─────────────────────────────────────────────────────────

  /**
   * Compute grid levels. Strategy:
   *   - If spread is tight (ask - bid < 0.10), use mid-based grid (traditional MM).
   *   - If spread is wide (typical for 5-min updown), place below best ask.
   *     This way we act as the bid side in a wide market — fills happen when
   *     someone market-sells into our bid, or when the ask drops to our level
   *     as direction becomes clearer near expiry.
   */
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

    const availableBudget = Math.min(this.balance - c.reserveUsdc, c.maxBudgetUsdc) - this.budgetCommitted;

    // Use best ask as anchor when spread is wide
    const yesAnchor = this.lastYesBestAsk > 0 && (this.lastYesBestAsk - this.lastYesBestBid) > 0.10
      ? this.lastYesBestAsk  // wide spread: anchor to ask
      : yesMid;              // tight spread: use mid
    const noAnchor = this.lastNoBestAsk > 0 && (this.lastNoBestAsk - this.lastNoBestBid) > 0.10
      ? this.lastNoBestAsk
      : noMid;

    for (let level = 0; level < c.gridLevels; level++) {
      // Place just below the anchor (ask or mid)
      const yesRaw = yesAnchor - spacing * (level + 1) - skewCents;
      const yesPrice = this.roundToTick(Math.max(0.01, Math.min(0.99, yesRaw)));

      const noRaw = noAnchor - spacing * (level + 1) + skewCents;
      const noPrice = this.roundToTick(Math.max(0.01, Math.min(0.99, noRaw)));

      // Skip if price is too high (> 0.92) — not worth the risk
      const maxGridPrice = 0.92;

      if (this.inventory.yesShares < c.maxInventoryPerSide && yesPrice <= maxGridPrice && yesPrice * c.sharesPerLevel <= availableBudget) {
        grid.push({ side: 'YES', price: yesPrice, shares: c.sharesPerLevel, level });
      }

      if (this.inventory.noShares < c.maxInventoryPerSide && noPrice <= maxGridPrice && noPrice * c.sharesPerLevel <= availableBudget) {
        grid.push({ side: 'NO', price: noPrice, shares: c.sharesPerLevel, level });
      }
    }

    return grid;
  }

  private roundToTick(price: number): number {
    return Math.round(price * 100) / 100;
  }

  // ── Simulated Fill Detection ──────────────────────────────────────────

  private detectSimulatedFills(yesBook: any, noBook: any): void {
    if (this.virtualOrders.size === 0) return;

    // Best ask = cheapest someone will sell to us
    // Our BUY at price P fills if market best ask <= P
    const yesBestAsk = parseFloat(yesBook.asks?.[0]?.price || '999');
    const noBestAsk = parseFloat(noBook.asks?.[0]?.price || '999');

    // Also check depth — can the market absorb our order?
    const yesAskDepth = parseFloat(yesBook.asks?.[0]?.size || '0');
    const noAskDepth = parseFloat(noBook.asks?.[0]?.size || '0');

    for (const [id, order] of this.virtualOrders) {
      let filled = false;

      if (order.side === 'YES' && yesBestAsk <= order.price && yesAskDepth >= order.shares) {
        filled = true;
      } else if (order.side === 'NO' && noBestAsk <= order.price && noAskDepth >= order.shares) {
        filled = true;
      }

      if (filled) {
        console.log(`   ✅ FILL: ${order.side} ${order.shares} shares @$${order.price.toFixed(3)} (L${order.level})`);

        if (order.side === 'YES') {
          this.inventory.yesShares += order.shares;
          this.inventory.yesCost += order.price * order.shares;
        } else {
          this.inventory.noShares += order.shares;
          this.inventory.noCost += order.price * order.shares;
        }

        // Budget was committed when order was placed — now it's spent on shares
        this.budgetCommitted -= order.price * order.shares;
        this.totalFills++;
        this.virtualOrders.delete(id);

        this.logTrade({
          timestamp: Date.now(),
          action: `FILL_${order.side}`,
          conditionId: this.activeMarket!.conditionId,
          question: this.activeMarket!.question,
          side: order.side,
          price: order.price,
          shares: order.shares,
          pnl: 0,
          balance: this.getEffectiveBalance(),
          reason: `Grid fill level=${order.level}`,
        });
      }
    }
  }

  // ── Virtual Order Management ──────────────────────────────────────────

  private replaceVirtualOrders(
    newGrid: Array<{ side: 'YES' | 'NO'; price: number; shares: number; level: number }>
  ): void {
    // Build desired set
    const desired = new Map<string, { side: 'YES' | 'NO'; price: number; shares: number; level: number }>();
    for (const g of newGrid) {
      const key = `${g.side}_${g.price.toFixed(2)}_${g.level}`;
      desired.set(key, g);
    }

    // Remove orders not in new grid
    for (const [id, order] of this.virtualOrders) {
      const key = `${order.side}_${order.price.toFixed(2)}_${order.level}`;
      if (!desired.has(key)) {
        this.budgetCommitted -= order.price * order.shares;
        this.virtualOrders.delete(id);
      } else {
        // Already have this order — don't need to place it
        desired.delete(key);
      }
    }

    // Place new orders
    for (const [, g] of desired) {
      const id = `paper_${this.nextOrderId++}`;
      const tokenId = this.activeMarket!
        ? (g.side === 'YES' ? this.activeMarket!.yesTokenId : this.activeMarket!.noTokenId)
        : '';

      this.virtualOrders.set(id, {
        id,
        tokenId,
        side: g.side,
        price: g.price,
        shares: g.shares,
        level: g.level,
        placedAt: Date.now(),
      });

      this.budgetCommitted += g.price * g.shares;
      console.log(`   📝 ${g.side} BUY ${g.shares} @$${g.price.toFixed(3)} (L${g.level})`);
    }
  }

  // ── Merge ─────────────────────────────────────────────────────────────

  private tryMerge(): void {
    const pairable = Math.min(this.inventory.yesShares, this.inventory.noShares);
    if (pairable < this.cfg.mergeThreshold) return;

    const yesAvg = this.inventory.yesCost / this.inventory.yesShares;
    const noAvg = this.inventory.noCost / this.inventory.noShares;
    const combinedAvgCost = yesAvg + noAvg;

    if (combinedAvgCost >= 1.0) {
      console.log(`   ⚠️  Merge not profitable: combined $${combinedAvgCost.toFixed(4)} >= $1.00`);
      return;
    }

    const mergeAmount = Math.floor(pairable);
    const profitPerPair = 1.0 - combinedAvgCost;
    const totalProfit = profitPerPair * mergeAmount;

    console.log(`\n🔄 MERGE: ${mergeAmount} pairs | cost=$${combinedAvgCost.toFixed(4)} | profit=$${totalProfit.toFixed(4)}`);

    // Update inventory
    const yesMergedCost = yesAvg * mergeAmount;
    const noMergedCost = noAvg * mergeAmount;

    this.inventory.yesShares -= mergeAmount;
    this.inventory.noShares -= mergeAmount;
    this.inventory.yesCost -= yesMergedCost;
    this.inventory.noCost -= noMergedCost;
    this.inventory.mergedPairs += mergeAmount;
    this.inventory.mergeProfit += totalProfit;

    // Merge returns $1.00 per pair back to balance
    this.balance += mergeAmount * 1.0;
    this.sessionPnL += totalProfit;
    this.totalMerges++;

    this.updatePeakBalance();

    this.logTrade({
      timestamp: Date.now(),
      action: 'MERGE',
      conditionId: this.activeMarket?.conditionId || '',
      question: this.activeMarket?.question || '',
      side: 'BOTH',
      price: combinedAvgCost,
      shares: mergeAmount,
      pnl: totalProfit,
      balance: this.getEffectiveBalance(),
      reason: `Merged ${mergeAmount} pairs @ combined $${combinedAvgCost.toFixed(4)}`,
    });
  }

  // ── Resolve unhedged at session end ───────────────────────────────────

  private resolveUnhedged(): void {
    // At session end, unhedged shares are worth $0 (pessimistic assumption)
    // In reality, they'd ride to resolution, but for paper trading we assume worst case
    const yesLoss = this.inventory.yesCost;
    const noLoss = this.inventory.noCost;
    const totalLoss = yesLoss + noLoss;

    if (totalLoss > 0) {
      console.log(`\n⚠️  Unhedged inventory at session end:`);
      console.log(`   YES: ${this.inventory.yesShares.toFixed(2)} shares (cost $${yesLoss.toFixed(4)})`);
      console.log(`   NO: ${this.inventory.noShares.toFixed(2)} shares (cost $${noLoss.toFixed(4)})`);
      console.log(`   Worst-case loss: -$${totalLoss.toFixed(4)} (assumes all resolve to $0)`);

      this.sessionPnL -= totalLoss;
      this.balance -= totalLoss;
    }
  }

  // ── Risk & Balance ────────────────────────────────────────────────────

  private getEffectiveBalance(): number {
    return this.balance - this.budgetCommitted;
  }

  private updatePeakBalance(): void {
    const effective = this.getEffectiveBalance();
    if (effective > this.peakBalance) {
      this.peakBalance = effective;
    }
    const dd = this.peakBalance - effective;
    if (dd > this.maxDrawdown) {
      this.maxDrawdown = dd;
    }
  }

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

  private logTrade(log: TradeLog): void {
    this.trades.push(log);
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
      `\r  📊 GMM-PAPER ${elapsed}m | BTC=$${btc.toFixed(0)} | ` +
      `YES=${inv.yesShares.toFixed(1)}@$${yesAvg} NO=${inv.noShares.toFixed(1)}@$${noAvg} | ` +
      `Fills=${this.totalFills} Merges=${this.totalMerges} PnL=$${this.sessionPnL.toFixed(4)} | ` +
      `Orders=${this.virtualOrders.size} TTL=${ttl}s` +
      '   '
    );
  }

  private printFinalReport(): void {
    const elapsed = ((Date.now() - this.startTime) / 60000).toFixed(1);
    const effective = this.getEffectiveBalance();
    const returnPct = ((effective - this.cfg.startingBalance) / this.cfg.startingBalance * 100).toFixed(2);

    console.log('\n\n' + '='.repeat(65));
    console.log('📊 GMM PAPER SESSION REPORT');
    console.log('='.repeat(65));
    console.log(`   Duration:           ${elapsed} minutes`);
    console.log(`   Starting balance:   $${this.cfg.startingBalance.toFixed(2)}`);
    console.log(`   Final balance:      $${effective.toFixed(4)}`);
    console.log(`   Return:             ${returnPct}%`);
    console.log(`   Peak balance:       $${this.peakBalance.toFixed(4)}`);
    console.log(`   Max drawdown:       $${this.maxDrawdown.toFixed(4)}`);
    console.log(`   Markets rotated:    ${this.marketsRotated}`);
    console.log(`   Total fills:        ${this.totalFills}`);
    console.log(`   Total merges:       ${this.totalMerges}`);
    console.log(`   Merged pairs:       ${this.inventory.mergedPairs}`);
    console.log(`   Merge profit:       $${this.inventory.mergeProfit.toFixed(4)}`);
    console.log(`   Session P&L:        $${this.sessionPnL.toFixed(4)}`);
    if (this.sessionHalted) {
      console.log(`   ⛔ Halted:          ${this.haltReason}`);
    }
    console.log('='.repeat(65));
  }

  private saveResults(): void {
    const dir = join(process.cwd(), 'backtest', 'data');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const sessionId = new Date().toISOString().replace(/[:.]/g, '-');
    const path = join(dir, `gmm_paper_${sessionId}.json`);

    const effective = this.getEffectiveBalance();
    const results = {
      strategy: 'GMM_PAPER',
      config: this.cfg,
      wallet: {
        startingBalance: this.cfg.startingBalance,
        finalBalance: effective,
        returnPct: (effective - this.cfg.startingBalance) / this.cfg.startingBalance * 100,
        peakBalance: this.peakBalance,
        maxDrawdown: this.maxDrawdown,
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
  const cfg = loadConfig();
  const engine = new GmmPaperEngine(cfg);

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
  console.error('❌ GMM Paper fatal error:', err);
  process.exit(1);
});
