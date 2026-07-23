import { EvmFlowService } from './evm-flow.service';

const candidate = {
  token: {
    chain: 'robinhood', tokenAddress: '0x1111111111111111111111111111111111111111',
    symbol: 'TEST', name: 'Test', source: 'test',
  },
  pool: {
    chain: 'robinhood', poolAddress: '0x2222222222222222222222222222222222222222',
    dex: 'test', token0Address: '0x1111111111111111111111111111111111111111',
    token1Address: '0x0bd7d308f8e1639fab988df18a8011f41eacad73',
    quoteAsset: 'WETH', quoteAssetAddress: '0x0bd7d308f8e1639fab988df18a8011f41eacad73', source: 'test',
  },
};

function service(clients = new Map()): EvmFlowService {
  const prisma = {
    evmFlowBackfillRange: { count: jest.fn().mockResolvedValue(0) },
    paperPosition: { count: jest.fn().mockResolvedValue(0) },
    evmRpcHealthSample: { create: jest.fn().mockResolvedValue({}) },
  };
  return new EvmFlowService(
    { get: jest.fn(() => undefined) } as any, prisma as any, {} as any, {} as any,
    {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any,
    {} as any, {} as any, clients as any, new Map() as any,
  );
}

describe('EvmFlowService data-plane guards', () => {
  it('keeps Base dormant unless explicitly enabled', () => {
    const flow = service();
    expect((flow as any).flowChains()).toEqual(['ethereum', 'robinhood']);
  });

  it('shares one initial head request and reuses the result for concurrent registrations', async () => {
    const flow = service();
    const client = { getBlockNumber: jest.fn().mockResolvedValue(123n) };

    await expect(Promise.all([
      (flow as any).registrationHead('robinhood', client),
      (flow as any).registrationHead('robinhood', client),
    ])).resolves.toEqual([123n, 123n]);
    await expect((flow as any).registrationHead('robinhood', client)).resolves.toBe(123n);

    expect(client.getBlockNumber).toHaveBeenCalledTimes(1);
  });

  it('defers a rate-limited registration instead of rejecting the collector Promise.all', async () => {
    const client = { getBlockNumber: jest.fn().mockRejectedValue(new Error('Rate Limit Hit')) };
    const flow = service(new Map([['robinhood', client]]));
    (flow as any).resolveModel = jest.fn().mockResolvedValue('V2');

    await expect((flow as any).register(candidate, 'FRESH')).resolves.toBe(false);
    expect((flow as any).rpcFailures.get('robinhood')).toBe(1);
  });

  it('does not let expired outcome watches poison entry health lag', async () => {
    const now = Date.now();
    const flow = service();
    const watches = (flow as any).watches as Map<string, unknown>;
    const makeWatch = (id: string, expiresAtMs: number, lastProcessedBlock: bigint) => ({
      id, candidate: { pool: { chain: 'robinhood' } }, expiresAtMs, lastProcessedBlock,
    });
    watches.set('expired', makeWatch('expired', now - 1, 1n));
    watches.set('live', makeWatch('live', now + 60_000, 99n));
    (flow as any).latestHead.set('robinhood', 100n);
    (flow as any).latestHttpHead.set('robinhood', 100n);

    await (flow as any).logHealth();

    const health = (flow as any).prisma.evmRpcHealthSample.create.mock.calls
      .map((call: any[]) => call[0].data)
      .find((row: any) => row.chain === 'robinhood');
    expect(health.lagBlocks).toBe(1);
  });
});
