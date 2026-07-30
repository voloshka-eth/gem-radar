/**
 * Resolve HTTP/WSS RPC endpoints with a free-first failover policy.
 *
 * Default provider split (matches the free-tier plan):
 *   - Alchemy  → Robinhood + Ethereum  (RPC_ALCHEMY_CHAINS)
 *   - Infura   → Solana                (RPC_INFURA_CHAINS)
 *
 * Per EVM chain URL order (RPC_PRIORITY=free_first, default):
 *   1. Free/public primary (or explicit *_RPC_URL)
 *   2. Alchemy (if chain is in RPC_ALCHEMY_CHAINS and key set)
 *   3. Infura  (if chain is in RPC_INFURA_CHAINS and key set)
 *
 * Solana HTTP is also free-first. WebSocket subscriptions intentionally stay
 * on Solana's public WS unless SOLANA_RPC_WS_URL is explicitly configured:
 * some paid free tiers accept HTTP reads but reject logsSubscribe.
 *
 * Viem transports must use rank:false + a long primary timeout so the free
 * endpoint is always tried first and paid providers only run after timeout.
 */

export type AlchemyNetwork =
  | 'eth-mainnet'
  | 'base-mainnet'
  | 'robinhood-mainnet';

export type PaidChain = 'ethereum' | 'base' | 'robinhood';

const ALCHEMY_HOST: Record<AlchemyNetwork, string> = {
  'eth-mainnet': 'eth-mainnet.g.alchemy.com',
  'base-mainnet': 'base-mainnet.g.alchemy.com',
  'robinhood-mainnet': 'robinhood-mainnet.g.alchemy.com',
};

const INFURA_HOST: Record<AlchemyNetwork, string> = {
  'eth-mainnet': 'mainnet.infura.io',
  'base-mainnet': 'base-mainnet.infura.io',
  'robinhood-mainnet': 'robinhood-mainnet.infura.io',
};

const PUBLIC_DEFAULTS = {
  ethereum: 'https://eth.drpc.org',
  ethereumFallback: 'https://ethereum.publicnode.com',
  base: 'https://base.drpc.org',
  baseFallback: 'https://base.publicnode.com',
  robinhood: 'https://rpc.mainnet.chain.robinhood.com',
} as const;

/** Default: Alchemy covers the Robinhood paper lane + Ethereum collector. */
const DEFAULT_ALCHEMY_CHAINS: PaidChain[] = ['robinhood', 'ethereum'];
/** Default: Infura covers Solana (when/if the Solana lane is re-enabled). */
const DEFAULT_INFURA_CHAINS: PaidChain[] = [];

/** Accept a raw key or a full Alchemy URL; return the API key segment only. */
export function extractAlchemyApiKey(raw: string | undefined | null): string | undefined {
  if (raw == null) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  const fromUrl = trimmed.match(
    /alchemy\.(?:com|api\.io)\/(?:v2|v3)\/([A-Za-z0-9_-]+)/i,
  );
  if (fromUrl?.[1]) return fromUrl[1];

  if (/^[A-Za-z0-9_-]{20,}$/.test(trimmed) && !trimmed.includes('://')) {
    return trimmed;
  }
  return undefined;
}

/** Accept a raw Infura key or a full Infura URL. */
export function extractInfuraApiKey(raw: string | undefined | null): string | undefined {
  if (raw == null) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  const fromUrl = trimmed.match(
    /infura\.io\/(?:v3|v2)\/([A-Za-z0-9_-]+)/i,
  );
  if (fromUrl?.[1]) return fromUrl[1];

  if (/^[A-Za-z0-9_-]{20,}$/.test(trimmed) && !trimmed.includes('://')) {
    return trimmed;
  }
  return undefined;
}

export function alchemyHttpUrl(network: AlchemyNetwork, apiKey: string): string {
  return `https://${ALCHEMY_HOST[network]}/v2/${apiKey}`;
}

export function alchemyWsUrl(network: AlchemyNetwork, apiKey: string): string {
  return `wss://${ALCHEMY_HOST[network]}/v2/${apiKey}`;
}

