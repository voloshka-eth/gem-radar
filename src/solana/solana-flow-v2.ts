import { createHash } from 'crypto';

export const SOLANA_MULTI_LAUNCH_STRATEGY = 'solana_multi_launch_flow_v2_3' as const;

export type SolanaVenue =
  | 'RAYDIUM_LAUNCHLAB'
  | 'RAYDIUM_CPMM'
  | 'PUMP_BONDING_CURVE'
  | 'PUMPSWAP'
  | 'METEORA_DBC'
  | 'METEORA_DAMM_V1'
  | 'METEORA_DAMM_V2';

export type SolanaRiskCohort = 'PRIMARY' | 'EXECUTABLE_SHADOW' | 'MARKET_OBSERVATION';
export type SolanaTradeDirection = 'BUY' | 'SELL';

export interface SolanaFlowTrade {
  tsMs: number;
  slot: number;
  wallet: string;
  direction: SolanaTradeDirection;
  quoteUsd: number;
  creatorTrade: boolean;
}

export interface SolanaFlowSnapshot {
  latestWindowBuyers: number;
  previousWindowBuyers: number;
  buyerAcceleration: number;
  buyVolumeUsd: number;
  sellVolumeUsd: number;
  netBuyUsd: number;
  netBuyToDepth: number;
  previousNetBuyToDepth: number;
  pressureGrowth: number;
  topThreeBuyerShare: number;
  buyerRetention: number;
  depthRetention: number;
  distinctSlots: number;
  creatorSell: boolean;
}

export interface SolanaExecutionSnapshot {
  executable: boolean;
  buySlippagePct: number | null;
  sellSlippagePct: number | null;
  roundTripMultiple: number | null;
  executableDepthUsd: number;
  quoteSlot: number;
  quoteModel: string;
}

export interface SolanaExecutionDecision {
  cohort: SolanaRiskCohort;
  benchmarkEligible: boolean;
  positionEligible: boolean;
  reasons: string[];
}

export interface SolanaConfirmationResult {
  confirmed: boolean;
  reasons: string[];
  snapshot: SolanaFlowSnapshot;
  chanceCode: string | null;
}

export interface SolanaConfirmationMarketContext {
  launchMultiple: number;
  reboundFromLow: number;
}

export interface SolanaExperimentArmDefinition {
  code: 'A_IMMEDIATE_20' | 'B_PROBE_4_ADD_16' | 'C_CONFIRM_20';
  immediateUsd: number;
  confirmationUsd: number;
}

export const SOLANA_FLOW_V2_CONFIG = deepFreeze({
  version: SOLANA_MULTI_LAUNCH_STRATEGY,
  positionBudgetUsd: 20,
  primaryMaxSlippagePct: 0.03,
  shadowMaxSlippagePct: 0.08,
  minRoundTripMultiple: 0.80,
  minExecutableDepthUsd: 100,
  maxPrimaryLagSlots: 8,
  maxQuoteAgeSlots: 1,
  maxPrimaryEventAgeMs: 5_000,
  /** Paid fills (C confirmation) are refused when discovery→fill exceeds this. */
  maxPaidEntryLatencyMs: 5_000,
  confirmationStartMs: 20_000,
  confirmationEndMs: 10 * 60_000,
  confirmationWindows: [
    { code: 'EARLY', startMs: 20_000, endMs: 90_000, recovery: false },
    { code: 'RECOVERY_1', startMs: 2 * 60_000, endMs: 5 * 60_000, recovery: true },
    { code: 'RECOVERY_2', startMs: 6 * 60_000, endMs: 10 * 60_000, recovery: true },
  ],
  flowWindowMs: 10_000,
  minLatestNewBuyers: 3,
  minBuyerAcceleration: 1.5,
  minNetBuyToDepth: 0.02,
  minPressureGrowth: 0.25,
  maxTopThreeBuyerShare: 0.50,
  minBuyerRetention: 0.70,
  minDepthRetention: 0.90,
  minDistinctSlots: 2,
  recoveryMinLatestNewBuyers: 4,
  recoveryMinBuyerAcceleration: 1.25,
  recoveryMinNetBuyToDepth: 0.01,
  recoveryMinPressureGrowth: 0.15,
  recoveryMaxTopThreeBuyerShare: 0.75,
  recoveryMinBuyerRetention: 0.60,
  recoveryMinDepthRetention: 0.80,
  recoveryMinReboundFromLow: 1.15,
  maxConfirmationLaunchMultiple: 2,
  hardStopMultiple: 0.80,
  timeExitMs: 8 * 60 * 60_000,
  ladder: [
    { multiple: 2, fraction: 0.80 },
    { multiple: 10, fraction: 0.15 },
    { multiple: 1000, fraction: 0.05 },
  ],
} as const);

