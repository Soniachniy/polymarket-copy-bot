#!/usr/bin/env tsx
/**
 * Paper Trading — Live simulation using REAL Polymarket market data.
 *
 * Two modes:
 *   1. DIRECTIONAL — Binance trend picks Up or Down, bet on one side
 *   2. MERGE — Buy BOTH Up and Down when combined cost < $1.00, profit at merge
 *
 * Merge mode is preferred when balance >= $10 (need $5 per side min order).
 * Falls back to directional when balance is too low for both sides.
 *
 * Data sources:
 *   - Binance WebSocket: BTC price, volatility gate, trend signal, reversal detection
 *   - Gamma API: market discovery, outcomePrices (implied probability)
 *
 * NO real trades are placed. Virtual wallet tracks paper P&L.
 *
 * Usage:
 *   npx tsx src/backtest/paper-trade.ts [duration_minutes]
 *   npm run paper-trade              # default 30 min
 *   npm run paper-trade -- 60        # 1 hour
 */

import dotenv from 'dotenv';
dotenv.config();

import { ClobClient } from '@polymarket/clob-client';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { BinancePriceFeed } from '../binance-feed.js';
import { MarketScanner, type ScannedMarket } from '../market-scanner.js';

// ── Configuration ──────────────────────────────────────────────────────────

interface PaperConfig {
  // Wallet
  startingBalance: number;
  positionSizePct: number;
  minPositionSize: number;
  sessionStopLossPct: number;
  maxOpenPositions: number;

  // Strategy
  maxEntryPrice: number;       // Max price to pay for one side (default 0.55)
  takeProfitPct: number;
  stopLossPct: number;
  trendWindowMs: number;       // Binance trend lookback window
  minTrendStrength: number;    // Minimum $/sec trend to trigger entry

  // Market filters
  minTtlMs: number;
  maxTtlMs: number;
  panicExitSeconds: number;

  // Volatility gate
  minVolatility: number;
  volatilityWarmupMs: number;

  // Reversal exit
  reversalExitUsd: number;       // BTC $ move against position → exit

  // Cooldowns
  cooldownAfterStopLossMs: number;
  cooldownAfterLossMs: number;

  // Timing
  scanIntervalMs: number;
  cycleIntervalMs: number;
  dashboardIntervalMs: number;

  // Binance
  symbol: string;

  // Merge mode
  mergeMode: boolean;            // true = buy both sides when cheap
  mergeMaxCombinedCost: number;  // max combined Up+Down price (e.g. 0.97)
  mergePositionSizePct: number;  // % of balance per side in merge mode

  // Session
  durationMs: number;
}

function loadConfig(): PaperConfig {
  const durationMin = parseFloat(process.argv[2] || '30');

  return {
    startingBalance: parseFloat(process.env.VOL_PAPER_STARTING_BALANCE || '5'),
    positionSizePct: parseFloat(process.env.VOL_PAPER_POSITION_SIZE_PCT || '0.40'),
    minPositionSize: parseFloat(process.env.VOL_PAPER_MIN_POSITION_SIZE || '0.50'),
    sessionStopLossPct: parseFloat(process.env.VOL_PAPER_SESSION_STOP_LOSS_PCT || '50'),
    maxOpenPositions: parseInt(process.env.VOL_MAX_OPEN_POSITIONS || '1'),

    maxEntryPrice: parseFloat(process.env.VOL_MAX_ENTRY_PRICE || '0.55'),
    takeProfitPct: parseFloat(process.env.VOL_TAKE_PROFIT_PCT || '15'),
    stopLossPct: parseFloat(process.env.VOL_STOP_LOSS_PCT || '20'),
    trendWindowMs: parseInt(process.env.VOL_TREND_WINDOW_MS || '30000'),
    minTrendStrength: parseFloat(process.env.VOL_MIN_TREND_STRENGTH || '0.5'),

    minTtlMs: parseInt(process.env.VOL_MIN_TTL_MS || '120000'),
    maxTtlMs: parseInt(process.env.VOL_MAX_TTL_MS || '600000'),
    panicExitSeconds: parseInt(process.env.VOL_PANIC_EXIT_SECONDS || '30'),

    minVolatility: parseFloat(process.env.VOL_MIN_VOLATILITY || '0.00005'),
    volatilityWarmupMs: parseInt(process.env.VOL_PAPER_WARMUP_MS || '15000'),

    reversalExitUsd: parseFloat(process.env.VOL_REVERSAL_EXIT_USD || '80'),

    cooldownAfterStopLossMs: parseInt(process.env.VOL_PAPER_COOLDOWN_STOP_LOSS_MS || '30000'),
    cooldownAfterLossMs: parseInt(process.env.VOL_PAPER_COOLDOWN_LOSS_MS || '10000'),

    scanIntervalMs: parseInt(process.env.VOL_SCAN_INTERVAL_MS || '30000'),
    cycleIntervalMs: parseInt(process.env.VOL_CYCLE_INTERVAL_MS || '5000'),
    dashboardIntervalMs: 2000,

    symbol: (process.env.VOL_BINANCE_SYMBOL || 'btcusdt').toLowerCase(),

    mergeMode: process.env.VOL_MERGE_MODE === 'true',
    mergeMaxCombinedCost: parseFloat(process.env.VOL_MERGE_MAX_COMBINED_COST || '0.97'),
    mergePositionSizePct: parseFloat(process.env.VOL_MERGE_POSITION_SIZE_PCT || '0.40'),

    durationMs: durationMin * 60_000,
  };
}

// ── Position Types ────────────────────────────────────────────────────────

interface DirectionalPosition {
  mode: 'directional';
  conditionId: string;
  question: string;
  slug: string;
  side: 'up' | 'down';
  tokenId: string;
  entryPrice: number;
  shares: number;
  cost: number;
  entryTime: number;
  expiresAt: number;
  btcPriceAtEntry: number;
  negRisk: boolean;
}

