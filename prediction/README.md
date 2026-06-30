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

## Network egress (one-time setup)

The CLI fetches live data directly, so the session's network policy must allow these hosts:

- `gamma-api.polymarket.com`
- `site.api.espn.com`

In Claude Code on the web, set this when creating the environment (network egress / allowlist).
If a host is missing, `npm run predict` stops with a message naming exactly what to add — it
never fabricates a slate. See https://code.claude.com/docs/en/claude-code-on-the-web for how
network policies are configured. Some sandboxes can't reach these endpoints at all; that is an
environment limitation, not a bug in the predictor.

## Model

`P(home) = Φ((diff_home − diff_away + 2.6 home court + manual adjustments) / 11.5)`,
then blended with the de-vigged market price at 65% market weight. Constants live in
`prediction/src/model.ts`; tune them only through the score-review loop.

## Files

- `src/predict.ts` — main CLI (fetch → match → model → blend → picks)
- `src/score.ts` — grading + calibration + mistakes report
- `src/model.ts` — probabilities, blending, market/game matching
- `src/polymarket.ts`, `src/espn.ts`, `src/teams.ts` — data layer
- `data/adjustments.json` — per-team point adjustments for today (written each session)
- `data/predictions.jsonl` — append-only prediction log (the system's memory)
- `data/review.md` — latest grading report

## Tests

`npm test` includes offline fixture tests for the parsers, matching, and probability math
(`prediction/src/tests/`). The live endpoints can't be reached from every sandbox; on first
local run, if a parser throws a "shape changed" error, inspect the endpoint and adjust.
