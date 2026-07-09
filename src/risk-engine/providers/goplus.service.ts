import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import axiosRetry from 'axios-retry';
import { createHash } from 'crypto';
import {
  GoPlusAccessTokenResponse,
  GoPlusApiResponse,
  GoPlusLpHolder,
  GoPlusTokenResult,
} from './goplus.types';
import { NormalizedRiskData } from '../risk-engine.types';
import { SupportedChain } from '../../collector/collector.types';

const CHAIN_ID_MAP: Partial<Record<SupportedChain, string>> = {
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
  'Dead Wallet',
  'Burned',
  'Unicrypt',
  'Team Finance',
  'UNCX',
  'PinkLock',
  'DxSale',
  'Mudra',
  'TrustSwap',
]);

// GoPlus lp_holders[].percent is a decimal fraction (e.g. "0.95" = 95%).
// LP_LOCK_THRESHOLD = 0.5 means at least 50% of LP must be on dead/locked addresses.
const LP_LOCK_THRESHOLD = 0.5;

const CRITICAL_GOPLUS_FIELDS: Array<keyof GoPlusTokenResult> = [
  'is_honeypot',
  'is_mintable',
  'is_blacklisted',
  'is_proxy',
];

const EXPECTED_GOPLUS_FIELDS: Array<keyof GoPlusTokenResult> = [
  ...CRITICAL_GOPLUS_FIELDS,
  'buy_tax',
  'sell_tax',
  'can_take_back_ownership',
  'transfer_pausable',
  'owner_address',
];

const TRADE_SIGNAL_FIELDS: Array<keyof GoPlusTokenResult> = [
  'buy_tax',
  'sell_tax',
  'transfer_tax',
  'cannot_buy',
  'cannot_sell_all',
  'is_in_dex',
  'holder_count',
  'lp_holders',
  'dex',
  'holders',
];

const GOPLUS_BACKOFF_CODES = new Set(['4029', '5000']);

@Injectable()
export class GoPlusService {
  private readonly logger = new Logger(GoPlusService.name);
  private readonly http: AxiosInstance;
  private readonly baseUrl: string;
  private readonly appKey?: string;
  private readonly appSecret?: string;
  private accessToken?: string;
  private accessTokenExpiresAt = 0;
  private authFailedUntil = 0;

  // Keep conservative free-plan spacing unless explicitly overridden.
  private lastCallAt = 0;
  private minIntervalMs: number;
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;
  private readonly circuitBreakerMs: number;
  private providerBackoffUntil = 0;

  constructor(private readonly config: ConfigService) {
    this.baseUrl =
      this.config.get<string>('api.goplusBaseUrl') ?? 'https://api.gopluslabs.io';
    this.appKey =
      this.config.get<string>('api.goplusAppKey') ??
      this.config.get<string>('api.goplusApiKey');
    this.appSecret = this.config.get<string>('api.goplusAppSecret');
    this.minIntervalMs =
      this.config.get<number>('api.goplusMinIntervalMs') ?? 2_000;
    this.maxAttempts =
      Math.max(1, this.config.get<number>('api.goplusMaxAttempts') ?? 2);
    this.retryDelayMs =
      this.config.get<number>('api.goplusRetryDelayMs') ?? 2_500;
    this.circuitBreakerMs =
      Math.max(0, this.config.get<number>('api.goplusCircuitBreakerMs') ?? 60_000);
    this.http = axios.create({ timeout: 10_000 });
    axiosRetry(this.http, { retries: 2, retryDelay: axiosRetry.exponentialDelay });
  }

  supportsChain(chain: SupportedChain): boolean {
    return Boolean(CHAIN_ID_MAP[chain]);
  }

