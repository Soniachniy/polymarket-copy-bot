#!/usr/bin/env tsx
/**
 * LIVE SNIPER — Real-money late-entry strategy for btc-updown-5m markets.
 *
 * THE EDGE:
 *   At T-15s before a 5-min window expires, BTC direction is ~80% locked.
 *   Buy the winning side at $0.60-0.90 via FOK order.
 *   Sell before expiry at $0.85-0.95 to free capital, or hold to resolution ($1.00).
 *   If wrong, merge rescue: buy other side + on-chain merge for $1.00.
 *
 * Usage:
 *   npm run sniper:live          # runs indefinitely
 *   npx tsx src/live-sniper.ts   # same
 */

import dotenv from 'dotenv';
dotenv.config();

import { AssetType } from '@polymarket/clob-client';
import { appendFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { config } from './config.js';
import { TradeExecutor, type CopyExecutionResult } from './trader.js';
import { MergeExecutor } from './merge-executor.js';
import { BinancePriceFeed } from './binance-feed.js';
import { MarketScanner, type ScannedMarket } from './market-scanner.js';
import type { Trade } from './monitor.js';

// ── Configuration ──────────────────────────────────────────────────────────

interface SniperConfig {
  startingBalance: number;        // for display & stop-loss % calc
  positionSizePct: number;
  minPositionSize: number;
  sessionStopLossPct: number;

  entryWindowSeconds: number;
  maxEntryPrice: number;
  minEntryPrice: number;
  minBtcDeltaUsd: number;

  mergeRescueEnabled: boolean;
  mergeMaxCombinedCost: number;

  exitBeforeExpirySec: number;
  minExitBidPrice: number;

  maxOpenPositions: number;
  consecutiveLossLimit: number;
  cooldownAfterLossMs: number;

  scanIntervalMs: number;
  cycleIntervalMs: number;

  symbol: string;
}

function loadConfig(): SniperConfig {
  return {
    startingBalance: parseFloat(process.env.SNIPER_STARTING_BALANCE || '5'),
    positionSizePct: parseFloat(process.env.SNIPER_POSITION_SIZE_PCT || '0.90'),
    minPositionSize: parseFloat(process.env.SNIPER_MIN_POSITION_SIZE || '2.50'),
    sessionStopLossPct: parseFloat(process.env.SNIPER_SESSION_STOP_LOSS_PCT || '50'),

    entryWindowSeconds: parseInt(process.env.SNIPER_ENTRY_WINDOW_SEC || '15'),
    maxEntryPrice: parseFloat(process.env.SNIPER_MAX_ENTRY_PRICE || '0.92'),
    minEntryPrice: parseFloat(process.env.SNIPER_MIN_ENTRY_PRICE || '0.55'),
    minBtcDeltaUsd: parseFloat(process.env.SNIPER_MIN_BTC_DELTA_USD || '10'),

    mergeRescueEnabled: process.env.SNIPER_MERGE_RESCUE !== 'false',
    mergeMaxCombinedCost: parseFloat(process.env.SNIPER_MERGE_MAX_COST || '0.99'),

    exitBeforeExpirySec: parseInt(process.env.SNIPER_EXIT_BEFORE_EXPIRY_SEC || '8'),
    minExitBidPrice: parseFloat(process.env.SNIPER_MIN_EXIT_BID || '0.60'),

    maxOpenPositions: parseInt(process.env.SNIPER_MAX_OPEN || '1'),
    consecutiveLossLimit: parseInt(process.env.SNIPER_CONSEC_LOSS_LIMIT || '3'),
    cooldownAfterLossMs: parseInt(process.env.SNIPER_COOLDOWN_LOSS_MS || '300000'),

    scanIntervalMs: parseInt(process.env.SNIPER_SCAN_INTERVAL_MS || '10000'),
    cycleIntervalMs: parseInt(process.env.SNIPER_CYCLE_INTERVAL_MS || '1000'),

    symbol: (process.env.SNIPER_SYMBOL || 'btcusdt').toLowerCase(),
  };
}

// ── Types ───────────────────────────────────────────────────────────────────

interface WindowTracker {
  conditionId: string;
  question: string;
  slug: string;
  market: ScannedMarket;
  windowStartBtcPrice: number;
  windowStartTime: number;
  expiresAt: number;
  entered: boolean;
  skipped: boolean;
}

interface LivePosition {
  conditionId: string;
  question: string;
  side: 'up' | 'down';
  tokenId: string;
  otherTokenId: string;
  orderId: string;
  entryPrice: number;
  shares: number;
  cost: number;
  entryTime: number;
  expiresAt: number;
  btcPriceAtEntry: number;
  btcDelta: number;
  negRisk: boolean;
  mergeRescued: boolean;
  mergeCost: number;
  status: 'open' | 'exiting' | 'merging' | 'resolved';
}

interface TradeLog {
  timestamp: number;
  action: string;
  conditionId: string;
  question: string;
  side: string;
  entryPrice: number;
  exitPrice: number;
  shares: number;
  pnl: number;
  btcPrice: number;
  btcDelta: number;
  balance: number;
  orderId: string;
  reason: string;
}

interface WindowSkipLog {
  timestamp: number;
  conditionId: string;
  question: string;
  btcStart: number;
  btcEnd: number;
  btcDelta: number;
  ttlAtSkip: number;
  trackingDuration: number;
  reason: string;
  bestAsk?: number;
  askDepth?: number;
}

// ── Live Sniper Engine ─────────────────────────────────────────────────────

class LiveSniperEngine {
  private config: SniperConfig;
  private executor: TradeExecutor;
  private mergeExecutor: MergeExecutor;
  private binanceFeed: BinancePriceFeed;
  private scanner: MarketScanner;

  private windowTrackers = new Map<string, WindowTracker>();
  private positions = new Map<string, LivePosition>();

  // Balance tracking (real CLOB balance + cache)
  private cachedBalance = 0;
  private balanceCacheTime = 0;
  private readonly BALANCE_CACHE_MS = 2000;

  // Stats
  private trades: TradeLog[] = [];
  private skips: WindowSkipLog[] = [];
  private realizedPnL = 0;
  private initialBalance = 0;
  private wins = 0;
  private losses = 0;
  private consecutiveLosses = 0;
  private totalSnipes = 0;
  private windowsSeen = 0;
  private windowsSkipped = 0;

  // Session
  private sessionHalted = false;
  private haltReason = '';
  private lastLossTime = 0;
  private isPlacingOrder = false;
  private startTime = 0;
  private sessionId: string;

  // Timers
  private scanTimer: NodeJS.Timeout | null = null;
  private cycleTimer: NodeJS.Timeout | null = null;
  private dashTimer: NodeJS.Timeout | null = null;

  // Log file path
  private logPath: string;

  constructor(
    executor: TradeExecutor,
    mergeExecutor: MergeExecutor,
    binanceFeed: BinancePriceFeed,
    scanner: MarketScanner,
    sniperConfig: SniperConfig,
  ) {
    this.config = sniperConfig;
    this.executor = executor;
    this.mergeExecutor = mergeExecutor;
    this.binanceFeed = binanceFeed;
    this.scanner = scanner;

    this.sessionId = new Date().toISOString().replace(/[:.]/g, '-');
    const dir = join(process.cwd(), 'backtest', 'data');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.logPath = join(dir, `live_trades_${this.sessionId}.jsonl`);
  }

  async run(): Promise<void> {
    const c = this.config;
    console.log('\n💰 LIVE SNIPER — Real Money Trading');
    console.log('='.repeat(65));
    console.log(`   Entry window:    T-${c.entryWindowSeconds}s before expiry`);
    console.log(`   Entry price:     $${c.minEntryPrice} — $${c.maxEntryPrice}`);
    console.log(`   Min BTC delta:   $${c.minBtcDeltaUsd}`);
    console.log(`   Position size:   ${(c.positionSizePct * 100).toFixed(0)}% of balance`);
    console.log(`   Pre-expiry exit: T-${c.exitBeforeExpirySec}s (min bid $${c.minExitBidPrice})`);
    console.log(`   Merge rescue:    ${c.mergeRescueEnabled ? 'ON' : 'OFF'}`);
    console.log(`   Loss limit:      ${c.consecutiveLossLimit} consecutive → ${(c.cooldownAfterLossMs / 60000).toFixed(0)}min cooldown`);
    console.log(`   Session halt:    ${c.sessionStopLossPct}% drawdown`);
    console.log('='.repeat(65));

    // 1. Connect Binance
    console.log(`\n🔌 Connecting to Binance (${c.symbol})...`);
    await this.binanceFeed.initialize();
    await this.waitForPrice();
    console.log(`✅ Binance: BTC=$${this.binanceFeed.getPrice().toFixed(2)}`);

    // 2. Check real CLOB balance
    console.log('\n💳 Checking Polymarket balance...');
    const balance = await this.fetchBalance();
    this.initialBalance = balance;
    console.log(`   CLOB balance: $${balance.toFixed(2)} USDC`);

    if (balance < this.config.minPositionSize) {
      console.log(`\n❌ Insufficient balance. Need at least $${this.config.minPositionSize.toFixed(2)} (min 5 shares).`);
      console.log(`   Current: $${balance.toFixed(2)}`);
      console.log(`   Deposit more USDC to your Polymarket account to continue.`);
      this.binanceFeed.close();
      return;
    }

    // 3. Initial scan
    console.log('\n🔍 Scanning Polymarket for btc-updown-5m markets...');
    const markets = await this.scanner.scan(true);
    const updown = markets.filter(m => m.marketType === 'updown');
    console.log(`   Found ${updown.length} active market(s)`);
    for (const m of updown) {
      const ttl = ((m.expiresAt - Date.now()) / 1000).toFixed(0);
      console.log(`   • "${m.question.slice(0, 55)}" TTL=${ttl}s`);
    }

    // 4. Go live
    console.log(`\n🚀 LIVE SNIPER ACTIVE — waiting for entry windows...`);
    console.log(`   Balance: $${balance.toFixed(2)} | Each 5-min window is an opportunity.`);
    console.log(`   Will enter at T-${c.entryWindowSeconds}s when BTC direction is locked.\n`);

    this.startTime = Date.now();
    this.scanTimer = setInterval(() => this.runScan(), c.scanIntervalMs);
    this.cycleTimer = setInterval(() => this.runCycle(), c.cycleIntervalMs);
    this.dashTimer = setInterval(() => this.printDashboard(), 5000);

    // Run indefinitely until SIGINT or halt
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
    console.log('\n\n⏹️  Shutting down...');
    if (this.scanTimer) clearInterval(this.scanTimer);
    if (this.cycleTimer) clearInterval(this.cycleTimer);
    if (this.dashTimer) clearInterval(this.dashTimer);
    this.binanceFeed.close();

    // Report open positions (DON'T auto-sell — user may want to keep them)
    if (this.positions.size > 0) {
      console.log(`\n⚠️  ${this.positions.size} OPEN POSITION(S) — not auto-closed:`);
      for (const [, pos] of this.positions) {
        console.log(`   • ${pos.side.toUpperCase()} ${pos.shares.toFixed(2)} shares @$${pos.entryPrice.toFixed(3)} | ${pos.question.slice(0, 50)}`);
        console.log(`     Order: ${pos.orderId} | Status: ${pos.status}`);
      }
    }

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
      return this.cachedBalance; // return stale if available
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

  // ── Market Scan ─────────────────────────────────────────────────────────

  private async runScan(): Promise<void> {
    try {
      const markets = await this.scanner.scan(true);

      for (const m of markets) {
        if (m.marketType !== 'updown') continue;
        if (this.windowTrackers.has(m.conditionId)) {
          this.windowTrackers.get(m.conditionId)!.market = m;
          continue;
        }

        const btcPrice = this.binanceFeed.getPrice();
        if (btcPrice <= 0) continue;

        this.windowTrackers.set(m.conditionId, {
          conditionId: m.conditionId,
          question: m.question,
          slug: m.slug,
          market: m,
          windowStartBtcPrice: btcPrice,
          windowStartTime: Date.now(),
          expiresAt: m.expiresAt,
          entered: false,
          skipped: false,
        });
        this.windowsSeen++;

        const ttl = ((m.expiresAt - Date.now()) / 1000).toFixed(0);
        console.log(`\n  📡 NEW WINDOW: "${m.question.slice(0, 60)}"`);
        console.log(`     TTL=${ttl}s | BTC=$${btcPrice.toFixed(0)} (tracking start)`);
      }

      // Clean expired trackers
      const now = Date.now();
      for (const [id, tracker] of this.windowTrackers) {
        if (tracker.expiresAt < now - 120_000 && !this.positions.has(id)) {
          this.windowTrackers.delete(id);
        }
      }
    } catch {}
  }

  // ── Decision Cycle (1s) ─────────────────────────────────────────────────

  private async runCycle(): Promise<void> {
    if (this.sessionHalted || this.isPlacingOrder) return;

    const now = Date.now();
    const btcPrice = this.binanceFeed.getPrice();
    if (btcPrice <= 0) return;

    // 1. Check positions for exit/merge
    await this.evaluatePositions(btcPrice, now);

    // 2. Check windows for snipe entry
    for (const [condId, tracker] of this.windowTrackers) {
      if (tracker.entered || tracker.skipped) continue;
      if (this.positions.has(condId)) continue;

      const ttl = tracker.expiresAt - now;

      if (ttl > this.config.entryWindowSeconds * 1000) continue;
      if (ttl <= 2000) {
        tracker.skipped = true;
        this.windowsSkipped++;
        const delta = btcPrice - tracker.windowStartBtcPrice;
        this.logWindowSkip(tracker, btcPrice, delta, 'expired before entry (TTL<=2s)');
        continue;
      }

      await this.evaluateSnipe(tracker, btcPrice, now);
    }

    // 3. Session stop-loss
    this.checkSessionStopLoss();
  }

  // ── Snipe Entry ─────────────────────────────────────────────────────────

  private async evaluateSnipe(tracker: WindowTracker, btcPrice: number, now: number): Promise<void> {
    const btcDelta = btcPrice - tracker.windowStartBtcPrice;
    const absDelta = Math.abs(btcDelta);
    const ttlSec = ((tracker.expiresAt - now) / 1000).toFixed(0);

    if (this.positions.size >= this.config.maxOpenPositions) {
      // Only log once when window is about to expire
      if (tracker.expiresAt - now < 5000 && !tracker.skipped) {
        tracker.skipped = true;
        this.windowsSkipped++;
        this.logWindowSkip(tracker, btcPrice, btcDelta, `max positions (${this.positions.size}/${this.config.maxOpenPositions})`);
      }
      return;
    }
    if (this.isPlacingOrder) return;

    // Cooldown
    if (this.consecutiveLosses >= this.config.consecutiveLossLimit) {
      if (now - this.lastLossTime < this.config.cooldownAfterLossMs) {
        if (tracker.expiresAt - now < 5000 && !tracker.skipped) {
          const cooldownLeft = ((this.config.cooldownAfterLossMs - (now - this.lastLossTime)) / 1000).toFixed(0);
          tracker.skipped = true;
          this.windowsSkipped++;
          this.logWindowSkip(tracker, btcPrice, btcDelta, `cooldown (${this.consecutiveLosses} consecutive losses, ${cooldownLeft}s left)`);
        }
        return;
      }
      this.consecutiveLosses = 0;
    }

    // BTC direction confidence
    if (absDelta < this.config.minBtcDeltaUsd) {
      if (tracker.expiresAt - now < 5000 && !tracker.skipped) {
        tracker.skipped = true;
        this.windowsSkipped++;
        const reason = `BTC Δ=$${btcDelta >= 0 ? '+' : ''}${btcDelta.toFixed(1)} < min $${this.config.minBtcDeltaUsd}`;
        console.log(`  ⏭️  SKIP: ${reason}`);
        this.logWindowSkip(tracker, btcPrice, btcDelta, reason);
      }
      return;
    }

    const predictedWinner: 'up' | 'down' = btcDelta > 0 ? 'up' : 'down';
    const market = tracker.market;

    // Get FRESH orderbook (not Gamma prices which lag)
    let bestAsk: number;
    let askDepth: number;
    const tokenId = predictedWinner === 'up' ? market.yesTokenId : market.noTokenId;
    const otherTokenId = predictedWinner === 'up' ? market.noTokenId : market.yesTokenId;

    try {
      const book = await this.executor.getOrderBook(tokenId);
      if (!book?.asks?.length) {
        const reason = `no asks in orderbook for ${predictedWinner.toUpperCase()}`;
        console.log(`  ⏭️  SKIP: ${reason}`);
        this.logWindowSkip(tracker, btcPrice, btcDelta, reason);
        return;
      }
      bestAsk = parseFloat(book.asks[0].price);
      askDepth = parseFloat(book.asks[0].size || '0');
    } catch (err: any) {
      const reason = `orderbook fetch failed: ${err.message}`;
      console.log(`  ⏭️  SKIP: ${reason}`);
      this.logWindowSkip(tracker, btcPrice, btcDelta, reason);
      return;
    }

    // Price validation
    if (bestAsk > this.config.maxEntryPrice) {
      tracker.skipped = true;
      this.windowsSkipped++;
      const reason = `${predictedWinner.toUpperCase()} ask $${bestAsk.toFixed(3)} > max $${this.config.maxEntryPrice}`;
      console.log(`  ⏭️  SKIP: ${reason}`);
      this.logWindowSkip(tracker, btcPrice, btcDelta, reason, bestAsk, askDepth);
      return;
    }
    if (bestAsk < this.config.minEntryPrice) {
      // Don't mark as skipped — price may update on next cycle
      // But log if window is expiring
      if (tracker.expiresAt - now < 5000 && !tracker.skipped) {
        tracker.skipped = true;
        this.windowsSkipped++;
        const reason = `${predictedWinner.toUpperCase()} ask $${bestAsk.toFixed(3)} < min $${this.config.minEntryPrice} (no edge signal)`;
        this.logWindowSkip(tracker, btcPrice, btcDelta, reason, bestAsk, askDepth);
      }
      return;
    }

    // Balance check (fresh)
    const balance = await this.fetchBalance();
    const budget = balance * this.config.positionSizePct;
    if (budget < this.config.minPositionSize) {
      const reason = `budget $${budget.toFixed(2)} < min $${this.config.minPositionSize} (balance=$${balance.toFixed(2)})`;
      console.log(`  ⏭️  SKIP: ${reason}`);
      this.logWindowSkip(tracker, btcPrice, btcDelta, reason, bestAsk, askDepth);
      return;
    }

    const notional = Math.min(budget, balance);
    const shares = notional / bestAsk;

    // Polymarket minimum: 5 shares
    if (shares < 5) {
      const reason = `${shares.toFixed(1)} shares < 5 minimum (need $${(5 * bestAsk).toFixed(2)} at $${bestAsk.toFixed(3)})`;
      console.log(`  ⏭️  SKIP: ${reason}`);
      this.logWindowSkip(tracker, btcPrice, btcDelta, reason, bestAsk, askDepth);
      return;
    }

    // Check orderbook depth
    if (askDepth < shares) {
      console.log(`  ⚠️  Partial fill risk: need ${shares.toFixed(1)} shares, book has ${askDepth.toFixed(1)}`);
    }

    // ── PLACE REAL ORDER ──
    this.isPlacingOrder = true;
    tracker.entered = true;
    this.totalSnipes++;

    const ttl = ((tracker.expiresAt - now) / 1000).toFixed(0);
    const arrow = predictedWinner === 'up' ? '🟢' : '🔴';
    console.log(`\n  ${arrow} SNIPE: BUY ${predictedWinner.toUpperCase()} @$${bestAsk.toFixed(3)} — TTL=${ttl}s`);
    console.log(`     "${tracker.question.slice(0, 60)}"`);
    console.log(`     BTC: $${tracker.windowStartBtcPrice.toFixed(0)} → $${btcPrice.toFixed(0)} (Δ=$${btcDelta >= 0 ? '+' : ''}${btcDelta.toFixed(0)})`);
    console.log(`     Shares=${shares.toFixed(2)} Notional=$${notional.toFixed(2)}`);

    try {
      const trade: Trade = {
        txHash: `sniper-${tracker.conditionId.slice(0, 10)}-${Date.now()}`,
        timestamp: Date.now(),
        market: tracker.question,
        tokenId,
        side: 'BUY',
        price: bestAsk,
        size: notional,
        outcome: 'UNKNOWN',
      };

      const result = await this.executor.executeCopyTrade(trade, notional);

      // Record position
      const pos: LivePosition = {
        conditionId: tracker.conditionId,
        question: tracker.question,
        side: predictedWinner,
        tokenId,
        otherTokenId,
        orderId: result.orderId,
        entryPrice: result.price,
        shares: result.copyShares,
        cost: result.copyNotional,
        entryTime: now,
        expiresAt: tracker.expiresAt,
        btcPriceAtEntry: btcPrice,
        btcDelta,
        negRisk: market.negRisk,
        mergeRescued: false,
        mergeCost: 0,
        status: 'open',
      };

      this.positions.set(tracker.conditionId, pos);

      console.log(`     ✅ ORDER FILLED: ${result.orderId}`);
      console.log(`     Fill: ${result.copyShares.toFixed(2)} shares @$${result.price.toFixed(3)} = $${result.copyNotional.toFixed(2)}`);

      this.appendTrade({
        timestamp: Date.now(), action: 'SNIPE_' + predictedWinner.toUpperCase(),
        conditionId: tracker.conditionId, question: tracker.question,
        side: predictedWinner, entryPrice: result.price, exitPrice: 0,
        shares: result.copyShares, pnl: 0, btcPrice, btcDelta,
        balance, orderId: result.orderId,
        reason: `BTC Δ=$${btcDelta >= 0 ? '+' : ''}${btcDelta.toFixed(0)} | ask=$${bestAsk.toFixed(3)} | TTL=${ttl}s`,
      });

    } catch (err: any) {
      console.log(`     ❌ ORDER FAILED: ${err.message}`);
      tracker.entered = false; // allow retry on next cycle if still in window
      this.totalSnipes--;

      this.appendTrade({
        timestamp: Date.now(), action: 'SNIPE_FAILED',
        conditionId: tracker.conditionId, question: tracker.question,
        side: predictedWinner, entryPrice: bestAsk, exitPrice: 0,
        shares: 0, pnl: 0, btcPrice, btcDelta,
        balance, orderId: '',
        reason: `ORDER FAILED: ${err.message}`,
      });
    } finally {
      this.isPlacingOrder = false;
    }
  }

  // ── Position Evaluation ─────────────────────────────────────────────────

  private async evaluatePositions(btcPrice: number, now: number): Promise<void> {
    for (const [condId, pos] of this.positions) {
      if (pos.status !== 'open') continue;

      const ttl = pos.expiresAt - now;

      // 1. Pre-expiry exit — sell at market to free capital
      if (ttl <= this.config.exitBeforeExpirySec * 1000 && ttl > 2000) {
        await this.preExpiryExit(condId, pos, btcPrice);
        continue;
      }

      // 2. Merge rescue — direction reversed, still time
      if (this.config.mergeRescueEnabled && !pos.mergeRescued && ttl > 3000 && ttl < 12000) {
        const currentDelta = btcPrice - pos.btcPriceAtEntry;
        const wentWrong = (pos.side === 'up' && currentDelta < -5) ||
                          (pos.side === 'down' && currentDelta > 5);
        if (wentWrong) {
          await this.attemptMergeRescue(condId, pos, btcPrice, now);
        }
      }

      // 3. Expired — position held to resolution
      if (ttl <= 0) {
        console.log(`\n  ⏰ EXPIRED: ${pos.side.toUpperCase()} position held to resolution`);
        console.log(`     "${pos.question.slice(0, 50)}"`);
        console.log(`     Waiting for Chainlink oracle to resolve...`);
        // Don't delete — user needs to manually check or wait for resolution
        // Mark as resolved so we stop evaluating
        pos.status = 'resolved';

        // For P&L estimation, check BTC direction
        const tracker = this.windowTrackers.get(condId);
        const windowStart = tracker?.windowStartBtcPrice || pos.btcPriceAtEntry;
        const finalDelta = btcPrice - windowStart;
        const likelyWon = (pos.side === 'up' && finalDelta > 0) || (pos.side === 'down' && finalDelta < 0);
        const estPnl = likelyWon ? (1.0 - pos.entryPrice) * pos.shares : -pos.cost;

        console.log(`     BTC Δ=$${finalDelta >= 0 ? '+' : ''}${finalDelta.toFixed(0)} → likely ${likelyWon ? 'WIN' : 'LOSS'}`);
        console.log(`     Est P&L: $${estPnl >= 0 ? '+' : ''}${estPnl.toFixed(2)}`);

        if (likelyWon) { this.wins++; this.consecutiveLosses = 0; }
        else { this.losses++; this.consecutiveLosses++; this.lastLossTime = now; }
        this.realizedPnL += estPnl;

        this.appendTrade({
          timestamp: Date.now(), action: likelyWon ? 'RESOLVED_WIN_EST' : 'RESOLVED_LOSS_EST',
          conditionId: condId, question: pos.question, side: pos.side,
          entryPrice: pos.entryPrice, exitPrice: likelyWon ? 1.0 : 0.0,
          shares: pos.shares, pnl: estPnl, btcPrice, btcDelta: finalDelta,
          balance: this.cachedBalance + estPnl, orderId: pos.orderId,
          reason: `BTC Δ=$${finalDelta >= 0 ? '+' : ''}${finalDelta.toFixed(0)} | held to resolution`,
        });
      }
    }
  }

  // ── Pre-Expiry Exit ─────────────────────────────────────────────────────

  private async preExpiryExit(condId: string, pos: LivePosition, btcPrice: number): Promise<void> {
    if (this.isPlacingOrder) return;
    pos.status = 'exiting';

    // Fetch fresh bid
    let bestBid: number;
    try {
      const book = await this.executor.getOrderBook(pos.tokenId);
      if (!book?.bids?.length) {
        console.log(`  ⚠️  No bids for exit — holding to resolution`);
        pos.status = 'open';
        return;
      }
      bestBid = parseFloat(book.bids[0].price);
    } catch (err: any) {
      console.log(`  ⚠️  Exit orderbook failed: ${err.message} — holding`);
      pos.status = 'open';
      return;
    }

    if (bestBid < this.config.minExitBidPrice) {
      console.log(`  ⚠️  Bid $${bestBid.toFixed(3)} < min $${this.config.minExitBidPrice} — holding to resolution`);
      pos.status = 'open';
      return;
    }

    // SELL
    this.isPlacingOrder = true;
    const pnl = (bestBid - pos.entryPrice) * pos.shares;
    const ttl = ((pos.expiresAt - Date.now()) / 1000).toFixed(0);

    console.log(`\n  📤 PRE-EXPIRY SELL: ${pos.side.toUpperCase()} @$${bestBid.toFixed(3)} (entry $${pos.entryPrice.toFixed(3)})`);
    console.log(`     P&L: $${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} (${((bestBid / pos.entryPrice - 1) * 100).toFixed(1)}%) | TTL=${ttl}s`);

    try {
      const sellTrade: Trade = {
        txHash: `sniper-exit-${condId.slice(0, 10)}-${Date.now()}`,
        timestamp: Date.now(),
        market: pos.question,
        tokenId: pos.tokenId,
        side: 'SELL',
        price: bestBid,
        size: pos.shares,
        outcome: 'UNKNOWN',
      };

      const result = await this.executor.executeCopyTrade(sellTrade, pos.shares * bestBid);

      console.log(`     ✅ SOLD: ${result.orderId} | ${result.copyShares.toFixed(2)} shares @$${result.price.toFixed(3)}`);

      const actualPnl = (result.price - pos.entryPrice) * result.copyShares;
      this.realizedPnL += actualPnl;
      if (actualPnl > 0) { this.wins++; this.consecutiveLosses = 0; }
      else if (actualPnl < 0) { this.losses++; this.consecutiveLosses++; this.lastLossTime = Date.now(); }

      // Invalidate balance cache
      this.balanceCacheTime = 0;

      this.appendTrade({
        timestamp: Date.now(), action: actualPnl >= 0 ? 'SELL_TP' : 'SELL_SL',
        conditionId: condId, question: pos.question, side: pos.side,
        entryPrice: pos.entryPrice, exitPrice: result.price,
        shares: result.copyShares, pnl: actualPnl, btcPrice,
        btcDelta: btcPrice - pos.btcPriceAtEntry,
        balance: this.cachedBalance + actualPnl, orderId: result.orderId,
        reason: `pre-expiry sell @$${result.price.toFixed(3)} | TTL=${ttl}s`,
      });

      this.positions.delete(condId);

    } catch (err: any) {
      console.log(`     ❌ SELL FAILED: ${err.message} — holding to resolution`);
      pos.status = 'open';
    } finally {
      this.isPlacingOrder = false;
    }
  }

  // ── Merge Rescue ────────────────────────────────────────────────────────

  private async attemptMergeRescue(condId: string, pos: LivePosition, btcPrice: number, now: number): Promise<void> {
    if (this.isPlacingOrder) return;

    // Get other side's ask price
    let otherAsk: number;
    try {
      const book = await this.executor.getOrderBook(pos.otherTokenId);
      if (!book?.asks?.length) return;
      otherAsk = parseFloat(book.asks[0].price);
    } catch { return; }

    const combinedCost = pos.entryPrice + otherAsk;
    if (combinedCost >= this.config.mergeMaxCombinedCost) return;

    // Check if we can afford the hedge
    const hedgeCost = otherAsk * pos.shares;
    const balance = await this.fetchBalance();
    if (hedgeCost > balance) return;

    // Merge rescue is better than selling at loss
    const mergePnlPerShare = 1.0 - combinedCost;
    const sellEstimate = 0.15; // rough sell price if losing badly
    if (mergePnlPerShare < sellEstimate - pos.entryPrice) return; // sell is better

    pos.status = 'merging';
    this.isPlacingOrder = true;

    const otherSide = pos.side === 'up' ? 'DOWN' : 'UP';
    console.log(`\n  🔀 MERGE RESCUE: Buy ${otherSide} @$${otherAsk.toFixed(3)} + merge`);
    console.log(`     Combined: $${combinedCost.toFixed(3)} → merge at $1.00 = $${(mergePnlPerShare * pos.shares).toFixed(2)} ${mergePnlPerShare >= 0 ? 'profit' : 'loss'}`);

    try {
      // 1. Buy other side
      const hedgeTrade: Trade = {
        txHash: `sniper-hedge-${condId.slice(0, 10)}-${Date.now()}`,
        timestamp: Date.now(),
        market: pos.question,
        tokenId: pos.otherTokenId,
        side: 'BUY',
        price: otherAsk,
        size: hedgeCost,
        outcome: 'UNKNOWN',
      };

      const hedgeResult = await this.executor.executeCopyTrade(hedgeTrade, hedgeCost);
      console.log(`     ✅ Hedge filled: ${hedgeResult.copyShares.toFixed(2)} shares @$${hedgeResult.price.toFixed(3)}`);

      // 2. Merge on-chain
      const mergeShares = Math.min(pos.shares, hedgeResult.copyShares);
      console.log(`     🔄 Merging ${mergeShares.toFixed(2)} shares on-chain...`);

      const mergeResult = await this.mergeExecutor.merge({
        conditionId: condId,
        amount: mergeShares,
        negRisk: pos.negRisk,
      });

      const actualCombined = pos.entryPrice + hedgeResult.price;
      const mergePnl = (1.0 - actualCombined) * mergeShares;

      console.log(`     ✅ MERGED: tx=${mergeResult.txHash.slice(0, 14)}...`);
      console.log(`     P&L: $${mergePnl >= 0 ? '+' : ''}${mergePnl.toFixed(2)} (combined $${actualCombined.toFixed(3)})`);

      this.realizedPnL += mergePnl;
      if (mergePnl >= 0) { this.wins++; this.consecutiveLosses = 0; }
      else { this.losses++; this.consecutiveLosses++; this.lastLossTime = now; }

      this.balanceCacheTime = 0;

      this.appendTrade({
        timestamp: Date.now(), action: 'MERGE_RESCUE',
        conditionId: condId, question: pos.question, side: 'both',
        entryPrice: actualCombined, exitPrice: 1.0,
        shares: mergeShares, pnl: mergePnl, btcPrice,
        btcDelta: btcPrice - pos.btcPriceAtEntry,
        balance: this.cachedBalance + mergePnl,
        orderId: `${pos.orderId}+${hedgeResult.orderId}+${mergeResult.txHash.slice(0, 14)}`,
        reason: `merge rescue: entry=$${pos.entryPrice.toFixed(3)} + hedge=$${hedgeResult.price.toFixed(3)} = $${actualCombined.toFixed(3)} → $1.00`,
      });

      this.positions.delete(condId);

    } catch (err: any) {
      console.log(`     ❌ MERGE RESCUE FAILED: ${err.message}`);
      pos.status = 'open'; // fall back to holding/resolution
    } finally {
      this.isPlacingOrder = false;
    }
  }

  // ── Session Stop-Loss ───────────────────────────────────────────────────

  private async checkSessionStopLoss(): Promise<void> {
    if (this.sessionHalted) return;
    const balance = await this.fetchBalance();
    const lossThreshold = this.initialBalance * (this.config.sessionStopLossPct / 100);
    if (this.initialBalance - balance >= lossThreshold && this.initialBalance > 0) {
      this.sessionHalted = true;
      this.haltReason = `Session stop-loss: $${balance.toFixed(2)} (${this.config.sessionStopLossPct}% below $${this.initialBalance.toFixed(2)})`;
      console.log(`\n  🚨 HALTED: ${this.haltReason}\n`);
    }
  }

  // ── Trade Logging ───────────────────────────────────────────────────────

  private appendTrade(trade: TradeLog): void {
    this.trades.push(trade);
    try {
      appendFileSync(this.logPath, JSON.stringify(trade) + '\n');
    } catch {}
  }

  private logWindowSkip(
    tracker: WindowTracker, btcPrice: number, btcDelta: number,
    reason: string, bestAsk?: number, askDepth?: number,
  ): void {
    const now = Date.now();
    const skip: WindowSkipLog = {
      timestamp: now,
      conditionId: tracker.conditionId,
      question: tracker.question,
      btcStart: tracker.windowStartBtcPrice,
      btcEnd: btcPrice,
      btcDelta,
      ttlAtSkip: (tracker.expiresAt - now) / 1000,
      trackingDuration: (now - tracker.windowStartTime) / 1000,
      reason,
      bestAsk,
      askDepth,
    };
    this.skips.push(skip);
    try {
      appendFileSync(this.logPath, JSON.stringify({ ...skip, action: 'WINDOW_SKIP' }) + '\n');
    } catch {}
  }

  // ── Dashboard ───────────────────────────────────────────────────────────

  private printDashboard(): void {
    const now = Date.now();
    const elapsed = ((now - this.startTime) / 60_000).toFixed(1);
    const btc = this.binanceFeed.getPrice();
    const winRate = this.wins + this.losses > 0
      ? ((this.wins / (this.wins + this.losses)) * 100).toFixed(0) : '-';

    let tracking = 0;
    let inWindow = 0;
    for (const [, t] of this.windowTrackers) {
      if (!t.entered && !t.skipped && t.expiresAt > now) {
        tracking++;
        if (t.expiresAt - now <= this.config.entryWindowSeconds * 1000) inWindow++;
      }
    }

    const pnlStr = this.realizedPnL >= 0 ? `+$${this.realizedPnL.toFixed(2)}` : `-$${Math.abs(this.realizedPnL).toFixed(2)}`;
    console.log(`\r  💰 ${elapsed}m | BTC=$${btc.toFixed(0)} | P&L=${pnlStr} | W/L=${this.wins}/${this.losses} (${winRate}%) | Snipes=${this.totalSnipes} | Windows=${this.windowsSeen} | Track=${tracking} Entry=${inWindow} | Pos=${this.positions.size}`);
  }

  // ── Final Report ────────────────────────────────────────────────────────

  private printFinalReport(): void {
    const elapsed = (Date.now() - this.startTime) / 60_000;
    const winRate = this.wins + this.losses > 0 ? this.wins / (this.wins + this.losses) * 100 : 0;

    console.log('\n' + '='.repeat(65));
    console.log('📊 LIVE SNIPER SESSION REPORT');
    console.log('='.repeat(65));
    console.log(`   Duration:          ${elapsed.toFixed(1)} minutes`);
    console.log(`   Initial balance:   $${this.initialBalance.toFixed(2)}`);
    console.log(`   Realized P&L:      $${this.realizedPnL >= 0 ? '+' : ''}${this.realizedPnL.toFixed(2)}`);
    console.log(`   Windows seen:      ${this.windowsSeen}`);
    console.log(`   Windows skipped:   ${this.windowsSkipped}`);
    console.log(`   Snipes taken:      ${this.totalSnipes}`);
    console.log(`   Wins:              ${this.wins}`);
    console.log(`   Losses:            ${this.losses}`);
    console.log(`   Win rate:          ${winRate.toFixed(0)}%`);
    if (this.sessionHalted) console.log(`   Halt reason:       ${this.haltReason}`);
    console.log('='.repeat(65));

    if (this.trades.length > 0) {
      console.log('\n📝 Trade Log:');
      for (const t of this.trades) {
        const time = new Date(t.timestamp).toLocaleTimeString();
        const pnlStr = t.pnl !== 0 ? ` pnl=$${t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(2)}` : '';
        console.log(`   [${time}] ${t.action} ${t.side} @$${t.entryPrice.toFixed(3)}→$${t.exitPrice.toFixed(2)}${pnlStr} | ${t.reason.slice(0, 60)}`);
      }
    }

    if (this.skips.length > 0) {
      console.log(`\n📋 Window Skip Log (${this.skips.length} windows):`);

      // Group by reason category
      const reasonCounts = new Map<string, number>();
      for (const s of this.skips) {
        const key = s.reason.replace(/\$[\d.+-]+/g, '$X').replace(/[\d.]+s/g, 'Xs');
        reasonCounts.set(key, (reasonCounts.get(key) || 0) + 1);
      }
      console.log('   Reason breakdown:');
      for (const [reason, count] of [...reasonCounts.entries()].sort((a, b) => b[1] - a[1])) {
        console.log(`     ${count}× ${reason}`);
      }

      console.log('   Details:');
      for (const s of this.skips) {
        const time = new Date(s.timestamp).toLocaleTimeString();
        const delta = s.btcDelta >= 0 ? `+$${s.btcDelta.toFixed(1)}` : `-$${Math.abs(s.btcDelta).toFixed(1)}`;
        const ask = s.bestAsk ? ` ask=$${s.bestAsk.toFixed(3)}` : '';
        console.log(`   [${time}] BTC $${s.btcStart.toFixed(0)}→$${s.btcEnd.toFixed(0)} (${delta}) tracked=${s.trackingDuration.toFixed(0)}s${ask} | ${s.reason}`);
      }
    }
  }

  // ── Save Session Results ────────────────────────────────────────────────

  private saveSessionResults(): void {
    const dir = join(process.cwd(), 'backtest', 'data');
    const jsonPath = join(dir, `live_session_${this.sessionId}.json`);

    writeFileSync(jsonPath, JSON.stringify({
      strategy: 'LIVE_SNIPER',
      config: this.config,
      wallet: {
        initialBalance: this.initialBalance,
        realizedPnL: this.realizedPnL,
      },
      results: {
        windowsSeen: this.windowsSeen,
        windowsSkipped: this.windowsSkipped,
        totalSnipes: this.totalSnipes,
        wins: this.wins,
        losses: this.losses,
        winRate: this.wins + this.losses > 0 ? this.wins / (this.wins + this.losses) : 0,
        sessionHalted: this.sessionHalted,
        haltReason: this.haltReason,
      },
      trades: this.trades,
      skips: this.skips,
    }, null, 2));

    console.log(`\n📁 Trades: ${this.logPath}`);
    console.log(`📁 Session: ${jsonPath}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const sniperConfig = loadConfig();

  console.log('🔧 Initializing trading infrastructure...\n');

  // 1. TradeExecutor (wallet, API keys, approvals)
  const executor = new TradeExecutor();
  await executor.initialize();

  // 2. MergeExecutor (on-chain merge/redeem)
  const mergeExec = new MergeExecutor({
    privateKey: config.privateKey,
    rpcUrl: config.rpcUrl,
    contracts: {
      ctf: config.contracts.ctf,
      usdc: config.contracts.usdc,
      negRiskAdapter: config.contracts.negRiskAdapter,
    },
  });

  // 3. Data sources
  const binanceFeed = new BinancePriceFeed({ symbol: sniperConfig.symbol });
  const scanner = new MarketScanner(executor.getClobClient(), { cacheTtlMs: sniperConfig.scanIntervalMs });

  // 4. Engine
  const engine = new LiveSniperEngine(executor, mergeExec, binanceFeed, scanner, sniperConfig);

  // Graceful shutdown
  let shutdownRequested = false;
  const handleShutdown = () => {
    if (shutdownRequested) {
      console.log('\nForce exit.');
      process.exit(1);
    }
    shutdownRequested = true;
    console.log('\n\n⚠️  Shutting down gracefully... (press again to force)');
    engine.shutdown();
    process.exit(0);
  };

  process.on('SIGINT', handleShutdown);
  process.on('SIGTERM', handleShutdown);

  await engine.run();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
