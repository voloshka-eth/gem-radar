import {
  SOLANA_EXPERIMENT_ARMS,
  SOLANA_FLOW_V2_CONFIG,
  SOLANA_FLOW_V2_CONFIG_HASH,
  SolanaFlowTrade,
  classifySolanaExecution,
  evaluateSolanaConfirmation,
} from './solana-flow-v2';

describe('Solana flow v2', () => {
  it('freezes the preregistered config and three paired arms', () => {
    expect(Object.isFrozen(SOLANA_FLOW_V2_CONFIG)).toBe(true);
    expect(SOLANA_FLOW_V2_CONFIG.version).toBe('solana_multi_launch_flow_v2_2');
    expect(SOLANA_FLOW_V2_CONFIG.timeExitMs).toBe(8 * 60 * 60_000);
    expect(SOLANA_FLOW_V2_CONFIG.confirmationWindows.map((window) => window.code)).toEqual([
      'EARLY', 'RECOVERY_1', 'RECOVERY_2',
    ]);
    expect(SOLANA_FLOW_V2_CONFIG_HASH).toMatch(/^[0-9a-f]{64}$/);
    expect(SOLANA_EXPERIMENT_ARMS.map((arm) => [arm.code, arm.immediateUsd, arm.confirmationUsd])).toEqual([
      ['A_IMMEDIATE_20', 20, 0],
      ['B_PROBE_4_ADD_16', 4, 16],
      ['C_CONFIRM_20', 0, 20],
    ]);
  });

  it('separates primary, executable shadow, and observation-only slippage', () => {
    const base = {
      executable: true, buySlippagePct: 0.02, sellSlippagePct: 0.025,
      roundTripMultiple: 0.9, executableDepthUsd: 100, quoteSlot: 100, quoteModel: 'TEST',
    };
    expect(classifySolanaExecution(base, 101, 1_000, false).cohort).toBe('PRIMARY');
    expect(classifySolanaExecution({ ...base, sellSlippagePct: 0.06 }, 101, 1_000, false))
      .toMatchObject({ cohort: 'EXECUTABLE_SHADOW', positionEligible: true, benchmarkEligible: false });
    expect(classifySolanaExecution({ ...base, sellSlippagePct: 0.09 }, 101, 1_000, false))
      .toMatchObject({ cohort: 'MARKET_OBSERVATION', positionEligible: false });
  });

  it('routes delayed or gap-recovered executable launches to shadow', () => {
    const execution = {
      executable: true, buySlippagePct: 0.01, sellSlippagePct: 0.01,
      roundTripMultiple: 0.95, executableDepthUsd: 100, quoteSlot: 100, quoteModel: 'TEST',
    };
    expect(classifySolanaExecution(execution, 110, 6_000, true).cohort).toBe('EXECUTABLE_SHADOW');
  });

  it('confirms accelerating, distributed, retained demand across multiple slots', () => {
    const t0 = 1_000_000;
    const trades: SolanaFlowTrade[] = [];
    for (let index = 0; index < 6; index++) {
      trades.push({
        tsMs: t0 + 14_000 + index * 500, slot: 10 + index % 2,
        wallet: `early-${index}`, direction: 'BUY', quoteUsd: 1, creatorTrade: false,
      });
    }
    for (let index = 0; index < 9; index++) {
      trades.push({
        tsMs: t0 + 24_000 + index * 500, slot: 20 + index % 2,
        wallet: `latest-${index}`, direction: 'BUY', quoteUsd: 2, creatorTrade: false,
      });
    }
    const result = evaluateSolanaConfirmation(trades, t0 + 30_000, t0, 100, 100, false);
    expect(result.confirmed).toBe(true);
    expect(result.snapshot.topThreeBuyerShare).toBeCloseTo(1 / 3, 6);
    expect(result.snapshot.buyerRetention).toBe(1);
  });

  it('rejects creator sells and concentrated demand', () => {
    const t0 = 2_000_000;
    const trades: SolanaFlowTrade[] = [
      { tsMs: t0 + 25_000, slot: 1, wallet: 'whale', direction: 'BUY', quoteUsd: 100, creatorTrade: false },
      { tsMs: t0 + 26_000, slot: 2, wallet: 'small-1', direction: 'BUY', quoteUsd: 1, creatorTrade: false },
      { tsMs: t0 + 27_000, slot: 2, wallet: 'creator', direction: 'SELL', quoteUsd: 1, creatorTrade: true },
    ];
    const result = evaluateSolanaConfirmation(trades, t0 + 30_000, t0, 100, 100, false);
    expect(result.confirmed).toBe(false);
    expect(result.reasons).toEqual(expect.arrayContaining(['creator_sell', 'top_three_share_above_chance_maximum']));
  });

  it('counts only first-time buyers and does not treat a partial sell as a full exit', () => {
    const t0 = 3_000_000;
    const trades: SolanaFlowTrade[] = [
      { tsMs: t0 + 5_000, slot: 1, wallet: 'repeat', direction: 'BUY', quoteUsd: 10, creatorTrade: false },
      { tsMs: t0 + 15_000, slot: 2, wallet: 'repeat', direction: 'BUY', quoteUsd: 5, creatorTrade: false },
      { tsMs: t0 + 16_000, slot: 2, wallet: 'early', direction: 'BUY', quoteUsd: 10, creatorTrade: false },
      { tsMs: t0 + 25_000, slot: 3, wallet: 'repeat', direction: 'BUY', quoteUsd: 5, creatorTrade: false },
      { tsMs: t0 + 26_000, slot: 3, wallet: 'latest', direction: 'BUY', quoteUsd: 10, creatorTrade: false },
      { tsMs: t0 + 27_000, slot: 4, wallet: 'early', direction: 'SELL', quoteUsd: 4, creatorTrade: false },
    ];
    const result = evaluateSolanaConfirmation(trades, t0 + 30_000, t0, 100, 100, false);
    expect(result.snapshot.previousWindowBuyers).toBe(1);
    expect(result.snapshot.latestWindowBuyers).toBe(1);
    expect(result.snapshot.buyerRetention).toBe(1);
  });

  it('allows a later recovery chance only after executable price rebounds', () => {
    const t0 = 4_000_000;
    const now = t0 + 150_000;
    const trades: SolanaFlowTrade[] = [];
    for (let index = 0; index < 3; index++) {
      trades.push({
        tsMs: now - 18_000 + index * 500, slot: 30 + index % 2,
        wallet: `previous-${index}`, direction: 'BUY', quoteUsd: 1, creatorTrade: false,
      });
    }
    for (let index = 0; index < 4; index++) {
      trades.push({
        tsMs: now - 8_000 + index * 500, slot: 40 + index % 2,
        wallet: `recovery-${index}`, direction: 'BUY', quoteUsd: 2, creatorTrade: false,
      });
    }

    const recovered = evaluateSolanaConfirmation(
      trades, now, t0, 90, 100, false, { launchMultiple: 0.6, reboundFromLow: 1.2 },
    );
    const stillFalling = evaluateSolanaConfirmation(
      trades, now, t0, 90, 100, false, { launchMultiple: 0.6, reboundFromLow: 1.05 },
    );

    expect(recovered).toMatchObject({ confirmed: true, chanceCode: 'RECOVERY_1' });
    expect(stillFalling.confirmed).toBe(false);
    expect(stillFalling.reasons).toContain('rebound_from_low_below_15pct');
  });

});
