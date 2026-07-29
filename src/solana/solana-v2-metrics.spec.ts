import {
  pairedArmDifference,
  reconcileSolanaArm,
  SolanaArmOutcome,
  summarizeSolanaArms,
  validateSolanaBenchmarkArm,
} from './solana-v2-metrics';

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

  it('reconciles entry gas, net exit proceeds and failed transaction gas from legs', () => {
    const ledger = reconcileSolanaArm(
      { committedUsd: 20.01, realizedValueUsd: 25 },
      [
        { status: 'FILLED', legType: 'IMMEDIATE_ENTRY', inputUsd: 20, outputUsd: null, gasUsd: 0.01 },
        { status: 'FAILED', legType: 'LADDER_SELL', inputUsd: null, outputUsd: null, gasUsd: 0.02 },
        { status: 'FILLED', legType: 'TIME_SELL', inputUsd: null, outputUsd: 25, gasUsd: 0.01 },
      ],
    );

    expect(ledger.entryAndAddCostUsd).toBeCloseTo(20.01);
    expect(ledger.exitProceedsUsd).toBe(25);
    expect(ledger.failedGasUsd).toBe(0.02);
    expect(ledger.netPnlUsd).toBeCloseTo(4.97);
    expect(ledger.differenceUsd).toBeCloseTo(-0.02);
    expect(validateSolanaBenchmarkArm({
      status: 'CLOSED',
      committedUsd: 20.01,
      remainingTokensRaw: '0',
    }, ledger)).toEqual(['execution_ledger_mismatch']);
  });

  it('rejects unresolved token residuals even when dollar accounting matches', () => {
    const ledger = reconcileSolanaArm(
      { committedUsd: 4.01, realizedValueUsd: 0 },
      [{ status: 'FILLED', legType: 'IMMEDIATE_ENTRY', inputUsd: 4, outputUsd: null, gasUsd: 0.01 }],
    );

    expect(validateSolanaBenchmarkArm({
      status: 'CLOSED',
      committedUsd: 4.01,
      remainingTokensRaw: '100',
    }, ledger)).toEqual(['unmarked_token_residual']);
  });

  it('accepts a complete no-trade confirm-only arm', () => {
    const ledger = reconcileSolanaArm({ committedUsd: 0, realizedValueUsd: 0 }, []);
    expect(validateSolanaBenchmarkArm({
      status: 'CLOSED',
      committedUsd: 0,
      remainingTokensRaw: '0',
    }, ledger)).toEqual([]);
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
