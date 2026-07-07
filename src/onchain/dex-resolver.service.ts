import { Injectable, Logger, Inject } from '@nestjs/common';
import type { PublicClient } from 'viem';
import type { SupportedChain } from '../collector/collector.types';
import type { LiquidityModel } from './onchain.types';
import { VIEM_CLIENTS } from './onchain.constants';

// Minimal ABIs — only what we need for probing
const GET_RESERVES_ABI = [{
  name: 'getReserves',
  type: 'function',
  stateMutability: 'view',
  inputs: [],
  outputs: [
    { name: 'reserve0', type: 'uint112' },
    { name: 'reserve1', type: 'uint112' },
    { name: 'blockTimestampLast', type: 'uint32' },
  ],
}] as const;

const STABLE_ABI = [{
  name: 'stable',
  type: 'function',
  stateMutability: 'view',
  inputs: [],
  outputs: [{ name: '', type: 'bool' }],
}] as const;

const SLOT0_ABI = [{
  name: 'slot0',
  type: 'function',
  stateMutability: 'view',
  inputs: [],
  outputs: [
    { name: 'sqrtPriceX96', type: 'uint160' },
    { name: 'tick', type: 'int24' },
    { name: 'observationIndex', type: 'uint16' },
    { name: 'observationCardinality', type: 'uint16' },
    { name: 'observationCardinalityNext', type: 'uint16' },
    { name: 'feeProtocol', type: 'uint8' },
    { name: 'unlocked', type: 'bool' },
  ],
}] as const;

const LIQUIDITY_ABI = [{
  name: 'liquidity',
  type: 'function',
  stateMutability: 'view',
  inputs: [],
  outputs: [{ name: '', type: 'uint128' }],
}] as const;

const FEE_ABI = [{
  name: 'fee',
  type: 'function',
  stateMutability: 'view',
  inputs: [],
  outputs: [{ name: '', type: 'uint24' }],
}] as const;

@Injectable()
export class DexResolverService {
  private readonly logger = new Logger(DexResolverService.name);

  constructor(
    @Inject(VIEM_CLIENTS) private readonly viemClients: Map<SupportedChain, PublicClient>,
  ) {}

  /**
   * Determine the DEX liquidity model for a pool by probing on-chain interfaces.
   * The `dexName` string is used ONLY as a hint to improve logging and fallback
   * classification — it NEVER determines the model. All decisions come from probes.
   *
   * Probe order:
   *   1. getReserves() → V2-style (Uniswap V2, Aerodrome volatile/stable)
   *      → stable pools are verified from reserves with conservative CP depth approximation
   *   2. slot0() + liquidity() → V3-style
   *   3. Both fail → UNSUPPORTED_V4 (if dexName hints V4) or UNSUPPORTED_UNKNOWN
   *
   * Returns probeError so the caller can surface it in the CSV error column.
   */
  async resolveModel(
    chain: SupportedChain,
    poolAddress: string,
    dexName: string,
  ): Promise<{ model: LiquidityModel; feeBps?: number; probeError?: string }> {
    const client = this.viemClients.get(chain);
    if (!client) {
      return { model: 'UNSUPPORTED_UNKNOWN', probeError: `No viem client for chain ${chain}` };
    }

    // V4 pool IDs are 32-byte hashes (66 chars with 0x prefix) — not EVM addresses.
    // Skip all probes immediately: viem would throw "Address invalid" on every call.
    if (poolAddress.length > 42) {
      this.logger.debug(`${chain}:${poolAddress.slice(0, 14)}… → UNSUPPORTED_V4 (32-byte pool ID)`);
      return { model: 'UNSUPPORTED_V4', probeError: 'V4 pool ID (32-byte hash, not an EVM address)' };
    }

    const addr = poolAddress as `0x${string}`;

    // ── Probe 1: getReserves() → V2-style ────────────────────────────────────
    const p1 = await this.tryCall(client, addr, GET_RESERVES_ABI, 'getReserves');
    if (p1.ok) {
      // Check if Aerodrome stable pool (different math — not supported in M3A)
      const stableResult = await this.tryCallBool(client, addr, STABLE_ABI, 'stable');
      // Volatile Aerodrome or Uniswap V2 — try to read fee (Aerodrome only; V2 = 30 BPS)
      const feeResult = await this.tryCallUint(client, addr, FEE_ABI, 'fee');
      const feeBps = feeResult.value ?? 30;
      if (stableResult.value === true) {
        this.logger.debug(`${chain}:${poolAddress} -> V2 (Aerodrome stable; conservative CP depth approximation)`);
      }
      return { model: 'V2', feeBps };
    }

    // ── Probe 2: slot0() + liquidity() → V3-style ────────────────────────────
    const p2a = await this.tryCall(client, addr, SLOT0_ABI, 'slot0');
    const p2b = await this.tryCall(client, addr, LIQUIDITY_ABI, 'liquidity');
    if (p2a.ok && p2b.ok) {
      const feeResult = await this.tryCallUint(client, addr, FEE_ABI, 'fee');
      const feeBps = feeResult.value ?? 3000;
      return { model: 'V3', feeBps };
    }

    // ── Both probes failed ────────────────────────────────────────────────────
    const brief = (s: string | undefined) => (s ?? 'failed').split('\n')[0].slice(0, 80);
    const probeError =
      `V2 probe (getReserves): ${brief(p1.error)}; ` +
      `V3 probe (slot0): ${p2a.ok ? 'ok' : 'failed'}, (liquidity): ${brief(p2b.error)}`;

    this.logger.warn(
      `Pool ${chain}:${poolAddress} (dex="${dexName}") — neither V2 nor V3 interface responded. ` +
      probeError,
    );

    // Use dexName ONLY as a hint for the UNSUPPORTED_* label — never as primary decision
    if (/v4/i.test(dexName)) {
      return { model: 'UNSUPPORTED_V4', probeError };
    }
    return { model: 'UNSUPPORTED_UNKNOWN', probeError };
  }

  private async tryCall(
    client: PublicClient,
    address: `0x${string}`,
    abi: readonly unknown[],
    functionName: string,
  ): Promise<{ ok: boolean; error?: string }> {
    try {
      await client.readContract({ address, abi: abi as never, functionName } as never);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  private async tryCallBool(
    client: PublicClient,
    address: `0x${string}`,
    abi: readonly unknown[],
    functionName: string,
  ): Promise<{ value: boolean | null; error?: string }> {
    try {
      const result = await client.readContract({ address, abi: abi as never, functionName } as never);
      return { value: result as boolean };
    } catch (err) {
      return { value: null, error: (err as Error).message };
    }
  }

  private async tryCallUint(
    client: PublicClient,
    address: `0x${string}`,
    abi: readonly unknown[],
    functionName: string,
  ): Promise<{ value: number | null; error?: string }> {
    try {
      const result = await client.readContract({ address, abi: abi as never, functionName } as never);
      return { value: Number(result) };
    } catch (err) {
      return { value: null, error: (err as Error).message };
    }
  }
}
