import { decodeFlowSwap, isPlausibleFlowQuoteAmount, poolQuoteIndex } from './swap-decoder';

describe('decodeFlowSwap', () => {
  it('decodes V2 buys and sells when quote is token0', () => {
    const buy = decodeFlowSwap({
      model: 'V2', quoteIndex: 0, quoteDecimals: 18, tokenDecimals: 18, quotePriceUsd: 3_000,
      args: { amount0In: 1n * 10n ** 18n, amount1In: 0n, amount0Out: 0n, amount1Out: 100n * 10n ** 18n },
    });
    const sell = decodeFlowSwap({
      model: 'V2', quoteIndex: 0, quoteDecimals: 18, tokenDecimals: 18, quotePriceUsd: 3_000,
      args: { amount0In: 0n, amount1In: 100n * 10n ** 18n, amount0Out: 5n * 10n ** 17n, amount1Out: 0n },
    });

    expect(buy).toMatchObject({ kind: 'BUY', quoteAmountUsd: 3_000, tokenAmount: 100, priceUsd: 30 });
    expect(sell).toMatchObject({ kind: 'SELL', quoteAmountUsd: 1_500, tokenAmount: 100, priceUsd: 15 });
  });

  it.each(['V3', 'V4'] as const)('uses pool-balance delta signs for %s', (model) => {
    const buy = decodeFlowSwap({
      model, quoteIndex: 1, quoteDecimals: 6, tokenDecimals: 18, quotePriceUsd: 1,
      args: { amount0: -(25n * 10n ** 18n), amount1: 100n * 10n ** 6n },
    });
    const sell = decodeFlowSwap({
      model, quoteIndex: 1, quoteDecimals: 6, tokenDecimals: 18, quotePriceUsd: 1,
      args: { amount0: 25n * 10n ** 18n, amount1: -(80n * 10n ** 6n) },
    });

    expect(buy).toMatchObject({ kind: 'BUY', quoteAmountUsd: 100, tokenAmount: 25, priceUsd: 4 });
    expect(sell).toMatchObject({ kind: 'SELL', quoteAmountUsd: 80, tokenAmount: 25, priceUsd: 3.2 });
  });

  it('rejects one-sided or zero-value events', () => {
    expect(decodeFlowSwap({
      model: 'V2', quoteIndex: 0, quoteDecimals: 18, tokenDecimals: 18, quotePriceUsd: 1,
      args: { amount0In: 1n, amount1In: 0n, amount0Out: 0n, amount1Out: 0n },
    })).toBeNull();
  });

  it('resolves the quote side from canonical pool currencies, not API base/quote order', () => {
    const usdc = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
    const weth = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';

    expect(poolQuoteIndex(usdc, weth, usdc)).toBe(0);
    expect(poolQuoteIndex(usdc, weth, weth)).toBe(1);
    expect(poolQuoteIndex(usdc, weth, '0x0000000000000000000000000000000000000001')).toBeNull();
  });

  it('rejects physically implausible decoded USD amounts without capping normal large-pool swaps', () => {
    expect(isPlausibleFlowQuoteAmount(250_000, 50_000, 1_000_000)).toBe(true);
    expect(isPlausibleFlowQuoteAmount(135_000_000_000_000, 93_000_000, 31_000_000)).toBe(false);
    expect(isPlausibleFlowQuoteAmount(Number.POSITIVE_INFINITY, 1_000, 1_000)).toBe(false);
  });
});
