import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../database/prisma.service';
import { LpLockService } from './lp-lock.service';
import type { SupportedChain } from '../collector/collector.types';

export interface ScreenResult {
  screened: number;
  passed: number;
  rejections: Record<string, number>;
  passedCandidates: Array<{ symbol: string; chain: string; tokenAddress: string; entryFdvUsd: number | null; lpSource: string }>;
}

/**
 * GEM-SCREEN — runs on survivors that already cleared the contract + liquidity gate
 * (sourced from paper_positions, the verified-survivor record). Applies two HARD gates:
 *   1. lp_locked_or_burned MUST be true (undetermined ⇒ reject).
 *   2. FDV headroom: minEntryFdv ≤ entry FDV ≤ maxEntryFdv (so x1000 stays possible; floor cuts dust).
 * Survivors that pass are tagged as gem_candidates. OBSERVATION ONLY.
 */
@Injectable()
export class GemScreenService {
  private readonly logger = new Logger(GemScreenService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly lpLock: LpLockService,
  ) {}

  async screen(): Promise<ScreenResult> {
    const minFdv = this.config.get<number>('gem.minEntryFdvUsd') ?? 1000;
    const maxFdv = this.config.get<number>('gem.maxEntryFdvUsd') ?? 50000;

    // Survivor cohort = every verified survivor we recorded a paper position for (deduped per token).
    const survivors = await this.prisma.paperPosition.findMany({
      include: { token: { select: { deployerAddress: true, decimals: true } } },
      orderBy: { firstSeenAt: 'desc' },
    });

    const rejections: Record<string, number> = {};
    const reject = (reason: string) => { rejections[reason] = (rejections[reason] ?? 0) + 1; };
    const passedCandidates: ScreenResult['passedCandidates'] = [];
    let passed = 0;

    for (const s of survivors) {
      const chain = s.chain as SupportedChain;
      const feats = (s.entryFeatures ?? {}) as { fdvUsd?: number | null };
      const entryFdv = feats.fdvUsd ?? null;

      // ── FDV headroom gate ──────────────────────────────────────────────────
      if (entryFdv == null) { reject('fdv_unknown'); continue; }
      if (entryFdv < minFdv) { reject('fdv_too_low_dust'); continue; }
      if (entryFdv > maxFdv) { reject('fdv_too_high_no_headroom'); continue; }

      // ── LP lock/burn HARD gate ─────────────────────────────────────────────
      const lp = await this.lpLock.detect(chain, s.poolAddress, s.liquidityModel);
      if (!lp.lockedOrBurned) { reject(`lp_not_locked:${lp.source}`); continue; }

      await this.prisma.gemCandidate.upsert({
        where: { chain_tokenAddress_poolAddress: { chain, tokenAddress: s.tokenAddress, poolAddress: s.poolAddress } },
        update: {
          lpLockedOrBurned: lp.lockedOrBurned, lpLockedFraction: lp.fraction, lpLockSource: lp.source,
        },
        create: {
          chain, tokenAddress: s.tokenAddress, poolAddress: s.poolAddress,
          symbol: s.symbol, liquidityModel: s.liquidityModel,
          deployerAddress: s.token?.deployerAddress ?? null,
          t0Ts: s.firstSeenAt,
          entryFdvUsd: entryFdv,
          entryPriceUsd: s.entryPriceUsd,
          entryLiquidityUsd: s.onchainLiqEntryUsd,
          lpLockedOrBurned: lp.lockedOrBurned, lpLockedFraction: lp.fraction, lpLockSource: lp.source,
        },
      });
      passed++;
      passedCandidates.push({ symbol: s.symbol ?? '?', chain, tokenAddress: s.tokenAddress, entryFdvUsd: entryFdv, lpSource: lp.source });
      this.logger.log(`gem_candidate: ${chain}:${s.tokenAddress} (${s.symbol ?? '?'}) FDV=$${entryFdv.toFixed(0)} lp=${lp.source} frac=${lp.fraction?.toFixed(3) ?? '?'}`);
    }

    return { screened: survivors.length, passed, rejections, passedCandidates };
  }
}
