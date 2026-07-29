import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import axiosRetry from 'axios-retry';
import type { SupportedChain } from '../../collector/collector.types';
import {
  evaluateHolderConcentrationGate,
  isBurnAddress,
  type HolderConcentrationGateResult,
  type HolderShareRow,
} from '../holder-concentration-gate';

const BLOCKSCOUT_BASE: Record<SupportedChain, string> = {
  ethereum: 'https://eth.blockscout.com',
  base: 'https://base.blockscout.com',
  robinhood: 'https://robinhoodchain.blockscout.com',
};

export interface FreeHolderAssessment {
  available: boolean;
  skipped: boolean;
  skipReason: string | null;
  source: 'blockscout' | 'geckoterminal' | null;
  gate: HolderConcentrationGateResult | null;
  hardReason: string | null;
  raw: Record<string, unknown> | null;
}

@Injectable()
export class FreeHolderConcentrationService {
  private readonly logger = new Logger(FreeHolderConcentrationService.name);
  private readonly http: AxiosInstance;
  private readonly enabled: boolean;
  private readonly timeoutMs: number;
  private readonly holderLimit: number;

  constructor(private readonly config: ConfigService) {
    this.enabled = this.config.get<boolean>('api.freeHolderGateEnabled') !== false;
    this.timeoutMs = this.config.get<number>('api.freeHolderGateTimeoutMs') ?? 12_000;
    this.holderLimit = Math.max(5, Math.min(50, this.config.get<number>('api.freeHolderGateLimit') ?? 20));
    this.http = axios.create({ timeout: this.timeoutMs });
    axiosRetry(this.http, {
      retries: 1,
      retryDelay: axiosRetry.exponentialDelay,
      retryCondition: (err) => axiosRetry.isNetworkOrIdempotentRequestError(err),
    });
  }

  /**
   * Free concentration check via Blockscout (primary) or GeckoTerminal top_10
   * (fallback). Fail-open when explorers have no data yet.
   */
  async assessToken(
    chain: SupportedChain,
    tokenAddress: string,
    poolAddress?: string | null,
  ): Promise<FreeHolderAssessment> {
    if (!this.enabled) {
      return this.skipped('free_holder_gate_disabled');
    }

    const blockscout = await this.fromBlockscout(chain, tokenAddress, poolAddress);
    if (blockscout.available) return blockscout;

    const gecko = await this.fromGeckoTerminal(chain, tokenAddress);
    if (gecko.available) return gecko;

    return {
      available: false,
      skipped: false,
      skipReason: blockscout.skipReason ?? gecko.skipReason ?? 'holders_unavailable',
      source: null,
      gate: null,
      hardReason: null,
      raw: {
        blockscout: blockscout.raw,
        geckoterminal: gecko.raw,
      },
    };
  }

  private async fromBlockscout(
    chain: SupportedChain,
    tokenAddress: string,
    poolAddress?: string | null,
  ): Promise<FreeHolderAssessment> {
    const base = BLOCKSCOUT_BASE[chain];
    if (!base) return this.skipped('blockscout_chain_unsupported');
    const token = tokenAddress.toLowerCase();
    const lp = poolAddress?.toLowerCase() ?? null;

    try {
      const [supplyRes, holdersRes] = await Promise.all([
        this.http.get(`${base}/api`, {
          params: { module: 'stats', action: 'tokensupply', contractaddress: token },
        }),
        this.http.get(`${base}/api`, {
          params: {
            module: 'token',
            action: 'getTokenHolders',
            contractaddress: token,
            page: 1,
            offset: this.holderLimit,
          },
        }),
      ]);

      const supplyRaw = String(supplyRes.data?.result ?? '');
      const supply = BigInt(supplyRaw || '0');
      if (!(supply > 0n) || supplyRes.data?.status !== '1') {
        return this.unavailable('blockscout_supply_missing', 'blockscout');
      }
      const rows = Array.isArray(holdersRes.data?.result) ? holdersRes.data.result : [];
      if (!rows.length || holdersRes.data?.status !== '1') {
        return this.unavailable('blockscout_holders_missing', 'blockscout');
      }

      const holders: HolderShareRow[] = rows.map((row: any) => {
        const address = String(row.address ?? '').toLowerCase();
        const value = BigInt(String(row.value ?? '0'));
        // Keep 6 decimal places of share without Number(bigint) overflow.
        const share = supply > 0n
          ? Number((value * 1_000_000n) / supply) / 1_000_000
          : 0;
        return {
          address,
          share: Number.isFinite(share) ? share : 0,
          isLp: Boolean(lp && address === lp),
          isBurn: isBurnAddress(address),
        };
      });

      // If pool wasn't in the top page, still try to credit LP via pair match later.
      const gate = evaluateHolderConcentrationGate({ holders });
      return this.fromGate(gate, 'blockscout', {
        supply: supplyRaw,
        holdersSampled: holders.length,
        topWalletShareExLp: gate.topWalletShareExLp,
        topWalletShareInclLp: gate.topWalletShareInclLp,
        lpShare: gate.lpShare,
        reasons: gate.reasons,
      });
    } catch (err: any) {
      this.logger.debug(`Blockscout holders failed ${chain}:${token}: ${err?.message ?? err}`);
      return this.unavailable('blockscout_request_failed', 'blockscout');
    }
  }

