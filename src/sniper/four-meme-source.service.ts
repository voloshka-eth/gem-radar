import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import {
  createPublicClient,
  formatUnits,
  http,
  type Address,
  type PublicClient,
} from 'viem';
import { bsc } from 'viem/chains';
import { FOUR_MEME_READ_ABI, FOUR_MEME_TOKEN_MANAGER2 } from './four-meme.abi';
import {
  FourMemeEvent,
  FourMemeSafetyState,
  SniperAddress,
} from './sniper.types';

type DecodedLog = {
  eventName: string;
  args: Record<string, unknown>;
  blockNumber: bigint | null;
  transactionHash: `0x${string}` | null;
  transactionIndex: number | null;
  logIndex: number | null;
};

export interface FourMemePollResult {
  events: FourMemeEvent[];
  cursor: string;
  range?: { fromBlock: string; toBlock: string };
  skippedRange?: { fromBlock: string; toBlock: string };
}

export interface LogPollPlan {
  fromBlock: bigint;
  toBlock: bigint;
  skippedRange?: { fromBlock: bigint; toBlock: bigint };
}

type FourMemeApiToken = {
  tokenId?: number;
  tokenAddress?: string;
  userAddress?: string;
  name?: string;
  shortName?: string;
  createDate?: string | number;
};

type FourMemeApiResponse = {
  code?: number;
  data?: FourMemeApiToken[];
};

@Injectable()
export class FourMemeSourceService {
  private readonly client: PublicClient | null;
  private readonly api: AxiosInstance;
  private readonly contractAddress: Address;
  private readonly initialLookbackBlocks: number;
  private readonly maxLogRangeBlocks: number;
  private readonly requestDelayMs: number;
  private readonly rpcTimeoutMs: number;
  private readonly apiSeedEnabled: boolean;
  private readonly apiSeedIntervalMs: number;
  private readonly apiSeedPageSize: number;
  private readonly confirmations: number;
  private lastApiSeedAtMs = 0;

  constructor(config: ConfigService) {
    const rpcUrl = config.get<string>('launchSniper.bscRpcUrl') ?? '';
    const apiBaseUrl = config.get<string>('launchSniper.fourMemeApiBaseUrl') ?? 'https://four.meme/meme-api/v1';
    this.contractAddress = (
      config.get<string>('launchSniper.fourMemeTokenManager') ?? FOUR_MEME_TOKEN_MANAGER2
    ) as Address;
    this.initialLookbackBlocks = config.get<number>('launchSniper.initialLookbackBlocks') ?? 300;
    this.maxLogRangeBlocks = Math.max(
      1,
      config.get<number>('launchSniper.maxLogRangeBlocks') ?? 25,
    );
    this.requestDelayMs = Math.max(
      0,
      config.get<number>('launchSniper.rpcRequestDelayMs') ?? 500,
    );
    this.rpcTimeoutMs = Math.max(
      1_000,
      config.get<number>('launchSniper.rpcTimeoutMs') ?? 15_000,
    );
    this.apiSeedEnabled = config.get<boolean>('launchSniper.apiSeedEnabled') ?? true;
    this.apiSeedIntervalMs = Math.max(
      3_000,
      config.get<number>('launchSniper.apiSeedIntervalMs') ?? 15_000,
    );
    this.apiSeedPageSize = Math.max(
      1,
      Math.min(100, config.get<number>('launchSniper.apiSeedPageSize') ?? 30),
    );
    this.confirmations = config.get<number>('launchSniper.confirmations') ?? 1;
    this.client = rpcUrl
      ? createPublicClient({
          chain: bsc,
          // A stalled public RPC must become a recorded poll error, not leave the
          // single watcher permanently stuck before it can write a heartbeat.
          transport: http(rpcUrl, { retryCount: 0, timeout: this.rpcTimeoutMs }),
        }) as unknown as PublicClient
      : null;
    this.api = axios.create({
      baseURL: apiBaseUrl,
      timeout: this.rpcTimeoutMs,
      headers: { Accept: 'application/json' },
    });
  }

  isConfigured(): boolean {
    return this.client != null;
  }

