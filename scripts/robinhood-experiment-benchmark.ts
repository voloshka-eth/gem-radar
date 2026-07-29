import { PrismaClient } from '@prisma/client';
import {
  bootstrapMeanConfidenceInterval,
  pairedPnlDifferences,
  summarizeArm,
  type ResolvedArmSample,
} from '../src/flow/robinhood-experiment-metrics';
import { reconcileRobinhoodArm } from '../src/flow/robinhood-experiment-accounting';
import {
  evaluateRobinhoodBankrollReadiness,
  ROBINHOOD_EXIT_ARM_CODES,
  type RobinhoodExitArmCode,
} from '../src/flow/robinhood-bankroll-readiness';
import {
  ROBINHOOD_PAPER_BANKROLL_POLICY,
  ROBINHOOD_PAPER_BANKROLL_POLICY_HASH,
} from '../src/flow/robinhood-paper-bankroll';
import {
  evaluateRobinhoodGeckoLaneReadiness,
  ROBINHOOD_GECKO_LANE_CONFIG,
  ROBINHOOD_GECKO_LANE_CONFIG_HASH,
} from '../src/flow/robinhood-gecko-lane';
import {
  classifyRobinhoodFriction,
  ROBINHOOD_EXIT_EXPERIMENT_CONFIG,
  ROBINHOOD_EXIT_EXPERIMENT_CONFIG_HASH,
  ROBINHOOD_FRICTION_FEATURE_SCHEMA,
  ROBINHOOD_FRICTION_FEATURE_SCHEMA_HASH,
  ROBINHOOD_FLOW_V3_CONFIG_HASH,
} from '../src/flow/robinhood-flow-v3';

type AnyRow = Record<string, any>;
const prisma = new PrismaClient();
const CONFIRMATORY = ['A_IMMEDIATE_20', 'B_PROBE_4_ADD_16', 'C_CONFIRM_20'] as const;
const ALL_ARMS = [...CONFIRMATORY, 'D_PROBE_2_ADD_18', 'E_PROBE_10_ADD_10'] as const;
const EXIT_ARMS = ROBINHOOD_EXIT_ARM_CODES;
const FRICTION_DETAIL_COHORTS = [
  'BOTH_LE_0_5',
  'BOTH_LE_1',
  'SELL_LE_1_BUY_1_3',
  'BUY_LE_1_SELL_1_3',
  'BOTH_1_3',
] as const;
const FORWARD_START_AT = new Date('2026-07-26T23:05:55.000Z');
function sample(experiment: AnyRow, arm: AnyRow): ResolvedArmSample {
  const accounting = reconcileRobinhoodArm(arm);
  return {
    experimentId: experiment.id,
    t0AtMs: experiment.t0At.getTime(),
    armCode: arm.armCode,
    scenarioCode: arm.scenarioCode,
    committedUsd: accounting.entryAndFailedCostsUsd,
    realizedUsd: accounting.exitProceedsUsd,
    capitalSeconds: Number(arm.capitalSeconds),
  };
}

function experimentReconciles(experiment: AnyRow): boolean {
  return experiment.arms.every((arm: AnyRow) => reconcileRobinhoodArm(arm).valid);
}

function frictionCohort(experiment: AnyRow): string {
  const executedArm = experiment.arms.find((arm: AnyRow) =>
    EXIT_ARMS.includes(arm.armCode) && arm.stateJson?.frictionCohort,
  );
  return executedArm?.stateJson?.frictionCohort ?? experiment.frictionCohort ?? 'LEGACY_UNCLASSIFIED';
}

function frictionDetailCohort(experiment: AnyRow): string {
  const executedArm = experiment.arms.find((arm: AnyRow) =>
    EXIT_ARMS.includes(arm.armCode) && arm.stateJson?.frictionDetailCohort,
  );
  const persisted = executedArm?.stateJson?.frictionDetailCohort ??
    experiment.dataHealthSnapshot?.frictionDetailCohort;
  if (typeof persisted === 'string') return persisted;
  const buyImpact = Number(experiment.t0BuyImpactPct);
  const sellImpact = Number(experiment.t0SellImpactPct);
  return Number.isFinite(buyImpact) && Number.isFinite(sellImpact)
    ? classifyRobinhoodFriction(buyImpact, sellImpact)
    : 'LEGACY_UNCLASSIFIED';
}