/**
 * Finish-line capital policy: A/B stay in the paired experiment as $0 shadow
 * arms (still created for coverage). Only C deploys paid size after flow
 * confirmation passes.
 */
export const SOLANA_EXPERIMENT_ARMS: readonly SolanaExperimentArmDefinition[] = deepFreeze([
  { code: 'A_IMMEDIATE_20', immediateUsd: 0, confirmationUsd: 0 },
  { code: 'B_PROBE_4_ADD_16', immediateUsd: 0, confirmationUsd: 0 },
  { code: 'C_CONFIRM_20', immediateUsd: 0, confirmationUsd: 20 },
]);

export const SOLANA_FLOW_V2_CONFIG_HASH = createHash('sha256')
  .update(canonicalJson(SOLANA_FLOW_V2_CONFIG))
  .digest('hex');

export function classifySolanaExecution(
  execution: SolanaExecutionSnapshot,
  latestSlot: number,
  eventAgeMs: number,
  unresolvedGap: boolean,
  hardRiskReasons: readonly string[] = [],
): SolanaExecutionDecision {
  const reasons = [...hardRiskReasons];
  if (unresolvedGap) reasons.push('unresolved_stream_gap');
  if (latestSlot - execution.quoteSlot > SOLANA_FLOW_V2_CONFIG.maxQuoteAgeSlots) reasons.push('quote_slot_stale');
  if (eventAgeMs > SOLANA_FLOW_V2_CONFIG.maxPrimaryEventAgeMs) reasons.push('event_too_old');
  if (!execution.executable) reasons.push('route_unavailable');
  if (execution.buySlippagePct == null || execution.sellSlippagePct == null) reasons.push('slippage_unknown');
  if (execution.roundTripMultiple == null) reasons.push('round_trip_unknown');
  if (execution.executableDepthUsd < SOLANA_FLOW_V2_CONFIG.minExecutableDepthUsd) reasons.push('depth_below_100');
  if ((execution.roundTripMultiple ?? 0) < SOLANA_FLOW_V2_CONFIG.minRoundTripMultiple) reasons.push('round_trip_below_0_8');

  const slip = Math.max(execution.buySlippagePct ?? Infinity, execution.sellSlippagePct ?? Infinity);
  const hardRisk = hardRiskReasons.length > 0;
  const physicalFailure = !execution.executable || !Number.isFinite(slip) ||
    execution.executableDepthUsd < SOLANA_FLOW_V2_CONFIG.minExecutableDepthUsd ||
    (execution.roundTripMultiple ?? 0) < SOLANA_FLOW_V2_CONFIG.minRoundTripMultiple;
  if (hardRisk || physicalFailure || slip > SOLANA_FLOW_V2_CONFIG.shadowMaxSlippagePct) {
    if (slip > SOLANA_FLOW_V2_CONFIG.shadowMaxSlippagePct) reasons.push('slippage_above_8pct');
    return { cohort: 'MARKET_OBSERVATION', benchmarkEligible: false, positionEligible: false, reasons };
  }

  const healthy = !unresolvedGap &&
    latestSlot - execution.quoteSlot <= SOLANA_FLOW_V2_CONFIG.maxQuoteAgeSlots &&
    eventAgeMs <= SOLANA_FLOW_V2_CONFIG.maxPrimaryEventAgeMs;
  if (slip <= SOLANA_FLOW_V2_CONFIG.primaryMaxSlippagePct && healthy) {
    return { cohort: 'PRIMARY', benchmarkEligible: true, positionEligible: true, reasons };
  }
  if (slip > SOLANA_FLOW_V2_CONFIG.primaryMaxSlippagePct) reasons.push('slippage_shadow_3_to_8pct');
  if (!healthy) reasons.push('degraded_data_health');
  return { cohort: 'EXECUTABLE_SHADOW', benchmarkEligible: false, positionEligible: true, reasons };
}

