import { ConfigService } from '@nestjs/config';
import { EvalService } from './eval.service';
import type { LiquidityCheckResult } from '../onchain/onchain.types';

const TOKEN_ADDR = '0xaaa0000000000000000000000000000000000001';
const POOL_ADDR = '0xbbb0000000000000000000000000000000000002';
const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';

function config(overrides: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    'paper.sandwichPct': 0.01,
    'paper.gasUsd': 1.5,
    'paper.ladder': [],
    'paper.liqPullDropPct': 0.6,
    'paper.rugLiqUsd': 50,
    'paper.sellTaxSpikePct': 0.5,
    'paper.maxDrawdownInvalidate': 0.7,
    'paper.priceReadFailureRugThreshold': 3,
    ...overrides,
  };
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

function openPosition(entryFeatures: Record<string, unknown> = {}) {
  return {
    id: 'pos_1',
    chain: 'ethereum',
    tokenAddress: TOKEN_ADDR,
    poolAddress: POOL_ADDR,
    symbol: 'TEST',
    firstSeenAt: new Date('2026-07-04T00:00:00.000Z'),
    entryPriceEffectiveUsd: 1,
    tokensBought: 20,
    sizeUsd: 20,
    onchainLiqEntryUsd: 10_000,
    maxMultipleObserved: 1,
    maxDrawdownObserved: 0,
    executedRungs: '',
    remainingFraction: 1,
    realizedValueUsd: 0,
    entryFeatures: { finalScore: 70, scoreConfidence: 0.5, ...entryFeatures },
    token: { decimals: 18 },
    pool: {
      poolAddress: POOL_ADDR,
      dex: 'Uniswap V2',
      token0: TOKEN_ADDR,
      token1: WETH,
      quoteAsset: 'WETH',
    },
  };
}

function unreadableLiquidity(error = 'no results found'): LiquidityCheckResult {
  return {
    liquidityModel: 'UNSUPPORTED_UNKNOWN',
    liquidityVerified: false,
    onchainTvlUsd: null,
    reportedVsOnchainPct: null,
    executableDepthUsd: null,
    slip50: null,
    slip100: null,
    slip500: null,
    slip1000: null,
    spotPriceUsd: null,
    error,
  };
}

function unreadableLiquidityWithTvl(onchainTvlUsd: number): LiquidityCheckResult {
  return {
    ...unreadableLiquidity('no price after liquidity drain'),
    liquidityModel: 'V2',
    liquidityVerified: false,
    onchainTvlUsd,
    error: 'implausible_read: slip on $50 probe = 97.2% (>50%)',
  };
}

function healthyLiquidity(): LiquidityCheckResult {
  return {
    liquidityModel: 'V2',
    liquidityVerified: true,
    onchainTvlUsd: 12_000,
    reportedVsOnchainPct: 0,
    executableDepthUsd: 1_000,
    slip50: 0.01,
    slip100: 0.02,
    slip500: 0.05,
    slip1000: 0.09,
    spotPriceUsd: 2,
  };
}

function healthyLiquidityAtPrice(spotPriceUsd: number): LiquidityCheckResult {
  return {
    ...healthyLiquidity(),
    spotPriceUsd,
  };
}

function harness(
  position: ReturnType<typeof openPosition>,
  liq: LiquidityCheckResult,
  configOverrides: Record<string, unknown> = {},
) {
  const prisma = {
    paperPosition: {
      count: jest.fn().mockResolvedValue(1),
      findMany: jest.fn().mockResolvedValue([position]),
      update: jest.fn().mockResolvedValue({}),
    },
    paperEvent: {
      create: jest.fn().mockResolvedValue({}),
    },
  };
  const fileLogger = {
    logPositionTick: jest.fn(),
    logPaperExit: jest.fn(),
  };
  const liquidityVerifier = {
    verify: jest.fn().mockResolvedValue(liq),
  };
  const riskEngine = {
    checkToken: jest.fn().mockResolvedValue({
      merged: { honeypot: false, sellTax: 0 },
    }),
  };
  const geckoTerminal = {
    getPoolTradeStats: jest.fn().mockResolvedValue(null),
  };
  const deployerReputation = {
    refreshAll: jest.fn().mockResolvedValue({ deployersUpdated: 0, rugLikeTokens: 0 }),
  };

  const service = new EvalService(
    config(configOverrides),
    prisma as any,
    fileLogger as any,
    liquidityVerifier as any,
    riskEngine as any,
    geckoTerminal as any,
    deployerReputation as any,
  );

  return { service, prisma, fileLogger };
}

