import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { createPublicClient, defineChain, fallback, http, webSocket, type PublicClient, type Transport } from 'viem';
import { mainnet, base } from 'viem/chains';
import type { SupportedChain } from '../collector/collector.types';
import { ONCHAIN_REDIS_CLIENT, VIEM_CLIENTS, VIEM_STREAM_CLIENTS } from './onchain.constants';
import { TokenAgeService } from './token-age.service';
import { PriceService } from './price.service';
import { DexResolverService } from './dex-resolver.service';
import { V2LiquidityService } from './v2-liquidity.service';
import { V3LiquidityService } from './v3-liquidity.service';
import { V4LiquidityService } from './v4-liquidity.service';
import { LiquidityVerificationService } from './liquidity-verification.service';
import { RobinhoodExperimentalSafetyService } from './robinhood-experimental-safety.service';
import { FactoryPoolDiscoveryService } from './factory-pool-discovery.service';
import { TokenMetadataService } from './token-metadata.service';
import { GasModelService } from './gas-model.service';

const robinhood = defineChain({
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://rpc.mainnet.chain.robinhood.com'] },
  },
  blockExplorers: {
    default: { name: 'Robinhood Chain Explorer', url: 'https://robinhoodchain.blockscout.com' },
  },
});

/**
 * Free-first transport: try URLs in order. Primary gets a long timeout so a
 * slow free RPC is waited on; only then does Alchemy/Infura run. rank:false
 * prevents viem from preferring the paid endpoint once it proves faster.
 */
function makeOrderedTransport(
  urls: string[],
  primaryTimeoutMs: number,
  fallbackTimeoutMs: number,
): Transport {
  const unique = [...new Set(urls.filter(Boolean))];
  if (unique.length === 0) throw new Error('makeOrderedTransport requires at least one RPC URL');
  if (unique.length === 1) {
    return http(unique[0], { timeout: primaryTimeoutMs, retryCount: 2, retryDelay: 200 });
  }
  return fallback(
    unique.map((url, index) => http(url, {
      timeout: index === 0 ? primaryTimeoutMs : fallbackTimeoutMs,
      retryCount: index === 0 ? 1 : 2,
      retryDelay: 200,
    })),
    { rank: false, retryCount: 1, retryDelay: 250 },
  );
}

/** Log-safe RPC host (strips API keys from path). */
function redactRpcHost(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname
      .replace(/\/v2\/[^/]+/i, '/v2/***')
      .replace(/\/v3\/[^/]+/i, '/v3/***');
    return `${parsed.host}${path === '/' ? '' : path}`;
  } catch {
    return 'invalid-url';
  }
}

function redactUrlList(urls: string[]): string {
  return urls.map(redactRpcHost).join(' -> ') || '(none)';
}

