---
name: nba-predict
description: >-
  Generate calibrated, selective NBA win predictions for Polymarket moneyline markets, or grade
  past predictions. Use when the user types /nba-predict, asks for NBA picks/predictions for
  Polymarket, asks who will win tonight's NBA games, or asks to score/grade/review previous NBA
  predictions. Targets ~80% hit rate by only emitting high-confidence, market-anchored picks.
---

# NBA prediction service for Polymarket

You are running a **selective, calibrated** NBA moneyline predictor. The goal is a ~80% hit rate,
achieved by being picky — not by predicting every game. Read `prediction/README.md` once for the
philosophy. The two modes below are the entire job.

```
/nba-predict            -> generate today's picks (default)
/nba-predict score      -> grade past picks vs final scores, then tune
/nba-predict 2026-01-15 -> picks for a specific date (YYYY-MM-DD, repeatable)
```

## Why this can reach 80% (do not skip)

The betting market is the best public forecast and is only ~68-70% accurate across *all* games.
You beat that on the subset you choose to bet by stacking four things, in order of importance:

1. **Market anchoring** — the de-vigged Polymarket price is the backbone of every probability.
   Never override it on a hunch.
2. **Selectivity** — only emit a pick when the blended probability ≥ threshold (0.78) AND the
   market's own probability ≥ floor (0.60). Most nights this yields a handful of picks, sometimes
   zero. **Zero picks is a correct, successful run** — say so plainly; do not force marginal picks.
3. **Game-day information** — season ratings can't see tonight's lineup. Your web research into
   injuries, rest, and motivation is encoded as point adjustments before picks are computed.
4. **Calibration** — an 80% pick is *supposed* to lose 1 in 5. The score loop verifies stated
   confidence matches reality and tunes the threshold. Do not panic at a single miss.

Tell the user "win probability", not "+EV bet" — high-confidence picks trade at high prices.

---

## MODE 1 — Generate picks (default)

### Step 0 — Setup
- Ensure deps: if `node_modules` is missing, run `npm install`.
- Determine target date(s). Default = today (the service uses the live ESPN slate). If the user
  gave a date, pass `--date YYYY-MM-DD` (repeatable).

### Step 1 — Get the slate (with fallback)
Run the pipeline in analysis mode to pull markets + ratings + the matched games:

```bash
npm run predict -- --all --json
```

- **If it succeeds:** you now have every matched game with `pModel`, `pMarket`, blended
  `probability`, and listed injuries. Good — go to Step 2.
- **If it fails with a network/allowlist/403 error** (some sandboxes block ESPN and the Polymarket
  Gamma API), do the data-gathering yourself and skip to the "Manual path" note at the bottom.
  Do not give up — fall back to `WebFetch`/`WebSearch`.

### Step 2 — Research the slate (this is where the edge comes from)
For **each matched game** that is even close to the threshold (say `pMarket` between 0.55 and 0.95
— blowouts and coin-flips below the floor need no research), use `WebSearch` for tonight's news.
Search like a sharp bettor:

- `"<Team> injury report <today's date>"` and `"<Team> starting lineup tonight"`
- Is either team on the **second night of a back-to-back**? (check the schedule)
- **Motivation / context**: tanking for lottery position, locked playoff seed resting starters,
  load management of a star, a coach announcing a "blowout-rotation" night.
- Confirm the **star players' game status**: Out / Doubtful / Questionable / Probable / Active.

### Step 3 — Encode findings as point adjustments
Write `prediction/data/adjustments.json`. Keys are team abbreviations (see `prediction/src/teams.ts`),
each value `{ "points": <number>, "reason": "<short>" }`. **Points shift that team's expected margin**
(negative = weaker). Use this playbook for consistency — these are calibrated to NBA margin units
(σ ≈ 11.5 pts), so resist inventing large numbers:

| Situation | Points |
|---|---|
| MVP-caliber star **Out** (e.g. top-10 player) | −6 to −8 |
| Clear #1 option / All-Star **Out** | −4 to −6 |
| Solid starter **Out** | −2 to −3 |
| Role player **Out** | −0.5 to −1.5 |
| Key player **Doubtful** | ~70% of the "Out" value |
| Second night of a back-to-back (esp. on the road) | −1.5 to −2.5 |
| Resting starters (locked seed / end of season) | −5 to −10 (or skip the game entirely) |
| A returning star coming back from injury | +2 to +4 |