interface MergePosition {
  mode: 'merge';
  conditionId: string;
  question: string;
  slug: string;
  upTokenId: string;
  downTokenId: string;
  upEntryPrice: number;
  downEntryPrice: number;
  combinedCost: number;         // upEntryPrice + downEntryPrice (per share)
  shares: number;               // Equal shares on both sides
  totalCost: number;            // combinedCost * shares
  entryTime: number;
  expiresAt: number;
  btcPriceAtEntry: number;
  negRisk: boolean;
}

type Position = DirectionalPosition | MergePosition;

// ── Trade Log ──────────────────────────────────────────────────────────────

type TradeAction = 'BUY_UP' | 'BUY_DOWN' | 'BUY_MERGE' | 'SELL_TP' | 'SELL_SL' |
  'SELL_REVERSAL' | 'RESOLVED_WIN' | 'RESOLVED_LOSS' | 'MERGE_REDEEM' |
  'PANIC_SELL' | 'SESSION_END';

interface TradeLog {
  timestamp: number;
  action: TradeAction;
  conditionId: string;
  question: string;
  side: 'up' | 'down' | 'both';
  entryPrice: number;
  exitPrice: number;
  shares: number;
  pnl: number;
  btcPrice: number;
  balance: number;
  reason: string;
}

// ── Paper Trading Engine ───────────────────────────────────────────────────

class PaperTradingEngine {
  private config: PaperConfig;

  // Real data sources
  private binanceFeed: BinancePriceFeed;
  private scanner: MarketScanner;

  // Positions
  private positions = new Map<string, Position>();

  // Wallet
  private balance: number;
  private lockedInPositions = 0;

  // Trade log
  private trades: TradeLog[] = [];

  // Stats
  private realizedPnL = 0;
  private unrealizedPnL = 0;
  private peakBalance: number;
  private maxDrawdown = 0;
  private totalEntries = 0;
  private wins = 0;
  private losses = 0;
  private consecutiveLosses = 0;
  private marketsScanned = 0;
  private marketsEligible = 0;

  // Session guards
  private sessionHalted = false;
  private haltReason = '';
  private lastStopLossTime = 0;
  private lastLossTime = 0;
  private processingCycle = false;

  // Timing
  private startTime = 0;
  private scanTimer: NodeJS.Timeout | null = null;
  private cycleTimer: NodeJS.Timeout | null = null;
  private dashboardTimer: NodeJS.Timeout | null = null;

  constructor(config: PaperConfig) {
    this.config = config;
    this.balance = config.startingBalance;
    this.peakBalance = config.startingBalance;

    this.binanceFeed = new BinancePriceFeed({ symbol: config.symbol });

    const clobClient = new ClobClient('https://clob.polymarket.com', 137);
    this.scanner = new MarketScanner(clobClient, { cacheTtlMs: config.scanIntervalMs });
  }

