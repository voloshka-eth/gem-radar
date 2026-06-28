export const ONCHAIN_REDIS_CLIENT = 'ONCHAIN_REDIS_CLIENT';

// Injection token for a Map<SupportedChain, PublicClient> providing viem clients.
export const VIEM_CLIENTS = 'VIEM_CLIENTS';

// Known decimal counts for accepted quote assets — avoids an on-chain call.
export const QUOTE_ASSET_DECIMALS: Record<string, number> = {
  WETH:  18,
  USDC:   6,
  USDT:   6,
  DAI:   18,
  USDbC:  6,
};

// DefiLlama chain key mapping
export const DEFILLAMA_CHAIN: Record<string, string> = {
  ethereum: 'ethereum',
  base:     'base',
};

// Explorer API config keys per chain.
// chainId is passed as the ?chainid= param (Etherscan V2 requires it; Basescan ignores it).
export const EXPLORER_CONFIG: Record<string, { baseUrl: string; apiKeyKey: string; chainId: string }> = {
  ethereum: { baseUrl: 'explorer.etherscanBaseUrl', apiKeyKey: 'explorer.etherscanApiKey', chainId: '1' },
  base:     { baseUrl: 'explorer.basescanBaseUrl',  apiKeyKey: 'explorer.basescanApiKey',  chainId: '8453' },
};

// QuoterV2 per chain (addresses verified 2025-06 against official Uniswap deployment docs)
export const QUOTER_V2_CONFIG_KEY: Record<string, string> = {
  ethereum: 'onchain.quoterV2Ethereum',
  base:     'onchain.quoterV2Base',
};