**Hard rule — do not adjust around uncertainty.** If a star is **Questionable** with no resolution,
do **not** try to price it. Add a note and let the threshold/floor skip the game. Guessing on
unresolved star status is the #1 cause of missed predictions. An empty `{}` is fine when there's
no news.

### Step 4 — Generate and log the picks
```bash
npm run predict -- --save
```
(append `--date ...` flags to match Step 0). This re-reads `adjustments.json`, blends model +
market, applies the threshold and market floor, prints PICKS plus games held back, and appends
new picks to `prediction/data/predictions.jsonl` (the system's memory; never edit by hand).

Optional knobs only if the score loop has told you to: `--threshold 0.82`, `--market-floor 0.65`.

### Step 5 — Report to the user
Present clearly:
- **PICKS**: for each — matchup, the team to win, confidence %, and a one-line rationale
  (model vs market, plus any adjustment/injury note).
- **Held back**: games that cleared confidence but failed the market floor (market saw them as
  close) — list briefly so the user sees what was skipped and why.
- **No picks**: if none clear the bar, say so confidently — that is the system working, not failing.
- Remind the user to come back with `/nba-predict score` after the games finish, and to **commit
  `prediction/data/*`** so the prediction log persists.

---

## MODE 2 — Score and tune (`/nba-predict score`)

1. Run `npm run predict:score`. It fetches ESPN finals for every pending pick's date, marks each
   `correct`/`incorrect`, updates `predictions.jsonl` in place, and writes
   `prediction/data/review.md` (accuracy, Brier score, per-confidence-bucket calibration, and a
   list of every miss).
2. Read `prediction/data/review.md` and present: overall accuracy vs the 80% target, the
   calibration table, and each miss.
3. **Classify every miss** into one of three buckets — this is the learning step:
   - **Variance** — a correctly-priced ~80% pick that lost. Expected ~1 in 5. No action.
   - **Information miss** — late lineup/rest/motivation news the research missed. Action: tighten
     the Step 2/3 routine (e.g. always confirm star status within an hour of tip).
   - **Model error** — the model sat far above the market and was wrong (overconfident ratings).
     Action: consider raising `MARKET_WEIGHT` or the threshold.
4. **Propose concrete tuning** grounded in the calibration table, then apply it once the user
   agrees:
   - Accuracy < 80% with misses clustered in the 78–85% bucket → raise `--threshold` (e.g. 0.82).
   - Hit rate consistently *above* stated confidence → you're too strict; lower the threshold.
   - Misses cluster on the model/market disagreeing → raise `MARKET_WEIGHT` in
     `prediction/src/model.ts` (respect the market more).
   - Misses cluster on injury/rest surprises → it's process, not parameters; fix the research step.
5. Remind the user to **commit `prediction/data/*`** so the graded history and review persist.

---

## Manual path (when CLI data endpoints are blocked)

If `npm run predict` can't reach ESPN / Polymarket Gamma, gather the same inputs with
`WebFetch`/`WebSearch` and compute by hand:

- **Markets + prices**: `WebFetch` `https://gamma-api.polymarket.com/events?tag_slug=nba&closed=false&limit=100`
  (outcomes/prices are JSON-encoded strings), or read the matchup prices off polymarket.com.
- **Schedule (home/away) + standings (W-L, point differential) + injuries**: `WebSearch`
  (e.g. "NBA scores today", "NBA standings point differential", "<Team> injury report").
- **Per game**: de-vig the two prices (divide each by their sum). Compute the model margin =
  `home.pointDiff − away.pointDiff + 2.6` plus your adjustments, then `pModel = Φ(margin / 11.5)`.
  Blend: `0.65·pMarket + 0.35·pModel`. Emit the pick only if `blend ≥ 0.78` **and**
  `pMarket ≥ 0.60`.
- Append each emitted pick to `prediction/data/predictions.jsonl` as one JSON object per line
  matching the `Prediction` type in `prediction/src/types.ts` (status `"pending"`), so the score
  loop can grade it later.

Keep the same selectivity discipline either way: **few, well-supported, market-anchored picks.**
