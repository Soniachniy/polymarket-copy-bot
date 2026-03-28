#!/usr/bin/env tsx
/**
 * SNIPER PAPER TRADER — Late-Entry Strategy for btc-updown-5m markets.
 *
 * THE EDGE:
 *   - BTC direction in a 5-min window is ~locked by T-15 seconds
 *   - Buy the winning side at $0.60-0.90 → resolves to $1.00
 *   - Fees are lowest at extreme prices (fee ∝ p*(1-p))
 *   - If wrong, MERGE RESCUE: buy other side + redeem $1.00 (lower loss than selling)
 *
 * HOW IT WORKS:
 *   1. Continuously track Binance BTC price from the START of each 5-min window
 *   2. At T-15s before expiry, check: which direction has BTC moved?
 *   3. Buy the winning side if orderbook price is favorable
 *   4. Hold to resolution ($1.00 if correct, $0.00 if wrong)
 *   5. If wrong and still have time, try merge rescue
 *
 * WHY THIS WORKS:
 *   - At T-15s, direction is 70-85% locked (BTC rarely reverses $50+ in 15 seconds)
 *   - Token prices lag by 2-5 seconds, creating brief edge windows
 *   - Fees at $0.80 are ~0.5% vs ~3.15% at $0.50
 *   - Merge rescue caps worst-case loss
 *
 * CONTINUOUS OPERATION:
 *   - Runs indefinitely (or until duration expires / session stop-loss)
 *   - Every 5-min window is an opportunity
 *   - No manual session management needed
 *
 * Usage:
 *   npx tsx src/backtest/sniper-paper.ts [duration_minutes]
 *   npm run sniper -- 60    # Run for 1 hour
 */

import dotenv from 'dotenv';
dotenv.config();

import { ClobClient } from '@polymarket/clob-client';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { BinancePriceFeed } from '../binance-feed.js';
import { MarketScanner, type ScannedMarket } from '../market-scanner.js';

// ── Configuration ──────────────────────────────────────────────────────────

interface SniperConfig {
  startingBalance: number;
  positionSizePct: number;     // % of available balance per trade
  minPositionSize: number;     // minimum $ to enter
  sessionStopLossPct: number;  // halt if balance drops this % from start

  // Entry timing — the core of the strategy
  entryWindowSeconds: number;  // enter this many seconds before expiry (default 15)
  maxEntryPrice: number;       // max price to pay for the winning side (default 0.92)
  minEntryPrice: number;       // min price — too cheap means no edge signal (default 0.55)

  // BTC direction confidence
  minBtcDeltaUsd: number;      // minimum BTC $ move to consider direction "locked" (default 10)
  windowStartTrackingMs: number; // start tracking BTC price this long before window end

  // Merge rescue
  mergeRescueEnabled: boolean;
  mergeMaxCombinedCost: number; // max combined cost to attempt merge rescue (default 0.99)

  // Risk
  maxOpenPositions: number;
  consecutiveLossLimit: number;
  cooldownAfterLossMs: number;

  // Timing
  scanIntervalMs: number;
  cycleIntervalMs: number;

  // Session
  durationMs: number;
  symbol: string;
}

function loadConfig(): SniperConfig {
  const durationMin = parseFloat(process.argv[2] || '60');
  return {
    startingBalance: parseFloat(process.env.SNIPER_STARTING_BALANCE || '5'),
    positionSizePct: parseFloat(process.env.SNIPER_POSITION_SIZE_PCT || '0.80'),
    minPositionSize: parseFloat(process.env.SNIPER_MIN_POSITION_SIZE || '0.50'),
    sessionStopLossPct: parseFloat(process.env.SNIPER_SESSION_STOP_LOSS_PCT || '50'),

    entryWindowSeconds: parseInt(process.env.SNIPER_ENTRY_WINDOW_SEC || '15'),
    maxEntryPrice: parseFloat(process.env.SNIPER_MAX_ENTRY_PRICE || '0.92'),
    minEntryPrice: parseFloat(process.env.SNIPER_MIN_ENTRY_PRICE || '0.55'),

    minBtcDeltaUsd: parseFloat(process.env.SNIPER_MIN_BTC_DELTA_USD || '10'),
    windowStartTrackingMs: parseInt(process.env.SNIPER_WINDOW_TRACKING_MS || '300000'), // 5 min

    mergeRescueEnabled: process.env.SNIPER_MERGE_RESCUE !== 'false',
    mergeMaxCombinedCost: parseFloat(process.env.SNIPER_MERGE_MAX_COST || '0.99'),

    maxOpenPositions: parseInt(process.env.SNIPER_MAX_OPEN || '1'),
    consecutiveLossLimit: parseInt(process.env.SNIPER_CONSEC_LOSS_LIMIT || '3'),
    cooldownAfterLossMs: parseInt(process.env.SNIPER_COOLDOWN_LOSS_MS || '300000'), // 5 min = 1 window

    scanIntervalMs: parseInt(process.env.SNIPER_SCAN_INTERVAL_MS || '10000'),
    cycleIntervalMs: parseInt(process.env.SNIPER_CYCLE_INTERVAL_MS || '1000'), // fast — 1s cycles

    durationMs: durationMin * 60_000,
    symbol: (process.env.SNIPER_SYMBOL || 'btcusdt').toLowerCase(),
  };
}

