import type { CandidatePool, CollectorResult } from './collector.types';
import type { LiquidityCheckResult } from '../onchain/onchain.types';
import {
  applyRobinhoodAdmissionStages,
  applyRobinhoodDiscoveryStages,
  type RobinhoodAdmissionStageConfig,
  type RobinhoodDiscoveryStageConfig,
} from './robinhood-stage-gate';

const DISCOVERY: RobinhoodDiscoveryStageConfig = {
  maxPoolAgeMs: 6 * 60 * 60 * 1000,
  minReportedLiquidityUsd: 2_500,
  standardLiquidityUsd: 5_000,
  minFdvUsd: 1_000,
  maxFdvUsd: 50_000_000,
  bootstrapMinVol5mUsd: 250,
  bootstrapMinTx1h: 5,
  bootstrapMinBuys1h: 3,
  matureMinVol1hUsd: 1_000,
  matureMinTx1h: 20,
  matureMinBuys1h: 10,
};

const ADMISSION: RobinhoodAdmissionStageConfig = {
  minExecutableDepthUsd: 100,
  minOnchainTvlUsd: 200,
  primaryMinScore: 50,
  shadowMinScore: 30,
  primaryMinFdvToOnchainTvlRatio: 1,
  primaryMaxEntrySlippagePct: 0.03,
  primaryMinRoundTripMultiple: 0.8,
};

function candidate(overrides: Partial<CandidatePool> = {}): CollectorResult {
  return {
    token: {
      chain: 'robinhood', tokenAddress: '0x1111111111111111111111111111111111111111',
      symbol: 'HOOD', name: 'Hood', source: 'test',
    },
    pool: {
      chain: 'robinhood', poolAddress: '0x2222222222222222222222222222222222222222',
      dex: 'Uniswap V3', token0Address: '0x1111111111111111111111111111111111111111',
      token1Address: '0x0bd7d308f8e1639fab988df18a8011f41eacad73', quoteAsset: 'WETH',
      quoteAssetAddress: '0x0bd7d308f8e1639fab988df18a8011f41eacad73',
      liquidityUsd: 2_900, fdvUsd: 2_900, vol5m: 400, vol1h: 400,
      buys1h: 3, sells1h: 2, txCount1h: 5,
      poolCreatedAt: new Date(Date.now() - 10 * 60_000), source: 'test',
      ...overrides,
    },
  };
}

function liquidity(overrides: Partial<LiquidityCheckResult> = {}): LiquidityCheckResult {
  return {
    liquidityModel: 'V3', liquidityVerified: true, onchainTvlUsd: 2_000,
    reportedVsOnchainPct: 0, executableDepthUsd: 100, slip50: 0.02,
    entrySlip20: 0.01, exitSlip20: 0.01,
    slip100: 0.04, slip500: null, slip1000: null, spotPriceUsd: 0.001,
    ...overrides,
  };
}

describe('Robinhood discovery stages', () => {
  it('admits an active $2.9k bootstrap pool without changing the global Stage0 floor', () => {
    expect(applyRobinhoodDiscoveryStages(candidate(), DISCOVERY)).toMatchObject({
      pass: true, stage: 'R2_REPORTED_MARKET', lane: 'robinhood_bootstrap_active',
    });
  });

  it('rejects the common one-trade bootstrap clones', () => {
    expect(applyRobinhoodDiscoveryStages(candidate({ vol5m: 1.8, vol1h: 1.8, buys1h: 1, txCount1h: 1 }), DISCOVERY))
      .toMatchObject({ pass: false, reason: 'bootstrap_activity_too_low' });
  });

  it('rejects reported liquidity below the Robinhood floor', () => {
    expect(applyRobinhoodDiscoveryStages(candidate({ liquidityUsd: 2_499 }), DISCOVERY))
      .toMatchObject({ pass: false, reason: 'liquidity_too_low' });
  });

  it('uses a Robinhood FDV floor suitable for early bootstrap pools', () => {
    expect(applyRobinhoodDiscoveryStages(candidate({ fdvUsd: 1_500 }), DISCOVERY).pass).toBe(true);
    expect(applyRobinhoodDiscoveryStages(candidate({ fdvUsd: 999 }), DISCOVERY))
      .toMatchObject({ pass: false, reason: 'fdv_too_low' });
  });

  it('admits old pools only through mature momentum', () => {
    const old = new Date(Date.now() - 24 * 60 * 60_000);
    expect(applyRobinhoodDiscoveryStages(candidate({ poolCreatedAt: old, vol1h: 2_000 }), DISCOVERY))
      .toMatchObject({ pass: true, lane: 'robinhood_mature_momentum' });
    expect(applyRobinhoodDiscoveryStages(candidate({ poolCreatedAt: old, vol1h: 10, buys1h: 1, txCount1h: 1 }), DISCOVERY))
      .toMatchObject({ pass: false, reason: 'pool_too_old' });
  });
});

describe('Robinhood admission stages', () => {
  const base = {
    riskDecision: 'CONTRACT_UNKNOWN', rejectReasons: [],
    providerStatus: 'NO_RISK_PROVIDER_SUPPORT', liquidity: liquidity(), finalScore: 50,
  };

  it('routes score >=50 to primary paper', () => {
    expect(applyRobinhoodAdmissionStages(base, ADMISSION)).toMatchObject({ pass: true, paperLane: 'PRIMARY' });
  });

  it('routes score 30-49.99 to full-lifecycle shadow paper', () => {
    expect(applyRobinhoodAdmissionStages({ ...base, finalScore: 30 }, ADMISSION))
      .toMatchObject({ pass: true, paperLane: 'SHADOW' });
  });

  it('routes physically inconsistent FDV/TVL and quote data to shadow instead of primary', () => {
    expect(applyRobinhoodAdmissionStages({ ...base, reportedFdvUsd: 1_000 }, ADMISSION))
      .toMatchObject({ pass: true, paperLane: 'SHADOW', qualityFlags: ['fdv_below_onchain_tvl'] });
    expect(applyRobinhoodAdmissionStages({
      ...base,
      reportedFdvUsd: 10_000,
      liquidity: liquidity({ entrySlip20: -0.01 }),
    }, ADMISSION)).toMatchObject({ pass: true, paperLane: 'SHADOW', qualityFlags: ['invalid_round_trip_quote'] });
  });

  it('rejects scores below the shadow floor', () => {
    expect(applyRobinhoodAdmissionStages({ ...base, finalScore: 29.99 }, ADMISSION))
      .toMatchObject({ pass: false, stage: 'R5_SCORE_ROUTING', reason: 'score_below_shadow_floor' });
  });

  it('keeps executable depth and on-chain TVL as hard stages', () => {
    expect(applyRobinhoodAdmissionStages({ ...base, liquidity: liquidity({ executableDepthUsd: 50 }) }, ADMISSION))
      .toMatchObject({ pass: false, reason: 'executable_depth_too_low' });
    expect(applyRobinhoodAdmissionStages({ ...base, liquidity: liquidity({ onchainTvlUsd: 199 }) }, ADMISSION))
      .toMatchObject({ pass: false, reason: 'onchain_tvl_too_low' });
  });
});
