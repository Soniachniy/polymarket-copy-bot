import dotenv from 'dotenv';
dotenv.config();

function parseCsv(value?: string): string[] {
  if (!value) return [];
  return value.split(',').map((v) => v.trim()).filter(Boolean);
}

const useWebSocket = process.env.USE_WEBSOCKET !== 'false';

export const config = {
  targetWallet: process.env.TARGET_WALLET || '',
  privateKey: process.env.PRIVATE_KEY || '',
  polymarketGeoToken: process.env.POLYMARKET_GEO_TOKEN || '',
  rpcUrl: process.env.RPC_URL || 'https://polygon-rpc.com',
  chainId: 137,

  // Polygon mainnet contracts used for approvals and balance checks.
  contracts: {
    exchange: '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E',
    ctf: '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045',
    usdc: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
    negRiskAdapter: '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296',
    negRiskExchange: '0xC5d563A36AE78145C45a50134d48A1215220f80a',
  },

  trading: {
    positionSizeMultiplier: parseFloat(process.env.POSITION_MULTIPLIER || '0.1'),
    maxTradeSize: parseFloat(process.env.MAX_TRADE_SIZE || '100'),
    minTradeSize: parseFloat(process.env.MIN_TRADE_SIZE || '1'),
    slippageTolerance: parseFloat(process.env.SLIPPAGE_TOLERANCE || '0.02'),
    // LIMIT=GTC, FOK=fill-or-kill, FAK=fill-and-kill
    orderType: (process.env.ORDER_TYPE || 'FOK') as 'LIMIT' | 'FOK' | 'FAK',
  },

  risk: {
    maxSessionNotional: parseFloat(process.env.MAX_SESSION_NOTIONAL || '0'),
    maxPerMarketNotional: parseFloat(process.env.MAX_PER_MARKET_NOTIONAL || '0'),
  },

  monitoring: {
    pollInterval: parseInt(process.env.POLL_INTERVAL || '2000'),
    useWebSocket,
    useUserChannel: process.env.USE_USER_CHANNEL === 'true',
    wsAssetIds: parseCsv(process.env.WS_ASSET_IDS),
    wsMarketIds: parseCsv(process.env.WS_MARKET_IDS),
  },

  alchemy: {
    wsUrl: process.env.ALCHEMY_WS_URL || '',
    enabled: process.env.USE_ALCHEMY === 'true',
  },

  volatility: {
    enabled: process.env.VOL_ENABLED === 'true',
    maxEntryCost: parseFloat(process.env.VOL_MAX_ENTRY_COST || '0.97'),
    minVolatility: parseFloat(process.env.VOL_MIN_VOLATILITY || '0.001'),
    strikeProximityPct: parseFloat(process.env.VOL_STRIKE_PROXIMITY_PCT || '2'),
    positionSize: parseFloat(process.env.VOL_POSITION_SIZE || '50'),
    takeProfitPct: parseFloat(process.env.VOL_TAKE_PROFIT_PCT || '15'),
    stopLossPct: parseFloat(process.env.VOL_STOP_LOSS_PCT || '10'),
    mergeTimeThresholdMs: parseInt(process.env.VOL_MERGE_TIME_THRESHOLD_MS || '60000'),
    panicExitSeconds: parseInt(process.env.VOL_PANIC_EXIT_SECONDS || '30'),
    scanIntervalMs: parseInt(process.env.VOL_SCAN_INTERVAL_MS || '60000'),
    cycleIntervalMs: parseInt(process.env.VOL_CYCLE_INTERVAL_MS || '5000'),
    maxOpenPositions: parseInt(process.env.VOL_MAX_OPEN_POSITIONS || '3'),
    minTtlMs: parseInt(process.env.VOL_MIN_TTL_MS || '120000'),
    maxTtlMs: parseInt(process.env.VOL_MAX_TTL_MS || '600000'),
    binanceSymbol: process.env.VOL_BINANCE_SYMBOL || 'btcusdt',
    binanceApiKey: process.env.BINANCE_API_KEY || '',
  },
  gmm: {
    enabled: process.env.GMM_ENABLED === 'true',
    gridLevels: parseInt(process.env.GMM_GRID_LEVELS || '2'),
    gridSpacingCents: parseInt(process.env.GMM_GRID_SPACING_CENTS || '3'),
    sharesPerLevel: parseFloat(process.env.GMM_SHARES_PER_LEVEL || '5'),
    maxBudgetUsdc: parseFloat(process.env.GMM_MAX_BUDGET || '5'),
    reserveUsdc: parseFloat(process.env.GMM_RESERVE || '1'),
    requoteIntervalMs: parseInt(process.env.GMM_REQUOTE_MS || '10000'),
    scanIntervalMs: parseInt(process.env.GMM_SCAN_MS || '15000'),
    maxInventoryPerSide: parseInt(process.env.GMM_MAX_INVENTORY || '20'),
    mergeThreshold: parseFloat(process.env.GMM_MERGE_THRESHOLD || '5'),
    inventorySkewFactor: parseFloat(process.env.GMM_SKEW_FACTOR || '0.5'),
    unwindBeforeExpirySec: parseInt(process.env.GMM_UNWIND_SEC || '30'),
    sessionLossLimitUsdc: parseFloat(process.env.GMM_LOSS_LIMIT || '2'),
    preferUpdown: process.env.GMM_PREFER_UPDOWN !== 'false',
    minTtlMs: parseInt(process.env.GMM_MIN_TTL_MS || '60000'),
    symbol: (process.env.GMM_SYMBOL || 'btcusdt').toLowerCase(),
  },
};

export function validateConfig(): void {
  const required = ['targetWallet', 'privateKey'];
  for (const key of required) {
    if (!config[key as keyof typeof config]) {
      throw new Error(`Missing required config: ${key}`);
    }
  }

  console.log('ℹ️  API credentials will be derived/generated from PRIVATE_KEY at startup');

  console.log('✅ Configuration validated');
  console.log(`   Auth: EOA (signature type 0)`);
}
