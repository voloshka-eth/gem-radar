import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { createPublicClient, fallback, http, type PublicClient } from 'viem';
import { mainnet, base } from 'viem/chains';
import type { SupportedChain } from '../collector/collector.types';
import { ONCHAIN_REDIS_CLIENT, VIEM_CLIENTS } from './onchain.constants';
import { TokenAgeService } from './token-age.service';
import { PriceService } from './price.service';
import { DexResolverService } from './dex-resolver.service';
import { V2LiquidityService } from './v2-liquidity.service';
import { V3LiquidityService } from './v3-liquidity.service';
import { LiquidityVerificationService } from './liquidity-verification.service';

@Module({
  providers: [
    // ── Redis client (shared across all onchain services) ────────────────────
    {
      provide: ONCHAIN_REDIS_CLIENT,
      useFactory: (config: ConfigService) =>
        new Redis({
          host: config.get<string>('redis.host') ?? 'localhost',
          port: config.get<number>('redis.port') ?? 6379,
          password: config.get<string>('redis.password'),
          lazyConnect: true,
          enableOfflineQueue: false,
        }),
      inject: [ConfigService],
    },

    // ── viem public clients — one per chain, primary + optional fallback ────
    // Primary: drpc.org (free archive access, required for binary-search token-age).
    // Fallback: publicnode.com (no archive, but handles latest-state calls on RPC outage).
    // On fallback: historical eth_getCode fails → TokenAgeService returns null → token passes gate.
    {
      provide: VIEM_CLIENTS,
      useFactory: (config: ConfigService): Map<SupportedChain, PublicClient> => {
        const ethPrimary   = config.get<string>('chain.ethereumRpcUrl')!;
        const ethFallback  = config.get<string>('chain.ethereumRpcUrlFallback');
        const basePrimary  = config.get<string>('chain.baseRpcUrl')!;
        const baseFallback = config.get<string>('chain.baseRpcUrlFallback');

        const makeTransport = (primary: string, fb?: string) =>
          fb
            ? fallback([
                http(primary, { retryCount: 2, retryDelay: 200 }),
                http(fb,      { retryCount: 2, retryDelay: 200 }),
              ])
            : http(primary, { retryCount: 3, retryDelay: 200 });

        const clients = new Map<SupportedChain, PublicClient>();
        clients.set('ethereum', createPublicClient({ chain: mainnet, transport: makeTransport(ethPrimary, ethFallback) }) as unknown as PublicClient);
        clients.set('base',     createPublicClient({ chain: base,    transport: makeTransport(basePrimary, baseFallback) }) as unknown as PublicClient);
        return clients;
      },
      inject: [ConfigService],
    },

    TokenAgeService,
    PriceService,
    DexResolverService,
    V2LiquidityService,
    V3LiquidityService,
    LiquidityVerificationService,
  ],
  exports: [
    TokenAgeService,
    LiquidityVerificationService,
  ],
})
export class OnchainModule {}
