import { describe, expect, it } from 'vitest';
import { evaluateGame, type EvalInput } from '../evaluate.js';
import { manualGameToInput } from '../manual.js';
import { invNormCdf, marginFromProb, normCdf } from '../model.js';
import type { TeamRating } from '../types.js';

const rating = (abbr: string, pointDiff: number): TeamRating => ({
  abbr,
  wins: 40,
  losses: 20,
  pointDiff,
  winPct: 0.66,
});

const baseInput = (over: Partial<EvalInput>): EvalInput => ({
  gameDate: '2026-01-15',
  slug: 'test',
  conditionId: '0xtest',
  question: 'AWY @ HOM',
  homeAbbr: 'BOS',
  awayAbbr: 'WAS',
  outcomes: ['BOS', 'WAS'],
  teamAbbrs: ['BOS', 'WAS'],
  homeIdx: 0,
  prices: [0.9, 0.1],
  adjustments: {},
  injuries: [],
  threshold: 0.78,
  ...over,
});

describe('invNormCdf', () => {
  it('inverts normCdf', () => {
    for (const p of [0.05, 0.25, 0.5, 0.75, 0.95]) {
      expect(normCdf(invNormCdf(p))).toBeCloseTo(p, 3);
    }
  });
  it('marginFromProb is zero at a coin flip and positive above', () => {
    expect(marginFromProb(0.5)).toBeCloseTo(0, 6);
    expect(marginFromProb(0.75)).toBeGreaterThan(0);
    expect(marginFromProb(0.25)).toBeLessThan(0);
  });
});

describe('evaluateGame', () => {
  it('blends ratings model with market when ratings are present', () => {
    const row = evaluateGame(
      baseInput({ homeRating: rating('BOS', 8), awayRating: rating('WAS', -9), prices: [0.85, 0.15] }),
    );
    expect(row.pickTeam).toBe('BOS');
    expect(row.pass).toBe(true);
    expect(row.probability).toBeGreaterThan(0.8);
    // Blend sits between the two components.
    expect(row.probability).toBeGreaterThan(Math.min(row.pModel, row.pMarket) - 1e-9);
    expect(row.probability).toBeLessThan(Math.max(row.pModel, row.pMarket) + 1e-9);
  });

  it('degrades to market-only when ratings are missing', () => {
    const row = evaluateGame(baseInput({ prices: [0.82, 0.18] }));
    expect(row.pModel).toBeCloseTo(row.pMarket, 6); // market-anchored: model == market
    expect(row.rationale).toContain('market-anchored');
  });

  it('applies adjustments to the market-implied margin without ratings', () => {
    const noAdj = evaluateGame(baseInput({ prices: [0.5, 0.5] }));
    const withAdj = evaluateGame(
      baseInput({
        prices: [0.5, 0.5],
        adjustments: { WAS: { points: -6, reason: 'star out' } },
      }),
    );
    // Weakening the away team should raise the home model probability.
    expect(withAdj.pModel).toBeGreaterThan(noAdj.pModel);
    expect(withAdj.rationale).toContain('star out');
  });

  it('picks the away side and reports its probability when the away team is favored', () => {
    const row = evaluateGame(
      baseInput({ homeRating: rating('BOS', -8), awayRating: rating('WAS', 9), prices: [0.15, 0.85] }),
    );
    expect(row.pickTeam).toBe('WAS');
    expect(row.probability).toBeGreaterThan(0.5);
  });
});

describe('manualGameToInput', () => {
  it('resolves names, defaults the away price, and orders [home, away]', () => {
    const input = manualGameToInput(
      { home: 'Lakers', away: 'Nuggets', marketHome: 0.6 },
      '2026-01-15',
      0.78,
    );
    expect(input.homeAbbr).toBe('LAL');
    expect(input.awayAbbr).toBe('DEN');
    expect(input.homeIdx).toBe(0);
    expect(input.prices).toEqual([0.6, 0.4]);
  });

  it('maps net ratings and adjustments through to the engine', () => {
    const input = manualGameToInput(
      {
        home: 'BOS',
        away: 'MIA',
        marketAway: 0.3,
        homeNetRating: 6,
        adjustments: [{ team: 'Heat', points: -4, reason: 'Herro out' }],
      },
      '2026-01-15',
      0.78,
    );
    expect(input.prices[0]).toBeCloseTo(0.7, 6);
    expect(input.homeRating?.pointDiff).toBe(6);
    expect(input.adjustments['MIA']).toEqual({ points: -4, reason: 'Herro out' });
    const row = evaluateGame(input);
    expect(row.pickTeam).toBe('BOS');
  });
});
