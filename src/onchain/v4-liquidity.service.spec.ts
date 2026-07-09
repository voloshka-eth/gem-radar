import { ConfigService } from '@nestjs/config';
import { V4LiquidityService } from './v4-liquidity.service';

const GEM = '0x1111111111111111111111111111111111111111';
const WETH = '0x4200000000000000000000000000000000000006';
const NATIVE = '0x0000000000000000000000000000000000000000';
const POOL_ID = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SQRT_PRICE_ONE = 2n ** 96n;

describe('V4LiquidityService', () => {
  it('reconstructs the PoolKey from Initialize and uses the Quoter sell probe', async () => {
    const readContract = jest
      .fn()
      .mockResolvedValueOnce([SQRT_PRICE_ONE, 0, 0, 3000])
      .mockImplementation(async (request: { functionName: string; args: unknown[] }) => {
        expect(request.functionName).toBe('quoteExactInputSingle');
        const params = request.args[0] as {
          poolKey: { currency0: string; currency1: string };
          zeroForOne: boolean;
          exactAmount: bigint;
        };
        expect(params.poolKey).toMatchObject({ currency0: NATIVE, currency1: GEM, fee: 3000, tickSpacing: 60 });
        expect(params.zeroForOne).toBe(false);
        return [params.exactAmount, 100_000n];
      });
    const client = {
      getLogs: jest.fn().mockResolvedValue([{
        args: {
          id: POOL_ID,
          currency0: NATIVE,
          currency1: GEM,
          fee: 3000,
          tickSpacing: 60,
          hooks: '0x0000000000000000000000000000000000000000',
          sqrtPriceX96: SQRT_PRICE_ONE,
        },
      }]),
      readContract,
    };
    const config = {
      get: (key: string) => ({
        'onchain.v4PoolManagerBase': '0x498581ff718922c3f8e6a244956af099b2652b2b',
        'onchain.v4QuoterBase': '0x0d5e0f971ed27fbff6c2837bf31316121532048d',
        'onchain.v4StateViewBase': '0xa3c0c9b65bad0b08107aa264b0f3db444b867a71',
      })[key],
    } as ConfigService;
    const price = { getUsdPrice: jest.fn().mockResolvedValue(2_000) };
    const service = new V4LiquidityService(config, new Map([['base', client]]) as any, price as any);

    const result = await service.readLiquidity({
      chain: 'base', poolAddress: POOL_ID, dex: 'Uniswap V4',
      token0Address: GEM, token1Address: WETH,
      quoteAsset: 'WETH', quoteAssetAddress: WETH, source: 'test',
    }, 18);

    expect(result.spotPriceUsd).toBeCloseTo(2_000, 8);
    expect(result.slip50).toBeCloseTo(0, 8);
    expect(result.executableDepthUsd).toBe(1000);
    expect(client.getLogs).toHaveBeenCalledTimes(1);
    expect(client.getLogs).toHaveBeenCalledWith(expect.objectContaining({
      address: '0x498581ff718922c3f8e6a244956af099b2652b2b',
      fromBlock: 0n,
      toBlock: 'latest',
    }));
  });
});
