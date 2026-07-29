import {
  evaluateRobinhoodEasyProfitEligibility,
  evaluateRobinhoodEasyProfitMomentum,
  easyProfitExitRungs,
  isEasyProfitArmCode,
  ROBINHOOD_EASY_PROFIT_EXIT_ARMS,
  ROBINHOOD_EASY_PROFIT_V1_CONFIG,
  ROBINHOOD_EASY_PROFIT_V1_CONFIG_HASH,
} from './robinhood-easy-profit-v1';
import { ROBINHOOD_FLOW_V3_CONFIG, ROBINHOOD_FLOW_V3_CONFIG_HASH } from './robinhood-flow-v3';
import type { FlowTrade } from './flow.types';

function trade(
  kind: 'BUY' | 'SELL',
  occurredAtMs: number,
  quoteAmountUsd: number,
): FlowTrade {
  return {
    chain: 'robinhood',
    poolAddress: '0xpool',
    tokenAddress: '0xtoken',
    blockNumber: '1',
    blockHash: null,
    txHash: `0x${kind}${occurredAtMs}`,
    logIndex: occurredAtMs,
    occurredAtMs,
    trader: `0x${kind}`,
    kind,
    quoteAmountUsd,
    tokenAmount: 1,
    priceUsd: 1,
  };
}

describe('Robinhood easy-profit v1 (parallel to low-friction control)', () => {
  it('freezes the registered easy-profit rules without touching the ≤1% control hash', () => {
    expect(ROBINHOOD_EASY_PROFIT_V1_CONFIG.version).toBe('robinhood_easy_profit_v1');
    expect(ROBINHOOD_EASY_PROFIT_V1_CONFIG.primaryMaxBuyImpactPct).toBe(0.015);
    expect(ROBINHOOD_EASY_PROFIT_V1_CONFIG.primaryMaxSellImpactPct).toBe(0.015);
    expect(ROBINHOOD_EASY_PROFIT_V1_CONFIG.minZeroMoveRoundTrip).toBe(0.85);
    expect(ROBINHOOD_EASY_PROFIT_V1_CONFIG.horizonMs).toBe(35 * 60_000);
    expect(ROBINHOOD_EASY_PROFIT_V1_CONFIG.hardStopMultiple).toBe(0.85);
    expect(ROBINHOOD_EASY_PROFIT_EXIT_ARMS.map((arm) => arm.code)).toEqual([
      'EASY_EXIT_LADDER_65_25_10',
    ]);
    expect(easyProfitExitRungs()).toEqual([
      { multiple: 1.5, fraction: 0.65 },
      { multiple: 2.0, fraction: 0.25 },
    ]);
    expect(ROBINHOOD_EASY_PROFIT_V1_CONFIG_HASH).toMatch(/^[0-9a-f]{64}$/);
    expect(ROBINHOOD_FLOW_V3_CONFIG.version).toBe('robinhood_low_friction_2x_v1');
    expect(ROBINHOOD_FLOW_V3_CONFIG.primaryMaxEntrySlippagePct).toBe(0.01);
    expect(ROBINHOOD_FLOW_V3_CONFIG_HASH).toMatch(/^[0-9a-f]{64}$/);
    expect(ROBINHOOD_EASY_PROFIT_V1_CONFIG_HASH).not.toBe(ROBINHOOD_FLOW_V3_CONFIG_HASH);
    expect(() => {
      (ROBINHOOD_EASY_PROFIT_V1_CONFIG as { horizonMs: number }).horizonMs = 1;
    }).toThrow();
  });

  it('requires ≤1.5% both sides, RT≥0.85, fresh flow, and buy/sell ≥1.3', () => {
    const nowMs = 100_000;
    const trades = [
      trade('BUY', nowMs - 10_000, 130),
      trade('SELL', nowMs - 5_000, 100),
    ];
    expect(evaluateRobinhoodEasyProfitEligibility({
      buyImpactPct: 0.015,
      sellImpactPct: 0.014,
      roundTripMultiple: 0.85,
      dataHealthy: true,
      trades,
      nowMs,
    })).toMatchObject({ eligible: true, reasons: [] });

    expect(evaluateRobinhoodEasyProfitEligibility({
      buyImpactPct: 0.016,
      sellImpactPct: 0.01,
      roundTripMultiple: 0.9,
      dataHealthy: true,
      trades,
      nowMs,
    }).reasons).toContain('buy_impact_over_1_5pct');

    expect(evaluateRobinhoodEasyProfitEligibility({
      buyImpactPct: 0.01,
      sellImpactPct: 0.01,
      roundTripMultiple: 0.84,
      dataHealthy: true,
      trades,
      nowMs,
    }).reasons).toContain('round_trip_below_0_85x');

    expect(evaluateRobinhoodEasyProfitEligibility({
      buyImpactPct: 0.01,
      sellImpactPct: 0.01,
      roundTripMultiple: 0.9,
      dataHealthy: false,
      trades,
      nowMs,
    }).reasons).toContain('flow_snapshot_stale');
  });

  it('rejects weak buy pressure in the momentum window', () => {
    const nowMs = 50_000;
    const momentum = evaluateRobinhoodEasyProfitMomentum([
      trade('BUY', nowMs - 20_000, 100),
      trade('SELL', nowMs - 10_000, 100),
    ], nowMs);
    expect(momentum.buyToSellRatio).toBe(1);
    expect(evaluateRobinhoodEasyProfitEligibility({
      buyImpactPct: 0.01,
      sellImpactPct: 0.01,
      roundTripMultiple: 0.9,
      dataHealthy: true,
      trades: [
        trade('BUY', nowMs - 20_000, 100),
        trade('SELL', nowMs - 10_000, 100),
      ],
      nowMs,
    }).reasons).toContain('buy_pressure_below_1_3x');
  });

  it('identifies easy-profit arm codes', () => {
    expect(isEasyProfitArmCode('EASY_EXIT_LADDER_65_25_10')).toBe(true);
    expect(isEasyProfitArmCode('EXIT_A_FULL_2X')).toBe(false);
  });
});
