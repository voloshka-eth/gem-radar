import { SolanaMultiLaunchService } from './solana-multi-launch.service';
import { solanaProgramDescriptors } from './solana-venue-adapters';

function harness(overrides: Record<string, any> = {}, configValues: Record<string, unknown> = {}) {
  const prisma: any = {
    $transaction: jest.fn((operations: Promise<any>[]) => Promise.all(operations)),
    solanaExecutionLeg: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'leg' }),
    },
    solanaPaperArm: {
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
    },
    solanaProgramCursor: {
      update: jest.fn().mockResolvedValue({}),
      upsert: jest.fn().mockResolvedValue({}),
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
    },
    solanaLaunchWatch: {
      update: jest.fn().mockResolvedValue({}),
      upsert: jest.fn().mockResolvedValue({ id: 'watch' }),
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
    },
    solanaPoolEra: {
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      upsert: jest.fn().mockResolvedValue({ id: 'era', active: true }),
      create: jest.fn().mockResolvedValue({ id: 'era', active: true }),
      update: jest.fn().mockResolvedValue({}),
    },
    solanaExperimentSignal: {
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
      groupBy: jest.fn().mockResolvedValue([]),
    },
    solanaSwapObservation: {
      findMany: jest.fn().mockResolvedValue([]),
      upsert: jest.fn().mockResolvedValue({}),
      count: jest.fn().mockResolvedValue(0),
    },
    solanaTradeAttributionIssue: {
      upsert: jest.fn().mockResolvedValue({}),
    },
    ...overrides,
  };
  const config: any = { get: jest.fn((key: string) => configValues[key]) };
  const files: any = { logPaperEntry: jest.fn(), logPaperExit: jest.fn() };
  const quotes: any = {
    connection: {
      onLogs: jest.fn().mockReturnValue(101),
      removeOnLogsListener: jest.fn().mockResolvedValue(undefined),
      onSlotChange: jest.fn().mockReturnValue(1),
      removeSlotChangeListener: jest.fn().mockResolvedValue(undefined),
      getSignaturesForAddress: jest.fn().mockResolvedValue([]),
    },
    runRpc: jest.fn((operation: () => Promise<unknown>) => operation()),
    quoteRoundTrip: jest.fn(),
    sellQuote: jest.fn(),
    quoteRawToUsd: jest.fn(),
  };
  return { service: new SolanaMultiLaunchService(config, prisma, files, quotes), prisma, quotes, files, config };
}

function streamState(overrides: Record<string, any> = {}) {
  return {
    programId: 'program',
    venue: 'PUMP_BONDING_CURVE',
    subscriptionId: 7,
    lastEventAtMs: Date.now(),
    lastEventSlot: 0,
    reconnectAttempts: 0,
    reconnectAt: 0,
    awaitingCatchUp: false,
    ...overrides,
  };
}

