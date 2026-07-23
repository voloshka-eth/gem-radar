/**
 * M5 — PURE exit-ladder + status detection.  No I/O, deterministic.
 *
 * The ladder sells fractions of the ORIGINAL position as the (gross, mark-to-market)
 * multiple crosses thresholds; the remainder stays open until a later rung or a
 * risk invalidation.
 * Status detection classifies a position from re-read on-chain facts.
 */

export interface LadderRung {
  multiple: number;       // gross multiple trigger (price_now / entry_effective)
  sellFraction: number;   // fraction of the ORIGINAL position to sell at this rung
}

export const DEFAULT_LADDER: LadderRung[] = [
  { multiple: 2,    sellFraction: 0.80 },
  { multiple: 10,   sellFraction: 0.15 },
  { multiple: 1000, sellFraction: 0.05 },
];

/**
 * Rungs newly triggered at `currentMultiple` that have not already executed.
 * `executedMultiples` is the list of rung.multiple values already sold.
 */
export function rungsTriggered(
  currentMultiple: number,
  executedMultiples: readonly number[],
  ladder: readonly LadderRung[] = DEFAULT_LADDER,
): LadderRung[] {
  return ladder.filter(
    (r) => currentMultiple >= r.multiple && !executedMultiples.includes(r.multiple),
  );
}

export type PositionStatus = 'alive' | 'liquidity_pulled' | 'unsellable' | 'rug';

export interface StatusInputs {
  liqEntryUsd: number;
  liqNowUsd: number | null;
  priceNowUsd: number | null;
  sellable: boolean;            // did a sell simulation succeed on re-read?
  sellTaxNowPct: number | null; // re-read sell tax, if available
}

export interface StatusParams {
  liqPullDropPct: number;   // e.g. 0.60 → liq down > 60%
  rugLiqUsd: number;        // e.g. 50 → liq ≤ $50 is effectively gone
  sellTaxSpikePct: number;  // e.g. 0.50 → sell tax ≥ 50% means you can't get out
}

/**
 * Classify a position from re-read facts. Order matters: rug (gone) is checked before
 * unsellable (can't exit) before liquidity_pulled (draining) before alive.
 */
export function detectStatus(i: StatusInputs, p: StatusParams): PositionStatus {
  if (i.liqNowUsd == null || i.priceNowUsd == null) return 'rug';     // can't read it → treat as gone
  if (i.liqNowUsd <= p.rugLiqUsd || !(i.priceNowUsd > 0)) return 'rug';
  if (!i.sellable || (i.sellTaxNowPct != null && i.sellTaxNowPct >= p.sellTaxSpikePct)) return 'unsellable';
  if (i.liqNowUsd < i.liqEntryUsd * (1 - p.liqPullDropPct)) return 'liquidity_pulled';
  return 'alive';
}

/** A status that forces an invalidation exit of the remaining position. */
export function isInvalidating(status: PositionStatus): boolean {
  return status === 'rug' || status === 'unsellable' || status === 'liquidity_pulled';
}

/**
 * Map the final state of a closed position to a research outcome class.
 * Pure: depends only on how it closed + the realized multiple.
 */
export function outcomeClass(
  closedByStatus: PositionStatus | 'ladder_complete' | 'drawdown' | 'time_profit' | 'time_loss' | 'hard_stop' | 'flow_reversal' | 'creator_exit',
  realizedMultiple: number,
): string {
  // Preserve realized economics when a token dies after a ladder rung. The
  // terminal condition remains visible without turning a profitable trade into
  // a false loss in benchmarking.
  if (realizedMultiple >= 1 && closedByStatus === 'rug') return 'PARTIAL_PROFIT_RUG';
  if (realizedMultiple >= 1 && closedByStatus === 'unsellable') return 'PARTIAL_PROFIT_UNSELLABLE';
  if (realizedMultiple >= 1 && closedByStatus === 'liquidity_pulled') return 'PARTIAL_PROFIT_LIQ_PULL';
  if (closedByStatus === 'rug') return 'RUG';
  if (closedByStatus === 'unsellable') return 'UNSELLABLE';
  if (closedByStatus === 'liquidity_pulled') return 'LIQ_PULL';
  if (closedByStatus === 'time_profit') return realizedMultiple >= 1 ? 'PARTIAL_PROFIT_TIME' : 'LOSS';
  if (closedByStatus === 'time_loss') return realizedMultiple >= 1 ? 'PARTIAL_PROFIT_TIME' : 'TIME_LOSS';
  if (closedByStatus === 'flow_reversal') return realizedMultiple >= 1 ? 'PARTIAL_PROFIT_FLOW_EXIT' : 'FLOW_EXIT_LOSS';
  if (closedByStatus === 'creator_exit') return realizedMultiple >= 1 ? 'PARTIAL_PROFIT_CREATOR_EXIT' : 'CREATOR_EXIT_LOSS';
  if (closedByStatus === 'hard_stop') return realizedMultiple >= 1 ? 'PARTIAL_PROFIT_STOP' : 'STOP_LOSS';
  if (closedByStatus === 'drawdown') return realizedMultiple >= 1 ? 'WIN' : 'LOSS';
  // ladder_complete or other graceful close
  return realizedMultiple >= 1 ? 'WIN' : 'LOSS';
}
