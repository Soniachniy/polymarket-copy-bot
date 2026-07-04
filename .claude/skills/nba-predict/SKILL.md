---
name: nba-predict
description: >-
  Generate calibrated, selective NBA moneyline predictions for Polymarket, and grade
  past picks. Use when the user runs `/nba-predict` (make today's picks) or
  `/nba-predict score` (grade finished games and tune). The system aims for ~80% hit
  rate through selectivity + market anchoring, not by predicting every game.
---

# NBA prediction service for Polymarket

You are the prediction operator. Your job is to produce a **small set of high-confidence
NBA moneyline picks** that hit ~80% of the time, and to grade them afterward. The compute
engine lives in `prediction/` (run via `npm run predict`); your job is to feed it accurate,
game-day data and to apply the discipline below.

## The one rule that produces 80%

**No model predicts every NBA game at 80%.** The market itself is only ~68-70% accurate and
it is the sharpest public forecast that exists. 80% comes from **only betting the games that
are already lopsided**, plus catching the rare edge the market hasn't priced yet. Concretely:

1. **Be selective.** Only emit picks whose blended probability clears the threshold (default
   0.78). Coin-flip games are skipped on purpose. **Some nights produce zero picks — that is
   the correct answer, not a failure.** Never pad the list to look productive.
2. **Anchor to the market.** The final probability is 65% market price + 35% ratings model.
   When you disagree with the market by a lot, the market is usually right — trust it unless
   you have specific, fresh information the market demonstrably hasn't absorbed.
3. **Only adjust for unpriced news.** The market already knows about public injuries. Add a
   point adjustment **only** when you believe the information is newer than the price (e.g. a
   star just ruled out minutes ago, a coach's surprise rest decision) or the market is thin.
4. **Skip, don't guess, on unresolved star status.** If a star is "Questionable/GTD" and the
   line hasn't settled, skip the game. Guessing on lineup uncertainty is what kills accuracy.

Accuracy ≠ profit: 80%-confidence picks trade at high prices. This service answers
"who will win," not "is this price +EV." Say so if the user conflates them.

---

## Mode: `/nba-predict` — make today's picks

Run these steps in order.

### 1. Pick the target date
Default to today (US/Eastern). If the user names a date, use it. NBA regular season runs
roughly late October → mid-April, playoffs to mid-June. **If it's the offseason (July–Sept),
tell the user there are no games and stop** — don't fabricate a slate.

### 2. Get the slate + market prices — try live first, fall back to research
Run the engine live:
```bash
npm run predict -- --all
```
- **If it prints matched games**, the hosts are reachable. The `--all` view shows every game
  with model/market probabilities. Move to step 3 to research adjustments, then re-run.
- **If it fails with `403 / Host not in allowlist` (or a fetch error)**, the data hosts
  (`gamma-api.polymarket.com`, `site.api.espn.com`) are not on this environment's egress
  allowlist. Two options — prefer (a):
  - **(a) Ask the user to allowlist the hosts** in their environment's network egress
    settings (see https://code.claude.com/docs/en/claude-code-on-the-web), then re-run. This
    unlocks the fully automatic path.
  - **(b) Gather the data yourself** and build a manual slate (below). This always works.

### 2b. Manual slate (network-independent path)
Use your own `WebSearch`/`WebFetch` tools to assemble tonight's games and prices, then write
`prediction/data/manual.json`:

```json
{
  "date": "2026-01-15",
  "games": [
    { "home": "Celtics", "away": "Wizards", "marketHome": 0.90, "homeNetRating": 8.1, "awayNetRating": -9.2 },
    { "home": "Heat", "away": "Bucks", "marketHome": 0.47 }
  ]
}
```
- `home`/`away`: team name or abbr. `marketHome`: the home team's win probability, 0..1.
- **Getting `marketHome`:** search Polymarket for the game if reachable. Otherwise use
  consensus sportsbook moneyline odds (Polymarket tracks them closely) and convert:
  - American odds `-150` → `150 / (150 + 100) = 0.60`. Odds `+130` → `100 / (130 + 100) = 0.435`.
  - De-vig two-way: `p_home / (p_home + p_away)`.
- `homeNetRating`/`awayNetRating` (optional): season point differential per game from
  standings / basketball-reference. Omit them to run market-only — the market price alone is
  already a strong forecast, and net rating only refines it.

Then run:
```bash
npm run predict -- --manual prediction/data/manual.json --all
```

### 3. Research game-day information (this is where your edge comes from)
For each game still in contention (favorite's price roughly 0.65–0.90 — the zone where one
piece of news flips a pick past or below threshold), `WebSearch` for tonight's status:
- **Injuries / lineups**: is a star OUT, and is that reflected in the price yet? Search
  "[team] injury report [today's date]" and the beat reporters.
- **Rest**: back-to-back (2nd night)? long road trip? Tired teams underperform ~2-3 pts.
- **Motivation**: tanking, resting starters late-season, playoff seeding locked.

Translate only **unpriced** findings into point adjustments (negative = weaker team):
- Star player newly OUT and price hasn't moved: ≈ −4 to −7 to that team.
- Confirmed on a back-to-back the market seems to ignore: ≈ −2.
- Second star also out on top of the first: stack another −2 to −3.

Write them into the game's `adjustments` array (manual path) **or** into
`prediction/data/adjustments.json` keyed by abbr (live path):
```json
{ "MIL": { "points": -6, "reason": "Giannis ruled out 30 min ago, line hasn't moved" } }
```
If a star's status is unresolved, do **not** adjust — plan to skip that game.

### 4. Generate and save the picks
```bash
# live path
npm run predict -- --save
# or manual path
npm run predict -- --manual prediction/data/manual.json --save
```
Add `--threshold 0.82` if the current review (see score mode) says to be stricter.
`--save` appends to `prediction/data/predictions.jsonl` — the system's memory. It de-dupes,
so re-running is safe.

### 5. Report to the user
Present the **PICKS** clearly, then the games you **skipped** and why. For each pick give:
team, confidence %, and the one-line reason (favorite strength / the adjustment you made).
If zero picks cleared the bar, say so plainly and explain that skipping coin-flips is the
system working as designed. End by reminding the user to run `/nba-predict score` after the
games finish.

### 6. Commit the memory
The `prediction/data/*.json*` files are the system's memory. Commit and push them so the next
session (and the grading step) can see tonight's picks.

---

## Mode: `/nba-predict score` — grade and tune

### 1. Grade finished games
```bash
npm run predict:score
```
This reads `predictions.jsonl`, fetches finals from ESPN, marks each pending pick
correct/incorrect, and writes `prediction/data/review.md` (accuracy, Brier score,
calibration buckets, and each miss).
- **If the ESPN fetch is blocked**, get final scores yourself via `WebSearch`
  ("[team] vs [team] final score [date]") and write a scoreboard snapshot the grader can read:
  `prediction/data/snapshot/scoreboard-YYYY-MM-DD.json` as an array of
  `{ "homeAbbr","awayAbbr","date","completed":true,"homeScore":N,"awayScore":M }`, then run
  `npm run predict:score -- --offline`.

### 2. Read and interpret `review.md`
Report accuracy vs the 80% target and the calibration table. Then classify **each miss** into
exactly one bucket — this is the "work with mistakes" loop the user wants:
- **Variance** — pick was sound (e.g. an 82% favorite that lost). Expected ~1 in 5. No change.
- **Information miss** — there was lineup/rest/motivation news you didn't encode. Note the
  source you should have checked so next time you do.
- **Model error** — the model sat far above the market and was wrong (overconfident). This
  argues for leaning harder on the market.

### 3. Propose and apply tuning
Based on the classification, recommend a concrete change and apply it if the user agrees:
- Misses cluster in the 78–85% bucket and accuracy < 80% → raise the default `--threshold`
  (e.g. 0.80 → 0.82). Be more selective.
- Every calibration bucket hits **above** its stated confidence → you're too strict; lower the
  threshold to stop leaving good picks on the table.
- Misses were mostly **information misses** → tighten step 3's research checklist; don't touch
  constants.
- Misses were **model errors** (model >> market and wrong) → raise `MARKET_WEIGHT` in
  `prediction/src/model.ts` (e.g. 0.65 → 0.72) so the sharp market dominates more.

### 4. Commit
Commit `review.md`, the updated `predictions.jsonl`, and any constant/threshold changes with a
message noting the current accuracy and what you tuned.

---

## Reference

- `prediction/README.md` — architecture, data sources, the model formula.
- `prediction/src/predict.ts` — CLI flags: `--all`, `--save`, `--json`, `--threshold N`,
  `--date YYYY-MM-DD` (repeatable), `--offline`, `--manual [file]`.
- `prediction/src/score.ts` — grading, calibration, mistakes report (`--offline` supported).
- The model: `P(home) = Φ((netΔ + 2.6 home court + adjustments) / 11.5)`, blended 65% with the
  de-vigged market price. Without net ratings it anchors entirely on the market and only
  adjustments move it.

## Honesty guardrails
- Never invent games, prices, injuries, or final scores. If you can't verify a number, say so
  and either skip that game or ask the user.
- Don't claim 80% is guaranteed on any single night — it's a long-run rate over selective
  picks. A night can go 2/3 and still be on track.
- The JSONL log is the only record of what was actually predicted. Never edit past entries to
  make accuracy look better.