describe('SolanaMultiLaunchService lifecycle safety', () => {
  it('does not apply an entry leg twice when the idempotency key already exists', async () => {
    const { service, prisma } = harness();
    prisma.solanaExecutionLeg.findUnique.mockResolvedValue({ id: 'existing-leg' });
    const now = Date.now();

    await (service as any).fillEntry(
      {
        id: 'signal',
        t0: new Date(now - 30_000),
        flowSnapshot: { latestWindowBuyers: 5, buyVolumeUsd: 20, distinctSlots: 3, topThreeBuyerShare: 0.2 },
        watch: { latestEventAt: new Date(now - 500), creatorAddress: null },
      },
      { id: 'arm', armCode: 'C_CONFIRM_20' },
      {},
      20,
      'CONFIRMATION_ADD',
      { latestWindowBuyers: 5, buyVolumeUsd: 20, distinctSlots: 3, topThreeBuyerShare: 0.2 },
    );

    expect(prisma.solanaExecutionLeg.create).not.toHaveBeenCalled();
    expect(prisma.solanaPaperArm.update).not.toHaveBeenCalled();
  });

  it('blocks non-confirmation paid fills under the finish-line C-only policy', async () => {
    const { service, prisma, files } = harness();

    await (service as any).fillEntry(
      { id: 'signal', watch: { latestEventAt: new Date() } },
      { id: 'arm', armCode: 'A_IMMEDIATE_20' },
      { entryTokensRaw: '1', entryTokens: 1, gasUsd: 0, tokenDecimals: 6 },
      20,
      'IMMEDIATE_ENTRY',
    );

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(files.logPaperEntry).not.toHaveBeenCalled();
  });

  it('demotes every affected signal when a watched-pool transaction cannot be recovered', async () => {
    const { service, prisma } = harness();
    await (service as any).markQueueGap(
      {
        slot: 10,
        source: 'STREAM',
        cursorProgramIds: new Set(['program']),
        watchIds: new Set(['watch']),
        attempts: 0,
      },
      new Error('429 Too Many Requests'),
    );

    expect(prisma.solanaProgramCursor.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { programId: 'program' },
      data: expect.objectContaining({ unresolvedGap: true }),
    }));
    expect(prisma.solanaLaunchWatch.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'watch' },
      data: expect.objectContaining({ benchmarkEligible: false, discoveryCohort: 'DEGRADED_SHADOW' }),
    }));
    expect(prisma.solanaExperimentSignal.updateMany).toHaveBeenCalledWith({
      where: { watchId: 'watch' },
      data: { benchmarkEligible: false, riskCohort: 'EXECUTABLE_SHADOW' },
    });
  });

  it('resolves a signal only after all three arms are terminal', async () => {
    const complete = {
      id: 'complete', watchId: 'watch-complete', resolutionReason: null, confirmedAt: new Date(),
      arms: [{ status: 'CLOSED' }, { status: 'CLOSED' }, { status: 'CLOSED' }],
    };
    const incomplete = {
      id: 'incomplete', watchId: 'watch-incomplete', resolutionReason: null, confirmedAt: null,
      arms: [{ status: 'CLOSED' }, { status: 'OPEN' }, { status: 'CLOSED' }],
    };
    const { service, prisma } = harness();
    prisma.solanaExperimentSignal.findMany.mockResolvedValue([complete, incomplete]);

    await (service as any).resolveCompletedSignals();

    expect(prisma.solanaExperimentSignal.update).toHaveBeenCalledTimes(1);
    expect(prisma.solanaExperimentSignal.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'complete' }, data: expect.objectContaining({ status: 'RESOLVED' }),
    }));
  });

  it('retries a transient RPC failure without permanently marking a data gap', async () => {
    jest.useFakeTimers();
    try {
      const { service } = harness({}, {
        'solanaLaunch.rpcUrl': 'https://dedicated.example',
        'solanaLaunch.rpcMinRequestIntervalMs': 0,
        'solanaLaunch.rateLimitBackoffMs': 5_000,
      });
      jest.spyOn(service as any, 'processSignature').mockRejectedValue(new Error('429 Too Many Requests'));
      const markGap = jest.spyOn(service as any, 'markQueueGap').mockResolvedValue(undefined);

      (service as any).enqueue('signature', 100, 'STREAM', 'program', null);
      await (service as any).drainQueue();

      expect(markGap).not.toHaveBeenCalled();
      expect((service as any).queued.get('signature')?.attempts).toBe(1);
      expect((service as any).rpcBackoffUntil - Date.now()).toBeGreaterThanOrEqual(4_900);
      (service as any).queued.clear();
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });

  it('marks a gap only after the transaction retry budget is exhausted', async () => {
    const { service } = harness({}, { 'solanaLaunch.rpcMinRequestIntervalMs': 0 });
    jest.spyOn(service as any, 'processSignature').mockRejectedValue(new Error('transaction unavailable'));
    const markGap = jest.spyOn(service as any, 'markQueueGap').mockResolvedValue(undefined);
    (service as any).queued.set('signature', {
      slot: 100,
      source: 'STREAM',
      cursorProgramIds: new Set(['program']),
      watchIds: new Set<string>(),
      attempts: 5,
    });

    await (service as any).drainQueue();

    expect(markGap).toHaveBeenCalledTimes(1);
    expect((service as any).queued.size).toBe(0);
  });

  it('gives queued live transactions priority over lifecycle polling', async () => {
    const { service } = harness();
    const cycle = jest.spyOn(service as any, 'runLifecycleCycle').mockResolvedValue(undefined);
    (service as any).queued.set('signature', { slot: 100 });

    await (service as any).lifecycle();

    expect(cycle).not.toHaveBeenCalled();
  });

  it('processes watched-pool flow before discovery so confirmation cannot starve', () => {
    const { service } = harness();
    (service as any).queued.set('pool-swap', {
      slot: 100, source: 'STREAM', priority: 'P1', queuedAtMs: 1,
      cursorProgramIds: new Set(), watchIds: new Set(['watch']), attempts: 0,
    });
    (service as any).queued.set('launch', {
      slot: 101, source: 'STREAM', priority: 'P2', queuedAtMs: 2,
      cursorProgramIds: new Set(['program']), watchIds: new Set(), attempts: 0,
    });

    expect((service as any).nextQueuedTransaction()[0]).toBe('pool-swap');
  });

  it('preserves launch coverage by evicting a pool event when the local queue is full', () => {
    const { service } = harness({}, { 'solanaLaunch.maxQueuedTransactions': 100 });
    for (let index = 0; index < 100; index++) {
      (service as any).enqueue(`pool-${index}`, index, 'STREAM', null, `watch-${index}`);
    }

    (service as any).enqueue('launch', 101, 'STREAM', 'launch-program', null);

    expect((service as any).queued.size).toBe(100);
    expect((service as any).queued.has('launch')).toBe(true);
    expect((service as any).queued.has('pool-0')).toBe(false);
  });

  it('keeps an unresolved gap in place when the live stream advances without backfill catch-up', async () => {
    const { service, prisma } = harness();

    await (service as any).updateLiveCursor('program', 123, 'signature');

    const call = prisma.solanaProgramCursor.update.mock.calls[0][0];
    expect(call.where).toEqual({ programId: 'program' });
    expect(call.data.lastSeenSlot).toBe(123n);
    expect(call.data.lastBackfillSignature).toBe('signature');
    expect(call.data.streamConnected).toBe(true);
    expect(call.data).not.toHaveProperty('unresolvedGap');
  });

  it('caps public-RPC pool streams instead of multiplying RPC load', async () => {
    const { service, quotes } = harness({}, {
      'solanaLaunch.rpcUrl': 'https://api.mainnet-beta.solana.com',
      'solanaLaunch.maxActivePoolSubscriptions': 2,
    });
    (service as any).poolSubscriptions.set('one', { subscriptionId: 1, poolAddress: 'one' });
    (service as any).poolSubscriptions.set('two', { subscriptionId: 2, poolAddress: 'two' });

    const subscribed = await (service as any).subscribeWatchPool({
      id: 'three', poolAddress: '11111111111111111111111111111111',
    });

    expect(subscribed).toBe(false);
    expect(quotes.connection.onLogs).not.toHaveBeenCalled();
  });

  it('limits full executable-shadow lifecycles on public RPC', async () => {
    const { service, prisma } = harness({}, {
      'solanaLaunch.rpcUrl': 'https://api.mainnet-beta.solana.com',
      'solanaLaunch.maxShadowSignals': 8,
    });
    prisma.solanaExperimentSignal.count.mockResolvedValue(8);

    await expect((service as any).hasShadowCapacity()).resolves.toBe(false);
    expect(prisma.solanaExperimentSignal.count).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        strategyVersion: 'solana_multi_launch_flow_v2_3',
        status: 'ACTIVE',
      }),
    }));
  });

  it('evaluates due open arms through the queue-independent fallback', async () => {
    const { service, prisma } = harness();
    const arm = { id: 'arm', signal: { watch: {} } };
    prisma.solanaPaperArm.findMany.mockResolvedValue([arm]);
    const evaluate = jest.spyOn(service as any, 'evaluateArm').mockResolvedValue(undefined);

    await (service as any).evaluateDueOpenArms(6);

    expect(evaluate).toHaveBeenCalledWith(arm);
    expect(prisma.solanaPaperArm.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: 'OPEN' }),
      orderBy: { updatedAt: 'asc' },
      take: 6,
    }));
  });

  it('keeps historical strategy provenance when an old arm exits after restart', () => {
    const { service, files } = harness();
    const now = new Date();

    (service as any).logExit(
      { strategyVersion: 'solana_multi_launch_flow_v2', configHash: 'old-hash', riskCohort: 'EXECUTABLE_SHADOW', t0: now },
      { id: 'arm', armCode: 'A_IMMEDIATE_20', status: 'CLOSED', tokensBoughtRaw: '100', realizedMultiple: 1 },
      {
        mintAddress: 'mint', poolAddress: 'pool', launchedAt: now, venue: 'PUMPSWAP',
        discoverySlot: 1n, discoverySignature: 'signature', programId: 'program',
      },
      { netUsd: 20, grossUsd: 20, slippagePct: 0 },
      'TIME_SELL',
      1,
      100n,
      'TIME_PROFIT',
      now,
    );

    expect(files.logPaperExit).toHaveBeenCalledWith(expect.objectContaining({
      strategy_version: 'solana_multi_launch_flow_v2',
      config_hash: 'old-hash',
      note: expect.stringContaining('event=TIME_SELL'),
    }));
  });

  it('attributes a trade by exact venue/program/pool identity before mint', async () => {
    const { service, prisma, quotes } = harness();
    const exact = {
      id: 'pumpswap-watch', venue: 'PUMPSWAP', programId: 'pump-program', poolAddress: 'new-pool',
      mintAddress: 'mint', creatorAddress: null, launchId: 'launch', migrationId: 'migration',
      discoverySignature: 'discovery', discoveryInstructionIndex: 0,
    };
    prisma.solanaPoolEra.findMany.mockResolvedValue([{ id: 'pumpswap-era', active: true, watch: exact }]);
    prisma.solanaSwapObservation.upsert.mockResolvedValue({});
    prisma.solanaLaunchWatch.update.mockResolvedValue({});
    quotes.quoteRawToUsd.mockResolvedValue(1);
    jest.spyOn(service as any, 'evaluateOpenArmsForWatch').mockResolvedValue(undefined);

    await (service as any).handleTrade({
      venue: 'PUMPSWAP', programId: 'pump-program', poolAddress: 'new-pool', mintAddress: 'mint',
      quoteMint: 'quote', signature: 'swap', instructionIndex: 1, slot: 10, blockTimeMs: Date.now(),
      wallet: 'buyer', direction: 'BUY', baseAmountRaw: '1', quoteAmountRaw: '1',
    });

    expect(prisma.solanaSwapObservation.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ watchId: 'pumpswap-watch', poolEraId: 'pumpswap-era', poolAddress: 'new-pool', migrationId: 'migration' }),
    }));
  });

  it('routes post-migration PumpSwap swaps through the destination era', async () => {
    const { service, prisma, quotes } = harness();
    const watch = {
      id: 'watch', mintAddress: 'mint', creatorAddress: null, launchId: 'launch', migrationId: 'migration',
      discoverySignature: 'discovery', discoveryInstructionIndex: 0,
    };
    prisma.solanaPoolEra.findMany.mockResolvedValue([{ id: 'pumpswap-era', active: true, watch }]);
    quotes.quoteRawToUsd.mockResolvedValue(1);

    await (service as any).handleTrade({
      venue: 'PUMPSWAP', programId: solanaProgramDescriptors().find((item) => item.venue === 'PUMPSWAP')!.programId,
      poolAddress: 'migrated-pool', mintAddress: 'mint', quoteMint: 'quote', signature: 'post-migration-swap',
      instructionIndex: 0, slot: 20, blockTimeMs: Date.now(), wallet: 'buyer', direction: 'BUY', baseAmountRaw: '1', quoteAmountRaw: '1',
    });

    expect(prisma.solanaSwapObservation.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ watchId: 'watch', poolEraId: 'pumpswap-era', venue: 'PUMPSWAP' }),
    }));
    expect(prisma.solanaTradeAttributionIssue.upsert).not.toHaveBeenCalled();
  });

  it('does not migrate a mint when the source bonding-curve identity is ambiguous', async () => {
    const { service, prisma } = harness();
    prisma.solanaPoolEra.findUnique.mockResolvedValue(null);
    prisma.solanaLaunchWatch.findMany.mockResolvedValue([{ id: 'one' }, { id: 'two' }]);

    await (service as any).handleMigration({
      kind: 'MIGRATION', venue: 'PUMPSWAP', programId: solanaProgramDescriptors().find((item) => item.venue === 'PUMP_BONDING_CURVE')!.programId,
      poolAddress: 'destination', sourcePoolAddress: 'source', mintAddress: 'mint', quoteMint: 'quote', creatorAddress: null,
      slot: 12, signature: 'migration', instructionIndex: 3, blockTimeMs: Date.now(),
    });

    expect(prisma.solanaLaunchWatch.update).not.toHaveBeenCalled();
    expect(prisma.solanaTradeAttributionIssue.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ reason: 'MIGRATION_ATTRIBUTION_UNKNOWN' }),
    }));
  });

  it('treats an already applied migration replay as an idempotent no-op', async () => {
    const { service, prisma } = harness();
    const destinationProgram = solanaProgramDescriptors().find((item) => item.venue === 'PUMPSWAP')!.programId;
    prisma.solanaPoolEra.findUnique.mockResolvedValue({
      id: 'destination-era',
      watchId: 'watch',
      migrationId: `${destinationProgram}:migration:3`,
      watch: { id: 'watch', mintAddress: 'mint' },
    });

    await (service as any).handleMigration({
      kind: 'MIGRATION', venue: 'PUMPSWAP',
      programId: solanaProgramDescriptors().find((item) => item.venue === 'PUMP_BONDING_CURVE')!.programId,
      poolAddress: 'destination', sourcePoolAddress: 'source', mintAddress: 'mint', quoteMint: 'quote',
      creatorAddress: null, slot: 12, signature: 'migration', instructionIndex: 3, blockTimeMs: Date.now(),
    });

    expect(prisma.solanaTradeAttributionIssue.upsert).not.toHaveBeenCalled();
    expect(prisma.solanaPoolEra.create).not.toHaveBeenCalled();
    expect(prisma.solanaLaunchWatch.update).not.toHaveBeenCalled();
  });

  it('records ambiguous or stale pool observations without attaching them to an arm', async () => {
    const { service, prisma } = harness();
    prisma.solanaLaunchWatch.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'mint-candidate' }]);

    await (service as any).handleTrade({
      venue: 'PUMP_BONDING_CURVE', programId: 'pump-program', poolAddress: 'old-bonding-pool', mintAddress: 'mint',
      quoteMint: 'quote', signature: 'late-swap', instructionIndex: 2, slot: 10, blockTimeMs: Date.now(),
      wallet: 'buyer', direction: 'BUY', baseAmountRaw: '1', quoteAmountRaw: '1',
    });

    expect(prisma.solanaSwapObservation.upsert).not.toHaveBeenCalled();
    expect(prisma.solanaTradeAttributionIssue.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ reason: 'TRADE_ATTRIBUTION_UNKNOWN' }),
    }));
  });

  it('keeps the small probe alive through an early drawdown while recovery chances remain', async () => {
    const { service, prisma, quotes } = harness();
    quotes.sellQuote = jest.fn().mockResolvedValue({
      netUsd: 2, grossUsd: 2.01, slippagePct: 0.02, quoteSlot: 100, raw: {},
    });
    const sell = jest.spyOn(service as any, 'sellArm').mockResolvedValue(undefined);
    const arm = {
      id: 'probe', armCode: 'B_PROBE_4_ADD_16', committedUsd: 4,
      remainingTokensRaw: '100', realizedValueUsd: 0, maxMultipleObserved: 1,
      currentMultiple: 1, executedRungs: '', tokensBoughtRaw: '100',
      signal: {
        status: 'ACTIVE', confirmationDueAt: new Date(Date.now() + 60_000),
        horizonAt: new Date(Date.now() + 3_600_000),
        watch: { venue: 'PUMPSWAP', poolAddress: 'pool', mintAddress: 'mint', quoteMint: 'quote' },
      },
    };

    await (service as any).evaluateArm(arm);

    expect(prisma.solanaPaperArm.update).toHaveBeenCalled();
    expect(sell).not.toHaveBeenCalled();
  });
});

