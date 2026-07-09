// DexScreener API response shapes

export interface DsTokenProfile {
  url: string;            // https://dexscreener.com/ethereum/0x...
  chainId: string;        // "ethereum" | "base" | ...
  tokenAddress: string;
  icon: string | null;
  header: string | null;
  description: string | null;
  links: Array<{ label: string; type: string; url: string }> | null;
}

export type DsTokenProfilesResponse = DsTokenProfile[];

export interface DsTokenBoost {
  url: string;
  chainId: string;
  tokenAddress: string;
  amount?: number;
  totalAmount?: number;
  icon?: string | null;
  header?: string | null;
  description?: string | null;
  links?: Array<{ label: string; type: string; url: string }> | null;
}

export type DsTokenBoostsResponse = DsTokenBoost[];

export interface DsTokenAd {
  url: string;
  chainId: string;
  tokenAddress: string;
  date?: string;
  type?: string;
  durationHours?: number | null;
  impressions?: number | null;
}

export type DsTokenAdsResponse = DsTokenAd[];

// Pair data returned by DexScreener token/pair endpoints.
export interface DsPairTransaction {
  buys: number;
  sells: number;
}

export interface DsPairLiquidity {
  usd: number;
  base: number;
  quote: number;
}

export interface DsPair {
  chainId: string;
  dexId: string;
  url: string;
  pairAddress: string;
  baseToken: { address: string; name: string; symbol: string };
  quoteToken: { address: string; name: string; symbol: string };
  priceNative: string;
  priceUsd: string | null;
  txns: {
    m5: DsPairTransaction;
    h1: DsPairTransaction;
    h6: DsPairTransaction;
    h24: DsPairTransaction;
  };
  volume: { m5: number; h1: number; h6: number; h24: number };
  priceChange: { m5: number; h1: number; h6: number; h24: number };
  liquidity?: DsPairLiquidity;
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number; // unix ms
  labels?: string[];
}

export interface DsTokenResponse {
  schemaVersion: string;
  pairs: DsPair[] | null;
}

export type DsTokensV1Response = DsPair[];

// Map DexScreener chainId strings to our SupportedChain type
export const DS_CHAIN_MAP: Record<string, string> = {
  ethereum: 'ethereum',
  base: 'base',
  robinhood: 'robinhood',
};
