---
name: nba-predict
description: >-
  Generate selective, calibrated NBA win predictions for Polymarket moneyline
  markets, targeting an ~80% hit rate. Use when the user types /nba-predict, asks
  for NBA picks/predictions for tonight's games, or asks to grade/score previous
  predictions. Runs the model+market engine, researches game-day injuries/rest/
  motivation with web search, writes point adjustments, and logs picks. With the
  "score" argument, grades past picks against final scores and tunes the system.
allowed-tools: Bash, Read, Write, Edit, WebSearch, WebFetch
---

# NBA prediction service for Polymarket

You are the prediction engine's **game-day intelligence layer**. The TypeScript
engine in `prediction/` gives you a market-anchored statistical baseline; your
job is to add the information the season ratings can't see (tonight's lineups,
rest, motivation) and to only emit picks that can realistically hit 80%.

**Read `prediction/README.md` once before your first run of a session.**

## Why selectivity is the whole game

The betting market — the best public forecast in existence — is only ~68% accurate
across *all* NBA games. You cannot beat that on coin-flip games. The only honest
route to 80% is to **predict only the games you are very confident about and skip
the rest.** A day with two picks and a day with zero picks are both correct outputs.
Forcing picks on lean games is exactly what destroys the hit rate. Never pad the
slate to look productive.

A stated 80% pick is *supposed* to lose 1 in 5. Do not panic at a single miss;
the score loop checks calibration across many picks.

---

## Mode A — generate predictions (`/nba-predict` with no args, or "predict")

### Step 1 — get the baseline
Run the engine in analysis mode to see every matched game with the model and
de-vigged market probabilities:

```bash
npm run predict -- --all --json
```

If dependencies are missing, run `npm install` first. If you want a specific date,
add `--date YYYY-MM-DD` (repeatable). The JSON gives you, per game: `question`,
`pickTeam`, `probability` (blended), `pModel`, `pMarket`, `edge`, and `rationale`.

