import {
  evaluateRobinhoodBankrollReadiness,
  type RobinhoodExitArmCode,
} from './robinhood-bankroll-readiness';
import type { ResolvedArmSample } from './robinhood-experiment-metrics';

const ARMS: RobinhoodExitArmCode[] = [
  'EXIT_A_FULL_2X',
  'EXIT_B_LADDER_80_15_5',
  'EXIT_C_90_10',
];

function samples(
  count: number,
  proceeds: (index: number) => number,
  arm: RobinhoodExitArmCode,
): ResolvedArmSample[] {
  return Array.from({ length: count }, (_, index) => ({
    experimentId: `signal-${index}`,
    t0AtMs: index,
    armCode: arm,
    scenarioCode: 'OBSERVED_ENTRY',
    committedUsd: 20,
    realizedUsd: proceeds(index),
    capitalSeconds: 60,
  }));
}

function input(count: number) {
  const observed = {
    EXIT_A_FULL_2X: samples(count, () => 25, 'EXIT_A_FULL_2X'),
    EXIT_B_LADDER_80_15_5: samples(count, () => 22, 'EXIT_B_LADDER_80_15_5'),
    EXIT_C_90_10: samples(count, () => 23, 'EXIT_C_90_10'),
  };
  return {
    observedByArm: observed,
    stressByArm: {
      EXIT_A_FULL_2X: [...observed.EXIT_A_FULL_2X],
      EXIT_B_LADDER_80_15_5: [...observed.EXIT_B_LADDER_80_15_5],
      EXIT_C_90_10: [...observed.EXIT_C_90_10],
    },
    invalidatedSignals: 0,
    totalSignals: count,
    selectionSize: 6,
    holdoutSize: 4,
    maxDrawdownUsd: 200,
  };
}

describe('Robinhood bankroll readiness', () => {
  it('does not choose a policy before the frozen selection sample is complete', () => {
    expect(evaluateRobinhoodBankrollReadiness(input(5))).toMatchObject({
      status: 'COLLECTING_SELECTION',
      selectedArm: null,
      selectionSamples: 5,
    });
  });

  it('requires the selected policy to survive a chronological holdout and stress', () => {
    const result = evaluateRobinhoodBankrollReadiness(input(10));
    expect(result.status).toBe('PAPER_EDGE_VALIDATED');
    expect(result.selectedArm).toBe('EXIT_A_FULL_2X');
    expect(result.holdoutSamples).toBe(4);
  });

  it('rejects otherwise profitable paper results when pipeline invalidation is excessive', () => {
    const candidate = input(10);
    candidate.invalidatedSignals = 2;
    candidate.totalSignals = 12;
    const result = evaluateRobinhoodBankrollReadiness(candidate);
    expect(result.status).toBe('HOLDOUT_REJECTED');
    expect(result.reasons).toContain('pipeline_invalidation_rate_above_5pct');
  });

  it('rejects a holdout with missing stress executions', () => {
    const candidate = input(10);
    candidate.stressByArm.EXIT_A_FULL_2X = candidate.stressByArm.EXIT_A_FULL_2X.slice(0, 9);
    const result = evaluateRobinhoodBankrollReadiness(candidate);
    expect(result.status).toBe('HOLDOUT_REJECTED');
    expect(result.reasons).toContain('holdout_stress_sample_incomplete');
  });

  it('counts duplicate arm rows as one market signal', () => {
    const candidate = input(5);
    candidate.observedByArm.EXIT_A_FULL_2X.push(
      ...candidate.observedByArm.EXIT_A_FULL_2X,
    );
    expect(evaluateRobinhoodBankrollReadiness(candidate).selectionSamples).toBe(5);
  });

  it('rejects a universe where no exit policy has robust economics', () => {
    const candidate = input(10);
    for (const arm of ARMS) {
      candidate.observedByArm[arm] = samples(10, () => 5, arm);
      candidate.stressByArm[arm] = candidate.observedByArm[arm];
    }
    expect(evaluateRobinhoodBankrollReadiness(candidate).status).toBe('SELECTION_REJECTED');
  });
});
