import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { FileLoggerService } from '../file-logger/file-logger.service';
import { CSV_SCHEMA_VERSION } from '../file-logger/csv-schemas';
import type { CandidateResult, ResearchCandidatePaperResult } from './paper.types';
import { modelEntry, slipForSize, EntryParams } from './fills';
import { GemScreenService } from '../gem/gem-screen.service';
import { LiquidityVerificationService } from '../onchain/liquidity-verification.service';
import { QUOTE_ASSET_MAP, type CandidatePool, type SupportedChain } from '../collector/collector.types';
import type { LiquidityCheckResult } from '../onchain/onchain.types';
import { assessTakeCohortConfirmation, type TakeCohortBaseline, type TakeCohortParams } from './take-cohort';

/** A tax value may arrive as a fraction (0.05) or a percent (5). Normalize to a fraction. */
export function taxFraction(t: number | null | undefined): number {
  if (t == null || !isFinite(t) || t <= 0) return 0;
  return t > 1 ? t / 100 : t;
}

/**
 * M5 — Paper ENTRY (recorded once at discovery).
 *
 * PAPER ONLY: no keys, no execution, no real orders. The entry is a modeled,
 * PESSIMISTIC fill of POSITION_SIZE_USD against the discovery snapshot's on-chain
 * data. NO LOOK-AHEAD: entry uses only the discovery snapshot (ts = first_seen ≤
 * opened_at = first_seen + DETECTION_DELAY). With sparse/intermittent runs there is
 * no snapshot strictly between first_seen and opened_at, so the discovery snapshot
 * (the latest with ts ≤ opened_at) is used — documented, not a look-ahead.
 */
@Injectable()
export class PaperService {
  private readonly logger = new Logger(PaperService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly fileLogger: FileLoggerService,
    private readonly gemScreen: GemScreenService,
    private readonly liquidityVerifier: LiquidityVerificationService,
  ) {}

