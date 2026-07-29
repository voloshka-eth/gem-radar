import {
  ROBINHOOD_PAPER_BANKROLL_POLICY_HASH,
  evaluateRobinhoodPaperBankroll,
  pnlAndDrawdown,
  utcDayStart,
} from './robinhood-paper-bankroll';

describe('Robinhood paper bankroll policy', () => {
  it('admits a signal inside every frozen risk limit', () => {
    expect(evaluateRobinhoodPaperBankroll({
      activeSignals: 4,
      activeExposureUsd: 80,
      newSignalsToday: 19,
      realizedPnlTodayUsd: -20,
      intradayDrawdownUsd: 80,
    })).toMatchObject({ eligible: true, reasons: [] });
    expect(ROBINHOOD_PAPER_BANKROLL_POLICY_HASH).toMatch(/^[0-9a-f]{64}$/);
  });

  it('routes excess correlated exposure to shadow', () => {
    const decision = evaluateRobinhoodPaperBankroll({
      activeSignals: 5,
      activeExposureUsd: 100,
      newSignalsToday: 20,
      realizedPnlTodayUsd: -100,
      intradayDrawdownUsd: 100,
    });
    expect(decision.eligible).toBe(false);
    expect(decision.reasons).toEqual([
      'max_concurrent_signals',
      'max_aggregate_exposure',
      'max_new_signals_per_utc_day',
      'max_intraday_drawdown',
    ]);
  });

  it('measures drawdown from the intraday realized-equity peak', () => {
    expect(pnlAndDrawdown([20, -5, -20, 10])).toEqual({
      realizedPnlUsd: 5,
      drawdownUsd: 25,
    });
  });

  it('uses a deterministic UTC research-day boundary', () => {
    expect(utcDayStart(Date.parse('2026-07-27T21:37:00Z')).toISOString())
      .toBe('2026-07-27T00:00:00.000Z');
  });
});
