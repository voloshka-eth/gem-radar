import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { FileLoggerService } from '../file-logger/file-logger.service';
import { CSV_SCHEMA_VERSION } from '../file-logger/csv-schemas';
import { GeckoTerminalService } from './geckoterminal/geckoterminal.service';
import { DexScreenerService } from './dexscreener/dexscreener.service';
import { CollectorResult, SupportedChain, TokenProbe } from './collector.types';
import { MoralisService } from './moralis/moralis.service';
import { BirdeyeService } from './birdeye/birdeye.service';
import { applyStage0Gate, filterDuplicates, Stage0Config, Stage0Result } from './stage0-gate';
import { RiskEngineService } from '../risk-engine/risk-engine.service';
import { ContractRiskResult, NormalizedRiskData } from '../risk-engine/risk-engine.types';
import { TokenAgeService } from '../onchain/token-age.service';
import { LiquidityVerificationService } from '../onchain/liquidity-verification.service';
import type { LiquidityCheckResult } from '../onchain/onchain.types';
import { PoolLiquiditySnapshotRow } from '../file-logger/csv-schemas';
import { ScoringService } from '../scoring/scoring.service';
import type { ScoreSnapshot, ScoreResult } from '../scoring/score';
import { PaperService } from '../paper/paper.service';
import {
  DeployerReputationService,
  DeployerReputationSummary,
  DeployerBlocklistHit,
} from '../deployer/deployer-reputation.service';

type CandidateProcessingResult = {
  outcome: 'SAFE' | 'REJECT' | 'QUARANTINE';
  riskResult: ContractRiskResult;
};

