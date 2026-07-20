import { ConfigService } from '@nestjs/config';
import { FourMemeSourceService } from './four-meme-source.service';
import { LaunchSniperService } from './launch-sniper.service';
import { SniperJournalService } from './sniper-journal.service';
import {
  EntryTriggerConfig,
  FourMemeEvent,
  PaperSniperConfig,
  SniperAddress,
} from './sniper.types';

describe('LaunchSniperService', () => {
  const token = '0x1111111111111111111111111111111111111111' as SniperAddress;
  const creator = '0x2222222222222222222222222222222222222222' as SniperAddress;
  const trigger: EntryTriggerConfig = {
    windowMs: 300_000,
    minAgeSec: 2,
    minBlocksAfterLaunch: 6,
    maxAgeSec: 300,
    minBuys: 3,
    minUniqueBuyers: 3,
    minBuyQuote: 0.1,
    minBuySellRatio: 2,
    maxLargestBuyerShare: 0.65,
    minPriceMomentum: 1.02,
  };
  const paper: PaperSniperConfig = {
    positionSizeQuote: 0.02,
    protocolFeePct: 0.01,
    entrySlippagePct: 0.02,
    exitSlippagePct: 0.03,
    stopMultiple: 0.8,
    timeExitMs: 3_600_000,
    momentumWindowMs: 30_000,
    momentumExitRatio: 0.7,
    momentumConfirmations: 2,
    ladder: [
      { multiple: 2, sellFraction: 0.8 },
      { multiple: 5, sellFraction: 0.15 },
      { multiple: 100, sellFraction: 0.05 },
    ],
  };

  it('opens one paper position from official launch plus qualifying early flow', async () => {
    const now = Date.now();
    const events: FourMemeEvent[] = [
      {
        kind: 'LAUNCH_CREATED', id: 'launch', blockNumber: '1', occurredAtMs: now - 5_000,
        token, creator, name: 'Test', symbol: 'TEST', totalSupply: 1_000_000_000,
      },
      buy('buy1', '7', address(3), now - 3_000, 0.04, 1),
      buy('buy2', '8', address(4), now - 2_000, 0.04, 1.02),
      buy('buy3', '9', address(5), now - 1_000, 0.04, 1.05),
    ];
    const append = jest.fn();
    const source = {
      poll: jest.fn().mockResolvedValueOnce({ events, cursor: '1' }).mockResolvedValue({ events, cursor: '1' }),
      readSafety: jest.fn().mockResolvedValue({
        ok: true, retryable: false, reasons: [], initialized: true, tradeEnabled: true,
        liquidityAdded: false, tradingHalt: false, codePresent: true,
      }),
      isConfigured: () => true,
    };
    const journal = { append, readState: () => null, writeState: jest.fn(), ensureProcessLock: jest.fn() };
    const service = new LaunchSniperService(
      configService('paper'),
      source as unknown as FourMemeSourceService,
      journal as unknown as SniperJournalService,
    );

    await service.runOnce();
    await service.runOnce();

    expect(source.readSafety).toHaveBeenCalledTimes(1);
    expect(append.mock.calls.map(([record]) => record.type)).toContain('ENTER');
    expect(append.mock.calls.map(([record]) => record.type)).toContain('WATCHER_HEARTBEAT');
    expect(append.mock.calls.filter(([record]) => record.type === 'ENTER')).toHaveLength(1);
  });

  it('refuses any runtime mode other than paper', () => {
    const source = { isConfigured: () => true };
    const journal = {
      append: jest.fn(), readState: () => null, writeState: jest.fn(), ensureProcessLock: jest.fn(),
    };
    const service = new LaunchSniperService(
      configService('live'),
      source as unknown as FourMemeSourceService,
      journal as unknown as SniperJournalService,
    );

    expect(() => service.onModuleInit()).toThrow('only paper is implemented');
  });

  it('backs off after a provider rate-limit response', async () => {
    const source = {
      poll: jest.fn().mockRejectedValue(new Error('too many requests')),
      isConfigured: () => true,
    };
    const append = jest.fn();
    const journal = { append, readState: () => null, writeState: jest.fn(), ensureProcessLock: jest.fn() };
    const service = new LaunchSniperService(
      configService('paper'),
      source as unknown as FourMemeSourceService,
      journal as unknown as SniperJournalService,
    );

    await service.runOnce();
    await service.runOnce();

    expect(source.poll).toHaveBeenCalledTimes(1);
    expect(append).toHaveBeenCalledWith(expect.objectContaining({
      type: 'POLL_ERROR',
      rateLimited: true,
      backoffMs: 60_000,
    }));
  });

  function configService(mode: string): ConfigService {
    const values: Record<string, unknown> = {
      'launchSniper.enabled': true,
      'launchSniper.mode': mode,
      'launchSniper.pollIntervalMs': 2_000,
      'launchSniper.pollErrorBackoffMs': 10_000,
      'launchSniper.rateLimitBackoffMs': 60_000,
      'launchSniper.maxPollBackoffMs': 300_000,
      'launchSniper.maxTrackedLaunches': 2_000,
      'launchSniper.heartbeatIntervalMs': 30_000,
      'launchSniper.trigger': trigger,
      'launchSniper.paper': paper,
      'launchSniper.blockedCreators': [],
    };
    return { get: <T>(key: string): T | undefined => values[key] as T | undefined } as ConfigService;
  }

  function buy(
    id: string,
    blockNumber: string,
    account: SniperAddress,
    occurredAtMs: number,
    quoteAmount: number,
    price: number,
  ): FourMemeEvent {
    return {
      kind: 'BUY', id, blockNumber, occurredAtMs, token, account,
      tokenAmount: quoteAmount / price, quoteAmount, priceQuotePerToken: price,
    };
  }

  function address(value: number): SniperAddress {
    return `0x${value.toString(16).padStart(40, '0')}` as SniperAddress;
  }
});
