import WebSocket from 'ws';
import { config } from './config.js';
import type { Trade } from './monitor.js';

/**
 * AlchemyMonitor
 *
 * Subscribes to `alchemy_pendingTransactions` via Alchemy's WebSocket endpoint.
 *
 * Filter applied at subscription time:
 *   fromAddress — TARGET_WALLET (the wallet being copy-traded)
 *   toAddress   — CTF Exchange + NegRisk Exchange contracts
 *   hashesOnly  — false  →  full tx objects received
 *
 * On each pending tx:
 *   1. `onEarlyTx` callback fires → index.ts triggers an immediate REST poll,
 *      bypassing the POLL_INTERVAL wait.  This is the primary speed benefit.
 *   2. Full tx object is available for further calldata decoding if needed.
 *
 * Why this approach over eth_subscribe logs:
 *   - Fires at mempool level (before block confirmation, ~2 s faster on Polygon)
 *   - Native address-level filter eliminates scanning all exchange logs
 *   - Pairs naturally with the REST poller which returns clean Polymarket trade metadata
 *
 * Note: Polymarket's CLOB settles orders via its own infrastructure, so most CLOB
 * fills arrive via the Polymarket WS or REST poller.  alchemy_pendingTransactions
 * catches direct on-chain interactions from the target wallet (merges, redeems,
 * direct fills) and acts as an early-trigger for the REST poll.
 */

// Exchange contract addresses — normalised to lowercase for comparison
const EXCHANGE_ADDRESSES = new Set<string>([
  config.contracts.exchange.toLowerCase(),
  config.contracts.negRiskExchange.toLowerCase(),
]);

export class AlchemyMonitor {
  private readonly alchemyWsUrl: string;
  private readonly targetWallet: string;
  private ws: WebSocket | null = null;
  private subscriptionId: string | null = null;
  private onTradeCallback?: (trade: Trade) => Promise<void>;
  private onEarlyTxCallback?: (txHash: string, from: string, to: string) => Promise<void>;
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = 10;
  private readonly reconnectBaseDelay = 1000;
  private isConnected = false;
  private pingInterval: NodeJS.Timeout | null = null;
  private reqId = 1;

  // Dedup for pending txs — Alchemy may re-emit the same hash as price/nonce changes
  private seenPendingTxs = new Set<string>();
  private readonly maxSeenTxs = 5000;

  constructor(cfg?: { alchemyWsUrl: string; targetWallet: string }) {
    this.alchemyWsUrl = cfg?.alchemyWsUrl ?? config.alchemy.wsUrl;
    this.targetWallet = cfg?.targetWallet ?? config.targetWallet;
  }

  /**
   * @param onTrade     - Standard trade callback (shared with all monitor sources)
   * @param onEarlyTx   - Optional callback fired on mempool detection; use to trigger
   *                      an immediate REST poll in index.ts
   */
  async initialize(
    onTrade: (trade: Trade) => Promise<void>,
    onEarlyTx?: (txHash: string, from: string, to: string) => Promise<void>,
  ): Promise<void> {
    this.onTradeCallback = onTrade;
    if (onEarlyTx !== undefined) {
      this.onEarlyTxCallback = onEarlyTx;
    }
    await this.connect();
  }

  private getWsUrl(): string {
    if (!this.alchemyWsUrl) {
      throw new Error(
        'ALCHEMY_WS_URL is required when USE_ALCHEMY=true.\n' +
        'Set it in .env:  ALCHEMY_WS_URL=wss://polygon-mainnet.g.alchemy.com/v2/<API_KEY>',
      );
    }
    return this.alchemyWsUrl;
  }

  private async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = this.getWsUrl();
      console.log('🔌 Connecting to Alchemy WebSocket (Polygon)...');
      this.ws = new WebSocket(url);

      const timeout = setTimeout(() => {
        if (!this.isConnected) {
          reject(new Error('Alchemy WebSocket connection timeout (10 s)'));
        }
      }, 10_000);

