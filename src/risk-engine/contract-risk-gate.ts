import { ContractDecision, NormalizedRiskData } from './risk-engine.types';

export interface ContractGateResult {
  decision: ContractDecision;
  rejectReasons: string[];
}

/**
 * Pure hard-reject gate — no I/O.
 * Any truthy risk flag → CONTRACT_REJECT with a reason code.
 * All reasons are accumulated (not short-circuited) so the full picture is logged.
 *
 * 14 rules total (was 9 in M2A initial; 5 added in M2A quality pass).
 */
export function applyContractRiskGate(data: NormalizedRiskData): ContractGateResult {
  const reasons: string[] = [];

  // ── Buy/sell traps ───────────────────────────────────────────────────────────
  if (data.honeypot === true) reasons.push('honeypot_detected');
  if (data.canSell === false) reasons.push('cannot_sell');

  // ── Tax (any non-zero detectable tax → reject) ─────────────────────────────
  if (data.sellTax !== undefined && data.sellTax > 0)
    reasons.push(`sell_tax_${data.sellTax.toFixed(1)}pct`);
  if (data.buyTax !== undefined && data.buyTax > 0)
    reasons.push(`buy_tax_${data.buyTax.toFixed(1)}pct`);

  // ── Owner capabilities (dangerous) ──────────────────────────────────────────
  if (data.mintRisk === true) reasons.push('owner_can_mint');
  if (data.blacklistRisk === true) reasons.push('blacklist_function_detected');
  if (data.pauseRisk === true) reasons.push('trading_can_be_paused');
  if (data.ownerPrivilegeRisk === true) reasons.push('owner_can_reclaim_ownership');
  if (data.feeModifiableRisk === true) reasons.push('owner_can_change_fees');
  if (data.tradingCooldownRisk === true) reasons.push('trading_cooldown_detected');
  if (data.hiddenOwnerRisk === true) reasons.push('hidden_owner_detected');
  if (data.selfdestructRisk === true) reasons.push('selfdestruct_risk');
  if (data.antiWhaleModifiableRisk === true) reasons.push('anti_whale_modifiable');

  // ── Proxy / upgradeability ───────────────────────────────────────────────────
  if (data.proxyRisk === true) reasons.push('proxy_risk');

  // NOTE: lpLockedOrBurned is computed and logged but NOT a hard-reject here.
  // GoPlus lp_holders is a V2 fungible-LP model; Base NFT positions (Uni V3/V4,
  // Aerodrome ve(3,3)) are often missing or irrelevant → too many false rejects.
  // Reserved as a scoring penalty signal in M4.

  if (reasons.length > 0) {
    return { decision: 'CONTRACT_REJECT', rejectReasons: reasons };
  }
  return { decision: 'CONTRACT_SAFE', rejectReasons: [] };
}

/**
 * Merge two normalized risk datasets — primary (GoPlus) and supplementary (Honeypot.is).
 * Risk-increasing flags (honeypot, mint, blacklist…): true wins.
 * Risk-decreasing flags (canSell, ownerRenounced…): false wins (most pessimistic).
 * Numeric taxes: take the maximum.
 * New fields in the supplementary source are folded in via the same rules.
 */
export function mergeRiskData(
  primary: NormalizedRiskData,
  supplementary?: NormalizedRiskData,
): NormalizedRiskData {
  if (!supplementary) return primary;

  // true wins (risk flag)
  const riskWins = (a?: boolean, b?: boolean): boolean | undefined => {
    if (a === true || b === true) return true;
    if (a === false || b === false) return false;
    return undefined;
  };

  // false wins (safety flag — pessimistic)
  const safeWins = (a?: boolean, b?: boolean): boolean | undefined => {
    if (a === false || b === false) return false;
    if (a === true || b === true) return true;
    return undefined;
  };

  const numMax = (a?: number, b?: number): number | undefined => {
    if (a === undefined) return b;
    if (b === undefined) return a;
    return Math.max(a, b);
  };

  return {
    providerStatus:            primary.providerStatus ?? supplementary.providerStatus,
    verified:                 safeWins(primary.verified, supplementary.verified),
    honeypot:                 riskWins(primary.honeypot, supplementary.honeypot),
    canSell:                  safeWins(primary.canSell, supplementary.canSell),
    buyTax:                   numMax(primary.buyTax, supplementary.buyTax),
    sellTax:                  numMax(primary.sellTax, supplementary.sellTax),
    mintRisk:                 riskWins(primary.mintRisk, supplementary.mintRisk),
    blacklistRisk:            riskWins(primary.blacklistRisk, supplementary.blacklistRisk),
    pauseRisk:                riskWins(primary.pauseRisk, supplementary.pauseRisk),
    proxyRisk:                riskWins(primary.proxyRisk, supplementary.proxyRisk),
    ownerPrivilegeRisk:       riskWins(primary.ownerPrivilegeRisk, supplementary.ownerPrivilegeRisk),
    feeModifiableRisk:        riskWins(primary.feeModifiableRisk, supplementary.feeModifiableRisk),
    tradingCooldownRisk:      riskWins(primary.tradingCooldownRisk, supplementary.tradingCooldownRisk),
    hiddenOwnerRisk:          riskWins(primary.hiddenOwnerRisk, supplementary.hiddenOwnerRisk),
    selfdestructRisk:         riskWins(primary.selfdestructRisk, supplementary.selfdestructRisk),
    antiWhaleModifiableRisk:  riskWins(primary.antiWhaleModifiableRisk, supplementary.antiWhaleModifiableRisk),
    ownerRenounced:           safeWins(primary.ownerRenounced, supplementary.ownerRenounced),
    lpLockedOrBurned:         safeWins(primary.lpLockedOrBurned, supplementary.lpLockedOrBurned),
    deployerAddress:          primary.deployerAddress ?? supplementary.deployerAddress,
    topNonContractHolderPct:  numMax(primary.topNonContractHolderPct, supplementary.topNonContractHolderPct),
    top10NonContractHolderPct: numMax(primary.top10NonContractHolderPct, supplementary.top10NonContractHolderPct),
    holderCount:              primary.holderCount ?? supplementary.holderCount,
  };
}