describe('SolanaMultiLaunchService stale-stream watchdog', () => {
  it('marks a stale cursor disconnected and gapped even though the websocket object still exists', async () => {
    const { service, prisma } = harness();
    const now = Date.now();
    (service as any).streamStates.set('program', streamState({
      lastEventAtMs: now - 10 * 60_000, lastEventSlot: 100,
    }));

    await (service as any).runStreamWatchdog(now);

    expect(prisma.solanaProgramCursor.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { programId: 'program' },
      data: expect.objectContaining({
        streamConnected: false,
        unresolvedGap: true,
        healthSnapshot: expect.objectContaining({ reason: 'stale_stream_watchdog' }),
      }),
    }));
    const state = (service as any).streamStates.get('program');
    expect(state.reconnectAt).toBeGreaterThan(now);
    expect(state.awaitingCatchUp).toBe(true);
  });

  it('detects staleness through slot lag even when wall-clock freshness looks fine', async () => {
    const { service, prisma } = harness();
    const now = Date.now();
    (service as any).latestHeadSlot = 10_000;
    (service as any).streamStates.set('program', streamState({
      lastEventAtMs: now - 1_000, lastEventSlot: 1_000,
    }));

    await (service as any).runStreamWatchdog(now);

    expect(prisma.solanaProgramCursor.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ streamConnected: false, unresolvedGap: true }),
    }));
  });

  it('backs off exponentially between reconnect attempts', async () => {
    const { service } = harness();
    const now = Date.now();
    (service as any).streamStates.set('program', streamState({
      lastEventAtMs: now - 10 * 60_000, reconnectAttempts: 3,
    }));

    await (service as any).runStreamWatchdog(now);

    const state = (service as any).streamStates.get('program');
    // attempt 4 -> base 5s * 2^3 = 40s
    expect(state.reconnectAt - now).toBe(40_000);
  });

  it('resubscribes after the backoff window without prematurely reporting a healthy cursor', async () => {
    const { service, prisma, quotes } = harness();
    const now = Date.now();
    // Use a real base58 program id because resubscription constructs a PublicKey.
    const programId = solanaProgramDescriptors()[0].programId;
    (service as any).streamStates.set(programId, streamState({
      programId, subscriptionId: 7, lastEventAtMs: now - 10 * 60_000,
      reconnectAttempts: 1, reconnectAt: now - 1, awaitingCatchUp: true,
    }));

    await (service as any).runStreamWatchdog(now);

    expect(quotes.connection.removeOnLogsListener).toHaveBeenCalledWith(7);
    expect(quotes.connection.onLogs).toHaveBeenCalledTimes(1);
    const state = (service as any).streamStates.get(programId);
    expect(state.reconnectAt).toBe(0);
    expect(state.awaitingCatchUp).toBe(true);
    // No healthy-state write happens on reconnect alone.
    for (const call of prisma.solanaProgramCursor.update.mock.calls) {
      expect(call[0].data).not.toMatchObject({ unresolvedGap: false });
      expect(call[0].data).not.toMatchObject({ streamConnected: true });
    }
  });

  it('clears the gap after a full backfill catch-up and reports connected only when the live stream is fresh', async () => {
    const descriptors = solanaProgramDescriptors().filter((item) => item.launchProgram);
    const freshProgram = descriptors[0].programId;
    const deadProgram = descriptors[1].programId;
    const { service, prisma } = harness({}, {
      'solanaLaunch.rpcUrl': 'https://dedicated.example',
      'solanaLaunch.rpcMinRequestIntervalMs': 0,
    });
    prisma.solanaProgramCursor.findUnique.mockImplementation(({ where }: any) =>
      Promise.resolve([freshProgram, deadProgram].includes(where.programId)
        ? {
          programId: where.programId, lastBackfillSignature: 'old-sig', unresolvedGap: true,
          streamConnected: false, lastSeenSlot: 1n, healthSnapshot: { reason: 'stale_stream_watchdog' },
        }
        : null));
    (service as any).quotes.connection.getSignaturesForAddress = jest.fn()
      .mockResolvedValue([{ signature: 'new-sig', slot: 42 }]);
    jest.spyOn(service as any, 'processSignature').mockResolvedValue(undefined);
    // Fresh live subscription for one program; the other has no live stream.
    (service as any).streamStates.set(freshProgram, streamState({ programId: freshProgram }));

    await (service as any).backfill();

    expect(prisma.solanaProgramCursor.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { programId: freshProgram },
      data: expect.objectContaining({
        unresolvedGap: false, streamConnected: true, lastBackfillSignature: 'new-sig',
      }),
    }));
    expect(prisma.solanaProgramCursor.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { programId: deadProgram },
      data: expect.objectContaining({
        unresolvedGap: false, streamConnected: false, lastBackfillSignature: 'new-sig',
      }),
    }));
    expect((service as any).streamStates.get(freshProgram).awaitingCatchUp).toBe(false);
  });

  it('never lets a launch on a gapped or stale cursor become primary-eligible', async () => {
    const { service, prisma } = harness();
    prisma.solanaProgramCursor.findUnique.mockResolvedValue({
      programId: 'program', unresolvedGap: true, streamConnected: true,
    });
    prisma.solanaLaunchWatch.upsert.mockResolvedValue({ id: 'watch-1' });
    (service as any).streamStates.set('program', streamState());

    await (service as any).handleLaunch({
      kind: 'LAUNCH', venue: 'PUMP_BONDING_CURVE', programId: 'program', signature: 'sig',
      instructionIndex: 0, slot: 10, blockTimeMs: Date.now(), instructionName: 'create',
      mintAddress: 'mint', poolAddress: 'pool', quoteMint: 'quote', creatorAddress: null, rawAccounts: [],
    }, 'STREAM');

    expect(prisma.solanaLaunchWatch.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ discoveryCohort: 'DEGRADED_SHADOW', benchmarkEligible: false }),
    }));
  });

  it('admits a healthy fresh-stream launch as a normal program-stream discovery', async () => {
    const { service, prisma } = harness();
    prisma.solanaProgramCursor.findUnique.mockResolvedValue({
      programId: 'program', unresolvedGap: false, streamConnected: true,
    });
    prisma.solanaLaunchWatch.upsert.mockResolvedValue({ id: 'watch-1' });
    (service as any).streamStates.set('program', streamState());

    await (service as any).handleLaunch({
      kind: 'LAUNCH', venue: 'PUMP_BONDING_CURVE', programId: 'program', signature: 'sig',
      instructionIndex: 0, slot: 10, blockTimeMs: Date.now(), instructionName: 'create',
      mintAddress: 'mint', poolAddress: 'pool', quoteMint: 'quote', creatorAddress: null, rawAccounts: [],
    }, 'STREAM');

    expect(prisma.solanaLaunchWatch.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ discoveryCohort: 'PROGRAM_STREAM' }),
    }));
  });
});

