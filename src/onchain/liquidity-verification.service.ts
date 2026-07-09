import { Injectable, Logger } from '@nestjs/common';
import type { CandidatePool } from '../collector/collector.types';
import type { LiquidityCheckResult } from './onchain.types';
import { DexResolverService } from './dex-resolver.service';
import { V2LiquidityService } from './v2-liquidity.service';
import { V3LiquidityService } from './v3-liquidity.service';
import { V4LiquidityService } from './v4-liquidity.service';

const UNSUPPORTED_RESULT = (model: string, error: string): LiquidityCheckResult => ({
  liquidityModel:       model as LiquidityCheckResult['liquidityModel'],
  liquidityVerified:    false,
  onchainTvlUsd:        null,
  reportedVsOnchainPct: null,
  executableDepthUsd:   null,
  slip50: null, slip100: null, slip500: null, slip1000: null,
  spotPriceUsd: null,
  error,
});

const IMPLAUSIBLE_RESULT = (
  model: 'V2' | 'V3',
  error: string,
  onchainTvlUsd: number,
  reportedVsOnchainPct: number | null,
  r: {
    spotPriceUsd: number;
    slip50: number | null; slip100: number | null;
    slip500: number | null; slip1000: number | null;
    executableDepthUsd: number;
  },
): LiquidityCheckResult => ({
  liquidityModel:       model,
  liquidityVerified:    false,
  onchainTvlUsd,
  reportedVsOnchainPct,
  executableDepthUsd:   r.executableDepthUsd,
  slip50:               r.slip50,
  slip100:              r.slip100,
  slip500:              r.slip500,
  slip1000:             r.slip1000,
  spotPriceUsd:         null,
  error,
});

@Injectable()
export class LiquidityVerificationService {
  private readonly logger = new Logger(LiquidityVerificationService.name);

  constructor(
    private readonly resolver: DexResolverService,
    private readonly v2:       V2LiquidityService,
    private readonly v3:       V3LiquidityService,
    private readonly v4:       V4LiquidityService,
  ) {}

  async verify(pool: CandidatePool, gemDecimalsHint?: number): Promise<LiquidityCheckResult> {
    const { model, feeBps, probeError } = await this.resolver.resolveModel(
      pool.chain, pool.poolAddress, pool.dex,
    );

    if (model !== 'V2' && model !== 'V3' && model !== 'V4') {
      this.logger.debug(`${pool.chain}:${pool.poolAddress} → ${model}`);
      return UNSUPPORTED_RESULT(model, probeError ?? `DEX model not supported in M3A: ${model}`);
    }

    // Resolve gem decimals: use the hint if available, else read on-chain
    let gemDecimals = gemDecimalsHint ?? 18;
    if (!gemDecimalsHint) {
      const gemAddr = pool.quoteAssetAddress === pool.token0Address
        ? pool.token1Address
        : pool.token0Address;
      gemDecimals = model === 'V2'
        ? await this.v2.readDecimals(pool.chain, gemAddr)
        : model === 'V3'
          ? await this.v3.readDecimals(pool.chain, gemAddr)
          : await this.v4.readDecimals(pool.chain, gemAddr);
    }

    // V2/V3 services throw with descriptive messages on any failure.
    // The catch below converts any thrown error into a CSV-ready UNSUPPORTED_RESULT.
    try {
      if (model === 'V2') {
        const r = await this.v2.readLiquidity(pool, gemDecimals, feeBps ?? 30);
        return this.buildResult('V2', r.onchainTvlUsd, pool.liquidityUsd, r);
      } else if (model === 'V3') {
        const r = await this.v3.readLiquidity(pool, gemDecimals, feeBps ?? 3000);
        return this.buildResult('V3', r.onchainTvlUsd, pool.liquidityUsd, r);
      } else {
        const r = await this.v4.readLiquidity(pool, gemDecimals);
        return this.buildV4Result(r);
      }
    } catch (err) {
      const errMsg = (err as Error).message;
      this.logger.warn(
        `${model} verification failed for ${pool.chain}:${pool.poolAddress} (dex=${pool.dex}): ${errMsg}`,
      );
      return UNSUPPORTED_RESULT(model, errMsg);
    }
  }

