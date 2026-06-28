import { Injectable, Logger, Inject } from '@nestjs/common';
import axios from 'axios';
import Redis from 'ioredis';
import type { SupportedChain } from '../collector/collector.types';
import { ONCHAIN_REDIS_CLIENT, DEFILLAMA_CHAIN } from './onchain.constants';

const CACHE_TTL_S = 120; // 2 minutes — price changes per block

@Injectable()
export class PriceService {
  private readonly logger = new Logger(PriceService.name);

  constructor(
    @Inject(ONCHAIN_REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  /**
   * Returns the USD price of a token from DefiLlama, or null on failure.
   * Used to price quote assets (WETH, USDC, etc.) for TVL / slippage math.
   */
  async getUsdPrice(chain: SupportedChain, tokenAddress: string): Promise<number | null> {
    const llamaChain = DEFILLAMA_CHAIN[chain];
    if (!llamaChain) return null;

    const coinId = `${llamaChain}:${tokenAddress}`;
    const cacheKey = `price:v1:${coinId}`;

    try {
      const cached = await this.redis.get(cacheKey);
      if (cached !== null) return parseFloat(cached);
    } catch { /* Redis offline — proceed */ }

    const price = await this.fetchFromLlama(coinId);
    if (price === null) return null;

    try {
      await this.redis.setex(cacheKey, CACHE_TTL_S, String(price));
    } catch { /* ignore */ }

    return price;
  }

  private async fetchFromLlama(coinId: string): Promise<number | null> {
    try {
      const res = await axios.get<DefiLlamaResponse>(
        `https://coins.llama.fi/prices/current/${encodeURIComponent(coinId)}`,
        { timeout: 5_000 },
      );
      const entry = res.data?.coins?.[coinId];
      if (!entry?.price || typeof entry.price !== 'number') return null;
      return entry.price;
    } catch (err) {
      this.logger.debug(`DefiLlama price fetch failed for ${coinId}: ${(err as Error).message}`);
      return null;
    }
  }
}

interface DefiLlamaResponse {
  coins: Record<string, { price: number; symbol: string; timestamp: number; confidence: number }>;
}