describe('SolanaMultiLaunchService flow snapshots', () => {
  it('produces a non-empty rolling snapshot from recorded swap observations', async () => {
    const { service, prisma } = harness();
    const now = Date.now();
    prisma.solanaSwapObservation.findMany.mockResolvedValue([
      { ts: new Date(now - 8_000), slot: 10n, wallet: 'w1', direction: 'BUY', quoteUsd: 5, creatorTrade: false },
      { ts: new Date(now - 4_000), slot: 11n, wallet: 'w2', direction: 'BUY', quoteUsd: 3, creatorTrade: false },
    ]);

    const { flow } = await (service as any).buildFlowContext(
      { watchId: 'watch', t0: new Date(now - 30_000), executionSnapshot: { executableDepthUsd: 100 } },
      120,
      now,
    );

    expect(flow.observationCount).toBe(2);
    expect(flow.latestWindowBuyers).toBe(2);
    expect(flow.buyVolumeUsd).toBe(8);
    expect(flow.currentDepthUsd).toBe(120);
    expect(flow.t0DepthUsd).toBe(100);
    expect(flow.computedAt).toBeTruthy();
  });

  it('persists a flow snapshot for a confirmation evaluation even when no quote is available', async () => {
    const { service, prisma, quotes } = harness();
    const now = Date.now();
    quotes.quoteRoundTrip.mockResolvedValue(null);
    const signal = {
      id: 'signal', watchId: 'watch', status: 'ACTIVE',
      t0: new Date(now - 30_000), confirmationDueAt: new Date(now + 60_000),
      executionSnapshot: { spotPriceUsd: 1, executableDepthUsd: 100 }, flowSnapshot: null,
      arms: [],
      watch: {
        venue: 'PUMPSWAP', poolAddress: 'pool', mintAddress: 'mint', quoteMint: 'quote',
        latestEventAt: new Date(now - 1_000), unresolvedGap: false,
      },
    };

    await (service as any).evaluateSignal(signal);

    expect(prisma.solanaExperimentSignal.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'signal' },
      data: { flowSnapshot: expect.objectContaining({ quoteUnavailable: true, observationCount: 0 }) },
    }));
  });

  it('confirms a signal from real recorded flow and forwards the snapshot into confirmation entries', async () => {
    const { service, prisma, quotes } = harness();
    const now = Date.now();
    (service as any).latestHeadSlot = 100;
    const observations: any[] = [];
    for (let index = 0; index < 6; index++) {
      observations.push({
        ts: new Date(now - 16_000 + index * 500), slot: BigInt(10 + (index % 2)),
        wallet: `early-${index}`, direction: 'BUY', quoteUsd: 1, creatorTrade: false,
      });
    }
    for (let index = 0; index < 9; index++) {
      observations.push({
        ts: new Date(now - 6_000 + index * 500), slot: BigInt(20 + (index % 2)),
        wallet: `latest-${index}`, direction: 'BUY', quoteUsd: 2, creatorTrade: false,
      });
    }
    prisma.solanaSwapObservation.findMany.mockResolvedValue(observations);
    const quote = {
      executable: true, buySlippagePct: 0.01, sellSlippagePct: 0.01, roundTripMultiple: 0.95,
      executableDepthUsd: 100, quoteSlot: 100, quoteModel: 'TEST', spotPriceUsd: 1,
      entryTokensRaw: '1000000', entryTokens: 1, entryUsd: 20, sellUsd: 19, gasUsd: 0.01, tokenDecimals: 6,
    };
    quotes.quoteRoundTrip.mockResolvedValue(quote);
    const fill = jest.spyOn(service as any, 'fillEntry').mockResolvedValue(undefined);
    const signal = {
      id: 'signal', watchId: 'watch', status: 'ACTIVE',
      t0: new Date(now - 30_000), confirmationDueAt: new Date(now + 60_000),
      executionSnapshot: { spotPriceUsd: 1, executableDepthUsd: 100 }, flowSnapshot: null,
      arms: [
        { id: 'arm-a', armCode: 'A_IMMEDIATE_20', committedUsd: 20, executedRungs: '' },
        { id: 'arm-b', armCode: 'B_PROBE_4_ADD_16', committedUsd: 4, executedRungs: '' },
        { id: 'arm-c', armCode: 'C_CONFIRM_20', committedUsd: 0, executedRungs: '' },
      ],
      watch: {
        venue: 'PUMPSWAP', poolAddress: 'pool', mintAddress: 'mint', quoteMint: 'quote',
        latestEventAt: new Date(now - 1_000), unresolvedGap: false,
      },
    };

    await (service as any).evaluateSignal(signal);

    expect(prisma.solanaExperimentSignal.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'signal' },
      data: expect.objectContaining({ status: 'CONFIRMED' }),
    }));
    // Finish-line: only C receives confirmation capital.
    expect(fill).toHaveBeenCalledTimes(1);
    expect((fill.mock.calls[0][1] as { armCode: string }).armCode).toBe('C_CONFIRM_20');
    expect(fill.mock.calls[0][3]).toBe(20);
    expect(fill.mock.calls[0][4]).toBe('CONFIRMATION_ADD');
    const snapshot = fill.mock.calls[0][5] as Record<string, unknown>;
    expect(snapshot.observationCount).toBe(observations.length);
    expect(snapshot.latestWindowBuyers).toBe(9);
    expect(snapshot.confirmationReasons).toEqual([]);
  });

  it('serializes the computed flow snapshot into the paper entry CSV row', async () => {
    const { service, prisma, files } = harness();
    const now = Date.now();
    prisma.solanaSwapObservation.findMany.mockResolvedValue([
      { ts: new Date(now - 3_000), slot: 10n, wallet: 'w1', direction: 'BUY', quoteUsd: 5, creatorTrade: false },
      { ts: new Date(now - 2_500), slot: 11n, wallet: 'w2', direction: 'BUY', quoteUsd: 5, creatorTrade: false },
      { ts: new Date(now - 2_000), slot: 12n, wallet: 'w3', direction: 'BUY', quoteUsd: 5, creatorTrade: false },
    ]);
    const flow = {
      latestWindowBuyers: 3, buyVolumeUsd: 15, distinctSlots: 3, topThreeBuyerShare: 0.4,
      observationCount: 3, creatorSell: false,
    };
    const signal = {
      id: 'signal', watchId: 'watch', status: 'CONFIRMED', riskCohort: 'EXECUTABLE_SHADOW',
      strategyVersion: 'solana_multi_launch_flow_v2_3', configHash: 'hash', benchmarkEligible: false,
      t0: new Date(now - 30_000), flowSnapshot: flow, healthSnapshot: { source: 'STREAM' },
      executionSnapshot: { executableDepthUsd: 100 },
      watch: {
        mintAddress: 'mint', poolAddress: 'pool', launchedAt: new Date(now - 40_000), venue: 'PUMPSWAP',
        discoverySlot: 1n, discoverySignature: 'sig', programId: 'program', creatorAddress: null, symbol: 'TKN',
        latestEventAt: new Date(now - 500),
      },
    };
    const arm = { id: 'arm', armCode: 'C_CONFIRM_20', committedUsd: 0, tokensBoughtRaw: '0', remainingTokensRaw: '0' };
    const quote = {
      entryTokensRaw: '1000000', entryTokens: 1, gasUsd: 0.01, buySlippagePct: 0.01,
      quoteSlot: 100, quoteModel: 'TEST', spotPriceUsd: 1, executableDepthUsd: 100,
      tokenDecimals: 6, roundTripMultiple: 0.95,
    };
    prisma.solanaPaperArm.update.mockResolvedValue({ ...arm, status: 'OPEN' });

    await (service as any).fillEntry(signal, arm, quote, 20, 'CONFIRMATION_ADD', flow);

    expect(prisma.$transaction).toHaveBeenCalled();
    const row = files.logPaperEntry.mock.calls[0][0];
    const loggedFlow = JSON.parse(row.flow_snapshot);
    expect(loggedFlow.latestWindowBuyers).toBe(3);
    expect(row.strategy_version).toBe('solana_multi_launch_flow_v2_3');
    expect(row.experiment_arm).toBe('C_CONFIRM_20');
    expect(row.quote_model).toBe('TEST');
    expect(row.note).toContain('leg=CONFIRMATION_ADD');
    expect(row.note).toContain('cohort=EXECUTABLE_SHADOW');
  });
  it('blocks paid confirmation when the creator already has a CREATOR_EXIT', async () => {
    const { service, prisma, files } = harness();
    const now = Date.now();
    prisma.solanaPaperArm.findFirst.mockResolvedValue({ id: 'prior-rug' });

    await (service as any).fillEntry(
      {
        id: 'signal', t0: new Date(now - 30_000),
        watch: { latestEventAt: new Date(now - 200), creatorAddress: 'creator' },
      },
      { id: 'arm', armCode: 'C_CONFIRM_20' },
      { entryTokensRaw: '1', entryTokens: 1, gasUsd: 0, tokenDecimals: 6 },
      20,
      'CONFIRMATION_ADD',
      { latestWindowBuyers: 5, buyVolumeUsd: 20, distinctSlots: 3, topThreeBuyerShare: 0.2 },
    );

    expect(prisma.solanaPaperArm.findFirst).toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(files.logPaperEntry).not.toHaveBeenCalled();
  });
});

