import { EventEmitter } from 'events';
import { BinancePriceFeed } from './binance-feed.js';
import { MarketScanner, type ScannedMarket } from './market-scanner.js';
import { DualPositionTracker, type DualPosition } from './dual-position-tracker.js';
import { MergeExecutor } from './merge-executor.js';
import { TradeExecutor } from './trader.js';
import { PositionTracker } from './positions.js';
import { RiskManager } from './risk-manager.js';
import type { Trade } from './monitor.js';

export interface VolatilityConfig {
  enabled: boolean;
  maxEntryCost: number;
  minVolatility: number;
  strikeProximityPct: number;
  positionSize: number;
  takeProfitPct: number;
  stopLossPct: number;
  mergeTimeThresholdMs: number;
  panicExitSeconds: number;
  scanIntervalMs: number;
  cycleIntervalMs: number;
  maxOpenPositions: number;
  minTtlMs: number;
  maxTtlMs: number;
}

export interface VolatilityStats {
  openPositions: number;
  totalEntries: number;
  totalExits: number;
  totalMerges: number;
  realizedPnL: number;
}

export class VolatilityStrategy extends EventEmitter {
  private binanceFeed: BinancePriceFeed;
  private scanner: MarketScanner;
  private dualTracker: DualPositionTracker;
  private mergeExecutor: MergeExecutor;
  private executor: TradeExecutor;
  private positions: PositionTracker;
  private risk: RiskManager;
  private config: VolatilityConfig;

  private isRunning = false;
  private scanTimer: NodeJS.Timeout | null = null;
  private cycleTimer: NodeJS.Timeout | null = null;
  private processingCycle = false;

  private stats: VolatilityStats = {
    openPositions: 0,
    totalEntries: 0,
    totalExits: 0,
    totalMerges: 0,
    realizedPnL: 0,
  };

  constructor(params: {
    binanceFeed: BinancePriceFeed;
    scanner: MarketScanner;
    mergeExecutor: MergeExecutor;
    executor: TradeExecutor;
    positions: PositionTracker;
    risk: RiskManager;
    config: VolatilityConfig;
  }) {
    super();
    this.binanceFeed = params.binanceFeed;
    this.scanner = params.scanner;
    this.dualTracker = new DualPositionTracker();
    this.mergeExecutor = params.mergeExecutor;
    this.executor = params.executor;
    this.positions = params.positions;
    this.risk = params.risk;
    this.config = params.config;
  }

  async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    console.log('\n🎲 Volatility Strategy Started');
    console.log(`   Max entry cost: $${this.config.maxEntryCost}`);
    console.log(`   Position size: $${this.config.positionSize} per side`);
    console.log(`   Take profit: ${this.config.takeProfitPct}%`);
    console.log(`   Stop loss: ${this.config.stopLossPct}%`);
    console.log(`   Max positions: ${this.config.maxOpenPositions}`);
    console.log(`   Scan interval: ${this.config.scanIntervalMs / 1000}s`);
    console.log(`   Cycle interval: ${this.config.cycleIntervalMs / 1000}s\n`);

    // Initial scan
    await this.runScanCycle();