export function computeSolanaFlowSnapshot(
  trades: readonly SolanaFlowTrade[],
  nowMs: number,
  currentDepthUsd: number,
  t0DepthUsd: number,
): SolanaFlowSnapshot {
  const width = SOLANA_FLOW_V2_CONFIG.flowWindowMs;
  const latest = trades.filter((trade) => trade.tsMs > nowMs - width && trade.tsMs <= nowMs);
  const previous = trades.filter((trade) => trade.tsMs > nowMs - 2 * width && trade.tsMs <= nowMs - width);
  const beforePreviousBuyers = new Set(
    trades.filter((trade) => trade.direction === 'BUY' && trade.tsMs <= nowMs - 2 * width).map((trade) => trade.wallet),
  );
  const previousBuyers = new Set(
    previous
      .filter((trade) => trade.direction === 'BUY' && !beforePreviousBuyers.has(trade.wallet))
      .map((trade) => trade.wallet),
  );
  const knownBeforeLatest = new Set([...beforePreviousBuyers, ...previousBuyers]);
  const buyers = new Set(
    latest
      .filter((trade) => trade.direction === 'BUY' && !knownBeforeLatest.has(trade.wallet))
      .map((trade) => trade.wallet),
  );
  const buyVolumeUsd = sum(latest.filter((trade) => trade.direction === 'BUY').map((trade) => trade.quoteUsd));
  const sellVolumeUsd = sum(latest.filter((trade) => trade.direction === 'SELL').map((trade) => trade.quoteUsd));
  const previousBuyUsd = sum(previous.filter((trade) => trade.direction === 'BUY').map((trade) => trade.quoteUsd));
  const previousSellUsd = sum(previous.filter((trade) => trade.direction === 'SELL').map((trade) => trade.quoteUsd));
  const netBuyUsd = buyVolumeUsd - sellVolumeUsd;
  const previousNetBuyUsd = previousBuyUsd - previousSellUsd;
  const pressure = safeRatio(netBuyUsd, currentDepthUsd);
  const previousPressure = safeRatio(previousNetBuyUsd, currentDepthUsd);

  const buyerVolumes = new Map<string, number>();
  for (const trade of latest) {
    if (trade.direction === 'BUY') buyerVolumes.set(trade.wallet, (buyerVolumes.get(trade.wallet) ?? 0) + trade.quoteUsd);
  }
  const topThree = [...buyerVolumes.values()].sort((a, b) => b - a).slice(0, 3);

  const earlyBuys = trades.filter((trade) => trade.direction === 'BUY' && trade.tsMs <= nowMs - width);
  const earlyBuyers = new Set(earlyBuys.map((trade) => trade.wallet));
  const earlyBuyerFlow = new Map<string, { bought: number; sold: number }>();
  for (const trade of trades) {
    if (!earlyBuyers.has(trade.wallet)) continue;
    const flow = earlyBuyerFlow.get(trade.wallet) ?? { bought: 0, sold: 0 };
    if (trade.direction === 'BUY') flow.bought += trade.quoteUsd;
    else flow.sold += trade.quoteUsd;
    earlyBuyerFlow.set(trade.wallet, flow);
  }
  const fullSellers = new Set(
    [...earlyBuyerFlow.entries()]
      .filter(([, flow]) => flow.bought > 0 && flow.sold >= flow.bought)
      .map(([wallet]) => wallet),
  );

  return {
    latestWindowBuyers: buyers.size,
    previousWindowBuyers: previousBuyers.size,
    buyerAcceleration: previousBuyers.size > 0 ? buyers.size / previousBuyers.size : buyers.size > 0 ? Infinity : 0,
    buyVolumeUsd,
    sellVolumeUsd,
    netBuyUsd,
    netBuyToDepth: pressure,
    previousNetBuyToDepth: previousPressure,
    pressureGrowth: previousPressure > 0 ? pressure / previousPressure - 1 : pressure > 0 ? Infinity : 0,
    topThreeBuyerShare: safeRatio(sum(topThree), buyVolumeUsd),
    buyerRetention: earlyBuyers.size > 0 ? 1 - fullSellers.size / earlyBuyers.size : 0,
    depthRetention: safeRatio(currentDepthUsd, t0DepthUsd),
    distinctSlots: new Set(latest.map((trade) => trade.slot)).size,
    creatorSell: trades.some((trade) => trade.creatorTrade && trade.direction === 'SELL'),
  };
}