  async recordEntry(c: CandidateResult): Promise<void> {
    const { pool, token, liq, score, ageDays, tokenId, poolId, runId, buyTax } = c;
    const riskCohort = c.riskCohort ?? 'CONTRACT_SAFE';
    const strategyVersion = c.strategyVersion ??
      (pool.chain === 'ethereum' || pool.chain === 'base' ? 'legacy_static_shadow_v0' : 'legacy_static_v0');
    const exitPolicy = c.exitPolicy ??
      (strategyVersion === 'legacy_static_shadow_v0' ? 'LEGACY_SHADOW' : 'SAFE_LADDER');
    const benchmarkEligible = c.benchmarkEligible ?? strategyVersion !== 'legacy_static_shadow_v0';

    // One paper position per token: re-discovery of the same token must not create a
    // duplicate (it would skew the aggregate edge/post-mortem stats).
    const existing = await this.prisma.paperPosition.findFirst({
      where: (c.signalId
        ? { signalId: c.signalId }
        : { chain: pool.chain, tokenAddress: token.tokenAddress, strategyVersion }) as any,
      select: { id: true },
    });
    if (existing) {
      this.logger.debug(`Paper entry skipped (position exists): ${pool.chain}:${token.tokenAddress}`);
      return;
    }

    if (this.shouldQueueForTakeConfirmation(pool.chain, riskCohort, strategyVersion)) {
      await this.queueTakeConfirmation(c, riskCohort);
      return;
    }

    const sizeUsd      = this.config.get<number>('paper.positionSizeUsd') ?? 20;
    const delaySec     = this.config.get<number>('paper.detectionDelaySec') ?? 0;
    const sandwichPct  = this.config.get<number>('paper.sandwichPct') ?? 0.01;
    const gasUsd       = c.gasUsd ?? this.config.get<number>('paper.gasUsd') ?? 1.5;
    const maxEntrySlip = c.maxEntrySlipPct ?? this.config.get<number>('paper.maxEntrySlipPct') ?? 0.5;

    const firstSeenAt = c.observedAt ?? new Date();
    const openedAt = new Date(firstSeenAt.getTime() + delaySec * 1000);

    // V2 uses its exact directional $20 probe; control cohorts keep the historical $50 bucket.
    const useExact20 = strategyVersion.endsWith('_v2') || strategyVersion.startsWith('robinhood_stages_v2_');
    const entrySlip = slipForSize(sizeUsd, {
      slip20: useExact20 ? liq.entrySlip20 ?? liq.slip20 ?? null : null,
      slip50: liq.slip50, slip100: liq.slip100, slip500: liq.slip500, slip1000: liq.slip1000,
    });
    const buyTaxPct = taxFraction(buyTax);

    const params: EntryParams = { sizeUsd, sandwichPct, gasUsd, buyTaxPct, maxEntrySlipPct: maxEntrySlip };
    const fill = modelEntry(liq.spotPriceUsd ?? 0, entrySlip, params);

    const entryFeatures = {
      liquidityModel: liq.liquidityModel,
      onchainTvlUsd: liq.onchainTvlUsd,
      slip1000: liq.slip1000,
      ageDays,
      fdvUsd: pool.fdvUsd ?? null,
      divergenceScore: score?.divergenceScore ?? null,
      finalScore: score?.finalScore ?? null,
      liquidityScore: score?.liquidityScore ?? null,
      depthScore: score?.depthScore ?? null,
      ageScore: score?.ageScore ?? null,
      tractionScore: score?.tractionScore ?? null,
      deployerReputationScore: score?.deployerReputationScore ?? null,
      scoreConfidence: score?.scoreConfidence ?? null,
      band: score?.band ?? 'flow_signal',
      deployerDeploymentsCount: token.deployerDeploymentsCount ?? null,
      deployerRugLikeCount: token.deployerRugLikeCount ?? null,
      deployerRiskScore: token.deployerRiskScore ?? null,
      deployerBlocklisted: token.deployerBlocklisted ?? null,
      riskCohort,
      experimentalSafety: c.experimentalSafety ?? null,
      discoverySource: pool.source,
      strategyVersion,
      signalId: c.signalId ?? null,
      exitPolicy,
      benchmarkEligible,
      flowSnapshot: c.flowSnapshot ?? null,
    };

    const status = fill.entered ? 'OPEN' : 'NOT_ENTERED';

    let positionId: string | null = null;
    try {
      const created = await this.prisma.paperPosition.create({
        data: {
          runId,
          chain: pool.chain,
          tokenId,
          poolId,
          tokenAddress: token.tokenAddress,
          poolAddress: pool.poolAddress,
          symbol: token.symbol ?? null,
          liquidityModel: liq.liquidityModel,
          strategyVersion,
          signalId: c.signalId ?? null,
          riskCohort,
          exitPolicy,
          benchmarkEligible,
          firstSeenAt,
          detectionDelaySec: delaySec,
          openedAt,
          sizeUsd,
          entryPriceUsd: liq.spotPriceUsd ?? null,
          entryPriceEffectiveUsd: fill.effectivePriceUsd,
          modeledSlippagePct: fill.slipPct,
          modeledSandwichPct: sandwichPct,
          modeledGasUsd: gasUsd,
          modeledBuyTaxPct: buyTaxPct,
          tokensBought: fill.tokensBought,
          onchainLiqEntryUsd: liq.onchainTvlUsd ?? null,
          entryFeatures: entryFeatures as Prisma.InputJsonValue,
          status,
          notEnteredReason: fill.reason,
          maxMultipleObserved: fill.entered ? 1 : null,
          maxDrawdownObserved: fill.entered ? 0 : null,
        },
      });
      positionId = created.id;

      if (fill.entered && fill.tokensBought != null) {
        await this.prisma.paperEvent.create({
          data: {
            positionId: created.id,
            ts: openedAt,
            type: 'BUY',
            price: fill.effectivePriceUsd ?? 0,
            multiple: 1,
            fraction: 1,
            tokens: fill.tokensBought,
            usd: -sizeUsd, // cost outflow
            slipPct: fill.slipPct,
            note: 'paper entry (pessimistic fill)',
          },
        });
        if (this.config.get<boolean>('gem.autoScreenEnabled') ?? true) {
          await this.gemScreen.screenPosition({
            chain: pool.chain,
            tokenAddress: token.tokenAddress,
            poolAddress: pool.poolAddress,
            symbol: token.symbol ?? null,
            liquidityModel: liq.liquidityModel,
            deployerAddress: token.deployerAddress ?? null,
            firstSeenAt,
            entryFdvUsd: pool.fdvUsd ?? null,
            entryPriceUsd: fill.effectivePriceUsd ?? null,
            entryLiquidityUsd: liq.onchainTvlUsd ?? null,
          }).catch((err) => {
            this.logger.warn(
              `Gem screen failed for ${pool.chain}:${token.tokenAddress}: ${(err as Error).message}`,
            );
          });
        }
      } else {
        await this.prisma.paperEvent.create({
          data: {
            positionId: created.id,
            ts: openedAt,
            type: 'NOT_ENTERED',
            price: liq.spotPriceUsd ?? 0,
            note: fill.reason ?? 'not entered',
          },
        });
      }
    } catch (err) {
      this.logger.warn(`Paper entry DB write failed (${pool.chain}:${token.tokenAddress}): ${(err as Error).message}`);
      return;
    }

    this.fileLogger.logPaperEntry({
      ts: new Date().toISOString(),
      run_id: runId,
      schema_version: CSV_SCHEMA_VERSION,
      chain: pool.chain,
      token_address: token.tokenAddress,
      symbol: token.symbol ?? '',
      pool_address: pool.poolAddress,
      liquidity_model: liq.liquidityModel,
      first_seen_at: firstSeenAt.toISOString(),
      detection_delay_sec: String(delaySec),
      opened_at: openedAt.toISOString(),
      size_usd: sizeUsd.toFixed(2),
      spot_price_usd: liq.spotPriceUsd != null ? liq.spotPriceUsd.toExponential(8) : '',
      entry_price_effective_usd: fill.effectivePriceUsd != null ? fill.effectivePriceUsd.toExponential(8) : '',
      slippage_pct: fill.slipPct != null ? fill.slipPct.toFixed(6) : '',
      sandwich_pct: sandwichPct.toFixed(6),
      gas_usd: gasUsd.toFixed(2),
      buy_tax_pct: buyTaxPct.toFixed(6),
      tokens_bought: fill.tokensBought != null ? fill.tokensBought.toExponential(8) : '',
      onchain_liq_entry_usd: liq.onchainTvlUsd != null ? liq.onchainTvlUsd.toFixed(2) : '',
      entered: String(fill.entered),
      not_entered_reason: fill.reason ?? '',
      final_score: score?.finalScore.toFixed(2) ?? '',
      band: score?.band ?? 'flow_signal',
      score_confidence: score?.scoreConfidence.toFixed(3) ?? '',
      deployer_address: token.deployerAddress ?? '',
      deployer_deployments_count: token.deployerDeploymentsCount != null ? String(token.deployerDeploymentsCount) : '',
      deployer_rug_count: token.deployerRugLikeCount != null ? String(token.deployerRugLikeCount) : '',
      lp_locked: '',
      lp_lock_source: '',
      lp_lock_fraction: '',
      discovery_source: pool.source,
      risk_cohort: riskCohort,
      strategy_version: strategyVersion,
      exit_policy: exitPolicy,
      benchmark_eligible: String(benchmarkEligible),
      trigger_unique_buyers: this.formatNumber(this.numberFeature(c.flowSnapshot?.uniqueBuyers)),
      trigger_buy_quote_usd: this.formatNumber(this.numberFeature(c.flowSnapshot?.buyQuoteUsd)),
      trigger_buy_sell_ratio: this.formatNumber(this.numberFeature(c.flowSnapshot?.buySellRatio)),
      trigger_price_momentum: this.formatNumber(this.numberFeature(c.flowSnapshot?.priceMomentum)),
    });

    this.logger.log(
      `Paper entry [${riskCohort}]: ${pool.chain}:${token.tokenAddress} (${token.symbol ?? '?'}) ` +
      `${fill.entered ? `OPEN size=$${sizeUsd} effPx=${fill.effectivePriceUsd?.toExponential(4)} slip=${((fill.slipPct ?? 0) * 100).toFixed(2)}%` : `NOT_ENTERED (${fill.reason})`}`,
    );
  }

