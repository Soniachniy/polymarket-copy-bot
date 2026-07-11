import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchScoreboard } from './espn.js';
import type { GameInfo, Prediction } from './types.js';

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const LOG_FILE = join(DATA_DIR, 'predictions.jsonl');
const REVIEW_FILE = join(DATA_DIR, 'review.md');

function loadLog(): Prediction[] {
  if (!existsSync(LOG_FILE)) {
    console.error(`No prediction log at ${LOG_FILE}. Run "npm run predict -- --save" first.`);
    process.exit(1);
  }
  return readFileSync(LOG_FILE, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Prediction);
}

export function winnerOf(g: GameInfo): string | null {
  if (!g.completed || g.homeScore === undefined || g.awayScore === undefined) return null;
  if (g.homeScore === g.awayScore) return null;
  return g.homeScore > g.awayScore ? g.homeAbbr : g.awayAbbr;
}

/**
 * Grade still-pending picks against fetched finals, mutating status/actualWinner in place.
 * Picks already graded by hand (status set in the JSONL, per the offline fallback) are left
 * untouched. Dates with no fetched results simply stay pending. Returns how many were newly graded.
 */
export function gradePending(log: Prediction[], resultsByDate: Map<string, GameInfo[]>): number {
  let graded = 0;
  for (const p of log) {
    if (p.status !== 'pending') continue;
    const games = resultsByDate.get(p.gameDate) ?? [];
    const game = games.find((g) => g.homeAbbr === p.pickTeam || g.awayAbbr === p.pickTeam);
    if (!game) continue;
    const winner = winnerOf(game);
    if (!winner) continue; // not finished yet
    p.actualWinner = winner;
    p.status = winner === p.pickTeam ? 'correct' : 'incorrect';
    graded++;
  }
  return graded;
}

/**
 * Build the review report (accuracy, Brier, calibration table, mistakes, tuning guidance) from
 * whatever is graded in the log. Pure — no I/O — so it can be unit-tested and so it still produces
 * a report from hand-graded picks when the live finals fetch is network-blocked.
 */
