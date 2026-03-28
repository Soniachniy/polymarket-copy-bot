import { EventEmitter } from 'events';
import { PolymarketCopyBot } from './bot.js';
import type { AppConfig } from './persistent-config.js';
import { toBotConfig } from './persistent-config.js';

export type BotStatus = 'stopped' | 'starting' | 'running' | 'stopping';

export interface CopiedTradeRecord {
  id: string;
  sourceTrade: {
    txHash: string;
    timestamp: number;
    market: string;
    tokenId: string;
    side: 'BUY' | 'SELL';
    price: number;
    size: number;
    outcome: string;
  };
  result: 'success' | 'failed' | 'skipped';
  reason?: string;
  orderId?: string;
  copyNotional?: number;
  copyShares?: number;
  price?: number;
  executedAt: string;
}

export interface VolatilityStatsPayload {
  openPositions: number;
  totalEntries: number;
  totalExits: number;
  totalMerges: number;
  realizedPnL: number;
}

export interface StatusPayload {
  status: BotStatus;
  startedAt: string | null;
  stats: {
    tradesDetected: number;
    tradesCopied: number;
    tradesFailed: number;
    totalVolume: number;
  };
  volatilityStats: VolatilityStatsPayload | null;
  walletAddress: string;
  setupComplete: boolean;
}

export class BotController extends EventEmitter {
  private bot: PolymarketCopyBot | null = null;
  private taskPromise: Promise<void> | null = null;
  private status: BotStatus = 'stopped';
  private startedAt: Date | null = null;
  private copiedTrades: CopiedTradeRecord[] = [];
  private readonly MAX_RECORDS = 500;

  private genId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  async start(appConfig: AppConfig, privateKey: string): Promise<void> {
    if (this.status !== 'stopped') {
      throw new Error(`Bot is already ${this.status}`);
    }

    this.status = 'starting';
    const botConfig = toBotConfig(appConfig, privateKey);
    this.bot = new PolymarketCopyBot(botConfig);

    // Wire bot events → controller events for WS broadcasting
    this.bot.on('trade:detected', (trade) => {
      this.emit('trade:detected', trade);
    });

    this.bot.on('trade:copied', ({ sourceTrade, result }) => {
      const record: CopiedTradeRecord = {
        id: this.genId(),
        sourceTrade,
        result: 'success',
        orderId: result.orderId,
        copyNotional: result.copyNotional,
        copyShares: result.copyShares,
        price: result.price,
        executedAt: new Date().toISOString(),
      };
      this.addRecord(record);
      this.emit('trade:copied', record);
    });

    this.bot.on('trade:failed', ({ trade, error }) => {
      const record: CopiedTradeRecord = {
        id: this.genId(),
        sourceTrade: trade,
        result: 'failed',
        reason: error,
        executedAt: new Date().toISOString(),
      };
      this.addRecord(record);
      this.emit('trade:failed', record);
    });

    this.bot.on('trade:skipped', ({ trade, reason }) => {
      const record: CopiedTradeRecord = {
        id: this.genId(),
        sourceTrade: trade,
        result: 'skipped',
        reason,
        executedAt: new Date().toISOString(),
      };
      this.addRecord(record);
      this.emit('trade:skipped', record);
    });

    // Volatility strategy events
    this.bot.on('vol:entry', (data) => this.emit('vol:entry', data));
    this.bot.on('vol:entry:failed', (data) => this.emit('vol:entry:failed', data));
    this.bot.on('vol:exit', (data) => this.emit('vol:exit', data));
    this.bot.on('vol:merge', (data) => this.emit('vol:merge', data));

    try {
      await this.bot.initialize();
    } catch (err) {
      this.status = 'stopped';
      this.bot = null;
      throw err;
    }
    this.status = 'running';
    this.startedAt = new Date();

    // Run loop as floating promise — stop() sets isRunning=false to exit it
    this.taskPromise = this.bot.start().then(() => {
      this.status = 'stopped';
      this.startedAt = null;
      this.taskPromise = null;
    }).catch((err) => {
      console.error('Bot loop error:', err);
      this.status = 'stopped';
      this.startedAt = null;
      this.taskPromise = null;
    });
  }

  async stop(): Promise<void> {
    if (!this.bot || this.status === 'stopped') return;
    this.status = 'stopping';
    this.bot.stop();
    if (this.taskPromise) {
      await this.taskPromise;
    }
    this.bot = null;
    this.startedAt = null;
    this.status = 'stopped';
  }

  getStatusPayload(appConfig: AppConfig | null): StatusPayload {
    return {
      status: this.status,
      startedAt: this.startedAt?.toISOString() ?? null,
      stats: this.bot?.getStats() ?? { tradesDetected: 0, tradesCopied: 0, tradesFailed: 0, totalVolume: 0 },
      volatilityStats: this.bot?.getVolatilityStats() ?? null,
      walletAddress: appConfig?.walletAddress ?? '',
      setupComplete: appConfig?.setupComplete ?? false,
    };
  }

  getCopiedTrades(): CopiedTradeRecord[] {
    return [...this.copiedTrades];
  }

  private addRecord(record: CopiedTradeRecord): void {
    this.copiedTrades.unshift(record);
    if (this.copiedTrades.length > this.MAX_RECORDS) {
      this.copiedTrades = this.copiedTrades.slice(0, this.MAX_RECORDS);
    }
  }
}