// ── Types ───────────────────────────────────────────────────────────────────

interface WindowTracker {
  conditionId: string;
  question: string;
  slug: string;
  market: ScannedMarket;
  windowStartBtcPrice: number;  // BTC price when we first saw this market
  windowStartTime: number;
  expiresAt: number;
  entered: boolean;              // already placed trade
  skipped: boolean;              // decided to skip
}

interface SniperPosition {
  conditionId: string;
  question: string;
  slug: string;
  side: 'up' | 'down';
  tokenId: string;
  otherTokenId: string;
  entryPrice: number;
  shares: number;
  cost: number;
  entryTime: number;
  expiresAt: number;
  btcPriceAtEntry: number;
  btcDelta: number;              // BTC move that triggered the entry
  mergeRescued: boolean;
  mergeCost: number;             // additional cost if merge rescue was used
}

type TradeAction = 'SNIPE_UP' | 'SNIPE_DOWN' | 'RESOLVED_WIN' | 'RESOLVED_LOSS' |
  'MERGE_RESCUE' | 'SESSION_END';

interface TradeLog {
  timestamp: number;
  action: TradeAction;
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
  reason: string;
}

// ── Sniper Engine ──────────────────────────────────────────────────────────

class SniperEngine {
  private config: SniperConfig;
  private binanceFeed: BinancePriceFeed;
  private scanner: MarketScanner;

  // Track active 5-min windows
  private windowTrackers = new Map<string, WindowTracker>();
  // Active positions
  private positions = new Map<string, SniperPosition>();

  // Wallet
  private balance: number;
  private lockedInPositions = 0;

  // Stats
  private trades: TradeLog[] = [];
  private realizedPnL = 0;
  private peakBalance: number;
  private maxDrawdown = 0;
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
  private startTime = 0;

  // Timers
  private scanTimer: NodeJS.Timeout | null = null;
  private cycleTimer: NodeJS.Timeout | null = null;
  private dashTimer: NodeJS.Timeout | null = null;

  constructor(config: SniperConfig) {
    this.config = config;
    this.balance = config.startingBalance;
    this.peakBalance = config.startingBalance;
    this.binanceFeed = new BinancePriceFeed({ symbol: config.symbol });
    const clobClient = new ClobClient('https://clob.polymarket.com', 137);
    this.scanner = new MarketScanner(clobClient, { cacheTtlMs: config.scanIntervalMs });
  }

