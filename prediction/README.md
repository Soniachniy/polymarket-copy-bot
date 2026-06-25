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

The whole thing is driven from one Claude Code skill — you run a session, it does
the rest. The predefined instructions live in `.claude/skills/nba-predict/SKILL.md`.

```
You:    /nba-predict
Claude: gets the slate + prices + ratings (live APIs, or web research if blocked),
        researches tonight's injuries/rest/motivation, encodes them as point
        adjustments, runs the engine, saves picks, reports PICKS + skipped games

(next day / after games finish)

You:    /nba-predict score
Claude: grades the log vs final scores, writes prediction/data/review.md,
        classifies each miss (variance / information miss / model error),
        proposes and applies tuning
```

Commit `prediction/data/*` after each session — the JSONL log is the system's memory.

### Why a skill, not just a script

The CLI does the math; it can't see tonight's lineup. The skill is the session
layer that researches game-day information (injuries, rest, load management) with
web search and turns it into the point adjustments the model needs. That research
step is where most of the edge — and most of the misses to learn from — lives.

## Offline / API-blocked mode (network-independent)

Some environments block `site.api.espn.com` / `gamma-api.polymarket.com` (egress
allowlists, rate limits). The engine then runs identically from a hand-built data
file the session layer fills via web research:

```bash
# 1. copy the template and fill it from web research (see input.example.json)
cp prediction/data/input.example.json prediction/data/input.today.json
# 2. generate + save picks with no API calls
npm run predict -- --input prediction/data/input.today.json --save
# 3. later, grade offline from a results file
npm run predict:score -- --results prediction/data/results.json
```

The model, blending, threshold, calibration, and logging are byte-for-byte the same
as live mode — only the data source changes. `prediction/data/input.example.json`
documents every field.

## CLI (what the skill runs under the hood)

```bash
npm run predict                       # picks above threshold for today's slate (live APIs)
npm run predict -- --all              # every matched game incl. below-threshold (analysis view)
npm run predict -- --save             # append picks to data/predictions.jsonl
npm run predict -- --threshold 0.82   # override confidence threshold
npm run predict -- --date 2026-06-11  # specific date (repeatable)
npm run predict -- --input FILE       # offline: read the slate from a manual data file
npm run predict:score                 # grade pending picks vs live finals, write data/review.md
npm run predict:score -- --results F  # offline: grade against a manual final-scores file
```

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

- `../.claude/skills/nba-predict/SKILL.md` — the session playbook (`/nba-predict`)
- `src/predict.ts` — main CLI (fetch/manual → match → model → blend → picks)
- `src/score.ts` — grading + calibration + mistakes report (live or `--results`)
- `src/model.ts` — probabilities, blending, market/game matching
- `src/manual.ts` — offline data loader (manual slate → pipeline shapes)
- `src/polymarket.ts`, `src/espn.ts`, `src/teams.ts` — live data layer
- `data/adjustments.json` — per-team point adjustments for today (LIVE mode)
- `data/input.example.json` — template for offline/manual slates
- `data/predictions.jsonl` — append-only prediction log (the system's memory)
- `data/review.md` — latest grading report

## Tests

`npm test` includes offline fixture tests for the parsers, matching, and probability math
(`prediction/src/tests/`). The live endpoints can't be reached from every sandbox; on first
local run, if a parser throws a "shape changed" error, inspect the endpoint and adjust.
