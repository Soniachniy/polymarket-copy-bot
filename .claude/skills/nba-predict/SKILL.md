---
name: nba-predict
description: >-
  Generate calibrated, selective NBA game-winner predictions for Polymarket moneyline
  markets, and grade past predictions. Use when the user types /nba-predict, asks for
  NBA picks / predictions / who-will-win for tonight's games, or asks to score/grade a
  previous prediction run. Targets ~80% hit rate through selectivity, market anchoring,
  and game-day research — NOT by predicting every game.
---

# NBA prediction service (for Polymarket moneyline markets)

You are the **session layer** of a two-part system. A deterministic TypeScript engine
(`prediction/`) does the probability math, blending, calibration, and logging. Your job is
to feed it clean game-day information and to run it, then report and (later) grade.

## The 80% contract — read this first, it governs every decision

No model predicts *every* NBA game at 80%. The market itself is only ~68-70% accurate, and it
is the sharpest public forecast that exists. We reach 80% **on the picks we emit** by being
selective — most games are correctly skipped. The four levers:

1. **Selectivity** — only emit a pick when the blended win probability clears the threshold
   (default **0.78**). Coin-flip games are skipped on purpose. **Zero picks on a slate is a
   valid, correct output.** Never invent picks to look busy — forcing coin-flips is the single
   fastest way to destroy the 80% rate.
2. **Market anchoring** — the final probability is 65% de-vigged Polymarket price + 35% ratings
   model. Prediction markets are sharp; we respect them and only tilt with real information.
3. **Game-day information** — season ratings can't see tonight's lineup. YOU research injuries,
   rest, back-to-backs, and motivation, and encode them as point adjustments before scoring.
4. **Calibration** — an 80% pick *should* lose 1 in 5. The score loop checks stated confidence
   against realized hit rate and tells you how to tune. Do not "fix" a single unlucky loss.

Accuracy ≠ profit. High-confidence picks trade at high prices. This service answers
"who will win," not "is this price +EV." Say so if the user conflates them.

---

## Modes

- `/nba-predict`            → **PREDICT** today's slate.
- `/nba-predict YYYY-MM-DD` → **PREDICT** a specific date.
- `/nba-predict score`      → **SCORE** previously logged picks against final results.

Detect the mode from the argument. Default to PREDICT for today.

---

## PREDICT mode — step by step

### Step 0 — orient
- Confirm today's date (a system reminder gives it). Note that the NBA regular season runs
  ~late October → mid-April, playoffs to mid-June. **In the offseason (July–September) there
  are no moneyline game markets — tell the user plainly and stop; do not fabricate a slate.**

### Step 1 — try the live pipeline (works only if egress is allowed)
Run:
```bash
npm run predict -- --all
```
- If it prints matched games with market prices, the sandbox can reach the APIs. Skip to
  **Step 3** (research adjustments) then re-run to save.
- If it fails with `403` / `Host not in allowlist` / `CONNECT tunnel failed`, the environment's
  network egress blocks Polymarket/ESPN. That is expected in locked-down sessions. Go to
  **Step 2** (build the bundle yourself). You may also tell the user they can enable the live
  path by allowlisting `gamma-api.polymarket.com` and `site.api.espn.com` in their
  environment's network egress settings (see https://code.claude.com/docs/en/claude-code-on-the-web).

### Step 2 — build the input bundle from web research (the robust path)
Gather the slate yourself and write a JSON bundle the engine can score offline. Use
`WebSearch` (routes through Anthropic infra, not the sandbox) and `WebFetch` where allowed.
For **every** game tonight collect:

| Field | How to get it | Notes |
|---|---|---|
| home / away teams | ESPN or NBA schedule for the date | 3-letter abbrs (LAL, BOS, …) |
| `homePointDiff` / `awayPointDiff` | season **net rating** or avg point differential per game | e.g. Basketball-Reference "SRS"/net rating, or ESPN standings. This is the model's power rating. |
| `marketHomeProb` | Polymarket price for the home team, **de-vigged** | If the two YES prices sum to >1, divide each by the sum. **If you cannot get a reliable price, omit this field** — the game becomes model-only and will NOT be auto-picked (correct, conservative behavior). |
| `injuries` | injury report: who is **Out / Doubtful** | Only these two statuses matter for auto-notes. |
| `adjustments` | your point tilts for tonight (see cheat-sheet) | This is where game-day judgment lives. |

Write to `prediction/data/input-<date>.json`:
```json
{
  "date": "2026-10-24",
  "games": [
    {
      "gameDate": "2026-10-24",
      "homeAbbr": "OKC", "awayAbbr": "WAS",
      "homePointDiff": 9.2, "awayPointDiff": -7.8,
      "homeRecord": [3, 0], "awayRecord": [0, 3],
      "marketHomeProb": 0.86,
      "homeOutcome": "Thunder", "awayOutcome": "Wizards",
      "conditionId": "0x…", "question": "Thunder vs. Wizards",
      "injuries": [{ "teamAbbr": "WAS", "player": "Guard X", "status": "Out" }],
      "adjustments": { "WAS": { "points": -2, "reason": "starting guard out" } }
    }
  ]
}
```
`homeOutcome`/`awayOutcome` should be the exact Polymarket outcome labels (so logged picks are
copy-pasteable). `conditionId` is the Polymarket market id — include it when known so the log
de-dupes and links back to the market. Everything except the teams, point diffs, and date is
optional.

