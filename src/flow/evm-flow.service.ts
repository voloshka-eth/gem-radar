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
import { blockIsAfterHead, chunkValues, isSignalWindowOpen } from './flow-state';
import type { FlowSnapshot, FlowTrade, FlowWatchType, PersistedCandidate } from './flow.types';

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
const POOL_TOKEN_ABI = [
  {
    type: 'function', name: 'token0', stateMutability: 'view', inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function', name: 'token1', stateMutability: 'view', inputs: [],
    outputs: [{ type: 'address' }],
  },
] as const;

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

@Injectable()
export class EvmFlowService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EvmFlowService.name);
  private readonly watches = new Map<string, WatchState>();
  private readonly unwatch: Array<() => void> = [];
  private factoryTimer: ReturnType<typeof setInterval> | null = null;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private factoryBusy = false;
  private evalBusy = false;
  private readonly latestHead = new Map<SupportedChain, bigint>();
  private readonly latestHttpHead = new Map<SupportedChain, bigint>();
  private readonly lastHttpHeadCheckAt = new Map<SupportedChain, number>();
  private readonly rpcFailures = new Map<SupportedChain, number>();
  private readonly headPollBusy = new Set<SupportedChain>();
  private readonly headPollBackoffUntil = new Map<SupportedChain, number>();
  private readonly headPollConsecutiveFailures = new Map<SupportedChain, number>();
  private readonly processingHeads = new Set<SupportedChain>();
  private readonly pendingHeads = new Map<SupportedChain, { number: bigint; hash: string | null }>();
  private readonly latestHeadHash = new Map<SupportedChain, string>();
  private readonly swapCount = new Map<SupportedChain, number>();
  private readonly invalidSwapCount = new Map<SupportedChain, number>();
  private readonly signalCount = new Map<SupportedChain, number>();

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
    @Inject(VIEM_CLIENTS) private readonly clients: Map<SupportedChain, PublicClient>,
    @Inject(VIEM_STREAM_CLIENTS) private readonly streamClients: Map<SupportedChain, PublicClient>,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!(this.config.get<boolean>('evmFlow.enabled') ?? true)) {
      this.logger.log('ETH/Base flow watcher disabled');
      return;
    }
    await this.restoreWatches();
    for (const chain of ['ethereum', 'base'] as const) this.startHeadWatcher(chain);
    const factoryPollMs = Math.max(1_000, this.config.get<number>('evmFlow.factoryPollMs') ?? 3_000);
    this.factoryTimer = setInterval(() => void this.pollFactories(), factoryPollMs);
    this.healthTimer = setInterval(
      () => void this.logHealth(),
      Math.max(5_000, this.config.get<number>('evmFlow.healthLogMs') ?? 30_000),
    );
    void this.pollFactories();
    this.logger.log(
      `ETH/Base flow watcher started: factory=${factoryPollMs}ms strategies=${strategiesFor('FRESH').length + strategiesFor('MATURE').length} ` +
      `streams=ethereum:${this.streamMode('ethereum')},base:${this.streamMode('base')} paper-only`,
    );
  }

  onModuleDestroy(): void {
    if (this.factoryTimer) clearInterval(this.factoryTimer);
    if (this.healthTimer) clearInterval(this.healthTimer);
    for (const stop of this.unwatch) stop();
  }

  async registerMatureCandidate(candidate: CollectorResult): Promise<void> {
    if (!(this.config.get<boolean>('evmFlow.enabled') ?? true)) return;
    if (candidate.pool.chain !== 'ethereum' && candidate.pool.chain !== 'base') return;
    const created = candidate.pool.poolCreatedAt?.getTime();
    if (created == null || Date.now() - created <= 24 * 60 * 60 * 1000) return;
    await this.register(candidate, 'MATURE');
  }

  private startHeadWatcher(chain: 'ethereum' | 'base'): void {
    const wsUrl = this.config.get<string>(chain === 'ethereum' ? 'chain.ethereumRpcWsUrl' : 'chain.baseRpcWsUrl');
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

  private startHttpHeadPoller(chain: 'ethereum' | 'base'): void {
    const intervalMs = Math.max(2_000, this.config.get<number>(chain === 'ethereum'
      ? 'evmFlow.httpPollMsEthereum'
      : 'evmFlow.httpPollMsBase') ?? (chain === 'ethereum' ? 12_000 : 4_000));
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
      for (const chain of ['ethereum', 'base'] as const) {
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

  private async register(candidate: CollectorResult, watchType: FlowWatchType): Promise<boolean> {
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
    const head = await client.getBlockNumber();
    const backfill = watchType === 'MATURE'
      ? BigInt(this.config.get<number>(candidate.pool.chain === 'ethereum'
        ? 'evmFlow.matureBackfillBlocksEthereum'
        : 'evmFlow.matureBackfillBlocksBase') ?? (candidate.pool.chain === 'ethereum' ? 25 : 150))
      : 0n;
    const creationBlock = this.bigintOrNull(candidate.pool.creationBlockNumber);
    const startBlock = creationBlock != null
      ? creationBlock > 0n ? creationBlock - 1n : 0n
      : head > backfill ? head - backfill : 0n;

    const [tokenMetadata, gemDecimals, poolCurrencies] = await Promise.all([
      this.metadata.read(candidate.pool.chain, candidate.token.tokenAddress),
      this.readDecimals(client, candidate.token.tokenAddress),
      this.readPoolCurrencies(client, candidate, model),
    ]);
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
      },
    });
    const state: WatchState = {
      id: stored.id,
      candidate,
      watchType,
      model,
      discoveredAtMs,
      expiresAtMs: discoveredAtMs + watchMs,
      outcomeDueAtMs: discoveredAtMs + outcomeTrackMs,
      swapTrackingUntilMs: discoveredAtMs + 3_600_000,
      lastProcessedBlock: this.bigintOrNull(stored.lastProcessedBlock) ?? startBlock,
      lastProcessedBlockHash: stored.lastProcessedBlockHash ?? null,
      trades: [],
      triggered: new Set<string>(),
      gemDecimals,
      poolToken0Address: poolCurrencies.token0,
      poolToken1Address: poolCurrencies.token1,
      flowCreatorAddress,
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
    if (head > state.lastProcessedBlock) void this.enqueueHead(candidate.pool.chain as 'ethereum' | 'base', head, null);
    return true;
  }

  private async enqueueHead(chain: 'ethereum' | 'base', head: bigint, hash: string | null): Promise<void> {
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

  private async processHead(chain: 'ethereum' | 'base', head: bigint, headHash: string | null): Promise<void> {
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
      const fromBlock = swapStates.reduce(
        (min, state) => state.lastProcessedBlock + 1n < min ? state.lastProcessedBlock + 1n : min,
        head,
      );
      const maxBatchBlocks = chain === 'ethereum' ? 64n : 400n;
      const toBlock = fromBlock + maxBatchBlocks - 1n < head ? fromBlock + maxBatchBlocks - 1n : head;
      const logs = await this.readSwapLogs(client, chain, swapStates, fromBlock, toBlock);
      const trades = await this.decodeTrades(client, swapStates, logs);
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
        state.lastProcessedBlock = toBlock;
        state.lastProcessedBlockHash = toBlock === head ? headHash : null;
        await this.evaluateStrategies(state, toBlock, httpHead);
        await this.updateWatchState(state);
      }
      if (trades.length) {
        const pools = [...new Set(trades.map((trade) => trade.poolAddress))];
        void this.eventDrivenEval(chain, pools);
      }
      if (toBlock < head) this.pendingHeads.set(chain, { number: head, hash: headHash });
    } catch (error) {
      this.rpcFailures.set(chain, (this.rpcFailures.get(chain) ?? 0) + 1);
      this.logger.warn(`Flow block processing failed ${chain}:${head}: ${(error as Error).message}`);
    }
  }

  private async readSwapLogs(
    client: PublicClient,
    chain: SupportedChain,
    states: WatchState[],
    fromBlock: bigint,
    toBlock: bigint,
  ): Promise<RawSwapLog[]> {
    const results: RawSwapLog[] = [];
    const v2 = states.filter((state) => state.model === 'V2').map((state) => state.candidate.pool.poolAddress as Address);
    const v3 = states.filter((state) => state.model === 'V3').map((state) => state.candidate.pool.poolAddress as Address);
    const v4 = states.filter((state) => state.model === 'V4');
    const calls: Array<Promise<unknown[]>> = [];
    for (const addresses of chunkValues(v2, 100)) {
      calls.push(client.getLogs({ address: addresses, event: V2_SWAP, fromBlock, toBlock } as any));
    }
    for (const addresses of chunkValues(v3, 100)) {
      calls.push(client.getLogs({ address: addresses, event: V3_SWAP, fromBlock, toBlock } as any));
    }
    if (v4.length) {
      const managerKey = chain === 'ethereum' ? 'onchain.v4PoolManagerEthereum' : 'onchain.v4PoolManagerBase';
      const manager = this.config.get<string>(managerKey);
      if (manager) calls.push(client.getLogs({ address: manager as Address, event: V4_SWAP, fromBlock, toBlock } as any));
    }
    for (const batch of await Promise.all(calls)) results.push(...batch as RawSwapLog[]);
    return results.filter((log) => log.blockNumber != null && log.transactionHash != null && log.logIndex != null);
  }

  private async decodeTrades(client: PublicClient, states: WatchState[], logs: RawSwapLog[]): Promise<FlowTrade[]> {
    const blockNumbers = [...new Set(logs.map((log) => log.blockNumber!.toString()))];
    const blockData = new Map<string, { timestampMs: number; fromByHash: Map<string, string> }>();
    await Promise.all(blockNumbers.map(async (number) => {
      const block = await client.getBlock({ blockNumber: BigInt(number), includeTransactions: true });
      const fromByHash = new Map<string, string>();
      for (const transaction of block.transactions) {
        if (typeof transaction !== 'string') fromByHash.set(transaction.hash.toLowerCase(), transaction.from.toLowerCase());
      }
      blockData.set(number, { timestampMs: Number(block.timestamp) * 1000, fromByHash });
    }));
    const quotePriceCache = new Map<string, number>();
    const output: FlowTrade[] = [];
    for (const log of logs) {
      const state = this.stateForLog(states, log);
      if (!state) continue;
      const block = blockData.get(log.blockNumber!.toString());
      const trader = block?.fromByHash.get(log.transactionHash!.toLowerCase()) ?? this.addressArg(log.args?.sender) ?? '';
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
    return output.sort((a, b) => a.occurredAtMs - b.occurredAtMs || a.logIndex - b.logIndex);
  }

  private async evaluateStrategies(state: WatchState, head: bigint, httpHead: bigint): Promise<void> {
    if (!isSignalWindowOpen(Date.now(), state.expiresAtMs)) return;
    const lag = httpHead > head ? Number(httpHead - head) : 0;
    for (const strategy of strategiesFor(state.watchType)) {
      if (state.triggered.has(strategy.version)) continue;
      const decision = evaluateFlowStrategy(
        strategy, state.trades, Date.now(), state.discoveredAtMs, state.flowCreatorAddress,
      );
      if (!decision.triggered) continue;
      if (lag > (this.config.get<number>('evmFlow.maxHeadLagBlocks') ?? 2)) {
        await this.persistLateSignal(state, strategy.version, head, decision.snapshot, lag);
        state.triggered.add(strategy.version);
        continue;
      }
      await this.admitSignal(state, strategy.version, head, decision.snapshot);
    }
  }

  private async admitSignal(
    state: WatchState,
    strategyVersion: string,
    head: bigint,
    snapshot: FlowSnapshot,
  ): Promise<void> {
    const liq = await this.liquidity.verify(state.candidate.pool, state.gemDecimals);
    const preflight = this.liquidityHardReject(liq);
    if (preflight) {
      await this.persistPreflightObservation(state, strategyVersion, head, snapshot, liq, preflight);
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
    }
    const hardRisk = await this.hardRiskReason(state, risk);
    const riskCohort = this.riskCohort(risk, hardRisk);
    const gasUsd = await this.gasModel.estimateUsd(state.candidate.pool.chain, state.model);
    const sizeUsd = this.config.get<number>('paper.positionSizeUsd') ?? 20;
    const entryFill = modelEntry(liq.spotPriceUsd ?? 0, slipForSize(sizeUsd, this.slipLadder(liq)), {
      sizeUsd,
      sandwichPct: this.config.get<number>('paper.sandwichPct') ?? 0.01,
      gasUsd,
      buyTaxPct: this.taxFraction(risk.merged.buyTax),
      maxEntrySlipPct: this.config.get<number>('evmFlow.maxEntrySlipPct') ?? 0.10,
    });
    const signal = await this.createSignal(
      state, strategyVersion, head, snapshot, risk,
      entryFill.effectivePriceUsd, hardRisk, hardRisk ? 'HARD_REJECT' : 'OBSERVED',
    );
    if (hardRisk) {
      state.triggered.add(strategyVersion);
      const chain = state.candidate.pool.chain;
      this.signalCount.set(chain, (this.signalCount.get(chain) ?? 0) + 1);
      this.logger.warn(`Flow hard reject ${strategyVersion}: ${state.candidate.pool.chain}:${state.candidate.token.tokenAddress} reason=${hardRisk}`);
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
      exitPolicy: riskCohort === 'SOFT_RISK' ? 'SOFT_RISK_2X' : 'SAFE_LADDER',
      benchmarkEligible: true,
      flowSnapshot: snapshot as unknown as Record<string, unknown>,
      observedAt: new Date(),
      gasUsd,
      maxEntrySlipPct: this.config.get<number>('evmFlow.maxEntrySlipPct') ?? 0.10,
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
      `buyers=${snapshot.uniqueBuyers} buy=$${snapshot.buyQuoteUsd.toFixed(0)} ratio=${snapshot.buySellRatio.toFixed(2)} ` +
      `momentum=${snapshot.priceMomentum?.toFixed(3) ?? '?'} cohort=${riskCohort}`,
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
  ): Promise<any> {
    const key = `${state.candidate.pool.chain}:${state.candidate.pool.poolAddress}:${strategyVersion}`;
    return (this.prisma as any).strategySignal.upsert({
      where: { idempotencyKey: key },
      create: {
        watchId: state.id, strategyVersion, chain: state.candidate.pool.chain,
        tokenAddress: state.candidate.token.tokenAddress, poolAddress: state.candidate.pool.poolAddress,
        observedAt: new Date(), observedBlock: head.toString(), expiresAt: new Date(state.expiresAtMs),
        executablePriceUsd: executableEntryPriceUsd, flowSnapshot: snapshot as unknown as Prisma.InputJsonValue,
        riskSnapshot: { ...this.riskSnapshot(risk), hardRiskReason } as Prisma.InputJsonValue,
        status, idempotencyKey: key,
      },
      update: {
        observedAt: new Date(), observedBlock: head.toString(), expiresAt: new Date(state.expiresAtMs),
        executablePriceUsd: executableEntryPriceUsd,
        flowSnapshot: snapshot as unknown as Prisma.InputJsonValue,
        riskSnapshot: { ...this.riskSnapshot(risk), hardRiskReason } as Prisma.InputJsonValue,
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
  ): Promise<void> {
    const key = `${state.candidate.pool.chain}:${state.candidate.pool.poolAddress}:${strategyVersion}`;
    await (this.prisma as any).strategySignal.upsert({
      where: { idempotencyKey: key },
      create: {
        watchId: state.id, strategyVersion, chain: state.candidate.pool.chain,
        tokenAddress: state.candidate.token.tokenAddress, poolAddress: state.candidate.pool.poolAddress,
        observedAt: new Date(), observedBlock: head.toString(), expiresAt: new Date(state.expiresAtMs),
        executablePriceUsd: liq.spotPriceUsd, flowSnapshot: snapshot as unknown as Prisma.InputJsonValue,
        riskSnapshot: { preflightReason: reason }, status: 'PREFLIGHT_WAIT', idempotencyKey: key,
      },
      update: {
        observedAt: new Date(), observedBlock: head.toString(), executablePriceUsd: liq.spotPriceUsd,
        flowSnapshot: snapshot as unknown as Prisma.InputJsonValue,
        riskSnapshot: { preflightReason: reason }, status: 'PREFLIGHT_WAIT',
      },
    });
  }

  private async persistLateSignal(state: WatchState, strategyVersion: string, head: bigint, snapshot: FlowSnapshot, lag: number): Promise<void> {
    const key = `${state.candidate.pool.chain}:${state.candidate.pool.poolAddress}:${strategyVersion}`;
    await (this.prisma as any).strategySignal.upsert({
      where: { idempotencyKey: key },
      create: {
        watchId: state.id, strategyVersion, chain: state.candidate.pool.chain,
        tokenAddress: state.candidate.token.tokenAddress, poolAddress: state.candidate.pool.poolAddress,
        observedAt: new Date(), observedBlock: head.toString(), expiresAt: new Date(state.expiresAtMs),
        flowSnapshot: { ...snapshot, rpcLagBlocks: lag }, status: 'LATE_SHADOW', idempotencyKey: key,
      },
      update: { status: 'LATE_SHADOW' },
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

  private async hardRiskReason(state: WatchState, risk: ContractRiskResult): Promise<string | null> {
    const merged = risk.merged;
    const contractReason = contractHardRiskReason(risk);
    if (contractReason) return contractReason;
    const deployer = state.candidate.token.deployerAddress;
    if (!deployer) return null;
    const block = await this.deployers.findBlocklistHit(state.candidate.pool.chain, deployer);
    if (block) return `blocked_deployer:${block.reason}`;
    const summary = await this.deployers.summarize(state.candidate.pool.chain, deployer);
    if (summary && this.deployers.isRepeatRugger(summary)) return 'repeat_rug_deployer';
    return null;
  }

  private riskCohort(risk: ContractRiskResult, hardReason: string | null): 'CONTRACT_SAFE' | 'SOFT_RISK' {
    return hardReason ? 'SOFT_RISK' : classifyFlowRisk(risk);
  }

  private liquidityHardReject(liq: LiquidityCheckResult): string | null {
    if (!liq.liquidityVerified || !(liq.spotPriceUsd && liq.spotPriceUsd > 0)) return 'executable_quote_unavailable';
    if ((liq.executableDepthUsd ?? 0) < (this.config.get<number>('evmFlow.minExecutableDepthUsd') ?? 100)) return 'depth_below_100';
    const slip = liq.slip50;
    if (slip == null) return 'sell_quote_unavailable';
    if (slip > (this.config.get<number>('evmFlow.maxEntrySlipPct') ?? 0.10)) return 'entry_slippage_over_10pct';
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
          const entry = modelEntry(liq.spotPriceUsd, slipForSize(sizeUsd, this.slipLadder(liq)), {
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
            slipForSize(grossUsd, this.slipLadder(liq)),
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
        timeTo2xSec: state.timeTo2xSec,
        maxDrawdown: state.maxDrawdown,
        outcome1h: outcome(3_600_000), outcome6h: outcome(21_600_000), outcome24h: outcome(86_400_000),
      },
    });
    if (status === 'COMPLETE') this.watches.delete(this.key(state.candidate.pool.chain, state.candidate.pool.poolAddress, state.watchType));
  }

  private async invalidateReorg(chain: SupportedChain, newHead: bigint): Promise<void> {
    const signals = await (this.prisma as any).strategySignal.findMany({
      where: { chain, status: { in: ['OBSERVED', 'ENTERED', 'NOT_ENTERED'] } },
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
      state.lastProcessedBlock = newHead;
      state.trades = state.trades.filter((trade) => BigInt(trade.blockNumber) <= newHead);
    }
    this.logger.warn(`Flow reorg detected ${chain}: rewound to block ${newHead}`);
  }

  private async restoreWatches(): Promise<void> {
    const rows = await (this.prisma as any).evmPoolWatch.findMany({
      where: { outcomeDueAt: { gt: new Date() }, status: { in: ['WATCHING', 'EXPIRED'] } },
      include: { swaps: { where: { ts: { gte: new Date(Date.now() - 300_000) } }, orderBy: { ts: 'asc' } }, signals: true },
    }).catch(() => []);
    for (const row of rows) {
      try {
        const candidate = this.deserializeCandidate(row.candidateJson as PersistedCandidate);
        const model = row.liquidityModel as FlowModel;
        const client = this.clients.get(candidate.pool.chain);
        const poolCurrencies = client
          ? await this.readPoolCurrencies(client, candidate, model)
          : this.sortedCurrencies(candidate.pool.token0Address, candidate.pool.token1Address);
        const state: WatchState = {
          id: row.id, candidate, watchType: row.watchType as FlowWatchType,
          model, discoveredAtMs: row.discoveredAt.getTime(),
          expiresAtMs: row.expiresAt.getTime(), outcomeDueAtMs: row.outcomeDueAt.getTime(),
          swapTrackingUntilMs: row.discoveredAt.getTime() + 3_600_000,
          lastProcessedBlock: this.bigintOrNull(row.lastProcessedBlock) ?? 0n,
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
      } catch (error) {
        this.logger.warn(`Flow watch restore skipped ${row.id}: ${(error as Error).message}`);
      }
    }
    if (rows.length) this.logger.log(`Restored ${rows.length} ETH/Base flow watch(es)`);
  }

  private async eventDrivenEval(chain: SupportedChain, poolAddresses: readonly string[]): Promise<void> {
    if (this.evalBusy) return;
    this.evalBusy = true;
    try { await this.evaluator.requestFlowEvaluation(chain, poolAddresses); }
    finally { this.evalBusy = false; }
  }

  private async logHealth(): Promise<void> {
    for (const chain of ['ethereum', 'base'] as const) {
      const head = this.latestHead.get(chain);
      const http = this.latestHttpHead.get(chain);
      const chainWatches = [...this.watches.values()].filter((watch) => watch.candidate.pool.chain === chain);
      const streamLag = head != null && http != null && http > head ? Number(http - head) : 0;
      const cursor = chainWatches.reduce<bigint | null>(
        (min, watch) => min == null || watch.lastProcessedBlock < min ? watch.lastProcessedBlock : min,
        null,
      );
      const cursorLag = cursor != null && http != null && http > cursor ? Number(http - cursor) : 0;
      const lag = Math.max(streamLag, cursorLag);
      const open = await this.prisma.paperPosition.count({
        where: { chain, status: 'OPEN', strategyVersion: { in: ['fresh_early_v1', 'fresh_confirmed_v1', 'mature_early_v1', 'mature_confirmed_v1'] } } as any,
      });
      this.logger.log(
        `Flow health ${chain}: head=${http ?? head ?? '?'} lag=${lag} watching=${chainWatches.filter((w) => Date.now() <= w.expiresAtMs).length} ` +
        `tracking=${chainWatches.length} swaps=${this.swapCount.get(chain) ?? 0} invalidSwaps=${this.invalidSwapCount.get(chain) ?? 0} ` +
        `signals=${this.signalCount.get(chain) ?? 0} open=${open} rpcErrors=${this.rpcFailures.get(chain) ?? 0}`,
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

  private async readPoolCurrencies(
    client: PublicClient,
    candidate: CollectorResult,
    model: FlowModel,
  ): Promise<{ token0: string; token1: string }> {
    const pool = candidate.pool;
    if (model === 'V4') {
      const currency0 = pool.v4Metadata?.currency0?.toLowerCase();
      const currency1 = pool.v4Metadata?.currency1?.toLowerCase();
      if (currency0 && currency1) return { token0: currency0, token1: currency1 };
      return this.sortedCurrencies(pool.token0Address, pool.token1Address);
    }
    try {
      const address = pool.poolAddress as Address;
      const [token0, token1] = await Promise.all([
        client.readContract({ address, abi: POOL_TOKEN_ABI, functionName: 'token0' }),
        client.readContract({ address, abi: POOL_TOKEN_ABI, functionName: 'token1' }),
      ]);
      return { token0: String(token0).toLowerCase(), token1: String(token1).toLowerCase() };
    } catch (error) {
      this.logger.warn(
        `Flow pool currency read failed ${pool.chain}:${pool.poolAddress}; using canonical address order: ${(error as Error).message}`,
      );
      return this.sortedCurrencies(pool.token0Address, pool.token1Address);
    }
  }

  private sortedCurrencies(tokenA: string, tokenB: string): { token0: string; token1: string } {
    const a = tokenA.toLowerCase();
    const b = tokenB.toLowerCase();
    return BigInt(a) <= BigInt(b) ? { token0: a, token1: b } : { token0: b, token1: a };
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
    return ['ENTERED', 'HARD_REJECT', 'NOT_ENTERED', 'LATE_SHADOW'].includes(status);
  }

  private slipLadder(liq: LiquidityCheckResult): {
    slip50: number | null; slip100: number | null; slip500: number | null; slip1000: number | null;
  } {
    return { slip50: liq.slip50, slip100: liq.slip100, slip500: liq.slip500, slip1000: liq.slip1000 };
  }

  private addressArg(value: unknown): string | null {
    return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value) ? value.toLowerCase() : null;
  }

  private isStableQuote(symbol: string): boolean {
    return symbol !== 'WETH';
  }

  private streamMode(chain: 'ethereum' | 'base'): 'wss' | 'http-fallback' {
    const url = this.config.get<string>(chain === 'ethereum' ? 'chain.ethereumRpcWsUrl' : 'chain.baseRpcWsUrl');
    return url ? 'wss' : 'http-fallback';
  }

  private taxFraction(value: number | null | undefined): number {
    if (value == null || !Number.isFinite(value) || value <= 0) return 0;
    return value > 1 ? value / 100 : value;
  }

  private key(chain: SupportedChain, poolAddress: string, watchType: FlowWatchType): string {
    return `${chain}:${poolAddress.toLowerCase()}:${watchType}`;
  }
}
