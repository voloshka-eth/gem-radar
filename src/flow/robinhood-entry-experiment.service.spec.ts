import { RobinhoodEntryExperimentService } from './robinhood-entry-experiment.service';
import { ROBINHOOD_FLOW_V3_CONFIG_HASH } from './robinhood-flow-v3';
import type { FlowTrade } from './flow.types';

const SAFE_RISK = {
  decision: 'CONTRACT_UNKNOWN', rejectReasons: [], goplusQueried: false, honeypotQueried: false,
  merged: { providerStatus: 'NO_RISK_PROVIDER_SUPPORT' }, providerStatus: 'NO_RISK_PROVIDER_SUPPORT', cacheHit: false,
} as any;

function buy(trader: string, occurredAtMs: number, blockNumber: string): FlowTrade {
  return {
    chain: 'robinhood', poolAddress: '0xpool', tokenAddress: '0xtoken', blockNumber,
    blockHash: null, txHash: `${trader}-${occurredAtMs}`, logIndex: occurredAtMs,
    occurredAtMs, trader, kind: 'BUY', quoteAmountUsd: 100, tokenAmount: 100, priceUsd: 1,
  };
}

function tick(observedAtMs = Date.now(), trades: FlowTrade[] = []): any {
  return {
    watchId: 'watch-1', watchType: 'FRESH', liquidityModel: 'V2', trades,
    discoveredAtMs: 0, latestBlock: 100n, observedAtMs, gemDecimals: 18,
    creatorAddress: null, creatorAttributable: false, launchPriceUsd: 1,
    dataHealthy: true, pipelineHealthy: true, dataHealth: { lagBlocks: 0 }, v2ShadowDecision: null,
    candidate: {
      token: { tokenAddress: '0xtoken', symbol: 'TEST', name: 'Test', decimals: 18 },
      pool: {
        chain: 'robinhood', poolAddress: '0xpool', dex: 'test', source: 'factory',
        token0Address: '0xquote', token1Address: '0xtoken', quoteAsset: 'WETH',
        quoteAssetAddress: '0xquote', poolCreatedAt: new Date(0),
      },
    },
  };
}

