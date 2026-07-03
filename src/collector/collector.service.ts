import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { FileLoggerService } from '../file-logger/file-logger.service';
import { CSV_SCHEMA_VERSION } from '../file-logger/csv-schemas';
import { GeckoTerminalService } from './geckoterminal/geckoterminal.service';
import { DexScreenerService } from './dexscreener/dexscreener.service';
import { CollectorResult, SupportedChain } from './collector.types';
import { applyStage0Gate, filterDuplicates, Stage0Config } from './stage0-gate';
import { RiskEngineService } from '../risk-engine/risk-engine.service';
import { ContractRiskResult, NormalizedRiskData } from '../risk-engine/risk-engine.types';
import { TokenAgeService } from '../onchain/token-age.service';
import { LiquidityVerificationService } from '../onchain/liquidity-verification.service';
import type { LiquidityCheckResult } from '../onchain/onchain.types';
import { PoolLiquiditySnapshotRow } from '../file-logger/csv-schemas';
import { ScoringService } from '../scoring/scoring.service';
import type { ScoreSnapshot, ScoreResult } from '../scoring/score';
import { PaperService } from '../paper/paper.service';

type CandidateProcessingResult = {
  outcome: 'SAFE' | 'REJECT' | 'QUARANTINE';
  riskResult: ContractRiskResult;
};

type DeployerGateHit = {
  address: string;
  deploymentsCount: number;
  rugLikeCount: number;
  rugRate: number;
};

const RUG_LIKE_OUTCOMES = new Set(['RUG', 'UNSELLABLE', 'LIQ_PULL']);

