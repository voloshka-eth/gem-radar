/**
 * M5 — PURE pessimistic fill modeling.  No I/O, deterministic.
 *
 * MANDATE: every fill is pessimistic. Mid-price is forbidden. On a BUY you always pay
 * spot × (1 + slippage + sandwich) × (1 + buyTax) and lose gas; on a SELL you always
 * receive gross × (1 − slippage − sandwich) × (1 − sellTax) − gas. There is NO path
 * through this file that produces a mid-price fill. These are modeling assumptions,
 * not predictions, and they are intentionally conservative.
 *
 * NO real orders, keys, or execution exist anywhere in M5 — this is paper only.
 */

export interface SlipLadder {
  slip20?: number | null;
  slip50: number | null;
  slip100: number | null;
  slip500: number | null;
  slip1000: number | null;
}

/**
 * Pessimistic slippage for a USD trade size: use the SMALLEST probe whose size ≥ the
 * trade (so a $20 trade is charged the $50 probe's slippage — an over-estimate, i.e.
 * pessimistic). Beyond $1000, scale the $1000 slip up linearly. null if no probe data.
 */
export function slipForSize(sizeUsd: number, ladder: SlipLadder): number | null {
  const pts: ReadonlyArray<readonly [number, number | null]> = [
    [20, ladder.slip20 ?? null], [50, ladder.slip50], [100, ladder.slip100],
    [500, ladder.slip500], [1000, ladder.slip1000],
  ];
  for (const [cap, s] of pts) {
    if (sizeUsd <= cap && s != null) return s;
  }
  if (ladder.slip1000 != null) {
    return Math.min(ladder.slip1000 * Math.max(1, sizeUsd / 1000), 1); // > $1000 → scale up
  }
  for (let i = pts.length - 1; i >= 0; i--) {
    if (pts[i][1] != null) return pts[i][1];
  }
  return null;
}

export interface EntryParams {
  sizeUsd: number;
  sandwichPct: number;
  gasUsd: number;
  buyTaxPct: number;
  maxEntrySlipPct: number;
}

export interface EntryFill {
  entered: boolean;
  reason: string | null;             // populated when entered=false
  spotPriceUsd: number;
  slipPct: number | null;
  sandwichPct: number;
  gasUsd: number;
  buyTaxPct: number;
  usableUsd: number;                 // size minus gas
  tokensBought: number | null;
  effectivePriceUsd: number | null;  // cost basis: sizeUsd / tokensBought (folds in every cost)
}

/** Model a pessimistic BUY of `sizeUsd`. Returns entered=false (+reason) if un-enterable. */
export function modelEntry(spotPriceUsd: number, slipPct: number | null, p: EntryParams): EntryFill {
  const base = {
    spotPriceUsd, slipPct, sandwichPct: p.sandwichPct, gasUsd: p.gasUsd, buyTaxPct: p.buyTaxPct,
  };
  const reject = (reason: string, usableUsd = 0): EntryFill => ({
    entered: false, reason, usableUsd, tokensBought: null, effectivePriceUsd: null, ...base,
  });

  if (!(spotPriceUsd > 0))          return reject('no_price');
  if (slipPct == null)              return reject('no_depth_data');
  if (!Number.isFinite(slipPct) || slipPct < 0) return reject('invalid_depth_data');
  if (slipPct > p.maxEntrySlipPct)  return reject(`entry_slip_${(slipPct * 100).toFixed(0)}pct_over_max`);

  const usableUsd = p.sizeUsd - p.gasUsd;
  if (usableUsd <= 0)               return reject('gas_exceeds_size', usableUsd);

  // Pessimistic buy: pay slip + sandwich on price, then buy tax reduces tokens received.
  const effPricePerToken = spotPriceUsd * (1 + slipPct + p.sandwichPct) * (1 + p.buyTaxPct);
  const tokensBought = usableUsd / effPricePerToken;
  // Cost basis per token relative to the full committed size (so gas drag is included).
  const effectivePriceUsd = p.sizeUsd / tokensBought;

  return { entered: true, reason: null, usableUsd, tokensBought, effectivePriceUsd, ...base };
}

export interface ExitParams {
  sandwichPct: number;
  gasUsd: number;
  sellTaxPct: number;
}

export interface ExitFill {
  grossUsd: number;
  netUsd: number;     // pessimistic proceeds after slip + sandwich + sellTax + gas (≥ 0)
  slipPct: number | null;
}

/** Model a pessimistic SELL of `tokensToSell` at `currentPriceUsd`. */
export function modelExit(
  tokensToSell: number,
  currentPriceUsd: number,
  slipPct: number | null,
  p: ExitParams,
): ExitFill {
  const grossUsd = Math.max(tokensToSell, 0) * Math.max(currentPriceUsd, 0);
  // Unknown depth → assume the worst (100% slippage) rather than a favorable fill.
  const s = Math.min(slipPct ?? 1, 1);
  const netUsd = Math.max(grossUsd * (1 - s - p.sandwichPct) * (1 - p.sellTaxPct) - p.gasUsd, 0);
  return { grossUsd, netUsd, slipPct };
}
