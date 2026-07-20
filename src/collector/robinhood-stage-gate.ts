import type { CollectorResult } from './collector.types';
import type { LiquidityCheckResult } from '../onchain/onchain.types';

export const ROBINHOOD_STAGE_VERSION = 'robinhood-stages-v1' as const;

export type RobinhoodDiscoveryLane =
  | 'robinhood_standard'
  | 'robinhood_bootstrap_active'
  | 'robinhood_mature_momentum'
  | 'robinhood_reported_data_missing';

export type RobinhoodPaperLane = 'PRIMARY' | 'SHADOW';

export interface RobinhoodDiscoveryStageConfig {
  maxPoolAgeMs: number;
  minReportedLiquidityUsd: number;
  standardLiquidityUsd: number;
  minFdvUsd: number;
  maxFdvUsd: number;
  bootstrapMinVol5mUsd: number;
  bootstrapMinTx1h: number;
  bootstrapMinBuys1h: number;
  matureMinVol1hUsd: number;
  matureMinTx1h: number;
  matureMinBuys1h: number;
  blockedTokenSymbols?: string[];
}

export interface RobinhoodAdmissionStageConfig {
  minExecutableDepthUsd: number;
  minOnchainTvlUsd: number;
  primaryMinScore: number;
  shadowMinScore: number;
}

export interface RobinhoodDiscoveryStageResult {
  pass: boolean;
  version: typeof ROBINHOOD_STAGE_VERSION;
  stage: 'R0_IDENTITY' | 'R1_AGE' | 'R2_REPORTED_MARKET';
  reason?: string;
  lane?: RobinhoodDiscoveryLane;
}

export interface RobinhoodAdmissionStageInput {
  riskDecision: string;
  rejectReasons: readonly string[];
  providerStatus: string | null | undefined;
  liquidity: LiquidityCheckResult;
  finalScore: number;
}

export interface RobinhoodAdmissionStageResult {
  pass: boolean;
  version: typeof ROBINHOOD_STAGE_VERSION;
  stage: 'R3_PROVIDER_CONTRACT' | 'R4_EXECUTABLE_LIQUIDITY' | 'R5_SCORE_ROUTING';
  reason?: string;
  paperLane?: RobinhoodPaperLane;
}

/**
 * Robinhood launches commonly bootstrap around $2.5k-$3k reported liquidity.
 * This gate admits only the active part of that regime to expensive on-chain
 * verification while keeping the global ETH/Base Stage0 policy unchanged.
 */
export function applyRobinhoodDiscoveryStages(
  candidate: CollectorResult,
  config: RobinhoodDiscoveryStageConfig,
  nowMs = Date.now(),
): RobinhoodDiscoveryStageResult {
  const { pool, token } = candidate;
  const result = (
    pass: boolean,
    stage: RobinhoodDiscoveryStageResult['stage'],
    reason?: string,
    lane?: RobinhoodDiscoveryLane,
  ): RobinhoodDiscoveryStageResult => ({
    pass,
    version: ROBINHOOD_STAGE_VERSION,
    stage,
    ...(reason ? { reason } : {}),
    ...(lane ? { lane } : {}),
  });

  const blocked = new Set((config.blockedTokenSymbols ?? []).map(normalizeSymbol).filter(Boolean));
  if (blocked.has(normalizeSymbol(token.symbol))) {
    return result(false, 'R0_IDENTITY', 'ticker_blocklisted');
  }
  if (!pool.quoteAsset) return result(false, 'R0_IDENTITY', 'quote_asset_not_accepted');

  const ageMs = pool.poolCreatedAt ? Math.max(0, nowMs - pool.poolCreatedAt.getTime()) : null;
  const mature = ageMs != null && ageMs > config.maxPoolAgeMs;
  if (mature && !hasMatureMomentum(candidate, config)) {
    return result(false, 'R1_AGE', 'pool_too_old');
  }

  const liquidity = finite(pool.liquidityUsd);
  const fdv = finite(pool.fdvUsd);
  if (liquidity != null && liquidity < config.minReportedLiquidityUsd) {
    return result(false, 'R2_REPORTED_MARKET', 'liquidity_too_low');
  }
  if (fdv != null && fdv < config.minFdvUsd) {
    return result(false, 'R2_REPORTED_MARKET', 'fdv_too_low');
  }
  if (fdv != null && fdv > config.maxFdvUsd) {
    return result(false, 'R2_REPORTED_MARKET', 'fdv_too_high');
  }
  if (liquidity == null || fdv == null) {
    return result(true, 'R2_REPORTED_MARKET', undefined, 'robinhood_reported_data_missing');
  }
  if (mature) {
    return result(true, 'R2_REPORTED_MARKET', undefined, 'robinhood_mature_momentum');
  }
  if (liquidity < config.standardLiquidityUsd) {
    if (!hasBootstrapActivity(candidate, config)) {
      return result(false, 'R2_REPORTED_MARKET', 'bootstrap_activity_too_low');
    }
    return result(true, 'R2_REPORTED_MARKET', undefined, 'robinhood_bootstrap_active');
  }
  return result(true, 'R2_REPORTED_MARKET', undefined, 'robinhood_standard');
}