@Injectable()
export class CollectorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CollectorService.name);
  private collectInterval: ReturnType<typeof setInterval> | null = null;
  private isCollecting = false;
  // Cross-cycle dedup: chain:tokenAddress seen in this session.
  // Resets on restart. Key = "chain:tokenAddress" (not pool) — same token in a new
  // pool still uses the same contract, so re-checking is wasteful.
  // Exception: same symbol with a DIFFERENT tokenAddress is a different token → processed.
  private readonly seenAcrossCycles = new Set<string>();

  private readonly enabledChains: SupportedChain[];
  private readonly pollIntervalMs: number;
  private readonly stage0Config: Stage0Config;
  private readonly tokenMaxAgeDays: number;
  private readonly deployerGateEnabled: boolean;
  private readonly deployerGateMinDeployments: number;
  private readonly deployerGateMinRugLike: number;
  private readonly deployerGateMinRugRate: number;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly fileLogger: FileLoggerService,
    private readonly geckoTerminal: GeckoTerminalService,
    private readonly dexScreener: DexScreenerService,
    private readonly riskEngine: RiskEngineService,
    private readonly tokenAge: TokenAgeService,
    private readonly liquidityVerifier: LiquidityVerificationService,
    private readonly scoring: ScoringService,
    private readonly paper: PaperService,
  ) {
    this.enabledChains = (
      this.config.get<string[]>('chain.enabledChains') ?? ['ethereum', 'base']
    ) as SupportedChain[];

    this.pollIntervalMs =
      this.config.get<number>('collector.pollIntervalMs') ?? 120_000;

    const maxAgeHours = this.config.get<number>('collector.newPoolMaxAgeHours') ?? 6;
    this.stage0Config = {
      maxPoolAgeMs: maxAgeHours * 60 * 60 * 1000,
      minLiquidityUsd: this.config.get<number>('scoring.minLiquidityUsd') ?? 5_000,
      minFdvUsd: this.config.get<number>('scoring.minFdvUsd') ?? 10_000,
      maxFdvUsd: this.config.get<number>('scoring.maxFdvUsd') ?? 50_000_000,
    };
    this.tokenMaxAgeDays = this.config.get<number>('collector.tokenMaxAgeDays') ?? 7;
    this.deployerGateEnabled =
      this.config.get<boolean>('collector.deployerGateEnabled') ?? true;
    this.deployerGateMinDeployments =
      this.config.get<number>('collector.deployerGateMinDeployments') ?? 2;
    this.deployerGateMinRugLike =
      this.config.get<number>('collector.deployerGateMinRugLike') ?? 2;
    this.deployerGateMinRugRate =
      this.config.get<number>('collector.deployerGateMinRugRate') ?? 0.5;
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────────────

  onModuleInit(): void {
    this.collectInterval = setInterval(
      () => void this.runCollectionCycle(),
      this.pollIntervalMs,
    );
    this.logger.log(
      `Collector scheduled — chains: [${this.enabledChains.join(', ')}], interval: ${this.pollIntervalMs}ms`,
    );
  }

  onModuleDestroy(): void {
    if (this.collectInterval) {
      clearInterval(this.collectInterval);
      this.collectInterval = null;
    }
  }

  // ─── Main cycle (also callable directly for testing) ─────────────────────────

  async runCollectionCycle(): Promise<void> {
    if (this.isCollecting) {
      this.logger.warn('Collection cycle already in progress — skipping tick');
      return;
    }
    this.isCollecting = true;
    try {
      await this.doCollectionCycle();
    } finally {
      this.isCollecting = false;
    }
  }

  private async doCollectionCycle(): Promise<void> {
    const runId = randomUUID();
    const cycleStart = Date.now();
    this.logger.log(`Cycle start — run_id: ${runId}`);

    let total = 0;
    let passed = 0;
    let rejected = 0;
    let quarantined = 0;
    let skipped = 0;

    const seenThisCycle = new Set<string>();
    const cycleRiskResults: ContractRiskResult[] = [];

    // ── GeckoTerminal pass (per chain) ──
    for (const chain of this.enabledChains) {
      const gtNormalized = await this.geckoTerminal.getNewPools(chain);
      const candidates = filterDuplicates(gtNormalized, seenThisCycle);

      this.fileLogger.logRawPayload({
        run_id: runId,
        ts: new Date().toISOString(),
        chain,
        source: 'geckoterminal',
        pool_count: gtNormalized.length,
        deduped_count: candidates.length,
      });
      await this.storeRawPayload(runId, chain, 'geckoterminal', {
        payload_type: 'cycle_summary',
        pool_count: gtNormalized.length,
        deduped_count: candidates.length,
        pool_addresses: candidates.map((c) => c.pool.poolAddress).slice(0, 100),
      });

      for (const candidate of candidates) {
        const tokenKey = `${candidate.pool.chain}:${candidate.token.tokenAddress}`;
        if (this.seenAcrossCycles.has(tokenKey)) { skipped++; continue; }

        total++;
        const gate = applyStage0Gate(candidate, this.stage0Config);
        if (!gate.pass) {
          rejected++;
          this.logRejection(candidate, 'stage0', gate.reason!, runId);
        } else if (await this.isTokenTooOld(candidate, runId)) {
          rejected++;
        } else {
          const processed = await this.processCandidate(candidate, runId);
          cycleRiskResults.push(processed.riskResult);
          if (processed.outcome === 'SAFE') passed++;
          else if (processed.outcome === 'QUARANTINE') quarantined++;
          else rejected++;
        }
        this.seenAcrossCycles.add(tokenKey);
      }
    }

    // ── DexScreener supplementary pass ──
    const dsAddresses = await this.dexScreener.getLatestProfileAddresses(this.enabledChains);
    const dsCandidates = await this.dexScreener.getPairsForTokens(dsAddresses);
    const dsFiltered = filterDuplicates(dsCandidates, seenThisCycle);

    this.fileLogger.logRawPayload({
      run_id: runId,
      ts: new Date().toISOString(),
      source: 'dexscreener',
      raw_count: dsCandidates.length,
      deduped_count: dsFiltered.length,
    });
    await this.storeRawPayload(runId, 'multi', 'dexscreener', {
      payload_type: 'cycle_summary',
      raw_count: dsCandidates.length,
      deduped_count: dsFiltered.length,
      token_addresses: dsFiltered.map((c) => c.token.tokenAddress).slice(0, 100),
    });

    for (const candidate of dsFiltered) {
      const tokenKey = `${candidate.pool.chain}:${candidate.token.tokenAddress}`;
      if (this.seenAcrossCycles.has(tokenKey)) { skipped++; continue; }

      total++;
      const gate = applyStage0Gate(candidate, this.stage0Config);
      if (!gate.pass) {
        rejected++;
        this.logRejection(candidate, 'stage0', gate.reason!, runId);
      } else if (await this.isTokenTooOld(candidate, runId)) {
        rejected++;
      } else {
        const processed = await this.processCandidate(candidate, runId);
        cycleRiskResults.push(processed.riskResult);
        if (processed.outcome === 'SAFE') passed++;
        else if (processed.outcome === 'QUARANTINE') quarantined++;
        else rejected++;
      }
      this.seenAcrossCycles.add(tokenKey);
    }

    this.emitContractGateSanityAlert(runId, cycleRiskResults);

    this.logger.log(
      `Cycle done — run_id: ${runId} | total: ${total} passed: ${passed} rejected: ${rejected} quarantined: ${quarantined} skipped: ${skipped} | elapsed: ${Date.now() - cycleStart}ms`,
    );
  }

  /**
   * Run risk check and route to one of three paths:
   *   CONTRACT_SAFE    → persist (Token + Pool + Snapshot + RiskCheck) + new_pools.csv
   *   CONTRACT_REJECT  → contract_rejected_tokens.csv + ContractRiskCheck (null tokenId)
   *   CONTRACT_UNKNOWN → quarantine_tokens.csv + QuarantineToken DB + ContractRiskCheck (null tokenId)
   *                      NOT in new_pools.csv, NOT scored, NOT paper-traded.
   */
  private async processCandidate(
    candidate: CollectorResult,
    runId: string,
  ): Promise<CandidateProcessingResult> {
    const { pool, token } = candidate;
    let riskResult = await this.riskEngine.checkToken(
      pool.chain,
      token.tokenAddress,
      token.symbol,
      token.name,
      runId,
    );
    const now = new Date();
    this.enrichCandidateDeployer(candidate, riskResult);

    if (riskResult.decision === 'CONTRACT_SAFE') {
      const deployerGateHit = await this.checkDeployerReputation(candidate);
      if (deployerGateHit) {
        riskResult = this.rejectForDeployerReputation(riskResult, deployerGateHit);
      }
    }

    if (riskResult.decision === 'CONTRACT_REJECT') {
      this.logContractRejected(candidate, riskResult, runId);
      if (!riskResult.cacheHit) {
        await this.storeRiskCheck(runId, pool.chain, token.tokenAddress, null, now, riskResult);
      }
      return { outcome: 'REJECT', riskResult };
    }

    if (riskResult.decision === 'CONTRACT_UNKNOWN') {
      this.logQuarantine(candidate, runId);
      await this.persistQuarantine(candidate, runId);
      if (!riskResult.cacheHit) {
        await this.storeRiskCheck(runId, pool.chain, token.tokenAddress, null, now, riskResult);
      }
      return { outcome: 'QUARANTINE', riskResult };
    }

    // CONTRACT_SAFE — run on-chain liquidity verification before persisting
    const liqResult = await this.liquidityVerifier.verify(candidate.pool, candidate.token.decimals);
    const result = await this.persistCandidate(candidate, runId, riskResult, liqResult);
    if (result?.isNewDiscovery) this.logNewPool(candidate, runId, riskResult.decision);
    if (result) {
      this.logPoolSnapshot(candidate, runId);
      this.logLiquiditySnapshot(candidate, runId, liqResult);
      // Survivor watchlist + scoring + paper entry: ONLY for CONTRACT_SAFE + token-age
      // gate + liquidity_verified. REJECT/UNKNOWN/unverified tokens never reach here.
      if (liqResult.liquidityVerified === true) {
        const ageDays = await this.tokenAge.getTokenAgeDays(pool.chain, token.tokenAddress);
        this.logCandidate(candidate, runId, liqResult, ageDays);
        const score = await this.scoreSurvivor(candidate, runId, liqResult, result.id, ageDays);
        await this.paper.recordEntry({
          pool, token, liq: liqResult, score, ageDays,
          tokenId: result.id, poolId: result.poolId, runId,
          buyTax: riskResult.merged.buyTax,
        });
      }
    }
    return { outcome: 'SAFE', riskResult };
  }

  private enrichCandidateDeployer(
    candidate: CollectorResult,
    riskResult: ContractRiskResult,
  ): void {
    const deployer = riskResult.merged.deployerAddress?.toLowerCase();
    if (!candidate.token.deployerAddress && deployer) {
      candidate.token.deployerAddress = deployer;
    }
  }

  private rejectForDeployerReputation(
    riskResult: ContractRiskResult,
    hit: DeployerGateHit,
  ): ContractRiskResult {
    this.logger.warn(
      `Deployer reputation gate: ${hit.address} rejected - ` +
      `${hit.rugLikeCount}/${hit.deploymentsCount} rug-like ` +
      `(${(hit.rugRate * 100).toFixed(1)}%)`,
    );
    return {
      ...riskResult,
      decision: 'CONTRACT_REJECT',
      rejectReasons: [...riskResult.rejectReasons, 'deployer_repeat_rugger'],
      merged: {
        ...riskResult.merged,
        deployerAddress: hit.address,
      },
    };
  }

  private async checkDeployerReputation(
    candidate: CollectorResult,
  ): Promise<DeployerGateHit | null> {
    if (!this.deployerGateEnabled) return null;

    const address = candidate.token.deployerAddress?.toLowerCase();
    if (!address) return null;

    try {
      const [deployerRow, deployedTokens] = await Promise.all([
        this.prisma.deployer.findUnique({
          where: { chain_address: { chain: candidate.token.chain, address } },
        }),
        this.prisma.token.findMany({
          where: { chain: candidate.token.chain, deployerAddress: address },
          select: {
            tokenAddress: true,
            paperPositions: { select: { outcomeClass: true } },
          },
        }),
      ]);

      const outcomeRugTokens = deployedTokens.filter((token) =>
        token.paperPositions.some((position) =>
          position.outcomeClass ? RUG_LIKE_OUTCOMES.has(position.outcomeClass) : false,
        ),
      ).length;
      const deploymentsCount = Math.max(
        deployerRow?.deploymentsCount ?? 0,
        deployedTokens.length,
      );
      const rugLikeCount = Math.max(
        deployerRow?.rugLikeCount ?? 0,
        outcomeRugTokens,
      );
      const rugRate = deploymentsCount > 0 ? rugLikeCount / deploymentsCount : 0;

      if (
        deploymentsCount >= this.deployerGateMinDeployments &&
        rugLikeCount >= this.deployerGateMinRugLike &&
        rugRate >= this.deployerGateMinRugRate
      ) {
        return { address, deploymentsCount, rugLikeCount, rugRate };
      }
    } catch (err) {
      this.logger.warn(
        `Deployer reputation lookup failed for ${candidate.token.chain}:${address} - ${(err as Error).message}`,
      );
    }

    return null;
  }

  private emitContractGateSanityAlert(runId: string, results: ContractRiskResult[]): void {
    const total = results.length;
    if (total === 0) return;

    const safe = results.filter((r) => r.decision === 'CONTRACT_SAFE').length;
    const goplusQueried = results.filter((r) => r.goplusQueried);
    const alerts: string[] = [];

    if (total >= 20 && safe / total > 0.9) {
      alerts.push(`SAFE RATE ${((safe / total) * 100).toFixed(1)}% > 90% (${safe}/${total})`);
    }

    if (goplusQueried.length >= 20) {
      const taxFilled = goplusQueried.filter(
        (r) => r.merged.buyTax !== undefined || r.merged.sellTax !== undefined,
      ).length;
      const mintFilled = goplusQueried.filter((r) => r.merged.mintRisk !== undefined).length;
      const taxRate = taxFilled / goplusQueried.length;
      const mintRate = mintFilled / goplusQueried.length;

      if (taxRate < 0.4) {
        alerts.push(`GoPlus tax fill rate ${(taxRate * 100).toFixed(1)}% < 40% (${taxFilled}/${goplusQueried.length})`);
      }
      if (mintRate < 0.4) {
        alerts.push(`GoPlus can_mint fill rate ${(mintRate * 100).toFixed(1)}% < 40% (${mintFilled}/${goplusQueried.length})`);
      }
    }

    if (alerts.length > 0) {
      this.logger.warn(
        `CONTRACT GATE DATA QUALITY ALERT run_id=${runId}: ${alerts.join(' | ')}`,
      );
    }
  }

  // ─── DB persistence ───────────────────────────────────────────────────────────

  private async persistCandidate(
    candidate: CollectorResult,
    runId: string,
    riskResult?: ContractRiskResult,
    liqResult?: LiquidityCheckResult,
  ): Promise<{ id: string; poolId: string; isNewDiscovery: boolean } | null> {
    const { token, pool } = candidate;
    const now = new Date();

    try {
      // Check pool existence BEFORE upsert — upsert result alone cannot distinguish create vs update.
      const existingPool = await this.prisma.pool.findUnique({
        where: { chain_poolAddress: { chain: pool.chain, poolAddress: pool.poolAddress } },
        select: { id: true },
      });
      const isNewDiscovery = !existingPool;

      const dbToken = await this.prisma.token.upsert({
        where: { chain_tokenAddress: { chain: token.chain, tokenAddress: token.tokenAddress } },
        create: {
          chain: token.chain,
          tokenAddress: token.tokenAddress,
          symbol: token.symbol,
          name: token.name,
          decimals: token.decimals,
          firstSeenAt: now,
          deployerAddress: token.deployerAddress,
          source: token.source,
        },
        // firstSeenAt is write-once — intentionally absent from update clause.
        update: {
          symbol: token.symbol || undefined,
          name: token.name || undefined,
          decimals: token.decimals ?? undefined,
        },
      });

      const dbPool = await this.prisma.pool.upsert({
        where: { chain_poolAddress: { chain: pool.chain, poolAddress: pool.poolAddress } },
        create: {
          chain: pool.chain,
          poolAddress: pool.poolAddress,
          dex: pool.dex,
          tokenId: dbToken.id,
          token0: pool.token0Address,
          token1: pool.token1Address,
          quoteAsset: pool.quoteAsset,
          feeTier: pool.feeTier,
          firstSeenAt: pool.poolCreatedAt ?? now,
        },
        update: {},
      });

      await this.prisma.poolSnapshot.create({
        data: {
          chain: pool.chain,
          poolId: dbPool.id,
          tokenId: dbToken.id,
          ts: now,
          priceUsd: pool.priceUsd ?? null,
          onchainLiquidityUsd: liqResult?.onchainTvlUsd ?? null,
          reportedLiquidityUsd: pool.liquidityUsd ?? null,
          fdvUsd: pool.fdvUsd ?? null,
          vol5m: pool.vol5m ?? null,
          vol1h: pool.vol1h ?? null,
          vol6h: pool.vol6h ?? null,
          vol24h: pool.vol24h ?? null,
          buys: pool.buys1h ?? null,
          sells: pool.sells1h ?? null,
          txCount: pool.txCount1h ?? null,
          liquidityModel: liqResult?.liquidityModel ?? null,
          liquidityVerified: liqResult?.liquidityVerified ?? null,
          reportedVsOnchainPct: liqResult?.reportedVsOnchainPct ?? null,
          spotPriceUsd: liqResult?.spotPriceUsd ?? null,
          executableDepthUsd: liqResult?.executableDepthUsd ?? null,
          slip50: liqResult?.slip50 ?? null,
          slip100: liqResult?.slip100 ?? null,
          slip500: liqResult?.slip500 ?? null,
          slip1000: liqResult?.slip1000 ?? null,
        },
      });

      if (riskResult && !riskResult.cacheHit) {
        await this.storeRiskCheck(runId, pool.chain, token.tokenAddress, dbToken.id, now, riskResult);
      }

      return { id: dbToken.id, poolId: dbPool.id, isNewDiscovery };
    } catch (err) {
      this.logger.error(
        `Persist failed for ${token.chain}:${token.tokenAddress} — ${(err as Error).message}`,
      );
      return null;
    }
  }

  private async persistQuarantine(
    candidate: CollectorResult,
    runId: string,
  ): Promise<void> {
    const { token, pool } = candidate;
    try {
      await this.prisma.quarantineToken.create({
        data: {
          runId,
          chain: pool.chain,
          tokenAddress: token.tokenAddress,
          tokenSymbol: token.symbol,
          tokenName: token.name,
          poolAddress: pool.poolAddress,
          dex: pool.dex,
          status: 'PENDING',
        },
      });
    } catch (err) {
      this.logger.warn(
        `Quarantine DB write failed for ${pool.chain}:${token.tokenAddress} — ${(err as Error).message}`,
      );
    }
  }

  private async storeRiskCheck(
    runId: string,
    chain: string,
    tokenAddress: string,
    tokenId: string | null,
    ts: Date,
    r: ContractRiskResult,
  ): Promise<void> {
    try {
      await this.prisma.contractRiskCheck.create({
        data: {
          runId,
          chain,
          tokenAddress,
          tokenId: tokenId ?? undefined,
          ts,
          source: 'goplus',
          goplusQueried: r.goplusQueried,
          honeypotQueried: r.honeypotQueried,
          verified: r.merged.verified ?? null,
          honeypot: r.merged.honeypot ?? null,
          buyTax: r.merged.buyTax ?? null,
          sellTax: r.merged.sellTax ?? null,
          canMint: r.merged.mintRisk ?? null,
          canBlacklist: r.merged.blacklistRisk ?? null,
          canPause: r.merged.pauseRisk ?? null,
          isProxy: r.merged.proxyRisk ?? null,
          ownerRenounced: r.merged.ownerRenounced ?? null,
          lpLockedOrBurned: r.merged.lpLockedOrBurned ?? null,
          decision: r.decision,
          rejectReasons: r.rejectReasons.length > 0 ? (r.rejectReasons as Prisma.InputJsonValue) : Prisma.JsonNull,
          hardReject: r.decision === 'CONTRACT_REJECT',
          rejectReason: r.rejectReasons[0] ?? null,
        },
      });
    } catch (err) {
      this.logger.warn(
        `Risk check DB write failed (${chain}:${tokenAddress}): ${(err as Error).message}`,
      );
    }
  }

  private async storeRawPayload(
    runId: string,
    chain: string,
    source: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.prisma.rawCollectorPayload.create({
        data: { runId, chain, source, ts: new Date(), payload: data as Prisma.InputJsonValue },
      });
    } catch (err) {
      this.logger.warn(`Raw payload DB write failed (${source}/${chain}): ${(err as Error).message}`);
    }
  }

  // ─── CSV logging ──────────────────────────────────────────────────────────────

  private logNewPool(
    candidate: CollectorResult,
    runId: string,
    riskDecision: string,
  ): void {
    const { token, pool } = candidate;
    this.fileLogger.logNewPool({
      ts: new Date().toISOString(),
      run_id: runId,
      schema_version: CSV_SCHEMA_VERSION,
      chain: pool.chain,
      token_address: token.tokenAddress,
      token_symbol: token.symbol,
      token_name: token.name,
      pool_address: pool.poolAddress,
      dex: pool.dex,
      quote_asset: pool.quoteAsset,
      price_usd: pool.priceUsd?.toString() ?? '',
      liquidity_usd: pool.liquidityUsd?.toString() ?? '',
      fdv_usd: pool.fdvUsd?.toString() ?? '',
      vol_5m: pool.vol5m?.toString() ?? '',
      vol_1h: pool.vol1h?.toString() ?? '',
      vol_6h: pool.vol6h?.toString() ?? '',
      vol_24h: pool.vol24h?.toString() ?? '',
      buys_1h: pool.buys1h?.toString() ?? '',
      sells_1h: pool.sells1h?.toString() ?? '',
      pool_created_at: pool.poolCreatedAt?.toISOString() ?? '',
      source: pool.source,
      risk_decision: riskDecision,
    });
  }

  private logPoolSnapshot(candidate: CollectorResult, runId: string): void {
    const { token, pool } = candidate;
    this.fileLogger.logPoolSnapshot({
      ts: new Date().toISOString(),
      run_id: runId,
      schema_version: CSV_SCHEMA_VERSION,
      chain: pool.chain,
      token_address: token.tokenAddress,
      pool_address: pool.poolAddress,
      price_usd: pool.priceUsd?.toString() ?? '',
      liquidity_usd: pool.liquidityUsd?.toString() ?? '',
      fdv_usd: pool.fdvUsd?.toString() ?? '',
      vol_5m: pool.vol5m?.toString() ?? '',
      vol_1h: pool.vol1h?.toString() ?? '',
      vol_6h: pool.vol6h?.toString() ?? '',
      vol_24h: pool.vol24h?.toString() ?? '',
      buys_1h: pool.buys1h?.toString() ?? '',
      sells_1h: pool.sells1h?.toString() ?? '',
      source: pool.source,
    });
  }

  private logRejection(
    candidate: CollectorResult,
    stage: string,
    reason: string,
    runId: string,
  ): void {
    const { token, pool } = candidate;
    const now = new Date();
    const poolAgeMinutes =
      pool.poolCreatedAt !== undefined
        ? Math.round((now.getTime() - pool.poolCreatedAt.getTime()) / 60_000)
        : undefined;

    this.fileLogger.logRejectedToken({
      ts: now.toISOString(),
      run_id: runId,
      schema_version: CSV_SCHEMA_VERSION,
      chain: pool.chain,
      token_address: token.tokenAddress,
      token_symbol: token.symbol,
      token_name: token.name,
      pool_address: pool.poolAddress,
      dex: pool.dex,
      quote_asset: pool.quoteAsset ?? '',
      price_usd: pool.priceUsd?.toString() ?? '',
      liquidity_usd: pool.liquidityUsd?.toString() ?? '',
      fdv_usd: pool.fdvUsd?.toString() ?? '',
      vol_5m: pool.vol5m?.toString() ?? '',
      vol_1h: pool.vol1h?.toString() ?? '',
      vol_6h: pool.vol6h?.toString() ?? '',
      vol_24h: pool.vol24h?.toString() ?? '',
      buys_1h: pool.buys1h?.toString() ?? '',
      sells_1h: pool.sells1h?.toString() ?? '',
      tx_count_1h: pool.txCount1h?.toString() ?? '',
      pool_created_at: pool.poolCreatedAt?.toISOString() ?? '',
      pool_age_minutes: poolAgeMinutes?.toString() ?? '',
      stage,
      reason,
      source: pool.source,
      liquidity_trust_level: 'REPORTED_ONLY',
      onchain_verified: 'false',
    });
  }

  private logContractRejected(
    candidate: CollectorResult,
    riskResult: ContractRiskResult,
    runId: string,
  ): void {
    const { token, pool } = candidate;
    const m: NormalizedRiskData = riskResult.merged;
    this.fileLogger.logContractRejected({
      ts: new Date().toISOString(),
      run_id: runId,
      schema_version: CSV_SCHEMA_VERSION,
      chain: pool.chain,
      token_address: token.tokenAddress,
      token_symbol: token.symbol ?? '',
      token_name: token.name ?? '',
      pool_address: pool.poolAddress,
      decision: 'CONTRACT_REJECT',
      reject_reasons: riskResult.rejectReasons.join(';'),
      honeypot: m.honeypot?.toString() ?? '',
      sell_tax: m.sellTax?.toFixed(2) ?? '',
      buy_tax: m.buyTax?.toFixed(2) ?? '',
      can_mint: m.mintRisk?.toString() ?? '',
      can_blacklist: m.blacklistRisk?.toString() ?? '',
      can_pause: m.pauseRisk?.toString() ?? '',
      is_proxy: m.proxyRisk?.toString() ?? '',
    });
  }

  private logQuarantine(candidate: CollectorResult, runId: string): void {
    const { token, pool } = candidate;
    this.fileLogger.logQuarantineToken({
      ts: new Date().toISOString(),
      run_id: runId,
      schema_version: CSV_SCHEMA_VERSION,
      chain: pool.chain,
      token_address: token.tokenAddress,
      token_symbol: token.symbol ?? '',
      token_name: token.name ?? '',
      pool_address: pool.poolAddress,
      dex: pool.dex,
      status: 'PENDING',
    });
  }

  // ── Token-age gate (M3A) ──────────────────────────────────────────────────────
  // Returns true if the token is definitely older than TOKEN_MAX_AGE_DAYS.
  // On error (unknown age) returns false — let it through.
  private async isTokenTooOld(candidate: CollectorResult, runId: string): Promise<boolean> {
    const { token, pool } = candidate;
    const ageDays = await this.tokenAge.getTokenAgeDays(pool.chain, token.tokenAddress);
    if (ageDays === null) return false; // unknown age ≠ old
    if (ageDays <= this.tokenMaxAgeDays) return false;
    this.logger.log(
      `Token-age gate: ${pool.chain}:${token.tokenAddress} (${token.symbol ?? '?'}) ` +
      `age=${ageDays.toFixed(1)}d > ${this.tokenMaxAgeDays}d — token_too_old; ` +
      `skipping risk engine + liquidity check (no contract_risk_checks, no pool_liquidity_snapshots written)`,
    );
    this.logRejection(candidate, 'token_age', 'token_too_old', runId);
    return true;
  }

  // ── Liquidity snapshot CSV (M3A) ─────────────────────────────────────────────
  private logLiquiditySnapshot(
    candidate: CollectorResult,
    runId: string,
    liq: LiquidityCheckResult,
  ): void {
    const { token, pool } = candidate;
    const row: PoolLiquiditySnapshotRow = {
      ts:                     new Date().toISOString(),
      run_id:                 runId,
      schema_version:         CSV_SCHEMA_VERSION,
      chain:                  pool.chain,
      token_address:          token.tokenAddress,
      pool_address:           pool.poolAddress,
      dex:                    pool.dex,
      liquidity_model:        liq.liquidityModel,
      liquidity_verified:     String(liq.liquidityVerified),
      reported_liquidity_usd: pool.liquidityUsd?.toString() ?? '',
      onchain_tvl_usd:        liq.onchainTvlUsd?.toFixed(4) ?? '',
      reported_vs_onchain_pct: liq.reportedVsOnchainPct?.toFixed(6) ?? '',
      executable_depth_usd:   liq.executableDepthUsd?.toString() ?? '',
      slip_50:                liq.slip50?.toFixed(6) ?? '',
      slip_100:               liq.slip100?.toFixed(6) ?? '',
      slip_500:               liq.slip500?.toFixed(6) ?? '',
      slip_1000:              liq.slip1000?.toFixed(6) ?? '',
      spot_price_usd:         liq.spotPriceUsd?.toFixed(12) ?? '',
      error:                  liq.error ?? '',
    };
    this.fileLogger.logLiquiditySnapshot(row);
  }

  // ── Survivor watchlist CSV (M3A) ─────────────────────────────────────────────
  // Only called for tokens that passed the full pipeline. age_days is resolved once
  // by the caller (Redis-cached) and shared with scoring to avoid a duplicate read.
  private logCandidate(
    candidate: CollectorResult,
    runId: string,
    liq: LiquidityCheckResult,
    ageDays: number | null,
  ): void {
    const { token, pool } = candidate;
    this.fileLogger.logCandidate({
      ts:                      new Date().toISOString(),
      run_id:                  runId,
      chain:                   pool.chain,
      token_address:           token.tokenAddress,
      symbol:                  token.symbol ?? '',
      name:                    token.name ?? '',
      model:                   `${pool.dex} / ${liq.liquidityModel}`,
      onchain_tvl_usd:         liq.onchainTvlUsd?.toFixed(2) ?? '',
      reported_vs_onchain_pct: liq.reportedVsOnchainPct?.toFixed(4) ?? '',
      slip_100:                liq.slip100?.toFixed(6) ?? '',
      slip_1000:               liq.slip1000?.toFixed(6) ?? '',
      fdv_usd:                 pool.fdvUsd?.toFixed(0) ?? '',
      age_days:                ageDays != null ? ageDays.toFixed(2) : '',
      deployer_address:        token.deployerAddress ?? '',
      deployer_deployments_count: '',
      deployer_rug_count:      '',
      lp_locked:               '',
      lp_lock_source:          '',
      lp_lock_fraction:        '',
    });
  }

  // ── M4 scoring ───────────────────────────────────────────────────────────────
  // Runs the pure scorer on a verified survivor, then persists to DB + CSV.
  // NOTE: scoring organizes survivors into UNVALIDATED bands — it is not a buy
  // signal and proves no edge. Only reached after liquidity_verified=true.
  private async scoreSurvivor(
    candidate: CollectorResult,
    runId: string,
    liq: LiquidityCheckResult,
    tokenId: string,
    ageDays: number | null,
  ): Promise<ScoreResult> {
    const { token, pool } = candidate;

    const snapshot: ScoreSnapshot = {
      liquidityModel:       liq.liquidityModel,
      onchainTvlUsd:        liq.onchainTvlUsd,
      executableDepthUsd:   liq.executableDepthUsd,
      slip50:               liq.slip50,
      slip100:              liq.slip100,
      slip500:              liq.slip500,
      slip1000:             liq.slip1000,
      reportedVsOnchainPct: liq.reportedVsOnchainPct,
      fdvUsd:               pool.fdvUsd  ?? null,
      ageDays,
      vol5m:                pool.vol5m   ?? null,
      vol1h:                pool.vol1h   ?? null,
      vol6h:                pool.vol6h   ?? null,
      vol24h:               pool.vol24h  ?? null,
      buys1h:               pool.buys1h  ?? null,
      sells1h:              pool.sells1h ?? null,
    };

    const result = this.scoring.score(snapshot);

    this.logger.log(
      `Score: ${pool.chain}:${token.tokenAddress} (${token.symbol ?? '?'}) ` +
      `final=${result.finalScore} band=${result.band} ` +
      `confidence=${result.scoreConfidence} present=[${result.componentsPresent.join(',')}]` +
      `${result.componentsMissing.length ? ` missing=[${result.componentsMissing.join(',')}]` : ''}`,
    );

    await this.storeScore(runId, candidate, tokenId, liq.liquidityModel, result);
    this.logScore(runId, candidate, liq.liquidityModel, result);
    return result;
  }

  private async storeScore(
    runId: string,
    candidate: CollectorResult,
    tokenId: string,
    liquidityModel: string,
    r: ScoreResult,
  ): Promise<void> {
    const { token, pool } = candidate;
    try {
      await this.prisma.scoringHistory.create({
        data: {
          runId,
          chain:             pool.chain,
          tokenId,
          tokenAddress:      token.tokenAddress,
          poolAddress:       pool.poolAddress,
          ts:                new Date(),
          liquidityModel,
          liquidityScore:    r.liquidityScore,
          depthScore:        r.depthScore,
          ageScore:          r.ageScore,
          tractionScore:     r.tractionScore,
          divergenceScore:   r.divergenceScore,
          finalScore:        r.finalScore,
          band:              r.band,
          scoreConfidence:   r.scoreConfidence,
          componentsPresent: r.componentsPresent.join(','),
          componentsMissing: r.componentsMissing.join(','),
        },
      });
    } catch (err) {
      this.logger.warn(
        `Scoring DB write failed (${pool.chain}:${token.tokenAddress}): ${(err as Error).message}`,
      );
    }
  }

  private logScore(
    runId: string,
    candidate: CollectorResult,
    liquidityModel: string,
    r: ScoreResult,
  ): void {
    const { token, pool } = candidate;
    const num = (n: number | null): string => (n != null ? n.toFixed(2) : '');
    this.fileLogger.logScoringHistory({
      ts:                 new Date().toISOString(),
      run_id:             runId,
      schema_version:     CSV_SCHEMA_VERSION,
      chain:              pool.chain,
      token_address:      token.tokenAddress,
      pool_address:       pool.poolAddress,
      liquidity_model:    liquidityModel,
      liquidity_score:    num(r.liquidityScore),
      depth_score:        num(r.depthScore),
      age_score:          num(r.ageScore),
      traction_score:     num(r.tractionScore),
      divergence_score:   num(r.divergenceScore),
      final_score:        r.finalScore.toFixed(2),
      band:               r.band,
      score_confidence:   r.scoreConfidence.toFixed(3),
      components_present: r.componentsPresent.join(';'),
      components_missing: r.componentsMissing.join(';'),
    });
  }
}