describe('SolanaMultiLaunchService confirmation expiry', () => {
  function overdueSignal(now: number) {
    return {
      id: 'signal', watchId: 'watch', status: 'ACTIVE',
      t0: new Date(now - 20 * 60_000), confirmationDueAt: new Date(now - 10 * 60_000),
      horizonAt: new Date(now + 3_600_000),
      executionSnapshot: { executableDepthUsd: 100 }, flowSnapshot: { observationCount: 4 },
      arms: [
        { id: 'arm-a', armCode: 'A_IMMEDIATE_20', status: 'OPEN', committedUsd: 20, remainingTokensRaw: '100' },
        { id: 'arm-b', armCode: 'B_PROBE_4_ADD_16', status: 'OPEN', committedUsd: 4, remainingTokensRaw: '100' },
        { id: 'arm-c', armCode: 'C_CONFIRM_20', status: 'PENDING', committedUsd: 0, remainingTokensRaw: '0' },
      ],
      watch: { venue: 'PUMPSWAP', poolAddress: 'pool', mintAddress: 'mint', quoteMint: 'quote' },
    };
  }

  it('closes the expired C arm as NO_CONFIRMATION without requiring a new swap event', async () => {
    const { service, prisma } = harness();
    const now = Date.now();
    const signal = overdueSignal(now);
    prisma.solanaExperimentSignal.findMany
      .mockResolvedValueOnce([signal])
      .mockResolvedValueOnce([]);
    const sellAll = jest.spyOn(service as any, 'sellAll').mockResolvedValue(undefined);

    await (service as any).sweepOverdueConfirmations(new Date(now));

    expect(prisma.solanaExperimentSignal.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'signal' },
      data: expect.objectContaining({ status: 'EXPIRED', resolutionReason: 'all_confirmation_chances_expired' }),
    }));
    expect(prisma.solanaPaperArm.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'arm-c' },
      data: expect.objectContaining({ status: 'CLOSED', outcomeClass: 'NO_CONFIRMATION' }),
    }));
    // B sells its probe with the confirmation deadline as the execution target.
    expect(sellAll).toHaveBeenCalledTimes(1);
    expect(sellAll).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'arm-b' }),
      signal.watch,
      'NO_CONFIRMATION_SELL',
      expect.objectContaining({ id: 'signal' }),
      { targetAt: signal.confirmationDueAt },
    );
    // A is never touched by the expiry path.
    expect(prisma.solanaPaperArm.update).not.toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'arm-a' },
    }));
  });

  it('repairs EXPIRED signals whose arms were left unresolved by a crash or failed quote', async () => {
    const { service, prisma } = harness();
    const now = Date.now();
    const stuck = { ...overdueSignal(now), status: 'EXPIRED' };
    prisma.solanaExperimentSignal.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([stuck]);
    const sellAll = jest.spyOn(service as any, 'sellAll').mockResolvedValue(undefined);

    await (service as any).sweepOverdueConfirmations(new Date(now));

    expect(prisma.solanaPaperArm.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'arm-c' },
      data: expect.objectContaining({ status: 'CLOSED', outcomeClass: 'NO_CONFIRMATION' }),
    }));
    expect(sellAll).toHaveBeenCalledTimes(1);
  });

  it('closes the B probe exactly once even when expiry is processed twice', async () => {
    const { service, prisma, files } = harness();
    prisma.solanaExecutionLeg.findUnique.mockResolvedValue({ id: 'existing-exit-leg' });
    const arm = {
      id: 'arm-b', armCode: 'B_PROBE_4_ADD_16', committedUsd: 4, remainingTokensRaw: '100',
      realizedValueUsd: 0, tokensBoughtRaw: '100', executedRungs: '',
      signal: { id: 'signal', watchId: 'watch', t0: new Date() },
    };

    await (service as any).sellArm(
      arm, { venue: 'PUMPSWAP' }, 100n,
      { netUsd: 3, grossUsd: 3, slippagePct: 0.01, quoteSlot: 5, raw: {} },
      'NO_CONFIRMATION_SELL', 0.75, true,
    );

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.solanaExecutionLeg.create).not.toHaveBeenCalled();
    expect(files.logPaperExit).not.toHaveBeenCalled();
  });

  it('processes overdue confirmation expiries before subscribing live streams on restart', async () => {
    jest.useFakeTimers();
    try {
      const { service, prisma, quotes } = harness();
      prisma.solanaProgramCursor.findUnique.mockResolvedValue({ lastBackfillSignature: 'sig' });
      const sweep = jest.spyOn(service as any, 'sweepOverdueConfirmations').mockResolvedValue(undefined);

      await service.onModuleInit();

      expect(sweep).toHaveBeenCalled();
      expect(sweep.mock.invocationCallOrder[0])
        .toBeLessThan(quotes.connection.onLogs.mock.invocationCallOrder[0]);
      await service.onModuleDestroy();
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });
});

