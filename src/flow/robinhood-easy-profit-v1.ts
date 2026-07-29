import { createHash } from 'crypto';
import type { FlowTrade } from './flow.types';
import type { RobinhoodArmDefinition } from './robinhood-experiment.types';
import { canonicalJson } from './robinhood-flow-v3';

/**
 * Parallel paper hypothesis from external review (Svitoch, 2026-07-29).
 * Does NOT mutate the frozen low-friction ≤1% / 2x control.
 *
 * Thesis: slightly softer executable friction + light buy-pressure + earlier
 * take-profit produces more frequent small net wins than waiting for 2x.
 */
export const ROBINHOOD_EASY_PROFIT_V1_CONFIG = Object.freeze({
  version: 'robinhood_easy_profit_v1',
  registeredAt: '2026-07-29T10:00:00.000Z',
  liveExecution: false,
  /** Primary easy-profit impact (both sides). Control stays at 1%. */
  primaryMaxBuyImpactPct: 0.015,
  primaryMaxSellImpactPct: 0.015,
  /** Stricter zero-move round trip than the control 0.80x floor. */
  minZeroMoveRoundTrip: 0.85,
  /** Light momentum: last window buy USD >= sell USD * ratio. */
  momentumWindowMs: 90_000,
  minBuyToSellVolumeRatio: 1.3,
  hardStopMultiple: 0.85,
  horizonMs: 35 * 60_000,
  /** After this age, if still below softTarget, force time exit. */
  softTargetMultiple: 1.40,
  softTargetDeadlineMs: 30 * 60_000,
  positionUsd: 20,
  exit: Object.freeze({
    code: 'EASY_EXIT_LADDER_65_25_10' as const,
    rungs: Object.freeze([
      Object.freeze({ multiple: 1.5, fraction: 0.65 }),
      Object.freeze({ multiple: 2.0, fraction: 0.25 }),
    ]),
    /** Remaining ~10% closes on time / flow / hard-risk. */
    runnerFraction: 0.10,
    policy: 'LADDER_65@1.5x_25@2x_10_runner',
  }),
});

export const ROBINHOOD_EASY_PROFIT_EXIT_ARMS: readonly RobinhoodArmDefinition[] = Object.freeze([
  {
    code: 'EASY_EXIT_LADDER_65_25_10',
    immediateUsd: 20,
    addUsd: 0,
    confirmatory: true,
    exploratory: true,
  },
]);

export const ROBINHOOD_EASY_PROFIT_V1_CONFIG_HASH = createHash('sha256')
  .update(canonicalJson(ROBINHOOD_EASY_PROFIT_V1_CONFIG))
  .digest('hex');

export interface RobinhoodEasyProfitEligibilityInput {
  buyImpactPct: number;
  sellImpactPct: number;
  roundTripMultiple: number;
  dataHealthy: boolean;
  trades: readonly FlowTrade[];
  nowMs: number;
}

export interface RobinhoodEasyProfitEligibility {
  eligible: boolean;
  reasons: string[];
  buyUsd: number;
  sellUsd: number;
  buyToSellRatio: number | null;
}

export function evaluateRobinhoodEasyProfitMomentum(
  trades: readonly FlowTrade[],
  nowMs: number,
  windowMs = ROBINHOOD_EASY_PROFIT_V1_CONFIG.momentumWindowMs,
): { buyUsd: number; sellUsd: number; buyToSellRatio: number | null } {
  const start = nowMs - windowMs;
  let buyUsd = 0;
  let sellUsd = 0;
  for (const trade of trades) {
    if (trade.occurredAtMs <= start || trade.occurredAtMs > nowMs) continue;
    if (trade.kind === 'BUY') buyUsd += trade.quoteAmountUsd;
    else sellUsd += trade.quoteAmountUsd;
  }
  const buyToSellRatio = sellUsd > 0
    ? buyUsd / sellUsd
    : buyUsd > 0
      ? Number.POSITIVE_INFINITY
      : null;
  return { buyUsd, sellUsd, buyToSellRatio };
}

export function evaluateRobinhoodEasyProfitEligibility(
  input: RobinhoodEasyProfitEligibilityInput,
): RobinhoodEasyProfitEligibility {
  const reasons: string[] = [];
  const cfg = ROBINHOOD_EASY_PROFIT_V1_CONFIG;
  if (!input.dataHealthy) reasons.push('flow_snapshot_stale');
  if (!(input.buyImpactPct <= cfg.primaryMaxBuyImpactPct)) {
    reasons.push('buy_impact_over_1_5pct');
  }
  if (!(input.sellImpactPct <= cfg.primaryMaxSellImpactPct)) {
    reasons.push('sell_impact_over_1_5pct');
  }
  if (!(input.roundTripMultiple >= cfg.minZeroMoveRoundTrip)) {
    reasons.push('round_trip_below_0_85x');
  }
  const momentum = evaluateRobinhoodEasyProfitMomentum(input.trades, input.nowMs);
  if (
    momentum.buyToSellRatio == null ||
    momentum.buyToSellRatio < cfg.minBuyToSellVolumeRatio
  ) {
    reasons.push('buy_pressure_below_1_3x');
  }
  return {
    eligible: reasons.length === 0,
    reasons,
    buyUsd: momentum.buyUsd,
    sellUsd: momentum.sellUsd,
    buyToSellRatio: momentum.buyToSellRatio,
  };
}

export function easyProfitExitRungs(): readonly { multiple: number; fraction: number }[] {
  return ROBINHOOD_EASY_PROFIT_V1_CONFIG.exit.rungs;
}

export function isEasyProfitArmCode(armCode: string): boolean {
  return armCode.startsWith('EASY_EXIT_');
}
