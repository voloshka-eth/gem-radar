export interface GoPlusLpHolder {
  address: string;
  percent: string;   // decimal fraction: "0.9500" = 95 %
  is_locked: number; // 1 = locked (e.g. Unicrypt, Team Finance)
  is_contract: number; // 1 = contract address (but NOT assumed to be a locker — see LP-lock logic)
  tag?: string;      // 'Dead Wallet', 'Burned', 'Unicrypt', 'Team Finance', etc.
}

/** Subset of GoPlus token_security response fields used by M2A. */
export interface GoPlusTokenResult {
  is_open_source?: string;              // "1" | "0"
  is_honeypot?: string;                 // "1" | "0"
  buy_tax?: string;                     // decimal fraction: "0.05" = 5 %
  sell_tax?: string;
  transfer_tax?: string;
  cannot_buy?: string;                  // "1" = buy simulation failed/blocked
  cannot_sell_all?: string;             // "1" = cannot sell entire balance (partial sell-lock)
  is_in_dex?: string;                   // "1" = GoPlus found DEX/liquidity metadata
  can_take_back_ownership?: string;     // "1" = owner can reclaim a renounced contract
  is_mintable?: string;                 // "1" = owner can mint new tokens
  is_blacklisted?: string;              // "1" = blacklist function exists
  transfer_pausable?: string;           // "1" = trading can be paused
  is_proxy?: string;                    // "1" = upgradeable proxy
  slippage_modifiable?: string;         // "1" = owner can set slippage for all wallets
  personal_slippage_modifiable?: string; // "1" = owner can set per-wallet slippage
  trading_cooldown?: string;            // "1" = forced cooldown between trades
  hidden_owner?: string;                // "1" = real owner is hidden (proxy conceals it)
  selfdestruct?: string;                // "1" = contract has selfdestruct
  anti_whale_modifiable?: string;       // "1" = owner can change max-wallet / anti-whale limits
  owner_address?: string;               // empty or zero address = renounced (empty = ambiguous)
  creator_address?: string;             // token deployer/creator when GoPlus exposes it
  holder_count?: string;
  lp_holders?: GoPlusLpHolder[];
  dex?: unknown[];
  holders?: unknown[];
}

export interface GoPlusApiResponse {
  code: number;
  message: string;
  result?: Record<string, GoPlusTokenResult>;
}

export interface GoPlusAccessTokenResponse {
  code: number;
  message: string;
  result?: {
    access_token?: string;
    token?: string;
    expires_in?: number | string;
    expire_time?: number | string;
  };
  access_token?: string;
  token?: string;
  expires_in?: number | string;
  expire_time?: number | string;
}
