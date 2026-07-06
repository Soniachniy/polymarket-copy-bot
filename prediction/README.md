# NBA prediction service for Polymarket

A selective, calibrated predictor for Polymarket NBA moneyline markets, designed to be driven
from a Claude Code session via the `/nba-predict` skill (`.claude/skills/nba-predict/SKILL.md`).

**Just run `/nba-predict` in a session.** The skill orchestrates everything below — it fetches
or researches the slate, encodes game-day adjustments, runs the engine, and reports picks.
`/nba-predict score` grades past picks and tells you how to tune. You don't call the CLI by hand.

## Two ways the data reaches the engine

1. **Live** — the CLI fetches Polymarket + ESPN directly. Works only where outbound network
   egress to `gamma-api.polymarket.com` and `site.api.espn.com` is allowed.
2. **Offline / session-injected** — when egress is blocked (common in locked-down Claude Code
   web sessions), the session layer (Claude, via web search) gathers the slate itself and writes
   a self-contained JSON bundle that the engine scores with **no network access**. This is the
   robust default and keeps the deterministic math identical to the live path (both go through
   `src/core.ts`).

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
# Live path (needs network egress to Polymarket + ESPN)
npm run predict                       # picks above threshold for today's slate
npm run predict -- --all              # every matched game incl. below-threshold (analysis view)
npm run predict -- --save             # append picks to data/predictions.jsonl
npm run predict -- --threshold 0.82   # override confidence threshold
npm run predict -- --date 2026-06-11  # specific date (repeatable)
npm run predict:score                 # grade pending picks, write data/review.md

# Offline path (no network — the session provides the data)
npm run predict -- --input data/input-2026-10-24.json --all    # score a session-built bundle
npm run predict -- --input data/input-2026-10-24.json --save   # ...and log the picks
npm run predict:score -- --results data/results-2026-10-24.json # grade from session-provided finals
```

See `prediction/sample-input.json` for the input-bundle schema. A results file is
`{ "YYYY-MM-DD": [ { "homeAbbr", "awayAbbr", "homeScore", "awayScore" } ] }`.

Games in a bundle with no `marketHomeProb` are scored **model-only** and are never emitted as
auto-picks — a deliberate safety valve, since the market anchor is 65% of the signal.

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

- `src/predict.ts` — main CLI; live fetch **or** `--input` offline bundle → picks
- `src/core.ts` — the single scoring path (blend, market anchor, render, save) shared by both
- `src/offline.ts` — turns a session-provided input bundle into scored rows (no network)
- `src/score.ts` — grading + calibration + mistakes report (live ESPN or `--results` offline)
- `src/model.ts` — probabilities, blending, market/game matching
- `src/polymarket.ts`, `src/espn.ts`, `src/teams.ts` — live data layer
- `data/adjustments.json` — per-team point adjustments for today (written each session)
- `data/predictions.jsonl` — append-only prediction log (the system's memory)
- `data/review.md` — latest grading report

## Tests

`npm test` includes offline fixture tests for the parsers, matching, and probability math
(`prediction/src/tests/`). The live endpoints can't be reached from every sandbox; on first
local run, if a parser throws a "shape changed" error, inspect the endpoint and adjust.
