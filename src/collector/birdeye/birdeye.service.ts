import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import axiosRetry from 'axios-retry';
import { SupportedChain, TokenProbe } from '../collector.types';

const BIRDEYE_CHAIN: Record<SupportedChain, string> = {
  ethereum: 'ethereum',
  base: 'base',
};

@Injectable()
export class BirdeyeService {
  private readonly logger = new Logger(BirdeyeService.name);
  private readonly http: AxiosInstance;
  private readonly apiKey?: string;
  private readonly limit: number;

  constructor(private readonly config: ConfigService) {
    this.apiKey = this.config.get<string>('api.birdeyeApiKey') || undefined;
    this.limit = this.config.get<number>('api.birdeyeTokenListLimit') ?? 50;
    this.http = axios.create({
      baseURL: this.config.get<string>('api.birdeyeBaseUrl') ?? 'https://public-api.birdeye.so',
      timeout: 30_000,
      headers: this.apiKey ? { 'X-API-KEY': this.apiKey } : undefined,
    });

    axiosRetry(this.http, {
      retries: 2,
      retryDelay: (count) => axiosRetry.exponentialDelay(count),
      retryCondition: (err) =>
        axiosRetry.isNetworkOrIdempotentRequestError(err) ||
        err.response?.status === 429 ||
        (err.response?.status ?? 0) >= 500,
      onRetry: (count, err, cfg) =>
        this.logger.warn(`Birdeye retry ${count} for ${cfg.url}: ${err.message}`),
    });
  }

  async getVolumeTokenAddresses(chains: SupportedChain[]): Promise<TokenProbe[]> {
    if (!this.apiKey) return [];

    const out: TokenProbe[] = [];
    for (const chain of chains) {
      try {
        const res = await this.http.get<unknown>('/defi/tokenlist', {
          headers: { 'x-chain': BIRDEYE_CHAIN[chain] },
          params: {
            sort_by: 'v24hUSD',
            sort_type: 'desc',
            offset: 0,
            limit: this.limit,
            min_liquidity: 1000,
          },
        });
        for (const tokenAddress of this.extractTokenAddresses(res.data)) {
          out.push({ chain, tokenAddress });
        }
      } catch (err) {
        this.logger.warn(`Birdeye tokenlist fetch failed for ${chain}: ${(err as Error).message}`);
      }
    }
    return out;
  }

  private extractTokenAddresses(payload: unknown): string[] {
    const arrays = this.findArrays(payload);
    const addresses = new Set<string>();
    for (const arr of arrays) {
      for (const item of arr) {
        if (!item || typeof item !== 'object') continue;
        const rec = item as Record<string, unknown>;
        const raw = rec.address ?? rec.token_address ?? rec.tokenAddress;
        if (typeof raw === 'string' && /^0x[a-fA-F0-9]{40}$/.test(raw)) {
          addresses.add(raw.toLowerCase());
        }
      }
    }
    return [...addresses];
  }

  private findArrays(value: unknown): unknown[][] {
    if (Array.isArray(value)) return [value];
    if (!value || typeof value !== 'object') return [];
    const out: unknown[][] = [];
    for (const child of Object.values(value as Record<string, unknown>)) {
      out.push(...this.findArrays(child));
    }
    return out;
  }
}
