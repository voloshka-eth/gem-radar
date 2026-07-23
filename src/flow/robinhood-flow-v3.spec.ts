import {
  ROBINHOOD_EXECUTION_SCENARIOS,
  ROBINHOOD_EXPERIMENT_ARMS,
  ROBINHOOD_FLOW_V3_CONFIG,
  ROBINHOOD_FLOW_V3_CONFIG_HASH,
  canonicalJson,
  evaluateRobinhoodFlowV3,
} from './robinhood-flow-v3';
import type { FlowTrade } from './flow.types';

function buy(trader: string, occurredAtMs: number, blockNumber: string, quoteAmountUsd = 100): FlowTrade {
  return {
    chain: 'robinhood', poolAddress: '0xpool', tokenAddress: '0xtoken',
    blockNumber, blockHash: null, txHash: `0x${trader}${occurredAtMs}`, logIndex: occurredAtMs,
    occurredAtMs, trader, kind: 'BUY', quoteAmountUsd, tokenAmount: 1, priceUsd: 1,
  };
}

describe('Robinhood Flow v3 pre-registration', () => {
  it('freezes five arms, four scenarios, and a deterministic config hash', () => {
    expect(ROBINHOOD_EXPERIMENT_ARMS.map((arm) => [arm.code, arm.immediateUsd, arm.addUsd])).toEqual([
      ['A_IMMEDIATE_20', 20, 0],
      ['B_PROBE_4_ADD_16', 4, 16],
      ['C_CONFIRM_20', 0, 20],
      ['D_PROBE_2_ADD_18', 2, 18],
      ['E_PROBE_10_ADD_10', 10, 10],
    ]);
    expect(ROBINHOOD_EXECUTION_SCENARIOS.map((scenario) => scenario.latencyMs)).toEqual([0, 1_000, 2_000, 5_000]);
    expect(ROBINHOOD_EXECUTION_SCENARIOS.at(-1)?.gasMultiplier).toBe(1.3);
    expect(ROBINHOOD_FLOW_V3_CONFIG_HASH).toMatch(/^[0-9a-f]{64}$/);
    expect(canonicalJson({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
  });

  it('confirms only when acceleration, organic flow, retention, depth and blocks all pass', () => {
    const trades = [
      buy('0xa1', 15_000, '1'),
      buy('0xa2', 18_000, '1'),
      buy('0xb1', 21_000, '2'),
      buy('0xb2', 23_000, '2'),
      buy('0xb3', 25_000, '3'),
      buy('0xb4', 28_000, '3'),
    ];
    const snapshot = evaluateRobinhoodFlowV3({
      trades, t0Ms: 0, nowMs: 30_000,
      launchPriceUsd: 1, currentPriceUsd: 1.2,
      t0DepthUsd: 1_000, currentDepthUsd: 950,
      creatorAddress: '0xcreator', hardRisk: false,
    });
    expect(snapshot.eligible).toBe(true);
    expect(snapshot.latestNewBuyers).toBe(4);
    expect(snapshot.previousNewBuyers).toBe(2);
    expect(snapshot.newBuyerAcceleration).toBe(2);
    expect(snapshot.organicBuyShare).toBeCloseTo(0.5);
    expect(snapshot.earlyBuyerRetention).toBe(1);
    expect(snapshot.distinctBlocks).toBe(3);
  });

  it('rejects concentrated flow even when absolute activity is high', () => {
    const trades = [
      buy('0xa1', 15_000, '1', 10),
      buy('0xa2', 18_000, '1', 10),
      buy('0xb1', 21_000, '2', 1_000),
      buy('0xb2', 23_000, '2', 1_000),
      buy('0xb3', 25_000, '3', 1_000),
      buy('0xb4', 28_000, '3', 1),
    ];
    const snapshot = evaluateRobinhoodFlowV3({
      trades, t0Ms: 0, nowMs: 30_000,
      launchPriceUsd: 1, currentPriceUsd: 1.1,
      t0DepthUsd: 10_000, currentDepthUsd: 10_000,
      creatorAddress: null, hardRisk: false,
    });
    expect(snapshot.eligible).toBe(false);
    expect(snapshot.reasons).toContain('organic_buy_share_below_50pct');
  });

  it('does not allow the confirmation thresholds to be mutated at runtime', () => {
    expect(Object.isFrozen(ROBINHOOD_FLOW_V3_CONFIG)).toBe(true);
    expect(() => {
      (ROBINHOOD_FLOW_V3_CONFIG as any).minLatestNewBuyers = 1;
    }).toThrow();
  });
});