  /** Resolve due Base/Ethereum hypotheses into actual paper buys or explicit rejects. */
  async processPendingConfirmations(): Promise<{ confirmed: number; rejected: number; deferred: number }> {
    if (!(this.config.get<boolean>('paper.takeCohortEnabled') ?? false)) {
      return { confirmed: 0, rejected: 0, deferred: 0 };
    }

    const pending = await this.prisma.paperPosition.findMany({
      where: { status: 'PENDING_CONFIRMATION' },
      include: { pool: true, token: true },
      orderBy: { firstSeenAt: 'asc' },
    });
    let confirmed = 0;
    let rejected = 0;
    let deferred = 0;

    for (const position of pending) {
      const features = this.features(position.entryFeatures);
      const dueAt = this.dateFeature(features.confirmationDueAt);
      if (!dueAt || dueAt.getTime() > Date.now()) {
        deferred++;
        continue;
      }

      const pool = this.toVerificationPool(position.chain as SupportedChain, position.pool);
      const current = pool
        ? await this.liquidityVerifier.verify(pool, position.token?.decimals ?? undefined).catch((err) => {
            this.logger.warn(`Take confirmation read failed for ${position.chain}:${position.tokenAddress}: ${(err as Error).message}`);
            return null;
          })
        : null;
      // An RPC outage is not adverse token evidence. Keep the hypothesis pending and
      // retry it on the next evaluator run instead of manufacturing a rejection.
      if (!current) {
        this.logTakeDecision(position, features, 'DEFERRED', 'confirmation_read_unavailable', null, {
          priceMultiple: null,
          liquidityRetention: null,
        });
        deferred++;
        continue;
      }
      const baseline: TakeCohortBaseline = {
        spotPriceUsd: this.numberFeature(features.t0SpotPriceUsd),
        executableDepthUsd: this.numberFeature(features.t0ExecutableDepthUsd),
        onchainTvlUsd: this.numberFeature(features.t0OnchainTvlUsd),
        liquidityModel: String(features.liquidityModel ?? position.liquidityModel),
      };
      const decision = assessTakeCohortConfirmation(baseline, current, this.takeCohortParams());

      if (!decision.confirmed) {
        const now = new Date();
        await this.prisma.paperPosition.update({
          where: { id: position.id },
          data: {
            status: 'NOT_ENTERED', notEnteredReason: decision.reason, lastEvalAt: now,
            priceNowUsd: current?.spotPriceUsd ?? null, onchainLiqNowUsd: current?.onchainTvlUsd ?? null,
            entryFeatures: {
              ...features, takeCohort: 'REJECTED', confirmationDecisionAt: now.toISOString(),
              confirmationReason: decision.reason, confirmationPriceMultiple: decision.priceMultiple,
              confirmationLiquidityRetention: decision.liquidityRetention,
            } as Prisma.InputJsonValue,
          },
        });
        await this.prisma.paperEvent.create({
          data: { positionId: position.id, ts: now, type: 'NOT_ENTERED', price: current?.spotPriceUsd ?? 0, note: decision.reason },
        });
        this.logTakeDecision(position, features, 'REJECTED', decision.reason, current, decision);
        rejected++;
        continue;
      }

      const opened = await this.openConfirmedPosition(position, features, current, decision);
      if (opened) confirmed++;
      else rejected++;
    }
    return { confirmed, rejected, deferred };
  }

