import { Injectable, Logger, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { PublicClient } from 'viem';
import Redis from 'ioredis';
import type { SupportedChain } from '../collector/collector.types';
import { ONCHAIN_REDIS_CLIENT, VIEM_CLIENTS } from './onchain.constants';

const CACHE_TTL_S = 7 * 24 * 3600; // contract creation date never changes

@Injectable()
export class TokenAgeService {
  private readonly logger = new Logger(TokenAgeService.name);

  constructor(
    private readonly config: ConfigService,
    @Inject(ONCHAIN_REDIS_CLIENT) private readonly redis: Redis,
    @Inject(VIEM_CLIENTS) private readonly viemClients: Map<SupportedChain, PublicClient>,
  ) {}

  /**
   * Returns the token contract's age in days (cached), or null if the age
   * cannot be determined. Callers must log a WARN when null is returned and
   * should let the token through (unknown age ≠ old).
   *
   * Uses binary search over eth_getCode — no explorer API key required.
   * ~25 RPC calls per uncached token (log2 of current block height).
   */
  async getTokenAgeDays(chain: SupportedChain, tokenAddress: string): Promise<number | null> {
    const cacheKey = `age:v1:${chain}:${tokenAddress}`;
    try {
      const cached = await this.redis.get(cacheKey);
      if (cached !== null) return parseFloat(cached);
    } catch { /* Redis offline — proceed to live fetch */ }

    const deployedAt = await this.findDeployTimestampMs(chain, tokenAddress);
    if (deployedAt === null) return null;

    const ageDays = (Date.now() - deployedAt) / 86_400_000;

    try {
      await this.redis.setex(cacheKey, CACHE_TTL_S, String(ageDays));
    } catch { /* ignore */ }

    return ageDays;
  }

  /**
   * Binary search: find the lowest block number where getCode(token) is
   * non-empty (contract exists), then read that block's timestamp.
   * Returns ms-epoch, or null on any RPC error.
   */
  private async findDeployTimestampMs(
    chain: SupportedChain,
    tokenAddress: string,
  ): Promise<number | null> {
    if (
      chain === 'robinhood' &&
      !(this.config.get<boolean>('chain.robinhoodHistoricalCodeEnabled') ?? false)
    ) {
      this.logger.debug(
        `TokenAgeService: historical eth_getCode disabled for Robinhood; age unknown for ${tokenAddress}`,
      );
      return null;
    }

    const client = this.viemClients.get(chain);
    if (!client) {
      this.logger.warn(
        `TokenAgeService: no viem client for chain "${chain}" — age unknown, token passes gate`,
      );
      return null;
    }

    const addr = tokenAddress as `0x${string}`;

    // ── Step 1: get current block so we know the search range ──────────────────
    let currentBlock: bigint;
    try {
      currentBlock = await client.getBlockNumber();
    } catch (err) {
      this.logger.warn(
        `TokenAgeService: getBlockNumber failed on ${chain} — age unknown, token passes gate. ` +
        `Error: ${(err as Error).message}`,
      );
      return null;
    }

    // ── Step 2: confirm contract actually exists now ────────────────────────────
    let codeNow: string | undefined;
    try {
      codeNow = await client.getCode({ address: addr });
    } catch (err) {
      this.logger.warn(
        `TokenAgeService: getCode(current) failed for ${chain}:${tokenAddress} — ` +
        `age unknown, token passes gate. Error: ${(err as Error).message.split('\n')[0]}`,
      );
      return null;
    }

    if (!codeNow) {
      // Not a contract (or contract self-destructed) — no age to compute.
      this.logger.warn(
        `TokenAgeService: ${chain}:${tokenAddress} has no bytecode at current block — ` +
        `not a contract? Age unknown, token passes gate.`,
      );
      return null;
    }

    // ── Step 3: binary search for first block with bytecode ────────────────────
    let lo = 0n;
    let hi = currentBlock;

    try {
      while (lo < hi) {
        const mid = (lo + hi) / 2n;
        const code = await client.getCode({ address: addr, blockNumber: mid });
        if (!code) {
          lo = mid + 1n; // contract not yet deployed at `mid`
        } else {
          hi = mid;      // contract exists at `mid` — could be earlier
        }
      }
    } catch (err) {
      // Mid-search RPC call failed — most commonly the publicnode.com fallback
      // rejecting archive requests. Age is unknown; token passes gate (safe default).
      this.logger.warn(
        `TokenAgeService: binary search failed for ${chain}:${tokenAddress} ` +
        `at lo=${lo} hi=${hi} — age unknown, token passes gate. ` +
        `Error: ${(err as Error).message.split('\n')[0]}`,
      );
      return null;
    }

    const deployBlock = lo;

    // ── Step 4: read the block timestamp ───────────────────────────────────────
    try {
      const block = await client.getBlock({ blockNumber: deployBlock });
      const tsMs = Number(block.timestamp) * 1_000;
      this.logger.log(
        `TokenAgeService: ${chain}:${tokenAddress} deployed at block ${deployBlock} ` +
        `(${new Date(tsMs).toISOString()})`,
      );
      return tsMs;
    } catch (err) {
      this.logger.warn(
        `TokenAgeService: getBlock(${deployBlock}) failed for ${chain}:${tokenAddress} — ` +
        `age unknown, token passes gate. Error: ${(err as Error).message.split('\n')[0]}`,
      );
      return null;
    }
  }
}
