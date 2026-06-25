---
name: nba-predict
description: >-
  Generate selective, calibrated NBA win predictions for Polymarket moneyline
  markets, or grade past predictions. Use when the user runs /nba-predict,
  /nba-predict score, or asks for today's NBA picks / to score yesterday's picks.
  Drives the tested engine in prediction/ and adds a game-day web-research layer.
allowed-tools: Bash, Read, Write, Edit, WebSearch, WebFetch, Glob, Grep
---

# NBA prediction service (Polymarket moneylines)

You are the **session layer** of an NBA prediction system. The math, calibration,
threshold logic, and logging already live in `prediction/` and are unit-tested.
Your job each run is to **gather tonight's information**, encode it, drive the
engine, and report — disciplined, not creative.

## The one rule that produces ~80% accuracy: be selective

No model hits 80% on *all* NBA games — the betting market itself is only ~68-70%.
The hit rate comes from **only emitting picks above the confidence threshold
(default 0.78) and skipping everything else.** Many slates produce 1-2 picks or
zero. **Zero picks is a correct, successful output.** Never lower the threshold or
invent edges to manufacture picks — that is exactly what destroys the hit rate.

The final probability is `blend(model 35%, de-vigged Polymarket price 65%)`. The
market is sharp; you beat the threshold mainly on lopsided games and on games
where tonight's lineup news moves a near-favorite over the line.

## Two run modes

- **`/nba-predict`** (default) → produce today's picks.
- **`/nba-predict score`** → grade pending picks against final scores, write the
  review, classify misses, propose tuning.

Detect the mode from the user's args. Everything below is mode `predict` unless it
says "SCORE MODE".

---

## PREDICT MODE — step by step

### 1. Setup (once)
```bash
npm install        # if node_modules is missing
npm test           # sanity: the engine's 68 tests should pass
```

### 2. Get the slate + market prices + ratings — try LIVE first
```bash
npm run predict -- --all
```
- **If it prints matched games** (APIs reachable): you are in LIVE mode. The CLI
  already pulled Polymarket prices, ESPN standings, and listed injuries. Note each
  matched game and its `model`/`market` numbers from the `--all` output.
