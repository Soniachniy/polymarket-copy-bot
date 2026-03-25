import { Router } from 'express';
import { ethers } from 'ethers';
import bcrypt from 'bcryptjs';
import {
  loadConfig, saveConfig, loadAuth,
  encryptPrivateKey, decryptPrivateKey,
} from '../persistent-config.js';

const USDC_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
];

function getProvider(rpcUrl: string) {
  return new ethers.providers.JsonRpcProvider(rpcUrl);
}

export function walletRouter(): Router {
  const router = Router();

  // POST /api/wallet/generate — generate a new random wallet, encrypt, store
  router.post('/generate', async (req, res) => {
    try {
      const { password } = req.body as { password?: string };
      if (!password) {
        res.status(400).json({ error: 'Password required.' });
        return;
      }
      const wallet = ethers.Wallet.createRandom();
      const encrypted = encryptPrivateKey(wallet.privateKey, password);
      saveConfig({ encryptedPrivateKey: encrypted, walletAddress: wallet.address });
      // Return key + mnemonic ONCE — never stored in plaintext
      res.json({
        address: wallet.address,
        privateKey: wallet.privateKey,
        mnemonic: wallet.mnemonic?.phrase ?? null,
        warning: 'Save your private key now. It will not be shown again.',
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? 'Failed to generate wallet.' });
    }
  });

  // POST /api/wallet/import — import existing private key
  router.post('/import', async (req, res) => {
    try {
      const { privateKey, password } = req.body as { privateKey?: string; password?: string };
      if (!privateKey || !password) {
        res.status(400).json({ error: 'privateKey and password required.' });
        return;
      }
      let wallet: ethers.Wallet;
      try {
        wallet = new ethers.Wallet(privateKey);
      } catch {
        res.status(400).json({ error: 'Invalid private key.' });
        return;
      }
      const encrypted = encryptPrivateKey(wallet.privateKey, password);
      saveConfig({ encryptedPrivateKey: encrypted, walletAddress: wallet.address });
      res.json({ address: wallet.address });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? 'Failed to import wallet.' });
    }
  });

  // POST /api/wallet/export — re-verify password, return decrypted key
  router.post('/export', async (req, res) => {
    try {
      const { password } = req.body as { password?: string };
      if (!password) {
        res.status(400).json({ error: 'Password required.' });
        return;
      }
      const auth = loadAuth();
      if (!auth) {
        res.status(400).json({ error: 'Auth not set up.' });
        return;
      }
      const valid = await bcrypt.compare(password, auth.passwordHash);
      if (!valid) {
        res.status(401).json({ error: 'Incorrect password.' });
        return;
      }
      const cfg = loadConfig();
      if (!cfg?.encryptedPrivateKey) {
        res.status(400).json({ error: 'No wallet stored.' });
        return;
      }
      const privateKey = decryptPrivateKey(cfg.encryptedPrivateKey, password);
      res.json({
        privateKey,
        address: cfg.walletAddress,
        warning: 'Never share your private key. Import it into MetaMask via Settings → Import Account.',
      });
    } catch {
      res.status(401).json({ error: 'Incorrect password or decryption failed.' });
    }
  });

  // GET /api/wallet/balance
  router.get('/balance', async (_req, res) => {
    try {
      const cfg = loadConfig();
      if (!cfg?.walletAddress) {
        res.status(400).json({ error: 'No wallet configured.' });
        return;
      }
      const rpcUrl = cfg.rpcUrl || 'https://polygon-rpc.com';
      const provider = getProvider(rpcUrl);
      const [maticWei, usdcContract] = await Promise.all([
        provider.getBalance(cfg.walletAddress),
        Promise.resolve(new ethers.Contract(USDC_ADDRESS, ERC20_ABI, provider)),
      ]);
      const [usdcRaw, usdcDecimals] = await Promise.all([
        usdcContract.balanceOf(cfg.walletAddress),
        usdcContract.decimals(),
      ]);
      res.json({
        walletAddress: cfg.walletAddress,
        maticBalance: parseFloat(ethers.utils.formatEther(maticWei)).toFixed(4),
        usdcBalance: parseFloat(ethers.utils.formatUnits(usdcRaw, usdcDecimals)).toFixed(2),
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? 'Failed to fetch balance.' });
    }
  });

  return router;
}
