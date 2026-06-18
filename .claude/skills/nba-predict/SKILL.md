---
name: nba-predict
description: >-
  Generate calibrated NBA moneyline predictions for Polymarket, or grade
  past predictions. Use when the user types /nba-predict, asks for NBA
  picks/predictions for tonight's slate, asks "who wins" NBA games for
  betting, or asks to score/grade/review previous NBA predictions. Runs the
  prediction pipeline in prediction/, researches game-day injuries and rest
  with web search, writes point adjustments, saves picks, and reports.
---

# NBA prediction service for Polymarket

You are the **session layer** of a two-part NBA predictor. The deterministic
math lives in `prediction/` (ratings model + de-vigged market blend). Your job
is to add the one thing the math cannot see on its own — **tonight's
information** (injuries, rest, motivation) — and to run the pipeline honestly.

The target is **80% hit rate on emitted picks**. The only way to hit it is
**selectivity**: emit a pick only when blended confidence clears the threshold
(default 0.78), and skip everything else. Days with zero picks are a correct
output, not a failure. Never invent picks to fill a slate.

## Modes

- `/nba-predict` (default) → generate picks for today's slate.
- `/nba-predict score` → grade past pending picks against final scores.
- Pass-through flags also work: `--threshold 0.82`, `--date 2026-06-19`
  (repeatable), `--all` (show below-threshold games too).

Decide the mode from the user's words: "score", "grade", "review", "how did we
do", "check yesterday" → **score mode**. Anything else → **predict mode**.

---

## PREDICT MODE — run these steps in order

### Step 1 — Pull the slate (no adjustments yet)

```bash
npm run predict -- --all
```

Read the output. It lists every matched game with the model probability, the
de-vigged market probability, and the blended confidence. If it errors with a
"shape changed" / "Host not in allowlist" message, see **Troubleshooting**.

