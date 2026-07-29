import { PrismaClient } from '@prisma/client';
import {
  bootstrapMeanConfidenceInterval,
  pairedPnlDifferences,
  summarizeArm,
  type ResolvedArmSample,
} from '../src/flow/robinhood-experiment-metrics';
import {
  ROBINHOOD_EXIT_EXPERIMENT_CONFIG,
  ROBINHOOD_EXIT_EXPERIMENT_CONFIG_HASH,
  ROBINHOOD_FLOW_V3_CONFIG_HASH,
} from '../src/flow/robinhood-flow-v3';

type AnyRow = Record<string, any>;
const prisma = new PrismaClient();
const CONFIRMATORY = ['A_IMMEDIATE_20', 'B_PROBE_4_ADD_16', 'C_CONFIRM_20'] as const;
const ALL_ARMS = [...CONFIRMATORY, 'D_PROBE_2_ADD_18', 'E_PROBE_10_ADD_10'] as const;
const EXIT_ARMS = ['EXIT_A_FULL_2X', 'EXIT_B_LADDER_80_15_5', 'EXIT_C_90_10'] as const;

function sample(experiment: AnyRow, arm: AnyRow): ResolvedArmSample {
  return {
    experimentId: experiment.id,
    t0AtMs: experiment.t0At.getTime(),
    armCode: arm.armCode,
    scenarioCode: arm.scenarioCode,
    committedUsd: Number(arm.committedUsd),
    realizedUsd: Number(arm.realizedValueUsd),
    capitalSeconds: Number(arm.capitalSeconds),
  };
}

function money(value: number): string {
  return `${value < 0 ? '-' : ''}$${Math.abs(value).toFixed(4)}`;
}

function number(value: number | null, suffix = ''): string {
  if (value == null) return '?';
  if (!Number.isFinite(value)) return `inf${suffix}`;
  return `${value.toFixed(4)}${suffix}`;
}

function metricLine(label: string, samples: ResolvedArmSample[]): string {
  const metric = summarizeArm(samples);
  return `${label}: n=${metric.samples} rawEV=${money(metric.rawEvUsd)} cap10EV=${money(metric.capped10xEvUsd)} ` +
    `total=${money(metric.totalPnlUsd)} exTop1=${money(metric.pnlWithoutTop1Usd)} exTop3=${money(metric.pnlWithoutTop3Usd)} ` +
    `PF=${number(metric.profitFactor)} winnerMed=${number(metric.medianWinnerMultiple, 'x')} ` +
    `P75=${number(metric.p75WinnerMultiple, 'x')} P90=${number(metric.p90WinnerMultiple, 'x')} ` +
    `maxDD=${money(metric.maxDrawdownUsd)} capital=$${metric.capitalUtilizedUsd.toFixed(2)} ` +
    `capitalHours=${metric.capitalHours.toFixed(2)} EV/capitalHour=${metric.evPerCapitalHour == null ? '?' : money(metric.evPerCapitalHour)}`;
}

