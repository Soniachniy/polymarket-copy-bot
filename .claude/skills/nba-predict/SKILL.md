---
name: nba-predict
description: >-
  Generate selective, calibrated NBA moneyline predictions for Polymarket aimed at an ~80%
  hit rate, and grade past predictions. Use when the user types /nba-predict, asks for NBA
  picks / win predictions for tonight's slate, or asks to score/grade/review past NBA picks.
  Drives the engine in prediction/ (ratings + de-vigged market blend) and adds the game-day
  research layer (injuries, rest, motivation) that the offline model cannot see.
argument-hint: "[score] [--threshold 0.80] [--date YYYY-MM-DD]"
---

# NBA prediction service for Polymarket

You are the orchestration layer for a selective NBA moneyline predictor. The TypeScript engine
in `prediction/` does the math (power ratings + de-vigged Polymarket price blend). YOUR job is
the part the offline engine cannot do: research tonight's real-world information (injuries,
rest, motivation), encode it as point adjustments, enforce selectivity, and report.

## The 80% contract — read before doing anything

No model wins 80% of *all* NBA games; the market itself is only ~68-70% accurate, and it is the
sharpest public forecast that exists. We reach ~80% **on the picks we actually emit** through:

1. **Selectivity.** Only emit a pick when blended confidence ≥ threshold (default **0.78**;
   raise toward 0.80–0.82 if the review loop shows misses clustered just above the line).
   Coin-flip games are skipped on purpose. **Zero picks on a given day is a correct, expected
   output — never invent picks to fill the slate.**
2. **Market anchoring.** Final probability blends the ratings model (35%) with the de-vigged
   Polymarket price (65%). Do not override the market on a hunch.
3. **Game-day information.** This is your value-add. Season ratings can't see that a star is
   out tonight or that a team is on the back end of a back-to-back. You research it and encode
   it as point adjustments before picks are generated.
4. **Honest grading.** A run of 80% picks *should* lose ~1 in 5. Calibration, not a hot streak,
   is the goal. Grade every pick and tune from misses.

Accuracy ≠ profit: high-confidence picks trade at high prices. This service answers "who wins",
not "is this price +EV". Say so if the user conflates them.

---

## Mode A — generate predictions (default, or `/nba-predict`)

### Step 1 — fetch the slate (analysis view)
Run from the repo root:

```bash
npm run predict -- --all
```

This prints every matched game with the raw model %, market %, and blended confidence, including
games below threshold. Read it; this is your candidate list.

