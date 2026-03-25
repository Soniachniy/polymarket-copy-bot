import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'fs';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';
import { join } from 'path';
import type { BotConfig } from './bot.js';

const DATA_DIR = process.env.DATA_DIR ?? '/data';
const CONFIG_PATH = join(DATA_DIR, 'config.json');
const AUTH_PATH = join(DATA_DIR, 'auth.json');

// ── jwtSecret lives in memory only — never written to disk ─────────────────
// Regenerated each startup. Existing sessions are invalidated on container restart,
// which is intentional: someone reading the volume cannot forge tokens.
let _runtimeJwtSecret: string | null = null;

export function getJwtSecret(): string {
  if (!_runtimeJwtSecret) {
    _runtimeJwtSecret = randomBytes(32).toString('hex');
  }
  return _runtimeJwtSecret;
}

export interface AppConfig {
  encryptedPrivateKey: string;
  walletAddress: string;
  targetWallet: string;
  rpcUrl: string;
  alchemyWsUrl: string;
  useAlchemy: boolean;
  polymarketGeoToken: string;
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
  createdAt: string;
  updatedAt: string;
}

export interface AuthData {
  passwordHash: string;
  createdAt: string;
}

const DEFAULTS: Omit<AppConfig, 'encryptedPrivateKey' | 'walletAddress' | 'createdAt' | 'updatedAt'> = {
  targetWallet: '',
  rpcUrl: 'https://polygon-rpc.com',
  alchemyWsUrl: '',
  useAlchemy: true,
  polymarketGeoToken: '',
  positionMultiplier: 0.1,
  maxTradeSize: 100,
  minTradeSize: 1,
  slippageTolerance: 0.02,
  orderType: 'FOK',
  maxSessionNotional: 0,
  maxPerMarketNotional: 0,
  pollInterval: 2000,
  useWebSocket: true,
  setupComplete: false,
};

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  }
}

export function loadConfig(): AppConfig | null {
  try {
    if (!existsSync(CONFIG_PATH)) return null;
    const raw = readFileSync(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw) as Partial<AppConfig> & { jwtSecret?: string };
    // Strip legacy jwtSecret if it was previously persisted
    delete parsed.jwtSecret;
    return { ...DEFAULTS, encryptedPrivateKey: '', walletAddress: '', createdAt: '', updatedAt: '', ...parsed } as AppConfig;
  } catch {
    return null;
  }
}

export function saveConfig(partial: Partial<AppConfig> & { jwtSecret?: string }): AppConfig {
  ensureDataDir();
  // Never persist jwtSecret to disk
  const { jwtSecret: _ignored, ...safePart } = partial;
  const existing = loadConfig() ?? {
    ...DEFAULTS,
    encryptedPrivateKey: '',
    walletAddress: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const updated: AppConfig = {
    ...existing,
    ...safePart,
    updatedAt: new Date().toISOString(),
  };
  // 0o600: only the owning process can read/write — not world-readable
  writeFileSync(CONFIG_PATH, JSON.stringify(updated, null, 2), { encoding: 'utf8', mode: 0o600 });
  return updated;
}

export function loadAuth(): AuthData | null {
  try {
    if (!existsSync(AUTH_PATH)) return null;
    return JSON.parse(readFileSync(AUTH_PATH, 'utf8')) as AuthData;
  } catch {
    return null;
  }
}

export function saveAuth(data: AuthData): void {
  ensureDataDir();
  // 0o600: password hash is sensitive — owner-only
  writeFileSync(AUTH_PATH, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
}

// ── Private key encryption (AES-256-GCM + scrypt) ─────────────────────────
// scrypt params: N=131072 (2^17), r=8, p=1 — ~0.5-1s per attempt on modern hardware,
// making offline brute-force of the encrypted key infeasible with weak passwords.

const SCRYPT_PARAMS = { N: 131072, r: 8, p: 1 };

interface EncryptedBlob {
  iv: string;
  salt: string;
  authTag: string;
  ciphertext: string;
  v: number; // version — allows future migration
}

function deriveKey(password: string, salt: Buffer): Buffer {
  return scryptSync(password, salt, 32, SCRYPT_PARAMS) as Buffer;
}

export function encryptPrivateKey(privateKey: string, password: string): string {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = deriveKey(password, salt);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(privateKey, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const blob: EncryptedBlob = {
    iv: iv.toString('base64'),
    salt: salt.toString('base64'),
    authTag: authTag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    v: 2,
  };
  return Buffer.from(JSON.stringify(blob)).toString('base64');
}

export function decryptPrivateKey(encrypted: string, password: string): string {
  const blob = JSON.parse(Buffer.from(encrypted, 'base64').toString('utf8')) as EncryptedBlob;
  const salt = Buffer.from(blob.salt, 'base64');
  const iv = Buffer.from(blob.iv, 'base64');
  const authTag = Buffer.from(blob.authTag, 'base64');
  const ciphertext = Buffer.from(blob.ciphertext, 'base64');
  // Support v1 blobs (legacy default scrypt params) alongside v2
  const params = blob.v === 2 ? SCRYPT_PARAMS : {};
  const key = scryptSync(password, salt, 32, params) as Buffer;
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(ciphertext) + decipher.final('utf8');
}

// ── Convert AppConfig → BotConfig shape expected by PolymarketCopyBot ─────

export function toBotConfig(appConfig: AppConfig, privateKey: string): BotConfig {
  const contracts = {
    exchange: '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E',
    ctf: '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045',
    usdc: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
    negRiskAdapter: '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296',
    negRiskExchange: '0xC5d563A36AE78145C45a50134d48A1215220f80a',
  };

  return {
    targetWallet: appConfig.targetWallet,
    privateKey,
    rpcUrl: appConfig.rpcUrl,
    alchemyWsUrl: appConfig.alchemyWsUrl,
    useAlchemy: appConfig.useAlchemy,
    polymarketGeoToken: appConfig.polymarketGeoToken,
    trading: {
      positionSizeMultiplier: appConfig.positionMultiplier,
      maxTradeSize: appConfig.maxTradeSize,
      minTradeSize: appConfig.minTradeSize,
      slippageTolerance: appConfig.slippageTolerance,
      orderType: appConfig.orderType,
    },
    risk: {
      maxSessionNotional: appConfig.maxSessionNotional,
      maxPerMarketNotional: appConfig.maxPerMarketNotional,
    },
    monitoring: {
      pollInterval: appConfig.pollInterval,
      useWebSocket: appConfig.useWebSocket,
      useUserChannel: false,
      wsAssetIds: [],
      wsMarketIds: [],
    },
    contracts,
  } as unknown as BotConfig;
}

// ── Wipe all persisted data (reset to factory state) ───────────────────────

export function wipeAllData(): void {
  if (existsSync(CONFIG_PATH)) unlinkSync(CONFIG_PATH);
  if (existsSync(AUTH_PATH)) unlinkSync(AUTH_PATH);
  _runtimeJwtSecret = null; // force new secret on next getJwtSecret() call
}