  private async fromGeckoTerminal(
    chain: SupportedChain,
    tokenAddress: string,
  ): Promise<FreeHolderAssessment> {
    const network = chain === 'ethereum' ? 'eth' : chain;
    const base = this.config.get<string>('api.geckoterminalBaseUrl')
      ?? 'https://api.geckoterminal.com/api/v2';
    try {
      const response = await this.http.get(
        `${base}/networks/${network}/tokens/${tokenAddress}/info`,
      );
      const attrs = response.data?.data?.attributes ?? {};
      const top10Pct = Number(attrs.holders?.distribution_percentage?.top_10);
      const top10 = Number.isFinite(top10Pct) ? top10Pct / 100 : null;
      const developerPct = Number(attrs.developer_holding_percentage);
      const developerShare = Number.isFinite(developerPct) ? developerPct / 100 : null;

      if (top10 == null && developerShare == null) {
        return this.unavailable('geckoterminal_holders_missing', 'geckoterminal');
      }

      // Gecko only exposes top_10 aggregate + optional developer %. Use the
      // stricter available signal as a single "wallet" proxy.
      const proxyShare = Math.max(top10 ?? 0, developerShare ?? 0);
      const holders: HolderShareRow[] = [{
        address: 'geckoterminal:top10_or_dev',
        share: proxyShare,
        isLp: false,
        isBurn: false,
      }];
      const gate = evaluateHolderConcentrationGate({ holders });
      return this.fromGate(gate, 'geckoterminal', {
        top10,
        developerShare,
        proxyShare,
        reasons: gate.reasons,
      });
    } catch (err: any) {
      this.logger.debug(`GeckoTerminal holders failed ${chain}:${tokenAddress}: ${err?.message ?? err}`);
      return this.unavailable('geckoterminal_request_failed', 'geckoterminal');
    }
  }

  private fromGate(
    gate: HolderConcentrationGateResult,
    source: 'blockscout' | 'geckoterminal',
    raw: Record<string, unknown>,
  ): FreeHolderAssessment {
    const hardReason = gate.blocked
      ? `holder_concentration:${gate.reasons.join('|')}`
      : null;
    if (hardReason) {
      this.logger.warn(
        `Free holder concentration block source=${source} ` +
        `exLp=${gate.topWalletShareExLp?.toFixed(3)} ` +
        `incl=${gate.topWalletShareInclLp?.toFixed(3)} ` +
        `lp=${gate.lpShare.toFixed(3)} reasons=${gate.reasons.join(',')}`,
      );
    }
    return {
      available: true,
      skipped: false,
      skipReason: null,
      source,
      gate,
      hardReason,
      raw: { source, ...raw },
    };
  }

  private skipped(reason: string): FreeHolderAssessment {
    return {
      available: false,
      skipped: true,
      skipReason: reason,
      source: null,
      gate: null,
      hardReason: null,
      raw: { skipReason: reason },
    };
  }

  private unavailable(
    reason: string,
    source: 'blockscout' | 'geckoterminal' | null,
  ): FreeHolderAssessment {
    return {
      available: false,
      skipped: false,
      skipReason: reason,
      source,
      gate: null,
      hardReason: null,
      raw: { skipReason: reason, source },
    };
  }
}
