/**
 * M6 (shadow gem-tracker) — PURE outcome-distribution computation. No I/O.
 *
 * The real deliverable: does the survivor funnel have an x10–x1000 forward tail?
 * Measured by FDV multiple vs t0 over candidates with enough forward history.
 * "Reached ≥Nx" (ever observed) and "rugged" (final state) are NOT mutually exclusive —
 * a token can pump then rug. They are reported as separate tallies.
 */

export interface GemCandidateSummary {
  tokenAddress: string;
  symbol: string;
  historyMaxMin: number;              // forward minutes observed (since the baseline)
  maxMultiple: number | null;         // max FDV multiple observed vs the baseline (null if none)
  rugged: boolean;                    // any forward tick flagged rug
  aliveLatest: boolean;               // latest forward tick: not rug & liquidity intact
  perHorizon: Record<string, { rug: boolean } | undefined>; // forward horizons → rug state
}

// Raw inputs for re-baselining (the service maps DB rows to this).
export interface ShadowTickLite {
  horizon: string;
  elapsedMin: number;
  fdvUsd: number | null;
  rug: boolean;
}
export interface RawGemCandidate {
  tokenAddress: string;
  symbol: string;
  entryFdvUsd: number | null;        // t0 FDV
  ticks: ShadowTickLite[];           // CAPTURED ticks only
}

/**
 * Derive per-candidate outcome summaries for a chosen baseline.
 *   baseline = 't0'   → multiples vs the discovery FDV; every candidate is eligible.
 *   baseline = '<h>'  → multiples vs the FDV at that horizon's tick, and ONLY candidates
 *                       that were ALIVE (not rugged, real FDV) at that horizon are eligible.
 *                       This is the "snipe only what survived ≥<h>" hypothesis: you can only
 *                       enter what was still alive, and returns are measured from there.
 */
export function deriveSummaries(
  raw: ReadonlyArray<RawGemCandidate>,
  baseline: 't0' | string,
): GemCandidateSummary[] {
  const out: GemCandidateSummary[] = [];
  for (const c of raw) {
    let baseFdv: number | null;
    let baseElapsed: number;
    let forward: ShadowTickLite[];

    if (baseline === 't0') {
      baseFdv = c.entryFdvUsd;
      baseElapsed = 0;
      forward = [...c.ticks];
    } else {
      const bt = c.ticks.find((t) => t.horizon === baseline);
      if (!bt || bt.fdvUsd == null || bt.fdvUsd <= 0 || bt.rug) continue; // not eligible to "snipe"
      baseFdv = bt.fdvUsd;
      baseElapsed = bt.elapsedMin;
      forward = c.ticks.filter((t) => t.elapsedMin > bt.elapsedMin);
    }

    const mults = forward
      .map((t) => (t.fdvUsd != null && baseFdv != null && baseFdv > 0 ? t.fdvUsd / baseFdv : null))
      .filter((x): x is number => x != null);
    const latest = [...forward].sort((a, b) => b.elapsedMin - a.elapsedMin)[0];
    const perHorizon: GemCandidateSummary['perHorizon'] = {};
    for (const t of forward) perHorizon[t.horizon] = { rug: t.rug };

    out.push({
      tokenAddress: c.tokenAddress,
      symbol: c.symbol,
      historyMaxMin: forward.length ? Math.max(...forward.map((t) => t.elapsedMin)) - baseElapsed : 0,
      maxMultiple: mults.length ? Math.max(...mults) : null,
      rugged: forward.some((t) => t.rug),
      aliveLatest: latest ? !latest.rug : baseline !== 't0',
      perHorizon,
    });
  }
  return out;
}

export interface BucketStats {
  label: string;            // '≥24h' | '≥72h'
  n: number;
  reached: Record<string, number>;   // "2x" → count, etc.
  reachedPct: Record<string, string>;
  rugged: number;
  faded: number;            // alive but <1x
  withMultiple: number;
  maxObserved: number | null;
  median: number | null;
  p90: number | null;
}

export interface SurvivorshipPoint {
  horizon: string;
  observed: number;   // candidates with a captured tick at this horizon
  alive: number;      // of those, not rug
  alivePct: string;
}

export interface GemReportResult {
  totalCandidates: number;
  buckets: BucketStats[];          // ≥24h and ≥72h
  survivorship: SurvivorshipPoint[];
  minSampleWarn: number;
}

const THRESHOLDS = [2, 5, 10, 100, 1000];

function percentile(sortedAsc: number[], p: number): number | null {
  if (sortedAsc.length === 0) return null;
  const idx = Math.min(sortedAsc.length - 1, Math.floor((p / 100) * sortedAsc.length));
  return sortedAsc[idx];
}

