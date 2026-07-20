export function isSignalWindowOpen(nowMs: number, expiresAtMs: number): boolean {
  return nowMs <= expiresAtMs;
}

export function blockIsAfterHead(blockNumber: string, head: bigint): boolean {
  try { return BigInt(blockNumber) > head; }
  catch { return false; }
}

export function chunkValues<T>(values: readonly T[], size: number): T[][] {
  if (!Number.isInteger(size) || size <= 0) throw new Error('chunk size must be positive');
  const output: T[][] = [];
  for (let index = 0; index < values.length; index += size) output.push(values.slice(index, index + size));
  return output;
}

export function nextConsecutiveWindowCount(
  previousWindow: number,
  previousCount: number,
  currentWindow: number,
  conditionMet: boolean,
): number {
  if (!conditionMet) return 0;
  return previousWindow === currentWindow - 1 ? previousCount + 1 : 1;
}
