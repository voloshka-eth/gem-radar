import { Injectable, Logger, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { PublicClient } from 'viem';
import type { CandidatePool, SupportedChain } from '../collector/collector.types';
import { QUOTE_ASSET_DECIMALS, V4_CONFIG_KEYS, VIEM_CLIENTS } from './onchain.constants';
import { PriceService } from './price.service';
import { bigintRatioToNumber, decimalToRawAmount, rawToDecimalNumber } from './bigint-math';

const INITIALIZE_EVENT = {
  type: 'event',
  name: 'Initialize',
  anonymous: false,
  inputs: [
    { indexed: true, name: 'id', type: 'bytes32' },
    { indexed: true, name: 'currency0', type: 'address' },
    { indexed: true, name: 'currency1', type: 'address' },
    { indexed: false, name: 'fee', type: 'uint24' },
    { indexed: false, name: 'tickSpacing', type: 'int24' },
    { indexed: false, name: 'hooks', type: 'address' },
    { indexed: false, name: 'sqrtPriceX96', type: 'uint160' },
    { indexed: false, name: 'tick', type: 'int24' },
  ],
} as const;

const STATE_VIEW_ABI = [{
  type: 'function',
  name: 'getSlot0',
  stateMutability: 'view',
  inputs: [{ name: 'id', type: 'bytes32' }],
  outputs: [
    { name: 'sqrtPriceX96', type: 'uint160' },
    { name: 'tick', type: 'int24' },
    { name: 'protocolFee', type: 'uint24' },
    { name: 'lpFee', type: 'uint24' },
  ],
}] as const;

const QUOTER_V4_ABI = [{
  type: 'function',
  name: 'quoteExactInputSingle',
  stateMutability: 'nonpayable',
  inputs: [{
    name: 'params',
    type: 'tuple',
    components: [
      {
        name: 'poolKey',
        type: 'tuple',
        components: [
          { name: 'currency0', type: 'address' },
          { name: 'currency1', type: 'address' },
          { name: 'fee', type: 'uint24' },
          { name: 'tickSpacing', type: 'int24' },
          { name: 'hooks', type: 'address' },
        ],
      },
      { name: 'zeroForOne', type: 'bool' },
      { name: 'exactAmount', type: 'uint128' },
      { name: 'hookData', type: 'bytes' },
    ],
  }],
  outputs: [
    { name: 'amountOut', type: 'uint256' },
    { name: 'gasEstimate', type: 'uint256' },
  ],
}] as const;

const DECIMALS_ABI = [{
  type: 'function',
  name: 'decimals',
  stateMutability: 'view',
  inputs: [],
  outputs: [{ type: 'uint8' }],
}] as const;

const PROBE_SIZES_USD = [50, 100, 500, 1000] as const;
const MAX_SLIPPAGE_FOR_DEPTH = 0.10;
const TWO_POW_96 = 2n ** 96n;
const TWO_POW_192 = TWO_POW_96 * TWO_POW_96;
const MAX_UINT128 = (2n ** 128n) - 1n;
const NATIVE_CURRENCY = '0x0000000000000000000000000000000000000000';

type PoolKey = {
  currency0: `0x${string}`;
  currency1: `0x${string}`;
  fee: number;
  tickSpacing: number;
  hooks: `0x${string}`;
};

type PoolMetadata = { key: PoolKey; sqrtPriceX96: bigint };

export interface V4LiquidityResult {
  spotPriceUsd: number;
  slip50: number | null;
  slip100: number | null;
  slip500: number | null;
  slip1000: number | null;
  executableDepthUsd: number;
}

/**
 * V4 pools are singleton state keyed by bytes32 poolId. The PoolManager Initialize
 * event carries the immutable PoolKey; StateView and Quoter then provide live price
 * and executable sell depth. V4 has no per-pool token balance, so this intentionally
 * does not fabricate an on-chain TVL figure from the singleton's aggregate balances.
 */
@Injectable()
export class V4LiquidityService {
  private readonly logger = new Logger(V4LiquidityService.name);
  private readonly metadataCache = new Map<string, PoolMetadata>();

  constructor(
    private readonly config: ConfigService,
    @Inject(VIEM_CLIENTS) private readonly clients: Map<SupportedChain, PublicClient>,
    private readonly priceService: PriceService,
  ) {}

  async readLiquidity(pool: CandidatePool, gemDecimals: number): Promise<V4LiquidityResult> {
    const client = this.clients.get(pool.chain);
    const keys = V4_CONFIG_KEYS[pool.chain];
    if (!client || !keys) throw new Error(`No V4 client/config for ${pool.chain}`);

    const poolId = pool.poolAddress as `0x${string}`;
    const poolManager = this.config.get<string>(keys.poolManager);
    const quoter = this.config.get<string>(keys.quoter);
    const stateView = this.config.get<string>(keys.stateView);
    if (!poolManager || !quoter || !stateView) {
      throw new Error(`Incomplete V4 deployment config for ${pool.chain}`);
    }
    const metadata = await this.getMetadata(client, pool.chain, poolId, poolManager);
    const quotePriceUsd = await this.priceService.getUsdPrice(pool.chain, pool.quoteAssetAddress);
    if (!quotePriceUsd) throw new Error(`DefiLlama price unavailable for ${pool.chain}:${pool.quoteAssetAddress}`);

    const slot0 = await client.readContract({
      address: stateView as `0x${string}`,
      abi: STATE_VIEW_ABI,
      functionName: 'getSlot0',
      args: [poolId],
    }) as readonly [bigint, number, number, number];
    const sqrtPriceX96 = slot0[0];
    if (sqrtPriceX96 === 0n) throw new Error(`V4 pool ${pool.chain}:${poolId} is uninitialized`);

    const quoteDec = QUOTE_ASSET_DECIMALS[pool.quoteAsset] ?? 18;
    const quoteAddr = pool.quoteAssetAddress.toLowerCase();
    const c0 = metadata.key.currency0.toLowerCase();
    const c1 = metadata.key.currency1.toLowerCase();
    const quoteCurrency = quoteAddr === c0 || quoteAddr === c1
      ? quoteAddr
      : pool.quoteAsset === 'WETH' && (c0 === NATIVE_CURRENCY || c1 === NATIVE_CURRENCY)
        ? NATIVE_CURRENCY
        : null;
    if (!quoteCurrency) {
      throw new Error(
        `V4 Initialize currencies do not contain configured quote asset ${quoteAddr} ` +
        `(currency0=${c0}, currency1=${c1})`,
      );
    }
    const gemAddr = quoteCurrency === c0 ? metadata.key.currency1 : metadata.key.currency0;
    const gemIsToken0 = gemAddr.toLowerCase() === c0;
    const priceRaw = bigintRatioToNumber(sqrtPriceX96 * sqrtPriceX96, TWO_POW_192);
    const priceGemInQuote = gemIsToken0
      ? priceRaw * (10 ** gemDecimals) / (10 ** quoteDec)
      : (10 ** gemDecimals) / (priceRaw * 10 ** quoteDec);
    const spotPriceUsd = priceGemInQuote * quotePriceUsd;
    if (!Number.isFinite(spotPriceUsd) || spotPriceUsd <= 0) {
      throw new Error(`V4 spot price invalid: ${spotPriceUsd}`);
    }

    const zeroForOne = gemIsToken0;
    const slippages = await Promise.all(PROBE_SIZES_USD.map((sizeUsd) =>
      this.quoteSlippage(client, quoter, metadata.key, zeroForOne,
        sizeUsd, spotPriceUsd, gemDecimals, quoteDec, quotePriceUsd),
    ));
    const [slip50, slip100, slip500, slip1000] = slippages;
    let executableDepthUsd = 0;
    for (let i = PROBE_SIZES_USD.length - 1; i >= 0; i--) {
      if ((slippages[i] ?? 1) < MAX_SLIPPAGE_FOR_DEPTH) {
        executableDepthUsd = PROBE_SIZES_USD[i];
        break;
      }
    }
    return { spotPriceUsd, slip50, slip100, slip500, slip1000, executableDepthUsd };
  }

  async readDecimals(chain: SupportedChain, tokenAddress: string): Promise<number> {
    const client = this.clients.get(chain);
    if (!client) return 18;
    try {
      const decimals = await client.readContract({
        address: tokenAddress as `0x${string}`,
        abi: DECIMALS_ABI,
        functionName: 'decimals',
      });
      return Number(decimals);
    } catch {
      return 18;
    }
  }

  private async getMetadata(
    client: PublicClient,
    chain: SupportedChain,
    poolId: `0x${string}`,
    poolManager: string,
  ): Promise<PoolMetadata> {
    const cacheKey = `${chain}:${poolId.toLowerCase()}`;
    const cached = this.metadataCache.get(cacheKey);
    if (cached) return cached;

    const logs = await client.getLogs({
      address: poolManager as `0x${string}`,
      event: INITIALIZE_EVENT,
      args: { id: poolId },
      fromBlock: 0n,
      toBlock: 'latest',
    } as any) as Array<{ args?: Record<string, unknown> }>;
    const args = logs.at(-1)?.args;
    const currency0 = typeof args?.currency0 === 'string' ? args.currency0 : null;
    const currency1 = typeof args?.currency1 === 'string' ? args.currency1 : null;
    const hooks = typeof args?.hooks === 'string' ? args.hooks : null;
    const fee = Number(args?.fee);
    const tickSpacing = Number(args?.tickSpacing);
    const sqrtPriceX96 = args?.sqrtPriceX96;
    if (!currency0 || !currency1 || !hooks || !Number.isFinite(fee) || !Number.isFinite(tickSpacing) || typeof sqrtPriceX96 !== 'bigint') {
      throw new Error(`V4 Initialize event unavailable for pool ${poolId}`);
    }
    const metadata = {
      key: { currency0: currency0 as `0x${string}`, currency1: currency1 as `0x${string}`, fee, tickSpacing, hooks: hooks as `0x${string}` },
      sqrtPriceX96,
    };
    this.metadataCache.set(cacheKey, metadata);
    return metadata;
  }

  private async quoteSlippage(
    client: PublicClient,
    quoter: string,
    poolKey: PoolKey,
    zeroForOne: boolean,
    sizeUsd: number,
    spotPriceUsd: number,
    gemDecimals: number,
    quoteDecimals: number,
    quotePriceUsd: number,
  ): Promise<number | null> {
    const amountIn = decimalToRawAmount(sizeUsd / spotPriceUsd, gemDecimals);
    if (amountIn < 1n || amountIn > MAX_UINT128) return null;
    try {
      const result = await client.readContract({
        address: quoter as `0x${string}`,
        abi: QUOTER_V4_ABI,
        functionName: 'quoteExactInputSingle',
        args: [{ poolKey, zeroForOne, exactAmount: amountIn, hookData: '0x' }],
      }) as readonly [bigint, bigint];
      const actualOutUsd = rawToDecimalNumber(result[0], quoteDecimals) * quotePriceUsd;
      return 1 - actualOutUsd / sizeUsd;
    } catch (err) {
      this.logger.debug(`V4 quoter failed for $${sizeUsd}: ${(err as Error).message}`);
      return null;
    }
  }
}
