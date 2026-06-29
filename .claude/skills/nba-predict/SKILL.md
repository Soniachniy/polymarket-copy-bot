---
name: nba-predict
description: >-
  Generate calibrated, selective win predictions for today's Polymarket NBA
  moneyline markets, and grade past picks. Use when the user runs /nba-predict,
  asks for NBA game predictions, Polymarket NBA picks, or to score/review prior
  NBA predictions. Targets ~80% accuracy by only emitting high-confidence,
  market-anchored picks and skipping coin-flip games.
---

# NBA prediction service for Polymarket

You are the **session layer** of an NBA prediction service. A deterministic TypeScript
engine (`prediction/`) does the probability math; **you** supply the game-day information it
cannot see (tonight's injuries, rest, motivation) and decide the final picks. Your job is to
produce predictions that hit **~80%** — which is only possible by being **selective**: you
skip coin-flip games on purpose and only emit picks that clear the confidence threshold.

Read `prediction/README.md` once if you have not — it explains *why* 80% requires selectivity,
calibration, and market anchoring. Do not try to predict every game.

## The one rule that determines accuracy

**A pick is only valid when it (a) clears the confidence threshold (default 0.78) AND (b) is
anchored to a real Polymarket price.** Model-only guesses and coin-flip games are skipped.
Some nights produce zero picks. That is the correct, winning behavior — forcing picks is what
destroys the hit rate.

---

## Modes

The user invokes this skill in one of two ways:

- `/nba-predict` (or "predict tonight's NBA games") → **PREDICT** workflow below.
- `/nba-predict score` (or "score / grade / review yesterday's picks") → **SCORE** workflow below.

If a date is given (e.g. "predict the games on 2026-11-03"), use it; otherwise use today in US/Eastern.

---

## PREDICT workflow

### Step 1 — Set up

```bash
npm install            # first run only
```

### Step 2 — Get the slate (which games, who's home)

Try the **live engine first**; fall back to **research mode** if the network blocks it.

```bash
npm run predict -- --all --json
```

- **If it prints rows / "matched games"** → live data is reachable. Note the matched games. You
  will still do Step 3 research and re-run with adjustments. Continue at Step 4.
- **If it fails with `Host not in allowlist` / 403 / fetch errors** → the direct ESPN +
  Polymarket APIs are blocked in this environment. Switch to **research mode** (Step 3R). This
  is common; it is not a bug.

### Step 3 — Research the slate (ALWAYS do this — it's where the edge is)

The season ratings can't see tonight's lineup. Use **WebSearch** (and WebFetch where allowed)
to find, for **each game on the slate**:

1. **Schedule & home/away** — confirm tonight's matchups. Sources: "NBA schedule [date]",
   ESPN/NBA.com schedule pages.
2. **Injuries / inactives** — "[team] injury report [date]", "NBA inactives tonight". Capture
   any **star** listed Out, Doubtful, or Questionable.
3. **Rest / schedule spot** — is either team on a **back-to-back** (B2B), 3rd-game-in-4-nights,
   or the end of a long road trip? Search "[team] back to back tonight".
4. **Net rating / point differential** — each team's season net rating (points per 100, ≈ per-game
   point diff). Sources: "NBA net rating standings", teamrankings.com, basketball-reference.
5. **Polymarket price** — the current moneyline price for each team. Search the Polymarket NBA
   page or "[away] [home] Polymarket". You need a number 0–1 for each side; if you cannot find
   a price, the game **cannot** be a pick — skip it.

Encode what you find as **point adjustments** to the expected margin, using this table (these are
the magnitudes that keep the model calibrated — do not freelance larger numbers):

