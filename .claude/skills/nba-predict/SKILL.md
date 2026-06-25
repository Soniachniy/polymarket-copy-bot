---
name: nba-predict
description: Generate calibrated, selective NBA win predictions for today's Polymarket moneyline markets, or grade and tune past predictions. Use when the user types /nba-predict, asks for NBA picks/predictions for Polymarket, wants to know who will win tonight's NBA games, or asks to score/review previous NBA predictions. Targets ~80% hit rate by only emitting high-confidence picks.
---

# NBA prediction service

You drive a selective, market-anchored predictor for Polymarket NBA moneyline markets.
The numerical engine lives in `prediction/src/` (a ratings model blended with the
de-vigged market price). Your job in the session is the part code cannot do: research
tonight's lineups/rest/motivation and turn them into point adjustments, then run the
engine and report disciplined picks.

**Read this once: how 80% accuracy is actually reached.** No model predicts every NBA
game at 80% — the betting market itself is only ~68–70% accurate on the full slate, and
it is the sharpest public forecast in existence. The honest route to 80% is **selectivity,
not cleverness**: only emit picks whose blended win probability clears the threshold
(default 0.78) and skip everything else. Some nights produce **zero picks** — that is the
correct output, not a failure. Forcing picks on coin-flip games is exactly what destroys
the hit rate. 80% *accuracy* is also not the same as *profit*: high-confidence picks trade
at high prices. This service answers "who will win", not "is this price +EV".

## Two modes

- `/nba-predict` (default) → **generate today's picks** (the PREDICT workflow below).
- `/nba-predict score` → **grade past picks and tune** (the SCORE workflow below).
- `/nba-predict <YYYY-MM-DD>` → predict for a specific date instead of today.

Detect the mode from the user's args. If they just say "predictions" or "picks", run PREDICT.

## One-time setup check

If `npm run predict -- --all` fails with `Host not in allowlist` / HTTP 403, the
environment's network egress policy is blocking the data sources. Tell the user to add
these two hosts to their environment's network egress settings, then stop:
`gamma-api.polymarket.com` and `site.api.espn.com`. The engine cannot run without them.
Run `npm install` first if `tsx`/`vitest` are missing.

---

## PREDICT workflow

Do these steps in order. Do not skip the research step — it is where the edge comes from.

### 1. Reset stale adjustments

Yesterday's injuries must not leak into today. Overwrite the adjustments file with an
empty object before researching:

Write `prediction/data/adjustments.json` with exactly: `{}`

### 2. Pull the slate (engine, no picks yet)

```bash
npm run predict -- --all --json
```

(Add `-- --all --json --date YYYY-MM-DD` for a specific date.) This prints every matched
game with the model probability, the de-vigged market price, and the blended probability.
Read it. If **0 games matched**, there are no NBA markets/games for that date (e.g.
offseason). Report "No NBA slate for <date>." and stop — this is normal.

Note the games where the blend is already near or above 0.70; those are your pick
candidates and deserve the most research. A game the market has at ~50/50 will almost
never clear threshold no matter what you find, so spend research budget on the lopsided
and the near-threshold games.

### 3. Research tonight's information (the edge)

The ratings model uses season-long point differential — it is blind to tonight's lineup.
For **each matched game** (prioritise candidates from step 2), use web search to find what
changed. Search queries that work:

- `"<Team> injury report <today's date>"`
- `"<Team> vs <Team> starting lineup tonight"`
- `"<Star player> playing tonight"` (when status is unclear)
- `"<Team> back to back" / "<Team> on second night"`

For each game establish:
1. **Out / Doubtful players** — who, and how important (star, starter, rotation, bench).
2. **Questionable stars with unresolved status** — flag these; see the skip rule below.
3. **Rest situation** — is either team on a back-to-back / 2nd night / long road trip?
4. **Motivation** — tanking, resting starters for playoffs, must-win, etc.

The engine already pulls ESPN's injuries feed, but it lags. Your web search is the
tiebreaker and catches late scratches the feed misses.

### 4. Encode findings as point adjustments

Write `prediction/data/adjustments.json` as a map of team abbr → `{points, reason}`.
`points` is added to that team's expected margin (negative = weaker). Use the abbrs in
`prediction/src/teams.ts` (e.g. `LAL`, `BOS`, `GSW`, `NOP`).