describe('SolanaMultiLaunchService exit timing data health', () => {
  it('records target vs observed execution, degrades late exits, and disables benchmark eligibility', async () => {
    const { service, prisma, files } = harness();
    const now = Date.now();
    prisma.solanaExperimentSignal.findUnique.mockResolvedValue({ flowSnapshot: { observationCount: 3 } });
    const targetAt = new Date(now - 3 * 60 * 60_000);
    const signal = {
      id: 'signal', watchId: 'watch', t0: new Date(now - 4 * 60 * 60_000),
      strategyVersion: 'solana_multi_launch_flow_v2_2', configHash: 'hash',
      riskCohort: 'EXECUTABLE_SHADOW', healthSnapshot: { source: 'STREAM' },
    };
    const arm = {
      id: 'arm-b', armCode: 'B_PROBE_4_ADD_16', signal, committedUsd: 4,
      remainingTokensRaw: '100', realizedValueUsd: 0, tokensBoughtRaw: '100', executedRungs: '',
    };
    const watch = {
      venue: 'PUMPSWAP', mintAddress: 'mint', poolAddress: 'pool', discoverySlot: 1n,
      discoverySignature: 'sig', programId: 'program', creatorAddress: null, launchedAt: new Date(now),
    };
    prisma.solanaPaperArm.update.mockResolvedValue({ ...arm, status: 'CLOSED', realizedMultiple: 0.75 });

    await (service as any).sellArm(
      arm, watch, 100n,
      { netUsd: 3, grossUsd: 3, slippagePct: 0.01, quoteSlot: 5, raw: {} },
      'NO_CONFIRMATION_SELL', 0.75, true, undefined, { targetAt },
    );

    expect(prisma.solanaExperimentSignal.updateMany).toHaveBeenCalledWith({
      where: { id: 'signal' }, data: { benchmarkEligible: false },
    });
    expect(prisma.solanaExecutionLeg.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        targetExecutionAt: targetAt,
        failureReason: 'delayed_execution:stale_state_recovery',
      }),
    }));
    const row = files.logPaperExit.mock.calls[0][0];
    expect(row.execution_scenario).toBe('DEGRADED_RECOVERY');
    expect(row.target_execution_at).toBe(targetAt.toISOString());
    expect(new Date(row.executed_at).getTime()).toBeGreaterThan(targetAt.getTime());
    expect(row.outcome_class).toBe('NO_CONFIRMATION_LOSS');
    expect(row.experiment_arm).toBe('B_PROBE_4_ADD_16');
    expect(row.strategy_version).toBe('solana_multi_launch_flow_v2_2');
    expect(row.quote_model).toBe('VENUE_EXIT_QUOTE');
    expect(JSON.parse(row.flow_snapshot).observationCount).toBe(3);
    const health = JSON.parse(row.data_health);
    expect(health.execution.delayReason).toBe('stale_state_recovery');
    expect(health.execution.executionDelayMs).toBeGreaterThanOrEqual(3 * 60 * 60_000 - 1_000);
    expect(health.execution.targetExecutionAt).toBe(targetAt.toISOString());
  });

  it('keeps a timely exit as a normal confirmed execution', async () => {
    const { service, prisma, files } = harness();
    prisma.solanaExperimentSignal.findUnique.mockResolvedValue({ flowSnapshot: { observationCount: 1 } });
    const signal = {
      id: 'signal', watchId: 'watch', t0: new Date(),
      strategyVersion: 'solana_multi_launch_flow_v2_2', configHash: 'hash',
      riskCohort: 'EXECUTABLE_SHADOW', healthSnapshot: {},
    };
    const arm = {
      id: 'arm-a', armCode: 'A_IMMEDIATE_20', signal, committedUsd: 20,
      remainingTokensRaw: '100', realizedValueUsd: 0, tokensBoughtRaw: '100', executedRungs: '',
    };
    prisma.solanaPaperArm.update.mockResolvedValue({ ...arm, status: 'CLOSED', realizedMultiple: 1.2 });

    await (service as any).sellArm(
      arm,
      {
        venue: 'PUMPSWAP', mintAddress: 'mint', poolAddress: 'pool', discoverySlot: 1n,
        discoverySignature: 'sig', programId: 'program', creatorAddress: null, launchedAt: new Date(),
      },
      100n,
      { netUsd: 24, grossUsd: 24, slippagePct: 0.01, quoteSlot: 5, raw: {} },
      'LADDER_SELL', 1.2, true,
    );

    expect(prisma.solanaExperimentSignal.updateMany).not.toHaveBeenCalled();
    const row = files.logPaperExit.mock.calls[0][0];
    expect(row.execution_scenario).toBe('CONFIRMED_RPC');
    expect(JSON.parse(row.data_health).execution.degraded).toBe(false);
  });

  it('degrades a stop exit when the arm was not observable for far longer than the evaluation cadence', async () => {
    const { service, quotes } = harness();
    quotes.sellQuote.mockResolvedValue({ netUsd: 2, grossUsd: 2, slippagePct: 0.02, quoteSlot: 100, raw: {} });
    const sell = jest.spyOn(service as any, 'sellArm').mockResolvedValue(undefined);
    const arm = {
      id: 'arm-a', armCode: 'A_IMMEDIATE_20', committedUsd: 20, remainingTokensRaw: '100',
      realizedValueUsd: 0, maxMultipleObserved: 1, currentMultiple: 1, executedRungs: '',
      tokensBoughtRaw: '100', updatedAt: new Date(Date.now() - 2 * 60 * 60_000),
      signal: {
        status: 'EXPIRED', confirmationDueAt: new Date(Date.now() - 60_000),
        horizonAt: new Date(Date.now() + 3_600_000),
        watch: { venue: 'PUMPSWAP', poolAddress: 'pool', mintAddress: 'mint', quoteMint: 'quote' },
      },
    };

    await (service as any).evaluateArm(arm);

    expect(sell).toHaveBeenCalledWith(
      arm, arm.signal.watch, 100n, expect.anything(), 'HARD_STOP_SELL', 0.1, true, undefined,
      { degradedReason: 'stale_evaluation_window' },
    );
  });
});
