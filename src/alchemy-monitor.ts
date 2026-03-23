import WebSocket from 'ws';
import { ethers } from 'ethers';
import { config } from './config.js';
import type { Trade } from './monitor.js';

// OrderFilled(bytes32,address,address,uint256,uint256,uint256,uint256,uint256)
const ORDER_FILLED_TOPIC = ethers.utils.id(
  'OrderFilled(bytes32,address,address,uint256,uint256,uint256,uint256,uint256)'
);

// USDC collateral is represented as assetId = 0 in Polymarket's CTF Exchange
const USDC_ASSET_ID = ethers.BigNumber.from(0);

export class AlchemyMonitor {
  private ws: WebSocket | null = null;
  private subscriptionId: string | null = null;
  private onTradeCallback?: (trade: Trade) => Promise<void>;
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = 10;
  private readonly reconnectBaseDelay = 1000;
  private isConnected = false;
  private pingInterval: NodeJS.Timeout | null = null;
  private reqId = 1;

  async initialize(onTrade: (trade: Trade) => Promise<void>): Promise<void> {
    this.onTradeCallback = onTrade;
    await this.connect();
  }

  private getWsUrl(): string {
    if (!config.alchemy.wsUrl) {
      throw new Error('ALCHEMY_WS_URL is required. Set it in .env');
    }
    return config.alchemy.wsUrl;
  }

  private async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = this.getWsUrl();
      console.log('🔌 Connecting to Alchemy WebSocket (Polygon)...');
      this.ws = new WebSocket(url);

      const timeout = setTimeout(() => {
        if (!this.isConnected) {
          reject(new Error('Alchemy WebSocket connection timeout'));
        }
      }, 10000);

      this.ws.on('open', () => {
        clearTimeout(timeout);
        this.isConnected = true;
        this.reconnectAttempts = 0;
        console.log('✅ Alchemy WebSocket connected');
        this.subscribeToLogs();
        this.startPing();
        resolve();
      });

      this.ws.on('message', (data: WebSocket.Data) => {
        this.handleMessage(data.toString());
      });

      this.ws.on('close', (code: number) => {
        clearTimeout(timeout);
        console.log(`❌ Alchemy WebSocket disconnected (code=${code})`);
        this.isConnected = false;
        this.subscriptionId = null;
        this.ws = null;
        this.stopPing();
        this.scheduleReconnect();
      });

