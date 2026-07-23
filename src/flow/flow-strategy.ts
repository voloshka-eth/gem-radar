import type {
  FlowSnapshot,
  FlowStrategyDecision,
  FlowStrategyDefinition,
  FlowTrade,
  FlowWatchType,
} from './flow.types';

export const FLOW_STRATEGIES: readonly FlowStrategyDefinition[] = [
  {
    version: 'fresh_early_v1', chains: ['ethereum', 'base'], watchType: 'FRESH', windowMs: 60_000,
    minUniqueBuyers: 2, minBuyQuoteUsd: 100, minBuySellRatio: 1.5,
    maxLargestBuyerShare: 0.75, minPriceMomentum: 1, minDistinctBlocks: 1,
  },
  {
    version: 'fresh_confirmed_v1', chains: ['ethereum', 'base'], watchType: 'FRESH', windowMs: 120_000,
    minUniqueBuyers: 4, minBuyQuoteUsd: 500, minBuySellRatio: 2,
    maxLargestBuyerShare: 0.60, minPriceMomentum: 1.03, minDistinctBlocks: 2,
  },
  {
    version: 'mature_early_v1', chains: ['ethereum', 'base'], watchType: 'MATURE', windowMs: 300_000,
    minUniqueBuyers: 5, minBuyQuoteUsd: 1_000, minBuySellRatio: 1.5,
    maxLargestBuyerShare: 1, minPriceMomentum: 1.03, minDistinctBlocks: 1,
  },
  {
    version: 'mature_confirmed_v1', chains: ['ethereum', 'base'], watchType: 'MATURE', windowMs: 300_000,
    minUniqueBuyers: 10, minBuyQuoteUsd: 5_000, minBuySellRatio: 2,
    maxLargestBuyerShare: 0.40, minPriceMomentum: 1.08, minDistinctBlocks: 1,
  },
  {
    version: 'evm_flow_precision_v2', chains: ['ethereum', 'base'], watchType: 'FRESH', windowMs: 120_000,
    minUniqueBuyers: 4, minBuyQuoteUsd: 500, minBuySellRatio: 2,
    maxLargestBuyerShare: 0.60, minPriceMomentum: 1.03, maxPriceMomentum: 1.50,
    minDistinctBlocks: 2, minNetBuyQuoteUsd: 250, maxBuyerSellerOverlap: 0.25,
    rejectCreatorSell: true, minOnchainTvlUsd: 10_000, maxOnchainTvlUsd: 50_000,
    maxEntrySlipPct: 0.03, minRoundTripMultiple: 0.80,
  },
  {
    version: 'evm_flow_precision_v2', chains: ['ethereum', 'base'], watchType: 'MATURE', windowMs: 300_000,
    minUniqueBuyers: 10, minBuyQuoteUsd: 5_000, minBuySellRatio: 2,
    maxLargestBuyerShare: 0.40, minPriceMomentum: 1.08, maxPriceMomentum: 1.50,
    minDistinctBlocks: 3, minNetBuyQuoteUsd: 2_500, maxBuyerSellerOverlap: 0.20,
    rejectCreatorSell: true, minOnchainTvlUsd: 10_000, maxOnchainTvlUsd: 50_000,
    maxEntrySlipPct: 0.03, minRoundTripMultiple: 0.80,
  },
  {
    version: 'robinhood_flow_precision_v2', chains: ['robinhood'], watchType: 'FRESH', windowMs: 60_000,
    minUniqueBuyers: 3, minBuyQuoteUsd: 250, minBuySellRatio: 1.5,
    maxLargestBuyerShare: 0.60, minPriceMomentum: 1, maxPriceMomentum: 1.50,
    minDistinctBlocks: 2, minNetBuyQuoteUsd: 100, maxBuyerSellerOverlap: 0.33,
    rejectCreatorSell: true, minOnchainTvlUsd: 10_000, maxOnchainTvlUsd: 50_000,
    maxEntrySlipPct: 0.03, minRoundTripMultiple: 0.80,
  },
  {
    version: 'robinhood_flow_precision_v2', chains: ['robinhood'], watchType: 'MATURE', windowMs: 300_000,
    minUniqueBuyers: 8, minBuyQuoteUsd: 2_000, minBuySellRatio: 1.5,
    maxLargestBuyerShare: 0.50, minPriceMomentum: 1.03, maxPriceMomentum: 1.35,
    minDistinctBlocks: 3, minNetBuyQuoteUsd: 1_000, maxBuyerSellerOverlap: 0.25,
    rejectCreatorSell: true, minOnchainTvlUsd: 10_000, maxOnchainTvlUsd: 50_000,
    maxEntrySlipPct: 0.03, minRoundTripMultiple: 0.80,
  },
] as const;

export function strategiesFor(watchType: FlowWatchType, chain?: FlowTrade['chain']): readonly FlowStrategyDefinition[] {
  return FLOW_STRATEGIES.filter((strategy) =>
    strategy.watchType === watchType && (chain == null || strategy.chains.includes(chain)),
  );
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
  const creatorSellQuoteUsd = creator == null
    ? 0
    : sum(sells.filter((trade) => trade.trader.toLowerCase() === creator).map((trade) => trade.quoteAmountUsd));

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
    buyerSellerOverlap: buyerTotals.size > 0
      ? overlap / buyerTotals.size
      : 0,
    creatorSellQuoteUsd,
    priceMomentum: firstPriceUsd && lastPriceUsd ? lastPriceUsd / firstPriceUsd : null,
    firstPriceUsd,
    lastPriceUsd,
    distinctBlocks: new Set(recent.map((trade) => trade.blockNumber)).size,
    creatorSold: creatorSellQuoteUsd > 0,
    creatorAddress: creator,
    latestSwapAtMs: recent.at(-1)?.occurredAtMs ?? null,
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
  if (strategy.maxPriceMomentum != null && snapshot.priceMomentum != null && snapshot.priceMomentum > strategy.maxPriceMomentum) {
    reasons.push('late_price_momentum');
  }
  if (snapshot.distinctBlocks < strategy.minDistinctBlocks) reasons.push('insufficient_distinct_blocks');
  if (strategy.minNetBuyQuoteUsd != null && snapshot.netBuyQuoteUsd < strategy.minNetBuyQuoteUsd) {
    reasons.push('insufficient_net_buy_quote');
  }
  if (strategy.maxBuyerSellerOverlap != null && snapshot.buyerSellerOverlap > strategy.maxBuyerSellerOverlap) {
    reasons.push('buyer_seller_overlap');
  }
  if (strategy.rejectCreatorSell) {
    const creatorSellThreshold = Math.max(20, snapshot.buyQuoteUsd * 0.05);
    if (snapshot.creatorSellQuoteUsd >= creatorSellThreshold) reasons.push('creator_sell');
  }
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
