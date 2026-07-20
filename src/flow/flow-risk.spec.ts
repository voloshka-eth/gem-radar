import type { ContractRiskResult } from '../risk-engine/risk-engine.types';
import { classifyFlowRisk, contractHardRiskReason } from './flow-risk';

function risk(overrides: Partial<ContractRiskResult> = {}): ContractRiskResult {
  return {
    decision: 'CONTRACT_SAFE', rejectReasons: [], goplusQueried: true,
    honeypotQueried: true, cacheHit: false,
    merged: { ownerRenounced: true, lpLockedOrBurned: true },
    ...overrides,
  };
}

describe('flow risk classification', () => {
  it('keeps provider gaps and owner capabilities in SOFT_RISK', () => {
    expect(classifyFlowRisk(risk({
      decision: 'CONTRACT_UNKNOWN',
      rejectReasons: ['GOPLUS_PARTIAL'],
      merged: { mintRisk: true },
    }))).toBe('SOFT_RISK');
  });

  it('does not turn a clean result into soft risk', () => {
    expect(classifyFlowRisk(risk())).toBe('CONTRACT_SAFE');
  });

  it.each([
    [{ honeypot: true }, 'confirmed_honeypot'],
    [{ canSell: false }, 'cannot_sell'],
    [{ sellTax: 50 }, 'sell_tax_50pct'],
    [{ sellTax: 0.5 }, 'sell_tax_50pct'],
  ] as const)('hard rejects proven sell hazards', (merged, expected) => {
    expect(contractHardRiskReason(risk({ merged }))).toBe(expected);
  });
});
