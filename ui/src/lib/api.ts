import axios from 'axios';

const api = axios.create({ baseURL: '/api' });

// Attach JWT from localStorage to every request
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// On 401, clear token and reload to trigger auth gate
api.interceptors.response.use(
  (r) => r,
  (err) => {
    if (err.response?.status === 401) {
      localStorage.removeItem('token');
      window.location.href = '/auth';
    }
    return Promise.reject(err);
  },
);

// ── Auth ──────────────────────────────────────────────────────────────────

export const authApi = {
  status: () => api.get<{ passwordSet: boolean }>('/auth/status'),
  setup: (password: string) => api.post('/auth/setup', { password }),
  login: (password: string) => api.post<{ token: string }>('/auth/login', { password }),
  wipe: () => api.post('/auth/wipe'),
};

// ── Wallet ────────────────────────────────────────────────────────────────

export interface WalletGenResult {
  address: string;
  privateKey: string;
  mnemonic: string | null;
  warning: string;
}

export interface WalletBalance {
  walletAddress: string;
  maticBalance: string;
  usdcBalance: string;
}

export const walletApi = {
  generate: (password: string) => api.post<WalletGenResult>('/wallet/generate', { password }),
  import: (privateKey: string, password: string) => api.post<{ address: string }>('/wallet/import', { privateKey, password }),
  export: (password: string) => api.post<{ privateKey: string; address: string; warning: string }>('/wallet/export', { password }),
  balance: () => api.get<WalletBalance>('/wallet/balance'),
};

// ── Config ────────────────────────────────────────────────────────────────

export interface AppConfig {
  walletAddress: string;
  targetWallet: string;
  rpcUrl: string;
  alchemyWsUrl: string;
  useAlchemy: boolean;
  positionMultiplier: number;
  maxTradeSize: number;
  minTradeSize: number;
  slippageTolerance: number;
  orderType: 'FOK' | 'FAK' | 'LIMIT';
  maxSessionNotional: number;
  maxPerMarketNotional: number;
  pollInterval: number;
  useWebSocket: boolean;
  setupComplete: boolean;
  updatedAt: string;
}

export const configApi = {
  get: () => api.get<AppConfig>('/config'),
  update: (data: Partial<AppConfig>) => api.put<AppConfig>('/config', data),
};

// ── Bot ───────────────────────────────────────────────────────────────────

export interface BotStatusPayload {
  status: 'stopped' | 'starting' | 'running' | 'stopping';
  startedAt: string | null;
  stats: { tradesDetected: number; tradesCopied: number; tradesFailed: number; totalVolume: number };
  walletAddress: string;
  setupComplete: boolean;
}

export interface CopiedTradeRecord {
  id: string;
  sourceTrade: TargetTrade;
  result: 'success' | 'failed' | 'skipped';
  reason?: string;
  orderId?: string;
  copyNotional?: number;
  price?: number;
  executedAt: string;
}

export const botApi = {
  status: () => api.get<BotStatusPayload>('/status'),
  start: (password: string) => api.post('/bot/start', { password }),
  stop: () => api.post('/bot/stop'),
  copiedTrades: () => api.get<CopiedTradeRecord[]>('/trades/copied'),
};

// ── Proxy ─────────────────────────────────────────────────────────────────

export interface TargetTrade {
  transactionHash: string;
  timestamp: number;
  conditionId: string;
  asset: string;
  side: string;
  price: string;
  usdcSize: string;
  outcome: string;
  market?: string;
}

export const proxyApi = {
  targetTrades: (limit = 20) => api.get<TargetTrade[]>(`/proxy/target-trades?limit=${limit}`),
  targetPositions: () => api.get('/proxy/target-positions'),
  ownPositions: () => api.get('/proxy/own-positions'),
};
