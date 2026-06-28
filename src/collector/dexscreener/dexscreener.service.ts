import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import axiosRetry from 'axios-retry';
import {
  DsTokenProfilesResponse,
  DsTokenResponse,
  DsPair,
  DS_CHAIN_MAP,
} from './dexscreener.types';
import {
  CollectorResult,
  SupportedChain,
  QUOTE_ASSET_MAP,
} from '../collector.types';

// DexScreener free-tier rate limit is ~30 req/min. We add a small delay
// between batched token lookups to stay well under the limit.
const BATCH_SIZE = 30; // addresses per /tokens call (DS supports up to 30)
const INTER_REQUEST_DELAY_MS = 2_000;

@Injectable()
export class DexScreenerService {
  private readonly logger = new Logger(DexScreenerService.name);
  private readonly http: AxiosInstance;

  constructor(private readonly config: ConfigService) {
    const baseURL = this.config.get<string>('api.dexscreenerBaseUrl');

    this.http = axios.create({ baseURL, timeout: 30_000 });

    axiosRetry(this.http, {
      retries: 3,
      retryDelay: (count) => axiosRetry.exponentialDelay(count) + Math.random() * 1000,
      retryCondition: (err) =>
        axiosRetry.isNetworkOrIdempotentRequestError(err) ||
        err.response?.status === 429 ||
        (err.response?.status ?? 0) >= 500,
      onRetry: (count, err, cfg) =>
        this.logger.warn(`DexScreener retry ${count} for ${cfg.url}: ${err.message}`),
    });
  }

  // Fetch the latest token profiles (free endpoint — returns recently profiled tokens).
  // Returns addresses filtered to chains we care about.
  async getLatestProfileAddresses(chains: SupportedChain[]): Promise<
    Array<{ chain: SupportedChain; tokenAddress: string }>
  > {
    try {
      const res = await this.http.get<DsTokenProfilesResponse>(
        '/token-profiles/latest/v1',
      );
      const profiles = res.data ?? [];

      return profiles
        .filter((p) => {
          const mapped = DS_CHAIN_MAP[p.chainId];
          return mapped && (chains as string[]).includes(mapped);
        })
        .map((p) => ({
          chain: DS_CHAIN_MAP[p.chainId] as SupportedChain,
          tokenAddress: p.tokenAddress.toLowerCase(),
        }));
    } catch (err) {
      this.logger.error(`DexScreener /token-profiles/latest/v1 failed: ${(err as Error).message}`);
      return [];
    }
  }

  // Enrich a list of token addresses with pair data from DexScreener.
  // Groups into batches of BATCH_SIZE to stay under rate limits.
  async getPairsForTokens(
    addressList: Array<{ chain: SupportedChain; tokenAddress: string }>,
  ): Promise<CollectorResult[]> {
    const results: CollectorResult[] = [];

    // Chunk into batches
    for (let i = 0; i < addressList.length; i += BATCH_SIZE) {
      if (i > 0) await this.delay(INTER_REQUEST_DELAY_MS);

      const batch = addressList.slice(i, i + BATCH_SIZE);
      // DS allows comma-separated addresses in a single call only when on the same chain.
      // Group by chain first.
      const byChain = new Map<SupportedChain, string[]>();
      for (const { chain, tokenAddress } of batch) {
        if (!byChain.has(chain)) byChain.set(chain, []);
        byChain.get(chain)!.push(tokenAddress);
      }

      for (const [chain, addrs] of byChain) {
        const batchResults = await this.fetchPairsForChainBatch(chain, addrs);
        results.push(...batchResults);
      }
    }

    this.logger.debug(`DexScreener enriched ${results.length} candidates`);
    return results;
  }

  // ─── Private ─────────────────────────────────────────────────────────────────

  private async fetchPairsForChainBatch(
    chain: SupportedChain,
    tokenAddresses: string[],
  ): Promise<CollectorResult[]> {
    const joined = tokenAddresses.join(',');
    try {
      const res = await this.http.get<DsTokenResponse>(
        `/latest/dex/tokens/${joined}`,
      );
      const pairs = res.data?.pairs ?? [];
      const results: CollectorResult[] = [];

      for (const pair of pairs) {
        // DS /tokens/{addr} returns pairs from ALL chains for that address.
        // Skip pairs whose real chainId doesn't match our query chain — otherwise
        // multichain/bridge tokens corrupt pool rows with the wrong chain label.
        if (DS_CHAIN_MAP[pair.chainId] !== chain) {
          this.logger.debug(
            `DexScreener: skipping pair ${pair.pairAddress} — chain mismatch (pair.chainId=${pair.chainId}, queried=${chain})`,
          );
          continue;
        }
        const result = this.normalisePair(chain, pair);
        if (result) results.push(result);
      }
      return results;
    } catch (err) {
      this.logger.error(
        `DexScreener /tokens batch fetch failed for ${chain}: ${(err as Error).message}`,
      );
      return [];
    }
  }

  private normalisePair(chain: SupportedChain, pair: DsPair): CollectorResult | null {
    const quoteAssetMap = QUOTE_ASSET_MAP[chain];
    if (!quoteAssetMap) return null;

    const baseAddr = pair.baseToken.address.toLowerCase();
    const quoteAddr = pair.quoteToken.address.toLowerCase();

    const quoteAssetFromQuote = quoteAssetMap[quoteAddr]; // normal:   GEM/WETH
    const quoteAssetFromBase = quoteAssetMap[baseAddr];   // reversed: WETH/GEM

    if (!quoteAssetFromQuote && !quoteAssetFromBase) return null;

    const isReversed = !quoteAssetFromQuote && !!quoteAssetFromBase;
    const quoteAssetName = isReversed ? quoteAssetFromBase : quoteAssetFromQuote;
    const quoteAssetAddress = isReversed ? baseAddr : quoteAddr;
    const gemToken = isReversed ? pair.quoteToken : pair.baseToken;
    const gemAddr = gemToken.address.toLowerCase();

    // DexScreener priceUsd always references the baseToken.
    // In reversed pairs (WETH/GEM) priceUsd is WETH's price, not the gem's.
    // We cannot compute gem price without current WETH spot — leave it undefined.
    const priceUsd = isReversed
      ? undefined
      : pair.priceUsd != null
        ? parseFloat(pair.priceUsd)
        : undefined;

    return {
      token: {
        chain,
        tokenAddress: gemAddr,
        symbol: gemToken.symbol,
        name: gemToken.name,
        source: 'dexscreener',
      },
      pool: {
        chain,
        poolAddress: pair.pairAddress.toLowerCase(),
        dex: pair.dexId,
        token0Address: baseAddr,
        token1Address: quoteAddr,
        quoteAsset: quoteAssetName!,
        quoteAssetAddress,
        priceUsd,
        liquidityUsd: pair.liquidity?.usd,
        fdvUsd: pair.fdv,
        vol5m: pair.volume.m5,
        vol1h: pair.volume.h1,
        vol6h: pair.volume.h6,
        vol24h: pair.volume.h24,
        buys1h: pair.txns.h1.buys,
        sells1h: pair.txns.h1.sells,
        txCount1h: pair.txns.h1.buys + pair.txns.h1.sells,
        poolCreatedAt: pair.pairCreatedAt ? new Date(pair.pairCreatedAt) : undefined,
        source: 'dexscreener',
      },
    };
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
