import { Router } from 'express';
import { loadConfig, saveConfig } from '../persistent-config.js';
import type { AppConfig } from '../persistent-config.js';

function sanitize(cfg: AppConfig): Omit<AppConfig, 'encryptedPrivateKey'> {
  const { encryptedPrivateKey: _k, ...safe } = cfg;
  return safe;
}

export function configRouter(): Router {
  const router = Router();

  // GET /api/config
  router.get('/', (_req, res) => {
    const cfg = loadConfig();
    if (!cfg) {
      res.status(404).json({ error: 'Config not initialised.' });
      return;
    }
    res.json(sanitize(cfg));
  });

  // PUT /api/config
  router.put('/', (req, res) => {
    try {
      const body = req.body as Partial<AppConfig>;
      // Prevent overwriting sensitive fields via this route
      delete (body as any).encryptedPrivateKey;
      delete (body as any).jwtSecret;
      delete (body as any).walletAddress;

      const updated = saveConfig(body);
      res.json(sanitize(updated));
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? 'Failed to save config.' });
    }
  });

  return router;
}