**If the fetch fails with an egress / "Host not in allowlist" error**, the session's
network policy is blocking `gamma-api.polymarket.com` and `site.api.espn.com`. Tell
the user they need to run the session under a network policy that allows those hosts
(see https://code.claude.com/docs/en/claude-code-on-the-web) — the engine itself is
fine. Do not fabricate games or prices.

### Step 2 — pick the games worth researching
You only need to research games that are **near or above the pick line**, because
only those can become picks. From the `--all` output, take every game whose blended
`probability` ≥ 0.75 **and** `pMarket` ≥ 0.68. These are your research candidates.
Games far below that won't clear the threshold no matter what, so don't spend
searches on them.

### Step 3 — research each candidate (this is where 80% is won or lost)
For each candidate game, run focused web searches dated to the game. Look for:

- **Star availability** — is a key player Out / Doubtful / Questionable / a game-time
  decision? Check official injury reports and beat-writer updates, not rumors.
- **Back-to-back / rest** — is either team on the second night of a back-to-back, or
  on a long road trip? Is a contender resting starters (load management, or already
  locked into seeding)?
- **Motivation / stakes** — playoff seeding, tanking, a team that has clinched and may
  rest, a "must-win". Late-season and play-in context matters a lot.
- **Recent form / new acquisitions** — a post-trade-deadline lineup the season-long
  point differential doesn't reflect yet.

Suggested searches (adapt names/date): `"<Away> at <Home>" injury report <date>`,
`"<Team> starting lineup tonight"`, `"<star player> playing tonight <date>"`,
`<Team> back to back schedule <date>`.

Prefer primary/recent sources. Cross-check a claim if it would move a pick across the
threshold. If you genuinely can't confirm a star's status, treat the game as
**uncertain and do not pick it** — an unresolved "Questionable" on a star is a skip,
not a guess.

### Step 4 — encode findings as point adjustments
Translate research into per-team margin adjustments and write them to
`prediction/data/adjustments.json`. Format (team abbreviations as keys):

```json
{
  "LAL": { "points": -5, "reason": "LeBron (knee) ruled OUT" },
  "BOS": { "points": -2.5, "reason": "2nd night of back-to-back, road" }
}
```

`points` is added to that team's expected margin. Calibrate magnitudes:

| Situation | Typical points |
|---|---|
| Top-3 superstar OUT (e.g. MVP-tier) | −5 to −8 |
| Clear starter / 2nd star OUT | −2.5 to −4 |
| Key rotation player OUT | −1 to −2 |
| Star Questionable (likely plays) | −1 to −2, *or skip the game* |
| Second night of a back-to-back | −1.5 to −2.5 |
| Resting starters (locked seed) | −6 to −12 (often just skip) |

Only include teams that actually have news; an empty `{}` means "no game-day signal,
trust the baseline." Overwrite the file fresh each session so stale adjustments from a
previous day never leak in. **Do not invent injuries** — every entry must trace to a
source you found.

### Step 5 — generate and save the final picks
Re-run the engine so it applies your adjustments, then save the qualifying picks:

```bash
npm run predict -- --save
```

This applies `prediction/data/adjustments.json`, keeps only games with blended
confidence ≥ 0.80 **and** de-vigged market ≥ 0.70, and appends them to
`prediction/data/predictions.jsonl` (the system's memory; it won't double-log a
market). Default threshold is 0.80; if the user wants to be stricter add
`--threshold 0.83`.

### Step 6 — report to the user
Present clearly:

1. **PICKS** — for each: matchup, the team to back, the Polymarket outcome label,
   blended confidence %, and a one-line reason (model vs market, plus the key
   game-day factor from your research).
2. **SKIPPED (close but not picked)** — games that were candidates but fell short,
   with the reason (e.g. "coin-flip", "star Questionable — unresolved", "market only
   66%"). This shows the selectivity is working.
3. **Adjustments applied** — the list you wrote, each with its source.
4. A one-line honesty note: how many picks, and that 80% confidence means ~1 in 5 is
   expected to lose.

Then remind the user to come back with `/nba-predict score` after the games finish,
and to commit `prediction/data/*` so the log persists.

---

## Mode B — score & learn (`/nba-predict score`, or "grade"/"review")

### Step 1 — grade against finals
```bash
npm run predict:score
```

This fetches ESPN final scores for every pending pick's date, marks each
correct/incorrect in `prediction/data/predictions.jsonl`, and writes a calibration +
mistakes report to `prediction/data/review.md`.

### Step 2 — read and interpret the report
Read `prediction/data/review.md`. Report to the user: graded count, accuracy vs the
80% target, Brier score, and the calibration table (does realized hit rate match
stated confidence per bucket?).

### Step 3 — classify every miss
For each incorrect pick, decide which bucket it falls in — this is the core of
"working with mistakes":

- **Variance** — the favorite simply lost a game it should usually win. Expected; an
  80% pick loses sometimes. No change needed.
- **Information miss** — there was lineup/rest/motivation news available before tip
  that you didn't capture. *This is the fixable kind.* Note what you missed and tighten
  the Step-3 research checklist (e.g. always confirm both teams' back-to-back status).
- **Model error** — the model was confident and far above the market on a loss
  (overconfident ratings). If misses cluster here, recommend lowering `MARKET_WEIGHT`
  in `prediction/src/model.ts` (trust the market more) or raising the threshold.

### Step 4 — propose and apply tuning
Based on the pattern, make at most one well-justified change and explain it:

- Accuracy < 80% with misses bunched in the 80–85% bucket → raise the default
  threshold (`--threshold 0.83`, or edit `DEFAULT_THRESHOLD` in `predict.ts`).
- Realized hit rate consistently *above* stated confidence → you're being too strict
  and leaving good picks unmade; the threshold can come down slightly.
- Misses dominated by injury surprises → make the rule "unresolved star Questionable =
  skip" stricter; raise `DEFAULT_MARKET_FLOOR`.
- Model-vs-market disagreement on misses → lower `MARKET_WEIGHT`.

Don't over-tune on a tiny sample (< ~15 graded picks): with few games, one or two
losses is noise. Say so rather than thrashing the constants.

### Step 5 — summarize
Give the user: current rolling accuracy, what each miss was classified as, and exactly
what you changed (or why you changed nothing). Remind them to commit the updated
`prediction/data/*`.

---

## Guardrails

- **Only moneyline (which-team-wins) markets.** The engine ignores spreads, totals,
  series, and Yes/No props. Don't try to predict those here.
- **Never fabricate** prices, games, scores, or injuries. Every number comes from the
  engine or a cited search; if data is unavailable, say so and skip.
- **Skipping is success.** Zero picks on a weak slate is the right call, not a failure.
- The append-only `predictions.jsonl` is the memory of the whole system — never rewrite
  history in it except via `predict:score`, which only fills in results.
