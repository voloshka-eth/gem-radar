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

  it('creates one market sample with exactly 5 arms x 4 latency scenarios', async () => {
    (service as any).assessSafety = jest.fn().mockResolvedValue({
      risk: SAFE_RISK, hardReason: null, buyTaxPct: 0, sellTaxPct: 0, staticSnapshot: { passed: true },
    });
    prisma.robinhoodEntryExperiment.create.mockImplementation(({ data }: any) => ({ id: 'experiment-1', ...data }));

    const result = await (service as any).tryCreateExperiment(tick());
    const create = prisma.robinhoodEntryExperiment.create.mock.calls[0][0].data;
    const arms = create.arms.create;

    expect(result.id).toBe('experiment-1');
    expect(create.configHash).toBe(ROBINHOOD_FLOW_V3_CONFIG_HASH);
    expect(arms).toHaveLength(20);
    expect(new Set(arms.map((arm: any) => arm.armCode))).toHaveProperty('size', 5);
    expect(new Set(arms.map((arm: any) => arm.scenarioCode))).toHaveProperty('size', 4);
    expect(arms.filter((arm: any) => arm.primaryScenario)).toHaveLength(5);
    expect(arms.filter((arm: any) => arm.stressScenario && Number(arm.gasMultiplier) === 1.3)).toHaveLength(5);
    expect(arms.filter((arm: any) => arm.immediateUsd > 0 && arm.legs?.create?.length === 1)).toHaveLength(16);
    expect(arms.filter((arm: any) => arm.armCode === 'C_CONFIRM_20').every((arm: any) => !arm.legs)).toBe(true);
  });

  it('fires confirmation once and schedules add legs for every B/C/D/E scenario', async () => {
    const trades = [
      buy('0xa1', 15_000, '1'), buy('0xa2', 18_000, '1'),
      buy('0xb1', 21_000, '2'), buy('0xb2', 23_000, '2'),
      buy('0xb3', 25_000, '3'), buy('0xb4', 28_000, '3'),
    ];
    const experiment = {
      id: 'experiment-1', t0At: new Date(0), t0SpotPriceUsd: 1, t0DepthUsd: 1_000,
      confirmationStatus: 'PENDING',
      arms: Array.from({ length: 20 }, (_, index) => ({
        id: `arm-${index}`, armCode: index % 5 === 0 ? 'A_IMMEDIATE_20' : 'OTHER',
        addUsd: index % 5 === 0 ? 0 : 10, latencyMs: index % 4 * 1_000,
        status: 'WAITING_CONFIRMATION', legs: [],
      })),
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
    expect((service as any).createPendingLeg).toHaveBeenCalledTimes(16);
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
});
