---
name: nba-predict
description: >-
  Generate calibrated NBA moneyline predictions for Polymarket that clear a high
  confidence bar (target ~80% hit rate), and grade/tune them after games finish.
  Use when the user runs "/nba-predict" (produce today's picks) or "/nba-predict
  score" (grade the last batch against final scores and tune the model). Drives the
  CLI in prediction/, researches tonight's injuries/rest/motivation with web search,
  writes point adjustments, saves picks to the append-only log, and reports
  PICKS + skipped games. This is the whole "run a session, get predictions" workflow.
---

# NBA prediction service (Polymarket moneyline)

You are the session layer of a calibrated NBA predictor. The math (ratings model +
de-vigged market blend) lives in `prediction/`; **your** job is to add the
game-day information a season-long model can't see, enforce the discipline that
produces an ~80% hit rate, and report cleanly. Do not rewrite the model on the fly —
tune it only through the score-review loop.

## The one idea that makes 80% possible

No model calls every NBA game at 80% — the sharpest public forecast (the betting
market) is only ~68-70% across all games. We hit 80% by **selectivity, not genius**:
only emit picks whose blended win probability clears the threshold (default `0.78`),
skip everything else, and let calibration + the score loop keep confidence honest.

**Some nights produce zero picks. That is the correct output, not a failure.**
Forcing picks onto coin-flip games is the single fastest way to destroy the hit rate.
Never lower the threshold just to have something to say.

---

## Setup (run once per session, silently)

```bash
npm install            # if node_modules is missing
```

The pipeline needs outbound HTTPS to two hosts. If a CLI step fails with
`Host not in allowlist` / HTTP 403 from the proxy, the environment's **network
policy** is blocking data — it is not a code bug. Tell the user to allow these
hosts in their web-session network settings, then stop:

- `gamma-api.polymarket.com` (Polymarket markets + prices)
- `site.api.espn.com` (schedule, standings, injuries, final scores)

Do **not** retry a 403 policy denial and do **not** disable TLS.

---

## Mode A — produce today's picks  (`/nba-predict`  or  `/nba-predict <YYYY-MM-DD>`)

Work through these steps in order. Steps 2-4 are what earn the accuracy; don't skip them.

### 1. Pull the baseline slate
```bash
npm run predict -- --all --json           # add --date YYYY-MM-DD per game day if specified
```
This prints every matched game with the model probability, de-vigged market
probability, and blended confidence — **before** any game-day adjustments. Read the
JSON. If zero games matched, report that (off-season / no NBA slate / markets not up
yet) and stop.

### 2. Research each matched game (this is the edge)
For every matched game — especially any sitting near the threshold — use
**WebSearch / WebFetch** to find what tonight's data can't encode. Prioritise
games that are close to the line; a game already at 92% market probability barely
moves and needs little research.

Look for, in priority order:
1. **Confirmed inactives** — starters/stars ruled **Out** (injury, rest, personal,
   suspension, G-League). Search `"<Team> injury report <today's date>"` and
   `"<Team> vs <Team> starting lineup tonight"`.
2. **Rest / schedule** — is either team on the **second night of a back-to-back**?
   On a long road trip? Coming off unusually long rest? (Search the schedule.)
3. **Motivation distortions** — end-of-season tanking, a locked playoff seed
   resting regulars, a team playing for play-in survival, a marquee revenge game.
4. **Late-breaking news** — a star downgraded a couple hours before tip.

### 3. Turn findings into point adjustments
Write `prediction/data/adjustments.json` — a map of **team abbr → { points, reason }**.
`points` is added to that team's expected margin (negative = weaker). The model reads
it automatically on the next run. Sizing guide (per team, cumulative if multiple):

| Situation | Points |
|---|---|
| MVP-tier star confirmed **Out** (e.g. Jokić/Luka/Giannis/SGA level) | **−6 to −8** |
| All-Star / primary option **Out** | **−3 to −5** |
| Key starter **Out** | **−1.5 to −3** |
| Rotation piece **Out** | **−0.5 to −1.5** |
| Second night of a back-to-back | **−1.5 to −2.5** |
| Meaningful rest edge (3+ days vs 0) | **+1** for the rested side |
| Resting starters / tanking (confirmed) | **−4 to −8** |
| Star **returning** from injury (was out, now active) | **+2 to +4** |

Example:
```json
{
  "MEM": { "points": -6.5, "reason": "Ja Morant + Jaren Jackson Jr. both ruled OUT (injury report, confirmed)" },
  "LAL": { "points": -2,   "reason": "2nd night of back-to-back, 4th road game in 6 nights" }
}
```
If nothing material is found for a game, add nothing — the market already prices the
known picture. Reset (empty `{}`) any stale adjustments from a prior day before writing.

### 4. Enforce the skip guards (protects the hit rate)
- **Unresolved star `Questionable`/`Doubtful`** near tip-off → do **not** adjust and do
  **not** pick that game. That is exactly the coin-flip a selective model must avoid.
  Only encode a star as a negative adjustment once **confirmed Out**.
- If research reveals a star **Out** that the market clearly hasn't priced yet (stale
  price), the adjustment may flip or strengthen a pick — good, that's the edge working.
