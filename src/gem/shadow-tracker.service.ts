import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../database/prisma.service';
import { LiquidityVerificationService } from '../onchain/liquidity-verification.service';
import { RiskEngineService } from '../risk-engine/risk-engine.service';
import { GeckoTerminalService } from '../collector/geckoterminal/geckoterminal.service';
import { QUOTE_ASSET_MAP, SupportedChain, CandidatePool } from '../collector/collector.types';

const num = (d: unknown): number | null => (d == null ? null : Number(d));
const horizonLabel = (min: number): string => (min < 60 ? `${min}m` : `${min / 60}h`);

interface ForwardState {
  priceUsd: number | null;     // on-chain spot (physicality-guarded)
  fdvUsd: number | null;       // GeckoTerminal FDV (same source/method as the stored t0 FDV)
  onchainLiqUsd: number | null;
  uniqueBuyers: number | null;
  uniqueSellers: number | null;
  sellSimOk: boolean | null;
  rugFlag: boolean;            // LP pulled (liquidity gone) or cannot sell
}

/**
 * SHADOW FORWARD TRACKER — observes (never trades) each gem_candidate at the configured
 * horizons (T+15m/1h/6h/24h/72h). Re-uses the on-chain read paths (V2 reserves / V3 QuoterV2
 * with the physicality guard) for liquidity/price/rug truth, GeckoTerminal for FDV continuity
 * (the same source the t0 FDV came from), and the risk engine's sell simulation.
 *
 * Because tracking begins when a candidate is screened, horizons that already elapsed before
 * the first run are recorded as status='missed' (we never observed them) rather than fabricated;
 * the current-age bucket is recorded as status='captured'. Going forward each new horizon is
 * captured near its due time.
 */
@Injectable()
export class ShadowTrackerService {
  private readonly logger = new Logger(ShadowTrackerService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly liquidityVerifier: LiquidityVerificationService,
    private readonly riskEngine: RiskEngineService,
    private readonly geckoTerminal: GeckoTerminalService,
  ) {}

  async track(): Promise<{ candidates: number; captured: number; missed: number }> {
    const horizonsMin = (this.config.get<number[]>('gem.horizonsMin') ?? [15, 60, 360, 1440, 4320]);
    const rugLiqUsd = this.config.get<number>('gem.rugLiqUsd') ?? 50;
    const now = Date.now();

    const candidates = await this.prisma.gemCandidate.findMany({ include: { ticks: true } });
    let captured = 0;
    let missed = 0;

    for (const c of candidates) {
      const elapsedMin = Math.floor((now - c.t0Ts.getTime()) / 60000);
      const have = new Set(c.ticks.map((t) => t.horizon));
      const dueHorizons = horizonsMin.filter((m) => elapsedMin >= m);
      if (dueHorizons.length === 0) continue;
      const currentBucket = Math.max(...dueHorizons); // highest horizon already elapsed

      // Capture the current bucket once (live read); mark any older un-observed horizons missed.
      let state: ForwardState | null = null;
      const entryFdv = num(c.entryFdvUsd);

      for (const m of dueHorizons) {
        const horizon = horizonLabel(m);
        if (have.has(horizon)) continue;
        const dueAt = new Date(c.t0Ts.getTime() + m * 60000);

        if (m === currentBucket) {
          if (!state) state = await this.captureState(c.chain as SupportedChain, c.poolAddress, c.tokenAddress, c.symbol ?? '', rugLiqUsd);
          const fdvNow = state.fdvUsd;
          const multiple = fdvNow != null && entryFdv != null && entryFdv > 0 ? fdvNow / entryFdv : null;
          await this.prisma.gemShadowTick.create({
            data: {
              candidateId: c.id, chain: c.chain, tokenAddress: c.tokenAddress, poolAddress: c.poolAddress,
              horizon, dueAt, capturedAt: new Date(), elapsedMin, status: 'captured',
              priceUsd: state.priceUsd, fdvUsd: state.fdvUsd, onchainLiqUsd: state.onchainLiqUsd,
              multipleVsT0: multiple, uniqueBuyers: state.uniqueBuyers, uniqueSellers: state.uniqueSellers,
              sellSimOk: state.sellSimOk, rugFlag: state.rugFlag,
            },
          }).catch((e) => this.logger.warn(`tick write failed ${c.tokenAddress} ${horizon}: ${(e as Error).message}`));
          captured++;
        } else {
          // Horizon elapsed before we started tracking → honest "missed" (no fabricated reading).
          await this.prisma.gemShadowTick.create({
            data: {
              candidateId: c.id, chain: c.chain, tokenAddress: c.tokenAddress, poolAddress: c.poolAddress,
              horizon, dueAt, capturedAt: new Date(), elapsedMin, status: 'missed', rugFlag: false,
            },
          }).catch(() => undefined);
          missed++;
        }
      }

      if (state) {
        this.logger.log(
          `shadow ${c.chain}:${c.tokenAddress} (${c.symbol ?? '?'}) @${horizonLabel(currentBucket)} ` +
          `mult=${state.fdvUsd != null && entryFdv ? (state.fdvUsd / entryFdv).toFixed(3) : '?'} ` +
          `liq=${state.onchainLiqUsd != null ? '$' + state.onchainLiqUsd.toFixed(0) : '?'} rug=${state.rugFlag}`,
        );
      }
    }

    return { candidates: candidates.length, captured, missed };
  }

