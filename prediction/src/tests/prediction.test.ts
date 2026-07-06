import { describe, expect, it } from 'vitest';
import { buildPickRow, marketHomeProb } from '../core.js';
import { blend, deVig, matchMarketsToGames, modelHomeWinProb, normCdf } from '../model.js';
import { rowsFromBundle } from '../offline.js';
import { isMoneylineMarket, normalizeMarkets } from '../polymarket.js';
import { normalizeEspnAbbr, resolveTeam } from '../teams.js';
import type { GameInfo, InputBundle, TeamRating } from '../types.js';

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
});

describe('core.buildPickRow', () => {
  const rating = (abbr: string, pointDiff: number): TeamRating => ({
    abbr,
    wins: 3,
    losses: 0,
    pointDiff,
    winPct: 1,
  });
  const base = {
    gameDate: '2026-10-24',
    slug: 's',
    conditionId: '0x1',
    question: 'q',
    homeAbbr: 'OKC',
    awayAbbr: 'WAS',
    homeOutcome: 'Thunder',
    awayOutcome: 'Wizards',
    injuries: [],
    adjustments: {},
    threshold: 0.78,
  };

  it('blends model with market and picks the favorite', () => {
    const row = buildPickRow({
      ...base,
      homeRating: rating('OKC', 9),
      awayRating: rating('WAS', -8),
      marketHomeProb: 0.86,
    });
    expect(row.pickTeam).toBe('OKC');
    expect(row.hasMarket).toBe(true);
    expect(row.probability).toBeCloseTo(0.65 * 0.86 + 0.35 * row.pModel, 6);
    expect(row.pass).toBe(true);
  });

  it('never passes a model-only game (no market price)', () => {
    const row = buildPickRow({
      ...base,
      homeRating: rating('OKC', 12),
      awayRating: rating('WAS', -6),
    });
    expect(row.hasMarket).toBe(false);
    expect(row.probability).toBeCloseTo(row.pModel, 10); // pure model, no blend
    expect(row.pass).toBe(false); // model-only games are never auto-picks
    expect(row.rationale).toContain('NO MARKET PRICE');
  });

  it('picks the away side when the away team is favored', () => {
    const row = buildPickRow({
      ...base,
      homeRating: rating('OKC', -5),
      awayRating: rating('WAS', 6),
      marketHomeProb: 0.3,
    });
    expect(row.pickTeam).toBe('WAS');
    expect(row.pickOutcome).toBe('Wizards');
  });

  it('marketHomeProb de-vigs a two-price array', () => {
    const p = marketHomeProb([0.75, 0.3], 0)!;
    expect(p).toBeCloseTo(0.75 / 1.05, 6);
    expect(marketHomeProb([0.5, 0.3, 0.2], 0)).toBeUndefined();
  });
});

describe('offline.rowsFromBundle', () => {
  const bundle: InputBundle = {
    date: '2026-10-24',
    games: [
      {
        gameDate: '2026-10-24',
        homeAbbr: 'OKC',
        awayAbbr: 'WAS',
        homePointDiff: 9,
        awayPointDiff: -8,
        marketHomeProb: 0.86,
        conditionId: '0xokc',
      },
      {
        gameDate: '2026-10-24',
        homeAbbr: 'LAL',
        awayAbbr: 'BOS',
        homePointDiff: 2,
        awayPointDiff: 4,
        marketHomeProb: 0.47,
        conditionId: '0xlal',
      },
    ],
  };

  it('scores every game and sorts by confidence', () => {
    const rows = rowsFromBundle(bundle, 0.78);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.probability).toBeGreaterThanOrEqual(rows[1]!.probability);
    const picks = rows.filter((r) => r.pass);
    expect(picks).toHaveLength(1);
    expect(picks[0]!.pickTeam).toBe('OKC');
  });

  it('applies per-game adjustments and normalizes ESPN abbrs', () => {
    const rows = rowsFromBundle(
      {
        games: [
          {
            gameDate: '2026-10-24',
            homeAbbr: 'GS', // ESPN-style abbr, should normalize to GSW
            awayAbbr: 'SA',
            homePointDiff: 3,
            awayPointDiff: 3,
            marketHomeProb: 0.55,
            adjustments: { GSW: { points: -6, reason: 'star out' } },
          },
        ],
      },
      0.78,
    );
    expect(rows[0]!.pickTeam).toBeDefined();
    expect(rows[0]!.rationale).toContain('star out');
    // GSW normalized from "GS"; adjustment keyed by GSW must apply.
    expect(rows[0]!.rationale).toContain('GSW');
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
