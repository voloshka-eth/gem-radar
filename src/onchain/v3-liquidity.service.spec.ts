import { Logger } from '@nestjs/common';
import { V3LiquidityService } from './v3-liquidity.service';

const GEM = '0x1111111111111111111111111111111111111111';
const WETH = '0x2222222222222222222222222222222222222222';
const POOL = '0x3333333333333333333333333333333333333333';
const SQRT_PRICE_ONE = 2n ** 96n;

describe('V3LiquidityService', () => {
  it('condenses failed quote probes while retaining the proven executable depth', async () => {
    const client = {
      readContract: jest.fn(async (request: any) => {
        if (request.functionName === 'token0') return GEM;
        if (request.functionName === 'token1') return WETH;
        if (request.functionName === 'slot0') return [SQRT_PRICE_ONE, 0, 0, 0, 0, 0, true];
        if (request.functionName === 'balanceOf') return 100n * 10n ** 18n;
        if (request.functionName === 'quoteExactInputSingle') {
          const amountIn = request.args[0].amountIn as bigint;
          if (amountIn === 50n * 10n ** 18n) {
            return [50n * 10n ** 18n, SQRT_PRICE_ONE, 0, 0n];
          }
          throw new Error('execution reverted: TF\nContract Call: very long viem trace');
        }
        throw new Error(`unexpected function ${request.functionName}`);
      }),
    };
    const logger = jest.spyOn(Logger.prototype, 'debug').mockImplementation();
    const service = new V3LiquidityService(
      { get: jest.fn().mockReturnValue('0x4444444444444444444444444444444444444444') } as any,
      new Map([['robinhood', client]]) as any,
      { getUsdPrice: jest.fn().mockResolvedValue(1) } as any,
    );

    const result = await service.readLiquidity({
      chain: 'robinhood', poolAddress: POOL, dex: 'uniswap_v3',
      token0Address: GEM, token1Address: WETH, quoteAsset: 'WETH', quoteAssetAddress: WETH,
      source: 'test',
    }, 18, 10_000);

    expect(result.executableDepthUsd).toBe(50);
    expect(result.slip50).toBe(0);
    expect(result.slip100).toBeNull();
    expect(logger).toHaveBeenCalledWith(expect.stringContaining('unexecutable probes $100, $500, $1000 (reverted:TF)'));
    logger.mockRestore();
  });
});
