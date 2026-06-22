---
name: nba-predict
description: Generate calibrated, high-confidence NBA game-winner predictions for Polymarket moneyline markets, and grade past predictions. Use when the user asks for NBA predictions, picks, "who will win tonight", to run the prediction pipeline, or to score/grade/review previous picks. Runs the prediction CLI, researches game-day injuries/rest/motivation with web search, writes point adjustments, and emits only picks that clear the confidence threshold.
---

# NBA prediction pipeline (Polymarket moneyline)

You are the orchestration layer of a selective NBA win-probability service. The TypeScript CLI
under `prediction/` does the math and data plumbing; **your job is the part code cannot do**:
researching tonight's lineups and translating that into point adjustments, then emitting only
the picks that clear the confidence bar.

**Read this contract first — it is how the system reaches ~80%:**

- The target is **80% accuracy on emitted picks, NOT on every game.** The market is only ~68–70%
  accurate across all games. We beat that by being *selective*: skip coin-flips and anything
  uncertain. **Zero picks on a given day is a correct, expected outcome — never force a pick.**
- A stated-80% pick is *supposed* to lose 1 in 5. Don't panic over a single miss; the `score`
  loop checks calibration across many picks and tunes the threshold.
- The final probability blends a power-rating model (35%) with the de-vigged Polymarket price
  (65%). Markets are sharp — respect them. Your research feeds the model side as point adjustments.

## Two modes

The user invokes one of:
- **predict** (default): generate today's picks.
- **score** / grade / review: grade past picks against final scores and report calibration.

If the user said "score", "grade", "review", or "check yesterday", do the **Scoring** section.
Otherwise do **Prediction**.

---

## Prediction workflow

Run these steps in order. Do not skip the research step — it is where the accuracy comes from.

### 1. Setup
- `cd` to the repo root. If `node_modules` is missing, run `npm install` first.
- Determine **today's NBA game date in US/Eastern** (NBA schedules are keyed to ET). A late West
  Coast game still belongs to its ET start date. Use this as `--date YYYY-MM-DD` in step 2 unless
  the user named a specific date.

### 2. Pull the slate (no adjustments yet)
```bash
npm run predict -- --all --json --date <YYYY-MM-DD>
```
This prints every matched game with `pModel`, `pMarket`, blended `probability`, `pickTeam`, and
any injuries ESPN already lists. Read it. If it errors with a "shape changed" message, the upstream
API changed — inspect the endpoint and fix the parser in `prediction/src/` before continuing.

If **0 games matched**, tell the user there are no NBA moneyline markets on Polymarket for that date
and stop. (Off-season or no slate.)

### 3. Research each matched game (the critical step)
For every matched game — prioritize the ones whose blended `probability` is near the threshold
(0.70–0.85), since that is where research flips the decision — use **WebSearch / WebFetch** to find
**game-day** information the season ratings cannot see. Search queries like:
- `"<Team A> vs <Team B> injury report <date>"`
- `"<Star player> status tonight"` / `"<Team> starting lineup tonight"`
- `"<Team> back to back" <date>` (second night of a back-to-back?)

Look for, and weigh, in roughly this order of impact:

| Situation | Point adjustment to that team's margin |
|---|---|
| All-NBA / franchise star **OUT** | **−4 to −7** |
| Second star / All-Star **OUT** | **−2.5 to −4** |
| Solid starter **OUT** | **−1 to −2.5** |
| Multiple rotation players out | stack the above |
| Star returning from injury (rust / minutes limit) | −0.5 to −1 |
| Second night of a **back-to-back** | −1.5 to −2.5 |
| 3rd game in 4 nights / long road trip | −1 |
| Resting starters / tanking (late season, eliminated) | −3 to −8 |
| Clear motivation edge (must-win, elimination) | +0.5 to +1 (small, unreliable) |

Note: ESPN's listed Out/Doubtful already shows in step 2's output, but it is often stale by tip-off
and misses "Questionable → Out" upgrades, rest days, and motivation. Web search is what catches those.

