import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import {
  parseAbiItem,
  type Address,
  type Hash,
  type PublicClient,
} from 'viem';
import type { CollectorResult, SupportedChain } from '../collector/collector.types';
import { PrismaService } from '../database/prisma.service';
import { DeployerReputationService } from '../deployer/deployer-reputation.service';
import { FactoryPoolDiscoveryService } from '../onchain/factory-pool-discovery.service';
import { LiquidityVerificationService } from '../onchain/liquidity-verification.service';
import { QUOTE_ASSET_DECIMALS, VIEM_CLIENTS, VIEM_STREAM_CLIENTS } from '../onchain/onchain.constants';
import { PriceService } from '../onchain/price.service';
import { TokenMetadataService } from '../onchain/token-metadata.service';
import { GasModelService } from '../onchain/gas-model.service';
import { DexResolverService } from '../onchain/dex-resolver.service';
import type { LiquidityCheckResult } from '../onchain/onchain.types';
import { PaperService } from '../paper/paper.service';
import { EvalService } from '../paper/eval.service';
import { modelEntry, modelExit, slipForSize } from '../paper/fills';
import { RiskEngineService } from '../risk-engine/risk-engine.service';
import type { ContractRiskResult } from '../risk-engine/risk-engine.types';
import { computeFlowSnapshot, evaluateFlowStrategy, strategiesFor } from './flow-strategy';
import { classifyFlowRisk, contractHardRiskReason } from './flow-risk';
import {
  decodeFlowSwap,
  isPlausibleFlowQuoteAmount,
  poolQuoteIndex,
  type FlowSwapModel,
} from './swap-decoder';
import {
  blockIsAfterHead,
  clampRegistrationStartBlock,
  isSignalWindowOpen,
  signalStatusConsumesTrigger,
} from './flow-state';
import { adaptiveBatchRead } from './rpc-batching';
import type {
  FlowSnapshot,
  FlowStrategyDefinition,
  FlowTrade,
  FlowWatchType,
  PersistedCandidate,
} from './flow.types';
import { RobinhoodEntryExperimentService } from './robinhood-entry-experiment.service';

const FLOW_CHAINS = ['ethereum', 'base', 'robinhood'] as const;
type FlowChain = typeof FLOW_CHAINS[number];

const V2_SWAP = parseAbiItem(
  'event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)',
);
const V3_SWAP = parseAbiItem(
  'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)',
);
const V4_SWAP = parseAbiItem(
  'event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)',
);
const DECIMALS_ABI = [{
  type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }],
}] as const;
type FlowModel = FlowSwapModel;

interface WatchState {
  id: string;
  candidate: CollectorResult;
  watchType: FlowWatchType;
  model: FlowModel;
  discoveredAtMs: number;
  expiresAtMs: number;
  outcomeDueAtMs: number;
  swapTrackingUntilMs: number;
  lastProcessedBlock: bigint;
  lastProcessedBlockHash: string | null;
  trades: FlowTrade[];
  triggered: Set<string>;
  gemDecimals: number;
  poolToken0Address: string;
  poolToken1Address: string;
  flowCreatorAddress: string | null;
  creatorAttributable: boolean;
  coverageComplete: boolean;
  latestSwapAtMs: number | null;
  pendingBackfill: boolean;
  firstPriceUsd: number | null;
  maxPriceUsd: number | null;
  executableNetMaxMultiple: number | null;
  benchmarkTokensBought: number | null;
  benchmarkEntryEffectiveUsd: number | null;
  benchmarkEntryGasUsd: number | null;
  timeTo2xSec: number | null;
  maxDrawdown: number | null;
  lastOutcomeQuoteAtMs: number;
}

interface RawSwapLog {
  address: string;
  args?: Record<string, unknown>;
  blockNumber?: bigint;
  blockHash?: string;
  transactionHash?: string;
  logIndex?: number;
}

interface SwapReadResult {
  logs: RawSwapLog[];
  coveredToByWatchId: Map<string, bigint>;
  failedWatchIds: Set<string>;
  totalShards: number;
  failedShards: number;
}

interface DecodeTradeResult {
  trades: FlowTrade[];
  failedBlocks: Set<string>;
}

