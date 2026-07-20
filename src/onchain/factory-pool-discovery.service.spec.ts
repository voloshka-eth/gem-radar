import { FactoryPoolDiscoveryService } from './factory-pool-discovery.service';

const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const TOKEN = '0x1111111111111111111111111111111111111111';
const PAIR = '0x2222222222222222222222222222222222222222';
const BASE_WETH = '0x4200000000000000000000000000000000000006';
const V4_ID = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function config(values: Record<string, unknown> = {}) {
  return {
    get: (key: string) => ({
      'collector.factoryDiscoveryEnabled': true,
      'collector.factoryDiscoveryInitialLookbackEthereum': 30,
      'collector.factoryDiscoveryInitialLookbackBase': 120,
      'collector.factoryDiscoveryPendingTtlMs': 1_800_000,
      'onchain.uniswapV2FactoryEthereum': '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f',
      'onchain.uniswapV3FactoryEthereum': '0x1F98431c8aD98523631AE4a59f267346ea31F984',
      'onchain.uniswapV3FactoryBase': '0x33128a8fC17869897dcE68Ed026d694621f6FDfD',
      'onchain.aerodromeFactoryBase': '0x420DD381b31aEf6683db6B902084cB0FFECe40Da',
      'onchain.v4PoolManagerEthereum': '0x000000000004444c5dc75cB358380D2e3dE08A90',
      'onchain.v4PoolManagerBase': '0x498581ff718922c3f8e6a244956af099b2652b2b',
      ...values,
    })[key],
  } as any;
}

describe('FactoryPoolDiscoveryService', () => {
  it('turns a Uniswap V2 quote-pair event into a pending on-chain candidate', async () => {
    const client = {
      getBlockNumber: jest.fn().mockResolvedValue(1_000n),
      getBlock: jest.fn().mockResolvedValue({ timestamp: 1_700_000_000n }),
      getLogs: jest.fn().mockImplementation(({ address }: { address: string }) =>
        address.toLowerCase() === '0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f'
          ? [{ blockNumber: 999n, args: { token0: TOKEN, token1: WETH, pair: PAIR } }]
          : [],
      ),
    };
    const service = new FactoryPoolDiscoveryService(config(), new Map([['ethereum', client]]) as any);

    const pools = await service.getPendingPools('ethereum');

    expect(pools).toEqual([expect.objectContaining({
      token: expect.objectContaining({ tokenAddress: TOKEN, source: 'onchain_factory' }),
      pool: expect.objectContaining({ poolAddress: PAIR, quoteAsset: 'WETH', dex: 'Uniswap V2' }),
    })]);
    expect(client.getLogs).toHaveBeenCalledWith(expect.objectContaining({ fromBlock: 970n, toBlock: 1_000n }));
  });

  it('keeps an unhandled factory event available on the next cycle and removes it when handled', async () => {
    const client = {
      getBlockNumber: jest.fn().mockResolvedValue(1_000n),
      getBlock: jest.fn(),
      getLogs: jest.fn().mockResolvedValue([]),
    };
    const service = new FactoryPoolDiscoveryService(config(), new Map([['ethereum', client]]) as any);
    (service as any).pending.set(`ethereum:${PAIR}`, {
      firstObservedAt: Date.now(),
      candidate: {
        token: { chain: 'ethereum', tokenAddress: TOKEN, symbol: '', name: '', source: 'onchain_factory' },
        pool: {
          chain: 'ethereum', poolAddress: PAIR, dex: 'Uniswap V2', token0Address: TOKEN, token1Address: WETH,
          quoteAsset: 'WETH', quoteAssetAddress: WETH, poolCreatedAt: new Date(), source: 'onchain_factory',
        },
      },
    });

    const [candidate] = await service.getPendingPools('ethereum');
    expect(candidate.pool.poolAddress).toBe(PAIR);
    service.markHandled(candidate);
    await expect(service.getPendingPools('ethereum')).resolves.toEqual([]);
  });

  it('fast-forwards a stale cursor to the live lookback instead of requesting archive logs', async () => {
    const client = {
      getBlockNumber: jest.fn().mockResolvedValue(1_000n),
      getLogs: jest.fn().mockResolvedValue([]),
    };
    const service = new FactoryPoolDiscoveryService(config(), new Map([['ethereum', client]]) as any);
    (service as any).lastProcessedBlock.set(
      'ethereum:0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f',
      1n,
    );

    await service.getPendingPools('ethereum');

    expect(client.getLogs).toHaveBeenCalledWith(expect.objectContaining({ fromBlock: 970n, toBlock: 1_000n }));
  });

  it('recognizes a V4 Initialize event with native ETH as a WETH-quoted pool', async () => {
    const client = {
      getBlockNumber: jest.fn().mockResolvedValue(2_000n),
      getBlock: jest.fn().mockResolvedValue({ timestamp: 1_700_000_000n }),
      getLogs: jest.fn().mockImplementation(({ address }: { address: string }) =>
        address.toLowerCase() === '0x498581ff718922c3f8e6a244956af099b2652b2b'
          ? [{
            blockNumber: 1_999n,
            args: {
              id: V4_ID, currency0: '0x0000000000000000000000000000000000000000', currency1: TOKEN,
              fee: 3000, tickSpacing: 60, hooks: '0x0000000000000000000000000000000000000000', sqrtPriceX96: 2n ** 96n,
            },
          }]
          : [],
      ),
    };
    const service = new FactoryPoolDiscoveryService(config(), new Map([['base', client]]) as any);

    const pools = await service.getPendingPools('base');

    expect(pools).toEqual([expect.objectContaining({
      token: expect.objectContaining({ tokenAddress: TOKEN }),
      pool: expect.objectContaining({
        poolAddress: V4_ID, quoteAsset: 'WETH', quoteAssetAddress: BASE_WETH, dex: 'Uniswap V4',
        v4Metadata: expect.objectContaining({ fee: 3000, tickSpacing: 60, sqrtPriceX96: 2n ** 96n }),
      }),
    })]);
  });
});
