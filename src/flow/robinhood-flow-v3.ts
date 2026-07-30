import { createHash } from 'crypto';
import type { FlowTrade } from './flow.types';
import type {
  RobinhoodArmDefinition,
  RobinhoodExecutionScenario,
  RobinhoodFrictionDetailCohort,
  RobinhoodFlowV3Config,
  RobinhoodFlowV3Snapshot,
} from './robinhood-experiment.types';

export const ROBINHOOD_FLOW_V3_CONFIG: Readonly<RobinhoodFlowV3Config> = Object.freeze({
  version: 'robinhood_friction_cohorts_v3',
  confirmationStartMs: 20_000,
  confirmationEndMs: 60_000,
  rollingWindowMs: 10_000,
  maxLaunchMultiple: 2,
  minLatestNewBuyers: 3,
  minNewBuyerAcceleration: 1.5,
  minNetBuyPressure: 0.02,
  minPressureGrowth: 1.25,
  minOrganicBuyShare: 0.50,
  minEarlyBuyerRetention: 0.70,
  minDepthRetention: 0.90,
  minDistinctBlocks: 2,
  minExecutableDepthUsd: 100,
  maxEntrySlippagePct: 0.03,
  primaryMaxEntrySlippagePct: 0.01,
  primaryMaxSellSlippagePct: 0.01,
  maxSellSlippagePct: 0.03,
  maxQuoteAgeMs: 5_000,
  minZeroMoveRoundTrip: 0.80,
  hardStopMultiple: 0.80,
  flowReversalBuySellRatio: 0.75,
  flowReversalDrawdown: 0.15,
  horizonMs: 60 * 60_000,
  /** Paid CONFIRM_ADD fills are refused when target-to-execute exceeds this. */
  maxPaidEntryLatencyMs: 5_000,
});

/**
 * Finish-line capital policy: A/B/D/E are $0 shadow arms (still created for
 * coverage). Only C deploys paid size after Flow v3 confirmation.
 */
export const ROBINHOOD_EXPERIMENT_ARMS: readonly RobinhoodArmDefinition[] = Object.freeze([
  { code: 'A_IMMEDIATE_20', immediateUsd: 0, addUsd: 0, confirmatory: true, exploratory: false },
  { code: 'B_PROBE_4_ADD_16', immediateUsd: 0, addUsd: 0, confirmatory: true, exploratory: false },
  { code: 'C_CONFIRM_20', immediateUsd: 0, addUsd: 20, confirmatory: true, exploratory: false },
  { code: 'D_PROBE_2_ADD_18', immediateUsd: 0, addUsd: 0, confirmatory: false, exploratory: true },
  { code: 'E_PROBE_10_ADD_10', immediateUsd: 0, addUsd: 0, confirmatory: false, exploratory: true },
]);

// These arms share the same immediate low-friction paper fill. Only their
// profit-taking policy differs, which keeps the comparison causal.
export const ROBINHOOD_PAIRED_EXIT_ARMS: readonly RobinhoodArmDefinition[] = Object.freeze([
  { code: 'EXIT_A_FULL_2X', immediateUsd: 20, addUsd: 0, confirmatory: true, exploratory: false },
  { code: 'EXIT_B_FULL_1_5X', immediateUsd: 20, addUsd: 0, confirmatory: true, exploratory: false },
  { code: 'EXIT_C_90_10', immediateUsd: 20, addUsd: 0, confirmatory: true, exploratory: false },
]);

export const ROBINHOOD_EXIT_EXPERIMENT_CONFIG = Object.freeze({
  version: 'robinhood_low_friction_paired_exits_v2',
  arms: ROBINHOOD_PAIRED_EXIT_ARMS.map((arm) => arm.code),
  full2x: '100%@2x',
  full1_5x: '100%@1.5x',
  protected: '90%@2x,10%@time_or_flow_reversal',
  horizonMs: ROBINHOOD_FLOW_V3_CONFIG.horizonMs,
  executionScenario: 'OBSERVED_ENTRY',
  stressExecutionScenario: 'STRESS_1_BLOCK:+1000ms,+30%gas',
  maxBenchmarkEntryLatencyMs: 5_000,
});

export const ROBINHOOD_EXECUTION_SCENARIOS: readonly RobinhoodExecutionScenario[] = Object.freeze([
  { code: 'OBSERVED_ENTRY', latencyMs: 0, gasMultiplier: 1, primary: true, stress: false },
  { code: 'STRESS_1_BLOCK', latencyMs: 1_000, gasMultiplier: 1.3, primary: false, stress: true },
]);

export const ROBINHOOD_FRICTION_FEATURE_SCHEMA = Object.freeze({
  version: 'robinhood_execution_friction_features_v3',
  quoteModel: 'single_snapshot_exact_20_bidirectional_conservative_round_trip',
  maxPrimaryImpactPct: 0.01,
  ultraLowImpactPct: 0.005,
  maxShadowImpactPct: 0.03,
});

