/** PURE descriptive stats helpers. No I/O. */

export interface Dist {
  n: number;
  mean: number | null;
  median: number | null;
  min: number | null;
  max: number | null;
}

export function distribution(values: ReadonlyArray<number | null | undefined>): Dist {
  const xs = values.filter((v): v is number => v != null && isFinite(v));
  if (xs.length === 0) return { n: 0, mean: null, median: null, min: null, max: null };
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return {
    n: xs.length,
    mean: xs.reduce((a, b) => a + b, 0) / xs.length,
    median,
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}

export function mean(values: ReadonlyArray<number>): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Are the values non-decreasing (allowing a tiny epsilon for float noise)? */
export function isMonotonicNonDecreasing(values: ReadonlyArray<number>, eps = 1e-9): boolean {
  for (let i = 1; i < values.length; i++) {
    if (values[i] < values[i - 1] - eps) return false;
  }
  return true;
}
