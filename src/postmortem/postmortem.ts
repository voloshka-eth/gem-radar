/**
 * M5 — PURE post-mortem computation over CLOSED paper positions. No I/O.
 *
 * Question: do the t0 (entry-time) features of things that later RUGGED/LOST differ
 * from those that SURVIVED/WON? Any separation found here is a HYPOTHESIS for M3/scoring
 * to test later — NOT a rule to hard-wire. With small samples it is almost certainly
 * overfitting, so a LOUD warning fires when either group has < minPerGroup positions.
 */
import { distribution, Dist } from '../paper/stats';

export interface ClosedFeatureRow {
  outcomeClass: string;       // WIN | LOSS | RUG | UNSELLABLE | LIQ_PULL | ...
  features: Record<string, number | null>;
}

export interface FeatureComparison {
  feature: string;
  bad: Dist;        // RUGGED/LOSS group
  good: Dist;       // SURVIVED/WIN group
  separates: boolean;
}

export interface FdvBucketPostmortem {
  bucket: string;
  bad: number;
  good: number;
  total: number;
  badRate: number | null;
}

export interface PostmortemResult {
  nBad: number;
  nGood: number;
  underpowered: boolean;       // either group < minPerGroup
  minPerGroup: number;
  features: FeatureComparison[];
  fdvBuckets: FdvBucketPostmortem[];
}

// Outcome → group.
const BAD = new Set(['RUG', 'UNSELLABLE', 'LIQ_PULL', 'LOSS']);
const GOOD = new Set(['WIN']);
const FDV_BUCKETS = [
  { label: '<$50k', min: 0, max: 50_000 },
  { label: '$50k-$100k', min: 50_000, max: 100_000 },
  { label: '$100k-$300k', min: 100_000, max: 300_000 },
  { label: '$300k-$1M', min: 300_000, max: 1_000_000 },
  { label: '$1M+', min: 1_000_000, max: Infinity },
] as const;

// Features compared between groups. The first block is t0 (entry-time); the last two
// are POST-t0 rug signals captured during eval (last tick before close) — added so that,
// once enough positions close, we can see whether they separate rugs from survivors.
export const POSTMORTEM_T0_FEATURES = [
  'onchainTvlUsd', 'slip1000', 'ageDays', 'fdvUsd', 'divergenceScore',
  'finalScore', 'liquidityScore', 'depthScore', 'ageScore', 'tractionScore',
  'deployerReputationScore', 'scoreConfidence',
];
export const POSTMORTEM_LASTTICK_FEATURES = ['sellersToBuyersRatioLast', 'sellSimOkLast'];
export const POSTMORTEM_FEATURES = [...POSTMORTEM_T0_FEATURES, ...POSTMORTEM_LASTTICK_FEATURES];

/** A feature "separates" if the group means differ by more than the pooled spread. */
function separates(bad: Dist, good: Dist): boolean {
  if (bad.mean == null || good.mean == null) return false;
  const spread = Math.max(
    (bad.max ?? 0) - (bad.min ?? 0),
    (good.max ?? 0) - (good.min ?? 0),
    1e-9,
  );
  return Math.abs(bad.mean - good.mean) > 0.5 * spread;
}

export function computePostmortem(
  rows: ReadonlyArray<ClosedFeatureRow>,
  minPerGroup: number,
): PostmortemResult {
  const bad = rows.filter((r) => BAD.has(r.outcomeClass));
  const good = rows.filter((r) => GOOD.has(r.outcomeClass));

  const features: FeatureComparison[] = POSTMORTEM_FEATURES.map((f) => {
    const bDist = distribution(bad.map((r) => r.features[f]));
    const gDist = distribution(good.map((r) => r.features[f]));
    return { feature: f, bad: bDist, good: gDist, separates: separates(bDist, gDist) };
  });

  const fdvBuckets: FdvBucketPostmortem[] = [];
  for (const bucket of FDV_BUCKETS) {
    const inBucket = rows.filter((r) => {
      const fdv = r.features.fdvUsd;
      return fdv != null && fdv >= bucket.min && fdv < bucket.max;
    });
    if (inBucket.length === 0) continue;
    const nBad = inBucket.filter((r) => BAD.has(r.outcomeClass)).length;
    const nGood = inBucket.filter((r) => GOOD.has(r.outcomeClass)).length;
    fdvBuckets.push({
      bucket: bucket.label,
      bad: nBad,
      good: nGood,
      total: inBucket.length,
      badRate: nBad / inBucket.length,
    });
  }

  return {
    nBad: bad.length,
    nGood: good.length,
    underpowered: bad.length < minPerGroup || good.length < minPerGroup,
    minPerGroup,
    features,
    fdvBuckets,
  };
}

export function renderPostmortem(r: PostmortemResult, dateLabel: string): string {
  const fnum = (n: number | null): string => (n == null ? '   –  ' : n.toPrecision(4).padStart(10));
  const lines: string[] = [
    '═'.repeat(78),
    '  GEM RADAR — M5 POST-MORTEM  (t0 features: RUGGED/LOSS vs SURVIVED/WIN)',
    `  Date: ${dateLabel}`,
    '  Findings are HYPOTHESES for M3/scoring to test later — NOT rules to hard-wire.',
    '═'.repeat(78),
    '',
    `  RUGGED/LOSS group (BAD):   n=${r.nBad}`,
    `  SURVIVED/WIN group (GOOD): n=${r.nGood}`,
  ];

  if (r.underpowered) {
    lines.push(
      '',
      '  ' + '!'.repeat(70),
      `  !! OVERFITTING WARNING: a group has < ${r.minPerGroup} samples (bad=${r.nBad}, good=${r.nGood}).`,
      '  !! Too few samples — any "separation" below is almost certainly noise.',
      '  !! DO NOT hard-wire these into M3/scoring. Collect more closed positions first.',
      '  ' + '!'.repeat(70),
    );
  }

  lines.push(
    '',
    `  ${'feature'.padEnd(18)}${'bad_mean'.padStart(11)}${'good_mean'.padStart(11)}${'bad_med'.padStart(11)}${'good_med'.padStart(11)}  separates?`,
    '  ' + '─'.repeat(74),
  );
  for (const f of r.features) {
    lines.push(
      `  ${f.feature.padEnd(18)}${fnum(f.bad.mean)}${fnum(f.good.mean)}${fnum(f.bad.median)}${fnum(f.good.median)}` +
      `   ${f.separates && !r.underpowered ? 'HYPOTHESIS' : (f.separates ? 'sep(noise?)' : 'no')}`,
    );
  }
  lines.push(
    '',
    'FDV BUCKETS (entry FDV; analysis only, no gate change)',
    `  ${'bucket'.padEnd(12)}${'total'.padStart(8)}${'bad'.padStart(8)}${'good'.padStart(8)}${'bad%'.padStart(9)}`,
    '  ' + '-'.repeat(45),
  );
  if (r.fdvBuckets.length === 0) {
    lines.push('  (no FDV data)');
  } else {
    for (const b of r.fdvBuckets) {
      const badPct = b.badRate == null ? '?' : `${(b.badRate * 100).toFixed(1)}%`;
      lines.push(
        `  ${b.bucket.padEnd(12)}${String(b.total).padStart(8)}` +
        `${String(b.bad).padStart(8)}${String(b.good).padStart(8)}${badPct.padStart(9)}`,
      );
    }
  }
  lines.push('', '═'.repeat(78));
  return lines.join('\n');
}
