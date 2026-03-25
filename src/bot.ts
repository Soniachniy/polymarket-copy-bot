import { EventEmitter } from 'events';
import { TradeMonitor } from './monitor.js';
import { WebSocketMonitor } from './websocket-monitor.js';
import { AlchemyMonitor } from './alchemy-monitor.js';
import type { Trade } from './monitor.js';
import { TradeExecutor } from './trader.js';
import { PositionTracker } from './positions.js';
import { RiskManager } from './risk-manager.js';

export interface BotConfig {
  targetWallet: string;
  privateKey: string;
  rpcUrl: string;
  alchemyWsUrl: string;
  useAlchemy: boolean;
  polymarketGeoToken?: string;
  trading: {
    positionSizeMultiplier: number;
    maxTradeSize: number;
    minTradeSize: number;
    slippageTolerance: number;
    orderType: 'LIMIT' | 'FOK' | 'FAK';
  };
  risk: {
    maxSessionNotional: number;
    maxPerMarketNotional: number;
  };
  monitoring: {
    pollInterval: number;
    useWebSocket: boolean;
    useUserChannel: boolean;
    wsAssetIds: string[];
    wsMarketIds: string[];
  };
}

export interface BotStats {
  tradesDetected: number;
  tradesCopied: number;
  tradesFailed: number;
  totalVolume: number;
}

export class PolymarketCopyBot extends EventEmitter {
  private monitor: TradeMonitor;
  private wsMonitor: WebSocketMonitor | undefined;
  private alchemyMonitor: AlchemyMonitor | undefined;
  private executor: TradeExecutor;
  private positions: PositionTracker;
  private risk: RiskManager;
  private isRunning: boolean = false;
  private processedTrades: Set<string> = new Set();
  private botStartTime: number = 0;
  private readonly maxProcessedTrades = 10000;
  private readonly botConfig: BotConfig;
  private stats: BotStats = {
    tradesDetected: 0,
    tradesCopied: 0,
    tradesFailed: 0,
    totalVolume: 0,
  };

  constructor(botConfig: BotConfig) {
    super();
    this.botConfig = botConfig;
    this.monitor = new TradeMonitor(botConfig);
    this.executor = new TradeExecutor(botConfig);
    this.positions = new PositionTracker();
    this.risk = new RiskManager(this.positions, botConfig);
  }

  async initialize(): Promise<void> {
    console.log('🤖 Polymarket Copy Trading Bot');
    console.log('================================');
    console.log(`Target wallet: ${this.botConfig.targetWallet}`);
    console.log(`Position multiplier: ${this.botConfig.trading.positionSizeMultiplier * 100}%`);
    console.log(`Max trade size: ${this.botConfig.trading.maxTradeSize} USDC`);
    console.log(`Order type: ${this.botConfig.trading.orderType}`);
    console.log(`WebSocket: ${this.botConfig.monitoring.useWebSocket ? 'Enabled' : 'Disabled'}`);
    console.log(`   Alchemy WS: ${this.botConfig.useAlchemy ? 'Enabled' : 'Disabled'}`);
    if (this.botConfig.risk.maxSessionNotional > 0 || this.botConfig.risk.maxPerMarketNotional > 0) {
      console.log(`Risk caps: session=${this.botConfig.risk.maxSessionNotional || '∞'} USDC, per-market=${this.botConfig.risk.maxPerMarketNotional || '∞'} USDC`);
    }
    console.log(`Auth mode: EOA (signature type 0)`);
    console.log('================================\n');

    this.botStartTime = Date.now();
    console.log(`⏰ Bot start time: ${new Date(this.botStartTime).toISOString()}`);
    console.log('   (Only trades after this time will be copied)\n');

    await this.monitor.initialize();
    await this.executor.initialize();
    await this.reconcilePositions();

    if (this.botConfig.monitoring.useWebSocket) {
      this.wsMonitor = new WebSocketMonitor();
      try {
        const wsAuth = this.executor.getWsAuth();
        const channel = this.botConfig.monitoring.useUserChannel ? 'user' : 'market';
        await this.wsMonitor.initialize(this.handleNewTrade.bind(this), channel, wsAuth);
        console.log(`✅ WebSocket monitor initialized (${channel} channel)\n`);

        if (channel === 'market' && this.botConfig.monitoring.wsAssetIds.length > 0) {
          for (const assetId of this.botConfig.monitoring.wsAssetIds) {
            await this.wsMonitor.subscribeToMarket(assetId);
          }
        }
        if (channel === 'user' && this.botConfig.monitoring.wsMarketIds.length > 0) {
          for (const marketId of this.botConfig.monitoring.wsMarketIds) {
            await this.wsMonitor.subscribeToCondition(marketId);
          }
        }
      } catch (error) {
        console.error('⚠️  WebSocket initialization failed, falling back to REST API only');
        this.wsMonitor = undefined;
      }
    }

    if (this.botConfig.useAlchemy && this.botConfig.alchemyWsUrl) {
      this.alchemyMonitor = new AlchemyMonitor(this.botConfig);
      try {
        await this.alchemyMonitor.initialize(
          this.handleNewTrade.bind(this),
          this.handleEarlyTx.bind(this),
        );
        console.log('✅ Alchemy monitor initialized (alchemy_pendingTransactions — mempool detection)\n');
      } catch (error) {
        console.error('⚠️  Alchemy monitor initialization failed, continuing without it');
        this.alchemyMonitor = undefined;
      }
    }
  }

