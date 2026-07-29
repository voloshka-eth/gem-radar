import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PublicKey } from '@solana/web3.js';
import { PrismaService } from '../database/prisma.service';
import { CSV_SCHEMA_VERSION } from '../file-logger/csv-schemas';
import { FileLoggerService } from '../file-logger/file-logger.service';
import {
  SOLANA_EXPERIMENT_ARMS,
  SOLANA_FLOW_V2_CONFIG,
  SOLANA_FLOW_V2_CONFIG_HASH,
  SOLANA_MULTI_LAUNCH_STRATEGY,
  SolanaFlowTrade,
  SolanaVenue,
  classifySolanaExecution,
  computeSolanaFlowSnapshot,
  evaluateSolanaConfirmation,
} from './solana-flow-v2';
import { SolanaProtocolQuoteService, SolanaRoundTripQuote } from './solana-protocol-quote.service';
import {
  SolanaDecodedTrade,
  SolanaLaunchEvent,
  decodeSolanaVenueTransaction,
  isPotentialLaunchLog,
  solanaProgramDescriptors,
} from './solana-venue-adapters';

type AnyRow = Record<string, any>;
type QueueMeta = {
  slot: number;
  source: 'STREAM' | 'BACKFILL';
  priority: 'P1' | 'P2' | 'P3';
  queuedAtMs: number;
  cursorProgramIds: Set<string>;
  watchIds: Set<string>;
  attempts: number;
};

type StreamState = {
  programId: string;
  venue: string;
  subscriptionId: number | null;
  lastEventAtMs: number;
  lastEventSlot: number;
  reconnectAttempts: number;
  /** Epoch ms when the next reconnect attempt is allowed; 0 = live subscription in place. */
  reconnectAt: number;
  /** True after a staleness disconnect until a full backfill catch-up succeeds. */
  awaitingCatchUp: boolean;
};

type SellOptions = {
  /** When the exit should have happened (horizon, confirmation deadline). Defaults to now. */
  targetAt?: Date;
  /** Explicit data-health reason forcing the execution to be recorded as degraded. */
  degradedReason?: string | null;
};