  private shouldQueueForTakeConfirmation(chain: SupportedChain, riskCohort: string, strategyVersion: string): boolean {
    if (strategyVersion !== 'legacy_static_shadow_v0' && strategyVersion !== 'legacy_static_v0') return false;
    const enabled = this.config.get<boolean>('paper.takeCohortEnabled') ?? false;
    const chains = this.config.get<string[]>('paper.takeCohortChains') ?? ['ethereum', 'base'];
    return enabled && riskCohort === 'CONTRACT_SAFE' && chains.includes(chain);
  }

  private async queueTakeConfirmation(c: CandidateResult, riskCohort: string): Promise<void> {
    const { pool, token, liq, score, ageDays, tokenId, poolId, runId, buyTax } = c;
    if (!score) return;
    const firstSeenAt = new Date();
    const delaySec = Math.max(0, this.config.get<number>('paper.takeConfirmationDelaySec') ?? 600);
    const confirmationDueAt = new Date(firstSeenAt.getTime() + delaySec * 1000);
    const features = {
      liquidityModel: liq.liquidityModel, onchainTvlUsd: liq.onchainTvlUsd, slip1000: liq.slip1000, ageDays,
      fdvUsd: pool.fdvUsd ?? null, divergenceScore: score.divergenceScore, finalScore: score.finalScore,
      liquidityScore: score.liquidityScore, depthScore: score.depthScore, ageScore: score.ageScore,
      tractionScore: score.tractionScore, deployerReputationScore: score.deployerReputationScore,
      scoreConfidence: score.scoreConfidence, band: score.band, deployerDeploymentsCount: token.deployerDeploymentsCount ?? null,
      deployerRugLikeCount: token.deployerRugLikeCount ?? null, deployerRiskScore: token.deployerRiskScore ?? null,
      deployerBlocklisted: token.deployerBlocklisted ?? null, riskCohort, experimentalSafety: c.experimentalSafety ?? null,
      discoverySource: pool.source,
      takeCohort: 'PENDING_CONFIRMATION', confirmationDueAt: confirmationDueAt.toISOString(),
      t0SpotPriceUsd: liq.spotPriceUsd, t0ExecutableDepthUsd: liq.executableDepthUsd,
      t0OnchainTvlUsd: liq.onchainTvlUsd, t0BuyTaxPct: taxFraction(buyTax),
    };
    try {
      const created = await this.prisma.paperPosition.create({
        data: {
          runId, chain: pool.chain, tokenId, poolId, tokenAddress: token.tokenAddress, poolAddress: pool.poolAddress,
          symbol: token.symbol ?? null, liquidityModel: liq.liquidityModel, firstSeenAt, detectionDelaySec: delaySec,
          openedAt: firstSeenAt, sizeUsd: this.config.get<number>('paper.positionSizeUsd') ?? 20,
          entryPriceUsd: liq.spotPriceUsd ?? null, entryFeatures: features as Prisma.InputJsonValue,
          status: 'PENDING_CONFIRMATION', maxMultipleObserved: null, maxDrawdownObserved: null,
        } as any,
      });
      await this.prisma.paperEvent.create({
        data: { positionId: created.id, ts: firstSeenAt, type: 'PENDING_CONFIRMATION', price: liq.spotPriceUsd ?? 0, note: `due ${confirmationDueAt.toISOString()}` },
      });
      this.logTakeDecision({ ...created, runId, chain: pool.chain, tokenAddress: token.tokenAddress, symbol: token.symbol, poolAddress: pool.poolAddress, firstSeenAt }, features, 'PENDING', 'awaiting_confirmation', liq, { priceMultiple: null, liquidityRetention: null });
      this.logger.log(`Paper take cohort pending: ${pool.chain}:${token.tokenAddress} (${token.symbol ?? '?'}) due=${confirmationDueAt.toISOString()}`);
    } catch (err) {
      this.logger.warn(`Take cohort DB write failed (${pool.chain}:${token.tokenAddress}): ${(err as Error).message}`);
    }
  }

