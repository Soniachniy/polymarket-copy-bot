import { describe, expect, it } from 'vitest';
import { blend, deVig, matchMarketsToGames, modelHomeWinProb, normCdf, passesPick } from '../model.js';
import { isMoneylineMarket, normalizeMarkets } from '../polymarket.js';
import { normalizeEspnAbbr, resolveTeam } from '../teams.js';
import type { GameInfo, TeamRating } from '../types.js';

describe('teams', () => {
  it('resolves common Polymarket outcome labels', () => {
    expect(resolveTeam('Lakers')).toBe('LAL');
    expect(resolveTeam('Oklahoma City Thunder')).toBe('OKC');
    expect(resolveTeam('76ers')).toBe('PHI');
    expect(resolveTeam('Trail Blazers')).toBe('POR');
    expect(resolveTeam('Yes')).toBeNull();
    expect(resolveTeam('Over 220.5')).toBeNull();
  });

  it('normalizes ESPN abbreviation variants', () => {
    expect(normalizeEspnAbbr('GS')).toBe('GSW');
    expect(normalizeEspnAbbr('NY')).toBe('NYK');
    expect(normalizeEspnAbbr('UTAH')).toBe('UTA');
    expect(normalizeEspnAbbr('BOS')).toBe('BOS');
  });
});

describe('polymarket normalization', () => {
  // Gamma API returns outcomes/outcomePrices as JSON-encoded strings.
  const gammaFixture = [
    {
      title: 'Thunder vs. Pacers',
      slug: 'nba-okc-ind-2026-06-11',
      markets: [
        {
          question: 'Thunder vs. Pacers',
          slug: 'nba-okc-ind-2026-06-11',
          conditionId: '0xabc123',
          outcomes: '["Thunder", "Pacers"]',
          outcomePrices: '["0.72", "0.28"]',
          active: true,
          closed: false,
        },
        {
          question: 'Will the series go 7 games?',
          slug: 'nba-series-7-games',
          conditionId: '0xdef456',
          outcomes: '["Yes", "No"]',
          outcomePrices: '["0.4", "0.6"]',
          active: true,
          closed: false,
        },
      ],
    },
  ];

  it('parses string-encoded outcomes and prices', () => {
    const markets = normalizeMarkets(gammaFixture);
    expect(markets).toHaveLength(2);
    expect(markets[0]!.outcomes).toEqual(['Thunder', 'Pacers']);
    expect(markets[0]!.prices).toEqual([0.72, 0.28]);
    expect(markets[0]!.teamAbbrs).toEqual(['OKC', 'IND']);
  });

  it('keeps only two-team markets as moneylines', () => {
    const markets = normalizeMarkets(gammaFixture);
    expect(isMoneylineMarket(markets[0]!)).toBe(true);
    expect(isMoneylineMarket(markets[1]!)).toBe(false); // Yes/No market
  });

  it('also accepts already-parsed arrays', () => {
    const markets = normalizeMarkets([
      {
        title: 'x',
        markets: [
          {
            question: 'Celtics vs. Knicks',
            conditionId: '0x1',
            outcomes: ['Celtics', 'Knicks'],
            outcomePrices: ['0.5', '0.5'],
          },
        ],
      },
    ] as never);
    expect(markets[0]!.teamAbbrs).toEqual(['BOS', 'NYK']);
  });
});

describe('model', () => {
  const rating = (abbr: string, pointDiff: number): TeamRating => ({
    abbr,
    wins: 50,
    losses: 20,
    pointDiff,
    winPct: 0.7,
  });

  it('normCdf behaves like a CDF', () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 4);
    expect(normCdf(1.96)).toBeCloseTo(0.975, 3);
    expect(normCdf(-1.96)).toBeCloseTo(0.025, 3);
  });

  it('strong home favorite gets a high probability', () => {
    const out = modelHomeWinProb({
      home: rating('OKC', 9.0),
      away: rating('WAS', -8.0),
      adjustments: {},
    });
    expect(out.expectedMargin).toBeCloseTo(19.6, 1);
    expect(out.pHome).toBeGreaterThan(0.9);
  });

  it('manual adjustments shift the margin in the right direction', () => {
    const base = modelHomeWinProb({ home: rating('BOS', 5), away: rating('MIA', 0), adjustments: {} });
    const adjusted = modelHomeWinProb({
      home: rating('BOS', 5),
      away: rating('MIA', 0),
      adjustments: { BOS: { points: -4, reason: 'star player out' } },
    });
    expect(adjusted.expectedMargin).toBeCloseTo(base.expectedMargin - 4, 5);
    expect(adjusted.pHome).toBeLessThan(base.pHome);
    expect(adjusted.notes[0]).toContain('star player out');
  });

  it('deVig normalizes prices to sum to 1', () => {
    const fair = deVig([0.75, 0.29]);
    expect(fair[0]! + fair[1]!).toBeCloseTo(1, 10);
    expect(fair[0]!).toBeGreaterThan(0.7);
  });

  it('blend leans toward the market', () => {
    expect(blend(0.9, 0.7)).toBeCloseTo(0.65 * 0.7 + 0.35 * 0.9, 10);
  });

  it('passesPick requires both the blended threshold and the market floor', () => {
    // Clears both -> pick.
    expect(passesPick(0.82, 0.7, 0.78, 0.6)).toBe(true);
    // Below the blended threshold -> no pick.
    expect(passesPick(0.75, 0.9, 0.78, 0.6)).toBe(false);
    // Blend clears threshold only because the model is confident, but the market sees the game
    // as close (below floor) -> held back to protect accuracy.
    expect(passesPick(0.8, 0.55, 0.78, 0.6)).toBe(false);
    // Exactly on both boundaries -> pick (inclusive).
    expect(passesPick(0.78, 0.6, 0.78, 0.6)).toBe(true);
  });
});

describe('matching', () => {
  it('matches a market to the right ESPN game and finds the home side', () => {
    const games: GameInfo[] = [
      {
        espnId: '1',
        date: '2026-06-11',
        homeAbbr: 'IND',
        awayAbbr: 'OKC',
        startTimeUtc: '2026-06-12T00:30Z',
        completed: false,
      },
    ];
    const markets = normalizeMarkets([
      {
        title: 'Thunder vs. Pacers',
        markets: [
          {
            question: 'Thunder vs. Pacers',
            conditionId: '0x1',
            outcomes: '["Thunder", "Pacers"]',
            outcomePrices: '["0.7", "0.3"]',
          },
        ],
      },
    ] as never);
    const matched = matchMarketsToGames(markets, games);
    expect(matched).toHaveLength(1);
    expect(matched[0]!.homeIdx).toBe(1); // Pacers are home
  });
});
