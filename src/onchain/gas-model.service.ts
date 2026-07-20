import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { PublicClient } from 'viem';
import { QUOTE_ASSET_MAP, type SupportedChain } from '../collector/collector.types';
import type { LiquidityModel } from './onchain.types';
import { VIEM_CLIENTS } from './onchain.constants';
import { PriceService } from './price.service';

@Injectable()
export class GasModelService {
  constructor(
    private readonly config: ConfigService,
    private readonly prices: PriceService,
    @Inject(VIEM_CLIENTS) private readonly clients: Map<SupportedChain, PublicClient>,
  ) {}

  async estimateUsd(chain: SupportedChain, model: LiquidityModel | string): Promise<number> {
    const fallback = this.config.get<number>('paper.gasUsd') ?? 1.5;
    const client = this.clients.get(chain);
    if (!client) return fallback;
    try {
      const gasPrice = await client.getGasPrice();
      const units = model === 'V2' ? 180_000n : model === 'V3' ? 230_000n : model === 'V4' ? 300_000n : 230_000n;
      const weth = Object.entries(QUOTE_ASSET_MAP[chain]).find(([, symbol]) => symbol === 'WETH')?.[0];
      const nativeUsd = weth ? await this.prices.getUsdPrice(chain, weth) : null;
      if (!(nativeUsd && nativeUsd > 0)) return fallback;
      return Number(gasPrice * units) / 1e18 * nativeUsd;
    } catch {
      return fallback;
    }
  }
}
