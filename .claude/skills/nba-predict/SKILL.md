---
name: nba-predict
description: >-
  Generate calibrated, selective NBA win predictions for Polymarket moneyline
  markets, and grade past picks. Use when the user types /nba-predict, asks for
  today's NBA picks / predictions for Polymarket, or wants to score/review
  previous NBA predictions. Runs the pipeline in prediction/, researches the
  game-day slate (injuries, rest, motivation) with web search, encodes findings
  as point adjustments, and emits only high-confidence picks (target ~80% hit
  rate by being selective).
---

# NBA prediction service for Polymarket

This skill is the operator's console for the predictor in `prediction/`. The code
fetches markets/schedule/standings/injuries and produces a market-anchored model
probability; **your job in the session is the game-day intelligence layer** that
season stats can't see (tonight's lineup, rest, motivation) plus disciplined
selection. The 80% target is reached by *skipping* coin-flip games, not by forcing
a pick on every game.

Two modes:

- `/nba-predict` — generate today's picks (default).
- `/nba-predict score` — grade past picks, write the review, propose tuning.

Pass-through flags after the mode go straight to the CLI, e.g.
`/nba-predict --date 2026-02-14` or `/nba-predict --threshold 0.82`.

---

## Mode A — Generate picks (`/nba-predict [flags]`)

Work through these steps in order. Do not skip the research step — the saved model
without adjustments is only as good as the market, never better.

### 1. Pull the candidate slate (no adjustments yet)

```bash
npm run predict -- --all --json   # add --date YYYY-MM-DD per game day if given
```

This prints every matched game as JSON with `homeAbbr`, `awayAbbr`, `question`,
`pModel`, `pMarket`, `probability`, `edge`, and a `rationale` that already lists
any ESPN-reported Out/Doubtful players.

Handle these outcomes before continuing:

- **`FatalHttpError ... 403 ... Host not in allowlist`** — the environment blocks
  egress to `gamma-api.polymarket.com` and/or `site.api.espn.com`. This is an
  org network policy, not a code bug. Tell the user to add those two hosts to the
  environment's egress allowlist (see `prediction/README.md` → "Network access"),
  or to run the skill in an environment with open egress, then stop.
- **0 matched games** — likely the NBA offseason or an empty slate. Report
  "no NBA slate today, nothing to predict" and stop. Zero picks is a valid day.
- **Games matched** — continue to research.

### 2. Research each matched game (the edge over the market)

For **every** matched game, use `WebSearch` (and `WebFetch` on a primary source
when a result is decisive) to find game-day information the season ratings miss.
Search the matchup and date, e.g. `"Lakers Celtics injury report [today's date]"`,
`"NBA starting lineups tonight"`, team beat-writer accounts, Rotowire/ESPN
injury pages. For each game establish:

1. **Star availability** — is any top-3 player Out, or still tagged
   Questionable/Game-Time-Decision near tip-off?
2. **Rest** — is either team on the second night of a back-to-back, or on a long
   road trip? Is the other side rested?
3. **Motivation / stakes** — late-season tanking, locked-in seeding, load
   management of stars in a meaningless game, a team resting starters.
4. **Confirmation** — does fresh news *confirm* the ESPN list in the rationale, or
   contradict it (a listed-Out player upgraded, or a new injury not yet in ESPN)?

Cross-check the date: only act on news for the actual game date.

### 3. Translate findings into point adjustments

Write `prediction/data/adjustments.json`. Schema — keys are team abbreviations,
points are added to that team's expected margin (negative = weaker):

```json
{
  "LAL": { "points": -5, "reason": "Doncic OUT (knee), confirmed by beat writer" },
  "BOS": { "points": -1.5, "reason": "2nd night of back-to-back, no rest" }
}
```

Rubric (calibrate, don't over-tune):

| Situation | Points |
|---|---|
| MVP-caliber / top-15 player **Out** | −5 to −7 |
| Clear #1 option **Out** | −4 to −5 |
| Key starter **Out** | −2 to −3 |
| Rotation piece **Out** | −0.5 to −1.5 |
| Second night of a back-to-back | −1.5 |
| Resting starters / tanking (announced) | −4 to −8 |
| A listed-Out star **returning** (upgrade) | +2 to +5 |

Apply adjustments to **both** teams as warranted; they net out in the margin.
Use empty `{}` if nothing material changes a game.

**Hard rule — when in doubt, skip, don't guess.** If a *star's* status is
unresolved (Questionable / game-time decision) at pick time and his presence
swings the game, do **not** invent an adjustment. Note the game as
"skip — unresolved star status" and leave it out of adjustments; the threshold
will usually drop it, and you should not emit it as a pick even if it sneaks over.

### 4. Generate and save the picks

```bash
npm run predict -- --save        # mirror any --date / --threshold from step 1
```

This re-runs with your adjustments and appends picks ≥ threshold (default 0.78,
de-duped by market) to `prediction/data/predictions.jsonl` — the system's memory.

### 5. Report to the user

Report in this shape:

- **PICKS** — for each: matchup, team picked, the Polymarket outcome label,
  confidence %, model% vs market%, and the one-line reason (injury/rest note).
- **Skipped** — games matched but below threshold or deliberately skipped, with
  the reason (coin flip / unresolved star). This is as important as the picks.
- **Caveat** — restate that ~80% is the *selective* hit-rate target, that high
  confidence ≠ profit (favorites trade rich), and that any game you skipped on
  unresolved news should not be bet.

Then remind the user to commit the data files:

```bash
git add prediction/data/ && git commit -m "nba picks <date>"
```

---

## Mode B — Score and review (`/nba-predict score`)

Run after games finish (next day).

### 1. Grade

```bash
npm run predict:score
```

Fetches ESPN finals for each pending pick's date, marks each
`correct`/`incorrect`, updates `predictions.jsonl` in place, and writes
`prediction/data/review.md` (accuracy vs 80% target, Brier score, calibration
buckets, list of misses).

### 2. Read and classify

Read `prediction/data/review.md`. Classify **each miss** into one bucket:

- **Variance** — model and market both favored the pick at a fair price; it just
  lost. Expected ~1 in 5 at 80%. No action.
- **Information miss** — late lineup/injury/rest news existed before tip that the
  research step didn't catch. Action: tighten step 2 (which source would have
  caught it).
- **Model error** — the model sat far above the market on the pick and was wrong
  (overconfident). Action: trust the market more.

### 3. Propose and apply tuning (only on a real pattern, not one game)

- Accuracy < 80% and misses cluster in the 78–85% bucket → raise the default
  threshold (e.g. run/recommend `--threshold 0.82`).
- Per-bucket hit rate consistently **above** stated confidence → you're too
  selective; the threshold can come down.
- Misses cluster on injury surprises → reinforce the "skip unresolved star"
  rule in your research.
- Model disagreed badly with the market on misses → lower `MARKET_WEIGHT` toward
  the market in `prediction/src/model.ts` (currently 0.65 weight on market).

Apply a constant change only with `Edit`, keep it small, and note it in the
report so the next review can judge it. Re-run `npm test` after editing model
constants.

### 4. Report

Summarize: graded count, accuracy vs 80%, Brier, the miss classification tally,
and any tuning you applied. Remind the user to commit `prediction/data/`.

---

## Guardrails

- This answers **"who will win"**, not "is this price +EV". Don't claim profit.
- Never fabricate injury/lineup data — if a search is inconclusive, treat the
  game as unresolved and skip it.
- Don't lower the threshold just to produce picks on a thin slate. Zero picks is
  a correct, honest output.
- The JSONL log is append-only memory; never rewrite past predictions except via
  `npm run predict:score` grading them.
