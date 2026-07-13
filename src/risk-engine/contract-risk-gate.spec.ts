import { applyContractRiskGate, mergeRiskData } from './contract-risk-gate';
import { NormalizedRiskData } from './risk-engine.types';

const CLEAN: NormalizedRiskData = {
  verified: true,
  honeypot: false,
  canSell: undefined,
  buyTax: 0,
  sellTax: 0,
  mintRisk: false,
  blacklistRisk: false,
  pauseRisk: false,
  proxyRisk: false,
  ownerRenounced: true,
  ownerPrivilegeRisk: false,
  lpLockedOrBurned: true,
};

describe('applyContractRiskGate', () => {
  it('returns CONTRACT_SAFE for a clean token', () => {
    const { decision, rejectReasons } = applyContractRiskGate(CLEAN);
    expect(decision).toBe('CONTRACT_SAFE');
    expect(rejectReasons).toHaveLength(0);
  });

  it('rejects honeypot_detected', () => {
    const { decision, rejectReasons } = applyContractRiskGate({ ...CLEAN, honeypot: true });
    expect(decision).toBe('CONTRACT_REJECT');
    expect(rejectReasons).toContain('honeypot_detected');
  });

  it('rejects cannot_sell when canSell is false', () => {
    const { decision, rejectReasons } = applyContractRiskGate({ ...CLEAN, canSell: false });
    expect(decision).toBe('CONTRACT_REJECT');
    expect(rejectReasons).toContain('cannot_sell');
  });

  it('does NOT reject when canSell is undefined', () => {
    const { decision } = applyContractRiskGate({ ...CLEAN, canSell: undefined });
    expect(decision).toBe('CONTRACT_SAFE');
  });

  it('rejects any non-zero sell_tax with formatted reason', () => {
    const { decision, rejectReasons } = applyContractRiskGate({ ...CLEAN, sellTax: 15 });
    expect(decision).toBe('CONTRACT_REJECT');
    expect(rejectReasons).toContain('sell_tax_15.0pct');
  });

  it('rejects any non-zero buy_tax with formatted reason', () => {
    const { rejectReasons } = applyContractRiskGate({ ...CLEAN, buyTax: 25.5 });
    expect(rejectReasons).toContain('buy_tax_25.5pct');
  });

  it('rejects sell_tax exactly 10 %', () => {
    const { decision, rejectReasons } = applyContractRiskGate({ ...CLEAN, sellTax: 10 });
    expect(decision).toBe('CONTRACT_REJECT');
    expect(rejectReasons).toContain('sell_tax_10.0pct');
  });

  it('rejects owner_can_mint', () => {
    const { rejectReasons } = applyContractRiskGate({ ...CLEAN, mintRisk: true });
    expect(rejectReasons).toContain('owner_can_mint');
  });

  it('rejects blacklist_function_detected', () => {
    const { rejectReasons } = applyContractRiskGate({ ...CLEAN, blacklistRisk: true });
    expect(rejectReasons).toContain('blacklist_function_detected');
  });

  it('rejects trading_can_be_paused', () => {
    const { rejectReasons } = applyContractRiskGate({ ...CLEAN, pauseRisk: true });
    expect(rejectReasons).toContain('trading_can_be_paused');
  });

  it('rejects owner_can_reclaim_ownership (ownerPrivilegeRisk = can_take_back_ownership)', () => {
    const { rejectReasons } = applyContractRiskGate({ ...CLEAN, ownerPrivilegeRisk: true });
    expect(rejectReasons).toContain('owner_can_reclaim_ownership');
    expect(rejectReasons).not.toContain('owner_can_change_fees');
  });

  it('rejects owner_can_change_fees (feeModifiableRisk = slippage_modifiable)', () => {
    const { rejectReasons } = applyContractRiskGate({ ...CLEAN, feeModifiableRisk: true });
    expect(rejectReasons).toContain('owner_can_change_fees');
  });

  it('rejects trading_cooldown_detected', () => {
    const { rejectReasons } = applyContractRiskGate({ ...CLEAN, tradingCooldownRisk: true });
    expect(rejectReasons).toContain('trading_cooldown_detected');
  });

  it('rejects hidden_owner_detected', () => {
    const { rejectReasons } = applyContractRiskGate({ ...CLEAN, hiddenOwnerRisk: true });
    expect(rejectReasons).toContain('hidden_owner_detected');
  });

  it('rejects selfdestruct_risk', () => {
    const { rejectReasons } = applyContractRiskGate({ ...CLEAN, selfdestructRisk: true });
    expect(rejectReasons).toContain('selfdestruct_risk');
  });

  it('rejects anti_whale_modifiable', () => {
    const { rejectReasons } = applyContractRiskGate({ ...CLEAN, antiWhaleModifiableRisk: true });
    expect(rejectReasons).toContain('anti_whale_modifiable');
  });

  it('does NOT reject on lpLockedOrBurned=false — scoring signal only, not a hard gate', () => {
    const { decision } = applyContractRiskGate({ ...CLEAN, lpLockedOrBurned: false });
    expect(decision).toBe('CONTRACT_SAFE');
  });

  it('rejects proxy_risk', () => {
    const { rejectReasons } = applyContractRiskGate({ ...CLEAN, proxyRisk: true });
    expect(rejectReasons).toContain('proxy_risk');
  });

  it('keeps holder concentration as data for scoring, not an unvalidated hard gate', () => {
    expect(applyContractRiskGate({ ...CLEAN, topNonContractHolderPct: 0.99 }).decision).toBe('CONTRACT_SAFE');
  });

  it('accumulates multiple reject reasons without short-circuiting', () => {
    const { decision, rejectReasons } = applyContractRiskGate({
      ...CLEAN,
      honeypot: true,
      mintRisk: true,
      blacklistRisk: true,
    });
    expect(decision).toBe('CONTRACT_REJECT');
    expect(rejectReasons).toHaveLength(3);
    expect(rejectReasons).toContain('honeypot_detected');
    expect(rejectReasons).toContain('owner_can_mint');
    expect(rejectReasons).toContain('blacklist_function_detected');
  });

  it('ignores undefined risk flags — does not reject', () => {
    const { decision } = applyContractRiskGate({
      honeypot: undefined,
      mintRisk: undefined,
      sellTax: undefined,
    });
    expect(decision).toBe('CONTRACT_SAFE');
  });
});

