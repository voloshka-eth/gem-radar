import { V2LiquidityService } from './v2-liquidity.service';

const GEM = '0x1111111111111111111111111111111111111111';
const QUOTE = '0x2222222222222222222222222222222222222222';
const POOL = '0x3333333333333333333333333333333333333333';

describe('V2LiquidityService', () => {
  it('models separate exact $20 entry and exit directions', async () => {
    const client = {
      readContract: jest.fn(async (request: any) => {
        if (request.functionName === 'token0') return QUOTE;
        if (request.functionName === 'token1') return GEM;
        if (request.functionName === 'getReserves') {
          return [10_000n * 10n ** 18n, 1_000_000n * 10n ** 18n, 0];
        }
        throw new Error(`unexpected function ${request.functionName}`);
      }),
    };
    const service = new V2LiquidityService(
      new Map([['base', client]]) as any,
      { getUsdPrice: jest.fn().mockResolvedValue(1) } as any,
    );

    const result = await service.readLiquidity({
      chain: 'base', poolAddress: POOL, dex: 'uniswap_v2',
      token0Address: QUOTE, token1Address: GEM,
      quoteAsset: 'WETH', quoteAssetAddress: QUOTE, source: 'test',
    }, 18, 30);

    expect(result.entrySlip20).toBeGreaterThan(0);
    expect(result.exitSlip20).toBeGreaterThan(0);
    expect(result.slip20).toBeCloseTo(Math.max(result.entrySlip20!, result.exitSlip20!), 12);
    expect(result.executableDepthUsd).toBeGreaterThanOrEqual(100);
  });

  it('quotes arbitrary experiment leg sizes without rounding them to the legacy ladder', async () => {
    const client = {
      readContract: jest.fn(async (request: any) => {
        if (request.functionName === 'token0') return QUOTE;
        if (request.functionName === 'token1') return GEM;
        if (request.functionName === 'getReserves') {
          return [10_000n * 10n ** 18n, 1_000_000n * 10n ** 18n, 0];
        }
        throw new Error(`unexpected function ${request.functionName}`);
      }),
    };
    const service = new V2LiquidityService(
      new Map([['robinhood', client]]) as any,
      { getUsdPrice: jest.fn().mockResolvedValue(1) } as any,
    );
    const pool = {
      chain: 'robinhood', poolAddress: POOL, dex: 'uniswap_v2',
      token0Address: QUOTE, token1Address: GEM,
      quoteAsset: 'WETH', quoteAssetAddress: QUOTE, source: 'test',
    } as any;

    const quote2 = await service.quoteTrade(pool, 18, 30, 2, 'BUY');
    const quote18 = await service.quoteTrade(pool, 18, 30, 18, 'BUY');

    expect(quote2.executable).toBe(true);
    expect(quote18.executable).toBe(true);
    expect(quote18.slippagePct!).toBeGreaterThan(quote2.slippagePct!);
    expect(quote2.sizeUsd).toBe(2);
    expect(quote18.sizeUsd).toBe(18);
  });
});