  /**
   * Query GoPlus token security for a single address.
   * Returns normalized risk data, or null if the request failed / response was malformed.
   *
   * Auth: GoPlus access-token is sha1(GOPLUS_APP_KEY + unix_time + GOPLUS_APP_SECRET).
   * The access token is cached and sent as Authorization. If auth fails, keep running
   * anonymous instead of sending a raw API key as Authorization.
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

    return this.checkTokenWithRetry(chainId, tokenAddress);
  }

  private async checkTokenWithRetry(
    chainId: string,
    tokenAddress: string,
  ): Promise<NormalizedRiskData | null> {
    const backoffRemainingMs = this.providerBackoffUntil - Date.now();
    if (backoffRemainingMs > 0) {
      this.logger.warn(
        `GoPlus: circuit breaker open for ${Math.ceil(backoffRemainingMs / 1000)}s - skipping ${tokenAddress}`,
      );
      return null;
    }

    let providerBackoffReason: string | null = null;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      await this.throttle();

      try {
        const authHeaders = await this.authHeaders();
        const { data } = await this.http.get<GoPlusApiResponse>(
          `${this.baseUrl}/api/v1/token_security/${chainId}`,
          {
            params: { contract_addresses: tokenAddress.toLowerCase() },
            ...(authHeaders ? { headers: authHeaders } : {}),
          },
        );

        if (data.code !== 1 || !data.result) {
          if (this.isProviderBackoffCode(data.code)) {
            providerBackoffReason = `code ${data.code}`;
          }
          this.logger.warn(
            `GoPlus: non-ok response for ${tokenAddress} - code: ${data.code}, msg: ${data.message}`,
          );
          if (attempt < this.maxAttempts) {
            await this.retryDelay(attempt);
            continue;
          }
          this.openProviderCircuitBreaker(providerBackoffReason);
          return null;
        }

        const key = Object.keys(data.result)[0];
        if (!key) {
          this.logger.warn(`GoPlus: empty result object for ${tokenAddress}`);
          if (attempt < this.maxAttempts) {
            await this.retryDelay(attempt);
            continue;
          }
          return null;
        }

        const normalized = this.normalize(data.result[key], tokenAddress);
        if (
          normalized.providerStatus === 'GOPLUS_PARSE_FAILED' &&
          attempt < this.maxAttempts
        ) {
          await this.retryDelay(attempt);
          continue;
        }
        return normalized;
      } catch (err) {
        providerBackoffReason = this.providerBackoffReasonFromError(err) ?? providerBackoffReason;
        this.logger.warn(
          `GoPlus: request failed for ${tokenAddress} - ${(err as Error).message}`,
        );
        if (attempt < this.maxAttempts) {
          await this.retryDelay(attempt);
          continue;
        }
        this.openProviderCircuitBreaker(providerBackoffReason);
        return null;
      }
    }

    return null;
  }

  private async authHeaders(): Promise<Record<string, string> | undefined> {
    if (!this.appKey || !this.appSecret) return undefined;
    if (Date.now() < this.authFailedUntil) return undefined;

    const token = await this.getAccessToken();
    return token ? { Authorization: token } : undefined;
  }

  private async getAccessToken(): Promise<string | null> {
    const now = Date.now();
    if (this.accessToken && now < this.accessTokenExpiresAt) {
      return this.accessToken;
    }

    const unixTime = Math.floor(now / 1000).toString();
    const sign = createHash('sha1')
      .update(`${this.appKey}${unixTime}${this.appSecret}`)
      .digest('hex');

    try {
      const { data } = await this.http.post<GoPlusAccessTokenResponse>(
        `${this.baseUrl}/api/v1/token_security/access_token`,
        {
          app_key: this.appKey,
          time: unixTime,
          sign,
        },
      );

      const token =
        data.result?.access_token ??
        data.result?.token ??
        data.access_token ??
        data.token;
      if (data.code !== 1 || !token) {
        this.logger.warn(
          `GoPlus: auth failed - code: ${data.code}, msg: ${data.message}; falling back to anonymous tier`,
        );
        this.authFailedUntil = Date.now() + 5 * 60_000;
        return null;
      }

      const rawTtl = data.result?.expires_in ?? data.expires_in;
      const ttlMs = Number.isFinite(Number(rawTtl))
        ? Math.max(10_000, Number(rawTtl) * 1000 - 5_000)
        : 55_000;

      this.accessToken = token;
      this.accessTokenExpiresAt = Date.now() + ttlMs;
      return token;
    } catch (err) {
      this.logger.warn(
        `GoPlus: auth request failed - ${(err as Error).message}; falling back to anonymous tier`,
      );
      this.authFailedUntil = Date.now() + 5 * 60_000;
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

  private async retryDelay(attempt: number): Promise<void> {
    const wait = this.retryDelayMs * attempt;
    if (wait > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, wait));
    }
  }

  private isProviderBackoffCode(code: unknown): boolean {
    return GOPLUS_BACKOFF_CODES.has(String(code));
  }

  private providerBackoffReasonFromError(err: unknown): string | null {
    const status = (err as { response?: { status?: number } }).response?.status;
    if (status === 429 || (status != null && status >= 500)) {
      return `http ${status}`;
    }
    return null;
  }

  private openProviderCircuitBreaker(reason: string | null): void {
    if (!reason || this.circuitBreakerMs <= 0) return;
    this.providerBackoffUntil = Date.now() + this.circuitBreakerMs;
    this.logger.warn(
      `GoPlus: opening circuit breaker for ${Math.ceil(this.circuitBreakerMs / 1000)}s after ${reason}`,
    );
  }

  private normalize(r: GoPlusTokenResult, tokenAddress: string): NormalizedRiskData {
    if (!r || typeof r !== 'object') {
      this.logger.warn(`GoPlus: malformed token payload for ${tokenAddress}`);
      return { providerStatus: 'GOPLUS_PARSE_FAILED' };
    }

    const criticalPresent = CRITICAL_GOPLUS_FIELDS.filter((field) => this.hasValue(r[field]));
    const tradeOrMetadataPresent = TRADE_SIGNAL_FIELDS.some((field) => this.hasValue(r[field]));
    if (criticalPresent.length === 0 && !tradeOrMetadataPresent) {
      this.logger.warn(
        `GoPlus: parse failed for ${tokenAddress} - critical risk fields missing`,
      );
      return { providerStatus: 'GOPLUS_PARSE_FAILED' };
    }

    const missingExpected = EXPECTED_GOPLUS_FIELDS.filter((field) => !this.hasValue(r[field]));
    const providerStatus =
      criticalPresent.length === 0
        ? 'GOPLUS_TRADE_ONLY_PARTIAL'
        : missingExpected.length > 0
          ? 'GOPLUS_PARTIAL'
          : 'OK';
    if (providerStatus !== 'OK') {
      this.logger.warn(
        `GoPlus: ${providerStatus} payload for ${tokenAddress} - missing/empty: ${missingExpected.join(', ')}`,
      );
    }

    const flag = (s?: string): boolean | undefined =>
      s === '1' ? true : s === '0' ? false : undefined;

    // GoPlus buy_tax / sell_tax are decimal fractions: "0.05" = 5%.
    const tax = (s?: string): number | undefined =>
      s !== undefined && s !== '' ? parseFloat(s) * 100 : undefined;

    // owner_address === '' is ambiguous (proxy may hide the real owner).
    // Empty string -> undefined (not "renounced"). Only zero/dead address = renounced.
    const addr = (r.owner_address ?? '').toLowerCase();
    const ownerRenounced: boolean | undefined =
      r.owner_address !== undefined && r.owner_address !== ''
        ? addr === '0x0000000000000000000000000000000000000000' ||
          addr === '0x000000000000000000000000000000000000dead'
        : undefined;

    // LP lock: count weighted % of LP supply on dead/locked addresses.
    // is_contract alone does not count. Only is_locked===1, known dead addresses,
    // or lock tags qualify.
    const lpLockedOrBurned = this.calcLpLocked(r.lp_holders);

    const cannotSellAll = flag(r.cannot_sell_all);
    const isHoneypot = flag(r.is_honeypot);
    const canSell: boolean | undefined =
      isHoneypot === true || cannotSellAll === true ? false : undefined;

    const slipMod = flag(r.slippage_modifiable);
    const persSlipMod = flag(r.personal_slippage_modifiable);
    const feeModifiableRisk: boolean | undefined =
      slipMod === true || persSlipMod === true
        ? true
        : slipMod === false && persSlipMod === false
          ? false
          : undefined;

    return {
      providerStatus,
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
      deployerAddress: this.normalizeAddress(r.creator_address),
    };
  }

  private hasValue(value: unknown): boolean {
    return value !== undefined && value !== null && value !== '';
  }

  private normalizeAddress(value?: string): string | undefined {
    return value && value !== '' ? value.toLowerCase() : undefined;
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