function bucketStats(label: string, members: GemCandidateSummary[]): BucketStats {
  const withMult = members.filter((m) => m.maxMultiple != null) as (GemCandidateSummary & { maxMultiple: number })[];
  const mults = withMult.map((m) => m.maxMultiple).sort((a, b) => a - b);
  const reached: Record<string, number> = {};
  const reachedPct: Record<string, string> = {};
  for (const t of THRESHOLDS) {
    const c = withMult.filter((m) => m.maxMultiple >= t).length;
    reached[`${t}x`] = c;
    reachedPct[`${t}x`] = members.length ? `${((c / members.length) * 100).toFixed(1)}%` : '–';
  }
  const median = mults.length ? percentile(mults, 50) : null;
  const p90 = mults.length ? percentile(mults, 90) : null;
  return {
    label,
    n: members.length,
    reached, reachedPct,
    rugged: members.filter((m) => m.rugged).length,
    faded: members.filter((m) => !m.rugged && m.maxMultiple != null && m.maxMultiple < 1).length,
    withMultiple: withMult.length,
    maxObserved: mults.length ? mults[mults.length - 1] : null,
    median, p90,
  };
}

export function computeGemReport(
  summaries: ReadonlyArray<GemCandidateSummary>,
  horizonOrder: ReadonlyArray<string>,
  minSampleWarn: number,
): GemReportResult {
  const ge24 = summaries.filter((s) => s.historyMaxMin >= 1440);
  const ge72 = summaries.filter((s) => s.historyMaxMin >= 4320);

  const survivorship: SurvivorshipPoint[] = horizonOrder.map((h) => {
    const observed = summaries.filter((s) => s.perHorizon[h] !== undefined);
    const alive = observed.filter((s) => s.perHorizon[h]!.rug === false).length;
    return {
      horizon: h,
      observed: observed.length,
      alive,
      alivePct: observed.length ? `${((alive / observed.length) * 100).toFixed(1)}%` : '–',
    };
  });

  return {
    totalCandidates: summaries.length,
    buckets: [bucketStats('≥24h', ge24), bucketStats('≥72h', ge72)],
    survivorship,
    minSampleWarn,
  };
}

export function renderGemReport(
  r: GemReportResult,
  dateLabel: string,
  opts: { heading?: string; baselineNote?: string } = {},
): string {
  const heading = opts.heading ?? 'OUTCOME DISTRIBUTION · baseline = t0 (discovery)';
  const L: string[] = [
    '═'.repeat(72),
    `  GEM RADAR — SHADOW GEM-TRACKER · ${heading}`,
    `  Date: ${dateLabel}`,
    '  OBSERVATION ONLY — no positions entered. Forward returns measured by FDV.',
    '  "reached ≥Nx" = ever observed; "rugged" = final state — NOT mutually exclusive.',
    '═'.repeat(72),
    '',
    `  ${opts.baselineNote ?? `Total gem_candidates tracked: ${r.totalCandidates}`}`,
  ];

  for (const b of r.buckets) {
    L.push('', `OUTCOMES — candidates with ${b.label} forward history  (n=${b.n})`);
    if (b.n === 0) {
      L.push('  (none yet — need more forward history at this horizon)');
      continue;
    }
    if (b.n < r.minSampleWarn) {
      L.push(`  ⚠️  SMALL SAMPLE (n=${b.n} < ${r.minSampleWarn}) — distribution is indicative only, not conclusive.`);
    }
    for (const t of THRESHOLDS) {
      L.push(`    reached ≥${`${t}x`.padEnd(6)} ${String(b.reached[`${t}x`]).padStart(4)}   (${b.reachedPct[`${t}x`]})`);
    }
    L.push(
      `    rugged             ${String(b.rugged).padStart(4)}`,
      `    faded (<1x, alive) ${String(b.faded).padStart(4)}`,
      `    max observed mult  ${b.maxObserved != null ? b.maxObserved.toFixed(2) + 'x' : '–'}`,
      `    median mult        ${b.median != null ? b.median.toFixed(2) + 'x' : '–'}  (over ${b.withMultiple} with FDV)`,
      `    p90 mult           ${b.p90 != null ? b.p90.toFixed(2) + 'x' : '–'}`,
    );
  }

  L.push('', 'SURVIVORSHIP CURVE  (of candidates observed at each horizon, % still alive)');
  L.push(`  ${'horizon'.padEnd(10)}${'observed'.padStart(10)}${'alive'.padStart(8)}${'alive%'.padStart(9)}`);
  for (const s of r.survivorship) {
    L.push(`  ${s.horizon.padEnd(10)}${String(s.observed).padStart(10)}${String(s.alive).padStart(8)}${s.alivePct.padStart(9)}`);
  }
  L.push('', '═'.repeat(72));
  return L.join('\n');
}
