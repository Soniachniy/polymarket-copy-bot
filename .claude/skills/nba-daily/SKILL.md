---
name: nba-daily
description: >-
  The everyday entry point for the NBA prediction service. Run this once per day (from a
  scheduled/triggered session). It FIRST reconciles open pull requests — merging the standing
  work and closing duplicates so PRs don't pile up — then syncs main and produces today's picks
  via /nba-predict. Use when the user runs /nba-daily, sets up the daily automated run, or asks
  to "check existing PRs and merge them" before predicting.
---

# NBA daily driver

This is the **daily automation entry point**. Previous automated sessions each opened a *new*
branch and a *new* "Add /nba-predict skill" PR without ever looking at the ones already open, so
duplicate PRs piled up (19 of them, all doing the same thing). This skill exists to stop that.

**The rule: reconcile before you build.** Every run, first bring `main` up to date by merging the
standing PR and closing duplicates. Only then do prediction work — and reuse the standing branch
instead of opening a new PR.

---

## Step 0 — reconcile open PRs (do this FIRST, every run)

Use the GitHub MCP tools (`mcp__github__*`). The repo is `Soniachniy/polymarket-copy-bot`.

1. **List open PRs.** `list_pull_requests` (state `open`). Group them:
   - **The prediction-system PRs** — titles like "Add /nba-predict skill…", branches
     `claude/pensive-dijkstra-*` / `claude/dreamy-ptolemy-*`. These are duplicates of the same work.
   - Anything else (a genuinely different change) — leave it alone; it's out of scope for this skill.

2. **If the work is already on `main`** (the `/nba-predict` skill exists at
   `.claude/skills/nba-predict/SKILL.md` on `main` and tests pass), then every open
   prediction-system PR is redundant. **Close them all** with a short comment:
   > Superseded — the NBA prediction service is already on `main`. Closing as duplicate. Future
   > daily runs reconcile open PRs before creating new ones (see `/nba-daily`).

3. **If the work is NOT yet on `main`** (first-time consolidation):
   - Pick the **most complete** prediction-system PR as canonical. Prefer one that (a) has passing
     tests, (b) includes the offline / web-research fallback path, and (c) fixes `.gitignore` so
     the skill file is actually tracked (the `*.md` ignore rule silently drops `SKILL.md`
     otherwise — verify with `git check-ignore .claude/skills/nba-predict/SKILL.md`).
   - **Verify it** before merging: check out the branch, run `npm ci` (or `npm install`),
     `npm test`, and `npx tsc --noEmit`. Do not merge red code into `main`.
   - **Merge it** (`merge_pull_request`, squash is fine).
   - **Close every other** prediction-system PR with the superseded comment above.

4. **Never leave more than one open prediction-system PR.** If two look equally complete, merge one
   and close the other; note in the closing comment which ideas (if any) should be ported as a
   follow-up so nothing valuable is lost.

5. **Sync local `main`:** `git fetch origin main && git checkout main && git pull` so the rest of
   the run builds on the merged result.

> Do not merge a PR that touches trading/credentials/secrets, or one whose CI is failing, or one
> from an author other than the automated sessions, without checking with the user first. When in
> doubt about closing something that isn't an obvious duplicate, ask rather than close.

---

## Step 1 — reuse the standing branch (don't spawn a new duplicate)

If this session was started on a fresh auto-named branch and you need to commit code changes,
**prefer updating the single standing PR** over opening another one:

- If an open prediction-system PR still exists after Step 0 (because you intentionally kept one),
  push your changes to *its* branch and let that PR update — do not open a new PR.
- If you only produced **prediction data** (the daily picks log, not code), you don't need a PR at
  all — commit `prediction/data/` to `main` directly (or to the standing branch) and push.
- Open a **new** PR only when you have a genuinely new *code* change and there is no standing PR to
  extend. One open PR at a time for this system — that is the whole point of this skill.

---

## Step 2 — produce today's picks

Run the prediction workflow:

```
/nba-predict
```

(That skill handles the live-API path, the web-research fallback, game-day adjustments, and the
selectivity discipline. See `.claude/skills/nba-predict/SKILL.md`.) In the NBA offseason
(July–September) there are no game markets — report that and stop; don't fabricate a slate.

Then persist the log (the system's memory):

```bash
git add prediction/data/ && git commit -m "nba: picks for <date>" && git push
```

---

## Step 3 — report

Give the user a short summary: how many duplicate PRs you closed / what you merged, whether `main`
is now current, and today's PICKS (or "no picks / offseason"). Keep it scannable.

---

## The trigger prompt (set this as your daily scheduled prompt)

Configure your daily Claude Code trigger to send exactly this, instead of a generic "build the
prediction service" prompt (which is what caused the duplicate-PR pileup):

```
Run /nba-daily. First reconcile open pull requests — merge the standing NBA-prediction PR into
main and close any duplicate open PRs, so PRs don't pile up. Then sync main and generate today's
NBA picks. Reuse the existing branch/PR for any code changes; only open a new PR if there is a
genuinely new code change and no standing PR to extend. Commit the picks log.
```

Key differences from the old prompt that stop the pileup:
- **Reconcile-first**: check and merge/close existing PRs before doing anything else.
- **Reuse, don't recreate**: update the standing branch/PR rather than spawning a new one.
- **Data ≠ PR**: daily picks are just a data commit, not a reason to open a PR.
