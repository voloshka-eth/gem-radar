import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import axiosRetry from 'axios-retry';
import {
  GtNewPoolsResponse,
  GtPool,
  GtIncluded,
  GtTokenAttributes,
  GT_NETWORK,
} from './geckoterminal.types';
import {
  CollectorResult,
  SupportedChain,
  QUOTE_ASSET_MAP,
} from '../collector.types';

export interface PoolTradeStats {
  buys: number;
  sells: number;
  uniqueBuyers: number;
  uniqueSellers: number;
  volumeUsd: number | null;   // total (GeckoTerminal does not split buy/sell volume)
  window: 'h1' | 'h6' | 'h24';
}

@Injectable()
export class GeckoTerminalService {
  private readonly logger = new Logger(GeckoTerminalService.name);
  private readonly http: AxiosInstance;

  constructor(private readonly config: ConfigService) {
    const baseURL = this.config.get<string>('api.geckoterminalBaseUrl');

    this.http = axios.create({
      baseURL,
      timeout: 30_000,
      headers: { Accept: 'application/json;version=20230302' },
    });

    axiosRetry(this.http, {
      retries: 3,
      retryDelay: (count) => axiosRetry.exponentialDelay(count) + Math.random() * 1000,
      retryCondition: (err) =>
        axiosRetry.isNetworkOrIdempotentRequestError(err) ||
        err.response?.status === 429 ||
        (err.response?.status ?? 0) >= 500,
      onRetry: (count, err, cfg) =>
        this.logger.warn(`GeckoTerminal retry ${count} for ${cfg.url}: ${err.message}`),
    });
  }

  async getNewPools(chain: SupportedChain): Promise<CollectorResult[]> {
    const network = GT_NETWORK[chain];
    if (!network) {
      this.logger.warn(`No GeckoTerminal network mapping for chain: ${chain}`);
      return [];
    }

    let data: GtNewPoolsResponse;
    try {
      const res = await this.http.get<GtNewPoolsResponse>(
        `/networks/${network}/new_pools`,
        { params: { include: 'base_token,quote_token,dex', page: 1 } },
      );
      data = res.data;
    } catch (err) {
      this.logger.error(
        `GeckoTerminal new_pools fetch failed for ${chain}: ${(err as Error).message}`,
      );
      return [];
    }

    const includedMap = this.buildIncludedMap(data.included ?? []);
    const results: CollectorResult[] = [];

    for (const pool of data.data) {
      const result = this.normalise(chain, pool, includedMap);
      if (result) results.push(result);
    }

    this.logger.debug(`GeckoTerminal fetched ${results.length} pools for ${chain}`);
    return results;
  }

  /**
   * Fetch CURRENT trade stats for a single pool (used by on-demand paper eval to
   * capture the sellers/buyers signal). Uses the 1h window, falling back to 6h then
   * 24h when 1h has no activity, so a quiet-but-not-dead pool still yields counts.
   * Note: GeckoTerminal exposes total volume only (no buy/sell split), so
   * sellVolumeUsd/buyVolumeUsd are left null — sellers/buyers counts are the signal.
   */
  async getPoolTradeStats(
    chain: SupportedChain,
    poolAddress: string,
  ): Promise<PoolTradeStats | null> {
    const network = GT_NETWORK[chain];
    if (!network) return null;
    try {
      const res = await this.http.get<{ data?: GtPool }>(
        `/networks/${network}/pools/${poolAddress.toLowerCase()}`,
      );
      const a = res.data?.data?.attributes;
      if (!a) return null;
      const t = a.transactions;
      const total = (b: { buys: number; sells: number }) => b.buys + b.sells;
      const bucket =
        total(t.h1) > 0 ? { ...t.h1, window: 'h1' as const } :
        total(t.h6) > 0 ? { ...t.h6, window: 'h6' as const } :
        { ...t.h24, window: 'h24' as const };
      const vol = { h1: a.volume_usd.h1, h6: a.volume_usd.h6, h24: a.volume_usd.h24 }[bucket.window];
      return {
        buys: bucket.buys,
        sells: bucket.sells,
        uniqueBuyers: bucket.buyers,
        uniqueSellers: bucket.sellers,
        volumeUsd: this.parseNum(vol) ?? null,
        window: bucket.window,
      };
    } catch (err) {
      this.logger.debug(`GeckoTerminal pool stats failed for ${chain}:${poolAddress}: ${(err as Error).message}`);
      return null;
    }
  }

