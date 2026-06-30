---
name: nba-predict
description: >-
  Generate selective, calibrated NBA win predictions for Polymarket moneyline
  markets, and grade/tune past predictions. Use when the user types /nba-predict,
  asks for today's NBA picks, asks who will win tonight's NBA games for Polymarket,
  or asks to score / review / tune previous NBA predictions. Targets ~80% hit rate
  by only emitting high-confidence picks and skipping coin-flip games.
---

# NBA prediction service (Polymarket moneyline)

You drive a calibrated pipeline that fetches live markets + team ratings, blends a
ratings model with the de-vigged market price, layers in **game-day research you do
yourself** (injuries, rest, motivation), and emits only picks that clear a confidence
threshold. The mechanism that reaches ~80% is **selectivity**: you skip games you
aren't confident about. Some days have zero picks — that is the correct output, never a
failure to paper over.

The pipeline code lives in `prediction/`. You run it via `npm run predict` /
`npm run predict:score`. The append-only log `prediction/data/predictions.jsonl` is the
system's memory; it must be committed after every session.

## Modes

Pick the mode from the user's argument after `/nba-predict`:

- **(no arg)** or a date like `2026-01-15` → **PREDICT** mode (generate picks).
- **`score`**, **`review`**, **`grade`** → **SCORE** mode (grade past picks + tune).

If unsure, default to PREDICT for today.

---

## PREDICT mode — step by step

Do these in order. Do not skip the research step (step 3); it is the part that turns a
market-echo into an edge.

### 1. Pull the slate + model baseline (read-only first)

Run, passing `--date YYYY-MM-DD` for each date the user named (omit for today):

```bash
npm run predict -- --all --json            # today, every matched game incl. below-threshold
npm run predict -- --all --json --date 2026-01-15   # a specific date
```

This prints a JSON array of matched games with, per game: `question`, `pickTeam`,
`probability` (blended), `pModel`, `pMarket`, `edge`, plus any `Out/Doubtful` players
ESPN already listed (in `rationale`). Read it.

**If it fails with a network/egress error:** the message lists the hosts to allowlist
(`gamma-api.polymarket.com`, `site.api.espn.com`). Relay that to the user verbatim and
**stop** — do not invent a slate or guess scores. This is one-time environment setup
(see `prediction/README.md` → network egress). Off-season / no games scheduled → report
"no NBA slate for <date>" and stop; that is normal.

### 2. List the matched games

For each matched game note the two teams, who is home, the model probability, and the
market probability. Games where `pModel` and `pMarket` disagree by a lot deserve the most
research — one of them is wrong.

### 3. Research each game's game-day situation (the edge)

Season ratings cannot see tonight's lineup. For **each matched game**, use `WebSearch`
(and `WebFetch` on a result if needed) to establish, as of the game date:

1. **Injuries / inactives** — Is any star **Out** or **Doubtful**? Confirm against the
   latest injury report, not a stale one. Search e.g.
   `"<Team> injury report <date>"`, `"<Star> playing tonight <date>"`.
2. **Rest** — Is either team on the **second night of a back-to-back**, or on a long road
   trip / 3-in-4? B2B is worth roughly **−2 to −3 points** for the tired team.
3. **Recent form & motivation** — Tanking for lottery odds, resting starters with a locked
   seed, a team on a long losing/winning streak, a revenge/rivalry spot.
4. **Lineup certainty** — If a star's status is still **Questionable / game-time decision**
   at the time you run, treat the game as **unresolved → skip it** (do not pick and do not
   guess). Uncertain star availability is the #1 cause of busted high-confidence picks.

Be efficient: research the matched games only, not the whole league. You may research
several games' searches in parallel.

### 4. Encode findings as point adjustments

Translate what you found into per-team point adjustments and write
`prediction/data/adjustments.json`. Each key is a **team abbreviation** (BOS, LAL, GSW…),
value is `{ "points": <number>, "reason": "<short>" }`. `points` is added to that team's
expected margin: **negative weakens** the team, positive strengthens it. Overwrite the
whole file each run (stale adjustments must not leak into a new slate).

Rubric (use judgment; do not stack beyond reality):

| Situation | Points |
|---|---|
| Clear All-NBA / franchise star ruled **Out** | −5 to −8 |
| Quality starter / 2nd option **Out** | −2 to −4 |
| Role player **Out** | −0.5 to −1.5 |
| Team on 2nd night of a back-to-back | −2 to −3 |
| Key player **returning** from injury (was out, now in) | +1 to +3 |
| Opponent resting starters (locked seed) | apply the **negative** to the resting team |
| Tanking team (late season, lottery incentive) | −2 to −4 |

