import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import axiosRetry from 'axios-retry';
import { HoneypotApiResponse } from './honeypot.types';
import { NormalizedRiskData } from '../risk-engine.types';
import { SupportedChain } from '../../collector/collector.types';

const CHAIN_ID_MAP: Record<SupportedChain, number> = {
  ethereum: 1,
  base: 8453,
};

@Injectable()
export class HoneypotService {
  private readonly logger = new Logger(HoneypotService.name);
  private readonly http: AxiosInstance;
  private readonly baseUrl: string;

  constructor(private readonly config: ConfigService) {
    this.baseUrl =
      this.config.get<string>('api.honeypotBaseUrl') ?? 'https://api.honeypot.is';
    this.http = axios.create({ timeout: 8_000 });
    // Only 1 retry — honeypot.is is supplementary; don't block the cycle on retries.
    axiosRetry(this.http, { retries: 1, retryDelay: axiosRetry.exponentialDelay });
  }

  /**
   * Query Honeypot.is for a single address.
   * Returns normalized risk data, or null on failure (non-fatal — supplementary only).
   *
   * Sell-fail signal: if buyGas > 0 but sellGas === "0" the sell simulation failed
   * even though isHoneypot may be false.  We surface this as canSell: false so the
   * gate can catch it independently of the honeypot flag.
   */
  async checkToken(
    chain: SupportedChain,
    tokenAddress: string,
  ): Promise<NormalizedRiskData | null> {
    const chainId = CHAIN_ID_MAP[chain];
    if (!chainId) return null;

    try {
      const { data } = await this.http.get<HoneypotApiResponse>(
        `${this.baseUrl}/v2/IsHoneypot`,
        { params: { address: tokenAddress.toLowerCase(), chainID: chainId } },
      );
      return this.normalize(data);
    } catch (err) {
      const status = (err as { response?: { status?: number } }).response?.status;
      if (status === 404) {
        this.logger.debug(
          `Honeypot.is: 404 for ${chain}:${tokenAddress} — token not indexed yet; treated as absent (non-fatal)`,
        );
      } else {
        this.logger.warn(
          `Honeypot.is: transient failure for ${chain}:${tokenAddress} (http=${status ?? 'n/a'}) — ${(err as Error).message}`,
        );
      }
      return null;
    }
  }

  private normalize(r: HoneypotApiResponse): NormalizedRiskData {
    const isHoneypot =
      r.isHoneypot === true || r.honeypotResult?.isHoneypot === true;

    // Independent sell-fail signal from gas estimates.
    // If buy simulation ran (buyGas > 0) but sell gas is "0", sell is blocked.
    const buyGasNum = parseInt(r.simulationResult?.buyGas ?? '0', 10);
    const sellGasNum = parseInt(r.simulationResult?.sellGas ?? '0', 10);
    const sellSimFailed = buyGasNum > 0 && sellGasNum === 0;

    const canSell: boolean | undefined =
      isHoneypot || sellSimFailed ? false : undefined;

    // Honeypot.is returns taxes already as percentage (5 = 5 %)
    const buyTax = r.simulationResult?.buyTax;
    const sellTax = r.simulationResult?.sellTax;

    return {
      honeypot: isHoneypot,
      canSell,
      buyTax: buyTax !== undefined && buyTax > 0 ? buyTax : undefined,
      sellTax: sellTax !== undefined && sellTax > 0 ? sellTax : undefined,
    };
  }
}
