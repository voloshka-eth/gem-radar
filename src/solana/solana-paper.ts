export const SOLANA_LADDER = [
  { multiple: 2, fraction: 0.80 },
  { multiple: 10, fraction: 0.15 },
  { multiple: 1000, fraction: 0.05 },
] as const;

export function normalizeFinishingRate(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value > 1 ? value / 100 : value;
}

export function prioritizeRouteReady<T>(
  values: readonly T[],
  finishingRate: (value: T) => number,
  minimum: number,
): T[] {
  return values
    .filter((value) => normalizeFinishingRate(finishingRate(value)) >= minimum)
    .sort((a, b) => normalizeFinishingRate(finishingRate(b)) - normalizeFinishingRate(finishingRate(a)));
}

export function prioritizeRouteProbes<T>(
  values: readonly T[],
  finishingRate: (value: T) => number,
  lastProbeAtMs: (value: T) => number | null,
  nowMs: number,
  readyMinimum: number,
  readyIntervalMs: number,
  fallbackIntervalMs: number,
): T[] {
  return values
    .filter((value) => {
      const ready = normalizeFinishingRate(finishingRate(value)) >= readyMinimum;
      const interval = ready ? readyIntervalMs : fallbackIntervalMs;
      const last = lastProbeAtMs(value);
      return last == null || nowMs - last >= interval;
    })
    .sort((a, b) => {
      const aRate = normalizeFinishingRate(finishingRate(a));
      const bRate = normalizeFinishingRate(finishingRate(b));
      const aReady = aRate >= readyMinimum ? 1 : 0;
      const bReady = bRate >= readyMinimum ? 1 : 0;
      if (aReady !== bReady) return bReady - aReady;
      if (aRate !== bRate) return bRate - aRate;
      return (lastProbeAtMs(a) ?? 0) - (lastProbeAtMs(b) ?? 0);
    });
}

export function tokenAmount(raw: string | bigint, decimals: number): number {
  const value = typeof raw === 'bigint' ? raw : BigInt(raw);
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const fractional = value % scale;
  return Number(whole) + Number(fractional) / Number(scale);
}

export function entrySlippagePct(
  sizeUsd: number,
  outputRaw: string,
  decimals: number,
  spotPriceUsd: number,
): number {
  const tokens = tokenAmount(outputRaw, decimals);
  if (!(tokens > 0) || !(spotPriceUsd > 0)) return Number.POSITIVE_INFINITY;
  return Math.max(0, sizeUsd / tokens / spotPriceUsd - 1);
}

export function executablePositionMultiple(
  quoteOutUsd: number,
  remainingRaw: bigint,
  originalRaw: bigint,
  committedUsd: number,
): number {
  if (remainingRaw <= 0n || originalRaw <= 0n || !(committedUsd > 0)) return 0;
  const remainingFraction = Number(remainingRaw) / Number(originalRaw);
  return remainingFraction > 0 ? quoteOutUsd / (committedUsd * remainingFraction) : 0;
}

export function nextLadderRung(multiple: number, executed: ReadonlySet<number>) {
  return SOLANA_LADDER.find((rung) => multiple >= rung.multiple && !executed.has(rung.multiple)) ?? null;
}
