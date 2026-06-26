# NBA prediction service for Polymarket

A selective, calibrated predictor for Polymarket NBA moneyline markets, designed to be driven
from a Claude Code session via the `/nba-predict` skill.

## How it reaches a ~80% hit rate (read this first)

No model predicts every NBA game at 80% — the betting market itself is only ~68-70% accurate
on all games, and it is the best public forecast that exists. The honest path to 80% is:

1. **Selectivity** — only emit picks whose blended win probability clears a threshold
   (default 0.78). Coin-flip games are skipped on purpose. Some days produce zero picks;
   that is correct behavior, not a bug.
2. **Calibration** — a 80% confidence pick *should* lose 1 in 5. The score loop checks that
   stated confidence matches realized hit rate per bucket and tunes the threshold.
3. **Market anchoring** — the final probability is a blend of a ratings model (35%) and the
   de-vigged Polymarket price (65%), because prediction markets are sharp.
4. **Game-day information** — season ratings can't see tonight's lineup. The session layer
   (Claude with web search) researches injuries/rest/motivation and encodes them as point
   adjustments before picks are generated.

Note: 80% *accuracy* is not the same as *profit* — high-confidence picks trade at high prices.
This service answers "who will win", not "is this price +EV".

## Daily workflow

```
You:    /nba-predict
Claude: runs the pipeline, researches the slate, writes adjustments, saves picks,
        reports PICKS + skipped games

(next day / after games finish)

You:    /nba-predict score
Claude: grades the log vs ESPN finals, writes prediction/data/review.md,
        classifies each miss (variance / information miss / model error),
        proposes and applies tuning
```

Commit `prediction/data/*` after each session — the JSONL log is the system's memory.

## CLI (what the skill runs under the hood)

```bash
npm run predict                       # picks above threshold for today's slate
npm run predict -- --all              # every matched game incl. below-threshold (analysis view)
npm run predict -- --save             # append picks to data/predictions.jsonl
npm run predict -- --threshold 0.82   # override confidence threshold
npm run predict -- --date 2026-06-11  # specific date (repeatable)
npm run predict:score                 # grade pending picks, write data/review.md
```

## Data sources (all free, no API keys)

| Source | Used for |
|---|---|
| `gamma-api.polymarket.com/events?tag_slug=nba` | active NBA markets, prices |
| ESPN `site.api.espn.com .../scoreboard` | schedule, home/away, final scores |
| ESPN `.../standings` | W-L, point differential (power ratings) |
| ESPN `.../injuries` | listed Out/Doubtful players |
| Web search (session layer) | late-breaking lineups, rest, motivation |

## Network requirements

The CLI fetches directly from two hosts. The environment running it must allow outbound
HTTPS to:

- `gamma-api.polymarket.com`
- `site.api.espn.com`

In a restricted/sandboxed session these may be blocked (`403 Host not in allowlist`). Add
them to the network egress allowlist, or use snapshot mode below. Web search (used by the
`/nba-predict` skill for injuries/rest) keeps working regardless.

## Offline / snapshot mode

Every successful live fetch is cached to `prediction/data/cache/<key>.json` as
`{ "savedAt": ISO, "data": ... }`. If a later live fetch fails, the engine transparently
falls back to that cached snapshot (warning if it's stale). This means:

- Re-running after a transient network blip just works.
- You can run fully offline / from manual input by **hand-writing** the cache files. Drop in
  the keys you need; any missing-and-unfetchable key raises a clear error.

The cache directory is git-ignored (transient). Keys and `data` shapes:

| Key | `data` shape |
|---|---|
| `markets` | `NbaMarket[]` — `{ eventTitle, question, slug, conditionId, outcomes[2], prices[2], teamAbbrs[2] }` |
| `scoreboard-today` / `scoreboard-YYYYMMDD` | `GameInfo[]` — `{ espnId, date, homeAbbr, awayAbbr, startTimeUtc, completed, homeScore?, awayScore? }` |
| `standings` | `TeamRating[]` — `{ abbr, wins, losses, pointDiff, winPct }` |
| `injuries` | `InjuryReport[]` — `{ teamAbbr, player, status, detail? }` (may be `[]`) |

`teamAbbrs` / `*Abbr` use the abbreviations in `prediction/src/teams.ts`. `prices` are 0–1 and
need not sum to 1 (the engine de-vigs them). Example minimal `cache/markets.json`:

```json
{ "savedAt": "2026-06-26T12:00:00.000Z", "data": [
  { "eventTitle": "Thunder vs. Pacers", "question": "Thunder vs. Pacers",
    "slug": "nba-okc-ind", "conditionId": "0x1",
    "outcomes": ["Thunder","Pacers"], "prices": [0.80,0.20], "teamAbbrs": ["OKC","IND"] }
] }
```

## Model

`P(home) = Φ((diff_home − diff_away + 2.6 home court + manual adjustments) / 11.5)`,
then blended with the de-vigged market price at 65% market weight. Constants live in
`prediction/src/model.ts`; tune them only through the score-review loop.

## Files

- `.claude/skills/nba-predict/SKILL.md` — the session playbook the user invokes via `/nba-predict`
- `src/predict.ts` — main CLI (fetch → match → model → blend → picks)
- `src/score.ts` — grading + calibration + mistakes report
- `src/model.ts` — probabilities, blending, market/game matching
- `src/polymarket.ts`, `src/espn.ts`, `src/teams.ts` — data layer
- `src/cache.ts` — on-disk snapshot fallback for blocked/offline fetches
- `data/adjustments.json` — per-team point adjustments for today (written each session)
- `data/predictions.jsonl` — append-only prediction log (the system's memory)
- `data/review.md` — latest grading report
- `data/cache/` — transient live-fetch snapshots (git-ignored; see Offline mode)

## Tests

`npm test` includes offline fixture tests for the parsers, matching, and probability math
(`prediction/src/tests/`). The live endpoints can't be reached from every sandbox; on first
local run, if a parser throws a "shape changed" error, inspect the endpoint and adjust.
