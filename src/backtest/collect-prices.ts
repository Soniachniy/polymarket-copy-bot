/**
 * Collect real-time BTC price data from Binance WebSocket.
 * Saves tick-level data to CSV for backtesting parameter optimization.
 *
 * Usage:
 *   npx tsx src/backtest/collect-prices.ts [duration_seconds]
 *
 * Default: 60 seconds. Output: backtest/data/btc_prices_<timestamp>.csv
 */

import WebSocket from 'ws';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', '..', 'backtest', 'data');

interface PriceTick {
  timestamp: number;
  price: number;
  quantity: number;
  isBuyerMaker: boolean;
}

const durationSec = parseInt(process.argv[2] || '60', 10);
const symbol = process.argv[3] || 'btcusdt';

console.log(`📊 Collecting ${symbol.toUpperCase()} prices for ${durationSec}s...`);
console.log(`   Output: ${DATA_DIR}/`);

if (!existsSync(DATA_DIR)) {
  mkdirSync(DATA_DIR, { recursive: true });
}

const ticks: PriceTick[] = [];
let connected = false;

const ws = new WebSocket(`wss://stream.binance.com:9443/ws/${symbol}@trade`);

ws.on('open', () => {
  connected = true;
  console.log('✅ Connected to Binance WebSocket');
  console.log(`   Collecting until ${new Date(Date.now() + durationSec * 1000).toLocaleTimeString()}...\n`);
});

ws.on('message', (data: WebSocket.Data) => {
  try {
    const msg = JSON.parse(data.toString());
    if (msg.e !== 'trade') return;

    ticks.push({
      timestamp: msg.T,
      price: parseFloat(msg.p),
      quantity: parseFloat(msg.q),
      isBuyerMaker: msg.m,
    });

    // Progress every 500 ticks
    if (ticks.length % 500 === 0) {
      process.stdout.write(`\r   Ticks collected: ${ticks.length} | Last price: $${parseFloat(msg.p).toFixed(2)}`);
    }
  } catch {
    // skip malformed
  }
});

ws.on('error', (err) => {
  console.error('WebSocket error:', err.message);
  process.exit(1);
});

// Wait for connection then run timer
const waitForConnection = setInterval(() => {
  if (!connected) return;
  clearInterval(waitForConnection);

  setTimeout(() => {
    ws.close();

    if (ticks.length === 0) {
      console.log('\n❌ No ticks collected');
      process.exit(1);
    }

    console.log(`\n\n📊 Collection complete: ${ticks.length} ticks in ${durationSec}s`);

    // Also produce 1-second OHLC bars for the optimizer
    const bars = aggregateToSeconds(ticks);
    console.log(`   Aggregated to ${bars.length} 1-second bars`);

    const startPrice = ticks[0]!.price;
    const endPrice = ticks[ticks.length - 1]!.price;
    const high = Math.max(...ticks.map((t) => t.price));
    const low = Math.min(...ticks.map((t) => t.price));
    console.log(`   Price range: $${low.toFixed(2)} — $${high.toFixed(2)}`);
    console.log(`   Start: $${startPrice.toFixed(2)} → End: $${endPrice.toFixed(2)} (${((endPrice - startPrice) / startPrice * 100).toFixed(3)}%)`);

    // Save raw ticks
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const tickFile = join(DATA_DIR, `btc_ticks_${ts}.csv`);
    const tickCsv = 'timestamp,price,quantity,is_buyer_maker\n' +
      ticks.map((t) => `${t.timestamp},${t.price},${t.quantity},${t.isBuyerMaker}`).join('\n');
    writeFileSync(tickFile, tickCsv);
    console.log(`\n   Raw ticks: ${tickFile}`);

    // Save 1s bars
    const barFile = join(DATA_DIR, `btc_bars_1s_${ts}.csv`);
    const barCsv = 'timestamp,open,high,low,close,volume,trade_count\n' +
      bars.map((b) => `${b.timestamp},${b.open},${b.high},${b.low},${b.close},${b.volume.toFixed(6)},${b.tradeCount}`).join('\n');
    writeFileSync(barFile, barCsv);
    console.log(`   1s bars:   ${barFile}`);

    // Save summary stats
    const statsFile = join(DATA_DIR, `btc_stats_${ts}.json`);
    const stats = {
      symbol,
      durationSec,
      tickCount: ticks.length,
      barCount: bars.length,
      startTime: new Date(ticks[0]!.timestamp).toISOString(),
      endTime: new Date(ticks[ticks.length - 1]!.timestamp).toISOString(),
      startPrice,
      endPrice,
      high,
      low,
      changePct: (endPrice - startPrice) / startPrice * 100,
      ticksPerSecond: ticks.length / durationSec,
    };
    writeFileSync(statsFile, JSON.stringify(stats, null, 2));
    console.log(`   Stats:     ${statsFile}\n`);

    console.log('✅ Done! Now run the optimizer:');
    console.log(`   npx tsx src/backtest/optimize-params.ts "${barFile}"\n`);
  }, durationSec * 1000);
}, 100);

interface Bar {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  tradeCount: number;
}

function aggregateToSeconds(ticks: PriceTick[]): Bar[] {
  const bars: Bar[] = [];
  if (ticks.length === 0) return bars;

  let currentSecond = Math.floor(ticks[0]!.timestamp / 1000) * 1000;
  let bar: Bar = {
    timestamp: currentSecond,
    open: ticks[0]!.price,
    high: ticks[0]!.price,
    low: ticks[0]!.price,
    close: ticks[0]!.price,
    volume: 0,
    tradeCount: 0,
  };

  for (const tick of ticks) {
    const tickSecond = Math.floor(tick.timestamp / 1000) * 1000;

    if (tickSecond !== currentSecond) {
      bars.push(bar);
      currentSecond = tickSecond;
      bar = {
        timestamp: tickSecond,
        open: tick.price,
        high: tick.price,
        low: tick.price,
        close: tick.price,
        volume: 0,
        tradeCount: 0,
      };
    }

    bar.high = Math.max(bar.high, tick.price);
    bar.low = Math.min(bar.low, tick.price);
    bar.close = tick.price;
    bar.volume += tick.price * tick.quantity;
    bar.tradeCount++;
  }

  bars.push(bar);
  return bars;
}
