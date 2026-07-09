export type ContractDecision = 'CONTRACT_SAFE' | 'CONTRACT_REJECT' | 'CONTRACT_UNKNOWN';
export type RiskDataStatus =
  | 'OK'
  | 'GOPLUS_PARTIAL'
  | 'GOPLUS_TRADE_ONLY_PARTIAL'
  | 'GOPLUS_PARSE_FAILED'
  | 'GOPLUS_UNAVAILABLE'
  | 'HONEYPOT_ONLY_PARTIAL'
  | 'NO_RISK_PROVIDER_SUPPORT'
  | 'ALL_PROVIDERS_UNAVAILABLE';

/** Normalized risk fields from any provider. undefined = no data for that field. */
export interface NormalizedRiskData {
  providerStatus?: RiskDataStatus;

  // ── Source verification ──────────────────────────────────────────────────────
  verified?: boolean;                // contract source is open-source / verified

  // ── Buy/sell traps ───────────────────────────────────────────────────────────
  honeypot?: boolean;                // detected buy-only trap
  canSell?: boolean;                 // tokens can be sold; false = trapped/sell-fail

  // ── Tax ─────────────────────────────────────────────────────────────────────
  buyTax?: number;                   // percentage 0–100
  sellTax?: number;                  // percentage 0–100

  // ── Dangerous owner capabilities ─────────────────────────────────────────────
  mintRisk?: boolean;                // owner retains mint authority
  blacklistRisk?: boolean;           // owner can blacklist addresses
  pauseRisk?: boolean;               // trading can be paused by owner
  ownerPrivilegeRisk?: boolean;      // owner can reclaim previously-renounced contract (can_take_back_ownership)
  feeModifiableRisk?: boolean;       // owner can change slippage / fee parameters
  tradingCooldownRisk?: boolean;     // contract has forced trading cooldown
  hiddenOwnerRisk?: boolean;         // hidden_owner — real owner concealed by proxy
  selfdestructRisk?: boolean;        // contract can self-destruct (rug)
  antiWhaleModifiableRisk?: boolean; // owner can change anti-whale max-wallet limits

  // ── Proxy / upgradeability ───────────────────────────────────────────────────
  proxyRisk?: boolean;               // upgradeable proxy (logic can be swapped)

  // ── Ownership & LP safety ─────────────────────────────────────────────────────
  ownerRenounced?: boolean;          // ownership has been burned/zeroed (undefined if ambiguous)
  lpLockedOrBurned?: boolean;        // ≥50% of LP tokens are on dead/locker addresses
  deployerAddress?: string;          // creator/deployer address when provider exposes it
}

export interface ContractRiskResult {
  decision: ContractDecision;
  rejectReasons: string[];
  goplusQueried: boolean;
  honeypotQueried: boolean;
  merged: NormalizedRiskData;
  providerStatus?: RiskDataStatus;
  // true when result was served from Redis cache — caller skips DB persistence
  cacheHit: boolean;
}
