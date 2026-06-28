import { slipForSize, modelEntry, modelExit, EntryParams, ExitParams } from './fills';
import {
  rungsTriggered, detectStatus, isInvalidating, outcomeClass, DEFAULT_LADDER,
} from './exit-ladder';

const ENTRY: EntryParams = { sizeUsd: 20, sandwichPct: 0.01, gasUsd: 1.5, buyTaxPct: 0, maxEntrySlipPct: 0.50 };
const EXIT: ExitParams = { sandwichPct: 0.01, gasUsd: 1.5, sellTaxPct: 0 };
const LADDER = { slip50: 0.02, slip100: 0.04, slip500: 0.10, slip1000: 0.20 };

describe('slipForSize — pessimistic bucketing', () => {
  it('charges a $20 trade the $50 probe slippage (over-estimate)', () => {
    expect(slipForSize(20, LADDER)).toBe(0.02);
  });
  it('uses the smallest probe ≥ size', () => {
    expect(slipForSize(75, LADDER)).toBe(0.04);
    expect(slipForSize(300, LADDER)).toBe(0.10);
    expect(slipForSize(1000, LADDER)).toBe(0.20);
  });
  it('scales the $1000 slip up beyond $1000', () => {
    expect(slipForSize(2000, LADDER)).toBeCloseTo(0.40, 5);
    expect(slipForSize(1e9, LADDER)).toBe(1); // clamped
  });
  it('returns null when no probe data exists', () => {
    expect(slipForSize(20, { slip50: null, slip100: null, slip500: null, slip1000: null })).toBeNull();
  });
});

describe('modelEntry — pessimistic BUY, never mid-price', () => {
  it('effective price is strictly worse than spot, tokens fewer than mid-price', () => {
    const f = modelEntry(1.0, 0.02, ENTRY);
    expect(f.entered).toBe(true);
    expect(f.effectivePriceUsd!).toBeGreaterThan(1.0);          // pay more than spot
    const midPriceTokens = (ENTRY.sizeUsd - ENTRY.gasUsd) / 1.0;
    expect(f.tokensBought!).toBeLessThan(midPriceTokens);        // fewer tokens than mid
  });

  it('buy tax further reduces tokens', () => {
    const noTax = modelEntry(1.0, 0.02, ENTRY);
    const taxed = modelEntry(1.0, 0.02, { ...ENTRY, buyTaxPct: 0.10 });
    expect(taxed.tokensBought!).toBeLessThan(noTax.tokensBought!);
  });

  it('rejects when un-enterable, with a reason and no fill', () => {
    expect(modelEntry(0, 0.02, ENTRY)).toMatchObject({ entered: false, reason: 'no_price', tokensBought: null });
    expect(modelEntry(1, null, ENTRY)).toMatchObject({ entered: false, reason: 'no_depth_data' });
    expect(modelEntry(1, 0.80, ENTRY).reason).toMatch(/entry_slip_80pct_over_max/);
    expect(modelEntry(1, 0.02, { ...ENTRY, gasUsd: 25 })).toMatchObject({ entered: false, reason: 'gas_exceeds_size' });
  });
});

describe('modelExit — pessimistic SELL, never mid-price', () => {
  it('net proceeds are strictly below gross', () => {
    const f = modelExit(100, 1.0, 0.02, EXIT);
    expect(f.grossUsd).toBe(100);
    expect(f.netUsd).toBeLessThan(f.grossUsd);
  });
  it('unknown depth assumes 100% slippage (net ≈ 0), not a favorable fill', () => {
    const f = modelExit(100, 1.0, null, EXIT);
    expect(f.netUsd).toBe(0);
  });
  it('sell tax reduces proceeds; never negative', () => {
    const taxed = modelExit(100, 1.0, 0.02, { ...EXIT, sellTaxPct: 0.30 });
    const untaxed = modelExit(100, 1.0, 0.02, EXIT);
    expect(taxed.netUsd).toBeLessThan(untaxed.netUsd);
    expect(modelExit(0.01, 0.0001, 0.5, EXIT).netUsd).toBeGreaterThanOrEqual(0);
  });
});

describe('rungsTriggered — ladder fires once per rung, in order', () => {
  it('at 3x only the 2x rung triggers', () => {
    const t = rungsTriggered(3, [], DEFAULT_LADDER);
    expect(t.map((r) => r.multiple)).toEqual([2]);
  });
  it('after 2x executed, 6x triggers the 5x rung', () => {
    const t = rungsTriggered(6, [2], DEFAULT_LADDER);
    expect(t.map((r) => r.multiple)).toEqual([5]);
  });
  it('a jump straight to 12x triggers all unexecuted rungs', () => {
    const t = rungsTriggered(12, [], DEFAULT_LADDER);
    expect(t.map((r) => r.multiple)).toEqual([2, 5, 10]);
  });
  it('moonbag: ladder fractions sum to 0.90, leaving 0.10 held', () => {
    const sold = DEFAULT_LADDER.reduce((a, r) => a + r.sellFraction, 0);
    expect(sold).toBeCloseTo(0.90, 5);
  });
});

describe('detectStatus — classifies re-read facts', () => {
  const P = { liqPullDropPct: 0.60, rugLiqUsd: 50, sellTaxSpikePct: 0.50 };
  const base = { liqEntryUsd: 10_000, liqNowUsd: 10_000, priceNowUsd: 1, sellable: true, sellTaxNowPct: 0 };

  it('alive when healthy', () => expect(detectStatus(base, P)).toBe('alive'));
  it('rug when liquidity ~0 or price ~0 or unreadable', () => {
    expect(detectStatus({ ...base, liqNowUsd: 10 }, P)).toBe('rug');
    expect(detectStatus({ ...base, priceNowUsd: 0 }, P)).toBe('rug');
    expect(detectStatus({ ...base, liqNowUsd: null, priceNowUsd: null }, P)).toBe('rug');
  });
  it('unsellable when sell sim fails or sell tax spikes', () => {
    expect(detectStatus({ ...base, sellable: false }, P)).toBe('unsellable');
    expect(detectStatus({ ...base, sellTaxNowPct: 0.60 }, P)).toBe('unsellable');
  });
  it('liquidity_pulled when liq down > 60% but still present', () => {
    expect(detectStatus({ ...base, liqNowUsd: 3_000 }, P)).toBe('liquidity_pulled');
  });
  it('rug/unsellable/liq_pull are invalidating; alive is not', () => {
    expect(isInvalidating('rug')).toBe(true);
    expect(isInvalidating('unsellable')).toBe(true);
    expect(isInvalidating('liquidity_pulled')).toBe(true);
    expect(isInvalidating('alive')).toBe(false);
  });
});

describe('outcomeClass — maps close reason + realized multiple', () => {
  it('maps invalidation statuses', () => {
    expect(outcomeClass('rug', 0.1)).toBe('RUG');
    expect(outcomeClass('unsellable', 0.1)).toBe('UNSELLABLE');
    expect(outcomeClass('liquidity_pulled', 0.5)).toBe('LIQ_PULL');
  });
  it('maps graceful closes by realized multiple', () => {
    expect(outcomeClass('ladder_complete', 3)).toBe('WIN');
    expect(outcomeClass('drawdown', 0.2)).toBe('LOSS');
    expect(outcomeClass('drawdown', 1.5)).toBe('WIN');
  });
});
