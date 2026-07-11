import { describe, expect, it } from 'vitest';
import { blend, deVig, matchMarketsToGames, modelHomeWinProb, normCdf } from '../model.js';
import { isMoneylineMarket, normalizeMarkets } from '../polymarket.js';
import { normalizeEspnAbbr, resolveTeam } from '../teams.js';
import { rowsFromSlate } from '../slate.js';
import { buildReview, gradePending } from '../score.js';
import type { GameInfo, Prediction, TeamRating } from '../types.js';

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

describe('slate path (web-research fallback)', () => {
  it('picks the strong side above threshold and skips coin flips', () => {
    const rows = rowsFromSlate({
      threshold: 0.78,
      games: [
        {
          date: '2026-11-15',
          home: 'Thunder',
          away: 'Wizards',
          homeNetRating: 9.5,
          awayNetRating: -8.0,
          marketHomePrice: 0.9,
        },
        {
          date: '2026-11-15',
          home: 'Lakers',
          away: 'Celtics',
          homeNetRating: 2.1,
          awayNetRating: 4.8,
          marketHomePrice: 0.44,
        },
      ],
    });
    expect(rows).toHaveLength(2);
    const okc = rows.find((r) => r.pickTeam === 'OKC')!;
    expect(okc.pass).toBe(true);
    expect(okc.probability).toBeGreaterThan(0.85);
    // The Lakers/Celtics game is a near coin flip after blending -> must not clear 0.78.
    const laGame = rows.find((r) => r.gameDate === '2026-11-15' && r.pickTeam !== 'OKC')!;
    expect(laGame.pass).toBe(false);
  });

  it('applies per-team adjustments by abbr', () => {
    const base = rowsFromSlate({
      games: [{ date: '2026-11-15', home: 'Lakers', away: 'Celtics', homeNetRating: 2, awayNetRating: 5, marketHomePrice: 0.44 }],
    })[0]!;
    const adjusted = rowsFromSlate({
      games: [{ date: '2026-11-15', home: 'Lakers', away: 'Celtics', homeNetRating: 2, awayNetRating: 5, marketHomePrice: 0.44 }],
      adjustments: { BOS: { points: -6, reason: 'Tatum out' } },
    })[0]!;
    // Weakening Boston must raise the Lakers' model win probability vs the unadjusted run.
    expect(adjusted.expectedMargin).toBeGreaterThan(base.expectedMargin);
  });

  it('defaults marketAwayPrice to 1 - marketHomePrice and de-vigs cleanly', () => {
    const [row] = rowsFromSlate({
      games: [{ date: '2026-11-15', home: 'Nuggets', away: 'Jazz', homeNetRating: 6, awayNetRating: -4, marketHomePrice: 0.8 }],
    });
    expect(row!.pMarket).toBeCloseTo(0.8, 5); // home is the pick; market prob ~ 0.8
  });

  it('gates model-driven picks the market does not back as a clear favorite', () => {
    // Home is a huge net-rating favorite (model loves it) but the market only rates it ~0.68 —
    // between the ~0.662 threshold-reachable minimum and the 0.70 floor. The blend clears 0.78 on
    // the model's strength, but the market floor must veto it.
    const game = {
      date: '2026-11-15',
      home: 'Nuggets',
      away: 'Wizards',
      homeNetRating: 12,
      awayNetRating: -7,
      marketHomePrice: 0.68,
    };
    const [gatedRow] = rowsFromSlate({ threshold: 0.78, games: [game] });
    expect(gatedRow!.probability).toBeGreaterThanOrEqual(0.78); // would pass on confidence alone
    expect(gatedRow!.pMarket).toBeLessThan(0.7); // but the market isn't a clear favorite
    expect(gatedRow!.floorGated).toBe(true);
    expect(gatedRow!.pass).toBe(false);

    // Lowering the floor lets the same game through — the guard is the only thing blocking it.
    const [ungated] = rowsFromSlate({ threshold: 0.78, marketFloor: 0.6, games: [game] });
    expect(ungated!.floorGated).toBe(false);
    expect(ungated!.pass).toBe(true);
  });

  it('does not gate a genuine strong favorite the market also backs', () => {
    const [row] = rowsFromSlate({
      threshold: 0.78,
      games: [{ date: '2026-11-15', home: 'Thunder', away: 'Wizards', homeNetRating: 9.5, awayNetRating: -8, marketHomePrice: 0.9 }],
    });
    expect(row!.pMarket).toBeGreaterThanOrEqual(0.7);
    expect(row!.floorGated).toBe(false);
    expect(row!.pass).toBe(true);
  });

  it('drops games with unresolvable team names or impossible prices', () => {
    const rows = rowsFromSlate({
      games: [
        { date: '2026-11-15', home: 'Not A Team', away: 'Celtics', homeNetRating: 0, awayNetRating: 0, marketHomePrice: 0.5 },
        { date: '2026-11-15', home: 'Lakers', away: 'Celtics', homeNetRating: 0, awayNetRating: 0, marketHomePrice: 1.5 },
      ],
    });
    expect(rows).toHaveLength(0);
  });
});

