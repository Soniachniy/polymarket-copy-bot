---
name: nba-predict
description: Generate calibrated, selective NBA moneyline predictions for Polymarket game markets, and score prior picks against final results. Use when the user types /nba-predict, asks for today's NBA picks, asks which NBA games to bet on Polymarket, or asks to grade/score previous NBA predictions.
---

# NBA prediction service for Polymarket

You are the prediction engine. When invoked you run one of two modes:

- **predict** (default): produce today's picks.
- **score**: grade previously logged picks against final scores and update the model.

The deterministic math lives in `prediction/src/`. Your job is to feed it good, current
inputs and enforce the discipline rules below. **Never invent numbers** — every point
differential, market price, and injury must come from a real source you fetched this session.

## The one rule that produces 80% accuracy: be selective

The betting market is only ~68-70% accurate across *all* NBA games and it is the sharpest
public forecast that exists. You do not beat it on every game. You reach 80% by **only
emitting picks whose blended win probability clears the 0.78 threshold and skipping
everything else.** Some slates produce zero picks. That is the correct, winning behavior —
forcing a pick on a coin-flip game is exactly what destroys the hit rate. Do not lower the
threshold to manufacture picks.

Two hard skips, regardless of probability:
1. **Unresolved star availability.** If a team's star is listed *Questionable/Game-Time
   Decision* and the game hinges on them, SKIP the game — do not guess with an adjustment.
   Adjustments are only for *confirmed* Out/available news.
2. **Stale price.** If you cannot confirm a current Polymarket price for the game, skip it.

## Step 1 — Get today's slate and the market

Try the fast path first; fall back to in-session research if the hosts are blocked.

### Fast path (direct APIs — only works if the runtime allows egress to these hosts)

```bash
npm run predict -- --all          # today; add --date YYYY-MM-DD for another day
```

If this prints picks/rows, the APIs are reachable. This already pulled Polymarket prices,
ESPN schedule, standings (point differentials), and listed injuries. Go to Step 2 to layer
in game-day research, then re-run with adjustments.

If it fails with `Host not in allowlist` / HTTP 403 / a network error, the direct APIs are
blocked in this environment. Use the research path below. (To enable the fast path
permanently, the user must add `gamma-api.polymarket.com` and `site.api.espn.com` to their
environment's network egress allowlist — tell them this once.)

### Research path (works anywhere — you gather the data)

For the target date, gather for **each** game on the slate:

1. **The matchup and home/away.** `WebFetch` ESPN's scoreboard, or `WebSearch "NBA schedule <date>"`.
   Home court matters (worth +2.6 pts in the model) so get home/away right.
2. **Each team's average point differential per game** (net rating proxy). Source: ESPN
   standings, Basketball-Reference, or a search like
   `WebSearch "NBA point differential per game standings 2026"`. Use season-to-date average
   margin (points for minus points against, per game), e.g. `+6.1`, `-3.4`.
3. **The current Polymarket price** for each side. `WebFetch https://polymarket.com/sports/nba/games`
   or the specific event page, or search `WebSearch "Polymarket <team> vs <team> odds"`.
   Record both outcome prices (they include vig; the model de-vigs them).
4. **Game-day availability** (this is the edge the season ratings can't see):
   - `WebSearch "<team> injury report <date>"` and `WebSearch "NBA starting lineups <date>"`.
   - Note anyone **confirmed Out** and whether it's a star (translate to a point adjustment,
     see the scale below). Note **back-to-backs / rest** — a team on the second night of a
     back-to-back is worth roughly **-2 to -3** points.
   - If a star is merely *Questionable*, apply the hard skip — do not adjust.

Write the slate to a JSON file (see schema in `prediction/src/compute.ts`) and run the
identical model math offline:

```bash
npm run predict:compute -- --input <slate.json> --all
```

Example `slate.json`:

```json
{
  "date": "2026-04-15",
  "games": [
    { "question": "Wizards @ Thunder", "home": "OKC", "away": "WAS",
      "homeDiff": 9.1, "awayDiff": -8.2, "marketHome": 0.93, "marketAway": 0.07 },
    { "question": "Celtics @ Heat", "home": "MIA", "away": "BOS",
      "homeDiff": 1.5, "awayDiff": 6.0, "marketHome": 0.42, "marketAway": 0.58,
      "adjAway": -4, "adjAwayReason": "Tatum confirmed out",
      "note": "BOS 2nd night of back-to-back" }
  ]
}
```

## Step 2 — Point-adjustment scale (only for CONFIRMED news)

| Situation | Adjustment to that team |
|---|---|
| Confirmed superstar (MVP-tier) OUT | **-6 to -8** |
| Confirmed All-Star / primary scorer OUT | **-4 to -6** |
| Confirmed solid starter OUT | **-2 to -3** |
| Key rotation player OUT | **-1** |
| 2nd night of a back-to-back | **-2 to -3** |
| Returning from injury, minutes limit | **-1 to -2** |

Adjustments are cumulative. Put them in `adjHome`/`adjAway` (fast path: write
`prediction/data/adjustments.json` keyed by team abbr, then re-run `npm run predict`).

## Step 3 — Emit and log picks

- Present the picks the CLI marks `[PICK]` (≥ 0.78 blended). For each: team, confidence,
  model vs market split, and the one-line rationale.
- Explicitly list the games you **skipped** and why (below threshold / questionable star /
  no price). The skips are part of the deliverable — they show discipline.
- Save the picks so they can be graded later:
  - Fast path: `npm run predict -- --save`
  - Research path: `npm run predict:compute -- --input <slate.json> --save`
- **Commit `prediction/data/*` after saving.** The JSONL log is the system's memory across
  sessions; without the commit the calibration loop has nothing to learn from.

## Step 4 (score mode) — grade and improve

When invoked as `/nba-predict score` (or the user asks to grade prior picks):

```bash
npm run predict:score        # fast path: fetches ESPN finals, grades pending picks
```

If ESPN is blocked, get final scores via `WebSearch "NBA scores <date>"` / `WebFetch`, then
update each pending row's `status` (`correct`/`incorrect`) and `actualWinner` in
`prediction/data/predictions.jsonl` yourself and regenerate the summary.

Then read `prediction/data/review.md` and act on it:

- Report accuracy vs the 80% target and the Brier score.
- For every miss, classify it: **variance** (an 80% pick is *supposed* to lose 1 in 5 — no
  action), **information miss** (late lineup news you didn't catch — tighten Step 1 research),
  or **model error** (model disagreed hard with the market and was wrong — consider lowering
  the model weight).
- Apply at most one tuning change and say why:
  - Accuracy < 80% with misses clustered in the 0.78-0.85 bucket → raise the threshold
    (`--threshold 0.82`).
  - Per-bucket hit rate consistently *above* stated confidence → you're too selective; the
    threshold can come down.
  - Model repeatedly overconfident vs market on misses → lower `MARKET_WEIGHT` blend toward
    the market in `prediction/src/model.ts` (currently 0.65).
- Commit the updated log and review.

## The model (for context; tune only via Step 4)

`P(home) = Φ((homeDiff − awayDiff + 2.6 home-court + adjustments) / 11.5)`, then blended
**65% market / 35% model** because prediction markets are sharp. Constants in
`prediction/src/model.ts`. Both `predict` (live API) and `predict:compute` (research path)
run this identical math via `prediction/src/core.ts`.

## Honesty note to relay when relevant

80% *accuracy* is a "who wins" claim, not a profit claim — high-confidence picks trade at
high prices, so winning 80% of them is not automatically +EV. This service answers "who will
win," which is what the user asked for. Say so if the user starts treating hit rate as ROI.
```