  async run(): Promise<void> {
    const c = this.config;
    console.log('\n🎯 SNIPER PAPER TRADER — Late-Entry Strategy');
    console.log('='.repeat(65));
    console.log(`   Balance:        $${c.startingBalance.toFixed(2)}`);
    console.log(`   Duration:       ${(c.durationMs / 60_000).toFixed(0)} minutes`);
    console.log(`   Entry window:   T-${c.entryWindowSeconds}s before expiry`);
    console.log(`   Entry price:    $${c.minEntryPrice} — $${c.maxEntryPrice}`);
    console.log(`   Min BTC delta:  $${c.minBtcDeltaUsd} (direction confidence)`);
    console.log(`   Position size:  ${(c.positionSizePct * 100).toFixed(0)}% of balance`);
    console.log(`   Merge rescue:   ${c.mergeRescueEnabled ? 'ON' : 'OFF'}`);
    console.log(`   Stop-loss:      ${c.consecutiveLossLimit} consecutive losses → cooldown`);
    console.log(`   Session halt:   ${c.sessionStopLossPct}% drawdown`);
    console.log('='.repeat(65));

    // 1. Connect Binance
    console.log(`\n🔌 Connecting to Binance (${c.symbol})...`);
    await this.binanceFeed.initialize();
    await this.waitForPrice();
    console.log(`✅ Binance: BTC=$${this.binanceFeed.getPrice().toFixed(2)}`);

    // 2. Initial scan
    console.log('\n🔍 Scanning Polymarket...');
    const markets = await this.scanner.scan(true);
    this.logMarkets(markets);

    // 3. Go
    console.log(`\n🚀 Sniper active — waiting for entry windows...`);
    console.log(`   Each 5-min BTC window is an opportunity.`);
    console.log(`   Will enter at T-${c.entryWindowSeconds}s when BTC direction is ~locked.\n`);

    this.startTime = Date.now();
    this.scanTimer = setInterval(() => this.runScan(), c.scanIntervalMs);
    this.cycleTimer = setInterval(() => this.runCycle(), c.cycleIntervalMs);
    this.dashTimer = setInterval(() => this.printDashboard(), 5000);

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
    this.resolveAllPositions();
    this.printFinalReport();
    this.saveResults();
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

  private stop(): void {
    if (this.scanTimer) clearInterval(this.scanTimer);
    if (this.cycleTimer) clearInterval(this.cycleTimer);
    if (this.dashTimer) clearInterval(this.dashTimer);
    this.binanceFeed.close();
  }

  private getAvailableBalance(): number {
    return Math.max(0, this.balance - this.lockedInPositions);
  }

  // ── Market Scan ─────────────────────────────────────────────────────────

  private async runScan(): Promise<void> {
    try {
      const markets = await this.scanner.scan(true);

      // Register new windows we haven't seen
      for (const m of markets) {
        if (m.marketType !== 'updown') continue;
        if (this.windowTrackers.has(m.conditionId)) {
          // Update market data in existing tracker
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
        console.log(`     Up=$${m.yesOutcomePrice.toFixed(3)} Down=$${m.noOutcomePrice.toFixed(3)} Combined=$${(m.yesOutcomePrice + m.noOutcomePrice).toFixed(3)}`);
      }

      // Clean expired trackers
      const now = Date.now();
      for (const [id, tracker] of this.windowTrackers) {
        if (tracker.expiresAt < now - 60_000 && !this.positions.has(id)) {
          this.windowTrackers.delete(id);
        }
      }
    } catch {}
  }

  // ── Decision Cycle (runs every 1s) ──────────────────────────────────────

  private runCycle(): void {
    if (this.sessionHalted) return;

    const now = Date.now();
    const btcPrice = this.binanceFeed.getPrice();
    if (btcPrice <= 0) return;

    // Check each window for snipe opportunity
    for (const [condId, tracker] of this.windowTrackers) {
      if (tracker.entered || tracker.skipped) continue;
      if (this.positions.has(condId)) continue;

      const ttl = tracker.expiresAt - now;

      // Too early — not in entry window yet
      if (ttl > this.config.entryWindowSeconds * 1000) continue;

      // Too late — expired
      if (ttl <= 2000) {
        tracker.skipped = true;
        this.windowsSkipped++;
        continue;
      }

      // We're in the entry window! Evaluate the snipe.
      this.evaluateSnipe(tracker, btcPrice, now);
    }

    // Evaluate positions for merge rescue
    this.evaluatePositions(btcPrice, now);

    // Session stop-loss check
    this.checkSessionStopLoss();
  }

  // ── Snipe Evaluation ────────────────────────────────────────────────────

  private evaluateSnipe(tracker: WindowTracker, btcPrice: number, now: number): void {
    if (this.positions.size >= this.config.maxOpenPositions) return;

    // Cooldown after consecutive losses
    if (this.consecutiveLosses >= this.config.consecutiveLossLimit) {
      if (now - this.lastLossTime < this.config.cooldownAfterLossMs) return;
      // Reset after cooldown
      this.consecutiveLosses = 0;
    }

    // BTC direction since window start
    const btcDelta = btcPrice - tracker.windowStartBtcPrice;
    const absDelta = Math.abs(btcDelta);

    // Not enough movement — direction not clear
    if (absDelta < this.config.minBtcDeltaUsd) {
      const ttl = ((tracker.expiresAt - now) / 1000).toFixed(0);
      // If very close to expiry and no clear direction, skip
      if (tracker.expiresAt - now < 5000) {
        tracker.skipped = true;
        this.windowsSkipped++;
        console.log(`  ⏭️  SKIP: BTC delta $${btcDelta.toFixed(0)} < $${this.config.minBtcDeltaUsd} min | TTL=${ttl}s`);
      }
      return;
    }

    // Direction determined
    const predictedWinner: 'up' | 'down' = btcDelta > 0 ? 'up' : 'down';

    // Get latest market data
    const market = tracker.market;
    const entryPrice = predictedWinner === 'up' ? market.yesOutcomePrice : market.noOutcomePrice;
    const tokenId = predictedWinner === 'up' ? market.yesTokenId : market.noTokenId;
    const otherTokenId = predictedWinner === 'up' ? market.noTokenId : market.yesTokenId;

    // Price checks
    if (entryPrice > this.config.maxEntryPrice) {
      // Too expensive — edge too thin
      tracker.skipped = true;
      this.windowsSkipped++;
      console.log(`  ⏭️  SKIP: ${predictedWinner.toUpperCase()} price $${entryPrice.toFixed(3)} > max $${this.config.maxEntryPrice}`);
      return;
    }
    if (entryPrice < this.config.minEntryPrice) {
      // Too cheap — market hasn't moved, no confirmation
      return; // Don't skip yet — price might update
    }

    // Position sizing
    const budget = this.getAvailableBalance() * this.config.positionSizePct;
    if (budget < this.config.minPositionSize) return;

    const shares = budget / entryPrice;
    const cost = shares * entryPrice;

    if (cost > this.getAvailableBalance()) return;

    // ENTER!
    tracker.entered = true;
    this.totalSnipes++;

    const position: SniperPosition = {
      conditionId: tracker.conditionId,
      question: tracker.question,
      slug: tracker.slug,
      side: predictedWinner,
      tokenId,
      otherTokenId,
      entryPrice,
      shares,
      cost,
      entryTime: now,
      expiresAt: tracker.expiresAt,
      btcPriceAtEntry: btcPrice,
      btcDelta,
      mergeRescued: false,
      mergeCost: 0,
    };

    this.positions.set(tracker.conditionId, position);
    this.lockedInPositions += cost;

    const ttl = ((tracker.expiresAt - now) / 1000).toFixed(0);
    const arrow = predictedWinner === 'up' ? '🟢' : '🔴';
    const action: TradeAction = predictedWinner === 'up' ? 'SNIPE_UP' : 'SNIPE_DOWN';

    this.logTrade(action, tracker.conditionId, tracker.question, predictedWinner,
      entryPrice, 0, shares, 0, btcPrice, btcDelta,
      `BTC Δ=$${btcDelta >= 0 ? '+' : ''}${btcDelta.toFixed(0)} | ${predictedWinner.toUpperCase()} @$${entryPrice.toFixed(3)} | TTL=${ttl}s`);

    console.log(`\n  ${arrow} SNIPE: BUY ${predictedWinner.toUpperCase()} @$${entryPrice.toFixed(3)} — TTL=${ttl}s`);
    console.log(`     "${tracker.question.slice(0, 60)}"`);
    console.log(`     BTC: $${tracker.windowStartBtcPrice.toFixed(0)} → $${btcPrice.toFixed(0)} (Δ=$${btcDelta >= 0 ? '+' : ''}${btcDelta.toFixed(0)})`);
    console.log(`     Shares=${shares.toFixed(2)} Cost=$${cost.toFixed(2)}`);
    console.log(`     Potential: win=$${(shares * (1.0 - entryPrice)).toFixed(2)} (${((1.0/entryPrice - 1) * 100).toFixed(1)}%) | loss=-$${cost.toFixed(2)}`);
    console.log(`     Balance: $${this.balance.toFixed(2)} (avail: $${this.getAvailableBalance().toFixed(2)})`);
  }

  // ── Position Management ─────────────────────────────────────────────────

  private evaluatePositions(btcPrice: number, now: number): void {
    for (const [condId, pos] of this.positions) {
      const ttl = pos.expiresAt - now;

      // Expired — resolve based on BTC direction
      if (ttl <= 0) {
        this.resolvePosition(condId, pos, btcPrice);
        continue;
      }

      // Still alive — check if we should merge rescue
      if (this.config.mergeRescueEnabled && !pos.mergeRescued && ttl > 3000 && ttl < 10000) {
        // We're in the danger zone — check if BTC reversed against us
        const currentDelta = btcPrice - pos.btcPriceAtEntry;
        const wentWrong = (pos.side === 'up' && currentDelta < 0) || (pos.side === 'down' && currentDelta > 0);

        if (wentWrong) {
          this.attemptMergeRescue(condId, pos, btcPrice, now);
        }
      }
    }
  }

  private resolvePosition(condId: string, pos: SniperPosition, btcPrice: number): void {
    // Determine outcome based on final BTC price vs window start
    const tracker = this.windowTrackers.get(condId);
    const windowStartPrice = tracker?.windowStartBtcPrice || pos.btcPriceAtEntry;
    const btcDelta = btcPrice - windowStartPrice;

    const won = (pos.side === 'up' && btcDelta > 0) || (pos.side === 'down' && btcDelta < 0);

    if (pos.mergeRescued) {
      // Merge position — redeem both sides for $1.00/share
      const totalCost = pos.cost + pos.mergeCost;
      const revenue = pos.shares * 1.0;
      const pnl = revenue - totalCost;

      this.realizePnL(pos, pnl, totalCost);
      this.logTrade('MERGE_RESCUE', condId, pos.question, 'both',
        pos.entryPrice, 1.0, pos.shares, pnl, btcPrice, btcDelta,
        `MERGE REDEEM: cost=$${totalCost.toFixed(2)} rev=$${revenue.toFixed(2)} pnl=$${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}`);

      const emoji = pnl >= 0 ? '🔀✅' : '🔀⚠️';
      console.log(`\n  ${emoji} MERGE RESOLVE: $${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} (rescued from directional loss)`);
    } else {
      const exitPrice = won ? 1.0 : 0.0;
      const pnl = (exitPrice - pos.entryPrice) * pos.shares;

      this.realizePnL(pos, pnl, pos.cost);
      const action: TradeAction = won ? 'RESOLVED_WIN' : 'RESOLVED_LOSS';
      this.logTrade(action, condId, pos.question, pos.side,
        pos.entryPrice, exitPrice, pos.shares, pnl, btcPrice, btcDelta,
        `${won ? 'WIN' : 'LOSS'}: BTC Δ=$${btcDelta >= 0 ? '+' : ''}${btcDelta.toFixed(0)} | ${pos.side} @$${pos.entryPrice.toFixed(3)}→$${exitPrice}`);

      const emoji = won ? '✅' : '❌';
      console.log(`\n  ${emoji} RESOLVED ${won ? 'WIN' : 'LOSS'}: $${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}`);
      console.log(`     BTC: $${windowStartPrice.toFixed(0)} → $${btcPrice.toFixed(0)} (Δ=$${btcDelta >= 0 ? '+' : ''}${btcDelta.toFixed(0)})`);
      console.log(`     ${pos.side.toUpperCase()} @$${pos.entryPrice.toFixed(3)} → $${exitPrice.toFixed(2)} × ${pos.shares.toFixed(2)} shares`);
    }

    this.positions.delete(condId);
    console.log(`     Balance: $${this.balance.toFixed(2)}`);
  }

  private attemptMergeRescue(condId: string, pos: SniperPosition, btcPrice: number, now: number): void {
    // Get current market data for the OTHER side
    const market = this.windowTrackers.get(condId)?.market;
    if (!market) return;

    const otherSidePrice = pos.side === 'up' ? market.noOutcomePrice : market.yesOutcomePrice;
    if (otherSidePrice <= 0) return;

    const combinedCost = pos.entryPrice + otherSidePrice;

    // Only merge if combined < threshold (otherwise just let it resolve)
    if (combinedCost > this.config.mergeMaxCombinedCost) return;

    const hedgeCost = otherSidePrice * pos.shares;
    if (hedgeCost > this.getAvailableBalance()) return;

    // Compare: merge rescue vs letting it ride
    // Merge: guaranteed $1.00/share - combinedCost = profit per share
    // Ride: 50/50 at this point (direction reversed), expected = 0.5
    const mergePnlPerShare = 1.0 - combinedCost;
    const rideExpectedPnl = (0.5 - pos.entryPrice); // rough EV if direction unclear

    // Merge rescue if it gives better expected outcome
    if (mergePnlPerShare > rideExpectedPnl) {
      pos.mergeRescued = true;
      pos.mergeCost = hedgeCost;
      this.lockedInPositions += hedgeCost;

      const ttl = ((pos.expiresAt - now) / 1000).toFixed(0);
      console.log(`\n  🔀 MERGE RESCUE: Buying ${pos.side === 'up' ? 'Down' : 'Up'} @$${otherSidePrice.toFixed(3)}`);
      console.log(`     Combined=$${combinedCost.toFixed(3)} → merge profit=$${(mergePnlPerShare * pos.shares).toFixed(2)} (${(mergePnlPerShare * 100).toFixed(1)}%)`);
      console.log(`     TTL=${ttl}s | vs riding EV=$${(rideExpectedPnl * pos.shares).toFixed(2)}`);
    }
  }

  // ── P&L ─────────────────────────────────────────────────────────────────

  private realizePnL(pos: SniperPosition, pnl: number, totalCost: number): void {
    this.balance += pnl;
    this.lockedInPositions = Math.max(0, this.lockedInPositions - totalCost);
    this.realizedPnL += pnl;

    if (pnl > 0) {
      this.wins++;
      this.consecutiveLosses = 0;
    } else if (pnl < 0) {
      this.losses++;
      this.consecutiveLosses++;
      this.lastLossTime = Date.now();
    }

    if (this.balance > this.peakBalance) this.peakBalance = this.balance;
    const drawdown = this.peakBalance - this.balance;
    if (drawdown > this.maxDrawdown) this.maxDrawdown = drawdown;
  }

  private checkSessionStopLoss(): void {
    if (this.sessionHalted) return;
    const lossThreshold = this.config.startingBalance * (this.config.sessionStopLossPct / 100);
    if (this.config.startingBalance - this.balance >= lossThreshold) {
      this.sessionHalted = true;
      this.haltReason = `Session stop-loss: $${this.balance.toFixed(2)} (${this.config.sessionStopLossPct}% drawdown)`;
      console.log(`\n  🚨 HALTED: ${this.haltReason}\n`);
    }
  }

  // ── Resolve all on shutdown ─────────────────────────────────────────────

  private resolveAllPositions(): void {
    const btcPrice = this.binanceFeed.getPrice();
    for (const [condId, pos] of this.positions) {
      this.resolvePosition(condId, pos, btcPrice);
    }
  }

  // ── Logging ─────────────────────────────────────────────────────────────

  private logTrade(action: TradeAction, condId: string, question: string,
    side: string, entry: number, exit: number, shares: number, pnl: number,
    btcPrice: number, btcDelta: number, reason: string): void {
    this.trades.push({
      timestamp: Date.now(), action, conditionId: condId, question, side,
      entryPrice: entry, exitPrice: exit, shares, pnl, btcPrice, btcDelta,
      balance: this.balance, reason,
    });
  }

  private logMarkets(markets: ScannedMarket[]): void {
    if (markets.length === 0) {
      console.log('   No BTC updown markets found. Will keep scanning...');
      return;
    }
    for (const m of markets) {
      if (m.marketType !== 'updown') continue;
      const ttl = ((m.expiresAt - Date.now()) / 1000).toFixed(0);
      console.log(`   • "${m.question.slice(0, 60)}" TTL=${ttl}s`);
      console.log(`     Up=$${m.yesOutcomePrice.toFixed(3)} Down=$${m.noOutcomePrice.toFixed(3)}`);
    }
  }

  // ── Dashboard ───────────────────────────────────────────────────────────

  private printDashboard(): void {
    const now = Date.now();
    const elapsed = ((now - this.startTime) / 60_000).toFixed(1);
    const remaining = Math.max(0, (this.config.durationMs - (now - this.startTime)) / 60_000).toFixed(1);
    const btc = this.binanceFeed.getPrice();
    const returnPct = ((this.balance - this.config.startingBalance) / this.config.startingBalance * 100).toFixed(2);
    const winRate = this.wins + this.losses > 0
      ? ((this.wins / (this.wins + this.losses)) * 100).toFixed(0) : '-';

    // Count active windows being tracked
    let tracking = 0;
    let inWindow = 0;
    for (const [, t] of this.windowTrackers) {
      if (!t.entered && !t.skipped && t.expiresAt > now) {
        tracking++;
        if (t.expiresAt - now <= this.config.entryWindowSeconds * 1000) inWindow++;
      }
    }

    console.log(`\r  ⏱ ${elapsed}m/${remaining}m | BTC=$${btc.toFixed(0)} | $${this.balance.toFixed(2)} (${returnPct}%) | W/L=${this.wins}/${this.losses} (${winRate}%) | Snipes=${this.totalSnipes} | Windows=${this.windowsSeen} | Tracking=${tracking} InEntry=${inWindow} | Pos=${this.positions.size}`);
  }

  // ── Final Report ────────────────────────────────────────────────────────

  private printFinalReport(): void {
    const elapsed = (Date.now() - this.startTime) / 60_000;
    const returnPct = (this.balance - this.config.startingBalance) / this.config.startingBalance * 100;
    const winRate = this.wins + this.losses > 0 ? this.wins / (this.wins + this.losses) * 100 : 0;

    console.log('\n' + '='.repeat(65));
    console.log('📊 SNIPER SESSION REPORT');
    console.log('='.repeat(65));
    console.log(`   Duration:          ${elapsed.toFixed(1)} minutes`);
    console.log(`   Final balance:     $${this.balance.toFixed(2)} (was $${this.config.startingBalance.toFixed(2)})`);
    console.log(`   Return:            ${returnPct >= 0 ? '+' : ''}${returnPct.toFixed(2)}%`);
    console.log(`   Realized P&L:      $${this.realizedPnL >= 0 ? '+' : ''}${this.realizedPnL.toFixed(2)}`);
    console.log(`   Peak balance:      $${this.peakBalance.toFixed(2)}`);
    console.log(`   Max drawdown:      $${this.maxDrawdown.toFixed(2)}`);
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
        console.log(`   [${time}] ${t.action} ${t.side} @$${t.entryPrice.toFixed(3)}→$${t.exitPrice.toFixed(2)}${pnlStr} | ${t.reason}`);
      }
    }
  }

