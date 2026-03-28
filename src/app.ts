import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import jwt from 'jsonwebtoken';
import type { Request, Response, NextFunction } from 'express';

import { BotController } from './bot-controller.js';
import { loadConfig, saveConfig, wipeAllData, getJwtSecret } from './persistent-config.js';
import { authRouter } from './routes/auth.js';
import { botRouter } from './routes/bot.js';
import { configRouter } from './routes/config.js';
import { walletRouter } from './routes/wallet.js';
import { proxyRouter } from './routes/proxy.js';

// ── Login rate limiter ──────────────────────────────────────────────────────
// Keyed by remote IP. Max 10 attempts per 15-minute window.
const loginAttempts = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT_MAX = 10;

function checkLoginRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  entry.count++;
  if (entry.count > RATE_LIMIT_MAX) return false;
  return true;
}

function resetLoginRateLimit(ip: string): void {
  loginAttempts.delete(ip);
}

export function createApp(controller: BotController = new BotController()) {
  // Ensure config file exists on first run (no jwtSecret written to disk)
  if (!loadConfig()) {
    saveConfig({});
  }

  const app = express();
  app.use(cors({ origin: '*' }));
  app.use(express.json());

  // Expose rate-limit helpers so authRouter can use them
  app.locals['checkLoginRateLimit'] = checkLoginRateLimit;
  app.locals['resetLoginRateLimit'] = resetLoginRateLimit;

  function requireAuth(req: Request, res: Response, next: NextFunction): void {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) { res.status(401).json({ error: 'Unauthorized' }); return; }
    try {
      jwt.verify(token, getJwtSecret());
      next();
    } catch {
      res.status(401).json({ error: 'Invalid or expired token' });
    }
  }

  // Public
  app.use('/api/auth', authRouter());

  // Protected
  app.use('/api/wallet', requireAuth, walletRouter());
  app.use('/api/config', requireAuth, configRouter());
  app.use('/api/proxy', requireAuth, proxyRouter());
  app.use('/api', requireAuth, botRouter(controller));

  // POST /api/auth/wipe — stop bot + delete all persisted data (factory reset)
  app.post('/api/auth/wipe', requireAuth, async (_req, res) => {
    try {
      await controller.stop();
      wipeAllData();
      saveConfig({});
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? 'Wipe failed.' });
    }
  });

  return { app, controller };
}

export function createHttpServer(controller?: BotController) {
  const { app, controller: ctrl } = createApp(controller);
  const httpServer = createServer(app);
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  function broadcast(type: string, payload: unknown): void {
    const msg = JSON.stringify({ type, payload, ts: Date.now() });
    for (const client of wss.clients) {
      if (client.readyState === 1) client.send(msg);
    }
  }

  ctrl.on('trade:detected', (t) => broadcast('trade:detected', t));
  ctrl.on('trade:copied', (r) => broadcast('trade:copied', r));
  ctrl.on('trade:failed', (r) => broadcast('trade:failed', r));
  ctrl.on('trade:skipped', (r) => broadcast('trade:skipped', r));

  // Volatility strategy events
  ctrl.on('vol:entry', (data) => broadcast('vol:entry', data));
  ctrl.on('vol:entry:failed', (data) => broadcast('vol:entry:failed', data));
  ctrl.on('vol:exit', (data) => broadcast('vol:exit', data));
  ctrl.on('vol:merge', (data) => broadcast('vol:merge', data));

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url ?? '', 'http://localhost');
    const token = url.searchParams.get('token') ?? req.headers['authorization']?.replace('Bearer ', '');
    if (!token) { ws.close(4401, 'Unauthorized'); return; }
    try { jwt.verify(token, getJwtSecret()); } catch { ws.close(4401, 'Unauthorized'); return; }
    ws.on('error', (err) => console.error('WS client error:', err));
    ws.send(JSON.stringify({ type: 'status_update', payload: ctrl.getStatusPayload(loadConfig()), ts: Date.now() }));
  });

  return { httpServer, app, controller: ctrl };
}
