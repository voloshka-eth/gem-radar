import {
  evaluateRobinhoodGeckoLaneEligibility,
  evaluateRobinhoodGeckoLaneReadiness,
  ROBINHOOD_GECKO_LANE_CONFIG_HASH,
} from './robinhood-gecko-lane';
import type { ResolvedArmSample } from './robinhood-experiment-metrics';

function sample(index: number, pnl: number, scenarioCode = 'OBSERVED_ENTRY'): ResolvedArmSample {
  return {
    experimentId: `experiment-${index}`,
    t0AtMs: index * 1_000,
    armCode: 'EXIT_A_FULL_2X',
    scenarioCode,
    committedUsd: 20,
    realizedUsd: 20 + pnl,
    capitalSeconds: 60,
  };
}

describe('Robinhood Gecko low-friction lane', () => {
  it('requires both Gecko discovery and the frozen low-friction cohort', () => {
    expect(evaluateRobinhoodGeckoLaneEligibility({
      discoverySource: 'GeckoTerminal',
      frictionCohort: 'LOW_FRICTION_PRIMARY',
      bankrollEligible: true,
    })).toEqual({ signalEligible: true, bankrollEligible: true, reasons: [] });

    expect(evaluateRobinhoodGeckoLaneEligibility({
      discoverySource: 'dexscreener',
      frictionCohort: 'LOW_FRICTION_PRIMARY',
      bankrollEligible: true,
    })).toMatchObject({
      signalEligible: false,
      bankrollEligible: false,
      reasons: ['source_not_geckoterminal'],
    });
    expect(ROBINHOOD_GECKO_LANE_CONFIG_HASH).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keeps source-qualified signals shadowed when bankroll limits reject them', () => {
    expect(evaluateRobinhoodGeckoLaneEligibility({
      discoverySource: 'geckoterminal',
      frictionCohort: 'LOW_FRICTION_PRIMARY',
      bankrollEligible: false,
      bankrollReasons: ['max_concurrent_signals'],
    })).toEqual({
      signalEligible: true,
      bankrollEligible: false,
      reasons: ['max_concurrent_signals'],
    });
  });

  it('does not validate before the fixed 200-signal holdout resolves', () => {
    const observed = Array.from({ length: 199 }, (_, index) => sample(index, 5));
    const stress = Array.from({ length: 199 }, (_, index) => sample(index, 4, 'STRESS_1_BLOCK'));
    expect(evaluateRobinhoodGeckoLaneReadiness({
      observed, stress, invalidatedSignals: 0, totalSignals: 199,
    })).toMatchObject({
      status: 'COLLECTING_HOLDOUT',
      samples: 199,
      reasons: ['need_1_more_holdout_signals'],
    });
  });

  it('validates a diversified positive observed and stress holdout', () => {
    const observed = Array.from({ length: 200 }, (_, index) =>
      sample(index, index % 3 === 0 ? -8 : 12),
    );
    const stress = Array.from({ length: 200 }, (_, index) =>
      sample(index, index % 3 === 0 ? -9 : 10, 'STRESS_1_BLOCK'),
    );
    expect(evaluateRobinhoodGeckoLaneReadiness({
      observed, stress, invalidatedSignals: 1, totalSignals: 201,
    })).toMatchObject({
      status: 'PAPER_EDGE_VALIDATED',
      samples: 200,
      reasons: ['all_fixed_lane_guardrails_passed'],
    });
  });

  it('rejects an apparent edge that depends on one extreme winner', () => {
    const observed = Array.from({ length: 200 }, (_, index) =>
      sample(index, index === 199 ? 2_000 : -2),
    );
    const stress = Array.from({ length: 200 }, (_, index) =>
      sample(index, index === 199 ? 1_000 : -3, 'STRESS_1_BLOCK'),
    );
    expect(evaluateRobinhoodGeckoLaneReadiness({
      observed, stress, invalidatedSignals: 0, totalSignals: 200,
    })).toMatchObject({
      status: 'HOLDOUT_REJECTED',
      reasons: expect.arrayContaining(['observed_economics_failed']),
    });
  });
});
