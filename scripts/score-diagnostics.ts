/**
 * Read-only score / legacy-book diagnostics.
 *
 * Does NOT tune weights. Answers whether legacy score looks like:
 *   A) stable uplift vs enter-all
 *   B) weak/noisy
 *   C) maturity proxy / inverted vs upside
 *
 * Usage: npm run diagnostics:score
 */
import 'reflect-metadata';
process.env.COLLECTOR_AUTOSTART = 'false';
process.env.SOLANA_LAUNCH_ENABLED = 'false';
process.env.SOLANA_MULTI_VENUE_ENABLED = 'false';
process.env.EVM_FLOW_ENABLED = 'false';
import { NestFactory } from '@nestjs/core';
import { PrismaService } from '../src/database/prisma.service';
import { AppModule } from '../src/app.module';
import fs from 'fs';
import path from 'path';
import { Prisma } from '@prisma/client';

const OUT_DIR = path.resolve(__dirname, '..', 'logs', 'reports');
const PREDECLARED_THRESHOLDS = [50, 60, 70, 85] as const; // watchlist/candidate/high-ish; declared a priori
const FIXED_HORIZON_MS = 60 * 60 * 1000;

type Features = Record<string, unknown>;

type Pos = {
  id: string;
  chain: string;
  strategyVersion: string;
  status: string;
  outcomeClass: string | null;
  riskCohort: string;
  exitPolicy: string;
  benchmarkEligible: boolean;
  detectionDelaySec: number;
  sizeUsd: number;
  openedAt: Date;
  closedAt: Date | null;
  realizedMultiple: number | null;
  maxMultipleObserved: number | null;
  maxDrawdownObserved: number | null;
  features: Features;
};

function num(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown, fallback = ''): string {
  if (v == null) return fallback;
  const s = String(v).trim();
  return s || fallback;
}

function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function percentile(xs: number[], p: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.floor((p / 100) * (s.length - 1))));
  return s[idx]!;
}

function trimmedMean(xs: number[], trimFrac = 0.05): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const k = Math.floor(s.length * trimFrac);
  const slice = s.slice(k, s.length - k || undefined);
  return mean(slice.length ? slice : s);
}

function bootstrapMeanCI(xs: number[], rounds = 1000, alpha = 0.05): { lo: number; hi: number; mean: number } | null {
  if (xs.length < 5) return null;
  const means: number[] = [];
  for (let r = 0; r < rounds; r++) {
    let sum = 0;
    for (let i = 0; i < xs.length; i++) {
      sum += xs[Math.floor(Math.random() * xs.length)]!;
    }
    means.push(sum / xs.length);
  }
  means.sort((a, b) => a - b);
  const lo = means[Math.floor((alpha / 2) * means.length)]!;
  const hi = means[Math.min(means.length - 1, Math.floor((1 - alpha / 2) * means.length))]!;
  return { lo, hi, mean: mean(xs)! };
}

/** Spearman rank correlation (handles ties via average ranks). */
function spearman(xs: number[], ys: number[]): number | null {
  if (xs.length !== ys.length || xs.length < 5) return null;
  const rank = (arr: number[]): number[] => {
    const idx = arr.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
    const ranks = new Array(arr.length).fill(0);
    let i = 0;
    while (i < idx.length) {
      let j = i;
      while (j + 1 < idx.length && idx[j + 1]!.v === idx[i]!.v) j++;
      const avgRank = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) ranks[idx[k]!.i] = avgRank;
      i = j + 1;
    }
    return ranks;
  };
  const rx = rank(xs);
  const ry = rank(ys);
  const mx = mean(rx)!;
  const my = mean(ry)!;
  let nume = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < rx.length; i++) {
    const ax = rx[i]! - mx;
    const ay = ry[i]! - my;
    nume += ax * ay;
    dx += ax * ax;
    dy += ay * ay;
  }
  if (dx === 0 || dy === 0) return null;
  return nume / Math.sqrt(dx * dy);
}

function pnlFromMultiple(m: number, size: number): number {
  return (m - 1) * size;
}