export function infuraHttpUrl(network: AlchemyNetwork, apiKey: string): string {
  return `https://${INFURA_HOST[network]}/v3/${apiKey}`;
}

export function infuraWsUrl(network: AlchemyNetwork, apiKey: string): string {
  return `wss://${INFURA_HOST[network]}/ws/v3/${apiKey}`;
}

export type ChainHttpUrls = {
  /** Ordered: free/public first, then provider failovers. */
  urls: string[];
  primary: string;
  fallback?: string;
  tertiary?: string;
};

export type ResolvedRpcEndpoints = {
  ethereum: ChainHttpUrls;
  base: ChainHttpUrls;
  robinhood: ChainHttpUrls;
  ethereumRpcWsUrl?: string;
  baseRpcWsUrl?: string;
  robinhoodRpcWsUrl?: string;
  primaryTimeoutMs: number;
  fallbackTimeoutMs: number;
  alchemyActive: boolean;
  infuraActive: boolean;
  alchemyChains: PaidChain[];
  infuraChains: PaidChain[];
  /** Union of alchemy+infura chains (compat). */
  paidChains: PaidChain[];
  providerLabel: string;
};

export type RpcEnvInput = {
  alchemyApiKey?: string;
  alchemyRpcUrl?: string;
  infuraApiKey?: string;
  infuraRpcUrl?: string;
  /** Comma list for Alchemy failovers. Default: robinhood,ethereum */
  rpcAlchemyChains?: string;
  /** Comma list for Infura. Default: none */
  rpcInfuraChains?: string;
  /**
   * Legacy alias: if set and the split vars are empty, applies to BOTH providers.
   * Prefer RPC_ALCHEMY_CHAINS / RPC_INFURA_CHAINS.
   */
  rpcPaidChains?: string;
  /** free_first (default) | paid_first */
  rpcPriority?: string;
  rpcPrimaryTimeoutMs?: string;
  rpcFallbackTimeoutMs?: string;
  ethereumRpcUrl?: string;
  ethereumRpcUrlFallback?: string;
  ethereumRpcWsUrl?: string;
  baseRpcUrl?: string;
  baseRpcUrlFallback?: string;
  baseRpcWsUrl?: string;
  robinhoodRpcUrl?: string;
  robinhoodRpcUrlFallback?: string;
  robinhoodRpcWsUrl?: string;
};

function parseChainList(raw: string | undefined, fallback: PaidChain[]): PaidChain[] {
  if (raw == null || !raw.trim()) return [...fallback];
  const allowed = new Set<PaidChain>(['ethereum', 'base', 'robinhood']);
  const parsed = raw
    .toLowerCase()
    .split(',')
    .map((part) => part.trim())
    .filter((part): part is PaidChain => allowed.has(part as PaidChain));
  return parsed.length > 0 ? [...new Set(parsed)] : [...fallback];
}

