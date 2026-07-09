import { ConfigService } from '@nestjs/config';
import { GemScreenService } from './gem-screen.service';

const position = {
  chain: 'base' as const,
  tokenAddress: '0xaaa0000000000000000000000000000000000001',
  poolAddress: '0xbbb0000000000000000000000000000000000002',
  symbol: 'GEM',
  liquidityModel: 'V2',
  deployerAddress: '0xccc0000000000000000000000000000000000003',
  firstSeenAt: new Date('2026-07-09T12:00:00.000Z'),
  entryFdvUsd: 20_000,
  entryPriceUsd: 0.01,
  entryLiquidityUsd: 30_000,
};

describe('GemScreenService.screenPosition', () => {
  const prisma = { gemCandidate: { upsert: jest.fn() } };
  const lpLock = { detect: jest.fn() };
  const config = {
    get: jest.fn((key: string) => ({
      'gem.minEntryFdvUsd': 1_000,
      'gem.maxEntryFdvUsd': 50_000,
    })[key]),
  } as unknown as ConfigService;

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.gemCandidate.upsert.mockResolvedValue({});
  });

  it('persists a locked, in-range paper position immediately', async () => {
    lpLock.detect.mockResolvedValue({ lockedOrBurned: true, fraction: 0.95, source: 'burn' });
    const service = new GemScreenService(config, prisma as any, lpLock as any);

    await expect(service.screenPosition(position)).resolves.toMatchObject({
      passed: true,
      candidate: { symbol: 'GEM', entryFdvUsd: 20_000, lpSource: 'burn' },
    });
    expect(prisma.gemCandidate.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        t0Ts: position.firstSeenAt,
        entryPriceUsd: position.entryPriceUsd,
      }),
    }));
  });

  it('does not spend an LP read outside the configured FDV range', async () => {
    const service = new GemScreenService(config, prisma as any, lpLock as any);

    await expect(service.screenPosition({ ...position, entryFdvUsd: 99_999 })).resolves.toEqual({
      passed: false,
      reason: 'fdv_too_high_no_headroom',
    });
    expect(lpLock.detect).not.toHaveBeenCalled();
    expect(prisma.gemCandidate.upsert).not.toHaveBeenCalled();
  });
});
