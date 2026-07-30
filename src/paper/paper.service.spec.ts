import { ConfigService } from '@nestjs/config';
import { PaperService } from './paper.service';
import type { CandidateResult } from './paper.types';

function buildCandidate(): CandidateResult {
  return {
    runId: 'run-1',
    tokenId: 'token-id',
    poolId: 'pool-id',
    ageDays: 0.1,
    buyTax: 0,
    token: {
      chain: 'ethereum',
      tokenAddress: '0xtoken',
      symbol: 'GEM',
      name: 'Gem Token',
      source: 'test',
    },
    pool: {
      chain: 'ethereum',
      poolAddress: '0xpool',
      dex: 'uniswap_v2',
      token0Address: '0xtoken',
      token1Address: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
      quoteAsset: 'WETH',
      quoteAssetAddress: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
      priceUsd: 0.001,
      liquidityUsd: 50_000,
      fdvUsd: 100_000,
      poolCreatedAt: new Date('2026-07-09T10:00:00.000Z'),
      source: 'test',
    },
    liq: {
      liquidityModel: 'V2',
      liquidityVerified: true,
      onchainTvlUsd: 50_000,
      reportedVsOnchainPct: 0,
      executableDepthUsd: 1_000,
      slip50: 0,
      slip100: 0,
      slip500: 0.01,
      slip1000: 0.02,
      spotPriceUsd: 0.001,
    },
    score: {
      finalScore: 75,
      liquidityScore: 80,
      depthScore: 80,
      ageScore: 80,
      tractionScore: 80,
      divergenceScore: 80,
      deployerReputationScore: null,
      componentsPresent: ['liquidity', 'depth', 'age', 'traction', 'divergence'],
      componentsMissing: ['deployer_reputation', 'holder_concentration', 'wash_trade', 'smart_wallet', 'unique_buyers'],
      scoreConfidence: 0.5,
      band: 'candidate',
    },
  };
}

