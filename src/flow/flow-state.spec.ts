import {
  blockIsAfterHead,
  clampRegistrationStartBlock,
  chunkValues,
  isSignalWindowOpen,
  nextConsecutiveWindowCount,
  signalStatusConsumesTrigger,
} from './flow-state';

describe('flow state helpers', () => {
  it('keeps the exact expiry boundary open and rejects later triggers', () => {
    expect(isSignalWindowOpen(1_000, 1_000)).toBe(true);
    expect(isSignalWindowOpen(1_001, 1_000)).toBe(false);
  });

  it('compares reorg block numbers numerically rather than lexicographically', () => {
    expect(blockIsAfterHead('100', 99n)).toBe(true);
    expect(blockIsAfterHead('99', 100n)).toBe(false);
    expect(blockIsAfterHead('invalid', 100n)).toBe(false);
  });

  it('clamps stale and future registration cursors to a bounded live range', () => {
    expect(clampRegistrationStartBlock(100n, 1_000n, 300n)).toBe(700n);
    expect(clampRegistrationStartBlock(900n, 1_000n, 300n)).toBe(900n);
    expect(clampRegistrationStartBlock(1_100n, 1_000n, 300n)).toBe(1_000n);
  });

  it('chunks batched getLogs addresses without dropping values', () => {
    expect(chunkValues([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('requires consecutive windows for flow reversal confirmation', () => {
    expect(nextConsecutiveWindowCount(10, 1, 11, true)).toBe(2);
    expect(nextConsecutiveWindowCount(9, 1, 11, true)).toBe(1);
    expect(nextConsecutiveWindowCount(10, 2, 11, false)).toBe(0);
  });

  it('keeps degraded and preflight observations retryable', () => {
    expect(signalStatusConsumesTrigger('DEGRADED_SHADOW')).toBe(false);
    expect(signalStatusConsumesTrigger('LATE_SHADOW')).toBe(false);
    expect(signalStatusConsumesTrigger('PREFLIGHT_WAIT')).toBe(false);
    expect(signalStatusConsumesTrigger('ENTERED')).toBe(true);
    expect(signalStatusConsumesTrigger('HARD_REJECT')).toBe(true);
  });
});
