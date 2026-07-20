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
      creationBlockNumber: '100',
    }, 18);

    expect(result.spotPriceUsd).toBeCloseTo(2_000, 8);
    expect(result.slip50).toBeCloseTo(0, 8);
    expect(result.executableDepthUsd).toBe(1000);
    expect(client.getLogs).toHaveBeenCalledTimes(1);
    expect(client.getLogs).toHaveBeenCalledWith(expect.objectContaining({
      address: '0x498581ff718922c3f8e6a244956af099b2652b2b',
      fromBlock: 100n,
      toBlock: 'latest',
    }));
  });

  it('does not scan from genesis when enrichment omitted V4 metadata', async () => {
    const client = { getLogs: jest.fn(), readContract: jest.fn() };
    const config = {
      get: (key: string) => ({
        'onchain.v4PoolManagerBase': '0x498581ff718922c3f8e6a244956af099b2652b2b',
        'onchain.v4QuoterBase': '0x0d5e0f971ed27fbff6c2837bf31316121532048d',
        'onchain.v4StateViewBase': '0xa3c0c9b65bad0b08107aa264b0f3db444b867a71',
      })[key],
    } as ConfigService;
    const service = new V4LiquidityService(config, new Map([['base', client]]) as any, {} as any);

    await expect(service.readLiquidity({
      chain: 'base', poolAddress: POOL_ID, dex: 'Uniswap V4',
      token0Address: GEM, token1Address: WETH,
      quoteAsset: 'WETH', quoteAssetAddress: WETH, source: 'enrichment',
    }, 18)).rejects.toThrow('metadata unavailable without a creation block');
    expect(client.getLogs).not.toHaveBeenCalled();
  });

  it('uses factory-discovered PoolKey metadata without a genesis-wide log scan', async () => {
    const readContract = jest
      .fn()
      .mockResolvedValueOnce([SQRT_PRICE_ONE, 0, 0, 3000])
      .mockImplementation(async (request: { functionName: string; args: unknown[] }) => {
        if (request.functionName !== 'quoteExactInputSingle') throw new Error('unexpected call');
        const params = request.args[0] as { exactAmount: bigint };
        return [params.exactAmount, 100_000n];
      });
    const client = { getLogs: jest.fn(), readContract };
    const config = {
      get: (key: string) => ({
        'onchain.v4PoolManagerBase': '0x498581ff718922c3f8e6a244956af099b2652b2b',
        'onchain.v4QuoterBase': '0x0d5e0f971ed27fbff6c2837bf31316121532048d',
        'onchain.v4StateViewBase': '0xa3c0c9b65bad0b08107aa264b0f3db444b867a71',
      })[key],
    } as ConfigService;
    const service = new V4LiquidityService(config, new Map([['base', client]]) as any, { getUsdPrice: jest.fn().mockResolvedValue(2_000) } as any);

    const result = await service.readLiquidity({
      chain: 'base', poolAddress: POOL_ID, dex: 'Uniswap V4', token0Address: GEM, token1Address: WETH,
      quoteAsset: 'WETH', quoteAssetAddress: WETH, source: 'test',
      v4Metadata: { currency0: NATIVE, currency1: GEM, fee: 3000, tickSpacing: 60, hooks: NATIVE, sqrtPriceX96: SQRT_PRICE_ONE },
    }, 18);

    expect(result.executableDepthUsd).toBe(1000);
    expect(client.getLogs).not.toHaveBeenCalled();
  });

  it('stops after the smallest probe when a hook-backed pool cannot be quoted', async () => {
    const readContract = jest
      .fn()
      .mockResolvedValueOnce([SQRT_PRICE_ONE, 0, 0, 3000])
      .mockRejectedValueOnce(new Error(
        'The contract function "quoteExactInputSingle" reverted with the following signature:\n0x6190b2b0',
      ));
    const client = { getLogs: jest.fn(), readContract };
    const config = {
      get: (key: string) => ({
        'onchain.v4PoolManagerBase': '0x498581ff718922c3f8e6a244956af099b2652b2b',
        'onchain.v4QuoterBase': '0x0d5e0f971ed27fbff6c2837bf31316121532048d',
        'onchain.v4StateViewBase': '0xa3c0c9b65bad0b08107aa264b0f3db444b867a71',
      })[key],
    } as ConfigService;
    const service = new V4LiquidityService(
      config,
      new Map([['base', client]]) as any,
      { getUsdPrice: jest.fn().mockResolvedValue(2_000) } as any,
    );

    const result = await service.readLiquidity({
      chain: 'base', poolAddress: POOL_ID, dex: 'Uniswap V4', token0Address: GEM, token1Address: WETH,
      quoteAsset: 'WETH', quoteAssetAddress: WETH, source: 'test',
      v4Metadata: {
        currency0: NATIVE,
        currency1: GEM,
        fee: 8_388_608,
        tickSpacing: 200,
        hooks: '0xb429d62f8f3bffb98cdb9569533ea23bf0ba28cc',
        sqrtPriceX96: SQRT_PRICE_ONE,
      },
    }, 18);

    expect(result).toMatchObject({
      slip50: null,
      slip100: null,
      slip500: null,
      slip1000: null,
      executableDepthUsd: 0,
    });
    expect(readContract).toHaveBeenCalledTimes(2);
  });
});