  // ── Save Results ────────────────────────────────────────────────────────

  private saveResults(): void {
    const dir = join(process.cwd(), 'backtest', 'data');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const ts = new Date().toISOString().replace(/[:.]/g, '-');

    // CSV
    const csvPath = join(dir, `sniper_${ts}.csv`);
    const headers = 'timestamp,action,conditionId,question,side,entryPrice,exitPrice,shares,pnl,balance,btcPrice,btcDelta,reason';
    const rows = this.trades.map(t =>
      `${t.timestamp},${t.action},${t.conditionId},"${t.question}",${t.side},${t.entryPrice.toFixed(6)},${t.exitPrice.toFixed(6)},${t.shares.toFixed(4)},${t.pnl.toFixed(4)},${t.balance.toFixed(4)},${t.btcPrice.toFixed(2)},${t.btcDelta.toFixed(2)},"${t.reason}"`
    );
    writeFileSync(csvPath, [headers, ...rows].join('\n'));

    // JSON
    const jsonPath = join(dir, `sniper_session_${ts}.json`);
    const returnPct = (this.balance - this.config.startingBalance) / this.config.startingBalance * 100;
    writeFileSync(jsonPath, JSON.stringify({
      strategy: 'SNIPER_LATE_ENTRY',
      config: this.config,
      wallet: {
        startingBalance: this.config.startingBalance,
        finalBalance: this.balance,
        returnPct,
        peakBalance: this.peakBalance,
        maxDrawdown: this.maxDrawdown,
      },
      results: {
        totalPnL: this.realizedPnL,
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
    }, null, 2));

    console.log(`\n📁 Trades: ${csvPath}`);
    console.log(`📁 Session: ${jsonPath}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────

const config = loadConfig();
const engine = new SniperEngine(config);

process.on('SIGINT', () => {
  console.log('\n\n⚠️  Interrupted — closing...');
  process.exit(0);
});

engine.run().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