describe('RobinhoodEntryExperimentService', () => {
  const prisma = {
    robinhoodEntryExperiment: { create: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    robinhoodExperimentArm: { updateMany: jest.fn() },
    robinhoodExperimentLeg: { updateMany: jest.fn() },
    $transaction: jest.fn((operations: Promise<unknown>[]) => Promise.all(operations)),
  } as any;
  const liquidity = {
    verify: jest.fn().mockResolvedValue({
      liquidityVerified: true, liquidityModel: 'V2', spotPriceUsd: 1,
      executableDepthUsd: 1_000, entrySlip20: 0.01, exitSlip20: 0.01,
    }),
    quoteTrade: jest.fn().mockImplementation((_pool, sizeUsd, direction) => Promise.resolve({
      liquidityModel: 'V2', direction, sizeUsd, spotPriceUsd: 1, slippagePct: 0.01,
      executable: true, observedAt: new Date(),
    })),
  } as any;
  const service = new RobinhoodEntryExperimentService(
    { get: jest.fn((key: string) => key === 'paper.sandwichPct' ? 0 : undefined) } as any,
    prisma,
    liquidity,
    { inspect: jest.fn() } as any,
    { checkToken: jest.fn() } as any,
    { findBlocklistHit: jest.fn(), summarize: jest.fn() } as any,
    { estimateUsd: jest.fn().mockResolvedValue(0.01) } as any,
    { logPaperEntry: jest.fn(), logPaperExit: jest.fn() } as any,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    liquidity.quoteTrade.mockImplementation((_pool: unknown, sizeUsd: number, direction: string) => Promise.resolve({
      liquidityModel: 'V2', direction, sizeUsd, spotPriceUsd: 1, slippagePct: 0.01,
      executable: true, observedAt: new Date(),
    }));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('does not turn a stale flow tick into a fictional t0', async () => {
    const result = await (service as any).tryCreateExperiment(tick(Date.now() - 10_001));

    expect(result).toBeNull();
    expect(liquidity.verify).not.toHaveBeenCalled();
    expect(prisma.robinhoodEntryExperiment.create).not.toHaveBeenCalled();
  });

  it('creates exactly one canonical observed full-2x position per Robinhood signal', async () => {
    (service as any).assessSafety = jest.fn().mockResolvedValue({
      risk: SAFE_RISK, hardReason: null, buyTaxPct: 0, sellTaxPct: 0, staticSnapshot: { passed: true },
    });
    prisma.robinhoodEntryExperiment.create.mockImplementation(({ data }: any) => ({ id: 'experiment-1', ...data }));

    const result = await (service as any).tryCreateExperiment(tick());
    const create = prisma.robinhoodEntryExperiment.create.mock.calls[0][0].data;
    const arms = create.arms.create;

    expect(result.id).toBe('experiment-1');
    expect(create.configHash).toBe(ROBINHOOD_FLOW_V3_CONFIG_HASH);
    expect(arms).toHaveLength(1);
    expect(arms[0]).toMatchObject({
      armCode: 'EXIT_A_FULL_2X', scenarioCode: 'OBSERVED_ENTRY',
      status: 'OPEN', committedUsd: 20,
      stateJson: { atomicT0Fill: true },
      legs: { create: [expect.objectContaining({ status: 'FILLED' })] },
    });
  });

  it('opens a separate 1-3% high-friction paper cohort without mixing it into low friction', async () => {
    (service as any).assessSafety = jest.fn().mockResolvedValue({
      risk: SAFE_RISK, hardReason: null, buyTaxPct: 0, sellTaxPct: 0, staticSnapshot: { passed: true },
    });
    liquidity.quoteTrade.mockImplementation((_pool: unknown, sizeUsd: number, direction: string) => Promise.resolve({
      liquidityModel: 'V2', direction, sizeUsd, spotPriceUsd: 1, slippagePct: 0.02,
      executable: true, observedAt: new Date(),
    }));
    prisma.robinhoodEntryExperiment.create.mockImplementation(({ data }: any) => ({ id: 'shadow', ...data }));

    await (service as any).tryCreateExperiment(tick());
    const create = prisma.robinhoodEntryExperiment.create.mock.calls[0][0].data;

    expect(create.frictionCohort).toBe('HIGH_FRICTION_PAPER');
    const observedExits = create.arms.create.filter((arm: any) =>
      arm.armCode.startsWith('EXIT_') && arm.scenarioCode === 'OBSERVED_ENTRY',
    );
    expect(observedExits).toHaveLength(1);
    expect(observedExits.every((arm: any) =>
      arm.status === 'OPEN' && arm.committedUsd === 20 && arm.legs.create[0].status === 'FILLED'
    )).toBe(true);
  });

  it('keeps the v1.10 universe when sell friction is high but the buy route is executable', async () => {
    (service as any).assessSafety = jest.fn().mockResolvedValue({
      risk: SAFE_RISK, hardReason: null, buyTaxPct: 0, sellTaxPct: 0, staticSnapshot: { passed: true },
    });
    liquidity.quoteTrade.mockImplementation((_pool: unknown, sizeUsd: number, direction: string) => Promise.resolve({
      liquidityModel: 'V2', direction, sizeUsd, spotPriceUsd: 1,
      slippagePct: direction === 'BUY' ? 0.02 : 0.12,
      executable: true, observedAt: new Date(),
    }));
    prisma.robinhoodEntryExperiment.create.mockImplementation(({ data }: any) => ({ id: 'wide-universe', ...data }));

    const result = await (service as any).tryCreateExperiment(tick());

    expect(result.id).toBe('wide-universe');
    expect(prisma.robinhoodEntryExperiment.create).toHaveBeenCalledTimes(1);
  });

  it('fires confirmation once and schedules add legs only for C', async () => {
    const trades = [
      buy('0xa1', 15_000, '1'), buy('0xa2', 18_000, '1'),
      buy('0xb1', 21_000, '2'), buy('0xb2', 23_000, '2'),
      buy('0xb3', 25_000, '3'), buy('0xb4', 28_000, '3'),
    ];
    const experiment = {
      id: 'experiment-1', t0At: new Date(0), t0SpotPriceUsd: 1, t0DepthUsd: 1_000,
      confirmationStatus: 'PENDING',
      arms: [
        { id: 'arm-a', armCode: 'A_IMMEDIATE_20', addUsd: 0, latencyMs: 0, status: 'WAITING_CONFIRMATION', legs: [] },
        { id: 'arm-b', armCode: 'B_PROBE_4_ADD_16', addUsd: 0, latencyMs: 0, status: 'WAITING_CONFIRMATION', legs: [] },
        { id: 'arm-c', armCode: 'C_CONFIRM_20', addUsd: 20, latencyMs: 0, status: 'WAITING_CONFIRMATION', legs: [] },
        { id: 'arm-d', armCode: 'D_PROBE_2_ADD_18', addUsd: 0, latencyMs: 0, status: 'WAITING_CONFIRMATION', legs: [] },
        { id: 'arm-e', armCode: 'E_PROBE_10_ADD_10', addUsd: 0, latencyMs: 0, status: 'WAITING_CONFIRMATION', legs: [] },
      ],
    };
    (service as any).assessSafety = jest.fn().mockResolvedValue({
      risk: SAFE_RISK, hardReason: null, buyTaxPct: 0, sellTaxPct: 0, staticSnapshot: { passed: true },
    });
    (service as any).createPendingLeg = jest.fn();

    await (service as any).evaluateConfirmation(
      experiment,
      tick(30_000, trades),
      { liquidityVerified: true, spotPriceUsd: 1.2, executableDepthUsd: 950 },
    );

    const confirmedUpdate = prisma.robinhoodEntryExperiment.update.mock.calls
      .map((call: any[]) => call[0].data)
      .find((data: any) => data.confirmationStatus === 'CONFIRMED');
    expect(confirmedUpdate).toMatchObject({
      status: 'CONFIRMED', classifierReferenceStatus: 'SCHEDULED',
    });
    expect((service as any).createPendingLeg).toHaveBeenCalledTimes(1);
    expect((service as any).createPendingLeg).toHaveBeenCalledWith(
      expect.objectContaining({ armCode: 'C_CONFIRM_20' }),
      'CONFIRM_ADD',
      30_000,
      30_000,
      20,
    );
  });

  it('expires confirmation against the absolute t0 clock and schedules the classifier reference at primary latency', async () => {
    const experiment = { id: 'experiment-1', t0At: new Date(0), confirmationStatus: 'PENDING', arms: [] };
    (service as any).expireUnconfirmedArms = jest.fn();

    await (service as any).evaluateConfirmation(
      experiment,
      tick(60_001),
      { liquidityVerified: true, spotPriceUsd: 1, executableDepthUsd: 1_000 },
    );

    expect(prisma.robinhoodEntryExperiment.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        confirmationStatus: 'EXPIRED',
        classifierReferenceStatus: 'SCHEDULED',
        classifierReferenceTargetAt: new Date(62_001),
      }),
    }));
  });

  it('executes immediate legs before refreshing dynamic risk', async () => {
    const order: string[] = [];
    const experiment = {
      id: 'experiment-1', watchId: 'watch-1', status: 'CONFIRMING', confirmationStatus: 'PENDING',
      t0At: new Date(), arms: [],
    };
    (service as any).findExperiment = jest.fn().mockResolvedValue(experiment);
    (service as any).executeDueLegs = jest.fn().mockImplementation(async () => { order.push('execute'); });
    (service as any).dynamicHardRiskReason = jest.fn().mockImplementation(async () => {
      order.push('risk');
      return null;
    });
    (service as any).creatorSellSince = jest.fn().mockReturnValue(0);
    (service as any).evaluateConfirmation = jest.fn();
    (service as any).initializeClassifierReference = jest.fn();
    (service as any).shouldEvaluateMarket = jest.fn().mockReturnValue(false);
    (service as any).resolveIfComplete = jest.fn();

    await (service as any).processExperiment(experiment, tick());

    expect(order.slice(0, 2)).toEqual(['execute', 'risk']);
  });

  it('preserves filled exit arms across a config change instead of invalidating them', async () => {
    const frozen = {
      id: 'experiment-1', watchId: 'watch-1', status: 'CONFIRMING',
      configHash: 'previous-frozen-config', horizonAt: new Date(123_456),
    };
    jest.spyOn(service as any, 'findExperiment').mockResolvedValue(frozen);
    const processFrozenExperiment = jest.spyOn(service as any, 'processFrozenExperiment').mockResolvedValue(undefined);
    const invalidateExperiment = jest.spyOn(service as any, 'invalidateExperiment').mockResolvedValue(undefined);

    const result = await service.handleTick(tick());

    expect(processFrozenExperiment).toHaveBeenCalledWith(frozen, expect.anything());
    expect(invalidateExperiment).not.toHaveBeenCalled();
    expect(result).toBe(123_456);
  });

  it('attempts a Robinhood entry when block coverage is healthy but recent flow is quiet', async () => {
    const created = {
      id: 'experiment-quiet-flow',
      watchId: 'watch-1',
      status: 'CONFIRMING',
      configHash: ROBINHOOD_FLOW_V3_CONFIG_HASH,
      horizonAt: new Date(123_456),
    };
    jest.spyOn(service as any, 'findExperiment')
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(created);
    const tryCreate = jest.spyOn(service as any, 'tryCreateExperiment').mockResolvedValue(created);
    jest.spyOn(service as any, 'processExperiment').mockResolvedValue(undefined);

    const result = await service.handleTick({
      ...tick(20_000),
      dataHealthy: false,
      pipelineHealthy: true,
    });

    expect(tryCreate).toHaveBeenCalledTimes(1);
    expect(result).toBe(123_456);
  });

  it('does not attempt a Robinhood entry while block coverage is unhealthy', async () => {
    jest.spyOn(service as any, 'findExperiment').mockResolvedValue(null);
    const tryCreate = jest.spyOn(service as any, 'tryCreateExperiment');

    await expect(service.handleTick({
      ...tick(20_000),
      dataHealthy: true,
      pipelineHealthy: false,
    })).resolves.toBeNull();

    expect(tryCreate).not.toHaveBeenCalled();
  });

  it('exports only the canonical observed full-2x arm to the legacy CSV view', () => {
    expect((service as any).isCanonicalCsvArm({
      armCode: 'EXIT_A_FULL_2X', scenarioCode: 'OBSERVED_ENTRY',
    })).toBe(true);
    expect((service as any).isCanonicalCsvArm({
      armCode: 'EXIT_B_FULL_1_5X', scenarioCode: 'OBSERVED_ENTRY',
    })).toBe(false);
    expect((service as any).isCanonicalCsvArm({
      armCode: 'EXIT_A_FULL_2X', scenarioCode: 'STRESS_1_BLOCK',
    })).toBe(false);
  });

  it('changes only take-profit allocation across paired exit arms', () => {
    expect((service as any).exitRungs({ armCode: 'EXIT_A_FULL_2X' })).toEqual([{ multiple: 2, fraction: 1 }]);
    expect((service as any).exitRungs({ armCode: 'EXIT_B_FULL_1_5X' })).toEqual([{ multiple: 1.5, fraction: 1 }]);
    expect((service as any).exitRungs({ armCode: 'EXIT_C_90_10' })).toEqual([{ multiple: 2, fraction: 0.9 }]);
    // Historical rows remain interpretable, but this arm is not part of v2.
    expect((service as any).exitRungs({ armCode: 'EXIT_B_LADDER_80_15_5' })).toEqual([
      { multiple: 2, fraction: 0.8 }, { multiple: 10, fraction: 0.15 }, { multiple: 1000, fraction: 0.05 },
    ]);
  });

  it('measures confirmation execution lateness from the leg target, not from t0', async () => {
    const legUpdate = jest.fn().mockResolvedValue({});
    const armUpdate = jest.fn().mockResolvedValue({});
    (prisma as any).robinhoodExperimentLeg = { update: legUpdate };
    (prisma as any).robinhoodExperimentArm = { update: armUpdate };
    (prisma as any).$transaction = jest.fn((operations: Promise<unknown>[]) => Promise.all(operations));
    jest.spyOn(service as any, 'cachedQuote').mockResolvedValue({
      liquidityModel: 'V2',
      direction: 'BUY',
      sizeUsd: 20,
      spotPriceUsd: 1,
      slippagePct: 0.01,
      executable: true,
      observedAt: new Date(31_000),
    });
    jest.spyOn(service as any, 'logEntry').mockImplementation(() => undefined);
    const arm = {
      id: 'arm',
      armCode: 'C_CONFIRM_20',
      status: 'WAITING_CONFIRMATION',
      gasMultiplier: 1,
      tokensBought: 0,
      remainingTokens: 0,
      committedUsd: 0,
      stateJson: {},
      experiment: { t0At: new Date(0), riskSnapshot: {} },
    };
    const leg = {
      id: 'leg',
      legType: 'CONFIRM_ADD',
      notionalUsd: 20,
      targetAt: new Date(30_000),
    };

    await (service as any).executeBuyLeg(arm, leg, tick(31_000), 0.01, new Map());

    expect(armUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        stateJson: expect.objectContaining({
          observedSignalLatencyMs: 31_000,
          observedEntryLatenessMs: 1_000,
          benchmarkEntryEligible: true,
        }),
      }),
    }));
  });

  it('kills late paid fills instead of fabricating a timely primary entry', async () => {
    const legUpdate = jest.fn().mockResolvedValue({});
    const armUpdate = jest.fn().mockResolvedValue({});
    (prisma as any).robinhoodExperimentLeg = { update: legUpdate };
    (prisma as any).robinhoodExperimentArm = { update: armUpdate };
    (prisma as any).$transaction = jest.fn((operations: Promise<unknown>[]) => Promise.all(operations));
    jest.spyOn(service as any, 'logEntry').mockImplementation(() => undefined);
    const cachedQuote = jest.spyOn(service as any, 'cachedQuote');
    const arm = {
      id: 'arm', armCode: 'C_CONFIRM_20', status: 'WAITING_CONFIRMATION', gasMultiplier: 1,
      tokensBought: 0, remainingTokens: 0, committedUsd: 0, stateJson: {},
      experiment: { t0At: new Date(0), riskSnapshot: {} },
    };
    const leg = {
      id: 'leg', legType: 'CONFIRM_ADD', notionalUsd: 20, targetAt: new Date(20_000),
    };

    await (service as any).executeBuyLeg(arm, leg, tick(40_000), 0.01, new Map());

    expect(cachedQuote).not.toHaveBeenCalled();
    expect(legUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: 'FAILED',
        failureReason: expect.stringContaining('execution_window_missed'),
      }),
    }));
  });

  it('waits through a short pipeline health miss before invalidating an experiment', async () => {
    const experiment = {
      id: 'experiment-health', watchId: 'watch-1', status: 'CONFIRMING',
      configHash: ROBINHOOD_FLOW_V3_CONFIG_HASH, horizonAt: new Date(100_000),
    };
    jest.spyOn(service as any, 'findExperiment').mockResolvedValue(experiment);
    const invalidate = jest.spyOn(service as any, 'invalidateExperiment').mockResolvedValue(undefined);
    const unhealthy = { ...tick(10_000), pipelineHealthy: false };

    await expect(service.handleTick(unhealthy)).resolves.toBe(100_000);
    await expect(service.handleTick({ ...unhealthy, observedAtMs: 19_999 })).resolves.toBe(100_000);
    expect(invalidate).not.toHaveBeenCalled();

    await service.handleTick({ ...unhealthy, observedAtMs: 20_000 });
    expect(invalidate).toHaveBeenCalledWith(experiment, 'unhealthy_paired_signal_period');
  });

  it('keeps technical experiment invalidation out of the market-exit CSV', async () => {
    const transition = jest.fn()
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    prisma.robinhoodEntryExperiment.updateMany = transition;
    prisma.robinhoodExperimentArm = { updateMany: jest.fn().mockResolvedValue({ count: 16 }) };
    prisma.robinhoodExperimentLeg = { updateMany: jest.fn().mockResolvedValue({ count: 8 }) };
    prisma.$transaction = jest.fn((operations: Promise<unknown>[]) => Promise.all(operations));
    const logPaperExit = (service as any).files.logPaperExit as jest.Mock;
    const experiment = {
      id: 'experiment-once', tokenAddress: '0xtoken', symbol: 'TEST', poolAddress: '0xpool',
      configHash: ROBINHOOD_FLOW_V3_CONFIG_HASH, frictionCohort: 'LOW_FRICTION_PRIMARY', arms: Array(16).fill({}),
    };

    await (service as any).invalidateExperiment(experiment, 'unhealthy_paired_signal_period');
    await (service as any).invalidateExperiment(experiment, 'unhealthy_paired_signal_period');

    expect(transition).toHaveBeenCalledTimes(2);
    expect(logPaperExit).not.toHaveBeenCalled();
  });
});