**Adjustment magnitude guide** (points off a team's margin):

| Situation | Points |
|---|---|
| MVP-tier star OUT (e.g. Jokić, Giannis, SGA, Luka) | −6 to −9 |
| All-Star / primary option OUT | −4 to −6 |
| Quality starter OUT | −2 to −3.5 |
| Rotation / role player OUT | −0.5 to −1.5 |
| Multiple starters OUT (stack them, then cap total ≈ −12) | sum, capped |
| Back-to-back / 2nd night of road trip | −1.5 to −2.5 |
| Star RETURNS from injury (market may lag) | +1 to +3 |
| Resting starters (tank / playoff seeding locked) | −5 to −10 |

Example:
```json
{
  "LAL": { "points": -6, "reason": "Luka OUT (calf), confirmed on team report" },
  "MEM": { "points": -2, "reason": "back-to-back, 2nd night" }
}
```

**Hard discipline rules — these protect the hit rate:**
- **Unresolved Questionable star → do NOT adjust, plan to SKIP the game.** If a star is
  Questionable and there's no confirmed in/out by the time you run, the outcome is a coin
  flip on lineup news. Note it; in step 6 drop that game even if it clears threshold.
- Don't double-count: if the market already moved hard on an injury (price implies a blowout
  the season model doesn't), a smaller adjustment avoids stacking the same news twice.
- Keep `reason` specific and sourced ("per team injury report" / "per beat writer X") so the
  score-review step can audit misses.

### 5. Generate and save picks

```bash
npm run predict -- --save
```

This applies the 0.78 threshold, prints PICKS, and appends them to
`prediction/data/predictions.jsonl` (it won't double-log a market already in the file).
To experiment without saving, drop `--save`; to change selectivity use `-- --threshold 0.82`.

### 6. Report to the user

Present, in this format:

- **PICKS** (each): `Team to win — confidence XX% (model XX% / market XX%, edge +X.Xpp)`,
  one line of rationale including any injury/rest note. Sort by confidence, highest first.
- **Skipped on discipline**: any game you dropped due to an unresolved Questionable star —
  name it and why. This is a feature; show it.
- **Below threshold**: a one-line count ("4 other matched games were coin-flips, no pick").
- Close with the honest reminder: a stated 80% pick is *expected* to lose ~1 in 5; track
  results and run `/nba-predict score` after games finish.

Then remind the user to commit `prediction/data/` so the log (the system's memory) persists.

---

## SCORE workflow (`/nba-predict score`)

Run after games have finished (typically next morning).

### 1. Grade

```bash
npm run predict:score
```

This fetches ESPN finals for every pending pick's date, marks each `correct`/`incorrect`,
recomputes accuracy + Brier + per-bucket calibration, and writes
`prediction/data/review.md`. Read it.

### 2. Classify every miss

For each incorrect pick in `review.md`, decide which kind of miss it was — this is the
learning loop:

- **Variance** — pick was sound, the 1-in-5 just hit. A correctly-calibrated 80% system
  *must* have these. No action; do not over-fit to noise.
- **Information miss** — there WAS knowable game-day news (late scratch, rest) the
  adjustments didn't capture. Action: tighten the research checklist for that situation
  (e.g. always confirm star status within an hour of tip).
- **Model error** — model probability was far above the market on the loss (overconfident
  ratings). Action: if this recurs, lower `MARKET_WEIGHT` in `prediction/src/model.ts`
  (trust the market more) or raise the threshold.

### 3. Tune (only on a real signal, never on one game)

Use the calibration table in `review.md`:
- Hit rate in the 78–85% bucket persistently **below** stated confidence → raise threshold
  (e.g. 0.80 → 0.82) so only stronger picks survive.
- Hit rate consistently **above** stated confidence → you're leaving picks on the table;
  threshold can come down slightly.
- Misses cluster on injury surprises → enforce the "skip unresolved Questionable star" rule
  harder.
- Model vs market disagreed badly on misses → lower `MARKET_WEIGHT`.

Make at most one tuning change per review, summarise it for the user with the evidence, and
remind them to commit `prediction/data/` + any `model.ts` change.

---

## Files you touch

- `prediction/data/adjustments.json` — you rewrite this every PREDICT run (reset, then fill).
- `prediction/data/predictions.jsonl` — append-only log; the engine writes it, you commit it.
- `prediction/data/review.md` — the engine writes it in SCORE mode; you read + act on it.
- `prediction/src/model.ts` — only edit constants here, and only via the SCORE loop.

Never edit `predictions.jsonl` by hand — it is the audit trail that proves the hit rate.
