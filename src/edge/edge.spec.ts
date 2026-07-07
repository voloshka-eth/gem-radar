import { computeEdge, ClosedPosition, EdgeParams } from './edge';

const P: EdgeParams = { minClosed: 50, scoreThreshold: 70 };

function mk(realizedMultiple: number, finalScore: number, band: string, fdvUsd?: number): ClosedPosition {
  return { realizedMultiple, finalScore, band, fdvUsd };
}

describe('computeEdge — verdict wiring', () => {
  it('N < minClosed → INSUFFICIENT SAMPLE → NO EDGE', () => {
    const r = computeEdge([mk(2, 80, 'high_band'), mk(1.5, 75, 'candidate')], P);
    expect(r.insufficientSample).toBe(true);
    expect(r.verdict).toMatch(/NO EDGE DEMONSTRATED/);
    expect(r.reasons.some((x) => /insufficient sample/.test(x))).toBe(true);
  });

  it('enough sample but score does NOT beat baseline → NO EDGE', () => {
    // High-score names do WORSE than low-score names → filtering by score hurts.
    const positions = Array.from({ length: 60 }, (_, i) =>
      i % 2 ? mk(1.1, 90, 'high_band') : mk(1.6, 40, 'reject_band'),
    );
    const r = computeEdge(positions, P);
    expect(r.insufficientSample).toBe(false);
    expect(r.scoreBeatsBaseline).toBe(false); // filtered 0.1 < baseline ~0.35
    expect(r.verdict).toMatch(/NO EDGE DEMONSTRATED/);
  });

  it('non-monotonic bands → NO EDGE, flagged as noise', () => {
    // high_band performs WORSE than watchlist → non-monotonic.
    const positions = [
      ...Array.from({ length: 30 }, () => mk(2.0, 55, 'watchlist')),
      ...Array.from({ length: 30 }, () => mk(0.5, 90, 'high_band')),
    ];
    const r = computeEdge(positions, P);
    expect(r.bandsMonotonic).toBe(false);
    expect(r.verdict).toMatch(/NO EDGE DEMONSTRATED/);
    expect(r.reasons.some((x) => /NOT monotonic/.test(x))).toBe(true);
  });

  it('expectancy is net per $1 (multiple − 1)', () => {
    const r = computeEdge(Array.from({ length: 50 }, () => mk(1.5, 80, 'high_band')), P);
    expect(r.expectancyEnterAll).toBeCloseTo(0.5, 6);
  });

  it('groups closed positions by entry FDV for hypothesis analysis', () => {
    const r = computeEdge([
      mk(2.0, 80, 'candidate', 25_000),
      mk(0.5, 80, 'candidate', 75_000),
      mk(1.5, 80, 'candidate', 750_000),
    ], { minClosed: 1, scoreThreshold: 70 });

    expect(r.fdvBuckets).toEqual([
      { bucket: '<$50k', n: 1, expectancyPer$1: 1 },
      { bucket: '$50k-$100k', n: 1, expectancyPer$1: -0.5 },
      { bucket: '$300k-$1M', n: 1, expectancyPer$1: 0.5 },
    ]);
  });

  it('only a genuinely superior, monotonic, profitable, large sample survives', () => {
    const positions = [
      ...Array.from({ length: 30 }, () => mk(0.6, 40, 'reject_band')),
      ...Array.from({ length: 30 }, () => mk(1.0, 60, 'watchlist')),
      ...Array.from({ length: 30 }, () => mk(1.4, 75, 'candidate')),
      ...Array.from({ length: 30 }, () => mk(2.2, 90, 'high_band')),
    ];
    const r = computeEdge(positions, P);
    expect(r.insufficientSample).toBe(false);
    expect(r.bandsMonotonic).toBe(true);
    expect(r.scoreBeatsBaseline).toBe(true);
    expect(r.verdict).toMatch(/SURVIVES/);
  });
});
