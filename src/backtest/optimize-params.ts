/**
 * Backtest parameter optimizer for the volatility strategy.
 *
 * Simulates buying YES+NO on a synthetic Polymarket-style market using
 * real BTC price data. Tests a grid of strategy parameters and reports
 * the combination that yields the highest profit.
 *
 * Usage:
 *   npx tsx src/backtest/optimize-params.ts <bars_csv_path>
 *
 * The CSV must have columns: timestamp,open,high,low,close,volume,trade_count
 */

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname, basename } from 'path';

// ── Load bars from CSV ──────────────────────────────────────────────────────

interface Bar {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  tradeCount: number;
}

function loadBars(csvPath: string): Bar[] {
  const raw = readFileSync(csvPath, 'utf8');
  const lines = raw.trim().split('\n');
  lines.shift(); // header

  return lines.map((line) => {
    const [timestamp, open, high, low, close, volume, tradeCount] = line.split(',');
    return {
      timestamp: parseInt(timestamp!, 10),
      open: parseFloat(open!),
      high: parseFloat(high!),
      low: parseFloat(low!),
      close: parseFloat(close!),
      volume: parseFloat(volume!),
      tradeCount: parseInt(tradeCount!, 10),
    };
  });
}

// ── Synthetic market simulation ─────────────────────────────────────────────
//
// A Polymarket "Bitcoin above $X by time T" market has:
//   YES price ≈ probability BTC > strike at expiry
//   NO price  ≈ 1 - YES price
//
// We model YES price as a logistic function of (BTC_price - strike):
//   p_yes = sigmoid((btc - strike) / (strike * sensitivity))
//
// Where sensitivity controls how quickly the market reacts to price moves.
// For 5-minute markets near the money, sensitivity ≈ 0.002–0.005.

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

function btcToYesPrice(btcPrice: number, strikePrice: number, sensitivity: number): number {
  const z = (btcPrice - strikePrice) / (strikePrice * sensitivity);
  const raw = sigmoid(z);
  // Polymarket prices are clamped [0.01, 0.99]
  return Math.max(0.01, Math.min(0.99, raw));
}

// ── Backtest engine ─────────────────────────────────────────────────────────

interface StrategyParams {
  maxEntryCost: number;      // max YES+NO combined ask to enter
  takeProfitPct: number;     // sell a side when profit > X%
  stopLossPct: number;       // cut both sides when loss > X%
  sensitivity: number;       // market price sensitivity to BTC moves
  mergeAtEnd: boolean;       // if still holding at expiry, merge
}

interface TradeRecord {
  action: 'BUY_YES' | 'BUY_NO' | 'SELL_YES' | 'SELL_NO' | 'MERGE';
  barIndex: number;
  price: number;
  pnl: number;
}

interface BacktestResult {
  params: StrategyParams;
  totalPnL: number;
  maxDrawdown: number;
  tradeCount: number;
  winRate: number;
  mergeCount: number;
  sellCount: number;
  avgHoldBars: number;
  trades: TradeRecord[];
}