  private buildResult(
    model: 'V2' | 'V3',
    onchainTvlUsd: number,
    reportedUsd: number | undefined,
    r: {
      spotPriceUsd: number;
      slip50: number | null; slip100: number | null;
      slip500: number | null; slip1000: number | null;
      executableDepthUsd: number;
    },
  ): LiquidityCheckResult {
    // Require at least $1 onchain to avoid division-by-near-zero when the pool
    // has dust liquidity (e.g. 1 raw USDC unit), which would produce ratios in
    // the billions and overflow the DB's Decimal(10,4) column (max ±999999.9999).
    const reportedVsOnchainPct =
      onchainTvlUsd >= 1 && reportedUsd != null
        ? (reportedUsd - onchainTvlUsd) / onchainTvlUsd
        : null;

    // ── Physicality guard ────────────────────────────────────────────────────
    // A verified=true row MUST be physically plausible. If the read fails any of
    // the rules below it is treated as a broken read → implausible_read,
    // liquidityVerified=false. An honest false beats a fabricated true.
    const physFail = this.assessPhysicality(model, onchainTvlUsd, reportedUsd, [
      { size: 50,   slip: r.slip50 },
      { size: 100,  slip: r.slip100 },
      { size: 500,  slip: r.slip500 },
      { size: 1000, slip: r.slip1000 },
    ]);
    if (physFail !== null) {
      this.logger.warn(
        `${model} physicality guard → implausible_read: ${physFail} ` +
        `(onchain=$${onchainTvlUsd.toFixed(2)} reported=$${reportedUsd?.toFixed(0) ?? '?'})`,
      );
      return IMPLAUSIBLE_RESULT(
        model,
        `implausible_read: ${physFail}`,
        onchainTvlUsd,
        reportedVsOnchainPct,
        r,
      );
    }

    this.logger.log(
      `${model} verified ${model === 'V2' ? '(constant-product)' : '(QuoterV2)'}: ` +
      `onchain=$${onchainTvlUsd.toFixed(0)} reported=$${reportedUsd?.toFixed(0) ?? '?'} ` +
      `divergence=${reportedVsOnchainPct != null ? (reportedVsOnchainPct * 100).toFixed(1) + '%' : '?'} ` +
      `slip50=${r.slip50 != null ? (r.slip50 * 100).toFixed(2) + '%' : '?'}`,
    );

    return {
      liquidityModel:       model,
      liquidityVerified:    true,
      onchainTvlUsd,
      reportedVsOnchainPct,
      executableDepthUsd:   r.executableDepthUsd,
      slip50:               r.slip50,
      slip100:              r.slip100,
      slip500:              r.slip500,
      slip1000:             r.slip1000,
      spotPriceUsd:         r.spotPriceUsd,
    };
  }

  private buildV4Result(r: {
    spotPriceUsd: number;
    slip50: number | null; slip100: number | null;
    slip500: number | null; slip1000: number | null;
    executableDepthUsd: number;
  }): LiquidityCheckResult {
    const physFail = this.assessPhysicality('V4', null, undefined, [
      { size: 50, slip: r.slip50 },
      { size: 100, slip: r.slip100 },
      { size: 500, slip: r.slip500 },
      { size: 1000, slip: r.slip1000 },
    ]);
    if (physFail !== null) {
      return {
        liquidityModel: 'V4', liquidityVerified: false,
        onchainTvlUsd: null, reportedVsOnchainPct: null,
        executableDepthUsd: r.executableDepthUsd,
        slip50: r.slip50, slip100: r.slip100, slip500: r.slip500, slip1000: r.slip1000,
        spotPriceUsd: null,
        error: `implausible_read: ${physFail}`,
      };
    }
    return {
      liquidityModel: 'V4', liquidityVerified: true,
      // PoolManager is a singleton; there is no per-pool token balance to price as TVL.
      onchainTvlUsd: null, reportedVsOnchainPct: null,
      executableDepthUsd: r.executableDepthUsd,
      slip50: r.slip50, slip100: r.slip100, slip500: r.slip500, slip1000: r.slip1000,
      spotPriceUsd: r.spotPriceUsd,
    };
  }

  /**
   * Physicality assessment — shared by V2 and V3.
   * Returns a human-readable failure reason, or null if the read is sane.
   *
   * A row is implausible (→ verified=false) if ANY of:
   *   1. V2 only: onchain_tvl < 1% of reported   while reported > $1000
   *   2. V2 only: onchain_tvl < $1               while reported > $1000
   *   3. slippage on ANY probe          > 50%
   *   4. slippage is non-monotonic across probe sizes (must be non-decreasing)
   *   5. the smallest probe never executed (slip null) — no executable evidence
   *
   * Note: for V2, TVL-based rules are the primary defence against fake liquidity.
   * For V3, local quote-token balance is not total concentrated liquidity, so
   * Quoter/slippage rules carry the physicality check.
   */
  private assessPhysicality(
    model: 'V2' | 'V3' | 'V4',
    onchainTvlUsd: number | null,
    reportedUsd: number | undefined,
    slips: ReadonlyArray<{ size: number; slip: number | null }>,
  ): string | null {
    const reported = reportedUsd ?? null;

    // Rule 1 — onchain absurdly small vs a meaningful reported figure.
    if (model === 'V2' && onchainTvlUsd != null && reported != null && reported > 1000 && onchainTvlUsd < reported * 0.01) {
      return `onchain_tvl $${onchainTvlUsd.toFixed(4)} is <1% of reported $${reported.toFixed(0)}`;
    }
    // Rule 2 — onchain below $1 while reported claims real money.
    if (model === 'V2' && onchainTvlUsd != null && reported != null && reported > 1000 && onchainTvlUsd < 1) {
      return `onchain_tvl $${onchainTvlUsd.toFixed(4)} < $1 while reported $${reported.toFixed(0)}`;
    }
    // Rule 3 — any probe shows >50% slippage → no real depth.
    for (const p of slips) {
      if (p.slip !== null && p.slip > 0.50) {
        return `slip on $${p.size} probe = ${(p.slip * 100).toFixed(1)}% (>50%)`;
      }
    }
    // Rule 4 — slippage must be non-decreasing as size grows.
    // Compare only probes that returned a value; allow 0.01% float noise.
    const present = slips.filter((p): p is { size: number; slip: number } => p.slip !== null);
    for (let i = 1; i < present.length; i++) {
      if (present[i].slip < present[i - 1].slip - 1e-4) {
        return `non-monotonic slip: ` +
          present.map((p) => `$${p.size}=${(p.slip * 100).toFixed(2)}%`).join(' → ');
      }
    }
    // Rule 5 — a verified row needs at least the smallest probe to have executed.
    if (slips.length > 0 && slips[0].slip === null) {
      return `no executable quote (smallest $${slips[0].size} probe returned null)`;
    }
    return null;
  }
}
