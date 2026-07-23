import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { DeployerReputationService } from '../deployer/deployer-reputation.service';
import { CSV_SCHEMA_VERSION } from '../file-logger/csv-schemas';
import { FileLoggerService } from '../file-logger/file-logger.service';
import { GasModelService } from '../onchain/gas-model.service';
import { LiquidityVerificationService } from '../onchain/liquidity-verification.service';
import { RobinhoodExperimentalSafetyService } from '../onchain/robinhood-experimental-safety.service';
import type { ExecutionQuoteResult, LiquidityCheckResult } from '../onchain/onchain.types';
import { modelEntry, modelExit } from '../paper/fills';
import { RiskEngineService } from '../risk-engine/risk-engine.service';
import type { ContractRiskResult } from '../risk-engine/risk-engine.types';
import { contractHardRiskReason } from './flow-risk';
import {
  ROBINHOOD_EXECUTION_SCENARIOS,
  ROBINHOOD_EXPERIMENT_ARMS,
  ROBINHOOD_FLOW_V3_CONFIG,
  ROBINHOOD_FLOW_V3_CONFIG_HASH,
  evaluateRobinhoodFlowV3,
} from './robinhood-flow-v3';
import type { FlowTrade } from './flow.types';
import type { RobinhoodExperimentTick, RobinhoodFlowV3Snapshot } from './robinhood-experiment.types';

const ACTIVE_EXPERIMENT_STATUSES = ['CONFIRMING', 'CONFIRMED', 'EXPIRED'] as const;
const ACTIVE_ARM_STATUSES = ['PENDING_ENTRY', 'WAITING_CONFIRMATION', 'OPEN'] as const;
const SELL_LEG_TYPES = new Set([
  'LADDER_SELL', 'HARD_STOP_SELL', 'FLOW_REVERSAL_SELL', 'CREATOR_EXIT_SELL',
  'HARD_RISK_SELL', 'CONFIRMATION_EXPIRY_SELL', 'TIME_SELL',
]);

type DbExperiment = any;
type DbArm = any;
type DbLeg = any;

interface SafetyAssessment {
  risk: ContractRiskResult;
  hardReason: string | null;
  buyTaxPct: number;
  sellTaxPct: number;
  staticSnapshot: Record<string, unknown>;
}

