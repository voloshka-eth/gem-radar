import { createHash } from 'crypto';
import { canonicalJson } from './robinhood-flow-v3';

export const ROBINHOOD_PAPER_BANKROLL_POLICY = Object.freeze({
  version: 'robinhood_low_friction_bankroll_v1',
  startingBankrollUsd: 1_000,
  positionUsd: 20,
  maxConcurrentSignals: 5,
  maxAggregateExposureUsd: 100,
  maxNewSignalsPerUtcDay: 20,
  maxIntradayDrawdownUsd: 100,
  dayBoundary: 'UTC',
  liveExecution: false,
});

export const ROBINHOOD_PAPER_BANKROLL_POLICY_HASH = createHash('sha256')
  .update(canonicalJson(ROBINHOOD_PAPER_BANKROLL_POLICY))
  .digest('hex');

export interface RobinhoodPaperBankrollSnapshot {
  activeSignals: number;
  activeExposureUsd: number;
  newSignalsToday: number;
  realizedPnlTodayUsd: number;
  intradayDrawdownUsd: number;
}

export interface RobinhoodPaperBankrollDecision {
  eligible: boolean;
  reasons: string[];
  snapshot: RobinhoodPaperBankrollSnapshot;
}

export function evaluateRobinhoodPaperBankroll(
  snapshot: RobinhoodPaperBankrollSnapshot,
): RobinhoodPaperBankrollDecision {
  const reasons: string[] = [];
  if (snapshot.activeSignals >= ROBINHOOD_PAPER_BANKROLL_POLICY.maxConcurrentSignals) {
    reasons.push('max_concurrent_signals');
  }
  if (
    snapshot.activeExposureUsd + ROBINHOOD_PAPER_BANKROLL_POLICY.positionUsd >
    ROBINHOOD_PAPER_BANKROLL_POLICY.maxAggregateExposureUsd
  ) {
    reasons.push('max_aggregate_exposure');
  }
  if (snapshot.newSignalsToday >= ROBINHOOD_PAPER_BANKROLL_POLICY.maxNewSignalsPerUtcDay) {
    reasons.push('max_new_signals_per_utc_day');
  }
  if (snapshot.intradayDrawdownUsd >= ROBINHOOD_PAPER_BANKROLL_POLICY.maxIntradayDrawdownUsd) {
    reasons.push('max_intraday_drawdown');
  }
  return { eligible: reasons.length === 0, reasons, snapshot };
}

export function utcDayStart(nowMs: number): Date {
  const now = new Date(nowMs);
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export function pnlAndDrawdown(realizedPnl: readonly number[]): {
  realizedPnlUsd: number;
  drawdownUsd: number;
} {
  let equity = 0;
  let peak = 0;
  let drawdown = 0;
  for (const pnl of realizedPnl) {
    equity += pnl;
    peak = Math.max(peak, equity);
    drawdown = Math.max(drawdown, peak - equity);
  }
  return { realizedPnlUsd: equity, drawdownUsd: drawdown };
}
