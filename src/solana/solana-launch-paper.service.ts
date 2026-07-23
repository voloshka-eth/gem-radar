import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { CSV_SCHEMA_VERSION } from '../file-logger/csv-schemas';
import { FileLoggerService } from '../file-logger/file-logger.service';
import {
  entrySlippagePct,
  executablePositionMultiple,
  nextLadderRung,
  normalizeFinishingRate,
  prioritizeRouteProbes,
  tokenAmount,
} from './solana-paper';

const STRATEGY_VERSION = 'solana_raydium_graduation_v1';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDC_DECIMALS = 6;

interface LaunchMintRow {
  mint: string;
  poolId: string;
  creator?: string;
  createAt: number;
  name?: string;
  symbol?: string;
  decimals: number;
  supply: number;
  marketCap: number;
  finishingRate: number;
  mintProgramA?: string;
  mintB?: { address?: string };
  [key: string]: unknown;
}

interface RaydiumQuoteData {
  inputAmount: string;
  outputAmount: string;
  priceImpactPct?: number | string;
  routePlan?: unknown[];
  [key: string]: unknown;
}

interface RaydiumQuoteResponse {
  id?: string;
  success: boolean;
  msg?: string;
  data?: RaydiumQuoteData;
}

interface MintSafety {
  passed: boolean;
  retryable: boolean;
  reasons: string[];
  ownerProgram?: string;
  mintAuthority?: string | null;
  freezeAuthority?: string | null;
  transferFeeBps?: number | null;
}

type Position = any;