function runBacktest(bars: Bar[], params: StrategyParams, positionSizePerSide: number): BacktestResult {
  if (bars.length < 10) {
    return { params, totalPnL: 0, maxDrawdown: 0, tradeCount: 0, winRate: 0, mergeCount: 0, sellCount: 0, avgHoldBars: 0, trades: [] };
  }

  // Strike = price at the start of the window (simulating "at the money" market)
  const strike = bars[0]!.close;
  const trades: TradeRecord[] = [];

  let totalPnL = 0;
  let maxDrawdown = 0;
  let peakPnL = 0;

  // Slide a window across the data simulating repeated 5-minute markets
  // Each "market" spans windowSize bars; we move forward by step bars each iteration
  // Each window simulates one 5-min market. Use smaller windows for short datasets.
  const windowSize = Math.min(300, Math.max(10, Math.floor(bars.length / 3)));
  const step = Math.max(1, Math.floor(windowSize / 4)); // overlapping windows for more data points
  let wins = 0;
  let losses = 0;
  let mergeCount = 0;
  let sellCount = 0;
  let totalHoldBars = 0;

  for (let start = 0; start + windowSize <= bars.length; start += step) {
    const window = bars.slice(start, start + windowSize);
    const marketStrike = window[0]!.close;

    // Check entry: compute YES/NO mid prices at market open
    const yesMid = btcToYesPrice(window[0]!.close, marketStrike, params.sensitivity);
    const noMid = 1 - yesMid;

    // In real Polymarket, the combined ask (YES ask + NO ask) is typically < $1.00
    // because market makers set asks slightly below theoretical mid to attract flow.
    // Model: each side's ask = mid - halfOverlap, so combined < 1.0
    // The "overlap" represents the arb opportunity — makers undercut by ~2-5 cents total.
    const overlap = 0.03; // 3 cent total overlap → combined cost ≈ $0.97
    const effectiveYesAsk = Math.max(0.01, Math.min(0.99, yesMid - overlap / 2));
    const effectiveNoAsk = Math.max(0.01, Math.min(0.99, noMid - overlap / 2));
    const effectiveCombined = effectiveYesAsk + effectiveNoAsk;

    if (effectiveCombined >= params.maxEntryCost) continue;

    // ENTER: buy both sides
    const yesEntry = effectiveYesAsk;
    const noEntry = effectiveNoAsk;
    const shares = positionSizePerSide; // shares per side (normalized to $1 each)

    trades.push({ action: 'BUY_YES', barIndex: start, price: yesEntry, pnl: 0 });
    trades.push({ action: 'BUY_NO', barIndex: start, price: noEntry, pnl: 0 });

    let yesHeld = true;
    let noHeld = true;
    let marketPnL = 0;
    let exitBar = start;

    // Walk through the market window looking for exits
    for (let i = 1; i < window.length; i++) {
      const bar = window[i]!;
      const currentYes = btcToYesPrice(bar.close, marketStrike, params.sensitivity);
      const currentNo = 1 - currentYes;

      // Apply spread for sell (bid is below mid, ask is above mid, but we already
      // modeled asks below mid for entry overlap — for exits, bids are below mid by ~1c)
      const bidSpread = 0.01; // bid sits 1c below mid
      const yesBid = Math.max(0.01, currentYes - bidSpread);
      const noBid = Math.max(0.01, currentNo - bidSpread);

      // Take profit on YES
      if (yesHeld && yesEntry > 0) {
        const yesProfitPct = (yesBid - yesEntry) / yesEntry * 100;
        if (yesProfitPct >= params.takeProfitPct) {
          const pnl = (yesBid - yesEntry) * shares;
          marketPnL += pnl;
          trades.push({ action: 'SELL_YES', barIndex: start + i, price: yesBid, pnl });
          yesHeld = false;
          sellCount++;
          exitBar = start + i;
        }
      }

      // Take profit on NO
      if (noHeld && noEntry > 0) {
        const noProfitPct = (noBid - noEntry) / noEntry * 100;
        if (noProfitPct >= params.takeProfitPct) {
          const pnl = (noBid - noEntry) * shares;
          marketPnL += pnl;
          trades.push({ action: 'SELL_NO', barIndex: start + i, price: noBid, pnl });
          noHeld = false;
          sellCount++;
          exitBar = start + i;
        }
      }

      // Stop loss on combined position
      if (yesHeld || noHeld) {
        let unrealized = 0;
        if (yesHeld) unrealized += (yesBid - yesEntry) * shares;
        if (noHeld) unrealized += (noBid - noEntry) * shares;
        const totalEntry = (yesHeld ? yesEntry : 0) + (noHeld ? noEntry : 0);
        if (totalEntry > 0 && unrealized < 0) {
          const lossPct = Math.abs(unrealized) / (totalEntry * shares) * 100;
          if (lossPct >= params.stopLossPct) {
            if (yesHeld) {
              const pnl = (yesBid - yesEntry) * shares;
              marketPnL += pnl;
              trades.push({ action: 'SELL_YES', barIndex: start + i, price: yesBid, pnl });
              yesHeld = false;
              sellCount++;
            }
            if (noHeld) {
              const pnl = (noBid - noEntry) * shares;
              marketPnL += pnl;
              trades.push({ action: 'SELL_NO', barIndex: start + i, price: noBid, pnl });
              noHeld = false;
              sellCount++;
            }
            exitBar = start + i;
            break;
          }
        }
      }

      if (!yesHeld && !noHeld) break;
    }

    // End of market window: merge if still holding both sides
    if (yesHeld && noHeld && params.mergeAtEnd) {
      const mergePnL = (1.0 - yesEntry - noEntry) * shares;
      marketPnL += mergePnL;
      trades.push({ action: 'MERGE', barIndex: start + windowSize - 1, price: 1.0, pnl: mergePnL });
      mergeCount++;
      exitBar = start + windowSize - 1;
    } else if (yesHeld || noHeld) {
      // Force sell remaining at last bar prices
      const lastBar = window[window.length - 1]!;
      const lastYes = btcToYesPrice(lastBar.close, marketStrike, params.sensitivity);
      const lastNo = 1 - lastYes;
      if (yesHeld) {
        const pnl = (Math.max(0.01, lastYes - 0.01) - yesEntry) * shares;
        marketPnL += pnl;
        sellCount++;
      }
      if (noHeld) {
        const pnl = (Math.max(0.01, lastNo - 0.01) - noEntry) * shares;
        marketPnL += pnl;
        sellCount++;
      }
      exitBar = start + windowSize - 1;
    }

    totalPnL += marketPnL;
    if (marketPnL > 0) wins++;
    else losses++;

    totalHoldBars += exitBar - start;

    peakPnL = Math.max(peakPnL, totalPnL);
    const drawdown = peakPnL - totalPnL;
    maxDrawdown = Math.max(maxDrawdown, drawdown);
  }

  const totalTrades = wins + losses;
  return {
    params,
    totalPnL,
    maxDrawdown,
    tradeCount: totalTrades,
    winRate: totalTrades > 0 ? wins / totalTrades : 0,
    mergeCount,
    sellCount,
    avgHoldBars: totalTrades > 0 ? totalHoldBars / totalTrades : 0,
    trades,
  };
}

