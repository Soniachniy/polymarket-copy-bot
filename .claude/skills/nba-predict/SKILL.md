---
name: nba-predict
description: >-
  Generate calibrated, selective NBA win predictions for Polymarket moneyline
  markets, or grade and tune past predictions. Use when the user runs
  /nba-predict, asks for today's NBA picks, asks who will win NBA games, or
  asks to score/review previous NBA predictions. Targets ~80% hit rate by only
  emitting high-confidence picks and blending a ratings model with the de-vigged
  market price, plus same-day injury/rest research.
---

# NBA prediction service (Polymarket moneylines)

This skill turns a Claude session into a repeatable NBA prediction run. You (Claude)
do the game-day research and orchestration; a tested TypeScript engine
(`prediction/src/*`) does the data fetching, probability math, market blending,
selectivity, saving, and grading. The user just runs `/nba-predict`.

**Golden rule of 80%:** accuracy comes from *selectivity*, not from predicting every
game. The engine only emits a pick when blended confidence clears the threshold
(default 0.78). Coin-flip games are skipped on purpose. **Some nights produce zero
picks — that is the correct, winning behavior. Never invent picks to fill a slate.**

The honest ceiling: the betting market itself is ~68–70% accurate across all NBA games
and is the best public forecast that exists. We beat that only on the *subset* of games
where the blend is confident AND our same-day research confirms nothing is broken.

---

## Modes

- `/nba-predict` or `/nba-predict predict [YYYY-MM-DD]` → produce today's (or a date's) picks.
- `/nba-predict score` → grade pending predictions against final scores and tune.

Default to **predict** mode when no argument is given.

---

## Predict mode — run this exact sequence

