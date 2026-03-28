export interface DualPosition {
  conditionId: string;
  question: string;
  yesTokenId: string;
  noTokenId: string;
  yesEntryPrice: number;
  noEntryPrice: number;
  shares: number;
  entryTime: number;
  expiresAt: number;
  strikePrice: number;
  negRisk: boolean;
  /** Tracks which sides are still held */
  yesHeld: boolean;
  noHeld: boolean;
  /** Filled notional per side */
  yesNotional: number;
  noNotional: number;
}

export interface DualPositionPnL {
  conditionId: string;
  yesPnL: number;
  noPnL: number;
  totalPnL: number;
  combinedEntryCost: number;
  mergeProfit: number;
  canMerge: boolean;
}

export class DualPositionTracker {
  private positions = new Map<string, DualPosition>();

  openPosition(params: {
    conditionId: string;
    question: string;
    yesTokenId: string;
    noTokenId: string;
    yesEntryPrice: number;
    noEntryPrice: number;
    shares: number;
    expiresAt: number;
    strikePrice: number;
    negRisk: boolean;
  }): DualPosition {
    const position: DualPosition = {
      ...params,
      entryTime: Date.now(),
      yesHeld: true,
      noHeld: true,
      yesNotional: params.yesEntryPrice * params.shares,
      noNotional: params.noEntryPrice * params.shares,
    };

    this.positions.set(params.conditionId, position);
    return position;
  }

  closeYes(conditionId: string): void {
    const pos = this.positions.get(conditionId);
    if (pos) {
      pos.yesHeld = false;
      this.cleanupIfFullyClosed(conditionId);
    }
  }

  closeNo(conditionId: string): void {
    const pos = this.positions.get(conditionId);
    if (pos) {
      pos.noHeld = false;
      this.cleanupIfFullyClosed(conditionId);
    }
  }

  closeBoth(conditionId: string): void {
    this.positions.delete(conditionId);
  }

  private cleanupIfFullyClosed(conditionId: string): void {
    const pos = this.positions.get(conditionId);
    if (pos && !pos.yesHeld && !pos.noHeld) {
      this.positions.delete(conditionId);
    }
  }

  getPosition(conditionId: string): DualPosition | undefined {
    return this.positions.get(conditionId);
  }

  getOpenPositions(): DualPosition[] {
    return Array.from(this.positions.values());
  }

  getOpenCount(): number {
    return this.positions.size;
  }

  hasPosition(conditionId: string): boolean {
    return this.positions.has(conditionId);
  }

  /**
   * Compute P&L for a dual position given current market prices.
   */
  computePnL(
    conditionId: string,
    currentYesBid: number,
    currentNoBid: number
  ): DualPositionPnL | null {
    const pos = this.positions.get(conditionId);
    if (!pos) return null;

    const combinedEntryCost = pos.yesEntryPrice + pos.noEntryPrice;

    const yesPnL = pos.yesHeld
      ? (currentYesBid - pos.yesEntryPrice) * pos.shares
      : 0;

    const noPnL = pos.noHeld
      ? (currentNoBid - pos.noEntryPrice) * pos.shares
      : 0;

    const canMerge = pos.yesHeld && pos.noHeld;
    const mergeProfit = canMerge
      ? (1.0 - combinedEntryCost) * pos.shares
      : 0;

    return {
      conditionId,
      yesPnL,
      noPnL,
      totalPnL: yesPnL + noPnL,
      combinedEntryCost,
      mergeProfit,
      canMerge,
    };
  }
}
