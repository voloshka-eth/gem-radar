import { applyStage0Gate, filterDuplicates, Stage0Config } from './stage0-gate';
import { CollectorResult, CandidatePool, SupportedChain } from './collector.types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const BASE_CONFIG: Stage0Config = {
  maxPoolAgeMs: 6 * 60 * 60 * 1000, // 6h
  minLiquidityUsd: 5_000,
  minFdvUsd: 10_000,
  maxFdvUsd: 50_000_000,
};

function buildCandidate(poolOverrides: Partial<CandidatePool> = {}): CollectorResult {
  const chain: SupportedChain = poolOverrides.chain ?? 'ethereum';
  return {
    token: {
      chain,
      tokenAddress: '0xtoken',
      symbol: 'GEM',
      name: 'Gem Token',
      source: 'test',
    },
    pool: {
      chain,
      poolAddress: '0xpool',
      dex: 'uniswap_v3',
      token0Address: '0xtoken',
      token1Address: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
      quoteAsset: 'WETH',
      quoteAssetAddress: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
      priceUsd: 0.001,
      liquidityUsd: 50_000,
      fdvUsd: 1_000_000,
      poolCreatedAt: new Date(Date.now() - 30 * 60 * 1000), // 30 min ago
      source: 'test',
      ...poolOverrides,
    },
  };
}

// ─── applyStage0Gate ─────────────────────────────────────────────────────────

describe('applyStage0Gate', () => {
  it('passes a fully valid candidate', () => {
    expect(applyStage0Gate(buildCandidate(), BASE_CONFIG)).toEqual({ pass: true });
  });

  it('rejects when quoteAsset is empty string', () => {
    const result = applyStage0Gate(buildCandidate({ quoteAsset: '' }), BASE_CONFIG);
    expect(result).toEqual({ pass: false, reason: 'quote_asset_not_accepted' });
  });

  it('rejects when quoteAsset is undefined-ish (normalised to empty by callers)', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = applyStage0Gate(buildCandidate({ quoteAsset: undefined as any }), BASE_CONFIG);
    expect(result).toEqual({ pass: false, reason: 'quote_asset_not_accepted' });
  });

  it('rejects explicitly blocklisted tickers before liquidity and FDV checks', () => {
    const candidate = buildCandidate({ liquidityUsd: 50_000, fdvUsd: 1_000_000 });
    candidate.token.symbol = '$OPENHUMAN';

    const result = applyStage0Gate(candidate, {
      ...BASE_CONFIG,
      blockedTokenSymbols: ['openhuman'],
    });

    expect(result).toEqual({ pass: false, reason: 'ticker_blocklisted' });
  });

  it('rejects a pool older than maxPoolAgeMs', () => {
    const oldDate = new Date(Date.now() - 7 * 60 * 60 * 1000); // 7h ago
    const result = applyStage0Gate(buildCandidate({ poolCreatedAt: oldDate }), BASE_CONFIG);
    expect(result).toEqual({ pass: false, reason: 'pool_too_old' });
  });

  it('keeps an older pool with fresh momentum for downstream on-chain checks', () => {
    const oldDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const result = applyStage0Gate(buildCandidate({
      poolCreatedAt: oldDate,
      vol1h: 25_000,
      txCount1h: 4,
      buys1h: 2,
    }), BASE_CONFIG);
    expect(result).toEqual({ pass: true, lane: 'mature_momentum' });
  });

  it('keeps an active pool below the reported floor when it has enough probe liquidity', () => {
    const result = applyStage0Gate(buildCandidate({
      liquidityUsd: 1_200,
      vol1h: 25_000,
      txCount1h: 4,
      buys1h: 2,
    }), BASE_CONFIG);
    expect(result).toEqual({ pass: true, lane: 'mature_momentum' });
  });

  it('passes when poolCreatedAt is undefined — missing age data must not false-reject', () => {
    const result = applyStage0Gate(buildCandidate({ poolCreatedAt: undefined }), BASE_CONFIG);
    expect(result).toEqual({ pass: true });
  });

  it('passes a pool exactly at the age boundary', () => {
    const borderDate = new Date(Date.now() - BASE_CONFIG.maxPoolAgeMs + 1000); // 1s inside limit
    expect(applyStage0Gate(buildCandidate({ poolCreatedAt: borderDate }), BASE_CONFIG)).toEqual({
      pass: true,
    });
  });

  it('rejects when liquidityUsd is below minimum', () => {
    const result = applyStage0Gate(buildCandidate({ liquidityUsd: 1_000 }), BASE_CONFIG);
    expect(result).toEqual({ pass: false, reason: 'liquidity_too_low' });
  });

  it('passes when liquidityUsd is undefined — missing data must not false-reject', () => {
    expect(applyStage0Gate(buildCandidate({ liquidityUsd: undefined }), BASE_CONFIG)).toEqual({
      pass: true,
    });
  });

  it('rejects when fdvUsd is below minFdvUsd', () => {
    expect(applyStage0Gate(buildCandidate({ fdvUsd: 5_000 }), BASE_CONFIG)).toEqual({
      pass: false,
      reason: 'fdv_too_low',
    });
  });

  it('moonshot bypass passes low-FDV tokens with tradable liquidity and strong early traction', () => {
    expect(
      applyStage0Gate(
        buildCandidate({
          liquidityUsd: 6_754.38,
          fdvUsd: 6_433.77,
          vol1h: 5_089.7,
          buys1h: 52,
          txCount1h: 69,
        }),
        {
          ...BASE_CONFIG,
          moonshotEnabled: true,
          moonshotMinLiquidityUsd: 1_000,
          moonshotMinFdvUsd: 1_000,
          moonshotMinVol1hUsd: 1_000,
          moonshotMinTx1h: 30,
          moonshotMinBuys1h: 15,
        },
      ),
    ).toEqual({ pass: true, lane: 'moonshot_probe' });
  });

  it('moonshot bypass still rejects dust-liquidity tokens as untradeable', () => {
    expect(
      applyStage0Gate(
        buildCandidate({
          liquidityUsd: 0.0027,
          fdvUsd: 2_070,
          vol1h: 0,
          vol6h: 1_817,
          buys1h: 0,
          txCount1h: 0,
        }),
        {
          ...BASE_CONFIG,
          moonshotEnabled: true,
          moonshotMinLiquidityUsd: 1_000,
          moonshotMinFdvUsd: 1_000,
          moonshotMinVol1hUsd: 1_000,
          moonshotMinTx1h: 30,
          moonshotMinBuys1h: 15,
        },
      ),
    ).toEqual({ pass: false, reason: 'liquidity_too_low' });
  });

  it('rejects when fdvUsd exceeds maxFdvUsd', () => {
    expect(applyStage0Gate(buildCandidate({ fdvUsd: 100_000_000 }), BASE_CONFIG)).toEqual({
      pass: false,
      reason: 'fdv_too_high',
    });
  });

  it('passes when fdvUsd is undefined — missing data must not false-reject', () => {
    expect(applyStage0Gate(buildCandidate({ fdvUsd: undefined }), BASE_CONFIG)).toEqual({
      pass: true,
    });
  });

  it('passes at exact minLiquidityUsd boundary', () => {
    expect(
      applyStage0Gate(buildCandidate({ liquidityUsd: BASE_CONFIG.minLiquidityUsd }), BASE_CONFIG),
    ).toEqual({ pass: true });
  });

  it('passes at exact maxFdvUsd boundary', () => {
    expect(
      applyStage0Gate(buildCandidate({ fdvUsd: BASE_CONFIG.maxFdvUsd }), BASE_CONFIG),
    ).toEqual({ pass: true });
  });
});

