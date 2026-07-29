import { PrismaClient } from '@prisma/client';

type Row = {
  id: string;
  openedAt: Date;
  sizeUsd: unknown;
  realizedValueUsd: unknown;
  realizedMultiple: unknown;
  modeledSlippagePct: unknown;
  onchainLiqEntryUsd: unknown;
  executedRungs: string;
  liquidityModel: string;
  entryFeatures: unknown;
};

type Sample = {
  id: string;
  openedAtMs: number;
  pnlUsd: number;
  full2xPnlUsd: number;
  reached2x: boolean;
  entrySlip: number | null;
  source: string;
  amm: string;
  scoreBand: string;
  features: Record<string, string>;
};

const prisma = new PrismaClient();
const CUTOFF = new Date('2026-07-23T12:00:00.000Z');
const STRATEGY = 'robinhood_stages_v2_shadow';

function numeric(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function bin(value: number | null, edges: readonly number[], labels: readonly string[]): string {
  if (value == null) return 'UNKNOWN';
  for (let index = 0; index < edges.length; index++) {
    if (value <= edges[index]) return labels[index];
  }
  return labels[labels.length - 1];
}

function entryFeatures(row: Row): Record<string, unknown> {
  return row.entryFeatures != null && typeof row.entryFeatures === 'object'
    ? row.entryFeatures as Record<string, unknown>
    : {};
}

function toSample(row: Row): Sample | null {
  const sizeUsd = numeric(row.sizeUsd);
  const proceedsUsd = numeric(row.realizedValueUsd);
  if (!(sizeUsd != null && sizeUsd > 0 && proceedsUsd != null)) return null;
  const feature = entryFeatures(row);
  const slip = numeric(row.modeledSlippagePct);
  const tvl = numeric(row.onchainLiqEntryUsd);
  const fdv = numeric(feature.fdvUsd);
  const fdvToTvl = fdv != null && tvl != null && tvl > 0 ? fdv / tvl : null;
  const reached2x = row.executedRungs
    .split(',')
    .map(Number)
    .some((multiple) => Number.isFinite(multiple) && multiple >= 2);
  return {
    id: row.id,
    openedAtMs: row.openedAt.getTime(),
    pnlUsd: proceedsUsd - sizeUsd,
    // A rung is an observed executable 2x fill. Winners are deliberately capped
    // at exactly 2x so one runner cannot manufacture this hypothesis.
    full2xPnlUsd: reached2x ? sizeUsd : proceedsUsd - sizeUsd,
    reached2x,
    entrySlip: slip,
    source: String(feature.discoverySource ?? 'UNKNOWN'),
    amm: row.liquidityModel || 'UNKNOWN',
    scoreBand: String(feature.band ?? 'UNKNOWN'),
    features: {
      entry_friction: bin(
        slip,
        [0.0025, 0.005, 0.01, 0.02, 0.03],
        ['<=0.25%', '0.25-0.5%', '0.5-1%', '1-2%', '2-3%', '>3%'],
      ),
      entry_tvl: bin(
        tvl,
        [5_000, 10_000, 50_000, 100_000],
        ['<=$5k', '$5-10k', '$10-50k', '$50-100k', '>$100k'],
      ),
      fdv_to_tvl: bin(
        fdvToTvl,
        [0.5, 1, 2, 5, 10],
        ['<=0.5', '0.5-1', '1-2', '2-5', '5-10', '>10'],
      ),
      amm: row.liquidityModel || 'UNKNOWN',
      source: String(feature.discoverySource ?? 'UNKNOWN'),
      score_band: String(feature.band ?? 'UNKNOWN'),
    },
  };
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function summary(samples: readonly Sample[]): {
  n: number;
  x2Rate: number;
  actualEv: number;
  full2xEv: number;
  full2xExTop1: number;
  full2xExTop3: number;
} {
  const pnl = samples.map((sample) => sample.full2xPnlUsd).sort((left, right) => right - left);
  return {
    n: samples.length,
    x2Rate: samples.length
      ? samples.filter((sample) => sample.reached2x).length / samples.length
      : 0,
    actualEv: samples.length ? sum(samples.map((sample) => sample.pnlUsd)) / samples.length : 0,
    full2xEv: samples.length ? sum(pnl) / samples.length : 0,
    full2xExTop1: sum(pnl.slice(1)),
    full2xExTop3: sum(pnl.slice(3)),
  };
}

function money(value: number): string {
  return `${value < 0 ? '-' : ''}$${Math.abs(value).toFixed(2)}`;
}

function line(label: string, samples: readonly Sample[]): string {
  const metric = summary(samples);
  return `${label}: n=${metric.n} x2=${(metric.x2Rate * 100).toFixed(1)}% ` +
    `actualEV=${money(metric.actualEv)} full2xEV=${money(metric.full2xEv)} ` +
    `full2xExTop1=${money(metric.full2xExTop1)} full2xExTop3=${money(metric.full2xExTop3)}`;
}

function chronologicalFolds(samples: readonly Sample[]): Sample[][] {
  const ordered = [...samples].sort((left, right) => left.openedAtMs - right.openedAtMs);
  return [0, 1, 2].map((fold) => {
    const start = Math.floor(ordered.length * fold / 3);
    const end = Math.floor(ordered.length * (fold + 1) / 3);
    return ordered.slice(start, end);
  });
}

async function main(): Promise<void> {
  const rows = await prisma.paperPosition.findMany({
    where: {
      chain: 'robinhood',
      strategyVersion: STRATEGY,
      status: 'CLOSED',
      openedAt: { gte: CUTOFF },
    },
    orderBy: { openedAt: 'asc' },
    select: {
      id: true,
      openedAt: true,
      sizeUsd: true,
      realizedValueUsd: true,
      realizedMultiple: true,
      modeledSlippagePct: true,
      onchainLiqEntryUsd: true,
      executedRungs: true,
      liquidityModel: true,
      entryFeatures: true,
    },
  }) as unknown as Row[];
  const samples = rows.flatMap((row) => {
    const sample = toSample(row);
    return sample == null ? [] : [sample];
  });
  const lines = [
    `ROBINHOOD EDGE AUDIT ${new Date().toISOString()}`,
    `cutoff=${CUTOFF.toISOString()} strategy=${STRATEGY}`,
    'Post-hoc hypothesis audit only. No runtime threshold is changed.',
    'Winner proceeds are conservatively replaced with exactly 2x.',
    line('ALL', samples),
    '',
    'PRE-SPECIFIED INTERSECTIONS (post-hoc; forward registration required)',
  ];
  const intersections: Array<[string, (sample: Sample) => boolean]> = [
    ['friction<=1%', (sample) => sample.entrySlip != null && sample.entrySlip <= 0.01],
    ['friction<=0.5%', (sample) => sample.entrySlip != null && sample.entrySlip <= 0.005],
    ['gecko & friction<=1%', (sample) =>
      sample.source === 'geckoterminal' && sample.entrySlip != null && sample.entrySlip <= 0.01],
    ['gecko & friction<=0.5%', (sample) =>
      sample.source === 'geckoterminal' && sample.entrySlip != null && sample.entrySlip <= 0.005],
    ['V2 & friction<=1%', (sample) =>
      sample.amm === 'V2' && sample.entrySlip != null && sample.entrySlip <= 0.01],
    ['watchlist & friction<=1%', (sample) =>
      sample.scoreBand === 'watchlist' && sample.entrySlip != null && sample.entrySlip <= 0.01],
  ];
  for (const [label, predicate] of intersections) {
    const cohort = samples.filter(predicate);
    lines.push(line(label, cohort));
    chronologicalFolds(cohort).forEach((fold, index) => {
      lines.push(`  fold${index + 1} ${line('', fold).trimStart()}`);
    });
  }
  for (const feature of ['entry_friction', 'entry_tvl', 'fdv_to_tvl', 'amm', 'source', 'score_band']) {
    lines.push('', feature.toUpperCase());
    const values = [...new Set(samples.map((sample) => sample.features[feature]))];
    for (const value of values) {
      const cohort = samples.filter((sample) => sample.features[feature] === value);
      if (cohort.length < 10) continue;
      lines.push(line(value, cohort));
      chronologicalFolds(cohort).forEach((fold, index) => {
        lines.push(`  fold${index + 1} ${line('', fold).trimStart()}`);
      });
    }
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
