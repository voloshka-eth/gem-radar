import {
  bootstrapMeanConfidenceInterval,
  pairedPnlDifferences,
  summarizeArm,
  type ArmMetricSummary,
  type ResolvedArmSample,
} from './robinhood-experiment-metrics';

export const ROBINHOOD_EXIT_ARM_CODES = [
  'EXIT_A_FULL_2X',
  'EXIT_B_LADDER_80_15_5',
  'EXIT_C_90_10',
] as const;

export type RobinhoodExitArmCode = typeof ROBINHOOD_EXIT_ARM_CODES[number];

export interface BankrollReadinessInput {
  observedByArm: Readonly<Record<RobinhoodExitArmCode, readonly ResolvedArmSample[]>>;
  stressByArm: Readonly<Record<RobinhoodExitArmCode, readonly ResolvedArmSample[]>>;
  invalidatedSignals: number;
  totalSignals: number;
  selectionSize?: number;
  holdoutSize?: number;
  maxDrawdownUsd?: number;
  maxInvalidationRate?: number;
}

export interface BankrollReadiness {
  status:
    | 'COLLECTING_SELECTION'
    | 'SELECTION_REJECTED'
    | 'COLLECTING_HOLDOUT'
    | 'HOLDOUT_REJECTED'
    | 'PAPER_EDGE_VALIDATED';
  selectedArm: RobinhoodExitArmCode | null;
  selectionSamples: number;
  holdoutSamples: number;
  invalidationRate: number;
  reasons: string[];
}

const CONTROL_ARM: RobinhoodExitArmCode = 'EXIT_B_LADDER_80_15_5';

export function evaluateRobinhoodBankrollReadiness(
  input: BankrollReadinessInput,
): BankrollReadiness {
  const selectionSize = input.selectionSize ?? 300;
  const holdoutSize = input.holdoutSize ?? 200;
  const maxDrawdownUsd = input.maxDrawdownUsd ?? 200;
  const maxInvalidationRate = input.maxInvalidationRate ?? 0.05;
  const orderedIds = pairedExperimentIds(input.observedByArm);
  const invalidationRate = input.totalSignals > 0
    ? input.invalidatedSignals / input.totalSignals
    : 0;
  if (orderedIds.length < selectionSize) {
    return {
      status: 'COLLECTING_SELECTION',
      selectedArm: null,
      selectionSamples: orderedIds.length,
      holdoutSamples: 0,
      invalidationRate,
      reasons: [`need_${selectionSize - orderedIds.length}_more_selection_signals`],
    };
  }

  const selectionIds = new Set(orderedIds.slice(0, selectionSize));
  const selection = mapSamples(input.observedByArm, selectionIds);
  const eligible = ROBINHOOD_EXIT_ARM_CODES
    .map((arm) => ({ arm, metric: summarizeArm(selection[arm]) }))
    .filter(({ arm, metric }) =>
      passesAbsolute(metric, maxDrawdownUsd) &&
      passesPairedControl(arm, selection),
    )
    .sort((left, right) => right.metric.capped10xEvUsd - left.metric.capped10xEvUsd);
  const selected = eligible[0]?.arm ?? null;
  if (selected == null) {
    return {
      status: 'SELECTION_REJECTED',
      selectedArm: null,
      selectionSamples: selectionSize,
      holdoutSamples: 0,
      invalidationRate,
      reasons: ['no_exit_policy_passed_selection_guardrails'],
    };
  }

  const holdoutIds = new Set(orderedIds.slice(selectionSize, selectionSize + holdoutSize));
  if (holdoutIds.size < holdoutSize) {
    return {
      status: 'COLLECTING_HOLDOUT',
      selectedArm: selected,
      selectionSamples: selectionSize,
      holdoutSamples: holdoutIds.size,
      invalidationRate,
      reasons: [`need_${holdoutSize - holdoutIds.size}_more_holdout_signals`],
    };
  }

  const holdout = mapSamples(input.observedByArm, holdoutIds);
  const stressHoldout = mapSamples(input.stressByArm, holdoutIds);
  const observedMetric = summarizeArm(holdout[selected]);
  const stressMetric = summarizeArm(stressHoldout[selected]);
  const reasons: string[] = [];
  if (stressHoldout[selected].length !== holdoutSize) {
    reasons.push('holdout_stress_sample_incomplete');
  }
  if (!passesAbsolute(observedMetric, maxDrawdownUsd)) {
    reasons.push('holdout_absolute_economics_failed');
  }
  if (!passesStress(stressMetric, maxDrawdownUsd)) {
    reasons.push('holdout_stress_economics_failed');
  }
  if (!passesPairedControl(selected, holdout)) {
    reasons.push('holdout_paired_ci_failed');
  }
  if (invalidationRate > maxInvalidationRate) {
    reasons.push('pipeline_invalidation_rate_above_5pct');
  }
  return {
    status: reasons.length ? 'HOLDOUT_REJECTED' : 'PAPER_EDGE_VALIDATED',
    selectedArm: selected,
    selectionSamples: selectionSize,
    holdoutSamples: holdoutSize,
    invalidationRate,
    reasons: reasons.length ? reasons : ['all_preregistered_paper_guardrails_passed'],
  };
}