  async poll(cursor: string | null): Promise<FourMemePollResult> {
    const client = this.requireClient();
    const latest = await client.getBlockNumber();
    const safeHead = latest > BigInt(this.confirmations)
      ? latest - BigInt(this.confirmations)
      : 0n;
    const plan = planLogPoll(
      cursor,
      safeHead,
      this.initialLookbackBlocks,
      this.maxLogRangeBlocks,
    );
    if (!plan) return { events: [], cursor: cursor ?? safeHead.toString() };

    await delay(this.requestDelayMs);
    const rawLogs = await client.getContractEvents({
      address: this.contractAddress,
      abi: FOUR_MEME_READ_ABI,
      fromBlock: plan.fromBlock,
      toBlock: plan.toBlock,
    }) as unknown as DecodedLog[];
    const blockTimes = new Map<string, number>();
    for (const blockNumber of new Set(rawLogs.map((log) => log.blockNumber?.toString()).filter(isString))) {
      await delay(this.requestDelayMs);
      const block = await client.getBlock({ blockNumber: BigInt(blockNumber) });
      blockTimes.set(blockNumber, Number(block.timestamp) * 1000);
    }
    const chainEvents = rawLogs
      .sort(compareLogs)
      .map((log) => this.decode(log, blockTimes))
      .filter((event): event is FourMemeEvent => event != null);
    const apiEvents = await this.getApiSeedEvents();
    const events = [...apiEvents, ...chainEvents].sort((a, b) => a.occurredAtMs - b.occurredAtMs);
    return {
      events,
      cursor: plan.toBlock.toString(),
      range: {
        fromBlock: plan.fromBlock.toString(),
        toBlock: plan.toBlock.toString(),
      },
      skippedRange: plan.skippedRange
        ? {
            fromBlock: plan.skippedRange.fromBlock.toString(),
            toBlock: plan.skippedRange.toBlock.toString(),
          }
        : undefined,
    };
  }

  private async getApiSeedEvents(): Promise<FourMemeEvent[]> {
    const nowMs = Date.now();
    if (!this.apiSeedEnabled || nowMs - this.lastApiSeedAtMs < this.apiSeedIntervalMs) return [];
    this.lastApiSeedAtMs = nowMs;
    try {
      const response = await this.api.post<FourMemeApiResponse>('/public/token/search', {
        type: 'NEW',
        listType: 'NOR',
        keyword: '',
        status: 'PUBLISH',
        sort: 'DESC',
        pageIndex: 1,
        pageSize: this.apiSeedPageSize,
      });
      if (response.data.code !== 0 || !Array.isArray(response.data.data)) return [];
      return response.data.data.flatMap((token) => this.decodeApiSeed(token));
    } catch {
      // The chain watcher remains the primary source when the supplementary API is unavailable.
      return [];
    }
  }

  private decodeApiSeed(token: FourMemeApiToken): FourMemeEvent[] {
    const tokenAddress = normaliseAddress(token.tokenAddress);
    const creator = normaliseAddress(token.userAddress);
    const occurredAtMs = Number(token.createDate);
    if (!tokenAddress || !creator || !Number.isFinite(occurredAtMs) || occurredAtMs <= 0) return [];
    return [{
      kind: 'LAUNCH_CREATED',
      id: `fourmeme-api:${token.tokenId ?? tokenAddress}`,
      blockNumber: 'api',
      occurredAtMs,
      token: tokenAddress,
      creator,
      name: token.name ?? '',
      symbol: token.shortName ?? '',
      totalSupply: 1_000_000_000,
    }];
  }

  async readSafety(token: SniperAddress): Promise<FourMemeSafetyState> {
    const client = this.requireClient();
    try {
      const [code, info] = await Promise.all([
        client.getBytecode({ address: token }),
        client.readContract({
          address: this.contractAddress,
          abi: FOUR_MEME_READ_ABI,
          functionName: '_tokenInfos',
          args: [token],
        }),
      ]);
      const tuple = info as readonly [
        boolean, bigint, bigint, bigint, bigint, bigint, boolean, boolean, boolean,
      ];
      const initialized = tuple[0];
      const tradeEnabled = tuple[6];
      const liquidityAdded = tuple[7];
      const tradingHalt = tuple[8];
      const codePresent = Boolean(code && code !== '0x');
      const reasons: string[] = [];
      if (!codePresent) reasons.push('token_code_missing');
      if (!initialized) reasons.push('launch_not_initialized');
      if (!tradeEnabled) reasons.push('trading_disabled');
      if (tradingHalt) reasons.push('trading_halted');
      if (liquidityAdded) reasons.push('already_graduated');
      return {
        ok: reasons.length === 0,
        retryable: false,
        reasons,
        initialized,
        tradeEnabled,
        liquidityAdded,
        tradingHalt,
        codePresent,
      };
    } catch (error) {
      return {
        ok: false,
        retryable: true,
        reasons: [`safety_read_failed:${(error as Error).message}`],
        initialized: null,
        tradeEnabled: null,
        liquidityAdded: null,
        tradingHalt: null,
        codePresent: null,
      };
    }
  }