describe('score: grading and review', () => {
  const mk = (over: Partial<Prediction>): Prediction => ({
    ts: '2026-11-15T00:00:00Z',
    gameDate: '2026-11-15',
    slug: 's',
    conditionId: 'c',
    question: 'A @ B',
    pickTeam: 'OKC',
    pickOutcome: 'Thunder',
    probability: 0.9,
    pModel: 0.95,
    pMarket: 0.88,
    edge: 0.02,
    threshold: 0.78,
    rationale: 'r',
    status: 'pending',
    ...over,
  });

  it('grades pending picks from finals and leaves hand-graded ones untouched', () => {
    const log: Prediction[] = [
      mk({ pickTeam: 'OKC' }),
      mk({ pickTeam: 'BOS', status: 'correct', actualWinner: 'BOS' }), // already hand-graded
    ];
    const results = new Map<string, GameInfo[]>([
      [
        '2026-11-15',
        [{ espnId: '1', date: '2026-11-15', homeAbbr: 'OKC', awayAbbr: 'WAS', startTimeUtc: '', completed: true, homeScore: 120, awayScore: 100 }],
      ],
    ]);
    const n = gradePending(log, results);
    expect(n).toBe(1);
    expect(log[0]!.status).toBe('correct');
    expect(log[0]!.actualWinner).toBe('OKC');
    expect(log[1]!.status).toBe('correct'); // untouched
  });

  it('leaves picks pending when no finals were fetched (network-blocked date)', () => {
    const log: Prediction[] = [mk({})];
    const n = gradePending(log, new Map()); // empty => fetch was blocked
    expect(n).toBe(0);
    expect(log[0]!.status).toBe('pending');
  });

  it('marks an incorrect pick when the other team wins', () => {
    const log: Prediction[] = [mk({ pickTeam: 'OKC' })];
    const results = new Map<string, GameInfo[]>([
      [
        '2026-11-15',
        [{ espnId: '1', date: '2026-11-15', homeAbbr: 'OKC', awayAbbr: 'WAS', startTimeUtc: '', completed: true, homeScore: 100, awayScore: 120 }],
      ],
    ]);
    gradePending(log, results);
    expect(log[0]!.status).toBe('incorrect');
    expect(log[0]!.actualWinner).toBe('WAS');
  });

  it('builds a report from hand-graded picks with no fetch at all', () => {
    const log: Prediction[] = [
      mk({ probability: 0.92, status: 'correct' }),
      mk({ probability: 0.81, status: 'incorrect', actualWinner: 'WAS', question: 'C @ D' }),
      mk({ probability: 0.85, status: 'pending' }),
    ];
    const md = buildReview(log, '2026-11-16');
    expect(md).toContain('Graded: **2**');
    expect(md).toContain('Correct: **1**');
    expect(md).toContain('Accuracy: **50.0%**');
    expect(md).toContain('Still pending: 1');
    expect(md).toContain('Still pending (ungraded)'); // section shown so operator can hand-grade
    expect(md).toContain('C @ D'); // the mistake is listed
  });
});
