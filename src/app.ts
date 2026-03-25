import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import jwt from 'jsonwebtoken';
import type { Request, Response, NextFunction } from 'express';
import { randomBytes } from 'crypto';

import { BotController } from './bot-controller.js';
import { loadConfig, saveConfig, wipeAllData } from './persistent-config.js';
import { authRouter } from './routes/auth.js';
import { botRouter } from './routes/bot.js';
import { configRouter } from './routes/config.js';
import { walletRouter } from './routes/wallet.js';
import { proxyRouter } from './routes/proxy.js';

export function createApp(controller: BotController = new BotController()) {
  // Ensure jwtSecret exists
  let cfg = loadConfig();
  if (!cfg) {
    saveConfig({ jwtSecret: randomBytes(32).toString('hex') });
    cfg = loadConfig();
  }

  const app = express();
  app.use(cors({ origin: '*' }));
  app.use(express.json());

  function requireAuth(req: Request, res: Response, next: NextFunction): void {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) { res.status(401).json({ error: 'Unauthorized' }); return; }
    const currentCfg = loadConfig();
    const secret = currentCfg?.jwtSecret;
    if (!secret) { res.status(500).json({ error: 'JWT secret missing' }); return; }
    try {
      jwt.verify(token, secret);
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

  app.post('/api/auth/wipe', requireAuth, async (_req, res) => {
    try {
      await controller.stop();
      wipeAllData();
      saveConfig({ jwtSecret: randomBytes(32).toString('hex') });
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

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url ?? '', 'http://localhost');
    const token = url.searchParams.get('token') ?? req.headers['authorization']?.replace('Bearer ', '');
    const currentCfg = loadConfig();
    const secret = currentCfg?.jwtSecret;
    if (!token || !secret) { ws.close(4401, 'Unauthorized'); return; }
    try { jwt.verify(token, secret); } catch { ws.close(4401, 'Unauthorized'); return; }
    ws.on('error', (err) => console.error('WS client error:', err));
    const currentStatus = ctrl.getStatusPayload(loadConfig());
    ws.send(JSON.stringify({ type: 'status_update', payload: currentStatus, ts: Date.now() }));
  });

  return { httpServer, app, controller: ctrl };
}
