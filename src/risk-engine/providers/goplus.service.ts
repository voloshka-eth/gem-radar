import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import axiosRetry from 'axios-retry';
import { GoPlusApiResponse, GoPlusLpHolder, GoPlusTokenResult } from './goplus.types';
import { NormalizedRiskData } from '../risk-engine.types';
import { SupportedChain } from '../../collector/collector.types';

const CHAIN_ID_MAP: Record<SupportedChain, string> = {
  ethereum: '1',
  base: '8453',
};

// Dead / zero addresses count as LP locked regardless of is_locked flag.
const DEAD_LP_ADDRESSES = new Set([
  '0x0000000000000000000000000000000000000000',
  '0x000000000000000000000000000000000000dead',
]);

// Tags GoPlus uses for known time-locks and burn addresses.
const LOCK_TAGS = new Set([
  'Dead Wallet', 'Burned', 'Unicrypt', 'Team Finance', 'UNCX',
  'PinkLock', 'DxSale', 'Mudra', 'TrustSwap',
]);

// GoPlus lp_holders[].percent is a decimal fraction (e.g. "0.95" = 95%), not a percentage.
// LP_LOCK_THRESHOLD = 0.5 means at least 50% of LP must be on dead/locked addresses.
const LP_LOCK_THRESHOLD = 0.5;

@Injectable()
export class GoPlusService {
  private readonly logger = new Logger(GoPlusService.name);
  private readonly http: AxiosInstance;
  private readonly baseUrl: string;
  // TODO: add private readonly appKey/appSecret here once access-token flow is implemented

  // Per-instance rate limiter.
  // Anon tier: ~30 req/min → 2 s minimum spacing.
  // TODO: raise to 200 ms once access-token auth is implemented (paid tier is 300 req/min).
  private lastCallAt = 0;
  private readonly minIntervalMs = 2_000;

  constructor(private readonly config: ConfigService) {
    this.baseUrl =
      this.config.get<string>('api.goplusBaseUrl') ?? 'https://api.gopluslabs.io';
    this.http = axios.create({ timeout: 10_000 });
    axiosRetry(this.http, { retries: 2, retryDelay: axiosRetry.exponentialDelay });
  }

  /**
   * Query GoPlus token security for a single address.
   * Returns normalized risk data, or null if the request failed / response was malformed.
   *
   * Auth (TODO): GoPlus requires an access-token obtained by signing:
   *   sha1(GOPLUS_APP_KEY + unix_time_seconds + GOPLUS_APP_SECRET)
   *   → POST /api/v1/token_security/support/access_token
   *   → cache the returned access_token (TTL ~59 s)
   *   → send as Authorization header on token_security requests.
   * Until that flow is implemented, requests run on the anon tier (30 req/min).
   * Do NOT send GOPLUS_API_KEY directly — a raw key in Authorization returns 401,
   * which is worse than no header at all (anon tier continues to work without it).
   */
  async checkToken(
    chain: SupportedChain,
    tokenAddress: string,
  ): Promise<NormalizedRiskData | null> {
    const chainId = CHAIN_ID_MAP[chain];
    if (!chainId) {
      this.logger.warn(`GoPlus: unsupported chain "${chain}"`);
      return null;
    }

    await this.throttle();

    try {
      const { data } = await this.http.get<GoPlusApiResponse>(
        `${this.baseUrl}/api/v1/token_security/${chainId}`,
        {
          params: { contract_addresses: tokenAddress.toLowerCase() },
          // No Authorization header — anon tier until access-token flow is implemented.
        },
      );

      if (data.code !== 1 || !data.result) {
        this.logger.warn(
          `GoPlus: non-ok response for ${tokenAddress} — code: ${data.code}, msg: ${data.message}`,
        );
        return null;
      }

      const key = Object.keys(data.result)[0];
      if (!key) {
        this.logger.warn(`GoPlus: empty result object for ${tokenAddress}`);
        return null;
      }

      return this.normalize(data.result[key]);
    } catch (err) {
      this.logger.warn(
        `GoPlus: request failed for ${tokenAddress} — ${(err as Error).message}`,
      );
      return null;
    }
  }