**If the command errors with a network/egress 403** (e.g. "Host not in allowlist:
gamma-api.polymarket.com"), the run environment is blocking the data hosts. Tell the user to
add `gamma-api.polymarket.com` and `site.api.espn.com` to the environment's network egress
allowlist (see Claude Code on the web → network settings), then re-run. Do NOT fabricate a slate.

### Step 2 — research game-day information (the 80% step)
For **every matched game that is within ~10 points of the threshold OR involves a clear
favorite** (i.e. any game you might pick or whose pick might flip), use `WebSearch` to find, for
tonight's date:

- **Injuries / availability** — search e.g. `"<Team> injury report <date> out questionable"`.
  Focus on players who move a line: stars and high-minutes starters.
- **Rest** — is either team on a back-to-back, or on a long road trip / 3rd game in 4 nights?
- **Motivation / context** — tanking, locked playoff seed, load management, must-win, blowout
  risk of resting starters late season.

Prefer primary/sharp sources surfaced in step-1 README list and search: official.nba.com,
espn.com/nba/injuries, rotowire, covers.com, lineups.com. Cross-check at least two when a star's
status is decisive.

### Step 3 — encode adjustments
Write `prediction/data/adjustments.json` as a JSON object keyed by team abbreviation. Points are
ADDED to that team's expected margin (negative = weaker). Calibrated magnitudes:

| Situation | Points |
|---|---|
| MVP-tier star ruled **Out** (e.g. top-15 player) | −4 to −6 |
| Quality starter ruled **Out** | −1.5 to −3 |
| Second key rotation player Out (stacking) | additional −1 to −2 |
| Back-to-back (tired team) | −1.5 |
| Resting healthy starters (late-season, locked seed) | −3 to −5 |
| Key player **returning** from injury | +1.5 to +3 |

Example:

```json
{
  "LAL": { "points": -5, "reason": "Luka Doncic OUT (calf), confirmed on official report" },
  "BOS": { "points": -1.5, "reason": "back-to-back, 2nd of road trip" }
}
```

**Hard rule — unresolved star status = SKIP, not adjust.** If a line-moving star is listed
**Questionable/Game-Time Decision** and you cannot confirm in/out from a second source, do NOT
guess a partial adjustment. Instead exclude that game from picks (note it as skipped). Injury
surprises are the #1 cause of confident misses; treat ambiguity as a reason to pass.

Only include teams playing today that have a real adjustment. Reset stale entries each run
(overwrite the file; don't accumulate yesterday's adjustments).

### Step 4 — regenerate and log picks
```bash
npm run predict -- --save
```

This applies your adjustments, prints picks ≥ threshold, and appends new picks to
`prediction/data/predictions.jsonl` (it won't double-log a market). Use `--threshold 0.80` /
`--date YYYY-MM-DD` if the user asked.

### Step 5 — report
Give the user, concisely:

- **PICKS** — for each: matchup, the team to back + Polymarket outcome label, confidence %,
  the model%/market% split, and a one-line reason (the decisive injury/rest/rating fact).
- **Skipped (notable)** — games you deliberately passed and why (coin-flip, unresolved star).
- **Stake guidance** — these are win-probability calls, not +EV calls; suggest flat sizing and
  remind that an 80% slate is expected to lose ~1 in 5.
- Tell the user to **commit `prediction/data/*`** so the log (the system's memory) persists.

---

## Mode B — score / grade (`/nba-predict score` or "grade/review past picks")

### Step 1 — grade
```bash
npm run predict:score
```

This fetches ESPN finals, marks each pending pick correct/incorrect in
`predictions.jsonl`, and writes `prediction/data/review.md` (accuracy vs 80% target, Brier
score, calibration buckets, list of misses).

### Step 2 — classify every miss
Read `review.md`. For each incorrect pick, label the cause:

- **Variance** — model & market both reasonably favored the pick; it just lost. (Expected;
  no action. An 80% bucket losing ~20% of the time is correct.)
- **Information miss** — late lineup/rest/motivation news you didn't capture. (Action: tighten
  the research checklist; this is where accuracy is recovered.)
- **Model error** — the model sat far above the market and was wrong. (Action: trust the market
  more.)

Use `WebSearch` if needed to reconstruct what was knowable at pick time.

### Step 3 — propose and apply tuning
Decide from the pattern, then make the edit:

- Accuracy < 80% with misses clustered in the 78–85% bucket → raise default threshold
  (`DEFAULT_THRESHOLD` in `prediction/src/predict.ts`, e.g. 0.78 → 0.82).
- Per-bucket hit rate consistently **above** stated confidence → you're too selective; lower the
  threshold to capture more picks.
- Misses are mostly **model error** (model >> market) → raise `MARKET_WEIGHT` in
  `prediction/src/model.ts` (e.g. 0.65 → 0.72).
- Misses are mostly **information misses** on Questionable stars → enforce the Step-3 SKIP rule
  harder; do not relax it.

Make exactly one principled change at a time, explain it, and note it for the next review so the
effect is measurable. Re-run `npm test` after editing engine constants.

### Step 4 — report & persist
Summarize: graded N, accuracy, Brier, the miss classification breakdown, and the one tuning
change you applied. Remind the user to **commit `prediction/data/*`** and any engine edit.

---

## Guardrails
- Never emit a pick for a game where a decisive star's status is unresolved — skip it.
- Never fill a thin slate with low-confidence picks to look productive.
- Never claim 80% on all games; the 80% target applies to emitted picks and is a calibration
  goal, verified only through the score loop.
- Keep `adjustments.json` to today's real, sourced adjustments; overwrite stale ones.
- Always tell the user to commit `prediction/data/*` — the JSONL log is the system's memory.
```
