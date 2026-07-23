import { Injectable, Logger, Inject } from '@nestjs/common';
import type { PublicClient } from 'viem';
import type { SupportedChain, CandidatePool } from '../collector/collector.types';
import { VIEM_CLIENTS, QUOTE_ASSET_DECIMALS } from './onchain.constants';
import { PriceService } from './price.service';
import { decimalToRawAmount, rawToDecimalNumber } from './bigint-math';
import type { ExecutionQuoteDirection, ExecutionQuoteResult } from './onchain.types';

// token0() / token1() — both V2 and V3 share this interface
const TOKEN_ADDR_ABI = [
  { name: 'token0', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { name: 'token1', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
] as const;

const GET_RESERVES_ABI = [{
  name: 'getReserves',
  type: 'function',
  stateMutability: 'view',
  inputs: [],
  outputs: [
    { name: 'reserve0', type: 'uint112' },
    { name: 'reserve1', type: 'uint112' },
    { name: 'blockTimestampLast', type: 'uint32' },
  ],
}] as const;

const DECIMALS_ABI = [{
  name: 'decimals',
  type: 'function',
  stateMutability: 'view',
  inputs: [],
  outputs: [{ type: 'uint8' }],
}] as const;

const PROBE_SIZES_USD = [20, 50, 100, 500, 1000] as const;
const MAX_SLIPPAGE_FOR_DEPTH = 0.10; // 10%

export interface V2LiquidityResult {
  onchainTvlUsd: number;
  spotPriceUsd: number;
  slip20: number | null;
  entrySlip20: number | null;
  exitSlip20: number | null;
  slip50: number | null;
  slip100: number | null;
  slip500: number | null;
  slip1000: number | null;
  executableDepthUsd: number;
}

@Injectable()
export class V2LiquidityService {
  private readonly logger = new Logger(V2LiquidityService.name);

  constructor(
    @Inject(VIEM_CLIENTS) private readonly viemClients: Map<SupportedChain, PublicClient>,
    private readonly priceService: PriceService,
  ) {}

  /**
   * Read V2 on-chain liquidity and compute slippage probes.
   * Throws with a descriptive message on any failure so the caller can
   * store it in the CSV error column.
   */
  async readLiquidity(
    pool: CandidatePool,
    gemDecimals: number,
    feeBps: number,
  ): Promise<V2LiquidityResult> {
    const client = this.viemClients.get(pool.chain);
    if (!client) {
      throw new Error(`No viem client for chain "${pool.chain}"`);
    }

    const addr = pool.poolAddress as `0x${string}`;

    let onchainToken0: string, onchainToken1: string;
    let reserve0Raw: bigint, reserve1Raw: bigint;
    try {
      [onchainToken0, onchainToken1] = await Promise.all([
        client.readContract({ address: addr, abi: TOKEN_ADDR_ABI, functionName: 'token0' }),
        client.readContract({ address: addr, abi: TOKEN_ADDR_ABI, functionName: 'token1' }),
      ]) as [string, string];

      const reserves = await client.readContract({
        address: addr,
        abi: GET_RESERVES_ABI,
        functionName: 'getReserves',
      });
      [reserve0Raw, reserve1Raw] = [reserves[0] as bigint, reserves[1] as bigint];
    } catch (err) {
      const msg = `RPC read failed for V2 pool ${pool.chain}:${pool.poolAddress}: ${(err as Error).message}`;
      this.logger.warn(msg);
      throw new Error(msg);
    }

    // Determine which on-chain slot is quote vs gem
    const quoteIsToken0 = onchainToken0.toLowerCase() === pool.quoteAssetAddress.toLowerCase();
    const quoteReserveRaw = quoteIsToken0 ? reserve0Raw : reserve1Raw;
    const gemReserveRaw   = quoteIsToken0 ? reserve1Raw : reserve0Raw;

    if (gemReserveRaw === 0n || quoteReserveRaw === 0n) {
      const msg =
        `Zero reserves: quoteReserve=${quoteReserveRaw} gemReserve=${gemReserveRaw} ` +
        `(quoteAsset=${pool.quoteAsset} quoteAddr=${pool.quoteAssetAddress} ` +
        `onchain token0=${onchainToken0} token1=${onchainToken1} quoteIsToken0=${quoteIsToken0})`;
      this.logger.warn(`${pool.chain}:${pool.poolAddress} — ${msg}`);
      throw new Error(msg);
    }

    // Quote decimals from known map; gem decimals from parameter
    const quoteDec = QUOTE_ASSET_DECIMALS[pool.quoteAsset] ?? 18;
    const gemDec   = gemDecimals;

    const quotePriceUsd = await this.priceService.getUsdPrice(pool.chain, pool.quoteAssetAddress);
    if (!quotePriceUsd) {
      const msg = `DefiLlama price unavailable for ${pool.chain}:${pool.quoteAssetAddress} (${pool.quoteAsset})`;
      this.logger.warn(`${pool.chain}:${pool.poolAddress} — ${msg}`);
      throw new Error(msg);
    }

    const quoteReserveHuman = rawToDecimalNumber(quoteReserveRaw, quoteDec);
    const gemReserveHuman   = rawToDecimalNumber(gemReserveRaw, gemDec);

    const onchainTvlUsd = quoteReserveHuman * quotePriceUsd * 2;
    const spotPriceUsd  = (quoteReserveHuman / gemReserveHuman) * quotePriceUsd;

    if (spotPriceUsd <= 0 || !isFinite(spotPriceUsd)) {
      throw new Error(
        `Spot price invalid: ${spotPriceUsd} ` +
        `(quoteReserveHuman=${quoteReserveHuman} gemReserveHuman=${gemReserveHuman} quotePriceUsd=${quotePriceUsd})`,
      );
    }

    // Slippage probes using constant-product math with fee
    // V2 Uniswap: amountOut = amountInWithFee * reserveOut / (reserveIn + amountInWithFee)
    //             where amountInWithFee = amountIn * (10000 - feeBps) / 10000
    const slippages = PROBE_SIZES_USD.map((sizeUsd) => {
      const amountInHuman  = sizeUsd / spotPriceUsd;          // gem tokens
      const amountInRaw    = decimalToRawAmount(amountInHuman, gemDec);

      const amountInWithFee = (amountInRaw * BigInt(10000 - feeBps)) / 10000n;

      const actualOutRaw   = (amountInWithFee * quoteReserveRaw) /
                              (gemReserveRaw + amountInWithFee);
      const actualOutUsd   = rawToDecimalNumber(actualOutRaw, quoteDec) * quotePriceUsd;
      const expectedOutUsd = amountInHuman * spotPriceUsd;

      return 1 - actualOutUsd / expectedOutUsd;
    });

    const [slip20, slip50, slip100, slip500, slip1000] = slippages;
    const quoteInRaw = decimalToRawAmount(PROBE_SIZES_USD[0] / quotePriceUsd, quoteDec);
    const quoteInWithFee = (quoteInRaw * BigInt(10000 - feeBps)) / 10000n;
    const gemOutRaw = (quoteInWithFee * gemReserveRaw) / (quoteReserveRaw + quoteInWithFee);
    const gemOutUsd = rawToDecimalNumber(gemOutRaw, gemDec) * spotPriceUsd;
    const entrySlip20 = 1 - gemOutUsd / PROBE_SIZES_USD[0];

    let executableDepthUsd = 0;
    for (let i = PROBE_SIZES_USD.length - 1; i >= 0; i--) {
      if ((slippages[i] ?? 1) < MAX_SLIPPAGE_FOR_DEPTH) {
        executableDepthUsd = PROBE_SIZES_USD[i];
        break;
      }
    }

    return {
      onchainTvlUsd, spotPriceUsd,
      slip20: Math.max(slip20, entrySlip20), entrySlip20, exitSlip20: slip20,
      slip50, slip100, slip500, slip1000, executableDepthUsd,
    };
  }

  async quoteTrade(
    pool: CandidatePool,
    gemDecimals: number,
    feeBps: number,
    sizeUsd: number,
    direction: ExecutionQuoteDirection,
  ): Promise<ExecutionQuoteResult> {
    const observedAt = new Date();
    if (!(sizeUsd > 0)) {
      return {
        liquidityModel: 'V2', direction, sizeUsd, spotPriceUsd: null,
        slippagePct: null, executable: false, observedAt, error: 'invalid_trade_size',
      };
    }
    try {
      const liquidity = await this.readLiquidity(pool, gemDecimals, feeBps);
      // In a constant-product pool both directions have the same spot-normalized
      // impact. The quote side reserve is exactly half the USD TVL.
      const quoteReserveUsd = liquidity.onchainTvlUsd / 2;
      const amountAfterFeeUsd = sizeUsd * Math.max(0, 1 - feeBps / 10_000);
      const outputAtSpotUsd = amountAfterFeeUsd * quoteReserveUsd / (quoteReserveUsd + amountAfterFeeUsd);
      const slippagePct = 1 - outputAtSpotUsd / sizeUsd;
      return {
        liquidityModel: 'V2', direction, sizeUsd,
        spotPriceUsd: liquidity.spotPriceUsd,
        slippagePct,
        executable: Number.isFinite(slippagePct) && slippagePct < 1,
        observedAt,
      };
    } catch (error) {
      return {
        liquidityModel: 'V2', direction, sizeUsd, spotPriceUsd: null,
        slippagePct: null, executable: false, observedAt, error: (error as Error).message,
      };
    }
  }

  /** Read decimals of the gem token on-chain (fallback when not in CandidateToken). */
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