// ── Parameter grid search ───────────────────────────────────────────────────

interface GridResult {
  params: StrategyParams;
  totalPnL: number;
  maxDrawdown: number;
  tradeCount: number;
  winRate: number;
  mergeCount: number;
  sellCount: number;
  avgHoldBars: number;
  sharpeApprox: number;
}

function runGridSearch(bars: Bar[]): GridResult[] {
  const results: GridResult[] = [];

  // Parameter ranges to test
  const maxEntryCosts = [0.95, 0.96, 0.97, 0.98, 0.99];
  const takeProfitPcts = [5, 10, 15, 20, 30, 50];
  const stopLossPcts = [5, 10, 15, 20, 30];
  const sensitivities = [0.001, 0.002, 0.003, 0.005, 0.008];
  const mergeOptions = [true, false];

  const totalCombinations = maxEntryCosts.length * takeProfitPcts.length * stopLossPcts.length * sensitivities.length * mergeOptions.length;
  console.log(`\n🔬 Running grid search: ${totalCombinations} parameter combinations...`);

  let completed = 0;

  for (const maxEntryCost of maxEntryCosts) {
    for (const takeProfitPct of takeProfitPcts) {
      for (const stopLossPct of stopLossPcts) {
        for (const sensitivity of sensitivities) {
          for (const mergeAtEnd of mergeOptions) {
            const params: StrategyParams = { maxEntryCost, takeProfitPct, stopLossPct, sensitivity, mergeAtEnd };
            const result = runBacktest(bars, params, 100); // $100 per side

            // Approximate Sharpe: mean return / std of returns per trade
            const tradeReturns = result.trades
              .filter((t) => t.action.startsWith('SELL') || t.action === 'MERGE')
              .map((t) => t.pnl);

            let sharpe = 0;
            if (tradeReturns.length >= 2) {
              const mean = tradeReturns.reduce((a, b) => a + b, 0) / tradeReturns.length;
              const variance = tradeReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / (tradeReturns.length - 1);
              const std = Math.sqrt(variance);
              sharpe = std > 0.0001 ? mean / std : (mean > 0 ? 99.99 : 0);
            }

            results.push({
              params,
              totalPnL: result.totalPnL,
              maxDrawdown: result.maxDrawdown,
              tradeCount: result.tradeCount,
              winRate: result.winRate,
              mergeCount: result.mergeCount,
              sellCount: result.sellCount,
              avgHoldBars: result.avgHoldBars,
              sharpeApprox: sharpe,
            });

            completed++;
            if (completed % 100 === 0) {
              process.stdout.write(`\r   Progress: ${completed}/${totalCombinations} (${(completed / totalCombinations * 100).toFixed(0)}%)`);
            }
          }
        }
      }
    }
  }

  console.log(`\r   Progress: ${totalCombinations}/${totalCombinations} (100%)     `);
  return results;
}

// ── Main ────────────────────────────────────────────────────────────────────

const csvPath = process.argv[2];
if (!csvPath) {
  console.error('Usage: npx tsx src/backtest/optimize-params.ts <bars_csv_path>');
  console.error('  Run collect-prices.ts first to generate the CSV.');
  process.exit(1);
}

console.log('📊 Volatility Strategy Parameter Optimizer');
console.log('==========================================\n');

const bars = loadBars(csvPath);
console.log(`Loaded ${bars.length} bars from ${basename(csvPath)}`);
console.log(`   Time range: ${new Date(bars[0]!.timestamp).toISOString()} → ${new Date(bars[bars.length - 1]!.timestamp).toISOString()}`);
console.log(`   Price range: $${Math.min(...bars.map((b) => b.low)).toFixed(2)} — $${Math.max(...bars.map((b) => b.high)).toFixed(2)}`);

const results = runGridSearch(bars);

// Sort by total P&L descending
results.sort((a, b) => b.totalPnL - a.totalPnL);