  private async throttle(): Promise<void> {
    const now = Date.now();
    const wait = this.minIntervalMs - (now - this.lastCallAt);
    if (wait > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, wait));
    }
    this.lastCallAt = Date.now();
  }

  private normalize(r: GoPlusTokenResult): NormalizedRiskData {
    const flag = (s?: string): boolean | undefined =>
      s === '1' ? true : s === '0' ? false : undefined;

    // GoPlus buy_tax / sell_tax are decimal fractions: "0.05" = 5 %
    const tax = (s?: string): number | undefined =>
      s !== undefined && s !== '' ? parseFloat(s) * 100 : undefined;

    // owner_address === '' is AMBIGUOUS (proxy may hide the real owner).
    // Empty string → undefined (not "renounced"). Only zero/dead address = renounced.
    const addr = (r.owner_address ?? '').toLowerCase();
    const ownerRenounced: boolean | undefined =
      r.owner_address !== undefined && r.owner_address !== ''
        ? addr === '0x0000000000000000000000000000000000000000' ||
          addr === '0x000000000000000000000000000000000000dead'
        : undefined;

    // LP lock: count weighted % of LP supply on dead/locked addresses.
    // is_contract alone does NOT count (any contract could hold LP — including
    // malicious ones).  Only is_locked===1, known dead addresses, or lock tags qualify.
    const lpLockedOrBurned = this.calcLpLocked(r.lp_holders);

    // cannot_sell_all or is_honeypot both block selling
    const cannotSellAll = flag(r.cannot_sell_all);
    const isHoneypot = flag(r.is_honeypot);
    const canSell: boolean | undefined =
      isHoneypot === true || cannotSellAll === true ? false : undefined;

    // slippage_modifiable OR personal_slippage_modifiable → fee-change risk
    const slipMod = flag(r.slippage_modifiable);
    const persSlipMod = flag(r.personal_slippage_modifiable);
    const feeModifiableRisk: boolean | undefined =
      slipMod === true || persSlipMod === true
        ? true
        : slipMod === false && persSlipMod === false
          ? false
          : undefined;

    return {
      verified: flag(r.is_open_source),
      honeypot: isHoneypot,
      canSell,
      buyTax: tax(r.buy_tax),
      sellTax: tax(r.sell_tax),
      mintRisk: flag(r.is_mintable),
      blacklistRisk: flag(r.is_blacklisted),
      pauseRisk: flag(r.transfer_pausable),
      proxyRisk: flag(r.is_proxy),
      ownerPrivilegeRisk: flag(r.can_take_back_ownership),
      feeModifiableRisk,
      tradingCooldownRisk: flag(r.trading_cooldown),
      hiddenOwnerRisk: flag(r.hidden_owner),
      selfdestructRisk: flag(r.selfdestruct),
      antiWhaleModifiableRisk: flag(r.anti_whale_modifiable),
      ownerRenounced,
      lpLockedOrBurned,
    };
  }

  private calcLpLocked(holders?: GoPlusLpHolder[]): boolean | undefined {
    if (!holders || holders.length === 0) return undefined;

    const lockedPct = holders
      .filter((h) => {
        const hAddr = (h.address ?? '').toLowerCase();
        const isKnownDead = DEAD_LP_ADDRESSES.has(hAddr);
        const isExplicitLock = h.is_locked === 1;
        const hasLockTag = h.tag ? LOCK_TAGS.has(h.tag) : false;
        return isKnownDead || isExplicitLock || hasLockTag;
      })
      .reduce((sum, h) => sum + parseFloat(h.percent ?? '0'), 0);

    return lockedPct >= LP_LOCK_THRESHOLD;
  }
}