    // Start periodic loops
    this.scanTimer = setInterval(() => this.runScanCycle(), this.config.scanIntervalMs);
    this.cycleTimer = setInterval(() => this.runDecisionCycle(), this.config.cycleIntervalMs);
  }

  stop(): void {
    this.isRunning = false;
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
    if (this.cycleTimer) {
      clearInterval(this.cycleTimer);
      this.cycleTimer = null;
    }
    console.log('🛑 Volatility Strategy stopped');
    this.printStats();
  }

  getStats(): VolatilityStats {
    return {
      ...this.stats,
      openPositions: this.dualTracker.getOpenCount(),
    };
  }

  getOpenPositions(): DualPosition[] {
    return this.dualTracker.getOpenPositions();
  }

  private async runScanCycle(): Promise<void> {
    if (!this.isRunning) return;
    try {
      await this.scanner.scan();
    } catch (error: any) {
      console.error(`❌ Scan cycle error: ${error.message}`);
    }
  }

  private async runDecisionCycle(): Promise<void> {
    if (!this.isRunning || this.processingCycle) return;
    this.processingCycle = true;

    try {
      // Check exits first (higher priority)
      await this.evaluateExits();

      // Then check entries
      await this.evaluateEntries();
    } catch (error: any) {
      console.error(`❌ Decision cycle error: ${error.message}`);
    } finally {
      this.processingCycle = false;
    }
  }

  // ── Entry Logic ─────────────────────────────────────────────────────────

  private async evaluateEntries(): Promise<void> {
    if (this.dualTracker.getOpenCount() >= this.config.maxOpenPositions) return;

    const btcPrice = this.binanceFeed.getPrice();
    if (btcPrice <= 0) return;

    const volatility = this.binanceFeed.getVolatility(60_000);
    if (volatility < this.config.minVolatility) return;

    const markets = this.scanner.getCachedMarkets();

    for (const market of markets) {
      if (this.dualTracker.getOpenCount() >= this.config.maxOpenPositions) break;
      if (this.dualTracker.hasPosition(market.conditionId)) continue;

      if (this.shouldEnter(market, btcPrice, volatility)) {
        await this.executeEntry(market);
      }
    }
  }

  private shouldEnter(market: ScannedMarket, btcPrice: number, volatility: number): boolean {
    // 1. Combined cost must be below threshold
    if (market.combinedCost >= this.config.maxEntryCost) return false;

    // 2. BTC price must be near the strike
    if (market.strikePrice > 0) {
      const distance = Math.abs(btcPrice - market.strikePrice) / market.strikePrice * 100;
      if (distance > this.config.strikeProximityPct) return false;
    }

    // 3. Check TTL
    const now = Date.now();
    if (market.expiresAt > 0) {
      const ttl = market.expiresAt - now;
      if (ttl < this.config.minTtlMs || ttl > this.config.maxTtlMs) return false;
    }

    // 4. Both sides must have asks
    if (market.yesBestAsk <= 0 || market.noBestAsk <= 0) return false;

    return true;
  }

  private async executeEntry(market: ScannedMarket): Promise<void> {
    const perSideNotional = this.config.positionSize;
    const totalNotional = perSideNotional * 2;

    // Risk check (use YES tokenId as representative for the market)
    const syntheticTrade: Trade = {
      txHash: `vol-entry-${Date.now()}`,
      timestamp: Date.now(),
      market: market.conditionId,
      tokenId: market.yesTokenId,
      side: 'BUY',
      price: market.yesBestAsk,
      size: totalNotional,
      outcome: 'YES',
    };

    const riskCheck = this.risk.checkTrade(syntheticTrade, totalNotional);
    if (!riskCheck.allowed) {
      console.log(`   ⚠️  Risk blocked entry for "${market.question.slice(0, 40)}": ${riskCheck.reason}`);
      return;
    }

    console.log(`\n📈 VOL ENTRY: "${market.question.slice(0, 60)}"`);
    console.log(`   Combined cost: $${market.combinedCost.toFixed(4)}`);
    console.log(`   YES ask: $${market.yesBestAsk.toFixed(4)}, NO ask: $${market.noBestAsk.toFixed(4)}`);
    console.log(`   Position size: $${perSideNotional} per side`);

    try {
      // Buy YES side
      const yesTrade: Trade = {
        txHash: `vol-yes-${Date.now()}`,
        timestamp: Date.now(),
        market: market.conditionId,
        tokenId: market.yesTokenId,
        side: 'BUY',
        price: market.yesBestAsk,
        size: perSideNotional,
        outcome: 'YES',
      };

      const yesResult = await this.executor.executeCopyTrade(yesTrade, perSideNotional);
      console.log(`   ✅ YES filled: ${yesResult.copyShares} shares @ $${yesResult.price.toFixed(4)}`);

      // Buy NO side
      const noTrade: Trade = {
        txHash: `vol-no-${Date.now()}`,
        timestamp: Date.now(),
        market: market.conditionId,
        tokenId: market.noTokenId,
        side: 'BUY',
        price: market.noBestAsk,
        size: perSideNotional,
        outcome: 'NO',
      };

      let noResult;
      try {
        noResult = await this.executor.executeCopyTrade(noTrade, perSideNotional);
        console.log(`   ✅ NO filled: ${noResult.copyShares} shares @ $${noResult.price.toFixed(4)}`);
      } catch (noError: any) {
        // Half-position: YES filled but NO didn't. Track as single-sided.
        console.log(`   ⚠️  NO side failed: ${noError.message}. Tracking YES-only position.`);
        this.dualTracker.openPosition({
          conditionId: market.conditionId,
          question: market.question,
          yesTokenId: market.yesTokenId,
          noTokenId: market.noTokenId,
          yesEntryPrice: yesResult.price,
          noEntryPrice: 0,
          shares: yesResult.copyShares,
          expiresAt: market.expiresAt,
          strikePrice: market.strikePrice,
          negRisk: market.negRisk,
        });
        // Mark NO as not held since it was never bought
        this.dualTracker.closeNo(market.conditionId);

        this.stats.totalEntries++;
        this.emit('vol:entry', { market, yesResult, noResult: null, halfPosition: true });
        return;
      }

      // Use the minimum shares between sides (for merge compatibility)
      const shares = Math.min(yesResult.copyShares, noResult.copyShares);

      this.dualTracker.openPosition({
        conditionId: market.conditionId,
        question: market.question,
        yesTokenId: market.yesTokenId,
        noTokenId: market.noTokenId,
        yesEntryPrice: yesResult.price,
        noEntryPrice: noResult.price,
        shares,
        expiresAt: market.expiresAt,
        strikePrice: market.strikePrice,
        negRisk: market.negRisk,
      });

      // Record fills for risk tracking
      this.risk.recordFill({ trade: yesTrade, notional: yesResult.copyNotional, shares: yesResult.copyShares, price: yesResult.price, side: 'BUY' });
      this.risk.recordFill({ trade: noTrade, notional: noResult.copyNotional, shares: noResult.copyShares, price: noResult.price, side: 'BUY' });

      this.stats.totalEntries++;
      const mergeProfit = (1.0 - (yesResult.price + noResult.price)) * shares;
      console.log(`   📊 Guaranteed merge profit: $${mergeProfit.toFixed(4)} (if merged)`);

      this.emit('vol:entry', { market, yesResult, noResult, halfPosition: false });
    } catch (error: any) {
      console.error(`   ❌ Entry failed: ${error.message}`);
      this.emit('vol:entry:failed', { market, error: error.message });
    }
  }

  // ── Exit Logic ──────────────────────────────────────────────────────────

  private async evaluateExits(): Promise<void> {
    const openPositions = this.dualTracker.getOpenPositions();
    if (openPositions.length === 0) return;

    const btcPrice = this.binanceFeed.getPrice();

    for (const pos of openPositions) {
      try {
        await this.evaluatePositionExit(pos, btcPrice);
      } catch (error: any) {
        console.error(`   ❌ Exit evaluation error for ${pos.conditionId.slice(0, 14)}: ${error.message}`);
      }
    }
  }

  private async evaluatePositionExit(pos: DualPosition, btcPrice: number): Promise<void> {
    const now = Date.now();
    const ttl = pos.expiresAt > 0 ? pos.expiresAt - now : Infinity;

    // Fetch current orderbook prices for held sides
    let currentYesBid = 0;
    let currentNoBid = 0;

    if (pos.yesHeld) {
      try {
        const yesBook = await this.executor.getOrderBook(pos.yesTokenId);
        currentYesBid = parseFloat(yesBook.bids?.[0]?.price || '0');
      } catch { /* no bids */ }
    }

    if (pos.noHeld) {
      try {
        const noBook = await this.executor.getOrderBook(pos.noTokenId);
        currentNoBid = parseFloat(noBook.bids?.[0]?.price || '0');
      } catch { /* no bids */ }
    }

    const pnl = this.dualTracker.computePnL(pos.conditionId, currentYesBid, currentNoBid);
    if (!pnl) return;

    // 5. PANIC EXIT — too close to expiry
    if (ttl < this.config.panicExitSeconds * 1000) {
      console.log(`\n⚠️  PANIC EXIT for "${pos.question.slice(0, 40)}" (TTL: ${(ttl / 1000).toFixed(0)}s)`);
      if (pnl.canMerge && pnl.mergeProfit > 0) {
        await this.executeMerge(pos);
      } else {
        await this.sellAllHeldSides(pos, currentYesBid, currentNoBid);
      }
      return;
    }

    // 4. MERGE WINDOW — close to expiry but merge is profitable
    if (ttl < this.config.mergeTimeThresholdMs && pnl.canMerge && pnl.mergeProfit > 0) {
      console.log(`\n🔄 Merge window for "${pos.question.slice(0, 40)}" (TTL: ${(ttl / 1000).toFixed(0)}s, merge profit: $${pnl.mergeProfit.toFixed(4)})`);
      await this.executeMerge(pos);
      return;
    }

    // 3. STOP LOSS — combined loss exceeds threshold
    const totalEntry = pos.yesNotional + pos.noNotional;
    if (totalEntry > 0 && pnl.totalPnL < 0) {
      const lossPct = Math.abs(pnl.totalPnL) / totalEntry * 100;
      if (lossPct >= this.config.stopLossPct) {
        console.log(`\n🛑 STOP LOSS for "${pos.question.slice(0, 40)}" (loss: ${lossPct.toFixed(1)}%)`);
        await this.sellAllHeldSides(pos, currentYesBid, currentNoBid);
        return;
      }
    }

    // 1. TAKE PROFIT on YES side
    if (pos.yesHeld && pos.yesEntryPrice > 0 && currentYesBid > 0) {
      const yesProfitPct = (currentYesBid - pos.yesEntryPrice) / pos.yesEntryPrice * 100;
      if (yesProfitPct >= this.config.takeProfitPct) {
        console.log(`\n💰 YES take-profit for "${pos.question.slice(0, 40)}" (profit: ${yesProfitPct.toFixed(1)}%)`);
        await this.sellSide(pos, 'YES', currentYesBid);
      }
    }

    // 2. TAKE PROFIT on NO side
    if (pos.noHeld && pos.noEntryPrice > 0 && currentNoBid > 0) {
      const noProfitPct = (currentNoBid - pos.noEntryPrice) / pos.noEntryPrice * 100;
      if (noProfitPct >= this.config.takeProfitPct) {
        console.log(`\n💰 NO take-profit for "${pos.question.slice(0, 40)}" (profit: ${noProfitPct.toFixed(1)}%)`);
        await this.sellSide(pos, 'NO', currentNoBid);
      }
    }
  }

  private async sellSide(pos: DualPosition, side: 'YES' | 'NO', currentBid: number): Promise<void> {
    const tokenId = side === 'YES' ? pos.yesTokenId : pos.noTokenId;
    const entryPrice = side === 'YES' ? pos.yesEntryPrice : pos.noEntryPrice;

    const sellTrade: Trade = {
      txHash: `vol-sell-${side.toLowerCase()}-${Date.now()}`,
      timestamp: Date.now(),
      market: pos.conditionId,
      tokenId,
      side: 'SELL',
      price: currentBid,
      size: pos.shares * currentBid,
      outcome: side,
    };

    try {
      const result = await this.executor.executeCopyTrade(sellTrade, pos.shares * currentBid);
      const profit = (result.price - entryPrice) * pos.shares;

      console.log(`   ✅ Sold ${side}: ${pos.shares} shares @ $${result.price.toFixed(4)} (P&L: $${profit.toFixed(4)})`);

      this.stats.realizedPnL += profit;
      this.stats.totalExits++;

      if (side === 'YES') {
        this.dualTracker.closeYes(pos.conditionId);
      } else {
        this.dualTracker.closeNo(pos.conditionId);
      }

      this.emit('vol:exit', { position: pos, side, result, profit });
    } catch (error: any) {
      console.error(`   ❌ Failed to sell ${side}: ${error.message}`);
    }
  }

  private async sellAllHeldSides(pos: DualPosition, currentYesBid: number, currentNoBid: number): Promise<void> {
    if (pos.yesHeld && currentYesBid > 0) {
      await this.sellSide(pos, 'YES', currentYesBid);
    }
    if (pos.noHeld && currentNoBid > 0) {
      await this.sellSide(pos, 'NO', currentNoBid);
    }
    // Clean up if sells failed (no bids)
    this.dualTracker.closeBoth(pos.conditionId);
  }

  private async executeMerge(pos: DualPosition): Promise<void> {
    try {
      const result = await this.mergeExecutor.merge({
        conditionId: pos.conditionId,
        amount: pos.shares,
        negRisk: pos.negRisk,
      });

      const mergeProfit = (1.0 - (pos.yesEntryPrice + pos.noEntryPrice)) * pos.shares;
      this.stats.realizedPnL += mergeProfit;
      this.stats.totalMerges++;
      this.stats.totalExits++;

      this.dualTracker.closeBoth(pos.conditionId);

      console.log(`   ✅ Merged: $${mergeProfit.toFixed(4)} profit (tx: ${result.txHash.slice(0, 14)}...)`);
      this.emit('vol:merge', { position: pos, result, profit: mergeProfit });
    } catch (error: any) {
      console.error(`   ❌ Merge failed: ${error.message}`);
      // Fallback: try selling both sides
      console.log(`   Falling back to market sell...`);
      await this.sellAllHeldSides(pos, 0, 0);
    }
  }

  private printStats(): void {
    const stats = this.getStats();
    console.log('\n📊 Volatility Strategy Statistics:');
    console.log(`   Total entries: ${stats.totalEntries}`);
    console.log(`   Total exits: ${stats.totalExits}`);
    console.log(`   Total merges: ${stats.totalMerges}`);
    console.log(`   Open positions: ${stats.openPositions}`);
    console.log(`   Realized P&L: $${stats.realizedPnL.toFixed(4)}`);
  }
}