export function buildReview(log: Prediction[], today: string): string {
  const graded = log.filter((p) => p.status === 'correct' || p.status === 'incorrect');
  const correct = graded.filter((p) => p.status === 'correct');
  const accuracy = graded.length > 0 ? correct.length / graded.length : NaN;
  const brier =
    graded.length > 0
      ? graded.reduce((s, p) => s + (p.probability - (p.status === 'correct' ? 1 : 0)) ** 2, 0) /
        graded.length
      : NaN;

  // Calibration buckets
  const buckets: Record<string, { n: number; hit: number; sumP: number }> = {};
  for (const p of graded) {
    const key = `${Math.floor(p.probability * 10) * 10}-${Math.floor(p.probability * 10) * 10 + 10}%`;
    buckets[key] ??= { n: 0, hit: 0, sumP: 0 };
    buckets[key].n++;
    buckets[key].sumP += p.probability;
    if (p.status === 'correct') buckets[key].hit++;
  }

  const mistakes = graded.filter((p) => p.status === 'incorrect');
  const pending = log.filter((p) => p.status === 'pending');

  const lines: string[] = [
    `# Prediction review — ${today}`,
    '',
    `- Graded: **${graded.length}** | Correct: **${correct.length}** | Accuracy: **${isNaN(accuracy) ? 'n/a' : (accuracy * 100).toFixed(1) + '%'}** (target 80%)`,
    `- Brier score: **${isNaN(brier) ? 'n/a' : brier.toFixed(4)}** (lower is better; 0.25 = coin flip)`,
    `- Still pending: ${pending.length}`,
    '',
    '## Calibration',
    '',
    '| Confidence bucket | Picks | Hit rate | Avg stated confidence |',
    '|---|---|---|---|',
    ...Object.entries(buckets)
      .sort()
      .map(
        ([k, b]) =>
          `| ${k} | ${b.n} | ${((b.hit / b.n) * 100).toFixed(0)}% | ${((b.sumP / b.n) * 100).toFixed(1)}% |`,
      ),
    '',
    '## Mistakes to review',
    '',
  ];
  if (mistakes.length === 0) {
    lines.push('None graded incorrect. 🎯');
  }
  for (const m of mistakes) {
    lines.push(
      `### ${m.gameDate} — ${m.question}`,
      `- Picked **${m.pickTeam}** at ${(m.probability * 100).toFixed(1)}% confidence; actual winner **${m.actualWinner}**.`,
      `- Model ${(m.pModel * 100).toFixed(1)}% vs market ${(m.pMarket * 100).toFixed(1)}% (edge ${(m.edge * 100).toFixed(1)}pp).`,
      `- Rationale at pick time: ${m.rationale}`,
      `- Review questions: Was there late lineup/injury news the adjustments missed? Was the model probability far above the market (overconfident model)? Should the threshold change?`,
      '',
    );
  }
  if (pending.length > 0) {
    lines.push(
      '## Still pending (ungraded)',
      '',
      'These picks have no final recorded yet. If the ESPN fetch was network-blocked, grade them by',
      'hand: set `status` to `correct`/`incorrect` and `actualWinner` in `data/predictions.jsonl`,',
      'then re-run `npm run predict:score` to regenerate this report.',
      '',
      ...pending.map((p) => `- ${p.gameDate} — ${p.question} → picked **${p.pickTeam}** (${(p.probability * 100).toFixed(1)}%)`),
      '',
    );
  }
  lines.push(
    '## Tuning guidance',
    '',
    '- If accuracy < 80% and most misses sat in the 78-85% bucket: raise `--threshold` (e.g. 0.82).',
    '- If hit rate per bucket is consistently *above* stated confidence: threshold can come down — you are leaving picks on the table.',
    '- If misses cluster around injury surprises: tighten the rule that games with unresolved star "Questionable" tags are skipped, not adjusted.',
    '- If model and market disagreed badly on misses: lower the model weight (MARKET_WEIGHT in prediction/src/model.ts).',
    '- If misses were model-driven (high model / low market, large positive edge): raise the market floor',
    '  (`--market-floor` / `marketFloor`, default 0.70) so the market must back the pick more strongly.',
    '',
  );
  return lines.join('\n');
}

async function main() {
  const log = loadLog();
  const pending = log.filter((p) => p.status === 'pending');
  const pendingDates = [...new Set(pending.map((p) => p.gameDate))];

  console.error(`${log.length} logged prediction(s), ${pending.length} pending across ${pendingDates.length} date(s).`);

  const resultsByDate = new Map<string, GameInfo[]>();
  let fetchBlocked = false;
  for (const date of pendingDates) {
    try {
      resultsByDate.set(date, await fetchScoreboard(date));
    } catch (err) {
      // ESPN egress is blocked in some sandboxes. Don't crash — leave those picks pending so the
      // operator can grade them by hand (see the offline fallback in the /nba-predict skill), and
      // still emit a report from whatever is already graded.
      fetchBlocked = true;
      console.error(`Could not fetch finals for ${date}: ${err instanceof Error ? err.message : err}`);
    }
  }
  if (fetchBlocked) {
    console.error(
      '\nFinals fetch was blocked for one or more dates. Grade those picks by hand in ' +
        'data/predictions.jsonl (set status + actualWinner) and re-run predict:score.\n',
    );
  }

  const newlyGraded = gradePending(log, resultsByDate);
  console.error(`Newly graded from finals: ${newlyGraded}.`);

  writeFileSync(LOG_FILE, log.map((p) => JSON.stringify(p)).join('\n') + '\n');

  const review = buildReview(log, new Date().toISOString().slice(0, 10));
  writeFileSync(REVIEW_FILE, review);
  console.log(review);
  console.error(`\nReview written to ${REVIEW_FILE}; log updated in place.`);
}

// Only run the CLI when executed directly, not when imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