@Injectable()
export class RobinhoodEntryExperimentService {
  private readonly logger = new Logger(RobinhoodEntryExperimentService.name);
  private readonly createAttemptAt = new Map<string, number>();
  private readonly dynamicSafetyAt = new Map<string, number>();
  private readonly marketEvaluationAt = new Map<string, number>();

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly liquidity: LiquidityVerificationService,
    private readonly staticSafety: RobinhoodExperimentalSafetyService,
    private readonly riskEngine: RiskEngineService,
    private readonly deployers: DeployerReputationService,
    private readonly gasModel: GasModelService,
    private readonly files: FileLoggerService,
  ) {}

  async handleTick(tick: RobinhoodExperimentTick): Promise<number | null> {
    if (tick.candidate.pool.chain !== 'robinhood' || tick.watchType !== 'FRESH') return null;
    let experiment = await this.findExperiment(tick.watchId);
    if (!experiment) {
      if (!tick.dataHealthy || !tick.pipelineHealthy) return null;
      const lastAttempt = this.createAttemptAt.get(tick.watchId) ?? 0;
      if (tick.observedAtMs - lastAttempt < 10_000) return null;
      this.createAttemptAt.set(tick.watchId, tick.observedAtMs);
      experiment = await this.tryCreateExperiment(tick);
      if (!experiment) return null;
    }
    if (!ACTIVE_EXPERIMENT_STATUSES.includes(experiment.status)) return null;
    if (experiment.configHash !== ROBINHOOD_FLOW_V3_CONFIG_HASH) {
      await this.invalidateExperiment(experiment, 'frozen_config_hash_mismatch');
      return null;
    }
    if (!tick.pipelineHealthy) {
      await this.invalidateExperiment(experiment, 'unhealthy_paired_signal_period');
      return null;
    }
    await this.processExperiment(experiment, tick);
    const latest = await this.findExperiment(tick.watchId);
    return latest && ACTIVE_EXPERIMENT_STATUSES.includes(latest.status)
      ? latest.horizonAt.getTime()
      : null;
  }

  async invalidateReorg(watchId: string, newHead: bigint): Promise<void> {
    const experiment = await this.findExperiment(watchId);
    if (!experiment || BigInt(experiment.t0Block) <= newHead) return;
    await this.invalidateExperiment(experiment, 'reorg_invalidated');
  }

  private async tryCreateExperiment(tick: RobinhoodExperimentTick): Promise<DbExperiment | null> {
    const maxTickAgeMs = this.config.get<number>('evmFlow.robinhoodExperimentMaxTickAgeMs') ?? 10_000;
    if (Date.now() - tick.observedAtMs > maxTickAgeMs) return null;
    const preflightStartedAtMs = Date.now();
    const pool = tick.candidate.pool;
    const [liq, buyQuote, sellQuote, safety, gasUsd] = await Promise.all([
      this.liquidity.verify(pool, tick.gemDecimals),
      this.liquidity.quoteTrade(pool, 20, 'BUY', tick.gemDecimals),
      this.liquidity.quoteTrade(pool, 20, 'SELL', tick.gemDecimals),
      this.assessSafety(tick),
      this.gasModel.estimateUsd('robinhood', tick.liquidityModel),
    ]);
    const preflight = await this.t0RejectReason(tick, liq, buyQuote, sellQuote, safety);
    if (preflight) {
      this.logger.debug(
        `Robinhood v3 t0 waiting ${tick.candidate.token.tokenAddress}: ${preflight}`,
      );
      return null;
    }
    const t0Ms = Date.now();
    if (!tick.pipelineHealthy || t0Ms - tick.observedAtMs > maxTickAgeMs) {
      this.logger.warn(
        `Robinhood v3 preflight stale ${tick.candidate.token.tokenAddress}: ` +
        `age=${t0Ms - tick.observedAtMs}ms preflight=${t0Ms - preflightStartedAtMs}ms`,
      );
      return null;
    }
    const sandwichPct = this.config.get<number>('paper.sandwichPct') ?? 0.01;
    const entry = modelEntry(buyQuote.spotPriceUsd!, buyQuote.slippagePct, {
      sizeUsd: 20,
      sandwichPct,
      gasUsd,
      buyTaxPct: safety.buyTaxPct,
      maxEntrySlipPct: ROBINHOOD_FLOW_V3_CONFIG.maxEntrySlippagePct,
    });
    if (!entry.entered || entry.tokensBought == null) return null;
    const exit = modelExit(entry.tokensBought, sellQuote.spotPriceUsd!, sellQuote.slippagePct, {
      sandwichPct,
      gasUsd,
      sellTaxPct: safety.sellTaxPct,
    });
    const roundTrip = exit.netUsd / 20;
    if (roundTrip < ROBINHOOD_FLOW_V3_CONFIG.minZeroMoveRoundTrip) return null;

    const t0At = new Date(t0Ms);
    const arms = ROBINHOOD_EXPERIMENT_ARMS.flatMap((arm) =>
      ROBINHOOD_EXECUTION_SCENARIOS.map((scenario) => {
        const legType = arm.code === 'A_IMMEDIATE_20' ? 'IMMEDIATE_BUY' : 'PROBE_BUY';
        return {
          armCode: arm.code,
          scenarioCode: scenario.code,
          latencyMs: scenario.latencyMs,
          gasMultiplier: scenario.gasMultiplier,
          confirmatory: arm.confirmatory,
          exploratory: arm.exploratory,
          primaryScenario: scenario.primary,
          stressScenario: scenario.stress,
          immediateUsd: arm.immediateUsd,
          addUsd: arm.addUsd,
          status: arm.immediateUsd > 0 ? 'PENDING_ENTRY' : 'WAITING_CONFIRMATION',
          stateJson: { lastCapitalAtMs: t0Ms, flowExitScheduled: false },
          ...(arm.immediateUsd > 0 ? {
            legs: { create: [{
              sequence: 1,
              legType,
              status: 'PENDING',
              intendedAt: t0At,
              targetAt: new Date(t0Ms + scenario.latencyMs),
              notionalUsd: arm.immediateUsd,
            }] },
          } : {}),
        };
      }),
    );
    const riskSnapshot = {
      decision: safety.risk.decision,
      providerStatus: safety.risk.providerStatus ?? null,
      rejectReasons: safety.risk.rejectReasons,
      merged: safety.risk.merged,
      static: safety.staticSnapshot,
      buyQuote,
      sellQuote,
      gasUsd,
    };
    const created = await (this.prisma as any).robinhoodEntryExperiment.create({
      data: {
        watchId: tick.watchId,
        tokenAddress: tick.candidate.token.tokenAddress.toLowerCase(),
        poolAddress: tick.candidate.pool.poolAddress.toLowerCase(),
        symbol: tick.candidate.token.symbol || null,
        liquidityModel: tick.liquidityModel,
        configVersion: ROBINHOOD_FLOW_V3_CONFIG.version,
        configHash: ROBINHOOD_FLOW_V3_CONFIG_HASH,
        configJson: ROBINHOOD_FLOW_V3_CONFIG as unknown as Prisma.InputJsonValue,
        t0At,
        horizonAt: new Date(t0Ms + ROBINHOOD_FLOW_V3_CONFIG.horizonMs),
        t0Block: tick.latestBlock.toString(),
        t0SpotPriceUsd: buyQuote.spotPriceUsd,
        t0DepthUsd: liq.executableDepthUsd,
        t0RoundTripMultiple: roundTrip,
        riskSnapshot: riskSnapshot as unknown as Prisma.InputJsonValue,
        dataHealthSnapshot: {
          ...tick.dataHealth,
          sourceTickAt: new Date(tick.observedAtMs).toISOString(),
          preflightLatencyMs: t0Ms - preflightStartedAtMs,
        } as Prisma.InputJsonValue,
        v2ShadowDecision: tick.v2ShadowDecision?.triggered ? 'TRIGGERED' : 'NOT_TRIGGERED',
        v2ShadowSnapshot: (tick.v2ShadowDecision ?? {}) as unknown as Prisma.InputJsonValue,
        arms: { create: arms },
      },
      include: { arms: { include: { legs: true } } },
    });
    this.logger.log(
      `ROBINHOOD EXPERIMENT t0 ${tick.candidate.token.tokenAddress} ` +
      `depth=$${Number(liq.executableDepthUsd).toFixed(0)} roundTrip=${roundTrip.toFixed(3)} ` +
      `arms=${arms.length} config=${ROBINHOOD_FLOW_V3_CONFIG_HASH.slice(0, 12)}`,
    );
    return created;
  }

  private async processExperiment(experiment: DbExperiment, tick: RobinhoodExperimentTick): Promise<void> {
    let current = await this.findExperiment(experiment.watchId);
    if (!current) return;

    // The t0 preflight already established static safety and an executable route.
    // Execute due immediate legs before any refresh RPCs consume their latency budget.
    await this.executeDueLegs(current, tick);
    current = await this.findExperiment(experiment.watchId);
    if (!current || current.status === 'INVALIDATED') return;

    const dynamicHardReason = await this.dynamicHardRiskReason(current, tick);
    const attributableCreator = tick.creatorAttributable ? tick.creatorAddress : null;
    const creatorSell = this.creatorSellSince(tick.trades, current.t0At.getTime(), attributableCreator);
    if (dynamicHardReason || creatorSell > 0) {
      const reason = dynamicHardReason ?? 'creator_sell_detected';
      await this.rejectConfirmation(current, tick, reason);
      await this.cancelPendingBuys(current, tick, reason);
      await this.scheduleFullExits(current, tick, reason === 'creator_sell_detected' ? 'CREATOR_EXIT_SELL' : 'HARD_RISK_SELL');
    }

    current = await this.findExperiment(experiment.watchId);
    if (!current || current.status === 'INVALIDATED') return;

    const liq = await this.liquidity.verify(tick.candidate.pool, tick.gemDecimals);
    if (current.confirmationStatus === 'PENDING') {
      await this.evaluateConfirmation(current, tick, liq);
      current = await this.findExperiment(experiment.watchId);
      if (!current) return;
    }
    await this.initializeClassifierReference(current, tick);
    current = await this.findExperiment(experiment.watchId);
    if (!current) return;
    if (this.shouldEvaluateMarket(current, tick)) {
      await this.updateClassifierOutcome(current, tick);
      await this.evaluateArmExits(current, tick, liq);
    }
    current = await this.findExperiment(experiment.watchId);
    if (!current) return;
    await this.executeDueLegs(current, tick);
    await this.resolveIfComplete(current, tick.observedAtMs);
  }

  private async evaluateConfirmation(
    experiment: DbExperiment,
    tick: RobinhoodExperimentTick,
    liq: LiquidityCheckResult,
  ): Promise<void> {
    const elapsedMs = tick.observedAtMs - experiment.t0At.getTime();
    if (elapsedMs > ROBINHOOD_FLOW_V3_CONFIG.confirmationEndMs) {
      await (this.prisma as any).robinhoodEntryExperiment.update({
        where: { id: experiment.id },
        data: {
          status: 'EXPIRED', confirmationStatus: 'EXPIRED', resolutionReason: 'confirmation_timeout',
          confirmationAt: new Date(tick.observedAtMs), confirmationBlock: tick.latestBlock.toString(),
          classifierReferenceStatus: 'SCHEDULED',
          classifierReferenceTargetAt: new Date(tick.observedAtMs + 2_000),
        },
      });
      await this.expireUnconfirmedArms(experiment, tick);
      return;
    }
    if (elapsedMs < ROBINHOOD_FLOW_V3_CONFIG.confirmationStartMs) return;
    if (!(liq.liquidityVerified && liq.spotPriceUsd && (liq.executableDepthUsd ?? 0) > 0)) return;
    const snapshot = evaluateRobinhoodFlowV3({
      trades: tick.trades,
      t0Ms: experiment.t0At.getTime(),
      nowMs: tick.observedAtMs,
      launchPriceUsd: tick.launchPriceUsd ?? Number(experiment.t0SpotPriceUsd),
      currentPriceUsd: liq.spotPriceUsd,
      t0DepthUsd: Number(experiment.t0DepthUsd),
      currentDepthUsd: liq.executableDepthUsd!,
      creatorAddress: tick.creatorAttributable ? tick.creatorAddress : null,
      hardRisk: false,
    });
    await (this.prisma as any).robinhoodEntryExperiment.update({
      where: { id: experiment.id },
      data: { confirmationSnapshot: snapshot as unknown as Prisma.InputJsonValue },
    });
    if (!snapshot.eligible) return;

    const safety = await this.assessSafety(tick);
    if (safety.hardReason) {
      await this.rejectConfirmation(experiment, tick, safety.hardReason);
      await this.scheduleFullExits(experiment, tick, 'HARD_RISK_SELL');
      return;
    }
    await (this.prisma as any).robinhoodEntryExperiment.update({
      where: { id: experiment.id },
      data: {
        status: 'CONFIRMED',
        confirmationStatus: 'CONFIRMED',
        confirmationAt: new Date(tick.observedAtMs),
        confirmationBlock: tick.latestBlock.toString(),
        confirmationSnapshot: snapshot as unknown as Prisma.InputJsonValue,
        classifierReferenceStatus: 'SCHEDULED',
        classifierReferenceTargetAt: new Date(tick.observedAtMs + 2_000),
      },
    });
    for (const arm of experiment.arms as DbArm[]) {
      if (Number(arm.addUsd) <= 0 || !ACTIVE_ARM_STATUSES.includes(arm.status)) continue;
      await this.createPendingLeg(arm, 'CONFIRM_ADD', tick.observedAtMs, tick.observedAtMs + arm.latencyMs, Number(arm.addUsd));
    }
    this.logger.log(
      `ROBINHOOD FLOW V3 CONFIRMED ${tick.candidate.token.tokenAddress}: ` +
      `newBuyers=${snapshot.latestNewBuyers} accel=${format(snapshot.newBuyerAcceleration)} ` +
      `pressure=${format(snapshot.netBuyPressure)} organic=${format(snapshot.organicBuyShare)} ` +
      `retention=${format(snapshot.earlyBuyerRetention)}`,
    );
  }

  private async executeDueLegs(experiment: DbExperiment, tick: RobinhoodExperimentTick): Promise<void> {
    const executionStartedAtMs = Date.now();
    const due = (experiment.arms as DbArm[])
      .flatMap((arm) => (arm.legs as DbLeg[]).map((leg) => ({ arm, leg })))
      .filter(({ leg }) => leg.status === 'PENDING' && leg.targetAt.getTime() <= executionStartedAtMs)
      .sort((left, right) => left.leg.targetAt.getTime() - right.leg.targetAt.getTime());
    const maxLatenessMs = this.config.get<number>('evmFlow.robinhoodExperimentMaxLegLatenessMs') ?? 3_000;
    const lateLeg = due.find(({ leg }) => executionStartedAtMs - leg.targetAt.getTime() > maxLatenessMs);
    if (lateLeg) {
      await this.invalidateExperiment(
        experiment,
        `execution_window_missed:${lateLeg.leg.legType}:${executionStartedAtMs - lateLeg.leg.targetAt.getTime()}ms`,
      );
      return;
    }
    const quoteCache = new Map<string, Promise<ExecutionQuoteResult>>();
    for (const { leg } of due) {
      if (!SELL_LEG_TYPES.has(leg.legType)) {
        void this.cachedQuote(quoteCache, tick, Number(leg.notionalUsd), 'BUY');
      }
    }
    await Promise.all(quoteCache.values());
    for (const { leg } of due) {
      if (SELL_LEG_TYPES.has(leg.legType)) continue;
      const quote = await this.cachedQuote(quoteCache, tick, Number(leg.notionalUsd), 'BUY');
      const quoteLatenessMs = quote.observedAt.getTime() - leg.targetAt.getTime();
      if (quoteLatenessMs > maxLatenessMs) {
        await this.invalidateExperiment(
          experiment,
          `quote_window_missed:${leg.legType}:${quoteLatenessMs}ms`,
        );
        return;
      }
    }
    const gasBase = await this.gasModel.estimateUsd('robinhood', tick.liquidityModel);
    const spotPriceUsd = due.some(({ leg }) => SELL_LEG_TYPES.has(leg.legType))
      ? (await this.liquidity.verify(tick.candidate.pool, tick.gemDecimals)).spotPriceUsd
      : null;
    for (const item of due) {
      const latestArm = await (this.prisma as any).robinhoodExperimentArm.findUnique({
        where: { id: item.arm.id }, include: { legs: true, experiment: true },
      });
      const latestLeg = latestArm?.legs?.find((leg: DbLeg) => leg.id === item.leg.id);
      if (!latestLeg || latestLeg.status !== 'PENDING') continue;
      if (!latestArm || !ACTIVE_ARM_STATUSES.includes(latestArm.status)) {
        await this.skipLeg(latestLeg.id, tick, 'arm_not_active');
        continue;
      }
      if (SELL_LEG_TYPES.has(latestLeg.legType)) {
        await this.executeSellLeg(latestArm, latestLeg, tick, gasBase, quoteCache, spotPriceUsd);
      } else {
        await this.executeBuyLeg(latestArm, latestLeg, tick, gasBase, quoteCache);
      }
    }
  }

  private async executeBuyLeg(
    arm: DbArm,
    leg: DbLeg,
    tick: RobinhoodExperimentTick,
    gasBase: number,
    quotes: Map<string, Promise<ExecutionQuoteResult>>,
  ): Promise<void> {
    const sizeUsd = Number(leg.notionalUsd);
    const quote = await this.cachedQuote(quotes, tick, sizeUsd, 'BUY');
    const executedAt = quote.observedAt;
    const gasUsd = gasBase * Number(arm.gasMultiplier);
    const risk = arm.experiment.riskSnapshot as any;
    const buyTaxPct = this.taxFraction(risk?.merged?.buyTax);
    const fill = modelEntry(quote.spotPriceUsd ?? 0, quote.slippagePct, {
      sizeUsd,
      sandwichPct: this.config.get<number>('paper.sandwichPct') ?? 0.01,
      gasUsd,
      buyTaxPct,
      maxEntrySlipPct: ROBINHOOD_FLOW_V3_CONFIG.maxEntrySlippagePct,
    });
    if (!quote.executable || !fill.entered || fill.tokensBought == null || fill.effectivePriceUsd == null) {
      const reason = quote.error ?? fill.reason ?? 'delayed_quote_failed';
      const noTrade = Number(arm.tokensBought) <= 0 &&
        (leg.legType === 'CONFIRM_ADD' || leg.legType === 'IMMEDIATE_BUY');
      await (this.prisma as any).$transaction([
        (this.prisma as any).robinhoodExperimentLeg.update({
          where: { id: leg.id }, data: {
            status: 'FAILED', executedAt, blockNumber: tick.latestBlock.toString(),
            spotPriceUsd: quote.spotPriceUsd, slippagePct: quote.slippagePct, gasUsd,
            failureReason: reason, quoteSnapshot: quote as unknown as Prisma.InputJsonValue,
          },
        }),
        (this.prisma as any).robinhoodExperimentArm.update({
          where: { id: arm.id }, data: {
            committedUsd: { increment: gasUsd }, gasSpentUsd: { increment: gasUsd },
            status: Number(arm.tokensBought) > 0 ? arm.status : noTrade ? 'NO_TRADE' : 'WAITING_CONFIRMATION',
            closedAt: noTrade ? executedAt : undefined,
            outcomeClass: noTrade ? 'EXECUTION_FAILED' : undefined,
          },
        }),
      ]);
      this.logEntry(arm, leg, tick, quote, null, gasUsd, buyTaxPct, reason, executedAt);
      return;
    }
    const tokensBought = fill.tokensBought;
    const previousTokens = Number(arm.tokensBought);
    const totalTokens = previousTokens + tokensBought;
    const committedUsd = Number(arm.committedUsd) + sizeUsd;
    await (this.prisma as any).$transaction([
      (this.prisma as any).robinhoodExperimentLeg.update({
        where: { id: leg.id }, data: {
          status: 'FILLED', executedAt, blockNumber: tick.latestBlock.toString(),
          tokenAmount: tokensBought, spotPriceUsd: quote.spotPriceUsd,
          effectivePriceUsd: fill.effectivePriceUsd, slippagePct: quote.slippagePct,
          gasUsd, taxPct: buyTaxPct, netUsd: -sizeUsd,
          quoteSnapshot: quote as unknown as Prisma.InputJsonValue,
        },
      }),
      (this.prisma as any).robinhoodExperimentArm.update({
        where: { id: arm.id }, data: {
          status: leg.legType === 'PROBE_BUY' ? 'WAITING_CONFIRMATION' : 'OPEN',
          committedUsd,
          tokensBought: totalTokens,
          remainingTokens: Number(arm.remainingTokens) + tokensBought,
          blendedCostBasisUsd: committedUsd / totalTokens,
          gasSpentUsd: { increment: gasUsd },
          openedAt: arm.openedAt ?? executedAt,
        },
      }),
    ]);
    this.logEntry(arm, leg, tick, quote, fill, gasUsd, buyTaxPct, null, executedAt);
  }

  private async executeSellLeg(
    arm: DbArm,
    leg: DbLeg,
    tick: RobinhoodExperimentTick,
    gasBase: number,
    quotes: Map<string, Promise<ExecutionQuoteResult>>,
    spotPriceUsd: number | null,
  ): Promise<void> {
    const tokensToSell = Math.min(Number(leg.tokenAmount ?? 0), Number(arm.remainingTokens));
    if (!(tokensToSell > 0)) {
      await this.skipLeg(leg.id, tick, 'no_remaining_tokens');
      return;
    }
    const grossUsd = tokensToSell * (spotPriceUsd ?? 0);
    const quote = spotPriceUsd && spotPriceUsd > 0
      ? await this.cachedQuote(quotes, tick, Math.max(grossUsd, 0.000001), 'SELL')
      : {
          liquidityModel: tick.liquidityModel,
          direction: 'SELL' as const,
          sizeUsd: grossUsd,
          spotPriceUsd: null,
          slippagePct: null,
          executable: false,
          observedAt: new Date(),
          error: 'sell_spot_unavailable',
        };
    const gasUsd = gasBase * Number(arm.gasMultiplier);
    const executedAt = quote.observedAt;
    const risk = arm.experiment.riskSnapshot as any;
    const sellTaxPct = this.taxFraction(risk?.merged?.sellTax);
    if (!quote.executable || !(quote.spotPriceUsd && quote.spotPriceUsd > 0)) {
      const reason = quote.error ?? 'sell_quote_failed';
      await (this.prisma as any).$transaction([
        (this.prisma as any).robinhoodExperimentLeg.update({
          where: { id: leg.id }, data: {
            status: 'FAILED', executedAt, blockNumber: tick.latestBlock.toString(),
            spotPriceUsd: quote.spotPriceUsd, slippagePct: quote.slippagePct, gasUsd,
            failureReason: reason, quoteSnapshot: quote as unknown as Prisma.InputJsonValue,
          },
        }),
        (this.prisma as any).robinhoodExperimentArm.update({
          where: { id: arm.id }, data: {
            committedUsd: { increment: gasUsd }, gasSpentUsd: { increment: gasUsd },
          },
        }),
      ]);
      this.logExit(arm, leg, tick, quote, 0, gasUsd, sellTaxPct, reason, null, executedAt);
      return;
    }
    const fill = modelExit(tokensToSell, quote.spotPriceUsd, quote.slippagePct, {
      sandwichPct: this.config.get<number>('paper.sandwichPct') ?? 0.01,
      gasUsd,
      sellTaxPct,
    });
    const remainingTokens = Math.max(0, Number(arm.remainingTokens) - tokensToSell);
    const realizedValueUsd = Number(arm.realizedValueUsd) + fill.netUsd;
    const committedUsd = Number(arm.committedUsd);
    const closed = remainingTokens <= Math.max(1e-12, Number(arm.tokensBought) * 1e-9);
    const realizedMultiple = committedUsd > 0 ? realizedValueUsd / committedUsd : 0;
    const outcomeClass = closed ? this.outcomeFor(leg.legType, realizedMultiple) : null;
    await (this.prisma as any).$transaction([
      (this.prisma as any).robinhoodExperimentLeg.update({
        where: { id: leg.id }, data: {
          status: 'FILLED', executedAt, blockNumber: tick.latestBlock.toString(),
          tokenAmount: tokensToSell, notionalUsd: grossUsd, spotPriceUsd: quote.spotPriceUsd,
          effectivePriceUsd: tokensToSell > 0 ? fill.netUsd / tokensToSell : null,
          slippagePct: quote.slippagePct, gasUsd, taxPct: sellTaxPct, netUsd: fill.netUsd,
          quoteSnapshot: quote as unknown as Prisma.InputJsonValue,
        },
      }),
      (this.prisma as any).robinhoodExperimentArm.update({
        where: { id: arm.id }, data: {
          status: closed ? 'CLOSED' : 'OPEN',
          remainingTokens,
          realizedValueUsd,
          gasSpentUsd: { increment: gasUsd },
          realizedMultiple: closed ? realizedMultiple : undefined,
          closedAt: closed ? executedAt : undefined,
          outcomeClass: closed ? outcomeClass : undefined,
        },
      }),
    ]);
    this.logExit(arm, leg, tick, quote, fill.netUsd, gasUsd, sellTaxPct, null, outcomeClass, executedAt);
  }

  private async evaluateArmExits(
    experiment: DbExperiment,
    tick: RobinhoodExperimentTick,
    liq: LiquidityCheckResult,
  ): Promise<void> {
    if (!(liq.liquidityVerified && liq.spotPriceUsd && liq.spotPriceUsd > 0)) return;
    const quoteCache = new Map<string, Promise<ExecutionQuoteResult>>();
    for (const arm of experiment.arms as DbArm[]) {
      if (!ACTIVE_ARM_STATUSES.includes(arm.status) || !(Number(arm.remainingTokens) > 0)) continue;
      await this.accrueCapitalSeconds(arm, tick.observedAtMs);
      const pendingBuy = (arm.legs as DbLeg[]).some((leg) => leg.status === 'PENDING' && !SELL_LEG_TYPES.has(leg.legType));
      if (pendingBuy) continue;
      const pendingExit = (arm.legs as DbLeg[]).some((leg) => leg.status === 'PENDING' && SELL_LEG_TYPES.has(leg.legType));
      if (pendingExit) continue;
      const grossUsd = Number(arm.remainingTokens) * liq.spotPriceUsd;
      const quote = await this.cachedQuote(quoteCache, tick, Math.max(grossUsd, 0.000001), 'SELL');
      if (!quote.executable || !(quote.spotPriceUsd && quote.spotPriceUsd > 0)) continue;
      const gasUsd = await this.gasModel.estimateUsd('robinhood', tick.liquidityModel) * Number(arm.gasMultiplier);
      const risk = experiment.riskSnapshot as any;
      const liquidation = modelExit(Number(arm.remainingTokens), quote.spotPriceUsd, quote.slippagePct, {
        sandwichPct: this.config.get<number>('paper.sandwichPct') ?? 0.01,
        gasUsd,
        sellTaxPct: this.taxFraction(risk?.merged?.sellTax),
      });
      const committed = Number(arm.committedUsd);
      const multiple = committed > 0 ? (Number(arm.realizedValueUsd) + liquidation.netUsd) / committed : 0;
      const previousPeak = Number(arm.peakMultiple ?? multiple);
      const peak = Math.max(previousPeak, multiple);
      const drawdown = peak > 0 ? Math.max(0, (peak - multiple) / peak) : 0;
      await (this.prisma as any).robinhoodExperimentArm.update({
        where: { id: arm.id }, data: {
          currentMultiple: multiple,
          peakMultiple: peak,
          maxDrawdown: Math.max(Number(arm.maxDrawdown ?? 0), drawdown),
        },
      });

      const horizonReached = tick.observedAtMs >= experiment.horizonAt.getTime();
      if (horizonReached) {
        await this.createSellLeg(arm, 'TIME_SELL', tick.observedAtMs, Number(arm.remainingTokens));
        continue;
      }
      if (multiple <= ROBINHOOD_FLOW_V3_CONFIG.hardStopMultiple) {
        await this.createSellLeg(arm, 'HARD_STOP_SELL', tick.observedAtMs, Number(arm.remainingTokens));
        continue;
      }
      if (this.flowReversed(tick.trades, tick.observedAtMs) && drawdown >= ROBINHOOD_FLOW_V3_CONFIG.flowReversalDrawdown) {
        await this.createSellLeg(arm, 'FLOW_REVERSAL_SELL', tick.observedAtMs, Number(arm.remainingTokens));
        continue;
      }
      const executed = new Set(String(arm.executedRungs || '').split(',').filter(Boolean).map(Number));
      const rungs = [
        { multiple: 2, fraction: 0.80 },
        { multiple: 10, fraction: 0.15 },
        { multiple: 1000, fraction: 0.05 },
      ].filter((rung) => multiple >= rung.multiple && !executed.has(rung.multiple));
      let remaining = Number(arm.remainingTokens);
      for (const rung of rungs) {
        const tokens = Math.min(remaining, Number(arm.tokensBought) * rung.fraction);
        if (!(tokens > 0)) continue;
        await this.createSellLeg(arm, 'LADDER_SELL', tick.observedAtMs, tokens, `rung:${rung.multiple}`);
        executed.add(rung.multiple);
        remaining -= tokens;
      }
      if (rungs.length) {
        await (this.prisma as any).robinhoodExperimentArm.update({
          where: { id: arm.id }, data: { executedRungs: [...executed].sort((a, b) => a - b).join(',') },
        });
      }
    }
  }

  private async expireUnconfirmedArms(experiment: DbExperiment, tick: RobinhoodExperimentTick): Promise<void> {
    for (const arm of experiment.arms as DbArm[]) {
      if (arm.armCode === 'A_IMMEDIATE_20') continue;
      if (Number(arm.remainingTokens) > 0) {
        await this.createSellLeg(arm, 'CONFIRMATION_EXPIRY_SELL', tick.observedAtMs, Number(arm.remainingTokens));
      } else {
        await (this.prisma as any).robinhoodExperimentArm.update({
          where: { id: arm.id },
          data: { status: 'NO_TRADE', closedAt: new Date(tick.observedAtMs), outcomeClass: 'NO_CONFIRMATION' },
        });
      }
    }
  }

  private async scheduleFullExits(experiment: DbExperiment, tick: RobinhoodExperimentTick, legType: string): Promise<void> {
    for (const arm of experiment.arms as DbArm[]) {
      if (Number(arm.remainingTokens) > 0 && ACTIVE_ARM_STATUSES.includes(arm.status)) {
        await this.createSellLeg(arm, legType, tick.observedAtMs, Number(arm.remainingTokens));
      } else if (ACTIVE_ARM_STATUSES.includes(arm.status)) {
        await (this.prisma as any).robinhoodExperimentArm.update({
          where: { id: arm.id }, data: { status: 'NO_TRADE', closedAt: new Date(tick.observedAtMs), outcomeClass: 'HARD_REJECT' },
        });
      }
    }
  }

  private async cancelPendingBuys(experiment: DbExperiment, tick: RobinhoodExperimentTick, reason: string): Promise<void> {
    const pendingBuyIds = (experiment.arms as DbArm[])
      .flatMap((arm) => arm.legs as DbLeg[])
      .filter((leg) => leg.status === 'PENDING' && !SELL_LEG_TYPES.has(leg.legType))
      .map((leg) => leg.id);
    if (!pendingBuyIds.length) return;
    await (this.prisma as any).robinhoodExperimentLeg.updateMany({
      where: { id: { in: pendingBuyIds } },
      data: {
        status: 'SKIPPED', executedAt: new Date(tick.observedAtMs),
        blockNumber: tick.latestBlock.toString(), failureReason: reason,
      },
    });
  }

  private async createSellLeg(
    arm: DbArm,
    legType: string,
    intendedAtMs: number,
    tokens: number,
    note?: string,
  ): Promise<void> {
    const pending = (arm.legs as DbLeg[]).some((leg) => leg.status === 'PENDING' && SELL_LEG_TYPES.has(leg.legType));
    if (pending) return;
    await this.createPendingLeg(
      arm,
      legType,
      intendedAtMs,
      intendedAtMs + Number(arm.latencyMs),
      0,
      tokens,
      note,
    );
  }

  private async createPendingLeg(
    arm: DbArm,
    legType: string,
    intendedAtMs: number,
    targetAtMs: number,
    notionalUsd: number,
    tokenAmount?: number,
    note?: string,
  ): Promise<void> {
    const lastLeg = await (this.prisma as any).robinhoodExperimentLeg.findFirst({
      where: { armId: arm.id }, orderBy: { sequence: 'desc' }, select: { sequence: true },
    });
    const sequence = Number(lastLeg?.sequence ?? 0) + 1;
    await (this.prisma as any).robinhoodExperimentLeg.create({
      data: {
        armId: arm.id,
        sequence,
        legType,
        status: 'PENDING',
        intendedAt: new Date(intendedAtMs),
        targetAt: new Date(targetAtMs),
        notionalUsd,
        tokenAmount: tokenAmount ?? null,
        failureReason: note ?? null,
      },
    });
  }

  private async rejectConfirmation(experiment: DbExperiment, tick: RobinhoodExperimentTick, reason: string): Promise<void> {
    if (experiment.confirmationStatus !== 'PENDING') return;
    await (this.prisma as any).robinhoodEntryExperiment.update({
      where: { id: experiment.id },
      data: {
        status: 'EXPIRED', confirmationStatus: 'REJECTED',
        resolutionReason: reason, confirmationAt: new Date(tick.observedAtMs),
        confirmationBlock: tick.latestBlock.toString(),
        classifierReferenceStatus: 'UNAVAILABLE',
        classifierResolvedAt: new Date(tick.observedAtMs),
      },
    });
  }

  private async initializeClassifierReference(experiment: DbExperiment, tick: RobinhoodExperimentTick): Promise<void> {
    if (experiment.classifierReferenceStatus !== 'SCHEDULED') return;
    const targetAt = experiment.classifierReferenceTargetAt?.getTime();
    if (targetAt == null || tick.observedAtMs < targetAt) return;
    const quote = await this.liquidity.quoteTrade(tick.candidate.pool, 20, 'BUY', tick.gemDecimals);
    const gasUsd = await this.gasModel.estimateUsd('robinhood', tick.liquidityModel);
    const risk = experiment.riskSnapshot as any;
    const fill = modelEntry(quote.spotPriceUsd ?? 0, quote.slippagePct, {
      sizeUsd: 20,
      sandwichPct: this.config.get<number>('paper.sandwichPct') ?? 0.01,
      gasUsd,
      buyTaxPct: this.taxFraction(risk?.merged?.buyTax),
      maxEntrySlipPct: ROBINHOOD_FLOW_V3_CONFIG.maxEntrySlippagePct,
    });
    if (!quote.executable || !fill.entered || fill.tokensBought == null) {
      await (this.prisma as any).robinhoodEntryExperiment.update({
        where: { id: experiment.id },
        data: {
          classifierReferenceStatus: 'UNAVAILABLE',
          classifierReferenceAt: new Date(tick.observedAtMs),
          classifierResolvedAt: new Date(tick.observedAtMs),
          classifierReached2x: null,
        },
      });
      return;
    }
    await (this.prisma as any).robinhoodEntryExperiment.update({
      where: { id: experiment.id },
      data: {
        classifierReferenceStatus: 'TRACKING',
        classifierReferenceAt: new Date(tick.observedAtMs),
        classifierReferenceTokens: fill.tokensBought,
        classifierReferenceCostUsd: 20,
        classifierReferenceMaxMultiple: 0,
        classifierReached2x: false,
      },
    });
  }

  private async updateClassifierOutcome(experiment: DbExperiment, tick: RobinhoodExperimentTick): Promise<void> {
    if (experiment.classifierReferenceStatus !== 'TRACKING') return;
    const tokens = Number(experiment.classifierReferenceTokens ?? 0);
    const cost = Number(experiment.classifierReferenceCostUsd ?? 20);
    let maxMultiple = Number(experiment.classifierReferenceMaxMultiple ?? 0);
    if (tokens > 0 && cost > 0) {
      const liq = await this.liquidity.verify(tick.candidate.pool, tick.gemDecimals);
      if (liq.spotPriceUsd && liq.spotPriceUsd > 0) {
        const grossUsd = tokens * liq.spotPriceUsd;
        const quote = await this.liquidity.quoteTrade(
          tick.candidate.pool, Math.max(grossUsd, 0.000001), 'SELL', tick.gemDecimals,
        );
        if (quote.executable && quote.spotPriceUsd && quote.spotPriceUsd > 0) {
          const risk = experiment.riskSnapshot as any;
          const gasUsd = await this.gasModel.estimateUsd('robinhood', tick.liquidityModel);
          const fill = modelExit(tokens, quote.spotPriceUsd, quote.slippagePct, {
            sandwichPct: this.config.get<number>('paper.sandwichPct') ?? 0.01,
            gasUsd,
            sellTaxPct: this.taxFraction(risk?.merged?.sellTax),
          });
          maxMultiple = Math.max(maxMultiple, fill.netUsd / cost);
          await (this.prisma as any).robinhoodEntryExperiment.update({
            where: { id: experiment.id },
            data: {
              classifierReferenceMaxMultiple: maxMultiple,
              classifierReached2x: maxMultiple >= 2,
            },
          });
        }
      }
    }
    if (tick.observedAtMs >= experiment.horizonAt.getTime()) {
      await (this.prisma as any).robinhoodEntryExperiment.update({
        where: { id: experiment.id },
        data: {
          classifierReferenceStatus: 'RESOLVED',
          classifierResolvedAt: new Date(tick.observedAtMs),
          classifierReferenceMaxMultiple: maxMultiple,
          classifierReached2x: maxMultiple >= 2,
        },
      });
    }
  }

  private async resolveIfComplete(experiment: DbExperiment, nowMs: number): Promise<void> {
    const latest = await this.findExperiment(experiment.watchId);
    if (!latest) return;
    const allTerminal = (latest.arms as DbArm[]).every((arm) => ['CLOSED', 'NO_TRADE', 'INVALIDATED'].includes(arm.status));
    const classifierTerminal = ['RESOLVED', 'UNAVAILABLE'].includes(latest.classifierReferenceStatus);
    if (!allTerminal || !classifierTerminal) return;
    await (this.prisma as any).robinhoodEntryExperiment.update({
      where: { id: latest.id },
      data: { status: 'RESOLVED', resolvedAt: new Date(nowMs), resolutionReason: latest.resolutionReason ?? 'all_arms_terminal' },
    });
  }

  private async invalidateExperiment(experiment: DbExperiment, reason: string): Promise<void> {
    const invalidatedAt = new Date();
    await (this.prisma as any).$transaction([
      (this.prisma as any).robinhoodEntryExperiment.update({
        where: { id: experiment.id },
        data: { status: 'INVALIDATED', invalidReason: reason, resolvedAt: invalidatedAt, resolutionReason: reason },
      }),
      (this.prisma as any).robinhoodExperimentArm.updateMany({
        where: { experimentId: experiment.id, status: { in: [...ACTIVE_ARM_STATUSES] } },
        data: { status: 'INVALIDATED', outcomeClass: 'INVALIDATED', closedAt: invalidatedAt },
      }),
      (this.prisma as any).robinhoodExperimentLeg.updateMany({
        where: { arm: { experimentId: experiment.id }, status: 'PENDING' },
        data: { status: 'SKIPPED', failureReason: reason },
      }),
    ]);
    for (const arm of experiment.arms as DbArm[]) {
      this.files.logPaperExit({
        ts: invalidatedAt.toISOString(), run_id: experiment.id,
        schema_version: CSV_SCHEMA_VERSION, chain: 'robinhood', token_address: experiment.tokenAddress,
        symbol: experiment.symbol ?? '', pool_address: experiment.poolAddress,
        event_type: 'EXPERIMENT_INVALIDATED', status: 'invalidated', price_usd: '',
        multiple: '', fraction: '0', tokens: '0', net_usd: '0', slip_pct: '',
        realized_multiple_total: '', note: reason, deployer_address: '',
        deployer_deployments_count: '', deployer_rug_count: '', outcome_class: 'INVALIDATED',
        strategy_version: ROBINHOOD_FLOW_V3_CONFIG.version, risk_cohort: 'ROBINHOOD_STATIC_SAFETY',
        exit_policy: 'ROBINHOOD_EXPERIMENT_LADDER', experiment_id: experiment.id,
        experiment_arm: arm.armCode, execution_scenario: arm.scenarioCode,
        execution_leg: 'EXPERIMENT_INVALIDATED', config_hash: ROBINHOOD_FLOW_V3_CONFIG_HASH,
        target_execution_at: '', executed_at: invalidatedAt.toISOString(),
      });
    }
    this.logger.warn(`Robinhood experiment invalidated ${experiment.id}: ${reason}`);
  }

  private async t0RejectReason(
    tick: RobinhoodExperimentTick,
    liq: LiquidityCheckResult,
    buyQuote: ExecutionQuoteResult,
    sellQuote: ExecutionQuoteResult,
    safety: SafetyAssessment,
  ): Promise<string | null> {
    if (safety.hardReason) return safety.hardReason;
    if (!liq.liquidityVerified || !(liq.spotPriceUsd && liq.spotPriceUsd > 0)) return 'liquidity_unverified';
    if ((liq.executableDepthUsd ?? 0) < ROBINHOOD_FLOW_V3_CONFIG.minExecutableDepthUsd) return 'depth_below_100';
    if (!buyQuote.executable || buyQuote.slippagePct == null) return 'buy_route_unavailable';
    if (!sellQuote.executable || sellQuote.slippagePct == null) return 'sell_route_unavailable';
    if (buyQuote.slippagePct > ROBINHOOD_FLOW_V3_CONFIG.maxEntrySlippagePct) return 'entry_slippage_over_3pct';
    if (tick.creatorAttributable && tick.creatorAddress) {
      const block = await this.deployers.findBlocklistHit('robinhood', tick.creatorAddress);
      if (block) return `blocked_creator:${block.reason}`;
      const summary = await this.deployers.summarize('robinhood', tick.creatorAddress);
      if (summary && summary.rugLikeCount >= 1) return 'prior_rug_creator';
    }
    return null;
  }

  private async assessSafety(tick: RobinhoodExperimentTick): Promise<SafetyAssessment> {
    const [staticResult, risk] = await Promise.all([
      this.staticSafety.inspect(tick.candidate.token.tokenAddress),
      this.riskEngine.checkToken(
        'robinhood', tick.candidate.token.tokenAddress,
        tick.candidate.token.symbol, tick.candidate.token.name,
        `robinhood-exp-${randomUUID()}`,
      ),
    ]);
    const hardReason = !staticResult.passed
      ? `static_safety:${staticResult.reasons.join('|')}`
      : contractHardRiskReason(risk);
    return {
      risk,
      hardReason,
      buyTaxPct: this.taxFraction(risk.merged.buyTax),
      sellTaxPct: this.taxFraction(risk.merged.sellTax),
      staticSnapshot: staticResult as unknown as Record<string, unknown>,
    };
  }

  private async dynamicHardRiskReason(experiment: DbExperiment, tick: RobinhoodExperimentTick): Promise<string | null> {
    const now = tick.observedAtMs;
    const last = this.dynamicSafetyAt.get(experiment.id) ?? experiment.t0At.getTime();
    if (now - last < 10_000) return null;
    this.dynamicSafetyAt.set(experiment.id, now);
    const staticResult = await this.staticSafety.inspect(tick.candidate.token.tokenAddress);
    if (staticResult.passed) return null;
    const evidencedReasons = staticResult.reasons.filter(
      (reason) => reason !== 'static_safety_read_failed' && reason !== 'no_robinhood_rpc_client',
    );
    return evidencedReasons.length ? `dynamic_static_safety:${evidencedReasons.join('|')}` : null;
  }

  private creatorSellSince(trades: readonly FlowTrade[], t0Ms: number, creatorAddress: string | null): number {
    if (!creatorAddress) return 0;
    const creator = creatorAddress.toLowerCase();
    return trades
      .filter((trade) => trade.occurredAtMs >= t0Ms && trade.kind === 'SELL' && trade.trader.toLowerCase() === creator)
      .reduce((sum, trade) => sum + trade.quoteAmountUsd, 0);
  }

  private flowReversed(trades: readonly FlowTrade[], nowMs: number): boolean {
    const ratio = (start: number, end: number): number => {
      const window = trades.filter((trade) => trade.occurredAtMs > start && trade.occurredAtMs <= end);
      const buys = window.filter((trade) => trade.kind === 'BUY').reduce((sum, trade) => sum + trade.quoteAmountUsd, 0);
      const sells = window.filter((trade) => trade.kind === 'SELL').reduce((sum, trade) => sum + trade.quoteAmountUsd, 0);
      return sells > 0 ? buys / sells : buys > 0 ? Number.POSITIVE_INFINITY : 0;
    };
    return ratio(nowMs - 30_000, nowMs) < ROBINHOOD_FLOW_V3_CONFIG.flowReversalBuySellRatio &&
      ratio(nowMs - 60_000, nowMs - 30_000) < ROBINHOOD_FLOW_V3_CONFIG.flowReversalBuySellRatio;
  }

  private shouldEvaluateMarket(experiment: DbExperiment, tick: RobinhoodExperimentTick): boolean {
    const last = this.marketEvaluationAt.get(experiment.id) ?? experiment.t0At.getTime();
    const latestTrade = tick.trades.at(-1);
    const swapBearingHead = latestTrade?.blockNumber === tick.latestBlock.toString();
    const fallbackDue = tick.observedAtMs - last >= 30_000;
    const horizonDue = tick.observedAtMs >= experiment.horizonAt.getTime();
    if (!swapBearingHead && !fallbackDue && !horizonDue) return false;
    this.marketEvaluationAt.set(experiment.id, tick.observedAtMs);
    return true;
  }

  private async accrueCapitalSeconds(arm: DbArm, nowMs: number): Promise<void> {
    const state = (arm.stateJson ?? {}) as Record<string, unknown>;
    const last = Number(state.lastCapitalAtMs ?? arm.openedAt?.getTime() ?? nowMs);
    const activeCapital = Number(arm.committedUsd) * Math.min(1, Number(arm.remainingTokens) / Math.max(Number(arm.tokensBought), 1e-18));
    const increment = Math.max(0, (nowMs - last) / 1000) * Math.max(0, activeCapital);
    await (this.prisma as any).robinhoodExperimentArm.update({
      where: { id: arm.id },
      data: {
        capitalSeconds: { increment },
        stateJson: { ...state, lastCapitalAtMs: nowMs } as Prisma.InputJsonValue,
      },
    });
  }

  private async cachedQuote(
    cache: Map<string, Promise<ExecutionQuoteResult>>,
    tick: RobinhoodExperimentTick,
    sizeUsd: number,
    direction: 'BUY' | 'SELL',
  ): Promise<ExecutionQuoteResult> {
    const key = `${direction}:${sizeUsd.toFixed(6)}`;
    let pending = cache.get(key);
    if (!pending) {
      pending = this.liquidity.quoteTrade(tick.candidate.pool, sizeUsd, direction, tick.gemDecimals)
        .then((quote) => ({ ...quote, observedAt: new Date() }));
      cache.set(key, pending);
    }
    return pending;
  }

  private async skipLeg(legId: string, tick: RobinhoodExperimentTick, reason: string): Promise<void> {
    const executedAt = new Date();
    await (this.prisma as any).robinhoodExperimentLeg.update({
      where: { id: legId },
      data: { status: 'SKIPPED', executedAt, blockNumber: tick.latestBlock.toString(), failureReason: reason },
    });
  }

  private async findExperiment(watchId: string): Promise<DbExperiment | null> {
    return (this.prisma as any).robinhoodEntryExperiment.findUnique({
      where: { watchId },
      include: { arms: { include: { legs: { orderBy: { sequence: 'asc' } } } } },
    });
  }

  private taxFraction(value: number | null | undefined): number {
    if (value == null || !Number.isFinite(value) || value <= 0) return 0;
    return value > 1 ? value / 100 : value;
  }

  private outcomeFor(legType: string, multiple: number): string {
    if (legType === 'HARD_STOP_SELL') return multiple >= 1 ? 'PARTIAL_PROFIT_STOP' : 'STOP_LOSS';
    if (legType === 'FLOW_REVERSAL_SELL') return multiple >= 1 ? 'PARTIAL_PROFIT_FLOW_EXIT' : 'FLOW_EXIT_LOSS';
    if (legType === 'CREATOR_EXIT_SELL') return multiple >= 1 ? 'PARTIAL_PROFIT_CREATOR_EXIT' : 'CREATOR_EXIT_LOSS';
    if (legType === 'HARD_RISK_SELL') return multiple >= 1 ? 'PARTIAL_PROFIT_HARD_RISK' : 'HARD_RISK_LOSS';
    if (legType === 'CONFIRMATION_EXPIRY_SELL') return multiple >= 1 ? 'PROBE_PROFIT' : 'PROBE_LOSS';
    if (legType === 'TIME_SELL') return multiple >= 1 ? 'PARTIAL_PROFIT_TIME' : 'TIME_LOSS';
    return multiple >= 1 ? 'WIN' : 'LOSS';
  }

  private logEntry(
    arm: DbArm,
    leg: DbLeg,
    tick: RobinhoodExperimentTick,
    quote: ExecutionQuoteResult,
    fill: ReturnType<typeof modelEntry> | null,
    gasUsd: number,
    buyTaxPct: number,
    reason: string | null,
    executedAt: Date,
  ): void {
    this.files.logPaperEntry({
      ts: executedAt.toISOString(),
      run_id: arm.experimentId,
      schema_version: CSV_SCHEMA_VERSION,
      chain: 'robinhood', token_address: tick.candidate.token.tokenAddress,
      symbol: tick.candidate.token.symbol, pool_address: tick.candidate.pool.poolAddress,
      liquidity_model: tick.liquidityModel,
      first_seen_at: arm.experiment?.t0At?.toISOString?.() ?? '',
      detection_delay_sec: String(Math.max(0, (executedAt.getTime() - leg.intendedAt.getTime()) / 1000)),
      opened_at: executedAt.toISOString(), size_usd: String(Number(leg.notionalUsd)),
      spot_price_usd: String(quote.spotPriceUsd ?? ''),
      entry_price_effective_usd: String(fill?.effectivePriceUsd ?? ''),
      slippage_pct: String(quote.slippagePct ?? ''), sandwich_pct: String(this.config.get<number>('paper.sandwichPct') ?? 0.01),
      gas_usd: String(gasUsd), buy_tax_pct: String(buyTaxPct), tokens_bought: String(fill?.tokensBought ?? ''),
      onchain_liq_entry_usd: '', entered: String(Boolean(fill?.entered)), not_entered_reason: reason ?? '',
      final_score: '', band: '', score_confidence: '', deployer_address: tick.creatorAddress ?? '',
      deployer_deployments_count: '', deployer_rug_count: '', lp_locked: '', lp_lock_source: '', lp_lock_fraction: '',
      discovery_source: 'evm_flow_rpc', risk_cohort: 'ROBINHOOD_STATIC_SAFETY',
      strategy_version: ROBINHOOD_FLOW_V3_CONFIG.version, exit_policy: 'ROBINHOOD_EXPERIMENT_LADDER',
      benchmark_eligible: 'true', trigger_unique_buyers: '', trigger_buy_quote_usd: '',
      trigger_buy_sell_ratio: '', trigger_price_momentum: '',
      experiment_id: arm.experimentId, experiment_arm: arm.armCode, execution_scenario: arm.scenarioCode,
      execution_leg: leg.legType, config_hash: ROBINHOOD_FLOW_V3_CONFIG_HASH,
      target_execution_at: leg.targetAt.toISOString(), executed_at: executedAt.toISOString(),
      confirmation_status: arm.experiment?.confirmationStatus ?? '',
    });
  }

  private logExit(
    arm: DbArm,
    leg: DbLeg,
    tick: RobinhoodExperimentTick,
    quote: ExecutionQuoteResult,
    netUsd: number,
    gasUsd: number,
    sellTaxPct: number,
    reason: string | null,
    outcomeClass: string | null,
    executedAt: Date,
  ): void {
    const committed = Number(arm.committedUsd);
    const realized = Number(arm.realizedValueUsd) + netUsd;
    this.files.logPaperExit({
      ts: executedAt.toISOString(), run_id: arm.experimentId,
      schema_version: CSV_SCHEMA_VERSION, chain: 'robinhood', token_address: tick.candidate.token.tokenAddress,
      symbol: tick.candidate.token.symbol, pool_address: tick.candidate.pool.poolAddress,
      event_type: leg.legType, status: reason ? 'failed' : 'filled', price_usd: String(quote.spotPriceUsd ?? ''),
      multiple: String(arm.currentMultiple ?? ''), fraction: String(Number(leg.tokenAmount ?? 0) / Math.max(Number(arm.tokensBought), 1e-18)),
      tokens: String(leg.tokenAmount ?? ''), net_usd: String(netUsd), slip_pct: String(quote.slippagePct ?? ''),
      realized_multiple_total: String(committed > 0 ? realized / committed : 0),
      note: reason ?? `gas=${gasUsd};sellTax=${sellTaxPct}`, deployer_address: tick.creatorAddress ?? '',
      deployer_deployments_count: '', deployer_rug_count: '', outcome_class: outcomeClass ?? '',
      strategy_version: ROBINHOOD_FLOW_V3_CONFIG.version, risk_cohort: 'ROBINHOOD_STATIC_SAFETY',
      exit_policy: 'ROBINHOOD_EXPERIMENT_LADDER',
      experiment_id: arm.experimentId, experiment_arm: arm.armCode, execution_scenario: arm.scenarioCode,
      execution_leg: leg.legType, config_hash: ROBINHOOD_FLOW_V3_CONFIG_HASH,
      target_execution_at: leg.targetAt.toISOString(), executed_at: executedAt.toISOString(),
    });
  }
}

function format(value: number): string {
  return Number.isFinite(value) ? value.toFixed(3) : 'inf';
}