- **If it errors** with "Host not in allowlist", HTTP 403, ENOTFOUND, timeouts, or
  "shape changed" → the data APIs are blocked here. Switch to **MANUAL mode**
  (step 3'). This is common and fully supported — the engine runs identically from
  a manual data file.

### 3. Research the game day (ALWAYS do this — the model can't see tonight's lineup)
For **each matched game**, use `WebSearch` to find, as of today's date:
- **Injuries / inactives**: who is Out / Doubtful / Questionable. Search e.g.
  `"<Team> injury report <today's date>"` and `"<Star player> playing tonight"`.
- **Rest**: is either team on a back-to-back (played yesterday)? Road back-to-backs
  are worth roughly -2 to -3 points.
- **Motivation / tanking / load management**: end-of-season rest, eliminated teams,
  star sitting for "load management", playoff seeding locked.
- Prefer primary sources: team beat reporters, ESPN, NBA.com, Rotowire, official
  injury report. Treat single tweets cautiously; confirm star statuses.

Convert findings into **point adjustments** (added to a team's expected margin):

| Situation | Adjustment to that team |
|---|---|
| Clear #1 star **Out** (e.g. MVP-level) | **-5 to -8** |
| Strong starter **Out** | **-2 to -4** |
| Rotation player **Out** | **-1** |
| Key player **Doubtful** | ~75% of the "Out" value |
| On a road **back-to-back** | **-2 to -3** |
| On a home back-to-back | **-1 to -2** |
| Resting starters / tanking / load mgmt (confirmed) | **-4 to -8**, or **SKIP the game** |

**Skip, don't guess.** If a *star's* status is unresolved **Questionable** at run
time and it would swing the pick, do **not** apply a guessed adjustment — exclude
that game (note it in the report). Calibration depends on not betting blind.

### 3' (MANUAL mode only) Build the data file
When live fetch is blocked, gather the same numbers by hand and write
`prediction/data/input.today.json`. Schema (see `prediction/data/input.example.json`):

```json
{
  "date": "YYYY-MM-DD",
  "games": [
    {
      "home": "Lakers", "away": "Celtics",
      "marketPrices": { "Lakers": 0.46, "Celtics": 0.54 },
      "homeNetRating": 2.1, "awayNetRating": 5.8,
      "homeRecord": [48, 34], "awayRecord": [55, 27],
      "adjustments": { "Lakers": { "points": -3.5, "reason": "AD doubtful (knee)" } },
      "injuries": [{ "team": "Lakers", "player": "Anthony Davis", "status": "Doubtful" }],
      "slug": "nba-lal-bos-YYYY-MM-DD", "conditionId": "0x...", "question": "Lakers vs. Celtics"
    }
  ]
}
```
Fill each field from web research:
- `marketPrices` — current Polymarket prices for the two teams. Get them by
  `WebFetch`ing `https://gamma-api.polymarket.com/events?tag_slug=nba&closed=false&limit=100`
  (or from polymarket.com), or from any odds source converted to implied prob.
  They need not sum to 1 (de-vigged automatically).
- `homeNetRating` / `awayNetRating` — each team's **season average point
  differential per game** (points scored minus allowed). Search
  `"<Team> net rating"` or compute from points-for/against per game. This is the
  single most important model input — get it roughly right (±1).
- `adjustments` / `injuries` — from step 3.
- `conditionId` — include it when you have it so picks can be graded and deduped.

### 4. Apply adjustments and generate picks
- **LIVE mode**: write the adjustments into `prediction/data/adjustments.json`
  (keyed by team abbr), e.g. `{ "LAL": { "points": -3.5, "reason": "AD doubtful" } }`,
  then:
  ```bash
  npm run predict -- --save
  ```
- **MANUAL mode**: adjustments already live inside `input.today.json`, so:
  ```bash
  npm run predict -- --input prediction/data/input.today.json --save
  ```
- Use `--threshold 0.82` instead of the default only if the latest
  `prediction/data/review.md` tuning guidance told you to.

`--save` appends picks to `prediction/data/predictions.jsonl` (the system's memory)
and skips any market already logged.

### 5. Report to the user
Show, clearly:
1. **PICKS** — for each: `Away @ Home → PICK team (confidence %)`, the model vs
   market split, and the one-line reason (key adjustment / why it cleared).
2. **Skipped** — games that didn't clear the threshold, and any game excluded for
   unresolved star status, with a one-line why.
3. A reminder: *"~80% target holds only across many picks; expect ~1 in 5 of these
   to lose. Stake responsibly."*
4. Tell them to **commit `prediction/data/*`** so the prediction log persists.

Keep the report tight. Do not pad with disclaimers beyond #3.

---

## SCORE MODE — `/nba-predict score`

Grade the pending picks and learn from misses.

1. Get final scores. Try live:
   ```bash
   npm run predict:score
   ```
   If the ESPN fetch is blocked, gather finals via `WebSearch`
   (`"NBA scores <date>"`), write `prediction/data/results.json`:
   ```json
   { "results": [ { "home": "Thunder", "away": "Wizards", "homeScore": 124, "awayScore": 98, "date": "YYYY-MM-DD" } ] }
   ```
   then:
   ```bash
   npm run predict:score -- --results prediction/data/results.json
   ```
2. Read `prediction/data/review.md` (accuracy, Brier, calibration table, mistakes).
3. **Classify every miss** into exactly one bucket and say which:
   - **Variance** — correct read, the underdog just won (a calibrated 80% pick
     loses 1 in 5; this is expected, change nothing).
   - **Information miss** — late news you didn't catch (star ruled out after run,
     surprise rest). Fix the *research step*, not the model.
   - **Model error** — model disagreed sharply with the market and was wrong.
     Consider lowering model weight.
4. **Propose tuning**, then apply it only if the evidence supports it:
   - Accuracy < 80% with misses clustered in the 78-85% bucket → raise the default
     threshold (edit `DEFAULT_THRESHOLD` in `prediction/src/predict.ts`, e.g. 0.82).
   - Hit rate consistently *above* stated confidence across buckets → threshold is
     too high; you're leaving picks on the table; consider lowering it.
   - Misses dominated by model-vs-market disagreement → raise `MARKET_WEIGHT` in
     `prediction/src/model.ts` (trust the market more).
   - Misses dominated by information misses → tighten the research checklist; do not
     touch the model constants.
   - One or two games of data → **do not tune**; say so. Need a meaningful sample.
5. Report: accuracy vs 80% target, the per-miss classification, and what you
   changed (or why you changed nothing). Remind the user to commit `prediction/data/*`.

---

## Guardrails
- This service predicts **who will win**, not whether a price is +EV. Say so if the
  user conflates accuracy with profit — high-confidence picks trade at high prices.
- Never fabricate injury/score data. If web research is inconclusive on a star,
  skip that game rather than guess.
- Never edit `prediction/data/predictions.jsonl` by hand to improve the record.
- Keep model constants stable; change them only through the score-review loop with
  a stated reason, so calibration stays meaningful.