  // ─── Private ─────────────────────────────────────────────────────────────────

  private normalise(
    chain: SupportedChain,
    pool: GtPool,
    includedMap: Map<string, GtIncluded>,
  ): CollectorResult | null {
    const quoteAssetMap = QUOTE_ASSET_MAP[chain];

    const baseTokenRef = pool.relationships.base_token.data.id;
    const quoteTokenRef = pool.relationships.quote_token.data.id;
    const dexRef = pool.relationships.dex.data.id;

    const baseTokenIncluded = includedMap.get(baseTokenRef);
    const quoteTokenIncluded = includedMap.get(quoteTokenRef);

    if (!baseTokenIncluded || !quoteTokenIncluded) {
      this.logger.debug(`Missing included token data for pool ${pool.attributes.address}`);
      return null;
    }

    const baseAttrs = baseTokenIncluded.attributes as GtTokenAttributes;
    const quoteAttrs = quoteTokenIncluded.attributes as GtTokenAttributes;

    const baseAddr = baseAttrs.address.toLowerCase();
    const quoteAddr = quoteAttrs.address.toLowerCase();
    const poolAddr = pool.attributes.address.toLowerCase();

    // Determine which side is the quote asset
    const quoteAssetName = quoteAssetMap[quoteAddr];
    const baseIsActuallyQuote = !quoteAssetName && !!quoteAssetMap[baseAddr];

    // We only care if one side is a known quote asset
    const resolvedQuoteAddr = quoteAssetName ? quoteAddr : (baseIsActuallyQuote ? baseAddr : null);
    const resolvedQuoteAsset = resolvedQuoteAddr ? (quoteAssetMap[resolvedQuoteAddr] ?? null) : null;

    const gemAddr = quoteAssetName ? baseAddr : (baseIsActuallyQuote ? quoteAddr : null);
    const gemAttrs = quoteAssetName ? baseAttrs : (baseIsActuallyQuote ? quoteAttrs : null);

    if (!resolvedQuoteAsset || !gemAddr || !gemAttrs) {
      return null; // Neither side is a known quote asset — skip (Stage 0 will catch this too)
    }

    const a = pool.attributes;
    const dexName = (includedMap.get(dexRef)?.attributes as { name?: string } | undefined)?.name ?? dexRef;

    return {
      token: {
        chain,
        tokenAddress: gemAddr,
        symbol: gemAttrs.symbol ?? '',
        name: gemAttrs.name ?? '',
        decimals: gemAttrs.decimals,
        source: 'geckoterminal',
      },
      pool: {
        chain,
        poolAddress: poolAddr,
        dex: dexName,
        token0Address: baseAddr,
        token1Address: quoteAddr,
        quoteAsset: resolvedQuoteAsset,
        quoteAssetAddress: resolvedQuoteAddr!,
        // gem is baseToken (normal): use base_token_price_usd
        // gem is quoteToken (reversed, e.g. WETH/GEM): use quote_token_price_usd
        priceUsd: quoteAssetName !== undefined
          ? this.parseNum(a.base_token_price_usd)
          : this.parseNum(a.quote_token_price_usd),
        liquidityUsd: this.parseNum(a.reserve_in_usd),
        fdvUsd: this.parseNum(a.fdv_usd),
        vol5m: this.parseNum(a.volume_usd.m5),
        vol1h: this.parseNum(a.volume_usd.h1),
        vol6h: this.parseNum(a.volume_usd.h6),
        vol24h: this.parseNum(a.volume_usd.h24),
        buys1h: a.transactions.h1.buys,
        sells1h: a.transactions.h1.sells,
        txCount1h: a.transactions.h1.buys + a.transactions.h1.sells,
        poolCreatedAt: a.pool_created_at ? new Date(a.pool_created_at) : undefined,
        source: 'geckoterminal',
      },
    };
  }

  private buildIncludedMap(included: GtIncluded[]): Map<string, GtIncluded> {
    const map = new Map<string, GtIncluded>();
    for (const item of included) {
      map.set(item.id, item);
    }
    return map;
  }

  private parseNum(value: string | null | undefined): number | undefined {
    if (!value) return undefined;
    const n = parseFloat(value);
    return isNaN(n) ? undefined : n;
  }
}