type ResearchEvaluation = {
  liq: LiquidityCheckResult;
  ageDays: number | null;
  score: ScoreResult;
};

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
  private readonly autoStart: boolean;
  private readonly pollIntervalMs: number;
  private readonly stage0Config: Stage0Config;
  private readonly tokenMaxAgeDays: number;
  private readonly tokenAgeHardGateEnabled: boolean;
  private readonly promoteCleanUnknownEnabled: boolean;
  private readonly deployerGateEnabled: boolean;
  private readonly manualProbeTokens: TokenProbe[];

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly fileLogger: FileLoggerService,
    private readonly geckoTerminal: GeckoTerminalService,
    private readonly dexScreener: DexScreenerService,
    private readonly moralis: MoralisService,
    private readonly birdeye: BirdeyeService,
    private readonly riskEngine: RiskEngineService,
    private readonly tokenAge: TokenAgeService,
    private readonly liquidityVerifier: LiquidityVerificationService,
    private readonly scoring: ScoringService,
    private readonly paper: PaperService,
    private readonly deployerReputation: DeployerReputationService,
  ) {
    this.enabledChains = (
      this.config.get<string[]>('chain.enabledChains') ?? ['ethereum', 'base']
    ) as SupportedChain[];
    this.autoStart =
      this.config.get<boolean>('collector.autoStart') ?? true;

    this.pollIntervalMs =
      this.config.get<number>('collector.pollIntervalMs') ?? 120_000;

    const maxAgeHours = this.config.get<number>('collector.newPoolMaxAgeHours') ?? 6;
    this.stage0Config = {
      maxPoolAgeMs: maxAgeHours * 60 * 60 * 1000,
      minLiquidityUsd: this.config.get<number>('scoring.minLiquidityUsd') ?? 5_000,
      minFdvUsd: this.config.get<number>('scoring.minFdvUsd') ?? 10_000,
      maxFdvUsd: this.config.get<number>('scoring.maxFdvUsd') ?? 50_000_000,
      moonshotEnabled: this.config.get<boolean>('collector.moonshotStage0Enabled') ?? true,
      moonshotMinLiquidityUsd: this.config.get<number>('collector.moonshotMinLiquidityUsd') ?? 1_000,
      moonshotMinFdvUsd: this.config.get<number>('collector.moonshotMinFdvUsd') ?? 1_000,
      moonshotMinVol1hUsd: this.config.get<number>('collector.moonshotMinVol1hUsd') ?? 1_000,
      moonshotMinTx1h: this.config.get<number>('collector.moonshotMinTx1h') ?? 30,
      moonshotMinBuys1h: this.config.get<number>('collector.moonshotMinBuys1h') ?? 15,
    };
    this.tokenMaxAgeDays = this.config.get<number>('collector.tokenMaxAgeDays') ?? 7;
    this.tokenAgeHardGateEnabled =
      this.config.get<boolean>('collector.tokenAgeHardGateEnabled') ?? false;
    this.promoteCleanUnknownEnabled =
      this.config.get<boolean>('collector.promoteCleanUnknownEnabled') ?? false;
    this.deployerGateEnabled =
      this.config.get<boolean>('collector.deployerGateEnabled') ?? true;
    this.manualProbeTokens =
      (this.config.get<TokenProbe[]>('collector.manualProbeTokens') ?? [])
        .filter((probe): probe is TokenProbe =>
          this.enabledChains.includes(probe.chain) && Boolean(probe.tokenAddress),
        );
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────────────

  onModuleInit(): void {
    if (!this.autoStart) {
      this.logger.log('Collector autostart disabled');
      return;
    }
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
      const gtNewPools = await this.geckoTerminal.getNewPools(chain);
      const gtTrendingPools = await this.geckoTerminal.getTrendingPools(chain);
      const gtNormalized = [...gtNewPools, ...gtTrendingPools];
      const candidates = filterDuplicates(gtNormalized, seenThisCycle);

      this.fileLogger.logRawPayload({
        run_id: runId,
        ts: new Date().toISOString(),
        chain,
        source: 'geckoterminal',
        new_pools_count: gtNewPools.length,
        trending_pools_count: gtTrendingPools.length,
        pool_count: gtNormalized.length,
        deduped_count: candidates.length,
      });
      await this.storeRawPayload(runId, chain, 'geckoterminal', {
        payload_type: 'cycle_summary',
        new_pools_count: gtNewPools.length,
        trending_pools_count: gtTrendingPools.length,
        pool_count: gtNormalized.length,
        deduped_count: candidates.length,
        pool_addresses: candidates.map((c) => c.pool.poolAddress).slice(0, 100),
      });

      for (const candidate of candidates) {
        const tokenKey = `${candidate.pool.chain}:${candidate.token.tokenAddress}`;
        const gate = applyStage0Gate(candidate, this.stage0Config);
        if (this.seenAcrossCycles.has(tokenKey)) {
          skipped++;
          this.logTrajectorySnapshot(candidate, runId, gate, 'seen_across_cycles');
          continue;
        }
        this.logTrajectorySnapshot(candidate, runId, gate, 'candidate');

        total++;
        if (!gate.pass) {
          rejected++;
          this.logRejection(candidate, 'stage0', gate.reason!, runId);
        } else if (await this.shouldRejectForTokenAge(candidate, runId)) {
          rejected++;
        } else {
          if (gate.lane === 'moonshot_probe') this.logMoonshotProbe(candidate);
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
    const dsProfileAddresses = await this.dexScreener.getLatestProfileAddresses(this.enabledChains);
    const dsBoostAddresses = await this.dexScreener.getLatestBoostAddresses(this.enabledChains);
    const dsTopBoostAddresses = await this.dexScreener.getTopBoostAddresses(this.enabledChains);
    const dsCommunityAddresses = await this.dexScreener.getLatestCommunityTakeoverAddresses(this.enabledChains);
    const dsAdAddresses = await this.dexScreener.getLatestAdAddresses(this.enabledChains);
    const moralisTrendingAddresses = await this.moralis.getTrendingTokenAddresses(this.enabledChains);
    const moralisSummary = this.moralis.getLastFetchSummary();
    const birdeyeVolumeAddresses = await this.birdeye.getVolumeTokenAddresses(this.enabledChains);
    const dsAddresses = this.dedupeTokenProbes([
      ...dsProfileAddresses,
      ...dsBoostAddresses,
      ...dsTopBoostAddresses,
      ...dsCommunityAddresses,
      ...dsAdAddresses,
      ...moralisTrendingAddresses,
      ...birdeyeVolumeAddresses,
      ...this.manualProbeTokens,
    ]);
    const dsCandidates = await this.dexScreener.getPairsForTokens(dsAddresses);
    const dsFiltered = filterDuplicates(dsCandidates, seenThisCycle);

    this.fileLogger.logRawPayload({
      run_id: runId,
      ts: new Date().toISOString(),
      source: 'dexscreener',
      profile_addresses: dsProfileAddresses.length,
      boost_addresses: dsBoostAddresses.length,
      top_boost_addresses: dsTopBoostAddresses.length,
      community_takeover_addresses: dsCommunityAddresses.length,
      ad_addresses: dsAdAddresses.length,
      moralis_trending_addresses: moralisTrendingAddresses.length,
      moralis_status: moralisSummary,
      birdeye_volume_addresses: birdeyeVolumeAddresses.length,
      manual_addresses: this.manualProbeTokens.length,
      token_addresses: dsAddresses.length,
      raw_count: dsCandidates.length,
      deduped_count: dsFiltered.length,
    });
    await this.storeRawPayload(runId, 'multi', 'dexscreener', {
      payload_type: 'cycle_summary',
      profile_addresses: dsProfileAddresses.length,
      boost_addresses: dsBoostAddresses.length,
      top_boost_addresses: dsTopBoostAddresses.length,
      community_takeover_addresses: dsCommunityAddresses.length,
      ad_addresses: dsAdAddresses.length,
      moralis_trending_addresses: moralisTrendingAddresses.length,
      moralis_status: moralisSummary,
      birdeye_volume_addresses: birdeyeVolumeAddresses.length,
      manual_addresses: this.manualProbeTokens.length,
      token_addresses_count: dsAddresses.length,
      raw_count: dsCandidates.length,
      deduped_count: dsFiltered.length,
      token_addresses: dsFiltered.map((c) => c.token.tokenAddress).slice(0, 100),
    });

    for (const candidate of dsFiltered) {
      const tokenKey = `${candidate.pool.chain}:${candidate.token.tokenAddress}`;
      const gate = applyStage0Gate(candidate, this.stage0Config);
      if (this.seenAcrossCycles.has(tokenKey)) {
        skipped++;
        this.logTrajectorySnapshot(candidate, runId, gate, 'seen_across_cycles');
        continue;
      }
      this.logTrajectorySnapshot(candidate, runId, gate, 'candidate');

      total++;
      if (!gate.pass) {
        rejected++;
        this.logRejection(candidate, 'stage0', gate.reason!, runId);
      } else if (await this.shouldRejectForTokenAge(candidate, runId)) {
        rejected++;
      } else {
        if (gate.lane === 'moonshot_probe') this.logMoonshotProbe(candidate);
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

    if (riskResult.decision !== 'CONTRACT_REJECT') {
      const deployerReject = await this.checkDeployerReject(candidate);
      if (deployerReject) {
        riskResult = deployerReject.kind === 'blocklist'
          ? this.rejectForBlockedDeployer(riskResult, deployerReject.hit)
          : this.rejectForDeployerReputation(riskResult, deployerReject.summary);
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
      let researchEvaluation: ResearchEvaluation | null = null;
      if (this.shouldLogResearchCandidate(candidate, riskResult)) {
        this.logResearchCandidate(candidate, riskResult, runId);
        researchEvaluation = await this.recordResearchPaperEntry(candidate, riskResult, runId);
        const promoted = await this.tryPromoteCleanUnknownCandidate(
          candidate,
          riskResult,
          runId,
          researchEvaluation,
        );
        if (promoted) {
          return { outcome: 'SAFE', riskResult };
        }
      }
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

  private async recordResearchPaperEntry(
    candidate: CollectorResult,
    riskResult: ContractRiskResult,
    runId: string,
  ): Promise<ResearchEvaluation | null> {
    const { pool, token } = candidate;
    try {
      const liq = await this.liquidityVerifier.verify(pool, token.decimals);
      const ageDays = await this.tokenAge.getTokenAgeDays(pool.chain, token.tokenAddress);
      const score = this.scoreCandidate(candidate, liq, ageDays, 'Research score');

      await this.paper.recordResearchEntry({
        pool,
        token,
        liq,
        score,
        ageDays,
        runId,
        buyTax: riskResult.merged.buyTax,
        riskStatus: riskResult.providerStatus ?? riskResult.merged.providerStatus ?? '',
        researchReason: 'contract_unknown_clean_trade_signals',
      });

      if (liq.liquidityVerified === true && score.band !== 'reject_band') {
        this.logSpeculativeCandidate(candidate, riskResult, runId, liq, ageDays, score);
      }
      return { liq, ageDays, score };
    } catch (err) {
      this.logger.warn(
        `Research paper entry failed for ${pool.chain}:${token.tokenAddress} - ${(err as Error).message}`,
      );
      return null;
    }
  }

  private async tryPromoteCleanUnknownCandidate(
    candidate: CollectorResult,
    riskResult: ContractRiskResult,
    runId: string,
    evaluation: ResearchEvaluation | null,
  ): Promise<boolean> {
    if (!evaluation) return false;
    if (!this.shouldPromoteCleanUnknownCandidate(riskResult, evaluation.liq, evaluation.score)) {
      return false;
    }

    const { pool, token } = candidate;
    const persisted = await this.persistCandidate(candidate, runId, riskResult, evaluation.liq);
    if (!persisted) return false;

    if (persisted.isNewDiscovery) {
      this.logNewPool(candidate, runId, 'CONTRACT_UNKNOWN_PROMOTED_CLEAN_PARTIAL');
    }
    this.logPoolSnapshot(candidate, runId);
    this.logLiquiditySnapshot(candidate, runId, evaluation.liq);
    this.logCandidate(candidate, runId, evaluation.liq, evaluation.ageDays);
    await this.storeScore(runId, candidate, persisted.id, evaluation.liq.liquidityModel, evaluation.score);
    this.logScore(runId, candidate, evaluation.liq.liquidityModel, evaluation.score);
    await this.paper.recordEntry({
      pool,
      token,
      liq: evaluation.liq,
      score: evaluation.score,
      ageDays: evaluation.ageDays,
      tokenId: persisted.id,
      poolId: persisted.poolId,
      runId,
      buyTax: riskResult.merged.buyTax,
    });

    this.logger.log(
      `Promoted clean partial candidate: ${pool.chain}:${token.tokenAddress} (${token.symbol ?? '?'}) ` +
      `risk=${riskResult.providerStatus ?? riskResult.merged.providerStatus ?? 'CONTRACT_UNKNOWN'} ` +
      `score=${evaluation.score.finalScore} band=${evaluation.score.band}`,
    );
    return true;
  }

  private shouldPromoteCleanUnknownCandidate(
    riskResult: ContractRiskResult,
    liq: LiquidityCheckResult,
    score: ScoreResult,
  ): boolean {
    if (!this.promoteCleanUnknownEnabled) return false;
    if (riskResult.decision !== 'CONTRACT_UNKNOWN') return false;
    if (riskResult.rejectReasons.length > 0) return false;
    if (liq.liquidityVerified !== true) return false;
    if (score.band === 'reject_band') return false;

    const status = riskResult.providerStatus ?? riskResult.merged.providerStatus;
    if (status !== 'GOPLUS_PARTIAL' && status !== 'GOPLUS_TRADE_ONLY_PARTIAL') {
      return false;
    }

    const m = riskResult.merged;
    if (m.honeypot !== false && m.canSell !== true) return false;
    if (m.canSell === false) return false;
    if (m.mintRisk === true || m.blacklistRisk === true || m.pauseRisk === true || m.proxyRisk === true) {
      return false;
    }
    if (m.sellTax !== undefined && m.sellTax > 0) return false;
    if (m.buyTax !== undefined && m.buyTax > 0) return false;

    return true;
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
    hit: DeployerReputationSummary,
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

  private rejectForBlockedDeployer(
    riskResult: ContractRiskResult,
    hit: DeployerBlocklistHit,
  ): ContractRiskResult {
    this.logger.warn(
      `Blocked deployer gate: ${hit.address} rejected by ${hit.source} blocklist (${hit.reason})`,
    );
    return {
      ...riskResult,
      decision: 'CONTRACT_REJECT',
      rejectReasons: [...riskResult.rejectReasons, 'deployer_blocklisted'],
      merged: {
        ...riskResult.merged,
        deployerAddress: hit.address,
      },
    };
  }

  private async checkDeployerReject(
    candidate: CollectorResult,
  ): Promise<
    | { kind: 'blocklist'; hit: DeployerBlocklistHit }
    | { kind: 'reputation'; summary: DeployerReputationSummary }
    | null
  > {
    if (!this.deployerGateEnabled) return null;

    const address = candidate.token.deployerAddress?.toLowerCase();
    if (!address) return null;
    const blocklistHit = await this.deployerReputation.findBlocklistHit(
      candidate.token.chain,
      address,
    );
    if (blocklistHit) {
      candidate.token.deployerBlocklisted = true;
      return { kind: 'blocklist', hit: blocklistHit };
    }

    try {
      const summary = await this.deployerReputation.summarize(candidate.token.chain, address);
      if (summary) this.enrichCandidateDeployerReputation(candidate, summary);
      return summary && this.deployerReputation.isRepeatRugger(summary)
        ? { kind: 'reputation', summary }
        : null;
    } catch (err) {
      this.logger.warn(
        `Deployer reputation lookup failed for ${candidate.token.chain}:${address} - ${(err as Error).message}`,
      );
    }

    return null;
  }

  private enrichCandidateDeployerReputation(
    candidate: CollectorResult,
    summary: DeployerReputationSummary,
  ): void {
    candidate.token.deployerDeploymentsCount = summary.deploymentsCount;
    candidate.token.deployerRugLikeCount = summary.rugLikeCount;
    candidate.token.deployerRiskScore = summary.riskScore;
    candidate.token.deployerBlocklisted = false;
  }

  private shouldLogResearchCandidate(
    candidate: CollectorResult,
    riskResult: ContractRiskResult,
  ): boolean {
    if (riskResult.decision !== 'CONTRACT_UNKNOWN') return false;
    if (riskResult.rejectReasons.length > 0) return false;

    const m = riskResult.merged;
    if (m.honeypot === true || m.canSell === false) return false;
    if (
      m.mintRisk === true ||
      m.blacklistRisk === true ||
      m.pauseRisk === true ||
      m.proxyRisk === true
    ) {
      return false;
    }
    if (m.sellTax !== undefined && m.sellTax >= 10) return false;
    if (m.buyTax !== undefined && m.buyTax >= 10) return false;

    const hasCleanTradeSignal =
      m.honeypot === false ||
      m.canSell === true ||
      m.sellTax !== undefined ||
      m.buyTax !== undefined;
    if (!hasCleanTradeSignal) return false;

    return (candidate.pool.liquidityUsd ?? 0) > 0 && (candidate.pool.fdvUsd ?? 0) > 0;
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

  private logMoonshotProbe(candidate: CollectorResult): void {
    const { token, pool } = candidate;
    this.logger.log(
      `Stage0 moonshot probe: ${pool.chain}:${token.tokenAddress} (${token.symbol ?? '?'}) ` +
      `liq=$${pool.liquidityUsd?.toFixed(0) ?? '?'} fdv=$${pool.fdvUsd?.toFixed(0) ?? '?'} ` +
      `vol1h=$${pool.vol1h?.toFixed(0) ?? '?'} buys1h=${pool.buys1h ?? '?'} tx1h=${pool.txCount1h ?? '?'}`,
    );
  }

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
      const persisted = await this.prisma.$transaction(async (tx) => {
      const existingPool = await tx.pool.findUnique({
        where: { chain_poolAddress: { chain: pool.chain, poolAddress: pool.poolAddress } },
        select: { id: true },
      });
      const isNewDiscovery = !existingPool;

      const dbToken = await tx.token.upsert({
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

      const dbPool = await tx.pool.upsert({
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

      await tx.poolSnapshot.create({
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
        const r = riskResult;
        await tx.contractRiskCheck.create({
          data: {
            runId,
            chain: pool.chain,
            tokenAddress: token.tokenAddress,
            tokenId: dbToken.id,
            ts: now,
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
      }

      return { dbToken, dbPool, isNewDiscovery };
      });

      return { id: persisted.dbToken.id, poolId: persisted.dbPool.id, isNewDiscovery: persisted.isNewDiscovery };
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

  private dedupeTokenProbes(probes: TokenProbe[]): TokenProbe[] {
    const seen = new Set<string>();
    const out: TokenProbe[] = [];
    for (const probe of probes) {
      const tokenAddress = probe.tokenAddress?.toLowerCase();
      if (!tokenAddress) continue;
      const key = `${probe.chain}:${tokenAddress}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ chain: probe.chain, tokenAddress });
    }
    return out;
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

  private logTrajectorySnapshot(
    candidate: CollectorResult,
    runId: string,
    gate: Stage0Result,
    processingStatus: 'candidate' | 'seen_across_cycles',
  ): void {
    const { token, pool } = candidate;
    const now = new Date();
    const poolAgeMinutes =
      pool.poolCreatedAt !== undefined
        ? Math.round((now.getTime() - pool.poolCreatedAt.getTime()) / 60_000)
        : undefined;

    this.fileLogger.logTrajectorySnapshot({
      ts: now.toISOString(),
      run_id: runId,
      schema_version: CSV_SCHEMA_VERSION,
      chain: pool.chain,
      token_address: token.tokenAddress,
      token_symbol: token.symbol ?? '',
      token_name: token.name ?? '',
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
      source: pool.source,
      stage0_pass: String(gate.pass),
      stage0_reason: gate.reason ?? '',
      stage0_lane: gate.lane ?? '',
      processing_status: processingStatus,
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
  private logResearchCandidate(
    candidate: CollectorResult,
    riskResult: ContractRiskResult,
    runId: string,
  ): void {
    const { token, pool } = candidate;
    const m = riskResult.merged;
    this.fileLogger.logResearchCandidate({
      ts: new Date().toISOString(),
      run_id: runId,
      schema_version: CSV_SCHEMA_VERSION,
      chain: pool.chain,
      token_address: token.tokenAddress,
      token_symbol: token.symbol ?? '',
      token_name: token.name ?? '',
      pool_address: pool.poolAddress,
      dex: pool.dex,
      source: pool.source,
      status: 'WATCH_ONLY',
      reason: 'contract_unknown_clean_trade_signals',
      risk_status: riskResult.providerStatus ?? m.providerStatus ?? '',
      honeypot: m.honeypot?.toString() ?? '',
      buy_tax: m.buyTax?.toFixed(2) ?? '',
      sell_tax: m.sellTax?.toFixed(2) ?? '',
      liquidity_usd: pool.liquidityUsd?.toString() ?? '',
      fdv_usd: pool.fdvUsd?.toString() ?? '',
      vol_1h: pool.vol1h?.toString() ?? '',
      buys_1h: pool.buys1h?.toString() ?? '',
      sells_1h: pool.sells1h?.toString() ?? '',
      tx_count_1h: pool.txCount1h?.toString() ?? '',
    });
  }

  private logSpeculativeCandidate(
    candidate: CollectorResult,
    riskResult: ContractRiskResult,
    runId: string,
    liq: LiquidityCheckResult,
    ageDays: number | null,
    score: ScoreResult,
  ): void {
    const { token, pool } = candidate;
    const m = riskResult.merged;
    this.fileLogger.logSpeculativeCandidate({
      ts: new Date().toISOString(),
      run_id: runId,
      schema_version: CSV_SCHEMA_VERSION,
      cohort: 'CONTRACT_UNKNOWN_LIQUIDITY_VERIFIED',
      chain: pool.chain,
      token_address: token.tokenAddress,
      symbol: token.symbol ?? '',
      name: token.name ?? '',
      pool_address: pool.poolAddress,
      dex: pool.dex,
      source: pool.source,
      risk_decision: riskResult.decision,
      risk_status: riskResult.providerStatus ?? m.providerStatus ?? '',
      research_reason: 'contract_unknown_clean_trade_signals',
      liquidity_model: liq.liquidityModel,
      liquidity_verified: String(liq.liquidityVerified),
      onchain_tvl_usd: liq.onchainTvlUsd?.toFixed(2) ?? '',
      slip_100: liq.slip100?.toFixed(6) ?? '',
      slip_1000: liq.slip1000?.toFixed(6) ?? '',
      fdv_usd: pool.fdvUsd?.toFixed(0) ?? '',
      age_days: ageDays != null ? ageDays.toFixed(2) : '',
      final_score: score.finalScore.toFixed(2),
      band: score.band,
      score_confidence: score.scoreConfidence.toFixed(3),
      honeypot: m.honeypot?.toString() ?? '',
      buy_tax: m.buyTax?.toFixed(2) ?? '',
      sell_tax: m.sellTax?.toFixed(2) ?? '',
    });
  }

  private async shouldRejectForTokenAge(candidate: CollectorResult, runId: string): Promise<boolean> {
    if (!this.tokenAgeHardGateEnabled) return false;

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
    const result = this.scoreCandidate(candidate, liq, ageDays, 'Score');
    await this.storeScore(runId, candidate, tokenId, liq.liquidityModel, result);
    this.logScore(runId, candidate, liq.liquidityModel, result);
    return result;
  }

  private scoreCandidate(
    candidate: CollectorResult,
    liq: LiquidityCheckResult,
    ageDays: number | null,
    label: string,
  ): ScoreResult {
    const { token, pool } = candidate;
    const result = this.scoring.score(this.buildScoreSnapshot(candidate, liq, ageDays));

    this.logger.log(
      `${label}: ${pool.chain}:${token.tokenAddress} (${token.symbol ?? '?'}) ` +
      `final=${result.finalScore} band=${result.band} ` +
      `confidence=${result.scoreConfidence} present=[${result.componentsPresent.join(',')}]` +
      `${result.componentsMissing.length ? ` missing=[${result.componentsMissing.join(',')}]` : ''}`,
    );
    return result;
  }

  private buildScoreSnapshot(
    candidate: CollectorResult,
    liq: LiquidityCheckResult,
    ageDays: number | null,
  ): ScoreSnapshot {
    const { pool, token } = candidate;
    return {
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
      deployerDeploymentsCount: token.deployerDeploymentsCount ?? null,
      deployerRugLikeCount: token.deployerRugLikeCount ?? null,
      deployerRiskScore: token.deployerRiskScore ?? null,
      deployerBlocklisted: token.deployerBlocklisted ?? null,
    };
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
      deployer_reputation_score: num(r.deployerReputationScore),
      final_score:        r.finalScore.toFixed(2),
      band:               r.band,
      score_confidence:   r.scoreConfidence.toFixed(3),
      components_present: r.componentsPresent.join(';'),
      components_missing: r.componentsMissing.join(';'),
    });
  }
}