  private async openConfirmedPosition(position: any, features: Record<string, unknown>, liq: LiquidityCheckResult, decision: { reason: string; priceMultiple: number | null; liquidityRetention: number | null }): Promise<boolean> {
    const sizeUsd = this.config.get<number>('paper.positionSizeUsd') ?? 20;
    const sandwichPct = this.config.get<number>('paper.sandwichPct') ?? 0.01;
    const gasUsd = this.config.get<number>('paper.gasUsd') ?? 1.5;
    const maxEntrySlip = this.config.get<number>('paper.maxEntrySlipPct') ?? 0.5;
    const buyTaxPct = this.numberFeature(features.t0BuyTaxPct) ?? 0;
    const fill = modelEntry(liq.spotPriceUsd ?? 0, slipForSize(sizeUsd, liq), { sizeUsd, sandwichPct, gasUsd, buyTaxPct, maxEntrySlipPct: maxEntrySlip });
    const now = new Date();
    if (!fill.entered || fill.tokensBought == null) {
      const reason = fill.reason ?? 'confirmation_entry_unfillable';
      await this.prisma.paperPosition.update({ where: { id: position.id }, data: { status: 'NOT_ENTERED', notEnteredReason: reason, lastEvalAt: now } });
      await this.prisma.paperEvent.create({ data: { positionId: position.id, ts: now, type: 'NOT_ENTERED', price: liq.spotPriceUsd ?? 0, note: reason } });
      this.logTakeDecision(position, features, 'REJECTED', reason, liq, decision);
      return false;
    }
    const nextFeatures = {
      ...features, takeCohort: 'CONFIRMED', confirmationDecisionAt: now.toISOString(),
      confirmationReason: decision.reason, confirmationPriceMultiple: decision.priceMultiple,
      confirmationLiquidityRetention: decision.liquidityRetention,
    };
    await this.prisma.paperPosition.update({
      where: { id: position.id },
      data: {
        status: 'OPEN', openedAt: now, detectionDelaySec: Math.round((now.getTime() - position.firstSeenAt.getTime()) / 1000),
        entryPriceUsd: liq.spotPriceUsd ?? null, entryPriceEffectiveUsd: fill.effectivePriceUsd, modeledSlippagePct: fill.slipPct,
        modeledSandwichPct: sandwichPct, modeledGasUsd: gasUsd, modeledBuyTaxPct: buyTaxPct, tokensBought: fill.tokensBought,
        onchainLiqEntryUsd: liq.onchainTvlUsd ?? null, entryFeatures: nextFeatures as Prisma.InputJsonValue,
        notEnteredReason: null, maxMultipleObserved: 1, maxDrawdownObserved: 0,
      },
    });
    await this.prisma.paperEvent.create({
      data: { positionId: position.id, ts: now, type: 'BUY', price: fill.effectivePriceUsd ?? 0, multiple: 1, fraction: 1, tokens: fill.tokensBought, usd: -sizeUsd, slipPct: fill.slipPct, note: 'paper entry after take-cohort confirmation (pessimistic fill)' },
    });
    this.logPaperEntryFromPosition(position, features, liq, fill, now, sandwichPct, gasUsd, buyTaxPct);
    this.logTakeDecision(position, features, 'CONFIRMED', decision.reason, liq, decision);
    if (this.config.get<boolean>('gem.autoScreenEnabled') ?? true) {
      await this.gemScreen.screenPosition({
        chain: position.chain, tokenAddress: position.tokenAddress, poolAddress: position.poolAddress,
        symbol: position.symbol ?? null, liquidityModel: liq.liquidityModel,
        deployerAddress: position.token?.deployerAddress ?? null, firstSeenAt: position.firstSeenAt,
        entryFdvUsd: this.numberFeature(features.fdvUsd), entryPriceUsd: fill.effectivePriceUsd,
        entryLiquidityUsd: liq.onchainTvlUsd ?? null,
      }).catch((err) => this.logger.warn(`Gem screen failed for ${position.chain}:${position.tokenAddress}: ${(err as Error).message}`));
    }
    this.logger.log(`Paper take cohort confirmed: ${position.chain}:${position.tokenAddress} (${position.symbol ?? '?'})`);
    return true;
  }

