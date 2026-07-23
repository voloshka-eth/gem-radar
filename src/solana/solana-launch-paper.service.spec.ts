import { ConfigService } from '@nestjs/config';
import { SolanaLaunchPaperService } from './solana-launch-paper.service';

const launch = {
  mint: 'GA2MNPqEDoMPsM3VFs6z9UkKqzUcSvV1PjLFwpfxbonk',
  poolId: '6HcEqtRBzRpdfkoKKHx289cVBMu3v4MdJPbEaA16sUyG',
  createAt: Date.now(),
  decimals: 6,
  supply: 1_000_000_000,
  marketCap: 10_000,
  finishingRate: 0,
  mintB: { address: 'So11111111111111111111111111111111111111112' },
};

function createService() {
  const config = {
    get: jest.fn((key: string) => ({
      'solanaLaunch.launchApiUrl': 'https://launch.example',
      'solanaLaunch.tradeApiUrl': 'https://trade.example',
      'solanaLaunch.routeProbeFinishingRate': 0.95,
      'solanaLaunch.routeReadyProbeIntervalMs': 15_000,
      'solanaLaunch.routeFallbackProbeIntervalMs': 60_000,
      'solanaLaunch.maxRouteProbesPerPoll': 10,
      'solanaLaunch.mintRefreshIntervalMs': 30_000,
      'solanaLaunch.mintRefreshBatchSize': 50,
    } as Record<string, unknown>)[key]),
  } as unknown as ConfigService;
  const positions = {
    findMany: jest.fn(),
    update: jest.fn().mockResolvedValue({}),
  };
  const prisma = { solanaLaunchPosition: positions };
  const service = new SolanaLaunchPaperService(config, prisma as any, {} as any);
  return { service, positions };
}

describe('SolanaLaunchPaperService resilience', () => {
  it('continues expiry and position evaluation when discovery fails', async () => {
    const { service } = createService();
    jest.spyOn(service as any, 'fetchLaunches').mockRejectedValue(new Error('launch API offline'));
    jest.spyOn(service as any, 'refreshWatchingMints').mockResolvedValue(undefined);
    const expire = jest.spyOn(service as any, 'expireWatches').mockResolvedValue(undefined);
    const watching = jest.spyOn(service as any, 'evaluateWatching').mockResolvedValue(undefined);
    const open = jest.spyOn(service as any, 'evaluateOpenPositions').mockResolvedValue(undefined);

    await (service as any).poll();

    expect(expire).toHaveBeenCalled();
    expect(watching).toHaveBeenCalled();
    expect(open).toHaveBeenCalled();
  });

  it('refreshes active launch snapshots through the per-mint endpoint', async () => {
    const { service, positions } = createService();
    positions.findMany.mockResolvedValue([{ id: 'position-1', mintAddress: launch.mint }]);
    jest.spyOn((service as any).http, 'get').mockResolvedValue({
      status: 200,
      data: { success: true, data: { rows: [{ ...launch, finishingRate: 0.97 }] } },
    });

    await (service as any).refreshWatchingMints();

    expect((service as any).http.get).toHaveBeenCalledWith(
      'https://launch.example/get/by/mints',
      { params: { ids: launch.mint } },
    );
    expect(positions.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'position-1' },
      data: expect.objectContaining({
        latestLaunchSnapshot: expect.objectContaining({ finishingRate: 0.97 }),
      }),
    }));
  });

  it('fallback-probes a route even when finishingRate remains zero', async () => {
    const { service, positions } = createService();
    const position = {
      id: 'position-1',
      mintAddress: launch.mint,
      latestLaunchSnapshot: launch,
      lastRouteProbeAt: null,
    };
    positions.findMany.mockResolvedValue([position]);
    const tryOpen = jest.spyOn(service as any, 'tryOpen').mockResolvedValue(undefined);

    await (service as any).evaluateWatching();

    expect(positions.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'position-1' },
      data: expect.objectContaining({ routeProbeAttempts: { increment: 1 } }),
    }));
    expect(tryOpen).toHaveBeenCalledWith(position, launch);
  });
});