describe('mergeRiskData', () => {
  it('returns primary unchanged when no supplementary', () => {
    const merged = mergeRiskData(CLEAN);
    expect(merged).toEqual(CLEAN);
  });

  it('supplementary honeypot=true overrides primary honeypot=false', () => {
    const merged = mergeRiskData(
      { ...CLEAN, honeypot: false },
      { honeypot: true },
    );
    expect(merged.honeypot).toBe(true);
  });

  it('primary honeypot=true is not overridden by supplementary honeypot=false', () => {
    const merged = mergeRiskData(
      { honeypot: true },
      { honeypot: false },
    );
    expect(merged.honeypot).toBe(true);
  });

  it('canSell: false is most pessimistic — overrides true', () => {
    const merged = mergeRiskData(
      { canSell: true },
      { canSell: false },
    );
    expect(merged.canSell).toBe(false);
  });

  it('sellTax: takes maximum across providers', () => {
    const merged = mergeRiskData(
      { sellTax: 5 },
      { sellTax: 12 },
    );
    expect(merged.sellTax).toBe(12);
  });

  it('undefined fields are filled from supplementary', () => {
    const merged = mergeRiskData(
      { honeypot: undefined },
      { honeypot: false },
    );
    expect(merged.honeypot).toBe(false);
  });

  it('takes the most concentrated provider reading when merging holder data', () => {
    const merged = mergeRiskData(
      { topNonContractHolderPct: 0.4, top10NonContractHolderPct: 0.7 },
      { topNonContractHolderPct: 0.8, top10NonContractHolderPct: 0.9 },
    );
    expect(merged.topNonContractHolderPct).toBe(0.8);
    expect(merged.top10NonContractHolderPct).toBe(0.9);
  });
});
