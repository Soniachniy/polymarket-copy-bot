# Polymarket Copy Trading Bot

TypeScript bot that watches a target Polymarket wallet and copies new `BUY` trades with configurable sizing and risk caps.

## What It Does

- Watches a target wallet via REST polling.
- Uses WebSocket subscriptions for faster market updates when enabled.
- Copies only `BUY` trades (SELL trades are intentionally skipped).
- Auto-checks/sets required token approvals in EOA mode.
- Applies position sizing, slippage, and optional notional risk caps.

## Prerequisites

- Node.js 18+ and npm
- Polygon EOA funded with `USDC.e` collateral and `POL` (MATIC) for gas
- Polymarket account tied to the same EOA/private key
- Polygon RPC URL (QuickNode recommended)

## Credentials TL;DR

- The bot derives/creates User CLOB credentials from `PRIVATE_KEY` at startup.
- Builder dashboard keys are for attribution and are not valid trading auth credentials for order placement.

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create your local env file:

```bash
cp .env.example .env
```

3. Fill required values in `.env`:

- `TARGET_WALLET`
- `PRIVATE_KEY`
- `RPC_URL`

4. (Optional) Generate and inspect user API credentials:

```bash
npm run generate-api-creds
```

## Run

```bash
npm start
```

Dev/watch mode:

```bash
npm run dev
```

Build + run compiled output:

```bash
npm run build
npm run start:prod
```

## Key Environment Variables

- `TARGET_WALLET`: wallet to follow
- `PRIVATE_KEY`: your EOA private key used for signing/approvals/trades
- `RPC_URL`: Polygon JSON-RPC endpoint
- `USE_WEBSOCKET`: `true|false`
- `USE_USER_CHANNEL`: `true|false` (`true` requires valid API creds for WS auth)
- `POSITION_MULTIPLIER`: copied size multiplier (e.g. `0.1`)
- `MAX_TRADE_SIZE`, `MIN_TRADE_SIZE`
- `SLIPPAGE_TOLERANCE`: e.g. `0.02`
- `ORDER_TYPE`: `LIMIT`, `FOK`, or `FAK`
- `MAX_SESSION_NOTIONAL`, `MAX_PER_MARKET_NOTIONAL`: `0` disables caps

See `.env.example` for the full list.

## Notes

- The bot starts copying only trades that happen after startup time.
- User API credentials are derived/generated from `PRIVATE_KEY` at startup.
- Frequent WebSocket disconnect/reconnect can happen; REST polling remains active as fallback.

## Security

- Never commit `.env`.
- Use a dedicated wallet for bot trading.
- Start with small limits before increasing size.

## NBA prediction service

This repo also ships a selective, calibrated predictor for Polymarket NBA moneyline
markets, driven from a Claude Code session. Just run **`/nba-predict`** to get today's
high-confidence picks (and `/nba-predict score` the next day to grade and tune them).

- The skill lives in `.claude/skills/nba-predict/SKILL.md` — it orchestrates the whole
  daily workflow (fetch markets + ratings, research game-day injuries/rest/motivation,
  blend with the market, emit only picks above the confidence threshold).
- The pipeline + design rationale (how it targets ~80% via selectivity, not magic) are in
  [`prediction/README.md`](prediction/README.md).
- One-time setup: allow `gamma-api.polymarket.com` and `site.api.espn.com` in the session's
  network egress settings (see `prediction/README.md`).