describe('PaperService', () => {
  const prismaMock = {
    paperPosition: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    paperEvent: {
      create: jest.fn(),
    },
  };
  const fileLoggerMock = {
    logPaperEntry: jest.fn(),
    logTakeCohortDecision: jest.fn(),
  };
  const gemScreenMock = {
    screenPosition: jest.fn(),
  };
  const liquidityVerifierMock = {
    verify: jest.fn(),
  };

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-09T12:00:00.000Z'));
    jest.clearAllMocks();
    prismaMock.paperPosition.findFirst.mockResolvedValue(null);
    prismaMock.paperPosition.create.mockResolvedValue({ id: 'paper-position-id' });
    prismaMock.paperEvent.create.mockResolvedValue({});
    gemScreenMock.screenPosition.mockResolvedValue({ passed: false, reason: 'lp_not_locked:none' });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('defaults candidate entries to immediate paper fills when no detection delay is configured', async () => {
    const config = { get: jest.fn(() => undefined) } as unknown as ConfigService;
    const service = new PaperService(config, prismaMock as any, fileLoggerMock as any, gemScreenMock as any, liquidityVerifierMock as any);

    await service.recordEntry(buildCandidate());

    const data = prismaMock.paperPosition.create.mock.calls[0][0].data;
    expect(data.detectionDelaySec).toBe(0);
    expect(data.openedAt.toISOString()).toBe('2026-07-09T12:00:00.000Z');
    expect(data.openedAt.getTime()).toBe(data.firstSeenAt.getTime());
    expect(fileLoggerMock.logPaperEntry.mock.calls[0][0].detection_delay_sec).toBe('0');
    expect(data.entryFeatures).toMatchObject({ riskCohort: 'CONTRACT_SAFE' });
    expect(gemScreenMock.screenPosition).toHaveBeenCalledWith(expect.objectContaining({
      chain: 'ethereum',
      tokenAddress: '0xtoken',
      entryFdvUsd: 100_000,
      entryPriceUsd: expect.any(Number),
    }));
  });

  it('keeps the paper entry when the optional gem screen fails', async () => {
    const config = { get: jest.fn(() => undefined) } as unknown as ConfigService;
    const service = new PaperService(config, prismaMock as any, fileLoggerMock as any, gemScreenMock as any, liquidityVerifierMock as any);
    gemScreenMock.screenPosition.mockRejectedValueOnce(new Error('temporary RPC failure'));

    await expect(service.recordEntry(buildCandidate())).resolves.toBeUndefined();

    expect(prismaMock.paperPosition.create).toHaveBeenCalledTimes(1);
    expect(fileLoggerMock.logPaperEntry).toHaveBeenCalledTimes(1);
  });

  it('keeps one paper position per chain and token across strategy signals', async () => {
    const config = {
      get: jest.fn((key: string) => key === 'paper.takeCohortEnabled' ? true : undefined),
    } as unknown as ConfigService;
    const service = new PaperService(config, prismaMock as any, fileLoggerMock as any, gemScreenMock as any, liquidityVerifierMock as any);
    const early = {
      ...buildCandidate(), strategyVersion: 'fresh_early_v1', signalId: 'signal-early',
      flowSnapshot: { uniqueBuyers: 2, buyQuoteUsd: 120, buySellRatio: 2, priceMomentum: 1.01 },
    };
    const confirmed = {
      ...buildCandidate(), strategyVersion: 'fresh_confirmed_v1', signalId: 'signal-confirmed',
      flowSnapshot: { uniqueBuyers: 4, buyQuoteUsd: 600, buySellRatio: 3, priceMomentum: 1.05 },
    };

    prismaMock.paperPosition.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'existing-token-position' });

    await service.recordEntry(early);
    await service.recordEntry(confirmed);

    expect(prismaMock.paperPosition.findFirst.mock.calls.map((call) => call[0].where)).toEqual([
      { chain: 'ethereum', tokenAddress: '0xtoken' },
      { chain: 'ethereum', tokenAddress: '0xtoken' },
    ]);
    expect(prismaMock.paperPosition.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.paperPosition.create.mock.calls[0][0].data).toMatchObject({
      strategyVersion: 'fresh_early_v1', signalId: 'signal-early', status: 'OPEN',
    });
  });

  it('keeps the v1 control on the historical $50 slip bucket and uses exact $20 only for v2', async () => {
    const config = { get: jest.fn(() => undefined) } as unknown as ConfigService;
    const service = new PaperService(config, prismaMock as any, fileLoggerMock as any, gemScreenMock as any, liquidityVerifierMock as any);
    const base = buildCandidate();
    base.liq = { ...base.liq, slip20: 0.01, entrySlip20: 0.01, slip50: 0.1 };

    await service.recordEntry({ ...base, strategyVersion: 'fresh_early_v1', signalId: 'control' });
    await service.recordEntry({ ...base, strategyVersion: 'evm_flow_precision_v2', signalId: 'v2' });
    await service.recordEntry({ ...base, strategyVersion: 'robinhood_stages_v2_primary', signalId: 'rh-v2' });

    expect(prismaMock.paperPosition.create.mock.calls[0][0].data.modeledSlippagePct).toBe(0.1);
    expect(prismaMock.paperPosition.create.mock.calls[1][0].data.modeledSlippagePct).toBe(0.01);
    expect(prismaMock.paperPosition.create.mock.calls[2][0].data.modeledSlippagePct).toBe(0.01);
  });

  it('queues Base/Ethereum candidates instead of treating discovery as a buy', async () => {
    const config = {
      get: jest.fn((key: string) => key === 'paper.takeCohortEnabled' ? true : undefined),
    } as unknown as ConfigService;
    const service = new PaperService(config, prismaMock as any, fileLoggerMock as any, gemScreenMock as any, liquidityVerifierMock as any);

    await service.recordEntry(buildCandidate());

    expect(prismaMock.paperPosition.create.mock.calls[0][0].data).toMatchObject({
      status: 'PENDING_CONFIRMATION',
      detectionDelaySec: 600,
      entryFeatures: expect.objectContaining({ takeCohort: 'PENDING_CONFIRMATION' }),
    });
    expect(fileLoggerMock.logPaperEntry).not.toHaveBeenCalled();
    expect(fileLoggerMock.logTakeCohortDecision).toHaveBeenCalledWith(expect.objectContaining({
      decision: 'PENDING', reason: 'awaiting_confirmation',
    }));
  });

  it('opens a pending position only after its confirmation snapshot passes', async () => {
    const now = new Date('2026-07-09T12:00:00.000Z');
    const position = {
      id: 'pending-1', runId: 'run-1', chain: 'ethereum', tokenAddress: '0xtoken', poolAddress: '0xpool', symbol: 'GEM',
      liquidityModel: 'V2', firstSeenAt: new Date('2026-07-09T11:45:00.000Z'),
      entryFeatures: {
        takeCohort: 'PENDING_CONFIRMATION', confirmationDueAt: new Date('2026-07-09T11:55:00.000Z').toISOString(),
        t0SpotPriceUsd: 0.001, t0ExecutableDepthUsd: 1_000, t0OnchainTvlUsd: 50_000, t0BuyTaxPct: 0,
        liquidityModel: 'V2', finalScore: 75, band: 'candidate', scoreConfidence: 0.5,
      },
      token: { decimals: 18 },
      pool: { poolAddress: '0xpool', dex: 'uniswap_v2', token0: '0xtoken', token1: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', quoteAsset: 'WETH' },
    };
    prismaMock.paperPosition.findMany.mockResolvedValue([position]);
    prismaMock.paperPosition.update.mockResolvedValue({});
    liquidityVerifierMock.verify.mockResolvedValue({ ...buildCandidate().liq, spotPriceUsd: 0.0011, onchainTvlUsd: 45_000 });
    const config = {
      get: jest.fn((key: string) => key === 'paper.takeCohortEnabled' ? true : undefined),
    } as unknown as ConfigService;
    const service = new PaperService(config, prismaMock as any, fileLoggerMock as any, gemScreenMock as any, liquidityVerifierMock as any);

    await expect(service.processPendingConfirmations()).resolves.toEqual({ confirmed: 1, rejected: 0, deferred: 0 });

    expect(prismaMock.paperPosition.update.mock.calls[0][0].data).toMatchObject({ status: 'OPEN', openedAt: now });
    expect(prismaMock.paperEvent.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ type: 'BUY' }) }));
    expect(fileLoggerMock.logPaperEntry).toHaveBeenCalledWith(expect.objectContaining({ entered: 'true' }));
  });

  it('keeps a pending position pending when the confirmation read is unavailable', async () => {
    prismaMock.paperPosition.findMany.mockResolvedValue([{
      id: 'pending-1', runId: 'run-1', chain: 'ethereum', tokenAddress: '0xtoken', poolAddress: '0xpool', symbol: 'GEM',
      liquidityModel: 'V2', firstSeenAt: new Date('2026-07-09T11:45:00.000Z'),
      entryFeatures: { confirmationDueAt: new Date('2026-07-09T11:55:00.000Z').toISOString() },
      token: { decimals: 18 },
      pool: { poolAddress: '0xpool', dex: 'uniswap_v2', token0: '0xtoken', token1: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', quoteAsset: 'WETH' },
    }]);
    liquidityVerifierMock.verify.mockRejectedValueOnce(new Error('RPC unavailable'));
    const config = { get: jest.fn((key: string) => key === 'paper.takeCohortEnabled' ? true : undefined) } as unknown as ConfigService;
    const service = new PaperService(config, prismaMock as any, fileLoggerMock as any, gemScreenMock as any, liquidityVerifierMock as any);

    await expect(service.processPendingConfirmations()).resolves.toEqual({ confirmed: 0, rejected: 0, deferred: 1 });

    expect(prismaMock.paperPosition.update).not.toHaveBeenCalled();
    expect(fileLoggerMock.logTakeCohortDecision).toHaveBeenCalledWith(expect.objectContaining({
      decision: 'DEFERRED', reason: 'confirmation_read_unavailable',
    }));
  });

});
