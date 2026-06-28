import { DexScreenerService } from './dexscreener.service';
import { ConfigService } from '@nestjs/config';
import * as dsFixture from '../fixtures/dexscreener-token-pairs.fixture.json';

// Pair addresses used in the fixture
const PAIR_NORMAL   = '0xccc0000000000000000000000000000000000001'; // GEMX/WETH
const PAIR_REVERSED = '0xccc0000000000000000000000000000000000002'; // WETH/ALTCOIN (reversed)
const PAIR_NULL_PX  = '0xccc0000000000000000000000000000000000003'; // NPT/WETH with null priceUsd

const WETH_ADDR    = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const GEMX_ADDR    = '0xaaa0000000000000000000000000000000000001';
const ALTCOIN_ADDR = '0xaaa0000000000000000000000000000000000002';

describe('DexScreenerService — normalisePair (fixture-based)', () => {
  let service: DexScreenerService;
  let mockGet: jest.Mock;

  beforeEach(() => {
    service = new DexScreenerService({
      get: (k: string) =>
        k === 'api.dexscreenerBaseUrl' ? 'https://api.dexscreener.com' : undefined,
    } as unknown as ConfigService);

    mockGet = jest.fn();
    (service as any).http = { get: mockGet };
  });

  async function callWithFixture() {
    mockGet.mockResolvedValueOnce({ data: dsFixture });
    return service.getPairsForTokens([{ chain: 'ethereum', tokenAddress: GEMX_ADDR }]);
  }

  it('normalises normal orientation: gem = baseToken, priceUsd from API', async () => {
    const results = await callWithFixture();
    const pair = results.find((r) => r.pool.poolAddress === PAIR_NORMAL);

    expect(pair).toBeDefined();
    expect(pair!.token.symbol).toBe('GEMX');
    expect(pair!.token.tokenAddress).toBe(GEMX_ADDR);
    expect(pair!.pool.quoteAsset).toBe('WETH');
    expect(pair!.pool.quoteAssetAddress).toBe(WETH_ADDR);
    expect(pair!.pool.priceUsd).toBeCloseTo(0.001234, 6);
  });

  it('normalises reversed orientation: WETH = baseToken, gem = quoteToken', async () => {
    const results = await callWithFixture();
    const pair = results.find((r) => r.pool.poolAddress === PAIR_REVERSED);

    expect(pair).toBeDefined();
    expect(pair!.token.symbol).toBe('ALTCOIN');
    expect(pair!.pool.quoteAsset).toBe('WETH');
    expect(pair!.pool.quoteAssetAddress).toBe(WETH_ADDR);
  });

  it('reversed pair tokenAddress is gem (quoteToken), not the quote asset (baseToken)', async () => {
    const results = await callWithFixture();
    const pair = results.find((r) => r.pool.poolAddress === PAIR_REVERSED);

    expect(pair!.token.tokenAddress).toBe(ALTCOIN_ADDR);
    expect(pair!.token.tokenAddress).not.toBe(WETH_ADDR);
  });

  it('reversed pair priceUsd is undefined — cannot derive gem price without WETH spot', async () => {
    const results = await callWithFixture();
    const pair = results.find((r) => r.pool.poolAddress === PAIR_REVERSED);
    expect(pair!.pool.priceUsd).toBeUndefined();
  });

  it('handles null priceUsd — returns undefined without error', async () => {
    const results = await callWithFixture();
    const pair = results.find((r) => r.pool.poolAddress === PAIR_NULL_PX);
    expect(pair).toBeDefined();
    expect(pair!.pool.priceUsd).toBeUndefined();
  });

  it('handles absent pairCreatedAt — returns undefined without error', async () => {
    const results = await callWithFixture();
    const pair = results.find((r) => r.pool.poolAddress === PAIR_NULL_PX);
    expect(pair!.pool.poolCreatedAt).toBeUndefined();
  });

  it('parses pairCreatedAt unix-ms timestamp to a Date', async () => {
    const results = await callWithFixture();
    const pair = results.find((r) => r.pool.poolAddress === PAIR_NORMAL);
    expect(pair!.pool.poolCreatedAt).toBeInstanceOf(Date);
    expect(pair!.pool.poolCreatedAt!.getTime()).toBe(1718618400000);
  });

  it('rejects pairs where neither side is a known quote asset', async () => {
    const noQuoteFixture = {
      schemaVersion: '1.0.0',
      pairs: [{
        chainId: 'ethereum',
        dexId: 'uniswap_v3',
        url: 'https://dexscreener.com/ethereum/0xfake',
        pairAddress: '0xfff0000000000000000000000000000000000099',
        baseToken:  { address: '0xfff0000000000000000000000000000000000001', name: 'Token A', symbol: 'TKA' },
        quoteToken: { address: '0xfff0000000000000000000000000000000000002', name: 'Token B', symbol: 'TKB' },
        priceNative: '1.0', priceUsd: '1.0',
        txns: { m5: { buys: 0, sells: 0 }, h1: { buys: 0, sells: 0 }, h6: { buys: 0, sells: 0 }, h24: { buys: 0, sells: 0 } },
        volume: { m5: 0, h1: 0, h6: 0, h24: 0 },
        priceChange: { m5: 0, h1: 0, h6: 0, h24: 0 },
        fdv: 0,
      }],
    };
    mockGet.mockResolvedValueOnce({ data: noQuoteFixture });
    const results = await service.getPairsForTokens([{ chain: 'ethereum', tokenAddress: GEMX_ADDR }]);
    expect(results).toHaveLength(0);
  });

  it('parses volume fields from fixture', async () => {
    const results = await callWithFixture();
    const pair = results.find((r) => r.pool.poolAddress === PAIR_NORMAL);
    expect(pair!.pool.vol5m).toBe(500);
    expect(pair!.pool.vol1h).toBe(3000);
    expect(pair!.pool.vol6h).toBe(15000);
    expect(pair!.pool.vol24h).toBe(45000);
  });

  it('parses h1 transaction counts from fixture', async () => {
    const results = await callWithFixture();
    const pair = results.find((r) => r.pool.poolAddress === PAIR_NORMAL);
    expect(pair!.pool.buys1h).toBe(40);
    expect(pair!.pool.sells1h).toBe(20);
    expect(pair!.pool.txCount1h).toBe(60);
  });

  it('returns empty array when HTTP call throws', async () => {
    mockGet.mockRejectedValueOnce(new Error('Network error'));
    const results = await service.getPairsForTokens([{ chain: 'ethereum', tokenAddress: GEMX_ADDR }]);
    expect(results).toEqual([]);
  });

  // ── cross-chain contamination guard ──────────────────────────────────────────
  // DS /latest/dex/tokens/{addr} returns pairs from ALL chains for that address.
  // Pairs whose real chainId doesn't match the query chain must be dropped.

  it('drops pairs whose chainId does not match the queried chain', async () => {
    const mixedChainFixture = {
      schemaVersion: '1.0.0',
      pairs: [
        {
          chainId: 'ethereum',
          dexId: 'uniswap_v3',
          url: 'https://dexscreener.com/ethereum/0xccc0000000000000000000000000000000000011',
          pairAddress: '0xccc0000000000000000000000000000000000011',
          baseToken:  { address: GEMX_ADDR, name: 'Gem X', symbol: 'GEMX' },
          quoteToken: { address: WETH_ADDR,  name: 'Wrapped Ether', symbol: 'WETH' },
          priceNative: '0.001', priceUsd: '2.50',
          txns: { m5:{buys:1,sells:0}, h1:{buys:5,sells:2}, h6:{buys:10,sells:5}, h24:{buys:20,sells:10} },
          volume: { m5: 100, h1: 500, h6: 2000, h24: 5000 },
          priceChange: { m5: 0, h1: 0, h6: 0, h24: 0 },
          liquidity: { usd: 20000, base: 10000, quote: 3 },
          fdv: 500000,
          pairCreatedAt: 1718618400000,
        },
        {
          // Same token address deployed on Base — DS returns this too, must be dropped
          chainId: 'base',
          dexId: 'aerodrome',
          url: 'https://dexscreener.com/base/0xccc0000000000000000000000000000000000022',
          pairAddress: '0xccc0000000000000000000000000000000000022',
          baseToken:  { address: GEMX_ADDR, name: 'Gem X', symbol: 'GEMX' },
          quoteToken: { address: '0x4200000000000000000000000000000000000006', name: 'Wrapped Ether', symbol: 'WETH' },
          priceNative: '0.001', priceUsd: '2.50',
          txns: { m5:{buys:1,sells:0}, h1:{buys:5,sells:2}, h6:{buys:10,sells:5}, h24:{buys:20,sells:10} },
          volume: { m5: 100, h1: 500, h6: 2000, h24: 5000 },
          priceChange: { m5: 0, h1: 0, h6: 0, h24: 0 },
          liquidity: { usd: 20000, base: 10000, quote: 3 },
          fdv: 500000,
          pairCreatedAt: 1718618400000,
        },
      ],
    };

    mockGet.mockResolvedValueOnce({ data: mixedChainFixture });
    const results = await service.getPairsForTokens([{ chain: 'ethereum', tokenAddress: GEMX_ADDR }]);

    // Only the ethereum pair should survive
    expect(results).toHaveLength(1);
    expect(results[0].pool.poolAddress).toBe('0xccc0000000000000000000000000000000000011');
    expect(results[0].pool.chain).toBe('ethereum');
    // The Base pair must be completely absent
    expect(results.some((r) => r.pool.poolAddress === '0xccc0000000000000000000000000000000000022')).toBe(false);
  });
});
