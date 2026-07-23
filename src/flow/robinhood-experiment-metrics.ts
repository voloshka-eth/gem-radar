export interface ResolvedArmSample {
  experimentId: string;
  t0AtMs: number;
  armCode: string;
  scenarioCode: string;
  committedUsd: number;
  realizedUsd: number;
  capitalSeconds: number;
}

export interface ArmMetricSummary {
  samples: number;
  rawEvUsd: number;
  capped10xEvUsd: number;
  totalPnlUsd: number;
  pnlWithoutTop1Usd: number;
  pnlWithoutTop3Usd: number;
  profitFactor: number | null;
  medianWinnerMultiple: number | null;
  p75WinnerMultiple: number | null;
  p90WinnerMultiple: number | null;
  maxDrawdownUsd: number;
  capitalUtilizedUsd: number;
  capitalHours: number;
  evPerCapitalHour: number | null;
}

export function summarizeArm(samples: readonly ResolvedArmSample[]): ArmMetricSummary {
  const ordered = [...samples].sort((left, right) => left.t0AtMs - right.t0AtMs);
  const pnl = ordered.map((sample) => sample.realizedUsd - sample.committedUsd);
  const cappedPnl = ordered.map((sample) =>
    Math.min(sample.realizedUsd, sample.committedUsd * 10) - sample.committedUsd,
  );
  const positives = pnl.filter((value) => value > 0).sort((a, b) => b - a);
  const gains = positives.reduce(sum, 0);
  const losses = Math.abs(pnl.filter((value) => value < 0).reduce(sum, 0));
  const winnerMultiples = ordered
    .filter((sample) => sample.committedUsd > 0 && sample.realizedUsd > sample.committedUsd)
    .map((sample) => sample.realizedUsd / sample.committedUsd)
    .sort((a, b) => a - b);
  const totalPnlUsd = pnl.reduce(sum, 0);
  const capitalHours = ordered.reduce((total, sample) => total + sample.capitalSeconds / 3_600, 0);
  return {
    samples: ordered.length,
    rawEvUsd: ordered.length ? totalPnlUsd / ordered.length : 0,
    capped10xEvUsd: ordered.length ? cappedPnl.reduce(sum, 0) / ordered.length : 0,
    totalPnlUsd,
    pnlWithoutTop1Usd: totalPnlUsd - positives.slice(0, 1).reduce(sum, 0),
    pnlWithoutTop3Usd: totalPnlUsd - positives.slice(0, 3).reduce(sum, 0),
    profitFactor: losses > 0 ? gains / losses : gains > 0 ? Number.POSITIVE_INFINITY : null,
    medianWinnerMultiple: quantile(winnerMultiples, 0.50),
    p75WinnerMultiple: quantile(winnerMultiples, 0.75),
    p90WinnerMultiple: quantile(winnerMultiples, 0.90),
    maxDrawdownUsd: maxEquityDrawdown(pnl),
    capitalUtilizedUsd: ordered.reduce((total, sample) => total + sample.committedUsd, 0),
    capitalHours,
    evPerCapitalHour: capitalHours > 0 ? totalPnlUsd / capitalHours : null,
  };
}

export function pairedPnlDifferences(
  left: readonly ResolvedArmSample[],
  right: readonly ResolvedArmSample[],
): number[] {
  const rightByExperiment = new Map(right.map((sample) => [sample.experimentId, sample]));
  return left.flatMap((sample) => {
    const pair = rightByExperiment.get(sample.experimentId);
    if (!pair) return [];
    const leftPnl = sample.realizedUsd - sample.committedUsd;
    const rightPnl = pair.realizedUsd - pair.committedUsd;
    return [leftPnl - rightPnl];
  });
}

export function bootstrapMeanConfidenceInterval(
  values: readonly number[],
  iterations = 10_000,
  seed = 0x5eed1234,
): { mean: number; lower95: number; upper95: number } | null {
  if (!values.length) return null;
  let state = seed >>> 0;
  const random = (): number => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
  const means: number[] = [];
  for (let iteration = 0; iteration < iterations; iteration++) {
    let total = 0;
    for (let index = 0; index < values.length; index++) {
      total += values[Math.floor(random() * values.length)];
    }
    means.push(total / values.length);
  }
  means.sort((a, b) => a - b);
  return {
    mean: values.reduce(sum, 0) / values.length,
    lower95: quantile(means, 0.025)!,
    upper95: quantile(means, 0.975)!,
  };
}

function maxEquityDrawdown(pnl: readonly number[]): number {
  let equity = 0;
  let peak = 0;
  let drawdown = 0;
  for (const value of pnl) {
    equity += value;
    peak = Math.max(peak, equity);
    drawdown = Math.max(drawdown, peak - equity);
  }
  return drawdown;
}

function quantile(sorted: readonly number[], q: number): number | null {
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function sum(total: number, value: number): number {
  return total + value;
}

