import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { GoPlusService } from './providers/goplus.service';
import { HoneypotService } from './providers/honeypot.service';
import { applyContractRiskGate, mergeRiskData } from './contract-risk-gate';
import { ContractRiskResult, NormalizedRiskData, RiskDataStatus } from './risk-engine.types';
import { SupportedChain } from '../collector/collector.types';
import { FileLoggerService } from '../file-logger/file-logger.service';
import { CSV_SCHEMA_VERSION } from '../file-logger/csv-schemas';
import { RISK_REDIS_CLIENT } from './risk-engine.constants';

const CACHE_TTL_SECONDS = 45 * 60;
// Bump this string whenever gate rules change — otherwise stale decisions live in cache.
const CACHE_KEY_PREFIX = 'risk:v4:';

@Injectable()
export class RiskEngineService {
  private readonly logger = new Logger(RiskEngineService.name);

  constructor(
    private readonly goplus: GoPlusService,
    private readonly honeypot: HoneypotService,
    private readonly fileLogger: FileLoggerService,
    @Inject(RISK_REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  /**
   * Run the contract risk check pipeline for a single token.
   *
   * Flow:
   *  1. Check Redis cache (TTL 45 min) — return early on hit.
   *  2. Query GoPlus AND Honeypot.is in parallel (Promise.allSettled).
   *  3. If BOTH fail → CONTRACT_UNKNOWN (no data to decide).
   *  4. If at least one succeeded → merge (most-pessimistic) → gate → decision.
   *  5. Log to contract_risk_checks.csv.
   *  6. Store result in Redis.
   *  7. Return result — caller decides DB persistence and pool logging.
   *
   * No wallet keys, no trades, no auto-buy. Decision only.
   */
  async checkToken(
    chain: SupportedChain,
    tokenAddress: string,
    tokenSymbol: string | undefined,
    tokenName: string | undefined,
    runId: string,
  ): Promise<ContractRiskResult> {
    const cacheKey = `${CACHE_KEY_PREFIX}${chain}:${tokenAddress.toLowerCase()}`;

    // ── Cache lookup ──────────────────────────────────────────────────────────
    const cached = await this.getCached(cacheKey);
    if (cached) {
      this.logger.debug(`Risk cache hit: ${chain}:${tokenAddress} → ${cached.decision}`);
      return { ...cached, cacheHit: true };
    }

    // ── Parallel provider calls ───────────────────────────────────────────────
    const goplusSupported = this.goplus.supportsChain(chain);
    const honeypotSupported = this.honeypot.supportsChain(chain);
    const [goplusSettled, honeypotSettled] = await Promise.allSettled([
      goplusSupported ? this.goplus.checkToken(chain, tokenAddress) : Promise.resolve(null),
      honeypotSupported ? this.honeypot.checkToken(chain, tokenAddress) : Promise.resolve(null),
    ]);

    const goplusData: NormalizedRiskData | null =
      goplusSettled.status === 'fulfilled' ? goplusSettled.value : null;
    const honeypotData: NormalizedRiskData | null =
      honeypotSettled.status === 'fulfilled' ? honeypotSettled.value : null;

    const goplusQueried = goplusData !== null;
    const honeypotQueried = honeypotData !== null;

    // ── UNKNOWN: both providers unavailable ───────────────────────────────────
    // Do NOT cache — a transient 5-second outage must not block re-checking for 45 min.
    if (!goplusQueried && !honeypotQueried) {
      const providerStatus: RiskDataStatus = !goplusSupported && !honeypotSupported
        ? 'NO_RISK_PROVIDER_SUPPORT'
        : 'ALL_PROVIDERS_UNAVAILABLE';
      this.logger.warn(
        `Risk engine: ${providerStatus} for ${chain}:${tokenAddress} - CONTRACT_UNKNOWN`,
      );
      const result: ContractRiskResult = {
        decision: 'CONTRACT_UNKNOWN',
        rejectReasons: [],
        goplusQueried: false,
        honeypotQueried: false,
        merged: {},
        providerStatus,
        cacheHit: false,
      };
      this.logRiskCheck(chain, tokenAddress, tokenSymbol, tokenName, runId, result);
      return result; // intentionally NOT cached
    }

    // ── Honeypot.is only: GoPlus unavailable ─────────────────────────────────
    // Honeypot.is covers: is_honeypot, sellGas (canSell), buy/sell tax.
    // It does NOT cover: mint, blacklist, pause, proxy, owner, hidden_owner, etc.
    // A "clean" Honeypot.is result is therefore insufficient to confirm SAFE.
    //   → REJECT is valid (detected a trap even without GoPlus)
    //   → "looks clean" → CONTRACT_UNKNOWN, not SAFE (too many signals missing)
    if (!goplusQueried && honeypotQueried) {
      const { decision: hpDecision, rejectReasons: hpReasons } = applyContractRiskGate(honeypotData!);
      const finalDecision = hpDecision === 'CONTRACT_REJECT' ? 'CONTRACT_REJECT' : 'CONTRACT_UNKNOWN';
      const result: ContractRiskResult = {
        decision: finalDecision,
        rejectReasons: finalDecision === 'CONTRACT_REJECT' ? hpReasons : [],
        goplusQueried: false,
        honeypotQueried: true,
        merged: { ...honeypotData!, providerStatus: 'HONEYPOT_ONLY_PARTIAL' },
        providerStatus: 'HONEYPOT_ONLY_PARTIAL',
        cacheHit: false,
      };
      this.logger.log(
        `Risk: ${chain}:${tokenAddress} → ${finalDecision} (GoPlus unavailable; Honeypot-only${finalDecision === 'CONTRACT_REJECT' ? ` [${hpReasons.join(', ')}]` : ' — insufficient for SAFE'})`,
      );
      this.logRiskCheck(chain, tokenAddress, tokenSymbol, tokenName, runId, result);
      if (finalDecision !== 'CONTRACT_UNKNOWN') {
        await this.setCached(cacheKey, result);
      }
      return result;
    }

    // ── GoPlus available — authoritative decision ─────────────────────────────
    // GoPlus is the source of truth; Honeypot.is supplements where it adds signal.
    const primary: NormalizedRiskData = goplusData!;
    const supplementary: NormalizedRiskData | undefined = honeypotData ?? undefined;
    const merged = mergeRiskData(primary, supplementary);

    const { decision, rejectReasons } = applyContractRiskGate(merged);
    const providerStatus = this.resolveProviderStatus(primary, merged);
    const finalDecision =
      decision === 'CONTRACT_REJECT'
        ? 'CONTRACT_REJECT'
        : providerStatus === 'OK' || this.isCleanPartialWithCriticalFields(providerStatus, merged)
          ? 'CONTRACT_SAFE'
          : 'CONTRACT_UNKNOWN';
    const result: ContractRiskResult = {
      decision: finalDecision,
      rejectReasons: finalDecision === 'CONTRACT_REJECT' ? rejectReasons : [],
      goplusQueried: true,
      honeypotQueried,
      merged: { ...merged, providerStatus },
      providerStatus,
      cacheHit: false,
    };

    this.logger.log(
      `Risk: ${chain}:${tokenAddress} -> ${finalDecision}${rejectReasons.length && finalDecision === 'CONTRACT_REJECT' ? ` [${rejectReasons.join(', ')}]` : ''}${providerStatus !== 'OK' ? ` (${providerStatus})` : ''}`,
    );
    this.logRiskCheck(chain, tokenAddress, tokenSymbol, tokenName, runId, result);
    if (finalDecision !== 'CONTRACT_UNKNOWN') {
      await this.setCached(cacheKey, result);
    }
    return result;
  }

  private isCleanPartialWithCriticalFields(
    providerStatus: RiskDataStatus,
    merged: NormalizedRiskData,
  ): boolean {
    return providerStatus === 'GOPLUS_PARTIAL' && this.allCriticalRiskFieldsPresent(merged);
  }

  private resolveProviderStatus(
    goplusData: NormalizedRiskData,
    merged: NormalizedRiskData,
  ): RiskDataStatus {
    const explicitStatus = goplusData.providerStatus ?? 'OK';
    if (explicitStatus === 'GOPLUS_PARSE_FAILED') return explicitStatus;
    if (explicitStatus === 'GOPLUS_PARTIAL') return explicitStatus;
    if (explicitStatus === 'GOPLUS_TRADE_ONLY_PARTIAL') return explicitStatus;
    if (this.allCriticalRiskFieldsUnknown(goplusData)) return 'GOPLUS_PARSE_FAILED';
    if (this.allCriticalRiskFieldsUnknown(merged)) return 'GOPLUS_PARSE_FAILED';
    return 'OK';
  }

  private allCriticalRiskFieldsUnknown(data: NormalizedRiskData): boolean {
    return (
      data.mintRisk === undefined &&
      data.blacklistRisk === undefined &&
      data.proxyRisk === undefined &&
      data.honeypot === undefined
    );
  }

  private allCriticalRiskFieldsPresent(data: NormalizedRiskData): boolean {
    return (
      data.mintRisk !== undefined &&
      data.blacklistRisk !== undefined &&
      data.proxyRisk !== undefined &&
      data.honeypot !== undefined
    );
  }

  // ── Redis helpers (non-fatal — Redis unavailability must not block checks) ──

  private async getCached(key: string): Promise<ContractRiskResult | null> {
    try {
      const raw = await this.redis.get(key);
      return raw ? (JSON.parse(raw) as ContractRiskResult) : null;
    } catch {
      return null;
    }
  }

  private async setCached(key: string, result: ContractRiskResult): Promise<void> {
    try {
      await this.redis.setex(key, CACHE_TTL_SECONDS, JSON.stringify(result));
    } catch {
      // Non-fatal — proceed without caching
    }
  }

  // ── CSV logging ────────────────────────────────────────────────────────────

  private logRiskCheck(
    chain: SupportedChain,
    tokenAddress: string,
    tokenSymbol: string | undefined,
    tokenName: string | undefined,
    runId: string,
    result: ContractRiskResult,
  ): void {
    const { decision, rejectReasons, goplusQueried, honeypotQueried, merged } = result;
    this.fileLogger.logContractRisk({
      ts: new Date().toISOString(),
      run_id: runId,
      schema_version: CSV_SCHEMA_VERSION,
      chain,
      token_address: tokenAddress,
      token_symbol: tokenSymbol ?? '',
      source: 'goplus',
      verified: merged.verified?.toString() ?? '',
      honeypot: merged.honeypot?.toString() ?? '',
      buy_tax: merged.buyTax?.toFixed(2) ?? '',
      sell_tax: merged.sellTax?.toFixed(2) ?? '',
      can_mint: merged.mintRisk?.toString() ?? '',
      can_blacklist: merged.blacklistRisk?.toString() ?? '',
      can_pause: merged.pauseRisk?.toString() ?? '',
      is_proxy: merged.proxyRisk?.toString() ?? '',
      owner_renounced: merged.ownerRenounced?.toString() ?? '',
      lp_locked_or_burned: merged.lpLockedOrBurned?.toString() ?? '',
      hard_reject: (decision === 'CONTRACT_REJECT').toString(),
      reject_reason: rejectReasons[0] ?? '',
      token_name: tokenName ?? '',
      goplus_queried: goplusQueried.toString(),
      honeypot_queried: honeypotQueried.toString(),
      decision,
      reject_reasons: rejectReasons.join(';'),
      risk_status: result.providerStatus ?? merged.providerStatus ?? '',
    });
  }
}
