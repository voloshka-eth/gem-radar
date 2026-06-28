/**
 * M5 — PURE exit-ladder + status detection.  No I/O, deterministic.
 *
 * The ladder sells fractions of the ORIGINAL position as the (gross, mark-to-market)
 * multiple crosses thresholds; the remainder is a moonbag held until invalidation.
 * Status detection classifies a position from re-read on-chain facts.
 */

export interface LadderRung {
  multiple: number;       // gross multiple trigger (price_now / entry_effective)
  sellFraction: number;   // fraction of the ORIGINAL position to sell at this rung
}

export const DEFAULT_LADDER: LadderRung[] = [
  { multiple: 2,  sellFraction: 0.50 },
  { multiple: 5,  sellFraction: 0.25 },
  { multiple: 10, sellFraction: 0.15 },
  // remainder (0.10) = moonbag, held until invalidation
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
  closedByStatus: PositionStatus | 'ladder_complete' | 'drawdown',
  realizedMultiple: number,
): string {
  if (closedByStatus === 'rug') return 'RUG';
  if (closedByStatus === 'unsellable') return 'UNSELLABLE';
  if (closedByStatus === 'liquidity_pulled') return 'LIQ_PULL';
  if (closedByStatus === 'drawdown') return realizedMultiple >= 1 ? 'WIN' : 'LOSS';
  // ladder_complete or other graceful close
  return realizedMultiple >= 1 ? 'WIN' : 'LOSS';
}
