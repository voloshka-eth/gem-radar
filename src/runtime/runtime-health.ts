import { monitorEventLoopDelay } from 'perf_hooks';

/** Small process-level telemetry with no network, DB, or strategy dependency. */
export class RuntimeHealthTracker {
  private readonly eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
  private started = false;

  start(): void {
    if (this.started) return;
    this.started = true;
    this.eventLoopDelay.enable();
  }

  stop(): void {
    if (!this.started) return;
    this.eventLoopDelay.disable();
    this.started = false;
  }

  summary(): string {
    const memory = process.memoryUsage();
    const delayMs = this.started && Number.isFinite(this.eventLoopDelay.percentile(95))
      ? Math.round(this.eventLoopDelay.percentile(95) / 1_000_000)
      : 0;
    this.eventLoopDelay.reset();
    return `rssMiB=${toMiB(memory.rss)} heapMiB=${toMiB(memory.heapUsed)}/${toMiB(memory.heapTotal)} elP95Ms=${delayMs}`;
  }
}

function toMiB(bytes: number): number {
  return Math.round((bytes / 1024 / 1024) * 10) / 10;
}
