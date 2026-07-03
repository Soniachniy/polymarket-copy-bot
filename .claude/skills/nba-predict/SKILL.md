---
name: nba-predict
description: Generate selective, calibrated NBA moneyline predictions for Polymarket, or grade prior picks. Use when the user runs /nba-predict, asks for NBA game predictions/picks, or wants to score past predictions. Gathers markets, standings, injuries and lineup news, blends a ratings model with the market price, and emits only high-confidence picks. Works even when live endpoints are blocked by gathering data via WebSearch/WebFetch.
---

# NBA prediction service for Polymarket

You are the session layer of a selective NBA predictor. Your job each run is to produce
**calibrated moneyline picks** for tonight's Polymarket NBA games, or to **grade** past picks.
The math lives in `prediction/src/`; you supply game-day information and drive the CLI.

## The one rule that produces ~80% accuracy: be selective

No model calls every NBA game at 80% — the betting market itself is only ~68-70% accurate and
it is the sharpest public forecast that exists. The honest route to 80% is to **only emit picks
whose blended probability clears the threshold (default 0.78) and skip everything else.** Some
nights produce zero picks. That is the correct output, not a failure. Never force a pick on a
coin-flip game to "have something" — that is exactly what destroys the hit rate.

Four levers, already wired into the code, get you there:
1. **Selectivity** — threshold filter (only ≥78% blended picks ship).
2. **Market anchoring** — final prob = 35% ratings model + 65% de-vigged market price. Markets are sharp; respect them.
3. **Game-day information** — YOU research injuries/rest/back-to-backs/motivation the season ratings can't see, and encode them as point adjustments.
4. **Calibration loop** — the score step checks stated confidence vs realized hit rate and tunes the threshold.

## Modes

- `/nba-predict` (default) → **generate** picks for today (or `--date`).
- `/nba-predict score` → **grade** pending picks against finals, write the review, classify misses, tune.

---

## GENERATE workflow

### 0. Setup (first run only)
```bash
npm install
```

### 1. Try the live pipeline first
```bash
npm run predict -- --save
```
If it prints picks and "Saved N prediction(s)", you're done — skip to step 5 (Report).

If it fails with `HTTP 403 ... not in allowlist`, `Host not in allowlist`, or any network/egress
error, the environment blocks direct fetch. Fall back to **session-gathered mode** (steps 2-4).
Do not give up — this fallback is the normal path in restricted environments.

### 2. Gather the slate with your own tools
Use WebSearch / WebFetch to collect, for **today's** games (US/Eastern date):

- **Schedule** — which teams play, and which is **home**. Search e.g. "NBA schedule today <date>".
  Home/away is critical: home court is worth ~+2.6 points in the model.
- **Team ratings** — each team's **season average point differential** (points scored − allowed,
  per game). Sources: ESPN/NBA/basketball-reference standings, teamrankings.com net rating. This is
  the model's power rating; get it for every team playing tonight.
- **Market prices** — the Polymarket implied win probability for each side. If polymarket.com is
  reachable, use it. If not, pull moneyline odds from any major sportsbook and convert to implied
  probabilities (american odds → prob). The pipeline de-vigs the two numbers, so raw book implieds
  that sum to ~1.05 are fine.
- **Injuries / availability** — for each team, who is **Out / Doubtful**, plus rest situation
  (playing a **back-to-back**? long road trip?) and any late "Questionable" star. Search team news
  and official injury reports for game day, not last week.

### 3. Encode game-day information
Write `prediction/data/adjustments.json` — per-team point adjustments layered on the model margin
(these are the edge the raw ratings can't see):

```json
{
  "MIA": { "points": -5, "reason": "Butler + Herro both Out" },
  "DEN": { "points": -2.5, "reason": "2nd night of a back-to-back" },
  "BOS": { "points": 1.5, "reason": "fully healthy, at home off 2 days rest" }
}
```
Rough magnitudes: a clear star out ≈ −3 to −6; a key rotation player out ≈ −1.5 to −3; a
back-to-back / heavy travel ≈ −2 to −3. Use `{}` if there is nothing material.

**Guardrail — unresolved star:** if a *star's* status is still "Questionable/Game-time decision"
at run time, do **not** guess a large adjustment. Prefer to let that game fall below threshold and
be skipped. A wrong guess on a star is the #1 source of high-confidence misses.

### 4. Build the input file and run
Write `prediction/data/session-input.json` (see `references/schemas.md` for the full schema):

```json
{
  "games": [
    { "date": "2026-01-15", "home": "Boston Celtics", "away": "Miami Heat", "homePrice": 0.80, "awayPrice": 0.20 },
    { "date": "2026-01-15", "home": "OKC", "away": "WAS", "homePrice": 92, "awayPrice": 8 }
  ],
  "ratings": {
    "BOS": { "pointDiff": 6.5, "wins": 30, "losses": 10 },
    "MIA": { "pointDiff": 0.5, "wins": 22, "losses": 18 },
    "OKC": { "pointDiff": 9.8 },
    "WAS": { "pointDiff": -8.2 }
  },
  "injuries": [ { "teamAbbr": "MIA", "player": "Jimmy Butler", "status": "Out" } ]
}
```
Team refs may be names or abbreviations; prices may be probabilities (0.80) or cents (80). Then:
```bash
npm run predict -- --input prediction/data/session-input.json --save
```
Add `--all` to inspect below-threshold games, `--threshold 0.82` to be stricter.

### 5. Report to the user
Report the **PICKS** (team, confidence, model vs market, one-line rationale incl. injuries) and the
**skipped** games (why each is below threshold). If zero picks clear, say so plainly and explain
that skipping coin-flips is the point. Then **commit** so the log persists as the system's memory:
```bash
git add prediction/data/ && git commit -m "nba picks <date>"
```

---

## SCORE workflow (`/nba-predict score`)

Run after the games finish (usually next morning).

1. Try live grading:
   ```bash
   npm run predict:score
   ```
2. If blocked, gather **final scores** for the pending pick dates via WebSearch, write
   `prediction/data/finals.json`, and grade offline:
   ```json
   { "finals": [
     { "date": "2026-01-15", "home": "OKC", "away": "WAS", "winner": "OKC" },
     { "date": "2026-01-15", "home": "BOS", "away": "MIA", "homeScore": 101, "awayScore": 110 }
   ] }
   ```
   ```bash
   npm run predict:score -- --finals prediction/data/finals.json
   ```
3. Read `prediction/data/review.md`. Report accuracy vs the 80% target, the Brier score, and the
   calibration table.
4. **Classify each miss** as one of: (a) **variance** — a correct 80% call that lost the 1-in-5
   (no action); (b) **information miss** — late injury/rest news you didn't encode (tighten step 2);
   (c) **model error** — model disagreed with the market and was wrong (consider lowering model weight).
5. **Tune** per the guidance in review.md — raise `--threshold` if misses cluster in the 78-85%
   bucket; adjust `MARKET_WEIGHT` in `prediction/src/model.ts` only if model-vs-market disagreements
   are systematically wrong. Then commit the updated log and any tuning.

## Guardrails recap
- Only ship picks ≥ threshold. Zero picks is a valid night.
- Never force a large adjustment on an unresolved "Questionable" star — skip the game instead.
- Always `--save` and commit `prediction/data/` — the JSONL log is how calibration improves.
- 80% *accuracy* ≠ *profit*: high-confidence picks trade at high prices. This service answers
  "who will win", not "is this price +EV". Tell the user that if they ask about returns.

See `references/schemas.md` for exact input/finals schemas and `prediction/README.md` for the model math.
