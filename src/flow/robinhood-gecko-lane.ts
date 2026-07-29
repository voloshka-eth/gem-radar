import { createHash } from 'crypto';
import {
  bootstrapMeanConfidenceInterval,
  summarizeArm,
  type ResolvedArmSample,
} from './robinhood-experiment-metrics';
import {
  canonicalJson,
  ROBINHOOD_EXIT_EXPERIMENT_CONFIG_HASH,
} from './robinhood-flow-v3';

export const ROBINHOOD_GECKO_LANE_CONFIG = Object.freeze({
  version: 'robinhood_gecko_low_friction_full2x_v3',
  registeredAt: '2026-07-27T02:15:00.000Z',
  allowedDiscoverySources: ['geckoterminal'],
  requiredFrictionCohort: 'LOW_FRICTION_PRIMARY',
  fixedExitArm: 'EXIT_A_FULL_2X',
  exitExecutionConfigHash: ROBINHOOD_EXIT_EXPERIMENT_CONFIG_HASH,
  holdoutSignals: 200,
  maxDrawdownUsd: 200,
  maxInvalidationRate: 0.05,
  requirePositiveBootstrapLower95: true,
  requirePositiveStressEv: true,
  liveExecution: false,
});

export const ROBINHOOD_GECKO_LANE_CONFIG_HASH = createHash('sha256')
  .update(canonicalJson(ROBINHOOD_GECKO_LANE_CONFIG))
  .digest('hex');

export interface RobinhoodGeckoLaneDecision {
  signalEligible: boolean;
  bankrollEligible: boolean;
  reasons: string[];
}

export interface RobinhoodGeckoLaneReadiness {
  status: 'COLLECTING_HOLDOUT' | 'HOLDOUT_REJECTED' | 'PAPER_EDGE_VALIDATED';
  samples: number;
  invalidationRate: number;
  bootstrapLower95Usd: number | null;
  reasons: string[];
}

export function evaluateRobinhoodGeckoLaneEligibility(input: {
  discoverySource: string | null | undefined;
  frictionCohort: string;
  bankrollEligible: boolean;
  bankrollReasons?: readonly string[];
}): RobinhoodGeckoLaneDecision {
  const reasons: string[] = [];
  const source = input.discoverySource?.trim().toLowerCase() ?? '';
  if (!ROBINHOOD_GECKO_LANE_CONFIG.allowedDiscoverySources.includes(source)) {
    reasons.push('source_not_geckoterminal');
  }
  if (input.frictionCohort !== ROBINHOOD_GECKO_LANE_CONFIG.requiredFrictionCohort) {
    reasons.push('not_low_friction_primary');
  }
  const signalEligible = reasons.length === 0;
  if (signalEligible && !input.bankrollEligible) {
    reasons.push(...(input.bankrollReasons?.length
      ? input.bankrollReasons
      : ['bankroll_policy_rejected']));
  }
  return {
    signalEligible,
    bankrollEligible: signalEligible && input.bankrollEligible,
    reasons,
  };
}

export function evaluateRobinhoodGeckoLaneReadiness(input: {
  observed: readonly ResolvedArmSample[];
  stress: readonly ResolvedArmSample[];
  invalidatedSignals: number;
  totalSignals: number;
}): RobinhoodGeckoLaneReadiness {
  const stressByExperiment = new Map(
    input.stress.map((sample) => [sample.experimentId, sample]),
  );
  const paired = [...input.observed]
    .filter((sample) => stressByExperiment.has(sample.experimentId))
    .sort((left, right) => left.t0AtMs - right.t0AtMs);
  const target = ROBINHOOD_GECKO_LANE_CONFIG.holdoutSignals;
  const invalidationRate = input.totalSignals > 0
    ? input.invalidatedSignals / input.totalSignals
    : 0;
  if (paired.length < target) {
    return {
      status: 'COLLECTING_HOLDOUT',
      samples: paired.length,
      invalidationRate,
      bootstrapLower95Usd: null,
      reasons: [`need_${target - paired.length}_more_holdout_signals`],
    };
  }

  const observed = paired.slice(0, target);
  const ids = new Set(observed.map((sample) => sample.experimentId));
  const stress = input.stress
    .filter((sample) => ids.has(sample.experimentId))
    .sort((left, right) => left.t0AtMs - right.t0AtMs);
  const observedMetric = summarizeArm(observed);
  const stressMetric = summarizeArm(stress);
  const interval = bootstrapMeanConfidenceInterval(
    observed.map((sample) => sample.realizedUsd - sample.committedUsd),
  );
  const reasons: string[] = [];

  if (
    observedMetric.rawEvUsd <= 0 ||
    observedMetric.capped10xEvUsd <= 0 ||
    observedMetric.pnlWithoutTop1Usd <= 0 ||
    observedMetric.pnlWithoutTop3Usd < 0 ||
    observedMetric.profitFactor == null ||
    observedMetric.profitFactor <= 1 ||
    observedMetric.maxDrawdownUsd > ROBINHOOD_GECKO_LANE_CONFIG.maxDrawdownUsd
  ) {
    reasons.push('observed_economics_failed');
  }
  if (
    stress.length !== target ||
    stressMetric.rawEvUsd <= 0 ||
    stressMetric.capped10xEvUsd <= 0 ||
    stressMetric.pnlWithoutTop1Usd < 0 ||
    stressMetric.profitFactor == null ||
    stressMetric.profitFactor <= 1 ||
    stressMetric.maxDrawdownUsd > ROBINHOOD_GECKO_LANE_CONFIG.maxDrawdownUsd
  ) {
    reasons.push('stress_economics_failed');
  }
  if (interval == null || interval.lower95 <= 0) {
    reasons.push('bootstrap_lower95_not_positive');
  }
  if (invalidationRate > ROBINHOOD_GECKO_LANE_CONFIG.maxInvalidationRate) {
    reasons.push('pipeline_invalidation_rate_above_5pct');
  }
  return {
    status: reasons.length ? 'HOLDOUT_REJECTED' : 'PAPER_EDGE_VALIDATED',
    samples: target,
    invalidationRate,
    bootstrapLower95Usd: interval?.lower95 ?? null,
    reasons: reasons.length ? reasons : ['all_fixed_lane_guardrails_passed'],
  };
}