function discoverySource(experiment: AnyRow): string {
  const executedArm = experiment.arms.find((arm: AnyRow) =>
    EXIT_ARMS.includes(arm.armCode) && arm.stateJson?.discoverySource,
  );
  return executedArm?.stateJson?.discoverySource ??
    experiment.dataHealthSnapshot?.discoverySource ??
    'LEGACY_UNCLASSIFIED';
}

function usesCurrentMeasurementSchema(experiment: AnyRow): boolean {
  const health = experiment.dataHealthSnapshot;
  const pairedExitArm = experiment.arms.find((arm: AnyRow) =>
    arm.armCode === 'EXIT_A_FULL_2X' &&
    arm.scenarioCode === 'OBSERVED_ENTRY',
  );
  return health?.frictionFeatureHash === ROBINHOOD_FRICTION_FEATURE_SCHEMA_HASH &&
    health?.bankrollPolicyHash === ROBINHOOD_PAPER_BANKROLL_POLICY_HASH &&
    pairedExitArm?.stateJson?.exitConfigHash === ROBINHOOD_EXIT_EXPERIMENT_CONFIG_HASH;
}

function usesCurrentGeckoLaneSchema(experiment: AnyRow): boolean {
  return experiment.dataHealthSnapshot?.geckoLaneHash === ROBINHOOD_GECKO_LANE_CONFIG_HASH;
}

function exitSamples(
  experiments: AnyRow[],
  armCode: string,
  scenarioCode = 'OBSERVED_ENTRY',
): ResolvedArmSample[] {
  return experiments.flatMap((experiment) => {
    const arm = experiment.arms.find((item: AnyRow) =>
      item.armCode === armCode && item.scenarioCode === scenarioCode,
    );
    return arm ? [sample(experiment, arm)] : [];
  });
}

