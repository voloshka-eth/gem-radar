import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import axiosRetry from 'axios-retry';
import { SupportedChain, TokenProbe } from '../collector.types';

interface MoralisTrendingToken {
  chainId?: string;
  chain_id?: string;
  chain?: string;
  tokenAddress?: string;
  token_address?: string;
  address?: string;
  token?: {
    chainId?: string;
    chain_id?: string;
    chain?: string;
    tokenAddress?: string;
    token_address?: string;
    address?: string;
  };
}

type MoralisTrendingResponse =
  | MoralisTrendingToken[]
  | {
      result?: MoralisTrendingResponse;
      data?: MoralisTrendingResponse;
      tokens?: MoralisTrendingToken[];
    };

export interface MoralisFetchSummary {
  enabled: boolean;
  requestedChains: number;
  returned: number;
  errors: number;
  lastStatus?: string;
  lastError?: string;
  authBackoffRemainingMs?: number;
}

const MORALIS_CHAIN: Partial<Record<SupportedChain, string>> = {
  ethereum: 'eth',
  base: 'base',
};

const CHAIN_ID_TO_CHAIN: Record<string, SupportedChain> = {
  eth: 'ethereum',
  ethereum: 'ethereum',
  '0x1': 'ethereum',
  '1': 'ethereum',
  base: 'base',
  '0x2105': 'base',
  '8453': 'base',
};

@Injectable()
export class MoralisService {
  private readonly logger = new Logger(MoralisService.name);
  private readonly http: AxiosInstance;
  private readonly apiKey?: string;
  private readonly limit: number;
  private authBackoffUntil = 0;
  private lastSummary: MoralisFetchSummary = {
    enabled: false,
    requestedChains: 0,
    returned: 0,
    errors: 0,
  };

  constructor(private readonly config: ConfigService) {
    this.apiKey = this.config.get<string>('api.moralisApiKey') || undefined;
    this.limit = this.config.get<number>('api.moralisTrendingLimit') ?? 50;
    this.http = axios.create({
      baseURL: this.config.get<string>('api.moralisBaseUrl') ?? 'https://deep-index.moralis.io/api/v2.2',
      timeout: 30_000,
      headers: this.apiKey ? { 'X-API-Key': this.apiKey } : undefined,
    });

    axiosRetry(this.http, {
      retries: 2,
      retryDelay: (count) => axiosRetry.exponentialDelay(count),
      retryCondition: (err) =>
        axiosRetry.isNetworkOrIdempotentRequestError(err) ||
        err.response?.status === 429 ||
        (err.response?.status ?? 0) >= 500,
      onRetry: (count, err, cfg) =>
        this.logger.warn(`Moralis retry ${count} for ${cfg.url}: ${err.message}`),
    });
  }

  async getTrendingTokenAddresses(chains: SupportedChain[]): Promise<TokenProbe[]> {
    const authBackoffRemainingMs = Math.max(0, this.authBackoffUntil - Date.now());
    const supportedChains = chains.filter((chain) => Boolean(MORALIS_CHAIN[chain]));
    this.lastSummary = {
      enabled: Boolean(this.apiKey),
      requestedChains: this.apiKey && authBackoffRemainingMs === 0 ? supportedChains.length : 0,
      returned: 0,
      errors: 0,
    };
    if (!this.apiKey) return [];
    if (authBackoffRemainingMs > 0) {
      this.lastSummary.lastStatus = 'AUTH_BACKOFF';
      this.lastSummary.lastError = 'Moralis credentials previously rejected';
      this.lastSummary.authBackoffRemainingMs = authBackoffRemainingMs;
      this.logger.warn(
        `Moralis auth backoff active for ${Math.ceil(authBackoffRemainingMs / 1000)}s - skipping trending fetch`,
      );
      return [];
    }

    const out: TokenProbe[] = [];
    for (const chain of supportedChains) {
      try {
        const res = await this.http.get<MoralisTrendingResponse>('/tokens/trending', {
          params: { chain: MORALIS_CHAIN[chain]!, limit: this.limit },
        });
        for (const item of this.unwrapTrendingResponse(res.data)) {
          const nested = item.token;
          const tokenAddress = (
            item.tokenAddress ??
            item.token_address ??
            item.address ??
            nested?.tokenAddress ??
            nested?.token_address ??
            nested?.address
          )?.toLowerCase();
          const rawChain =
            item.chainId ??
            item.chain_id ??
            item.chain ??
            nested?.chainId ??
            nested?.chain_id ??
            nested?.chain;
          const resolvedChain = rawChain ? this.resolveChain(rawChain) : chain;
          if (tokenAddress && resolvedChain === chain) out.push({ chain, tokenAddress });
        }
      } catch (err) {
        this.lastSummary.errors++;
        const status = this.errorStatus(err);
        this.lastSummary.lastStatus = status;
        this.lastSummary.lastError = (err as Error).message;
        this.logger.warn(
          `Moralis trending fetch failed for ${chain}${status ? ` (status=${status})` : ''}: ${(err as Error).message}`,
        );
        if (status === '401' || status === '403') {
          const backoffMs = Math.max(
            0,
            this.config.get<number>('api.moralisAuthBackoffMs') ?? 3_600_000,
          );
          this.authBackoffUntil = Date.now() + backoffMs;
          this.lastSummary.authBackoffRemainingMs = backoffMs;
          break;
        }
      }
    }
    const deduped = this.dedupe(out);
    this.lastSummary.returned = deduped.length;
    return deduped;
  }

  getLastFetchSummary(): MoralisFetchSummary {
    return { ...this.lastSummary };
  }

  private unwrapTrendingResponse(data: MoralisTrendingResponse | undefined): MoralisTrendingToken[] {
    if (!data) return [];
    if (Array.isArray(data)) return data;
    if (data.tokens) return data.tokens;
    return [
      ...this.unwrapTrendingResponse(data.result),
      ...this.unwrapTrendingResponse(data.data),
    ];
  }

  private resolveChain(value: string | undefined): SupportedChain | null {
    if (!value) return null;
    return CHAIN_ID_TO_CHAIN[value.toLowerCase()] ?? null;
  }

  private errorStatus(err: unknown): string | undefined {
    if (!axios.isAxiosError(err)) return undefined;
    return err.response?.status != null ? String(err.response.status) : undefined;
  }

  private dedupe(items: TokenProbe[]): TokenProbe[] {
    const seen = new Set<string>();
    return items.filter((item) => {
      const key = `${item.chain}:${item.tokenAddress}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
}
