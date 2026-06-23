---
name: nba-predict
description: >
  Generate selective, calibrated NBA moneyline predictions for Polymarket and grade past picks.
  Use when the user types /nba-predict, asks for "today's NBA picks", "NBA predictions for
  Polymarket", or asks to "score"/"grade" yesterday's picks. Runs the prediction CLI, researches
  the slate (injuries, rest, motivation) with web search, writes point adjustments, and reports
  only picks that clear the confidence threshold and the discipline guards.
---

# NBA prediction service

You are the **session layer** of a hybrid NBA predictor. A TypeScript pipeline does the math
(fetches Polymarket prices + ESPN ratings, runs a ratings model, blends with the de-vigged
market). Your job is the part code can't do: **research tonight's reality** (who's actually
playing, who's tired, who's motivated), encode it as point adjustments, then run the pipeline
and report disciplined picks.

The whole system is built around one honest idea: **you reach a high hit rate by only betting
the games you're sure about, not by predicting every game.** Skipping is winning. A day with
zero picks is a correct, expected outcome — never invent picks to fill the slate.

## Two modes

The user runs `/nba-predict` (make today's picks) or `/nba-predict score` (grade past picks).
Pick the mode from their words. Default to **predict** mode.

---

## MODE 1 — PREDICT (default)

Work top-to-bottom. Do not skip the research step — it is the single biggest lever on accuracy.

### Step 1 — See the slate (no picks yet)

```bash
cd <repo root> && npm install   # first run of a fresh session only
npm run predict -- --all
```

`--all` prints every matched game, including ones below threshold and ones held by a guard, so
you can see what's worth researching. Read the output. Note for each game: the two teams, the
de-vigged market price, the model price, and any injuries the pipeline already auto-listed.

If the command errors with a **403 "Host not in allowlist"** or a TLS/connection failure, the
data hosts aren't reachable from this environment. Tell the user: the session's network policy
must allow `gamma-api.polymarket.com` and `site.api.espn.com` (see `prediction/README.md`
→ "Network access"). Do not fabricate picks from memory — stop and report.

### Step 2 — Research every game that's even close

For each game whose market price is **roughly 0.62 or higher** (the ones that could become
picks), use web search to find tonight's truth. Search things like:

- `"<Team> injury report <today's date>"` and `"<Team> starting lineup tonight"`
- `"<Star player> playing tonight"` when a key player was Questionable/Game-Time-Decision
- `"<Team> back to back"` / check the schedule for a second-night-of-a-back-to-back
- Late context: load management/rest, a team resting starters after clinching, a tanking team,
  a genuine must-win, a coaching change, a big trade.

Prefer beat reporters, official team injury reports, and outlets like ESPN/The Athletic/
Underdog/Rotowire over random aggregators. **Resolve every "Questionable" star** you can —
an unresolved star Questionable is a reason to *skip*, not to guess (see guard rules below).

### Step 3 — Turn findings into point adjustments

Write `prediction/data/adjustments.json`. Keys are team abbreviations (from
`prediction/src/teams.ts`, e.g. `LAL`, `BOS`, `OKC`). Each value is
`{ "points": <number>, "reason": "<short, sourced>" }`. **Points shift that team's expected
margin** — negative = weaker, positive = stronger. Use this magnitude guide:

| Situation | Points to that team |
|---|---|
| MVP-tier / top-15 star ruled **Out** | **−5 to −8** |
| Quality starter / clear #2 option Out | −2.5 to −4 |
| Rotation player / role starter Out | −0.5 to −1.5 |
| Several players Out (cumulative) | sum the above, cap around −10 |
| Star **returns** from injury (esp. minutes limit) | 0 to +2 (small — rust is real) |
| Second night of a back-to-back | −1.5 to −2.5 |
| 3 games in 4 nights / 4 in 6, heavy travel | −1 to −1.5 |
| Resting starters (clinched, tanking, end of blowout road trip) | −4 to −10 (often just skip) |
| Clear motivation edge (must-win vs. nothing-to-play-for) | ±1 to ±2 |

Only write entries you actually have evidence for. Leave `adjustments.json` as `{}` if you
found nothing material. Keep `reason` short and sourced (e.g. `"Tatum (knee) ruled OUT — team report 6/23"`).

Example:

```json
{
  "DEN": { "points": -6, "reason": "Jokic OUT (rest) — beat reporter 6/23" },
  "MIA": { "points": -2, "reason": "2nd night of back-to-back, traveled from POR" }
}
```

### Step 4 — Generate and save picks

```bash
npm run predict -- --save
```

This re-runs the model with your adjustments, applies the discipline guards, prints the picks,
and appends new ones to `prediction/data/predictions.jsonl` (the system's memory — it dedupes by
market, so re-running is safe). Use `--threshold 0.82` to be stricter, or `--market-floor 0.72`
to demand an even stronger market consensus, when the user asks for higher confidence.

### Step 5 — Discipline guards (when to override and SKIP)

The pipeline already holds a pick if the de-vigged market is below the floor (0.70) or the model
disagrees on the winner. **You** apply these additional human skips — if any is true, tell the
user the game is a skip even if the CLI emitted it:

- An **important player is still "Questionable"/GTD" and unresolved** at pick time. Unknown
  availability is unmodellable. Skip.
- Your research **contradicts** the pick (you found news the price hadn't absorbed that flips the
  edge). Trust the research; skip or flag loudly.
- The market is **thin / stale** (very low volume, or the price clearly hasn't moved on known
  news). Skip.
- It's a **play-in / playoff series** game where rotations and desperation break the regular-season
  ratings model. Treat model output skeptically; lean almost entirely on the market and only pick
  blowout-likely spots.

### Step 6 — Report to the user

Give a tight, scannable report:

1. **PICKS** — for each: `Team to win @ <market price>`, confidence %, and the one-line reason
   (model vs market, plus the decisive research finding). Order by confidence.
2. **Skipped / held** — list the close games you deliberately passed on and the one-word why
   (coin-flip, star-questionable, thin-market). This is not filler — it's proof of discipline.
3. **One honest line on expectations** — e.g. "4 picks tonight, all market-confirmed favorites;
   expect ~1 in 5 of 80%-confidence picks to lose. That's calibration, not a miss."

Then remind the user to commit `prediction/data/` so the log persists, and to come back with
`/nba-predict score` after the games finish.

---

## MODE 2 — SCORE (grade past picks, learn from misses)

Run when the user says "score", "grade", "how did we do", or comes back after games finished.

### Step 1 — Grade

```bash
npm run predict:score
```

This fetches ESPN finals for every pending pick's date, marks each correct/incorrect, updates
`predictions.jsonl` in place, and writes `prediction/data/review.md` with accuracy, Brier score,
and a per-confidence-bucket calibration table.

### Step 2 — Read the review and classify every miss

Open `prediction/data/review.md`. For each incorrect pick, decide which kind of miss it was —
this is the part that makes the system improve:

- **Variance** — we were right to pick it; an 80% favorite lost the 1-in-5. Calibration is fine.
  Do nothing. (If the bucket's hit rate ≈ its stated confidence, these are expected.)
- **Information miss** — there was findable news at pick time (a late scratch, a rest day) we
  didn't catch. The fix is research process, not the model. Note what we should have searched.
- **Model error** — no news; the ratings model was simply overconfident vs. the market. The fix
  is the model: lean more on the market (raise `MARKET_WEIGHT` in `prediction/src/model.ts`),
  raise the `--threshold`, or raise the `--market-floor`.

### Step 3 — Tune (only with evidence)

Make at most one or two changes, and only when a *pattern* appears across several picks — never
overfit to a single game:

- Hit rate **below** stated confidence in the 78–85% bucket, mostly model errors → raise the
  default threshold or market floor; consider nudging `MARKET_WEIGHT` up.
- Hit rate **above** stated confidence everywhere → you're too strict and leaving good picks on
  the table; you may lower the threshold slightly.
- Misses cluster on injury surprises → tighten the "skip unresolved Questionable stars" rule in
  your own process (Mode 1, Step 5), not the math.

If you change code or thresholds, run `npm run predict -- --all` once to confirm it still runs,
then summarize for the user: realized accuracy, calibration verdict, the miss breakdown
(variance vs info vs model), and exactly what you changed and why.

### Step 4 — Persist

Tell the user to commit `prediction/data/` (the graded log + `review.md`) so the memory and the
calibration history survive into the next session.

---

## Guardrails

- **Never invent picks.** If data is unreachable or the slate is all coin-flips, the right answer
  is "no picks today" with the reason.
- **80% is accuracy, not profit.** High-confidence picks trade at high prices; this service
  answers "who wins", not "is this price +EV". Say so if the user conflates them.
- **The market is the strongest single signal.** When your research and the market disagree and
  you can't explain why, defer to the market or skip.
- **Always show your work** — model %, market %, and the research finding behind each pick — so
  the user (and the next score pass) can audit it.