If zero games matched, tell the user there is no NBA slate today (or markets
aren't open yet) and stop. Do not fabricate games.

### Step 2 — Research tonight's information (the part that earns the 80%)

For **every matched game** — especially any sitting near the threshold — use
**WebSearch** (and WebFetch on primary sources) to find what changed since the
season averages were computed. Search same-day, e.g.:

- `"<Team> injury report <today's date>"`
- `"<Team> vs <Team> starting lineup tonight"`
- `"<star player> status tonight questionable out"`
- `"<Team> back to back" / "load management <player>"`

Look specifically for, in rough order of impact:

1. **Star ruled OUT** — a top-2 player on a team. Biggest single swing.
2. **Star QUESTIONABLE / game-time decision** — unresolved. See rule below.
3. **Rest / load management** — healthy stars resting (common in back-to-backs
   and tank/playoff-locked situations late season).
4. **Rotation injuries**, schedule spots (3rd game in 4 nights, long road trip).
5. **Motivation** — tanking, locked playoff seed, eliminated, must-win.

Cross-check ESPN's `injuries` endpoint output (the pipeline already prints
listed Out/Doubtful players in each game's rationale) against fresher reporting;
beat reporters are usually ahead of the official feed.

### Step 3 — Encode findings as point adjustments

Write `prediction/data/adjustments.json`. Keys are **team abbreviations** (see
`prediction/src/teams.ts`). `points` is added to that team's expected margin —
**negative weakens the team**. Calibrate roughly:

| Situation | Points |
|---|---|
| MVP-tier / top-2 star ruled OUT | -5 to -7 |
| Quality starter OUT | -2 to -4 |
| Healthy stars rested (load management) | -4 to -8 |
| Key rotation player OUT | -1 to -2 |
| Strong rest edge (opp on 2nd night of back-to-back) | +1 to +2 to the rested team |
| Pure motivation (tanking, eliminated) | -2 to -4 |

Example:

```json
{
  "LAL": { "points": -6, "reason": "Luka Doncic ruled OUT (calf), per Shams 6/18" },
  "DEN": { "points": 1.5, "reason": "opponent on 2nd night of back-to-back" }
}
```

Only include teams you found real news for. An empty file (`{}`) is fine when
nothing changed — do not pad it.

**Overwrite this file fresh every session.** It is not cumulative — yesterday's
"star OUT" must not leak into today's slate. Replace the whole contents; start
from `{}` if today is clean.

**Hard rule on unresolved star "Questionable":** if a top player's status is a
true game-time decision and you cannot confirm it, do **not** guess a number to
push the game over the threshold. Either leave that team unadjusted (the market
price already partly reflects the uncertainty) or, if the whole pick hinges on
that one player, note it and let the game fall below threshold. Skipping beats
guessing — one wrong star call is what blows up a 5-pick slate.

### Step 4 — Regenerate and save

```bash
npm run predict -- --save
```

This re-runs with your adjustments applied and appends picks above the threshold
to `prediction/data/predictions.jsonl` (the append-only memory; it won't
double-log a market). Use `--threshold 0.82` if the user wants to be stricter,
or if the last `score` review recommended raising it.

### Step 5 — Report to the user

Present, in plain language:

1. **PICKS** — for each: matchup, the team to back, the Polymarket outcome
   label, blended confidence %, and a one-line "why" citing the key
   model/market/injury factor. Order by confidence, highest first.
2. **Skipped (near threshold)** — games that were close but didn't clear it, and
   the single reason (coin-flip, unresolved star status, model vs market
   disagreement).
3. **Adjustments applied** — the teams + reasons you wrote, so the user can
   sanity-check your research.
4. A reminder: **"~80% confidence means roughly 1 in 5 of these should still
   lose — that is expected and is how the calibration stays honest."**

Then tell the user to run `/nba-predict score` after the games finish, and to
commit `prediction/data/*` so the memory persists.

---

## SCORE MODE

```bash
npm run predict:score
```

This grades every pending pick against ESPN final scores, updates
`predictions.jsonl` in place, and writes `prediction/data/review.md` with
accuracy, Brier score, a calibration table, and a per-miss breakdown.

After it runs:

1. Read `prediction/data/review.md` and summarize: overall accuracy vs the 80%
   target, Brier score, and the calibration table (does each confidence bucket's
   realized hit rate match its stated confidence?).
2. **Classify every miss** into one of three buckets — this is the learning loop:
   - **Variance** — pick was sound, the underdog just won. A correctly
     calibrated 80% pick loses ~20% of the time. No model change.
   - **Information miss** — late news (a star sat, a lineup change) that
     game-day research should have caught. Tighten the research checklist /
     adjustment for that case.
   - **Model error** — the model was structurally overconfident vs the market,
     or a parsing/matching bug. Consider lowering `MARKET_WEIGHT` in
     `prediction/src/model.ts` or raising the threshold.
3. **Propose concrete tuning** following the guidance printed in `review.md`:
   - Accuracy < 80% and misses cluster in the 78–85% bucket → raise threshold.
   - Per-bucket hit rate consistently *above* stated confidence → threshold can
     come down (you're leaving good picks on the table).
   - Misses cluster on injury surprises → strengthen the Step 2 research rule.
   - Model and market disagreed badly on misses → lower `MARKET_WEIGHT`.
4. Apply only changes the user approves (or obvious, low-risk ones), then remind
   them to commit `prediction/data/*`.

---

## Troubleshooting

- **`Host not in allowlist` / 403 on `site.api.espn.com` or
  `gamma-api.polymarket.com`** — the environment's network egress policy is
  blocking the data sources. The pipeline cannot run without them. Ask the user
  to allowlist these hosts in their environment's network settings (or run the
  session under a policy that permits them):
  - `gamma-api.polymarket.com`
  - `site.api.espn.com`
- **"response shape likely changed" error** — ESPN or Gamma changed their JSON.
  Inspect the failing endpoint (curl/WebFetch it) and update the parser in
  `prediction/src/espn.ts` or `prediction/src/polymarket.ts`. Run
  `npm test` after fixing.
- **A market didn't match its ESPN game** — check the team alias/abbr in
  `prediction/src/teams.ts`; add the missing alias.

## What NOT to do

- Don't emit a pick just because the user wants action on a slate.
- Don't guess injury statuses or invent adjustment points to clear the threshold.
- Don't claim 80% accuracy on any single game — 80% is the long-run hit rate
  over many *selected* picks, not a guarantee per game.
- Don't confuse accuracy with profit. High-confidence picks trade at high
  prices; this service answers "who wins", not "is this price +EV".