  private takeCohortParams(): TakeCohortParams {
    return {
      minPriceMultiple: this.config.get<number>('paper.takeMinPriceMultiple') ?? 1,
      minExecutableDepthUsd: this.config.get<number>('paper.takeMinExecutableDepthUsd') ?? 100,
      minLiquidityRetention: this.config.get<number>('paper.takeMinLiquidityRetention') ?? 0.8,
      minV2OnchainTvlUsd: this.config.get<number>('paper.takeMinV2OnchainTvlUsd') ?? 5_000,
    };
  }

  private toVerificationPool(chain: SupportedChain, pool: any): CandidatePool | null {
    if (!pool) return null;
    const quotes = QUOTE_ASSET_MAP[chain] ?? {};
    const quote = [pool.token0, pool.token1].find((address: string) => quotes[address.toLowerCase()] != null);
    if (!quote) return null;
    return {
      chain, poolAddress: pool.poolAddress, dex: pool.dex, token0Address: pool.token0, token1Address: pool.token1,
      quoteAsset: pool.quoteAsset, quoteAssetAddress: quote.toLowerCase(),
      v4Metadata: this.v4MetadataFromStorage(pool.v4Metadata), source: 'paper-take-confirmation',
    };
  }

  private features(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {}; }
  private numberFeature(value: unknown): number | null { const n = typeof value === 'number' ? value : Number(value); return Number.isFinite(n) ? n : null; }
  private dateFeature(value: unknown): Date | null { const date = typeof value === 'string' ? new Date(value) : null; return date && Number.isFinite(date.getTime()) ? date : null; }
  private formatNumber(value: number | null): string { return value != null && Number.isFinite(value) ? String(value) : ''; }

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

