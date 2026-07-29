import {
  HOLDER_CONCENTRATION_GATE_CONFIG,
  evaluateHolderConcentrationGate,
} from './holder-concentration-gate';

describe('free holder concentration gate', () => {
  it('freezes the same hard thresholds as the Bubblemaps recommendation', () => {
    expect(HOLDER_CONCENTRATION_GATE_CONFIG.maxWalletShareExLp).toBe(0.60);
    expect(HOLDER_CONCENTRATION_GATE_CONFIG.maxWalletShareInclLp).toBe(0.45);
    expect(HOLDER_CONCENTRATION_GATE_CONFIG.maxTopWalletExLpPlusLp).toBe(0.70);
  });

  it('blocks top wallet ≥60% excluding LP', () => {
    const result = evaluateHolderConcentrationGate({
      holders: [
        { address: '0xwhale', share: 0.62, isLp: false, isBurn: false },
        { address: '0xlp', share: 0.10, isLp: true, isBurn: false },
      ],
    });
    expect(result.blocked).toBe(true);
    expect(result.reasons).toEqual(expect.arrayContaining([
      'wallet_ex_lp_ge_60pct',
      'wallet_incl_lp_ge_45pct',
    ]));
  });

  it('blocks top wallet ≥45% including LP and ignores burn', () => {
    const result = evaluateHolderConcentrationGate({
      holders: [
        { address: '0x000000000000000000000000000000000000dead', share: 0.80, isLp: false, isBurn: true },
        { address: '0xlp', share: 0.48, isLp: true, isBurn: false },
      ],
    });
    expect(result.blocked).toBe(true);
    expect(result.reasons).toContain('wallet_incl_lp_ge_45pct');
  });

  it('blocks top wallet ex-LP + LP ≥70%', () => {
    const result = evaluateHolderConcentrationGate({
      holders: [
        { address: '0xwhale', share: 0.35, isLp: false, isBurn: false },
        { address: '0xlp', share: 0.40, isLp: true, isBurn: false },
      ],
    });
    expect(result.topWalletExLpPlusLp).toBeCloseTo(0.75, 5);
    expect(result.reasons).toContain('top_wallet_plus_lp_ge_70pct');
  });

  it('passes diversified holders', () => {
    const result = evaluateHolderConcentrationGate({
      holders: [
        { address: '0xa', share: 0.12, isLp: false, isBurn: false },
        { address: '0xb', share: 0.10, isLp: false, isBurn: false },
        { address: '0xlp', share: 0.20, isLp: true, isBurn: false },
      ],
    });
    expect(result.blocked).toBe(false);
    expect(result.reasons).toEqual([]);
  });
});
