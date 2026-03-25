import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { loadAuth, saveAuth, loadConfig, wipeAllData } from '../persistent-config.js';

export function authRouter(): Router {
  const router = Router();

  // GET /api/auth/status — returns whether password has been set
  router.get('/status', (_req, res) => {
    const auth = loadAuth();
    res.json({ passwordSet: !!auth });
  });

  // POST /api/auth/setup — first-time password creation
  router.post('/setup', async (req, res) => {
    try {
      const existing = loadAuth();
      if (existing) {
        res.status(409).json({ error: 'Password already set. Use /api/auth/login.' });
        return;
      }
      const { password } = req.body as { password?: string };
      if (!password || password.length < 6) {
        res.status(400).json({ error: 'Password must be at least 6 characters.' });
        return;
      }
      const hash = await bcrypt.hash(password, 12);
      saveAuth({ passwordHash: hash, createdAt: new Date().toISOString() });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: 'Setup failed.' });
    }
  });

  // POST /api/auth/login — verify password, return JWT
  router.post('/login', async (req, res) => {
    try {
      const auth = loadAuth();
      if (!auth) {
        res.status(404).json({ error: 'No password set. Use /api/auth/setup first.' });
        return;
      }
      const { password } = req.body as { password?: string };
      if (!password) {
        res.status(400).json({ error: 'Password required.' });
        return;
      }
      const valid = await bcrypt.compare(password, auth.passwordHash);
      if (!valid) {
        res.status(401).json({ error: 'Invalid password.' });
        return;
      }
      const cfg = loadConfig();
      const secret = cfg?.jwtSecret;
      if (!secret) {
        res.status(500).json({ error: 'JWT secret not initialised. Complete setup first.' });
        return;
      }
      const token = jwt.sign({ sub: 'user' }, secret, { expiresIn: '7d' });
      res.json({ token });
    } catch {
      res.status(500).json({ error: 'Login failed.' });
    }
  });

  return router;
}
