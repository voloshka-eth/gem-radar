import { Inject, Injectable } from '@nestjs/common';
import type { PublicClient } from 'viem';
import type { SupportedChain } from '../collector/collector.types';
import { VIEM_CLIENTS } from './onchain.constants';

const ERC20_METADATA_ABI = [
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'name', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
] as const;

export type TokenMetadata = { symbol: string; name: string };

/** Best-effort ERC-20 metadata for a pool that already proved executable. */
@Injectable()
export class TokenMetadataService {
  constructor(
    @Inject(VIEM_CLIENTS) private readonly clients: Map<SupportedChain, PublicClient>,
  ) {}

  async read(chain: SupportedChain, tokenAddress: string): Promise<TokenMetadata> {
    const client = this.clients.get(chain);
    if (!client) return { symbol: '', name: '' };
    const address = tokenAddress as `0x${string}`;
    const [symbol, name] = await Promise.all([
      client.readContract({ address, abi: ERC20_METADATA_ABI, functionName: 'symbol' })
        .then((value) => typeof value === 'string' ? value.trim().slice(0, 64) : '')
        .catch(() => ''),
      client.readContract({ address, abi: ERC20_METADATA_ABI, functionName: 'name' })
        .then((value) => typeof value === 'string' ? value.trim().slice(0, 160) : '')
        .catch(() => ''),
    ]);
    return { symbol, name };
  }
}
