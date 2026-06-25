import { describe, expect, it } from 'vitest';
import { buildManualSlate } from '../manual.js';
import { buildRows } from '../predict.js';
import type { ManualInputFile } from '../types.js';

const slate: ManualInputFile = {
  date: '2026-06-25',
  games: [
    {
      home: 'Lakers',
      away: 'Celtics',
      marketPrices: { Lakers: 0.46, Celtics: 0.54 },
      homeNetRating: 2.1,
      awayNetRating: 5.8,
      homeRecord: [48, 34],
      awayRecord: [55, 27],
      adjustments: { Lakers: { points: -3.5, reason: 'AD doubtful' } },
      injuries: [{ team: 'Lakers', player: 'Anthony Davis', status: 'Doubtful' }],
      conditionId: '0xLALBOS',
    },
    {
      home: 'Thunder',
      away: 'Wizards',
      marketPrices: [0.9, 0.1],
      homeNetRating: 8.4,
      awayNetRating: -7.9,
      conditionId: '0xOKCWAS',
    },
  ],
};

describe('buildManualSlate', () => {
  it('resolves team names and orders outcomes [home, away]', () => {
    const { matched } = buildManualSlate(slate);
    expect(matched).toHaveLength(2);
    const lal = matched[0]!;
    expect(lal.market.teamAbbrs).toEqual(['LAL', 'BOS']);
    expect(lal.homeIdx).toBe(0);
    expect(lal.game.homeAbbr).toBe('LAL');
    expect(lal.game.awayAbbr).toBe('BOS');
  });

  it('maps keyed market prices to the right outcome regardless of order', () => {
    const { matched } = buildManualSlate(slate);
    // Lakers home price 0.46, Celtics away price 0.54.
    expect(matched[0]!.market.prices).toEqual([0.46, 0.54]);
  });

  it('accepts a [home, away] price tuple', () => {
    const { matched } = buildManualSlate(slate);
    expect(matched[1]!.market.prices).toEqual([0.9, 0.1]);
  });

  it('collects ratings, adjustments and injuries', () => {
    const { ratings, adjustments, injuries } = buildManualSlate(slate);
    expect(ratings.get('LAL')!.pointDiff).toBe(2.1);
    expect(ratings.get('BOS')!.winPct).toBeCloseTo(55 / 82, 5);
    expect(adjustments.LAL!.points).toBe(-3.5);
    expect(injuries).toContainEqual({ teamAbbr: 'LAL', player: 'Anthony Davis', status: 'Doubtful' });
  });

  it('supports a bare-number adjustment shorthand', () => {
    const { adjustments } = buildManualSlate({
      date: '2026-06-25',
      games: [
        {
          home: 'BOS',
          away: 'MIA',
          marketPrices: [0.6, 0.4],
          homeNetRating: 5,
          awayNetRating: 0,
          adjustments: { MIA: -4 },
        },
      ],
    });
    expect(adjustments.MIA!.points).toBe(-4);
  });

  it('throws on an unresolvable team', () => {
    expect(() =>
      buildManualSlate({
        date: '2026-06-25',
        games: [{ home: 'Not A Team', away: 'BOS', marketPrices: [0.5, 0.5], homeNetRating: 0, awayNetRating: 0 }],
      }),
    ).toThrow(/could not resolve team/i);
  });

  it('feeds the same calibrated model as the live pipeline', () => {
    const { matched, ratings, adjustments, injuries } = buildManualSlate(slate);
    const rows = buildRows(matched, ratings, adjustments, injuries, 0.78);
    const okc = rows.find((r) => r.pickTeam === 'OKC')!;
    // Strong favorite blended with a 90% market price clears the threshold.
    expect(okc.pass).toBe(true);
    expect(okc.probability).toBeGreaterThan(0.85);
    // The doubtful-AD adjustment shows up in the Lakers/Celtics rationale.
    const lalGame = rows.find((r) => r.question.includes('Lakers'))!;
    expect(lalGame.rationale).toMatch(/AD doubtful/);
    expect(lalGame.rationale).toMatch(/Anthony Davis/);
  });
});