@Injectable()
export class SolanaMultiLaunchService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SolanaMultiLaunchService.name);
  private readonly streamStates = new Map<string, StreamState>();
  private readonly poolSubscriptions = new Map<string, { subscriptionId: number; poolAddress: string }>();
  private readonly admissionsInFlight = new Set<string>();
  private readonly pendingAdmissions = new Set<string>();
  private readonly queued = new Map<string, QueueMeta>();
  private readonly p0ExitQueue = new Map<string, number>();
  private draining = false;
  private p0Draining = false;
  private backfillBusy = false;
  private lifecycleBusy = false;
  private confirmationSweepBusy = false;
  private rpcBackoffUntil = 0;
  private rpcRateLimitStrikes = 0;
  private lastRateLimitAt = 0;
  private latestHeadSlot = 0;
  private slotSubscription: number | null = null;
  private backfillTimer: ReturnType<typeof setInterval> | null = null;
  private lifecycleTimer: ReturnType<typeof setInterval> | null = null;
  private armFallbackTimer: ReturnType<typeof setInterval> | null = null;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private confirmationTimer: ReturnType<typeof setInterval> | null = null;
  private armEvaluationBusy = false;
  private discovered = 0;
  private swaps = 0;
  private signals = 0;
  private confirmations = 0;
  private queueWaitTotalMs = 0;
  private queueWaitSamples = 0;
  private droppedOrExpiredJobs = 0;
  private p0ExitDelayTotalMs = 0;
  private p0ExitDelaySamples = 0;
  private entries = 0;
  private exits = 0;
  private rpcFailures = 0;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly files: FileLoggerService,
    private readonly quotes: SolanaProtocolQuoteService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!(this.config.get<boolean>('solanaLaunch.multiVenueEnabled') ?? true)) {
      this.logger.log('Solana multi-venue flow v2.2 disabled');
      return;
    }
    // Restart recovery: resolve every overdue confirmation expiry before any
    // live processing starts, without waiting for a new swap event.
    await this.runIsolated('confirmation-recovery', () => this.sweepOverdueConfirmations());
    this.slotSubscription = this.quotes.connection.onSlotChange((slot) => {
      this.latestHeadSlot = Math.max(this.latestHeadSlot, slot.slot);
    });
    for (const descriptor of solanaProgramDescriptors().filter((item) => item.launchProgram)) {
      await (this.prisma as any).solanaProgramCursor.upsert({
        where: { programId: descriptor.programId },
        create: { venue: descriptor.venue, programId: descriptor.programId },
        update: { venue: descriptor.venue },
      });
      const state: StreamState = {
        programId: descriptor.programId,
        venue: descriptor.venue,
        subscriptionId: null,
        lastEventAtMs: Date.now(),
        lastEventSlot: 0,
        reconnectAttempts: 0,
        reconnectAt: 0,
        awaitingCatchUp: false,
      };
      this.streamStates.set(descriptor.programId, state);
      state.subscriptionId = this.subscribeLaunchLogs(descriptor.programId, descriptor.venue as SolanaVenue);
    }

    const backfillMs = Math.max(
      this.isPublicRpc() ? 30_000 : 10_000,
      this.config.get<number>('solanaLaunch.streamBackfillMs') ?? 15_000,
    );
    const lifecycleMs = Math.max(3_000, this.config.get<number>('solanaLaunch.lifecyclePollMs') ?? 5_000);
    this.backfillTimer = setInterval(() => void this.runIsolated('backfill', () => this.backfill()), backfillMs);
    this.lifecycleTimer = setInterval(() => void this.runIsolated('lifecycle', () => this.lifecycle()), lifecycleMs);
    this.armFallbackTimer = setInterval(
      () => void this.runIsolated('arm-fallback', () => this.evaluateDueOpenArms()),
      this.openArmEvalIntervalMs(),
    );
    this.healthTimer = setInterval(() => void this.runIsolated('health', () => this.logHealth()), 30_000);
    this.watchdogTimer = setInterval(
      () => void this.runIsolated('stream-watchdog', () => this.runStreamWatchdog()),
      this.streamWatchdogMs(),
    );
    this.confirmationTimer = setInterval(
      () => void this.runIsolated('confirmation-sweep', () => this.sweepOverdueConfirmations()),
      this.confirmationSweepMs(),
    );
    await this.bootstrapCursors();
    await this.restorePoolSubscriptions();
    void this.runIsolated('lifecycle', () => this.lifecycle());
    const launchStreams = solanaProgramDescriptors().filter((item) => item.launchProgram).length;
    this.logger.log(
      `Solana multi-venue flow started: launchStreams=${launchStreams} venueAdapters=${solanaProgramDescriptors().length} ` +
      `strategy=${SOLANA_MULTI_LAUNCH_STRATEGY} config=${SOLANA_FLOW_V2_CONFIG_HASH.slice(0, 12)} paper-only`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    if (this.backfillTimer) clearInterval(this.backfillTimer);
    if (this.lifecycleTimer) clearInterval(this.lifecycleTimer);
    if (this.armFallbackTimer) clearInterval(this.armFallbackTimer);
    if (this.healthTimer) clearInterval(this.healthTimer);
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    if (this.confirmationTimer) clearInterval(this.confirmationTimer);
    await Promise.allSettled([
      ...(this.slotSubscription == null
        ? []
        : [this.quotes.connection.removeSlotChangeListener(this.slotSubscription)]),
      ...[...this.streamStates.values()]
        .filter((state) => state.subscriptionId != null)
        .map((state) => this.quotes.connection.removeOnLogsListener(state.subscriptionId!)),
      ...[...this.poolSubscriptions.values()].map((entry) => this.quotes.connection.removeOnLogsListener(entry.subscriptionId)),
    ]);
  }

  private subscribeLaunchLogs(programId: string, venue: SolanaVenue): number {
    return this.quotes.connection.onLogs(
      new PublicKey(programId),
      (event, context) => {
        if (event.err) return;
        this.latestHeadSlot = Math.max(this.latestHeadSlot, context.slot);
        const state = this.streamStates.get(programId);
        if (state) {
          state.lastEventAtMs = Date.now();
          state.lastEventSlot = Math.max(state.lastEventSlot, context.slot);
          state.reconnectAttempts = 0;
        }
        const potentialLaunch = isPotentialLaunchLog(venue, event.logs);
        void this.updateLiveCursor(programId, context.slot, potentialLaunch ? null : event.signature);
        if (!potentialLaunch) return;
    this.enqueue(event.signature, context.slot, 'STREAM', programId, null, 'P2');
        void this.drainQueue();
      },
      'confirmed',
    );
  }

  /**
   * Stale-stream watchdog. A cursor whose live subscription has produced no
   * valid update inside the freshness window is marked disconnected and gapped
   * in the DB (the websocket object still existing is not evidence of health),
   * then resubscribed with bounded exponential backoff. `streamConnected` is
   * only restored by live events after resubscription, and `unresolvedGap` is
   * only cleared by a successful backfill catch-up.
   */
  async runStreamWatchdog(now = Date.now()): Promise<void> {
    for (const state of this.streamStates.values()) {
      if (state.reconnectAt > 0) {
        if (now >= state.reconnectAt) await this.reconnectStream(state, now);
        continue;
      }
      const ageMs = now - state.lastEventAtMs;
      const slotLag = this.latestHeadSlot > 0 && state.lastEventSlot > 0
        ? Math.max(0, this.latestHeadSlot - state.lastEventSlot)
        : 0;
      const stale = ageMs > this.streamFreshnessMs() || slotLag > this.streamFreshnessSlots();
      if (!stale) continue;
      state.reconnectAttempts++;
      state.reconnectAt = now + this.reconnectBackoffMs(state.reconnectAttempts);
      state.awaitingCatchUp = true;
      await (this.prisma as any).solanaProgramCursor.update({
        where: { programId: state.programId },
        data: {
          streamConnected: false,
          unresolvedGap: true,
          healthSnapshot: json({
            reason: 'stale_stream_watchdog',
            staleForMs: ageMs,
            slotLag,
            reconnectAttempt: state.reconnectAttempts,
            reconnectAt: new Date(state.reconnectAt).toISOString(),
          }),
        },
      }).catch(() => undefined);
      this.logger.warn(
        `Solana stream stale venue=${state.venue} ageMs=${ageMs} slotLag=${slotLag} ` +
        `reconnectAttempt=${state.reconnectAttempts} backoffMs=${state.reconnectAt - now}`,
      );
    }
  }

  private async reconnectStream(state: StreamState, now = Date.now()): Promise<void> {
    if (state.subscriptionId != null) {
      await Promise.resolve(this.quotes.connection.removeOnLogsListener(state.subscriptionId)).catch(() => undefined);
      state.subscriptionId = null;
    }
    try {
      state.subscriptionId = this.subscribeLaunchLogs(state.programId, state.venue as SolanaVenue);
      state.reconnectAt = 0;
      state.lastEventAtMs = now;
      this.logger.log(`Solana stream resubscribed venue=${state.venue}, awaiting backfill catch-up`);
    } catch (error) {
      state.reconnectAttempts++;
      state.reconnectAt = now + this.reconnectBackoffMs(state.reconnectAttempts);
      this.logger.warn(`Solana stream resubscribe failed venue=${state.venue}: ${this.describe(error)}`);
    }
  }

  /** True when the live subscription for a program has recently produced events. */
  isStreamFresh(programId: string, now = Date.now()): boolean {
    const state = this.streamStates.get(programId);
    if (!state || state.subscriptionId == null || state.reconnectAt > 0) return false;
    if (now - state.lastEventAtMs > this.streamFreshnessMs()) return false;
    if (this.latestHeadSlot > 0 && state.lastEventSlot > 0 &&
        this.latestHeadSlot - state.lastEventSlot > this.streamFreshnessSlots()) return false;
    return true;
  }

  private async bootstrapCursors(): Promise<void> {
    for (const descriptor of solanaProgramDescriptors().filter((item) => item.launchProgram)) {
      const cursor = await (this.prisma as any).solanaProgramCursor.findUnique({ where: { programId: descriptor.programId } });
      if (cursor?.lastBackfillSignature) continue;
      try {
        const latest = await this.quotes.runRpc(() => this.quotes.connection.getSignaturesForAddress(
          new PublicKey(descriptor.programId), { limit: 1 }, 'confirmed',
        ), 'P2');
        await (this.prisma as any).solanaProgramCursor.update({
          where: { programId: descriptor.programId },
          data: {
            lastBackfillSignature: latest[0]?.signature ?? null,
            lastSeenSlot: latest[0]?.slot != null ? BigInt(latest[0].slot) : null,
            streamConnected: true,
          },
        });
      } catch (error) {
        this.rpcFailures++;
        this.logger.warn(`Solana cursor bootstrap failed program=${descriptor.programId}: ${this.describe(error)}`);
      }
      if (this.isPublicRpc()) await delay(this.rpcRequestDelayMs());
    }
  }

  private async restorePoolSubscriptions(): Promise<void> {
    const lifecycleFilter = this.isPublicRpc()
      ? { signals: { some: { status: 'ACTIVE' } } }
      : {
        OR: [
          { signals: { some: { status: { in: ['ACTIVE', 'CONFIRMED'] } } } },
          { signals: { some: { arms: { some: { status: 'OPEN' } } } } },
        ],
      };
    const watches = await (this.prisma as any).solanaLaunchWatch.findMany({
      where: {
        invalidatedAt: null,
        latestEventAt: { gte: new Date(Date.now() - SOLANA_FLOW_V2_CONFIG.timeExitMs - 5 * 60_000) },
        ...lifecycleFilter,
      },
      include: { signals: { include: { arms: true } } },
      orderBy: { latestEventAt: 'desc' },
      take: 200,
    });
    const ranked = [...watches].sort((left: AnyRow, right: AnyRow) =>
      this.subscriptionPriority(right) - this.subscriptionPriority(left) ||
      right.latestEventAt.getTime() - left.latestEventAt.getTime(),
    );
    for (const watch of ranked.slice(0, this.maxPoolSubscriptions())) {
      await this.subscribeWatchPool(watch);
    }
  }

  private async subscribeWatchPool(watch: AnyRow): Promise<boolean> {
    const current = this.poolSubscriptions.get(watch.id);
    if (current?.poolAddress === watch.poolAddress) return true;
    if (current) await this.quotes.connection.removeOnLogsListener(current.subscriptionId).catch(() => undefined);
    if (current) this.poolSubscriptions.delete(watch.id);
    if (this.poolSubscriptions.size >= this.maxPoolSubscriptions()) return false;
    const subscriptionId = this.quotes.connection.onLogs(
      new PublicKey(watch.poolAddress),
      (event, context) => {
        if (event.err) return;
        this.latestHeadSlot = Math.max(this.latestHeadSlot, context.slot);
        this.enqueue(event.signature, context.slot, 'STREAM', null, watch.id, 'P1');
        void this.drainQueue();
      },
      'confirmed',
    );
    this.poolSubscriptions.set(watch.id, { subscriptionId, poolAddress: watch.poolAddress });
    return true;
  }

  private subscriptionPriority(watch: AnyRow): number {
    const signals = watch.signals ?? [];
    if (signals.some((signal: AnyRow) =>
      signal.strategyVersion === SOLANA_MULTI_LAUNCH_STRATEGY && signal.status === 'ACTIVE')) return 4;
    if (signals.some((signal: AnyRow) => signal.status === 'ACTIVE')) return 3;
    if (signals.some((signal: AnyRow) =>
      signal.strategyVersion === SOLANA_MULTI_LAUNCH_STRATEGY &&
      signal.arms?.some((arm: AnyRow) => arm.status === 'OPEN'))) return 2;
    if (signals.some((signal: AnyRow) => signal.arms?.some((arm: AnyRow) => arm.status === 'OPEN'))) return 1;
    return 0;
  }

  private async unsubscribeWatch(watchId: string): Promise<void> {
    const current = this.poolSubscriptions.get(watchId);
    if (!current) return;
    this.poolSubscriptions.delete(watchId);
    await this.quotes.connection.removeOnLogsListener(current.subscriptionId).catch(() => undefined);
  }

  private async drainQueue(): Promise<void> {
    if (this.draining) return;
    if (this.backfillBusy || this.lifecycleBusy) {
      setTimeout(() => void this.drainQueue(), 500);
      return;
    }
    if (Date.now() < this.rpcBackoffUntil) {
      setTimeout(() => void this.drainQueue(), Math.max(250, this.rpcBackoffUntil - Date.now()));
      return;
    }
    this.draining = true;
    try {
      const configuredMaximum = Math.max(1, this.config.get<number>('solanaLaunch.maxTransactionsPerCycle') ?? 40);
      const maximum = this.isPublicRpc() ? Math.min(configuredMaximum, 20) : configuredMaximum;
      const requestDelayMs = this.rpcRequestDelayMs();
      let processed = 0;
      while (this.queued.size && processed < maximum) {
        if (Date.now() < this.rpcBackoffUntil) break;
        const [signature, meta] = this.nextQueuedTransaction();
        this.queued.delete(signature);
        try {
          this.queueWaitTotalMs += Math.max(0, Date.now() - meta.queuedAtMs);
          this.queueWaitSamples++;
          await this.processSignature(signature, meta.source, meta.slot, meta.priority);
          await this.markQueueProcessed(meta, signature);
        } catch (error) {
          this.rpcFailures++;
          if (isRateLimit(error)) {
            this.openRpcBackoff();
          }
          if (meta.attempts < 5) {
            meta.attempts++;
            this.queued.set(signature, meta);
          } else {
            this.droppedOrExpiredJobs++;
            await this.markQueueGap(meta, error);
          }
          if (meta.attempts <= 1 || meta.attempts >= 5) {
            this.logger.warn(
              `Solana tx retry signature=${signature} attempt=${meta.attempts}/5: ${this.describe(error)}`,
            );
          }
        }
        processed++;
        if (!this.hasQueuedLaunches()) await this.runNextAdmission();
        if (requestDelayMs > 0) await delay(requestDelayMs);
      }
    } finally {
      this.draining = false;
      if (this.queued.size) {
        const waitMs = Math.max(250, this.rpcBackoffUntil - Date.now());
        setTimeout(() => void this.drainQueue(), waitMs);
      }
    }
  }

  private enqueue(
    signature: string,
    slot: number,
    source: 'STREAM' | 'BACKFILL',
    cursorProgramId: string | null,
    watchId: string | null,
    priority: QueueMeta['priority'] = watchId ? 'P1' : source === 'BACKFILL' ? 'P3' : 'P2',
  ): void {
    const existing = this.queued.get(signature);
    if (existing) {
      if (cursorProgramId) existing.cursorProgramIds.add(cursorProgramId);
      if (watchId) existing.watchIds.add(watchId);
      if (queuePriority(priority) < queuePriority(existing.priority)) existing.priority = priority;
      return;
    }
    const meta: QueueMeta = {
      slot,
      source,
      priority,
      queuedAtMs: Date.now(),
      cursorProgramIds: new Set(cursorProgramId ? [cursorProgramId] : []),
      watchIds: new Set(watchId ? [watchId] : []),
      attempts: 0,
    };
    const maximum = Math.max(100, this.config.get<number>('solanaLaunch.maxQueuedTransactions') ?? 1_000);
    if (this.queued.size >= maximum) {
      const entries = [...this.queued.entries()];
      const victim = cursorProgramId
        ? entries.find(([, queuedMeta]) => queuedMeta.cursorProgramIds.size === 0) ?? entries[0]
        : entries.find(([, queuedMeta]) => queuedMeta.cursorProgramIds.size === 0);
      if (!victim) {
        this.droppedOrExpiredJobs++;
        void this.markQueueGap(meta, new Error('local_queue_overflow_pool_event_dropped'));
        return;
      }
      this.queued.delete(victim[0]);
      this.droppedOrExpiredJobs++;
      void this.markQueueGap(victim[1], new Error('local_queue_overflow'));
    }
    this.queued.set(signature, meta);
  }

  private nextQueuedTransaction(): [string, QueueMeta] {
    const entries = [...this.queued.entries()];
    // P1 is watched-pool / confirmation flow. It must outrun discovery and
    // backfill; active exits use their independent fallback (P0) below.
    return entries.sort(([, left], [, right]) =>
      queuePriority(left.priority) - queuePriority(right.priority) || left.queuedAtMs - right.queuedAtMs,
    )[0];
  }

  private hasQueuedLaunches(): boolean {
    return [...this.queued.values()].some((meta) => meta.priority === 'P2');
  }

  private async runNextAdmission(): Promise<void> {
    const watchId = this.pendingAdmissions.values().next().value as string | undefined;
    if (!watchId) return;
    this.pendingAdmissions.delete(watchId);
    await this.runAdmission(watchId);
  }

  private async markQueueGap(meta: QueueMeta, error: unknown): Promise<void> {
    const reason = this.describe(error);
    await Promise.allSettled([
      ...[...meta.cursorProgramIds].map((programId) => (this.prisma as any).solanaProgramCursor.update({
        where: { programId },
        data: { unresolvedGap: true, rpcFailures: { increment: 1 }, streamConnected: !isRateLimit(error) },
      })),
      ...[...meta.watchIds].map((watchId) => (this.prisma as any).solanaLaunchWatch.update({
        where: { id: watchId },
        data: {
          unresolvedGap: true,
          benchmarkEligible: false,
          discoveryCohort: 'DEGRADED_SHADOW',
          healthSnapshot: json({ unresolvedGap: true, reason }),
        },
      })),
      ...[...meta.watchIds].map((watchId) => (this.prisma as any).solanaExperimentSignal.updateMany({
        where: { watchId },
        data: { benchmarkEligible: false, riskCohort: 'EXECUTABLE_SHADOW' },
      })),
    ]);
  }

  private async markQueueProcessed(meta: QueueMeta, signature: string): Promise<void> {
    await Promise.allSettled([
      ...[...meta.cursorProgramIds].map((programId) => (this.prisma as any).solanaProgramCursor.update({
        where: { programId }, data: { lastBackfillSignature: signature },
      })),
      ...[...meta.watchIds].map((watchId) => (this.prisma as any).solanaLaunchWatch.update({
        where: { id: watchId }, data: { lastObservedSignature: signature },
      })),
    ]);
  }

  private async processSignature(
    signature: string,
    source: 'STREAM' | 'BACKFILL',
    expectedSlot: number,
    priority: QueueMeta['priority'] = source === 'BACKFILL' ? 'P3' : 'P2',
  ): Promise<void> {
    const transaction = await this.fetchTransaction(signature, priority);
    if (!transaction) throw new Error('confirmed_transaction_unavailable');
    const decoded = decodeSolanaVenueTransaction(transaction, signature);
    for (const launch of decoded.launches) await this.handleLaunch(launch, source);
    for (const trade of decoded.trades) await this.handleTrade(trade);
    if (!decoded.launches.length && !decoded.trades.length && transaction.slot !== expectedSlot) {
      this.logger.debug(`Solana program tx decoded no tracked instruction signature=${signature}`);
    }
  }

  private async fetchTransaction(signature: string, priority: QueueMeta['priority']) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const transaction = await this.quotes.runRpc(() => this.quotes.connection.getParsedTransaction(signature, {
        commitment: 'confirmed', maxSupportedTransactionVersion: 0,
      }), priority);
      if (transaction) return transaction;
      await delay(250 * (attempt + 1));
    }
    return null;
  }

  private async handleLaunch(event: SolanaLaunchEvent, source: 'STREAM' | 'BACKFILL'): Promise<void> {
    if (event.kind === 'MIGRATION') {
      await this.handleMigration(event);
      return;
    }

    const migratedWatch = await (this.prisma as any).solanaLaunchWatch.findFirst({
      where: { mintAddress: event.mintAddress, poolAddress: event.poolAddress, invalidatedAt: null },
      orderBy: { launchedAt: 'asc' },
    });
    if (migratedWatch) {
      const refreshed = await (this.prisma as any).solanaLaunchWatch.update({
        where: { id: migratedWatch.id },
        data: { latestSlot: BigInt(event.slot), latestEventAt: new Date(event.blockTimeMs) },
      });
      if (this.poolSubscriptions.has(migratedWatch.id)) await this.subscribeWatchPool(refreshed);
      return;
    }

    const head = Math.max(this.latestHeadSlot, event.slot);
    const cursor = await (this.prisma as any).solanaProgramCursor.findUnique({ where: { programId: event.programId } });
    const eventAgeMs = Math.max(0, Date.now() - event.blockTimeMs);
    const lag = Math.max(0, head - event.slot);
    const queueLag = this.currentQueueLag(head);
    const rpcBackoffActive = Date.now() < this.rpcBackoffUntil;
    const streamFresh = this.isStreamFresh(event.programId);
    const streamConnected = Boolean(cursor?.streamConnected);
    const degraded = source === 'BACKFILL' || lag > SOLANA_FLOW_V2_CONFIG.maxPrimaryLagSlots ||
      eventAgeMs > SOLANA_FLOW_V2_CONFIG.maxPrimaryEventAgeMs || Boolean(cursor?.unresolvedGap) ||
      queueLag > SOLANA_FLOW_V2_CONFIG.maxPrimaryLagSlots || rpcBackoffActive ||
      !streamFresh || !streamConnected;
    const health = {
      source, head, eventSlot: event.slot, lagSlots: lag, queueLagSlots: queueLag, eventAgeMs,
      rpcBackoffActive, streamFresh, streamConnected,
      unresolvedGap: source === 'BACKFILL' || Boolean(cursor?.unresolvedGap),
    };
    const unique = {
      programId_discoverySignature_discoveryInstructionIndex: {
        programId: event.programId,
        discoverySignature: event.signature,
        discoveryInstructionIndex: event.instructionIndex,
      },
    };
    const existing = await (this.prisma as any).solanaLaunchWatch.findUnique({ where: unique });
    const watch = await (this.prisma as any).solanaLaunchWatch.upsert({
      where: unique,
      create: {
        venue: event.venue, programId: event.programId, mintAddress: event.mintAddress,
        poolAddress: event.poolAddress, quoteMint: event.quoteMint, creatorAddress: event.creatorAddress,
        launchedAt: new Date(event.blockTimeMs), discoverySlot: BigInt(event.slot),
        discoverySignature: event.signature, discoveryInstructionIndex: event.instructionIndex,
        launchId: `${event.programId}:${event.signature}:${event.instructionIndex}`,
        latestSlot: BigInt(event.slot), latestEventAt: new Date(event.blockTimeMs),
        discoveryCohort: degraded ? 'DEGRADED_SHADOW' : 'PROGRAM_STREAM',
        benchmarkEligible: false, healthSnapshot: json(health),
      },
      update: { latestSlot: BigInt(event.slot), latestEventAt: new Date(event.blockTimeMs), healthSnapshot: json(health) },
    });
    await this.ensurePoolEra(watch, {
      venue: event.venue,
      programId: event.programId,
      poolAddress: event.poolAddress,
      quoteMint: event.quoteMint,
      migrationId: null,
      startedAt: new Date(event.blockTimeMs),
    });
    if (!existing) {
      this.discovered++;
      this.logger.log(
        `SOLANA V2.2 WATCH venue=${event.venue} mint=${event.mintAddress} pool=${event.poolAddress} ` +
        `slot=${event.slot} source=${source} lag=${lag}`,
      );
    }
    this.pendingAdmissions.add(watch.id);
  }

  private async handleMigration(event: SolanaLaunchEvent): Promise<void> {
    const destinationProgramId = this.programForVenue(event.venue);
    if (!destinationProgramId) {
      await this.recordAttributionIssue(event, 'MIGRATION_DESTINATION_PROGRAM_UNKNOWN');
      return;
    }
    const migrationId = `${destinationProgramId}:${event.signature}:${event.instructionIndex}`;
    const existingDestination = await (this.prisma as any).solanaPoolEra.findUnique({
      where: {
        programId_poolAddress: {
          programId: destinationProgramId,
          poolAddress: event.poolAddress,
        },
      },
      include: { watch: true },
    });
    if (existingDestination) {
      if (
        existingDestination.watch.mintAddress === event.mintAddress &&
        existingDestination.migrationId === migrationId
      ) {
        return;
      }
      await this.recordAttributionIssue(
        event,
        'MIGRATION_DESTINATION_IDENTITY_CONFLICT',
        [existingDestination.watchId],
      );
      return;
    }

    const sourcePoolAddress = event.sourcePoolAddress ?? null;
    const sourceEra = sourcePoolAddress
      ? await (this.prisma as any).solanaPoolEra.findUnique({
        where: { programId_poolAddress: { programId: event.programId, poolAddress: sourcePoolAddress } },
        include: { watch: true },
      })
      : null;
    let resolvedSource = sourceEra;
    if (!resolvedSource && sourcePoolAddress) {
      // Compatibility bridge for a pre-era watch. This is exact pool identity,
      // never a mint + oldest fallback.
      const legacy = await (this.prisma as any).solanaLaunchWatch.findMany({
        where: {
          mintAddress: event.mintAddress, poolAddress: sourcePoolAddress,
          programId: event.programId, invalidatedAt: null,
        },
        take: 2,
      });
      if (legacy.length === 1) {
        const era = await this.ensurePoolEra(legacy[0], {
          venue: legacy[0].venue,
          programId: legacy[0].programId,
          poolAddress: legacy[0].poolAddress,
          quoteMint: legacy[0].quoteMint,
          migrationId: legacy[0].migrationId ?? null,
          startedAt: legacy[0].launchedAt,
        });
        resolvedSource = { ...era, watch: legacy[0] };
      }
    }
    if (!resolvedSource || resolvedSource.watch.mintAddress !== event.mintAddress || !resolvedSource.active) {
      await this.recordAttributionIssue(event, 'MIGRATION_ATTRIBUTION_UNKNOWN');
      return;
    }
    const now = new Date(event.blockTimeMs);
    await (this.prisma as any).$transaction([
      (this.prisma as any).solanaPoolEra.update({
        where: { id: resolvedSource.id }, data: { active: false, endedAt: now },
      }),
      (this.prisma as any).solanaPoolEra.create({
        data: {
          watchId: resolvedSource.watch.id, venue: event.venue, programId: destinationProgramId,
          poolAddress: event.poolAddress, quoteMint: event.quoteMint, migrationId, startedAt: now,
        },
      }),
      (this.prisma as any).solanaLaunchWatch.update({
        where: { id: resolvedSource.watch.id },
        data: {
          venue: event.venue, programId: destinationProgramId, poolAddress: event.poolAddress, quoteMint: event.quoteMint,
          migrationId, latestSlot: BigInt(event.slot), latestEventAt: now,
        },
      }),
    ]);
    const migrated = { ...resolvedSource.watch, venue: event.venue, programId: destinationProgramId,
      poolAddress: event.poolAddress, quoteMint: event.quoteMint, migrationId };
    if (this.poolSubscriptions.has(migrated.id)) await this.subscribeWatchPool(migrated);
  }

  private async ensurePoolEra(watch: AnyRow, era: {
    venue: string; programId: string; poolAddress: string; quoteMint: string; migrationId: string | null; startedAt: Date;
  }): Promise<AnyRow> {
    const existing = await (this.prisma as any).solanaPoolEra.findUnique({
      where: { programId_poolAddress: { programId: era.programId, poolAddress: era.poolAddress } },
    });
    if (existing) {
      if (existing.watchId !== watch.id) {
        throw new Error(`pool era identity conflict for ${era.programId}:${era.poolAddress}`);
      }
      return (this.prisma as any).solanaPoolEra.update({
        where: { id: existing.id },
        data: { active: true, endedAt: null, quoteMint: era.quoteMint },
      });
    }
    return (this.prisma as any).solanaPoolEra.create({ data: { watchId: watch.id, ...era } });
  }

  private programForVenue(venue: SolanaVenue): string | null {
    return solanaProgramDescriptors().find((descriptor) => descriptor.venue === venue)?.programId ?? null;
  }

  private async runAdmission(watchId: string): Promise<void> {
    if (this.admissionsInFlight.has(watchId)) return;
    this.admissionsInFlight.add(watchId);
    try {
      await this.admitWatch(watchId);
    } finally {
      this.admissionsInFlight.delete(watchId);
    }
  }

  private async admitWatch(watchId: string): Promise<void> {
    const watch = await (this.prisma as any).solanaLaunchWatch.findUnique({
      where: { id: watchId }, include: { signals: true },
    });
    if (!watch || watch.signals.length || watch.status === 'REORG_INVALIDATED') return;
    if (this.isPublicRpc() && watch.discoveryCohort === 'DEGRADED_SHADOW' && !(await this.hasShadowCapacity())) {
      await (this.prisma as any).solanaLaunchWatch.update({
        where: { id: watch.id },
        data: {
          status: 'OBSERVATION', discoveryCohort: 'MARKET_OBSERVATION', benchmarkEligible: false,
          resolutionReason: 'shadow_capacity_exceeded',
        },
      });
      return;
    }
    const hardRiskReasons = await this.inspectMintAndCreator(watch);
    let quote: SolanaRoundTripQuote | null = null;
    try {
      quote = await this.quotes.quoteRoundTrip(
        watch.venue as SolanaVenue, watch.poolAddress, watch.mintAddress, watch.quoteMint, 20,
      );
    } catch (error) {
      await (this.prisma as any).solanaLaunchWatch.update({
        where: { id: watch.id }, data: { resolutionReason: `quote_pending:${this.describe(error)}` },
      });
      return;
    }
    if (!quote) {
      await (this.prisma as any).solanaLaunchWatch.update({
        where: { id: watch.id }, data: { resolutionReason: 'quote_pending' },
      });
      return;
    }
    const health = watch.healthSnapshot as AnyRow ?? {};
    const latestSlot = Math.max(this.latestHeadSlot, quote.quoteSlot);
    const decision = classifySolanaExecution(
      quote,
      latestSlot,
      Math.max(0, Date.now() - watch.launchedAt.getTime()),
      Boolean(health.unresolvedGap || watch.unresolvedGap),
      hardRiskReasons,
    );
    const updated = await (this.prisma as any).solanaLaunchWatch.update({
      where: { id: watch.id },
      data: {
        decimals: quote.tokenDecimals,
        quoteMint: quote.quoteMint,
        discoveryCohort: decision.cohort,
        benchmarkEligible: decision.benchmarkEligible,
        status: decision.positionEligible ? 'SIGNALLED' : 'OBSERVATION',
        resolutionReason: decision.reasons.join('|') || null,
        riskSnapshot: json({ hardRiskReasons, decision }),
        quoteSnapshot: json(quote),
      },
    });
    if (!decision.positionEligible) {
      await this.unsubscribeWatch(watch.id);
      return;
    }
    if (decision.cohort === 'EXECUTABLE_SHADOW' && !(await this.hasShadowCapacity())) {
      await (this.prisma as any).solanaLaunchWatch.update({
        where: { id: watch.id },
        data: {
          status: 'OBSERVATION', discoveryCohort: 'MARKET_OBSERVATION', benchmarkEligible: false,
          resolutionReason: [...decision.reasons, 'shadow_capacity_exceeded'].join('|'),
        },
      });
      return;
    }
    if (!(await this.subscribeWatchPool(updated))) {
      await (this.prisma as any).solanaLaunchWatch.update({
        where: { id: watch.id },
        data: {
          status: 'OBSERVATION', discoveryCohort: 'MARKET_OBSERVATION', benchmarkEligible: false,
          resolutionReason: [...decision.reasons, 'pool_subscription_capacity_exceeded'].join('|'),
        },
      });
      return;
    }
    await this.createSignal(updated, quote, decision.cohort, decision.benchmarkEligible);
  }

  private async hasShadowCapacity(): Promise<boolean> {
    if (!this.isPublicRpc()) return true;
    const limit = Math.max(1, this.config.get<number>('solanaLaunch.maxShadowSignals') ?? 8);
    const count = await (this.prisma as any).solanaExperimentSignal.count({
      where: {
        strategyVersion: SOLANA_MULTI_LAUNCH_STRATEGY,
        riskCohort: 'EXECUTABLE_SHADOW',
        status: 'ACTIVE',
      },
    });
    return count < limit;
  }

  private async createSignal(
    watch: AnyRow,
    quote: SolanaRoundTripQuote,
    riskCohort: string,
    benchmarkEligible: boolean,
  ): Promise<void> {
    const now = new Date();
    const depthMeasurement = await this.quoteDepthMatrix(watch);
    const depthMatrix = depthMeasurement?.snapshot ?? null;
    const entryQuote = depthMeasurement?.quotes.get(20) ?? quote;
    const latestSlot = this.latestHeadSlot || Number(watch.latestSlot ?? entryQuote.quoteSlot);
    const measuredDecision = classifySolanaExecution(
      entryQuote,
      latestSlot,
      Math.max(0, now.getTime() - new Date(watch.latestEventAt ?? watch.launchedAt).getTime()),
      Boolean(watch.unresolvedGap),
    );
    // Route aggregators do not quote every size from one immutable venue
    // state. They remain executable shadow data until an atomic adapter exists.
    const measuredBenchmarkEligible = benchmarkEligible &&
      depthMeasurement?.benchmarkEligible === true &&
      measuredDecision.benchmarkEligible;
    const measuredRiskCohort = measuredBenchmarkEligible ? riskCohort : 'EXECUTABLE_SHADOW';
    const signal = await (this.prisma as any).solanaExperimentSignal.upsert({
      where: { watchId_strategyVersion_configHash: {
        watchId: watch.id, strategyVersion: SOLANA_MULTI_LAUNCH_STRATEGY, configHash: SOLANA_FLOW_V2_CONFIG_HASH,
      } },
      create: {
        watchId: watch.id, strategyVersion: SOLANA_MULTI_LAUNCH_STRATEGY, configHash: SOLANA_FLOW_V2_CONFIG_HASH,
        t0: now, t0Slot: BigInt(quote.quoteSlot),
        confirmationDueAt: new Date(now.getTime() + SOLANA_FLOW_V2_CONFIG.confirmationEndMs),
        horizonAt: new Date(now.getTime() + SOLANA_FLOW_V2_CONFIG.timeExitMs),
        riskCohort: measuredRiskCohort, benchmarkEligible: measuredBenchmarkEligible,
        featureSchemaVersion: 'solana_measurement_v3',
        executionSnapshot: json({
          ...entryQuote,
          depthMatrix: depthMatrix ?? { depthSource: 'UNKNOWN', depthConfidence: 'UNKNOWN' },
        }),
        healthSnapshot: watch.healthSnapshot ?? json({}), firstEligibleAt: now,
        arms: { create: SOLANA_EXPERIMENT_ARMS.map((arm) => ({
          armCode: arm.code, budgetUsd: SOLANA_FLOW_V2_CONFIG.positionBudgetUsd,
        })) },
      },
      update: {},
      include: { arms: true, watch: true },
    });
    this.signals++;
    for (const arm of signal.arms) {
      const definition = SOLANA_EXPERIMENT_ARMS.find((item) => item.code === arm.armCode)!;
      if (definition.immediateUsd > 0 && Number(arm.committedUsd) === 0) {
        const armQuote = depthMeasurement?.quotes.get(definition.immediateUsd) ?? (definition.immediateUsd === 20
          ? entryQuote
          : await this.quotes.quoteRoundTrip(
            watch.venue as SolanaVenue, watch.poolAddress, watch.mintAddress, watch.quoteMint, definition.immediateUsd,
          ));
        if (armQuote) await this.fillEntry(signal, arm, armQuote, definition.immediateUsd, 'IMMEDIATE_ENTRY');
      }
    }
  }

  private async handleTrade(trade: SolanaDecodedTrade): Promise<void> {
    const watch = await this.resolveTradeWatch(trade);
    if (!watch) return;
    const quoteUsd = trade.quoteAmountRaw
      ? await this.quotes.quoteRawToUsd(trade.quoteMint, trade.quoteAmountRaw).catch(() => null)
      : null;
    const creatorTrade = Boolean(watch.creatorAddress && trade.wallet === watch.creatorAddress);
    await (this.prisma as any).solanaSwapObservation.upsert({
      where: { programId_signature_instructionIndex: {
        programId: trade.programId, signature: trade.signature, instructionIndex: trade.instructionIndex,
      } },
      create: {
        watchId: watch.id, venue: trade.venue, programId: trade.programId, signature: trade.signature,
        poolEraId: watch.poolEraId,
        poolAddress: trade.poolAddress, tokenMint: trade.mintAddress,
        launchId: watch.launchId ?? `${watch.programId}:${watch.discoverySignature}:${watch.discoveryInstructionIndex}`,
        migrationId: watch.migrationId,
        instructionIndex: trade.instructionIndex, slot: BigInt(trade.slot), ts: new Date(trade.blockTimeMs),
        wallet: trade.wallet, direction: trade.direction, baseAmountRaw: trade.baseAmountRaw,
        quoteAmountRaw: trade.quoteAmountRaw, quoteUsd, creatorTrade, rawSnapshot: json(trade),
      },
      update: {},
    });
    await (this.prisma as any).solanaLaunchWatch.update({
      where: { id: watch.id },
      data: {
        latestSlot: BigInt(trade.slot),
        latestEventAt: new Date(trade.blockTimeMs),
        lastObservedSignature: trade.signature,
      },
    });
    this.swaps++;
    if (creatorTrade && trade.direction === 'SELL') await this.closeWatchArms(watch.id, 'CREATOR_SELL');
    // P0 is deliberately separate from transaction decoding: a slow quote can
    // never block newer swaps, confirmations or discovery from being decoded.
    this.scheduleP0ExitEvaluation(watch.id);
  }

  private async resolveTradeWatch(trade: SolanaDecodedTrade): Promise<AnyRow | null> {
    const matchingEras = await (this.prisma as any).solanaPoolEra.findMany({
      where: {
        venue: trade.venue, programId: trade.programId, poolAddress: trade.poolAddress,
        watch: { mintAddress: trade.mintAddress, invalidatedAt: null },
      },
      include: { watch: true },
      take: 2,
    });
    const exactEras = matchingEras.filter((era: AnyRow) => era.active);
    if (exactEras.length === 1) return { ...exactEras[0].watch, poolEraId: exactEras[0].id };
    // Trades from a closed bonding-curve era are valid chain activity but no
    // longer belong to the active migrated execution route.
    if (exactEras.length === 0 && matchingEras.length === 1) return null;

    // Pre-era history remains readable only through the same exact identity.
    const legacy = matchingEras.length === 0 ? await (this.prisma as any).solanaLaunchWatch.findMany({
      where: {
        venue: trade.venue, programId: trade.programId, poolAddress: trade.poolAddress,
        mintAddress: trade.mintAddress, invalidatedAt: null,
        poolEras: { none: {} },
      },
      take: 2,
    }) : [];
    if (legacy.length === 1) return { ...legacy[0], poolEraId: null };

    const mintCandidates = matchingEras.length === 0 && legacy.length === 0
      ? await (this.prisma as any).solanaLaunchWatch.findMany({
        where: { mintAddress: trade.mintAddress, invalidatedAt: null },
        select: { id: true },
        take: 2,
      })
      : [];
    const candidates = [
      ...matchingEras.map((era: AnyRow) => era.watch.id),
      ...legacy.map((watch: AnyRow) => watch.id),
      ...mintCandidates.map((watch: AnyRow) => watch.id),
    ];
    if (candidates.length === 0) return null;
    await this.recordAttributionIssue(trade, 'TRADE_ATTRIBUTION_UNKNOWN', candidates);
    this.logger.warn(
      `TRADE_ATTRIBUTION_UNKNOWN venue=${trade.venue} pool=${trade.poolAddress ?? 'none'} ` +
      `mint=${trade.mintAddress} candidates=${candidates.length}`,
    );
    return null;
  }

  private async recordAttributionIssue(
    event: SolanaDecodedTrade | SolanaLaunchEvent,
    reason: string,
    candidateWatchIds: readonly string[] = [],
  ): Promise<void> {
    await (this.prisma as any).solanaTradeAttributionIssue.upsert({
      where: { programId_signature_instructionIndex: {
        programId: event.programId, signature: event.signature, instructionIndex: event.instructionIndex,
      } },
      create: {
        venue: event.venue, programId: event.programId, poolAddress: event.poolAddress ?? null,
        tokenMint: event.mintAddress, signature: event.signature, instructionIndex: event.instructionIndex,
        slot: BigInt(event.slot), reason, candidateWatchIds: [...candidateWatchIds], rawSnapshot: json(event),
      },
      update: {},
    });
  }

  private scheduleP0ExitEvaluation(watchId: string): void {
    this.p0ExitQueue.set(watchId, this.p0ExitQueue.get(watchId) ?? Date.now());
    void this.drainP0ExitQueue();
  }

  private async drainP0ExitQueue(): Promise<void> {
    if (this.p0Draining) return;
    this.p0Draining = true;
    try {
      const limit = Math.max(1, this.config.get<number>('solanaLaunch.p0ExitBatchSize') ?? 3);
      for (let processed = 0; processed < limit && this.p0ExitQueue.size; processed++) {
        const [watchId, queuedAtMs] = this.p0ExitQueue.entries().next().value as [string, number];
        this.p0ExitQueue.delete(watchId);
        const delayMs = Math.max(0, Date.now() - queuedAtMs);
        this.p0ExitDelayTotalMs += delayMs;
        this.p0ExitDelaySamples++;
        if (delayMs > this.executionTimelinessMs()) {
          await (this.prisma as any).solanaExperimentSignal.updateMany({
            where: { watchId, status: { in: ['ACTIVE', 'CONFIRMED', 'EXPIRED'] } },
            data: { benchmarkEligible: false },
          });
        }
        await this.evaluateOpenArmsForWatch(watchId);
      }
    } finally {
      this.p0Draining = false;
      if (this.p0ExitQueue.size) void this.drainP0ExitQueue();
    }
  }

  private async evaluateOpenArmsForWatch(watchId: string): Promise<void> {
    const arms = await (this.prisma as any).solanaPaperArm.findMany({
      where: { status: 'OPEN', signal: { watchId } },
      include: { signal: { include: { watch: true } } },
      take: 20,
    });
    const quotes = new Map<string, Promise<Awaited<ReturnType<SolanaProtocolQuoteService['sellQuote']>>>>();
    for (const arm of arms) await this.evaluateArm(arm, quotes);
  }

  private async quoteDepthMatrix(watch: AnyRow): Promise<{
    snapshot: Record<string, unknown>;
    quotes: Map<number, SolanaRoundTripQuote>;
    benchmarkEligible: boolean;
  } | null> {
    const sizes = [4, 20, 50, 100];
    const matrix = await this.quotes.quoteSizeMatrix(
      watch.venue as SolanaVenue, watch.poolAddress, watch.mintAddress, watch.quoteMint, sizes,
      'P2',
    ).catch(() => null);
    if (!matrix) return null;
    const rows = matrix.quotes.map((quoted) => ({
      sizeUsd: quoted.entryUsd,
      buyImpactPct: quoted.buySlippagePct,
      sellImpactPct: quoted.sellSlippagePct,
      roundTripMultiple: quoted.roundTripMultiple,
      quoteSlot: quoted.quoteSlot,
    }));
    const maxAt = (threshold: number) => Math.max(0, ...rows
      .filter((row) => Math.max(row.buyImpactPct ?? Infinity, row.sellImpactPct ?? Infinity) <= threshold)
      .map((row) => row.sizeUsd));
    return {
      quotes: new Map(matrix.quotes.map((quoted) => [quoted.entryUsd, quoted])),
      benchmarkEligible: matrix.depthConfidence === 'REAL_EXECUTABLE_ATOMIC' &&
        maxAt(0.05) >= SOLANA_FLOW_V2_CONFIG.minExecutableDepthUsd,
      snapshot: {
      depthSource: matrix.depthConfidence === 'REAL_EXECUTABLE_ATOMIC'
        ? 'VENUE_STATE_QUOTE_MATRIX'
        : 'ROUTE_AGGREGATOR_QUOTE_MATRIX',
      depthConfidence: matrix.depthConfidence,
      observedAt: matrix.observedAt.toISOString(),
      bySize: rows,
      maxSizeAt1pctImpact: maxAt(0.01),
      maxSizeAt3pctImpact: maxAt(0.03),
      maxSizeAt5pctImpact: maxAt(0.05),
      zeroMoveRoundTripBySize: Object.fromEntries(rows.map((row) => [String(row.sizeUsd), row.roundTripMultiple])),
      },
    };
  }

  private async lifecycle(): Promise<void> {
    if (this.lifecycleBusy) return;
    if (Date.now() < this.rpcBackoffUntil) return;
    if (this.draining || this.backfillBusy || this.queued.size > 0) return;
    this.lifecycleBusy = true;
    try {
      await this.runLifecycleCycle();
    } finally {
      this.lifecycleBusy = false;
    }
  }

  private async runLifecycleCycle(): Promise<void> {
    const signalBatch = this.isPublicRpc() ? 3 : 100;
    const armBatch = this.isPublicRpc() ? 6 : 150;
    await this.expireStaleWatches();
    const pendingWatches = await (this.prisma as any).solanaLaunchWatch.findMany({
      where: {
        status: 'WATCHING',
        launchedAt: { gte: new Date(Date.now() - this.pendingWatchTimeoutMs()) },
        signals: { none: {} },
      },
      orderBy: { launchedAt: 'asc' }, take: this.isPublicRpc() ? 10 : 50,
    });
    for (const watch of pendingWatches) this.pendingAdmissions.add(watch.id);
    if (!this.hasQueuedLaunches()) await this.runNextAdmission();

    const activeSignals = await (this.prisma as any).solanaExperimentSignal.findMany({
      where: { status: 'ACTIVE' }, include: { watch: true, arms: true }, take: signalBatch,
    });
    for (const signal of activeSignals) await this.evaluateSignal(signal);

    await this.evaluateDueOpenArms(armBatch);
    await this.finalizeRecentWatches();
    await this.resolveCompletedSignals();
  }

  private async evaluateDueOpenArms(batchSize?: number): Promise<void> {
    if (this.armEvaluationBusy || Date.now() < this.rpcBackoffUntil) return;
    this.armEvaluationBusy = true;
    try {
      const defaultBatch = this.isPublicRpc() ? 6 : 150;
      const openArms = await (this.prisma as any).solanaPaperArm.findMany({
        where: {
          status: 'OPEN',
          updatedAt: { lte: new Date(Date.now() - this.openArmEvalIntervalMs()) },
        },
        include: { signal: { include: { watch: true } } },
        orderBy: { updatedAt: 'asc' },
        take: batchSize ?? defaultBatch,
      });
      for (const arm of openArms) await this.evaluateArm(arm);
    } finally {
      this.armEvaluationBusy = false;
    }
  }

  private async expireStaleWatches(): Promise<void> {
    const stale = await (this.prisma as any).solanaLaunchWatch.findMany({
      where: {
        status: 'WATCHING',
        launchedAt: { lt: new Date(Date.now() - this.pendingWatchTimeoutMs()) },
        signals: { none: {} },
      },
      orderBy: { launchedAt: 'asc' },
      take: 100,
    });
    for (const watch of stale) {
      this.pendingAdmissions.delete(watch.id);
      await (this.prisma as any).solanaLaunchWatch.update({
        where: { id: watch.id },
        data: {
          status: 'OBSERVATION', discoveryCohort: 'MARKET_OBSERVATION', benchmarkEligible: false,
          resolutionReason: 'quote_timeout',
        },
      });
      await this.unsubscribeWatch(watch.id);
    }
  }

  /**
   * Loads the swap observations recorded for a signal since t0 and computes a
   * rolling flow snapshot. Always returns a fully-populated structure (never
   * `{}`), including the raw observation count so downstream CSV/DB exports
   * are auditable even when no flow was observed.
   */
  private async buildFlowContext(
    signal: AnyRow,
    currentDepthUsd: number | null,
    nowMs = Date.now(),
  ): Promise<{ flow: AnyRow; trades: SolanaFlowTrade[] }> {
    const observations = await (this.prisma as any).solanaSwapObservation.findMany({
      where: { watchId: signal.watchId, ts: { gte: signal.t0 } }, orderBy: { ts: 'asc' },
    });
    const trades: SolanaFlowTrade[] = observations.map((row: AnyRow) => ({
      tsMs: row.ts.getTime(), slot: Number(row.slot), wallet: row.wallet,
      direction: row.direction, quoteUsd: Number(row.quoteUsd ?? 0), creatorTrade: row.creatorTrade,
    }));
    const initial = signal.executionSnapshot as AnyRow ?? {};
    const previousFlow = signal.flowSnapshot as AnyRow | null;
    const t0DepthUsd = Number(initial.executableDepthUsd ?? 0);
    const depthUsd = currentDepthUsd ?? Number(previousFlow?.currentDepthUsd ?? t0DepthUsd);
    const snapshot = computeSolanaFlowSnapshot(trades, nowMs, depthUsd, t0DepthUsd);
    const flow = {
      ...snapshot,
      observationCount: trades.length,
      currentDepthUsd: depthUsd,
      t0DepthUsd,
      computedAt: new Date(nowMs).toISOString(),
    };
    return { flow, trades };
  }

  private async evaluateSignal(signal: AnyRow): Promise<void> {
    const now = Date.now();
    const elapsed = now - signal.t0.getTime();
    if (elapsed < SOLANA_FLOW_V2_CONFIG.confirmationStartMs) return;
    if (now > signal.confirmationDueAt.getTime()) {
      await this.expireConfirmation(signal);
      return;
    }
    const previousFlow = signal.flowSnapshot as AnyRow | null;
    const chance = SOLANA_FLOW_V2_CONFIG.confirmationWindows.find(
      (window) => elapsed >= window.startMs && elapsed <= window.endMs,
    );
    const lastEvaluatedAt = Date.parse(String(previousFlow?.evaluatedAt ?? ''));
    const evaluationIntervalMs = chance ? 10_000 : 30_000;
    if (Number.isFinite(lastEvaluatedAt) && now - lastEvaluatedAt < evaluationIntervalMs) return;
    const quote = await this.quotes.quoteRoundTrip(
      signal.watch.venue as SolanaVenue,
      signal.watch.poolAddress,
      signal.watch.mintAddress,
      signal.watch.quoteMint,
      20,
    ).catch(() => null);
    if (!quote) {
      // Persist the flow snapshot even without an executable quote so the
      // confirmation evaluation trail is never empty; the evaluation itself
      // is recorded as degraded and cannot confirm.
      const { flow } = await this.buildFlowContext(signal, null, now);
      const degradedSnapshot = {
        ...flow,
        chanceCode: chance?.code ?? null,
        confirmationReasons: ['quote_unavailable'],
        quoteUnavailable: true,
        evaluatedAt: new Date(now).toISOString(),
      };
      await (this.prisma as any).solanaExperimentSignal.update({
        where: { id: signal.id }, data: { flowSnapshot: json(degradedSnapshot) },
      });
      return;
    }
    const { flow: flowContext, trades } = await this.buildFlowContext(signal, quote.executableDepthUsd, now);
    const initial = signal.executionSnapshot as AnyRow;
    const minSpotPriceUsd = Math.min(
      Number(previousFlow?.minSpotPriceUsd ?? quote.spotPriceUsd),
      quote.spotPriceUsd,
    );
    const launchMultiple = safeRatio(quote.spotPriceUsd, Number(initial.spotPriceUsd ?? 0));
    const reboundFromLow = safeRatio(quote.spotPriceUsd, minSpotPriceUsd);
    const watchEventAgeMs = Math.max(0, now - signal.watch.latestEventAt.getTime());
    const executionDecision = classifySolanaExecution(
      quote,
      Math.max(this.latestHeadSlot, quote.quoteSlot),
      watchEventAgeMs,
      Boolean(signal.watch.unresolvedGap),
    );
    const result = evaluateSolanaConfirmation(
      trades, now, signal.t0.getTime(), quote.executableDepthUsd,
      Number(initial.executableDepthUsd ?? 0), !executionDecision.positionEligible,
      { launchMultiple, reboundFromLow },
    );
    const chanceEvaluations = { ...(previousFlow?.chanceEvaluations as AnyRow ?? {}) };
    if (result.chanceCode) chanceEvaluations[result.chanceCode] = Number(chanceEvaluations[result.chanceCode] ?? 0) + 1;
    const enrichedSnapshot = {
      ...result.snapshot,
      observationCount: flowContext.observationCount,
      currentDepthUsd: quote.executableDepthUsd,
      t0DepthUsd: Number(initial.executableDepthUsd ?? 0),
      chanceCode: result.chanceCode,
      chanceEvaluations,
      confirmationReasons: result.reasons,
      launchMultiple,
      reboundFromLow,
      minSpotPriceUsd,
      currentSpotPriceUsd: quote.spotPriceUsd,
      executionDecision,
      quoteSlot: quote.quoteSlot,
      evaluatedAt: new Date(now).toISOString(),
    };
    await (this.prisma as any).solanaExperimentSignal.update({
      where: { id: signal.id }, data: { flowSnapshot: json(enrichedSnapshot) },
    });
    if (!result.confirmed) return;
    const confirmedAt = new Date();
    await (this.prisma as any).solanaExperimentSignal.update({
      where: { id: signal.id },
      data: { status: 'CONFIRMED', confirmedAt, confirmationSnapshot: json(enrichedSnapshot) },
    });
    this.confirmations++;
    for (const arm of signal.arms) {
      const definition = SOLANA_EXPERIMENT_ARMS.find((item) => item.code === arm.armCode)!;
      if (definition.confirmationUsd <= 0) continue;
      if (arm.armCode === 'B_PROBE_4_ADD_16' && String(arm.executedRungs ?? '').length > 0) continue;
      const addQuote = definition.confirmationUsd === 20
        ? quote
        : await this.quotes.quoteRoundTrip(
          signal.watch.venue as SolanaVenue, signal.watch.poolAddress,
          signal.watch.mintAddress, signal.watch.quoteMint, definition.confirmationUsd,
        );
      if (addQuote) {
        await this.fillEntry(signal, arm, addQuote, definition.confirmationUsd, 'CONFIRMATION_ADD', enrichedSnapshot);
      }
    }
    if (this.isPublicRpc()) await this.unsubscribeWatch(signal.watchId);
    this.logger.log(
      `SOLANA V2.2 CONFIRMED mint=${signal.watch.mintAddress} venue=${signal.watch.venue} ` +
      `chance=${result.chanceCode} launchMult=${launchMultiple.toFixed(3)} rebound=${reboundFromLow.toFixed(3)}`,
    );
  }

  /**
   * Queue-independent sweep that resolves confirmation expiries. Runs at
   * startup (restart recovery) and on its own timer, so an overdue expiry
   * never waits for a new swap event, a drained queue, or a live stream.
   */
  async sweepOverdueConfirmations(now = new Date()): Promise<void> {
    if (this.confirmationSweepBusy) return;
    this.confirmationSweepBusy = true;
    try {
      const overdue = await (this.prisma as any).solanaExperimentSignal.findMany({
        where: { status: 'ACTIVE', confirmationDueAt: { lt: now } },
        include: { arms: true, watch: true },
        orderBy: { confirmationDueAt: 'asc' },
        take: 50,
      });
      for (const signal of overdue) await this.expireConfirmation(signal);
      // Repair pass: EXPIRED signals whose arms were left unresolved by an
      // earlier crash or a failed exit quote.
      const stuck = await (this.prisma as any).solanaExperimentSignal.findMany({
        where: {
          status: 'EXPIRED',
          arms: { some: { OR: [
            { armCode: 'C_CONFIRM_20', status: 'PENDING' },
            { armCode: 'B_PROBE_4_ADD_16', status: 'OPEN' },
          ] } },
        },
        include: { arms: true, watch: true },
        take: 50,
      });
      for (const signal of stuck) await this.resolveExpiredArms(signal);
    } finally {
      this.confirmationSweepBusy = false;
    }
  }

  private async expireConfirmation(signal: AnyRow): Promise<void> {
    let snapshot = signal.flowSnapshot as AnyRow | null;
    if (!snapshot || Object.keys(snapshot).length === 0) {
      snapshot = {
        ...(await this.buildFlowContext(signal, null).catch(() => ({ flow: {} as AnyRow }))).flow,
        confirmationReasons: ['all_confirmation_chances_expired'],
      };
    }
    await (this.prisma as any).solanaExperimentSignal.update({
      where: { id: signal.id },
      data: {
        status: 'EXPIRED',
        flowSnapshot: json(snapshot),
        confirmationReject: json(snapshot),
        resolutionReason: 'all_confirmation_chances_expired',
      },
    });
    await this.resolveExpiredArms({ ...signal, flowSnapshot: snapshot });
    if (this.isPublicRpc()) await this.unsubscribeWatch(signal.watchId);
  }

  /**
   * Deterministic post-expiry arm resolution:
   * C closes as NO_CONFIRMATION with $0 exposure, B sells its probe using the
   * freshest valid executable quote (retried by the sweep until a quote
   * succeeds), A keeps its normal ladder/stop/time lifecycle. Idempotent.
   */
  private async resolveExpiredArms(signal: AnyRow): Promise<void> {
    for (const arm of signal.arms as AnyRow[]) {
      if (arm.armCode === 'C_CONFIRM_20' && arm.status === 'PENDING' && Number(arm.committedUsd) === 0) {
        await (this.prisma as any).solanaPaperArm.update({
          where: { id: arm.id }, data: { status: 'CLOSED', closedAt: new Date(), outcomeClass: 'NO_CONFIRMATION' },
        });
      }
      if (arm.armCode === 'B_PROBE_4_ADD_16' && arm.status === 'OPEN' && Number(arm.committedUsd) > 0) {
        if (Date.now() < this.rpcBackoffUntil) continue;
        await this.sellAll(arm, signal.watch, 'NO_CONFIRMATION_SELL', signal, {
          targetAt: signal.confirmationDueAt,
        });
      }
    }
  }

  private async fillEntry(
    signal: AnyRow,
    arm: AnyRow,
    quote: SolanaRoundTripQuote,
    sizeUsd: number,
    legType: string,
    flowSnapshot?: AnyRow | null,
  ): Promise<void> {
    if (sizeUsd > 0) {
      const block = await this.paidFillBlockReason(signal, arm, sizeUsd, legType, flowSnapshot);
      if (block) {
        this.logger.warn(
          `SOLANA V2.3 PAID FILL BLOCKED arm=${arm.armCode} type=${legType} reason=${block}`,
        );
        return;
      }
    }
    const idempotencyKey = `${signal.id}:${arm.armCode}:${legType}`;
    const existingLeg = await (this.prisma as any).solanaExecutionLeg.findUnique({ where: { idempotencyKey } });
    if (existingLeg) return;
    const executedAt = new Date();
    const existingTokens = BigInt(arm.tokensBoughtRaw ?? '0');
    const addedTokens = BigInt(quote.entryTokensRaw);
    const totalTokens = existingTokens + addedTokens;
    const committed = Number(arm.committedUsd ?? 0) + sizeUsd + quote.gasUsd;
    const blended = committed / rawToNumber(totalTokens, quote.tokenDecimals);
    const flow = flowSnapshot
      ?? await this.buildFlowContext(signal, quote.executableDepthUsd)
        .then((context) => context.flow)
        .catch(() => (signal.flowSnapshot as AnyRow) ?? {});
    const hasPersistedFlow = signal.flowSnapshot && Object.keys(signal.flowSnapshot as AnyRow).length > 0;
    const operations = [
      (this.prisma as any).solanaExecutionLeg.create({
        data: {
          armId: arm.id, legType, status: 'FILLED', idempotencyKey,
          targetExecutionAt: executedAt, executedAt, inputUsd: sizeUsd,
          tokenAmountRaw: addedTokens.toString(), effectivePriceUsd: (sizeUsd + quote.gasUsd) / quote.entryTokens,
          slippagePct: quote.buySlippagePct, gasUsd: quote.gasUsd, quoteSlot: BigInt(quote.quoteSlot),
          quoteModel: quote.quoteModel, quoteSnapshot: json(quote),
        },
      }),
      (this.prisma as any).solanaPaperArm.update({
        where: { id: arm.id },
        data: {
          status: 'OPEN', openedAt: arm.openedAt ?? executedAt, committedUsd: committed,
          tokensBoughtRaw: totalTokens.toString(), remainingTokensRaw: (BigInt(arm.remainingTokensRaw ?? '0') + addedTokens).toString(),
          blendedEntryPriceUsd: blended, currentMultiple: quote.roundTripMultiple,
          maxMultipleObserved: Math.max(Number(arm.maxMultipleObserved ?? 0), quote.roundTripMultiple ?? 0),
        },
      }),
      ...(hasPersistedFlow ? [] : [(this.prisma as any).solanaExperimentSignal.update({
        where: { id: signal.id }, data: { flowSnapshot: json(flow) },
      })]),
    ];
    const [, updated] = await (this.prisma as any).$transaction(operations);
    this.entries++;
    this.logEntry(signal, updated, quote, sizeUsd, legType, executedAt, flow);
  }

  private async evaluateArm(
    arm: AnyRow,
    quoteCache?: Map<string, Promise<Awaited<ReturnType<SolanaProtocolQuoteService['sellQuote']>>>>,
  ): Promise<void> {
    const watch = arm.signal.watch;
    const remaining = BigInt(arm.remainingTokensRaw ?? '0');
    if (remaining <= 0n) return;
    // If this arm has not been observed for far longer than the evaluation
    // cadence (stream stall, restart, RPC backoff), any exit recorded now is a
    // late recovery, not a timely execution.
    const lastEvaluatedAtMs = arm.updatedAt instanceof Date ? arm.updatedAt.getTime() : Date.now();
    const evaluationGapMs = Math.max(0, Date.now() - lastEvaluatedAtMs);
    const staleEvaluation = evaluationGapMs > Math.max(3 * this.openArmEvalIntervalMs(), this.executionTimelinessMs());
    const degradedReason = staleEvaluation ? 'stale_evaluation_window' : null;
    const sellQuote = await this.cachedSellQuote(watch, remaining.toString(), quoteCache);
    if (!sellQuote) {
      await (this.prisma as any).solanaPaperArm.update({
        where: { id: arm.id }, data: { currentMultiple: arm.currentMultiple },
      });
      return;
    }
    const committed = Number(arm.committedUsd);
    const multiple = committed > 0 ? (Number(arm.realizedValueUsd) + sellQuote.netUsd) / committed : 0;
    await (this.prisma as any).solanaPaperArm.update({
      where: { id: arm.id }, data: {
        currentMultiple: multiple,
        maxMultipleObserved: Math.max(Number(arm.maxMultipleObserved ?? 0), multiple),
      },
    });
    const protectedProbe = arm.armCode === 'B_PROBE_4_ADD_16' &&
      arm.signal.status === 'ACTIVE' &&
      Date.now() <= arm.signal.confirmationDueAt.getTime() &&
      Number(arm.committedUsd) <= 5;
    if (multiple <= SOLANA_FLOW_V2_CONFIG.hardStopMultiple && !protectedProbe) {
      await this.sellArm(arm, watch, remaining, sellQuote, 'HARD_STOP_SELL', multiple, true, undefined, { degradedReason });
      return;
    }
    const executed = new Set(String(arm.executedRungs ?? '').split(',').filter(Boolean).map(Number));
    const rung = SOLANA_FLOW_V2_CONFIG.ladder.find((item) => multiple >= item.multiple && !executed.has(item.multiple));
    if (rung) {
      const original = BigInt(arm.tokensBoughtRaw);
      const target = original * BigInt(Math.round(rung.fraction * 100)) / 100n;
      const amount = target < remaining ? target : remaining;
      const quote = amount === remaining ? sellQuote : await this.cachedSellQuote(watch, amount.toString(), quoteCache);
      if (quote) {
        executed.add(rung.multiple);
        await this.sellArm(arm, watch, amount, quote, 'LADDER_SELL', multiple, amount === remaining, executed, { degradedReason });
      }
      return;
    }
    if (Date.now() >= arm.signal.horizonAt.getTime()) {
      await this.sellArm(arm, watch, remaining, sellQuote, 'TIME_SELL', multiple, true, undefined, {
        targetAt: arm.signal.horizonAt,
        degradedReason,
      });
    }
  }

  private async cachedSellQuote(
    watch: AnyRow,
    tokensRaw: string,
    cache?: Map<string, Promise<Awaited<ReturnType<SolanaProtocolQuoteService['sellQuote']>>>>,
  ): Promise<Awaited<ReturnType<SolanaProtocolQuoteService['sellQuote']>>> {
    const key = `${watch.venue}:${watch.poolAddress}:${tokensRaw}`;
    let pending = cache?.get(key);
    if (!pending) {
      pending = this.quotes.sellQuote({
        venue: watch.venue as SolanaVenue, poolAddress: watch.poolAddress,
        mintAddress: watch.mintAddress, quoteMint: watch.quoteMint, tokensRaw,
      }).catch(() => null);
      cache?.set(key, pending);
    }
    return pending;
  }

  private async closeWatchArms(watchId: string, reason: string): Promise<void> {
    const arms = await (this.prisma as any).solanaPaperArm.findMany({
      where: { status: 'OPEN', signal: { watchId } }, include: { signal: { include: { watch: true } } },
    });
    for (const arm of arms) await this.sellAll(arm, arm.signal.watch, reason);
  }

  private async sellAll(
    arm: AnyRow,
    watch: AnyRow,
    reason: string,
    signal?: AnyRow,
    options?: SellOptions,
  ): Promise<void> {
    const contextualArm = signal && !arm.signal ? { ...arm, signal } : arm;
    const remaining = BigInt(arm.remainingTokensRaw ?? '0');
    if (remaining <= 0n) return;
    const quote = await this.quotes.sellQuote({
      venue: watch.venue, poolAddress: watch.poolAddress, mintAddress: watch.mintAddress,
      quoteMint: watch.quoteMint, tokensRaw: remaining.toString(),
    });
    if (!quote) return;
    const committed = Number(arm.committedUsd);
    const multiple = committed > 0 ? (Number(arm.realizedValueUsd) + quote.netUsd) / committed : 0;
    await this.sellArm(contextualArm, watch, remaining, quote, reason, multiple, true, undefined, options);
  }

  private async sellArm(
    arm: AnyRow,
    watch: AnyRow,
    amountRaw: bigint,
    quote: { netUsd: number; grossUsd: number; slippagePct: number; quoteSlot: number; raw: unknown },
    eventType: string,
    multiple: number,
    closes: boolean,
    executedRungs?: ReadonlySet<number>,
    options?: SellOptions,
  ): Promise<void> {
    const idempotencyKey = `${arm.id}:${eventType}:${[...(executedRungs ?? [])].join('-') || 'terminal'}`;
    const existingLeg = await (this.prisma as any).solanaExecutionLeg.findUnique({ where: { idempotencyKey } });
    if (existingLeg) return;
    const executedAt = new Date();
    const targetAt = options?.targetAt ?? executedAt;
    const executionDelayMs = Math.max(0, executedAt.getTime() - targetAt.getTime());
    // Data-health rule: when the intended execution moment could not be
    // observed timely (stream stall, restart, backoff), never fabricate a
    // timely primary execution — record the delay and degrade the signal.
    const delayReason = options?.degradedReason
      ?? (executionDelayMs > this.executionTimelinessMs() ? 'stale_state_recovery' : null);
    const degraded = delayReason != null;
    const remaining = BigInt(arm.remainingTokensRaw) - amountRaw;
    const realized = Number(arm.realizedValueUsd) + quote.netUsd;
    const realizedMultiple = Number(arm.committedUsd) > 0 ? realized / Number(arm.committedUsd) : 0;
    const closed = closes || remaining <= 0n;
    const outcome = closed ? classifyExitOutcome(eventType, realizedMultiple) : null;
    const signalRef = arm.signal ?? (arm.signalId ? { id: arm.signalId } : null);
    const operations = [
      (this.prisma as any).solanaExecutionLeg.create({
        data: {
          armId: arm.id, legType: eventType, status: 'FILLED', idempotencyKey,
          targetExecutionAt: targetAt, executedAt, outputUsd: quote.netUsd,
          tokenAmountRaw: amountRaw.toString(), slippagePct: quote.slippagePct,
          gasUsd: (this.config.get<number>('solanaLaunch.gasUsd') ?? 0.01), quoteSlot: BigInt(quote.quoteSlot),
          quoteModel: 'VENUE_EXIT_QUOTE', quoteSnapshot: json(quote.raw),
          failureReason: degraded ? `delayed_execution:${delayReason}` : null,
        },
      }),
      (this.prisma as any).solanaPaperArm.update({
        where: { id: arm.id },
        data: {
          remainingTokensRaw: remaining.toString(), realizedValueUsd: realized,
          executedRungs: executedRungs ? [...executedRungs].sort((a, b) => a - b).join(',') : arm.executedRungs,
          ...(closed ? {
            status: 'CLOSED', closedAt: executedAt, realizedMultiple, outcomeClass: outcome,
          } : {}),
        },
      }),
      ...(degraded && signalRef?.id ? [(this.prisma as any).solanaExperimentSignal.updateMany({
        where: { id: signalRef.id }, data: { benchmarkEligible: false },
      })] : []),
    ];
    const [, updated] = await (this.prisma as any).$transaction(operations);
    this.exits++;
    const executionHealth = {
      targetExecutionAt: targetAt.toISOString(),
      observedExecutionAt: executedAt.toISOString(),
      executionDelayMs,
      delayReason,
      degraded,
    };
    const flow = await this.latestFlowSnapshot(arm.signal ?? null);
    this.logExit(
      arm.signal ?? { watch }, updated, watch, quote, eventType, multiple, amountRaw, outcome, executedAt,
      flow, executionHealth, targetAt,
    );
    if (degraded) {
      this.logger.warn(
        `SOLANA V2.2 DEGRADED EXIT arm=${arm.armCode ?? arm.id} type=${eventType} ` +
        `delayMs=${executionDelayMs} reason=${delayReason}`,
      );
    }
  }

  /**
   * Fetches the freshest persisted flow snapshot for a signal (the in-memory
   * row loaded at cycle start may be stale), recomputing from observations
   * when nothing was persisted yet.
   */
  private async latestFlowSnapshot(signal: AnyRow | null): Promise<AnyRow | null> {
    if (!signal?.id) return null;
    const fresh = await (this.prisma as any).solanaExperimentSignal.findUnique({
      where: { id: signal.id },
    }).catch(() => null);
    const persisted = (fresh?.flowSnapshot ?? signal.flowSnapshot) as AnyRow | null;
    if (persisted && Object.keys(persisted).length > 0) return persisted;
    if (!signal.watchId || !signal.t0) return persisted ?? null;
    return this.buildFlowContext(signal, null)
      .then((context) => context.flow)
      .catch(() => persisted ?? null);
  }

  private async inspectMintAndCreator(watch: AnyRow): Promise<string[]> {
    const reasons: string[] = [];
    const blocked = new Set(this.config.get<string[]>('solanaLaunch.blockedCreators') ?? []);
    if (watch.creatorAddress && blocked.has(watch.creatorAddress)) reasons.push('blocked_creator');
    const serial = await this.serialCreatorBlockReason(watch.creatorAddress ?? null);
    if (serial) reasons.push(serial);
    try {
      const account = await this.quotes.runRpc(() => this.quotes.connection.getParsedAccountInfo(
        new PublicKey(watch.mintAddress), 'confirmed',
      ), 'P2');
      const info: any = (account.value?.data as any)?.parsed?.info;
      if (!info) return [...reasons, 'mint_state_unavailable'];
      if (info.mintAuthority && PublicKey.isOnCurve(new PublicKey(info.mintAuthority))) {
        reasons.push('external_mint_authority');
      }
      if (info.freezeAuthority && PublicKey.isOnCurve(new PublicKey(info.freezeAuthority))) {
        reasons.push('external_freeze_authority');
      }
      for (const extension of info.extensions ?? []) {
        const name = String(extension.extension ?? '').toLowerCase();
        if (['transferhook', 'defaultaccountstate', 'nontransferable', 'permanentdelegate'].includes(name)) {
          reasons.push(`dangerous_token2022_${name}`);
        }
        if (name === 'transferfeeconfig') {
          const bps = Number(extension.state?.newerTransferFee?.transferFeeBasisPoints ?? 0);
          if (bps >= 5_000) reasons.push('transfer_fee_gte_50pct');
        }
      }
    } catch {
      reasons.push('mint_state_unavailable');
    }
    return reasons;
  }

  /**
   * Finish-line paid-capital gate. Only C confirmation size should reach here
   * with sizeUsd>0; still defend against latency, empty flow, and serial rugs.
   */
  private async paidFillBlockReason(
    signal: AnyRow,
    arm: AnyRow,
    sizeUsd: number,
    legType: string,
    flowSnapshot?: AnyRow | null,
  ): Promise<string | null> {
    if (arm.armCode !== 'C_CONFIRM_20' || legType !== 'CONFIRMATION_ADD') {
      return `non_confirmation_paid_arm:${arm.armCode}:${legType}`;
    }
    if (sizeUsd <= 0) return null;
    const watch = signal.watch ?? {};
    const eventAt = watch.latestEventAt ?? signal.t0;
    const eventAgeMs = Math.max(0, Date.now() - new Date(eventAt).getTime());
    if (eventAgeMs > SOLANA_FLOW_V2_CONFIG.maxPaidEntryLatencyMs) {
      return `stale_market_event_${eventAgeMs}ms`;
    }
    const flow = flowSnapshot
      ?? (signal.flowSnapshot as AnyRow | null)
      ?? (signal.confirmationSnapshot as AnyRow | null);
    const buyers = Number(flow?.latestWindowBuyers ?? 0);
    const buyVolume = Number(flow?.buyVolumeUsd ?? 0);
    const slots = Number(flow?.distinctSlots ?? 0);
    if (!(buyers > 0 && buyVolume > 0 && slots >= SOLANA_FLOW_V2_CONFIG.minDistinctSlots)) {
      return 'empty_or_thin_flow';
    }
    if (flow?.topThreeBuyerShare != null &&
      Number(flow.topThreeBuyerShare) > SOLANA_FLOW_V2_CONFIG.maxTopThreeBuyerShare) {
      return 'concentrated_buyers';
    }
    if (flow?.creatorSell) return 'creator_sell';
    return this.serialCreatorBlockReason(signal.watch?.creatorAddress ?? null);
  }

  /** Block paid capital when this creator already dumped on a prior watched launch. */
  private async serialCreatorBlockReason(creatorAddress: string | null): Promise<string | null> {
    if (!creatorAddress) return null;
    const prior = await (this.prisma as any).solanaPaperArm.findFirst({
      where: {
        outcomeClass: 'CREATOR_EXIT',
        signal: { watch: { creatorAddress } },
      },
      select: { id: true },
    });
    return prior ? 'prior_creator_exit' : null;
  }

  private async backfill(): Promise<void> {
    if (Date.now() < this.rpcBackoffUntil) return;
    if (this.backfillBusy || this.draining || this.lifecycleBusy || this.queued.size > 0) return;
    this.backfillBusy = true;
    try {
      for (const descriptor of solanaProgramDescriptors().filter((item) => item.launchProgram)) {
        const cursor = await (this.prisma as any).solanaProgramCursor.findUnique({
          where: { programId: descriptor.programId },
        });
        if (!cursor?.lastBackfillSignature) continue;
        try {
          const configuredMaximum = Math.max(
            1,
            this.config.get<number>('solanaLaunch.maxTransactionsPerCycle') ?? 40,
          );
          const maximum = this.isPublicRpc() ? Math.min(configuredMaximum, 10) : configuredMaximum;
          const requestDelayMs = this.rpcRequestDelayMs();
          const rows = await this.quotes.runRpc(() => this.quotes.connection.getSignaturesForAddress(
            new PublicKey(descriptor.programId),
            { until: cursor.lastBackfillSignature, limit: maximum + 1 },
            'confirmed',
          ), 'P3');
        if (rows.length > maximum) {
          const liveLag = cursor.lastSeenSlot == null || this.latestHeadSlot <= 0
            ? Number.POSITIVE_INFINITY
            : Math.max(0, this.latestHeadSlot - Number(cursor.lastSeenSlot));
          const liveStreamCurrent = Boolean(cursor.streamConnected && liveLag <= 16);
          await (this.prisma as any).solanaProgramCursor.update({
            where: { programId: descriptor.programId },
            data: {
              lastBackfillSignature: rows[0].signature,
              unresolvedGap: !liveStreamCurrent,
              healthSnapshot: json({
                reason: liveStreamCurrent
                  ? 'historical_backfill_truncated_live_stream_current'
                  : 'backfill_range_exceeded_public_rpc_budget',
                skipped: rows.length,
                liveLag,
              }),
            },
          });
          this.logger.warn(
            `Solana backfill truncated program=${descriptor.programId} missing>${maximum} ` +
            `liveStreamCurrent=${liveStreamCurrent}`,
          );
            continue;
          }
          let failed = false;
          let rateLimited = false;
          for (const row of [...rows].reverse()) {
            try {
              await this.processSignature(row.signature, 'BACKFILL', row.slot, 'P3');
              if (requestDelayMs > 0) await delay(requestDelayMs);
            } catch (error) {
              failed = true;
              if (isRateLimit(error)) {
                rateLimited = true;
                this.openRpcBackoff();
              }
              break;
            }
          }
          const previousHealth = cursor.healthSnapshot as AnyRow | null;
          const permanentGap = Boolean(
            cursor.unresolvedGap && previousHealth?.reason === 'backfill_range_exceeded_public_rpc_budget',
          );
          const caughtUp = !failed && !permanentGap;
          const state = this.streamStates.get(descriptor.programId);
          if (caughtUp && state) state.awaitingCatchUp = false;
          await (this.prisma as any).solanaProgramCursor.update({
            where: { programId: descriptor.programId },
            data: {
              ...(failed ? {} : { lastBackfillSignature: rows[0]?.signature ?? cursor.lastBackfillSignature }),
              unresolvedGap: permanentGap || (failed && !rateLimited),
              // Connected only when the live subscription itself is fresh —
              // a successful poll-based backfill is not a live stream.
              streamConnected: this.isStreamFresh(descriptor.programId),
              healthSnapshot: failed
                ? json({ reason: rateLimited ? 'transient_rate_limit' : 'backfill_failed' })
                : permanentGap ? cursor.healthSnapshot : json({ recoveredAt: new Date().toISOString() }),
            },
          });
        } catch (error) {
          this.rpcFailures++;
          const rateLimited = isRateLimit(error);
          await (this.prisma as any).solanaProgramCursor.update({
            where: { programId: descriptor.programId },
            data: rateLimited
              ? {
                rpcFailures: { increment: 1 },
                healthSnapshot: json({ reason: 'transient_rate_limit' }),
              }
              : {
                unresolvedGap: true, rpcFailures: { increment: 1 }, streamConnected: false,
                healthSnapshot: json({ reason: this.describe(error) }),
              },
          });
          this.logger.warn(`Solana backfill failed program=${descriptor.programId}: ${this.describe(error)}`);
          if (rateLimited) {
            this.openRpcBackoff();
            break;
          }
        }
      }
      await this.backfillWatchedPools();
    } finally {
      this.backfillBusy = false;
      if (this.queued.size) void this.drainQueue();
    }
  }

  private async backfillWatchedPools(): Promise<void> {
    if (Date.now() < this.rpcBackoffUntil) return;
    const batchSize = Math.max(1, this.config.get<number>('solanaLaunch.watchBackfillBatchSize') ?? 5);
    const configuredMaximum = Math.max(1, this.config.get<number>('solanaLaunch.maxTransactionsPerCycle') ?? 40);
    const maximum = this.isPublicRpc() ? Math.min(configuredMaximum, 10) : configuredMaximum;
    const requestDelayMs = this.rpcRequestDelayMs();
    const watches = await (this.prisma as any).solanaLaunchWatch.findMany({
      where: {
        id: { in: [...this.poolSubscriptions.keys()] },
        invalidatedAt: null,
      },
      orderBy: { updatedAt: 'asc' },
      take: batchSize,
    });
    for (const watch of watches) {
      try {
        if (!watch.lastObservedSignature) {
          const latest = await this.quotes.runRpc(() => this.quotes.connection.getSignaturesForAddress(
            new PublicKey(watch.poolAddress), { limit: 1 }, 'confirmed',
          ), 'P1');
          await (this.prisma as any).solanaLaunchWatch.update({
            where: { id: watch.id }, data: { lastObservedSignature: latest[0]?.signature ?? null },
          });
          continue;
        }
        const rows = await this.quotes.runRpc(() => this.quotes.connection.getSignaturesForAddress(
          new PublicKey(watch.poolAddress),
          { until: watch.lastObservedSignature, limit: maximum + 1 },
          'confirmed',
        ), 'P1');
        if (!rows.length) {
          await (this.prisma as any).solanaLaunchWatch.update({ where: { id: watch.id }, data: {} });
          continue;
        }
        await this.markWatchDegraded(watch.id, 'pool_stream_backfill');
        if (rows.length > maximum) {
          await (this.prisma as any).solanaLaunchWatch.update({
            where: { id: watch.id },
            data: { lastObservedSignature: rows[0].signature, unresolvedGap: true },
          });
          continue;
        }
        let failed = false;
        for (const row of [...rows].reverse()) {
          try {
            await this.processSignature(row.signature, 'BACKFILL', row.slot, 'P1');
            if (requestDelayMs > 0) await delay(requestDelayMs);
          } catch (error) {
            failed = true;
            if (isRateLimit(error)) {
              this.openRpcBackoff();
            }
            break;
          }
        }
        await (this.prisma as any).solanaLaunchWatch.update({
          where: { id: watch.id },
          data: {
            unresolvedGap: failed || Boolean(watch.unresolvedGap),
            ...(!failed ? { lastObservedSignature: rows[0].signature } : {}),
          },
        });
        if (failed) break;
      } catch (error) {
        this.rpcFailures++;
        await this.markWatchDegraded(watch.id, this.describe(error));
        if (isRateLimit(error)) {
          this.openRpcBackoff();
          break;
        }
      }
    }
  }

  private async markWatchDegraded(watchId: string, reason: string): Promise<void> {
    await Promise.all([
      (this.prisma as any).solanaLaunchWatch.update({
        where: { id: watchId },
        data: {
          unresolvedGap: true, benchmarkEligible: false, discoveryCohort: 'DEGRADED_SHADOW',
          healthSnapshot: json({ unresolvedGap: true, reason }),
        },
      }),
      (this.prisma as any).solanaExperimentSignal.updateMany({
        where: { watchId }, data: { benchmarkEligible: false, riskCohort: 'EXECUTABLE_SHADOW' },
      }),
    ]);
  }

  private async finalizeRecentWatches(): Promise<void> {
    const watches = await (this.prisma as any).solanaLaunchWatch.findMany({
      where: { finalized: false, invalidatedAt: null, launchedAt: { gte: new Date(Date.now() - 10 * 60_000) } },
      take: 100,
    });
    if (!watches.length) return;
    const statuses = await this.quotes.runRpc(() => this.quotes.connection.getSignatureStatuses(
      watches.map((watch: AnyRow) => watch.discoverySignature),
      { searchTransactionHistory: true },
    ), 'P3');
    for (let index = 0; index < watches.length; index++) {
      const watch = watches[index];
      const status = statuses.value[index];
      if (status?.confirmationStatus === 'finalized' && !status.err) {
        await (this.prisma as any).solanaLaunchWatch.update({ where: { id: watch.id }, data: { finalized: true } });
      } else if (!status && Date.now() - watch.launchedAt.getTime() > 120_000) {
        await this.invalidateReorg(watch);
      }
    }
  }

  private async resolveCompletedSignals(): Promise<void> {
    const candidates = await (this.prisma as any).solanaExperimentSignal.findMany({
      where: { status: { in: ['CONFIRMED', 'EXPIRED'] } },
      include: { arms: true },
      take: 200,
    });
    const terminal = new Set(['CLOSED', 'FAILED', 'REORG_INVALIDATED']);
    for (const signal of candidates) {
      if (!signal.arms.length || signal.arms.some((arm: AnyRow) => !terminal.has(arm.status))) continue;
      await (this.prisma as any).solanaExperimentSignal.update({
        where: { id: signal.id },
        data: {
          status: 'RESOLVED',
          resolvedAt: new Date(),
          resolutionReason: signal.resolutionReason ?? (signal.confirmedAt ? 'arms_completed' : 'no_confirmation'),
        },
      });
      await this.unsubscribeWatch(signal.watchId);
    }
  }

  private async invalidateReorg(watch: AnyRow): Promise<void> {
    const now = new Date();
    await (this.prisma as any).solanaLaunchWatch.update({
      where: { id: watch.id }, data: {
        status: 'REORG_INVALIDATED', invalidatedAt: now, resolutionReason: 'discovery_signature_not_finalized',
        benchmarkEligible: false,
      },
    });
    await (this.prisma as any).solanaExperimentSignal.updateMany({
      where: { watchId: watch.id }, data: {
        status: 'REORG_INVALIDATED', resolvedAt: now, resolutionReason: 'discovery_signature_not_finalized',
        benchmarkEligible: false,
      },
    });
    await (this.prisma as any).solanaPaperArm.updateMany({
      where: { signal: { watchId: watch.id } }, data: {
        status: 'REORG_INVALIDATED', closedAt: now, outcomeClass: 'REORG_INVALIDATED',
      },
    });
    await this.unsubscribeWatch(watch.id);
  }

  private async updateLiveCursor(programId: string, slot: number, signature: string | null): Promise<void> {
    // A live event proves the subscription works, but it does NOT prove the
    // missed range was recovered: unresolvedGap is only cleared by a full
    // backfill catch-up (see backfill()).
    await (this.prisma as any).solanaProgramCursor.update({
      where: { programId },
      data: {
        lastSeenSlot: BigInt(slot),
        ...(signature ? { lastBackfillSignature: signature } : {}),
        streamConnected: true,
        healthSnapshot: json({ liveEventAt: new Date().toISOString(), slot }),
      },
    }).catch(() => undefined);
  }

  private async logHealth(): Promise<void> {
    const now = Date.now();
    const head = this.latestHeadSlot;
    const launchProgramIds = solanaProgramDescriptors()
      .filter((item) => item.launchProgram)
      .map((item) => item.programId);
    const [
      cursors, watching, active, pendingConfirmations, overdueConfirmations, open, cohortRows, observationsTotal,
    ] = await Promise.all([
      (this.prisma as any).solanaProgramCursor.findMany({ where: { programId: { in: launchProgramIds } } }),
      (this.prisma as any).solanaLaunchWatch.count({ where: { status: 'WATCHING' } }),
      (this.prisma as any).solanaExperimentSignal.count({ where: { status: { in: ['ACTIVE', 'CONFIRMED'] } } }),
      (this.prisma as any).solanaExperimentSignal.count({
        where: { status: 'ACTIVE', confirmationDueAt: { gte: new Date(now) } },
      }),
      (this.prisma as any).solanaExperimentSignal.count({
        where: { status: 'ACTIVE', confirmationDueAt: { lt: new Date(now) } },
      }),
      (this.prisma as any).solanaPaperArm.count({ where: { status: 'OPEN' } }),
      (async () => (this.prisma as any).solanaExperimentSignal.groupBy?.({
        by: ['riskCohort'], _count: { _all: true },
      }) ?? [])().catch(() => [] as AnyRow[]),
      (async () => (this.prisma as any).solanaSwapObservation?.count?.() ?? -1)().catch(() => -1),
    ]);
    const queueLag = this.currentQueueLag(head);
    const cohorts = new Map<string, number>(
      (cohortRows as AnyRow[]).map((row) => [String(row.riskCohort), Number(row._count?._all ?? 0)]),
    );
    // Truthful stream state: a venue is healthy only when its live
    // subscription is fresh AND its backfill cursor has no unresolved gap.
    const venueLines: string[] = [];
    let healthyStreams = 0;
    let reconnecting = 0;
    let gaps = 0;
    for (const cursor of cursors as AnyRow[]) {
      const state = this.streamStates.get(cursor.programId);
      const lastSlot = cursor.lastSeenSlot == null ? 0 : Number(cursor.lastSeenSlot);
      const lag = head > 0 && lastSlot > 0 ? Math.max(0, head - lastSlot) : -1;
      const lastEventMs = state?.lastEventAtMs ?? cursor.updatedAt.getTime();
      const sinceEventSec = Math.round(Math.max(0, now - lastEventMs) / 1000);
      const isReconnecting = Boolean(state && state.reconnectAt > 0);
      const fresh = this.isStreamFresh(cursor.programId, now);
      const connected = Boolean(cursor.streamConnected) && fresh;
      const gap = Boolean(cursor.unresolvedGap);
      if (gap) gaps++;
      if (isReconnecting) reconnecting++;
      if (connected && !gap) healthyStreams++;
      venueLines.push(
        `${cursor.venue}: lastSlot=${lastSlot} lag=${lag} sinceEventSec=${sinceEventSec} ` +
        `connected=${connected} reconnecting=${isReconnecting} gap=${gap} rpcFailures=${cursor.rpcFailures}`,
      );
    }
    const mode = gaps > 0 || healthyStreams < cursors.length ||
      queueLag > SOLANA_FLOW_V2_CONFIG.maxPrimaryLagSlots || now < this.rpcBackoffUntil
      ? 'DEGRADED_SHADOW'
      : 'PRIMARY_READY';
    this.logger.log(
      `SOLANA V2.2 HEALTH mode=${mode} head=${head} queueLag=${queueLag} ` +
      `streams=${healthyStreams}/${cursors.length} reconnecting=${reconnecting} gaps=${gaps} queued=${this.queued.size} ` +
      `queueWaitMsAvg=${this.queueWaitSamples ? Math.round(this.queueWaitTotalMs / this.queueWaitSamples) : 0} ` +
      `p0ExitQueue=${this.p0ExitQueue.size} p0ExitDelayMsAvg=${this.p0ExitDelaySamples ? Math.round(this.p0ExitDelayTotalMs / this.p0ExitDelaySamples) : 0} ` +
      `droppedOrExpiredJobs=${this.droppedOrExpiredJobs} ` +
      `watching=${watching} signals=${active} pendingConfirmations=${pendingConfirmations} ` +
      `overdueConfirmations=${overdueConfirmations} openArms=${open} ` +
      `poolStreams=${this.poolSubscriptions.size}/${this.maxPoolSubscriptions()} ` +
      `flowObsTotal=${observationsTotal} flowObsSession=${this.swaps} ` +
      `primary=${cohorts.get('PRIMARY') ?? 0} shadow=${cohorts.get('EXECUTABLE_SHADOW') ?? 0} ` +
      `observation=${cohorts.get('MARKET_OBSERVATION') ?? 0} ` +
      `discovered=${this.discovered} confirmations=${this.confirmations} entries=${this.entries} exits=${this.exits} ` +
      `rpcErrors=${this.rpcFailures} rpcBackoffMs=${Math.max(0, this.rpcBackoffUntil - now)} ` +
      `rateLimitStrikes=${this.rpcRateLimitStrikes}`,
    );
    if (venueLines.length) this.logger.log(`SOLANA V2.2 STREAMS ${venueLines.join(' | ')}`);
  }

  private logEntry(
    signal: AnyRow,
    arm: AnyRow,
    quote: SolanaRoundTripQuote,
    sizeUsd: number,
    legType: string,
    executedAt: Date,
    flow?: AnyRow | null,
  ): void {
    const watch = signal.watch;
    this.files.logPaperEntry({
      ts: executedAt.toISOString(), run_id: arm.id, schema_version: CSV_SCHEMA_VERSION,
      chain: 'solana', token_address: watch.mintAddress, symbol: watch.symbol ?? watch.mintAddress.slice(0, 6),
      pool_address: watch.poolAddress, liquidity_model: quote.quoteModel,
      first_seen_at: watch.launchedAt.toISOString(), detection_delay_sec: String((executedAt.getTime() - watch.launchedAt.getTime()) / 1000),
      opened_at: executedAt.toISOString(), size_usd: String(sizeUsd), spot_price_usd: String(quote.spotPriceUsd),
      entry_price_effective_usd: String((sizeUsd + quote.gasUsd) / quote.entryTokens),
      slippage_pct: String(quote.buySlippagePct), sandwich_pct: '0', gas_usd: String(quote.gasUsd), buy_tax_pct: '0',
      tokens_bought: String(quote.entryTokens), onchain_liq_entry_usd: String(quote.executableDepthUsd),
      entered: 'true', not_entered_reason: '', final_score: '', band: '', score_confidence: '',
      deployer_address: watch.creatorAddress ?? '', deployer_deployments_count: '', deployer_rug_count: '',
      lp_locked: '', lp_lock_source: '', lp_lock_fraction: '', discovery_source: 'solana_program_stream',
      risk_cohort: signal.riskCohort, strategy_version: signal.strategyVersion ?? SOLANA_MULTI_LAUNCH_STRATEGY,
      exit_policy: 'SOLANA_V2_80_15_5_LADDER', benchmark_eligible: String(signal.benchmarkEligible),
      trigger_unique_buyers: '', trigger_buy_quote_usd: '', trigger_buy_sell_ratio: '', trigger_price_momentum: '',
      experiment_id: signal.id, experiment_arm: arm.armCode, execution_scenario: 'CONFIRMED_RPC',
      execution_leg: legType, config_hash: signal.configHash ?? SOLANA_FLOW_V2_CONFIG_HASH,
      target_execution_at: executedAt.toISOString(), executed_at: executedAt.toISOString(),
      confirmation_status: signal.status,
      venue: watch.venue, discovery_slot: String(watch.discoverySlot), discovery_signature: watch.discoverySignature,
      source_program: watch.programId, quote_model: quote.quoteModel,
      flow_snapshot: JSON.stringify(flow ?? signal.flowSnapshot ?? {}),
      data_health: JSON.stringify(signal.healthSnapshot ?? {}),
      signal_latency_ms: String(executedAt.getTime() - signal.t0.getTime()),
      note: [
        `leg=${legType}`,
        `venue=${watch.venue}`,
        `cohort=${signal.riskCohort}`,
        `benchmark=${String(signal.benchmarkEligible)}`,
        `quote=${quote.quoteModel}`,
      ].join(';'),
    } as any);
  }

  private logExit(
    signal: AnyRow,
    arm: AnyRow,
    watch: AnyRow,
    quote: { netUsd: number; grossUsd: number; slippagePct: number },
    eventType: string,
    multiple: number,
    amountRaw: bigint,
    outcome: string | null,
    executedAt: Date,
    flow?: AnyRow | null,
    executionHealth?: AnyRow | null,
    targetAt?: Date,
  ): void {
    const original = BigInt(arm.tokensBoughtRaw || '0');
    const fraction = original > 0n ? Number(amountRaw) / Number(original) : 0;
    const dataHealth = {
      ...((signal.healthSnapshot as AnyRow) ?? {}),
      ...(executionHealth ? { execution: executionHealth } : {}),
    };
    this.files.logPaperExit({
      ts: executedAt.toISOString(), run_id: arm.id, schema_version: CSV_SCHEMA_VERSION,
      chain: 'solana', token_address: watch.mintAddress, symbol: watch.symbol ?? watch.mintAddress.slice(0, 6),
      pool_address: watch.poolAddress, event_type: eventType, status: arm.status,
      price_usd: '', multiple: String(multiple), fraction: String(fraction), tokens: amountRaw.toString(),
      net_usd: String(quote.netUsd), slip_pct: String(quote.slippagePct),
      realized_multiple_total: String(arm.realizedMultiple ?? ''),
      note: this.exitNote(eventType, outcome, multiple, executionHealth),
      deployer_address: watch.creatorAddress ?? '', deployer_deployments_count: '', deployer_rug_count: '',
      outcome_class: outcome ?? '', strategy_version: signal.strategyVersion ?? SOLANA_MULTI_LAUNCH_STRATEGY,
      risk_cohort: signal.riskCohort ?? '', exit_policy: 'SOLANA_V2_80_15_5_LADDER',
      experiment_id: signal.id ?? '', experiment_arm: arm.armCode,
      execution_scenario: executionHealth?.degraded ? 'DEGRADED_RECOVERY' : 'CONFIRMED_RPC',
      execution_leg: eventType, config_hash: signal.configHash ?? SOLANA_FLOW_V2_CONFIG_HASH,
      target_execution_at: (targetAt ?? executedAt).toISOString(), executed_at: executedAt.toISOString(),
      venue: watch.venue, discovery_slot: String(watch.discoverySlot), discovery_signature: watch.discoverySignature,
      source_program: watch.programId, quote_model: 'VENUE_EXIT_QUOTE',
      flow_snapshot: JSON.stringify(flow ?? signal.flowSnapshot ?? {}),
      data_health: JSON.stringify(dataHealth),
      signal_latency_ms: String(executedAt.getTime() - (signal.t0?.getTime?.() ?? executedAt.getTime())),
    } as any);
  }

  private async runIsolated(name: string, operation: () => Promise<void>): Promise<void> {
    try {
      await operation();
    } catch (error) {
      this.rpcFailures++;
      if (isRateLimit(error)) {
        this.openRpcBackoff();
      }
      this.logger.warn(`Solana v2 ${name} failed: ${this.describe(error)}`);
    }
  }

  private exitNote(
    eventType: string,
    outcome: string | null,
    multiple: number,
    executionHealth?: AnyRow | null,
  ): string {
    const fragments = [
      `event=${eventType}`,
      `outcome=${outcome ?? 'PARTIAL'}`,
      `executable_multiple=${Number.isFinite(multiple) ? multiple.toFixed(4) : 'unknown'}`,
    ];
    if (executionHealth?.executionDelayMs != null) fragments.push(`execution_delay_ms=${executionHealth.executionDelayMs}`);
    if (executionHealth?.delayReason) fragments.push(`delay_reason=${executionHealth.delayReason}`);
    if (executionHealth?.degraded) fragments.push('data_health=DEGRADED');
    return fragments.join(';');
  }

  private describe(error: unknown): string {
    return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }

  private isPublicRpc(): boolean {
    return /api\.mainnet-beta\.solana\.com/i.test(this.config.get<string>('solanaLaunch.rpcUrl') ?? '');
  }

  private maxPoolSubscriptions(): number {
    const configured = Math.max(
      1,
      this.config.get<number>('solanaLaunch.maxActivePoolSubscriptions') ?? (this.isPublicRpc() ? 8 : 100),
    );
    return this.isPublicRpc() ? Math.min(configured, 8) : configured;
  }

  private openArmEvalIntervalMs(): number {
    return Math.max(5_000, this.config.get<number>('solanaLaunch.openArmEvalIntervalMs') ?? 30_000);
  }

  /** A live cursor with no valid update inside this window is considered stale. */
  private streamFreshnessMs(): number {
    return Math.max(15_000, this.config.get<number>('solanaLaunch.streamFreshnessMs') ?? 90_000);
  }

  /** Slot-based staleness bound (~400ms per slot; 225 slots ≈ 90s). */
  private streamFreshnessSlots(): number {
    return Math.max(25, this.config.get<number>('solanaLaunch.streamFreshnessSlots') ?? 225);
  }

  private streamWatchdogMs(): number {
    return Math.max(5_000, this.config.get<number>('solanaLaunch.streamWatchdogMs') ?? 10_000);
  }

  private reconnectBackoffMs(attempt: number): number {
    const base = Math.max(1_000, this.config.get<number>('solanaLaunch.streamReconnectBaseMs') ?? 5_000);
    const maximum = Math.max(base, this.config.get<number>('solanaLaunch.streamReconnectMaxMs') ?? 120_000);
    return Math.min(maximum, base * 2 ** Math.min(Math.max(0, attempt - 1), 6));
  }

  private confirmationSweepMs(): number {
    return Math.max(5_000, this.config.get<number>('solanaLaunch.confirmationSweepMs') ?? 10_000);
  }

  /** Executions recorded later than this after their target are degraded data. */
  private executionTimelinessMs(): number {
    return Math.max(5_000, this.config.get<number>('solanaLaunch.executionTimelinessMs') ?? 60_000);
  }

  private pendingWatchTimeoutMs(): number {
    return Math.max(30_000, this.config.get<number>('solanaLaunch.pendingWatchTimeoutMs') ?? 120_000);
  }

  private rpcRequestDelayMs(): number {
    const configured = Math.max(0, this.config.get<number>('solanaLaunch.rpcMinRequestIntervalMs') ?? 250);
    return this.isPublicRpc() ? Math.max(configured, 250) : configured;
  }

  private currentQueueLag(head = this.latestHeadSlot): number {
    const queuedSlots = [...this.queued.values()].map((meta) => meta.slot).filter((slot) => slot > 0);
    return head > 0 && queuedSlots.length > 0 ? Math.max(0, head - Math.min(...queuedSlots)) : 0;
  }

  private openRpcBackoff(): void {
    const now = Date.now();
    if (now - this.lastRateLimitAt > 60_000) this.rpcRateLimitStrikes = 0;
    this.lastRateLimitAt = now;
    this.rpcRateLimitStrikes++;
    const configured = Math.max(5_000, this.config.get<number>('solanaLaunch.rateLimitBackoffMs') ?? 10_000);
    const duration = this.isPublicRpc()
      ? Math.min(60_000, configured * (2 ** Math.min(this.rpcRateLimitStrikes - 1, 3)))
      : configured;
    this.rpcBackoffUntil = Math.max(this.rpcBackoffUntil, Date.now() + duration);
  }
}

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value, (_key, child) => typeof child === 'bigint' ? child.toString() : child));
}

