import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../database/prisma.service';
import { FileLoggerService } from '../file-logger/file-logger.service';
import { CSV_SCHEMA_VERSION } from '../file-logger/csv-schemas';
import { LiquidityVerificationService } from '../onchain/liquidity-verification.service';
import { RiskEngineService } from '../risk-engine/risk-engine.service';
import { GeckoTerminalService } from '../collector/geckoterminal/geckoterminal.service';
import { QUOTE_ASSET_MAP, SupportedChain, CandidatePool } from '../collector/collector.types';
import type { LiquidityCheckResult } from '../onchain/onchain.types';
import {
  detectStatus, isInvalidating, outcomeClass, PositionStatus, LadderRung,
} from './exit-ladder';

type ExitDiagnostics = {
  reason: string;
  liqEntryUsd: number | null;
  liqNowUsd: number | null;
  executableExitMultiple: number | null;
  sellSimOk: boolean | null;
  sellTaxPct: number | null;
  priceReadFailures: number;
  liquidityGoneReads: number;
  quoteError: string | null;
};
import { modelExit, slipForSize } from './fills';
import { taxFraction } from './paper.service';
import type { EvalViewRow } from './paper.types';
import { DeployerReputationService } from '../deployer/deployer-reputation.service';
import { PaperService } from './paper.service';
import { GasModelService } from '../onchain/gas-model.service';
import { nextConsecutiveWindowCount } from '../flow/flow-state';

const num = (d: unknown): number | null => (d == null ? null : Number(d));
const DEFAULT_PRICE_READ_FAILURE_RUG_THRESHOLD = 3;
const DEFAULT_RUG_LIQUIDITY_CONFIRMATION_COUNT = 1;
const DEFAULT_ROBINHOOD_RUG_LIQUIDITY_CONFIRMATION_COUNT = 2;

type OnchainReadResult = {
  liq: LiquidityCheckResult | null;
  error: string | null;
};

/**
 * M5 — ON-DEMAND re-evaluation. NOT a daemon. When `npm run eval` runs, it re-reads
 * CURRENT on-chain price + liquidity for every OPEN paper position, updates the
 * multiple / drawdown, classifies status, applies the exit ladder and invalidation
 * exits — all with PESSIMISTIC modeled fills.
 *
 * DOCUMENTED LIMITATION: because runs are intermittent, a token that rugs BETWEEN two
 * eval runs is captured only as a FINAL state (rug) — there is no intra-run price
 * trajectory and no mid-rug exit. This is acceptable for post-mortem research (we ask
 * "what did the t0 features look like for things that later rugged?"), but it means
 * realized multiples are conservative/coarse, not tick-accurate.
 */
