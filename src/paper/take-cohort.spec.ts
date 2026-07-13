import { assessTakeCohortConfirmation } from './take-cohort';
import type { LiquidityCheckResult } from '../onchain/onchain.types';

const params = {
  minPriceMultiple: 1,
  minExecutableDepthUsd: 100,
  minLiquidityRetention: 0.8,
  minV2OnchainTvlUsd: 5_000,
};

const baseline = {
  spotPriceUsd: 0.01,
  executableDepthUsd: 500,
  onchainTvlUsd: 10_000,
  liquidityModel: 'V2',
};

function current(overrides: Partial<LiquidityCheckResult> = {}): LiquidityCheckResult {
  return {
    liquidityModel: 'V2',
    liquidityVerified: true,
    onchainTvlUsd: 9_000,
    reportedVsOnchainPct: 0,
    executableDepthUsd: 500,
    slip50: 0.01,
    slip100: 0.02,
    slip500: 0.05,
    slip1000: 0.1,
    spotPriceUsd: 0.011,
    ...overrides,
  };
}

describe('assessTakeCohortConfirmation', () => {
  it('accepts a pool that remains liquid and above its t0 price', () => {
    const decision = assessTakeCohortConfirmation(baseline, current(), params);
    expect(decision).toMatchObject({ confirmed: true, reason: 'confirmed', liquidityRetention: 0.9 });
    expect(decision.priceMultiple).toBeCloseTo(1.1, 10);
  });

  it.each([
    ['liquidity unverified', current({ liquidityVerified: false }), 'confirmation_liquidity_unverified'],
    ['too shallow', current({ executableDepthUsd: 99 }), 'confirmation_depth_too_low'],
    ['price below t0', current({ spotPriceUsd: 0.009 }), 'confirmation_price_below_baseline'],
    ['liquidity not retained', current({ onchainTvlUsd: 7_000 }), 'confirmation_liquidity_not_retained'],
    ['v2 TVL too low', current({ onchainTvlUsd: 4_000 }), 'confirmation_liquidity_not_retained'],
  ])('rejects %s', (_case, liq, reason) => {
    expect(assessTakeCohortConfirmation(baseline, liq, params)).toMatchObject({ confirmed: false, reason });
  });

  it('uses depth rather than a reserve floor for V3 pools', () => {
    const v3Baseline = { ...baseline, liquidityModel: 'V3', onchainTvlUsd: null };
    const v3Current = current({ liquidityModel: 'V3', onchainTvlUsd: null });
    expect(assessTakeCohortConfirmation(v3Baseline, v3Current, params)).toMatchObject({ confirmed: true });
  });

  it('applies the V2 reserve floor when no t0 reserve was available', () => {
    expect(assessTakeCohortConfirmation(
      { ...baseline, onchainTvlUsd: null },
      current({ onchainTvlUsd: 4_000 }),
      params,
    )).toMatchObject({ confirmed: false, reason: 'confirmation_v2_tvl_too_low' });
  });
});
