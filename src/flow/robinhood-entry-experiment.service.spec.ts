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
    robinhoodEntryExperiment: { create: jest.fn(), update: jest.fn() },
  } as any;
  const liquidity = {
    verify: jest.fn().mockResolvedValue({
      liquidityVerified: true, liquidityModel: 'V2', spotPriceUsd: 1,
      executableDepthUsd: 1_000, entrySlip20: 0.01, exitSlip20: 0.01,
    }),
    quoteTrade: jest.fn().mockImplementation((_pool, sizeUsd, direction) => Promise.resolve({
      liquidityModel: 'V2', direction, sizeUsd, spotPriceUsd: 1, slippagePct: 0.01,
      executable: true, observedAt: new Date(0),
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

  beforeEach(() => jest.clearAllMocks());

  it('does not turn a stale flow tick into a fictional t0', async () => {
    const result = await (service as any).tryCreateExperiment(tick(Date.now() - 10_001));

    expect(result).toBeNull();
    expect(liquidity.verify).not.toHaveBeenCalled();
    expect(prisma.robinhoodEntryExperiment.create).not.toHaveBeenCalled();
  });

  it('creates one market sample with C-only paid capital and one observational exit arm', async () => {
    (service as any).assessSafety = jest.fn().mockResolvedValue({
      risk: SAFE_RISK, hardReason: null, buyTaxPct: 0, sellTaxPct: 0, staticSnapshot: { passed: true },
    });
    prisma.robinhoodEntryExperiment.create.mockImplementation(({ data }: any) => ({ id: 'experiment-1', ...data }));

    const result = await (service as any).tryCreateExperiment(tick());
    const create = prisma.robinhoodEntryExperiment.create.mock.calls[0][0].data;
    const arms = create.arms.create;

    expect(result.id).toBe('experiment-1');
    expect(create.configHash).toBe(ROBINHOOD_FLOW_V3_CONFIG_HASH);
    expect(arms).toHaveLength(6);
    expect(new Set(arms.map((arm: any) => arm.armCode))).toHaveProperty('size', 6);
    expect(new Set(arms.map((arm: any) => arm.scenarioCode))).toEqual(new Set(['OBSERVED_ENTRY']));
    expect(arms.filter((arm: any) => arm.primaryScenario)).toHaveLength(6);
    expect(arms.filter((arm: any) => arm.immediateUsd > 0)).toHaveLength(0);
    expect(arms.filter((arm: any) => arm.armCode === 'C_CONFIRM_20')).toEqual([
      expect.objectContaining({ addUsd: 20, immediateUsd: 0, status: 'WAITING_CONFIRMATION' }),
    ]);
    expect(arms.filter((arm: any) => arm.armCode === 'EXIT_C_90_10').every((arm: any) =>
      arm.stateJson.experimentType === 'PAIRED_EXIT' && arm.immediateUsd === 0,
    )).toBe(true);
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

  it('changes only take-profit allocation across paired exit arms', () => {
    expect((service as any).exitRungs({ armCode: 'EXIT_A_FULL_2X' })).toEqual([{ multiple: 2, fraction: 1 }]);
    expect((service as any).exitRungs({ armCode: 'EXIT_C_90_10' })).toEqual([{ multiple: 2, fraction: 0.9 }]);
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
});