export const ROBINHOOD_REGISTERED_EXPERIMENT_CONFIG = Object.freeze({
  flow: ROBINHOOD_FLOW_V3_CONFIG,
  entryArms: ROBINHOOD_EXPERIMENT_ARMS,
  exitArms: ROBINHOOD_PAIRED_EXIT_ARMS,
  executionScenarios: ROBINHOOD_EXECUTION_SCENARIOS,
  activePaperLifecycle: Object.freeze({
    arm: 'EXIT_A_FULL_2X',
    scenario: 'OBSERVED_ENTRY',
    onePositionPerSignal: true,
  }),
  frictionFeatures: ROBINHOOD_FRICTION_FEATURE_SCHEMA,
});

export const ROBINHOOD_FLOW_V3_CONFIG_HASH = createHash('sha256')
  .update(canonicalJson(ROBINHOOD_REGISTERED_EXPERIMENT_CONFIG))
  .digest('hex');

export const ROBINHOOD_EXIT_EXPERIMENT_CONFIG_HASH = createHash('sha256')
  .update(canonicalJson(ROBINHOOD_EXIT_EXPERIMENT_CONFIG))
  .digest('hex');

export const ROBINHOOD_FRICTION_FEATURE_SCHEMA_HASH = createHash('sha256')
  .update(canonicalJson(ROBINHOOD_FRICTION_FEATURE_SCHEMA))
  .digest('hex');

export function classifyRobinhoodFriction(
  buyImpactPct: number,
  sellImpactPct: number,
): RobinhoodFrictionDetailCohort {
  if (
    !Number.isFinite(buyImpactPct) ||
    !Number.isFinite(sellImpactPct) ||
    buyImpactPct < 0 ||
    sellImpactPct < 0 ||
    buyImpactPct > ROBINHOOD_FRICTION_FEATURE_SCHEMA.maxShadowImpactPct ||
    sellImpactPct > ROBINHOOD_FRICTION_FEATURE_SCHEMA.maxShadowImpactPct
  ) {
    return 'OUT_OF_RANGE';
  }
  const ultraLow = ROBINHOOD_FRICTION_FEATURE_SCHEMA.ultraLowImpactPct;
  const primary = ROBINHOOD_FRICTION_FEATURE_SCHEMA.maxPrimaryImpactPct;
  if (buyImpactPct <= ultraLow && sellImpactPct <= ultraLow) return 'BOTH_LE_0_5';
  if (buyImpactPct <= primary && sellImpactPct <= primary) return 'BOTH_LE_1';
  if (sellImpactPct <= primary && buyImpactPct > primary) return 'SELL_LE_1_BUY_1_3';
  if (buyImpactPct <= primary && sellImpactPct > primary) return 'BUY_LE_1_SELL_1_3';
  return 'BOTH_1_3';
}

export interface RobinhoodFlowV3Input {
  trades: readonly FlowTrade[];
  t0Ms: number;
  nowMs: number;
  launchPriceUsd: number;
  currentPriceUsd: number;
  t0DepthUsd: number;
  currentDepthUsd: number;
  creatorAddress: string | null;
  hardRisk: boolean;
}

