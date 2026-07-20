import type { ContractRiskResult } from '../risk-engine/risk-engine.types';

export type FlowRiskCohort = 'CONTRACT_SAFE' | 'SOFT_RISK';

export function contractHardRiskReason(risk: ContractRiskResult): string | null {
  const merged = risk.merged;
  if (merged.honeypot === true) return 'confirmed_honeypot';
  if (merged.canSell === false) return 'cannot_sell';
  if (taxFraction(merged.sellTax) >= 0.5) return 'sell_tax_50pct';
  return null;
}

export function classifyFlowRisk(risk: ContractRiskResult): FlowRiskCohort {
  const m = risk.merged;
  const soft = risk.decision !== 'CONTRACT_SAFE' || risk.rejectReasons.length > 0 ||
    m.mintRisk === true || m.proxyRisk === true || m.blacklistRisk === true || m.pauseRisk === true ||
    m.ownerPrivilegeRisk === true || m.feeModifiableRisk === true || m.ownerRenounced !== true ||
    m.lpLockedOrBurned !== true;
  return soft ? 'SOFT_RISK' : 'CONTRACT_SAFE';
}

function taxFraction(value: number | null | undefined): number {
  if (value == null || !Number.isFinite(value) || value <= 0) return 0;
  return value > 1 ? value / 100 : value;
}
