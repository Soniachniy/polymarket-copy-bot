# NBA prediction service for Polymarket

A selective, calibrated predictor for Polymarket NBA moneyline markets, designed to be driven
from a Claude Code session via the `/nba-predict` skill.

## How it reaches a ~80% hit rate (read this first)

No model predicts every NBA game at 80% — the betting market itself is only ~68-70% accurate
on all games, and it is the best public forecast that exists. The honest path to 80% is:

1. **Selectivity** — only emit picks whose blended win probability clears a threshold
   (default 0.78). Coin-flip games are skipped on purpose. Some days produce zero picks;
   that is correct behavior, not a bug.
   - **Market-agreement floor (a hard code invariant).** A game can clear the 0.78 blend on the
     model's strength alone (the model carries 35% weight) even when the de-vigged market only
     rates the team a mild ~0.66–0.69 favorite — which loses far more than 1 in 5. So a pick must
     *also* clear a market floor (default 0.70): the sharpest public forecast has to call it a
     clear favorite too. These "model-driven" games are reported as `gate` (not `PICK`) and
     skipped. This turns the old "trust the market, skip outliers" guidance into enforced code on
     both the live and slate paths. Override with `--market-floor` (CLI) or `marketFloor` (slate).
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
npm run predict                       # picks above threshold for today's slate (live APIs)
npm run predict -- --all              # every matched game incl. below-threshold (analysis view)
npm run predict -- --save             # append picks to data/predictions.jsonl
npm run predict -- --threshold 0.82   # override confidence threshold
npm run predict -- --market-floor 0.72 # override the market-agreement floor (default 0.70)
npm run predict -- --date 2026-06-11  # specific date (repeatable)
npm run predict:score                 # grade pending picks, write data/review.md

# Web-research fallback — same engine on a hand-assembled slate (see "Network access" below)
npm run predict:slate -- data/slate.json --all      # review every game in the slate
npm run predict:slate -- data/slate.json --save     # emit + log picks >= threshold
```

## Network access (read this if `predict` fails with a 403 / allowlist error)

The live path fetches two hosts directly: `site.api.espn.com` and `gamma-api.polymarket.com`.
Some environments (locked-down web sandboxes) block outbound egress to arbitrary hosts, so the
direct `fetch` — and even `WebFetch` — return HTTP 403 "Host not in allowlist". Two options:

1. **Allowlist the two hosts** in your environment's network egress settings → the fast live path
   works unchanged.
2. **Use the slate path** (`predict:slate`). `WebSearch` still works when direct fetch is blocked,
   so the `/nba-predict` skill gathers the schedule, team net ratings, Polymarket prices, and
   injuries via web search, writes `data/slate.json`, and runs the *identical* model/blend/selection
   engine on it. No allowlisting required; works in any environment. Schema: `src/slate.ts`.

The `/nba-predict` skill tries the live path first and falls back to the slate path automatically.

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
then blended with the de-vigged market price at 65% market weight. A pick must clear both the
confidence threshold (0.78) **and** the market-agreement floor (0.70 on the de-vigged market
price of the picked side) — the latter vetoes model-driven picks the market doesn't back.
Constants (`MARKET_WEIGHT`, `MARKET_FLOOR`, `HOME_COURT_POINTS`, `MARGIN_SIGMA`) live in
`prediction/src/model.ts`; tune them only through the score-review loop.

## Files

- `.claude/skills/nba-predict/SKILL.md` — the operator instructions the `/nba-predict` skill runs
- `src/predict.ts` — live-API CLI (fetch → match → model → blend → picks)
- `src/slate.ts` — web-research CLI (hand-assembled slate → same engine)
- `src/engine.ts` — shared core: model → market blend → pick → threshold → logging
- `src/score.ts` — grading + calibration + mistakes report
- `src/model.ts` — probabilities, blending, market/game matching
- `src/polymarket.ts`, `src/espn.ts`, `src/teams.ts` — data layer
- `data/adjustments.json` — per-team point adjustments for today (API path; written each session)
- `data/slate.json` — hand-assembled slate for the web-research path (written each session)
- `data/predictions.jsonl` — append-only prediction log (the system's memory)
- `data/review.md` — latest grading report

## Tests

`npm test` includes offline fixture tests for the parsers, matching, and probability math
(`prediction/src/tests/`). The live endpoints can't be reached from every sandbox; on first
local run, if a parser throws a "shape changed" error, inspect the endpoint and adjust.
