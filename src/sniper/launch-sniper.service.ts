import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { addTrade, evaluateEntryTrigger, recentBuySellRatio } from './launch-strategy';
import { FourMemePollResult, FourMemeSourceService } from './four-meme-source.service';
import { PaperSniperEngine } from './paper-sniper-engine';
import { SniperJournalService } from './sniper-journal.service';
import {
  EntryTriggerConfig,
  FourMemeEvent,
  LaunchTradeEvent,
  LaunchState,
  PaperAction,
  PaperSniperConfig,
  SNIPER_STRATEGY_VERSION,
  SniperAddress,
  SniperJournalRecord,
  SniperPaperPosition,
} from './sniper.types';

interface PersistedSniperState {
  cursor: string | null;
  launches: LaunchState[];
  positions: SniperPaperPosition[];
  seenEventIds: string[];
}

@Injectable()
export class LaunchSniperService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LaunchSniperService.name);
  private readonly enabled: boolean;
  private readonly mode: string;
  private readonly pollIntervalMs: number;
  private readonly pollErrorBackoffMs: number;
  private readonly rateLimitBackoffMs: number;
  private readonly maxPollBackoffMs: number;
  private readonly maxTrackedLaunches: number;
  private readonly heartbeatIntervalMs: number;
  private readonly triggerConfig: EntryTriggerConfig;
  private readonly paperConfig: PaperSniperConfig;
  private readonly blockedCreators: Set<string>;
  private readonly paperEngine: PaperSniperEngine;
  private readonly launches = new Map<string, LaunchState>();
  private readonly positions = new Map<string, SniperPaperPosition>();
  private readonly seenEventIds = new Set<string>();
  // The API can announce a launch after its first on-chain swaps were already polled.
  // Keep that short gap so a newly discovered token starts with the real early flow.
  private readonly unmatchedTrades = new Map<string, LaunchTradeEvent[]>();
  private cursor: string | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private consecutivePollFailures = 0;
  private nextPollAtMs = 0;
  private lastHeartbeatAtMs = 0;

  constructor(
    config: ConfigService,
    private readonly source: FourMemeSourceService,
    private readonly journal: SniperJournalService,
  ) {
    this.enabled = config.get<boolean>('launchSniper.enabled') ?? false;
    this.mode = config.get<string>('launchSniper.mode') ?? 'paper';
    this.pollIntervalMs = config.get<number>('launchSniper.pollIntervalMs') ?? 2_000;
    this.pollErrorBackoffMs = config.get<number>('launchSniper.pollErrorBackoffMs') ?? 10_000;
    this.rateLimitBackoffMs = config.get<number>('launchSniper.rateLimitBackoffMs') ?? 60_000;
    this.maxPollBackoffMs = config.get<number>('launchSniper.maxPollBackoffMs') ?? 300_000;
    this.maxTrackedLaunches = config.get<number>('launchSniper.maxTrackedLaunches') ?? 2_000;
    this.heartbeatIntervalMs = config.get<number>('launchSniper.heartbeatIntervalMs') ?? 30_000;
    this.triggerConfig = config.get<EntryTriggerConfig>('launchSniper.trigger')!;
    this.paperConfig = config.get<PaperSniperConfig>('launchSniper.paper')!;
    this.blockedCreators = new Set(
      (config.get<string[]>('launchSniper.blockedCreators') ?? []).map((address) => address.toLowerCase()),
    );
    this.paperEngine = new PaperSniperEngine(this.paperConfig);
  }

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.log('Launch sniper disabled');
      return;
    }
    if (this.mode !== 'paper') {
      throw new Error(`Unsafe launch sniper mode "${this.mode}" rejected: only paper is implemented`);
    }
    if (!this.source.isConfigured()) {
      this.logger.error('Launch sniper enabled but BSC_RPC_URL is missing; paper watcher not started');
      return;
    }
    this.journal.ensureProcessLock();
    this.restoreState();
    this.interval = setInterval(() => void this.runOnce(), this.pollIntervalMs);
    this.logger.log(
      `Launch sniper scheduled: Four.meme/BSC, paper-only, interval=${this.pollIntervalMs}ms, ` +
      `strategy=${SNIPER_STRATEGY_VERSION}`,
    );
    void this.runOnce();
  }

  onModuleDestroy(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
    this.persistState();
  }

  async runOnce(): Promise<void> {
    if (this.polling || Date.now() < this.nextPollAtMs) return;
    this.polling = true;
    try {
      const result = await this.source.poll(this.cursor);
      if (result.skippedRange) {
        this.record('STALE_RPC_GAP_SKIPPED', {
          fromBlock: result.skippedRange.fromBlock,
          toBlock: result.skippedRange.toBlock,
          reason: 'outside_launch_strategy_window',
        });
        this.logger.warn(
          `Skipped stale BSC blocks ${result.skippedRange.fromBlock}-${result.skippedRange.toBlock}`,
        );
      }
      const touchedTokens = new Set<string>();
      for (const event of result.events) {
        if (this.seenEventIds.has(event.id)) continue;
        this.rememberEvent(event.id);
        this.record(`SOURCE_${event.kind}`, event as unknown as Record<string, unknown>);
        await this.processEvent(event, touchedTokens);
      }
      this.cursor = result.cursor;
      await this.evaluateOpenPositions(touchedTokens, Date.now());
      this.expireStaleLaunches(Date.now());
      this.pruneUnmatchedTrades(Date.now());
      this.pruneLaunches();
      this.persistState();
      this.logHeartbeat(result, Date.now());
      if (this.consecutivePollFailures > 0) {
        this.logger.log(`BSC RPC recovered after ${this.consecutivePollFailures} failed poll(s)`);
        this.record('RPC_RECOVERED', { failedPolls: this.consecutivePollFailures });
      }
      this.consecutivePollFailures = 0;
      this.nextPollAtMs = 0;
    } catch (error) {
      const message = (error as Error).message;
      const rateLimited = isRateLimitError(message);
      this.consecutivePollFailures += 1;
      const baseBackoff = rateLimited ? this.rateLimitBackoffMs : this.pollErrorBackoffMs;
      const backoffMs = Math.min(
        this.maxPollBackoffMs,
        baseBackoff * (2 ** Math.min(this.consecutivePollFailures - 1, 4)),
      );
      this.nextPollAtMs = Date.now() + backoffMs;
      this.logger.warn(
        `Launch sniper poll failed; retrying in ${Math.ceil(backoffMs / 1000)}s: ${message}`,
      );
      this.record('POLL_ERROR', {
        message,
        rateLimited,
        consecutiveFailures: this.consecutivePollFailures,
        backoffMs,
        retryAt: new Date(this.nextPollAtMs).toISOString(),
      });
    } finally {
      this.polling = false;
    }
  }

  private async processEvent(event: FourMemeEvent, touchedTokens: Set<string>): Promise<void> {
    const key = event.token.toLowerCase();
    if (event.kind === 'LAUNCH_CREATED') {
      if (this.launches.has(key)) return;
      const blocked = this.blockedCreators.has(event.creator.toLowerCase());
      const state: LaunchState = {
        token: event.token,
        creator: event.creator,
        name: event.name,
        symbol: event.symbol,
        launchedAtMs: event.occurredAtMs,
        launchBlockNumber: event.blockNumber,
        firstSeenAtMs: Date.now(),
        status: blocked ? 'REJECTED' : 'WATCHING',
        trades: [],
        creatorSold: false,
        entryAttempted: blocked,
        weakWindowCount: 0,
      };
      this.launches.set(key, state);
      this.record(blocked ? 'LAUNCH_REJECTED' : 'HOT_WATCH_STARTED', {
        token: event.token,
        creator: event.creator,
        symbol: event.symbol,
        reason: blocked ? 'blocked_creator' : 'official_factory_launch',
      });
      if (!blocked) {
        const buffered = this.unmatchedTrades.get(key) ?? [];
        this.unmatchedTrades.delete(key);
        for (const trade of buffered) addTrade(state, trade, this.triggerConfig.windowMs);
        if (buffered.length > 0) {
          touchedTokens.add(key);
          this.record('HOT_WATCH_REPLAYED_TRADES', {
            token: state.token,
            symbol: state.symbol,
            trades: buffered.length,
            buys: buffered.filter((trade) => trade.kind === 'BUY').length,
            sells: buffered.filter((trade) => trade.kind === 'SELL').length,
          });
          await this.tryOpen(state, Date.now());
        }
      }
      return;
    }

    const state = this.launches.get(key);
    if (!state) {
      if (event.kind === 'BUY' || event.kind === 'SELL') this.bufferUnmatchedTrade(event);
      return;
    }
    touchedTokens.add(key);
    if (event.kind === 'TRADE_STOPPED') {
      await this.closeStoppedPosition(state, event.occurredAtMs);
      return;
    }
    addTrade(state, event, this.triggerConfig.windowMs);
    if (state.status === 'WATCHING') await this.tryOpen(state, event.occurredAtMs);
  }

  private async tryOpen(state: LaunchState, nowMs: number): Promise<void> {
    if (state.entryAttempted) return;
    const decision = evaluateEntryTrigger(state, nowMs, this.triggerConfig);
    if (!decision.triggered) {
      if (decision.terminal) {
        state.status = decision.snapshot.creatorSold ? 'REJECTED' : 'EXPIRED';
        state.entryAttempted = true;
        this.record('ENTRY_REJECTED', {
          token: state.token,
          symbol: state.symbol,
          reasons: decision.reasons,
          features: decision.snapshot,
        });
      }
      return;
    }

    const safety = await this.source.readSafety(state.token);
    if (!safety.ok) {
      this.record(safety.retryable ? 'SAFETY_DEFERRED' : 'ENTRY_REJECTED', {
        token: state.token,
        symbol: state.symbol,
        reasons: safety.reasons,
        safety,
        features: decision.snapshot,
      });
      if (!safety.retryable) {
        state.status = 'REJECTED';
        state.entryAttempted = true;
      }
      return;
    }

    const price = decision.snapshot.lastPriceQuotePerToken;
    if (price == null || price <= 0) return;
    const { position, action } = this.paperEngine.open(
      { token: state.token, creator: state.creator, symbol: state.symbol },
      price,
      nowMs,
    );
    state.status = 'OPEN';
    state.entryAttempted = true;
    this.positions.set(state.token.toLowerCase(), position);
    this.recordAction(action, {
      creator: state.creator,
      name: state.name,
      features: decision.snapshot,
      safety,
      quoteAsset: 'BNB',
      positionSizeQuote: position.positionSizeQuote,
      entryEffectivePrice: position.entryEffectivePrice,
    });
    this.logger.log(
      `PAPER ENTER ${state.symbol} ${state.token} buys=${decision.snapshot.buys} ` +
      `unique=${decision.snapshot.uniqueBuyers} flow=${formatRatio(decision.snapshot.buySellRatio)}`,
    );
  }

  private async evaluateOpenPositions(touchedTokens: Set<string>, nowMs: number): Promise<void> {
    for (const [key, position] of this.positions) {
      if (position.status !== 'OPEN') continue;
      const state = this.launches.get(key);
      if (!state) continue;
      const lastTrade = state.trades.at(-1);
      const marketPrice = lastTrade?.priceQuotePerToken ?? position.entryMarketPrice;
      const ratio = recentBuySellRatio(state, nowMs, this.paperConfig.momentumWindowMs);
      const actions = this.paperEngine.evaluate(position, marketPrice, nowMs, ratio);
      for (const action of actions) this.recordAction(action, { recentFlowRatio: ratio });
      if (position.closeReason != null || position.remainingFraction <= 1e-9) {
        state.status = 'CLOSED';
        this.logClose(position);
      } else if (touchedTokens.has(key)) {
        this.record('POSITION_MARK', {
          token: position.token,
          symbol: position.symbol,
          priceQuotePerToken: marketPrice,
          recentFlowRatio: ratio,
          maxNetMultiple: position.maxNetMultiple,
          remainingFraction: position.remainingFraction,
          realizedMultiple: position.realizedQuote / position.positionSizeQuote,
        });
      }
    }
  }

  private async closeStoppedPosition(state: LaunchState, nowMs: number): Promise<void> {
    const position = this.positions.get(state.token.toLowerCase());
    if (!position || position.status !== 'OPEN') {
      state.status = 'REJECTED';
      return;
    }
    const price = state.trades.at(-1)?.priceQuotePerToken ?? position.entryMarketPrice;
    const actions = this.paperEngine.evaluate(position, price, nowMs, 0, true);
    for (const action of actions) this.recordAction(action, { recentFlowRatio: 0 });
    state.status = 'CLOSED';
    this.logClose(position);
  }

  private expireStaleLaunches(nowMs: number): void {
    for (const state of this.launches.values()) {
      if (state.status !== 'WATCHING') continue;
      const ageSec = (nowMs - state.launchedAtMs) / 1000;
      if (ageSec <= this.triggerConfig.maxAgeSec) continue;
      state.status = 'EXPIRED';
      state.entryAttempted = true;
      const decision = evaluateEntryTrigger(state, nowMs, this.triggerConfig);
      this.record('HOT_WATCH_EXPIRED', {
        token: state.token,
        symbol: state.symbol,
        reasons: decision.reasons,
        features: decision.snapshot,
      });
    }
  }

  private logClose(position: SniperPaperPosition): void {
    this.record('POSITION_CLOSED', {
      token: position.token,
      symbol: position.symbol,
      closeReason: position.closeReason,
      realizedMultiple: position.realizedQuote / position.positionSizeQuote,
      maxNetMultiple: position.maxNetMultiple,
      executedRungs: position.executedRungs,
    });
  }

  private logHeartbeat(result: FourMemePollResult, nowMs: number): void {
    if (nowMs - this.lastHeartbeatAtMs < this.heartbeatIntervalMs) return;
    this.lastHeartbeatAtMs = nowMs;
    const watching = [...this.launches.values()].filter((state) => state.status === 'WATCHING').length;
    const open = [...this.positions.values()].filter((position) => position.status === 'OPEN').length;
    const range = result.range
      ? `${result.range.fromBlock}-${result.range.toBlock}`
      : 'caught_up';
    this.logger.log(
      `BSC watcher healthy: blocks=${range} events=${result.events.length} cursor=${result.cursor} ` +
      `watching=${watching} open=${open}`,
    );
    this.record('WATCHER_HEARTBEAT', {
      fromBlock: result.range?.fromBlock ?? null,
      toBlock: result.range?.toBlock ?? null,
      events: result.events.length,
      cursor: result.cursor,
      watching,
      open,
    });
  }

  private recordAction(action: PaperAction, extra: Record<string, unknown>): void {
    this.record(action.type, { ...action, ...extra, actionType: action.type });
  }

  private record(type: string, payload: Record<string, unknown>): void {
    const record = {
      ...payload,
      ts: new Date().toISOString(),
      strategyVersion: SNIPER_STRATEGY_VERSION,
      type,
      chain: 'bsc',
      launchpad: 'four_meme',
    } satisfies SniperJournalRecord;
    this.journal.append(record);
  }

  private restoreState(): void {
    const state = this.journal.readState<PersistedSniperState>();
    if (!state) return;
    this.cursor = state.cursor;
    for (const launch of state.launches ?? []) this.launches.set(launch.token.toLowerCase(), launch);
    for (const position of state.positions ?? []) this.positions.set(position.token.toLowerCase(), position);
    for (const id of state.seenEventIds ?? []) this.seenEventIds.add(id);
    this.logger.log(
      `Launch sniper restored cursor=${this.cursor ?? 'none'} launches=${this.launches.size} ` +
      `open=${[...this.positions.values()].filter((position) => position.status === 'OPEN').length}`,
    );
  }

  private persistState(): void {
    this.journal.writeState({
      cursor: this.cursor,
      launches: [...this.launches.values()],
      positions: [...this.positions.values()],
      seenEventIds: [...this.seenEventIds],
    } satisfies PersistedSniperState);
  }

  private rememberEvent(id: string): void {
    this.seenEventIds.add(id);
    while (this.seenEventIds.size > 20_000) {
      const oldest = this.seenEventIds.values().next().value as string | undefined;
      if (!oldest) break;
      this.seenEventIds.delete(oldest);
    }
  }

  private pruneLaunches(): void {
    if (this.launches.size <= this.maxTrackedLaunches) return;
    const removable = [...this.launches.entries()]
      .filter(([, state]) => state.status !== 'OPEN' && state.status !== 'WATCHING')
      .sort((left, right) => left[1].launchedAtMs - right[1].launchedAtMs);
    for (const [key] of removable) {
      if (this.launches.size <= this.maxTrackedLaunches) break;
      this.launches.delete(key);
      this.positions.delete(key);
    }
  }

  private bufferUnmatchedTrade(event: LaunchTradeEvent): void {
    const key = event.token.toLowerCase();
    const trades = this.unmatchedTrades.get(key) ?? [];
    trades.push(event);
    this.unmatchedTrades.set(key, trades);
  }

  private pruneUnmatchedTrades(nowMs: number): void {
    const expiresAtMs = nowMs - this.triggerConfig.maxAgeSec * 1_000;
    for (const [key, trades] of this.unmatchedTrades) {
      const recent = trades.filter((trade) => trade.occurredAtMs >= expiresAtMs);
      if (recent.length === 0) this.unmatchedTrades.delete(key);
      else this.unmatchedTrades.set(key, recent);
    }
  }
}

function formatRatio(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : 'inf';
}

export function isRateLimitError(message: string): boolean {
  return /(?:too many requests|rate.?limit|\b429\b)/i.test(message);
}