function geckoLanePolicySamples(
  experiments: AnyRow[],
  scenarioCode: string,
): ResolvedArmSample[] {
  return experiments.flatMap((experiment) => {
    const arm = experiment.arms.find((item: AnyRow) =>
      item.armCode === ROBINHOOD_GECKO_LANE_CONFIG.fixedExitArm &&
      item.scenarioCode === scenarioCode,
    );
    if (!arm) return [];
    const counterfactual = sample(experiment, arm);
    if (experiment.dataHealthSnapshot?.geckoLaneBankrollEligible === true) {
      return [counterfactual];
    }
    return [{
      ...counterfactual,
      committedUsd: 0,
      realizedUsd: 0,
      capitalSeconds: 0,
    }];
  });
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
  const [allExperiments, forwardWatches]: [AnyRow[], AnyRow[]] = await Promise.all([
    (prisma as any).robinhoodEntryExperiment.findMany({
      where: {
        configHash: ROBINHOOD_FLOW_V3_CONFIG_HASH,
      },
      include: { arms: { include: { legs: true } } },
      orderBy: { t0At: 'asc' },
    }),
    (prisma as any).evmPoolWatch.findMany({
      where: {
        chain: 'robinhood',
        watchType: 'FRESH',
        discoveredAt: { gte: FORWARD_START_AT },
      },
      select: {
        id: true,
        latestDataHealth: true,
        robinhoodExperiments: {
          where: { configHash: ROBINHOOD_FLOW_V3_CONFIG_HASH },
          select: { id: true },
          take: 1,
        },
      },
    }),
  ]);
  const attemptReasons = new Map<string, number>();
  let noAttemptSnapshot = 0;
  let experimentWatches = 0;
  for (const watch of forwardWatches) {
    if (watch.robinhoodExperiments.length > 0) experimentWatches++;
    const attempt = watch.latestDataHealth?.robinhoodExperiment;
    const reason = typeof attempt?.reason === 'string' ? attempt.reason : null;
    if (reason == null) {
      noAttemptSnapshot++;
      continue;
    }
    attemptReasons.set(reason, (attemptReasons.get(reason) ?? 0) + 1);
  }
  const funnelReasons = [...attemptReasons.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([reason, count]) => `${reason}=${count}`)
    .join(', ');
  const measurementExperiments = allExperiments.filter(usesCurrentMeasurementSchema);
  const experiments = measurementExperiments.filter((experiment) =>
    experiment.status === 'RESOLVED' && experiment.invalidReason == null,
  );
  const resolved = experiments.filter((experiment) =>
    experiment.arms.every((arm: AnyRow) => ['CLOSED', 'NO_TRADE'].includes(arm.status)),
  );
  const reconciledResolved = resolved.filter(experimentReconciles);
  const primary = new Map<string, ResolvedArmSample[]>();
  for (const armCode of ALL_ARMS) {
    primary.set(armCode, reconciledResolved.flatMap((experiment) => {
      const arm = experiment.arms.find((item: AnyRow) => item.armCode === armCode && item.scenarioCode === 'OBSERVED_ENTRY');
      return arm ? [sample(experiment, arm)] : [];
    }));
  }

  const lines = [
    `ROBINHOOD ENTRY EXPERIMENT V1 ${new Date().toISOString()}`,
    `configHash=${ROBINHOOD_FLOW_V3_CONFIG_HASH}`,
    `forwardStartAt=${FORWARD_START_AT.toISOString()}`,
    `freshWatchFunnel=${forwardWatches.length} experimentCreated=${experimentWatches} ` +
      `noAttemptSnapshot=${noAttemptSnapshot} reasons=${funnelReasons || 'none'}`,
    `resolvedUniqueSignals=${resolved.length} reconciled=${reconciledResolved.length} ` +
      `accountingMismatchExcluded=${resolved.length - reconciledResolved.length} ` +
      `currentMeasurementSchema=${measurementExperiments.length} ` +
      `legacySchemaExcluded=${allExperiments.length - measurementExperiments.length} ` +
      `invalidatedExcluded=${measurementExperiments.filter((experiment) => experiment.status === 'INVALIDATED').length} ` +
      `activeExcluded=${measurementExperiments.filter((experiment) => !['RESOLVED', 'INVALIDATED'].includes(experiment.status)).length}`,
    reconciledResolved.length < 100
      ? 'stage=DIAGNOSTICS_ONLY (<100); no arm selection is permitted'
      : reconciledResolved.length < 300
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

  const completeExitSignals = reconciledResolved.filter((experiment) => EXIT_ARMS.every((armCode) =>
    experiment.arms.some((arm: AnyRow) => arm.armCode === armCode && arm.scenarioCode === 'OBSERVED_ENTRY'),
  ));
  const pairedExitSignals = completeExitSignals.filter((experiment) => EXIT_ARMS.every((armCode) => {
    if (frictionCohort(experiment) !== 'LOW_FRICTION_PRIMARY') return false;
    const arm = experiment.arms.find((item: AnyRow) =>
      item.armCode === armCode && item.scenarioCode === 'OBSERVED_ENTRY',
    );
    return arm?.stateJson?.benchmarkEntryEligible === true &&
      Number(arm.stateJson?.observedEntryLatenessMs ?? Infinity) <=
        ROBINHOOD_EXIT_EXPERIMENT_CONFIG.maxBenchmarkEntryLatencyMs;
  }));
  const highFrictionShadowSignals = completeExitSignals.filter((experiment) => {
    if (frictionCohort(experiment) !== 'HIGH_FRICTION_SHADOW') return false;
    return EXIT_ARMS.every((armCode) => {
      const arm = experiment.arms.find((item: AnyRow) =>
        item.armCode === armCode && item.scenarioCode === 'OBSERVED_ENTRY',
      );
      return arm?.stateJson?.executionTimingEligible === true &&
        Number(arm.stateJson?.observedEntryLatenessMs ?? Infinity) <=
          ROBINHOOD_EXIT_EXPERIMENT_CONFIG.maxBenchmarkEntryLatencyMs;
    });
  });
  const bankrollLimitShadowSignals = completeExitSignals.filter((experiment) => {
    if (frictionCohort(experiment) !== 'BANKROLL_LIMIT_SHADOW') return false;
    return EXIT_ARMS.every((armCode) => {
      const arm = experiment.arms.find((item: AnyRow) =>
        item.armCode === armCode && item.scenarioCode === 'OBSERVED_ENTRY',
      );
      return arm?.stateJson?.executionTimingEligible === true &&
        Number(arm.stateJson?.observedEntryLatenessMs ?? Infinity) <=
          ROBINHOOD_EXIT_EXPERIMENT_CONFIG.maxBenchmarkEntryLatencyMs;
    });
  });
  const exitPrimary = new Map<string, ResolvedArmSample[]>();
  const exitStress = new Map<string, ResolvedArmSample[]>();
  const exitHighFriction = new Map<string, ResolvedArmSample[]>();
  const exitBankrollLimitShadow = new Map<string, ResolvedArmSample[]>();
  for (const armCode of EXIT_ARMS) {
    exitPrimary.set(armCode, exitSamples(pairedExitSignals, armCode));
    exitStress.set(armCode, exitSamples(pairedExitSignals, armCode, 'STRESS_1_BLOCK'));
    exitHighFriction.set(armCode, exitSamples(highFrictionShadowSignals, armCode));
    exitBankrollLimitShadow.set(armCode, exitSamples(bankrollLimitShadowSignals, armCode));
  }
  const detailSignals = new Map<string, AnyRow[]>();
  for (const detail of FRICTION_DETAIL_COHORTS) {
    detailSignals.set(detail, completeExitSignals.filter((experiment) => {
      if (frictionDetailCohort(experiment) !== detail) return false;
      return EXIT_ARMS.every((armCode) => {
        const arm = experiment.arms.find((item: AnyRow) =>
          item.armCode === armCode && item.scenarioCode === 'OBSERVED_ENTRY',
        );
        const eligibilityField = frictionCohort(experiment) === 'LOW_FRICTION_PRIMARY'
          ? arm?.stateJson?.benchmarkEntryEligible
          : arm?.stateJson?.executionTimingEligible;
        return eligibilityField === true &&
          Number(arm?.stateJson?.observedEntryLatenessMs ?? Infinity) <=
            ROBINHOOD_EXIT_EXPERIMENT_CONFIG.maxBenchmarkEntryLatencyMs;
      });
    }));
  }
  const observedByExitArm = Object.fromEntries(EXIT_ARMS.map((arm) => [
    arm,
    exitPrimary.get(arm) ?? [],
  ])) as Record<RobinhoodExitArmCode, ResolvedArmSample[]>;
  const stressByExitArm = Object.fromEntries(EXIT_ARMS.map((arm) => [
    arm,
    exitStress.get(arm) ?? [],
  ])) as Record<RobinhoodExitArmCode, ResolvedArmSample[]>;
  const primaryExperimentUniverse = measurementExperiments.filter(
    (experiment) => frictionCohort(experiment) === 'LOW_FRICTION_PRIMARY',
  );
  const invalidatedSignals = primaryExperimentUniverse.filter(
    (experiment) => experiment.status === 'INVALIDATED',
  ).length;
  const bankrollReadiness = evaluateRobinhoodBankrollReadiness({
    observedByArm: observedByExitArm,
    stressByArm: stressByExitArm,
    invalidatedSignals,
    totalSignals: primaryExperimentUniverse.length,
  });
  const geckoLaneSignals = completeExitSignals.filter((experiment) => {
    if (!usesCurrentGeckoLaneSchema(experiment)) return false;
    if (experiment.dataHealthSnapshot?.geckoLaneSignalEligible !== true) return false;
    return EXIT_ARMS.every((armCode) => {
      const arm = experiment.arms.find((item: AnyRow) =>
        item.armCode === armCode && item.scenarioCode === 'OBSERVED_ENTRY',
      );
      return arm?.stateJson?.executionTimingEligible === true &&
        Number(arm.stateJson?.observedEntryLatenessMs ?? Infinity) <=
          ROBINHOOD_EXIT_EXPERIMENT_CONFIG.maxBenchmarkEntryLatencyMs;
    });
  });
  const geckoLaneCounterfactualObserved = exitSamples(
    geckoLaneSignals,
    ROBINHOOD_GECKO_LANE_CONFIG.fixedExitArm,
  );
  const geckoLaneCounterfactualStress = exitSamples(
    geckoLaneSignals,
    ROBINHOOD_GECKO_LANE_CONFIG.fixedExitArm,
    'STRESS_1_BLOCK',
  );
  const geckoLaneObserved = geckoLanePolicySamples(
    geckoLaneSignals,
    'OBSERVED_ENTRY',
  );
  const geckoLaneStress = geckoLanePolicySamples(
    geckoLaneSignals,
    'STRESS_1_BLOCK',
  );
  const geckoLaneUniverse = measurementExperiments.filter((experiment) =>
    usesCurrentGeckoLaneSchema(experiment) &&
    experiment.dataHealthSnapshot?.geckoLaneSignalEligible === true,
  );
  const geckoLaneReadiness = evaluateRobinhoodGeckoLaneReadiness({
    observed: geckoLaneObserved,
    stress: geckoLaneStress,
    invalidatedSignals: geckoLaneUniverse.filter(
      (experiment) => experiment.status === 'INVALIDATED',
    ).length,
    totalSignals: geckoLaneUniverse.length,
  });
  lines.push(
    '',
    'PAIRED EXIT EXPERIMENT V1 (same signal, entry quote, latency, stops and costs)',
    `exitConfigHash=${ROBINHOOD_EXIT_EXPERIMENT_CONFIG_HASH}`,
    `bankrollPolicy=${ROBINHOOD_PAPER_BANKROLL_POLICY.version} ` +
      `hash=${ROBINHOOD_PAPER_BANKROLL_POLICY_HASH} ` +
      `bankroll=$${ROBINHOOD_PAPER_BANKROLL_POLICY.startingBankrollUsd} ` +
      `position=$${ROBINHOOD_PAPER_BANKROLL_POLICY.positionUsd} ` +
      `maxConcurrent=${ROBINHOOD_PAPER_BANKROLL_POLICY.maxConcurrentSignals} ` +
      `maxDaily=${ROBINHOOD_PAPER_BANKROLL_POLICY.maxNewSignalsPerUtcDay} ` +
      `dailyDD=$${ROBINHOOD_PAPER_BANKROLL_POLICY.maxIntradayDrawdownUsd}`,
    `resolvedPairedSignals=${pairedExitSignals.length}`,
    `resolvedHighFrictionShadowSignals=${highFrictionShadowSignals.length}`,
    `resolvedBankrollLimitShadowSignals=${bankrollLimitShadowSignals.length}`,
    `lateExecutionSignalsExcluded=${completeExitSignals.length - pairedExitSignals.length}`,
    pairedExitSignals.length < 100 ? 'stage=DIAGNOSTICS_ONLY (<100); no exit-policy selection is permitted'
      : pairedExitSignals.length < 300 ? 'stage=FROZEN_FORWARD_COLLECTION (100-299)'
        : 'stage=CONFIRMATORY_EVALUATION (>=300); fresh 200-signal holdout remains required',
    'OBSERVED EXIT LEADERBOARD',
    ...EXIT_ARMS.map((arm) => metricLine(arm, exitPrimary.get(arm)!)),
    'STRESS LEADERBOARD (+1 block latency, +30% gas; same primary market samples)',
    ...EXIT_ARMS.map((arm) => metricLine(arm, exitStress.get(arm)!)),
    'HIGH FRICTION SHADOW (1-3% actual entry impact; never mixed with primary)',
    ...EXIT_ARMS.map((arm) => metricLine(arm, exitHighFriction.get(arm)!)),
    'BANKROLL LIMIT SHADOW (counterfactual opportunity-cost audit; never mixed with primary)',
    ...EXIT_ARMS.map((arm) => metricLine(arm, exitBankrollLimitShadow.get(arm)!)),
    'FRICTION DETAIL COHORTS (observational; BOTH_LE_1 excludes BOTH_LE_0_5)',
    `featureSchema=${ROBINHOOD_FRICTION_FEATURE_SCHEMA.version} ` +
      `hash=${ROBINHOOD_FRICTION_FEATURE_SCHEMA_HASH}`,
  );
  for (const detail of FRICTION_DETAIL_COHORTS) {
    const signals = detailSignals.get(detail) ?? [];
    const sources = [...signals.reduce((counts, experiment) => {
      const source = discoverySource(experiment);
      counts.set(source, (counts.get(source) ?? 0) + 1);
      return counts;
    }, new Map<string, number>()).entries()]
      .sort((left, right) => right[1] - left[1])
      .map(([source, count]) => `${source}=${count}`)
      .join(',');
    lines.push(
      `${detail}: signals=${signals.length} sources=${sources || 'none'}`,
      ...EXIT_ARMS.map((arm) => metricLine(
        `  OBSERVED ${arm}`,
        exitSamples(signals, arm),
      )),
      ...EXIT_ARMS.map((arm) => metricLine(
        `  STRESS ${arm}`,
        exitSamples(signals, arm, 'STRESS_1_BLOCK'),
      )),
    );
  }
  lines.push(
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
  lines.push(
    '',
    'BANKROLL READINESS (pre-registered chronological 300 selection + 200 holdout)',
    `status=${bankrollReadiness.status} selectedArm=${bankrollReadiness.selectedArm ?? 'none'} ` +
      `selection=${bankrollReadiness.selectionSamples}/300 holdout=${bankrollReadiness.holdoutSamples}/200`,
    `pipelineInvalidationRate=${(bankrollReadiness.invalidationRate * 100).toFixed(2)}% ` +
      `reasons=${bankrollReadiness.reasons.join(',')}`,
    'PAPER_EDGE_VALIDATED is a research result only; liveExecution=false.',
    '',
    'GECKO LOW-FRICTION FIXED FULL-2X LANE (new untouched holdout)',
    `lane=${ROBINHOOD_GECKO_LANE_CONFIG.version} hash=${ROBINHOOD_GECKO_LANE_CONFIG_HASH}`,
    `fixedArm=${ROBINHOOD_GECKO_LANE_CONFIG.fixedExitArm} ` +
      `registeredAt=${ROBINHOOD_GECKO_LANE_CONFIG.registeredAt} ` +
      `eligibleSignals=${geckoLaneUniverse.length} resolved=${geckoLaneSignals.length} ` +
      `allocatedResolved=${geckoLaneSignals.filter((experiment) =>
        experiment.dataHealthSnapshot?.geckoLaneBankrollEligible === true).length} ` +
      `holdout=${geckoLaneReadiness.samples}/${ROBINHOOD_GECKO_LANE_CONFIG.holdoutSignals}`,
    metricLine('POLICY OBSERVED (capacity rejects = $0)', geckoLaneObserved),
    metricLine('POLICY STRESS (capacity rejects = $0)', geckoLaneStress),
    metricLine('ALL-ELIGIBLE COUNTERFACTUAL OBSERVED', geckoLaneCounterfactualObserved),
    metricLine('ALL-ELIGIBLE COUNTERFACTUAL STRESS', geckoLaneCounterfactualStress),
    `status=${geckoLaneReadiness.status} ` +
      `bootstrapLower95=${geckoLaneReadiness.bootstrapLower95Usd == null
        ? '?'
        : money(geckoLaneReadiness.bootstrapLower95Usd)} ` +
      `invalidationRate=${(geckoLaneReadiness.invalidationRate * 100).toFixed(2)}% ` +
      `reasons=${geckoLaneReadiness.reasons.join(',')}`,
    'This nested lane does not alter or reuse the v1 control decision.',
  );

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
    'Live remains forbidden. Holdout must also pass the frozen +1 block, +30% gas stress scenario.',
  );
  console.log(lines.join('\n'));
}

main()
  .catch((error) => { console.error('Fatal:', error); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