      this.ws.on('open', () => {
        clearTimeout(timeout);
        this.isConnected = true;
        this.reconnectAttempts = 0;
        console.log('✅ Alchemy WebSocket connected');
        this.subscribeToPendingTransactions();
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

  /**
   * Send alchemy_pendingTransactions subscription.
   *
   * Request shape (per Alchemy docs):
   * {
   *   jsonrpc: "2.0",
   *   id: <n>,
   *   method: "eth_subscribe",
   *   params: [
   *     "alchemy_pendingTransactions",
   *     {
   *       fromAddress: "<TARGET_WALLET>",          // address we are copy-trading
   *       toAddress:   ["<CTF>", "<NEGRISK>"],     // Polymarket exchange contracts
   *       hashesOnly:  false                       // receive full tx objects
   *     }
   *   ]
   * }
   *
   * Max 1 000 addresses allowed per filter per Alchemy docs.
   */
  private subscribeToPendingTransactions(): void {
    if (!this.ws) return;

    const targetWallet = this.targetWallet.toLowerCase();

    const req = {
      jsonrpc: '2.0',
      id: this.reqId++,
      method: 'eth_subscribe',
      params: [
        'alchemy_pendingTransactions',
        {
          fromAddress: targetWallet,
          toAddress: Array.from(EXCHANGE_ADDRESSES),
          hashesOnly: false,
        },
      ],
    };

    this.ws.send(JSON.stringify(req));
    console.log(`📡 Alchemy: subscribed to pending txns`);
    console.log(`   fromAddress : ${targetWallet}`);
    console.log(`   toAddress   : CTF Exchange + NegRisk Exchange`);
  }

  private handleMessage(raw: string): void {
    try {
      const msg = JSON.parse(raw);

      // Subscription confirmation  →  { id, result: "0x<subId>" }
      if (msg.id && typeof msg.result === 'string' && !msg.params) {
        this.subscriptionId = msg.result;
        console.log(`📡 Alchemy alchemy_pendingTransactions subscription active: ${this.subscriptionId}`);
        return;
      }

      // Event push  →  { method: "eth_subscription", params: { subscription, result: tx } }
      if (msg.method === 'eth_subscription' && msg.params?.result) {
        this.handlePendingTx(msg.params.result).catch((err) =>
          console.error('Error handling Alchemy pending tx:', err),
        );
      }
    } catch {
      // ignore unparseable frames (e.g. plain pings)
    }
  }

  /**
   * Process a full pending transaction object received from Alchemy.
   *
   * tx fields used:
   *   tx.hash  — transaction hash (for dedup)
   *   tx.from  — sender address (validated == targetWallet)
   *   tx.to    — recipient address (validated in EXCHANGE_ADDRESSES)
   *   tx.input — calldata (available for future decoding if needed)
   */
  private async handlePendingTx(tx: any): Promise<void> {
    const txHash: string = tx.hash ?? '';
    const from: string  = (tx.from ?? '').toLowerCase();
    const to: string    = (tx.to   ?? '').toLowerCase();

    if (!txHash) return;

    // Alchemy can re-send the same pending tx when gas price bumps —
    // deduplicate to avoid flooding the REST poller.
    if (this.seenPendingTxs.has(txHash)) return;
    this.seenPendingTxs.add(txHash);
    this.pruneSeen();

    // Belt-and-suspenders: the subscription filter already enforces these,
    // but double-check here in case of any relay quirks.
    const targetLower = this.targetWallet.toLowerCase();
    if (from !== targetLower) return;
    if (!EXCHANGE_ADDRESSES.has(to)) return;

    console.log(
      `⚡ Alchemy mempool: ${from.slice(0, 10)}… → ${to.slice(0, 10)}… ` +
      `tx=${txHash.slice(0, 14)}…`,
    );

    // Fire early-tx callback so index.ts can trigger an immediate REST poll.
    // The REST poll returns the full Polymarket trade object (outcome, market, etc.).
    if (this.onEarlyTxCallback) {
      await this.onEarlyTxCallback(txHash, from, to);
    }
  }

  private pruneSeen(): void {
    if (this.seenPendingTxs.size > this.maxSeenTxs) {
      const entries = Array.from(this.seenPendingTxs);
      this.seenPendingTxs = new Set(entries.slice(-Math.floor(this.maxSeenTxs / 2)));
    }
  }

  // ─── Lifecycle helpers ────────────────────────────────────────────────────

  private startPing(): void {
    this.pingInterval = setInterval(() => {
      if (this.ws && this.isConnected) {
        this.ws.ping();
      }
    }, 30_000);
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
      `🔄 Alchemy reconnecting in ${delay / 1000}s ` +
      `(attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})…`,
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

  getConnectionStatus(): {
    connected: boolean;
    subscriptionId: string | null;
    reconnectAttempts: number;
    seenPendingTxs: number;
  } {
    return {
      connected: this.isConnected,
      subscriptionId: this.subscriptionId,
      reconnectAttempts: this.reconnectAttempts,
      seenPendingTxs: this.seenPendingTxs.size,
    };
  }
}