      this.ws.on('error', (err: Error) => {
        clearTimeout(timeout);
        console.error('Alchemy WebSocket error:', err.message);
        if (!this.isConnected) {
          reject(err);
        }
      });
    });
  }

  private subscribeToLogs(): void {
    if (!this.ws) return;

    const req = {
      jsonrpc: '2.0',
      id: this.reqId++,
      method: 'eth_subscribe',
      params: [
        'logs',
        {
          address: [
            config.contracts.exchange,
            config.contracts.negRiskExchange,
          ],
          topics: [ORDER_FILLED_TOPIC],
        },
      ],
    };

    this.ws.send(JSON.stringify(req));
    console.log('📡 Alchemy: subscribed to CTF Exchange OrderFilled logs');
  }

  private handleMessage(raw: string): void {
    try {
      const msg = JSON.parse(raw);

      // Subscription confirmation: { id, result: "0x..." }
      if (msg.id && typeof msg.result === 'string' && !msg.params) {
        this.subscriptionId = msg.result;
        console.log(`📡 Alchemy subscription active: ${this.subscriptionId}`);
        return;
      }

      // Event push: { method: "eth_subscription", params: { subscription, result: log } }
      if (msg.method === 'eth_subscription' && msg.params?.result) {
        this.handleLog(msg.params.result).catch((err) =>
          console.error('Error handling Alchemy log:', err)
        );
      }
    } catch {
      // ignore unparseable frames
    }
  }

  private async handleLog(log: any): Promise<void> {
    if (!Array.isArray(log.topics) || log.topics.length < 4) return;
    if (log.topics[0]?.toLowerCase() !== ORDER_FILLED_TOPIC.toLowerCase()) return;

    // Decode indexed fields
    // topics[1] = orderHash (bytes32)
    // topics[2] = maker (address, zero-padded to 32 bytes)
    // topics[3] = taker (address, zero-padded to 32 bytes)
    const maker = ('0x' + log.topics[2].slice(26)).toLowerCase();
    const taker = ('0x' + log.topics[3].slice(26)).toLowerCase();

    const targetLower = config.targetWallet.toLowerCase();
    if (maker !== targetLower && taker !== targetLower) {
      return;
    }

    // Decode non-indexed data: makerAssetId, takerAssetId, makerAmountFilled, takerAmountFilled, fee
    let decoded: ethers.utils.Result;
    try {
      decoded = ethers.utils.defaultAbiCoder.decode(
        ['uint256', 'uint256', 'uint256', 'uint256', 'uint256'],
        log.data
      );
    } catch {
      console.error('Alchemy: failed to decode OrderFilled log data');
      return;
    }

    const [makerAssetId, takerAssetId, makerAmountFilled, takerAmountFilled] = decoded;

    // Determine trade direction from target's perspective
    // assetId = 0 means USDC (collateral); non-zero = conditional token (YES/NO share)
    const isMaker = maker === targetLower;

    let side: 'BUY' | 'SELL';
    let tokenId: string;
    let usdcAmount: ethers.BigNumber;
    let tokenAmount: ethers.BigNumber;

    if (isMaker) {
      if (makerAssetId.eq(USDC_ASSET_ID)) {
        // target gave USDC → BUY
        side = 'BUY';
        tokenId = takerAssetId.toString();
        usdcAmount = makerAmountFilled;
        tokenAmount = takerAmountFilled;
      } else {
        // target gave conditional tokens → SELL
        side = 'SELL';
        tokenId = makerAssetId.toString();
        usdcAmount = takerAmountFilled;
        tokenAmount = makerAmountFilled;
      }
    } else {
      // target is taker
      if (takerAssetId.eq(USDC_ASSET_ID)) {
        // target gave USDC → BUY
        side = 'BUY';
        tokenId = makerAssetId.toString();
        usdcAmount = takerAmountFilled;
        tokenAmount = makerAmountFilled;
      } else {
        // target gave conditional tokens → SELL
        side = 'SELL';
        tokenId = takerAssetId.toString();
        usdcAmount = makerAmountFilled;
        tokenAmount = takerAmountFilled;
      }
    }

    // USDC has 6 decimals; CTF tokens also use 6 decimals on Polygon
    const usdcFloat = parseFloat(ethers.utils.formatUnits(usdcAmount, 6));
    const tokenFloat = parseFloat(ethers.utils.formatUnits(tokenAmount, 6));
    const price = tokenFloat > 0 ? usdcFloat / tokenFloat : 0;

    const trade: Trade = {
      txHash: log.transactionHash || `alchemy-${log.blockNumber}-${Date.now()}`,
      timestamp: Date.now(), // block timestamp requires extra RPC call; REST poll will reconcile
      market: log.address,
      tokenId,
      side,
      price,
      size: usdcFloat,
      outcome: 'UNKNOWN', // YES/NO mapping requires Polymarket API lookup
    };

    console.log(
      `⚡ Alchemy on-chain trade: ${trade.side} ${trade.size.toFixed(2)} USDC @ ${trade.price.toFixed(3)} (token: ${tokenId.slice(0, 10)}...)`
    );

    if (this.onTradeCallback) {
      await this.onTradeCallback(trade);
    }
  }

  private startPing(): void {
    this.pingInterval = setInterval(() => {
      if (this.ws && this.isConnected) {
        this.ws.ping();
      }
    }, 30000);
  }

  private stopPing(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('❌ Alchemy: max reconnect attempts reached. Giving up.');
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectBaseDelay * Math.pow(2, this.reconnectAttempts - 1);
    console.log(
      `🔄 Alchemy reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})...`
    );

    setTimeout(async () => {
      try {
        await this.connect();
      } catch (err) {
        console.error('Alchemy reconnection failed:', err);
        this.scheduleReconnect();
      }
    }, delay);
  }

  close(): void {
    this.stopPing();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.isConnected = false;
    console.log('🔌 Alchemy WebSocket closed');
  }

  getConnectionStatus(): { connected: boolean; subscriptionId: string | null; reconnectAttempts: number } {
    return {
      connected: this.isConnected,
      subscriptionId: this.subscriptionId,
      reconnectAttempts: this.reconnectAttempts,
    };
  }
}