Then score it:
```bash
npm run predict -- --input prediction/data/input-<date>.json --all      # inspect all games
npm run predict -- --input prediction/data/input-<date>.json --save     # save picks to the log
```

### Step 3 — game-day adjustments (the judgment layer)
Adjustments are points added to a team's expected margin. Be conservative and cite a reason for
each. Rough magnitudes (a full team is ~11.5 pts of sigma, so these matter):

| Situation | Points |
|---|---|
| Clear #1 star ruled **Out** | −4 to −7 |
| Key starter Out | −2 to −4 |
| Role player Out | −0.5 to −1.5 |
| Playing 2nd night of a back-to-back | −1.5 to −2.5 |
| Opponent on a back-to-back, you're rested | apply the penalty to *them* |
| Long road trip / 3rd game in 4 nights | −1 to −2 |
| Confirmed tanking / resting starters (late season) | −3 to −8, or **skip the game** |
| Strong revenge/elimination motivation | +0.5 to +1.5 (use sparingly) |

**Hard rule on uncertainty:** if a *star's* status is "**Questionable**" / "Game-Time Decision"
and unresolved, do **not** guess a point value — either wait for the confirmed report or **skip
the game** (leave it out of the bundle, or don't let it clear threshold). Injury surprises are
the #1 killer of hit rate. It is always fine to skip.

### Step 4 — report to the user
Present, in this order:
1. **PICKS** (games that cleared threshold): team, confidence %, and one-line rationale
   (model vs market, key adjustment). These are what they act on.
2. **Skipped / close games** — one line each on why (coin-flip, no market price, unresolved
   injury). Transparency builds trust in the selectivity.
3. If **zero picks**: say so directly. "No games clear 78% tonight — skipping is the right call."
4. Remind them to run `/nba-predict score` after the games finish.

### Step 5 — persist memory
The JSONL log is the system's memory. Commit it:
```bash
git add prediction/data/ && git commit -m "nba: picks for <date>"
```

---

## SCORE mode — grading and learning from mistakes

### Step 1 — get final scores and grade
- **Live path:** `npm run predict:score` (fetches ESPN finals, grades pending picks, writes
  `prediction/data/review.md`).
- **Offline path** (egress blocked): research the final scores of the pending games via
  `WebSearch`, write a results file, and grade from it:
  ```json
  { "2026-10-24": [ { "homeAbbr": "OKC", "awayAbbr": "WAS", "homeScore": 121, "awayScore": 99 } ] }
  ```
  ```bash
  npm run predict:score -- --results prediction/data/results-<date>.json
  ```

### Step 2 — read `prediction/data/review.md` and classify every miss
For each incorrect pick, decide which bucket it falls in — this drives tuning:
- **Variance** — we were 80% and the 20% happened. Correct process, unlucky. **Change nothing.**
- **Information miss** — late injury/rest/lineup news we didn't encode. Tighten the research
  checklist; reinforce the "skip unresolved Questionable stars" rule.
- **Model error** — the model disagreed sharply with the market and was wrong. The market was
  right; lean more on it (raise `MARKET_WEIGHT` in `prediction/src/model.ts`, e.g. 0.65 → 0.72).

### Step 3 — check calibration and tune the threshold
Read the calibration table in `review.md`:
- Overall accuracy **< 80%** and misses cluster in the 78–82% bucket → **raise the threshold**
  (run future slates with `--threshold 0.82`). Fewer, better picks.
- Realized hit rate **consistently above** stated confidence → you're being too strict and
  leaving good picks on the table → the threshold can come **down** slightly.
- Only retune after a **meaningful sample** (≥ ~15–20 graded picks). Never tune on 1–2 games.

### Step 4 — report and persist
Summarize: accuracy vs 80% target, Brier score, each miss's classification, and the concrete
tuning action taken (or "none — within variance"). Commit `prediction/data/`.

---

## Guardrails (do not violate)
- **Never force a pick** to fill a slate. Zero picks is a valid day.
- **Never guess a point value for an unresolved star injury** — skip instead.
- **Never claim 80% on any single game.** 80% is a portfolio property of selective picks.
- **Never invent market prices.** No reliable price → omit it → model-only → not an auto-pick.
- **Do not retune constants on small samples or single losses.**
- Keep the model math in the engine; your job is clean inputs and honest reporting.

## Reference
- CLI details, model formula, and data sources: `prediction/README.md`.
- Constants (home court, sigma, market weight, threshold): `prediction/src/model.ts`,
  `prediction/src/predict.ts`.
