import type { Trade } from './monitor.js';
import { config } from './config.js';
import { PositionTracker } from './positions.js';

export interface RiskCheckResult {
  allowed: boolean;
  reason?: string;
}

export class RiskManager {
  private sessionNotional = 0;
  private positions: PositionTracker;
  private readonly riskCfg: { maxSessionNotional: number; maxPerMarketNotional: number };

  constructor(positions: PositionTracker, cfg?: { risk: { maxSessionNotional: number; maxPerMarketNotional: number } }) {
    this.positions = positions;
    this.riskCfg = cfg?.risk ?? config.risk;
  }

  checkTrade(trade: Trade, copyNotional: number): RiskCheckResult {
    if (copyNotional <= 0) {
      return { allowed: false, reason: 'Copy notional is <= 0' };
    }

    if (this.riskCfg.maxSessionNotional > 0) {
      const nextSession = this.sessionNotional + copyNotional;
      if (nextSession > this.riskCfg.maxSessionNotional) {
        return {
          allowed: false,
          reason: `Session notional cap exceeded (${nextSession.toFixed(2)} > ${this.riskCfg.maxSessionNotional})`,
        };
      }
    }

    if (this.riskCfg.maxPerMarketNotional > 0) {
      const current = this.positions.getNotional(trade.tokenId);
      const next = current + copyNotional;
      if (next > this.riskCfg.maxPerMarketNotional) {
        return {
          allowed: false,
          reason: `Per-market notional cap exceeded (${next.toFixed(2)} > ${this.riskCfg.maxPerMarketNotional})`,
        };
      }
    }

    return { allowed: true };
  }

  recordFill(params: {
    trade: Trade;
    notional: number;
    shares: number;
    price: number;
    side: 'BUY' | 'SELL';
  }): void {
    this.sessionNotional += params.notional;
    this.positions.recordFill(params);
  }

  getSessionNotional(): number {
    return this.sessionNotional;
  }
}