// ─── filterDuplicates ────────────────────────────────────────────────────────

describe('filterDuplicates', () => {
  it('removes duplicate (chain, poolAddress) within a single batch', () => {
    const seen = new Set<string>();
    const c1 = buildCandidate({ poolAddress: '0xpool1' });
    const c2 = buildCandidate({ poolAddress: '0xpool1' }); // same pool
    const c3 = buildCandidate({ poolAddress: '0xpool2' });

    const result = filterDuplicates([c1, c2, c3], seen);
    expect(result).toHaveLength(2);
    expect(result[0].pool.poolAddress).toBe('0xpool1');
    expect(result[1].pool.poolAddress).toBe('0xpool2');
  });

  it('first occurrence wins when deduplicating', () => {
    const seen = new Set<string>();
    const first = buildCandidate({ poolAddress: '0xpool1', priceUsd: 0.001 });
    const second = buildCandidate({ poolAddress: '0xpool1', priceUsd: 0.999 }); // ignored

    const result = filterDuplicates([first, second], seen);
    expect(result).toHaveLength(1);
    expect(result[0].pool.priceUsd).toBe(0.001);
  });

  it('same pool address on different chains is NOT a duplicate', () => {
    const seen = new Set<string>();
    const eth = buildCandidate({ chain: 'ethereum', poolAddress: '0xpool1' });
    const base = buildCandidate({ chain: 'base', poolAddress: '0xpool1' });

    const result = filterDuplicates([eth, base], seen);
    expect(result).toHaveLength(2);
  });

  it('rejects duplicates ACROSS two consecutive calls sharing the same Set', () => {
    const seen = new Set<string>();
    const c = buildCandidate({ poolAddress: '0xpool1' });

    // First call — from GeckoTerminal
    const batch1 = filterDuplicates([c], seen);
    expect(batch1).toHaveLength(1);

    // Second call — from DexScreener, same pool
    const batch2 = filterDuplicates([c], seen);
    expect(batch2).toHaveLength(0);
  });

  it('passes unique pools across two consecutive calls', () => {
    const seen = new Set<string>();
    const gt = [buildCandidate({ poolAddress: '0xpool1' })];
    const ds = [
      buildCandidate({ poolAddress: '0xpool1' }), // duplicate — should be filtered
      buildCandidate({ poolAddress: '0xpool2' }), // unique — should pass
    ];

    const r1 = filterDuplicates(gt, seen);
    const r2 = filterDuplicates(ds, seen);

    expect(r1).toHaveLength(1);
    expect(r2).toHaveLength(1);
    expect(r2[0].pool.poolAddress).toBe('0xpool2');
  });

  it('returns empty array for empty input', () => {
    expect(filterDuplicates([], new Set())).toEqual([]);
  });
});