### 1. Prepare
- Working dir is the repo root (`/home/user/polymarket-copy-bot`).
- If `node_modules` is missing, run `npm install` once.
- Target date = the argument if given, else **today in US/Eastern** (ESPN's game date).
  Pass it as `--date YYYY-MM-DD` to every command below so the run is reproducible.

### 2. First pass — pull the slate and base model (no save yet)
```bash
npm run predict -- --all --json --date <DATE>
```
This prints every matched game as JSON with: `question`, `pickTeam`, `probability`
(blended), `pModel`, `pMarket`, `edge`, and `rationale`. Read it.

- If it errors with **"Live fetch … failed and no cached snapshot exists"**, the
  environment is blocking the data hosts. Do NOT fabricate data. Go to
  **"When data is blocked"** below, then re-run this step.
- Note which games are anywhere near the threshold: any game with `pMarket` or
  `pModel` ≥ 0.65 is worth researching in step 3. Clear blowouts and clear coin-flips
  below 0.6 rarely need research.

### 3. Game-day research (this is where the edge over the raw market comes from)
For each game flagged in step 2, use **WebSearch** (it works even when the data APIs are
egress-blocked) to confirm tonight's reality. Search the team names + "injury report",
"starting lineup", "inactives", "back to back". Establish:

- **Confirmed inactives** — a star ruled **Out** is the single biggest signal.
- **Rest** — second night of a back-to-back, long road trip, or a clearly rested favorite.
- **Motivation** — end of season seeding locked, tanking, or a team resting starters in a
  meaningless game. Playoff/play-in intensity in the other direction.
- **Reliable, dated sources only** (team beat writers, official injury report, ESPN/The
  Athletic). Ignore stale articles — verify the date matches the game date.

Translate findings into **point adjustments** to a team's expected margin and write them to
`prediction/data/adjustments.json` (overwrite it fresh each run; clear stale entries):

```json
{
  "LAL": { "points": -6, "reason": "Luka Doncic ruled OUT (rest)" },
  "DEN": { "points": -1.5, "reason": "2nd night of back-to-back, at altitude disadvantage away" }
}
```

Point-adjustment guide (per team, applied to its side of the margin):

| Situation | Points |
|---|---|
| Clear All-NBA star ruled **Out** | −5 to −8 |
| Quality starter / 2nd star **Out** | −2 to −4 |
| Role player Out | −0.5 to −1.5 |
| Second night of a back-to-back | −1.5 to −2.5 |
| Team resting starters / tanking (confirmed) | −6 to −10 |
| Key player **returning** from injury | +1 to +3 |

**Hard skip rule:** if a game-swinging star is **Questionable / Game-Time-Decision** and you
cannot confirm in or out, do **not** guess a fractional adjustment. Leave that team with no
adjustment and treat the game as *skip-uncertain* — report it as skipped in step 6. Unresolved
star status is the #1 cause of confident misses; refusing the game protects the hit rate.

### 4. Second pass — apply adjustments and save the picks
```bash
npm run predict -- --save --date <DATE>
```
This reloads `adjustments.json`, re-blends, prints picks ≥ threshold, and appends them to
`prediction/data/predictions.jsonl` (the system's memory; it won't double-log a market).

- To be stricter on a heavy slate, add `--threshold 0.82`.
- The saved JSONL row is the contract that `score` mode grades later.

### 5. Sanity-check before reporting
For each emitted pick, confirm the rationale still makes sense given your research. If an
adjustment you made should have flipped or killed a pick but didn't, re-check
`adjustments.json` (right team abbr? right sign? negative = weaker) and re-run step 4.

### 6. Report to the user
Give a tight summary:
- **PICKS** — for each: `Team to win — NN% confidence` + one line of why (model vs market +
  the decisive research note). Sort by confidence.
- **Skipped (uncertain/coin-flip)** — game + one-line reason (e.g. "PG questionable, GTD").
- If zero picks: say so plainly and explain it's the correct output for this slate.
- Remind the user to **commit `prediction/data/*`** so the prediction log (memory) persists,
  and to return the next day for `/nba-predict score`.

---

## Score mode — grade and tune

### 1. Grade
```bash
npm run predict:score
```
Fetches final scores for the dates of all pending picks, marks each `correct`/`incorrect`
in `predictions.jsonl`, and writes `prediction/data/review.md` with accuracy, Brier score,
and a calibration table.

### 2. Read `prediction/data/review.md` and classify every miss
Put each incorrect pick in exactly one bucket:
- **Variance** — sound process, the favorite simply lost (expected ~1 in 5 at 80%). No change.
- **Information miss** — late news we failed to capture (surprise scratch, blowout rest day).
  Action: tighten the step-3 research checklist; the skip rule should have caught it.
- **Model error** — the model was systematically overconfident vs the market on misses.
  Action: lower model weight.

### 3. Apply tuning (only through this loop)
- Accuracy < 80% and misses cluster in the 78–85% bucket → raise the default threshold
  (`DEFAULT_THRESHOLD` in `prediction/src/predict.ts`, e.g. 0.78 → 0.82).
- Per-bucket hit rate consistently **above** stated confidence → you're too strict; lower
  the threshold (leaving good picks on the table).
- Model-error misses → raise `MARKET_WEIGHT` in `prediction/src/model.ts` (trust the market more).
- Repeated injury-surprise misses → strengthen the hard skip rule wording in this skill.

Make the smallest change the evidence supports. Re-run `npm test` after editing constants.

### 4. Report + commit
Show accuracy vs the 80% target, the calibration table, the miss classification, and what you
changed. Commit `prediction/data/*` and any tuned source files.

---

## When data is blocked (egress allowlist / sandbox)

The engine fetches from `gamma-api.polymarket.com` and `site.api.espn.com`. If the environment
blocks them you'll see `403 Host not in allowlist`.

1. **Preferred:** ask the user to allowlist those two hosts for network egress (see the repo
   README "Network requirements"), then re-run. This is the only way to get exact live market
   prices automatically.
2. **Fallback (snapshot mode):** the engine reads `prediction/data/cache/<key>.json` whenever a
   live fetch fails, so you can hand-write a snapshot from WebSearch findings and still produce
   model-blended picks. Required keys and shapes are documented in `prediction/README.md`
   ("Offline / snapshot mode"). At minimum write `markets`, `scoreboard-today` (or
   `scoreboard-YYYYMMDD`), and `standings`; `injuries` may be `[]`. Market prices gathered from
   the web are approximate — say so in the report when running this way.

Never fabricate a result silently. If you can't get trustworthy prices, tell the user and stop.

---

## Guardrails
- Selectivity over coverage. Zero picks beats forced picks.
- Respect the market: the blend is 65% market by default. Large model-vs-market disagreements
  on the *pick* side are a yellow flag — research harder or skip.
- This answers "who will win", not "is this price +EV". High-confidence picks trade at high
  prices; accuracy ≠ profit.
- Only tune constants through the score loop, with `npm test` green afterward.
