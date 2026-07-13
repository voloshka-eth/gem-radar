import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import fs from 'fs';
import path from 'path';
import { parseAbiItem, type Address, type PublicClient } from 'viem';
import { QUOTE_ASSET_MAP, type CollectorResult, type SupportedChain } from '../collector/collector.types';
import { VIEM_CLIENTS } from './onchain.constants';

const V2_PAIR_CREATED = parseAbiItem(
  'event PairCreated(address indexed token0, address indexed token1, address pair, uint256)',
);
const V3_POOL_CREATED = parseAbiItem(
  'event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)',
);
const AERODROME_POOL_CREATED = parseAbiItem(
  'event PoolCreated(address indexed token0, address indexed token1, bool indexed stable, address pool, uint256)',
);
const V4_INITIALIZE = parseAbiItem(
  'event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)',
);
const NATIVE_CURRENCY = '0x0000000000000000000000000000000000000000';

type FactoryDefinition = {
  address: Address;
  dex: string;
  event: typeof V2_PAIR_CREATED | typeof V3_POOL_CREATED | typeof AERODROME_POOL_CREATED | typeof V4_INITIALIZE;
  poolArg: 'pair' | 'pool' | 'id';
};

type PendingPool = {
  candidate: CollectorResult;
  firstObservedAt: number;
};

/**
 * Watches factory creation logs through the configured RPC instead of waiting for a
 * third-party indexer to list the pool. The collector owns admission: a factory log
 * remains pending until the pool has executable liquidity or its short retry window
 * expires, so an empty createPool transaction cannot consume risk-provider quota.
 */
@Injectable()
export class FactoryPoolDiscoveryService {
  private readonly logger = new Logger(FactoryPoolDiscoveryService.name);
  private readonly lastProcessedBlock = new Map<string, bigint>();
  private readonly pending = new Map<string, PendingPool>();
  private readonly cursorFile: string | null;

  constructor(
    private readonly config: ConfigService,
    @Inject(VIEM_CLIENTS) private readonly clients: Map<SupportedChain, PublicClient>,
  ) {
    const logDir = this.config.get<string>('app.logDir');
    this.cursorFile = logDir ? path.resolve(logDir, 'state', 'factory_discovery_cursors.json') : null;
    this.loadCursors();
  }

  async getPendingPools(chain: SupportedChain): Promise<CollectorResult[]> {
    if (!(this.config.get<boolean>('collector.factoryDiscoveryEnabled') ?? true)) return [];
    if (chain !== 'ethereum' && chain !== 'base') return [];

    const client = this.clients.get(chain);
    if (!client) return this.pendingFor(chain);

    try {
      const toBlock = await client.getBlockNumber();
      const lookback = BigInt(Math.max(1, this.initialLookback(chain)));
      const results = await Promise.all(this.factories(chain).map(async (factory) => {
        const cursorKey = `${chain}:${factory.address}`;
        const previous = this.lastProcessedBlock.get(cursorKey);
        const fromBlock = previous == null
          ? (toBlock > lookback ? toBlock - lookback : 0n)
          : previous + 1n;
        if (fromBlock > toBlock) return 0;
        try {
          const logs = await client.getLogs({
            address: factory.address,
            event: factory.event as never,
            fromBlock,
            toBlock,
          } as never);
          this.lastProcessedBlock.set(cursorKey, toBlock);
          this.saveCursors();
          return this.addLogs(chain, factory, logs, client);
        } catch (err) {
          this.logger.warn(
            `Factory discovery log read failed for ${chain}:${factory.dex}: ${(err as Error).message}`,
          );
          return 0;
        }
      }));
      const discovered = results.reduce((sum, count) => sum + count, 0);
      if (discovered > 0) this.logger.log(`Factory discovery ${chain}: ${discovered} quote-pool event(s)`);
    } catch (err) {
      this.logger.warn(`Factory discovery cursor read failed for ${chain}: ${(err as Error).message}`);
    }

    this.prunePending();
    return this.pendingFor(chain);
  }

  markHandled(candidate: CollectorResult): void {
    this.pending.delete(this.key(candidate));
  }

  private async addLogs(
    chain: SupportedChain,
    factory: FactoryDefinition,
    logs: unknown[],
    client: PublicClient,
  ): Promise<number> {
    let added = 0;
    const timestamps = new Map<bigint, Date | undefined>();
    for (const log of logs as Array<{ args?: Record<string, unknown>; blockNumber?: bigint }>) {
      const token0 = this.addressArg(log.args?.token0 ?? log.args?.currency0);
      const token1 = this.addressArg(log.args?.token1 ?? log.args?.currency1);
      const poolAddress = factory.poolArg === 'id'
        ? this.poolIdArg(log.args?.id)
        : this.addressArg(log.args?.[factory.poolArg]);
      if (!token0 || !token1 || !poolAddress) continue;

      const quotes = QUOTE_ASSET_MAP[chain];
      const quote0 = this.quoteAddress(chain, token0, quotes);
      const quote1 = this.quoteAddress(chain, token1, quotes);
      const quoteAddress = quote0 ?? quote1;
      if (!quoteAddress) continue;
      const tokenAddress = quote0 ? token1 : token0;
      let poolCreatedAt: Date | undefined;
      if (log.blockNumber != null) {
        if (!timestamps.has(log.blockNumber)) {
          const timestamp = await client.getBlock({ blockNumber: log.blockNumber })
            .then((block) => new Date(Number(block.timestamp) * 1000))
            .catch(() => undefined);
          timestamps.set(log.blockNumber, timestamp);
        }
        poolCreatedAt = timestamps.get(log.blockNumber);
      }
      const candidate: CollectorResult = {
        token: { chain, tokenAddress, symbol: '', name: '', source: 'onchain_factory' },
        pool: {
          chain, poolAddress, dex: factory.dex, token0Address: token0, token1Address: token1,
          quoteAsset: quotes[quoteAddress], quoteAssetAddress: quoteAddress,
          v4Metadata: factory.poolArg === 'id' ? this.v4Metadata(log.args) : undefined,
          poolCreatedAt, source: 'onchain_factory',
        },
      };
      const key = this.key(candidate);
      if (!this.pending.has(key)) {
        this.pending.set(key, { candidate, firstObservedAt: Date.now() });
        added++;
      }
    }
    return added;
  }

