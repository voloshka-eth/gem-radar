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

function service(
  clients = new Map(),
  configValues: Record<string, unknown> = {},
  streamClients = new Map(),
): EvmFlowService {
  const prisma = {
    evmFlowBackfillRange: {
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      upsert: jest.fn().mockResolvedValue({}),
    },
    paperPosition: { count: jest.fn().mockResolvedValue(0) },
    evmRpcHealthSample: { create: jest.fn().mockResolvedValue({}) },
  };
  return new EvmFlowService(
    { get: jest.fn((key: string) => configValues[key]) } as any, prisma as any, {} as any, {} as any,
    {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any,
    {} as any, { getAttemptSnapshot: jest.fn().mockReturnValue(null) } as any,
    clients as any, streamClients as any,
  );
}

describe('EvmFlowService data-plane guards', () => {
  it('keeps Base dormant unless explicitly enabled', () => {
    const flow = service();
    expect((flow as any).flowChains()).toEqual(['ethereum', 'robinhood']);
  });

  it('uses the empirically supported wider log range only on Robinhood', () => {
    const flow = service();
    expect((flow as any).maxLogRangeBlocks('ethereum')).toBe(64n);
    expect((flow as any).maxLogRangeBlocks('base')).toBe(400n);
    expect((flow as any).maxLogRangeBlocks('robinhood')).toBe(2_000n);
  });

  it('uses a dedicated bounded block-read budget for high-throughput Robinhood', () => {
    const defaults = service();
    expect((defaults as any).blockReadConcurrency('ethereum')).toBe(2);
    expect((defaults as any).blockReadConcurrency('robinhood')).toBe(4);

    const configured = service(new Map(), {
      'evmFlow.blockReadConcurrency': 3,
      'evmFlow.blockReadConcurrencyRobinhood': 6,
    });
    expect((configured as any).blockReadConcurrency('ethereum')).toBe(3);
    expect((configured as any).blockReadConcurrency('robinhood')).toBe(6);
  });

  it('keeps Robinhood experiment RPC work off the head path with bounded workers', async () => {
    const flow = service(new Map(), {
      'evmFlow.robinhoodExperimentConcurrency': 2,
      'evmFlow.robinhoodExperimentDiscoveryMinIntervalMs': 0,
    });
    const never = new Promise<number | null>(() => undefined);
    const handleTick = jest.fn().mockReturnValue(never);
    (flow as any).robinhoodExperiment.handleTick = handleTick;
    const now = Date.now();

    for (let index = 0; index < 4; index += 1) {
      const state = {
        id: `watch-${index}`,
        expiresAtMs: now + 60_000,
        swapTrackingUntilMs: now + 60_000,
      };
      (flow as any).enqueueRobinhoodExperimentTick(state, {
        candidate: { token: { tokenAddress: `token-${index}` } },
      });
    }
    await Promise.resolve();

    expect(handleTick).toHaveBeenCalledTimes(2);
    expect((flow as any).robinhoodExperimentWorkers).toBe(2);
    expect((flow as any).pendingRobinhoodExperimentJobs.size).toBe(2);
  });

  it('registers an HTTP head fallback when a WSS stream is configured', () => {
    const stop = jest.fn();
    const streamClient = {
      watchBlocks: jest.fn().mockReturnValue(stop),
    };
    const flow = service(
      new Map([['robinhood', { getBlockNumber: jest.fn() }]]),
      { 'chain.robinhoodRpcWsUrl': 'wss://example.invalid' },
      new Map([['robinhood', streamClient]]),
    );
    const startHttp = jest.spyOn(flow as any, 'startHttpHeadPoller').mockImplementation(() => undefined);

    (flow as any).startHeadWatcher('robinhood');

    expect(streamClient.watchBlocks).toHaveBeenCalled();
    expect(startHttp).toHaveBeenCalledWith('robinhood', true);
  });

  it('does not hold the HTTP poll lock while a previous head is still processing', async () => {
    const client = { getBlockNumber: jest.fn().mockResolvedValue(123n) };
    const flow = service(new Map([['robinhood', client]]));
    jest.spyOn(flow as any, 'enqueueHead').mockImplementation(() => new Promise(() => undefined));

    (flow as any).startHttpHeadPoller('robinhood');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(client.getBlockNumber).toHaveBeenCalledTimes(1);
    expect((flow as any).latestHttpHead.get('robinhood')).toBe(123n);
    expect((flow as any).headPollBusy.has('robinhood')).toBe(false);
    for (const stop of (flow as any).unwatch) stop();
  });

  it('decodes only logs newer than the cursor of their exact pool watch', () => {
    const flow = service();
    const state = {
      model: 'V3',
      lastProcessedBlock: 100n,
      candidate: { pool: { poolAddress: candidate.pool.poolAddress } },
    };
    const log = (blockNumber: bigint) => ({
      address: candidate.pool.poolAddress,
      blockNumber,
      transactionHash: `0x${blockNumber.toString(16).padStart(64, '0')}`,
      logIndex: 0,
    });

    expect((flow as any).logsAfterWatchCursor([state], [log(99n), log(100n), log(101n)]))
      .toEqual([log(101n)]);
  });

  it('does not split transient log-provider failures into an RPC storm', () => {
    const flow = service();
    expect((flow as any).shouldSplitLogBatch(new Error('429 Too Many Requests'))).toBe(false);
    expect((flow as any).shouldSplitLogBatch(new Error('network timeout'))).toBe(false);
    expect((flow as any).shouldSplitLogBatch(new Error('invalid params: address array too large'))).toBe(true);
  });

  it('gets exact trader identity without downloading every transaction in the block', async () => {
    const flow = service();
    const hash = `0x${'1'.repeat(64)}`;
    const trader = `0x${'3'.repeat(40)}`;
    const state = {
      model: 'V2',
      lastProcessedBlock: 100n,
      gemDecimals: 18,
      poolToken0Address: candidate.pool.token0Address,
      poolToken1Address: candidate.pool.token1Address,
      candidate: {
        token: candidate.token,
        pool: {
          ...candidate.pool,
          quoteAsset: 'USDC',
          quoteAssetAddress: candidate.pool.token1Address,
        },
      },
    };
    const client = {
      getBlock: jest.fn().mockResolvedValue({
        timestamp: 1n,
        transactions: [hash],
      }),
      getTransaction: jest.fn().mockResolvedValue({ hash, from: trader }),
    };
    const logs = [{
      address: candidate.pool.poolAddress,
      blockNumber: 101n,
      transactionHash: hash,
      logIndex: 0,
      args: {
        amount0In: 0n,
        amount1In: 1_000_000n,
        amount0Out: 1_000_000_000_000_000_000n,
        amount1Out: 0n,
      },
    }];

    const decoded = await (flow as any).decodeTrades(client, [state], logs);

    expect(client.getBlock).toHaveBeenCalledWith({
      blockNumber: 101n,
      includeTransactions: false,
    });
    expect(client.getTransaction).toHaveBeenCalledWith({ hash });
    expect(decoded.trades).toHaveLength(1);
    expect(decoded.trades[0].trader).toBe(trader);
  });

  it('uses validated raw JSON-RPC batches for Robinhood flow metadata', async () => {
    const rpcUrl = 'https://robinhood.example.invalid';
    const flow = service(new Map(), { 'chain.robinhoodRpcUrl': rpcUrl });
    const hash = `0x${'1'.repeat(64)}`;
    const trader = `0x${'3'.repeat(40)}`;
    const state = {
      model: 'V2',
      lastProcessedBlock: 100n,
      gemDecimals: 18,
      poolToken0Address: candidate.pool.token0Address,
      poolToken1Address: candidate.pool.token1Address,
      candidate: {
        token: candidate.token,
        pool: {
          ...candidate.pool,
          quoteAsset: 'USDC',
          quoteAssetAddress: candidate.pool.token1Address,
        },
      },
    };
    const client = {
      getBlock: jest.fn(),
      getTransaction: jest.fn(),
    };
    const fetchSpy = jest.spyOn(global, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{ jsonrpc: '2.0', id: 0, result: { timestamp: '0x1' } }],
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{ jsonrpc: '2.0', id: 0, result: { from: trader } }],
      } as Response);
    const logs = [{
      address: candidate.pool.poolAddress,
      blockNumber: 101n,
      transactionHash: hash,
      logIndex: 0,
      args: {
        amount0In: 0n,
        amount1In: 1_000_000n,
        amount0Out: 1_000_000_000_000_000_000n,
        amount1Out: 0n,
      },
    }];

    const decoded = await (flow as any).decodeTrades(client, [state], logs);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(client.getBlock).not.toHaveBeenCalled();
    expect(client.getTransaction).not.toHaveBeenCalled();
    expect(decoded.trades).toHaveLength(1);
    expect(decoded.trades[0].trader).toBe(trader);
    fetchSpy.mockRestore();
  });

  it('defers Robinhood metadata after a batch 429 instead of bursting single calls', async () => {
    const rpcUrl = 'https://robinhood.example.invalid';
    const flow = service(new Map(), {
      'chain.robinhoodRpcUrl': rpcUrl,
      'chain.robinhoodRpcBatchSize': 10,
    });
    const hash = `0x${'1'.repeat(64)}`;
    const state = {
      model: 'V2',
      lastProcessedBlock: 100n,
      gemDecimals: 18,
      poolToken0Address: candidate.pool.token0Address,
      poolToken1Address: candidate.pool.token1Address,
      candidate: {
        token: candidate.token,
        pool: {
          ...candidate.pool,
          quoteAsset: 'USDC',
          quoteAssetAddress: candidate.pool.token1Address,
        },
      },
    };
    const client = {
      getBlock: jest.fn(),
      getTransaction: jest.fn(),
    };
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 429,
    } as Response);
    const logs = [{
      address: candidate.pool.poolAddress,
      blockNumber: 101n,
      transactionHash: hash,
      logIndex: 0,
      args: {
        amount0In: 0n,
        amount1In: 1_000_000n,
        amount0Out: 1_000_000_000_000_000_000n,
        amount1Out: 0n,
      },
    }];

    const decoded = await (flow as any).decodeTrades(client, [state], logs);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(client.getBlock).not.toHaveBeenCalled();
    expect(client.getTransaction).not.toHaveBeenCalled();
    expect(decoded.trades).toEqual([]);
    expect(decoded.failedBlocks).toEqual(new Set(['101']));
    fetchSpy.mockRestore();
  });

  it('refuses to persist an inverted backfill range', async () => {
    const flow = service();
    const state = {
      id: 'watch',
      candidate: { pool: { chain: 'robinhood' } },
      model: 'V3',
      pendingBackfill: false,
    };
    await (flow as any).persistBackfill(state, 20n, 10n, 'bad range');
    expect((flow as any).prisma.evmFlowBackfillRange.upsert).not.toHaveBeenCalled();
    expect(state.pendingBackfill).toBe(false);
  });

  it('terminally resolves corrupt pending queue rows without deleting them', async () => {
    const flow = service();
    (flow as any).prisma.evmFlowBackfillRange.findMany.mockResolvedValue([
      { id: 'valid', fromBlock: '10', toBlock: '20' },
      { id: 'inverted', fromBlock: '30', toBlock: '20' },
      { id: 'malformed', fromBlock: 'x', toBlock: '20' },
    ]);

    await (flow as any).resolveCorruptBackfillRanges(['robinhood']);

    expect((flow as any).prisma.evmFlowBackfillRange.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ['inverted', 'malformed'] } } }),
    );
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

  it('never marks an unknown or stale chain head as signal eligible', async () => {
    const flow = service();
    await (flow as any).logHealth();
    const health = (flow as any).prisma.evmRpcHealthSample.create.mock.calls
      .map((call: any[]) => call[0].data)
      .find((row: any) => row.chain === 'robinhood');
    expect(health.headBlock).toBeNull();
    expect(health.signalEligible).toBe(false);
  });

  it('keeps the process alive when a health count exhausts the Prisma pool', async () => {
    const flow = service();
    const error = Object.assign(new Error('Timed out fetching a new connection from the connection pool.'), {
      code: 'P2024',
    });
    (flow as any).prisma.paperPosition.count.mockRejectedValueOnce(error);
    const warn = jest.spyOn((flow as any).logger, 'warn').mockImplementation();

    await expect((flow as any).runHealthTick()).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('P2024'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('open-position count unavailable'));
  });

  it('does not overlap health ticks while the previous database read is running', async () => {
    const flow = service();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const logHealth = jest.spyOn(flow as any, 'logHealth').mockReturnValue(pending);

    const first = (flow as any).runHealthTick();
    await (flow as any).runHealthTick();
    expect(logHealth).toHaveBeenCalledTimes(1);

    release();
    await first;
    await (flow as any).runHealthTick();
    expect(logHealth).toHaveBeenCalledTimes(2);
  });

  it('contains factory timer failures instead of rejecting from setInterval', async () => {
    const flow = service();
    const warn = jest.spyOn((flow as any).logger, 'warn').mockImplementation();
    jest.spyOn(flow as any, 'pollFactories').mockRejectedValue(new Error('temporary factory RPC failure'));

    await expect((flow as any).runFactoryTick()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Flow factory tick failed'));
  });

  it('evaluates fresh Robinhood swap watches before historical outcome tracking', () => {
    const flow = service();
    const now = Date.now();
    const state = (
      id: string,
      chain: string,
      watchType: string,
      swapTrackingUntilMs: number,
      latestSwapAtMs: number | null,
      discoveredAtMs: number,
    ) => ({
      id,
      candidate: { pool: { chain } },
      watchType,
      swapTrackingUntilMs,
      latestSwapAtMs,
      discoveredAtMs,
    });
    const ordered = (flow as any).prioritizeEvaluation([
      state('historical', 'robinhood', 'FRESH', now - 1, now - 1_000, now - 100_000),
      state('ethereum', 'ethereum', 'FRESH', now + 60_000, now - 500, now - 5_000),
      state('rh-old-swap', 'robinhood', 'FRESH', now + 60_000, now - 2_000, now - 3_000),
      state('rh-new-swap', 'robinhood', 'FRESH', now + 60_000, now - 100, now - 2_000),
    ], now);

    expect(ordered.map((item: { id: string }) => item.id)).toEqual([
      'rh-new-swap',
      'rh-old-swap',
      'ethereum',
      'historical',
    ]);
  });

  it('keeps bounded outcome fallback work outside active swap tracking', async () => {
    const flow = service();
    const now = Date.now();
    const makeWatch = (id: string, swapTrackingUntilMs: number, lastOutcomeQuoteAtMs: number) => ({
      id,
      candidate: { pool: { chain: 'robinhood' } },
      outcomeDueAtMs: now + 60_000,
      swapTrackingUntilMs,
      lastOutcomeQuoteAtMs,
      lastProcessedBlock: 10n,
      lastProcessedBlockHash: '0xold',
      coverageComplete: false,
    });
    const historical = makeWatch('historical', now - 1, 0);
    const active = makeWatch('active', now + 60_000, 0);
    (flow as any).watches.set('historical', historical);
    (flow as any).watches.set('active', active);
    const update = jest.spyOn(flow as any, 'updateWatchState').mockResolvedValue(undefined);

    await (flow as any).runOutcomeFallback('robinhood', 100n);
    await (flow as any).runOutcomeFallback('robinhood', 101n);

    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(historical);
    expect(historical.lastProcessedBlock).toBe(100n);
    expect(historical.coverageComplete).toBe(true);
    expect(active.lastProcessedBlock).toBe(10n);
  });
});
