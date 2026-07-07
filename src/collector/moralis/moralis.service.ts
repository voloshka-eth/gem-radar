import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import axiosRetry from 'axios-retry';
import { SupportedChain, TokenProbe } from '../collector.types';

interface MoralisTrendingToken {
  chainId?: string;
  chain_id?: string;
  tokenAddress?: string;
  token_address?: string;
}

const MORALIS_CHAIN: Record<SupportedChain, string> = {
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
    if (!this.apiKey) return [];

    const out: TokenProbe[] = [];
    for (const chain of chains) {
      try {
        const res = await this.http.get<MoralisTrendingToken[]>('/tokens/trending', {
          params: { chain: MORALIS_CHAIN[chain], limit: this.limit },
        });
        for (const item of res.data ?? []) {
          const tokenAddress = (item.tokenAddress ?? item.token_address)?.toLowerCase();
          const rawChain = item.chainId ?? item.chain_id;
          const resolvedChain = rawChain ? this.resolveChain(rawChain) : chain;
          if (tokenAddress && resolvedChain === chain) out.push({ chain, tokenAddress });
        }
      } catch (err) {
        this.logger.warn(`Moralis trending fetch failed for ${chain}: ${(err as Error).message}`);
      }
    }
    return out;
  }

  private resolveChain(value: string | undefined): SupportedChain | null {
    if (!value) return null;
    return CHAIN_ID_TO_CHAIN[value.toLowerCase()] ?? null;
  }
}
