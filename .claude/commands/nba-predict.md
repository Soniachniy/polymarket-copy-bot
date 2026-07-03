---
description: Generate calibrated NBA moneyline picks for Polymarket (or `score` to grade past picks)
argument-hint: "[score]"
---

Run the NBA prediction service. Follow the instructions in
`.claude/skills/nba-predict/SKILL.md` exactly.

Arguments: `$ARGUMENTS`
- empty → GENERATE mode: produce today's picks (or a `--date`), save, and report PICKS + skipped games.
- `score` → SCORE mode: grade pending picks against finals, write the review, classify misses, tune.

Always prefer the live CLI (`npm run predict -- --save`); if the endpoints are blocked by network
egress, fall back to gathering the slate via WebSearch/WebFetch and running the `--input` /
`--finals` offline modes, as the skill describes. Be selective — only ship picks above threshold.
