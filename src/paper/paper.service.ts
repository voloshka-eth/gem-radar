import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { FileLoggerService } from '../file-logger/file-logger.service';
import { CSV_SCHEMA_VERSION } from '../file-logger/csv-schemas';
import type { CandidateResult } from './paper.types';
import { modelEntry, slipForSize, EntryParams } from './fills';

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
  ) {}

  async recordEntry(c: CandidateResult): Promise<void> {
    const { pool, token, liq, score, ageDays, tokenId, poolId, runId, buyTax } = c;

    // One paper position per token: re-discovery of the same token must not create a
    // duplicate (it would skew the aggregate edge/post-mortem stats).
    const existing = await this.prisma.paperPosition.findFirst({
      where: { chain: pool.chain, tokenAddress: token.tokenAddress },
      select: { id: true },
    });
    if (existing) {
      this.logger.debug(`Paper entry skipped (position exists): ${pool.chain}:${token.tokenAddress}`);
      return;
    }

    const sizeUsd      = this.config.get<number>('paper.positionSizeUsd') ?? 20;
    const delaySec     = this.config.get<number>('paper.detectionDelaySec') ?? 300;
    const sandwichPct  = this.config.get<number>('paper.sandwichPct') ?? 0.01;
    const gasUsd       = this.config.get<number>('paper.gasUsd') ?? 1.5;
    const maxEntrySlip = this.config.get<number>('paper.maxEntrySlipPct') ?? 0.5;

    const firstSeenAt = new Date();
    const openedAt = new Date(firstSeenAt.getTime() + delaySec * 1000);

    // Pessimistic entry slip for the position size (a $20 trade is charged the $50 probe).
    const entrySlip = slipForSize(sizeUsd, {
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
      divergenceScore: score.divergenceScore,
      finalScore: score.finalScore,
      liquidityScore: score.liquidityScore,
      depthScore: score.depthScore,
      ageScore: score.ageScore,
      tractionScore: score.tractionScore,
      scoreConfidence: score.scoreConfidence,
      band: score.band,
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
      final_score: score.finalScore.toFixed(2),
      band: score.band,
      score_confidence: score.scoreConfidence.toFixed(3),
    });

    this.logger.log(
      `Paper entry: ${pool.chain}:${token.tokenAddress} (${token.symbol ?? '?'}) ` +
      `${fill.entered ? `OPEN size=$${sizeUsd} effPx=${fill.effectivePriceUsd?.toExponential(4)} slip=${((fill.slipPct ?? 0) * 100).toFixed(2)}%` : `NOT_ENTERED (${fill.reason})`}`,
    );
  }
}