function queuePriority(priority: QueueMeta['priority']): number {
  return priority === 'P1' ? 1 : priority === 'P2' ? 2 : 3;
}

function rawToNumber(raw: bigint, decimals: number): number {
  const scale = 10n ** BigInt(decimals);
  return Number(raw / scale) + Number(raw % scale) / Number(scale);
}

function safeRatio(numerator: number, denominator: number): number {
  return denominator > 0 && Number.isFinite(numerator) ? numerator / denominator : 0;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimit(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b429\b|too many requests|rate.?limit/i.test(message);
}

function classifyExitOutcome(eventType: string, realizedMultiple: number): string {
  if (eventType === 'NO_CONFIRMATION_SELL') {
    return realizedMultiple > 1 ? 'NO_CONFIRMATION_PROFIT' : 'NO_CONFIRMATION_LOSS';
  }
  if (realizedMultiple >= 1) return 'WIN';
  if (eventType === 'HARD_STOP_SELL') return 'STOP_LOSS';
  if (eventType === 'CREATOR_SELL') return 'CREATOR_EXIT';
  if (eventType === 'PROBE_EXPIRED') return 'PROBE_EXPIRED';
  if (eventType === 'TIME_SELL') return 'TIME_LOSS';
  return 'RISK_EXIT';
}
