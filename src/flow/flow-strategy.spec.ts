import { computeFlowSnapshot, evaluateFlowStrategy, FLOW_STRATEGIES } from './flow-strategy';
import type { FlowTrade } from './flow.types';

const NOW = 1_000_000;

function trade(
  kind: 'BUY' | 'SELL',
  trader: string,
  quoteAmountUsd: number,
  priceUsd: number,
  ageMs: number,
  blockNumber: string,
): FlowTrade {
  return {
    chain: 'base', poolAddress: '0xpool', tokenAddress: '0xtoken',
    blockNumber, blockHash: null, txHash: `${trader}-${ageMs}`, logIndex: ageMs,
    occurredAtMs: NOW - ageMs, trader, kind, quoteAmountUsd, tokenAmount: 1, priceUsd,
  };
}

describe('flow strategy', () => {
  it('computes rolling volume, wallet concentration, overlap, and momentum', () => {
    const snapshot = computeFlowSnapshot([
      trade('BUY', '0xa', 60, 1, 50_000, '1'),
      trade('BUY', '0xb', 40, 1.1, 20_000, '2'),
      trade('SELL', '0xa', 20, 1.2, 10_000, '2'),
      trade('BUY', '0xold', 1_000, 0.5, 70_000, '0'),
    ], NOW, NOW - 120_000, 60_000);

    expect(snapshot.buyQuoteUsd).toBe(100);
    expect(snapshot.sellQuoteUsd).toBe(20);
    expect(snapshot.uniqueBuyers).toBe(2);
    expect(snapshot.largestBuyerShare).toBeCloseTo(0.6);
    expect(snapshot.buyerSellerOverlap).toBe(1);
    expect(snapshot.priceMomentum).toBeCloseTo(1.2);
    expect(snapshot.distinctBlocks).toBe(2);
  });

  it('triggers fresh_confirmed_v1 only after every frozen condition is met', () => {
    const strategy = FLOW_STRATEGIES.find((item) => item.version === 'fresh_confirmed_v1')!;
    const passing = [
      trade('BUY', '0xa', 130, 1, 100_000, '1'),
      trade('BUY', '0xb', 130, 1.01, 80_000, '1'),
      trade('BUY', '0xc', 130, 1.02, 50_000, '2'),
      trade('BUY', '0xd', 130, 1.04, 10_000, '2'),
      trade('SELL', '0xe', 100, 1.03, 5_000, '2'),
    ];

    expect(evaluateFlowStrategy(strategy, passing, NOW, NOW - 180_000).triggered).toBe(true);
    const concentrated = passing.map((item, index) => index === 0 ? { ...item, quoteAmountUsd: 900 } : item);
    expect(evaluateFlowStrategy(strategy, concentrated, NOW, NOW - 180_000)).toMatchObject({
      triggered: false,
      reasons: expect.arrayContaining(['buyer_concentration']),
    });
  });

  it('records a creator sell as a feature without adding an unversioned gate', () => {
    const strategy = FLOW_STRATEGIES[0];
    const decision = evaluateFlowStrategy(strategy, [
      trade('BUY', '0xa', 60, 1, 20_000, '1'),
      trade('BUY', '0xb', 60, 1.1, 10_000, '2'),
      trade('SELL', '0xcreator', 1, 1.1, 5_000, '2'),
    ], NOW, NOW - 60_000, '0xcreator');
    expect(decision.triggered).toBe(true);
    expect(decision.snapshot.creatorSold).toBe(true);
  });
});
