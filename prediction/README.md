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

The whole system is driven from a Claude Code session by the **`/nba-predict` skill**
(`.claude/skills/nba-predict/SKILL.md`). You don't run commands by hand — you type the
command and Claude executes the predefined protocol.

```
You:    /nba-predict
Claude: gets today's slate + market prices, researches injuries/rest/lineups,
        writes adjustments, computes picks at the 0.78 threshold, saves them,
        reports PICKS + the games it skipped (and why)

(next day / after games finish)

You:    /nba-predict score
Claude: grades the log vs final scores, writes prediction/data/review.md,
        classifies each miss (variance / information miss / model error),
        proposes and applies one tuning change
```

Commit `prediction/data/*` after each session — the JSONL log is the system's memory.

## Two data paths (why it runs anywhere)

The model math is identical either way — both paths call `src/core.ts`.

1. **Direct API (fast path):** `npm run predict` pulls Polymarket + ESPN directly. This only
   works if the runtime can reach `gamma-api.polymarket.com` and `site.api.espn.com`. In a
   network-restricted Claude Code web session these hosts are blocked (HTTP 403); add them to
   the environment's egress allowlist to enable this path.
2. **In-session research (works anywhere):** when the APIs are blocked, the skill gathers the
   same inputs (point differentials, market prices, injuries) via `WebSearch`/`WebFetch`,
   writes them to a JSON file, and runs `npm run predict:compute -- --input <file>` — the same
   probabilities, no direct host access required.

## CLI (what the skill runs under the hood)

```bash
npm run predict                       # picks above threshold for today's slate (direct API)
npm run predict -- --all              # every matched game incl. below-threshold (analysis view)
npm run predict -- --save             # append picks to data/predictions.jsonl
npm run predict -- --threshold 0.82   # override confidence threshold
npm run predict -- --date 2026-06-11  # specific date (repeatable)
npm run predict:compute -- --input slate.json --all   # offline: score a slate you researched
npm run predict:compute -- --input slate.json --save  # offline: save those picks to the log
npm run predict:score                 # grade pending picks, write data/review.md
```

The `--input` file schema for `predict:compute` is documented at the top of
`prediction/src/compute.ts` (per-game: home/away abbrs, point diffs, market prices, optional
confirmed-injury point adjustments).

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

- `src/predict.ts` — direct-API CLI (fetch → match → model → blend → picks)
- `src/compute.ts` — offline CLI: same math on a slate you researched in-session
- `src/core.ts` — shared forecast/blend/threshold/save logic used by both CLIs
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
