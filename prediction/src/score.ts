import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchScoreboard } from './espn.js';
import { normalizeEspnAbbr } from './teams.js';
import type { GameInfo, Prediction } from './types.js';

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const LOG_FILE = join(DATA_DIR, 'predictions.jsonl');
const REVIEW_FILE = join(DATA_DIR, 'review.md');

/**
 * Offline final scores provided by the session layer when the sandbox cannot
 * reach ESPN. Shape: { "YYYY-MM-DD": [{homeAbbr, awayAbbr, homeScore, awayScore}] }.
 */
type ResultsFile = Record<
  string,
  Array<{ homeAbbr: string; awayAbbr: string; homeScore: number; awayScore: number }>
>;

function loadResultsFile(path: string): Map<string, GameInfo[]> {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as ResultsFile;
  const map = new Map<string, GameInfo[]>();
  for (const [date, finals] of Object.entries(raw)) {
    map.set(
      date,
      finals.map((f) => ({
        espnId: '',
        date,
        homeAbbr: normalizeEspnAbbr(f.homeAbbr),
        awayAbbr: normalizeEspnAbbr(f.awayAbbr),
        startTimeUtc: '',
        completed: true,
        homeScore: f.homeScore,
        awayScore: f.awayScore,
      })),
    );
  }
  return map;
}

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

function winnerOf(g: GameInfo): string | null {
  if (!g.completed || g.homeScore === undefined || g.awayScore === undefined) return null;
  if (g.homeScore === g.awayScore) return null;
  return g.homeScore > g.awayScore ? g.homeAbbr : g.awayAbbr;
}

async function main() {
  const argv = process.argv.slice(2);
  const resultsIdx = argv.indexOf('--results');
  const resultsPath = resultsIdx >= 0 ? argv[resultsIdx + 1] : undefined;

  const log = loadLog();
  const pending = log.filter((p) => p.status === 'pending');
  const pendingDates = [...new Set(pending.map((p) => p.gameDate))];

  console.error(`${log.length} logged prediction(s), ${pending.length} pending across ${pendingDates.length} date(s).`);

  let resultsByDate = new Map<string, GameInfo[]>();
  if (resultsPath) {
    console.error(`Offline grading from ${resultsPath} (no ESPN fetch).`);
    resultsByDate = loadResultsFile(resultsPath);
  } else {
    for (const date of pendingDates) {
      resultsByDate.set(date, await fetchScoreboard(date));
    }
  }

  for (const p of pending) {
    const games = resultsByDate.get(p.gameDate) ?? [];
    // The pick references one team; find the completed game involving it.
    const game = games.find((g) => g.homeAbbr === p.pickTeam || g.awayAbbr === p.pickTeam);
    if (!game) continue;
    const winner = winnerOf(game);
    if (!winner) continue; // not finished yet
    p.actualWinner = winner;
    p.status = winner === p.pickTeam ? 'correct' : 'incorrect';
  }

  writeFileSync(LOG_FILE, log.map((p) => JSON.stringify(p)).join('\n') + '\n');

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

  const lines: string[] = [
    `# Prediction review — ${new Date().toISOString().slice(0, 10)}`,
    '',
    `- Graded: **${graded.length}** | Correct: **${correct.length}** | Accuracy: **${isNaN(accuracy) ? 'n/a' : (accuracy * 100).toFixed(1) + '%'}** (target 80%)`,
    `- Brier score: **${isNaN(brier) ? 'n/a' : brier.toFixed(4)}** (lower is better; 0.25 = coin flip)`,
    `- Still pending: ${log.filter((p) => p.status === 'pending').length}`,
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
  lines.push(
    '## Tuning guidance',
    '',
    '- If accuracy < 80% and most misses sat in the 78-85% bucket: raise `--threshold` (e.g. 0.82).',
    '- If hit rate per bucket is consistently *above* stated confidence: threshold can come down — you are leaving picks on the table.',
    '- If misses cluster around injury surprises: tighten the rule that games with unresolved star "Questionable" tags are skipped, not adjusted.',
    '- If model and market disagreed badly on misses: lower the model weight (MARKET_WEIGHT in prediction/src/model.ts).',
    '',
  );

  writeFileSync(REVIEW_FILE, lines.join('\n'));
  console.log(lines.join('\n'));
  console.error(`\nReview written to ${REVIEW_FILE}; log updated in place.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
