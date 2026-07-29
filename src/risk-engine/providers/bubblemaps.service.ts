import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import axiosRetry from 'axios-retry';
import type { SupportedChain } from '../../collector/collector.types';
import {
  evaluateBubblemapsClusterGate,
  type BubblemapsClusterGateResult,
} from '../bubblemaps-cluster-gate';

const CHAIN_ID_MAP: Partial<Record<SupportedChain, string>> = {
  ethereum: 'eth',
  base: 'base',
  robinhood: 'robinhood',
};

export interface BubblemapsMapAssessment {
  available: boolean;
  skipped: boolean;
  skipReason: string | null;
  gate: BubblemapsClusterGateResult | null;
  hardReason: string | null;
  raw: Record<string, unknown> | null;
}

@Injectable()
export class BubblemapsService {
  private readonly logger = new Logger(BubblemapsService.name);
  private readonly http: AxiosInstance;
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly enabled: boolean;
  private readonly timeoutMs: number;

  constructor(private readonly config: ConfigService) {
    this.baseUrl = this.config.get<string>('api.bubblemapsBaseUrl') ?? 'https://api.bubblemaps.io';
    this.apiKey = this.config.get<string>('api.bubblemapsApiKey') || undefined;
    this.enabled = this.config.get<boolean>('api.bubblemapsEnabled') === true;
    this.timeoutMs = this.config.get<number>('api.bubblemapsTimeoutMs') ?? 15_000;
    this.http = axios.create({ timeout: this.timeoutMs });
    axiosRetry(this.http, {
      retries: 1,
      retryDelay: axiosRetry.exponentialDelay,
      retryCondition: (err) =>
        axiosRetry.isNetworkOrIdempotentRequestError(err) ||
        err.response?.status === 429,
    });
  }

  supportsChain(chain: SupportedChain): boolean {
    return Boolean(CHAIN_ID_MAP[chain]);
  }

  /**
   * Hard cluster concentration check. Fail-open when disabled / no key / API miss
   * so paper collection continues; enforcement requires BUBBLEMAPS_ENABLED=true
   * and a valid API key.
   */
  async assessTokenCluster(chain: SupportedChain, tokenAddress: string): Promise<BubblemapsMapAssessment> {
    if (!this.enabled) {
      return this.skipped('bubblemaps_disabled');
    }
    if (!this.apiKey) {
      this.logger.warn('Bubblemaps enabled but BUBBLEMAPS_API_KEY is empty — gate skipped');
      return this.skipped('bubblemaps_api_key_missing');
    }
    const chainId = CHAIN_ID_MAP[chain];
    if (!chainId) return this.skipped('bubblemaps_chain_unsupported');

    try {
      const url = `${this.baseUrl}/v0/tokens/map/${chainId}/${tokenAddress}`;
      const response = await this.http.get(url, {
        headers: { 'X-ApiKey': this.apiKey },
        params: {
          limit: 80,
          return_clusters: true,
          return_nodes: true,
          return_relationships: false,
          use_magic_nodes: true,
          use_time_nodes: true,
        },
      });
      const data = response.data ?? {};
      const clusters = Array.isArray(data.clusters)
        ? data.clusters.map((cluster: any) => ({
            share: Number(cluster.share),
            holders: Array.isArray(cluster.holders) ? cluster.holders.map(String) : [],
          }))
        : [];
      const topHolders = Array.isArray(data.nodes?.top_holders) ? data.nodes.top_holders : [];
      const holders = topHolders.map((node: any) => ({
        address: String(node.address ?? ''),
        share: Number(node.holder_data?.share ?? 0),
        isDex: Boolean(node.address_details?.is_dex),
      })).filter((h: { address: string }) => h.address.length > 0);

      const dexSupplyShare = Number(data.metrics?.supply_stats?.dexs);
      const gate = evaluateBubblemapsClusterGate({
        clusters,
        holders,
        dexSupplyShare: Number.isFinite(dexSupplyShare) ? dexSupplyShare : null,
      });
      const hardReason = gate.blocked
        ? `bubblemaps_cluster:${gate.reasons.join('|')}`
        : null;
      if (hardReason) {
        this.logger.warn(
          `Bubblemaps cluster block ${chain}:${tokenAddress} ` +
          `incl=${gate.topClusterShareInclLp?.toFixed(3)} ` +
          `exLp=${gate.topClusterShareExLp?.toFixed(3)} ` +
          `dex=${gate.dexSupplyShare.toFixed(3)} reasons=${gate.reasons.join(',')}`,
        );
      }
      return {
        available: true,
        skipped: false,
        skipReason: null,
        gate,
        hardReason,
        raw: {
          dtUpdate: data.metadata?.dt_update ?? null,
          clusterCount: clusters.length,
          dexSupplyShare: Number.isFinite(dexSupplyShare) ? dexSupplyShare : null,
          topClusterShareInclLp: gate.topClusterShareInclLp,
          topClusterShareExLp: gate.topClusterShareExLp,
          reasons: gate.reasons,
          warnings: gate.warnings,
        },
      };
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 404) return this.unavailable('bubblemaps_map_not_found', status);
      if (status === 400) return this.unavailable('bubblemaps_token_unsupported', status);
      if (status === 429) return this.unavailable('bubblemaps_rate_limited', status);
      this.logger.warn(
        `Bubblemaps map failed ${chain}:${tokenAddress}: ${err?.message ?? err}`,
      );
      return this.unavailable('bubblemaps_request_failed', status);
    }
  }

  private skipped(reason: string): BubblemapsMapAssessment {
    return {
      available: false,
      skipped: true,
      skipReason: reason,
      gate: null,
      hardReason: null,
      raw: { skipReason: reason },
    };
  }

  private unavailable(reason: string, status?: number): BubblemapsMapAssessment {
    return {
      available: false,
      skipped: false,
      skipReason: reason,
      gate: null,
      hardReason: null,
      raw: { skipReason: reason, httpStatus: status ?? null },
    };
  }
}
