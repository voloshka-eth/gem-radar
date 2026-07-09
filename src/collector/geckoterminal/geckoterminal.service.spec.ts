import { GeckoTerminalService } from './geckoterminal.service';
import { ConfigService } from '@nestjs/config';
import * as gtFixture from '../fixtures/geckoterminal-new-pools.fixture.json';

// Pool addresses used in the fixture
const POOL_NORMAL   = '0xbbb0000000000000000000000000000000000001'; // GEMX/WETH
const POOL_REVERSED = '0xbbb0000000000000000000000000000000000002'; // WETH/ALTCOIN (reversed)
const POOL_MISSING  = '0xbbb0000000000000000000000000000000000003'; // unknown base token

const WETH_ADDR    = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const GEMX_ADDR    = '0xaaa0000000000000000000000000000000000001';
const ALTCOIN_ADDR = '0xaaa0000000000000000000000000000000000002';

describe('GeckoTerminalService — normalise (fixture-based)', () => {
  let service: GeckoTerminalService;
  let mockGet: jest.Mock;

  beforeEach(() => {
    (GeckoTerminalService as any).lastRequestAt = 0;
    (GeckoTerminalService as any).rateLimitBackoffUntil = 0;
    (GeckoTerminalService as any).statsCache = new Map();

    service = new GeckoTerminalService({
      get: (k: string) => {
        if (k === 'api.geckoterminalBaseUrl') return 'https://api.geckoterminal.com/api/v2';
        if (k === 'collector.geckoTerminalPages') return 1;
        if (k === 'collector.geckoTerminalRequestDelayMs') return 0;
        if (k === 'collector.geckoTerminalRateLimitBackoffMs') return 300_000;
        if (k === 'collector.geckoTerminalStatsCacheTtlMs') return 600_000;
        return undefined;
      },
    } as unknown as ConfigService);

    mockGet = jest.fn().mockResolvedValue({ data: gtFixture });
    (service as any).http = { get: mockGet };
  });

  it('normalises normal orientation: gem = baseToken, WETH = quoteToken', async () => {
    const results = await service.getNewPools('ethereum');
    const pool = results.find((r) => r.pool.poolAddress === POOL_NORMAL);

    expect(pool).toBeDefined();
    expect(pool!.token.symbol).toBe('GEMX');
    expect(pool!.token.tokenAddress).toBe(GEMX_ADDR);
    expect(pool!.pool.quoteAsset).toBe('WETH');
    expect(pool!.pool.quoteAssetAddress).toBe(WETH_ADDR);
  });

  it('normal orientation uses base_token_price_usd for gem price', async () => {
    const results = await service.getNewPools('ethereum');
    const pool = results.find((r) => r.pool.poolAddress === POOL_NORMAL);
    expect(pool!.pool.priceUsd).toBeCloseTo(0.001234, 6);
  });

  it('normalises reversed orientation: WETH = baseToken, gem = quoteToken', async () => {
    const results = await service.getNewPools('ethereum');
    const pool = results.find((r) => r.pool.poolAddress === POOL_REVERSED);

    expect(pool).toBeDefined();
    expect(pool!.token.symbol).toBe('ALTCOIN');
    expect(pool!.token.tokenAddress).toBe(ALTCOIN_ADDR);
    expect(pool!.pool.quoteAsset).toBe('WETH');
    expect(pool!.pool.quoteAssetAddress).toBe(WETH_ADDR);
  });

  it('reversed orientation uses quote_token_price_usd — regression: must NOT return WETH price', async () => {
    const results = await service.getNewPools('ethereum');
    const pool = results.find((r) => r.pool.poolAddress === POOL_REVERSED);

    // gem (ALTCOIN) is quoteToken → quote_token_price_usd = 0.000876
    // base_token_price_usd is the WETH price (3198.22) and must NOT be used
    expect(pool!.pool.priceUsd).toBeCloseTo(0.000876, 6);
    expect(pool!.pool.priceUsd).not.toBeCloseTo(3198.22, 0);
  });

  it('skips pool whose baseToken is absent from included array', async () => {
    const results = await service.getNewPools('ethereum');
    const missing = results.find((r) => r.pool.poolAddress === POOL_MISSING);
    expect(missing).toBeUndefined();
    expect(results).toHaveLength(2);
  });

  it('parses pool_created_at string as a Date', async () => {
    const results = await service.getNewPools('ethereum');
    const pool = results.find((r) => r.pool.poolAddress === POOL_NORMAL);
    expect(pool!.pool.poolCreatedAt).toBeInstanceOf(Date);
    expect(pool!.pool.poolCreatedAt!.toISOString()).toBe('2024-06-17T10:00:00.000Z');
  });

  it('returns undefined poolCreatedAt when pool_created_at is null', async () => {
    const fixture = {
      ...gtFixture,
      data: [{ ...gtFixture.data[0], attributes: { ...gtFixture.data[0].attributes, pool_created_at: null } }],
    };
    mockGet.mockResolvedValueOnce({ data: fixture });
    const results = await service.getNewPools('ethereum');
    expect(results).toHaveLength(1);
    expect(results[0].pool.poolCreatedAt).toBeUndefined();
  });

  it('fetches multiple GeckoTerminal pages when configured', async () => {
    service = new GeckoTerminalService({
      get: (k: string) => {
        if (k === 'api.geckoterminalBaseUrl') return 'https://api.geckoterminal.com/api/v2';
        if (k === 'collector.geckoTerminalPages') return 2;
        if (k === 'collector.geckoTerminalRequestDelayMs') return 0;
        return undefined;
      },
    } as unknown as ConfigService);

    mockGet = jest.fn()
      .mockResolvedValueOnce({ data: gtFixture })
      .mockResolvedValueOnce({ data: { ...gtFixture, data: [] } });
    (service as any).http = { get: mockGet };

    const results = await service.getNewPools('ethereum');

    expect(mockGet).toHaveBeenCalledTimes(2);
    expect(mockGet.mock.calls[0][1].params.page).toBe(1);
    expect(mockGet.mock.calls[1][1].params.page).toBe(2);
    expect(results).toHaveLength(2);
  });

  it('returns undefined liquidityUsd and fdvUsd when API fields are null', async () => {
    const fixture = {
      ...gtFixture,
      data: [{ ...gtFixture.data[0], attributes: { ...gtFixture.data[0].attributes, reserve_in_usd: null, fdv_usd: null } }],
    };
    mockGet.mockResolvedValueOnce({ data: fixture });
    const results = await service.getNewPools('ethereum');
    expect(results[0].pool.liquidityUsd).toBeUndefined();
    expect(results[0].pool.fdvUsd).toBeUndefined();
  });

  it('parses volume_usd fields from fixture', async () => {
    const results = await service.getNewPools('ethereum');
    const pool = results.find((r) => r.pool.poolAddress === POOL_NORMAL);
    expect(pool!.pool.vol5m).toBe(500);
    expect(pool!.pool.vol1h).toBe(3000);
    expect(pool!.pool.vol6h).toBe(15000);
    expect(pool!.pool.vol24h).toBe(45000);
  });

  it('parses h1 transaction counts from fixture', async () => {
    const results = await service.getNewPools('ethereum');
    const pool = results.find((r) => r.pool.poolAddress === POOL_NORMAL);
    expect(pool!.pool.buys1h).toBe(40);
    expect(pool!.pool.sells1h).toBe(20);
    expect(pool!.pool.txCount1h).toBe(60);
  });

  it('returns empty array when HTTP call throws', async () => {
    mockGet.mockRejectedValueOnce(new Error('Network error'));
    const results = await service.getNewPools('ethereum');
    expect(results).toEqual([]);
  });

  it('opens shared backoff after GeckoTerminal 429 and skips the next request', async () => {
    const rateLimitErr = {
      isAxiosError: true,
      message: 'Request failed with status code 429',
      response: { status: 429, headers: { 'retry-after': '2' } },
    };
    mockGet.mockRejectedValueOnce(rateLimitErr);

    const first = await service.getNewPools('ethereum');
    const second = await service.getTrendingPools('ethereum');

    expect(first).toEqual([]);
    expect(second).toEqual([]);
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it('caches per-pool trade stats to avoid repeated eval calls', async () => {
    mockGet.mockResolvedValue({
      data: { data: gtFixture.data[0] },
    });

    const first = await service.getPoolTradeStats('ethereum', POOL_NORMAL);
    const second = await service.getPoolTradeStats('ethereum', POOL_NORMAL);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      buys: 40,
      sells: 20,
      uniqueBuyers: 30,
      uniqueSellers: 15,
      window: 'h1',
    });
    expect(mockGet).toHaveBeenCalledTimes(1);
  });
});
