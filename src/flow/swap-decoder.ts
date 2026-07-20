export type FlowSwapModel = 'V2' | 'V3' | 'V4';

export interface DecodedFlowSwap {
  kind: 'BUY' | 'SELL';
  quoteAmountUsd: number;
  tokenAmount: number;
  priceUsd: number;
}

export interface SwapDecodeInput {
  model: FlowSwapModel;
  quoteIndex: 0 | 1;
  quoteDecimals: number;
  tokenDecimals: number;
  quotePriceUsd: number;
  args: Record<string, unknown>;
}

export function poolQuoteIndex(
  token0Address: string | null | undefined,
  token1Address: string | null | undefined,
  quoteAddress: string,
): 0 | 1 | null {
  const token0 = token0Address?.toLowerCase();
  const token1 = token1Address?.toLowerCase();
  const quote = quoteAddress.toLowerCase();
  if (token0 === quote) return 0;
  if (token1 === quote) return 1;
  return null;
}

export function isPlausibleFlowQuoteAmount(
  quoteAmountUsd: number,
  reportedLiquidityUsd?: number | null,
  reportedVolume24hUsd?: number | null,
): boolean {
  if (!Number.isFinite(quoteAmountUsd) || quoteAmountUsd <= 0) return false;
  const references = [reportedLiquidityUsd, reportedVolume24hUsd]
    .filter((value): value is number => value != null && Number.isFinite(value) && value > 0);
  const reference = Math.max(0, ...references);
  return quoteAmountUsd <= Math.max(10_000_000, reference * 100);
}

export function decodeFlowSwap(input: SwapDecodeInput): DecodedFlowSwap | null {
  const { model, quoteIndex, quoteDecimals, tokenDecimals, quotePriceUsd, args } = input;
  if (!(quotePriceUsd > 0)) return null;

  let kind: 'BUY' | 'SELL';
  let quoteRaw: bigint;
  let tokenRaw: bigint;
  if (model === 'V2') {
    const amount0In = bigint(args.amount0In);
    const amount1In = bigint(args.amount1In);
    const amount0Out = bigint(args.amount0Out);
    const amount1Out = bigint(args.amount1Out);
    if (quoteIndex === 0 && amount0In > 0n && amount1Out > 0n) {
      kind = 'BUY'; quoteRaw = amount0In; tokenRaw = amount1Out;
    } else if (quoteIndex === 0 && amount1In > 0n && amount0Out > 0n) {
      kind = 'SELL'; quoteRaw = amount0Out; tokenRaw = amount1In;
    } else if (quoteIndex === 1 && amount1In > 0n && amount0Out > 0n) {
      kind = 'BUY'; quoteRaw = amount1In; tokenRaw = amount0Out;
    } else if (quoteIndex === 1 && amount0In > 0n && amount1Out > 0n) {
      kind = 'SELL'; quoteRaw = amount1Out; tokenRaw = amount0In;
    } else {
      return null;
    }
  } else {
    const amount0 = bigint(args.amount0);
    const amount1 = bigint(args.amount1);
    const quoteDelta = quoteIndex === 0 ? amount0 : amount1;
    const tokenDelta = quoteIndex === 0 ? amount1 : amount0;
    if (quoteDelta > 0n && tokenDelta < 0n) kind = 'BUY';
    else if (quoteDelta < 0n && tokenDelta > 0n) kind = 'SELL';
    else return null;
    quoteRaw = abs(quoteDelta);
    tokenRaw = abs(tokenDelta);
  }

  const quoteAmount = rawNumber(quoteRaw, quoteDecimals);
  const tokenAmount = rawNumber(tokenRaw, tokenDecimals);
  const quoteAmountUsd = quoteAmount * quotePriceUsd;
  if (!(quoteAmountUsd > 0) || !(tokenAmount > 0)) return null;
  return { kind, quoteAmountUsd, tokenAmount, priceUsd: quoteAmountUsd / tokenAmount };
}

function bigint(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' || typeof value === 'string') {
    try { return BigInt(value); } catch { return 0n; }
  }
  return 0n;
}

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function rawNumber(value: bigint, decimals: number): number {
  const divisor = 10n ** BigInt(decimals);
  return Number(value / divisor) + Number(value % divisor) / Number(divisor);
}
