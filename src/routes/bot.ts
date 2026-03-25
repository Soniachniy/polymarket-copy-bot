import { Router } from 'express';
import type { BotController } from '../bot-controller.js';
import { loadConfig, decryptPrivateKey } from '../persistent-config.js';

export function botRouter(controller: BotController): Router {
  const router = Router();

  // GET /api/status
  router.get('/status', (_req, res) => {
    const cfg = loadConfig();
    res.json(controller.getStatusPayload(cfg));
  });

  // POST /api/bot/start — password required to decrypt private key
  router.post('/bot/start', async (req, res) => {
    try {
      const cfg = loadConfig();
      if (!cfg) {
        res.status(400).json({ error: 'Setup not complete. Run the wizard first.' });
        return;
      }
      if (!cfg.setupComplete) {
        res.status(400).json({ error: 'Wizard not completed.' });
        return;
      }
      if (!cfg.encryptedPrivateKey) {
        res.status(400).json({ error: 'No wallet configured.' });
        return;
      }
      const { password } = req.body as { password?: string };
      if (!password) {
        res.status(400).json({ error: 'Password required to decrypt private key.' });
        return;
      }
      let privateKey: string;
      try {
        privateKey = decryptPrivateKey(cfg.encryptedPrivateKey, password);
      } catch {
        res.status(401).json({ error: 'Incorrect password.' });
        return;
      }
      await controller.start(cfg, privateKey);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? 'Failed to start bot.' });
    }
  });

  // POST /api/bot/stop
  router.post('/bot/stop', async (_req, res) => {
    try {
      await controller.stop();
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? 'Failed to stop bot.' });
    }
  });

  // GET /api/trades/copied
  router.get('/trades/copied', (_req, res) => {
    res.json(controller.getCopiedTrades());
  });

  return router;
}