@Injectable()
export class EvmFlowService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EvmFlowService.name);
  private readonly watches = new Map<string, WatchState>();
  private readonly unwatch: Array<() => void> = [];
  private factoryTimer: ReturnType<typeof setInterval> | null = null;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private factoryBusy = false;
  private healthBusy = false;
  private evalBusy = false;
  private readonly latestHead = new Map<SupportedChain, bigint>();
  private readonly latestHttpHead = new Map<SupportedChain, bigint>();
  private readonly lastHttpHeadCheckAt = new Map<SupportedChain, number>();
  private readonly rpcFailures = new Map<SupportedChain, number>();
  private readonly headPollBusy = new Set<SupportedChain>();
  private readonly headPollBackoffUntil = new Map<SupportedChain, number>();
  private readonly headPollConsecutiveFailures = new Map<SupportedChain, number>();
  private readonly initialHeadRequests = new Map<FlowChain, Promise<bigint>>();
  private readonly processingHeads = new Set<SupportedChain>();
  private readonly pendingHeads = new Map<SupportedChain, { number: bigint; hash: string | null }>();
  private readonly latestHeadHash = new Map<SupportedChain, string>();
  private readonly swapCount = new Map<SupportedChain, number>();
  private readonly invalidSwapCount = new Map<SupportedChain, number>();
  private readonly signalCount = new Map<SupportedChain, number>();
  private readonly addressBatchSizes = new Map<string, number>();
  private readonly readStats = new Map<SupportedChain, { totalShards: number; failedShards: number; coverageRatio: number }>();

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly factoryDiscovery: FactoryPoolDiscoveryService,
    private readonly liquidity: LiquidityVerificationService,
    private readonly metadata: TokenMetadataService,
    private readonly prices: PriceService,
    private readonly riskEngine: RiskEngineService,
    private readonly deployers: DeployerReputationService,
    private readonly paper: PaperService,
    private readonly evaluator: EvalService,
    private readonly gasModel: GasModelService,
    private readonly dexResolver: DexResolverService,
    private readonly robinhoodExperiment: RobinhoodEntryExperimentService,
    @Inject(VIEM_CLIENTS) private readonly clients: Map<SupportedChain, PublicClient>,
    @Inject(VIEM_STREAM_CLIENTS) private readonly streamClients: Map<SupportedChain, PublicClient>,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!(this.config.get<boolean>('evmFlow.enabled') ?? true)) {
      this.logger.log('EVM flow watcher disabled');
      return;
    }
    const activeChains = this.flowChains();
    await this.restoreWatches(activeChains);
    for (const chain of activeChains) this.startHeadWatcher(chain);
    const factoryPollMs = Math.max(1_000, this.config.get<number>('evmFlow.factoryPollMs') ?? 3_000);
    this.factoryTimer = setInterval(() => void this.runFactoryTick(), factoryPollMs);
    this.healthTimer = setInterval(
      () => void this.runHealthTick(),
      Math.max(5_000, this.config.get<number>('evmFlow.healthLogMs') ?? 30_000),
    );
    void this.runFactoryTick();
    this.logger.log(
      `EVM flow watcher started: factory=${factoryPollMs}ms strategies=${strategiesFor('FRESH').length + strategiesFor('MATURE').length} ` +
      `streams=${activeChains.map((chain) => `${chain}:${this.streamMode(chain)}`).join(',')} paper-only`,
    );
  }

  onModuleDestroy(): void {
    if (this.factoryTimer) clearInterval(this.factoryTimer);
    if (this.healthTimer) clearInterval(this.healthTimer);
    for (const stop of this.unwatch) stop();
  }

  async registerMatureCandidate(candidate: CollectorResult): Promise<void> {
    await this.registerCollectorCandidate(candidate);
  }

  async registerCollectorCandidate(candidate: CollectorResult): Promise<void> {
    if (!(this.config.get<boolean>('evmFlow.enabled') ?? true)) return;
    if (!this.flowChains().includes(candidate.pool.chain as FlowChain)) return;
    const created = candidate.pool.poolCreatedAt?.getTime();
    if (created == null) return;
    const ageMs = Date.now() - created;
    if (candidate.pool.chain === 'robinhood') {
      if (ageMs <= 5 * 60_000) await this.register(candidate, 'FRESH');
      else if (ageMs > 6 * 3_600_000) await this.register(candidate, 'MATURE');
      return;
    }
    if (ageMs <= 24 * 3_600_000) return;
    await this.register(candidate, 'MATURE');
  }

  private startHeadWatcher(chain: FlowChain): void {
    const wsUrl = this.config.get<string>(this.wsConfigKey(chain));
    if (!wsUrl) {
      this.startHttpHeadPoller(chain);
      return;
    }
    const client = this.streamClients.get(chain);
    if (!client) return;
    const stop = client.watchBlocks({
      emitOnBegin: true,
      onBlock: (block) => {
        if (block.number == null) return;
        void this.enqueueHead(chain, block.number, block.hash ?? null);
      },
      onError: (error) => {
        this.rpcFailures.set(chain, (this.rpcFailures.get(chain) ?? 0) + 1);
        this.logger.warn(`Flow head stream error ${chain}: ${error.message}`);
      },
    });
    this.unwatch.push(stop);
  }

  private startHttpHeadPoller(chain: FlowChain): void {
    const intervalKey = chain === 'ethereum' ? 'evmFlow.httpPollMsEthereum'
      : chain === 'base' ? 'evmFlow.httpPollMsBase' : 'evmFlow.httpPollMsRobinhood';
    const intervalMs = Math.max(2_000, this.config.get<number>(intervalKey) ?? (chain === 'ethereum' ? 12_000 : 4_000));
    const poll = async () => {
      if (this.headPollBusy.has(chain) || Date.now() < (this.headPollBackoffUntil.get(chain) ?? 0)) return;
      const client = this.clients.get(chain);
      if (!client) return;
      this.headPollBusy.add(chain);
      try {
        const head = await client.getBlockNumber();
        this.latestHttpHead.set(chain, head);
        this.lastHttpHeadCheckAt.set(chain, Date.now());
        this.headPollConsecutiveFailures.set(chain, 0);
        await this.enqueueHead(chain, head, null);
      } catch (error) {
        const failures = (this.headPollConsecutiveFailures.get(chain) ?? 0) + 1;
        this.headPollConsecutiveFailures.set(chain, failures);
        this.rpcFailures.set(chain, (this.rpcFailures.get(chain) ?? 0) + 1);
        const backoffMs = Math.min(60_000, intervalMs * 2 ** Math.min(failures - 1, 4));
        this.headPollBackoffUntil.set(chain, Date.now() + backoffMs);
        this.logger.warn(`Flow HTTP head poll failed ${chain}; backoff=${backoffMs}ms: ${(error as Error).message}`);
      } finally {
        this.headPollBusy.delete(chain);
      }
    };
    const timer = setInterval(() => void poll(), intervalMs);
    this.unwatch.push(() => clearInterval(timer));
    void poll();
  }

  private async pollFactories(): Promise<void> {
    if (this.factoryBusy) return;
    this.factoryBusy = true;
    try {
      for (const chain of (['ethereum', 'base'] as const).filter((item) => this.flowChains().includes(item))) {
        const candidates = await this.factoryDiscovery.getPendingPools(chain);
        for (const candidate of candidates) {
          const registered = await this.register(candidate, 'FRESH');
          if (registered) this.factoryDiscovery.markHandled(candidate);
        }
      }
    } finally {
      this.factoryBusy = false;
    }
  }

  private async runFactoryTick(): Promise<void> {
    try {
      await this.pollFactories();
    } catch (error) {
      this.logger.warn(`Flow factory tick failed: ${(error as Error).message}`);
    }
  }

  private async runHealthTick(): Promise<void> {
    if (this.healthBusy) return;
    this.healthBusy = true;
    try {
      await this.logHealth();
    } catch (error) {
      const prismaCode = (error as { code?: string }).code;
      const suffix = prismaCode ? ` (${prismaCode})` : '';
      this.logger.warn(`Flow health tick failed${suffix}: ${(error as Error).message}`);
    } finally {
      this.healthBusy = false;
    }
  }

  private async register(candidate: CollectorResult, watchType: FlowWatchType): Promise<boolean> {
    try {
      return await this.registerUnsafe(candidate, watchType);
    } catch (error) {
      const chain = candidate.pool.chain as FlowChain;
      this.rpcFailures.set(chain, (this.rpcFailures.get(chain) ?? 0) + 1);
      this.logger.warn(
        `Flow watch registration deferred ${candidate.pool.chain}:${candidate.pool.poolAddress}: ${(error as Error).message}`,
      );
      return false;
    }
  }

  private async registerUnsafe(candidate: CollectorResult, watchType: FlowWatchType): Promise<boolean> {
    const key = this.key(candidate.pool.chain, candidate.pool.poolAddress, watchType);
    if (this.watches.has(key)) return true;
    const model = await this.resolveModel(candidate);
    if (!model) return false;
    const client = this.clients.get(candidate.pool.chain);
    if (!client) return false;

    const now = Date.now();
    const discoveredAtMs = watchType === 'FRESH'
      ? candidate.pool.poolCreatedAt?.getTime() ?? now
      : now;
    const watchMs = watchType === 'FRESH'
      ? this.config.get<number>('evmFlow.freshWatchMs') ?? 300_000
      : this.config.get<number>('evmFlow.matureWatchMs') ?? 900_000;
    const outcomeTrackMs = this.config.get<number>('evmFlow.outcomeTrackMs') ?? 86_400_000;
    const head = await this.registrationHead(candidate.pool.chain as FlowChain, client);
    const backfillKey = candidate.pool.chain === 'ethereum' ? 'evmFlow.matureBackfillBlocksEthereum'
      : candidate.pool.chain === 'base' ? 'evmFlow.matureBackfillBlocksBase' : 'evmFlow.matureBackfillBlocksRobinhood';
    const backfill = watchType === 'MATURE'
      ? BigInt(this.config.get<number>(backfillKey) ?? (candidate.pool.chain === 'ethereum' ? 25 : 150))
      : 0n;
    const creationBlock = this.bigintOrNull(candidate.pool.creationBlockNumber);
    const requestedStartBlock = creationBlock != null
      ? creationBlock > 0n ? creationBlock - 1n : 0n
      : head > backfill ? head - backfill : 0n;
    const startBlock = clampRegistrationStartBlock(
      requestedStartBlock,
      head,
      this.registrationMaxBackfill(candidate.pool.chain as FlowChain),
    );
    if (startBlock !== requestedStartBlock) {
      this.logger.warn(
        `Flow registration clamped stale cursor ${candidate.pool.chain}:${candidate.pool.poolAddress} ` +
        `${requestedStartBlock}->${startBlock} head=${head}`,
      );
    }

    const [tokenMetadata, gemDecimals] = await Promise.all([
      this.metadata.read(candidate.pool.chain, candidate.token.tokenAddress),
      this.readDecimals(client, candidate.token.tokenAddress),
    ]);
    const poolCurrencies = model === 'V4' && candidate.pool.v4Metadata?.currency0 && candidate.pool.v4Metadata?.currency1
      ? {
        token0: candidate.pool.v4Metadata.currency0.toLowerCase(),
        token1: candidate.pool.v4Metadata.currency1.toLowerCase(),
      }
      : this.sortedCurrencies(candidate.pool.token0Address, candidate.pool.token1Address);
    candidate.token.symbol ||= tokenMetadata.symbol;
    candidate.token.name ||= tokenMetadata.name;
    candidate.token.decimals = gemDecimals;
    const flowCreatorAddress = candidate.token.deployerAddress ?? await this.poolCreator(client, candidate.pool.creationTxHash);

    const stored = await (this.prisma as any).evmPoolWatch.upsert({
      where: { chain_poolAddress_watchType: {
        chain: candidate.pool.chain, poolAddress: candidate.pool.poolAddress, watchType,
      } },
      create: {
        chain: candidate.pool.chain,
        tokenAddress: candidate.token.tokenAddress,
        poolAddress: candidate.pool.poolAddress,
        dex: candidate.pool.dex,
        liquidityModel: model,
        watchType,
        source: candidate.pool.source,
        status: 'WATCHING',
        discoveredAt: new Date(discoveredAtMs),
        expiresAt: new Date(discoveredAtMs + watchMs),
        outcomeDueAt: new Date(discoveredAtMs + outcomeTrackMs),
        creationBlock: candidate.pool.creationBlockNumber ?? null,
        creationTxHash: candidate.pool.creationTxHash ?? null,
        creationLogIndex: candidate.pool.creationLogIndex ?? null,
        creatorAddress: flowCreatorAddress,
        lastProcessedBlock: startBlock.toString(),
        candidateJson: this.serializeCandidate(candidate) as unknown as Prisma.InputJsonValue,
      },
      update: {
        candidateJson: this.serializeCandidate(candidate) as unknown as Prisma.InputJsonValue,
        status: 'WATCHING',
        creatorAddress: flowCreatorAddress,
        discoveredAt: new Date(discoveredAtMs),
        expiresAt: new Date(discoveredAtMs + watchMs),
        outcomeDueAt: new Date(discoveredAtMs + outcomeTrackMs),
      },
    });
    const persistedCursor = this.bigintOrNull(stored.lastProcessedBlock) ?? startBlock;
    const liveCursor = clampRegistrationStartBlock(
      persistedCursor > startBlock ? persistedCursor : startBlock,
      head,
      this.registrationMaxBackfill(candidate.pool.chain as FlowChain),
    );
    if (liveCursor !== persistedCursor) {
      await (this.prisma as any).evmPoolWatch.update({
        where: { id: stored.id },
        data: { lastProcessedBlock: liveCursor.toString(), lastProcessedBlockHash: null },
      });
    }
    const state: WatchState = {
      id: stored.id,
      candidate,
      watchType,
      model,
      discoveredAtMs,
      expiresAtMs: discoveredAtMs + watchMs,
      outcomeDueAtMs: discoveredAtMs + outcomeTrackMs,
      swapTrackingUntilMs: discoveredAtMs + watchMs,
      lastProcessedBlock: liveCursor,
      lastProcessedBlockHash: liveCursor === persistedCursor ? stored.lastProcessedBlockHash ?? null : null,
      trades: [],
      triggered: new Set<string>(),
      gemDecimals,
      poolToken0Address: poolCurrencies.token0,
      poolToken1Address: poolCurrencies.token1,
      flowCreatorAddress,
      creatorAttributable: flowCreatorAddress != null && await this.isEoa(client, flowCreatorAddress),
      coverageComplete: false,
      latestSwapAtMs: null,
      pendingBackfill: false,
      firstPriceUsd: this.numberOrNull(stored.firstPriceUsd),
      maxPriceUsd: this.restoreMaxPrice(stored.firstPriceUsd, stored.spotMaxMultiple),
      executableNetMaxMultiple: this.numberOrNull(stored.executableNetMaxMultiple),
      benchmarkTokensBought: this.numberOrNull(stored.benchmarkTokensBought),
      benchmarkEntryEffectiveUsd: this.numberOrNull(stored.benchmarkEntryEffectiveUsd),
      benchmarkEntryGasUsd: this.numberOrNull(stored.benchmarkEntryGasUsd),
      timeTo2xSec: stored.timeTo2xSec ?? null,
      maxDrawdown: this.numberOrNull(stored.maxDrawdown),
      lastOutcomeQuoteAtMs: 0,
    };
    const previousSignals = await (this.prisma as any).strategySignal.findMany({
      where: { watchId: state.id }, select: { strategyVersion: true, status: true },
    });
    for (const signal of previousSignals) {
      if (this.isTerminalSignalStatus(signal.status)) state.triggered.add(signal.strategyVersion);
    }
    this.watches.set(key, state);
    this.logger.log(
      `Flow watch ${watchType.toLowerCase()}: ${candidate.pool.chain}:${candidate.token.tokenAddress} ` +
      `pool=${candidate.pool.poolAddress} model=${model} from=${state.lastProcessedBlock + 1n}`,
    );
    if (head > state.lastProcessedBlock) void this.enqueueHead(candidate.pool.chain as FlowChain, head, null);
    return true;
  }

  private async enqueueHead(chain: FlowChain, head: bigint, hash: string | null): Promise<void> {
    const pending = this.pendingHeads.get(chain);
    if (!pending || head >= pending.number) this.pendingHeads.set(chain, { number: head, hash });
    if (this.processingHeads.has(chain)) return;
    this.processingHeads.add(chain);
    try {
      while (this.pendingHeads.has(chain)) {
        const next = this.pendingHeads.get(chain)!;
        this.pendingHeads.delete(chain);
        await this.processHead(chain, next.number, next.hash);
      }
    } finally {
      this.processingHeads.delete(chain);
    }
  }

  private async processHead(chain: FlowChain, head: bigint, headHash: string | null): Promise<void> {
    const previousHead = this.latestHead.get(chain);
    const previousHash = this.latestHeadHash.get(chain);
    if (previousHead != null && (head < previousHead || head === previousHead && headHash != null && previousHash != null && headHash !== previousHash)) {
      await this.invalidateReorg(chain, head);
    }
    this.latestHead.set(chain, head);
    if (headHash) this.latestHeadHash.set(chain, headHash);
    const client = this.clients.get(chain);
    if (!client) return;
    try {
      const hasWs = this.streamMode(chain) === 'wss';
      let httpHead = head;
      if (hasWs && Date.now() - (this.lastHttpHeadCheckAt.get(chain) ?? 0) >= 5_000) {
        httpHead = await client.getBlockNumber();
        this.lastHttpHeadCheckAt.set(chain, Date.now());
      } else if (hasWs) {
        const cached = this.latestHttpHead.get(chain);
        if (cached != null && cached > httpHead) httpHead = cached;
      }
      this.latestHttpHead.set(chain, httpHead);
      const now = Date.now();
      const states = [...this.watches.values()].filter(
        (state) => state.candidate.pool.chain === chain && state.outcomeDueAtMs > now &&
          state.lastProcessedBlock < head &&
          (state.swapTrackingUntilMs > now || now - state.lastOutcomeQuoteAtMs >= 30_000),
      );
      if (!states.length) return;
      const swapStates = states.filter((state) => state.swapTrackingUntilMs > now);
      const read = await this.readSwapLogs(client, chain, swapStates, head);
      const decoded = await this.decodeTrades(client, swapStates, read.logs);
      for (const failedBlock of decoded.failedBlocks) {
        for (const log of read.logs.filter((item) => item.blockNumber?.toString() === failedBlock)) {
          const state = this.stateForLog(swapStates, log);
          if (!state) continue;
          read.failedWatchIds.add(state.id);
          const rewindTo = BigInt(failedBlock) > 0n ? BigInt(failedBlock) - 1n : 0n;
          const covered = read.coveredToByWatchId.get(state.id);
          if (covered != null && covered > rewindTo) read.coveredToByWatchId.set(state.id, rewindTo);
          await this.persistBackfill(state, BigInt(failedBlock), covered ?? BigInt(failedBlock), 'block_transaction_read_failed');
        }
      }
      if (decoded.failedBlocks.size > 0) {
        read.failedShards += decoded.failedBlocks.size;
        read.totalShards += decoded.failedBlocks.size;
      }
      this.readStats.set(chain, {
        totalShards: read.totalShards,
        failedShards: read.failedShards,
        coverageRatio: read.totalShards > 0 ? (read.totalShards - read.failedShards) / read.totalShards : 1,
      });
      const trades = decoded.trades;
      for (const trade of trades) {
        const state = states.find((item) => this.matchesTrade(item, trade));
        if (!state || BigInt(trade.blockNumber) <= state.lastProcessedBlock) continue;
        state.trades.push(trade);
        this.pruneTrades(state, trade.occurredAtMs);
        this.updateSpotOutcome(state, trade);
      }
      if (trades.length) {
        this.swapCount.set(chain, (this.swapCount.get(chain) ?? 0) + trades.length);
        await (this.prisma as any).evmSwapObservation.createMany({
          data: trades.map((trade) => ({
            watchId: states.find((state) => this.matchesTrade(state, trade))!.id,
            chain: trade.chain, poolAddress: trade.poolAddress, blockNumber: trade.blockNumber,
            blockHash: trade.blockHash, txHash: trade.txHash, logIndex: trade.logIndex,
            ts: new Date(trade.occurredAtMs), trader: trade.trader, kind: trade.kind,
            quoteAmountUsd: trade.quoteAmountUsd, tokenAmount: trade.tokenAmount, priceUsd: trade.priceUsd,
          })),
          skipDuplicates: true,
        });
      }
      for (const state of states) {
        const coveredTo = read.coveredToByWatchId.get(state.id);
        if (coveredTo != null && coveredTo > state.lastProcessedBlock) {
          state.lastProcessedBlock = coveredTo;
          state.lastProcessedBlockHash = coveredTo === head ? headHash : null;
        }
        state.coverageComplete = state.swapTrackingUntilMs <= now ||
          (!read.failedWatchIds.has(state.id) && state.lastProcessedBlock >= head);
        state.latestSwapAtMs = state.trades.at(-1)?.occurredAtMs ?? state.latestSwapAtMs;
        if (chain === 'robinhood') {
          const lag = httpHead > state.lastProcessedBlock ? Number(httpHead - state.lastProcessedBlock) : 0;
          const latestSwapAgeMs = state.latestSwapAtMs == null ? Number.POSITIVE_INFINITY : now - state.latestSwapAtMs;
          const dataHealthy = lag <= (this.config.get<number>('evmFlow.maxHeadLagBlocks') ?? 2) &&
            state.coverageComplete && !state.pendingBackfill &&
            latestSwapAgeMs <= (this.config.get<number>('evmFlow.maxLatestSwapAgeMs') ?? 15_000);
          const pipelineHealthy = state.swapTrackingUntilMs <= now || (
            lag <= (this.config.get<number>('evmFlow.maxHeadLagBlocks') ?? 2) &&
            state.coverageComplete && !state.pendingBackfill
          );
          const v2 = strategiesFor(state.watchType, 'robinhood')
            .find((strategy) => strategy.version === 'robinhood_flow_precision_v2');
          const v2ShadowDecision = v2
            ? evaluateFlowStrategy(v2, state.trades, now, state.discoveredAtMs, state.flowCreatorAddress)
            : null;
          const experimentTrackingUntilMs = await this.robinhoodExperiment.handleTick({
            watchId: state.id,
            candidate: state.candidate,
            watchType: state.watchType,
            liquidityModel: state.model,
            trades: state.trades,
            discoveredAtMs: state.discoveredAtMs,
            latestBlock: state.lastProcessedBlock,
            observedAtMs: now,
            gemDecimals: state.gemDecimals,
            creatorAddress: state.flowCreatorAddress,
            creatorAttributable: state.creatorAttributable,
            launchPriceUsd: state.firstPriceUsd,
            dataHealthy,
            pipelineHealthy,
            dataHealth: {
              lagBlocks: lag,
              coverageComplete: state.coverageComplete,
              unresolvedBackfill: state.pendingBackfill,
              latestSwapAgeMs: Number.isFinite(latestSwapAgeMs) ? latestSwapAgeMs : null,
              streamMode: this.streamMode(chain),
            },
            v2ShadowDecision,
          });
          if (experimentTrackingUntilMs != null) {
            state.swapTrackingUntilMs = Math.max(state.swapTrackingUntilMs, experimentTrackingUntilMs);
          }
        }
        await this.evaluateStrategies(state, state.lastProcessedBlock, httpHead);
        await this.updateWatchState(state);
      }
      if (trades.length) {
        const pools = [...new Set(trades.map((trade) => trade.poolAddress))];
        void this.eventDrivenEval(chain, pools);
      }
      const continuing = states.some((state) =>
        !read.failedWatchIds.has(state.id) && state.swapTrackingUntilMs > now && state.lastProcessedBlock < head,
      );
      if (continuing) this.pendingHeads.set(chain, { number: head, hash: headHash });
    } catch (error) {
      this.rpcFailures.set(chain, (this.rpcFailures.get(chain) ?? 0) + 1);
      this.logger.warn(`Flow block processing failed ${chain}:${head}: ${(error as Error).message}`);
    }
  }

  private async readSwapLogs(
    client: PublicClient,
    chain: FlowChain,
    states: WatchState[],
    head: bigint,
  ): Promise<SwapReadResult> {
    const results: RawSwapLog[] = [];
    const coveredToByWatchId = new Map<string, bigint>();
    const failedWatchIds = new Set<string>();
    let totalShards = 0;
    let failedShards = 0;
    const v2 = states.filter((state) => state.model === 'V2');
    const v3 = states.filter((state) => state.model === 'V3');
    const v4 = states.filter((state) => state.model === 'V4');

    const readAddressModel = async (
      model: 'V2' | 'V3',
      modelStates: WatchState[],
      event: typeof V2_SWAP | typeof V3_SWAP,
    ): Promise<void> => {
      if (!modelStates.length) return;
      const cacheKey = `${chain}:${model}`;
      const initialSize = this.addressBatchSizes.get(cacheKey) ??
        Math.max(1, this.config.get<number>('evmFlow.initialAddressBatchSize') ?? 32);
      let successfulShards = 0;
      const adaptive = await adaptiveBatchRead(modelStates, initialSize, async (batch) => {
        const fromBlock = batch.reduce(
          (min, state) => state.lastProcessedBlock + 1n < min ? state.lastProcessedBlock + 1n : min,
          head,
        );
        const maxBatchBlocks = chain === 'ethereum' ? 64n : 400n;
        const toBlock = fromBlock + maxBatchBlocks - 1n < head ? fromBlock + maxBatchBlocks - 1n : head;
        const addresses = [...new Set(batch.map((state) => state.candidate.pool.poolAddress.toLowerCase()))] as Address[];
        const logs = await client.getLogs({
          address: addresses.length === 1 ? addresses[0] : addresses,
          event,
          fromBlock,
          toBlock,
        } as any) as unknown as RawSwapLog[];
        successfulShards++;
        for (const state of batch) {
          coveredToByWatchId.set(state.id, toBlock);
          if (state.pendingBackfill) await this.resolveBackfill(state, state.lastProcessedBlock + 1n, toBlock);
        }
        return logs;
      });
      results.push(...adaptive.results);
      totalShards += successfulShards + adaptive.failures.length;
      failedShards += adaptive.failures.length;
      if (adaptive.maxSuccessfulBatch > 0 && adaptive.maxSuccessfulBatch < initialSize) {
        this.addressBatchSizes.set(cacheKey, adaptive.maxSuccessfulBatch);
      }
      for (const failure of adaptive.failures) {
        for (const state of failure.values) {
          failedWatchIds.add(state.id);
          const fromBlock = state.lastProcessedBlock + 1n;
          const maxBatchBlocks = chain === 'ethereum' ? 64n : 400n;
          const toBlock = fromBlock + maxBatchBlocks - 1n < head ? fromBlock + maxBatchBlocks - 1n : head;
          await this.persistBackfill(state, fromBlock, toBlock, failure.error.message);
        }
      }
    };

    await Promise.all([
      readAddressModel('V2', v2, V2_SWAP),
      readAddressModel('V3', v3, V3_SWAP),
    ]);
    if (v4.length) {
      const managerKey = chain === 'ethereum' ? 'onchain.v4PoolManagerEthereum'
        : chain === 'base' ? 'onchain.v4PoolManagerBase' : 'onchain.v4PoolManagerRobinhood';
      const manager = this.config.get<string>(managerKey);
      const fromBlock = v4.reduce(
        (min, state) => state.lastProcessedBlock + 1n < min ? state.lastProcessedBlock + 1n : min,
        head,
      );
      const maxBatchBlocks = chain === 'ethereum' ? 64n : 400n;
      const toBlock = fromBlock + maxBatchBlocks - 1n < head ? fromBlock + maxBatchBlocks - 1n : head;
      totalShards++;
      if (manager) {
        try {
          results.push(...await client.getLogs({
            address: manager as Address, event: V4_SWAP, fromBlock, toBlock,
          } as any) as unknown as RawSwapLog[]);
          for (const state of v4) {
            coveredToByWatchId.set(state.id, toBlock);
            if (state.pendingBackfill) await this.resolveBackfill(state, state.lastProcessedBlock + 1n, toBlock);
          }
        } catch (cause) {
          failedShards++;
          for (const state of v4) {
            failedWatchIds.add(state.id);
            await this.persistBackfill(state, state.lastProcessedBlock + 1n, toBlock, (cause as Error).message);
          }
        }
      } else {
        failedShards++;
        for (const state of v4) failedWatchIds.add(state.id);
      }
    }
    return {
      logs: results.filter((log) => log.blockNumber != null && log.transactionHash != null && log.logIndex != null),
      coveredToByWatchId,
      failedWatchIds,
      totalShards,
      failedShards,
    };
  }

  private async decodeTrades(client: PublicClient, states: WatchState[], logs: RawSwapLog[]): Promise<DecodeTradeResult> {
    const blockNumbers = [...new Set(logs.map((log) => log.blockNumber!.toString()))];
    const blockData = new Map<string, { timestampMs: number; fromByHash: Map<string, string> }>();
    const reads = await Promise.allSettled(blockNumbers.map(async (number) => {
      const block = await client.getBlock({ blockNumber: BigInt(number), includeTransactions: false });
      blockData.set(number, { timestampMs: Number(block.timestamp) * 1000, fromByHash: new Map() });
    }));
    const failedBlocks = new Set<string>();
    reads.forEach((result, index) => {
      if (result.status === 'rejected') failedBlocks.add(blockNumbers[index]);
    });
    const txLogs = [...new Map(
      logs
        .filter((log) => !failedBlocks.has(log.blockNumber!.toString()))
        .map((log) => [log.transactionHash!.toLowerCase(), log]),
    ).entries()];
    const transactionChunkSize = 8;
    for (let offset = 0; offset < txLogs.length; offset += transactionChunkSize) {
      const chunk = txLogs.slice(offset, offset + transactionChunkSize);
      const transactions = await Promise.allSettled(
        chunk.map(([hash]) => client.getTransaction({ hash: hash as `0x${string}` })),
      );
      transactions.forEach((result, index) => {
        const [hash, log] = chunk[index];
        if (result.status === 'rejected') {
          failedBlocks.add(log.blockNumber!.toString());
          return;
        }
        blockData.get(log.blockNumber!.toString())?.fromByHash.set(
          hash,
          result.value.from.toLowerCase(),
        );
      });
    }
    const quotePriceCache = new Map<string, number>();
    const output: FlowTrade[] = [];
    for (const log of logs) {
      if (failedBlocks.has(log.blockNumber!.toString())) continue;
      const state = this.stateForLog(states, log);
      if (!state) continue;
      const block = blockData.get(log.blockNumber!.toString());
      const trader = block?.fromByHash.get(log.transactionHash!.toLowerCase()) ?? '';
      if (!trader) continue;
      const quotePriceKey = `${state.candidate.pool.chain}:${state.candidate.pool.quoteAssetAddress}`;
      let quotePriceUsd = quotePriceCache.get(quotePriceKey);
      if (quotePriceUsd == null) {
        quotePriceUsd = this.isStableQuote(state.candidate.pool.quoteAsset)
          ? 1
          : await this.prices.getUsdPrice(state.candidate.pool.chain, state.candidate.pool.quoteAssetAddress) ?? 0;
        quotePriceCache.set(quotePriceKey, quotePriceUsd);
      }
      if (!(quotePriceUsd > 0)) continue;
      const quoteIndex = this.quoteIndex(state);
      if (quoteIndex == null) continue;
      const decoded = decodeFlowSwap({
        model: state.model,
        quoteIndex,
        quoteDecimals: QUOTE_ASSET_DECIMALS[state.candidate.pool.quoteAsset] ?? 18,
        tokenDecimals: state.gemDecimals,
        quotePriceUsd,
        args: log.args ?? {},
      });
      if (!decoded) continue;
      if (!isPlausibleFlowQuoteAmount(
        decoded.quoteAmountUsd,
        state.candidate.pool.liquidityUsd,
        state.candidate.pool.vol24h,
      )) {
        const chain = state.candidate.pool.chain;
        this.invalidSwapCount.set(chain, (this.invalidSwapCount.get(chain) ?? 0) + 1);
        continue;
      }
      output.push({
        chain: state.candidate.pool.chain,
        poolAddress: state.candidate.pool.poolAddress,
        tokenAddress: state.candidate.token.tokenAddress,
        blockNumber: log.blockNumber!.toString(), blockHash: log.blockHash ?? null,
        txHash: log.transactionHash!.toLowerCase(), logIndex: log.logIndex!,
        occurredAtMs: block?.timestampMs ?? Date.now(), trader, ...decoded,
      });
    }
    return {
      trades: output.sort((a, b) => a.occurredAtMs - b.occurredAtMs || a.logIndex - b.logIndex),
      failedBlocks,
    };
  }

  private async evaluateStrategies(state: WatchState, head: bigint, httpHead: bigint): Promise<void> {
    if (!isSignalWindowOpen(Date.now(), state.expiresAtMs)) return;
    const lag = httpHead > head ? Number(httpHead - head) : 0;
    for (const strategy of strategiesFor(state.watchType, state.candidate.pool.chain)) {
      if (state.triggered.has(strategy.version)) continue;
      const decision = evaluateFlowStrategy(
        strategy, state.trades, Date.now(), state.discoveredAtMs, state.flowCreatorAddress,
      );
      if (!decision.triggered) continue;
      const latestSwapAgeMs = decision.snapshot.latestSwapAtMs == null
        ? Number.POSITIVE_INFINITY
        : Date.now() - decision.snapshot.latestSwapAtMs;
      const health = {
        lagBlocks: lag,
        coverageComplete: state.coverageComplete,
        unresolvedBackfill: state.pendingBackfill,
        latestSwapAgeMs: Number.isFinite(latestSwapAgeMs) ? latestSwapAgeMs : null,
        streamMode: this.streamMode(state.candidate.pool.chain as FlowChain),
      };
      if (
        lag > (this.config.get<number>('evmFlow.maxHeadLagBlocks') ?? 2) ||
        !state.coverageComplete ||
        state.pendingBackfill ||
        latestSwapAgeMs > (this.config.get<number>('evmFlow.maxLatestSwapAgeMs') ?? 15_000)
      ) {
        await this.persistLateSignal(state, strategy.version, head, decision.snapshot, health);
        continue;
      }
      await this.admitSignal(state, strategy, head, decision.snapshot, health);
    }
  }

  private async admitSignal(
    state: WatchState,
    strategy: FlowStrategyDefinition,
    head: bigint,
    snapshot: FlowSnapshot,
    dataHealth: Record<string, unknown>,
  ): Promise<void> {
    const strategyVersion = strategy.version;
    const liq = await this.liquidity.verify(state.candidate.pool, state.gemDecimals);
    const preflight = this.liquidityHardReject(liq, strategy);
    if (preflight) {
      await this.persistPreflightObservation(state, strategyVersion, head, snapshot, liq, preflight, dataHealth);
      this.logger.debug(`Flow trigger waiting ${state.candidate.pool.chain}:${state.candidate.token.tokenAddress} ${strategyVersion}: ${preflight}`);
      return;
    }
    const runId = `flow-${randomUUID()}`;
    const risk = await this.riskEngine.checkToken(
      state.candidate.pool.chain, state.candidate.token.tokenAddress,
      state.candidate.token.symbol, state.candidate.token.name, runId,
    );
    if (risk.merged.deployerAddress) {
      state.candidate.token.deployerAddress = risk.merged.deployerAddress.toLowerCase();
      state.flowCreatorAddress = risk.merged.deployerAddress.toLowerCase();
      const client = this.clients.get(state.candidate.pool.chain);
      state.creatorAttributable = client != null && await this.isEoa(client, state.flowCreatorAddress);
    }
    const admissionSnapshot = computeFlowSnapshot(
      state.trades,
      Date.now(),
      state.discoveredAtMs,
      strategy.windowMs,
      state.flowCreatorAddress,
    );
    const hardRisk = await this.hardRiskReason(state, risk, strategyVersion);
    const riskCohort = this.riskCohort(risk, hardRisk);
    const gasUsd = await this.gasModel.estimateUsd(state.candidate.pool.chain, state.model);
    const sizeUsd = this.config.get<number>('paper.positionSizeUsd') ?? 20;
    const entrySlip = slipForSize(sizeUsd, this.slipLadder(liq, 'entry'));
    const maxEntrySlipPct = strategy.maxEntrySlipPct ?? (this.config.get<number>('evmFlow.maxEntrySlipPct') ?? 0.10);
    const entryFill = modelEntry(liq.spotPriceUsd ?? 0, entrySlip, {
      sizeUsd,
      sandwichPct: this.config.get<number>('paper.sandwichPct') ?? 0.01,
      gasUsd,
      buyTaxPct: this.taxFraction(risk.merged.buyTax),
      maxEntrySlipPct,
    });
    const roundTrip = entryFill.entered && entryFill.tokensBought != null
      ? modelExit(
          entryFill.tokensBought,
          liq.spotPriceUsd ?? 0,
          slipForSize(entryFill.tokensBought * (liq.spotPriceUsd ?? 0), this.slipLadder(liq, 'exit')),
          {
            sandwichPct: this.config.get<number>('paper.sandwichPct') ?? 0.01,
            gasUsd,
            sellTaxPct: this.taxFraction(risk.merged.sellTax),
          },
        ).netUsd / sizeUsd
      : 0;
    const creatorSellThreshold = Math.max(20, admissionSnapshot.buyQuoteUsd * 0.05);
    const creatorSellReject = strategy.rejectCreatorSell &&
      admissionSnapshot.creatorSellQuoteUsd >= creatorSellThreshold;
    const economicReject = creatorSellReject
      ? 'creator_sell_after_attribution'
      : !entryFill.entered
      ? entryFill.reason ?? 'entry_quote_failed'
      : strategy.minRoundTripMultiple != null && roundTrip < strategy.minRoundTripMultiple
        ? `round_trip_${roundTrip.toFixed(4)}_below_${strategy.minRoundTripMultiple.toFixed(2)}`
        : null;
    const entryQuoteSnapshot = {
      positionSizeUsd: sizeUsd,
      spotPriceUsd: liq.spotPriceUsd,
      entrySlipPct: entrySlip,
      exitSlipPct: liq.exitSlip20 ?? liq.slip20 ?? null,
      executableDepthUsd: liq.executableDepthUsd,
      gasUsd,
      buyTaxPct: this.taxFraction(risk.merged.buyTax),
      sellTaxPct: this.taxFraction(risk.merged.sellTax),
      effectiveEntryPriceUsd: entryFill.effectivePriceUsd,
      zeroMoveRoundTripMultiple: roundTrip,
    };
    const signal = await this.createSignal(
      state, strategyVersion, head, admissionSnapshot, risk,
      entryFill.effectivePriceUsd, hardRisk ?? economicReject,
      hardRisk ? 'HARD_REJECT' : economicReject ? 'NOT_ENTERED' : 'OBSERVED',
      dataHealth,
      entryQuoteSnapshot,
    );
    if (hardRisk || economicReject) {
      state.triggered.add(strategyVersion);
      const chain = state.candidate.pool.chain;
      this.signalCount.set(chain, (this.signalCount.get(chain) ?? 0) + 1);
      this.logger.warn(`Flow ${hardRisk ? 'hard reject' : 'not entered'} ${strategyVersion}: ${state.candidate.pool.chain}:${state.candidate.token.tokenAddress} reason=${hardRisk ?? economicReject}`);
      return;
    }
    if (strategyVersion === 'robinhood_flow_precision_v2') {
      await (this.prisma as any).strategySignal.update({
        where: { id: signal.id }, data: { status: 'SHADOW_DIAGNOSTIC' },
      });
      state.triggered.add(strategyVersion);
      const chain = state.candidate.pool.chain;
      this.signalCount.set(chain, (this.signalCount.get(chain) ?? 0) + 1);
      this.logger.log(
        `FLOW SHADOW ${strategyVersion}: ${chain}:${state.candidate.token.tokenAddress} ` +
        `buyers=${admissionSnapshot.uniqueBuyers} buy=$${admissionSnapshot.buyQuoteUsd.toFixed(0)}`,
      );
      return;
    }
    const persisted = await this.persistCandidate(state.candidate, liq, risk, runId);
    if (!persisted) return;
    await this.paper.recordEntry({
      pool: state.candidate.pool,
      token: state.candidate.token,
      liq,
      ageDays: null,
      tokenId: persisted.tokenId,
      poolId: persisted.poolId,
      runId,
      buyTax: risk.merged.buyTax,
      riskCohort,
      strategyVersion,
      signalId: signal.id,
      exitPolicy: riskCohort === 'SOFT_RISK'
        ? 'SOFT_RISK_2X'
        : strategyVersion.endsWith('_v2') ? 'PROTECTED_LADDER_V2' : 'SAFE_LADDER',
      benchmarkEligible: true,
      flowSnapshot: admissionSnapshot as unknown as Record<string, unknown>,
      observedAt: new Date(),
      gasUsd,
      maxEntrySlipPct,
    });
    const position = await this.prisma.paperPosition.findFirst({ where: { signalId: signal.id } as any });
    if (!position) {
      await (this.prisma as any).strategySignal.update({
        where: { id: signal.id }, data: { status: 'ENTRY_RETRY' },
      });
      this.logger.warn(`Flow paper entry missing after signal ${signal.id}; strategy remains retryable`);
      return;
    }
    await (this.prisma as any).strategySignal.update({
      where: { id: signal.id }, data: { status: position.status === 'OPEN' ? 'ENTERED' : 'NOT_ENTERED' },
    });
    state.triggered.add(strategyVersion);
    const chain = state.candidate.pool.chain;
    this.signalCount.set(chain, (this.signalCount.get(chain) ?? 0) + 1);
    this.logger.log(
      `FLOW SIGNAL ${strategyVersion}: ${state.candidate.pool.chain}:${state.candidate.token.tokenAddress} ` +
      `buyers=${admissionSnapshot.uniqueBuyers} buy=$${admissionSnapshot.buyQuoteUsd.toFixed(0)} ratio=${admissionSnapshot.buySellRatio.toFixed(2)} ` +
      `momentum=${admissionSnapshot.priceMomentum?.toFixed(3) ?? '?'} cohort=${riskCohort}`,
    );
  }

  private async createSignal(
    state: WatchState,
    strategyVersion: string,
    head: bigint,
    snapshot: FlowSnapshot,
    risk: ContractRiskResult,
    executableEntryPriceUsd: number | null,
    hardRiskReason: string | null,
    status: string,
    dataHealth: Record<string, unknown>,
    entryQuoteSnapshot: Record<string, unknown>,
  ): Promise<any> {
    const key = `${state.candidate.pool.chain}:${state.candidate.pool.poolAddress}:${strategyVersion}`;
    return (this.prisma as any).strategySignal.upsert({
      where: { idempotencyKey: key },
      create: {
        watchId: state.id, strategyVersion, chain: state.candidate.pool.chain,
        tokenAddress: state.candidate.token.tokenAddress, poolAddress: state.candidate.pool.poolAddress,
        observedAt: new Date(), firstEligibleAt: new Date(), firstEligibleBlock: head.toString(),
        firstEligibleFlowSnapshot: snapshot as unknown as Prisma.InputJsonValue,
        firstEligibleDataHealthSnapshot: dataHealth as Prisma.InputJsonValue,
        latestSwapAt: snapshot.latestSwapAtMs == null ? null : new Date(snapshot.latestSwapAtMs),
        observedBlock: head.toString(), expiresAt: new Date(state.expiresAtMs),
        executablePriceUsd: executableEntryPriceUsd, flowSnapshot: snapshot as unknown as Prisma.InputJsonValue,
        riskSnapshot: { ...this.riskSnapshot(risk), hardRiskReason } as Prisma.InputJsonValue,
        dataHealthSnapshot: dataHealth as Prisma.InputJsonValue,
        entryQuoteSnapshot: entryQuoteSnapshot as Prisma.InputJsonValue,
        status, idempotencyKey: key,
      },
      update: {
        observedAt: new Date(), observedBlock: head.toString(), expiresAt: new Date(state.expiresAtMs),
        latestSwapAt: snapshot.latestSwapAtMs == null ? null : new Date(snapshot.latestSwapAtMs),
        executablePriceUsd: executableEntryPriceUsd,
        flowSnapshot: snapshot as unknown as Prisma.InputJsonValue,
        riskSnapshot: { ...this.riskSnapshot(risk), hardRiskReason } as Prisma.InputJsonValue,
        dataHealthSnapshot: dataHealth as Prisma.InputJsonValue,
        entryQuoteSnapshot: entryQuoteSnapshot as Prisma.InputJsonValue,
        status,
      },
    });
  }

  private async persistPreflightObservation(
    state: WatchState,
    strategyVersion: string,
    head: bigint,
    snapshot: FlowSnapshot,
    liq: LiquidityCheckResult,
    reason: string,
    dataHealth: Record<string, unknown>,
  ): Promise<void> {
    const key = `${state.candidate.pool.chain}:${state.candidate.pool.poolAddress}:${strategyVersion}`;
    await (this.prisma as any).strategySignal.upsert({
      where: { idempotencyKey: key },
      create: {
        watchId: state.id, strategyVersion, chain: state.candidate.pool.chain,
        tokenAddress: state.candidate.token.tokenAddress, poolAddress: state.candidate.pool.poolAddress,
        observedAt: new Date(), firstEligibleAt: new Date(), firstEligibleBlock: head.toString(),
        firstEligibleFlowSnapshot: snapshot as unknown as Prisma.InputJsonValue,
        firstEligibleDataHealthSnapshot: dataHealth as Prisma.InputJsonValue,
        latestSwapAt: snapshot.latestSwapAtMs == null ? null : new Date(snapshot.latestSwapAtMs),
        observedBlock: head.toString(), expiresAt: new Date(state.expiresAtMs),
        executablePriceUsd: liq.spotPriceUsd, flowSnapshot: snapshot as unknown as Prisma.InputJsonValue,
        riskSnapshot: { preflightReason: reason }, dataHealthSnapshot: dataHealth as Prisma.InputJsonValue,
        status: 'PREFLIGHT_WAIT', idempotencyKey: key,
      },
      update: {
        observedAt: new Date(), observedBlock: head.toString(), executablePriceUsd: liq.spotPriceUsd,
        latestSwapAt: snapshot.latestSwapAtMs == null ? null : new Date(snapshot.latestSwapAtMs),
        flowSnapshot: snapshot as unknown as Prisma.InputJsonValue,
        riskSnapshot: { preflightReason: reason }, dataHealthSnapshot: dataHealth as Prisma.InputJsonValue,
        status: 'PREFLIGHT_WAIT',
      },
    });
  }

  private async persistLateSignal(
    state: WatchState,
    strategyVersion: string,
    head: bigint,
    snapshot: FlowSnapshot,
    dataHealth: Record<string, unknown>,
  ): Promise<void> {
    const key = `${state.candidate.pool.chain}:${state.candidate.pool.poolAddress}:${strategyVersion}`;
    await (this.prisma as any).strategySignal.upsert({
      where: { idempotencyKey: key },
      create: {
        watchId: state.id, strategyVersion, chain: state.candidate.pool.chain,
        tokenAddress: state.candidate.token.tokenAddress, poolAddress: state.candidate.pool.poolAddress,
        observedAt: new Date(), firstEligibleAt: new Date(), firstEligibleBlock: head.toString(),
        firstEligibleFlowSnapshot: snapshot as unknown as Prisma.InputJsonValue,
        firstEligibleDataHealthSnapshot: dataHealth as Prisma.InputJsonValue,
        latestSwapAt: snapshot.latestSwapAtMs == null ? null : new Date(snapshot.latestSwapAtMs),
        observedBlock: head.toString(), expiresAt: new Date(state.expiresAtMs),
        flowSnapshot: snapshot as unknown as Prisma.InputJsonValue,
        dataHealthSnapshot: dataHealth as Prisma.InputJsonValue,
        status: 'DEGRADED_SHADOW', idempotencyKey: key,
      },
      update: {
        observedAt: new Date(), observedBlock: head.toString(),
        latestSwapAt: snapshot.latestSwapAtMs == null ? null : new Date(snapshot.latestSwapAtMs),
        flowSnapshot: snapshot as unknown as Prisma.InputJsonValue,
        dataHealthSnapshot: dataHealth as Prisma.InputJsonValue,
        status: 'DEGRADED_SHADOW',
      },
    });
  }

  private async persistCandidate(
    candidate: CollectorResult,
    liq: LiquidityCheckResult,
    risk: ContractRiskResult,
    runId: string,
  ): Promise<{ tokenId: string; poolId: string } | null> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const now = new Date();
        const token = await tx.token.upsert({
          where: { chain_tokenAddress: { chain: candidate.pool.chain, tokenAddress: candidate.token.tokenAddress } },
          create: {
            chain: candidate.pool.chain, tokenAddress: candidate.token.tokenAddress,
            symbol: candidate.token.symbol || null, name: candidate.token.name || null,
            decimals: candidate.token.decimals ?? null, firstSeenAt: now,
            deployerAddress: candidate.token.deployerAddress ?? null, source: candidate.token.source,
          },
          update: {
            symbol: candidate.token.symbol || undefined, name: candidate.token.name || undefined,
            decimals: candidate.token.decimals ?? undefined,
            deployerAddress: candidate.token.deployerAddress ?? undefined,
          },
        });
        const pool = await tx.pool.upsert({
          where: { chain_poolAddress: { chain: candidate.pool.chain, poolAddress: candidate.pool.poolAddress } },
          create: {
            chain: candidate.pool.chain, poolAddress: candidate.pool.poolAddress, dex: candidate.pool.dex,
            tokenId: token.id, token0: candidate.pool.token0Address, token1: candidate.pool.token1Address,
            quoteAsset: candidate.pool.quoteAsset, feeTier: candidate.pool.feeTier,
            v4Metadata: this.v4Storage(candidate.pool.v4Metadata), firstSeenAt: candidate.pool.poolCreatedAt ?? now,
          },
          update: { v4Metadata: this.v4Storage(candidate.pool.v4Metadata) },
        });
        await tx.poolSnapshot.create({
          data: {
            chain: candidate.pool.chain, poolId: pool.id, tokenId: token.id, ts: now,
            priceUsd: liq.spotPriceUsd, onchainLiquidityUsd: liq.onchainTvlUsd,
            reportedLiquidityUsd: candidate.pool.liquidityUsd ?? null, fdvUsd: candidate.pool.fdvUsd ?? null,
            liquidityModel: liq.liquidityModel, liquidityVerified: liq.liquidityVerified,
            reportedVsOnchainPct: liq.reportedVsOnchainPct, spotPriceUsd: liq.spotPriceUsd,
            executableDepthUsd: liq.executableDepthUsd, slip50: liq.slip50, slip100: liq.slip100,
            slip500: liq.slip500, slip1000: liq.slip1000,
          },
        });
        if (!risk.cacheHit) {
          await tx.contractRiskCheck.create({
            data: {
              runId, chain: candidate.pool.chain, tokenAddress: candidate.token.tokenAddress, tokenId: token.id,
              ts: now, goplusQueried: risk.goplusQueried, honeypotQueried: risk.honeypotQueried,
              verified: risk.merged.verified ?? null, honeypot: risk.merged.honeypot ?? null,
              buyTax: risk.merged.buyTax ?? null, sellTax: risk.merged.sellTax ?? null,
              canMint: risk.merged.mintRisk ?? null, canBlacklist: risk.merged.blacklistRisk ?? null,
              canPause: risk.merged.pauseRisk ?? null, isProxy: risk.merged.proxyRisk ?? null,
              ownerRenounced: risk.merged.ownerRenounced ?? null, lpLockedOrBurned: risk.merged.lpLockedOrBurned ?? null,
              decision: risk.decision, rejectReasons: risk.rejectReasons as Prisma.InputJsonValue,
              hardReject: false, rejectReason: null,
            },
          });
        }
        return { tokenId: token.id, poolId: pool.id };
      });
    } catch (error) {
      this.logger.warn(`Flow candidate persistence failed: ${(error as Error).message}`);
      return null;
    }
  }

  private async hardRiskReason(
    state: WatchState,
    risk: ContractRiskResult,
    strategyVersion: string,
  ): Promise<string | null> {
    const merged = risk.merged;
    const contractReason = contractHardRiskReason(risk);
    if (contractReason) return contractReason;
    const deployer = state.candidate.token.deployerAddress;
    if (!deployer || !state.creatorAttributable) return null;
    const block = await this.deployers.findBlocklistHit(state.candidate.pool.chain, deployer);
    if (block) return `blocked_deployer:${block.reason}`;
    const summary = await this.deployers.summarize(state.candidate.pool.chain, deployer);
    if (summary && strategyVersion.endsWith('_v2') && summary.rugLikeCount >= 1) return 'prior_rug_creator';
    if (summary && this.deployers.isRepeatRugger(summary)) return 'repeat_rug_deployer';
    return null;
  }

  private riskCohort(risk: ContractRiskResult, hardReason: string | null): 'CONTRACT_SAFE' | 'SOFT_RISK' {
    return hardReason ? 'SOFT_RISK' : classifyFlowRisk(risk);
  }

  private liquidityHardReject(liq: LiquidityCheckResult, strategy: FlowStrategyDefinition): string | null {
    if (!liq.liquidityVerified || !(liq.spotPriceUsd && liq.spotPriceUsd > 0)) return 'executable_quote_unavailable';
    if ((liq.executableDepthUsd ?? 0) < (this.config.get<number>('evmFlow.minExecutableDepthUsd') ?? 100)) return 'depth_below_100';
    if (strategy.minOnchainTvlUsd != null && (liq.onchainTvlUsd ?? 0) < strategy.minOnchainTvlUsd) {
      return `onchain_tvl_below_${strategy.minOnchainTvlUsd}`;
    }
    if (strategy.maxOnchainTvlUsd != null && (liq.onchainTvlUsd ?? Number.POSITIVE_INFINITY) > strategy.maxOnchainTvlUsd) {
      return `onchain_tvl_above_${strategy.maxOnchainTvlUsd}`;
    }
    const entrySlip = strategy.version.endsWith('_v2') ? liq.entrySlip20 ?? null : liq.slip50;
    const exitSlip = strategy.version.endsWith('_v2') ? liq.exitSlip20 ?? null : liq.slip50;
    if (entrySlip == null) return 'buy_quote_unavailable';
    if (exitSlip == null) return 'sell_quote_unavailable';
    const maxSlip = strategy.maxEntrySlipPct ?? (this.config.get<number>('evmFlow.maxEntrySlipPct') ?? 0.10);
    if (entrySlip > maxSlip) return `entry_slippage_over_${Math.round(maxSlip * 100)}pct`;
    return null;
  }

  private updateSpotOutcome(state: WatchState, trade: FlowTrade): void {
    if (!(trade.priceUsd && trade.priceUsd > 0)) return;
    state.firstPriceUsd ??= trade.priceUsd;
    state.maxPriceUsd = Math.max(state.maxPriceUsd ?? trade.priceUsd, trade.priceUsd);
    const drawdown = state.maxPriceUsd > 0 ? (state.maxPriceUsd - trade.priceUsd) / state.maxPriceUsd : 0;
    state.maxDrawdown = Math.max(state.maxDrawdown ?? 0, drawdown);
  }

  private async updateWatchState(state: WatchState): Promise<void> {
    const now = Date.now();
    const spotMaxMultiple = state.firstPriceUsd && state.maxPriceUsd
      ? state.maxPriceUsd / state.firstPriceUsd
      : null;
    if (now - state.lastOutcomeQuoteAtMs >= 30_000 && state.trades.length > 0) {
      state.lastOutcomeQuoteAtMs = now;
      const liq = await this.liquidity.verify(state.candidate.pool, state.gemDecimals);
      if (liq.spotPriceUsd && liq.slip50 != null) {
        const sizeUsd = this.config.get<number>('paper.positionSizeUsd') ?? 20;
        const sandwichPct = this.config.get<number>('paper.sandwichPct') ?? 0.01;
        const gasUsd = await this.gasModel.estimateUsd(state.candidate.pool.chain, state.model);
        if (state.benchmarkTokensBought == null) {
          const entry = modelEntry(liq.spotPriceUsd, slipForSize(sizeUsd, this.slipLadder(liq, 'entry')), {
            sizeUsd, sandwichPct, gasUsd, buyTaxPct: 0,
            maxEntrySlipPct: this.config.get<number>('evmFlow.maxEntrySlipPct') ?? 0.10,
          });
          if (entry.entered) {
            state.benchmarkTokensBought = entry.tokensBought;
            state.benchmarkEntryEffectiveUsd = entry.effectivePriceUsd;
            state.benchmarkEntryGasUsd = gasUsd;
          }
        }
        if (state.benchmarkTokensBought != null) {
          const grossUsd = state.benchmarkTokensBought * liq.spotPriceUsd;
          const exit = modelExit(
            state.benchmarkTokensBought,
            liq.spotPriceUsd,
            slipForSize(grossUsd, this.slipLadder(liq, 'exit')),
            { sandwichPct, gasUsd, sellTaxPct: 0 },
          );
          const executable = sizeUsd > 0 ? exit.netUsd / sizeUsd : 0;
          state.executableNetMaxMultiple = Math.max(state.executableNetMaxMultiple ?? 0, executable);
          if (state.timeTo2xSec == null && executable >= 2) {
            state.timeTo2xSec = Math.round((now - state.discoveredAtMs) / 1000);
          }
        }
      }
    }
    const age = now - state.discoveredAtMs;
    const outcome = (horizon: number): string | null => age < horizon
      ? null
      : (state.executableNetMaxMultiple ?? 0) >= 2 ? 'EXECUTABLE_2X' : 'NO_EXECUTABLE_2X';
    const status = now >= state.outcomeDueAtMs ? 'COMPLETE' : now >= state.expiresAtMs ? 'EXPIRED' : 'WATCHING';
    const latestFlowSnapshot = {
      window30s: computeFlowSnapshot(state.trades, now, state.discoveredAtMs, 30_000, state.flowCreatorAddress),
      window60s: computeFlowSnapshot(state.trades, now, state.discoveredAtMs, 60_000, state.flowCreatorAddress),
      window120s: computeFlowSnapshot(state.trades, now, state.discoveredAtMs, 120_000, state.flowCreatorAddress),
      window5m: computeFlowSnapshot(state.trades, now, state.discoveredAtMs, 300_000, state.flowCreatorAddress),
    };
    const httpHead = this.latestHttpHead.get(state.candidate.pool.chain);
    const cursorLag = httpHead != null && httpHead > state.lastProcessedBlock
      ? Number(httpHead - state.lastProcessedBlock)
      : 0;
    const latestDataHealth = {
      coverageComplete: state.coverageComplete,
      cursorLagBlocks: cursorLag,
      latestSwapAgeMs: state.latestSwapAtMs == null ? null : Math.max(0, now - state.latestSwapAtMs),
      streamMode: this.streamMode(state.candidate.pool.chain as FlowChain),
    };
    await (this.prisma as any).evmPoolWatch.update({
      where: { id: state.id },
      data: {
        status, lastProcessedBlock: state.lastProcessedBlock.toString(),
        lastProcessedBlockHash: state.lastProcessedBlockHash,
        firstPriceUsd: state.firstPriceUsd, spotMaxMultiple,
        executableNetMaxMultiple: state.executableNetMaxMultiple,
        benchmarkTokensBought: state.benchmarkTokensBought,
        benchmarkEntryEffectiveUsd: state.benchmarkEntryEffectiveUsd,
        benchmarkEntryGasUsd: state.benchmarkEntryGasUsd,
        creatorAddress: state.flowCreatorAddress,
        latestFlowSnapshot: latestFlowSnapshot as unknown as Prisma.InputJsonValue,
        latestDataHealth: latestDataHealth as Prisma.InputJsonValue,
        timeTo2xSec: state.timeTo2xSec,
        maxDrawdown: state.maxDrawdown,
        outcome15m: outcome(900_000), outcome1h: outcome(3_600_000),
        outcome6h: outcome(21_600_000), outcome24h: outcome(86_400_000),
      },
    });
    if (status === 'COMPLETE') this.watches.delete(this.key(state.candidate.pool.chain, state.candidate.pool.poolAddress, state.watchType));
  }

  private async invalidateReorg(chain: SupportedChain, newHead: bigint): Promise<void> {
    const signals = await (this.prisma as any).strategySignal.findMany({
      where: {
        chain,
        status: { in: ['OBSERVED', 'ENTERED', 'NOT_ENTERED', 'HARD_REJECT', 'PREFLIGHT_WAIT', 'DEGRADED_SHADOW'] },
      },
      select: { id: true, observedBlock: true, paperPosition: { select: { id: true } } },
    });
    const invalid = signals.filter((signal: any) => blockIsAfterHead(signal.observedBlock, newHead));
    if (invalid.length) {
      const ids = invalid.map((signal: any) => signal.id);
      await (this.prisma as any).strategySignal.updateMany({ where: { id: { in: ids } }, data: { status: 'REORG_INVALIDATED' } });
      await this.prisma.paperPosition.updateMany({
        where: { signalId: { in: ids } } as any,
        data: { status: 'INVALIDATED', outcomeClass: 'REORG_INVALIDATED', benchmarkEligible: false } as any,
      });
    }
    const observations = await (this.prisma as any).evmSwapObservation.findMany({
      where: { chain }, select: { id: true, blockNumber: true }, orderBy: { ts: 'desc' }, take: 10_000,
    });
    const orphanIds = observations
      .filter((observation: any) => blockIsAfterHead(observation.blockNumber, newHead))
      .map((observation: any) => observation.id);
    if (orphanIds.length) await (this.prisma as any).evmSwapObservation.deleteMany({ where: { id: { in: orphanIds } } });
    for (const state of this.watches.values()) {
      if (state.candidate.pool.chain !== chain || state.lastProcessedBlock <= newHead) continue;
      if (chain === 'robinhood') await this.robinhoodExperiment.invalidateReorg(state.id, newHead);
      state.lastProcessedBlock = newHead;
      state.trades = state.trades.filter((trade) => BigInt(trade.blockNumber) <= newHead);
    }
    this.logger.warn(`Flow reorg detected ${chain}: rewound to block ${newHead}`);
  }

  private async restoreWatches(activeChains = this.flowChains()): Promise<void> {
    const restoreHeads = new Map<FlowChain, bigint>();
    await Promise.all(activeChains.map(async (chain) => {
      const client = this.clients.get(chain);
      if (!client) return;
      const head = await client.getBlockNumber().catch(() => null);
      if (head != null) {
        restoreHeads.set(chain, head);
        this.latestHttpHead.set(chain, head);
      }
    }));
    const rows = await (this.prisma as any).evmPoolWatch.findMany({
      where: {
        chain: { in: activeChains },
        outcomeDueAt: { gt: new Date() },
        status: { in: ['WATCHING', 'EXPIRED'] },
      },
      include: {
        swaps: { where: { ts: { gte: new Date(Date.now() - 300_000) } }, orderBy: { ts: 'asc' } },
        signals: true,
        backfills: { where: { status: 'PENDING' }, select: { id: true }, take: 1 },
        robinhoodExperiments: {
          where: { status: { in: ['CONFIRMING', 'CONFIRMED', 'EXPIRED'] } },
          select: { horizonAt: true },
          take: 1,
        },
      },
    }).catch(() => []);
    for (const row of rows) {
      try {
        const candidate = this.deserializeCandidate(row.candidateJson as PersistedCandidate);
        const model = row.liquidityModel as FlowModel;
        const client = this.clients.get(candidate.pool.chain);
        const poolCurrencies = this.sortedCurrencies(
          candidate.pool.token0Address,
          candidate.pool.token1Address,
        );
        const persistedCursor = this.bigintOrNull(row.lastProcessedBlock) ?? 0n;
        const restoreHead = restoreHeads.get(candidate.pool.chain as FlowChain);
        const restoredCursor = restoreHead == null
          ? persistedCursor
          : clampRegistrationStartBlock(
            persistedCursor,
            restoreHead,
            this.registrationMaxBackfill(candidate.pool.chain as FlowChain),
          );
        const state: WatchState = {
          id: row.id, candidate, watchType: row.watchType as FlowWatchType,
          model, discoveredAtMs: row.discoveredAt.getTime(),
          expiresAtMs: row.expiresAt.getTime(), outcomeDueAtMs: row.outcomeDueAt.getTime(),
          swapTrackingUntilMs: Math.max(
            row.expiresAt.getTime(),
            row.robinhoodExperiments[0]?.horizonAt?.getTime() ?? 0,
          ),
          lastProcessedBlock: restoredCursor,
          lastProcessedBlockHash: row.lastProcessedBlockHash ?? null,
          trades: row.swaps.map((swap: any) => ({
            chain: swap.chain, poolAddress: swap.poolAddress, tokenAddress: candidate.token.tokenAddress,
            blockNumber: swap.blockNumber, blockHash: swap.blockHash, txHash: swap.txHash,
            logIndex: swap.logIndex, occurredAtMs: swap.ts.getTime(), trader: swap.trader,
            kind: swap.kind, quoteAmountUsd: Number(swap.quoteAmountUsd),
            tokenAmount: this.numberOrNull(swap.tokenAmount), priceUsd: this.numberOrNull(swap.priceUsd),
          })),
          triggered: new Set(row.signals
            .filter((signal: any) => this.isTerminalSignalStatus(signal.status))
            .map((signal: any) => signal.strategyVersion)),
          gemDecimals: candidate.token.decimals ?? 18,
          poolToken0Address: poolCurrencies.token0,
          poolToken1Address: poolCurrencies.token1,
          flowCreatorAddress: row.creatorAddress ?? candidate.token.deployerAddress ?? null,
          creatorAttributable: false,
          coverageComplete: false,
          latestSwapAtMs: row.swaps.at(-1)?.ts.getTime() ?? null,
          pendingBackfill: row.backfills.length > 0,
          firstPriceUsd: this.numberOrNull(row.firstPriceUsd),
          maxPriceUsd: this.restoreMaxPrice(row.firstPriceUsd, row.spotMaxMultiple),
          executableNetMaxMultiple: this.numberOrNull(row.executableNetMaxMultiple),
          benchmarkTokensBought: this.numberOrNull(row.benchmarkTokensBought),
          benchmarkEntryEffectiveUsd: this.numberOrNull(row.benchmarkEntryEffectiveUsd),
          benchmarkEntryGasUsd: this.numberOrNull(row.benchmarkEntryGasUsd),
          timeTo2xSec: row.timeTo2xSec ?? null,
          maxDrawdown: this.numberOrNull(row.maxDrawdown),
          lastOutcomeQuoteAtMs: 0,
        };
        this.watches.set(this.key(candidate.pool.chain, candidate.pool.poolAddress, state.watchType), state);
        const creator = row.creatorAddress ?? candidate.token.deployerAddress ?? null;
        if (client && creator && state.expiresAtMs > Date.now()) {
          void this.isEoa(client, creator).then((attributable) => {
            state.creatorAttributable = attributable;
          });
        }
      } catch (error) {
        this.logger.warn(`Flow watch restore skipped ${row.id}: ${(error as Error).message}`);
      }
    }
    if (rows.length) this.logger.log(`Restored ${rows.length} EVM flow watch(es)`);
  }

  private async eventDrivenEval(chain: SupportedChain, poolAddresses: readonly string[]): Promise<void> {
    if (this.evalBusy) return;
    this.evalBusy = true;
    try { await this.evaluator.requestFlowEvaluation(chain, poolAddresses); }
    finally { this.evalBusy = false; }
  }

  private async logHealth(): Promise<void> {
    for (const chain of this.flowChains()) {
      const head = this.latestHead.get(chain);
      const http = this.latestHttpHead.get(chain);
      const chainWatches = [...this.watches.values()].filter((watch) => watch.candidate.pool.chain === chain);
      const now = Date.now();
      // Once the entry window expires, stale outcome tracking must not make a new entry unhealthy.
      const entryEligibleWatches = chainWatches.filter((watch) => watch.expiresAtMs > now);
      const streamLag = head != null && http != null && http > head ? Number(http - head) : 0;
      const cursor = entryEligibleWatches.reduce<bigint | null>(
        (min, watch) => min == null || watch.lastProcessedBlock < min ? watch.lastProcessedBlock : min,
        null,
      );
      const cursorLag = cursor != null && http != null && http > cursor ? Number(http - cursor) : 0;
      const lag = Math.max(streamLag, cursorLag);
      const unresolvedRanges = await (this.prisma as any).evmFlowBackfillRange.count({
        where: { chain, status: 'PENDING', watch: { expiresAt: { gt: new Date(now) } } },
      }).catch(() => 0);
      const stats = this.readStats.get(chain) ?? { totalShards: 0, failedShards: 0, coverageRatio: 1 };
      const signalEligible = lag <= (this.config.get<number>('evmFlow.maxHeadLagBlocks') ?? 2) &&
        unresolvedRanges === 0 && stats.coverageRatio >= (this.config.get<number>('evmFlow.minBlockCoverage') ?? 0.995);
      const open = await this.prisma.paperPosition.count({
        where: {
          chain,
          status: 'OPEN',
          strategyVersion: { in: [
            'fresh_early_v1', 'fresh_confirmed_v1', 'mature_early_v1', 'mature_confirmed_v1',
            'evm_flow_precision_v2', 'robinhood_flow_precision_v2',
          ] },
        } as any,
      }).catch((error) => {
        const prismaCode = (error as { code?: string }).code;
        const suffix = prismaCode ? ` (${prismaCode})` : '';
        this.logger.warn(`Flow health open-position count unavailable ${chain}${suffix}: ${(error as Error).message}`);
        return null;
      });
      let experimentHealth = '';
      if (chain === 'robinhood') {
        const experimentDelegate = (this.prisma as any).robinhoodEntryExperiment;
        const armDelegate = (this.prisma as any).robinhoodExperimentArm;
        const [activeExperiments, activeArms, resolvedExperiments] = await Promise.all([
          experimentDelegate?.count
            ? experimentDelegate.count({ where: { status: { in: ['CONFIRMING', 'CONFIRMED', 'EXPIRED'] } } }).catch(() => 0)
            : 0,
          armDelegate?.count
            ? armDelegate.count({ where: { status: { in: ['PENDING_ENTRY', 'WAITING_CONFIRMATION', 'OPEN'] } } }).catch(() => 0)
            : 0,
          experimentDelegate?.count
            ? experimentDelegate.count({ where: { status: 'RESOLVED' } }).catch(() => 0)
            : 0,
        ]);
        experimentHealth = ` experimentSignals=${activeExperiments} experimentArms=${activeArms} experimentResolved=${resolvedExperiments}`;
      }
      await (this.prisma as any).evmRpcHealthSample.create({
        data: {
          chain, headBlock: (http ?? head)?.toString() ?? null, cursorBlock: cursor?.toString() ?? null,
          lagBlocks: lag, totalShards: stats.totalShards, failedShards: stats.failedShards,
          unresolvedRanges, coverageRatio: stats.coverageRatio, signalEligible,
          streamMode: this.streamMode(chain), rpcFailures: this.rpcFailures.get(chain) ?? 0,
        },
      }).catch(() => undefined);
      this.logger.log(
        `Flow health ${chain}: head=${http ?? head ?? '?'} lag=${lag} watching=${entryEligibleWatches.length} ` +
        `outcomeTracking=${chainWatches.length} swaps=${this.swapCount.get(chain) ?? 0} invalidSwaps=${this.invalidSwapCount.get(chain) ?? 0} ` +
        `signals=${this.signalCount.get(chain) ?? 0} open=${open ?? '?'} rpcErrors=${this.rpcFailures.get(chain) ?? 0} ` +
        `coverage=${(stats.coverageRatio * 100).toFixed(2)}% unresolved=${unresolvedRanges} eligible=${signalEligible}${experimentHealth}`,
      );
    }
  }

  private stateForLog(states: WatchState[], log: RawSwapLog): WatchState | undefined {
    const direct = states.find((state) => state.model !== 'V4' && state.candidate.pool.poolAddress === log.address.toLowerCase());
    if (direct) return direct;
    const id = typeof log.args?.id === 'string' ? log.args.id.toLowerCase() : null;
    return id ? states.find((state) => state.model === 'V4' && state.candidate.pool.poolAddress === id) : undefined;
  }

  private matchesTrade(state: WatchState, trade: FlowTrade): boolean {
    return state.candidate.pool.chain === trade.chain && state.candidate.pool.poolAddress === trade.poolAddress;
  }

  private quoteIndex(state: WatchState): 0 | 1 | null {
    const zero = '0x0000000000000000000000000000000000000000';
    const p = state.candidate.pool;
    const quote = p.quoteAssetAddress.toLowerCase();
    const direct = poolQuoteIndex(state.poolToken0Address, state.poolToken1Address, quote);
    if (direct != null) return direct;
    if (state.model === 'V4' && p.quoteAsset === 'WETH') {
      return poolQuoteIndex(state.poolToken0Address, state.poolToken1Address, zero);
    }
    return null;
  }

  private sortedCurrencies(tokenA: string, tokenB: string): { token0: string; token1: string } {
    const a = tokenA.toLowerCase();
    const b = tokenB.toLowerCase();
    return BigInt(a) <= BigInt(b) ? { token0: a, token1: b } : { token0: b, token1: a };
  }

  private registrationMaxBackfill(chain: FlowChain): bigint {
    const key = chain === 'ethereum'
      ? 'evmFlow.registrationMaxBackfillBlocksEthereum'
      : chain === 'base'
        ? 'evmFlow.registrationMaxBackfillBlocksBase'
        : 'evmFlow.registrationMaxBackfillBlocksRobinhood';
    return BigInt(Math.max(1, this.config.get<number>(key) ?? (chain === 'ethereum' ? 32 : 300)));
  }

  private async resolveModel(candidate: CollectorResult): Promise<FlowModel | null> {
    if (candidate.pool.v4Metadata || candidate.pool.poolAddress.length === 66) return 'V4';
    const dex = candidate.pool.dex.toLowerCase();
    if (dex.includes('v3')) return 'V3';
    if (dex.includes('v2') || dex.includes('aerodrome')) return 'V2';
    const resolved = await this.dexResolver.resolveModel(
      candidate.pool.chain,
      candidate.pool.poolAddress,
      candidate.pool.dex,
    );
    return resolved.model === 'V2' || resolved.model === 'V3' || resolved.model === 'V4'
      ? resolved.model
      : null;
  }

  private serializeCandidate(candidate: CollectorResult): PersistedCandidate {
    return {
      candidate: {
        token: { ...candidate.token },
        pool: {
          ...candidate.pool,
          poolCreatedAt: candidate.pool.poolCreatedAt?.toISOString(),
          v4Metadata: candidate.pool.v4Metadata
            ? { ...candidate.pool.v4Metadata, sqrtPriceX96: candidate.pool.v4Metadata.sqrtPriceX96.toString() }
            : undefined,
        },
      },
    };
  }

  private deserializeCandidate(value: PersistedCandidate): CollectorResult {
    const candidate = value.candidate;
    return {
      token: candidate.token,
      pool: {
        ...candidate.pool,
        poolCreatedAt: candidate.pool.poolCreatedAt ? new Date(candidate.pool.poolCreatedAt) : undefined,
        v4Metadata: candidate.pool.v4Metadata
          ? { ...candidate.pool.v4Metadata, sqrtPriceX96: BigInt(candidate.pool.v4Metadata.sqrtPriceX96) }
          : undefined,
      },
    };
  }

  private v4Storage(value: CollectorResult['pool']['v4Metadata']): Prisma.InputJsonValue | typeof Prisma.JsonNull {
    return value ? { ...value, sqrtPriceX96: value.sqrtPriceX96.toString() } : Prisma.JsonNull;
  }

  private riskSnapshot(risk: ContractRiskResult): Record<string, unknown> {
    return { decision: risk.decision, rejectReasons: risk.rejectReasons, providerStatus: risk.providerStatus, ...risk.merged };
  }

  private pruneTrades(state: WatchState, nowMs: number): void {
    const cutoff = nowMs - 300_000;
    state.trades = state.trades.filter((trade) => trade.occurredAtMs >= cutoff);
  }

  private async readDecimals(client: PublicClient, tokenAddress: string): Promise<number> {
    try {
      return Number(await client.readContract({ address: tokenAddress as Address, abi: DECIMALS_ABI, functionName: 'decimals' }));
    } catch { return 18; }
  }

  private async poolCreator(client: PublicClient, txHash?: string): Promise<string | null> {
    if (!txHash) return null;
    try {
      const transaction = await client.getTransaction({ hash: txHash as Hash });
      return transaction.from.toLowerCase();
    } catch {
      return null;
    }
  }

  private bigintOrNull(value: unknown): bigint | null {
    if (value == null || value === '') return null;
    try { return BigInt(String(value)); } catch { return null; }
  }

  private numberOrNull(value: unknown): number | null {
    if (value == null) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  private restoreMaxPrice(firstPrice: unknown, spotMaxMultiple: unknown): number | null {
    const first = this.numberOrNull(firstPrice);
    const multiple = this.numberOrNull(spotMaxMultiple);
    return first != null && multiple != null ? first * multiple : first;
  }

  private isTerminalSignalStatus(status: string): boolean {
    return signalStatusConsumesTrigger(status);
  }

  private slipLadder(liq: LiquidityCheckResult, direction: 'entry' | 'exit' | 'conservative' = 'conservative'): {
    slip20?: number | null; slip50: number | null; slip100: number | null; slip500: number | null; slip1000: number | null;
  } {
    const exact20 = direction === 'entry' ? liq.entrySlip20
      : direction === 'exit' ? liq.exitSlip20 : liq.slip20;
    return {
      slip20: exact20 ?? liq.slip20 ?? null,
      slip50: liq.slip50, slip100: liq.slip100, slip500: liq.slip500, slip1000: liq.slip1000,
    };
  }

  private addressArg(value: unknown): string | null {
    return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value) ? value.toLowerCase() : null;
  }

  private isStableQuote(symbol: string): boolean {
    return symbol !== 'WETH';
  }

  private streamMode(chain: FlowChain): 'wss' | 'http-fallback' {
    const url = this.config.get<string>(this.wsConfigKey(chain));
    return url ? 'wss' : 'http-fallback';
  }

  private wsConfigKey(chain: FlowChain): string {
    return chain === 'ethereum' ? 'chain.ethereumRpcWsUrl'
      : chain === 'base' ? 'chain.baseRpcWsUrl' : 'chain.robinhoodRpcWsUrl';
  }

  private flowChains(): FlowChain[] {
    const configured = this.config.get<string[]>('evmFlow.chains') ?? ['ethereum', 'robinhood'];
    const selected = new Set(configured.map((chain) => chain.trim().toLowerCase()));
    return FLOW_CHAINS.filter((chain) => selected.has(chain));
  }

  private registrationHead(chain: FlowChain, client: PublicClient): Promise<bigint> {
    const cached = this.latestHttpHead.get(chain) ?? this.latestHead.get(chain);
    if (cached != null) return Promise.resolve(cached);
    const inFlight = this.initialHeadRequests.get(chain);
    if (inFlight) return inFlight;
    const request = client.getBlockNumber().then((head) => {
      this.latestHttpHead.set(chain, head);
      this.lastHttpHeadCheckAt.set(chain, Date.now());
      return head;
    }).finally(() => this.initialHeadRequests.delete(chain));
    this.initialHeadRequests.set(chain, request);
    return request;
  }

  private async isEoa(client: PublicClient, address: string | null): Promise<boolean> {
    if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) return false;
    try {
      const code = await client.getCode({ address: address as Address });
      return code == null || code === '0x';
    } catch {
      return false;
    }
  }

  private async persistBackfill(state: WatchState, fromBlock: bigint, toBlock: bigint, error: string): Promise<void> {
    const idempotencyKey = `${state.candidate.pool.chain}:${state.id}:${fromBlock}:${toBlock}`;
    await (this.prisma as any).evmFlowBackfillRange.upsert({
      where: { idempotencyKey },
      create: {
        watchId: state.id, chain: state.candidate.pool.chain, liquidityModel: state.model,
        fromBlock: fromBlock.toString(), toBlock: toBlock.toString(), status: 'PENDING',
        attempts: 1, lastError: error.slice(0, 2_000), idempotencyKey,
      },
      update: { status: 'PENDING', attempts: { increment: 1 }, lastError: error.slice(0, 2_000), resolvedAt: null },
    }).catch(() => undefined);
    state.pendingBackfill = true;
  }

  private async resolveBackfill(state: WatchState, fromBlock: bigint, toBlock: bigint): Promise<void> {
    const pending = await (this.prisma as any).evmFlowBackfillRange.findMany({
      where: { watchId: state.id, status: 'PENDING' },
      select: { id: true, fromBlock: true, toBlock: true },
    }).catch(() => []);
    const ids = pending
      .filter((row: any) => BigInt(row.fromBlock) >= fromBlock && BigInt(row.toBlock) <= toBlock)
      .map((row: any) => row.id);
    if (!ids.length) return;
    try {
      await (this.prisma as any).evmFlowBackfillRange.updateMany({
        where: { id: { in: ids } },
        data: { status: 'RESOLVED', resolvedAt: new Date(), lastError: null },
      });
      const remaining = await (this.prisma as any).evmFlowBackfillRange.count({
        where: { watchId: state.id, status: 'PENDING' },
      });
      state.pendingBackfill = remaining > 0;
    } catch {
      state.pendingBackfill = true;
    }
  }

  private taxFraction(value: number | null | undefined): number {
    if (value == null || !Number.isFinite(value) || value <= 0) return 0;
    return value > 1 ? value / 100 : value;
  }

  private key(chain: SupportedChain, poolAddress: string, watchType: FlowWatchType): string {
    return `${chain}:${poolAddress.toLowerCase()}:${watchType}`;
  }
}
