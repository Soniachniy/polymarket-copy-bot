# Repository guide for Claude

This repo contains two independent systems:

1. **Polymarket copy-trading bot** (`src/`, `ui/`) — watches a target wallet and copies BUY trades.
   See the root `README.md`.
2. **NBA prediction service** (`prediction/`) — calibrated, selective win-probability predictions
   for Polymarket NBA moneyline markets. This is the system most sessions here are about.

## NBA predictions — how to run a session

The turnkey entry point is the **`/nba-predict` skill** (`.claude/skills/nba-predict/SKILL.md`).
When the user asks for NBA picks / "who wins tonight" / to run predictions, invoke that skill — it
defines the full pipeline (pull slate → research injuries/rest via web search → write point
adjustments → emit only high-confidence picks → save log). To grade past picks, the user asks to
"score" / "grade" / "review" and the same skill runs the scoring path.

Design philosophy (do not violate without the user's say-so):
- Target is **80% accuracy on *emitted* picks, not on all games** — achieved by *selectivity*.
  **Emitting zero picks on a low-edge day is correct behavior.** Never force or pad picks.
- Final probability = 35% power-rating model + 65% de-vigged market price. Markets are sharp.
- Web research feeds the model as point adjustments in `prediction/data/adjustments.json`.
- `prediction/data/predictions.jsonl` is the system's memory — **commit `prediction/data/*` after
  every predict and score session.**

CLI (the skill runs these under the hood):
```bash
npm run predict -- --all --json --date YYYY-MM-DD   # inspect slate (model vs market)
npm run predict -- --save --date YYYY-MM-DD          # save picks ≥ threshold to the log
npm run predict:score                                # grade pending picks, write review.md
npm test                                             # offline parser/model tests
```

Tune model constants in `prediction/src/model.ts` only through the score/review loop, never to
overfit a single night.
