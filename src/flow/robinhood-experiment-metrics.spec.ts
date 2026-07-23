import {
  bootstrapMeanConfidenceInterval,
  pairedPnlDifferences,
  summarizeArm,
  type ResolvedArmSample,
} from './robinhood-experiment-metrics';

function sample(id: string, committed: number, realized: number, t0AtMs = 0): ResolvedArmSample {
  return {
    experimentId: id, t0AtMs, armCode: 'B', scenarioCode: 'PRIMARY_2S',
    committedUsd: committed, realizedUsd: realized, capitalSeconds: committed * 3_600,
  };
}

describe('Robinhood experiment metrics', () => {
  it('reports raw/capped EV, fat-tail exclusions and capital-hour economics', () => {
    const metric = summarizeArm([
      sample('a', 20, 10, 1),
      sample('b', 20, 30, 2),
      sample('c', 20, 400, 3),
    ]);
    expect(metric.rawEvUsd).toBeCloseTo(380 / 3);
    expect(metric.capped10xEvUsd).toBeCloseTo(180 / 3);
    expect(metric.pnlWithoutTop1Usd).toBe(0);
    expect(metric.pnlWithoutTop3Usd).toBe(-10);
    expect(metric.profitFactor).toBe(39);
    expect(metric.capitalHours).toBe(60);
  });

  it('keeps comparisons paired by experiment id', () => {
    const left = [sample('a', 20, 25), sample('b', 20, 10), sample('unpaired', 20, 100)];
    const right = [sample('a', 20, 20), sample('b', 20, 15)];
    expect(pairedPnlDifferences(left, right)).toEqual([5, -5]);
  });

  it('produces a deterministic bootstrap interval', () => {
    const first = bootstrapMeanConfidenceInterval([1, 2, 3, 4], 1_000);
    const second = bootstrapMeanConfidenceInterval([1, 2, 3, 4], 1_000);
    expect(first).toEqual(second);
    expect(first?.lower95).toBeLessThan(first!.mean);
    expect(first?.upper95).toBeGreaterThan(first!.mean);
  });
});

