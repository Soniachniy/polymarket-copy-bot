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

Driven from a Claude Code session by the **`/nba-predict` skill**
(`.claude/skills/nba-predict/SKILL.md`), which contains the full operating instructions:

```
You:    /nba-predict
Claude: gets tonight's slate + market prices, researches injuries/rest/motivation,
        writes adjustments, saves picks, reports PICKS + skipped games

(next day / after games finish)

You:    /nba-predict score
Claude: grades the log vs finals, writes prediction/data/review.md,
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
npm run predict -- --manual FILE      # score a hand-authored slate (see below)
npm run predict -- --offline          # use cached snapshots only, never hit the network
npm run predict:score                 # grade pending picks, write data/review.md
```

## Two ways to feed it data (works with or without network access)

The live hosts are only reachable when they're on the environment's egress allowlist.
Every live fetch is cached to `prediction/data/snapshot/`, and there are two fallbacks so the
engine runs regardless:

- **`--offline`** — recompute from the last cached snapshots without touching the network.
- **`--manual FILE`** — score a slate you (or Claude via web search) wrote by hand. This is the
  fully network-independent path. Minimal shape:

  ```json
  {
    "date": "2026-01-15",
    "games": [
      { "home": "Celtics", "away": "Wizards", "marketHome": 0.90, "homeNetRating": 8.1, "awayNetRating": -9.2 },
      { "home": "Heat", "away": "Bucks", "marketHome": 0.47,
        "adjustments": [ { "team": "Bucks", "points": -6, "reason": "Giannis ruled out, line stale" } ] }
    ]
  }
  ```

  Only `home`, `away`, and one `marketHome` price are required. With no net ratings the model
  anchors entirely on the market price and lets `adjustments` move it. Prices can come from
  Polymarket or from sportsbook moneyline odds (`-150` → `150/250 = 0.60`, then de-vig).

## Data sources (all free, no API keys)

| Source | Used for |
|---|---|
| `gamma-api.polymarket.com/events?tag_slug=nba` | active NBA markets, prices |
| ESPN `site.api.espn.com .../scoreboard` | schedule, home/away, final scores |
| ESPN `.../standings` | W-L, point differential (power ratings) |
| ESPN `.../injuries` | listed Out/Doubtful players |
| Web search (session layer) | late-breaking lineups, rest, motivation |

## Model

`P(home) = Φ((diff_home − diff_away + 2.6 home court + manual adjustments) / 11.5)`,
then blended with the de-vigged market price at 65% market weight. Constants live in
`prediction/src/model.ts`; tune them only through the score-review loop.

## Files

- `../.claude/skills/nba-predict/SKILL.md` — the operator instructions Claude follows
- `src/predict.ts` — main CLI (source → evaluate → blend → picks)
- `src/evaluate.ts` — per-game evaluation (ratings-blend or market-only degrade)
- `src/score.ts` — grading + calibration + mistakes report
- `src/model.ts` — probabilities, inverse-normal, blending, market/game matching
- `src/sources.ts` — live→snapshot fallback + `--offline` resolution
- `src/manual.ts`, `src/snapshot.ts` — network-independent input paths
- `src/polymarket.ts`, `src/espn.ts`, `src/teams.ts` — live data layer
- `data/adjustments.json` — per-team point adjustments for today (live path)
- `data/manual.json` — hand-authored slate (manual path; git-tracked when present)
- `data/predictions.jsonl` — append-only prediction log (the system's memory)
- `data/review.md` — latest grading report
- `data/snapshot/` — regenerable fetch cache (gitignored)

## Tests

`npm test` includes offline fixture tests for the parsers, matching, and probability math
(`prediction/src/tests/`). The live endpoints can't be reached from every sandbox; on first
local run, if a parser throws a "shape changed" error, inspect the endpoint and adjust.