function groupCount(rows: Pos[], key: (p: Pos) => string): Array<[string, number]> {
  const m = new Map<string, number>();
  for (const r of rows) m.set(key(r), (m.get(key(r)) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

function fmt(n: number | null | undefined, digits = 3): string {
  if (n == null || !Number.isFinite(n)) return 'n/a';
  return n.toFixed(digits);
}

function pct(n: number | null | undefined, digits = 1): string {
  if (n == null || !Number.isFinite(n)) return 'n/a';
  return `${(n * 100).toFixed(digits)}%`;
}

function discoveryLane(p: Pos): string {
  const src = str(p.features.discoverySource, 'unknown');
  const sv = p.strategyVersion;
  if (sv.startsWith('fresh_') || sv.includes('flow') || src.includes('factory') || src.includes('flow')) {
    return 'factory_or_flow';
  }
  if (src.includes('gecko') || src.includes('dexscreener') || src.includes('moralis') || src.includes('birdeye')) {
    return 'api_post_index';
  }
  if (sv.includes('robinhood') || p.riskCohort.includes('ROBINHOOD')) return 'robinhood';
  if (sv.startsWith('legacy') || sv.includes('static')) return 'legacy_radar';
  return `other:${src || sv}`;
}

function mapRow(r: {
  id: string;
  chain: string;
  strategyVersion: string;
  status: string;
  outcomeClass: string | null;
  riskCohort: string;
  exitPolicy: string;
  benchmarkEligible: boolean;
  detectionDelaySec: number;
  sizeUsd: Prisma.Decimal;
  openedAt: Date;
  closedAt: Date | null;
  realizedMultiple: Prisma.Decimal | null;
  maxMultipleObserved: Prisma.Decimal | null;
  maxDrawdownObserved: Prisma.Decimal | null;
  entryFeatures: Prisma.JsonValue | null;
}): Pos {
  return {
    id: r.id,
    chain: r.chain,
    strategyVersion: r.strategyVersion,
    status: r.status,
    outcomeClass: r.outcomeClass,
    riskCohort: r.riskCohort,
    exitPolicy: r.exitPolicy,
    benchmarkEligible: r.benchmarkEligible,
    detectionDelaySec: r.detectionDelaySec,
    sizeUsd: Number(r.sizeUsd),
    openedAt: r.openedAt,
    closedAt: r.closedAt,
    realizedMultiple: r.realizedMultiple != null ? Number(r.realizedMultiple) : null,
    maxMultipleObserved: r.maxMultipleObserved != null ? Number(r.maxMultipleObserved) : null,
    maxDrawdownObserved: r.maxDrawdownObserved != null ? Number(r.maxDrawdownObserved) : null,
    features: (r.entryFeatures ?? {}) as Features,
  };
}

function scoreOf(p: Pos): number | null {
  return num(p.features.finalScore);
}

function bandOf(p: Pos): string {
  return str(p.features.band, 'unknown');
}

function componentOf(p: Pos, key: string): number | null {
  return num(p.features[key]);
}

function isPrimaryObservation(p: Pos): boolean {
  // Keep experimental/no-provider books separate from primary SAFE radar book.
  return p.riskCohort !== 'ROBINHOOD_EXPERIMENTAL_NO_PROVIDER' &&
    p.riskCohort !== 'CONTRACT_MINTABLE_RESEARCH' &&
    p.riskCohort !== 'CONTRACT_UNKNOWN_RESEARCH';
}

function isClosedTradable(p: Pos): boolean {
  return p.status === 'CLOSED' && p.realizedMultiple != null;
}

/** Proxy fixed-horizon return: prefer realized if closed within horizon; else maxMultiple as optimistic MFE proxy. */
function horizonProxy(p: Pos): {
  kind: 'closed_within_horizon' | 'closed_after_horizon' | 'open_mfe_proxy' | 'missing';
  returnMultiple: number | null;
  holdMs: number | null;
} {
  const opened = p.openedAt.getTime();
  if (p.status === 'CLOSED' && p.closedAt && p.realizedMultiple != null) {
    const holdMs = p.closedAt.getTime() - opened;
    return {
      kind: holdMs <= FIXED_HORIZON_MS ? 'closed_within_horizon' : 'closed_after_horizon',
      returnMultiple: p.realizedMultiple,
      holdMs,
    };
  }
  if (p.maxMultipleObserved != null) {
    return { kind: 'open_mfe_proxy', returnMultiple: p.maxMultipleObserved, holdMs: null };
  }
  return { kind: 'missing', returnMultiple: null, holdMs: null };
}

function summarizeReturns(label: string, rows: Pos[], multipleOf: (p: Pos) => number | null): string[] {
  const pairs = rows
    .map((p) => ({ p, m: multipleOf(p) }))
    .filter((x): x is { p: Pos; m: number } => x.m != null);
  const ms = pairs.map((x) => x.m);
  const pnls = pairs.map((x) => pnlFromMultiple(x.m, x.p.sizeUsd));
  const totalPnl = pnls.reduce((a, b) => a + b, 0);
  const invested = pairs.reduce((a, x) => a + x.p.sizeUsd, 0);
  const sortedByPnl = [...pairs].sort((a, b) => pnlFromMultiple(b.m, b.p.sizeUsd) - pnlFromMultiple(a.m, a.p.sizeUsd));
  const dropTopK = (k: number) => {
    const rest = sortedByPnl.slice(k);
    return rest.reduce((a, x) => a + pnlFromMultiple(x.m, x.p.sizeUsd), 0);
  };
  const dropTopFrac = (frac: number) => {
    const k = Math.max(1, Math.floor(sortedByPnl.length * frac));
    return dropTopK(k);
  };
  const top1Share = sortedByPnl.length
    ? pnlFromMultiple(sortedByPnl[0]!.m, sortedByPnl[0]!.p.sizeUsd) / (Math.abs(totalPnl) < 1e-9 ? 1 : totalPnl)
    : null;
  const top5Share = sortedByPnl.length
    ? sortedByPnl.slice(0, 5).reduce((a, x) => a + pnlFromMultiple(x.m, x.p.sizeUsd), 0) /
      (Math.abs(totalPnl) < 1e-9 ? 1 : totalPnl)
    : null;
  const ev = mean(ms.map((m) => m - 1));
  const ci = bootstrapMeanCI(ms.map((m) => m - 1));
  const wins = ms.filter((m) => m >= 1).length;
  const x2 = ms.filter((m) => m >= 2).length;
  return [
    `### ${label}`,
    `n=${pairs.length}  invested≈$${invested.toFixed(2)}  totalPnl≈$${totalPnl.toFixed(2)}  ROI≈${pct(invested ? totalPnl / invested : null)}`,
    `mean_mult=${fmt(mean(ms))}  median_mult=${fmt(median(ms))}  trimmed_mean_mult(5%)=${fmt(trimmedMean(ms))}`,
    `EV(mult-1)=${fmt(ev)}  bootstrap95% CI=[${fmt(ci?.lo)}, ${fmt(ci?.hi)}]  P(EV>0)≈${ci ? (ci.lo > 0 ? 'likely' : ci.hi < 0 ? 'unlikely' : 'crosses_zero') : 'n/a'}`,
    `win_rate(≥1x)=${pct(pairs.length ? wins / pairs.length : null)}  ≥2x=${x2}/${pairs.length}`,
    `PnL w/o top1%=$${dropTopFrac(0.01).toFixed(2)}  w/o top5 trades=$${dropTopK(Math.min(5, sortedByPnl.length)).toFixed(2)}`,
    `share_of_total_pnl from top1≈${fmt(top1Share, 2)}  from top5≈${fmt(top5Share, 2)}`,
    `mult p10/p50/p90=${fmt(percentile(ms, 10))} / ${fmt(percentile(ms, 50))} / ${fmt(percentile(ms, 90))}`,
    '',
  ];
}

function bandMonotonicity(rows: Pos[], multipleOf: (p: Pos) => number | null): string[] {
  const order = ['reject_band', 'watchlist', 'candidate', 'high_band'];
  const lines = ['### Band expectancy (ordered reject→high)'];
  const vals: number[] = [];
  for (const band of order) {
    const ms = rows.filter((p) => bandOf(p) === band).map(multipleOf).filter((m): m is number => m != null);
    const ev = mean(ms.map((m) => m - 1));
    if (ms.length) vals.push(ev ?? 0);
    lines.push(`  ${band.padEnd(14)} n=${String(ms.length).padStart(4)}  mean_mult=${fmt(mean(ms))}  EV=${fmt(ev)}`);
  }
  const mono = vals.every((v, i) => i === 0 || v >= vals[i - 1]! - 1e-9);
  lines.push(`  monotonic_non_decreasing? ${mono ? 'YES' : 'NO'}`);
  lines.push('');
  return lines;
}

function thresholdUplift(rows: Pos[], multipleOf: (p: Pos) => number | null): string[] {
  const all = rows.map(multipleOf).filter((m): m is number => m != null);
  const baseEv = mean(all.map((m) => m - 1));
  const lines = [
    '### Predeclared threshold uplift vs enter-all (same closed set — overfitting risk noted)',
    `baseline enter-all n=${all.length} EV=${fmt(baseEv)}`,
  ];
  for (const t of PREDECLARED_THRESHOLDS) {
    const filtered = rows.filter((p) => {
      const s = scoreOf(p);
      return s != null && s >= t;
    });
    const ms = filtered.map(multipleOf).filter((m): m is number => m != null);
    const ev = mean(ms.map((m) => m - 1));
    const uplift = ev != null && baseEv != null ? ev - baseEv : null;
    lines.push(
      `  score≥${t}: n=${ms.length} EV=${fmt(ev)} uplift=${fmt(uplift)} ${uplift != null && uplift > 0 ? 'BEATS' : '≤ baseline'}`,
    );
  }
  lines.push('');
  return lines;
}

function temporalHoldout(rows: Pos[], multipleOf: (p: Pos) => number | null): string[] {
  const scored = rows
    .filter((p) => scoreOf(p) != null && multipleOf(p) != null)
    .sort((a, b) => a.openedAt.getTime() - b.openedAt.getTime());
  const lines = ['### Temporal holdout (first 70% develop / last 30% test) — threshold fixed at 70'];
  if (scored.length < 30) {
    lines.push('  insufficient sample for holdout');
    lines.push('');
    return lines;
  }
  const cut = Math.floor(scored.length * 0.7);
  const train = scored.slice(0, cut);
  const test = scored.slice(cut);
  const evalSet = (set: Pos[], label: string) => {
    const all = set.map(multipleOf).filter((m): m is number => m != null);
    const filt = set.filter((p) => (scoreOf(p) ?? 0) >= 70).map(multipleOf).filter((m): m is number => m != null);
    lines.push(
      `  ${label}: n_all=${all.length} EV_all=${fmt(mean(all.map((m) => m - 1)))} | n≥70=${filt.length} EV≥70=${fmt(mean(filt.map((m) => m - 1)))}`,
    );
  };
  evalSet(train, 'develop');
  evalSet(test, 'holdout');
  lines.push(`  develop window: ${train[0]?.openedAt.toISOString()} → ${train[train.length - 1]?.openedAt.toISOString()}`);
  lines.push(`  holdout window: ${test[0]?.openedAt.toISOString()} → ${test[test.length - 1]?.openedAt.toISOString()}`);
  lines.push('');
  return lines;
}

function componentCorrelations(rows: Pos[], multipleOf: (p: Pos) => number | null): string[] {
  const keys = [
    'finalScore',
    'liquidityScore',
    'depthScore',
    'ageScore',
    'tractionScore',
    'divergenceScore',
    'deployerReputationScore',
    'scoreConfidence',
    'fdvUsd',
    'ageDays',
    'onchainTvlUsd',
    'executableDepthUsd',
  ];
  const lines = ['### Rank correlation (Spearman) component/feature ↔ outcome multiple'];
  for (const key of keys) {
    const xs: number[] = [];
    const ys: number[] = [];
    for (const p of rows) {
      const x = key === 'finalScore' ? scoreOf(p) : componentOf(p, key);
      const y = multipleOf(p);
      if (x != null && y != null) {
        xs.push(x);
        ys.push(y);
      }
    }
    lines.push(`  ${key.padEnd(28)} ρ=${fmt(spearman(xs, ys), 3)}  n=${xs.length}`);
  }
  lines.push('');
  return lines;
}

function scoreDistribution(rows: Pos[]): string[] {
  const scores = rows.map(scoreOf).filter((s): s is number => s != null);
  const bands = groupCount(rows, (p) => bandOf(p));
  const missing = rows.filter((p) => scoreOf(p) == null).length;
  return [
    '### Score distribution (primary book)',
    `scored=${scores.length}  missing_score=${missing}`,
    `mean=${fmt(mean(scores))} median=${fmt(median(scores))} p10=${fmt(percentile(scores, 10))} p90=${fmt(percentile(scores, 90))}`,
    `bands: ${bands.map(([k, v]) => `${k}=${v}`).join(', ')}`,
    '',
  ];
}

function missingDataBehavior(rows: Pos[]): string[] {
  const lines = ['### Missing-component / confidence behavior'];
  const conf = rows.map((p) => num(p.features.scoreConfidence)).filter((c): c is number => c != null);
  lines.push(`scoreConfidence mean=${fmt(mean(conf))} median=${fmt(median(conf))} n=${conf.length}`);
  const missingKeys = new Map<string, number>();
  for (const p of rows) {
    const raw = p.features.componentsMissing;
    const list = Array.isArray(raw) ? raw.map(String) : [];
    for (const k of list) missingKeys.set(k, (missingKeys.get(k) ?? 0) + 1);
  }
  if (!missingKeys.size) {
    lines.push('  componentsMissing not present on most entryFeatures (legacy rows may lack it)');
  } else {
    for (const [k, v] of [...missingKeys.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
      lines.push(`  missing ${k}: ${v}`);
    }
  }
  // High score with low confidence = renormalization danger signal
  let highScoreLowConf = 0;
  let highScore = 0;
  for (const p of rows) {
    const s = scoreOf(p);
    const c = num(p.features.scoreConfidence);
    if (s != null && s >= 70) {
      highScore++;
      if (c != null && c < 0.55) highScoreLowConf++;
    }
  }
  lines.push(`  score≥70 with confidence<0.55: ${highScoreLowConf}/${highScore}`);
  lines.push('');
  return lines;
}

function outcomeBias(all: Pos[]): string[] {
  const lines = ['### Outcome / open-missing bias'];
  for (const [k, v] of groupCount(all, (p) => p.status)) lines.push(`  status ${k}=${v}`);
  for (const [k, v] of groupCount(all.filter((p) => p.outcomeClass), (p) => str(p.outcomeClass, '?'))) {
    lines.push(`  outcomeClass ${k}=${v}`);
  }
  const open = all.filter((p) => p.status === 'OPEN' || p.status === 'PENDING_CONFIRMATION');
  const closed = all.filter(isClosedTradable);
  const openScores = open.map(scoreOf).filter((s): s is number => s != null);
  const closedScores = closed.map(scoreOf).filter((s): s is number => s != null);
  lines.push(`  open/pending n=${open.length} mean_score=${fmt(mean(openScores))}`);
  lines.push(`  closed n=${closed.length} mean_score=${fmt(mean(closedScores))}`);
  const openMax = open.map((p) => p.maxMultipleObserved).filter((m): m is number => m != null);
  lines.push(`  open maxMultipleObserved mean=${fmt(mean(openMax))} median=${fmt(median(openMax))}`);
  lines.push('');
  return lines;
}

function executionLatencyProxy(rows: Pos[]): string[] {
  // We lack per-block inclusion quotes; report detectionDelaySec distribution +
  // crude optimistic/p50/p95 *cost* stress by applying extra adverse move on multiple.
  const delays = rows.map((p) => p.detectionDelaySec);
  const lines = [
    '### Execution latency model (limited by available data)',
    `detectionDelaySec mean=${fmt(mean(delays), 2)} median=${fmt(median(delays), 2)} p95=${fmt(percentile(delays, 95), 2)}`,
    'NOTE: without inclusion-block executable quotes, p50/p95 latency stress is a sensitivity check only:',
  ];
  const closed = rows.filter(isClosedTradable);
  const baseMs = closed.map((p) => p.realizedMultiple!).filter((m) => m != null);
  // Assume adverse price move during delay: optimistic 0%, p50 3%, p95 8% worse entry → multiply outcome by (1-d)
  const stress = (adverse: number) => mean(baseMs.map((m) => m * (1 - adverse) - 1));
  lines.push(`  closed EV baseline=${fmt(mean(baseMs.map((m) => m - 1)))}`);
  lines.push(`  stress optimistic (0% adverse)=${fmt(stress(0))}`);
  lines.push(`  stress p50-like (3% adverse)=${fmt(stress(0.03))}`);
  lines.push(`  stress p95-like (8% adverse)=${fmt(stress(0.08))}`);
  lines.push('  (This is NOT true inclusion-block replay — flag as data gap.)');
  lines.push('');
  return lines;
}

function composition(all: Pos[]): string[] {
  const lines = ['## 1. Composition by lane / version / hash / chain'];
  lines.push(`total_positions=${all.length}`);
  lines.push('by strategyVersion:');
  for (const [k, v] of groupCount(all, (p) => p.strategyVersion).slice(0, 25)) {
    lines.push(`  ${k}=${v}`);
  }
  lines.push('by discovery_lane (heuristic):');
  for (const [k, v] of groupCount(all, discoveryLane)) lines.push(`  ${k}=${v}`);
  lines.push('by chain:');
  for (const [k, v] of groupCount(all, (p) => p.chain)) lines.push(`  ${k}=${v}`);
  lines.push('by riskCohort:');
  for (const [k, v] of groupCount(all, (p) => p.riskCohort)) lines.push(`  ${k}=${v}`);
  lines.push('by exitPolicy:');
  for (const [k, v] of groupCount(all, (p) => p.exitPolicy).slice(0, 15)) lines.push(`  ${k}=${v}`);
  lines.push('by config_hash (from entryFeatures):');
  for (const [k, v] of groupCount(all, (p) => str(p.features.configHash, '(none)')).slice(0, 15)) {
    lines.push(`  ${k}=${v}`);
  }
  lines.push('by benchmarkEligible:');
  for (const [k, v] of groupCount(all, (p) => String(p.benchmarkEligible))) lines.push(`  ${k}=${v}`);
  lines.push('');
  return lines;
}

function pickDominantLegacyBook(primary: Pos[]): { label: string; rows: Pos[] } {
  // Prefer largest single strategyVersion among primary closed+open.
  const versions = groupCount(primary, (p) => p.strategyVersion);
  if (!versions.length) return { label: 'empty', rows: [] };
  const [topVersion] = versions[0]!;
  // If legacy_static dominates or mix of early static versions, take all "legacy*" / static_shadow
  const legacyLike = primary.filter((p) =>
    p.strategyVersion.includes('legacy') ||
    p.strategyVersion.includes('static') ||
    p.strategyVersion === topVersion,
  );
  // Prefer pure top version if it's large enough
  const topRows = primary.filter((p) => p.strategyVersion === topVersion);
  if (topRows.length >= Math.min(100, primary.length * 0.4)) {
    return { label: `strategyVersion=${topVersion}`, rows: topRows };
  }
  return { label: `legacy-like dominant around ${topVersion}`, rows: legacyLike };
}

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    const prisma = app.get(PrismaService);
    const raw = await prisma.paperPosition.findMany({
      select: {
        id: true,
        chain: true,
        strategyVersion: true,
        status: true,
        outcomeClass: true,
        riskCohort: true,
        exitPolicy: true,
        benchmarkEligible: true,
        detectionDelaySec: true,
        sizeUsd: true,
        openedAt: true,
        closedAt: true,
        realizedMultiple: true,
        maxMultipleObserved: true,
        maxDrawdownObserved: true,
        entryFeatures: true,
      },
      orderBy: { openedAt: 'asc' },
    });
    const all = raw.map(mapRow);
    const primary = all.filter(isPrimaryObservation);
    const book = pickDominantLegacyBook(primary);
    const bookClosed = book.rows.filter(isClosedTradable);
    const bookAllStatuses = book.rows;

    const realizedOf = (p: Pos) => p.realizedMultiple;
    const horizonOf = (p: Pos) => horizonProxy(p).returnMultiple;

    const lines: string[] = [];
    lines.push('═'.repeat(72));
    lines.push(' GEM RADAR — SCORE / LEGACY BOOK DIAGNOSTICS (read-only)');
    lines.push(` generated: ${new Date().toISOString()}`);
    lines.push('═'.repeat(72));
    lines.push('');
    lines.push('Framing (not flattery): research primitives exist; this report checks whether');
    lines.push('legacy data is clean enough for causal claims about score uplift.');
    lines.push('');

    lines.push(...composition(all));

    lines.push('## 2. Open / missing outcome bias');
    lines.push(...outcomeBias(all));
    lines.push('Primary observation book only:');
    lines.push(...outcomeBias(primary));
    lines.push(`Dominant analysis book: ${book.label} (n=${book.rows.length}, closed=${bookClosed.length})`);
    lines.push(...outcomeBias(bookAllStatuses));

    lines.push('## 3. Score distribution');
    lines.push(...scoreDistribution(book.rows));

    lines.push('## 4. Missing-data / renormalization signals');
    lines.push(...missingDataBehavior(book.rows));

    lines.push('## 5–6. Band monotonicity + rank correlations');
    lines.push('### On CLOSED realized multiples (survivorship warning)');
    lines.push(...bandMonotonicity(bookClosed, realizedOf));
    lines.push(...componentCorrelations(bookClosed, realizedOf));
    lines.push('### Fixed-horizon PROXY (closed within 60m uses realized; else maxMultiple / open MFE)');
    lines.push('DATA GAP: true executable_return_60m is not stored per signal for all cohorts.');
    const kindCounts = new Map<string, number>();
    for (const p of book.rows) {
      const k = horizonProxy(p).kind;
      kindCounts.set(k, (kindCounts.get(k) ?? 0) + 1);
    }
    lines.push(`horizon proxy kinds: ${[...kindCounts.entries()].map(([k, v]) => `${k}=${v}`).join(', ')}`);
    lines.push(...bandMonotonicity(book.rows, horizonOf));
    lines.push(...componentCorrelations(book.rows.filter((p) => horizonOf(p) != null), horizonOf));

    lines.push('## 7. Predeclared threshold uplift');
    lines.push(...thresholdUplift(bookClosed, realizedOf));
    lines.push(...temporalHoldout(bookClosed, realizedOf));

    lines.push('## 8–9. PnL concentration / distribution');
    lines.push(...summarizeReturns(`CLOSED realized — ${book.label}`, bookClosed, realizedOf));
    const safeClosed = primary.filter((p) => p.riskCohort === 'CONTRACT_SAFE' && isClosedTradable(p));
    lines.push(...summarizeReturns('CLOSED realized — riskCohort=CONTRACT_SAFE only (mixed versions)', safeClosed, realizedOf));
    lines.push('### CONTRACT_SAFE band monotonicity');
    lines.push(...bandMonotonicity(safeClosed, realizedOf));
    lines.push(...summarizeReturns('CLOSED realized — ALL primary (mixed versions)', primary.filter(isClosedTradable), realizedOf));
    lines.push(...summarizeReturns('CLOSED realized — ALL positions (including research)', all.filter(isClosedTradable), realizedOf));

    lines.push('## Transform check (raw vs scored age)');
    lines.push('If ageDays correlates positively with outcome but ageScore negatively, the age curve targets the wrong regime.');
    {
      const xsScore: number[] = [];
      const xsDays: number[] = [];
      const ys: number[] = [];
      for (const p of bookClosed) {
        const a = componentOf(p, 'ageScore');
        const d = componentOf(p, 'ageDays');
        const m = p.realizedMultiple;
        if (a != null && d != null && m != null) {
          xsScore.push(a);
          xsDays.push(d);
          ys.push(m);
        }
      }
      lines.push(`  paired n=${ys.length}  ρ(ageScore,ret)=${fmt(spearman(xsScore, ys))}  ρ(ageDays,ret)=${fmt(spearman(xsDays, ys))}`);
      lines.push('');
    }

    lines.push('## 10. Optimistic / p50 / p95 execution stress (sensitivity only)');
    lines.push(...executionLatencyProxy(bookClosed));

    const baseEv = mean(bookClosed.map((p) => (p.realizedMultiple ?? 1) - 1));
    const filtered70 = bookClosed.filter((p) => (scoreOf(p) ?? -1) >= 70);
    const filtEv = mean(filtered70.map((p) => (p.realizedMultiple ?? 1) - 1));
    const scores = bookClosed.map(scoreOf).filter((s): s is number => s != null);
    const rets = bookClosed.filter((p) => scoreOf(p) != null).map((p) => p.realizedMultiple!);
    const rho = spearman(
      bookClosed.filter((p) => scoreOf(p) != null).map((p) => scoreOf(p)!),
      rets,
    );
    const bandEvs: number[] = [];
    for (const band of ['reject_band', 'watchlist', 'candidate', 'high_band']) {
      const ms = bookClosed.filter((p) => bandOf(p) === band).map((p) => p.realizedMultiple!).filter((m) => m != null);
      if (ms.length) bandEvs.push(mean(ms.map((m) => m - 1)) ?? 0);
    }
    const mono = bandEvs.length >= 2 && bandEvs.every((v, i) => i === 0 || v >= bandEvs[i - 1]! - 1e-9);
    const uplift = filtEv != null && baseEv != null ? filtEv - baseEv : null;

    lines.push('## Verdict (for this dominant book)');
    lines.push(`book=${book.label}`);
    lines.push(`closed_n=${bookClosed.length}  scored_closed=${scores.length}`);
    lines.push(`enter_all_EV=${fmt(baseEv)}  score≥70_EV=${fmt(filtEv)}  uplift=${fmt(uplift)}`);
    lines.push(`spearman(score, realized)=${fmt(rho)}  bands_monotonic=${mono}`);
    lines.push('');
    let bucket: 'A_stable_uplift' | 'B_weak_noisy' | 'C_maturity_or_inverted' | 'INSUFFICIENT_DATA';
    if (bookClosed.length < 80 || scores.length < 80) {
      bucket = 'INSUFFICIENT_DATA';
    } else if (rho != null && rho < -0.05 && (uplift == null || uplift <= 0) && !mono) {
      bucket = 'C_maturity_or_inverted';
    } else if (uplift != null && uplift > 0.02 && mono && rho != null && rho > 0.05) {
      bucket = 'A_stable_uplift';
    } else {
      bucket = 'B_weak_noisy';
    }
    lines.push(`RESULT_BUCKET=${bucket}`);
    lines.push('');
    lines.push('Interpretation keys:');
    lines.push('  A_stable_uplift → keep score, calibrate, add benchmark capital arm');
    lines.push('  B_weak_noisy → simplify, gather more clean paired data, do not invent features');
    lines.push('  C_maturity_or_inverted → do NOT tune weights; change target + feature architecture');
    lines.push('  INSUFFICIENT_DATA → fix terminal outcomes / version split before score claims');
    lines.push('');
    lines.push('Known causal gaps still open after this report:');
    lines.push('  - no true executable_return_60m for every signal (incl. rejected)');
    lines.push('  - rejected-not-entered tokens may lack comparable outcome series');
    lines.push('  - threshold uplift on same sample can overfit (holdout section mitigates partially)');
    lines.push('  - latency stress is not inclusion-block replay');
    lines.push('');

    const text = lines.join('\n');
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const outFile = path.join(OUT_DIR, `score_diagnostics_${new Date().toISOString().slice(0, 10)}.txt`);
    fs.writeFileSync(outFile, text, 'utf8');
    console.log(text);
    console.log(`\nWrote ${outFile}`);
  } finally {
    await app.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
