import { reconcileRobinhoodArm } from './robinhood-experiment-accounting';

describe('Robinhood experiment leg accounting', () => {
  it('reconciles entry, partial exits, terminal proceeds and failed gas', () => {
    const result = reconcileRobinhoodArm({
      committedUsd: 20.25,
      realizedValueUsd: 27,
      remainingTokens: 0,
      legs: [
        { legType: 'IMMEDIATE_BUY', status: 'FILLED', notionalUsd: 20, gasUsd: 0.05 },
        { legType: 'LADDER_SELL', status: 'FILLED', netUsd: 24, gasUsd: 0.05 },
        { legType: 'LADDER_SELL', status: 'FAILED', gasUsd: 0.25 },
        { legType: 'TIME_SELL', status: 'FILLED', netUsd: 3, gasUsd: 0.05 },
      ],
    });

    expect(result).toMatchObject({
      entryAndFailedCostsUsd: 20.25,
      exitProceedsUsd: 27,
      residualTokens: 0,
      valid: true,
    });
  });

  it('fails closed on aggregate mismatch or unsold residual tokens', () => {
    const result = reconcileRobinhoodArm({
      committedUsd: 20,
      realizedValueUsd: 10,
      remainingTokens: 1,
      legs: [
        { legType: 'IMMEDIATE_BUY', status: 'FILLED', notionalUsd: 20 },
        { legType: 'TIME_SELL', status: 'FILLED', netUsd: 9 },
      ],
    });

    expect(result.valid).toBe(false);
    expect(result.proceedsDeltaUsd).toBe(1);
    expect(result.residualTokens).toBe(1);
  });
});
