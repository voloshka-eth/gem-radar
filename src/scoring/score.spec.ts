import {
  scoreSnapshot,
  liquidityScore,
  depthScore,
  ageScore,
  tractionScore,
  divergenceScore,
  deployerReputationScore,
  bandFor,
  DEFAULT_SCORING_PARAMS,
  INTENDED_COMPONENT_KEYS,
  UNIMPLEMENTED_COMPONENT_KEYS,
  ScoreSnapshot,
} from './score';

// A fully-populated verified V2 survivor with a TIGHT reported↔onchain gap.
// V2 → all 5 implemented components have data.
const fullV2: ScoreSnapshot = {
  liquidityModel: 'V2',
  onchainTvlUsd: 80_000,
  executableDepthUsd: 1000,
  slip50: 0.0006,
  slip100: 0.0006,
  slip500: 0.0008,
  slip1000: 0.0012,
  reportedVsOnchainPct: 0.05, // reported ~5% above onchain — healthy for V2
  fdvUsd: 120_000,
  ageDays: 2,
  vol5m: 1_000,
  vol1h: 20_000,
  vol6h: 80_000,
  vol24h: 200_000,
  buys1h: 60,
  sells1h: 40,
  deployerDeploymentsCount: 3,
  deployerRugLikeCount: 0,
  deployerRiskScore: 0,
  deployerBlocklisted: false,
};

// Same, but V3 with a large STRUCTURAL gap → divergence is omitted (neutral).
const fullV3: ScoreSnapshot = { ...fullV2, liquidityModel: 'V3', reportedVsOnchainPct: 1.4 };