Example `adjustments.json`:

```json
{
  "MIL": { "points": -7, "reason": "Giannis OUT (knee), confirmed inactive" },
  "DEN": { "points": -2.5, "reason": "2nd night of back-to-back, traveled from LAC" }
}
```

If you found nothing material for a slate, write `{}` — that is valid.

### 5. Generate + save the picks

Re-run with the adjustments applied and save the ones that clear the threshold:

```bash
npm run predict -- --save --json           # add --date ... to match step 1
```

Use the default threshold (0.78) unless the score-review loop has told you to change it,
or the user asks for more/fewer picks (`--threshold 0.82` = stricter/fewer,
`--threshold 0.75` = looser/more). `--save` appends only picks above threshold and
de-dupes by market, so it is safe to re-run.

### 6. Report to the user

Present clearly:

- **PICKS** (above threshold): for each → matchup, the team to bet, the Polymarket outcome
  label, blended confidence %, and a one-line reason citing the decisive factor (model
  edge, injury, rest). Order by confidence.
- **Skipped** (below threshold or deliberately skipped): one line each with why
  ("coin-flip, 61%", "star Questionable — unresolved"). This is a feature; show it.
- State the count: "N picks / M matched games" and remind that an 80%-confidence pick is
  expected to lose ~1 in 5 — variance on a single pick is not a model failure.
- Note that `prediction/data/predictions.jsonl` and `adjustments.json` were updated and
  should be committed.

Never round a 70% game up to a pick to "give the user something." Discipline is the product.

---

## SCORE mode — grade and tune

Run after games finish (usually the next day).

### 1. Grade

```bash
npm run predict:score
```

This fetches ESPN finals, marks each pending pick `correct`/`incorrect`, and writes
`prediction/data/review.md` with accuracy, Brier score, calibration buckets, and the list
of misses. Read `review.md`.

### 2. Classify every miss

For each incorrect pick, decide which bucket it falls in — this drives tuning:

- **Variance** — pick was sound, the underdog just won. Expected ~1-in-5 at 80%. No change.
- **Information miss** — a late scratch / lineup / rest fact existed before tip that the
  research step missed. → tighten the research checklist (step 3), not the math.
- **Model error** — model probability sat far above market and was wrong (overconfident
  model). → recurring pattern means lower model weight.

Use WebSearch on the game date if you need to confirm whether news was knowable pre-tip.

### 3. Propose + apply tuning (only with evidence)

Tune only on a *pattern across several graded picks*, never on one bad night:

- Accuracy below 80% and misses cluster in the **78–85%** band → raise the threshold
  (run future predicts with `--threshold 0.82`); record the new default in the skill notes
  below and in `review.md`.
- Per-bucket hit rate consistently **above** stated confidence → you are too strict; lower
  the threshold toward 0.75 to capture left-on-the-table picks.
- Misses driven by **model-vs-market** disagreement → lower `MARKET_WEIGHT` is wrong; the
  market was right, so **raise** `MARKET_WEIGHT` toward 0.7–0.75 in
  `prediction/src/model.ts` (respect the market more).
- Misses driven by injury surprises → enforce the "Questionable star ⇒ skip" rule harder.

Make the smallest change that addresses the pattern. Re-run `npm test` after editing
`model.ts`. Summarize what you changed and why.

### 4. Commit the memory

After either mode, commit the data so the system remembers:

```bash
git add prediction/data/predictions.jsonl prediction/data/review.md prediction/data/adjustments.json
git commit -m "nba-predict: <picks for DATE | scored DATE, accuracy X%>"
```

---

## Guardrails (do not violate)

- **Never fabricate** games, prices, injuries, or final scores. If data can't be fetched,
  say so and stop.
- **Selectivity over volume.** Zero qualifying picks is a valid, correct result.
- **Skip on uncertainty**, especially unresolved star availability.
- **80% is accuracy, not profit.** High-confidence picks trade at high prices on
  Polymarket; this service answers "who wins", not "is this price +EV". Say so if the user
  conflates them.
- The market is the sharpest public forecast. Your edge is game-day information it may not
  have fully priced yet — not out-predicting it on paper.

## Files this skill touches

- `prediction/data/adjustments.json` — you write this each PREDICT run.
- `prediction/data/predictions.jsonl` — append-only log (`--save`); the memory.
- `prediction/data/review.md` — written by SCORE mode.
- `prediction/src/model.ts` — constants; edit only via the SCORE tuning loop.

## Current tuning defaults

- Confidence threshold: **0.78**
- Market weight in blend: **0.65**
- (Update these two lines whenever the SCORE loop changes them, so the next session knows.)
