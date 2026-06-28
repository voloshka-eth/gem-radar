/**
 * M5 — PURE edge computation over CLOSED paper positions. No I/O, deterministic.
 *
 * "No edge" is a VALID, expected result. A single position means nothing; only
 * aggregates over a sufficient sample (default ≥ 50 closed) are interpretable.
 * Expectancy is measured NET of all modeled costs (the entry/exit fills already
 * subtracted slippage + sandwich + gas + tax), expressed per $1 risked.
 */

export interface ClosedPosition {
  realizedMultiple: number; // realized value / size (1.0 = break-even net of costs)
  finalScore: number | null;
  band: string | null;
}

export interface BandExpectancy {
  band: string;
  n: number;
  expectancyPer$1: number | null;
}

export interface EdgeParams {
  minClosed: number;       // below this → insufficient sample
  scoreThreshold: number;  // "candidate" band min for the filtered strategy
}

export interface EdgeResult {
  nClosed: number;
  insufficientSample: boolean;
  expectancyEnterAll: number | null;        // baseline: enter every survivor
  expectancyScoreFiltered: number | null;   // strategy: enter only score >= threshold
  nScoreFiltered: number;
  scoreBeatsBaseline: boolean;
  bands: BandExpectancy[];                   // ordered worst → best band
  bandsMonotonic: boolean;
  verdict: string;
  reasons: string[];
}

// Band order from worst to best — expectancy should rise along this if the score ranks.
const BAND_ORDER = ['reject_band', 'watchlist', 'candidate', 'high_band'];

const per$1 = (xs: number[]): number | null =>
  xs.length === 0 ? null : xs.reduce((a, m) => a + (m - 1), 0) / xs.length;

export function computeEdge(positions: ReadonlyArray<ClosedPosition>, params: EdgeParams): EdgeResult {
  const nClosed = positions.length;
  const insufficientSample = nClosed < params.minClosed;

  const allMultiples = positions.map((p) => p.realizedMultiple);
  const expectancyEnterAll = per$1(allMultiples);

  const filtered = positions.filter((p) => p.finalScore != null && p.finalScore >= params.scoreThreshold);
  const expectancyScoreFiltered = per$1(filtered.map((p) => p.realizedMultiple));

  // Band expectancies in worst→best order (only bands that have positions).
  const bands: BandExpectancy[] = [];
  for (const band of BAND_ORDER) {
    const inBand = positions.filter((p) => p.band === band).map((p) => p.realizedMultiple);
    if (inBand.length > 0) bands.push({ band, n: inBand.length, expectancyPer$1: per$1(inBand) });
  }
  const bandVals = bands.map((b) => b.expectancyPer$1 ?? 0);
  const bandsMonotonic = bandVals.every((v, i) => i === 0 || v >= bandVals[i - 1] - 1e-9);

  const scoreBeatsBaseline =
    expectancyScoreFiltered != null && expectancyEnterAll != null &&
    expectancyScoreFiltered > expectancyEnterAll;

  // ── Verdict ─────────────────────────────────────────────────────────────────
  const reasons: string[] = [];
  if (insufficientSample) reasons.push(`only ${nClosed} closed positions (< ${params.minClosed}) — insufficient sample`);
  if (!scoreBeatsBaseline) reasons.push('score-filtered expectancy does not beat enter-all baseline');
  if (bands.length >= 2 && !bandsMonotonic) reasons.push('expectancy is NOT monotonic across score bands (score looks like noise)');
  if (expectancyScoreFiltered != null && expectancyScoreFiltered <= 0) reasons.push('net expectancy ≤ 0 (loses money after costs)');

  const noEdge = insufficientSample || !scoreBeatsBaseline || (bands.length >= 2 && !bandsMonotonic) ||
                 (expectancyScoreFiltered != null && expectancyScoreFiltered <= 0);

  const verdict = noEdge
    ? 'NO EDGE DEMONSTRATED — do not risk capital'
    : 'Edge hypothesis SURVIVES this sample (still not proof; keep validating)';

  return {
    nClosed, insufficientSample,
    expectancyEnterAll, expectancyScoreFiltered, nScoreFiltered: filtered.length,
    scoreBeatsBaseline, bands, bandsMonotonic, verdict, reasons,
  };
}

export function renderEdgeReport(r: EdgeResult, params: EdgeParams, dateLabel: string): string {
  const pct = (n: number | null): string => (n == null ? '?' : `${(n * 100).toFixed(2)}%`);
  const lines: string[] = [
    '═'.repeat(64),
    '  GEM RADAR — M5 EDGE REPORT',
    `  Date: ${dateLabel}`,
    '  Expectancy is NET of all modeled costs, per $1 risked. Paper only.',
    '  "No edge" is a valid, expected outcome — not a failure.',
    '═'.repeat(64),
    '',
    `  Closed positions:        ${r.nClosed}`,
  ];
  if (r.insufficientSample) {
    lines.push(
      '',
      `  ⚠️  INSUFFICIENT SAMPLE — ${r.nClosed} < ${params.minClosed} closed positions.`,
      '      No conclusion can be drawn. Keep collecting closed positions.',
    );
  }
  lines.push(
    '',
    'EXPECTANCY (net of costs, per $1)',
    `  Baseline (enter every survivor):     ${pct(r.expectancyEnterAll)}`,
    `  Strategy (score ≥ ${params.scoreThreshold}, n=${r.nScoreFiltered}):        ${pct(r.expectancyScoreFiltered)}`,
    `  Score beats baseline?                ${r.scoreBeatsBaseline ? 'yes' : 'NO'}`,
    '',
    'BAND MONOTONICITY (expectancy should rise worst→best)',
  );
  if (r.bands.length === 0) {
    lines.push('  (no banded positions)');
  } else {
    for (const b of r.bands) lines.push(`  ${b.band.padEnd(14)} n=${String(b.n).padStart(4)}   ${pct(b.expectancyPer$1)}`);
    lines.push(`  Monotonic non-decreasing?            ${r.bandsMonotonic ? 'yes' : 'NO — score looks like noise'}`);
  }
  lines.push(
    '',
    'VERDICT',
    `  ${r.verdict}`,
  );
  if (r.reasons.length) {
    lines.push('  reasons:');
    for (const reason of r.reasons) lines.push(`    - ${reason}`);
  }
  lines.push('', '═'.repeat(64));
  return lines.join('\n');
}