export function evaluateSolanaConfirmation(
  trades: readonly SolanaFlowTrade[],
  nowMs: number,
  t0Ms: number,
  currentDepthUsd: number,
  t0DepthUsd: number,
  hardRisk: boolean,
  market: SolanaConfirmationMarketContext = { launchMultiple: 1, reboundFromLow: 1 },
): SolanaConfirmationResult {
  const snapshot = computeSolanaFlowSnapshot(trades, nowMs, currentDepthUsd, t0DepthUsd);
  const reasons: string[] = [];
  const elapsed = nowMs - t0Ms;
  const chance = SOLANA_FLOW_V2_CONFIG.confirmationWindows.find(
    (window) => elapsed >= window.startMs && elapsed <= window.endMs,
  ) ?? null;
  if (!chance) {
    if (elapsed < SOLANA_FLOW_V2_CONFIG.confirmationStartMs) reasons.push('confirmation_window_not_open');
    else if (elapsed > SOLANA_FLOW_V2_CONFIG.confirmationEndMs) reasons.push('confirmation_window_expired');
    else reasons.push('between_confirmation_chances');
  }
  const recovery = Boolean(chance?.recovery);
  const minBuyers = recovery
    ? SOLANA_FLOW_V2_CONFIG.recoveryMinLatestNewBuyers
    : SOLANA_FLOW_V2_CONFIG.minLatestNewBuyers;
  const minAcceleration = recovery
    ? SOLANA_FLOW_V2_CONFIG.recoveryMinBuyerAcceleration
    : SOLANA_FLOW_V2_CONFIG.minBuyerAcceleration;
  const minPressure = recovery
    ? SOLANA_FLOW_V2_CONFIG.recoveryMinNetBuyToDepth
    : SOLANA_FLOW_V2_CONFIG.minNetBuyToDepth;
  const minPressureGrowth = recovery
    ? SOLANA_FLOW_V2_CONFIG.recoveryMinPressureGrowth
    : SOLANA_FLOW_V2_CONFIG.minPressureGrowth;
  const maxTopThreeShare = recovery
    ? SOLANA_FLOW_V2_CONFIG.recoveryMaxTopThreeBuyerShare
    : SOLANA_FLOW_V2_CONFIG.maxTopThreeBuyerShare;
  const minRetention = recovery
    ? SOLANA_FLOW_V2_CONFIG.recoveryMinBuyerRetention
    : SOLANA_FLOW_V2_CONFIG.minBuyerRetention;
  const minDepthRetention = recovery
    ? SOLANA_FLOW_V2_CONFIG.recoveryMinDepthRetention
    : SOLANA_FLOW_V2_CONFIG.minDepthRetention;
  if (snapshot.latestWindowBuyers < minBuyers) reasons.push('buyers_below_chance_minimum');
  if (snapshot.buyerAcceleration < minAcceleration) reasons.push('buyer_acceleration_below_chance_minimum');
  if (snapshot.netBuyToDepth < minPressure) reasons.push('net_buy_pressure_below_chance_minimum');
  if (snapshot.pressureGrowth < minPressureGrowth) reasons.push('pressure_growth_below_chance_minimum');
  if (snapshot.topThreeBuyerShare > maxTopThreeShare) reasons.push('top_three_share_above_chance_maximum');
  if (snapshot.buyerRetention < minRetention) reasons.push('buyer_retention_below_chance_minimum');
  if (snapshot.depthRetention < minDepthRetention) reasons.push('depth_retention_below_chance_minimum');
  if (snapshot.distinctSlots < SOLANA_FLOW_V2_CONFIG.minDistinctSlots) reasons.push('activity_below_2_slots');
  if (market.launchMultiple > SOLANA_FLOW_V2_CONFIG.maxConfirmationLaunchMultiple) {
    reasons.push('launch_multiple_above_2x');
  }
  if (recovery && market.reboundFromLow < SOLANA_FLOW_V2_CONFIG.recoveryMinReboundFromLow) {
    reasons.push('rebound_from_low_below_15pct');
  }
  if (snapshot.creatorSell) reasons.push('creator_sell');
  if (hardRisk) reasons.push('hard_risk');
  return { confirmed: reasons.length === 0, reasons, snapshot, chanceCode: chance?.code ?? null };
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function safeRatio(numerator: number, denominator: number): number {
  return denominator > 0 && Number.isFinite(numerator) ? numerator / denominator : 0;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + (Number.isFinite(value) ? value : 0), 0);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
