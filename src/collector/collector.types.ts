export type SupportedChain = 'ethereum' | 'base' | 'robinhood';

export const SUPPORTED_CHAINS: readonly SupportedChain[] = [
  'ethereum',
  'base',
  'robinhood',
] as const;

// Addresses of accepted quote assets per chain (lowercase)
export const QUOTE_ASSET_MAP: Record<SupportedChain, Record<string, string>> = {
  ethereum: {
    '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': 'WETH',
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 'USDC',
    '0xdac17f958d2ee523a2206206994597c13d831ec7': 'USDT',
    '0x6b175474e89094c44da98b954eedeac495271d0f': 'DAI',
  },
  base: {
    '0x4200000000000000000000000000000000000006': 'WETH',
    '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': 'USDC',
    '0x50c5725949a6f0c72e6c4a641f24049a917db0cb': 'DAI',
    '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca': 'USDbC',
  },
  robinhood: {
    '0x0bd7d308f8e1639fab988df18a8011f41eacad73': 'WETH',
    '0x5fc5360d0400ad4f2af552add042d716f1d168': 'USDG',
  },
};

export interface CandidateToken {
  chain: SupportedChain;
  tokenAddress: string; // always lowercase
  symbol: string;
  name: string;
  decimals?: number;
  deployerAddress?: string;
  deployerDeploymentsCount?: number | null;
  deployerRugLikeCount?: number | null;
  deployerRiskScore?: number | null;
  deployerBlocklisted?: boolean | null;
  source: string;
}

export interface CandidatePool {
  chain: SupportedChain;
  poolAddress: string; // always lowercase
  dex: string;
  token0Address: string; // always lowercase
  token1Address: string; // always lowercase
  quoteAsset: string; // 'WETH' | 'USDC' | ...
  quoteAssetAddress: string; // always lowercase
  feeTier?: string;
  // V4 pools are singleton state keyed by bytes32. Factory discovery captures the
  // Initialize event's immutable PoolKey so the verifier need not scan from genesis.
  v4Metadata?: {
    currency0: string;
    currency1: string;
    fee: number;
    tickSpacing: number;
    hooks: string;
    sqrtPriceX96: bigint;
  };
  priceUsd?: number;
  liquidityUsd?: number;
  fdvUsd?: number;
  vol5m?: number;
  vol1h?: number;
  vol6h?: number;
  vol24h?: number;
  buys1h?: number;
  sells1h?: number;
  txCount1h?: number;
  poolCreatedAt?: Date;
  creationBlockNumber?: string;
  creationTxHash?: string;
  creationLogIndex?: number;
  source: string;
}

export interface CollectorResult {
  token: CandidateToken;
  pool: CandidatePool;
}

export type TokenProbe = { chain: SupportedChain; tokenAddress: string };

// Stage 0 rejection reasons
export type Stage0RejectReason =
  | 'quote_asset_not_accepted'
  | 'pool_too_old'
  | 'liquidity_too_low'
  | 'fdv_too_low'
  | 'fdv_too_high'
  | 'ticker_blocklisted'
  | 'duplicate';

// Token-age gate rejection reasons (M3A — runs after Stage 0, before risk engine)
export type TokenAgeRejectReason = 'token_too_old';
