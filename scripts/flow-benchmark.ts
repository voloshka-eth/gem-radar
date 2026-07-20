import { PrismaClient } from '@prisma/client';

type AnyRow = Record<string, any>;
type Metric = {
  samples: Set<string>;
  signals: number;
  eligible: number;
  x2: number;
  closed: number;
  pnlSum: number;
  rugs: number;
  latencySumSec: number;
  latencyN: number;
};

const prisma = new PrismaClient();

function emptyMetric(): Metric {
  return {
    samples: new Set(), signals: 0, eligible: 0, x2: 0, closed: 0,
    pnlSum: 0, rugs: 0, latencySumSec: 0, latencyN: 0,
  };
}

function marketKey(row: AnyRow): string {
  return `${row.chain}:${row.poolAddress}:${row.watchType}`;
}

function terminal(position: AnyRow | null): boolean {
  return position != null && ['CLOSED', 'INVALIDATED', 'NOT_ENTERED'].includes(position.status);
}

function rugLike(position: AnyRow | null): boolean {
  return /RUG|LIQ_PULL|UNSELLABLE/.test(position?.outcomeClass ?? '');
}

function quoteOnlyInvalidation(position: AnyRow | null): boolean {
  if (!position || position.status !== 'CLOSED' || position.outcomeClass !== 'RUG') return false;
  const features = position.entryFeatures && typeof position.entryFeatures === 'object'
    ? position.entryFeatures as AnyRow
    : {};
  return position.priceNowUsd == null &&
    Number(position.onchainLiqNowUsd ?? 0) > 50 &&
    Number(features.priceReadFailureCount ?? 0) > 0 &&
    Number(features.liquidityGoneReadCount ?? 0) === 0 &&
    position.lastSellSimOk !== false;
}

function fullHourOrTerminal(watch: AnyRow, position: AnyRow | null, now: number): boolean {
  return now - watch.discoveredAt.getTime() >= 3_600_000 || terminal(position);
}

function reached2xWithinHour(watch: AnyRow, position: AnyRow | null): boolean {
  return watch.outcome1h === 'EXECUTABLE_2X' ||
    String(position?.executedRungs ?? '').split(',').includes('2');
}

function addMetric(
  metrics: Map<string, Metric>,
  key: string,
  watch: AnyRow,
  signal: AnyRow,
  now: number,
): void {
  const metric = metrics.get(key) ?? emptyMetric();
  const position = signal.paperPosition ?? null;
  metric.samples.add(marketKey(watch));
  metric.signals++;
  const latencySec = Math.max(0, (signal.observedAt.getTime() - watch.discoveredAt.getTime()) / 1_000);
  metric.latencySumSec += latencySec;
  metric.latencyN++;
  if (fullHourOrTerminal(watch, position, now) &&
      signal.status !== 'REORG_INVALIDATED' &&
      !quoteOnlyInvalidation(position)) {
    metric.eligible++;
    if (reached2xWithinHour(watch, position)) metric.x2++;
    if (position?.realizedMultiple != null) {
      metric.closed++;
      metric.pnlSum += Number(position.realizedMultiple) - 1;
    }
    if (rugLike(position)) metric.rugs++;
  }
  metrics.set(key, metric);
}

function renderMetric(label: string, metric: Metric): string {
  const precision = metric.eligible ? 100 * metric.x2 / metric.eligible : null;
  const expectancy = metric.closed ? metric.pnlSum / metric.closed : null;
  const rugRate = metric.eligible ? 100 * metric.rugs / metric.eligible : null;
  const latency = metric.latencyN ? metric.latencySumSec / metric.latencyN : null;
  return `${label}: marketSamples=${metric.samples.size} signals=${metric.signals} eligible1h=${metric.eligible} ` +
    `precision2x=${precision == null ? '?' : precision.toFixed(1) + '%'} ` +
    `expectancy=${expectancy == null ? '?' : expectancy.toFixed(4)} ` +
    `rugRate=${rugRate == null ? '?' : rugRate.toFixed(1) + '%'} ` +
    `latencyAvg=${latency == null ? '?' : latency.toFixed(1) + 's'}`;
}

