import type { LiquidityCheckResult } from '../onchain/onchain.types';

export type TakeCohortParams = {
  minPriceMultiple: number;
  minExecutableDepthUsd: number;
  minLiquidityRetention: number;
  minV2OnchainTvlUsd: number;
};

export type TakeCohortBaseline = {
  spotPriceUsd: number | null;
  executableDepthUsd: number | null;
  onchainTvlUsd: number | null;
  liquidityModel: string;
};

export type TakeCohortDecision = {
  confirmed: boolean;
  reason: string;
  priceMultiple: number | null;
  liquidityRetention: number | null;
};

/**
 * A deliberately small, observable entry rule for the Base/Ethereum take cohort.
 * It is not a score: the pool must still be tradable after a delay, without a price
 * break or a material liquidity loss. This turns the initial candidate into a
 * hypothesis and keeps rejected hypotheses out of paper_entries.csv.
 */
export function assessTakeCohortConfirmation(
  baseline: TakeCohortBaseline,
  current: LiquidityCheckResult | null,
  params: TakeCohortParams,
): TakeCohortDecision {
  if (!current?.liquidityVerified) {
    return { confirmed: false, reason: 'confirmation_liquidity_unverified', priceMultiple: null, liquidityRetention: null };
  }

  const price = current.spotPriceUsd;
  if (price == null || !Number.isFinite(price) || price <= 0) {
    return { confirmed: false, reason: 'confirmation_price_unavailable', priceMultiple: null, liquidityRetention: null };
  }

  const depth = current.executableDepthUsd;
  if (depth == null || !Number.isFinite(depth) || depth < params.minExecutableDepthUsd) {
    return { confirmed: false, reason: 'confirmation_depth_too_low', priceMultiple: null, liquidityRetention: null };
  }

  const baselinePrice = baseline.spotPriceUsd;
  const priceMultiple = baselinePrice != null && baselinePrice > 0 ? price / baselinePrice : null;
  if (priceMultiple != null && priceMultiple < params.minPriceMultiple) {
    return { confirmed: false, reason: 'confirmation_price_below_baseline', priceMultiple, liquidityRetention: null };
  }

  const baselineTvl = baseline.onchainTvlUsd;
  const currentTvl = current.onchainTvlUsd;
  const liquidityRetention = baselineTvl != null && baselineTvl > 0 && currentTvl != null
    ? currentTvl / baselineTvl
    : null;
  if (liquidityRetention != null && liquidityRetention < params.minLiquidityRetention) {
    return { confirmed: false, reason: 'confirmation_liquidity_not_retained', priceMultiple, liquidityRetention };
  }

  // V2 balance reads are direct pool-reserve reads, so a minimum is meaningful.
  // V3/V4 range liquidity uses executable quote depth instead; forcing a reserve
  // threshold there would reject healthy concentrated-liquidity pools.
  if (baseline.liquidityModel === 'V2' && (currentTvl == null || currentTvl < params.minV2OnchainTvlUsd)) {
    return { confirmed: false, reason: 'confirmation_v2_tvl_too_low', priceMultiple, liquidityRetention };
  }

  return { confirmed: true, reason: 'confirmed', priceMultiple, liquidityRetention };
}
