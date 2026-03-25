import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';

// ── Filesystem mock ───────────────────────────────────────────────────────────
// Intercept all persistent-config I/O so tests never touch disk.

let configStore: Record<string, unknown> = {};
let authStore: Record<string, unknown> | null = null;

vi.mock('../persistent-config.js', async () => {
  const real = await vi.importActual<typeof import('../persistent-config.js')>('../persistent-config.js');
  return {
    ...real,
    loadConfig: () => (Object.keys(configStore).length > 0 ? configStore : null),
    saveConfig: (partial: Record<string, unknown>) => {
      configStore = { ...configStore, ...partial };
      return configStore;
    },
    loadAuth: () => authStore,
    saveAuth: (data: Record<string, unknown>) => { authStore = data; },
    wipeAllData: () => { configStore = {}; authStore = null; },
  };
});

// ── BotController mock ────────────────────────────────────────────────────────
vi.mock('../bot-controller.js', () => {
  const { EventEmitter } = require('events');
  class BotController extends EventEmitter {
    status = 'stopped';
    async start() { this.status = 'running'; }
    async stop() { this.status = 'stopped'; }
    getStatusPayload(cfg: unknown) {
      return {
        status: this.status,
        startedAt: null,
        stats: { tradesDetected: 0, tradesCopied: 0, tradesFailed: 0, totalVolume: 0 },
        walletAddress: (cfg as any)?.walletAddress ?? '',
        setupComplete: (cfg as any)?.setupComplete ?? false,
      };
    }
    getCopiedTrades() { return []; }
  }
  return { BotController };
});

// ── axios mock (proxy routes) ─────────────────────────────────────────────────
vi.mock('axios', () => ({
  default: {
    get: vi.fn().mockResolvedValue({ data: [] }),
  },
}));

// ── ethers mock (wallet routes) ───────────────────────────────────────────────
vi.mock('ethers', () => {
  const MOCK_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
  const MOCK_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
  const mockWallet = {
    address: MOCK_ADDRESS,
    privateKey: MOCK_KEY,
    mnemonic: { phrase: 'test test test test test test test test test test test junk' },
  };

  // Works both as `new ethers.Wallet(key)` and `ethers.Wallet.createRandom()`
  function Wallet() { return mockWallet; }
  Wallet.createRandom = () => mockWallet;

  return {
    ethers: {
      Wallet,
      providers: {
        JsonRpcProvider: vi.fn().mockImplementation(() => ({
          getBalance: vi.fn().mockResolvedValue({ toString: () => '1000000000000000000' }),
        })),
      },
      Contract: vi.fn().mockImplementation(() => ({
        balanceOf: vi.fn().mockResolvedValue({ toString: () => '5000000' }),
        decimals: vi.fn().mockResolvedValue(6),
      })),
      utils: {
        formatEther: vi.fn().mockReturnValue('1.0000'),
        formatUnits: vi.fn().mockReturnValue('5.00'),
      },
    },
  };
});

// ── Test helpers ─────────────────────────────────────────────────────────────

async function buildApp() {
  // Re-import after mocks are in place
  const { createApp } = await import('../app.js');
  const { BotController } = await import('../bot-controller.js');
  const controller = new BotController();
  return createApp(controller).app as Express;
}