  private decode(log: DecodedLog, blockTimes: Map<string, number>): FourMemeEvent | null {
    if (log.blockNumber == null) return null;
    const blockNumber = log.blockNumber.toString();
    const occurredAtMs = blockTimes.get(blockNumber) ?? Date.now();
    const id = `${log.transactionHash ?? 'unknown'}:${log.logIndex ?? 0}`;
    if (log.eventName === 'TokenCreate') {
      const launchTime = asBigInt(log.args.launchTime);
      return {
        kind: 'LAUNCH_CREATED',
        id,
        blockNumber,
        occurredAtMs: launchTime > 0n ? Number(launchTime) * 1000 : occurredAtMs,
        token: asAddress(log.args.token),
        creator: asAddress(log.args.creator),
        name: String(log.args.name ?? ''),
        symbol: String(log.args.symbol ?? ''),
        totalSupply: Number(formatUnits(asBigInt(log.args.totalSupply), 18)),
      };
    }
    if (log.eventName === 'TokenPurchase' || log.eventName === 'TokenSale') {
      const tokenAmount = Number(formatUnits(asBigInt(log.args.amount ?? log.args.tokenAmount), 18));
      const quoteAmount = Number(formatUnits(asBigInt(log.args.cost ?? log.args.etherAmount), 18));
      return {
        kind: log.eventName === 'TokenPurchase' ? 'BUY' : 'SELL',
        id,
        blockNumber,
        occurredAtMs,
        token: asAddress(log.args.token),
        account: asAddress(log.args.account),
        tokenAmount,
        quoteAmount,
        priceQuotePerToken: tokenAmount > 0 ? quoteAmount / tokenAmount : 0,
      };
    }
    if (log.eventName === 'TradeStop') {
      return {
        kind: 'TRADE_STOPPED',
        id,
        blockNumber,
        occurredAtMs,
        token: asAddress(log.args.token),
      };
    }
    return null;
  }

  private requireClient(): PublicClient {
    if (!this.client) throw new Error('BSC_RPC_URL is required for launch_sniper_paper');
    return this.client;
  }
}

export function planLogPoll(
  cursor: string | null,
  safeHead: bigint,
  lookbackBlocks: number,
  maxBlocks: number,
): LogPollPlan | null {
  const lookback = BigInt(Math.max(1, Math.trunc(lookbackBlocks)));
  const chunkSize = BigInt(Math.max(1, Math.trunc(maxBlocks)));
  const earliestUsefulBlock = safeHead >= lookback - 1n ? safeHead - lookback + 1n : 0n;
  const requestedFrom = cursor == null ? earliestUsefulBlock : BigInt(cursor) + 1n;
  const fromBlock = requestedFrom < earliestUsefulBlock ? earliestUsefulBlock : requestedFrom;
  if (fromBlock > safeHead) return null;
  const proposedEnd = fromBlock + chunkSize - 1n;
  return {
    fromBlock,
    toBlock: proposedEnd < safeHead ? proposedEnd : safeHead,
    skippedRange: requestedFrom < earliestUsefulBlock
      ? { fromBlock: requestedFrom, toBlock: earliestUsefulBlock - 1n }
      : undefined,
  };
}

function asAddress(value: unknown): SniperAddress {
  const text = String(value ?? '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(text)) throw new Error(`Invalid event address: ${text}`);
  return text as SniperAddress;
}

function normaliseAddress(value: unknown): SniperAddress | null {
  const text = String(value ?? '').toLowerCase();
  return /^0x[0-9a-f]{40}$/.test(text) ? text as SniperAddress : null;
}

function asBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  return BigInt(String(value ?? 0));
}

function isString(value: string | undefined): value is string {
  return value != null;
}

function compareLogs(left: DecodedLog, right: DecodedLog): number {
  const byBlock = (left.blockNumber ?? 0n) - (right.blockNumber ?? 0n);
  if (byBlock < 0n) return -1;
  if (byBlock > 0n) return 1;
  const byTransaction = (left.transactionIndex ?? 0) - (right.transactionIndex ?? 0);
  if (byTransaction !== 0) return byTransaction;
  return (left.logIndex ?? 0) - (right.logIndex ?? 0);
}

function delay(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}
