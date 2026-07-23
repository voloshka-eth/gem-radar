import {
  entrySlippagePct,
  executablePositionMultiple,
  nextLadderRung,
  normalizeFinishingRate,
  prioritizeRouteProbes,
  prioritizeRouteReady,
  tokenAmount,
} from './solana-paper';

describe('Solana paper math', () => {
  it('normalizes fractional and percentage graduation progress', () => {
    expect(normalizeFinishingRate(0.97)).toBe(0.97);
    expect(normalizeFinishingRate(97)).toBe(0.97);
  });

  it('probes graduation-ready launches even when they are outside an initial page', () => {
    const launches = Array.from({ length: 30 }, (_, index) => ({
      id: index,
      finishingRate: index === 29 ? 100 : 0.5,
    }));

    const ready = prioritizeRouteReady(launches, (launch) => launch.finishingRate, 0.95);

    expect(ready.map((launch) => launch.id)).toEqual([29]);
  });

  it('still probes launches whose API finishing rate is stale after the fallback interval', () => {
    const now = 100_000;
    const launches = [
      { id: 'stale', finishingRate: 0, lastProbe: 1_000 },
      { id: 'ready', finishingRate: 0.98, lastProbe: 80_000 },
      { id: 'not-due', finishingRate: 0, lastProbe: 90_000 },
    ];

    const due = prioritizeRouteProbes(
      launches,
      (launch) => launch.finishingRate,
      (launch) => launch.lastProbe,
      now,
      0.95,
      15_000,
      60_000,
    );

    expect(due.map((launch) => launch.id)).toEqual(['ready', 'stale']);
  });

  it('converts raw token amounts without losing the decimal scale', () => {
    expect(tokenAmount('1234567', 6)).toBeCloseTo(1.234567, 6);
  });

  it('derives entry slippage from launch spot and executable output', () => {
    expect(entrySlippagePct(20, '10000000', 6, 2)).toBeCloseTo(0, 8);
    expect(entrySlippagePct(20, '8000000', 6, 2)).toBeCloseTo(0.25, 8);
  });

  it('compares executable value against the capital allocated to remaining tokens', () => {
    expect(executablePositionMultiple(8, 20n, 100n, 20)).toBe(2);
  });

  it('returns only the first unexecuted ladder rung', () => {
    expect(nextLadderRung(12, new Set())).toEqual({ multiple: 2, fraction: 0.8 });
    expect(nextLadderRung(12, new Set([2]))).toEqual({ multiple: 10, fraction: 0.15 });
  });
});
