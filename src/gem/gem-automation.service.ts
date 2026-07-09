import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ShadowTrackerService } from './shadow-tracker.service';

/** Runs the observation-only forward tracker independently from the collector loop. */
@Injectable()
export class GemAutomationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GemAutomationService.name);
  private initialTimer: ReturnType<typeof setTimeout> | null = null;
  private intervalTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly config: ConfigService,
    private readonly shadowTracker: ShadowTrackerService,
  ) {}

  onModuleInit(): void {
    const enabled = this.config.get<boolean>('gem.shadowAutostart') ?? true;
    if (!enabled) {
      this.logger.log('Gem shadow automation disabled');
      return;
    }

    const intervalMs = Math.max(60_000, this.config.get<number>('gem.shadowIntervalMs') ?? 300_000);
    const initialDelayMs = Math.max(0, this.config.get<number>('gem.shadowInitialDelayMs') ?? 180_000);
    this.initialTimer = setTimeout(() => void this.runScheduledTrack(), initialDelayMs);
    this.intervalTimer = setInterval(() => void this.runScheduledTrack(), intervalMs);
    this.logger.log(`Gem shadow automation scheduled - interval: ${intervalMs}ms, initial delay: ${initialDelayMs}ms`);
  }

  onModuleDestroy(): void {
    if (this.initialTimer) clearTimeout(this.initialTimer);
    if (this.intervalTimer) clearInterval(this.intervalTimer);
    this.initialTimer = null;
    this.intervalTimer = null;
  }

  private async runScheduledTrack(): Promise<void> {
    if (this.running) {
      this.logger.warn('Gem shadow track already in progress - skipping scheduled tick');
      return;
    }
    this.running = true;
    try {
      const result = await this.shadowTracker.track();
      this.logger.log(
        `Gem shadow tick done: candidates=${result.candidates}, captured=${result.captured}, missed=${result.missed}`,
      );
    } catch (err) {
      this.logger.error(`Gem shadow tick failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
