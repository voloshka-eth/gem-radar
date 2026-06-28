export type SupportedChain = 'ethereum' | 'base';

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
};

export interface CandidateToken {
  chain: SupportedChain;
  tokenAddress: string; // always lowercase
  symbol: string;
  name: string;
  decimals?: number;
  deployerAddress?: string;
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
  source: string;
}

export interface CollectorResult {
  token: CandidateToken;
  pool: CandidatePool;
}

// Stage 0 rejection reasons
export type Stage0RejectReason =
  | 'quote_asset_not_accepted'
  | 'pool_too_old'
  | 'liquidity_too_low'
  | 'fdv_too_low'
  | 'fdv_too_high'
  | 'duplicate';

// Token-age gate rejection reasons (M3A — runs after Stage 0, before risk engine)
export type TokenAgeRejectReason = 'token_too_old';