export function evaluateRobinhoodFlowV3(
  input: RobinhoodFlowV3Input,
  config: Readonly<RobinhoodFlowV3Config> = ROBINHOOD_FLOW_V3_CONFIG,
): RobinhoodFlowV3Snapshot {
  const elapsedMs = input.nowMs - input.t0Ms;
  const afterT0 = input.trades.filter((trade) => trade.occurredAtMs >= input.t0Ms && trade.occurredAtMs <= input.nowMs);
  const latestStart = input.nowMs - config.rollingWindowMs;
  const previousStart = latestStart - config.rollingWindowMs;
  const latest = afterT0.filter((trade) => trade.occurredAtMs > latestStart);
  const previous = afterT0.filter(
    (trade) => trade.occurredAtMs > previousStart && trade.occurredAtMs <= latestStart,
  );

  const firstBuyAt = new Map<string, number>();
  for (const trade of afterT0) {
    if (trade.kind !== 'BUY') continue;
    const trader = trade.trader.toLowerCase();
    const first = firstBuyAt.get(trader);
    if (first == null || trade.occurredAtMs < first) firstBuyAt.set(trader, trade.occurredAtMs);
  }
  const latestNewBuyers = countFirstBuys(firstBuyAt, latestStart, input.nowMs);
  const previousNewBuyers = countFirstBuys(firstBuyAt, previousStart, latestStart);
  const newBuyerAcceleration = ratio(latestNewBuyers, previousNewBuyers);
  const latestNetBuyUsd = netBuyUsd(latest);
  const previousNetBuyUsd = netBuyUsd(previous);
  const netBuyPressure = safeDivide(latestNetBuyUsd, input.currentDepthUsd);
  const previousNetBuyPressure = safeDivide(previousNetBuyUsd, input.currentDepthUsd);
  const pressureGrowth = ratio(netBuyPressure, previousNetBuyPressure);

  const walletBuyUsd = new Map<string, number>();
  let totalBuyUsd = 0;
  for (const trade of afterT0) {
    if (trade.kind !== 'BUY') continue;
    totalBuyUsd += trade.quoteAmountUsd;
    const trader = trade.trader.toLowerCase();
    walletBuyUsd.set(trader, (walletBuyUsd.get(trader) ?? 0) + trade.quoteAmountUsd);
  }
  const topThreeBuyUsd = [...walletBuyUsd.values()].sort((a, b) => b - a).slice(0, 3).reduce((sum, value) => sum + value, 0);
  const organicBuyUsd = Math.max(0, totalBuyUsd - topThreeBuyUsd);
  const organicBuyShare = safeDivide(organicBuyUsd, totalBuyUsd);

  const earlyCutoff = input.t0Ms + config.confirmationStartMs;
  const earlyBuyers = new Set(
    [...firstBuyAt.entries()].filter(([, firstAt]) => firstAt <= earlyCutoff).map(([trader]) => trader),
  );
  const earlyBuyerSold = new Set(
    afterT0
      .filter((trade) => trade.kind === 'SELL' && earlyBuyers.has(trade.trader.toLowerCase()))
      .map((trade) => trade.trader.toLowerCase()),
  );
  const retainedEarlyBuyers = Math.max(0, earlyBuyers.size - earlyBuyerSold.size);
  const earlyBuyerRetention = safeDivide(retainedEarlyBuyers, earlyBuyers.size);
  const depthRetention = safeDivide(input.currentDepthUsd, input.t0DepthUsd);
  const distinctBlocks = new Set(afterT0.map((trade) => trade.blockNumber)).size;
  const creator = input.creatorAddress?.toLowerCase() ?? null;
  const creatorSellUsd = creator == null ? 0 : afterT0
    .filter((trade) => trade.kind === 'SELL' && trade.trader.toLowerCase() === creator)
    .reduce((sum, trade) => sum + trade.quoteAmountUsd, 0);
  const launchMultiple = safeDivide(input.currentPriceUsd, input.launchPriceUsd);

  const reasons: string[] = [];
  if (elapsedMs < config.confirmationStartMs) reasons.push('confirmation_window_not_open');
  if (elapsedMs > config.confirmationEndMs) reasons.push('confirmation_window_expired');
  if (!(launchMultiple > 0 && launchMultiple <= config.maxLaunchMultiple)) reasons.push('launch_multiple_over_2x');
  if (latestNewBuyers < config.minLatestNewBuyers) reasons.push('latest_new_buyers_below_3');
  if (newBuyerAcceleration < config.minNewBuyerAcceleration) reasons.push('new_buyer_acceleration_below_1_5x');
  if (netBuyPressure < config.minNetBuyPressure) reasons.push('net_buy_pressure_below_2pct');
  if (pressureGrowth < config.minPressureGrowth) reasons.push('net_buy_pressure_growth_below_25pct');
  if (organicBuyShare < config.minOrganicBuyShare) reasons.push('organic_buy_share_below_50pct');
  if (earlyBuyerRetention < config.minEarlyBuyerRetention) reasons.push('early_buyer_retention_below_70pct');
  if (depthRetention < config.minDepthRetention) reasons.push('depth_retention_below_90pct');
  if (distinctBlocks < config.minDistinctBlocks) reasons.push('activity_below_2_blocks');
  if (creatorSellUsd > 0) reasons.push('creator_sell_detected');
  if (input.hardRisk) reasons.push('hard_risk_detected');

  return {
    eligible: reasons.length === 0,
    reasons,
    elapsedMs,
    launchMultiple,
    latestNewBuyers,
    previousNewBuyers,
    newBuyerAcceleration,
    latestNetBuyUsd,
    previousNetBuyUsd,
    netBuyPressure,
    previousNetBuyPressure,
    pressureGrowth,
    totalBuyUsd,
    organicBuyUsd,
    organicBuyShare,
    earlyBuyers: earlyBuyers.size,
    retainedEarlyBuyers,
    earlyBuyerRetention,
    executableDepthUsd: input.currentDepthUsd,
    depthRetention,
    distinctBlocks,
    creatorSellUsd,
  };
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value != null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

function countFirstBuys(firstBuyAt: ReadonlyMap<string, number>, startExclusive: number, endInclusive: number): number {
  return [...firstBuyAt.values()].filter((timestamp) => timestamp > startExclusive && timestamp <= endInclusive).length;
}

function netBuyUsd(trades: readonly FlowTrade[]): number {
  return trades.reduce(
    (sum, trade) => sum + (trade.kind === 'BUY' ? trade.quoteAmountUsd : -trade.quoteAmountUsd),
    0,
  );
}

function safeDivide(numerator: number, denominator: number): number {
  if (!(denominator > 0)) return numerator > 0 ? Number.POSITIVE_INFINITY : 0;
  return numerator / denominator;
}

function ratio(current: number, previous: number): number {
  if (previous <= 0) return current > 0 ? Number.POSITIVE_INFINITY : 0;
  return current / previous;
}