  private async captureState(
    chain: SupportedChain, poolAddress: string, tokenAddress: string, symbol: string, rugLiqUsd: number,
  ): Promise<ForwardState> {
    // Reconstruct a CandidatePool from the stored Pool row for the verifier.
    const pool = await this.prisma.pool.findUnique({
      where: { chain_poolAddress: { chain, poolAddress } },
      include: { token: { select: { decimals: true } } },
    });
    let priceUsd: number | null = null;
    let onchainLiqUsd: number | null = null;
    if (pool) {
      const quoteMap = QUOTE_ASSET_MAP[chain] ?? {};
      const quoteAddr = [pool.token0, pool.token1].find((a) => quoteMap[a.toLowerCase()] != null);
      if (quoteAddr) {
        const candidatePool: CandidatePool = {
          chain, poolAddress: pool.poolAddress, dex: pool.dex,
          token0Address: pool.token0, token1Address: pool.token1,
          quoteAsset: pool.quoteAsset, quoteAssetAddress: quoteAddr.toLowerCase(), source: 'gem-shadow',
        };
        try {
          const liq = await this.liquidityVerifier.verify(candidatePool, pool.token?.decimals ?? undefined);
          priceUsd = liq.spotPriceUsd;
          onchainLiqUsd = liq.onchainTvlUsd;
        } catch { /* unreadable → treated as rug below */ }
      }
    }

    const stats = await this.geckoTerminal.getPoolTradeStats(chain, poolAddress);
    const sellSimOk = await this.reCheckSellSim(chain, tokenAddress, symbol);

    const rugFlag =
      onchainLiqUsd == null || onchainLiqUsd <= rugLiqUsd ||
      priceUsd == null || priceUsd <= 0 || sellSimOk === false;

    return {
      priceUsd, fdvUsd: stats?.fdvUsd ?? null, onchainLiqUsd,
      uniqueBuyers: stats?.uniqueBuyers ?? null, uniqueSellers: stats?.uniqueSellers ?? null,
      sellSimOk, rugFlag,
    };
  }

  private async reCheckSellSim(chain: SupportedChain, tokenAddress: string, symbol: string): Promise<boolean | null> {
    try {
      const r = await this.riskEngine.checkToken(chain, tokenAddress, symbol, symbol, 'gem-shadow');
      const hp = r.merged.honeypot;
      return hp === true ? false : hp === false ? true : null;
    } catch {
      return null;
    }
  }
}