  private factories(chain: SupportedChain): FactoryDefinition[] {
    if (chain === 'ethereum') {
      return [
        {
          address: this.config.get<string>('onchain.uniswapV2FactoryEthereum') as Address,
          dex: 'Uniswap V2', event: V2_PAIR_CREATED, poolArg: 'pair',
        },
        {
          address: this.config.get<string>('onchain.uniswapV3FactoryEthereum') as Address,
          dex: 'Uniswap V3', event: V3_POOL_CREATED, poolArg: 'pool',
        },
        {
          address: this.config.get<string>('onchain.v4PoolManagerEthereum') as Address,
          dex: 'Uniswap V4', event: V4_INITIALIZE, poolArg: 'id',
        },
      ];
    }
    if (chain === 'base') {
      return [
        {
          address: this.config.get<string>('onchain.uniswapV3FactoryBase') as Address,
          dex: 'Uniswap V3', event: V3_POOL_CREATED, poolArg: 'pool',
        },
        {
          address: this.config.get<string>('onchain.aerodromeFactoryBase') as Address,
          dex: 'Aerodrome', event: AERODROME_POOL_CREATED, poolArg: 'pool',
        },
        {
          address: this.config.get<string>('onchain.v4PoolManagerBase') as Address,
          dex: 'Uniswap V4', event: V4_INITIALIZE, poolArg: 'id',
        },
      ];
    }
    return [];
  }

  private initialLookback(chain: SupportedChain): number {
    const key = chain === 'ethereum'
      ? 'collector.factoryDiscoveryInitialLookbackEthereum'
      : 'collector.factoryDiscoveryInitialLookbackBase';
    return this.config.get<number>(key) ?? (chain === 'ethereum' ? 30 : 120);
  }

  private pendingFor(chain: SupportedChain): CollectorResult[] {
    return [...this.pending.values()]
      .filter((entry) => entry.candidate.pool.chain === chain)
      .map((entry) => entry.candidate);
  }

  private prunePending(): void {
    const ttlMs = Math.max(60_000, this.config.get<number>('collector.factoryDiscoveryPendingTtlMs') ?? 1_800_000);
    const cutoff = Date.now() - ttlMs;
    for (const [key, entry] of this.pending) {
      if (entry.firstObservedAt < cutoff) this.pending.delete(key);
    }
  }

  private loadCursors(): void {
    if (!this.cursorFile || !fs.existsSync(this.cursorFile)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.cursorFile, 'utf8')) as Record<string, unknown>;
      for (const [key, value] of Object.entries(raw)) {
        if (typeof value === 'string' && /^\d+$/.test(value)) {
          this.lastProcessedBlock.set(key, BigInt(value));
        }
      }
    } catch (err) {
      this.logger.warn(`Factory discovery cursor state unreadable: ${(err as Error).message}`);
    }
  }

  private saveCursors(): void {
    if (!this.cursorFile) return;
    try {
      fs.mkdirSync(path.dirname(this.cursorFile), { recursive: true });
      const state = Object.fromEntries(
        [...this.lastProcessedBlock.entries()].map(([key, value]) => [key, value.toString()]),
      );
      fs.writeFileSync(this.cursorFile, JSON.stringify(state, null, 2) + '\n', 'utf8');
    } catch (err) {
      this.logger.warn(`Factory discovery cursor state write failed: ${(err as Error).message}`);
    }
  }

  private addressArg(value: unknown): string | null {
    return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value)
      ? value.toLowerCase()
      : null;
  }

  private poolIdArg(value: unknown): string | null {
    return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value)
      ? value.toLowerCase()
      : null;
  }

  private quoteAddress(
    chain: SupportedChain,
    currency: string,
    quotes: Record<string, string>,
  ): string | null {
    if (quotes[currency] != null) return currency;
    if (currency !== NATIVE_CURRENCY) return null;
    // V4 represents native ETH as address(0); use the configured WETH address as
    // its USD quote identity, which V4LiquidityService maps back to address(0).
    return Object.entries(quotes).find(([, symbol]) => symbol === 'WETH')?.[0] ?? null;
  }

  private v4Metadata(args: Record<string, unknown> | undefined): CollectorResult['pool']['v4Metadata'] | undefined {
    const currency0 = this.addressArg(args?.currency0);
    const currency1 = this.addressArg(args?.currency1);
    const hooks = this.addressArg(args?.hooks);
    const fee = Number(args?.fee);
    const tickSpacing = Number(args?.tickSpacing);
    const sqrtPriceX96 = args?.sqrtPriceX96;
    if (!currency0 || !currency1 || !hooks || !Number.isFinite(fee) || !Number.isFinite(tickSpacing) || typeof sqrtPriceX96 !== 'bigint') {
      return undefined;
    }
    return { currency0, currency1, fee, tickSpacing, hooks, sqrtPriceX96 };
  }

  private key(candidate: CollectorResult): string {
    return `${candidate.pool.chain}:${candidate.pool.poolAddress}`;
  }
}