async function main(): Promise<void> {
  const allExperiments: AnyRow[] = await (prisma as any).robinhoodEntryExperiment.findMany({
    where: {
      configHash: ROBINHOOD_FLOW_V3_CONFIG_HASH,
    },
    include: { arms: true },
    orderBy: { t0At: 'asc' },
  });
  const experiments = allExperiments.filter((experiment) =>
    experiment.status === 'RESOLVED' && experiment.invalidReason == null,
  );
  const resolved = experiments.filter((experiment) =>
    experiment.arms.every((arm: AnyRow) => ['CLOSED', 'NO_TRADE'].includes(arm.status)),
  );
  const primary = new Map<string, ResolvedArmSample[]>();
  for (const armCode of ALL_ARMS) {
    primary.set(armCode, resolved.flatMap((experiment) => {
      const arm = experiment.arms.find((item: AnyRow) => item.armCode === armCode && item.scenarioCode === 'OBSERVED_ENTRY');
      return arm ? [sample(experiment, arm)] : [];
    }));
  }

  const lines = [
    `ROBINHOOD ENTRY EXPERIMENT V1 ${new Date().toISOString()}`,
    `configHash=${ROBINHOOD_FLOW_V3_CONFIG_HASH}`,
    `resolvedUniqueSignals=${resolved.length} ` +
      `invalidatedExcluded=${allExperiments.filter((experiment) => experiment.status === 'INVALIDATED').length} ` +
      `activeExcluded=${allExperiments.filter((experiment) => !['RESOLVED', 'INVALIDATED'].includes(experiment.status)).length}`,
    resolved.length < 100
      ? 'stage=DIAGNOSTICS_ONLY (<100); no arm selection is permitted'
      : resolved.length < 300
        ? 'stage=FROZEN_FORWARD_COLLECTION (100-299); thresholds remain frozen'
        : 'stage=CONFIRMATORY_EVALUATION (>=300); A/B/C may be compared, live remains forbidden',
    '',
    'OBSERVED EXECUTION LEADERBOARD',
    ...ALL_ARMS.map((arm) => metricLine(arm, primary.get(arm)!)),
    '',
    'PAIRED BOOTSTRAP (pool-level PnL differences, 95% CI)',
  ];
  const comparisons: Array<[string, string]> = [
    ['B_PROBE_4_ADD_16', 'A_IMMEDIATE_20'],
    ['B_PROBE_4_ADD_16', 'C_CONFIRM_20'],
    ['C_CONFIRM_20', 'A_IMMEDIATE_20'],
  ];
  for (const [left, right] of comparisons) {
    const differences = pairedPnlDifferences(primary.get(left)!, primary.get(right)!);
    const ci = bootstrapMeanConfidenceInterval(differences);
    lines.push(`${left} - ${right}: n=${differences.length} ` +
      (ci ? `mean=${money(ci.mean)} CI=[${money(ci.lower95)}, ${money(ci.upper95)}]` : 'insufficient data'));
  }

  const completeExitSignals = resolved.filter((experiment) => EXIT_ARMS.every((armCode) =>
    experiment.arms.some((arm: AnyRow) => arm.armCode === armCode && arm.scenarioCode === 'OBSERVED_ENTRY'),
  ));
  const pairedExitSignals = completeExitSignals.filter((experiment) => EXIT_ARMS.every((armCode) => {
    const arm = experiment.arms.find((item: AnyRow) =>
      item.armCode === armCode && item.scenarioCode === 'OBSERVED_ENTRY',
    );
    return arm?.stateJson?.benchmarkEntryEligible === true &&
      Number(arm.stateJson?.observedEntryLatenessMs ?? Infinity) <=
        ROBINHOOD_EXIT_EXPERIMENT_CONFIG.maxBenchmarkEntryLatencyMs;
  }));
  const exitPrimary = new Map<string, ResolvedArmSample[]>();
  for (const armCode of EXIT_ARMS) {
    exitPrimary.set(armCode, pairedExitSignals.flatMap((experiment) => {
      const arm = experiment.arms.find((item: AnyRow) => item.armCode === armCode && item.scenarioCode === 'OBSERVED_ENTRY');
      return arm ? [sample(experiment, arm)] : [];
    }));
  }
  lines.push(
    '',
    'PAIRED EXIT EXPERIMENT V1 (same signal, entry quote, latency, stops and costs)',
    `exitConfigHash=${ROBINHOOD_EXIT_EXPERIMENT_CONFIG_HASH}`,
    `resolvedPairedSignals=${pairedExitSignals.length}`,
    `lateExecutionSignalsExcluded=${completeExitSignals.length - pairedExitSignals.length}`,
    pairedExitSignals.length < 100 ? 'stage=DIAGNOSTICS_ONLY (<100); no exit-policy selection is permitted'
      : pairedExitSignals.length < 300 ? 'stage=FROZEN_FORWARD_COLLECTION (100-299)'
        : 'stage=CONFIRMATORY_EVALUATION (>=300); fresh 200-signal holdout remains required',
    'OBSERVED EXIT LEADERBOARD',
    ...EXIT_ARMS.map((arm) => metricLine(arm, exitPrimary.get(arm)!)),
    'PAIRED EXIT BOOTSTRAP (95% CI)',
  );
  for (const [left, right] of [
    ['EXIT_A_FULL_2X', 'EXIT_B_LADDER_80_15_5'],
    ['EXIT_C_90_10', 'EXIT_B_LADDER_80_15_5'],
    ['EXIT_A_FULL_2X', 'EXIT_C_90_10'],
  ]) {
    const differences = pairedPnlDifferences(exitPrimary.get(left)!, exitPrimary.get(right)!);
    const ci = bootstrapMeanConfidenceInterval(differences);
    lines.push(`${left} - ${right}: n=${differences.length} ` +
      (ci ? `mean=${money(ci.mean)} CI=[${money(ci.lower95)}, ${money(ci.upper95)}]` : 'insufficient data'));
  }

  const confusion = { tp: 0, fp: 0, fn: 0, tn: 0, unavailable: 0 };
  for (const experiment of resolved) {
    if (experiment.classifierReferenceStatus !== 'RESOLVED' || experiment.classifierReached2x == null) {
      confusion.unavailable++;
      continue;
    }
    const confirmed = experiment.confirmationStatus === 'CONFIRMED';
    const winner = experiment.classifierReached2x === true;
    if (confirmed && winner) confusion.tp++;
    else if (confirmed) confusion.fp++;
    else if (winner) confusion.fn++;
    else confusion.tn++;
  }
  const precision = confusion.tp + confusion.fp > 0 ? confusion.tp / (confusion.tp + confusion.fp) : null;
  const recall = confusion.tp + confusion.fn > 0 ? confusion.tp / (confusion.tp + confusion.fn) : null;
  lines.push(
    '',
    'FLOW V3 CONFIRMATION CLASSIFIER',
    `TP=${confusion.tp} FP=${confusion.fp} FN=${confusion.fn} TN=${confusion.tn} unavailable=${confusion.unavailable} ` +
      `precision=${precision == null ? '?' : (precision * 100).toFixed(1) + '%'} ` +
      `recall=${recall == null ? '?' : (recall * 100).toFixed(1) + '%'}`,
    '',
    'ACCEPTANCE GUARDRAILS',
    'D/E are exploratory and cannot be promoted from this sample.',
    'Any selected A/B/C arm still requires a fresh 200-signal holdout.',
    'Live remains forbidden. A later holdout must add an independently specified execution-cost stress test.',
  );
  console.log(lines.join('\n'));
}

main()
  .catch((error) => { console.error('Fatal:', error); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
