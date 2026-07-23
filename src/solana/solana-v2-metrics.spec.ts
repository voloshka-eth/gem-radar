import { pairedArmDifference, SolanaArmOutcome, summarizeSolanaArms } from './solana-v2-metrics';

const rows: SolanaArmOutcome[] = [
  outcome('s1', 'A_IMMEDIATE_20', 20, 40, 2.1, 1),
  outcome('s1', 'B_PROBE_4_ADD_16', 20, 50, 2.6, 1),
  outcome('s1', 'C_CONFIRM_20', 20, 30, 1.6, 1),
  outcome('s2', 'A_IMMEDIATE_20', 20, 10, 0.7, 2),
  outcome('s2', 'B_PROBE_4_ADD_16', 4, 3, 0.8, 2),
  outcome('s2', 'C_CONFIRM_20', 0, 0, 0, 2),
];

describe('Solana v2 benchmark metrics', () => {
  it('counts no-confirmation as a zero-PnL original signal', () => {
    const confirm = summarizeSolanaArms(rows).find((row) => row.armCode === 'C_CONFIRM_20')!;
    expect(confirm.signals).toBe(2);
    expect(confirm.traded).toBe(1);
    expect(confirm.rawEvPerSignal).toBe(5);
  });

  it('computes paired pool-level differences', () => {
    expect(pairedArmDifference(rows, 'B_PROBE_4_ADD_16', 'A_IMMEDIATE_20')).toEqual({
      samples: 2,
      meanDifferenceUsd: 9.5,
    });
  });
});

function outcome(
  signalId: string,
  armCode: string,
  committedUsd: number,
  realizedUsd: number,
  maxMultiple: number,
  resolvedAtMs: number,
): SolanaArmOutcome {
  return {
    signalId, venue: 'PUMP_BONDING_CURVE', cohort: 'PRIMARY', armCode,
    committedUsd, realizedUsd, maxMultiple, capitalHours: committedUsd, resolvedAtMs,
  };
}
