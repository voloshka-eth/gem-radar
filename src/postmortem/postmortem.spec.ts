import { computePostmortem, ClosedFeatureRow } from './postmortem';

function row(outcomeClass: string, onchainTvlUsd: number, finalScore: number): ClosedFeatureRow {
  return { outcomeClass, features: { onchainTvlUsd, finalScore } };
}

describe('computePostmortem — groups, separation, overfitting warning', () => {
  it('splits BAD (rug/loss) vs GOOD (win) and computes per-group distributions', () => {
    const rows = [
      row('RUG', 100, 40), row('LOSS', 200, 45),
      row('WIN', 50_000, 80), row('WIN', 60_000, 85),
    ];
    const r = computePostmortem(rows, 30);
    expect(r.nBad).toBe(2);
    expect(r.nGood).toBe(2);
    const tvl = r.features.find((f) => f.feature === 'onchainTvlUsd')!;
    expect(tvl.bad.mean).toBeCloseTo(150, 6);
    expect(tvl.good.mean).toBeCloseTo(55_000, 6);
  });

  it('fires the overfitting warning when a group is under minPerGroup', () => {
    const rows = [row('RUG', 100, 40), row('WIN', 50_000, 80)];
    const r = computePostmortem(rows, 30);
    expect(r.underpowered).toBe(true); // 1 per group < 30
  });

  it('is NOT underpowered when both groups meet the threshold', () => {
    const rows = [
      ...Array.from({ length: 30 }, () => row('RUG', 100, 40)),
      ...Array.from({ length: 30 }, () => row('WIN', 50_000, 80)),
    ];
    const r = computePostmortem(rows, 30);
    expect(r.underpowered).toBe(false);
    const tvl = r.features.find((f) => f.feature === 'onchainTvlUsd')!;
    expect(tvl.separates).toBe(true); // clearly separated means
  });

  it('handles missing feature values without crashing (null distributions)', () => {
    const rows: ClosedFeatureRow[] = [
      { outcomeClass: 'RUG', features: { onchainTvlUsd: null, finalScore: 40 } },
      { outcomeClass: 'WIN', features: { onchainTvlUsd: null, finalScore: 80 } },
    ];
    const r = computePostmortem(rows, 30);
    const tvl = r.features.find((f) => f.feature === 'onchainTvlUsd')!;
    expect(tvl.bad.mean).toBeNull();
    expect(tvl.separates).toBe(false);
  });
});