async function main(): Promise<void> {
  const now = Date.now();
  const watches: AnyRow[] = await (prisma as any).evmPoolWatch.findMany({
    include: { signals: { include: { paperPosition: true }, orderBy: { observedAt: 'asc' } } },
    orderBy: { discoveredAt: 'asc' },
  });
  const valid = watches.filter((watch) => watch.status !== 'REORG_INVALIDATED');
  const quoteOnlyInvalidations = valid.flatMap((watch) => watch.signals)
    .filter((signal) => quoteOnlyInvalidation(signal.paperPosition));
  const metrics = new Map<string, Metric>();

  for (const watch of valid) {
    for (const signal of watch.signals) {
      if (signal.status === 'LATE_SHADOW' || signal.status === 'REORG_INVALIDATED') continue;
      const cohort = signal.paperPosition?.riskCohort ?? (signal.status === 'HARD_REJECT' ? 'HARD_REJECT' : 'NO_POSITION');
      addMetric(metrics, `chain=${watch.chain}`, watch, signal, now);
      addMetric(metrics, `amm=${watch.chain}/${watch.liquidityModel ?? 'unknown'}`, watch, signal, now);
      addMetric(metrics, `strategy=${watch.chain}/${signal.strategyVersion}`, watch, signal, now);
      addMetric(metrics, `cohort=${watch.chain}/${signal.strategyVersion}/${cohort}`, watch, signal, now);
    }
  }

  const lines = [
    `ETH/BASE FLOW BENCHMARK ${new Date().toISOString()}`,
    'Canonical DB only. Legacy static entries and late/reorg-invalidated signals are excluded.',
    'Precision denominator: full 1h observation or an earlier terminal paper outcome.',
    `Data-quality exclusions: quote-only false RUG signals=${quoteOnlyInvalidations.length}.`,
    '',
    'PRIMARY METRICS',
    ...[...metrics.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, metric]) => renderMetric(key, metric)),
    '',
    'RECALL / FALSE NEGATIVES',
  ];

  for (const chain of ['base', 'ethereum']) {
    const chainWatches = valid.filter((watch) => watch.chain === chain && watch.outcome1h != null);
    const winners = chainWatches.filter((watch) => watch.outcome1h === 'EXECUTABLE_2X');
    const triggered = winners.filter((watch) => watch.signals.some((signal: AnyRow) =>
      !['LATE_SHADOW', 'REORG_INVALIDATED'].includes(signal.status),
    ));
    const falseNegatives = winners.length - triggered.length;
    lines.push(`${chain}: recall=${winners.length ? (100 * triggered.length / winners.length).toFixed(1) + '%' : '?'} ` +
      `captured=${triggered.length}/${winners.length} falseNegatives=${falseNegatives} observedPools=${chainWatches.length}`);
  }

  lines.push('', 'PROVISIONAL EARLY 2X (NOT YET PRECISION-ELIGIBLE)');
  for (const chain of ['base', 'ethereum']) {
    const pendingEarlyWinners = valid.filter((watch) =>
      watch.chain === chain &&
      watch.outcome1h == null &&
      watch.timeTo2xSec != null &&
      Number(watch.timeTo2xSec) <= 3_600,
    );
    const captured = pendingEarlyWinners.filter((watch) => watch.signals.some((signal: AnyRow) =>
      !['LATE_SHADOW', 'REORG_INVALIDATED'].includes(signal.status),
    ));
    lines.push(`${chain}: early2x=${pendingEarlyWinners.length} captured=${captured.length} ` +
      `provisionalFalseNegatives=${pendingEarlyWinners.length - captured.length}`);
  }

  lines.push('', 'PAIRED STRATEGY COMPARISON');
  const pairs = new Map<string, { both: number; aWins: number; bWins: number; ties: number }>();
  for (const watch of valid) {
    const signals = watch.signals.filter((signal: AnyRow) => !['LATE_SHADOW', 'REORG_INVALIDATED'].includes(signal.status));
    for (let i = 0; i < signals.length; i++) {
      for (let j = i + 1; j < signals.length; j++) {
        const [a, b] = [signals[i], signals[j]].sort((left, right) => left.strategyVersion.localeCompare(right.strategyVersion));
        const key = `${watch.chain}:${a.strategyVersion} vs ${b.strategyVersion}`;
        const pair = pairs.get(key) ?? { both: 0, aWins: 0, bWins: 0, ties: 0 };
        pair.both++;
        const aPnl = a.paperPosition?.realizedMultiple == null || quoteOnlyInvalidation(a.paperPosition)
          ? null : Number(a.paperPosition.realizedMultiple);
        const bPnl = b.paperPosition?.realizedMultiple == null || quoteOnlyInvalidation(b.paperPosition)
          ? null : Number(b.paperPosition.realizedMultiple);
        if (aPnl == null || bPnl == null || Math.abs(aPnl - bPnl) < 1e-9) pair.ties++;
        else if (aPnl > bPnl) pair.aWins++;
        else pair.bWins++;
        pairs.set(key, pair);
      }
    }
  }
  if (!pairs.size) lines.push('insufficient paired signals');
  for (const [key, pair] of [...pairs.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`${key}: pools=${pair.both} firstWins=${pair.aWins} secondWins=${pair.bWins} tiesOrOpen=${pair.ties}`);
  }

  lines.push('', 'FROZEN V1 SAMPLE GATE');
  for (const chain of ['base', 'ethereum']) {
    const uniqueTriggered = new Set(valid
      .filter((watch) => watch.chain === chain && watch.signals.some((signal: AnyRow) =>
        !['LATE_SHADOW', 'REORG_INVALIDATED'].includes(signal.status),
      ))
      .map(marketKey));
    lines.push(`${chain}: ${uniqueTriggered.size}/100 unique triggered pools; thresholds remain frozen`);
  }

  console.log(lines.join('\n'));
}

main()
  .catch((error) => { console.error('Fatal:', error); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
