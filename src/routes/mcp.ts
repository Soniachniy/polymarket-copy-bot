/**
 * MCP (Model Context Protocol) adapter for Polymarket Copy Bot.
 *
 * Exposes the bot's REST API as MCP tools via JSON-RPC 2.0 on POST /mcp.
 * IronClaw (or any MCP-compatible agent) can discover and call these tools.
 *
 * Supported JSON-RPC methods:
 *   - initialize              → handshake (server info + capabilities)
 *   - tools/list              → available tool definitions
 *   - tools/call              → execute a tool
 *   - notifications/initialized → client ack (no-op)
 *   - ping                    → health check
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import type { BotController } from '../bot-controller.js';
import { loadConfig, saveConfig, decryptPrivateKey, type AppConfig } from '../persistent-config.js';

// ── JSON-RPC helpers ────────────────────────────────────────────────────────

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

function ok(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

function err(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

// ── Tool definitions (MCP protocol) ─────────────────────────────────────────

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
    description: 'Get history of copied trades (up to 500 most recent). Returns trade details including source info, result, and execution time.',
    inputSchema: { type: 'object' as const, properties: {}, required: [] as string[] },
  },
  {
    name: 'get_config',
    description: 'Get current bot configuration (sensitive fields excluded). Includes target wallet, trading parameters, and monitoring config.',
    inputSchema: { type: 'object' as const, properties: {}, required: [] as string[] },
  },
  {
    name: 'update_config',
    description: 'Update bot configuration. Pass only the fields you want to change. Cannot modify wallet or encryption keys.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        targetWallet: { type: 'string', description: 'Wallet address to copy trades from' },
        rpcUrl: { type: 'string', description: 'Polygon RPC endpoint URL' },
        positionMultiplier: { type: 'number', description: 'Position size multiplier (e.g. 0.1 = 10% of target)' },
        maxTradeSize: { type: 'number', description: 'Maximum trade size in USDC' },
        minTradeSize: { type: 'number', description: 'Minimum trade size in USDC' },
        slippageTolerance: { type: 'number', description: 'Slippage tolerance (e.g. 0.02 = 2%)' },
        orderType: { type: 'string', enum: ['FOK', 'FAK', 'LIMIT'], description: 'Order type' },
        pollInterval: { type: 'number', description: 'Polling interval in ms' },
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
    description: "Get open positions of the bot's own wallet on Polymarket.",
    inputSchema: { type: 'object' as const, properties: {}, required: [] as string[] },
  },
];

// ── Sanitize config (strip secrets) ─────────────────────────────────────────

const SENSITIVE_KEYS = ['encryptedPrivateKey', 'jwtSecret'];

function sanitizeConfig(cfg: AppConfig): Record<string, unknown> {
  const obj = { ...cfg } as unknown as Record<string, unknown>;
  for (const key of SENSITIVE_KEYS) delete obj[key];
  return obj;
}

// ── Tool execution ──────────────────────────────────────────────────────────

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

async function executeTool(
  name: string,
  args: Record<string, unknown>,
  controller: BotController,
): Promise<ToolResult> {
  const cfg = loadConfig();

  try {
    switch (name) {
      case 'get_status': {
        return text(JSON.stringify(controller.getStatusPayload(cfg), null, 2));
      }

      case 'start_bot': {
        const password = args.password as string | undefined;
        if (!password) return fail('Password is required to start the bot.');
        if (!cfg?.setupComplete) return fail('Setup not complete. Run the wizard first.');
        if (!cfg.encryptedPrivateKey) return fail('No wallet configured.');
        let privateKey: string;
        try {
          privateKey = decryptPrivateKey(cfg.encryptedPrivateKey, password);
        } catch {
          return fail('Incorrect password.');
        }
        await controller.start(cfg, privateKey);
        return text('Bot started successfully.');
      }

      case 'stop_bot': {
        await controller.stop();
        return text('Bot stopped successfully.');
      }

      case 'get_trades': {
        return text(JSON.stringify(controller.getCopiedTrades(), null, 2));
      }

      case 'get_config': {
        if (!cfg) return fail('No configuration found. Setup not complete.');
        return text(JSON.stringify(sanitizeConfig(cfg), null, 2));
      }

      case 'update_config': {
        const blocked = new Set(SENSITIVE_KEYS.concat('walletAddress'));
        const updates: Partial<AppConfig> = {};
        for (const [k, v] of Object.entries(args)) {
          if (!blocked.has(k)) (updates as Record<string, unknown>)[k] = v;
        }
        const saved = saveConfig(updates);
        return text(JSON.stringify(sanitizeConfig(saved), null, 2));
      }

      case 'get_wallet_balance': {
        if (!cfg?.walletAddress) return fail('No wallet configured.');
        const { ethers } = await import('ethers');
        const provider = new ethers.providers.JsonRpcProvider(cfg.rpcUrl || 'https://polygon-rpc.com');
        const maticBalance = ethers.utils.formatEther(await provider.getBalance(cfg.walletAddress));
        const USDC = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
        const erc20 = new ethers.Contract(USDC, ['function balanceOf(address) view returns (uint256)'], provider);
        const usdcBalance = ethers.utils.formatUnits(await erc20.balanceOf(cfg.walletAddress), 6);
        return text(JSON.stringify({ walletAddress: cfg.walletAddress, maticBalance, usdcBalance }, null, 2));
      }

      case 'get_target_positions':
      case 'get_own_positions': {
        const wallet = name === 'get_target_positions' ? cfg?.targetWallet : cfg?.walletAddress;
        if (!wallet) return fail(`No ${name === 'get_target_positions' ? 'target' : 'bot'} wallet configured.`);
        const axios = (await import('axios')).default;
        const resp = await axios.get('https://data-api.polymarket.com/positions', {
          params: { user: wallet.toLowerCase() },
          timeout: 10_000,
        });
        return text(JSON.stringify(resp.data, null, 2));
      }

      default:
        return fail(`Unknown tool: ${name}`);
    }
  } catch (e: unknown) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

function text(t: string): ToolResult {
  return { content: [{ type: 'text', text: t }] };
}

function fail(msg: string): ToolResult {
  return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
}

// ── Express Router ──────────────────────────────────────────────────────────

export function mcpRouter(controller: BotController): Router {
  const router = Router();

  router.post('/', async (req: Request, res: Response) => {
    const body = req.body as JsonRpcRequest;
    if (!body || body.jsonrpc !== '2.0') {
      res.status(400).json(err(null, -32600, 'Invalid JSON-RPC request'));
      return;
    }

    const id = body.id ?? null;

    switch (body.method) {
      case 'initialize':
        res.json(ok(id, {
          protocolVersion: '2024-11-05',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'polymarket-copy-bot', version: '1.0.0' },
        }));
        return;

      case 'notifications/initialized':
        if (id == null) { res.status(204).end(); } else { res.json(ok(id, {})); }
        return;

      case 'ping':
        res.json(ok(id, {}));
        return;

      case 'tools/list':
        res.json(ok(id, { tools: TOOLS }));
        return;

      case 'tools/call': {
        const params = body.params ?? {};
        const toolName = params.name as string;
        const toolArgs = (params.arguments ?? {}) as Record<string, unknown>;
        if (!toolName) { res.json(err(id, -32602, 'Missing required parameter: name')); return; }
        if (!TOOLS.find((t) => t.name === toolName)) { res.json(err(id, -32602, `Unknown tool: ${toolName}`)); return; }
        const result = await executeTool(toolName, toolArgs, controller);
        res.json(ok(id, result));
        return;
      }

      default:
        res.json(err(id, -32601, `Method not found: ${body.method}`));
    }
  });

  return router;
}
