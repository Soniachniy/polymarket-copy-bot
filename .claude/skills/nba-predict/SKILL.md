---
name: nba-predict
description: >
  Run the NBA Polymarket prediction session. Default mode researches today's slate and
  produces high-confidence picks; "score" mode grades past picks and works the mistakes.
  Use when the user asks for NBA predictions, picks, or to grade/review/score predictions.
argument-hint: "[score]"
---

# NBA prediction session

You are running the daily prediction workflow for `prediction/` (see `prediction/README.md`
for the design). Two modes:

- **No argument (or anything that isn't `score`)** → PREDICT mode.
- **Argument `score`** (or the user asks to grade/review/check results) → SCORE mode.

Hard rules that apply in both modes — these are what make the 80% target reachable:

1. **Never force a pick.** Zero picks on a given day is a valid, common, correct output.
   The threshold exists to refuse coin-flip games.
2. **Never edit model constants (`prediction/src/model.ts`) in PREDICT mode.** Constants
   are only tuned in SCORE mode, with evidence from `review.md`, one change at a time.
3. **The JSONL log is append-only memory.** Never delete or rewrite rows in
   `prediction/data/predictions.jsonl` by hand; only `predict:score` updates statuses.
4. **Commit `prediction/data/*` at the end of every session** so the next session sees it.

## Network prerequisites (check first)

The CLI needs egress to `gamma-api.polymarket.com`, `site.api.espn.com`, and `cdn.espn.com`.
If the first fetch returns 403 "Host not in allowlist", stop and tell the user to add those
hosts to the environment's network egress settings (Claude Code on the web → environment →
network policy) or run from a machine with open egress. Do not try to work around the block.

---

## PREDICT mode

### 1. See the slate

```bash
npm run predict -- --all
```

This prints every matched game (PICK and pass), each with model probability, de-vigged
market probability, blended confidence, and any listed Out/Doubtful players from ESPN's
injury feed. Note which games are near the threshold (within ~5pp either side) — those are
the ones game-day research can flip, so spend the research budget there.

### 2. Research the slate (web search)

For every matched game — most thoroughly for near-threshold ones — search for today's news:

- **Injuries/lineups**: search `"<team> injury report today"` and `"<star player> status"`.
  ESPN's feed lags; beat writers and official injury reports are fresher.
- **Rest**: is either team on the second night of a back-to-back? (Check yesterday's slate
  with `npm run predict -- --all --date <yesterday>` or search.) Road B2B is worth ~-2 pts.
- **Motivation/rotation**: late-season tanking, seeding locked, stars rested in playoffs-
  irrelevant games, blowout-risk scheduling. In June (Finals/playoffs) check series state.

Convert findings into **point adjustments** on the expected margin:

| Finding | Points |
|---|---|
| Superstar (top-5 usage, All-NBA) out | -4 to -6 |
| All-Star / clear #1 option out | -3 to -4 |
| Quality starter out | -1.5 to -2.5 |
| Two+ rotation players out | -1 to -2 extra |
| Second night of road back-to-back | -1.5 to -2.5 |
| Tanking / nothing to play for vs motivated opponent | -2 to -4 |

### 3. Encode adjustments

Write `prediction/data/adjustments.json`, keyed by team abbreviation:

```json
{
  "LAL": { "points": -4.5, "reason": "LeBron (out, ankle) per Shams 2h ago" },
  "BOS": { "points": -2, "reason": "road B2B, played OT last night" }
}
```

Start from `{}` each session — stale adjustments from a previous day must not leak in.
Every entry needs a `reason` with the source; that string ends up in the pick's rationale
and is what SCORE mode audits later.

**The Questionable rule**: if a star is listed Questionable/Game-Time-Decision and the game
would otherwise be a PICK, do not guess. Apply the full "out" adjustment with reason
`"unresolved GTD — conservative"` so the game drops below threshold. Picks made on
unresolved star availability are the #1 historical source of misses.

### 4. Generate and save picks

```bash
npm run predict -- --all      # confirm adjustments landed (look for "adj:" in rationales)
npm run predict -- --save     # appends picks above threshold to the JSONL log
```

If a previous review session changed the working threshold, pass it explicitly:
`npm run predict -- --save --threshold 0.82`. The current working threshold, if it differs
from the default 0.78, is recorded at the top of `prediction/data/review.md`.

### 5. Report

Give the user, in this order:

1. **PICKS** — one line each: matchup, pick, confidence %, one-sentence rationale.
2. **Skipped games** — matchup + why (below threshold / GTD rule / no market match).
3. A reminder of the standing instruction: after the games finish, run `/nba-predict score`.

Then commit `prediction/data/adjustments.json` and `prediction/data/predictions.jsonl`
with message like `predictions for <date>: N picks, M skipped`.

---

## SCORE mode

### 1. Grade

```bash
npm run predict:score
```

This fetches finals from ESPN, updates statuses in the JSONL log in place, and writes
`prediction/data/review.md` with accuracy, Brier score, calibration buckets, and a
"Mistakes to review" section. Read `prediction/data/review.md`.

### 2. Work each mistake

For every incorrect pick, web-search the game (`"<away> at <home> <date> recap"`,
`"<team> injury report <date>"`) and classify the miss:

- **Variance** — pick was sound, information was complete, favorite lost anyway.
  An 80%-confidence pick *should* lose 1 in 5. No action; do not tune on variance.
- **Information miss** — news existed before tip-off (late scratch, rest decision) that the
  adjustments didn't encode. Action: improve step-2 research habits; note the missed source
  in the review.
- **Model error** — `pModel` was far from `pMarket` (edge > ~8pp) with no information
  justification, and the market was right. Action: candidate for tuning.

Append your classification of each miss to `prediction/data/review.md` under a
`## Session analysis` heading.

### 3. Tune (at most one change per session)

Use the calibration table, not single games:

- Bucket hit rates **below** stated confidence and most misses in the 70–85% bucket →
  raise the working threshold by 0.02–0.04 and record it at the top of `review.md`.
- Bucket hit rates consistently **above** stated confidence over 20+ graded picks →
  lower the threshold; you are leaving correct picks unmade.
- Repeated *model error* misses → lower `MARKET_WEIGHT`'s complement, i.e. increase market
  weight in `prediction/src/model.ts`, by at most 0.05, and say so in the commit message.
- Repeated *information misses* of the same type → add the pattern to the research
  checklist in step 2 of PREDICT mode (edit this SKILL.md).

Fewer than ~15 graded picks → report results but make **no** tuning change; the sample
cannot distinguish variance from miscalibration.

### 4. Report and commit

Tell the user: record to date (X/Y, accuracy vs the 80% target), Brier score, each miss
with its classification, and what (if anything) was tuned and why. Commit
`prediction/data/*` (and any tuning edits) with message like
`score review <date>: X/Y correct, <tuning summary>`.
