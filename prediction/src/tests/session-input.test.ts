import { describe, expect, it } from 'vitest';
import { parseSessionInput } from '../session-input.js';
import { matchMarketsToGames } from '../model.js';

describe('session input (offline slate)', () => {
  const input = {
    games: [
      { date: '2026-01-15', home: 'Boston Celtics', away: 'Miami Heat', homePrice: 0.8, awayPrice: 0.2 },
      { date: '2026-01-15', home: 'OKC', away: 'WAS', homePrice: 92, awayPrice: 8 },
    ],
    ratings: {
      BOS: { pointDiff: 6.5, wins: 30, losses: 10 },
      'Miami Heat': { pointDiff: 0.5, wins: 22, losses: 18 },
      OKC: { pointDiff: 9.8 },
      WAS: { pointDiff: -8.2 },
    },
    injuries: [{ teamAbbr: 'Miami Heat', player: 'Jimmy Butler', status: 'Out' }],
  };

  it('resolves team names and abbreviations to abbrs', () => {
    const { ratings, games } = parseSessionInput(input);
    expect(ratings.get('BOS')?.pointDiff).toBe(6.5);
    expect(ratings.get('MIA')?.pointDiff).toBe(0.5);
    expect(games[0]!.homeAbbr).toBe('BOS');
    expect(games[0]!.awayAbbr).toBe('MIA');
  });

  it('normalizes prices given as cents to probabilities', () => {
    const { markets } = parseSessionInput(input);
    const okc = markets.find((m) => m.teamAbbrs[0] === 'OKC')!;
    expect(okc.prices[0]).toBeCloseTo(0.92, 10);
    expect(okc.prices[1]).toBeCloseTo(0.08, 10);
  });

  it('lists the home team first so matching finds homeIdx 0', () => {
    const { markets, games } = parseSessionInput(input);
    const matched = matchMarketsToGames(markets, games);
    expect(matched).toHaveLength(2);
    expect(matched.every((m) => m.homeIdx === 0)).toBe(true);
  });

  it('derives winPct and defaults missing records to 0.5', () => {
    const { ratings } = parseSessionInput(input);
    expect(ratings.get('BOS')?.winPct).toBeCloseTo(0.75, 10);
    expect(ratings.get('OKC')?.winPct).toBe(0.5); // no W-L supplied
  });

  it('maps injuries through team resolution', () => {
    const { injuries } = parseSessionInput(input);
    expect(injuries[0]).toMatchObject({ teamAbbr: 'MIA', player: 'Jimmy Butler', status: 'Out' });
  });

  it('throws a clear error on an unresolvable team', () => {
    expect(() =>
      parseSessionInput({ games: [], ratings: { 'Fake United': { pointDiff: 0 } } }),
    ).toThrow(/Could not resolve team/);
  });
});