  async run(): Promise<void> {
    const c = this.config;
    const modeStr = c.mergeMode ? 'MERGE + DIRECTIONAL' : 'DIRECTIONAL';
    console.log(`\n📄 PAPER TRADING — ${modeStr} STRATEGY (REAL POLYMARKET DATA)`);
    console.log('='.repeat(65));
    console.log(`   Symbol:            ${c.symbol.toUpperCase()}`);
    console.log(`   Duration:          ${(c.durationMs / 60_000).toFixed(0)} minutes`);
    console.log(`   Starting balance:  $${c.startingBalance.toFixed(2)}`);
    console.log(`   Position sizing:   ${(c.positionSizePct * 100).toFixed(0)}% of balance (min $${c.minPositionSize})`);
    console.log(`   Session stop-loss: ${c.sessionStopLossPct}% of starting balance`);
    console.log(`   Max entry price:   $${c.maxEntryPrice} per side`);
    console.log(`   Take profit:       ${c.takeProfitPct}%`);
    console.log(`   Stop loss:         ${c.stopLossPct}%`);
    console.log(`   Trend window:      ${(c.trendWindowMs / 1000).toFixed(0)}s`);
    console.log(`   Min trend:         $${c.minTrendStrength}/sec`);
    console.log(`   Min volatility:    ${(c.minVolatility * 100).toFixed(4)}%`);
    console.log(`   Warmup:            ${(c.volatilityWarmupMs / 1000).toFixed(0)}s`);
    console.log(`   SL cooldown:       ${(c.cooldownAfterStopLossMs / 1000).toFixed(0)}s`);
    console.log(`   Scan interval:     ${(c.scanIntervalMs / 1000).toFixed(0)}s`);
    console.log(`   Cycle interval:    ${(c.cycleIntervalMs / 1000).toFixed(0)}s`);
    console.log(`   Reversal exit:     $${c.reversalExitUsd} BTC move`);
    console.log(`   Max open:          ${c.maxOpenPositions}`);
    console.log(`   Merge mode:        ${c.mergeMode ? `ON (max combined $${c.mergeMaxCombinedCost})` : 'OFF'}`);
    console.log(`   Strategy:          ${c.mergeMode ? 'MERGE + DIRECTIONAL fallback' : 'DIRECTIONAL (Binance trend → buy predicted side)'}`);
    console.log(`   Pricing:           Gamma outcomePrices (real implied probability)`);
    console.log('='.repeat(65));

    // 1. Connect to Binance
    console.log(`\n🔌 Connecting to Binance (${c.symbol})...`);
    await this.binanceFeed.initialize();

    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (this.binanceFeed.getPrice() > 0) {
          clearInterval(check);
          resolve();
        }
      }, 100);
    });
    console.log(`✅ Binance connected — BTC: $${this.binanceFeed.getPrice().toFixed(2)}`);

    // 2. Warmup (build volatility + trend history)
    if (c.volatilityWarmupMs > 0) {
      console.log(`⏳ Warming up for ${(c.volatilityWarmupMs / 1000).toFixed(0)}s (building price history)...`);
      await new Promise<void>((resolve) => setTimeout(resolve, c.volatilityWarmupMs));
      const vol = this.binanceFeed.getVolatility(60_000);
      const trend = this.binanceFeed.getTrend(c.trendWindowMs);
      console.log(`   Done — vol=${(vol * 100).toFixed(4)}% trend=${trend >= 0 ? '+' : ''}${trend.toFixed(2)} $/sec`);
    }

    // 3. Initial market scan
    console.log('\n🔍 Scanning Polymarket for real BTC markets...');
    try {
      const markets = await this.scanner.scan(true);
      this.marketsScanned = markets.length;
      if (markets.length === 0) {
        console.log('   ⚠️  No BTC markets found. Will keep scanning...');
      } else {
        console.log(`   ✅ Found ${markets.length} market(s):`);
        for (const m of markets) {
          const ttl = m.expiresAt > 0 ? ((m.expiresAt - Date.now()) / 1000).toFixed(0) + 's' : 'unknown';
          console.log(`      • "${m.question.slice(0, 60)}..."`);
          console.log(`        Up=$${m.yesOutcomePrice.toFixed(4)} Down=$${m.noOutcomePrice.toFixed(4)} TTL=${ttl} type=${m.marketType}`);
        }
      }
    } catch (err: any) {
      console.log(`   ⚠️  Initial scan failed: ${err.message}. Will retry...`);
    }

    // 4. Start trading
    console.log(`\n🚀 Paper trading started at ${new Date().toLocaleTimeString()}`);
    console.log(`   Balance: $${this.balance.toFixed(2)} | Will run until ${new Date(Date.now() + c.durationMs).toLocaleTimeString()}\n`);

    this.startTime = Date.now();

    this.scanTimer = setInterval(() => this.runScan(), c.scanIntervalMs);
    this.cycleTimer = setInterval(() => this.runDecisionCycle(), c.cycleIntervalMs);
    this.dashboardTimer = setInterval(() => this.printDashboard(), c.dashboardIntervalMs);

    // Wait for duration or early halt
    await new Promise<void>((resolve) => {
      const sessionEnd = setTimeout(() => resolve(), c.durationMs);
      const haltCheck = setInterval(() => {
        if (this.sessionHalted) {
          clearTimeout(sessionEnd);
          clearInterval(haltCheck);
          resolve();
        }
      }, 1000);
      setTimeout(() => clearInterval(haltCheck), c.durationMs + 1000);
    });

    this.stop();
    this.forceCloseAll();
    this.printFinalReport();
    this.saveResults();
  }

  private stop(): void {
    if (this.scanTimer) clearInterval(this.scanTimer);
    if (this.cycleTimer) clearInterval(this.cycleTimer);
    if (this.dashboardTimer) clearInterval(this.dashboardTimer);
    this.binanceFeed.close();
  }

  // ── Wallet helpers ────────────────────────────────────────────────────

  private getAvailableBalance(): number {
    return this.balance - this.lockedInPositions;
  }

  private checkSessionStopLoss(): void {
    if (this.sessionHalted) return;
    const lossThreshold = this.config.startingBalance * (this.config.sessionStopLossPct / 100);
    const totalBalance = this.balance + this.unrealizedPnL;
    if (this.config.startingBalance - totalBalance >= lossThreshold) {
      this.sessionHalted = true;
      this.haltReason = `Session stop-loss: balance $${totalBalance.toFixed(2)} dropped ${this.config.sessionStopLossPct}%+ below $${this.config.startingBalance.toFixed(2)}`;
      console.log(`\n\n  🚨 SESSION HALTED: ${this.haltReason}\n`);
    }
  }

  // ── Market scan ───────────────────────────────────────────────────────

  private async runScan(): Promise<void> {
    try {
      const markets = await this.scanner.scan(true);
      this.marketsScanned = markets.length;
      this.marketsEligible = markets.filter(m =>
        m.marketType === 'updown'
          ? m.yesOutcomePrice <= this.config.maxEntryPrice && m.noOutcomePrice <= this.config.maxEntryPrice
          : m.combinedCost < 0.98
      ).length;
    } catch {}
  }

  // ── Decision cycle ────────────────────────────────────────────────────

  private async runDecisionCycle(): Promise<void> {
    if (this.sessionHalted || this.processingCycle) return;
    this.processingCycle = true;

    try {
      this.evaluateExits();
      this.evaluateEntries();
      this.updateUnrealized();
      this.checkSessionStopLoss();
    } catch {} finally {
      this.processingCycle = false;
    }
  }

  // ── Entry evaluation — MERGE preferred, DIRECTIONAL fallback ─────────

  private evaluateEntries(): void {
    if (this.sessionHalted) return;
    if (this.positions.size >= this.config.maxOpenPositions) return;

    const now = Date.now();

    // Cooldown checks
    if (this.lastStopLossTime > 0 && now - this.lastStopLossTime < this.config.cooldownAfterStopLossMs) return;
    if (this.lastLossTime > 0 && now - this.lastLossTime < this.config.cooldownAfterLossMs) return;

    // Volatility gate
    const btcPrice = this.binanceFeed.getPrice();
    if (btcPrice <= 0) return;
    const vol = this.binanceFeed.getVolatility(60_000);
    if (this.config.minVolatility > 0 && vol < this.config.minVolatility) return;

    // Trend signal (used for directional; merge doesn't need it)
    const trend = this.binanceFeed.getTrend(this.config.trendWindowMs);

    // Get REAL markets
    const markets = this.scanner.getCachedMarkets();

    for (const market of markets) {
      if (this.positions.size >= this.config.maxOpenPositions) break;
      if (this.positions.has(market.conditionId)) continue;
      if (market.marketType !== 'updown') continue;

      // TTL check
      if (market.expiresAt > 0) {
        const ttl = market.expiresAt - now;
        if (ttl < this.config.minTtlMs || ttl > this.config.maxTtlMs) continue;
      }

      const ttlStr = market.expiresAt > 0 ? `${((market.expiresAt - now) / 1000).toFixed(0)}s` : '?';

      // ── Try MERGE first (buy both sides if combined < threshold)
      if (this.config.mergeMode) {
        const combinedCost = market.yesOutcomePrice + market.noOutcomePrice;
        const mergeProfit = 1.0 - combinedCost; // guaranteed profit per share at redemption

        if (combinedCost > 0 && combinedCost < this.config.mergeMaxCombinedCost) {
          const budgetPerSide = this.getAvailableBalance() * this.config.mergePositionSizePct;
          const maxSide = Math.max(market.yesOutcomePrice, market.noOutcomePrice);
          const sharesAffordable = budgetPerSide / maxSide; // shares limited by more expensive side
          const totalCost = combinedCost * sharesAffordable;

          if (totalCost <= this.getAvailableBalance() && budgetPerSide >= this.config.minPositionSize) {
            const pos: MergePosition = {
              mode: 'merge',
              conditionId: market.conditionId,
              question: market.question,
              slug: market.slug,
              upTokenId: market.yesTokenId,
              downTokenId: market.noTokenId,
              upEntryPrice: market.yesOutcomePrice,
              downEntryPrice: market.noOutcomePrice,
              combinedCost,
              shares: sharesAffordable,
              totalCost,
              entryTime: now,
              expiresAt: market.expiresAt,
              btcPriceAtEntry: btcPrice,
              negRisk: market.negRisk,
            };

            this.positions.set(market.conditionId, pos);
            this.lockedInPositions += totalCost;
            this.totalEntries++;

            this.logTrade('BUY_MERGE', market.conditionId, market.question, 'both',
              combinedCost, combinedCost, sharesAffordable, 0, btcPrice,
              `merge edge=$${mergeProfit.toFixed(4)}/share combined=$${combinedCost.toFixed(4)} TTL=${ttlStr}`);

            console.log(`\n  🔀 MERGE ENTRY: BUY BOTH @$${combinedCost.toFixed(4)} (Up=$${market.yesOutcomePrice.toFixed(3)} + Down=$${market.noOutcomePrice.toFixed(3)})`);
            console.log(`     "${market.question.slice(0, 55)}..."`);
            console.log(`     Shares=${sharesAffordable.toFixed(2)} Cost=$${totalCost.toFixed(2)} Edge=$${(mergeProfit * sharesAffordable).toFixed(2)} (${(mergeProfit * 100).toFixed(1)}%/share)`);
            console.log(`     BTC=$${btcPrice.toFixed(0)} TTL=${ttlStr}`);
            console.log(`     Balance: $${this.balance.toFixed(2)} → avail: $${this.getAvailableBalance().toFixed(2)}`);
            continue; // Entered via merge, skip directional
          }
        }
      }

      // ── DIRECTIONAL fallback (need clear trend)
      if (Math.abs(trend) < this.config.minTrendStrength) continue;

      const predictedSide: 'up' | 'down' = trend > 0 ? 'up' : 'down';
      const budget = this.getAvailableBalance() * this.config.positionSizePct;
      if (budget < this.config.minPositionSize) continue;

      const entryPrice = predictedSide === 'up' ? market.yesOutcomePrice : market.noOutcomePrice;
      const tokenId = predictedSide === 'up' ? market.yesTokenId : market.noTokenId;

      if (entryPrice > this.config.maxEntryPrice || entryPrice < 0.05) continue;

      const currentBudget = Math.min(budget, this.getAvailableBalance());
      if (currentBudget < this.config.minPositionSize) break;

      const shares = currentBudget / entryPrice;
      const cost = shares * entryPrice;
      if (cost > this.getAvailableBalance()) continue;

      const position: DirectionalPosition = {
        mode: 'directional',
        conditionId: market.conditionId,
        question: market.question,
        slug: market.slug,
        side: predictedSide,
        tokenId,
        entryPrice,
        shares,
        cost,
        entryTime: now,
        expiresAt: market.expiresAt,
        btcPriceAtEntry: btcPrice,
        negRisk: market.negRisk,
      };

      this.positions.set(market.conditionId, position);
      this.lockedInPositions += cost;
      this.totalEntries++;

      const action: TradeAction = predictedSide === 'up' ? 'BUY_UP' : 'BUY_DOWN';
      this.logTrade(action, market.conditionId, market.question, predictedSide,
        entryPrice, entryPrice, shares, 0, btcPrice,
        `trend=${trend >= 0 ? '+' : ''}${trend.toFixed(2)}$/s vol=${(vol * 100).toFixed(3)}% TTL=${ttlStr}`);

      const arrow = predictedSide === 'up' ? '🟢' : '🔴';
      console.log(`\n  ${arrow} ENTRY: BUY ${predictedSide.toUpperCase()} @$${entryPrice.toFixed(4)} (Gamma price)`);
      console.log(`     "${market.question.slice(0, 55)}..."`);
      console.log(`     Shares=${shares.toFixed(2)} Cost=$${cost.toFixed(2)} Trend=${trend >= 0 ? '+' : ''}${trend.toFixed(2)}$/s`);
      console.log(`     BTC=$${btcPrice.toFixed(0)} Vol=${(vol * 100).toFixed(3)}% TTL=${ttlStr}`);
      console.log(`     Balance: $${this.balance.toFixed(2)} (locked: $${this.lockedInPositions.toFixed(2)}, avail: $${this.getAvailableBalance().toFixed(2)})`);
    }
  }

  // ── Exit evaluation (handles both MERGE and DIRECTIONAL positions) ───

  private evaluateExits(): void {
    const now = Date.now();
    const btcPrice = this.binanceFeed.getPrice();

    const markets = this.scanner.getCachedMarkets();
    const marketMap = new Map<string, ScannedMarket>();
    for (const m of markets) marketMap.set(m.conditionId, m);

    for (const [condId, pos] of this.positions) {
      const ttl = pos.expiresAt > 0 ? pos.expiresAt - now : Infinity;
      const market = marketMap.get(condId);

      if (pos.mode === 'merge') {
        this.evaluateMergeExit(condId, pos, ttl, btcPrice, market, now);
      } else {
        this.evaluateDirectionalExit(condId, pos, ttl, btcPrice, market, now);
      }
    }
  }

  // ── MERGE position exit ──────────────────────────────────────────────

  private evaluateMergeExit(
    condId: string, pos: MergePosition, ttl: number,
    btcPrice: number, market: ScannedMarket | undefined, now: number,
  ): void {
    // ── 1. RESOLVED or near-expiry → MERGE REDEEM for $1.00/share
    if (ttl <= this.config.panicExitSeconds * 1000) {
      // Merge = redeem both tokens for $1.00/share
      const revenue = 1.0 * pos.shares;
      const pnl = revenue - pos.totalCost;

      this.realizeExit(pos, 'MERGE_REDEEM', 1.0, pnl, btcPrice,
        `merge redeem ${pos.shares.toFixed(1)} shares | cost=$${pos.totalCost.toFixed(2)} revenue=$${revenue.toFixed(2)}`);
      this.positions.delete(condId);
      return;
    }

    // ── 2. Sell winning side early for quick TP (the key merge optimization)
    if (market) {
      const upNow = market.yesOutcomePrice;
      const downNow = market.noOutcomePrice;

      // Check if one side has appreciated enough for a quick directional TP
      const upProfitPct = pos.upEntryPrice > 0 ? (upNow - pos.upEntryPrice) / pos.upEntryPrice * 100 : 0;
      const downProfitPct = pos.downEntryPrice > 0 ? (downNow - pos.downEntryPrice) / pos.downEntryPrice * 100 : 0;

      if (upProfitPct >= this.config.takeProfitPct || downProfitPct >= this.config.takeProfitPct) {
        // Sell both sides at current Gamma prices
        const revenue = (upNow + downNow) * pos.shares;
        const pnl = revenue - pos.totalCost;

        const winningSide = upProfitPct > downProfitPct ? 'Up' : 'Down';
        const bestPct = Math.max(upProfitPct, downProfitPct);

        this.realizeExit(pos, 'SELL_TP', upNow + downNow, pnl, btcPrice,
          `merge TP: ${winningSide} +${bestPct.toFixed(1)}% | sell both @$${(upNow + downNow).toFixed(4)} (was $${pos.combinedCost.toFixed(4)})`);
        this.positions.delete(condId);
        return;
      }
    }
  }

  // ── DIRECTIONAL position exit (with MERGE RESCUE) ───────────────────

  private evaluateDirectionalExit(
    condId: string, pos: DirectionalPosition, ttl: number,
    btcPrice: number, market: ScannedMarket | undefined, now: number,
  ): void {
    let currentPrice = 0;
    let otherSidePrice = 0;
    if (market) {
      currentPrice = pos.side === 'up' ? market.yesOutcomePrice : market.noOutcomePrice;
      otherSidePrice = pos.side === 'up' ? market.noOutcomePrice : market.yesOutcomePrice;
    }

    // ── Helper: compare sell vs merge rescue, pick the better exit
    const pickBestExit = (sellPrice: number, baseAction: TradeAction, baseReason: string): void => {
      const sellPnl = (sellPrice - pos.entryPrice) * pos.shares;

      // MERGE RESCUE: buy the other side + merge for $1.00/share
      // Only possible if we can afford the other side AND it's cheaper than selling
      if (this.config.mergeMode && otherSidePrice > 0 && sellPnl < 0) {
        const mergeCostPerShare = pos.entryPrice + otherSidePrice; // total cost for both sides
        const mergeRevenue = 1.0; // always redeem at $1.00
        const mergePnlPerShare = mergeRevenue - mergeCostPerShare;
        const mergeTotalPnl = mergePnlPerShare * pos.shares;
        const hedgeCost = otherSidePrice * pos.shares;

        // Merge is better if: (a) combined < $1.00 (profit), or (b) merge loss < sell loss
        if (mergeTotalPnl > sellPnl && hedgeCost <= this.getAvailableBalance()) {
          // Lock additional capital for the hedge
          this.lockedInPositions += hedgeCost;
          // Adjust balance for the hedge purchase cost (will be unlocked in realizeExit)
          // We need to track the extra cost — add it to pos.cost
          pos.cost += hedgeCost;

          const saved = mergeTotalPnl - sellPnl;
          this.realizeExit(pos, 'MERGE_REDEEM', mergeRevenue, mergeTotalPnl, btcPrice,
            `MERGE RESCUE: buy ${pos.side === 'up' ? 'Down' : 'Up'} @$${otherSidePrice.toFixed(3)} + merge=$1.00 | combined=$${mergeCostPerShare.toFixed(3)} | saved $${saved.toFixed(2)} vs sell @$${sellPrice.toFixed(3)}`);
          this.positions.delete(condId);
          if (mergeTotalPnl < 0) {
            this.lastLossTime = now;
            if (baseAction === 'SELL_SL') this.lastStopLossTime = now;
          }
          return;
        }
      }

      // Regular sell
      this.realizeExit(pos, baseAction, sellPrice, sellPnl, btcPrice, baseReason);
      this.positions.delete(condId);
      if (sellPnl < 0) {
        this.lastLossTime = now;
        if (baseAction === 'SELL_SL') this.lastStopLossTime = now;
      }
    };

    // ── 1. RESOLVED
    if (ttl <= 0) {
      const btcMoved = btcPrice - pos.btcPriceAtEntry;
      const won = (pos.side === 'up' && btcMoved > 0) || (pos.side === 'down' && btcMoved < 0);
      const exitPrice = won ? 1.0 : 0.0;
      const pnl = (exitPrice - pos.entryPrice) * pos.shares;

      this.realizeExit(pos, won ? 'RESOLVED_WIN' : 'RESOLVED_LOSS', exitPrice, pnl, btcPrice,
        `resolved ${won ? 'WIN' : 'LOSS'} | BTC moved ${btcMoved >= 0 ? '+' : ''}$${btcMoved.toFixed(0)}`);
      this.positions.delete(condId);
      return;
    }

    // ── 2. PANIC EXIT (near expiry) — try merge rescue first
    if (ttl < this.config.panicExitSeconds * 1000) {
      const sellPrice = currentPrice > 0 ? currentPrice : pos.entryPrice * 0.9;
      pickBestExit(sellPrice, 'PANIC_SELL',
        `panic TTL=${(ttl / 1000).toFixed(0)}s price=$${sellPrice.toFixed(4)}`);
      return;
    }

    // ── 3. REVERSAL EXIT (BTC moved against us) — try merge rescue first
    if (this.config.reversalExitUsd > 0) {
      const btcMoved = btcPrice - pos.btcPriceAtEntry;
      const movedAgainst = (pos.side === 'up' && btcMoved < -this.config.reversalExitUsd) ||
                            (pos.side === 'down' && btcMoved > this.config.reversalExitUsd);
      if (movedAgainst) {
        const sellPrice = currentPrice > 0 ? currentPrice : pos.entryPrice * 0.92;
        pickBestExit(sellPrice, 'SELL_REVERSAL',
          `BTC reversal ${btcMoved >= 0 ? '+' : ''}$${btcMoved.toFixed(0)} vs ${pos.side} | price $${pos.entryPrice.toFixed(4)}→$${sellPrice.toFixed(4)}`);
        return;
      }
    }

    if (currentPrice <= 0) return;

    // ── 4. STOP LOSS — try merge rescue first
    if (pos.entryPrice > 0) {
      const lossPct = (pos.entryPrice - currentPrice) / pos.entryPrice * 100;
      if (lossPct >= this.config.stopLossPct) {
        pickBestExit(currentPrice, 'SELL_SL',
          `stop loss ${lossPct.toFixed(1)}% | price $${pos.entryPrice.toFixed(4)}→$${currentPrice.toFixed(4)}`);
        return;
      }
    }

    // ── 5. TAKE PROFIT
    if (pos.entryPrice > 0 && currentPrice > pos.entryPrice) {
      const profitPct = (currentPrice - pos.entryPrice) / pos.entryPrice * 100;
      if (profitPct >= this.config.takeProfitPct) {
        const pnl = (currentPrice - pos.entryPrice) * pos.shares;
        this.realizeExit(pos, 'SELL_TP', currentPrice, pnl, btcPrice,
          `take profit ${profitPct.toFixed(1)}% | price $${pos.entryPrice.toFixed(4)}→$${currentPrice.toFixed(4)}`);
        this.positions.delete(condId);
        return;
      }
    }
  }

  // ── Realize exit ──────────────────────────────────────────────────────

  private realizeExit(
    pos: Position,
    action: TradeAction,
    exitPrice: number,
    pnl: number,
    btcPrice: number,
    reason: string,
  ): void {
    const posCost = pos.mode === 'merge' ? pos.totalCost : pos.cost;
    this.balance += pnl;
    this.lockedInPositions = Math.max(0, this.lockedInPositions - posCost);
    this.realizedPnL += pnl;

    if (pnl > 0) {
      this.wins++;
      this.consecutiveLosses = 0;
    } else if (pnl < 0) {
      this.losses++;
      this.consecutiveLosses++;
      this.lastLossTime = Date.now();
    }

    this.peakBalance = Math.max(this.peakBalance, this.balance);
    this.maxDrawdown = Math.max(this.maxDrawdown, this.peakBalance - this.balance);

    const side = pos.mode === 'merge' ? 'both' : pos.side;
    const entryP = pos.mode === 'merge' ? pos.combinedCost : pos.entryPrice;

    this.logTrade(action, pos.conditionId, pos.question, side,
      entryP, exitPrice, pos.shares, pnl, btcPrice, reason);

    const emoji = action === 'RESOLVED_WIN' || action === 'SELL_TP' || action === 'MERGE_REDEEM' ? '💰' :
                  action === 'RESOLVED_LOSS' || action === 'SELL_SL' || action === 'SELL_REVERSAL' ? '📉' :
                  action === 'PANIC_SELL' ? '🛑' : '🔄';

    console.log(`  ${emoji} ${action} ${side.toUpperCase()} @$${exitPrice.toFixed(4)} (entry=$${entryP.toFixed(4)}) P&L=$${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} | Bal=$${this.balance.toFixed(2)} (${reason})`);
  }

  // ── Trade logging ─────────────────────────────────────────────────────

  private logTrade(
    action: TradeAction,
    conditionId: string,
    question: string,
    side: 'up' | 'down' | 'both',
    entryPrice: number,
    exitPrice: number,
    shares: number,
    pnl: number,
    btcPrice: number,
    reason: string,
  ): void {
    this.trades.push({
      timestamp: Date.now(), action, conditionId, question, side,
      entryPrice, exitPrice, shares, pnl, btcPrice,
      balance: this.balance, reason,
    });
  }

  // ── Unrealized P&L ──────────────────────────────────────────────────

  private updateUnrealized(): void {
    let unrealized = 0;
    const markets = this.scanner.getCachedMarkets();
    const marketMap = new Map<string, ScannedMarket>();
    for (const m of markets) marketMap.set(m.conditionId, m);

    for (const [condId, pos] of this.positions) {
      const market = marketMap.get(condId);
      if (!market) continue;

      if (pos.mode === 'merge') {
        const currentCombined = market.yesOutcomePrice + market.noOutcomePrice;
        // Merge positions can always be redeemed at $1.00, so unrealized = (1.0 - combinedCost) * shares
        // But if selling now, unrealized = (currentCombined - combinedCost) * shares
        unrealized += (currentCombined - pos.combinedCost) * pos.shares;
      } else {
        const currentPrice = pos.side === 'up' ? market.yesOutcomePrice : market.noOutcomePrice;
        unrealized += (currentPrice - pos.entryPrice) * pos.shares;
      }
    }
    this.unrealizedPnL = unrealized;
  }

  // ── Force close at session end ────────────────────────────────────────

  private forceCloseAll(): void {
    const btcPrice = this.binanceFeed.getPrice();
    const markets = this.scanner.getCachedMarkets();
    const marketMap = new Map<string, ScannedMarket>();
    for (const m of markets) marketMap.set(m.conditionId, m);

    for (const [condId, pos] of this.positions) {
      const market = marketMap.get(condId);

      if (pos.mode === 'merge') {
        const revenue = 1.0 * pos.shares;
        const pnl = revenue - pos.totalCost;
        this.realizeExit(pos, 'MERGE_REDEEM', 1.0, pnl, btcPrice,
          `session end — merge redeem ${pos.shares.toFixed(1)} shares for $${revenue.toFixed(2)}`);
      } else {
        let sellPrice = pos.entryPrice * 0.95;
        let otherSidePrice = 0;
        if (market) {
          sellPrice = pos.side === 'up' ? market.yesOutcomePrice : market.noOutcomePrice;
          otherSidePrice = pos.side === 'up' ? market.noOutcomePrice : market.yesOutcomePrice;
        }

        const sellPnl = (sellPrice - pos.entryPrice) * pos.shares;

        // Try merge rescue at session end too
        if (this.config.mergeMode && otherSidePrice > 0 && sellPnl < 0) {
          const mergeCost = pos.entryPrice + otherSidePrice;
          const mergePnl = (1.0 - mergeCost) * pos.shares;
          const hedgeCost = otherSidePrice * pos.shares;

          if (mergePnl > sellPnl && hedgeCost <= this.getAvailableBalance()) {
            pos.cost += hedgeCost;
            this.lockedInPositions += hedgeCost;
            const saved = mergePnl - sellPnl;
            this.realizeExit(pos, 'MERGE_REDEEM', 1.0, mergePnl, btcPrice,
              `session end MERGE RESCUE: buy other @$${otherSidePrice.toFixed(3)} + merge=$1.00 | saved $${saved.toFixed(2)} vs sell @$${sellPrice.toFixed(3)}`);
          } else {
            this.realizeExit(pos, 'SESSION_END', sellPrice, sellPnl, btcPrice,
              `session end — force sell at Gamma price $${sellPrice.toFixed(4)}`);
          }
        } else {
          this.realizeExit(pos, 'SESSION_END', sellPrice, sellPnl, btcPrice,
            `session end — force sell at Gamma price $${sellPrice.toFixed(4)}`);
        }
      }
      this.positions.delete(condId);
    }
  }

  // ── Dashboard ─────────────────────────────────────────────────────────

  private printDashboard(): void {
    const now = Date.now();
    const elapsed = now - this.startTime;
    const remaining = Math.max(0, this.config.durationMs - elapsed);
    const btcPrice = this.binanceFeed.getPrice();
    const vol = this.binanceFeed.getVolatility(60_000);
    const trend = this.binanceFeed.getTrend(this.config.trendWindowMs);

    const effectiveBalance = this.balance + this.unrealizedPnL;
    const pnlFromStart = effectiveBalance - this.config.startingBalance;
    const pnlPct = (pnlFromStart / this.config.startingBalance * 100);
    const winRate = (this.wins + this.losses) > 0 ? (this.wins / (this.wins + this.losses) * 100) : 0;

    process.stdout.write('\x1b[2K\r');

    let statusStr = '';
    if (this.sessionHalted) {
      statusStr = ' \x1b[31m[HALTED]\x1b[0m';
    } else if (now - this.lastStopLossTime < this.config.cooldownAfterStopLossMs) {
      const cdLeft = Math.ceil((this.config.cooldownAfterStopLossMs - (now - this.lastStopLossTime)) / 1000);
      statusStr = ` \x1b[33m[CD:${cdLeft}s]\x1b[0m`;
    }

    const trendArrow = trend > this.config.minTrendStrength ? '↑' :
                       trend < -this.config.minTrendStrength ? '↓' : '→';
    const balColor = pnlFromStart >= 0 ? '\x1b[32m' : '\x1b[31m';

    // Show open position info
    let posInfo = '';
    for (const pos of this.positions.values()) {
      if (pos.mode === 'merge') {
        posInfo = ` [MERGE@$${pos.combinedCost.toFixed(3)}]`;
      } else {
        posInfo = ` [${pos.side.toUpperCase()}@$${pos.entryPrice.toFixed(3)}]`;
      }
    }

    const parts = [
      `⏱ ${this.fmtDur(remaining)}`,
      `BTC=$${btcPrice.toFixed(0)}`,
      `${trendArrow}${Math.abs(trend).toFixed(1)}`,
      `v=${(vol * 100).toFixed(3)}%`,
      `| ${balColor}$${effectiveBalance.toFixed(2)}(${pnlFromStart >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%)\x1b[0m`,
      `Mkts:${this.marketsScanned}(${this.marketsEligible})`,
      `Open:${this.positions.size}${posInfo}`,
      `E:${this.totalEntries}`,
      `W:${this.wins}`,
      `L:${this.losses}`,
      `WR:${winRate.toFixed(0)}%`,
      statusStr,
    ];

    process.stdout.write(parts.join(' '));
  }

  private fmtDur(ms: number): string {
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;
  }

  // ── Final report ──────────────────────────────────────────────────────

  private printFinalReport(): void {
    const elapsed = Date.now() - this.startTime;
    const totalTrades = this.wins + this.losses;
    const winRate = totalTrades > 0 ? (this.wins / totalTrades * 100) : 0;
    const returnPct = ((this.balance - this.config.startingBalance) / this.config.startingBalance * 100);

    console.log('\n\n');
    console.log('═'.repeat(70));
    console.log(`  📄 PAPER TRADING REPORT — ${this.config.mergeMode ? 'MERGE + DIRECTIONAL' : 'DIRECTIONAL'} (REAL POLYMARKET)`);
    console.log('═'.repeat(70));
    console.log(`  Duration:          ${this.fmtDur(elapsed)} (${(elapsed / 60_000).toFixed(1)} min)`);
    if (this.sessionHalted) {
      console.log(`  ⚠️  Halted:         ${this.haltReason}`);
    }
    console.log('─'.repeat(70));
    console.log('  WALLET');
    console.log(`  Starting:          $${this.config.startingBalance.toFixed(2)}`);
    console.log(`  Final:             $${this.balance.toFixed(2)}`);
    console.log(`  Return:            ${returnPct >= 0 ? '✅' : '❌'} ${returnPct >= 0 ? '+' : ''}${returnPct.toFixed(2)}% ($${(this.balance - this.config.startingBalance).toFixed(2)})`);
    console.log(`  Peak:              $${this.peakBalance.toFixed(2)}`);
    console.log(`  Max drawdown:      $${this.maxDrawdown.toFixed(2)} (${(this.maxDrawdown / this.config.startingBalance * 100).toFixed(1)}%)`);
    console.log('─'.repeat(70));
    console.log('  STRATEGY');
    console.log(`  Max entry price:   $${this.config.maxEntryPrice}`);
    console.log(`  Take profit:       ${this.config.takeProfitPct}%`);
    console.log(`  Stop loss:         ${this.config.stopLossPct}%`);
    console.log(`  Trend window:      ${(this.config.trendWindowMs / 1000).toFixed(0)}s`);
    console.log(`  Min trend:         $${this.config.minTrendStrength}/sec`);
    console.log(`  Position sizing:   ${(this.config.positionSizePct * 100).toFixed(0)}% of balance`);
    console.log('─'.repeat(70));
    console.log('  RESULTS');
    console.log(`  Entries:           ${this.totalEntries}`);
    console.log(`  Wins / Losses:     ${this.wins} / ${this.losses}`);
    console.log(`  Win rate:          ${winRate.toFixed(1)}%`);
    console.log(`  Avg P&L/trade:     $${totalTrades > 0 ? (this.realizedPnL / totalTrades).toFixed(4) : '0.00'}`);
    console.log(`  Markets scanned:   ${this.marketsScanned}`);
    console.log('─'.repeat(70));

    if (this.trades.length > 0) {
      console.log('  TRADE LOG');
      console.log('  ' + 'Time'.padEnd(12) + 'Action'.padEnd(16) + 'Side'.padEnd(6) + 'Entry'.padEnd(9) + 'Exit'.padEnd(9) + 'P&L'.padEnd(10) + 'Balance'.padEnd(10) + 'BTC'.padEnd(10) + 'Reason');
      console.log('  ' + '─'.repeat(100));
      for (const t of this.trades) {
        const time = new Date(t.timestamp).toLocaleTimeString();
        const pnlStr = t.pnl !== 0 ? `$${t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(2)}` : '';
        console.log(
          '  ' +
          time.padEnd(12) +
          t.action.padEnd(16) +
          t.side.toUpperCase().padEnd(6) +
          `$${t.entryPrice.toFixed(3)}`.padEnd(9) +
          `$${t.exitPrice.toFixed(3)}`.padEnd(9) +
          pnlStr.padEnd(10) +
          `$${t.balance.toFixed(2)}`.padEnd(10) +
          `$${t.btcPrice.toFixed(0)}`.padEnd(10) +
          t.reason.slice(0, 45)
        );
      }
    }

    console.log('═'.repeat(70));
  }

  // ── Save results ──────────────────────────────────────────────────────

  private saveResults(): void {
    const dataDir = join(process.cwd(), 'backtest', 'data');
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

    const ts = new Date().toISOString().replace(/[:.]/g, '-');

    const csvPath = join(dataDir, `paper_directional_${ts}.csv`);
    const header = 'timestamp,action,conditionId,question,side,entryPrice,exitPrice,shares,pnl,balance,btcPrice,reason\n';
    const rows = this.trades.map(t =>
      `${t.timestamp},${t.action},${t.conditionId},"${t.question.replace(/"/g, '""')}",${t.side},${t.entryPrice.toFixed(6)},${t.exitPrice.toFixed(6)},${t.shares.toFixed(4)},${t.pnl.toFixed(4)},${t.balance.toFixed(4)},${t.btcPrice.toFixed(2)},"${t.reason}"`
    ).join('\n');
    writeFileSync(csvPath, header + rows);

    const jsonPath = join(dataDir, `paper_directional_session_${ts}.json`);
    writeFileSync(jsonPath, JSON.stringify({
      dataSource: this.config.mergeMode ? 'REAL_POLYMARKET_MERGE_HYBRID' : 'REAL_POLYMARKET_DIRECTIONAL',
      config: this.config,
      wallet: {
        startingBalance: this.config.startingBalance,
        finalBalance: this.balance,
        returnPct: (this.balance - this.config.startingBalance) / this.config.startingBalance * 100,
        peakBalance: this.peakBalance,
        maxDrawdown: this.maxDrawdown,
      },
      results: {
        totalPnL: this.realizedPnL,
        totalEntries: this.totalEntries,
        wins: this.wins,
        losses: this.losses,
        winRate: (this.wins + this.losses) > 0 ? this.wins / (this.wins + this.losses) : 0,
        marketsScanned: this.marketsScanned,
        sessionHalted: this.sessionHalted,
        haltReason: this.haltReason,
        durationMs: Date.now() - this.startTime,
      },
      trades: this.trades,
    }, null, 2));

    console.log(`\n📁 Trades: ${csvPath}`);
    console.log(`📁 Session: ${jsonPath}\n`);
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

const config = loadConfig();
const engine = new PaperTradingEngine(config);

process.on('SIGINT', () => {
  console.log('\n\n⚠️  Interrupted — generating report...');
  process.exit(0);
});

engine.run().catch((err) => {
  console.error('❌ Paper trading failed:', err.message);
  process.exit(1);
});
