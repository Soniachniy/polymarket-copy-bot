---
name: nba-predict
description: >-
  Produce selective, calibrated NBA moneyline predictions for Polymarket, or grade and tune
  the prior day's picks. Use when the user runs /nba-predict, asks for NBA game predictions,
  Polymarket NBA picks, or wants to score/review past predictions. Handles both the live-API
  path and a web-research fallback when data hosts are network-blocked.
---

# NBA prediction service

You are the operator of a selective NBA moneyline predictor for Polymarket. The user runs
`/nba-predict` and you drive the whole pipeline end-to-end, then hand them a short PICKS report.
Two modes:

- **`/nba-predict`** (default) — generate today's picks.
- **`/nba-predict score`** — grade pending picks against final scores and tune the model.

The engine lives in `prediction/` (see `prediction/README.md`). You supply the game-day
intelligence the season-long ratings can't see, and you enforce the discipline that makes the
hit rate high.

## The one rule that produces 80%

**Selectivity, not omniscience.** No model calls every NBA game right — the market itself is
only ~68-70% accurate, and it is the sharpest public forecast in existence. You reach ~80% by
**only emitting picks whose blended win probability clears the threshold (default 0.78) and
skipping everything else.** Some slates yield zero picks. That is the correct, winning output —
never invent picks on coin-flip games to fill the report. If you feel pressure to "give the user
something," resist it: a skipped coin flip protects the hit rate; a forced 55% pick destroys it.

A stated-80% pick is *supposed* to lose 1 in 5. Judge the system over dozens of picks via the
score loop, not on any single game.

---

## Mode 1: generate picks (`/nba-predict`)

### Step 0 — confirm there is a real NBA slate to predict (do this FIRST)

The model is **only valid for regular-season and playoff games played by full NBA rosters that
Polymarket prices as a moneyline market.** Before anything else, confirm today qualifies. A single
`WebSearch "NBA schedule <today's date>"` answers it. Stand down (report "no picks" and stop) if:

- **Offseason (roughly late June → late September).** The Finals end in mid-June and the regular
  season tips in late October; in between there are no real games. Report "offseason — no picks"
  and stop. Do **not** fabricate a slate.
- **Summer League (July, Las Vegas/California).** These show up in searches as "NBA games" but are
  played by rookies, two-way, and undrafted players — **not** the rosters the net-rating model is
  built on, and Polymarket generally has no moneyline market for them. The model's inputs are
  meaningless here. **Never build a slate from Summer League games.** Report "Summer League only —
  the model doesn't cover it, no picks" and stop.
- **Preseason exhibitions / All-Star weekend / any event where stars sit by design.** Ratings and
  the market both break down when the result doesn't matter to the teams. Skip.

Only when today has genuine regular-season or playoff games do you proceed to Step 1. This one
check is what stops the system from confidently "predicting" games it has no business touching —
the fastest way to wreck the hit rate is to run the regular-season model on non-regular-season
basketball.

### Step 1 — try the live-API path first

```bash
npm run predict -- --all
```

- **If it prints matched games**, the APIs are reachable. Go to Step 2 (API path).
- **If it fails with `Host not in allowlist` / HTTP 403 / a network egress error**, the
  environment blocks `site.api.espn.com` and/or `gamma-api.polymarket.com`. Do **not** fight the
  proxy. Switch to the **web-research (slate) path** in Step 2b. (You can suggest the user
  allowlist those two hosts in their environment's network settings for the faster path, but the
  slate path works everywhere and needs no allowlisting.)

### Step 2a — API path: research the slate, then finalize

The `--all` output lists every matched game with a model probability and the market price. For
each game that is anywhere near the threshold (say model+market blend ≥ 0.70), **research tonight's
reality** with web search — season ratings can't see today's lineup:

Run `WebSearch` for each relevant game (and read authoritative results):
- **Injuries / lineup:** `"<TEAM> injury report <today's date>"`, `"<STAR PLAYER> playing tonight"`.
  Confirm status: Out / Doubtful / Questionable / Probable / Available.
- **Rest:** is either team on the **second night of a back-to-back**? On a long road trip?
- **Motivation / context:** tanking, load management for stars, must-win, already clinched, a
  team resting starters late in a blowout-prone matchup.