describe('scoreSnapshot — determinism / replay (PURITY CONTRACT)', () => {
  it('produces byte-identical output when run twice on the same snapshot', () => {
    const a = scoreSnapshot(fullV2);
    const b = scoreSnapshot(fullV2);
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('does not mutate its input snapshot', () => {
    const snapshot = { ...fullV2 };
    const frozen = JSON.stringify(snapshot);
    scoreSnapshot(snapshot);
    expect(JSON.stringify(snapshot)).toBe(frozen);
  });

  it('is stable across many repetitions (no hidden clock / randomness)', () => {
    const first = JSON.stringify(scoreSnapshot(fullV2));
    for (let i = 0; i < 50; i++) {
      expect(JSON.stringify(scoreSnapshot(fullV2))).toBe(first);
    }
  });
});

describe('scoreSnapshot — honest confidence over the FULL intended model', () => {
  it('never reads 1.0: even a fully-populated V2 is ~0.6 because rug-vector components are still partly unwired', () => {
    const r = scoreSnapshot(fullV2);
    // 6 implemented present / 10 intended.
    expect(r.scoreConfidence).toBeCloseTo(0.6, 5);
    expect(r.scoreConfidence).toBeLessThan(1.0);
  });

  it('always lists every unimplemented component in componentsMissing', () => {
    for (const snap of [fullV2, fullV3]) {
      const r = scoreSnapshot(snap);
      for (const k of UNIMPLEMENTED_COMPONENT_KEYS) {
        expect(r.componentsMissing).toContain(k);
      }
    }
  });

  it('intended set is the 6 implemented + 4 unimplemented (size 10)', () => {
    expect(INTENDED_COMPONENT_KEYS).toHaveLength(10);
    expect(UNIMPLEMENTED_COMPONENT_KEYS).toEqual([
      'holder_concentration', 'wash_trade', 'smart_wallet', 'unique_buyers',
    ]);
  });
});

describe('scoreSnapshot — missing data is omitted, never faked', () => {
  it('scores from present components only, with correct missing[] and reduced confidence', () => {
    // No age (archive node couldn't date it) and no traction data (no vol/buys/sells).
    const partial: ScoreSnapshot = {
      ...fullV2,
      ageDays: null,
      vol1h: null,
      buys1h: null,
      sells1h: null,
    };
    const r = scoreSnapshot(partial);

    expect(r.componentsPresent.sort()).toEqual(['deployer_reputation', 'depth', 'divergence', 'liquidity']);
    expect(r.ageScore).toBeNull();
    expect(r.tractionScore).toBeNull();
    expect(r.componentsMissing).toContain('age');
    expect(r.componentsMissing).toContain('traction');
    // 4 implemented present / 10 intended.
    expect(r.scoreConfidence).toBeCloseTo(0.4, 5);
    expect(r.finalScore).toBeGreaterThan(0);
    expect(r.finalScore).toBeLessThanOrEqual(100);
  });

  it('never substitutes a neutral 50 for a missing component', () => {
    const noAge: ScoreSnapshot = { ...fullV2, ageDays: null };
    const r = scoreSnapshot(noAge);
    expect(r.ageScore).toBeNull(); // not 50, not 0 — absent
    expect(r.componentsMissing).toContain('age');
  });

  it('traction is OMITTED (null), never defaulted, when its inputs are absent', () => {
    expect(tractionScore(null, null, null, null)).toBeNull();
    expect(tractionScore(20_000, 0, 0, 0)).toBeNull();   // TVL 0 and no trades → null
    const noTraction: ScoreSnapshot = { ...fullV2, vol1h: null, buys1h: null, sells1h: null };
    const r = scoreSnapshot(noTraction);
    expect(r.tractionScore).toBeNull();
    expect(r.componentsMissing).toContain('traction');
  });

  it('renormalizes weights: dropping a component reweights the rest (does not just zero it)', () => {
    const withAge = scoreSnapshot(fullV2);
    const noAge = scoreSnapshot({ ...fullV2, ageDays: null });
    expect(noAge.finalScore).not.toBeCloseTo(withAge.finalScore - 15, 1);
    expect(noAge.finalScore).toBeGreaterThan(0);
    expect(noAge.finalScore).toBeLessThanOrEqual(100);
  });

  it('confidence reflects component count exactly (1 of 10 present → 0.1)', () => {
    const onlyLiquidity: ScoreSnapshot = {
      liquidityModel: 'V2',
      onchainTvlUsd: 50_000,
      executableDepthUsd: null,
      slip50: null, slip100: null, slip500: null, slip1000: null,
      reportedVsOnchainPct: null,
      fdvUsd: null, ageDays: null,
      vol5m: null, vol1h: null, vol6h: null, vol24h: null,
      buys1h: null, sells1h: null,
    };
    const r = scoreSnapshot(onlyLiquidity);
    expect(r.componentsPresent).toEqual(['liquidity']);
    expect(r.scoreConfidence).toBeCloseTo(0.1, 5);
    // finalScore equals the single present component (renormalized weight = 1).
    expect(r.finalScore).toBe(r.liquidityScore);
  });
});

describe('divergenceScore — higher = healthier; V2 penalized, V3 neutral (omitted)', () => {
  it('V2: a tight reported↔onchain gap scores high (helps the score)', () => {
    expect(divergenceScore('V2', 0.05)!).toBeGreaterThan(95);
  });

  it('V2: a wide reported>>onchain gap gets a WORSE outcome than a tight one (TASK 3)', () => {
    const tight = divergenceScore('V2', 0.1)!;
    const wide  = divergenceScore('V2', 1.4)!;
    expect(wide).toBeLessThan(tight);
    expect(wide).toBeLessThan(100);
  });

  it('V2: reported ≤ onchain is healthy (100)', () => {
    expect(divergenceScore('V2', 0)).toBe(100);
    expect(divergenceScore('V2', -0.2)).toBe(100);
  });

  it('V3: structural gap is neutral — component is OMITTED (null), not a flattering 100', () => {
    expect(divergenceScore('V3', 1.4)).toBeNull();
    expect(divergenceScore('V3', 5.0)).toBeNull();
    expect(divergenceScore('V3', 0.0)).toBeNull();
  });

  it('returns null when divergence data is absent (V2)', () => {
    expect(divergenceScore('V2', null)).toBeNull();
  });

  it('end-to-end: identical snapshot scores higher as V3 than as V2 (V2 dragged by its gap)', () => {
    const asV3 = scoreSnapshot({ ...fullV3, liquidityModel: 'V3' });
    const asV2 = scoreSnapshot({ ...fullV3, liquidityModel: 'V2' });
    expect(asV3.divergenceScore).toBeNull();           // V3 neutral / omitted
    expect(asV2.divergenceScore!).toBeLessThan(100);   // V2 penalized for the 1.4 gap
    expect(asV3.finalScore).toBeGreaterThan(asV2.finalScore);
    // V3 also reports lower confidence (divergence omitted → 4/10 vs 5/10).
    expect(asV3.scoreConfidence).toBeCloseTo(0.5, 5);
    expect(asV2.scoreConfidence).toBeCloseTo(0.6, 5);
    expect(asV3.componentsMissing).toContain('divergence');
  });
});

describe('deployerReputationScore - higher = healthier deployer history', () => {
  it('omits the component when no deployer data is present', () => {
    expect(deployerReputationScore(null, null, null, null)).toBeNull();

    const r = scoreSnapshot({
      ...fullV2,
      deployerDeploymentsCount: null,
      deployerRugLikeCount: null,
      deployerRiskScore: null,
      deployerBlocklisted: null,
    });

    expect(r.deployerReputationScore).toBeNull();
    expect(r.componentsMissing).toContain('deployer_reputation');
  });

  it('penalizes repeat rug-like deployer history and hard-blocks blocklisted deployers', () => {
    expect(deployerReputationScore(4, 0, 0, false)).toBe(100);
    expect(deployerReputationScore(4, 2, 50, false)).toBe(50);
    expect(deployerReputationScore(1, 1, 100, true)).toBe(0);
  });
});

describe('component curves behave monotonically / sanely', () => {
  it('liquidityScore: floor → 0, rises with TVL, saturates at ceiling', () => {
    expect(liquidityScore(5_000)).toBe(0);
    expect(liquidityScore(250_000)).toBe(100);
    expect(liquidityScore(1_000_000)).toBe(100);
    expect(liquidityScore(50_000)!).toBeGreaterThan(liquidityScore(20_000)!);
    expect(liquidityScore(null)).toBeNull();
  });

  it('depthScore: deeper depth + lower slip → higher', () => {
    expect(depthScore(1000, 0)).toBe(100);
    expect(depthScore(50, 0.09)!).toBeLessThan(depthScore(1000, 0.001)!);
    expect(depthScore(null, null)).toBeNull();
  });

  it('ageScore: sweet-spot plateau 1–3 days, lower at the edges', () => {
    expect(ageScore(2)).toBe(100);
    expect(ageScore(0.5)!).toBeLessThan(100);
    expect(ageScore(6)!).toBeLessThan(100);
    expect(ageScore(2)!).toBeGreaterThan(ageScore(6)!);
    expect(ageScore(null)).toBeNull();
  });

  it('tractionScore: guards divide-by-zero and absurd ratios', () => {
    expect(tractionScore(20_000, 0, 0, 0)).toBeNull();
    expect(tractionScore(1e12, 50_000, 100, 0)).toBe(100); // absurd turnover + all-buys clamped
    expect(tractionScore(null, null, null, null)).toBeNull();
  });

  it('bandFor: thresholds map correctly', () => {
    const b = DEFAULT_SCORING_PARAMS.bands;
    expect(bandFor(40, b)).toBe('reject_band');
    expect(bandFor(50, b)).toBe('watchlist');
    expect(bandFor(70, b)).toBe('candidate');
    expect(bandFor(85, b)).toBe('high_band');
    expect(bandFor(99, b)).toBe('high_band');
  });
});
