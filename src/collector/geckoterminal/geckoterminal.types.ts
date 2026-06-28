// GeckoTerminal /networks/{network}/new_pools response shapes

export interface GtTokenAttributes {
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  image_url: string | null;
  coingecko_coin_id: string | null;
}

export interface GtDexAttributes {
  name: string;
}

export interface GtIncluded {
  id: string;
  type: 'token' | 'dex';
  attributes: GtTokenAttributes | GtDexAttributes;
}

export interface GtVolumeUsd {
  m5: string;
  h1: string;
  h6: string;
  h24: string;
}

export interface GtTransactionBucket {
  buys: number;
  sells: number;
  buyers: number;
  sellers: number;
}

export interface GtPoolAttributes {
  base_token_price_usd: string | null;
  quote_token_price_usd: string | null;
  address: string;
  name: string;
  pool_created_at: string | null;
  fdv_usd: string | null;
  reserve_in_usd: string | null;
  volume_usd: GtVolumeUsd;
  transactions: {
    m5: GtTransactionBucket;
    h1: GtTransactionBucket;
    h6: GtTransactionBucket;
    h24: GtTransactionBucket;
  };
}

export interface GtRelationshipRef {
  data: { id: string; type: string };
}

export interface GtPool {
  id: string;
  type: 'pool';
  attributes: GtPoolAttributes;
  relationships: {
    base_token: GtRelationshipRef;
    quote_token: GtRelationshipRef;
    dex: GtRelationshipRef;
  };
}

export interface GtNewPoolsResponse {
  data: GtPool[];
  included?: GtIncluded[];
}

// Map our chain names to GeckoTerminal network slugs
export const GT_NETWORK: Record<string, string> = {
  ethereum: 'eth',
  base: 'base',
};