### 4. The skip rule (protects the 80%)
If a **star** is **Questionable / game-time decision / probable-but-unconfirmed** AND the game is
anywhere near the threshold, **do not adjust and gamble — plan to skip that game.** Uncertainty is
the enemy of an 80% hit rate. Only emit a pick when the situation is *resolved* (player confirmed in
or out). You enforce this by simply not lowering the threshold for that game; if its blended
probability doesn't clear the bar on its own, it gets skipped.

### 5. Write adjustments
Write all the point adjustments you derived to `prediction/data/adjustments.json` as a map of
**team abbreviation → { points, reason }**. Points are *added to that team's expected margin*
(negative = weaker). Example:
```json
{
  "LAL": { "points": -5, "reason": "Luka Doncic ruled out (calf), confirmed by beat reporter" },
  "BOS": { "points": -1.5, "reason": "second night of back-to-back, traveled from Denver" }
}
```
Use the canonical abbreviations in `prediction/src/teams.ts` (LAL, BOS, OKC, …). Overwrite the file
fresh each run — old adjustments must not leak into a new slate. If no adjustments are warranted,
write `{}`.

### 6. Generate and save final picks
```bash
npm run predict -- --save --date <YYYY-MM-DD>
```
This reloads your adjustments, recomputes blended probabilities, keeps only picks ≥ threshold
(default 0.78), and appends them to `prediction/data/predictions.jsonl` (the system's memory;
it de-dupes by market). Use `--threshold 0.82` if the latest `review.md` told you to raise it.

### 7. Report to the user
Give a tight summary:
- **PICKS** (the saved ones): for each, `pickTeam`, blended confidence %, and a one-line reason
  (model vs market split + the decisive injury/rest fact).
- **Skipped** (notable near-misses): game + the one reason it was skipped (e.g. "star Questionable",
  "true coin-flip", "model and market disagree").
- If zero picks: say so plainly and why — that is a valid, disciplined result, not a failure.

End by reminding the user to **commit `prediction/data/*`** so the prediction log persists, and to
return the next day to grade with `score`.

---

## Scoring workflow

Run after the games have finished (next day is safest).

1. `cd` to repo root.
2. ```bash
   npm run predict:score
   ```
   This fetches ESPN final scores, grades every `pending` pick in `predictions.jsonl` in place,
   and writes `prediction/data/review.md` with overall accuracy, Brier score, a calibration table,
   and a per-miss breakdown.
3. **Read `review.md` and diagnose each miss** for the user. Classify every incorrect pick as one of:
   - **Variance** — the pick was sound, the underdog just won. An 80% pick losing ≈1/5 of the time is
     expected. No action.
   - **Information miss** — there was a late lineup/rest fact we failed to research (the most fixable
     kind). Tighten step 3/4 next time.
   - **Model error** — the model was confidently wrong vs the market (large positive edge that lost).
     Repeated cases mean the model is overweighted.
4. **Tune, then state what you changed:**
   - Accuracy < 80% with misses clustered in the 78–85% bucket → recommend raising the threshold
     (run future predicts with `--threshold 0.82`).
   - Hit rate per bucket consistently *above* stated confidence → threshold can come down; we're
     leaving good picks on the table.
   - Misses dominated by injury surprises → reinforce the skip rule, not bigger adjustments.
   - Misses dominated by model-vs-market disagreement → lower `MARKET_WEIGHT`'s complement by raising
     `MARKET_WEIGHT` in `prediction/src/model.ts` (more market trust). Change constants only through
     this review loop, and only with several data points — never overfit to one night.
5. Remind the user to commit `prediction/data/*` (the updated log + `review.md`).

---

## Guardrails
- Never invent injury news. If web search is inconclusive, treat the player as available and rely on
  the skip rule for risky games. An honest "no reliable info → skip" beats a confident guess.
- Never lower the threshold just to produce picks. Fewer, right picks is the entire strategy.
- Keep `adjustments.json` scoped to the current slate; clear it each run.
- This service answers **"who will win"**, not "is this price profitable" — high-confidence winners
  trade at high prices. Make that distinction if the user talks about betting value.
