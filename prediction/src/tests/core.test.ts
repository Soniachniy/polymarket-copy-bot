import { describe, expect, it } from 'vitest';
import { DEFAULT_THRESHOLD, forecastGame, type ForecastInput } from '../core.js';

const base = (over: Partial<ForecastInput> = {}): ForecastInput => ({
  gameDate: '2026-04-15',
  slug: 'test',
  conditionId: '0xtest',
  question: 'Away @ Home',
  homeAbbr: 'OKC',
  awayAbbr: 'WAS',
  homeDiff: 9.1,
  awayDiff: -8.2,
  marketHome: 0.93,
  marketAway: 0.07,
  ...over,
});

describe('forecastGame', () => {
  it('picks the strong favorite and clears the threshold', () => {
    const r = forecastGame(base(), DEFAULT_THRESHOLD);
    expect(r.pickTeam).toBe('OKC');
    expect(r.probability).toBeGreaterThan(0.9);
    expect(r.pass).toBe(true);
  });

  it('skips (does not pass) a coin-flip game', () => {
    const r = forecastGame(
      base({
        homeAbbr: 'SAC',
        awayAbbr: 'DEN',
        homeDiff: 0.4,
        awayDiff: 3.2,
        marketHome: 0.48,
        marketAway: 0.52,
      }),
      DEFAULT_THRESHOLD,
    );
    expect(r.probability).toBeLessThan(DEFAULT_THRESHOLD);
    expect(r.pass).toBe(false);
  });

  it('de-vigs the market price before blending (pMarket sums out the overround)', () => {
    // Raw prices sum to 1.05; the favorite's fair share is 0.60/1.05, not 0.60.
    const r = forecastGame(
      base({ homeAbbr: 'BOS', awayAbbr: 'MIA', homeDiff: 5, awayDiff: 1, marketHome: 0.6, marketAway: 0.45 }),
      DEFAULT_THRESHOLD,
    );
    expect(r.pickTeam).toBe('BOS');
    expect(r.pMarket).toBeCloseTo(0.6 / 1.05, 4);
  });

  it('applies a confirmed-out adjustment to the correct side', () => {
    const noAdj = forecastGame(
      base({ homeAbbr: 'BOS', awayAbbr: 'MIA', homeDiff: 5, awayDiff: 0, marketHome: 0.7, marketAway: 0.3 }),
      DEFAULT_THRESHOLD,
    );
    const withAdj = forecastGame(
      base({
        homeAbbr: 'BOS',
        awayAbbr: 'MIA',
        homeDiff: 5,
        awayDiff: 0,
        marketHome: 0.7,
        marketAway: 0.3,
        adjustments: { BOS: { points: -6, reason: 'star out' } },
      }),
      DEFAULT_THRESHOLD,
    );
    expect(withAdj.expectedMargin).toBeCloseTo(noAdj.expectedMargin - 6, 5);
    expect(withAdj.pModel).toBeLessThan(noAdj.pModel);
    expect(withAdj.rationale).toContain('star out');
  });

  it('honors an overridden threshold', () => {
    const g = base({
      homeAbbr: 'LAL',
      awayAbbr: 'GSW',
      homeDiff: 6,
      awayDiff: -2,
      marketHome: 0.88,
      marketAway: 0.12,
    });
    expect(forecastGame(g, 0.78).pass).toBe(true);
    expect(forecastGame(g, 0.95).pass).toBe(false);
  });

  it('appends a free-text note to the rationale', () => {
    const r = forecastGame(base({ extraNote: 'back-to-back' }), DEFAULT_THRESHOLD);
    expect(r.rationale).toContain('back-to-back');
  });
});
