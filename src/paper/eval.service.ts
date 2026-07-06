import { Injectable, Logger } from '@nestjs/common';
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
  detectStatus, isInvalidating, rungsTriggered, outcomeClass, PositionStatus, LadderRung,
} from './exit-ladder';
import { modelExit, slipForSize } from './fills';
import { taxFraction } from './paper.service';
import type { EvalViewRow } from './paper.types';
import { DeployerReputationService } from '../deployer/deployer-reputation.service';

const num = (d: unknown): number | null => (d == null ? null : Number(d));
const DEFAULT_PRICE_READ_FAILURE_RUG_THRESHOLD = 3;

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
export class EvalService {
  private readonly logger = new Logger(EvalService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly fileLogger: FileLoggerService,
    private readonly liquidityVerifier: LiquidityVerificationService,
    private readonly riskEngine: RiskEngineService,
    private readonly geckoTerminal: GeckoTerminalService,
    private readonly deployerReputation: DeployerReputationService,
  ) {}

  async evaluateOpenPositions(): Promise<{
    rows: EvalViewRow[];
    evaluated: number;
    openTotal: number;
    deferred: number;
    closed: number;
    deployersRefreshed: number;
    rugLikeTokens: number;
  }> {
    const runId = `eval-${randomUUID().slice(0, 8)}`;
    const evalMaxOpenPositions = this.config.get<number>('paper.evalMaxOpenPositions');
    const openTotal = await this.prisma.paperPosition.count({
      where: { status: 'OPEN' },
    });
    const open = await this.prisma.paperPosition.findMany({
      where: { status: 'OPEN' },
      include: { pool: true, token: true },
      orderBy: { openedAt: 'asc' },
      ...(evalMaxOpenPositions && evalMaxOpenPositions > 0
        ? { take: Math.floor(evalMaxOpenPositions) }
        : {}),
    });
    const deferred = Math.max(0, openTotal - open.length);
    if (deferred > 0) {
      this.logger.warn(
        `Paper eval capped: evaluating ${open.length}/${openTotal} OPEN positions; ` +
        `${deferred} deferred until next run`,
      );
    }

    const sandwichPct  = this.config.get<number>('paper.sandwichPct') ?? 0.01;
    const gasUsd       = this.config.get<number>('paper.gasUsd') ?? 1.5;
    const ladder       = (this.config.get<LadderRung[]>('paper.ladder') ?? []) as LadderRung[];
    const statusParams = {
      liqPullDropPct:  this.config.get<number>('paper.liqPullDropPct') ?? 0.6,
      rugLiqUsd:       this.config.get<number>('paper.rugLiqUsd') ?? 50,
      sellTaxSpikePct: this.config.get<number>('paper.sellTaxSpikePct') ?? 0.5,
    };
    const maxDrawdownInvalidate = this.config.get<number>('paper.maxDrawdownInvalidate') ?? 0.7;
    const priceReadFailureRugThreshold = Math.max(
      1,
      this.config.get<number>('paper.priceReadFailureRugThreshold') ??
        DEFAULT_PRICE_READ_FAILURE_RUG_THRESHOLD,
    );

    const rows: EvalViewRow[] = [];
    let closed = 0;

    for (const pos of open) {
      const chain = pos.chain as SupportedChain;
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
      const priceFailureReached =
        priceUnreadable && priceReadFailureCount >= priceReadFailureRugThreshold;
      const nextEntryFeatures = this.withPriceReadFailure(
        pos.entryFeatures,
        priceReadFailureCount,
        priceUnreadable ? (onchainRead.error ?? 'no_price') : null,
      );

      // RE-RUN sell simulation against current state (existing exit behavior unchanged).
      const { sellSimOk, sellTaxNow } = await this.reCheckSell(chain, pos.tokenAddress, pos.symbol ?? '');

      // Capture current trade stats (sellers/buyers signal) — COLLECTION ONLY.
      const stats = await this.geckoTerminal.getPoolTradeStats(chain, pos.poolAddress);
      const uniqueBuyers  = stats?.uniqueBuyers ?? null;
      const uniqueSellers = stats?.uniqueSellers ?? null;
      const sellersToBuyersRatio =
        uniqueBuyers != null && uniqueSellers != null ? uniqueSellers / Math.max(uniqueBuyers, 1) : null;

      const sellSideInvalid =
        sellSimOk === false ||
        (sellTaxNow != null && sellTaxNow >= statusParams.sellTaxSpikePct);
      const liquidityGone = liqNow != null && liqNow <= statusParams.rugLiqUsd;
      const liquidityPulled =
        liqNow != null && liqEntry > 0 && liqNow < liqEntry * (1 - statusParams.liqPullDropPct);
      const status = priceUnreadable
        ? liquidityGone
          ? 'rug'
          : liquidityPulled
            ? 'liquidity_pulled'
            : sellSideInvalid
              ? 'unsellable'
              : priceFailureReached
                ? 'rug'
                : 'alive'
        : detectStatus(
          { liqEntryUsd: liqEntry, liqNowUsd: liqNow, priceNowUsd: priceNow, sellable, sellTaxNowPct: sellTaxNow },
          statusParams,
        );
      const tickStatus = priceUnreadable && status === 'alive'
        ? `price_unreadable_${priceReadFailureCount}/${priceReadFailureRugThreshold}`
        : status;

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

      if (currentMultiple != null && status === 'alive') {
        for (const rung of rungsTriggered(currentMultiple, executed, ladder)) {
          const tokensToSell = tokensBought * rung.sellFraction;
          const usdValue = tokensToSell * (priceNow ?? 0);
          const exitSlip = slipForSize(usdValue, ladderFrom(liq));
          const fill = modelExit(tokensToSell, priceNow ?? 0, exitSlip, { sandwichPct, gasUsd, sellTaxPct: taxFraction(sellTaxNow) });
          realizedValueUsd += fill.netUsd;
          remainingFraction = Math.max(0, remainingFraction - rung.sellFraction);
          executed.push(rung.multiple);
          await this.writeExit(runId, pos, 'LADDER_SELL', status, priceNow, currentMultiple, rung.sellFraction,
            tokensToSell, fill.netUsd, exitSlip, realizedValueUsd / sizeUsd, `ladder ${rung.multiple}x`);
        }
      }

      // Last-tick rug signals — persisted on the position (COLLECTION ONLY; the LAST
      // value before close feeds the post-mortem). NOT used in any exit decision.
      const lastTickData = {
        lastUniqueBuyers: uniqueBuyers, lastUniqueSellers: uniqueSellers,
        lastSellersToBuyersRatio: sellersToBuyersRatio, lastSellSimOk: sellSimOk,
        lastSellTaxNow: sellTaxNow,
      };

      // ── Invalidation exit ─────────────────────────────────────────────────────
      const invalidate = isInvalidating(status) || drawdown > maxDrawdownInvalidate;
      let finalStatus: string = tickStatus;
      if (invalidate) {
        const tokensToSell = tokensBought * remainingFraction;
        // On a rug, priceNow≈0 and depth is gone → modeled proceeds ≈ 0 (pessimistic).
        const usdValue = tokensToSell * (priceNow ?? 0);
        const exitSlip = liqNow == null ? 1 : slipForSize(usdValue, ladderFrom(liq));
        const fill = modelExit(tokensToSell, priceNow ?? 0, exitSlip, { sandwichPct, gasUsd, sellTaxPct: taxFraction(sellTaxNow) });
        realizedValueUsd += fill.netUsd;
        const reason = drawdown > maxDrawdownInvalidate && !isInvalidating(status) ? 'drawdown' : status;
        const realizedMultiple = realizedValueUsd / sizeUsd;
        const closeOutcomeClass = outcomeClass(reason as PositionStatus | 'drawdown', realizedMultiple);
        const invalidationReason = priceFailureReached && status === 'rug'
          ? `price_unreadable_${priceReadFailureCount}x${onchainRead.error ? `: ${onchainRead.error}` : ''}`
          : reason;
        await this.writeExit(runId, pos, 'INVALIDATE_SELL', status, priceNow, currentMultiple, remainingFraction,
          tokensToSell, fill.netUsd, exitSlip, realizedMultiple, `invalidation: ${invalidationReason}`, closeOutcomeClass);
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
            entryFeatures: nextEntryFeatures,
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
            entryFeatures: nextEntryFeatures,
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
    };
  }

  // Re-verify the pool's CURRENT on-chain liquidity/price. Includes a failure reason.
  private async reReadOnchain(
    chain: SupportedChain,
    pool: { poolAddress: string; dex: string; token0: string; token1: string; quoteAsset: string } | null,
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
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
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

  private async writeExit(
    runId: string,
    pos: { id: string; chain: string; tokenAddress: string; symbol: string | null; poolAddress: string },
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
  ): Promise<void> {
    await this.prisma.paperEvent.create({
      data: {
        positionId: pos.id, ts: new Date(), type,
        price: priceNow ?? 0, multiple, fraction, tokens, usd: netUsd, slipPct, note,
      },
    }).catch(() => undefined);

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
    });
  }
}

// Build a SlipLadder from a fresh liquidity read.
function ladderFrom(liq: LiquidityCheckResult | null) {
  return {
    slip50: liq?.slip50 ?? null, slip100: liq?.slip100 ?? null,
    slip500: liq?.slip500 ?? null, slip1000: liq?.slip1000 ?? null,
  };
}
