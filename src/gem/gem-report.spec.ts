import { deriveSummaries, RawGemCandidate } from './gem-report';

// NOTE: this verifies ONLY the re-baseline arithmetic/eligibility of deriveSummaries.
// It is NOT evidence of any edge or live result — the live snipe@3h cohort is currently
// empty (the collected candidates were tracked after 3h had already elapsed).

const mk = (over: Partial<RawGemCandidate>): RawGemCandidate => ({
  tokenAddress: '0xabc', symbol: 'T', entryFdvUsd: 10_000, ticks: [], ...over,
});

describe('deriveSummaries — re-baseline math', () => {
  it('t0 baseline: multiples are vs discovery FDV; all candidates eligible', () => {
    const c = mk({ ticks: [
      { horizon: '3h', elapsedMin: 180, fdvUsd: 20_000, rug: false },
      { horizon: '24h', elapsedMin: 1440, fdvUsd: 200_000, rug: false },
    ] });
    const [s] = deriveSummaries([c], 't0');
    expect(s.maxMultiple).toBeCloseTo(20, 6);     // 200k / 10k
    expect(s.historyMaxMin).toBe(1440);
    expect(s.rugged).toBe(false);
  });

  it('3h baseline: returns measured FROM the 3h FDV, not t0', () => {
    const c = mk({ ticks: [
      { horizon: '3h', elapsedMin: 180, fdvUsd: 20_000, rug: false },
      { horizon: '24h', elapsedMin: 1440, fdvUsd: 200_000, rug: false },
    ] });
    const [s] = deriveSummaries([c], '3h');
    expect(s.maxMultiple).toBeCloseTo(10, 6);     // 200k / 20k (re-based on 3h)
    expect(s.historyMaxMin).toBe(1440 - 180);     // forward history since the baseline
  });

  it('3h baseline: a token rugged AT 3h is NOT enterable (excluded)', () => {
    const rugged = mk({ tokenAddress: '0xdead', ticks: [
      { horizon: '3h', elapsedMin: 180, fdvUsd: 20_000, rug: true },
      { horizon: '24h', elapsedMin: 1440, fdvUsd: 1, rug: true },
    ] });
    expect(deriveSummaries([rugged], '3h')).toHaveLength(0);
    expect(deriveSummaries([rugged], 't0')).toHaveLength(1); // but it IS in the t0 cohort
  });

  it('3h baseline: a token with no captured 3h tick is excluded', () => {
    const noBaseline = mk({ ticks: [{ horizon: '24h', elapsedMin: 1440, fdvUsd: 5_000, rug: false }] });
    expect(deriveSummaries([noBaseline], '3h')).toHaveLength(0);
  });

  it('3h baseline: forward FDV below the 3h FDV yields a <1x (a loss for the sniper)', () => {
    const c = mk({ ticks: [
      { horizon: '3h', elapsedMin: 180, fdvUsd: 50_000, rug: false },
      { horizon: '24h', elapsedMin: 1440, fdvUsd: 5_000, rug: false },
    ] });
    const [s] = deriveSummaries([c], '3h');
    expect(s.maxMultiple).toBeCloseTo(0.1, 6);    // 5k / 50k
  });
});