@Injectable()
export class SolanaLaunchPaperService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SolanaLaunchPaperService.name);
  private readonly http: AxiosInstance;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private launchBackoffUntilMs = 0;
  private tradeBackoffUntilMs = 0;
  private rpcBackoffUntilMs = 0;
  private lastMintRefreshAtMs = 0;
  private discovered = 0;
  private entries = 0;
  private exits = 0;
  private apiErrors = 0;
  private routeMisses = 0;
  private readonly routeMissReasons = new Map<string, number>();

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly files: FileLoggerService,
  ) {
    this.http = axios.create({
      timeout: this.config.get<number>('solanaLaunch.requestTimeoutMs') ?? 10_000,
      validateStatus: () => true,
    });
  }

  onModuleInit(): void {
    if (!(this.config.get<boolean>('solanaLaunch.enabled') ?? true)) {
      this.logger.log('Solana LaunchLab paper lane disabled');
      return;
    }
    const pollMs = Math.max(3_000, this.config.get<number>('solanaLaunch.pollIntervalMs') ?? 10_000);
    const healthMs = Math.max(10_000, this.config.get<number>('solanaLaunch.healthLogMs') ?? 30_000);
    this.pollTimer = setInterval(() => void this.poll(), pollMs);
    this.healthTimer = setInterval(() => void this.logHealth(), healthMs);
    void this.poll();
    this.logger.log(
      `Solana LaunchLab graduation paper lane started: poll=${pollMs}ms size=$${this.positionSizeUsd()} ` +
      `strategy=${STRATEGY_VERSION} paper-only`,
    );
  }

  onModuleDestroy(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.healthTimer) clearInterval(this.healthTimer);
  }

  private async poll(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.runPollStage('discovery', async () => {
        const rows = await this.fetchLaunches();
        if (rows) await this.discoverAndRefresh(rows);
      });
      await this.runPollStage('mint_refresh', () => this.refreshWatchingMints());
      await this.runPollStage('expiry', () => this.expireWatches());
      await this.runPollStage('watch_evaluation', () => this.evaluateWatching());
      await this.runPollStage('open_evaluation', () => this.evaluateOpenPositions());
    } finally {
      this.busy = false;
    }
  }

  private async runPollStage(name: string, operation: () => Promise<void>): Promise<void> {
    try {
      await operation();
    } catch (error) {
      this.apiErrors++;
      this.logger.warn(`Solana ${name} failed: ${this.describeError(error)}`);
    }
  }

  private describeError(error: unknown): string {
    if (axios.isAxiosError(error)) {
      const status = error.response?.status ?? 'no_status';
      const body = error.response?.data;
      const detail = typeof body === 'string' ? body : JSON.stringify(body ?? null);
      return `axios status=${status} code=${error.code ?? 'none'} message=${error.message || 'none'} body=${detail}`;
    }
    if (error instanceof Error) {
      return `${error.name}: ${error.message.trim() || 'no_message'}`.replace(/\s+/g, ' ');
    }
    return `non_error: ${String(error)}`;
  }

  private async fetchLaunches(): Promise<LaunchMintRow[] | null> {
    if (Date.now() < this.launchBackoffUntilMs) return null;
    const baseUrl = this.config.get<string>('solanaLaunch.launchApiUrl')!;
    const response = await this.http.get(`${baseUrl}/get/list`, { params: { sort: 'new' } });
    if (response.status === 429) {
      this.launchBackoffUntilMs = Date.now() + 60_000;
      this.apiErrors++;
      this.logger.warn('Raydium LaunchLab rate limited; backing off for 60s');
      return null;
    }
    if (response.status < 200 || response.status >= 300 || response.data?.success !== true) {
      throw new Error(`launch_api_${response.status}:${response.data?.msg ?? 'invalid_response'}`);
    }
    return Array.isArray(response.data?.data?.rows) ? response.data.data.rows as LaunchMintRow[] : [];
  }

  private async refreshWatchingMints(): Promise<void> {
    const now = Date.now();
    const refreshIntervalMs = Math.max(
      10_000,
      this.config.get<number>('solanaLaunch.mintRefreshIntervalMs') ?? 30_000,
    );
    if (now < this.launchBackoffUntilMs || now - this.lastMintRefreshAtMs < refreshIntervalMs) return;
    this.lastMintRefreshAtMs = now;

    const positions: Array<{ id: string; mintAddress: string }> = await (this.prisma as any)
      .solanaLaunchPosition.findMany({
        where: {
          strategyVersion: STRATEGY_VERSION,
          status: 'WATCHING',
          watchExpiresAt: { gt: new Date() },
        },
        select: { id: true, mintAddress: true },
        orderBy: { launchedAt: 'desc' },
        take: 250,
      });
    if (!positions.length) return;

    const batchSize = Math.max(
      1,
      Math.min(100, this.config.get<number>('solanaLaunch.mintRefreshBatchSize') ?? 50),
    );
    const baseUrl = this.config.get<string>('solanaLaunch.launchApiUrl')!;
    for (let offset = 0; offset < positions.length; offset += batchSize) {
      if (Date.now() < this.launchBackoffUntilMs) break;
      const batch = positions.slice(offset, offset + batchSize);
      const response = await this.http.get(`${baseUrl}/get/by/mints`, {
        params: { ids: batch.map((position) => position.mintAddress).join(',') },
      });
      if (response.status === 429) {
        this.launchBackoffUntilMs = Date.now() + 60_000;
        this.apiErrors++;
        this.logger.warn('Raydium mint refresh rate limited; backing off discovery reads for 60s');
        break;
      }
      if (response.status < 200 || response.status >= 300 || response.data?.success !== true) {
        this.apiErrors++;
        this.logger.warn(`Raydium mint refresh failed status=${response.status} msg=${response.data?.msg ?? 'invalid_response'}`);
        continue;
      }

      const rows = Array.isArray(response.data?.data?.rows)
        ? response.data.data.rows as LaunchMintRow[]
        : [];
      const positionByMint = new Map(batch.map((position) => [position.mintAddress, position]));
      const updates = rows
        .filter((row) => this.validLaunch(row) && positionByMint.has(row.mint))
        .map((row) => (this.prisma as any).solanaLaunchPosition.update({
          where: { id: positionByMint.get(row.mint)!.id },
          data: {
            latestLaunchSnapshot: row as unknown as Prisma.InputJsonValue,
            poolAddress: row.poolId,
            quoteMint: row.mintB?.address ?? '',
          },
        }));
      const results = await Promise.allSettled(updates);
      const failed = results.filter((result) => result.status === 'rejected').length;
      if (failed > 0) {
        this.apiErrors += failed;
        this.logger.warn(`Raydium mint refresh DB updates failed=${failed}/${updates.length}`);
      }
    }
  }

  private async discoverAndRefresh(rows: LaunchMintRow[]): Promise<void> {
    const now = Date.now();
    const discoveryAgeMs = this.config.get<number>('solanaLaunch.discoveryAgeMs') ?? 300_000;
    const bootstrapLookbackMs = this.config.get<number>('solanaLaunch.bootstrapLookbackMs') ?? 86_400_000;
    const bootstrapWatchMs = this.config.get<number>('solanaLaunch.bootstrapWatchMs') ?? 1_800_000;
    const watchMs = this.config.get<number>('solanaLaunch.watchMs') ?? 7_200_000;
    const existingCount = await (this.prisma as any).solanaLaunchPosition.count({
      where: { strategyVersion: STRATEGY_VERSION },
    }).catch(() => 0);
    for (const row of rows) {
      if (!this.validLaunch(row)) continue;
      const ageMs = now - row.createAt;
      const existing = await (this.prisma as any).solanaLaunchPosition.findUnique({
        where: { strategyVersion_mintAddress: { strategyVersion: STRATEGY_VERSION, mintAddress: row.mint } },
        select: { id: true },
      }).catch(() => null);
      const bootstrapShadow = !existing && existingCount === 0 && ageMs > discoveryAgeMs && ageMs <= bootstrapLookbackMs;
      if (!existing && !bootstrapShadow && (ageMs < -60_000 || ageMs > discoveryAgeMs)) continue;
      await (this.prisma as any).solanaLaunchPosition.upsert({
        where: { strategyVersion_mintAddress: { strategyVersion: STRATEGY_VERSION, mintAddress: row.mint } },
        create: {
          strategyVersion: STRATEGY_VERSION,
          mintAddress: row.mint,
          poolAddress: row.poolId,
          quoteMint: row.mintB?.address ?? '',
          creatorAddress: row.creator ?? null,
          symbol: row.symbol ?? null,
          name: row.name ?? null,
          decimals: row.decimals,
          launchedAt: new Date(row.createAt),
          watchExpiresAt: new Date(bootstrapShadow ? now + bootstrapWatchMs : row.createAt + watchMs),
          discoveryCohort: bootstrapShadow ? 'BOOTSTRAP_SHADOW' : 'FORWARD_PRIMARY',
          benchmarkEligible: !bootstrapShadow,
          sizeUsd: this.positionSizeUsd(),
          latestLaunchSnapshot: row as unknown as Prisma.InputJsonValue,
        },
        update: {
          latestLaunchSnapshot: row as unknown as Prisma.InputJsonValue,
          poolAddress: row.poolId,
          quoteMint: row.mintB?.address ?? '',
        },
      });
      if (!existing) {
        this.discovered++;
        this.logger.log(
          `SOLANA WATCH ${row.symbol ?? '?'} mint=${row.mint} ` +
          `progress=${(normalizeFinishingRate(row.finishingRate) * 100).toFixed(1)}% ` +
          `cohort=${bootstrapShadow ? 'BOOTSTRAP_SHADOW' : 'FORWARD_PRIMARY'}`,
        );
      }
    }
  }

  private async expireWatches(): Promise<void> {
    await (this.prisma as any).solanaLaunchPosition.updateMany({
      where: { strategyVersion: STRATEGY_VERSION, status: 'WATCHING', watchExpiresAt: { lt: new Date() } },
      data: { status: 'EXPIRED', resolutionReason: 'no_executable_route_before_watch_expiry', closedAt: new Date() },
    });
  }

  private async evaluateWatching(): Promise<void> {
    const positions: Position[] = await (this.prisma as any).solanaLaunchPosition.findMany({
      where: { strategyVersion: STRATEGY_VERSION, status: 'WATCHING', watchExpiresAt: { gt: new Date() } },
      orderBy: { launchedAt: 'desc' },
      take: 250,
    });
    const minProgress = this.config.get<number>('solanaLaunch.routeProbeFinishingRate') ?? 0.95;
    const readyIntervalMs = Math.max(
      5_000,
      this.config.get<number>('solanaLaunch.routeReadyProbeIntervalMs') ?? 15_000,
    );
    const fallbackIntervalMs = Math.max(
      readyIntervalMs,
      this.config.get<number>('solanaLaunch.routeFallbackProbeIntervalMs') ?? 60_000,
    );
    const maxProbes = Math.max(
      1,
      this.config.get<number>('solanaLaunch.maxRouteProbesPerPoll') ?? 10,
    );
    let probes = 0;
    const routeReady = prioritizeRouteProbes(
      positions.filter((position) => position.latestLaunchSnapshot),
      (position) => Number((position.latestLaunchSnapshot as LaunchMintRow).finishingRate),
      (position) => position.lastRouteProbeAt?.getTime?.() ?? null,
      Date.now(),
      minProgress,
      readyIntervalMs,
      fallbackIntervalMs,
    );
    for (const position of routeReady) {
      if (probes >= maxProbes) break;
      const launch = position.latestLaunchSnapshot as LaunchMintRow;
      await (this.prisma as any).solanaLaunchPosition.update({
        where: { id: position.id },
        data: { lastRouteProbeAt: new Date(), routeProbeAttempts: { increment: 1 } },
      });
      probes++;
      try {
        await this.tryOpen(position, launch);
      } catch (error) {
        this.apiErrors++;
        this.recordRouteMiss('watch_evaluation_failed');
        this.logger.warn(
          `Solana watch evaluation failed mint=${position.mintAddress}: ${this.describeError(error)}`,
        );
      }
    }
  }

  private async tryOpen(position: Position, launch: LaunchMintRow): Promise<void> {
    const safety = await this.inspectMint(position.mintAddress);
    if (!safety.passed) {
      if (safety.retryable) {
        await this.deferWatch(position, safety.reasons.join('|'));
        return;
      }
      await (this.prisma as any).solanaLaunchPosition.update({
        where: { id: position.id },
        data: {
          status: 'REJECTED', resolutionReason: safety.reasons.join('|'),
          safetySnapshot: safety as unknown as Prisma.InputJsonValue, closedAt: new Date(),
        },
      });
      return;
    }

    const sizeUsd = Number(position.sizeUsd);
    const [entryQuote, depthQuote] = await Promise.all([
      this.quote(USDC_MINT, position.mintAddress, this.usdcRaw(sizeUsd)),
      this.quote(USDC_MINT, position.mintAddress, this.usdcRaw(100)),
    ]);
    if (!entryQuote?.data || !depthQuote?.data) {
      const reason = !entryQuote?.data ? 'entry_route_unavailable' : 'depth_route_unavailable';
      this.recordRouteMiss(reason);
      await this.deferWatch(position, reason);
      return;
    }
    const spotPriceUsd = Number(launch.marketCap) / Number(launch.supply);
    const entrySlip = entrySlippagePct(sizeUsd, entryQuote.data.outputAmount, position.decimals, spotPriceUsd);
    const depthSlip = entrySlippagePct(100, depthQuote.data.outputAmount, position.decimals, spotPriceUsd);
    if (entrySlip > (this.config.get<number>('solanaLaunch.maxEntrySlippagePct') ?? 0.03) || depthSlip > 0.10) {
      const reason = entrySlip > (this.config.get<number>('solanaLaunch.maxEntrySlippagePct') ?? 0.03)
        ? 'entry_slippage_too_high'
        : 'depth_slippage_too_high';
      this.recordRouteMiss(reason);
      await this.deferWatch(position, reason);
      return;
    }

    const sellQuote = await this.quote(position.mintAddress, USDC_MINT, entryQuote.data.outputAmount);
    if (!sellQuote?.data) {
      this.recordRouteMiss('sell_route_unavailable');
      await this.deferWatch(position, 'sell_route_unavailable');
      return;
    }
    const gasUsd = this.gasUsd();
    const roundTrip = Math.max(0, this.usdcAmount(sellQuote.data.outputAmount) - gasUsd) / sizeUsd;
    if (roundTrip < (this.config.get<number>('solanaLaunch.minRoundTripMultiple') ?? 0.8)) {
      this.recordRouteMiss('round_trip_below_minimum');
      await this.deferWatch(position, 'round_trip_below_minimum');
      return;
    }

    const openedAt = new Date();
    const tokens = tokenAmount(entryQuote.data.outputAmount, position.decimals);
    const committedUsd = sizeUsd + gasUsd;
    const effectivePrice = committedUsd / tokens;
    const entrySnapshot = { entryQuote, depthQuote, sellQuote, spotPriceUsd, entrySlip, depthSlip, roundTrip };
    const updated = await (this.prisma as any).solanaLaunchPosition.update({
      where: { id: position.id },
      data: {
        status: 'OPEN', openedAt, committedUsd, entryPriceEffectiveUsd: effectivePrice,
        resolutionReason: null,
        tokensBoughtRaw: entryQuote.data.outputAmount,
        remainingTokensRaw: entryQuote.data.outputAmount,
        safetySnapshot: safety as unknown as Prisma.InputJsonValue,
        entryQuoteSnapshot: entrySnapshot as unknown as Prisma.InputJsonValue,
        currentMultiple: roundTrip, maxMultipleObserved: roundTrip,
        events: { create: {
          eventType: 'ENTER', ts: openedAt, tokenAmountRaw: entryQuote.data.outputAmount,
          grossUsd: sizeUsd, netUsd: -committedUsd, multiple: roundTrip,
          quoteSnapshot: entrySnapshot as unknown as Prisma.InputJsonValue,
        } },
      },
    });
    this.entries++;
    this.logEntry(updated, launch, entryQuote, safety, spotPriceUsd, entrySlip, gasUsd, tokens, openedAt);
    this.logger.log(
      `SOLANA PAPER ENTER ${position.symbol ?? '?'} mint=${position.mintAddress} ` +
      `slip=${(entrySlip * 100).toFixed(2)}% roundTrip=${roundTrip.toFixed(3)}x`,
    );
  }

  private async evaluateOpenPositions(): Promise<void> {
    const positions: Position[] = await (this.prisma as any).solanaLaunchPosition.findMany({
      where: { strategyVersion: STRATEGY_VERSION, status: 'OPEN' },
      orderBy: { openedAt: 'asc' },
    });
    for (const position of positions) {
      try {
        await this.evaluateOpen(position);
      } catch (error) {
        this.apiErrors++;
        this.logger.warn(
          `Solana open-position evaluation failed mint=${position.mintAddress}: ${this.describeError(error)}`,
        );
      }
    }
  }

  private async evaluateOpen(position: Position): Promise<void> {
    const originalRaw = BigInt(position.tokensBoughtRaw);
    const remainingRaw = BigInt(position.remainingTokensRaw);
    if (remainingRaw <= 0n) return;
    const quote = await this.quote(position.mintAddress, USDC_MINT, remainingRaw.toString());
    if (!quote?.data) return;
    const grossUsd = this.usdcAmount(quote.data.outputAmount);
    const multiple = executablePositionMultiple(
      Math.max(0, grossUsd - this.gasUsd()), remainingRaw, originalRaw, Number(position.committedUsd),
    );
    const maxMultiple = Math.max(Number(position.maxMultipleObserved ?? 0), multiple);
    await (this.prisma as any).solanaLaunchPosition.update({
      where: { id: position.id }, data: { currentMultiple: multiple, maxMultipleObserved: maxMultiple },
    });

    const executed = new Set(
      String(position.executedRungs || '').split(',').filter(Boolean).map((value) => Number(value)),
    );
    const hardStop = this.config.get<number>('solanaLaunch.hardStopMultiple') ?? 0.8;
    if (multiple <= hardStop) {
      await this.sell(position, remainingRaw, 'HARD_STOP_SELL', multiple, quote, true, executed);
      return;
    }
    const rung = nextLadderRung(multiple, executed);
    if (rung) {
      const targetRaw = originalRaw * BigInt(Math.round(rung.fraction * 100)) / 100n;
      const amountRaw = targetRaw < remainingRaw ? targetRaw : remainingRaw;
      const rungQuote = amountRaw === remainingRaw
        ? quote
        : await this.quote(position.mintAddress, USDC_MINT, amountRaw.toString());
      if (rungQuote?.data) {
        executed.add(rung.multiple);
        await this.sell(position, amountRaw, 'LADDER_SELL', multiple, rungQuote, amountRaw === remainingRaw, executed);
      }
      return;
    }
    const timeExitMs = this.config.get<number>('solanaLaunch.timeExitMs') ?? 28_800_000;
    if (Date.now() - position.openedAt.getTime() >= timeExitMs) {
      await this.sell(position, remainingRaw, 'TIME_SELL', multiple, quote, true, executed);
    }
  }

  private async sell(
    position: Position,
    amountRaw: bigint,
    eventType: string,
    multiple: number,
    quote: RaydiumQuoteResponse,
    closes: boolean,
    executed: ReadonlySet<number>,
  ): Promise<void> {
    if (!quote.data) return;
    const executedAt = new Date();
    const gasUsd = this.gasUsd();
    const grossUsd = this.usdcAmount(quote.data.outputAmount);
    const netUsd = Math.max(0, grossUsd - gasUsd);
    const remainingRaw = BigInt(position.remainingTokensRaw) - amountRaw;
    const realized = Number(position.realizedValueUsd) + netUsd;
    const committed = Number(position.committedUsd);
    const realizedMultiple = committed > 0 ? realized / committed : 0;
    const closed = closes || remainingRaw <= 0n;
    const outcome = closed
      ? eventType === 'HARD_STOP_SELL'
        ? realizedMultiple >= 1 ? 'PARTIAL_PROFIT_STOP' : 'STOP_LOSS'
        : realizedMultiple >= 1 ? 'WIN' : 'TIME_LOSS'
      : null;
    const updated = await (this.prisma as any).solanaLaunchPosition.update({
      where: { id: position.id },
      data: {
        remainingTokensRaw: remainingRaw.toString(), realizedValueUsd: realized,
        executedRungs: [...executed].sort((a, b) => a - b).join(','),
        ...(closed ? {
          status: 'CLOSED', closedAt: executedAt, realizedMultiple, outcomeClass: outcome,
          resolutionReason: eventType.toLowerCase(),
        } : {}),
        events: { create: {
          eventType, ts: executedAt, tokenAmountRaw: amountRaw.toString(), grossUsd, netUsd,
          multiple, quoteSnapshot: quote as unknown as Prisma.InputJsonValue,
        } },
      },
    });
    this.exits++;
    this.logExit(updated, amountRaw, eventType, multiple, grossUsd, netUsd, quote, outcome, executedAt);
    this.logger.log(
      `SOLANA ${eventType} ${position.symbol ?? '?'} multiple=${multiple.toFixed(3)}x ` +
      `net=$${netUsd.toFixed(2)} remaining=${remainingRaw}`,
    );
  }

  private async quote(inputMint: string, outputMint: string, amount: string): Promise<RaydiumQuoteResponse | null> {
    if (Date.now() < this.tradeBackoffUntilMs) return null;
    const baseUrl = this.config.get<string>('solanaLaunch.tradeApiUrl')!;
    const response = await this.http.get(`${baseUrl}/compute/swap-base-in`, {
      params: { inputMint, outputMint, amount, slippageBps: 300, txVersion: 'V0' },
    });
    if (response.status === 429) {
      this.tradeBackoffUntilMs = Date.now() + 60_000;
      this.apiErrors++;
      return null;
    }
    const body = response.data as RaydiumQuoteResponse;
    return response.status >= 200 && response.status < 300 && body?.success && body.data ? body : null;
  }

  private async inspectMint(mint: string): Promise<MintSafety> {
    if (Date.now() < this.rpcBackoffUntilMs) {
      return { passed: false, retryable: true, reasons: ['solana_rpc_backoff'] };
    }
    try {
      const response = await this.http.post(this.config.get<string>('solanaLaunch.rpcUrl')!, {
        jsonrpc: '2.0', id: 1, method: 'getAccountInfo',
        params: [mint, { encoding: 'jsonParsed', commitment: 'confirmed' }],
      });
      const value = response.data?.result?.value;
      const info = value?.data?.parsed?.info;
      if (response.status === 429) {
        this.rpcBackoffUntilMs = Date.now() + 60_000;
        return { passed: false, retryable: true, reasons: ['solana_rpc_rate_limited'] };
      }
      if (!value || !info) return { passed: false, retryable: true, reasons: ['mint_state_unavailable'] };
      const extensions = Array.isArray(info.extensions) ? info.extensions : [];
      const transferFee = extensions.find((item: any) => item?.extension === 'transferFeeConfig');
      const transferFeeBps = Number(
        transferFee?.state?.newerTransferFee?.transferFeeBasisPoints ??
        transferFee?.state?.olderTransferFee?.transferFeeBasisPoints ?? 0,
      );
      const reasons: string[] = [];
      if (info.freezeAuthority) reasons.push('active_freeze_authority');
      if (Number.isFinite(transferFeeBps) && transferFeeBps >= 5_000) reasons.push('transfer_fee_gte_50pct');
      return {
        passed: reasons.length === 0, retryable: false, reasons,
        ownerProgram: value.owner, mintAuthority: info.mintAuthority ?? null,
        freezeAuthority: info.freezeAuthority ?? null,
        transferFeeBps: Number.isFinite(transferFeeBps) ? transferFeeBps : null,
      };
    } catch (error) {
      return { passed: false, retryable: true, reasons: [`mint_safety_read_failed:${(error as Error).message}`] };
    }
  }

  private async logHealth(): Promise<void> {
    const [watching, open, closed] = await Promise.all([
      this.count('WATCHING'), this.count('OPEN'), this.count('CLOSED'),
    ]);
    this.logger.log(
      `Solana health: watching=${watching} open=${open} closed=${closed} discovered=${this.discovered} ` +
      `entries=${this.entries} exits=${this.exits} routeMisses=${this.routeMisses} apiErrors=${this.apiErrors} ` +
      `routeReasons=${this.routeReasonSummary()} ` +
      `backoffMs={launch:${Math.max(0, this.launchBackoffUntilMs - Date.now())},` +
      `trade:${Math.max(0, this.tradeBackoffUntilMs - Date.now())},` +
      `rpc:${Math.max(0, this.rpcBackoffUntilMs - Date.now())}}`,
    );
  }

  private async deferWatch(position: Position, reason: string): Promise<void> {
    if (position.resolutionReason === reason) return;
    await (this.prisma as any).solanaLaunchPosition.update({
      where: { id: position.id },
      data: { resolutionReason: reason },
    });
    position.resolutionReason = reason;
  }

  private recordRouteMiss(reason: string): void {
    this.routeMisses++;
    this.routeMissReasons.set(reason, (this.routeMissReasons.get(reason) ?? 0) + 1);
  }

  private routeReasonSummary(): string {
    if (!this.routeMissReasons.size) return 'none';
    return [...this.routeMissReasons.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([reason, count]) => `${reason}:${count}`)
      .join('|');
  }

  private count(status: string): Promise<number> {
    return (this.prisma as any).solanaLaunchPosition.count({
      where: { strategyVersion: STRATEGY_VERSION, status },
    }).catch(() => 0);
  }

  private logEntry(
    position: Position,
    launch: LaunchMintRow,
    quote: RaydiumQuoteResponse,
    safety: MintSafety,
    spotPriceUsd: number,
    slip: number,
    gasUsd: number,
    tokens: number,
    openedAt: Date,
  ): void {
    this.files.logPaperEntry({
      ts: openedAt.toISOString(), run_id: position.id, schema_version: CSV_SCHEMA_VERSION,
      chain: 'solana', token_address: position.mintAddress, symbol: position.symbol ?? '',
      pool_address: position.poolAddress, liquidity_model: 'RAYDIUM_ROUTE',
      first_seen_at: position.launchedAt.toISOString(),
      detection_delay_sec: String((openedAt.getTime() - position.launchedAt.getTime()) / 1000),
      opened_at: openedAt.toISOString(), size_usd: String(this.positionSizeUsd()),
      spot_price_usd: String(spotPriceUsd), entry_price_effective_usd: String(Number(position.entryPriceEffectiveUsd)),
      slippage_pct: String(slip), sandwich_pct: '0', gas_usd: String(gasUsd), buy_tax_pct: '0',
      tokens_bought: String(tokens), onchain_liq_entry_usd: '', entered: 'true', not_entered_reason: '',
      final_score: '', band: '', score_confidence: '', deployer_address: launch.creator ?? '',
      deployer_deployments_count: '', deployer_rug_count: '', lp_locked: '', lp_lock_source: '', lp_lock_fraction: '',
      discovery_source: 'raydium_launchlab_api',
      risk_cohort: `${position.discoveryCohort}:${safety.mintAuthority ? 'SOLANA_MINTABLE_SOFT_RISK' : 'SOLANA_STATIC_SAFE'}`,
      strategy_version: STRATEGY_VERSION, exit_policy: 'SOLANA_80_15_5_LADDER',
      benchmark_eligible: String(position.benchmarkEligible),
      trigger_unique_buyers: '', trigger_buy_quote_usd: String(this.positionSizeUsd()), trigger_buy_sell_ratio: '',
      trigger_price_momentum: String(normalizeFinishingRate(launch.finishingRate)),
      execution_leg: 'ENTER', executed_at: openedAt.toISOString(),
      config_hash: '', target_execution_at: '', confirmation_status: 'EXECUTABLE_ROUTE',
      experiment_id: '', experiment_arm: '', execution_scenario: '',
    });
  }

  private logExit(
    position: Position,
    amountRaw: bigint,
    eventType: string,
    multiple: number,
    grossUsd: number,
    netUsd: number,
    quote: RaydiumQuoteResponse,
    outcome: string | null,
    executedAt: Date,
  ): void {
    const originalRaw = BigInt(position.tokensBoughtRaw);
    const realizedMultiple = Number(position.committedUsd) > 0
      ? Number(position.realizedValueUsd) / Number(position.committedUsd)
      : 0;
    this.files.logPaperExit({
      ts: executedAt.toISOString(), run_id: position.id, schema_version: CSV_SCHEMA_VERSION,
      chain: 'solana', token_address: position.mintAddress, symbol: position.symbol ?? '',
      pool_address: position.poolAddress, event_type: eventType, status: 'filled',
      price_usd: String(grossUsd / tokenAmount(amountRaw, position.decimals)), multiple: String(multiple),
      fraction: String(Number(amountRaw) / Number(originalRaw)), tokens: String(tokenAmount(amountRaw, position.decimals)),
      net_usd: String(netUsd), slip_pct: String(quote.data?.priceImpactPct ?? ''),
      realized_multiple_total: String(realizedMultiple), note: `gas=${this.gasUsd()}`,
      deployer_address: position.creatorAddress ?? '', deployer_deployments_count: '', deployer_rug_count: '',
      outcome_class: outcome ?? '', strategy_version: STRATEGY_VERSION,
      risk_cohort: `${position.discoveryCohort}:SOLANA_EXECUTABLE_ROUTE`, exit_policy: 'SOLANA_80_15_5_LADDER',
      experiment_id: '', experiment_arm: '', execution_scenario: '', execution_leg: eventType,
      config_hash: '', target_execution_at: '', executed_at: executedAt.toISOString(),
    });
  }

  private validLaunch(row: LaunchMintRow): boolean {
    return Boolean(
      row && typeof row.mint === 'string' && row.mint.length >= 32 &&
      typeof row.poolId === 'string' && row.poolId.length >= 32 &&
      Number.isFinite(row.createAt) && Number.isInteger(row.decimals) && row.decimals >= 0 && row.decimals <= 18,
    );
  }

  private positionSizeUsd(): number {
    return this.config.get<number>('solanaLaunch.positionSizeUsd') ?? 20;
  }

  private gasUsd(): number {
    return this.config.get<number>('solanaLaunch.gasUsd') ?? 0.01;
  }

  private usdcRaw(usd: number): string {
    return BigInt(Math.round(usd * 10 ** USDC_DECIMALS)).toString();
  }

  private usdcAmount(raw: string): number {
    return Number(raw) / 10 ** USDC_DECIMALS;
  }
}