| Situation | Adjustment to that team's margin |
|---|---|
| All-NBA / top-15 star **Out** | **−6 to −8** |
| Clear All-Star starter **Out** | **−3.5 to −5** |
| Solid starter **Out** | **−1.5 to −3** |
| Key rotation player **Out** | **−1 to −1.5** |
| Star **Doubtful** | treat as ~70% out: about 0.7 × the "Out" value |
| Star **Questionable (unresolved)** | **do not adjust — SKIP the game** (you can't price a coin flip on a tag) |
| Team on a **back-to-back** | **−1.5 to −2.5** |
| Opponent rested 2+ days while team on B2B | apply the B2B penalty to the tired team only |
| Clear tanking / resting starters (late season, eliminated) | skip unless the price already reflects it |

Stars returning from injury, revenge games, and "must-win" narratives are **noise** — ignore them
unless they change who actually plays.

### Step 3R — Research mode (when live fetch is blocked)

Build an input bundle from your research and let the engine score it. Write
`prediction/data/input.json` in this shape (see `prediction/data/input.example.json`):

```json
{
  "date": "YYYY-MM-DD",
  "games": [
    {
      "home": "Boston Celtics",
      "away": "New York Knicks",
      "homeRating": 6.1,            // season net rating / point diff, home team
      "awayRating": 2.4,
      "marketHomePrice": 0.66,      // Polymarket price for home side, 0..1
      "marketAwayPrice": 0.36,
      "slug": "nba-nyk-bos-YYYY-MM-DD",
      "conditionId": "0x...",       // optional; from Polymarket if you have it
      "adjustments": { "BOS": { "points": -3.5, "reason": "Porzingis Out" } },
      "injuries": [ { "team": "NYK", "player": "Robinson", "status": "Questionable" } ]
    }
  ]
}
```

Then score it (no network needed):

```bash
npm run predict -- --input prediction/data/input.json --all
```

### Step 4 — Generate and save the picks

Live mode: write game-day adjustments to `prediction/data/adjustments.json`
(`{ "BOS": { "points": -3.5, "reason": "Porzingis Out" }, ... }`) and run:

```bash
npm run predict -- --save
```

Research mode: re-run the input bundle with `--save`:

```bash
npm run predict -- --input prediction/data/input.json --save
```

`--save` appends only above-threshold picks to `prediction/data/predictions.jsonl` (the system's
memory) and de-dupes by market. Default threshold is 0.78; raise it with `--threshold 0.82` if the
last review showed misses clustered just above 0.78.

### Step 5 — Report to the user

Present:

- **PICKS** — for each: matchup, pick + team, confidence %, and a one-line reason (what the
  adjustment was, model vs market). These are the bets to place.
- **SKIPPED** — games that didn't clear threshold or had unresolved star Questionables, with the
  reason. Brief.
- A reminder that an 80% target means **~1 in 5 picks will still lose** — that's expected and
  on-calibration, not a mistake.

Then **commit** the data so the memory persists:

```bash
git add prediction/data && git commit -m "nba-predict: picks for <date>"
```

---

## SCORE workflow (`/nba-predict score`)

Grade pending picks against final scores and learn from misses.

```bash
npm run predict:score
```

- Live mode pulls finals from ESPN automatically. If that's blocked, look up each pending game's
  **final score** with WebSearch first, then mark results: edit the matching line(s) in
  `prediction/data/predictions.jsonl`, setting `"status"` to `"correct"` or `"incorrect"` and
  `"actualWinner"` to the winning team abbr. (`status` grades against `pickTeam`.)
- Read the generated `prediction/data/review.md` and report to the user:
  - Overall **accuracy** vs the 80% target, **Brier score**, and the **calibration table**.
  - Each miss, classified as **(a) variance** (good pick, lost — expected ~20% of the time),
    **(b) information miss** (late injury/rest news you didn't catch — fixable), or
    **(c) model error** (model fought the market and was wrong).
- Apply tuning from the misses:
  - Many misses in the 0.78–0.85 bucket → raise the threshold (use `--threshold 0.82` going forward).
  - Hit rate consistently **above** stated confidence → threshold can come down; you're leaving picks on the table.
  - Misses cluster on injury surprises → be stricter about skipping unresolved Questionables.
  - Model badly disagreed with the market on misses → lower model weight (`MARKET_WEIGHT` in `prediction/src/model.ts`), tuning only through this review loop.
- Commit: `git add prediction/data prediction/src && git commit -m "nba-predict: score + tune <date>"`.

---

## Guardrails

- Never invent injuries, prices, or ratings. If you can't verify a number, skip the game.
- Never lower the threshold just to produce picks on a quiet night. Zero picks is a valid result.
- The market is the sharpest public forecast; large model-vs-market disagreements are a reason for
  suspicion, not confidence.
- One market = one pick. Don't log the same `conditionId` twice (the engine de-dupes, but don't fight it).
- Off-season (≈ July–September) there are no games — say so and stop.
