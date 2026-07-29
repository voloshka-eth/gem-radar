import {
  BUBBLEMAPS_CLUSTER_GATE_CONFIG,
  evaluateBubblemapsClusterGate,
} from './bubblemaps-cluster-gate';

describe('Bubblemaps cluster gate', () => {
  it('freezes the recommended hard thresholds', () => {
    expect(BUBBLEMAPS_CLUSTER_GATE_CONFIG.maxClusterShareExLp).toBe(0.60);
    expect(BUBBLEMAPS_CLUSTER_GATE_CONFIG.maxClusterShareInclLp).toBe(0.45);
    expect(BUBBLEMAPS_CLUSTER_GATE_CONFIG.maxTopClusterExLpPlusLp).toBe(0.70);
  });

  it('blocks when one cluster holds ≥60% excluding LP', () => {
    const result = evaluateBubblemapsClusterGate({
      clusters: [{ share: 0.62, holders: ['0xa', '0xb'] }],
      holders: [
        { address: '0xa', share: 0.40, isDex: false },
        { address: '0xb', share: 0.22, isDex: false },
      ],
      dexSupplyShare: 0.05,
    });
    expect(result.blocked).toBe(true);
    expect(result.reasons).toEqual(expect.arrayContaining([
      'cluster_ex_lp_ge_60pct',
      'cluster_incl_lp_ge_45pct',
    ]));
  });

  it('blocks when one cluster holds ≥45% including LP', () => {
    const result = evaluateBubblemapsClusterGate({
      clusters: [{ share: 0.48, holders: ['0xa', '0xlp'] }],
      holders: [
        { address: '0xa', share: 0.20, isDex: false },
        { address: '0xlp', share: 0.28, isDex: true },
      ],
      dexSupplyShare: 0.28,
    });
    expect(result.blocked).toBe(true);
    expect(result.reasons).toContain('cluster_incl_lp_ge_45pct');
    expect(result.topClusterShareExLp).toBeCloseTo(0.20, 5);
  });

  it('blocks when top cluster ex-LP + LP ≥70%', () => {
    const result = evaluateBubblemapsClusterGate({
      clusters: [{ share: 0.35, holders: ['0xa'] }],
      holders: [
        { address: '0xa', share: 0.35, isDex: false },
        { address: '0xlp', share: 0.40, isDex: true },
      ],
      dexSupplyShare: 0.40,
    });
    expect(result.topClusterExLpPlusLp).toBeCloseTo(0.75, 5);
    expect(result.blocked).toBe(true);
    expect(result.reasons).toContain('top_cluster_plus_lp_ge_70pct');
  });

  it('passes a diversified map', () => {
    const result = evaluateBubblemapsClusterGate({
      clusters: [
        { share: 0.18, holders: ['0xa'] },
        { share: 0.12, holders: ['0xb'] },
      ],
      holders: [
        { address: '0xa', share: 0.18, isDex: false },
        { address: '0xb', share: 0.12, isDex: false },
        { address: '0xlp', share: 0.20, isDex: true },
      ],
      dexSupplyShare: 0.20,
    });
    expect(result.blocked).toBe(false);
    expect(result.reasons).toEqual([]);
  });
});