  async start(): Promise<void> {
    this.isRunning = true;
    const methods = [];
    if (this.wsMonitor) methods.push('Polymarket WS');
    if (this.alchemyMonitor) methods.push('Alchemy WS');
    methods.push('REST API');

    console.log(`🚀 Bot started! Monitoring via: ${methods.join(' + ')}\n`);

    while (this.isRunning) {
      try {
        await this.monitor.pollForNewTrades(this.handleNewTrade.bind(this));
        this.monitor.pruneProcessedHashes();
      } catch (error) {
        console.error('Error in monitoring loop:', error);
      }
      await this.sleep(this.botConfig.monitoring.pollInterval);
    }
  }

  private async handleNewTrade(trade: Trade): Promise<void> {
    if (trade.timestamp && trade.timestamp < this.botStartTime) return;

    const keys = this.getTradeKeys(trade);
    if (keys.some((k) => this.processedTrades.has(k))) return;
    for (const k of keys) this.processedTrades.add(k);
    this.pruneProcessedTrades();
    this.stats.tradesDetected++;

    this.emit('trade:detected', trade);

    console.log('\n' + '='.repeat(50));
    console.log(`🎯 NEW TRADE DETECTED`);
    console.log(`   Time: ${new Date(trade.timestamp).toISOString()}`);
    console.log(`   Market: ${trade.market}`);
    console.log(`   Side: ${trade.side} ${trade.outcome}`);
    console.log(`   Size: ${trade.size} USDC @ ${trade.price.toFixed(3)}`);
    console.log('='.repeat(50));

    if (trade.side === 'SELL') {
      console.log('⚠️  Skipping SELL trade');
      this.emit('trade:skipped', { trade, reason: 'SELL trades skipped' });
      return;
    }

    if (this.wsMonitor) await this.wsMonitor.subscribeToMarket(trade.tokenId);

    const copyNotional = this.executor.calculateCopySize(trade.size);
    const riskCheck = this.risk.checkTrade(trade, copyNotional);
    if (!riskCheck.allowed) {
      console.log(`⚠️  Risk check blocked trade: ${riskCheck.reason}`);
      this.emit('trade:skipped', { trade, reason: riskCheck.reason });
      return;
    }

    try {
      const result = await this.executor.executeCopyTrade(trade, copyNotional);
      this.risk.recordFill({ trade, notional: result.copyNotional, shares: result.copyShares, price: result.price, side: result.side });
      this.stats.tradesCopied++;
      this.stats.totalVolume += result.copyNotional;
      console.log(`✅ Successfully copied trade!`);
      this.emit('trade:copied', { sourceTrade: trade, result });
    } catch (error: any) {
      this.stats.tradesFailed++;
      console.log(`❌ Failed to copy trade: ${error?.message}`);
      this.emit('trade:failed', { trade, error: error?.message || 'Unknown error' });
    }
  }

  private async handleEarlyTx(txHash: string, from: string, to: string): Promise<void> {
    console.log(`\n⚡ Early mempool signal: ${from.slice(0, 10)}… → ${to.slice(0, 10)}… (${txHash.slice(0, 14)}…)`);
    try {
      await this.monitor.pollForNewTrades(this.handleNewTrade.bind(this));
    } catch (error) {
      console.error('   Early poll failed:', error);
    }
  }

  private async reconcilePositions(): Promise<void> {
    try {
      const positions = await this.executor.getPositions();
      if (!positions || positions.length === 0) {
        console.log('🧾 Positions: none found (fresh session)');
        return;
      }
      const { loaded, skipped } = this.positions.loadFromClobPositions(positions);
      const totalNotional = this.positions.getTotalNotional();
      console.log(`🧾 Positions loaded: ${loaded} (skipped ${skipped}), total notional ≈ ${totalNotional.toFixed(2)} USDC`);
    } catch (error: any) {
      console.log(`🧾 Positions reconciliation failed: ${error.message || 'Unknown error'}`);
    }
  }

  stop(): void {
    this.isRunning = false;
    if (this.wsMonitor) this.wsMonitor.close();
    if (this.alchemyMonitor) this.alchemyMonitor.close();
    console.log('\n🛑 Bot stopped');
    this.printStats();
  }

  getStats(): BotStats {
    return { ...this.stats };
  }

  printStats(): void {
    console.log('\n📊 Session Statistics:');
    console.log(`   Trades detected: ${this.stats.tradesDetected}`);
    console.log(`   Trades copied: ${this.stats.tradesCopied}`);
    console.log(`   Trades failed: ${this.stats.tradesFailed}`);
    console.log(`   Total volume: ${this.stats.totalVolume.toFixed(2)} USDC`);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  private getTradeKeys(trade: Trade): string[] {
    const keys: string[] = [];
    if (trade.txHash) keys.push(trade.txHash);
    keys.push(`${trade.tokenId}|${trade.side}|${trade.size}|${trade.price}|${trade.timestamp}`);
    return keys;
  }

  private pruneProcessedTrades(): void {
    if (this.processedTrades.size <= this.maxProcessedTrades) return;
    const entries = Array.from(this.processedTrades);
    this.processedTrades = new Set(entries.slice(-Math.floor(this.maxProcessedTrades / 2)));
  }
}
