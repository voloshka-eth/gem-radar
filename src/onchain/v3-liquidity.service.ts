import { Injectable, Logger, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { PublicClient } from 'viem';
import type { SupportedChain, CandidatePool } from '../collector/collector.types';
import { VIEM_CLIENTS, QUOTE_ASSET_DECIMALS, QUOTER_V2_CONFIG_KEY } from './onchain.constants';
import { PriceService } from './price.service';

const TOKEN_ADDR_ABI = [
  { name: 'token0', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { name: 'token1', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
] as const;

const SLOT0_ABI = [{
  name: 'slot0',
  type: 'function',
  stateMutability: 'view',
  inputs: [],
  outputs: [
    { name: 'sqrtPriceX96', type: 'uint160' },
    { name: 'tick', type: 'int24' },
    { name: 'observationIndex', type: 'uint16' },
    { name: 'observationCardinality', type: 'uint16' },
    { name: 'observationCardinalityNext', type: 'uint16' },
    { name: 'feeProtocol', type: 'uint8' },
    { name: 'unlocked', type: 'bool' },
  ],
}] as const;

const BALANCE_OF_ABI = [{
  name: 'balanceOf',
  type: 'function',
  stateMutability: 'view',
  inputs: [{ name: 'account', type: 'address' }],
  outputs: [{ type: 'uint256' }],
}] as const;

const DECIMALS_ABI = [{
  name: 'decimals',
  type: 'function',
  stateMutability: 'view',
  inputs: [],
  outputs: [{ type: 'uint8' }],
}] as const;

// QuoterV2 quoteExactInputSingle — params struct (Uniswap V3 periphery v1.0.0)
const QUOTER_V2_ABI = [{
  name: 'quoteExactInputSingle',
  type: 'function',
  stateMutability: 'nonpayable',
  inputs: [{
    name: 'params',
    type: 'tuple',
    components: [
      { name: 'tokenIn',           type: 'address' },
      { name: 'tokenOut',          type: 'address' },
      { name: 'amountIn',          type: 'uint256' },
      { name: 'fee',               type: 'uint24'  },
      { name: 'sqrtPriceLimitX96', type: 'uint160' },
    ],
  }],
  outputs: [
    { name: 'amountOut',               type: 'uint256' },
    { name: 'sqrtPriceX96After',       type: 'uint160' },
    { name: 'initializedTicksCrossed', type: 'uint32'  },
    { name: 'gasEstimate',             type: 'uint256' },
  ],
}] as const;

const PROBE_SIZES_USD = [50, 100, 500, 1000] as const;
const MAX_SLIPPAGE_FOR_DEPTH = 0.10;
const TWO_POW_96 = 2n ** 96n;

export interface V3LiquidityResult {
  onchainTvlUsd: number;
  spotPriceUsd: number;
  slip50: number | null;
  slip100: number | null;
  slip500: number | null;
  slip1000: number | null;
  executableDepthUsd: number;
}

@Injectable()
export class V3LiquidityService {
  private readonly logger = new Logger(V3LiquidityService.name);

  constructor(
    private readonly config: ConfigService,
    @Inject(VIEM_CLIENTS) private readonly viemClients: Map<SupportedChain, PublicClient>,
    private readonly priceService: PriceService,
  ) {}

  /**
   * Read V3 on-chain liquidity and compute slippage via QuoterV2.
   * Throws with a descriptive message on any failure so the caller can
   * store it in the CSV error column.
   */
  async readLiquidity(
    pool: CandidatePool,
    gemDecimals: number,
    feeBps: number,
  ): Promise<V3LiquidityResult> {
    const client = this.viemClients.get(pool.chain);
    if (!client) {
      throw new Error(`No viem client for chain "${pool.chain}"`);
    }

    const quoterKey  = QUOTER_V2_CONFIG_KEY[pool.chain];
    const quoterAddr = this.config.get<string>(quoterKey);
    if (!quoterAddr) {
      throw new Error(`No QuoterV2 address configured for chain "${pool.chain}" (config key: ${quoterKey})`);
    }

    const poolAddr = pool.poolAddress as `0x${string}`;

    let onchainToken0: string, onchainToken1: string, sqrtPriceX96: bigint;
    try {
      [onchainToken0, onchainToken1] = await Promise.all([
        client.readContract({ address: poolAddr, abi: TOKEN_ADDR_ABI, functionName: 'token0' }),
        client.readContract({ address: poolAddr, abi: TOKEN_ADDR_ABI, functionName: 'token1' }),
      ]) as [string, string];

      const slot0 = await client.readContract({ address: poolAddr, abi: SLOT0_ABI, functionName: 'slot0' });
      sqrtPriceX96 = slot0[0] as bigint;
    } catch (err) {
      const msg = `RPC read failed for V3 pool ${pool.chain}:${pool.poolAddress}: ${(err as Error).message}`;
      this.logger.warn(msg);
      throw new Error(msg);
    }

    if (sqrtPriceX96 === 0n) {
      throw new Error(`sqrtPriceX96 is zero — pool ${pool.chain}:${pool.poolAddress} may be uninitialized`);
    }

    const quotePriceUsd = await this.priceService.getUsdPrice(pool.chain, pool.quoteAssetAddress);
    if (!quotePriceUsd) {
      const msg = `DefiLlama price unavailable for ${pool.chain}:${pool.quoteAssetAddress} (${pool.quoteAsset})`;
      this.logger.warn(`${pool.chain}:${pool.poolAddress} — ${msg}`);
      throw new Error(msg);
    }

    const quoteDec = QUOTE_ASSET_DECIMALS[pool.quoteAsset] ?? 18;
    const gemDec   = gemDecimals;

    // Approximate TVL: quote-token balance held by pool × price × 2
    let onchainTvlUsd = 0;
    try {
      const quoteBal = await client.readContract({
        address: pool.quoteAssetAddress as `0x${string}`,
        abi: BALANCE_OF_ABI,
        functionName: 'balanceOf',
        args: [poolAddr],
      }) as bigint;
      const quoteBalHuman = Number(quoteBal) / 10 ** quoteDec;
      onchainTvlUsd = quoteBalHuman * quotePriceUsd * 2;
    } catch (err) {
      this.logger.warn(
        `balanceOf failed for ${pool.chain}:${pool.quoteAssetAddress} — TVL will be 0. ${(err as Error).message}`,
      );
    }

    // Spot price from sqrtPriceX96:
    // sqrtPrice = sqrtPriceX96 / 2^96, price = sqrtPrice^2 = token1Raw per token0Raw
    const sqrtRatio   = Number(sqrtPriceX96) / Number(TWO_POW_96);
    const priceRaw    = sqrtRatio * sqrtRatio; // token1 per token0 in raw units

    const gemIsToken0 = onchainToken0.toLowerCase() !== pool.quoteAssetAddress.toLowerCase();

    let spotPriceUsd: number;
    let gemAddr: string;
    let quoteAddr: string;

    if (gemIsToken0) {
      // token0 = gem, token1 = quote: priceRaw = quoteRaw / gemRaw
      const priceGemInQuote = priceRaw * (10 ** gemDec) / (10 ** quoteDec);
      spotPriceUsd = priceGemInQuote * quotePriceUsd;
      gemAddr   = onchainToken0;
      quoteAddr = onchainToken1;
    } else {
      // token0 = quote, token1 = gem: priceRaw = gemRaw / quoteRaw → invert
      const priceGemInQuote = (10 ** gemDec) / (priceRaw * 10 ** quoteDec);
      spotPriceUsd = priceGemInQuote * quotePriceUsd;
      gemAddr   = onchainToken1;
      quoteAddr = onchainToken0;
    }

    if (spotPriceUsd <= 0 || !isFinite(spotPriceUsd)) {
      throw new Error(
        `V3 spot price invalid: ${spotPriceUsd} ` +
        `(sqrtPriceX96=${sqrtPriceX96} gemIsToken0=${gemIsToken0} ` +
        `token0=${onchainToken0} quoteAddr=${pool.quoteAssetAddress})`,
      );
    }

    // Slippage probes via QuoterV2 quoteExactInputSingle (gem → quote direction)
    const feeUint24 = feeBps; // V3 fee is already in pool units (e.g. 3000 = 0.3%)
    const slippages = await Promise.all(
      PROBE_SIZES_USD.map((sizeUsd) =>
        this.quoteSlippage(client, quoterAddr, gemAddr, quoteAddr, feeUint24,
                           sizeUsd, spotPriceUsd, gemDec, quoteDec, quotePriceUsd),
      ),
    );

    const [slip50, slip100, slip500, slip1000] = slippages;

    let executableDepthUsd = 0;
    for (let i = PROBE_SIZES_USD.length - 1; i >= 0; i--) {
      if ((slippages[i] ?? 1) < MAX_SLIPPAGE_FOR_DEPTH) {
        executableDepthUsd = PROBE_SIZES_USD[i];
        break;
      }
    }

    return { onchainTvlUsd, spotPriceUsd, slip50, slip100, slip500, slip1000, executableDepthUsd };
  }

  /**
   * Slippage probe — QUOTE→GEM direction.
   *
   * We sell a fixed USD value of the quote token (WETH/USDC) and measure how many
   * gem tokens come out, then express the result as USD slippage relative to spot.
   *
   * WHY not GEM→QUOTE:
   *   amountIn_gem = sizeUsd / spotPriceUsd * 10^gemDec
   *   For a cheap gem ($0.0001 per token, 18 decimals):
   *     amountIn = 50 / 0.0001 * 1e18 = 5e23 raw units
   *   Selling 5e23 raw units into a thin pool → QuoterV2 returns 0 output → 100% slippage.
   *   In QUOTE→GEM direction amountIn is always ≤ sizeUsd/quotePriceUsd * 10^quoteDec,
   *   which is small and well-defined regardless of the gem's price.
   */
  private async quoteSlippage(
    client: PublicClient,
    quoterAddr: string,
    gemAddr: string,
    quoteAddr: string,
    fee: number,
    sizeUsd: number,
    spotPriceUsd: number,
    gemDec: number,
    quoteDec: number,
    quotePriceUsd: number,
  ): Promise<number | null> {
    if (!isFinite(spotPriceUsd) || spotPriceUsd <= 0) return null;
    try {
      // Sell sizeUsd worth of quote (e.g. USDC or WETH) to buy gem.
      const amountInFloat = (sizeUsd / quotePriceUsd) * (10 ** quoteDec);
      if (!isFinite(amountInFloat) || amountInFloat < 1) return null;
      const amountInRaw = BigInt(Math.round(amountInFloat));

      const result = await client.readContract({
        address: quoterAddr as `0x${string}`,
        abi: QUOTER_V2_ABI,
        functionName: 'quoteExactInputSingle',
        args: [{
          tokenIn:           quoteAddr as `0x${string}`,  // sell quote
          tokenOut:          gemAddr   as `0x${string}`,  // receive gem
          amountIn:          amountInRaw,
          fee,
          sqrtPriceLimitX96: 0n,
        }],
      }) as readonly [bigint, bigint, number, bigint];

      // Convert received gem tokens to USD at spot price, compare to what we spent.
      const actualGemRaw = result[0];
      const actualOutUsd = (Number(actualGemRaw) / 10 ** gemDec) * spotPriceUsd;
      return 1 - actualOutUsd / sizeUsd;
    } catch (err) {
      this.logger.debug(
        `QuoterV2 quoteExactInputSingle failed ($${sizeUsd} probe): ${(err as Error).message}`,
      );
      return null;
    }
  }

  /** Read gem decimals on-chain as fallback. */
  async readDecimals(chain: SupportedChain, tokenAddress: string): Promise<number> {
    const client = this.viemClients.get(chain);
    if (!client) return 18;
    try {
      const d = await client.readContract({
        address: tokenAddress as `0x${string}`,
        abi: DECIMALS_ABI,
        functionName: 'decimals',
      });
      return Number(d);
    } catch {
      return 18;
    }
  }
}