function pairedExperimentIds(
  samples: Readonly<Record<RobinhoodExitArmCode, readonly ResolvedArmSample[]>>,
): string[] {
  const byArm = ROBINHOOD_EXIT_ARM_CODES.map((arm) =>
    new Set(samples[arm].map((sample) => sample.experimentId)),
  );
  const firstByExperiment = new Map<string, ResolvedArmSample>();
  for (const sample of samples[ROBINHOOD_EXIT_ARM_CODES[0]]) {
    const current = firstByExperiment.get(sample.experimentId);
    if (current == null || sample.t0AtMs < current.t0AtMs) {
      firstByExperiment.set(sample.experimentId, sample);
    }
  }
  return [...firstByExperiment.values()]
    .filter((sample) => byArm.every((ids) => ids.has(sample.experimentId)))
    .sort((left, right) => left.t0AtMs - right.t0AtMs)
    .map((sample) => sample.experimentId);
}

function mapSamples(
  samples: Readonly<Record<RobinhoodExitArmCode, readonly ResolvedArmSample[]>>,
  ids: ReadonlySet<string>,
): Record<RobinhoodExitArmCode, ResolvedArmSample[]> {
  return Object.fromEntries(ROBINHOOD_EXIT_ARM_CODES.map((arm) => [
    arm,
    samples[arm].filter((sample) => ids.has(sample.experimentId)),
  ])) as Record<RobinhoodExitArmCode, ResolvedArmSample[]>;
}

function passesAbsolute(metric: ArmMetricSummary, maxDrawdownUsd: number): boolean {
  return metric.rawEvUsd > 0 &&
    metric.capped10xEvUsd > 0 &&
    metric.pnlWithoutTop1Usd > 0 &&
    metric.pnlWithoutTop3Usd >= 0 &&
    metric.profitFactor != null &&
    metric.profitFactor > 1 &&
    metric.maxDrawdownUsd <= maxDrawdownUsd;
}

function passesStress(metric: ArmMetricSummary, maxDrawdownUsd: number): boolean {
  return metric.rawEvUsd > 0 &&
    metric.capped10xEvUsd > 0 &&
    metric.pnlWithoutTop1Usd >= 0 &&
    metric.profitFactor != null &&
    metric.profitFactor > 1 &&
    metric.maxDrawdownUsd <= maxDrawdownUsd;
}

function passesPairedControl(
  arm: RobinhoodExitArmCode,
  samples: Readonly<Record<RobinhoodExitArmCode, readonly ResolvedArmSample[]>>,
): boolean {
  if (arm === CONTROL_ARM) return true;
  const differences = pairedPnlDifferences(samples[arm], samples[CONTROL_ARM]);
  const interval = bootstrapMeanConfidenceInterval(differences);
  return interval != null && interval.lower95 > 0;
}
