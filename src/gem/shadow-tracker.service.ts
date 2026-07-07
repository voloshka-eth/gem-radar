import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { PrismaService } from '../database/prisma.service';
import { CSV_SCHEMA_VERSION } from '../file-logger/csv-schemas';
import { FileLoggerService } from '../file-logger/file-logger.service';
import { LiquidityVerificationService } from '../onchain/liquidity-verification.service';
import { RiskEngineService } from '../risk-engine/risk-engine.service';
import { GeckoTerminalService } from '../collector/geckoterminal/geckoterminal.service';
import { QUOTE_ASSET_MAP, SupportedChain, CandidatePool } from '../collector/collector.types';

const num = (d: unknown): number | null => (d == null ? null : Number(d));
const csvNum = (n: number | null | undefined): string => (n == null || !Number.isFinite(n) ? '' : String(n));
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
    private readonly fileLogger: FileLoggerService,
    private readonly liquidityVerifier: LiquidityVerificationService,
    private readonly riskEngine: RiskEngineService,
    private readonly geckoTerminal: GeckoTerminalService,
  ) {}

  async track(): Promise<{ candidates: number; captured: number; missed: number }> {
    const runId = `shadow-${randomUUID().slice(0, 8)}`;
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
          const capturedAt = new Date();
          await this.prisma.gemShadowTick.create({
            data: {
              candidateId: c.id, chain: c.chain, tokenAddress: c.tokenAddress, poolAddress: c.poolAddress,
              horizon, dueAt, capturedAt, elapsedMin, status: 'captured',
              priceUsd: state.priceUsd, fdvUsd: state.fdvUsd, onchainLiqUsd: state.onchainLiqUsd,
              multipleVsT0: multiple, uniqueBuyers: state.uniqueBuyers, uniqueSellers: state.uniqueSellers,
              sellSimOk: state.sellSimOk, rugFlag: state.rugFlag,
            },
          }).then(() => {
            this.logShadowTick(runId, c, horizon, dueAt, capturedAt, elapsedMin, 'captured', state!, multiple);
          }).catch((e) => this.logger.warn(`tick write failed ${c.tokenAddress} ${horizon}: ${(e as Error).message}`));
          captured++;
        } else {
          const capturedAt = new Date();
          // Horizon elapsed before we started tracking → honest "missed" (no fabricated reading).
          await this.prisma.gemShadowTick.create({
            data: {
              candidateId: c.id, chain: c.chain, tokenAddress: c.tokenAddress, poolAddress: c.poolAddress,
              horizon, dueAt, capturedAt, elapsedMin, status: 'missed', rugFlag: false,
            },
          }).then(() => {
            this.logShadowTick(runId, c, horizon, dueAt, capturedAt, elapsedMin, 'missed', null, null);
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

  private logShadowTick(
    runId: string,
    candidate: {
      id: string;
      chain: string;
      tokenAddress: string;
      symbol: string | null;
      poolAddress: string;
      deployerAddress: string | null;
      t0Ts: Date;
      entryFdvUsd: unknown;
    },
    horizon: string,
    dueAt: Date,
    capturedAt: Date,
    elapsedMin: number,
    status: 'captured' | 'missed',
    state: ForwardState | null,
    multiple: number | null,
  ): void {
    this.fileLogger.logGemShadowTick({
      ts: new Date().toISOString(),
      run_id: runId,
      schema_version: CSV_SCHEMA_VERSION,
      candidate_id: candidate.id,
      chain: candidate.chain,
      token_address: candidate.tokenAddress,
      symbol: candidate.symbol ?? '',
      pool_address: candidate.poolAddress,
      deployer_address: candidate.deployerAddress ?? '',
      t0_ts: candidate.t0Ts.toISOString(),
      horizon,
      due_at: dueAt.toISOString(),
      captured_at: capturedAt.toISOString(),
      elapsed_min: String(elapsedMin),
      status,
      price_usd: csvNum(state?.priceUsd),
      fdv_usd: csvNum(state?.fdvUsd),
      entry_fdv_usd: csvNum(num(candidate.entryFdvUsd)),
      multiple_vs_t0: csvNum(multiple),
      onchain_liq_usd: csvNum(state?.onchainLiqUsd),
      unique_buyers: csvNum(state?.uniqueBuyers),
      unique_sellers: csvNum(state?.uniqueSellers),
      sell_sim_ok: state?.sellSimOk == null ? '' : String(state.sellSimOk),
      rug_flag: state == null ? 'false' : String(state.rugFlag),
    });
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
