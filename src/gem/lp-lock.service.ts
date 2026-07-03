import { Injectable, Logger, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { PublicClient } from 'viem';
import { VIEM_CLIENTS } from '../onchain/onchain.constants';
import type { SupportedChain } from '../collector/collector.types';

const ERC20_ABI = [
  { name: 'totalSupply', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'balanceOf', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const;

export interface LpLockResult {
  lockedOrBurned: boolean;
  fraction: number | null;   // (burned + locked) / totalSupply
  source: string;            // burn | locker:<name> | burn+locker:<name> | none | undetermined_v3 | read_failed
}

/**
 * Detect whether a pool's LP is locked or burned — the gem-screen HARD GATE.
 *
 * V2: the pair address IS the fungible LP token. We read totalSupply and the LP balance
 * held by burn sinks (reliable) and by known lockers (best-effort registry). Locked-or-burned
 * fraction ≥ config threshold ⇒ true.
 *
 * V3: liquidity is held as NFT positions, not a fungible LP token, so this method cannot
 * determine lock/burn here. Per the mandate, UNDETERMINED ⇒ treated as NOT locked ⇒ reject.
 */
@Injectable()
export class LpLockService {
  private readonly logger = new Logger(LpLockService.name);

  constructor(
    private readonly config: ConfigService,
    @Inject(VIEM_CLIENTS) private readonly clients: Map<SupportedChain, PublicClient>,
  ) {}

  async detect(chain: SupportedChain, poolAddress: string, liquidityModel: string): Promise<LpLockResult> {
    if (liquidityModel !== 'V2') {
      return { lockedOrBurned: false, fraction: null, source: 'undetermined_v3' };
    }
    const client = this.clients.get(chain);
    if (!client) return { lockedOrBurned: false, fraction: null, source: 'no_client' };

    const lp = poolAddress as `0x${string}`;
    const dead = (this.config.get<string[]>('gem.deadAddresses') ?? []).map((a) => a.toLowerCase());
    const lockers = (this.config.get<Record<string, Record<string, string>>>('gem.lockers') ?? {})[chain] ?? {};
    const minFraction = this.config.get<number>('gem.lpLockedMinFraction') ?? 0.9;

    try {
      const total = await client.readContract({ address: lp, abi: ERC20_ABI, functionName: 'totalSupply' }) as bigint;
      if (total === 0n) return { lockedOrBurned: false, fraction: 0, source: 'zero_supply' };

      const balOf = (addr: string) =>
        client.readContract({ address: lp, abi: ERC20_ABI, functionName: 'balanceOf', args: [addr as `0x${string}`] }) as Promise<bigint>;

      let burned = 0n;
      for (const d of dead) burned += await balOf(d);

      let locked = 0n;
      const lockerHits: string[] = [];
      for (const [addr, name] of Object.entries(lockers)) {
        const b = await balOf(addr);
        if (b > 0n) { locked += b; lockerHits.push(`locker:${name}`); }
      }

      const fraction = Number(burned + locked) / Number(total);
      const parts: string[] = [];
      if (burned > 0n) parts.push('burn');
      parts.push(...lockerHits);
      const source = parts.length ? parts.join('+') : 'none';

      return { lockedOrBurned: fraction >= minFraction, fraction, source };
    } catch (err) {
      this.logger.debug(`LP-lock read failed for ${chain}:${poolAddress}: ${(err as Error).message}`);
      return { lockedOrBurned: false, fraction: null, source: 'read_failed' };
    }
  }
}