@Injectable()
export class EvalService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EvalService.name);
  private evalTimeout: ReturnType<typeof setTimeout> | null = null;
  private evalInterval: ReturnType<typeof setInterval> | null = null;
  private isScheduledEvalRunning = false;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly fileLogger: FileLoggerService,
    private readonly liquidityVerifier: LiquidityVerificationService,
    private readonly riskEngine: RiskEngineService,
    private readonly geckoTerminal: GeckoTerminalService,
    private readonly deployerReputation: DeployerReputationService,
    private readonly paper: PaperService,
    private readonly gasModel: GasModelService,
  ) {}

  onModuleInit(): void {
    const autostart = this.config.get<boolean>('paper.evalAutostart') ?? true;
    if (!autostart) {
      this.logger.log('Paper eval autostart disabled');
      return;
    }

    const intervalMs = Math.max(15_000, this.config.get<number>('paper.evalIntervalMs') ?? 30_000);
    const initialDelayMs = Math.max(0, this.config.get<number>('paper.evalInitialDelayMs') ?? 120_000);
    this.evalTimeout = setTimeout(() => void this.runScheduledEval(), initialDelayMs);
    this.evalInterval = setInterval(() => void this.runScheduledEval(), intervalMs);
    this.logger.log(
      `Paper eval scheduled - interval: ${intervalMs}ms, initial delay: ${initialDelayMs}ms`,
    );
  }

  onModuleDestroy(): void {
    if (this.evalTimeout) {
      clearTimeout(this.evalTimeout);
      this.evalTimeout = null;
    }
    if (this.evalInterval) {
      clearInterval(this.evalInterval);
      this.evalInterval = null;
    }
  }

  private async runScheduledEval(): Promise<void> {
    if (this.isScheduledEvalRunning) {
      this.logger.warn('Paper eval already in progress - skipping scheduled tick');
      return;
    }

    this.isScheduledEvalRunning = true;
    try {
      const result = await this.evaluateOpenPositions();
      this.logger.log(
        `Scheduled paper eval done: evaluated ${result.evaluated}/${result.openTotal}, ` +
        `closed=${result.closed}, deferred=${result.deferred}, ` +
        `takeConfirmed=${result.takeConfirmed}, takeRejected=${result.takeRejected}`,
      );
    } catch (err) {
      this.logger.error(`Scheduled paper eval failed: ${(err as Error).message}`);
    } finally {
      this.isScheduledEvalRunning = false;
    }
  }

  async requestEvaluation(): Promise<void> {
    await this.runScheduledEval();
  }

  async requestFlowEvaluation(chain: string, poolAddresses: readonly string[]): Promise<void> {
    if (this.isScheduledEvalRunning || poolAddresses.length === 0) return;
    this.isScheduledEvalRunning = true;
    try {
      await this.evaluateOpenPositions({ forceFlow: true, chain, poolAddresses });
    } catch (err) {
      this.logger.error(`Flow paper eval failed: ${(err as Error).message}`);
    } finally {
      this.isScheduledEvalRunning = false;
    }
  }

  async evaluateOpenPositions(options: {
    forceFlow?: boolean;
    chain?: string;
    poolAddresses?: readonly string[];
  } = {}): Promise<{
    rows: EvalViewRow[];
    evaluated: number;
    openTotal: number;
    deferred: number;
    closed: number;
    deployersRefreshed: number;
    rugLikeTokens: number;
    takeConfirmed: number;
    takeRejected: number;
    takeDeferred: number;
  }> {
    const runId = `eval-${randomUUID().slice(0, 8)}`;
    const take = await this.paper.processPendingConfirmations();
    const evalMaxOpenPositions = this.config.get<number>('paper.evalMaxOpenPositions');
    const openTotal = await this.prisma.paperPosition.count({
      where: {
        status: 'OPEN',
        ...(options.forceFlow ? {
          chain: options.chain,
          poolAddress: { in: [...(options.poolAddresses ?? [])] },
          OR: [
            { strategyVersion: { startsWith: 'fresh_' } },
            { strategyVersion: { startsWith: 'mature_' } },
            { strategyVersion: { startsWith: 'evm_flow_' } },
            { strategyVersion: { startsWith: 'robinhood_flow_' } },
          ],
        } : {}),
      },
    });
    const youngWindowSec = this.config.get<number>('paper.evalYoungWindowSec');
    const youngIntervalMs = this.config.get<number>('paper.evalYoungIntervalMs');
    const matureIntervalMs = this.config.get<number>('paper.evalMatureIntervalMs');
    const collectTradeStats = this.config.get<boolean>('paper.collectTradeStats') ?? false;
    const cadenceEnabled = youngWindowSec != null && youngIntervalMs != null && matureIntervalMs != null;
    const openRows = await this.prisma.paperPosition.findMany({
      where: {
        status: 'OPEN',
        ...(options.forceFlow ? {
          chain: options.chain,
          poolAddress: { in: [...(options.poolAddresses ?? [])] },
          OR: [
            { strategyVersion: { startsWith: 'fresh_' } },
            { strategyVersion: { startsWith: 'mature_' } },
            { strategyVersion: { startsWith: 'evm_flow_' } },
            { strategyVersion: { startsWith: 'robinhood_flow_' } },
          ],
        } : {}),
      },
      include: { pool: true, token: true },
      orderBy: { openedAt: 'asc' },
      ...(!cadenceEnabled && evalMaxOpenPositions && evalMaxOpenPositions > 0
        ? { take: Math.floor(evalMaxOpenPositions) }
        : {}),
    });
    const nowMs = Date.now();
    const dueRows = options.forceFlow
      ? openRows
      : cadenceEnabled
      ? openRows.filter((position) => {
          if (!position.lastEvalAt) return true;
          const openedAt = position.openedAt?.getTime?.() ?? position.firstSeenAt.getTime();
          const ageMs = Math.max(0, nowMs - openedAt);
          const cadenceMs = ageMs <= youngWindowSec! * 1000 ? youngIntervalMs! : matureIntervalMs!;
          return nowMs - position.lastEvalAt.getTime() >= cadenceMs;
      })
      : openRows;
    if (cadenceEnabled && !options.forceFlow) {
      dueRows.sort((a, b) => {
        const aOpened = a.openedAt?.getTime?.() ?? a.firstSeenAt.getTime();
        const bOpened = b.openedAt?.getTime?.() ?? b.firstSeenAt.getTime();
        const aYoung = nowMs - aOpened <= youngWindowSec! * 1000;
        const bYoung = nowMs - bOpened <= youngWindowSec! * 1000;
        if (aYoung !== bYoung) return aYoung ? -1 : 1;
        return aOpened - bOpened;
      });
    }
    const open = evalMaxOpenPositions && evalMaxOpenPositions > 0
      ? dueRows.slice(0, Math.floor(evalMaxOpenPositions))
      : dueRows;
    const deferred = Math.max(0, openTotal - open.length);
    if (deferred > 0) {
      const deferReason = cadenceEnabled && evalMaxOpenPositions && evalMaxOpenPositions > 0
        ? 'cadence/cap'
        : cadenceEnabled
          ? 'cadence'
          : 'cap';
      this.logger.warn(
        `Paper eval deferred (${deferReason}): evaluating ${open.length}/${openTotal} OPEN positions; ` +
        `${deferred} deferred until next run`,
      );
    }

    const sandwichPct  = this.config.get<number>('paper.sandwichPct') ?? 0.01;
    const partialProfitTimeExitMs = Math.max(
      0,
      this.config.get<number>('paper.partialProfitTimeExitMs') ?? 3_600_000,
    );
    const ladder       = (this.config.get<LadderRung[]>('paper.ladder') ?? []) as LadderRung[];
    const statusParams = {
      liqPullDropPct:  this.config.get<number>('paper.liqPullDropPct') ?? 0.6,
      rugLiqUsd:       this.config.get<number>('paper.rugLiqUsd') ?? 50,
      sellTaxSpikePct: this.config.get<number>('paper.sellTaxSpikePct') ?? 0.5,
    };
    const maxDrawdownInvalidate = this.config.get<number>('paper.maxDrawdownInvalidate') ?? 0.7;
    const hardStopMultiple = this.config.get<number>('paper.hardStopMultiple') ?? 0.8;
    const priceReadFailureRugThreshold = Math.max(
      1,
      this.config.get<number>('paper.priceReadFailureRugThreshold') ??
        DEFAULT_PRICE_READ_FAILURE_RUG_THRESHOLD,
    );
    const defaultRugLiquidityConfirmationCount = Math.max(
      1,
      this.config.get<number>('paper.rugLiquidityConfirmationCount') ??
        DEFAULT_RUG_LIQUIDITY_CONFIRMATION_COUNT,
    );
    const robinhoodRugLiquidityConfirmationCount = Math.max(
      1,
      this.config.get<number>('paper.robinhoodRugLiquidityConfirmationCount') ??
        DEFAULT_ROBINHOOD_RUG_LIQUIDITY_CONFIRMATION_COUNT,
    );

    const rows: EvalViewRow[] = [];
    let closed = 0;

    for (const pos of open) {
      const chain = pos.chain as SupportedChain;
      const gasUsd = await this.gasModel.estimateUsd(chain, pos.liquidityModel);
      const rugLiquidityConfirmationCount = chain === 'robinhood'
        ? robinhoodRugLiquidityConfirmationCount
        : defaultRugLiquidityConfirmationCount;
      const entryEff = num(pos.entryPriceEffectiveUsd);
      const tokensBought = num(pos.tokensBought) ?? 0;
      const sizeUsd = num(pos.sizeUsd) ?? 0;
      const liqEntry = num(pos.onchainLiqEntryUsd) ?? 0;

      // ── Re-read CURRENT on-chain state ────────────────────────────────────────
      const onchainRead = await this.reReadOnchain(chain, pos.pool, pos.token?.decimals ?? undefined);
      const liq = onchainRead.liq;
      const priceNow = liq?.spotPriceUsd ?? null;
      const liqNow   = liq?.onchainTvlUsd ?? null;
      const sellable = liq != null && liq.liquidityVerified && (liq.onchainTvlUsd ?? 0) > 0;
      const priceUnreadable = priceNow == null || !(priceNow > 0);
      const entryFeatures = this.entryFeaturesRecord(pos.entryFeatures);
      const priceReadFailureCount = priceUnreadable
        ? this.readPriceFailureCount(entryFeatures.priceReadFailureCount) + 1
        : 0;
      const lowLiquidityRead = liqNow != null && liqNow <= statusParams.rugLiqUsd;
      const liquidityGoneReadCount = lowLiquidityRead
        ? this.readCounter(entryFeatures.liquidityGoneReadCount) + 1
        : 0;
      const liquidityGoneConfirmed =
        lowLiquidityRead && liquidityGoneReadCount >= rugLiquidityConfirmationCount;
      let nextEntryFeatures = this.entryFeaturesRecord(this.withPriceReadFailure(
        pos.entryFeatures,
        priceReadFailureCount,
        priceUnreadable ? (onchainRead.error ?? 'no_price') : null,
      ));
      nextEntryFeatures = this.entryFeaturesRecord(this.withLiquidityGoneRead(
        nextEntryFeatures,
        liquidityGoneReadCount,
        lowLiquidityRead ? liqNow : null,
      ));
      // RE-RUN sell simulation against current state (existing exit behavior unchanged).
      const { sellSimOk, sellTaxNow } = await this.reCheckSell(chain, pos.tokenAddress, pos.symbol ?? '');

      // Trade stats are research-only. Keeping them off the shared Gecko budget
      // prevents a large open-position book from starving new-pool discovery.
      const stats = collectTradeStats
        ? await this.geckoTerminal.getPoolTradeStats(chain, pos.poolAddress)
        : null;
      const uniqueBuyers  = stats?.uniqueBuyers ?? null;
      const uniqueSellers = stats?.uniqueSellers ?? null;
      const sellersToBuyersRatio =
        uniqueBuyers != null && uniqueSellers != null ? uniqueSellers / Math.max(uniqueBuyers, 1) : null;

      const sellSideInvalid =
        sellSimOk === false ||
        (sellTaxNow != null && sellTaxNow >= statusParams.sellTaxSpikePct);
      const liquidityPulled =
        liqNow != null && liqEntry > 0 && liqNow < liqEntry * (1 - statusParams.liqPullDropPct);
      const status: PositionStatus = priceUnreadable
        ? liquidityGoneConfirmed
          ? 'rug'
          : liquidityPulled && (!lowLiquidityRead || liquidityGoneConfirmed)
            ? 'liquidity_pulled'
            : sellSideInvalid
              ? 'unsellable'
              : 'alive'
        : liqNow == null
          ? sellSideInvalid ? 'unsellable' : 'alive'
          : (() => {
              const detected = detectStatus(
                { liqEntryUsd: liqEntry, liqNowUsd: liqNow, priceNowUsd: priceNow, sellable, sellTaxNowPct: sellTaxNow },
                statusParams,
              );
              return detected === 'rug' && !liquidityGoneConfirmed ? 'alive' : detected;
            })();
      const tickStatus = priceUnreadable && status === 'alive'
        ? `price_unreadable_${priceReadFailureCount}/${priceReadFailureRugThreshold}`
        : !priceUnreadable && liqNow == null && status === 'alive'
          ? 'liquidity_unreadable'
        : status;
      nextEntryFeatures = this.entryFeaturesRecord(this.withSurvivalObservation(
        nextEntryFeatures,
        pos.openedAt ?? pos.firstSeenAt,
        entryEff,
        priceNow,
        liq,
        status,
      ));

      // ── Multiple / drawdown ───────────────────────────────────────────────────
      const currentMultiple = entryEff && priceNow != null ? priceNow / entryEff : null;
      let maxMult = num(pos.maxMultipleObserved) ?? 1;
      if (currentMultiple != null && currentMultiple > maxMult) maxMult = currentMultiple;
      const drawdown = currentMultiple != null && maxMult > 0
        ? Math.max(0, (maxMult - currentMultiple) / maxMult)
        : (num(pos.maxDrawdownObserved) ?? 0);

      // ── Exit ladder (pessimistic sells of ORIGINAL fractions) ─────────────────
      const executed = (pos.executedRungs ? pos.executedRungs.split(',').filter(Boolean).map(Number) : []);
      let remainingFraction = num(pos.remainingFraction) ?? 1;
      let realizedValueUsd  = num(pos.realizedValueUsd) ?? 0;
      const exitPolicy = (pos as any).exitPolicy ?? 'SAFE_LADDER';
      const useExact20 = typeof pos.strategyVersion === 'string' && pos.strategyVersion.endsWith('_v2');
      const positionLadder: LadderRung[] = exitPolicy === 'SOFT_RISK_2X'
        ? [{ multiple: 2, sellFraction: 1 }]
        : ladder;

      if (currentMultiple != null && status === 'alive') {
        for (const rung of positionLadder.filter((item) => !executed.includes(item.multiple))) {
          const tokensToSell = tokensBought * rung.sellFraction;
          const usdValue = tokensToSell * (priceNow ?? 0);
          const exitSlip = slipForSize(usdValue, ladderFrom(liq, useExact20));
          const fill = modelExit(tokensToSell, priceNow ?? 0, exitSlip, { sandwichPct, gasUsd, sellTaxPct: taxFraction(sellTaxNow) });
          const executableRungMultiple = sizeUsd > 0 && rung.sellFraction > 0
            ? fill.netUsd / (sizeUsd * rung.sellFraction)
            : 0;
          if (executableRungMultiple < rung.multiple) continue;
          realizedValueUsd += fill.netUsd;
          remainingFraction = Math.max(0, remainingFraction - rung.sellFraction);
          executed.push(rung.multiple);
          await this.writeExit(runId, pos, 'LADDER_SELL', status, priceNow, currentMultiple, rung.sellFraction,
            tokensToSell, fill.netUsd, exitSlip, realizedValueUsd / sizeUsd,
            `ladder ${rung.multiple}x executable=${executableRungMultiple.toFixed(4)}x`, '',
            this.exitDiagnostics(`LADDER_TARGET_${rung.multiple}X`, liqEntry, liqNow, executableRungMultiple, sellSimOk,
              sellTaxNow, priceReadFailureCount, liquidityGoneReadCount, onchainRead.error));
        }
      }
      const ladderComplete = remainingFraction <= 1e-6;
      const openedAtMs = (pos.openedAt ?? pos.firstSeenAt).getTime();

      const fullExitTokens = tokensBought * remainingFraction;
      const fullExitValue = fullExitTokens * (priceNow ?? 0);
      const fullExitSlip = slipForSize(fullExitValue, ladderFrom(liq, useExact20));
      const fullExitFill = modelExit(fullExitTokens, priceNow ?? 0, fullExitSlip, {
        sandwichPct, gasUsd, sellTaxPct: taxFraction(sellTaxNow),
      });
      const executableIfClosed = sizeUsd > 0 ? (realizedValueUsd + fullExitFill.netUsd) / sizeUsd : 0;
      const previousExecutablePeak = Math.max(1, this.numberFeature(nextEntryFeatures.protectedExecutablePeak) ?? 1);
      const executablePeak = Math.max(previousExecutablePeak, executableIfClosed);
      const executableDrawdown = executablePeak > 0
        ? Math.max(0, (executablePeak - executableIfClosed) / executablePeak)
        : 0;
      const protectedPolicy = exitPolicy === 'PROTECTED_LADDER_V2';
      const flowReversal = await this.flowReversalState(
        pos,
        nextEntryFeatures,
        entryEff,
        priceNow,
        protectedPolicy ? executableDrawdown : drawdown,
      );
      nextEntryFeatures = {
        ...nextEntryFeatures,
        flowReversalCount: flowReversal.count,
        flowReversalWindow: flowReversal.window,
        flowBuySellRatio30s: flowReversal.ratio,
        flowCreatorSellUsd30s: flowReversal.creatorSellUsd,
        flowCreatorExit30s: flowReversal.creatorExit,
        protectedExecutablePeak: executablePeak,
        protectedExecutableDrawdown: executableDrawdown,
      };
      const positionAgeMs = Date.now() - openedAtMs;
      const protectedGreenExit = protectedPolicy && positionAgeMs >= 30 * 60_000 && executableIfClosed > 1;
      const timeExitDue = status === 'alive' && currentMultiple != null && (protectedPolicy
        ? protectedGreenExit || positionAgeMs >= 60 * 60_000
        : partialProfitTimeExitMs > 0 && positionAgeMs >= partialProfitTimeExitMs);
      const hardStop = status === 'alive' && currentMultiple != null && executableIfClosed <= hardStopMultiple;

      // Last-tick rug signals — persisted on the position (COLLECTION ONLY; the LAST
      // value before close feeds the post-mortem). NOT used in any exit decision.
      const lastTickData = {
        lastUniqueBuyers: uniqueBuyers, lastUniqueSellers: uniqueSellers,
        lastSellersToBuyersRatio: sellersToBuyersRatio, lastSellSimOk: sellSimOk,
        lastSellTaxNow: sellTaxNow,
      };

      // ── Invalidation exit ─────────────────────────────────────────────────────
      const invalidate = !ladderComplete && (
        isInvalidating(status) || hardStop || flowReversal.confirmed || drawdown > maxDrawdownInvalidate
      );
      let finalStatus: string = tickStatus;
      if (ladderComplete) {
        const realizedMultiple = realizedValueUsd / sizeUsd;
        const closeOutcomeClass = outcomeClass('ladder_complete', realizedMultiple);
        await this.prisma.paperPosition.update({
          where: { id: pos.id },
          data: {
            status: 'CLOSED', closedAt: new Date(),
            realizedMultiple, realizedValueUsd, remainingFraction: 0,
            outcomeClass: closeOutcomeClass,
            executedRungs: executed.join(','), lastEvalAt: new Date(),
            priceNowUsd: priceNow, onchainLiqNowUsd: liqNow, currentMultiple,
            maxMultipleObserved: maxMult, maxDrawdownObserved: drawdown,
            entryFeatures: nextEntryFeatures as Prisma.InputJsonValue,
            ...lastTickData,
          },
        });
        finalStatus = `closed:${closeOutcomeClass}`;
        closed++;
      } else if (timeExitDue && !invalidate) {
        const tokensToSell = tokensBought * remainingFraction;
        const usdValue = tokensToSell * (priceNow ?? 0);
        const exitSlip = slipForSize(usdValue, ladderFrom(liq, useExact20));
        const fill = modelExit(tokensToSell, priceNow ?? 0, exitSlip, {
          sandwichPct, gasUsd, sellTaxPct: taxFraction(sellTaxNow),
        });
        const finalRealizedValueUsd = realizedValueUsd + fill.netUsd;
        const realizedMultiple = finalRealizedValueUsd / sizeUsd;

        {
          const closeReason = realizedMultiple >= 1 ? 'time_profit' : 'time_loss';
          const closeOutcomeClass = outcomeClass(closeReason, realizedMultiple);
          await this.writeExit(
            runId, pos, realizedMultiple >= 1 ? 'TIME_PROFIT_SELL' : 'TIME_LOSS_SELL', status, priceNow, currentMultiple, remainingFraction,
            tokensToSell, fill.netUsd, exitSlip, realizedMultiple,
            `time exit after ${Math.round(positionAgeMs / 60_000)}m${protectedGreenExit ? ' protected-green' : ''}`,
            closeOutcomeClass,
            this.exitDiagnostics(realizedMultiple >= 1 ? 'TIME_HORIZON_PROFIT' : 'TIME_HORIZON_LOSS', liqEntry,
              liqNow, executableIfClosed, sellSimOk, sellTaxNow, priceReadFailureCount,
              liquidityGoneReadCount, onchainRead.error),
          );
          remainingFraction = 0;
          realizedValueUsd = finalRealizedValueUsd;
          await this.prisma.paperPosition.update({
            where: { id: pos.id },
            data: {
              status: 'CLOSED', closedAt: new Date(),
              realizedMultiple, realizedValueUsd, remainingFraction: 0,
              outcomeClass: closeOutcomeClass,
              executedRungs: executed.join(','), lastEvalAt: new Date(),
              priceNowUsd: priceNow, onchainLiqNowUsd: liqNow, currentMultiple,
              maxMultipleObserved: maxMult, maxDrawdownObserved: drawdown,
              entryFeatures: nextEntryFeatures as Prisma.InputJsonValue,
              ...lastTickData,
            },
          });
          finalStatus = `closed:${closeOutcomeClass}`;
          closed++;
        }
      } else if (invalidate) {
        const tokensToSell = tokensBought * remainingFraction;
        // On a rug, priceNow≈0 and depth is gone → modeled proceeds ≈ 0 (pessimistic).
        const usdValue = tokensToSell * (priceNow ?? 0);
        const exitSlip = liqNow == null ? 1 : slipForSize(usdValue, ladderFrom(liq, useExact20));
        const fill = modelExit(tokensToSell, priceNow ?? 0, exitSlip, { sandwichPct, gasUsd, sellTaxPct: taxFraction(sellTaxNow) });
        realizedValueUsd += fill.netUsd;
        const reason = hardStop
          ? 'hard_stop'
          : flowReversal.creatorExit
            ? 'creator_exit'
          : flowReversal.confirmed
            ? 'flow_reversal'
            : drawdown > maxDrawdownInvalidate && !isInvalidating(status) ? 'drawdown' : status;
        const realizedMultiple = realizedValueUsd / sizeUsd;
        const closeOutcomeClass = outcomeClass(
          reason as PositionStatus | 'drawdown' | 'hard_stop' | 'flow_reversal' | 'creator_exit',
          realizedMultiple,
        );
        const invalidationReason = liquidityGoneConfirmed && status === 'rug'
            ? `liquidity_gone_${liquidityGoneReadCount}x`
          : reason;
        const exitReason = this.exitReason(reason, sellSimOk, sellTaxNow, liquidityGoneConfirmed);
        await this.writeExit(runId, pos, this.exitEventType(exitReason), status, priceNow, currentMultiple, remainingFraction,
          tokensToSell, fill.netUsd, exitSlip, realizedMultiple,
          `exit: ${exitReason}; trigger=${invalidationReason}`, closeOutcomeClass,
          this.exitDiagnostics(exitReason, liqEntry, liqNow, executableIfClosed, sellSimOk, sellTaxNow,
            priceReadFailureCount, liquidityGoneReadCount, onchainRead.error));
        remainingFraction = 0;

        await this.prisma.paperPosition.update({
          where: { id: pos.id },
          data: {
            status: 'CLOSED', closedAt: new Date(),
            realizedMultiple, realizedValueUsd, remainingFraction: 0,
            outcomeClass: closeOutcomeClass,
            executedRungs: executed.join(','), lastEvalAt: new Date(),
            priceNowUsd: priceNow, onchainLiqNowUsd: liqNow, currentMultiple,
            maxMultipleObserved: maxMult, maxDrawdownObserved: drawdown,
            entryFeatures: nextEntryFeatures as Prisma.InputJsonValue,
            ...lastTickData,
          },
        });
        finalStatus = `closed:${closeOutcomeClass}`;
        closed++;
      } else {
        await this.prisma.paperPosition.update({
          where: { id: pos.id },
          data: {
            lastEvalAt: new Date(), priceNowUsd: priceNow, onchainLiqNowUsd: liqNow,
            currentMultiple, maxMultipleObserved: maxMult, maxDrawdownObserved: drawdown,
            remainingFraction, realizedValueUsd, executedRungs: executed.join(','),
            entryFeatures: nextEntryFeatures as Prisma.InputJsonValue,
            ...lastTickData,
          },
        });
      }

      // ── Write the per-position tick row (sellers/buyers + sell-sim signals) ────
      this.fileLogger.logPositionTick({
        ts: new Date().toISOString(), run_id: runId, chain: pos.chain,
        token_address: pos.tokenAddress, pool_address: pos.poolAddress,
        price_now: priceNow != null ? priceNow.toExponential(8) : '',
        onchain_liquidity_usd: liqNow != null ? liqNow.toFixed(2) : '',
        unique_buyers: uniqueBuyers != null ? String(uniqueBuyers) : '',
        unique_sellers: uniqueSellers != null ? String(uniqueSellers) : '',
        sellers_to_buyers_ratio: sellersToBuyersRatio != null ? sellersToBuyersRatio.toFixed(4) : '',
        buys: stats?.buys != null ? String(stats.buys) : '',
        sells: stats?.sells != null ? String(stats.sells) : '',
        sell_to_buy_vol_ratio: '', // GeckoTerminal does not split buy/sell volume
        sell_sim_ok: sellSimOk == null ? '' : String(sellSimOk),
        sell_tax_now: sellTaxNow != null ? sellTaxNow.toFixed(6) : '',
        multiple_vs_entry: currentMultiple != null ? currentMultiple.toFixed(4) : '',
        status: tickStatus,
      });

      const feats = pos.entryFeatures as { finalScore?: number; scoreConfidence?: number } | null;
      rows.push({
        symbol: pos.symbol ?? '?',
        chain: pos.chain,
        tokenAddress: pos.tokenAddress,
        foundAt: pos.firstSeenAt.toISOString(),
        entryEffective: entryEff,
        priceNow,
        multiple: currentMultiple,
        status: finalStatus,
        score: feats?.finalScore ?? null,
        confidence: feats?.scoreConfidence ?? null,
        sellersToBuyersRatio,
        sellSimOk,
      });

      this.logger.log(
        `Eval ${pos.chain}:${pos.tokenAddress} (${pos.symbol ?? '?'}) status=${finalStatus} ` +
        `mult=${currentMultiple != null ? currentMultiple.toFixed(3) : '?'} liqNow=${liqNow != null ? '$' + liqNow.toFixed(0) : '?'} ` +
        `s/b=${sellersToBuyersRatio != null ? sellersToBuyersRatio.toFixed(2) : '?'} sellSimOk=${sellSimOk ?? '?'}`,
      );
    }

    const reputation = await this.deployerReputation.refreshAll();

    return {
      rows,
      evaluated: open.length,
      openTotal,
      deferred,
      closed,
      deployersRefreshed: reputation.deployersUpdated,
      rugLikeTokens: reputation.rugLikeTokens,
      takeConfirmed: take.confirmed,
      takeRejected: take.rejected,
      takeDeferred: take.deferred,
    };
  }

  // Re-verify the pool's CURRENT on-chain liquidity/price. Includes a failure reason.
  private async reReadOnchain(
    chain: SupportedChain,
    pool: {
      poolAddress: string;
      dex: string;
      token0: string;
      token1: string;
      quoteAsset: string;
      v4Metadata?: unknown;
    } | null,
    decimals: number | undefined,
  ): Promise<OnchainReadResult> {
    if (!pool) return { liq: null, error: 'missing_pool' };
    const quoteMap = QUOTE_ASSET_MAP[chain] ?? {};
    const quoteAddr = [pool.token0, pool.token1].find((a) => quoteMap[a.toLowerCase()] != null);
    if (!quoteAddr) return { liq: null, error: 'quote_asset_not_found' };
    const candidate: CandidatePool = {
      chain,
      poolAddress: pool.poolAddress,
      dex: pool.dex,
      token0Address: pool.token0,
      token1Address: pool.token1,
      quoteAsset: pool.quoteAsset,
      quoteAssetAddress: quoteAddr.toLowerCase(),
      v4Metadata: this.v4MetadataFromStorage(pool.v4Metadata),
      source: 'paper-eval',
    };
    try {
      const liq = await this.liquidityVerifier.verify(candidate, decimals);
      return {
        liq,
        error: liq.spotPriceUsd != null && liq.spotPriceUsd > 0
          ? null
          : (liq.error ?? 'no_price'),
      };
    } catch (err) {
      this.logger.debug(`Eval re-read failed for ${chain}:${pool.poolAddress}: ${(err as Error).message}`);
      return { liq: null, error: (err as Error).message };
    }
  }

  // Best-effort RE-RUN of the sell-side check against CURRENT state (side-effect free).
  // Honeypot.is/GoPlus simulate a sell, so this catches a token that was sellable at t0
  // but became unsellable later. Returns sellSimOk/sellTaxNow (null when unknown).
  private async reCheckSell(
    chain: SupportedChain, tokenAddress: string, symbol: string,
  ): Promise<{ sellSimOk: boolean | null; sellTaxNow: number | null }> {
    try {
      const r = await this.riskEngine.checkToken(chain, tokenAddress, symbol, symbol, 'eval');
      const hp = r.merged.honeypot;
      const sellSimOk = hp === true ? false : hp === false ? true : null;
      // Honeypot → effectively 100% sell tax (can't get out); else use the simulated sell tax.
      const sellTaxNow = hp === true ? 1 : (r.merged.sellTax ?? null);
      return { sellSimOk, sellTaxNow };
    } catch {
      return { sellSimOk: null, sellTaxNow: null }; // rely on on-chain liquidity signal
    }
  }

  private entryFeaturesRecord(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return { ...(value as Record<string, unknown>) };
  }

  private readPriceFailureCount(value: unknown): number {
    return this.readCounter(value);
  }

  private v4MetadataFromStorage(value: unknown): CandidatePool['v4Metadata'] | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const raw = value as Record<string, unknown>;
    const currency0 = typeof raw.currency0 === 'string' ? raw.currency0 : null;
    const currency1 = typeof raw.currency1 === 'string' ? raw.currency1 : null;
    const hooks = typeof raw.hooks === 'string' ? raw.hooks : null;
    const fee = Number(raw.fee);
    const tickSpacing = Number(raw.tickSpacing);
    try {
      const sqrtPriceX96 = typeof raw.sqrtPriceX96 === 'string' ? BigInt(raw.sqrtPriceX96) : null;
      if (!currency0 || !currency1 || !hooks || !Number.isFinite(fee) || !Number.isFinite(tickSpacing) || sqrtPriceX96 == null) return undefined;
      return { currency0, currency1, hooks, fee, tickSpacing, sqrtPriceX96 };
    } catch {
      return undefined;
    }
  }

  private readCounter(value: unknown): number {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }

  private numberFeature(value: unknown): number | null {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  private withPriceReadFailure(
    rawFeatures: unknown,
    count: number,
    error: string | null,
  ): Prisma.InputJsonValue {
    const next = this.entryFeaturesRecord(rawFeatures);
    next.priceReadFailureCount = count;
    if (count > 0 && error) {
      next.lastPriceReadError = error.slice(0, 180);
    } else {
      delete next.lastPriceReadError;
    }
    return next as Prisma.InputJsonValue;
  }

  private withLiquidityGoneRead(
    rawFeatures: unknown,
    count: number,
    liquidityUsd: number | null,
  ): Prisma.InputJsonValue {
    const next = this.entryFeaturesRecord(rawFeatures);
    next.liquidityGoneReadCount = count;
    if (count > 0 && liquidityUsd != null) {
      next.lastLowLiquidityUsd = liquidityUsd;
    } else {
      delete next.lastLowLiquidityUsd;
    }
    return next as Prisma.InputJsonValue;
  }

  /**
   * Record what happened ten minutes after the real t0 paper entry. This is
   * deliberately observation-only: it never changes entry or exit decisions.
   */
  private withSurvivalObservation(
    rawFeatures: unknown,
    openedAt: Date | null,
    entryPrice: number | null,
    priceNow: number | null,
    liq: LiquidityCheckResult | null,
    status: string,
  ): Prisma.InputJsonValue {
    const next = this.entryFeaturesRecord(rawFeatures);
    if (next.survival10mStatus != null || !(this.config.get<boolean>('paper.survivalObservationEnabled') ?? true)) {
      return next as Prisma.InputJsonValue;
    }
    const delaySec = Math.max(0, this.config.get<number>('paper.survivalObservationDelaySec') ?? 600);
    if (!openedAt || Date.now() - openedAt.getTime() < delaySec * 1000) {
      return next as Prisma.InputJsonValue;
    }
    const priceMultiple = entryPrice && priceNow != null ? priceNow / entryPrice : null;
    const entryLiquidity = Number(next.onchainTvlUsd);
    const liquidityRetention = Number.isFinite(entryLiquidity) && entryLiquidity > 0 && liq?.onchainTvlUsd != null
      ? liq.onchainTvlUsd / entryLiquidity
      : null;
    const depthUsd = liq?.executableDepthUsd ?? null;
    const survived = status === 'alive' && priceMultiple != null && priceMultiple >= 1 &&
      depthUsd != null && depthUsd >= 100 && (liquidityRetention == null || liquidityRetention >= 0.8);
    next.survival10mStatus = survived ? 'SURVIVED' : status === 'alive' ? 'WEAK_OR_UNVERIFIED' : status.toUpperCase();
    next.survival10mAt = new Date().toISOString();
    next.survival10mPriceMultiple = priceMultiple;
    next.survival10mLiquidityRetention = liquidityRetention;
    next.survival10mExecutableDepthUsd = depthUsd;
    return next as Prisma.InputJsonValue;
  }

  private async flowReversalState(
    pos: { chain: string; poolAddress: string; strategyVersion?: string; exitPolicy?: string },
    features: Record<string, unknown>,
    entryPrice: number | null,
    priceNow: number | null,
    drawdown: number,
  ): Promise<{
    confirmed: boolean;
    creatorExit: boolean;
    creatorSellUsd: number;
    count: number;
    window: number;
    ratio: number | null;
  }> {
    const window = Math.floor(Date.now() / 30_000);
    const previousWindow = this.readCounter(features.flowReversalWindow);
    const previousCount = this.readCounter(features.flowReversalCount);
    const protectedPolicy = pos.exitPolicy === 'PROTECTED_LADDER_V2';
    if (!pos.strategyVersion || !/^(fresh|mature|evm_flow|robinhood_flow)_/.test(pos.strategyVersion)) {
      return { confirmed: false, creatorExit: false, creatorSellUsd: 0, count: previousCount, window, ratio: null };
    }
    if (previousWindow === window) {
      const creatorExit = features.flowCreatorExit30s === true;
      return {
        confirmed: creatorExit || previousCount >= 2,
        creatorExit,
        creatorSellUsd: this.numberFeature(features.flowCreatorSellUsd30s) ?? 0,
        count: previousCount,
        window,
        ratio: this.numberFeature(features.flowBuySellRatio30s),
      };
    }
    const swapDelegate = (this.prisma as any).evmSwapObservation;
    if (!swapDelegate) {
      return { confirmed: false, creatorExit: false, creatorSellUsd: 0, count: previousCount, window, ratio: null };
    }
    const swaps = await swapDelegate.findMany({
      where: {
        chain: pos.chain,
        poolAddress: pos.poolAddress,
        ts: { gte: new Date(window * 30_000) },
      },
      select: { kind: true, quoteAmountUsd: true, trader: true },
    }).catch(() => []);
    let buys = 0;
    let sells = 0;
    let creatorSellUsd = 0;
    const flowSnapshot = features.flowSnapshot && typeof features.flowSnapshot === 'object'
      ? features.flowSnapshot as Record<string, unknown>
      : {};
    const creatorAddress = typeof flowSnapshot.creatorAddress === 'string'
      ? flowSnapshot.creatorAddress.toLowerCase()
      : null;
    for (const swap of swaps) {
      const value = Number(swap.quoteAmountUsd);
      if (swap.kind === 'BUY') buys += value;
      else if (swap.kind === 'SELL') {
        sells += value;
        if (creatorAddress && String(swap.trader).toLowerCase() === creatorAddress) creatorSellUsd += value;
      }
    }
    const ratio = sells > 0 ? buys / sells : buys > 0 ? 999 : null;
    const weak = protectedPolicy
      ? sells > 0 && ratio != null && ratio < 0.75 && drawdown >= 0.15
      : sells > 0 && ratio != null && ratio < 0.5 && entryPrice != null &&
        priceNow != null && priceNow < entryPrice && drawdown >= 0.20;
    const count = nextConsecutiveWindowCount(previousWindow, previousCount, window, weak);
    const creatorExit = protectedPolicy && creatorSellUsd >= Math.max(20, buys * 0.05);
    features.flowCreatorExit30s = creatorExit;
    return { confirmed: creatorExit || count >= 2, creatorExit, creatorSellUsd, count, window, ratio };
  }

  private async writeExit(
    runId: string,
    pos: { id: string; chain: string; tokenAddress: string; symbol: string | null; poolAddress: string; strategyVersion?: string; riskCohort?: string; exitPolicy?: string },
    type: string,
    status: PositionStatus,
    priceNow: number | null,
    multiple: number | null,
    fraction: number,
    tokens: number,
    netUsd: number,
    slipPct: number | null,
    realizedMultipleTotal: number,
    note: string,
    outcomeClassValue = '',
    diagnostics?: ExitDiagnostics,
  ): Promise<void> {
    const eventDelegate = (this.prisma as any).paperEvent;
    const duplicateWhere: Record<string, unknown> = {
      type,
      position: {
        chain: pos.chain,
        poolAddress: pos.poolAddress,
        id: { not: pos.id },
      },
    };
    if (type === 'LADDER_SELL') {
      const rung = note.match(/^ladder\s+([0-9.]+x)/i)?.[1];
      if (rung) duplicateWhere.note = { startsWith: `ladder ${rung}` };
    }
    const duplicateMarketEvent = typeof eventDelegate?.findFirst === 'function'
      ? await eventDelegate.findFirst({ where: duplicateWhere, select: { id: true } }).catch(() => null)
      : null;

    await this.prisma.paperEvent.create({
      data: {
        positionId: pos.id, ts: new Date(), type,
        price: priceNow ?? 0, multiple, fraction, tokens, usd: netUsd, slipPct, note,
      },
    }).catch(() => undefined);

    // Historical parallel strategy positions retain their own accounting event,
    // but the human-facing journal records one market action only once.
    if (duplicateMarketEvent) return;

    this.fileLogger.logPaperExit({
      ts: new Date().toISOString(), run_id: runId, schema_version: CSV_SCHEMA_VERSION,
      chain: pos.chain, token_address: pos.tokenAddress, symbol: pos.symbol ?? '',
      pool_address: pos.poolAddress, event_type: type, status,
      price_usd: priceNow != null ? priceNow.toExponential(8) : '',
      multiple: multiple != null ? multiple.toFixed(4) : '',
      fraction: fraction.toFixed(4),
      tokens: tokens.toExponential(6),
      net_usd: netUsd.toFixed(4),
      slip_pct: slipPct != null ? slipPct.toFixed(6) : '',
      realized_multiple_total: realizedMultipleTotal.toFixed(4),
      note,
      deployer_address: '',
      deployer_deployments_count: '',
      deployer_rug_count: '',
      outcome_class: outcomeClassValue,
      strategy_version: pos.strategyVersion ?? 'legacy_static_v0',
      risk_cohort: pos.riskCohort ?? 'CONTRACT_SAFE',
      exit_policy: pos.exitPolicy ?? 'SAFE_LADDER',
      exit_reason: diagnostics?.reason ?? '',
      liquidity_entry_usd: diagnostics?.liqEntryUsd != null ? diagnostics.liqEntryUsd.toFixed(2) : '',
      liquidity_now_usd: diagnostics?.liqNowUsd != null ? diagnostics.liqNowUsd.toFixed(2) : '',
      liquidity_change_pct: diagnostics?.liqEntryUsd != null && diagnostics.liqEntryUsd > 0 && diagnostics.liqNowUsd != null
        ? (((diagnostics.liqNowUsd - diagnostics.liqEntryUsd) / diagnostics.liqEntryUsd) * 100).toFixed(2)
        : '',
      executable_exit_multiple: diagnostics?.executableExitMultiple != null
        ? diagnostics.executableExitMultiple.toFixed(4)
        : '',
      sell_sim_ok: diagnostics?.sellSimOk == null ? '' : String(diagnostics.sellSimOk),
      sell_tax_pct: diagnostics?.sellTaxPct != null ? diagnostics.sellTaxPct.toFixed(4) : '',
      price_read_failures: diagnostics ? String(diagnostics.priceReadFailures) : '',
      liquidity_gone_reads: diagnostics ? String(diagnostics.liquidityGoneReads) : '',
      quote_error: diagnostics?.quoteError ?? '',
    });
  }

  private exitDiagnostics(
    reason: string,
    liqEntryUsd: number | null,
    liqNowUsd: number | null,
    executableExitMultiple: number | null,
    sellSimOk: boolean | null,
    sellTaxPct: number | null,
    priceReadFailures: number,
    liquidityGoneReads: number,
    quoteError: string | null,
  ): ExitDiagnostics {
    return {
      reason, liqEntryUsd, liqNowUsd, executableExitMultiple, sellSimOk, sellTaxPct,
      priceReadFailures, liquidityGoneReads, quoteError,
    };
  }

  private exitReason(
    reason: string,
    sellSimOk: boolean | null,
    sellTaxPct: number | null,
    liquidityGoneConfirmed: boolean,
  ): string {
    if (reason === 'hard_stop') return 'EXECUTABLE_HARD_STOP';
    if (reason === 'creator_exit') return 'CREATOR_SELL_PROTECTION';
    if (reason === 'flow_reversal') return 'FLOW_REVERSAL_PROTECTION';
    if (reason === 'drawdown') return 'MAX_DRAWDOWN_INVALIDATION';
    if (reason === 'liquidity_pulled') return 'DEPTH_COLLAPSE';
    if (reason === 'unsellable') {
      if (sellTaxPct != null) return 'SELL_TAX_SPIKE';
      return sellSimOk === false ? 'SELL_SIMULATION_FAILED' : 'SELL_ROUTE_UNAVAILABLE';
    }
    if (reason === 'rug') {
      return liquidityGoneConfirmed ? 'LIQUIDITY_GONE_CONFIRMED' : 'PRICE_OR_LIQUIDITY_UNREADABLE';
    }
    return 'OTHER_INVALIDATION';
  }

  private exitEventType(exitReason: string): string {
    const eventTypes: Record<string, string> = {
      EXECUTABLE_HARD_STOP: 'HARD_STOP_SELL',
      CREATOR_SELL_PROTECTION: 'CREATOR_EXIT_SELL',
      FLOW_REVERSAL_PROTECTION: 'FLOW_REVERSAL_SELL',
      MAX_DRAWDOWN_INVALIDATION: 'MAX_DRAWDOWN_SELL',
      DEPTH_COLLAPSE: 'DEPTH_COLLAPSE_SELL',
      LIQUIDITY_GONE_CONFIRMED: 'LIQUIDITY_GONE_SELL',
      SELL_TAX_SPIKE: 'SELL_TAX_EXIT',
      SELL_SIMULATION_FAILED: 'UNSELLABLE_EXIT',
      SELL_ROUTE_UNAVAILABLE: 'UNSELLABLE_EXIT',
      PRICE_OR_LIQUIDITY_UNREADABLE: 'DATA_UNREADABLE_EXIT',
      OTHER_INVALIDATION: 'INVALIDATION_EXIT',
    };
    return eventTypes[exitReason] ?? 'INVALIDATION_EXIT';
  }
}

// Build a SlipLadder from a fresh liquidity read.
function ladderFrom(liq: LiquidityCheckResult | null, useExact20 = false) {
  return {
    slip20: useExact20 ? liq?.exitSlip20 ?? liq?.slip20 ?? null : null,
    slip50: liq?.slip50 ?? null, slip100: liq?.slip100 ?? null,
    slip500: liq?.slip500 ?? null, slip1000: liq?.slip1000 ?? null,
  };
}
