import { computeBuyerQualityShadow } from './buyer-quality';

const trade = (trader: string, kind: 'BUY' | 'SELL', quoteAmountUsd: number, occurredAtMs: number, blockNumber = '1') => ({
  chain: 'robinhood' as const, poolAddress: 'pool', tokenAddress: 'token', blockHash: null,
  txHash: `${trader}-${occurredAtMs}`, logIndex: 0, trader, kind, quoteAmountUsd, occurredAtMs, blockNumber,
  tokenAmount: null, priceUsd: null,
});

describe('buyer quality shadow features', () => {
  it('never promotes an unlabelled wallet to organic flow', () => {
    const snapshot = computeBuyerQualityShadow([
      trade('wallet', 'BUY', 20, 1_000),
    ], 2_000, 100, null);
    expect(snapshot.windows['15s'].organicFlowRatio).toBeNull();
    expect(snapshot.windows['15s'].unknownFlowShare).toBe(1);
  });

  it('separates creator volume from unknown volume without double counting', () => {
    const snapshot = computeBuyerQualityShadow([
      trade('creator', 'BUY', 30, 1_000),
      trade('other', 'BUY', 10, 1_500, '2'),
    ], 2_000, 100, 'creator');
    expect(snapshot.windows['15s'].classVolumeUsd.CREATOR).toBe(30);
    expect(snapshot.windows['15s'].classVolumeUsd.UNKNOWN).toBe(10);
  });
});
