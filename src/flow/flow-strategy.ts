import type {
  FlowSnapshot,
  FlowStrategyDecision,
  FlowStrategyDefinition,
  FlowTrade,
  FlowWatchType,
} from './flow.types';

export const FLOW_STRATEGIES: readonly FlowStrategyDefinition[] = [
  {
    version: 'fresh_early_v1', watchType: 'FRESH', windowMs: 60_000,
    minUniqueBuyers: 2, minBuyQuoteUsd: 100, minBuySellRatio: 1.5,
    maxLargestBuyerShare: 0.75, minPriceMomentum: 1, minDistinctBlocks: 1,
  },
  {
    version: 'fresh_confirmed_v1', watchType: 'FRESH', windowMs: 120_000,
    minUniqueBuyers: 4, minBuyQuoteUsd: 500, minBuySellRatio: 2,
    maxLargestBuyerShare: 0.60, minPriceMomentum: 1.03, minDistinctBlocks: 2,
  },
  {
    version: 'mature_early_v1', watchType: 'MATURE', windowMs: 300_000,
    minUniqueBuyers: 5, minBuyQuoteUsd: 1_000, minBuySellRatio: 1.5,
    maxLargestBuyerShare: 1, minPriceMomentum: 1.03, minDistinctBlocks: 1,
  },
  {
    version: 'mature_confirmed_v1', watchType: 'MATURE', windowMs: 300_000,
    minUniqueBuyers: 10, minBuyQuoteUsd: 5_000, minBuySellRatio: 2,
    maxLargestBuyerShare: 0.40, minPriceMomentum: 1.08, minDistinctBlocks: 1,
  },
] as const;

export function strategiesFor(watchType: FlowWatchType): readonly FlowStrategyDefinition[] {
  return FLOW_STRATEGIES.filter((strategy) => strategy.watchType === watchType);
}

export function computeFlowSnapshot(
  trades: readonly FlowTrade[],
  nowMs: number,
  launchedAtMs: number,
  windowMs: number,
  creatorAddress?: string | null,
): FlowSnapshot {
  const cutoff = nowMs - windowMs;
  const recent = trades.filter((trade) => trade.occurredAtMs >= cutoff && trade.occurredAtMs <= nowMs);
  const buys = recent.filter((trade) => trade.kind === 'BUY');
  const sells = recent.filter((trade) => trade.kind === 'SELL');
  const buyQuoteUsd = sum(buys.map((trade) => trade.quoteAmountUsd));
  const sellQuoteUsd = sum(sells.map((trade) => trade.quoteAmountUsd));
  const buyerTotals = totalsByTrader(buys);
  const sellerTotals = totalsByTrader(sells);
  const priced = recent.filter((trade) => trade.priceUsd != null && trade.priceUsd > 0);
  const firstPriceUsd = priced[0]?.priceUsd ?? null;
  const lastPriceUsd = priced.at(-1)?.priceUsd ?? null;
  const largestBuyer = Math.max(0, ...buyerTotals.values());
  const overlap = [...buyerTotals.keys()].filter((address) => sellerTotals.has(address)).length;
  const creator = creatorAddress?.toLowerCase() ?? null;

  return {
    windowMs,
    ageSec: Math.max(0, (nowMs - launchedAtMs) / 1000),
    buys: buys.length,
    sells: sells.length,
    uniqueBuyers: buyerTotals.size,
    uniqueSellers: sellerTotals.size,
    buyQuoteUsd,
    sellQuoteUsd,
    netBuyQuoteUsd: buyQuoteUsd - sellQuoteUsd,
    buySellRatio: sellQuoteUsd > 0 ? buyQuoteUsd / sellQuoteUsd : buyQuoteUsd > 0 ? 999 : 0,
    largestBuyerShare: buyQuoteUsd > 0 ? largestBuyer / buyQuoteUsd : 1,
    buyerSellerOverlap: Math.min(buyerTotals.size, sellerTotals.size) > 0
      ? overlap / Math.min(buyerTotals.size, sellerTotals.size)
      : 0,
    priceMomentum: firstPriceUsd && lastPriceUsd ? lastPriceUsd / firstPriceUsd : null,
    firstPriceUsd,
    lastPriceUsd,
    distinctBlocks: new Set(recent.map((trade) => trade.blockNumber)).size,
    creatorSold: creator != null && sells.some((trade) => trade.trader.toLowerCase() === creator),
  };
}

export function evaluateFlowStrategy(
  strategy: FlowStrategyDefinition,
  trades: readonly FlowTrade[],
  nowMs: number,
  launchedAtMs: number,
  creatorAddress?: string | null,
): FlowStrategyDecision {
  const snapshot = computeFlowSnapshot(trades, nowMs, launchedAtMs, strategy.windowMs, creatorAddress);
  const reasons: string[] = [];
  if (snapshot.uniqueBuyers < strategy.minUniqueBuyers) reasons.push('insufficient_unique_buyers');
  if (snapshot.buyQuoteUsd < strategy.minBuyQuoteUsd) reasons.push('insufficient_buy_quote');
  if (snapshot.buySellRatio < strategy.minBuySellRatio) reasons.push('weak_buy_sell_ratio');
  if (snapshot.largestBuyerShare > strategy.maxLargestBuyerShare) reasons.push('buyer_concentration');
  if (snapshot.priceMomentum == null || snapshot.priceMomentum < strategy.minPriceMomentum) {
    reasons.push('weak_price_momentum');
  }
  if (snapshot.distinctBlocks < strategy.minDistinctBlocks) reasons.push('insufficient_distinct_blocks');
  return { triggered: reasons.length === 0, reasons, snapshot };
}

function totalsByTrader(trades: readonly FlowTrade[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const trade of trades) {
    const trader = trade.trader.toLowerCase();
    totals.set(trader, (totals.get(trader) ?? 0) + trade.quoteAmountUsd);
  }
  return totals;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