export function applyRobinhoodAdmissionStages(
  input: RobinhoodAdmissionStageInput,
  config: RobinhoodAdmissionStageConfig,
): RobinhoodAdmissionStageResult {
  const fail = (
    stage: RobinhoodAdmissionStageResult['stage'],
    reason: string,
  ): RobinhoodAdmissionStageResult => ({
    pass: false,
    version: ROBINHOOD_STAGE_VERSION,
    stage,
    reason,
  });

  if (input.riskDecision !== 'CONTRACT_UNKNOWN' || input.rejectReasons.length > 0) {
    return fail('R3_PROVIDER_CONTRACT', 'risk_reject_reasons');
  }
  if (input.providerStatus !== 'NO_RISK_PROVIDER_SUPPORT') {
    return fail('R3_PROVIDER_CONTRACT', 'provider_status');
  }
  if (!input.liquidity.liquidityVerified) {
    return fail('R4_EXECUTABLE_LIQUIDITY', 'liquidity_unverified');
  }
  if ((input.liquidity.executableDepthUsd ?? 0) < config.minExecutableDepthUsd) {
    return fail('R4_EXECUTABLE_LIQUIDITY', 'executable_depth_too_low');
  }
  if ((input.liquidity.onchainTvlUsd ?? 0) < config.minOnchainTvlUsd) {
    return fail('R4_EXECUTABLE_LIQUIDITY', 'onchain_tvl_too_low');
  }
  if (input.finalScore < config.shadowMinScore) {
    return fail('R5_SCORE_ROUTING', 'score_below_shadow_floor');
  }
  return {
    pass: true,
    version: ROBINHOOD_STAGE_VERSION,
    stage: 'R5_SCORE_ROUTING',
    paperLane: input.finalScore >= config.primaryMinScore ? 'PRIMARY' : 'SHADOW',
  };
}

function hasBootstrapActivity(
  candidate: CollectorResult,
  config: RobinhoodDiscoveryStageConfig,
): boolean {
  const { pool } = candidate;
  return (pool.vol5m ?? 0) >= config.bootstrapMinVol5mUsd ||
    (pool.txCount1h ?? 0) >= config.bootstrapMinTx1h ||
    (pool.buys1h ?? 0) >= config.bootstrapMinBuys1h;
}

function hasMatureMomentum(
  candidate: CollectorResult,
  config: RobinhoodDiscoveryStageConfig,
): boolean {
  const { pool } = candidate;
  return (pool.vol1h ?? 0) >= config.matureMinVol1hUsd ||
    (pool.txCount1h ?? 0) >= config.matureMinTx1h ||
    (pool.buys1h ?? 0) >= config.matureMinBuys1h;
}

function normalizeSymbol(value: string | null | undefined): string {
  return (value ?? '').trim().replace(/^\$/, '').toLowerCase();
}

function finite(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) ? value : null;
}