  private logTakeDecision(position: any, features: Record<string, unknown>, decision: string, reason: string, liq: LiquidityCheckResult | null, metrics: { priceMultiple: number | null; liquidityRetention: number | null }): void {
    this.fileLogger.logTakeCohortDecision({
      ts: new Date().toISOString(), run_id: position.runId ?? '', schema_version: CSV_SCHEMA_VERSION, decision, reason,
      chain: position.chain, token_address: position.tokenAddress, symbol: position.symbol ?? '', pool_address: position.poolAddress,
      first_seen_at: position.firstSeenAt.toISOString(), confirmation_due_at: String(features.confirmationDueAt ?? ''), decided_at: new Date().toISOString(),
      baseline_price_usd: this.formatNumber(this.numberFeature(features.t0SpotPriceUsd)), current_price_usd: this.formatNumber(liq?.spotPriceUsd ?? null), price_multiple: this.formatNumber(metrics.priceMultiple),
      baseline_onchain_tvl_usd: this.formatNumber(this.numberFeature(features.t0OnchainTvlUsd)), current_onchain_tvl_usd: this.formatNumber(liq?.onchainTvlUsd ?? null), liquidity_retention: this.formatNumber(metrics.liquidityRetention),
      current_executable_depth_usd: this.formatNumber(liq?.executableDepthUsd ?? null), final_score: this.formatNumber(this.numberFeature(features.finalScore)), band: String(features.band ?? ''), discovery_source: String(features.discoverySource ?? ''),
    });
  }

  private logPaperEntryFromPosition(position: any, features: Record<string, unknown>, liq: LiquidityCheckResult, fill: ReturnType<typeof modelEntry>, openedAt: Date, sandwichPct: number, gasUsd: number, buyTaxPct: number): void {
    this.fileLogger.logPaperEntry({
      ts: new Date().toISOString(), run_id: position.runId ?? '', schema_version: CSV_SCHEMA_VERSION, chain: position.chain, token_address: position.tokenAddress, symbol: position.symbol ?? '', pool_address: position.poolAddress,
      liquidity_model: liq.liquidityModel, first_seen_at: position.firstSeenAt.toISOString(), detection_delay_sec: String(Math.round((openedAt.getTime() - position.firstSeenAt.getTime()) / 1000)), opened_at: openedAt.toISOString(),
      size_usd: (this.config.get<number>('paper.positionSizeUsd') ?? 20).toFixed(2), spot_price_usd: this.formatNumber(liq.spotPriceUsd), entry_price_effective_usd: this.formatNumber(fill.effectivePriceUsd), slippage_pct: this.formatNumber(fill.slipPct), sandwich_pct: sandwichPct.toFixed(6), gas_usd: gasUsd.toFixed(2), buy_tax_pct: buyTaxPct.toFixed(6), tokens_bought: this.formatNumber(fill.tokensBought), onchain_liq_entry_usd: this.formatNumber(liq.onchainTvlUsd), entered: 'true', not_entered_reason: '',
      final_score: this.formatNumber(this.numberFeature(features.finalScore)), band: String(features.band ?? ''), score_confidence: this.formatNumber(this.numberFeature(features.scoreConfidence)), deployer_address: position.token?.deployerAddress ?? '', deployer_deployments_count: this.formatNumber(this.numberFeature(features.deployerDeploymentsCount)), deployer_rug_count: this.formatNumber(this.numberFeature(features.deployerRugLikeCount)), lp_locked: '', lp_lock_source: '', lp_lock_fraction: '', discovery_source: String(features.discoverySource ?? ''), risk_cohort: String(features.riskCohort ?? 'CONTRACT_SAFE'), strategy_version: String(features.strategyVersion ?? 'legacy_static_v0'), exit_policy: String(features.exitPolicy ?? 'SAFE_LADDER'), benchmark_eligible: String(features.benchmarkEligible ?? true), trigger_unique_buyers: '', trigger_buy_quote_usd: '', trigger_buy_sell_ratio: '', trigger_price_momentum: '',
    });
  }