- Never talk yourself past the threshold. If the blended confidence lands below it, skip.

### 5. Generate and log the picks
```bash
npm run predict -- --save                 # applies adjustments.json, logs picks above threshold
```
Add `--date YYYY-MM-DD` (repeatable) to match the slate you researched.
`--save` appends only picks that clear the threshold to `prediction/data/predictions.jsonl`
(the system's memory) and won't double-log a market.

### 6. Report to the user
- **PICKS**: for each, `Away @ Home → PICK (confidence%)`, the market vs model split,
  and a one-line rationale citing the decisive adjustment ("Grizzlies −6.5, Morant + JJJ out").
- **Skipped**: list close/coin-flip games and *why* each was skipped (below threshold,
  unresolved Questionable star, etc.). Transparency here is the product.
- Remind: **commit `prediction/data/*`** so the log persists (it's the memory the score
  loop learns from). If the session can commit, offer to.

---

## Mode B — grade & tune  (`/nba-predict score`)

Run after the games in the log have finished.

### 1. Grade
```bash
npm run predict:score                     # grades pending picks vs ESPN finals, writes data/review.md
```
Read `prediction/data/review.md`: accuracy vs the 80% target, Brier score, the
calibration table (stated confidence vs realized hit rate per bucket), and each miss.

### 2. Classify every miss into exactly one bucket
- **Variance** — right call, lost anyway (an 80% pick *should* lose ~1 in 5). No action.
- **Information miss** — late lineup/rest/motivation news we failed to research or
  size correctly. Action: tighten the research checklist, not the math.
- **Model error** — model sat far above the market and was wrong (overconfident math).
  Action: raise the market weight or the threshold.

### 3. Propose and apply tuning (only if the evidence supports it)
- Accuracy < 80% **and** misses cluster in the 78-85% bucket → raise the default
  threshold in `prediction/src/predict.ts` (e.g. `0.78` → `0.82`).
- Per-bucket hit rate consistently **above** stated confidence → threshold can come
  **down** slightly; you're leaving good picks on the table.
- Misses dominated by **model-over-market** disagreement → raise `MARKET_WEIGHT` in
  `prediction/src/model.ts` (markets are sharp; lean on them more).
- Misses dominated by **injury/rest surprises** → strengthen the Mode-A research rules,
  leave the math alone.
Make one change at a time, note it, and let the next batch judge it. Run `npm test`
after touching `prediction/src/*`. Remind the user to commit `prediction/data/*` and any tuning.

---

## Honesty rules (do not break these)
- Report skipped and zero-pick nights plainly; never invent picks to fill the slate.
- 80% **accuracy ≠ profit** — high-confidence picks trade at high prices. This service
  answers *"who will win,"* not *"is this price +EV."* Say so if the user asks about betting.
- Cite the source/date of any injury or lineup claim that drives an adjustment.
- If data is missing (endpoint blocked, standings incomplete), say so and stop — don't guess.

## Files (the machinery you drive)
- `prediction/src/predict.ts` — pick generation CLI (fetch → match → model → blend → save)
- `prediction/src/score.ts` — grading + calibration + mistakes report
- `prediction/src/model.ts` — probabilities & blend constants (tune only via the score loop)
- `prediction/data/adjustments.json` — **you write this each session** (game-day points)
- `prediction/data/predictions.jsonl` — append-only prediction log (the memory)
- `prediction/data/review.md` — latest grading report
