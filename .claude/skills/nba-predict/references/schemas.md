# Input & finals schemas

Both files are consumed by the offline CLI modes. Team references may be NBA team **names**
("Boston Celtics", "Heat") or **abbreviations** ("BOS", "MIA"); the loader resolves either.

## `session-input.json` — for `npm run predict -- --input <file>`

```jsonc
{
  "games": [                         // one entry per game on the slate
    {
      "date": "2026-01-15",          // YYYY-MM-DD, the game's US/Eastern date (required)
      "home": "Boston Celtics",      // home team, name or abbr (required)
      "away": "Miami Heat",          // away team, name or abbr (required)
      "homePrice": 0.80,             // home implied win prob; 0..1 OR cents (80). de-vigged internally
      "awayPrice": 0.20,             // away implied win prob; 0..1 OR cents (20)
      "question": "Celtics vs. Heat",// optional display label
      "slug": "nba-bos-mia-2026-01-15",   // optional; used for the log
      "conditionId": "0x…"           // optional Polymarket condition id; else synthesized for dedup
    }
  ],
  "ratings": {                       // one entry per team playing tonight (required)
    "BOS": { "pointDiff": 6.5, "wins": 30, "losses": 10 },  // season avg point diff/game; W-L optional
    "MIA": { "pointDiff": 0.5 },     // wins/losses optional (used only for winPct display)
    "OKC": { "pointDiff": 9.8 },
    "WAS": { "pointDiff": -8.2 }
  },
  "injuries": [                      // optional; surfaced in the pick rationale
    { "teamAbbr": "MIA", "player": "Jimmy Butler", "status": "Out", "detail": "knee" }
  ]
}
```

Notes:
- `pointDiff` is the model's power rating: **average points scored − allowed, per game** this season
  (i.e. net rating). A +8 team is elite; a −8 team is a bottom-dweller.
- Only `status` values matching `Out` or `Doubtful` are surfaced as injury notes.
- Point adjustments (star out, back-to-back, etc.) go in a **separate** file, `adjustments.json`
  (see below) — not here. Ratings + prices are the raw slate; adjustments are your edits on top.

## `adjustments.json` — game-day point edits (read automatically each run)

```jsonc
{
  "MIA": { "points": -5, "reason": "Butler + Herro Out" },   // negative = weaker
  "DEN": { "points": -2.5, "reason": "2nd night of back-to-back" }
}
```
Empty `{}` when nothing is material. Keyed by team name or abbr.

## `finals.json` — for `npm run predict:score -- --finals <file>`

```jsonc
{
  "finals": [
    { "date": "2026-01-15", "home": "OKC", "away": "WAS", "winner": "OKC" },        // explicit winner, OR…
    { "date": "2026-01-15", "home": "BOS", "away": "MIA", "homeScore": 101, "awayScore": 110 } // …scores
  ]
}
```
Provide either a `winner` (name/abbr) or both scores. A bare array (no `finals` wrapper) also works.