  async recordResearchEntry(c: ResearchCandidatePaperResult): Promise<void> {
    const { pool, token, liq, score, runId, buyTax, riskStatus, researchReason } = c;

    const sizeUsd      = this.config.get<number>('paper.positionSizeUsd') ?? 20;
    const delaySec     = this.config.get<number>('paper.detectionDelaySec') ?? 0;
    const sandwichPct  = this.config.get<number>('paper.sandwichPct') ?? 0.01;
    const gasUsd       = this.config.get<number>('paper.gasUsd') ?? 1.5;
    const maxEntrySlip = this.config.get<number>('paper.maxEntrySlipPct') ?? 0.5;

    const firstSeenAt = new Date();
    const openedAt = new Date(firstSeenAt.getTime() + delaySec * 1000);
    const entrySlip = slipForSize(sizeUsd, {
      slip20: null,
      slip50: liq.slip50, slip100: liq.slip100, slip500: liq.slip500, slip1000: liq.slip1000,
    });
    const buyTaxPct = taxFraction(buyTax);
    const params: EntryParams = { sizeUsd, sandwichPct, gasUsd, buyTaxPct, maxEntrySlipPct: maxEntrySlip };
    const fill = modelEntry(liq.spotPriceUsd ?? 0, entrySlip, params);

    this.fileLogger.logResearchPaperEntry({
      ts: new Date().toISOString(),
      run_id: runId,
      schema_version: CSV_SCHEMA_VERSION,
      cohort: 'CONTRACT_UNKNOWN_RESEARCH',
      chain: pool.chain,
      token_address: token.tokenAddress,
      symbol: token.symbol ?? '',
      pool_address: pool.poolAddress,
      liquidity_model: liq.liquidityModel,
      liquidity_verified: String(liq.liquidityVerified),
      risk_status: riskStatus,
      research_reason: researchReason,
      first_seen_at: firstSeenAt.toISOString(),
      detection_delay_sec: String(delaySec),
      opened_at: openedAt.toISOString(),
      size_usd: sizeUsd.toFixed(2),
      spot_price_usd: liq.spotPriceUsd != null ? liq.spotPriceUsd.toExponential(8) : '',
      entry_price_effective_usd: fill.effectivePriceUsd != null ? fill.effectivePriceUsd.toExponential(8) : '',
      slippage_pct: fill.slipPct != null ? fill.slipPct.toFixed(6) : '',
      sandwich_pct: sandwichPct.toFixed(6),
      gas_usd: gasUsd.toFixed(2),
      buy_tax_pct: buyTaxPct.toFixed(6),
      tokens_bought: fill.tokensBought != null ? fill.tokensBought.toExponential(8) : '',
      onchain_liq_entry_usd: liq.onchainTvlUsd != null ? liq.onchainTvlUsd.toFixed(2) : '',
      entered: String(fill.entered),
      not_entered_reason: fill.reason ?? '',
      final_score: score.finalScore.toFixed(2),
      band: score.band,
      score_confidence: score.scoreConfidence.toFixed(3),
    });

    this.logger.log(
      `Research paper entry: ${pool.chain}:${token.tokenAddress} (${token.symbol ?? '?'}) ` +
      `${fill.entered ? `OPEN_MODEL size=$${sizeUsd} effPx=${fill.effectivePriceUsd?.toExponential(4)} slip=${((fill.slipPct ?? 0) * 100).toFixed(2)}%` : `NOT_ENTERED (${fill.reason})`} ` +
      `risk=${riskStatus}`,
    );
  }
}