describe('EvalService price-read failures', () => {
  it('keeps an OPEN paper position alive below the no-price rug threshold', async () => {
    const { service, prisma, fileLogger } = harness(
      openPosition({ priceReadFailureCount: 1 }),
      unreadableLiquidity(),
    );

    const result = await service.evaluateOpenPositions();

    expect(result.closed).toBe(0);
    expect(prisma.paperEvent.create).not.toHaveBeenCalled();
    expect(fileLogger.logPaperExit).not.toHaveBeenCalled();
    expect(prisma.paperPosition.update.mock.calls[0][0].data.status).toBeUndefined();
    expect(prisma.paperPosition.update.mock.calls[0][0].data.entryFeatures).toMatchObject({
      priceReadFailureCount: 2,
      lastPriceReadError: 'no results found',
    });
    expect(fileLogger.logPositionTick.mock.calls[0][0].status).toBe('price_unreadable_2/3');
    expect(result.rows[0].status).toBe('price_unreadable_2/3');
  });

  it('evaluates oldest OPEN positions first and reports deferred positions when capped', async () => {
    const { service, prisma } = harness(openPosition(), healthyLiquidity(), {
      'paper.evalMaxOpenPositions': 25,
    });
    prisma.paperPosition.count.mockResolvedValue(30);

    const result = await service.evaluateOpenPositions();

    expect(result.openTotal).toBe(30);
    expect(result.evaluated).toBe(1);
    expect(result.deferred).toBe(29);
    expect(prisma.paperPosition.count).toHaveBeenCalledWith({
      where: { status: 'OPEN' },
    });
    expect(prisma.paperPosition.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: 'OPEN' },
        orderBy: { openedAt: 'asc' },
        take: 25,
      }),
    );
  });

  it('closes as RUG once no-price repeats at the threshold', async () => {
    const { service, prisma, fileLogger } = harness(
      openPosition({ priceReadFailureCount: 2 }),
      unreadableLiquidity(),
    );

    const result = await service.evaluateOpenPositions();

    expect(result.closed).toBe(1);
    expect(prisma.paperEvent.create).toHaveBeenCalledTimes(1);
    expect(prisma.paperPosition.update.mock.calls[0][0].data).toMatchObject({
      status: 'CLOSED',
      outcomeClass: 'RUG',
      remainingFraction: 0,
    });
    expect(prisma.paperPosition.update.mock.calls[0][0].data.entryFeatures).toMatchObject({
      priceReadFailureCount: 3,
      lastPriceReadError: 'no results found',
    });
    expect(fileLogger.logPaperExit.mock.calls[0][0]).toMatchObject({
      status: 'rug',
      outcome_class: 'RUG',
    });
    expect(fileLogger.logPaperExit.mock.calls[0][0].note).toContain('price_unreadable_3x');
    expect(result.rows[0].status).toBe('closed:RUG');
  });

  it('closes immediately when liquidity is already gone even if price is unreadable', async () => {
    const { service, prisma, fileLogger } = harness(
      openPosition({ priceReadFailureCount: 0 }),
      unreadableLiquidityWithTvl(2),
    );

    const result = await service.evaluateOpenPositions();

    expect(result.closed).toBe(1);
    expect(prisma.paperPosition.update.mock.calls[0][0].data).toMatchObject({
      status: 'CLOSED',
      outcomeClass: 'RUG',
      remainingFraction: 0,
    });
    expect(fileLogger.logPaperExit.mock.calls[0][0]).toMatchObject({
      status: 'rug',
      outcome_class: 'RUG',
    });
  });

  it('resets the no-price counter when price data recovers', async () => {
    const { service, prisma, fileLogger } = harness(
      openPosition({ priceReadFailureCount: 2, lastPriceReadError: 'no results found' }),
      healthyLiquidity(),
    );

    const result = await service.evaluateOpenPositions();

    expect(result.closed).toBe(0);
    expect(prisma.paperEvent.create).not.toHaveBeenCalled();
    expect(prisma.paperPosition.update.mock.calls[0][0].data.entryFeatures).toMatchObject({
      priceReadFailureCount: 0,
    });
    expect(prisma.paperPosition.update.mock.calls[0][0].data.entryFeatures.lastPriceReadError).toBeUndefined();
    expect(fileLogger.logPositionTick.mock.calls[0][0].status).toBe('alive');
    expect(result.rows[0].status).toBe('alive');
  });

  it('sells 80% at 2x and keeps the gem tail open', async () => {
    const { service, prisma, fileLogger } = harness(
      openPosition(),
      healthyLiquidityAtPrice(2),
      {
        'paper.ladder': [
          { multiple: 2, sellFraction: 0.8 },
          { multiple: 10, sellFraction: 0.15 },
          { multiple: 1000, sellFraction: 0.05 },
        ],
      },
    );

    const result = await service.evaluateOpenPositions();

    expect(result.closed).toBe(0);
    expect(fileLogger.logPaperExit).toHaveBeenCalledTimes(1);
    const update = prisma.paperPosition.update.mock.calls[0][0].data;
    expect(update.remainingFraction).toBeCloseTo(0.2, 10);
    expect(update.executedRungs).toBe('2');
    expect(result.rows[0].status).toBe('alive');
  });

  it('closes only when the final 1000x ladder rung is sold', async () => {
    const { service, prisma, fileLogger } = harness(
      openPosition(),
      healthyLiquidityAtPrice(1000),
      {
        'paper.ladder': [
          { multiple: 2, sellFraction: 0.8 },
          { multiple: 10, sellFraction: 0.15 },
          { multiple: 1000, sellFraction: 0.05 },
        ],
      },
    );

    const result = await service.evaluateOpenPositions();

    expect(result.closed).toBe(1);
    expect(fileLogger.logPaperExit).toHaveBeenCalledTimes(3);
    expect(prisma.paperPosition.update.mock.calls[0][0].data).toMatchObject({
      status: 'CLOSED',
      remainingFraction: 0,
      outcomeClass: 'WIN',
      executedRungs: '2,10,1000',
    });
    expect(result.rows[0].status).toBe('closed:WIN');
  });
});

describe('EvalService scheduling', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('does not schedule background eval when autostart is disabled', () => {
    const { service } = harness(openPosition(), healthyLiquidity(), {
      'paper.evalAutostart': false,
    });
    const runSpy = jest.spyOn(service as any, 'runScheduledEval');

    service.onModuleInit();
    jest.advanceTimersByTime(10 * 60_000);

    expect(runSpy).not.toHaveBeenCalled();
    service.onModuleDestroy();
  });

  it('schedules background eval when autostart is enabled', () => {
    const { service } = harness(openPosition(), healthyLiquidity(), {
      'paper.evalAutostart': true,
      'paper.evalInitialDelayMs': 1_000,
      'paper.evalIntervalMs': 60_000,
    });
    const runSpy = jest
      .spyOn(service as any, 'runScheduledEval')
      .mockResolvedValue(undefined);

    service.onModuleInit();
    jest.advanceTimersByTime(999);
    expect(runSpy).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);
    expect(runSpy).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(60_000);
    expect(runSpy).toHaveBeenCalledTimes(2);
    service.onModuleDestroy();
  });
});
