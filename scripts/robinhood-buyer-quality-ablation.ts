import { PrismaClient } from '@prisma/client';
import {
  summarizeArm,
  type ResolvedArmSample,
} from '../src/flow/robinhood-experiment-metrics';
import { ROBINHOOD_FLOW_V3_CONFIG_HASH } from '../src/flow/robinhood-flow-v3';

type AnyRow = Record<string, any>;
type ResearchSample = ResolvedArmSample & {
  feature: number | null;
  reached2x: boolean | null;
  outcomeClass: string | null;
};

const prisma = new PrismaClient();
const FEATURE_SCHEMA = 'robinhood_buyer_quality_shadow_v1';

async function main(): Promise<void> {
  const experiments: AnyRow[] = await (prisma as any).robinhoodEntryExperiment.findMany({
    where: {
      configHash: ROBINHOOD_FLOW_V3_CONFIG_HASH,
      status: 'RESOLVED',
      invalidReason: null,
    },
    include: { watch: true, arms: true },
    orderBy: { t0At: 'asc' },
  });
  const baselineArm = process.env.ROBINHOOD_ABLATION_ARM ?? 'EXIT_A_FULL_2X';
  const eligible = experiments.filter((experiment) =>
    experiment.confirmationSnapshot?.featureSchemaVersion === FEATURE_SCHEMA &&
    experiment.arms.some((arm: AnyRow) =>
      arm.armCode === baselineArm &&
      arm.scenarioCode === 'OBSERVED_ENTRY' &&
      ['CLOSED', 'NO_TRADE'].includes(arm.status),
    ),
  );
  const featureReaders: Array<[string, (experiment: AnyRow) => number | null]> = [
    ['organic_flow_ratio_60s', (row) => finite(row.confirmationSnapshot?.buyerQuality?.windows?.['60s']?.organicFlowRatio)],
    ['buyer_retention_rate_0_60s', (row) => finite(
      row.confirmationSnapshot?.buyerQuality?.retention?.cohort_0_60s?.buyerRetentionRate,
    )],
    ['absorption_ratio_60s', (row) => finite(
      row.confirmationSnapshot?.buyerQuality?.firstMajorSell?.absorptionRatio60s,
    )],
    ['legacy_score', (row) => legacyScore(row.watch?.candidateJson)],
  ];
  const lines = [
    `ROBINHOOD BUYER-QUALITY ABLATION ${new Date().toISOString()}`,
    `config_hash=${ROBINHOOD_FLOW_V3_CONFIG_HASH}`,
    `feature_schema=${FEATURE_SCHEMA}`,
    `fixed_outcome_arm=${baselineArm}`,
    `resolved_forward_signals=${eligible.length}`,
    'buyer-quality remains observational; quantile membership never changes entry, size, or exit.',
    '',
    metricLine('BASELINE_ALL', eligible.map((experiment) => sample(experiment, baselineArm, null))),
  ];
  for (const [featureName, read] of featureReaders) {
    const samples = eligible.map((experiment) => sample(experiment, baselineArm, read(experiment)));
    lines.push('', `FEATURE ${featureName}`);
    for (const [label, rows] of quantileGroups(samples)) lines.push(metricLine(label, rows));
  }
  lines.push(
    '',
    'Interpretation guardrail: only a stable, reasonably monotonic forward relationship is hypothesis-worthy.',
    'No threshold optimization or strategy promotion is performed by this report.',
  );
  process.stdout.write(lines.join('\n') + '\n');
}

function sample(experiment: AnyRow, armCode: string, feature: number | null): ResearchSample {
  const arm = experiment.arms.find((row: AnyRow) =>
    row.armCode === armCode && row.scenarioCode === 'OBSERVED_ENTRY',
  );
  return {
    experimentId: experiment.id,
    t0AtMs: experiment.t0At.getTime(),
    armCode,
    scenarioCode: 'OBSERVED_ENTRY',
    committedUsd: Number(arm.committedUsd),
    realizedUsd: Number(arm.realizedValueUsd),
    capitalSeconds: Number(arm.capitalSeconds),
    feature,
    reached2x: experiment.classifierReached2x,
    outcomeClass: arm.outcomeClass,
  };
}

function quantileGroups(samples: ResearchSample[]): Array<[string, ResearchSample[]]> {
  const known = samples.filter((row) => row.feature != null).sort((left, right) =>
    left.feature! - right.feature! || left.t0AtMs - right.t0AtMs);
  const groups: Array<[string, ResearchSample[]]> = [
    ['Q1_BOTTOM_20', []],
    ['Q2_20_40', []],
    ['Q3_40_60', []],
    ['Q4_60_80', []],
    ['Q5_TOP_20', []],
  ];
  known.forEach((row, index) => {
    const bucket = Math.min(4, Math.floor(index * 5 / Math.max(1, known.length)));
    groups[bucket][1].push(row);
  });
  groups.push(['UNKNOWN', samples.filter((row) => row.feature == null)]);
  return groups;
}

function metricLine(label: string, samples: ResearchSample[]): string {
  const metrics = summarizeArm(samples);
  const pnl = samples.map((row) => row.realizedUsd - row.committedUsd).sort((a, b) => a - b);
  const rugs = samples.filter((row) => /RUG|UNSELLABLE|HARD_RISK/i.test(row.outcomeClass ?? '')).length;
  const known2x = samples.filter((row) => row.reached2x != null);
  const precision2x = known2x.length
    ? known2x.filter((row) => row.reached2x).length / known2x.length
    : null;
  return `${label}: n=${samples.length} rawEV=${money(metrics.rawEvUsd)} cap10EV=${money(metrics.capped10xEvUsd)} ` +
    `medianPnL=${money(percentile(pnl, 0.5) ?? 0)} total=${money(metrics.totalPnlUsd)} ` +
    `exTop1=${money(metrics.pnlWithoutTop1Usd)} exTop3=${money(metrics.pnlWithoutTop3Usd)} ` +
    `PF=${format(metrics.profitFactor)} DD=${money(metrics.maxDrawdownUsd)} ` +
    `2x=${percent(precision2x)} rugs=${percent(samples.length ? rugs / samples.length : null)} ` +
    `EV/capitalHour=${metrics.evPerCapitalHour == null ? 'n/a' : money(metrics.evPerCapitalHour)}`;
}

function legacyScore(candidateJson: unknown): number | null {
  const row = (candidateJson ?? {}) as AnyRow;
  return finite(row.finalScore ?? row.score?.finalScore ?? row.scoreSnapshot?.finalScore);
}

function finite(value: unknown): number | null {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function percentile(sorted: readonly number[], q: number): number | null {
  if (!sorted.length) return null;
  return sorted[Math.floor((sorted.length - 1) * q)];
}

function money(value: number): string {
  return `${value < 0 ? '-' : ''}$${Math.abs(value).toFixed(4)}`;
}

function format(value: number | null): string {
  return value == null ? 'n/a' : Number.isFinite(value) ? value.toFixed(4) : 'inf';
}

function percent(value: number | null): string {
  return value == null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

void main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