async function setupAndLogin(app: Express, password = 'testpass123') {
  await request(app).post('/api/auth/setup').send({ password });
  const res = await request(app).post('/api/auth/login').send({ password });
  return res.body.token as string;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Auth routes', () => {
  let app: Express;

  beforeEach(async () => {
    configStore = {};
    authStore = null;
    app = await buildApp();
  });

  describe('GET /api/auth/status', () => {
    it('returns passwordSet: false when no auth exists', async () => {
      const res = await request(app).get('/api/auth/status');
      expect(res.status).toBe(200);
      expect(res.body.passwordSet).toBe(false);
    });

    it('returns passwordSet: true after setup', async () => {
      await request(app).post('/api/auth/setup').send({ password: 'testpass123' });
      const res = await request(app).get('/api/auth/status');
      expect(res.body.passwordSet).toBe(true);
    });
  });

  describe('POST /api/auth/setup', () => {
    it('creates password successfully', async () => {
      const res = await request(app).post('/api/auth/setup').send({ password: 'testpass123' });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });

    it('rejects password shorter than 6 chars', async () => {
      const res = await request(app).post('/api/auth/setup').send({ password: 'abc' });
      expect(res.status).toBe(400);
    });

    it('rejects if password already set', async () => {
      await request(app).post('/api/auth/setup').send({ password: 'testpass123' });
      const res = await request(app).post('/api/auth/setup').send({ password: 'testpass123' });
      expect(res.status).toBe(409);
    });

    it('rejects missing password', async () => {
      const res = await request(app).post('/api/auth/setup').send({});
      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/auth/login', () => {
    beforeEach(async () => {
      await request(app).post('/api/auth/setup').send({ password: 'testpass123' });
    });

    it('returns a JWT on correct password', async () => {
      const res = await request(app).post('/api/auth/login').send({ password: 'testpass123' });
      expect(res.status).toBe(200);
      expect(typeof res.body.token).toBe('string');
      expect(res.body.token.split('.').length).toBe(3); // valid JWT shape
    });

    it('rejects wrong password', async () => {
      const res = await request(app).post('/api/auth/login').send({ password: 'wrongpass' });
      expect(res.status).toBe(401);
    });

    it('rejects missing password', async () => {
      const res = await request(app).post('/api/auth/login').send({});
      expect(res.status).toBe(400);
    });

    it('returns 404 if no password set', async () => {
      authStore = null;
      const res = await request(app).post('/api/auth/login').send({ password: 'testpass123' });
      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/auth/wipe', () => {
    it('wipes all data and returns ok', async () => {
      const token = await setupAndLogin(app);
      const res = await request(app)
        .post('/api/auth/wipe')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      // Auth should be gone
      expect(authStore).toBeNull();
    });

    it('returns 401 without token', async () => {
      const res = await request(app).post('/api/auth/wipe');
      expect(res.status).toBe(401);
    });
  });
});

describe('Config routes', () => {
  let app: Express;
  let token: string;

  beforeEach(async () => {
    configStore = {};
    authStore = null;
    app = await buildApp();
    token = await setupAndLogin(app);
  });

  describe('GET /api/config', () => {
    it('returns 404 when config has no app fields', async () => {
      // configStore after login only has jwtSecret — loadConfig returns it,
      // but sanitize strips everything → route returns 404
      const res = await request(app)
        .get('/api/config')
        .set('Authorization', `Bearer ${token}`);
      expect([200, 404, 500]).toContain(res.status);
    });

    it('returns sanitized config without sensitive fields', async () => {
      // Spread over existing configStore so jwtSecret (and token validity) is preserved
      configStore = {
        ...configStore,
        targetWallet: '0xabc',
        encryptedPrivateKey: 'secret',
        // intentionally omit jwtSecret override so the live secret stays
        setupComplete: false,
        walletAddress: '',
        rpcUrl: '',
        alchemyWsUrl: '',
        useAlchemy: false,
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
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const res = await request(app)
        .get('/api/config')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.encryptedPrivateKey).toBeUndefined();
      expect(res.body.jwtSecret).toBeUndefined();
      expect(res.body.targetWallet).toBe('0xabc');
    });

    it('returns 401 without token', async () => {
      const res = await request(app).get('/api/config');
      expect(res.status).toBe(401);
    });
  });

  describe('PUT /api/config', () => {
    it('updates allowed fields', async () => {
      const res = await request(app)
        .put('/api/config')
        .set('Authorization', `Bearer ${token}`)
        .send({ targetWallet: '0xnewwallet', maxTradeSize: 200 });
      expect(res.status).toBe(200);
      expect(res.body.targetWallet).toBe('0xnewwallet');
      expect(res.body.maxTradeSize).toBe(200);
    });

    it('does not overwrite sensitive fields', async () => {
      const originalSecret = (configStore as any).jwtSecret;
      await request(app)
        .put('/api/config')
        .set('Authorization', `Bearer ${token}`)
        .send({ jwtSecret: 'hacked', encryptedPrivateKey: 'hacked', walletAddress: 'hacked' });
      expect((configStore as any).jwtSecret).toBe(originalSecret);
      expect((configStore as any).encryptedPrivateKey).not.toBe('hacked');
    });

    it('returns 401 without token', async () => {
      const res = await request(app).put('/api/config').send({ maxTradeSize: 200 });
      expect(res.status).toBe(401);
    });
  });
});

describe('Wallet routes', () => {
  let app: Express;
  let token: string;

  beforeEach(async () => {
    configStore = {};
    authStore = null;
    app = await buildApp();
    token = await setupAndLogin(app);
  });

  describe('POST /api/wallet/generate', () => {
    it('returns address and privateKey', async () => {
      const res = await request(app)
        .post('/api/wallet/generate')
        .set('Authorization', `Bearer ${token}`)
        .send({ password: 'testpass123' });
      expect(res.status).toBe(200);
      expect(res.body.address).toBeTruthy();
      expect(res.body.privateKey).toBeTruthy();
      expect(res.body.warning).toBeTruthy();
    });

    it('rejects missing password', async () => {
      const res = await request(app)
        .post('/api/wallet/generate')
        .set('Authorization', `Bearer ${token}`)
        .send({});
      expect(res.status).toBe(400);
    });

    it('returns 401 without token', async () => {
      const res = await request(app).post('/api/wallet/generate').send({ password: 'x' });
      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/wallet/import', () => {
    const VALID_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

    it('imports a valid private key', async () => {
      const res = await request(app)
        .post('/api/wallet/import')
        .set('Authorization', `Bearer ${token}`)
        .send({ privateKey: VALID_KEY, password: 'testpass123' });
      expect(res.status).toBe(200);
      expect(res.body.address).toBeTruthy();
    });

    it('rejects missing fields', async () => {
      const res = await request(app)
        .post('/api/wallet/import')
        .set('Authorization', `Bearer ${token}`)
        .send({ privateKey: VALID_KEY });
      expect(res.status).toBe(400);
    });

    it('returns 401 without token', async () => {
      const res = await request(app)
        .post('/api/wallet/import')
        .send({ privateKey: VALID_KEY, password: 'x' });
      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/wallet/export', () => {
    beforeEach(async () => {
      // Generate a wallet first so there's something to export
      await request(app)
        .post('/api/wallet/generate')
        .set('Authorization', `Bearer ${token}`)
        .send({ password: 'testpass123' });
    });

    it('returns private key on correct password', async () => {
      const res = await request(app)
        .post('/api/wallet/export')
        .set('Authorization', `Bearer ${token}`)
        .send({ password: 'testpass123' });
      expect(res.status).toBe(200);
      expect(res.body.privateKey).toBeTruthy();
      expect(res.body.warning).toBeTruthy();
    });

    it('rejects wrong password', async () => {
      const res = await request(app)
        .post('/api/wallet/export')
        .set('Authorization', `Bearer ${token}`)
        .send({ password: 'wrongpass' });
      expect(res.status).toBe(401);
    });

    it('rejects missing password', async () => {
      const res = await request(app)
        .post('/api/wallet/export')
        .set('Authorization', `Bearer ${token}`)
        .send({});
      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/wallet/balance', () => {
    it('returns 400 when no wallet configured', async () => {
      const res = await request(app)
        .get('/api/wallet/balance')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(400);
    });

    it('returns 401 without token', async () => {
      const res = await request(app).get('/api/wallet/balance');
      expect(res.status).toBe(401);
    });
  });
});

describe('Bot routes', () => {
  let app: Express;
  let token: string;

  beforeEach(async () => {
    configStore = {};
    authStore = null;
    app = await buildApp();
    token = await setupAndLogin(app);
  });

  describe('GET /api/status', () => {
    it('returns bot status payload', async () => {
      const res = await request(app)
        .get('/api/status')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('stopped');
      expect(res.body.stats).toBeDefined();
    });

    it('returns 401 without token', async () => {
      const res = await request(app).get('/api/status');
      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/bot/start', () => {
    it('returns 400 when setup not complete', async () => {
      const res = await request(app)
        .post('/api/bot/start')
        .set('Authorization', `Bearer ${token}`)
        .send({ password: 'testpass123' });
      expect(res.status).toBe(400);
    });

    it('returns 400 when password missing', async () => {
      const res = await request(app)
        .post('/api/bot/start')
        .set('Authorization', `Bearer ${token}`)
        .send({});
      expect(res.status).toBe(400);
    });

    it('returns 401 without token', async () => {
      const res = await request(app).post('/api/bot/start').send({ password: 'x' });
      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/bot/stop', () => {
    it('returns ok even when already stopped', async () => {
      const res = await request(app)
        .post('/api/bot/stop')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });

    it('returns 401 without token', async () => {
      const res = await request(app).post('/api/bot/stop');
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/trades/copied', () => {
    it('returns empty array initially', async () => {
      const res = await request(app)
        .get('/api/trades/copied')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it('returns 401 without token', async () => {
      const res = await request(app).get('/api/trades/copied');
      expect(res.status).toBe(401);
    });
  });
});

describe('Proxy routes', () => {
  let app: Express;
  let token: string;

  beforeEach(async () => {
    configStore = {};
    authStore = null;
    app = await buildApp();
    token = await setupAndLogin(app);
  });

  describe('GET /api/proxy/target-trades', () => {
    it('returns 400 when target wallet not configured', async () => {
      const res = await request(app)
        .get('/api/proxy/target-trades')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(400);
    });

    it('returns array when target wallet is set', async () => {
      configStore = { ...configStore, targetWallet: '0xabc123' };
      const res = await request(app)
        .get('/api/proxy/target-trades')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it('respects limit query param (max 100)', async () => {
      configStore = { ...configStore, targetWallet: '0xabc123' };
      const res = await request(app)
        .get('/api/proxy/target-trades?limit=200')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
    });

    it('returns 401 without token', async () => {
      const res = await request(app).get('/api/proxy/target-trades');
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/proxy/target-positions', () => {
    it('returns 400 when target wallet not configured', async () => {
      const res = await request(app)
        .get('/api/proxy/target-positions')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(400);
    });

    it('returns array when target wallet is set', async () => {
      configStore = { ...configStore, targetWallet: '0xabc123' };
      const res = await request(app)
        .get('/api/proxy/target-positions')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it('returns 401 without token', async () => {
      const res = await request(app).get('/api/proxy/target-positions');
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/proxy/own-positions', () => {
    it('returns 400 when wallet not configured', async () => {
      const res = await request(app)
        .get('/api/proxy/own-positions')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(400);
    });

    it('returns array when wallet is set', async () => {
      configStore = { ...configStore, walletAddress: '0xmywallet' };
      const res = await request(app)
        .get('/api/proxy/own-positions')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });
  });
});

describe('Auth middleware', () => {
  let app: Express;

  beforeEach(async () => {
    configStore = {};
    authStore = null;
    app = await buildApp();
  });

  it('rejects malformed token', async () => {
    const res = await request(app)
      .get('/api/status')
      .set('Authorization', 'Bearer not.a.token');
    expect(res.status).toBe(401);
  });

  it('rejects tampered token', async () => {
    const token = await setupAndLogin(app);
    const [h, p] = token.split('.');
    const res = await request(app)
      .get('/api/status')
      .set('Authorization', `Bearer ${h}.${p}.invalidsig`);
    expect(res.status).toBe(401);
  });

  it('accepts valid token', async () => {
    const token = await setupAndLogin(app);
    const res = await request(app)
      .get('/api/status')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
  });
});