Encode what you find as **point adjustments** in `prediction/data/adjustments.json`, keyed by team
abbr. Scale (points added to that team's expected margin):

| Situation | Adjustment |
|---|---|
| Perennial-All-Star / franchise player ruled **Out** | −4 to −7 |
| Solid starter **Out** | −2 to −4 |
| Key rotation player **Out** | −1 to −2 |
| Multiple starters **Out** | stack them, cap around −10 |
| Second night of a back-to-back | −1.5 to −2.5 |
| Star **returning** from injury (rusty/minutes-capped) | +1 to +3 for their team, but treat as uncertain |

Example `adjustments.json`:
```json
{
  "BOS": { "points": -5, "reason": "Tatum ruled OUT (ankle), confirmed on team report 11/15" },
  "MIL": { "points": -2, "reason": "2nd night of back-to-back, no rest" }
}
```

**Skip, don't guess, on genuine uncertainty.** If a *star* is listed **Questionable** and there's
no confirmed decision, the honest move is to make that game ineligible rather than half-adjust it —
put `{ "points": 0, "reason": "star Questionable, unresolved — game excluded" }` and mention in the
report that you're standing down on it. A wrong guess on a star's status is the #1 cause of misses.

Then produce and save the final picks:
```bash
npm run predict -- --save
```
This re-runs with your adjustments loaded, emits only picks ≥ threshold, and appends them to
`prediction/data/predictions.jsonl` (the system's memory). Report the picks (format below).

### Step 2b — web-research (slate) path: when APIs are blocked

Assemble the slate entirely from web search, then run the identical engine on it. This works in
any environment (WebSearch routes through Anthropic, not the blocked hosts).

1. **Today's schedule** — `WebSearch "NBA schedule today <date>"`. Get every game: home team, away
   team (home/away matters — home court is worth ~2.6 pts).
2. **Team strength** — for each team, find **net rating** (point differential per game) and W-L
   record: `WebSearch "<TEAM> net rating 2025-26 season"` or read an ESPN/Basketball-Reference
   standings result. Net rating is the key input; record is secondary.
3. **Polymarket price** — `WebSearch "Polymarket <away> <home> NBA"` or read the market page to get
   the implied price on each team (0..1). If Polymarket has no market for a game, use a sportsbook
   moneyline and convert to an implied probability (strip the vig by normalizing the two sides to
   sum to 1). **A pick with no market price is not allowed** — the market blend is core to the
   accuracy; skip any game you can't price.
4. **Injuries / rest / motivation** — same research as Step 2a; encode as `adjustments` in the slate.

Write `prediction/data/slate.json` (schema and full field docs in `prediction/src/slate.ts`):
```json
{
  "threshold": 0.78,
  "games": [
    {
      "date": "2026-11-15",
      "home": "Thunder",
      "away": "Wizards",
      "homeNetRating": 9.5,
      "awayNetRating": -8.0,
      "marketHomePrice": 0.90,
      "note": "OKC healthy; WAS on 2nd of back-to-back"
    }
  ],
  "adjustments": { "BOS": { "points": -5, "reason": "Tatum OUT" } }
}
```

Then:
```bash
npm run predict:slate -- prediction/data/slate.json --all     # review everything first
npm run predict:slate -- prediction/data/slate.json --save    # emit + log picks ≥ threshold
```

### Step 3 — report to the user

Keep it short and scannable. For each **PICK**:

```
PICKS for <date>  (threshold 78%)

✅ Oklahoma City Thunder  to beat Washington Wizards      conf 92%
   model 96% / market 90%  ·  OKC healthy, WAS on 2nd of back-to-back

(skipped 5 other games — none cleared 78%; forcing those is what kills accuracy)
```

- Lead with the confident picks only. State confidence, and the one-line reason.
- Explicitly say how many games you skipped and why (below threshold / unresolved star status).
- If **zero** picks clear the bar, say so plainly: "No games clear 78% tonight — no picks. That's
  the correct output, not a failure." Do not backfill.
- Remind the user once: high-confidence picks trade at high prices — this answers *"who wins"*, not
  *"is this price +EV"*. 80% accuracy ≠ automatic profit.

Finally, tell the user to run **`/nba-predict score`** tomorrow after the games finish, and to
commit `prediction/data/*` so the log persists.

---

## Mode 2: score & tune (`/nba-predict score`)

1. Grade pending picks against final scores:
   ```bash
   npm run predict:score
   ```
   This fetches finals (ESPN API path) and writes `prediction/data/review.md` with accuracy, Brier
   score, a calibration table, and every miss. **If the score fetch is network-blocked**, the run no
   longer crashes — it leaves those picks pending, still writes `review.md` from whatever is already
   graded, and lists the pending games under a "Still pending (ungraded)" section. Grade each one by
   hand: get its final via `WebSearch "<away> <home> final score <date>"`, set the `status`
   (`correct`/`incorrect`) and `actualWinner` fields in `prediction/data/predictions.jsonl`, then
   re-run `npm run predict:score` to fold them into the report.

2. **Classify each miss** (read `review.md`, research each loss):
   - **Variance** — pick was sound, right side, favorite just lost. Expected ~1 in 5 at 80%. No action.
   - **Information miss** — there *was* knowable late news (a star sat, a back-to-back) you didn't
     encode. Action: tighten the research checklist; this is the fixable bucket.
   - **Model error** — the model was confidently wrong *and* far from the market. Action: consider
     raising `MARKET_WEIGHT` in `prediction/src/model.ts` (respect the market more).

3. **Propose tuning** from the calibration table (guidance is printed at the bottom of `review.md`):
   - Accuracy < 80% and misses cluster in the 78-85% bucket → raise `--threshold` (e.g. 0.82) and
     record it as the new default in the report.
   - Hit rate consistently *above* stated confidence → you're too strict; the threshold can come
     down and you'll get more picks at the same accuracy.
   - Misses cluster on injury surprises → enforce the "skip unresolved Questionable stars" rule harder.

   Apply small changes (threshold, `MARKET_WEIGHT`, `HOME_COURT_POINTS`, `MARGIN_SIGMA` in
   `prediction/src/model.ts`) only through this loop, one adjustment at a time, and note what you
   changed and why in your reply so the next session has the reasoning.

4. Summarize: accuracy so far, Brier, calibration health, what you changed. Remind the user to
   commit `prediction/data/*`.

---

## Guardrails

- **Never fabricate injury/lineup data.** If web search doesn't confirm a status, treat it as
  unknown and exclude the game rather than guessing.
- **Never lower the threshold just to produce picks** in a generate run. Threshold changes belong
  only to the score-and-tune loop, backed by calibration data.
- **The market is sharp.** When your model disagrees wildly with the Polymarket price and you can't
  explain why with concrete game-day info, trust the market and skip.
- **Reset `adjustments.json` to `{}`** at the start of a fresh generate run so yesterday's
  injuries don't leak into today (the slate path carries adjustments inside the slate file, so this
  applies mainly to the API path).
- Data files in `prediction/data/` are the system's memory — always remind the user to commit them.
