/**
 * MCP (Model Context Protocol) adapter for Polymarket Copy Bot.
 *
 * Exposes the bot's REST API as MCP tools via JSON-RPC 2.0 on POST /mcp.
 * IronClaw (or any MCP-compatible agent) can discover and call these tools.
 *
 * Supported JSON-RPC methods:
 *   - initialize        → handshake (returns server info + capabilities)
 *   - tools/list        → returns available tool definitions
 *   - tools/call        → executes a tool and returns result
 *   - notifications/initialized → client ack (no-op)
 *   - ping              → health check
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import type { BotController } from '../bot-controller.js';
import { loadConfig, saveConfig, decryptPrivateKey } from '../persistent-config.js';

// ── JSON-RPC types ──────────────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

function rpcOk(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

function rpcErr(id: string | number | null, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message, data } };
}

// ── MCP Tool definitions ────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'get_status',
    description: 'Get current bot status, trade statistics, wallet address, and whether setup is complete.',
    inputSchema: { type: 'object' as const, properties: {}, required: [] as string[] },
  },
  {
    name: 'start_bot',
    description: 'Start the copy bot. Requires the user password to decrypt the private key.',
    inputSchema: {
      type: 'object' as const,
      properties: { password: { type: 'string', description: 'User password to decrypt wallet private key' } },
      required: ['password'],
    },
  },
  {
    name: 'stop_bot',
    description: 'Stop the running copy bot.',
    inputSchema: { type: 'object' as const, properties: {}, required: [] as string[] },
  },
  {
    name: 'get_trades',
    description: 'Get history of copied trades (up to 500 most recent). Returns trade details including source trade info, result, and execution time.',
    inputSchema: { type: 'object' as const, properties: {}, required: [] as string[] },
  },
  {
    name: 'get_config',
    description: 'Get current bot configuration (sensitive fields excluded). Includes target wallet, trading parameters, risk settings, and monitoring config.',
    inputSchema: { type: 'object' as const, properties: {}, required: [] as string[] },
  },
  {
    name: 'update_config',
    description: 'Update bot configuration. Pass only the fields you want to change. Cannot modify wallet or JWT secret via this tool.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        targetWallet: { type: 'string', description: 'Wallet address to copy trades from' },
        rpcUrl: { type: 'string', description: 'Polygon RPC endpoint URL' },
        trading: {
          type: 'object',
          description: 'Trading parameters (slippage, position size, order type)',
        },
        risk: {
          type: 'object',
          description: 'Risk management settings',
        },
        monitoring: {
          type: 'object',
          description: 'Monitoring parameters',
        },
      },
      required: [] as string[],
    },
  },
  {
    name: 'get_wallet_balance',
    description: 'Get wallet balances: MATIC (for gas) and USDC (for trading) on Polygon network.',
    inputSchema: { type: 'object' as const, properties: {}, required: [] as string[] },
  },
  {
    name: 'get_target_positions',
    description: 'Get open positions of the target wallet being copied on Polymarket.',
    inputSchema: { type: 'object' as const, properties: {}, required: [] as string[] },
  },
  {
    name: 'get_own_positions',
    description: 'Get open positions of the bot\'s own wallet on Polymarket.',
    inputSchema: { type: 'object' as const, properties: {}, required: [] as string[] },
  },
];

// ── Tool execution ──────────────────────────────────────────────────────────

async function executeTool(
  name: string,
  args: Record<string, unknown>,
  controller: BotController,
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const cfg = loadConfig();

  try {
    switch (name) {
      case 'get_status': {
        const payload = controller.getStatusPayload(cfg);
        return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
      }

      case 'start_bot': {
        const password = args.password as string | undefined;
        if (!password) {
          return { content: [{ type: 'text', text: 'Error: password is required to start the bot.' }], isError: true };
        }
        if (!cfg || !cfg.setupComplete) {
          return { content: [{ type: 'text', text: 'Error: setup not complete. Run the wizard first.' }], isError: true };
        }
        if (!cfg.encryptedPrivateKey) {
          return { content: [{ type: 'text', text: 'Error: no wallet configured.' }], isError: true };
        }
        let privateKey: string;
        try {
          privateKey = decryptPrivateKey(cfg.encryptedPrivateKey, password);
        } catch {
          return { content: [{ type: 'text', text: 'Error: incorrect password.' }], isError: true };
        }
        await controller.start(cfg, privateKey);
        return { content: [{ type: 'text', text: 'Bot started successfully.' }] };
      }

      case 'stop_bot': {
        await controller.stop();
        return { content: [{ type: 'text', text: 'Bot stopped successfully.' }] };
      }

      case 'get_trades': {
        const trades = controller.getCopiedTrades();
        return { content: [{ type: 'text', text: JSON.stringify(trades, null, 2) }] };
      }

      case 'get_config': {
        if (!cfg) {
          return { content: [{ type: 'text', text: 'No configuration found. Setup not complete.' }], isError: true };
        }
        // Sanitize sensitive fields
        const cfgAny = cfg as unknown as Record<string, unknown>;
        const { encryptedPrivateKey, jwtSecret, ...safe } = cfgAny;
        return { content: [{ type: 'text', text: JSON.stringify(safe, null, 2) }] };
      }

      case 'update_config': {
        const blocked = ['encryptedPrivateKey', 'jwtSecret', 'walletAddress'];
        const updates: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(args)) {
          if (!blocked.includes(k)) updates[k] = v;
        }
        const current = cfg ?? {};
        const merged = { ...current, ...updates };
        saveConfig(merged);
        const mergedAny = merged as unknown as Record<string, unknown>;
        const { encryptedPrivateKey: _, jwtSecret: __, ...safe } = mergedAny;
        return { content: [{ type: 'text', text: JSON.stringify(safe, null, 2) }] };
      }

      case 'get_wallet_balance': {
        if (!cfg?.walletAddress) {
          return { content: [{ type: 'text', text: 'No wallet configured. Please set up wallet first.' }], isError: true };
        }
        const { ethers } = await import('ethers');
        const rpcUrl = cfg.rpcUrl || 'https://polygon-rpc.com';
        const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
        const maticBalance = ethers.utils.formatEther(await provider.getBalance(cfg.walletAddress));
        // USDC on Polygon
        const USDC_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
        const erc20 = new ethers.Contract(USDC_ADDRESS, ['function balanceOf(address) view returns (uint256)'], provider);
        const usdcRaw = await erc20.balanceOf(cfg.walletAddress);
        const usdcBalance = ethers.utils.formatUnits(usdcRaw, 6);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ walletAddress: cfg.walletAddress, maticBalance, usdcBalance }, null, 2),
          }],
        };
      }

      case 'get_target_positions':
      case 'get_own_positions': {
        const wallet = name === 'get_target_positions'
          ? cfg?.targetWallet
          : cfg?.walletAddress;
        if (!wallet) {
          return { content: [{ type: 'text', text: `No ${name === 'get_target_positions' ? 'target' : 'bot'} wallet configured.` }], isError: true };
        }
        const axios = (await import('axios')).default;
        const resp = await axios.get(`https://data-api.polymarket.com/positions`, {
          params: { user: wallet.toLowerCase() },
          timeout: 10_000,
        });
        return { content: [{ type: 'text', text: JSON.stringify(resp.data, null, 2) }] };
      }

      default:
        return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
  }
}

// ── Router ──────────────────────────────────────────────────────────────────

export function mcpRouter(controller: BotController): Router {
  const router = Router();

  router.post('/', async (req: Request, res: Response) => {
    const body = req.body as JsonRpcRequest;

    if (!body || body.jsonrpc !== '2.0') {
      res.status(400).json(rpcErr(null, -32600, 'Invalid JSON-RPC request'));
      return;
    }

    const id = body.id ?? null;

    switch (body.method) {
      // ── Handshake ───────────────────────────────────────────────────────
      case 'initialize': {
        res.json(rpcOk(id, {
          protocolVersion: '2024-11-05',
          capabilities: { tools: { listChanged: false } },
          serverInfo: {
            name: 'polymarket-copy-bot',
            version: '1.0.0',
          },
        }));
        return;
      }

      // ── Client ack (notification, no response needed) ───────────────────
      case 'notifications/initialized': {
        // Notifications have no id — don't send a response
        if (id === null || id === undefined) {
          res.status(204).end();
        } else {
          res.json(rpcOk(id, {}));
        }
        return;
      }

      // ── Ping ────────────────────────────────────────────────────────────
      case 'ping': {
        res.json(rpcOk(id, {}));
        return;
      }

      // ── List tools ──────────────────────────────────────────────────────
      case 'tools/list': {
        res.json(rpcOk(id, { tools: TOOLS }));
        return;
      }

      // ── Call a tool ─────────────────────────────────────────────────────
      case 'tools/call': {
        const params = body.params ?? {};
        const toolName = params.name as string;
        const toolArgs = (params.arguments ?? {}) as Record<string, unknown>;

        if (!toolName) {
          res.json(rpcErr(id, -32602, 'Missing required parameter: name'));
          return;
        }

        const known = TOOLS.find((t) => t.name === toolName);
        if (!known) {
          res.json(rpcErr(id, -32602, `Unknown tool: ${toolName}`));
          return;
        }

        const result = await executeTool(toolName, toolArgs, controller);
        res.json(rpcOk(id, result));
        return;
      }

      default: {
        res.json(rpcErr(id, -32601, `Method not found: ${body.method}`));
      }
    }
  });

  return router;
}
