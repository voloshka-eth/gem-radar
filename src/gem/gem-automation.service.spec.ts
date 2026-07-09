import { ConfigService } from '@nestjs/config';
import { GemAutomationService } from './gem-automation.service';

describe('GemAutomationService', () => {
  const tracker = { track: jest.fn() };

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    tracker.track.mockResolvedValue({ candidates: 0, captured: 0, missed: 0 });
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('does not schedule when disabled', () => {
    const config = { get: (key: string) => key === 'gem.shadowAutostart' ? false : undefined } as ConfigService;
    const service = new GemAutomationService(config, tracker as any);

    service.onModuleInit();
    jest.advanceTimersByTime(10 * 60_000);

    expect(tracker.track).not.toHaveBeenCalled();
    service.onModuleDestroy();
  });

  it('tracks at the initial delay and configured interval', () => {
    const config = {
      get: (key: string) => ({
        'gem.shadowAutostart': true,
        'gem.shadowInitialDelayMs': 1_000,
        'gem.shadowIntervalMs': 60_000,
      })[key],
    } as ConfigService;
    const service = new GemAutomationService(config, tracker as any);
    const runSpy = jest.spyOn(service as any, 'runScheduledTrack').mockResolvedValue(undefined);

    service.onModuleInit();
    jest.advanceTimersByTime(1_000);
    expect(runSpy).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(60_000);
    expect(runSpy).toHaveBeenCalledTimes(2);
    service.onModuleDestroy();
  });
});
