import { Router } from 'express';
import axios from 'axios';
import { loadConfig } from '../persistent-config.js';

export function proxyRouter(): Router {
  const router = Router();

  // GET /api/proxy/target-trades?limit=20
  router.get('/target-trades', async (req, res) => {
    try {
      const cfg = loadConfig();
      if (!cfg?.targetWallet) {
        res.status(400).json({ error: 'Target wallet not configured.' });
        return;
      }
      const limit = Math.min(parseInt(String(req.query['limit'] ?? '20')), 100);
      const response = await axios.get('https://data-api.polymarket.com/activity', {
        params: {
          user: cfg.targetWallet.toLowerCase(),
          type: 'TRADE',
          limit,
          sortBy: 'TIMESTAMP',
          sortDirection: 'DESC',
        },
        timeout: 10_000,
      });
      res.json(Array.isArray(response.data) ? response.data : []);
    } catch (err: any) {
      res.status(502).json({ error: err?.message ?? 'Upstream request failed.' });
    }
  });

  // GET /api/proxy/target-positions
  router.get('/target-positions', async (_req, res) => {
    try {
      const cfg = loadConfig();
      if (!cfg?.targetWallet) {
        res.status(400).json({ error: 'Target wallet not configured.' });
        return;
      }
      const response = await axios.get('https://data-api.polymarket.com/positions', {
        params: { user: cfg.targetWallet.toLowerCase() },
        timeout: 10_000,
      });
      res.json(Array.isArray(response.data) ? response.data : []);
    } catch (err: any) {
      res.status(502).json({ error: err?.message ?? 'Upstream request failed.' });
    }
  });

  // GET /api/proxy/own-positions
  router.get('/own-positions', async (_req, res) => {
    try {
      const cfg = loadConfig();
      if (!cfg?.walletAddress) {
        res.status(400).json({ error: 'Wallet not configured.' });
        return;
      }
      const response = await axios.get('https://data-api.polymarket.com/positions', {
        params: { user: cfg.walletAddress.toLowerCase() },
        timeout: 10_000,
      });
      res.json(Array.isArray(response.data) ? response.data : []);
    } catch (err: any) {
      res.status(502).json({ error: err?.message ?? 'Upstream request failed.' });
    }
  });

  return router;
}