@Module({
  providers: [
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

    // Free public primary → Alchemy → Infura (ordered). See chain.*RpcUrls.
    {
      provide: VIEM_CLIENTS,
      useFactory: (config: ConfigService): Map<SupportedChain, PublicClient> => {
        const activeChains = new Set([
          ...(config.get<string[]>('chain.enabledChains') ?? []),
          ...(config.get<string[]>('evmFlow.chains') ?? []),
        ]);
        const primaryTimeoutMs = config.get<number>('chain.primaryTimeoutMs') ?? 8_000;
        const fallbackTimeoutMs = config.get<number>('chain.fallbackTimeoutMs') ?? 12_000;
        const ethUrls = config.get<string[]>('chain.ethereumRpcUrls')
          ?? [config.get<string>('chain.ethereumRpcUrl')!].filter(Boolean);
        const baseUrls = config.get<string[]>('chain.baseRpcUrls')
          ?? [config.get<string>('chain.baseRpcUrl')!].filter(Boolean);
        const rhUrls = config.get<string[]>('chain.robinhoodRpcUrls')
          ?? [config.get<string>('chain.robinhoodRpcUrl')!].filter(Boolean);
        const provider = config.get<string>('chain.rpcProvider') ?? 'public/custom';
        const paidChains = (config.get<string[]>('chain.paidChains') ?? []).join(',') || 'none';

        console.log(
          `[OnchainModule] RPC ${provider} paidChains=${paidChains} ` +
          `timeouts=${primaryTimeoutMs}/${fallbackTimeoutMs}ms`,
        );
        console.log(`[OnchainModule] eth: ${redactUrlList(ethUrls)}`);
        console.log(`[OnchainModule] base: ${redactUrlList(baseUrls)}`);
        console.log(`[OnchainModule] robinhood: ${redactUrlList(rhUrls)}`);

        const clients = new Map<SupportedChain, PublicClient>();
        if (activeChains.has('ethereum')) {
          clients.set('ethereum', createPublicClient({
            chain: mainnet,
            transport: makeOrderedTransport(ethUrls, primaryTimeoutMs, fallbackTimeoutMs),
          }) as unknown as PublicClient);
        }
        if (activeChains.has('base')) {
          clients.set('base', createPublicClient({
            chain: base,
            transport: makeOrderedTransport(baseUrls, primaryTimeoutMs, fallbackTimeoutMs),
          }) as unknown as PublicClient);
        }
        if (activeChains.has('robinhood')) {
          clients.set('robinhood', createPublicClient({
            chain: robinhood,
            transport: makeOrderedTransport(rhUrls, primaryTimeoutMs, fallbackTimeoutMs),
          }) as unknown as PublicClient);
        }
        return clients;
      },
      inject: [ConfigService],
    },
    {
      provide: VIEM_STREAM_CLIENTS,
      useFactory: (config: ConfigService): Map<SupportedChain, PublicClient> => {
        const activeChains = new Set([
          ...(config.get<string[]>('chain.enabledChains') ?? []),
          ...(config.get<string[]>('evmFlow.chains') ?? []),
        ]);
        const ethWs = config.get<string>('chain.ethereumRpcWsUrl');
        const baseWs = config.get<string>('chain.baseRpcWsUrl');
        const robinhoodWs = config.get<string>('chain.robinhoodRpcWsUrl');
        const primaryTimeoutMs = config.get<number>('chain.primaryTimeoutMs') ?? 8_000;
        const fallbackTimeoutMs = config.get<number>('chain.fallbackTimeoutMs') ?? 12_000;
        const ethUrls = config.get<string[]>('chain.ethereumRpcUrls')
          ?? [config.get<string>('chain.ethereumRpcUrl')!].filter(Boolean);
        const baseUrls = config.get<string[]>('chain.baseRpcUrls')
          ?? [config.get<string>('chain.baseRpcUrl')!].filter(Boolean);
        const rhUrls = config.get<string[]>('chain.robinhoodRpcUrls')
          ?? [config.get<string>('chain.robinhoodRpcUrl')!].filter(Boolean);

        const clients = new Map<SupportedChain, PublicClient>();
        // Prefer Alchemy/Infura WSS when configured — streaming beats free HTTP poll.
        // Otherwise fall back to the same free-first HTTP ordered transport.
        if (activeChains.has('ethereum')) clients.set('ethereum', createPublicClient({
          chain: mainnet,
          transport: ethWs
            ? webSocket(ethWs, { reconnect: true })
            : makeOrderedTransport(ethUrls, primaryTimeoutMs, fallbackTimeoutMs),
          pollingInterval: 2_000,
        }) as unknown as PublicClient);
        if (activeChains.has('base')) clients.set('base', createPublicClient({
          chain: base,
          transport: baseWs
            ? webSocket(baseWs, { reconnect: true })
            : makeOrderedTransport(baseUrls, primaryTimeoutMs, fallbackTimeoutMs),
          pollingInterval: 1_000,
        }) as unknown as PublicClient);
        if (activeChains.has('robinhood')) clients.set('robinhood', createPublicClient({
          chain: robinhood,
          transport: robinhoodWs
            ? webSocket(robinhoodWs, { reconnect: true })
            : makeOrderedTransport(rhUrls, primaryTimeoutMs, fallbackTimeoutMs),
          pollingInterval: 1_000,
        }) as unknown as PublicClient);
        return clients;
      },
      inject: [ConfigService],
    },

    TokenAgeService,
    PriceService,
    DexResolverService,
    V2LiquidityService,
    V3LiquidityService,
    V4LiquidityService,
    RobinhoodExperimentalSafetyService,
    FactoryPoolDiscoveryService,
    TokenMetadataService,
    LiquidityVerificationService,
    GasModelService,
  ],
  exports: [
    TokenAgeService,
    PriceService,
    LiquidityVerificationService,
    RobinhoodExperimentalSafetyService,
    FactoryPoolDiscoveryService,
    TokenMetadataService,
    GasModelService,
    DexResolverService,
    VIEM_CLIENTS,
    VIEM_STREAM_CLIENTS,
  ],
})
export class OnchainModule {}
