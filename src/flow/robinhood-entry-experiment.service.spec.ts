import { RobinhoodEntryExperimentService } from './robinhood-entry-experiment.service';
import {
  ROBINHOOD_EXIT_EXPERIMENT_CONFIG_HASH,
  ROBINHOOD_FLOW_V3_CONFIG_HASH,
} from './robinhood-flow-v3';
import { ROBINHOOD_GECKO_LANE_CONFIG } from './robinhood-gecko-lane';
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
    robinhoodEntryExperiment: {
      create: jest.fn(),
      update: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
    },
    robinhoodExperimentArm: {
      findMany: jest.fn().mockResolvedValue([]),
    },
  } as any;
  const liquidity = {
    verify: jest.fn().mockResolvedValue({
      liquidityVerified: true, liquidityModel: 'V2', spotPriceUsd: 1,
      executableDepthUsd: 1_000, entrySlip20: 0.01, exitSlip20: 0.01,
    }),
    verifyEntrySnapshot: jest.fn().mockResolvedValue({
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
    {
      assessTokenCluster: jest.fn().mockResolvedValue({
        available: false, skipped: true, skipReason: 'bubblemaps_disabled',
        gate: null, hardReason: null, raw: null,
      }),
    } as any,
    {
      assessToken: jest.fn().mockResolvedValue({
        available: false, skipped: true, skipReason: 'free_holder_gate_disabled',
        source: null, gate: null, hardReason: null, raw: null,
      }),
    } as any,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    liquidity.verify.mockResolvedValue({
      liquidityVerified: true, liquidityModel: 'V2', spotPriceUsd: 1,
      executableDepthUsd: 1_000, entrySlip20: 0.01, exitSlip20: 0.01,
    });
    liquidity.verifyEntrySnapshot.mockResolvedValue({
      liquidityVerified: true, liquidityModel: 'V2', spotPriceUsd: 1,
      executableDepthUsd: 1_000, entrySlip20: 0.01, exitSlip20: 0.01,
    });
    prisma.robinhoodEntryExperiment.count.mockResolvedValue(0);
    if (!(prisma.robinhoodExperimentArm as any).findMany) {
      (prisma.robinhoodExperimentArm as any).findMany = jest.fn();
    }
    (prisma.robinhoodExperimentArm as any).findMany.mockResolvedValue([]);
    (service as any).bankrollDecisionCache = null;
    (service as any).createAttemptAt.clear();
    (service as any).attemptSnapshots.clear();
  });

  it('does not turn a stale flow tick into a fictional t0', async () => {
    const result = await (service as any).tryCreateExperiment(tick(Date.now() - 10_001));

    expect(result).toBeNull();
    expect(liquidity.verify).not.toHaveBeenCalled();
    expect(prisma.robinhoodEntryExperiment.create).not.toHaveBeenCalled();
  });

  it('rejects an unexecutable market snapshot before spending safety RPCs', async () => {
    liquidity.verifyEntrySnapshot.mockResolvedValueOnce({
      liquidityVerified: false, liquidityModel: 'V3', spotPriceUsd: null,
      executableDepthUsd: null, entrySlip20: null, exitSlip20: null,
      error: 'route_unavailable',
    });
    const safety = jest.spyOn(service as any, 'assessSafety');

    await expect((service as any).tryCreateExperiment(tick())).resolves.toBeNull();

    expect(liquidity.verifyEntrySnapshot).toHaveBeenCalledTimes(1);
    expect(liquidity.quoteTrade).not.toHaveBeenCalled();
    expect(safety).not.toHaveBeenCalled();
    expect(service.getAttemptSnapshot('watch-1')).toMatchObject({
      outcome: 'WAIT',
      reason: 'liquidity_unverified',
    });
    safety.mockRestore();
  });

  it('attempts quote-driven creation when flow is stale but block coverage is healthy', async () => {
    const find = jest.spyOn(service as any, 'findExperiment').mockResolvedValue(null);
    const create = jest.spyOn(service as any, 'tryCreateExperiment').mockResolvedValue(null);
    const staleFlow = tick();
    staleFlow.watchId = 'stale-flow-watch';
    staleFlow.dataHealthy = false;
    staleFlow.pipelineHealthy = true;

    await service.handleTick(staleFlow);

    expect(create).toHaveBeenCalledWith(staleFlow);
    expect((service as any).getAttemptSnapshot(staleFlow.watchId)?.reason)
      .not.toBe('latest_swap_or_coverage_unhealthy');
    find.mockRestore();
    create.mockRestore();
  });

  it('degrades on transient pipeline unhealthy instead of invalidating the experiment', async () => {
    const existing = {
      id: 'experiment-1',
      watchId: 'watch-1',
      status: 'CONFIRMING',
      configHash: ROBINHOOD_FLOW_V3_CONFIG_HASH,
    };
    jest.spyOn(service as any, 'findExperiment').mockResolvedValue(existing);
    const degrade = jest.spyOn(service as any, 'handleUnhealthyPipeline').mockResolvedValue(undefined);
    const invalidate = jest.spyOn(service as any, 'invalidateExperiment').mockResolvedValue(undefined);
    const unhealthy = tick();
    unhealthy.pipelineHealthy = false;

    await service.handleTick(unhealthy);

    expect(degrade).toHaveBeenCalledWith(existing, unhealthy);
    expect(invalidate).not.toHaveBeenCalledWith(existing, 'unhealthy_paired_signal_period');
    degrade.mockRestore();
    invalidate.mockRestore();
  });

  it('does not append INVALIDATED rows to the operator paper_exits CSV', async () => {
    prisma.$transaction = jest.fn(async (ops: Array<Promise<unknown> | unknown>) => {
      await Promise.all(ops.map((op) => Promise.resolve(op)));
    });
    prisma.robinhoodEntryExperiment.update.mockResolvedValue({});
    prisma.robinhoodExperimentArm.updateMany = jest.fn().mockResolvedValue({ count: 2 });
    prisma.robinhoodExperimentLeg = {
      updateMany: jest.fn().mockResolvedValue({ count: 2 }),
    };
    const files = (service as any).files;

    await (service as any).invalidateExperiment({
      id: 'exp-inv',
      watchId: 'watch-1',
      tokenAddress: '0xabc',
      poolAddress: '0xdef',
      symbol: 'NOISE',
      configVersion: 'robinhood_low_friction_2x_v1',
      configHash: ROBINHOOD_FLOW_V3_CONFIG_HASH,
      frictionCohort: 'HIGH_FRICTION_SHADOW',
      arms: [
        { armCode: 'EXIT_A_FULL_2X', scenarioCode: 'OBSERVED_ENTRY' },
        { armCode: 'EXIT_B_LADDER_80_15_5', scenarioCode: 'OBSERVED_ENTRY' },
      ],
    }, 'frozen_config_hash_mismatch');

    expect(files.logPaperExit).not.toHaveBeenCalled();
    expect(prisma.$transaction).toHaveBeenCalled();
  });

  it('logs both low- and high-friction fills to the operator paper CSV trail', () => {
    expect((service as any).shouldLogOperatorCsv('LOW_FRICTION_PRIMARY')).toBe(true);
    expect((service as any).shouldLogOperatorCsv('HIGH_FRICTION_SHADOW')).toBe(true);
    expect((service as any).shouldLogOperatorCsv('BANKROLL_LIMIT_SHADOW')).toBe(false);
  });

  it('creates one market sample with three shared-quote paired exit arms', async () => {
    (service as any).assessSafety = jest.fn().mockResolvedValue({
      risk: SAFE_RISK, hardReason: null, buyTaxPct: 0, sellTaxPct: 0, staticSnapshot: { passed: true }, bubblemapsSnapshot: null, holderConcentrationSnapshot: null,
    });
    prisma.robinhoodEntryExperiment.create.mockImplementation(({ data }: any) => ({ id: 'experiment-1', ...data }));

    const result = await (service as any).tryCreateExperiment(tick());
    const create = prisma.robinhoodEntryExperiment.create.mock.calls[0][0].data;
    const arms = create.arms.create;

    expect(result.id).toBe('experiment-1');
    expect(create.configHash).toBe(ROBINHOOD_FLOW_V3_CONFIG_HASH);
    expect(arms).toHaveLength(16);
    expect(new Set(arms.map((arm: any) => arm.armCode))).toHaveProperty('size', 8);
    expect(new Set(arms.map((arm: any) => arm.scenarioCode))).toEqual(
      new Set(['OBSERVED_ENTRY', 'STRESS_1_BLOCK']),
    );
    expect(arms.filter((arm: any) => arm.primaryScenario)).toHaveLength(8);
    expect(arms.filter((arm: any) => arm.immediateUsd > 0)).toHaveLength(6);
    expect(arms.filter((arm: any) => arm.armCode === 'C_CONFIRM_20')).toHaveLength(2);
    expect(arms.filter((arm: any) => arm.armCode === 'C_CONFIRM_20').every(
      (arm: any) => arm.addUsd === 20 && arm.immediateUsd === 0 && arm.status === 'WAITING_CONFIRMATION',
    )).toBe(true);
    expect(arms.filter((arm: any) => arm.armCode.startsWith('EXIT_')).every((arm: any) =>
      arm.stateJson.experimentType === 'PAIRED_EXIT' &&
      arm.immediateUsd === 20 &&
      arm.stateJson.frictionCohort === 'LOW_FRICTION_PRIMARY' &&
      arm.stateJson.sharedEntryQuoteId === create.sharedEntryQuoteId,
    )).toBe(true);
    const observedExitArms = arms.filter((arm: any) =>
      arm.armCode.startsWith('EXIT_') && arm.scenarioCode === 'OBSERVED_ENTRY',
    );
    expect(observedExitArms).toHaveLength(3);
    expect(observedExitArms.every((arm: any) =>
      arm.status === 'OPEN' &&
      arm.committedUsd === 20 &&
      arm.tokensBought > 0 &&
      arm.remainingTokens === arm.tokensBought &&
      arm.openedAt instanceof Date &&
      arm.stateJson.atomicT0Fill === true &&
      arm.stateJson.observedEntryLatenessMs === 0 &&
      arm.legs.create[0].status === 'FILLED' &&
      arm.legs.create[0].executedAt instanceof Date,
    )).toBe(true);
    expect(arms.filter((arm: any) =>
      arm.armCode.startsWith('EXIT_') && arm.scenarioCode === 'STRESS_1_BLOCK',
    ).every((arm: any) =>
      arm.status === 'PENDING_ENTRY' && arm.legs.create[0].status === 'PENDING',
    )).toBe(true);
    expect(create.frictionCohort).toBe('LOW_FRICTION_PRIMARY');
    expect(create.t0BuyImpactPct).toBe(0.01);
    expect(create.dataHealthSnapshot).toMatchObject({
      frictionDetailCohort: 'BOTH_LE_1',
      frictionFeatureVersion: 'robinhood_execution_friction_features_v3',
      frictionQuoteModel: 'single_venue_depth_snapshot_exact_20_bidirectional',
      frictionFeatureHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      bankrollPolicyVersion: 'robinhood_low_friction_bankroll_v1',
      bankrollEligible: true,
      geckoLaneVersion: ROBINHOOD_GECKO_LANE_CONFIG.version,
      geckoLaneSignalEligible: false,
      geckoLaneBankrollEligible: false,
      geckoLaneReasons: ['source_not_geckoterminal'],
      discoverySource: 'factory',
      poolDiscoverySource: 'factory',
    });
    expect(arms.every((arm: any) =>
      arm.stateJson.frictionDetailCohort === 'BOTH_LE_1' &&
      arm.stateJson.discoverySource === 'factory',
    )).toBe(true);
  });

  it('registers Gecko low-friction signals in the fixed full-2x holdout lane', async () => {
    (service as any).assessSafety = jest.fn().mockResolvedValue({
      risk: SAFE_RISK, hardReason: null, buyTaxPct: 0, sellTaxPct: 0, staticSnapshot: { passed: true }, bubblemapsSnapshot: null, holderConcentrationSnapshot: null,
    });
    prisma.robinhoodEntryExperiment.create.mockImplementation(
      ({ data }: any) => ({ id: 'gecko-lane', ...data }),
    );
    const geckoTick = tick();
    geckoTick.candidate.pool.source = 'geckoterminal';
    geckoTick.candidate.token.source = 'geckoterminal';

    await (service as any).tryCreateExperiment(geckoTick);

    const create = prisma.robinhoodEntryExperiment.create.mock.calls[0][0].data;
    expect(create.dataHealthSnapshot).toMatchObject({
      geckoLaneVersion: ROBINHOOD_GECKO_LANE_CONFIG.version,
      geckoLaneHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      geckoLaneSignalEligible: true,
      geckoLaneBankrollEligible: true,
      geckoLaneReasons: [],
      flowFreshAtT0: true,
      v1SignalEligible: true,
    });
    expect(create.arms.create.every((arm: any) =>
      arm.stateJson.geckoLaneSignalEligible === true &&
      arm.stateJson.geckoLaneBankrollEligible === true,
    )).toBe(true);
  });

  it('lets the quote-driven Gecko lane observe stale flow without contaminating v1', async () => {
    (service as any).assessSafety = jest.fn().mockResolvedValue({
      risk: SAFE_RISK, hardReason: null, buyTaxPct: 0, sellTaxPct: 0, staticSnapshot: { passed: true }, bubblemapsSnapshot: null, holderConcentrationSnapshot: null,
    });
    prisma.robinhoodEntryExperiment.create.mockImplementation(
      ({ data }: any) => ({ id: 'gecko-stale-flow', ...data }),
    );
    const geckoTick = tick();
    geckoTick.dataHealthy = false;
    geckoTick.dataHealth.latestSwapAgeMs = 30_000;
    geckoTick.candidate.pool.source = 'geckoterminal';
    geckoTick.candidate.token.source = 'geckoterminal';

    await (service as any).tryCreateExperiment(geckoTick);

    const create = prisma.robinhoodEntryExperiment.create.mock.calls[0][0].data;
    expect(create.dataHealthSnapshot).toMatchObject({
      flowFreshAtT0: false,
      v1SignalEligible: false,
      bankrollEligible: false,
      bankrollReasons: ['flow_snapshot_stale_at_t0'],
      geckoLaneSignalEligible: true,
      geckoLaneBankrollEligible: true,
      geckoLaneReasons: [],
    });
    expect(create.arms.create.every((arm: any) =>
      arm.stateJson.v1SignalEligible === false &&
      arm.stateJson.geckoLaneSignalEligible === true,
    )).toBe(true);
  });

  it('keeps excess low-friction signals as bankroll-limit shadow observations', async () => {
    (service as any).assessSafety = jest.fn().mockResolvedValue({
      risk: SAFE_RISK, hardReason: null, buyTaxPct: 0, sellTaxPct: 0, staticSnapshot: { passed: true }, bubblemapsSnapshot: null, holderConcentrationSnapshot: null,
    });
    prisma.robinhoodEntryExperiment.count
      .mockResolvedValueOnce(5)
      .mockResolvedValueOnce(5);
    prisma.robinhoodEntryExperiment.create.mockImplementation(
      ({ data }: any) => ({ id: 'bankroll-shadow', ...data }),
    );

    await (service as any).tryCreateExperiment(tick());

    const create = prisma.robinhoodEntryExperiment.create.mock.calls[0][0].data;
    expect(create.frictionCohort).toBe('BANKROLL_LIMIT_SHADOW');
    expect(create.dataHealthSnapshot).toMatchObject({
      bankrollEligible: false,
      bankrollReasons: expect.arrayContaining([
        'max_concurrent_signals',
        'max_aggregate_exposure',
      ]),
    });
    expect(create.arms.create.every((arm: any) =>
      arm.stateJson.frictionCohort === 'BANKROLL_LIMIT_SHADOW' &&
      arm.stateJson.bankrollEligible === false,
    )).toBe(true);
  });

  it('keeps executable 1-3% entries in a separate high-friction shadow cohort', async () => {
    (service as any).assessSafety = jest.fn().mockResolvedValue({
      risk: SAFE_RISK, hardReason: null, buyTaxPct: 0, sellTaxPct: 0, staticSnapshot: { passed: true }, bubblemapsSnapshot: null, holderConcentrationSnapshot: null,
    });
    liquidity.verifyEntrySnapshot.mockResolvedValueOnce({
      liquidityVerified: true, liquidityModel: 'V2', spotPriceUsd: 1,
      executableDepthUsd: 1_000, entrySlip20: 0.02, exitSlip20: 0.01,
    });
    prisma.robinhoodEntryExperiment.create.mockImplementation(({ data }: any) => ({ id: 'experiment-2', ...data }));

    await (service as any).tryCreateExperiment(tick());

    const create = prisma.robinhoodEntryExperiment.create.mock.calls[0][0].data;
    expect(create.frictionCohort).toBe('HIGH_FRICTION_SHADOW');
    expect(create.dataHealthSnapshot.frictionDetailCohort).toBe('SELL_LE_1_BUY_1_3');
    expect(create.dataHealthSnapshot).toMatchObject({
      bankrollEligible: false,
      bankrollReasons: ['high_friction_shadow'],
    });
    expect(create.arms.create.filter((arm: any) =>
      arm.armCode.startsWith('EXIT_') && arm.scenarioCode === 'OBSERVED_ENTRY',
    ).every(
      (arm: any) =>
        arm.stateJson.frictionCohort === 'HIGH_FRICTION_SHADOW' &&
        arm.stateJson.bankrollEligible === false &&
        arm.stateJson.bankrollReasons.includes('high_friction_shadow'),
    )).toBe(true);
  });

  it('requires low friction on both the immediate buy and sell routes', async () => {
    (service as any).assessSafety = jest.fn().mockResolvedValue({
      risk: SAFE_RISK, hardReason: null, buyTaxPct: 0, sellTaxPct: 0, staticSnapshot: { passed: true }, bubblemapsSnapshot: null, holderConcentrationSnapshot: null,
    });
    liquidity.verifyEntrySnapshot.mockResolvedValueOnce({
      liquidityVerified: true, liquidityModel: 'V2', spotPriceUsd: 1,
      executableDepthUsd: 1_000, entrySlip20: 0.005, exitSlip20: 0.02,
    });
    prisma.robinhoodEntryExperiment.create.mockImplementation(
      ({ data }: any) => ({ id: 'experiment-sell-friction', ...data }),
    );

    await (service as any).tryCreateExperiment(tick());

    const create = prisma.robinhoodEntryExperiment.create.mock.calls[0][0].data;
    expect(create.t0BuyImpactPct).toBe(0.005);
    expect(create.t0SellImpactPct).toBe(0.02);
    expect(create.frictionCohort).toBe('HIGH_FRICTION_SHADOW');
  });

  it('does not create a paper experiment when the immediate sell impact exceeds 3%', async () => {
    (service as any).assessSafety = jest.fn().mockResolvedValue({
      risk: SAFE_RISK, hardReason: null, buyTaxPct: 0, sellTaxPct: 0, staticSnapshot: { passed: true }, bubblemapsSnapshot: null, holderConcentrationSnapshot: null,
    });
    liquidity.verifyEntrySnapshot.mockResolvedValueOnce({
      liquidityVerified: true, liquidityModel: 'V2', spotPriceUsd: 1,
      executableDepthUsd: 1_000, entrySlip20: 0.01, exitSlip20: 0.031,
    });

    await expect((service as any).tryCreateExperiment(tick())).resolves.toBeNull();
    expect(prisma.robinhoodEntryExperiment.create).not.toHaveBeenCalled();
    expect(service.getAttemptSnapshot('watch-1')).toMatchObject({
      outcome: 'WAIT',
      reason: 'exit_slippage_over_3pct',
    });
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
      risk: SAFE_RISK, hardReason: null, buyTaxPct: 0, sellTaxPct: 0, staticSnapshot: { passed: true }, bubblemapsSnapshot: null, holderConcentrationSnapshot: null,
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

  it('marks a zero-notional immediate diagnostic arm terminal when confirmation expires', async () => {
    const update = jest.fn().mockResolvedValue({});
    (prisma as any).robinhoodExperimentArm = { update };
    const experiment = {
      arms: [{
        id: 'arm-a', armCode: 'A_IMMEDIATE_20', immediateUsd: 0,
        remainingTokens: 0, status: 'WAITING_CONFIRMATION',
      }, {
        id: 'legacy-exit', armCode: 'EXIT_C_90_10', immediateUsd: 0,
        remainingTokens: 0, status: 'WAITING_CONFIRMATION',
      }],
    };

    await (RobinhoodEntryExperimentService.prototype as any).expireUnconfirmedArms.call(
      service,
      experiment,
      tick(60_001),
    );

    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'arm-a' },
      data: expect.objectContaining({ status: 'NO_TRADE', outcomeClass: 'NO_CONFIRMATION' }),
    }));
    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'legacy-exit' },
      data: expect.objectContaining({ status: 'NO_TRADE', outcomeClass: 'NO_CONFIRMATION' }),
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
      experiment: {
        t0At: new Date(0),
        riskSnapshot: {},
        frictionCohort: 'LOW_FRICTION_PRIMARY',
      },
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

  it('allows the registered paired exit arms to receive the shared paper fill', async () => {
    const legUpdate = jest.fn().mockResolvedValue({});
    const armUpdate = jest.fn().mockResolvedValue({});
    (prisma as any).robinhoodExperimentLeg = { update: legUpdate };
    (prisma as any).robinhoodExperimentArm = { update: armUpdate };
    (prisma as any).$transaction = jest.fn((operations: Promise<unknown>[]) => Promise.all(operations));
    jest.spyOn(service as any, 'cachedQuote').mockResolvedValue({
      liquidityModel: 'V2', direction: 'BUY', sizeUsd: 20, spotPriceUsd: 1,
      slippagePct: 0.005, executable: true, observedAt: new Date(1_000),
    });
    jest.spyOn(service as any, 'logEntry').mockImplementation(() => undefined);
    const arm = {
      id: 'exit-arm', armCode: 'EXIT_A_FULL_2X', status: 'PENDING_ENTRY',
      gasMultiplier: 1, tokensBought: 0, remainingTokens: 0, committedUsd: 0,
      stateJson: {}, experiment: {
        t0At: new Date(0), configHash: ROBINHOOD_FLOW_V3_CONFIG_HASH,
        riskSnapshot: {}, frictionCohort: 'LOW_FRICTION_PRIMARY',
      },
    };
    const leg = {
      id: 'entry-leg', legType: 'IMMEDIATE_BUY', notionalUsd: 20,
      targetAt: new Date(0),
    };

    await (service as any).executeBuyLeg(arm, leg, tick(1_000), 0.01, new Map());

    expect(legUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'FILLED' }),
    }));
    expect(armUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: 'OPEN',
        stateJson: expect.objectContaining({
          frictionCohort: 'LOW_FRICTION_PRIMARY',
          benchmarkEntryEligible: true,
        }),
      }),
    }));
  });

  it('marks an unsellable terminal residual at zero instead of leaving the arm open', async () => {
    const legUpdate = jest.fn().mockResolvedValue({});
    const armUpdate = jest.fn().mockResolvedValue({});
    (prisma as any).robinhoodExperimentLeg = { update: legUpdate };
    (prisma as any).robinhoodExperimentArm = { update: armUpdate };
    (prisma as any).$transaction = jest.fn((operations: Promise<unknown>[]) => Promise.all(operations));
    jest.spyOn(service as any, 'cachedQuote').mockResolvedValue({
      liquidityModel: 'V2', direction: 'SELL', sizeUsd: 10,
      spotPriceUsd: null, slippagePct: null, executable: false,
      observedAt: new Date(60_000), error: 'route_unavailable',
    });
    const arm = {
      id: 'arm', experimentId: 'experiment', armCode: 'EXIT_A_FULL_2X',
      scenarioCode: 'OBSERVED_ENTRY', gasMultiplier: 1, status: 'OPEN',
      committedUsd: 20, realizedValueUsd: 0, tokensBought: 10, remainingTokens: 10,
      stateJson: {}, experiment: {
        configHash: ROBINHOOD_FLOW_V3_CONFIG_HASH,
        configVersion: 'robinhood_low_friction_2x_v1',
        frictionCohort: 'LOW_FRICTION_PRIMARY',
        riskSnapshot: {},
      },
    };
    const leg = {
      id: 'sell', legType: 'TIME_SELL', tokenAmount: 10, targetAt: new Date(60_000),
    };

    await (service as any).executeSellLeg(
      arm,
      leg,
      tick(60_000),
      0.1,
      new Map(),
      1,
    );

    expect(armUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: 'CLOSED',
        remainingTokens: 0,
        outcomeClass: 'UNSELLABLE',
        stateJson: expect.objectContaining({ terminalResidualMarkedZero: true }),
      }),
    }));
  });

  it('fails a delayed ladder sell when executable proceeds fall below frozen minOut', async () => {
    const legUpdate = jest.fn().mockResolvedValue({});
    const armUpdate = jest.fn().mockResolvedValue({});
    (prisma as any).robinhoodExperimentLeg = { update: legUpdate };
    (prisma as any).robinhoodExperimentArm = { update: armUpdate };
    (prisma as any).$transaction = jest.fn((operations: Promise<unknown>[]) => Promise.all(operations));
    jest.spyOn(service as any, 'cachedQuote').mockResolvedValue({
      liquidityModel: 'V2', direction: 'SELL', sizeUsd: 10,
      spotPriceUsd: 1, slippagePct: 0.1, executable: true,
      observedAt: new Date(61_000),
    });
    jest.spyOn(service as any, 'logExit').mockImplementation(() => undefined);
    const arm = {
      id: 'guarded-arm', experimentId: 'experiment', armCode: 'EXIT_A_FULL_2X',
      scenarioCode: 'OBSERVED_ENTRY', gasMultiplier: 1, status: 'OPEN',
      committedUsd: 20, realizedValueUsd: 0, tokensBought: 10, remainingTokens: 10,
      stateJson: { exitConfigHash: ROBINHOOD_EXIT_EXPERIMENT_CONFIG_HASH },
      experiment: { riskSnapshot: {} },
    };
    const leg = {
      id: 'guarded-sell', legType: 'LADDER_SELL', tokenAmount: 10,
      targetAt: new Date(60_000), failureReason: 'rung:2',
      quoteSnapshot: {
        executionGuard: {
          configHash: ROBINHOOD_EXIT_EXPERIMENT_CONFIG_HASH,
          rungMultiple: 2,
          minimumNetUsd: 10,
        },
      },
    };

    await (service as any).executeSellLeg(
      arm,
      leg,
      tick(61_000),
      0.1,
      new Map(),
      1,
    );

    expect(legUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: 'FAILED',
        failureReason: expect.stringContaining('min_out_violated'),
        netUsd: null,
      }),
    }));
    expect(armUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        committedUsd: { increment: 0.1 },
        stateJson: expect.objectContaining({
          lastMinOutFailure: expect.objectContaining({ rungMultiple: 2 }),
        }),
      }),
    }));
  });

  it('triggers later ladder rungs from executable token-price multiple, not total portfolio multiple', async () => {
    const armUpdate = jest.fn().mockResolvedValue({});
    (prisma as any).robinhoodExperimentArm = { update: armUpdate };
    jest.spyOn(service as any, 'accrueCapitalSeconds').mockResolvedValue(undefined);
    jest.spyOn(service as any, 'cachedQuote').mockResolvedValue({
      liquidityModel: 'V2', direction: 'SELL', sizeUsd: 20,
      spotPriceUsd: 11, slippagePct: 0, executable: true,
      observedAt: new Date(10_000),
    });
    const createSellLeg = jest.spyOn(service as any, 'createSellLeg').mockResolvedValue(undefined);
    const arm = {
      id: 'ladder-arm', armCode: 'EXIT_B_LADDER_80_15_5', status: 'OPEN',
      scenarioCode: 'OBSERVED_ENTRY', gasMultiplier: 1,
      committedUsd: 20, realizedValueUsd: 16, tokensBought: 10, remainingTokens: 2,
      blendedCostBasisUsd: 1, executedRungs: '2', currentMultiple: 1.9,
      peakMultiple: 1.9, maxDrawdown: 0, openedAt: new Date(0),
      stateJson: { exitConfigHash: ROBINHOOD_EXIT_EXPERIMENT_CONFIG_HASH },
      legs: [],
    };
    const experiment = {
      horizonAt: new Date(100_000),
      riskSnapshot: {},
      arms: [arm],
    };

    await (service as any).evaluateArmExits(
      experiment,
      tick(10_000),
      {
        liquidityVerified: true,
        liquidityModel: 'V2',
        spotPriceUsd: 11,
      },
    );

    expect(createSellLeg).toHaveBeenCalledWith(
      arm,
      'LADDER_SELL',
      10_000,
      1.5,
      'rung:10',
      expect.objectContaining({
        executionGuard: expect.objectContaining({
          rungMultiple: 10,
          minimumNetUsd: expect.any(Number),
        }),
      }),
    );
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
