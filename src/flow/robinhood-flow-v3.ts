import { createHash } from 'crypto';
import type { FlowTrade } from './flow.types';
import type {
  RobinhoodArmDefinition,
  RobinhoodExecutionScenario,
  RobinhoodFlowV3Config,
  RobinhoodFlowV3Snapshot,
} from './robinhood-experiment.types';

export const ROBINHOOD_FLOW_V3_CONFIG: Readonly<RobinhoodFlowV3Config> = Object.freeze({
  version: 'robinhood_flow_v3_entry_experiment_v1',
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
  minZeroMoveRoundTrip: 0.80,
  hardStopMultiple: 0.80,
  flowReversalBuySellRatio: 0.75,
  flowReversalDrawdown: 0.15,
  horizonMs: 60 * 60_000,
});

export const ROBINHOOD_EXPERIMENT_ARMS: readonly RobinhoodArmDefinition[] = Object.freeze([
  { code: 'A_IMMEDIATE_20', immediateUsd: 20, addUsd: 0, confirmatory: true, exploratory: false },
  { code: 'B_PROBE_4_ADD_16', immediateUsd: 4, addUsd: 16, confirmatory: true, exploratory: false },
  { code: 'C_CONFIRM_20', immediateUsd: 0, addUsd: 20, confirmatory: true, exploratory: false },
  { code: 'D_PROBE_2_ADD_18', immediateUsd: 2, addUsd: 18, confirmatory: false, exploratory: true },
  { code: 'E_PROBE_10_ADD_10', immediateUsd: 10, addUsd: 10, confirmatory: false, exploratory: true },
]);

export const ROBINHOOD_EXECUTION_SCENARIOS: readonly RobinhoodExecutionScenario[] = Object.freeze([
  { code: 'LATENCY_0S', latencyMs: 0, gasMultiplier: 1, primary: false, stress: false },
  { code: 'LATENCY_1S', latencyMs: 1_000, gasMultiplier: 1, primary: false, stress: false },
  { code: 'PRIMARY_2S', latencyMs: 2_000, gasMultiplier: 1, primary: true, stress: false },
  // Stress adds one additional Robinhood block on top of the primary two-second execution.
  { code: 'STRESS_5S', latencyMs: 5_000, gasMultiplier: 1.30, primary: false, stress: true },
]);

export const ROBINHOOD_FLOW_V3_CONFIG_HASH = createHash('sha256')
  .update(canonicalJson(ROBINHOOD_FLOW_V3_CONFIG))
  .digest('hex');

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