// Show top 10
console.log('\n\n🏆 TOP 10 PARAMETER COMBINATIONS (by Total P&L)');
console.log('='.repeat(130));
console.log(
  'Rank'.padEnd(6) +
  'P&L ($)'.padEnd(12) +
  'Win Rate'.padEnd(10) +
  'Trades'.padEnd(8) +
  'Merges'.padEnd(8) +
  'Sells'.padEnd(8) +
  'MaxDD ($)'.padEnd(12) +
  'Sharpe'.padEnd(8) +
  'AvgHold'.padEnd(9) +
  'MaxEntry'.padEnd(10) +
  'TP%'.padEnd(6) +
  'SL%'.padEnd(6) +
  'Sens'.padEnd(8) +
  'Merge?'
);
console.log('-'.repeat(130));

const top10 = results.slice(0, 10);
top10.forEach((r, i) => {
  console.log(
    `#${i + 1}`.padEnd(6) +
    `$${r.totalPnL.toFixed(2)}`.padEnd(12) +
    `${(r.winRate * 100).toFixed(1)}%`.padEnd(10) +
    `${r.tradeCount}`.padEnd(8) +
    `${r.mergeCount}`.padEnd(8) +
    `${r.sellCount}`.padEnd(8) +
    `$${r.maxDrawdown.toFixed(2)}`.padEnd(12) +
    `${r.sharpeApprox.toFixed(3)}`.padEnd(8) +
    `${r.avgHoldBars.toFixed(0)}s`.padEnd(9) +
    `${r.params.maxEntryCost}`.padEnd(10) +
    `${r.params.takeProfitPct}`.padEnd(6) +
    `${r.params.stopLossPct}`.padEnd(6) +
    `${r.params.sensitivity}`.padEnd(8) +
    `${r.params.mergeAtEnd}`
  );
});

// Show best by Sharpe ratio
const bySharpe = [...results].sort((a, b) => b.sharpeApprox - a.sharpeApprox);
console.log('\n\n📈 TOP 5 BY SHARPE RATIO (risk-adjusted)');
console.log('-'.repeat(130));
bySharpe.slice(0, 5).forEach((r, i) => {
  console.log(
    `#${i + 1}`.padEnd(6) +
    `$${r.totalPnL.toFixed(2)}`.padEnd(12) +
    `${(r.winRate * 100).toFixed(1)}%`.padEnd(10) +
    `${r.tradeCount}`.padEnd(8) +
    `${r.mergeCount}`.padEnd(8) +
    `${r.sellCount}`.padEnd(8) +
    `$${r.maxDrawdown.toFixed(2)}`.padEnd(12) +
    `${r.sharpeApprox.toFixed(3)}`.padEnd(8) +
    `${r.avgHoldBars.toFixed(0)}s`.padEnd(9) +
    `${r.params.maxEntryCost}`.padEnd(10) +
    `${r.params.takeProfitPct}`.padEnd(6) +
    `${r.params.stopLossPct}`.padEnd(6) +
    `${r.params.sensitivity}`.padEnd(8) +
    `${r.params.mergeAtEnd}`
  );
});

// Recommend
const best = top10[0]!;
console.log('\n\n✅ RECOMMENDED .env PARAMETERS');
console.log('================================');
console.log(`VOL_ENABLED=true`);
console.log(`VOL_MAX_ENTRY_COST=${best.params.maxEntryCost}`);
console.log(`VOL_TAKE_PROFIT_PCT=${best.params.takeProfitPct}`);
console.log(`VOL_STOP_LOSS_PCT=${best.params.stopLossPct}`);
console.log(`# Market sensitivity estimate: ${best.params.sensitivity}`);
console.log(`# Merge at expiry: ${best.params.mergeAtEnd}`);
console.log(`# Expected P&L per cycle: $${(best.totalPnL / Math.max(1, best.tradeCount)).toFixed(2)}`);
console.log(`# Win rate: ${(best.winRate * 100).toFixed(1)}%`);
console.log(`# Max drawdown: $${best.maxDrawdown.toFixed(2)}`);

// Save full results
const outDir = dirname(csvPath);
const outFile = join(outDir, `optimization_results_${Date.now()}.json`);
writeFileSync(outFile, JSON.stringify({
  inputFile: csvPath,
  barCount: bars.length,
  totalCombinations: results.length,
  top10: top10.map((r) => ({ ...r, trades: undefined })),
  topSharpe: bySharpe.slice(0, 5).map((r) => ({ ...r, trades: undefined })),
  recommended: {
    maxEntryCost: best.params.maxEntryCost,
    takeProfitPct: best.params.takeProfitPct,
    stopLossPct: best.params.stopLossPct,
    sensitivity: best.params.sensitivity,
    mergeAtEnd: best.params.mergeAtEnd,
  },
}, null, 2));
console.log(`\n📁 Full results saved to: ${outFile}\n`);