function buildChainUrls(args: {
  explicitPrimary?: string;
  explicitFallback?: string;
  publicPrimary: string;
  publicExtraFallback?: string;
  alchemyUrl?: string;
  infuraUrl?: string;
  useAlchemy: boolean;
  useInfura: boolean;
  paidFirst: boolean;
}): ChainHttpUrls {
  const explicitPrimary = trimOrUndefined(args.explicitPrimary);
  const explicitFallback = trimOrUndefined(args.explicitFallback);

  const paid: string[] = [];
  if (args.useAlchemy && args.alchemyUrl) paid.push(args.alchemyUrl);
  if (args.useInfura && args.infuraUrl) paid.push(args.infuraUrl);

  if (explicitPrimary) {
    const urls = [explicitPrimary];
    if (explicitFallback && explicitFallback !== explicitPrimary) urls.push(explicitFallback);
    for (const url of paid) {
      if (!urls.includes(url)) urls.push(url);
    }
    return { urls, primary: urls[0], fallback: urls[1], tertiary: urls[2] };
  }

  const free = [args.publicPrimary, args.publicExtraFallback].filter(
    (url): url is string => Boolean(url),
  );
  const ordered = args.paidFirst
    ? unique([...paid, ...free])
    : unique([...free, ...paid]);
  const urls = ordered.length > 0 ? ordered : [args.publicPrimary];
  return { urls, primary: urls[0], fallback: urls[1], tertiary: urls[2] };
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

/**
 * Build chain RPC endpoints.
 * Default: Alchemy = robinhood+ethereum, Infura = none. Free public is primary.
 */
export function resolveRpcEndpoints(
  env: RpcEnvInput = process.env as unknown as RpcEnvInput,
): ResolvedRpcEndpoints {
  const alchemyKey = extractAlchemyApiKey(env.alchemyApiKey)
    ?? extractAlchemyApiKey(env.alchemyRpcUrl);
  const infuraKey = extractInfuraApiKey(env.infuraApiKey)
    ?? extractInfuraApiKey(env.infuraRpcUrl);

  const legacyPaid = env.rpcPaidChains?.trim()
    ? parseChainList(env.rpcPaidChains, DEFAULT_ALCHEMY_CHAINS)
    : null;
  const alchemyChains = parseChainList(
    env.rpcAlchemyChains,
    legacyPaid ?? DEFAULT_ALCHEMY_CHAINS,
  );
  const infuraChains = parseChainList(
    env.rpcInfuraChains,
    legacyPaid ?? DEFAULT_INFURA_CHAINS,
  );

  const paidFirst = (env.rpcPriority ?? 'free_first').trim().toLowerCase() === 'paid_first';
  const primaryTimeoutMs = Math.max(
    2_000,
    parseInt(env.rpcPrimaryTimeoutMs ?? '8000', 10) || 8_000,
  );
  const fallbackTimeoutMs = Math.max(
    primaryTimeoutMs,
    parseInt(env.rpcFallbackTimeoutMs ?? '12000', 10) || 12_000,
  );

  const onAlchemy = (chain: PaidChain) => alchemyChains.includes(chain);
  const onInfura = (chain: PaidChain) => infuraChains.includes(chain);

  const ethereum = buildChainUrls({
    explicitPrimary: env.ethereumRpcUrl,
    explicitFallback: env.ethereumRpcUrlFallback,
    publicPrimary: PUBLIC_DEFAULTS.ethereum,
    publicExtraFallback: PUBLIC_DEFAULTS.ethereumFallback,
    alchemyUrl: alchemyKey ? alchemyHttpUrl('eth-mainnet', alchemyKey) : undefined,
    infuraUrl: infuraKey ? infuraHttpUrl('eth-mainnet', infuraKey) : undefined,
    useAlchemy: onAlchemy('ethereum'),
    useInfura: onInfura('ethereum'),
    paidFirst,
  });

  const base = buildChainUrls({
    explicitPrimary: env.baseRpcUrl,
    explicitFallback: env.baseRpcUrlFallback,
    publicPrimary: PUBLIC_DEFAULTS.base,
    publicExtraFallback: PUBLIC_DEFAULTS.baseFallback,
    alchemyUrl: alchemyKey ? alchemyHttpUrl('base-mainnet', alchemyKey) : undefined,
    infuraUrl: infuraKey ? infuraHttpUrl('base-mainnet', infuraKey) : undefined,
    useAlchemy: onAlchemy('base'),
    useInfura: onInfura('base'),
    paidFirst,
  });

  const robinhood = buildChainUrls({
    explicitPrimary: env.robinhoodRpcUrl,
    explicitFallback: env.robinhoodRpcUrlFallback,
    publicPrimary: PUBLIC_DEFAULTS.robinhood,
    alchemyUrl: alchemyKey ? alchemyHttpUrl('robinhood-mainnet', alchemyKey) : undefined,
    infuraUrl: infuraKey ? infuraHttpUrl('robinhood-mainnet', infuraKey) : undefined,
    useAlchemy: onAlchemy('robinhood'),
    useInfura: onInfura('robinhood'),
    paidFirst,
  });

  const ethWsExplicit = trimOrUndefined(env.ethereumRpcWsUrl);
  const baseWsExplicit = trimOrUndefined(env.baseRpcWsUrl);
  const rhWsExplicit = trimOrUndefined(env.robinhoodRpcWsUrl);

  const ethereumRpcWsUrl = ethWsExplicit
    ?? (alchemyKey && onAlchemy('ethereum') ? alchemyWsUrl('eth-mainnet', alchemyKey) : undefined)
    ?? (infuraKey && onInfura('ethereum') ? infuraWsUrl('eth-mainnet', infuraKey) : undefined);
  const baseRpcWsUrl = baseWsExplicit
    ?? (alchemyKey && onAlchemy('base') ? alchemyWsUrl('base-mainnet', alchemyKey) : undefined)
    ?? (infuraKey && onInfura('base') ? infuraWsUrl('base-mainnet', infuraKey) : undefined);
  const robinhoodRpcWsUrl = rhWsExplicit
    ?? (alchemyKey && onAlchemy('robinhood') ? alchemyWsUrl('robinhood-mainnet', alchemyKey) : undefined)
    ?? (infuraKey && onInfura('robinhood') ? infuraWsUrl('robinhood-mainnet', infuraKey) : undefined);
  // Do not infer a paid Solana WSS endpoint. Providers can expose HTTP RPC on
  // a free plan while rejecting logsSubscribe, which makes web3.js retry and
  // log -32601 forever. With no explicit WSS URL, Connection derives the
  // well-supported public WS endpoint from the public HTTP primary.
  const alchemyActive = Boolean(alchemyKey) && alchemyChains.length > 0;
  const infuraActive = Boolean(infuraKey) && infuraChains.length > 0;
  const paidChains = unique([...alchemyChains, ...infuraChains]) as PaidChain[];

  const parts: string[] = [paidFirst ? 'paid-first' : 'free-first'];
  if (alchemyActive) parts.push(`alchemy:${alchemyChains.join('+') || 'none'}`);
  if (infuraActive) parts.push(`infura:${infuraChains.join('+') || 'none'}`);

  return {
    ethereum,
    base,
    robinhood,
    ethereumRpcWsUrl,
    baseRpcWsUrl,
    robinhoodRpcWsUrl,
    primaryTimeoutMs,
    fallbackTimeoutMs,
    alchemyActive,
    infuraActive,
    alchemyChains,
    infuraChains,
    paidChains,
    providerLabel: parts.join('|'),
  };
}

/** Back-compat accessors used by configuration.ts / older call sites. */
export function flattenResolved(rpc: ResolvedRpcEndpoints) {
  return {
    ethereumRpcUrl: rpc.ethereum.primary,
    ethereumRpcUrlFallback: rpc.ethereum.fallback,
    ethereumRpcUrls: rpc.ethereum.urls,
    ethereumRpcWsUrl: rpc.ethereumRpcWsUrl,
    baseRpcUrl: rpc.base.primary,
    baseRpcUrlFallback: rpc.base.fallback,
    baseRpcUrls: rpc.base.urls,
    baseRpcWsUrl: rpc.baseRpcWsUrl,
    robinhoodRpcUrl: rpc.robinhood.primary,
    robinhoodRpcUrlFallback: rpc.robinhood.fallback,
    robinhoodRpcUrls: rpc.robinhood.urls,
    robinhoodRpcWsUrl: rpc.robinhoodRpcWsUrl,
    primaryTimeoutMs: rpc.primaryTimeoutMs,
    fallbackTimeoutMs: rpc.fallbackTimeoutMs,
    alchemyActive: rpc.alchemyActive,
    infuraActive: rpc.infuraActive,
    alchemyChains: rpc.alchemyChains,
    infuraChains: rpc.infuraChains,
    paidChains: rpc.paidChains,
    providerLabel: rpc.providerLabel,
  };
}

function trimOrUndefined(value: string | undefined): string | undefined {
  if (value == null) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
