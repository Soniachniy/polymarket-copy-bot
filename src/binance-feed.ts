import WebSocket from 'ws';
import { EventEmitter } from 'events';

export interface BinancePriceUpdate {
  price: number;
  timestamp: number;
}

interface PriceEntry {
  price: number;
  timestamp: number;
}

interface BinanceTradeMessage {
  e: string;   // Event type
  E: number;   // Event time
  s: string;   // Symbol
  t: number;   // Trade ID
  p: string;   // Price
  q: string;   // Quantity
  T: number;   // Trade time
}

export class BinancePriceFeed extends EventEmitter {
  private ws: WebSocket | null = null;
  private isConnected = false;
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = 10;
  private readonly reconnectDelay = 1000;
  private connectPromise: Promise<void> | undefined;
  private pingInterval: NodeJS.Timeout | null = null;
  private sampleInterval: NodeJS.Timeout | null = null;

  private lastPrice = 0;
  private lastRawPrice = 0;
  private lastRawTimestamp = 0;
  private priceHistory: PriceEntry[] = [];
  private readonly maxHistorySize: number;
  private readonly symbol: string;
  private readonly apiKey: string;

  constructor(options: {
    symbol?: string;
    maxHistorySize?: number;
    apiKey?: string;
  } = {}) {
    super();
    this.symbol = (options.symbol || 'btcusdt').toLowerCase();
    this.maxHistorySize = options.maxHistorySize || 300;
    this.apiKey = options.apiKey || '';
  }

  async initialize(): Promise<void> {
    await this.connect();
    this.startSampling();
  }

  private async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        const url = `wss://stream.binance.com:9443/ws/${this.symbol}@trade`;
        console.log(`🔌 Connecting to Binance WebSocket (${this.symbol})...`);
        this.ws = new WebSocket(url);

        this.ws.on('open', () => {
          console.log(`✅ Binance WebSocket connected (${this.symbol})`);
          this.isConnected = true;
          this.reconnectAttempts = 0;
          this.startPingInterval();
          this.emit('connected');
          resolve();
        });

        this.ws.on('message', (data: WebSocket.Data) => {
          this.handleMessage(data.toString());
        });

        this.ws.on('close', (code: number, reason: Buffer) => {
          const reasonText = reason?.toString() || 'no reason';
          console.log(`❌ Binance WebSocket disconnected (code=${code}, reason=${reasonText})`);
          this.isConnected = false;
          this.ws = null;
          this.stopPingInterval();
          this.emit('disconnected');
          this.attemptReconnect();
        });

        this.ws.on('error', (error: Error) => {
          console.error('Binance WebSocket error:', error.message);
          this.emit('error', error);
          reject(error);
        });

        setTimeout(() => {
          if (!this.isConnected) {
            reject(new Error('Binance WebSocket connection timeout'));
          }
        }, 10000);
      } catch (error) {
        reject(error);
      }
    });
  }

  private handleMessage(data: string): void {
    try {
      const msg = JSON.parse(data) as BinanceTradeMessage;
      if (msg.e !== 'trade') return;

      const price = parseFloat(msg.p);
      if (!Number.isFinite(price) || price <= 0) return;

      this.lastRawPrice = price;
      this.lastRawTimestamp = msg.T || Date.now();
    } catch {
      // Ignore malformed messages
    }
  }

  /**
   * Sample the latest raw price at 1-second intervals to avoid
   * processing hundreds of messages per second from btcusdt@trade.
   */
  private startSampling(): void {
    this.sampleInterval = setInterval(() => {
      if (this.lastRawPrice <= 0) return;

      const entry: PriceEntry = {
        price: this.lastRawPrice,
        timestamp: this.lastRawTimestamp || Date.now(),
      };

      // Only emit + record if price actually changed or it's the first sample
      if (this.lastPrice !== entry.price || this.priceHistory.length === 0) {
        this.lastPrice = entry.price;
        this.priceHistory.push(entry);

        if (this.priceHistory.length > this.maxHistorySize) {
          this.priceHistory = this.priceHistory.slice(-this.maxHistorySize);
        }

        this.emit('price', { price: entry.price, timestamp: entry.timestamp } as BinancePriceUpdate);
      }
    }, 1000);
  }

  getPrice(): number {
    return this.lastPrice;
  }

  getPriceHistory(): PriceEntry[] {
    return [...this.priceHistory];
  }

  /**
   * Compute standard deviation of log-returns over a rolling window.
   * Returns 0 if insufficient data.
   */
  getVolatility(windowMs: number = 60_000): number {
    const now = Date.now();
    const cutoff = now - windowMs;
    const relevant = this.priceHistory.filter((e) => e.timestamp >= cutoff);

    if (relevant.length < 3) return 0;

    const returns: number[] = [];
    for (let i = 1; i < relevant.length; i++) {
      const prev = relevant[i - 1]!;
      const curr = relevant[i]!;
      const logReturn = Math.log(curr.price / prev.price);
      returns.push(logReturn);
    }

    if (returns.length < 2) return 0;

    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / (returns.length - 1);
    return Math.sqrt(variance);
  }

  /**
   * Compute linear regression slope of price over a rolling window.
   * Positive = uptrend, negative = downtrend.
   * Returns price change per second.
   */
  getTrend(windowMs: number = 60_000): number {
    const now = Date.now();
    const cutoff = now - windowMs;
    const relevant = this.priceHistory.filter((e) => e.timestamp >= cutoff);

    if (relevant.length < 3) return 0;

    const n = relevant.length;
    let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
    const t0 = relevant[0]!.timestamp;

    for (const entry of relevant) {
      const x = (entry.timestamp - t0) / 1000; // seconds
      const y = entry.price;
      sumX += x;
      sumY += y;
      sumXY += x * y;
      sumXX += x * x;
    }

    const denominator = n * sumXX - sumX * sumX;
    if (denominator === 0) return 0;

    return (n * sumXY - sumX * sumY) / denominator;
  }

  isReady(): boolean {
    return this.isConnected && this.lastPrice > 0;
  }

  getConnectionStatus(): { connected: boolean; lastPrice: number; historySize: number; reconnectAttempts: number } {
    return {
      connected: this.isConnected,
      lastPrice: this.lastPrice,
      historySize: this.priceHistory.length,
      reconnectAttempts: this.reconnectAttempts,
    };
  }

  private startPingInterval(): void {
    this.pingInterval = setInterval(() => {
      if (this.ws && this.isConnected) {
        try {
          this.ws.ping();
        } catch {
          // Ignore ping errors
        }
      }
    }, 30000);
  }

  private stopPingInterval(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  private attemptReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('❌ Max Binance reconnection attempts reached.');
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1), 10000);

    console.log(`🔄 Binance reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);

    setTimeout(async () => {
      try {
        await this.connect();
      } catch {
        this.attemptReconnect();
      }
    }, delay);
  }

  close(): void {
    this.stopPingInterval();
    if (this.sampleInterval) {
      clearInterval(this.sampleInterval);
      this.sampleInterval = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.isConnected = false;
    console.log('🔌 Binance WebSocket connection closed');
  }
}
