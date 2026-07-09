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
      create: jest.fn(),
    },
    paperEvent: {
      create: jest.fn(),
    },
  };
  const fileLoggerMock = {
    logPaperEntry: jest.fn(),
  };
  const gemScreenMock = {
    screenPosition: jest.fn(),
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
    const service = new PaperService(config, prismaMock as any, fileLoggerMock as any, gemScreenMock as any);

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
    const service = new PaperService(config, prismaMock as any, fileLoggerMock as any, gemScreenMock as any);
    gemScreenMock.screenPosition.mockRejectedValueOnce(new Error('temporary RPC failure'));

    await expect(service.recordEntry(buildCandidate())).resolves.toBeUndefined();

    expect(prismaMock.paperPosition.create).toHaveBeenCalledTimes(1);
    expect(fileLoggerMock.logPaperEntry).toHaveBeenCalledTimes(1);
  });

});
