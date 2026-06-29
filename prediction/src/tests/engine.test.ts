import { describe, expect, it } from 'vitest';
import { bundleToInputs, computeRows, type InputBundle } from '../engine.js';

const bundle: InputBundle = {
  date: '2026-10-22',
  games: [
    {
      home: 'Denver Nuggets',
      away: 'Washington Wizards',
      homeRating: 5.0,
      awayRating: -8.5,
      marketHomePrice: 0.91,
      marketAwayPrice: 0.1,
    },
    {
      home: 'Boston Celtics',
      away: 'New York Knicks',
      homeRating: 6.1,
      awayRating: 2.4,
      marketHomePrice: 0.66,
      marketAwayPrice: 0.36,
      adjustments: { BOS: { points: -3.5, reason: 'Porzingis out' } },
      injuries: [{ team: 'NYK', player: 'OG Anunoby', status: 'Out' }],
    },
  ],
};

describe('bundleToInputs', () => {
  it('resolves team names to abbrs and builds ratings/markets', () => {
    const { matched, ratings, adjustments, injuries, warnings } = bundleToInputs(bundle);
    expect(warnings).toEqual([]);
    expect(matched).toHaveLength(2);
    expect(ratings.get('DEN')?.pointDiff).toBe(5.0);
    expect(ratings.get('WAS')?.pointDiff).toBe(-8.5);
    // home-first ordering means homeIdx is always 0
    expect(matched[0]!.homeIdx).toBe(0);
    expect(matched[0]!.market.teamAbbrs).toEqual(['DEN', 'WAS']);
    expect(adjustments.BOS?.points).toBe(-3.5);
    expect(injuries[0]).toMatchObject({ teamAbbr: 'NYK', player: 'OG Anunoby', status: 'Out' });
  });

  it('warns and skips unresolvable games rather than throwing', () => {
    const { matched, warnings } = bundleToInputs({
      date: '2026-10-22',
      games: [{ home: 'Not A Team', away: 'Also Fake', homeRating: 0, awayRating: 0 }],
    });
    expect(matched).toHaveLength(0);
    expect(warnings[0]).toMatch(/could not resolve/);
  });
});

describe('computeRows', () => {
  it('emits a confident PICK for a clear favorite and respects the threshold', () => {
    const { matched, ratings, injuries, adjustments } = bundleToInputs(bundle);
    const rows = computeRows(matched, { ratings, injuries, adjustments, threshold: 0.78 });
    const den = rows.find((r) => r.pickTeam === 'DEN')!;
    expect(den.pass).toBe(true);
    expect(den.probability).toBeGreaterThan(0.85);

    const bos = rows.find((r) => r.slug.includes('BOS') || r.question.includes('Boston'))!;
    // Porzingis-out adjustment pulls Boston below the confidence threshold.
    expect(bos.pass).toBe(false);
    expect(bos.rationale).toContain('Porzingis');
  });

  it('never emits a confident pick without a market anchor', () => {
    const noMarket = bundleToInputs({
      date: '2026-10-22',
      games: [{ home: 'Denver Nuggets', away: 'Washington Wizards', homeRating: 12, awayRating: -12 }],
    });
    const rows = computeRows(noMarket.matched, {
      ratings: noMarket.ratings,
      injuries: noMarket.injuries,
      adjustments: noMarket.adjustments,
      threshold: 0.78,
    });
    expect(rows[0]!.pass).toBe(false);
    expect(rows[0]!.rationale).toContain('NO MARKET PRICE');
  });

  it('sorts rows by descending probability', () => {
    const { matched, ratings, injuries, adjustments } = bundleToInputs(bundle);
    const rows = computeRows(matched, { ratings, injuries, adjustments, threshold: 0.78 });
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i - 1]!.probability).toBeGreaterThanOrEqual(rows[i]!.probability);
    }
  });
});
