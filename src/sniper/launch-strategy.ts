import {
  EntryDecision,
  EntryTriggerConfig,
  FlowSnapshot,
  LaunchState,
  LaunchTradeEvent,
} from './sniper.types';

export function addTrade(state: LaunchState, trade: LaunchTradeEvent, maxWindowMs: number): void {
  if (trade.token.toLowerCase() !== state.token.toLowerCase()) return;
  state.trades.push(trade);
  const cutoff = trade.occurredAtMs - maxWindowMs;
  state.trades = state.trades.filter((item) => item.occurredAtMs >= cutoff);
  if (trade.kind === 'SELL' && trade.account.toLowerCase() === state.creator.toLowerCase()) {
    state.creatorSold = true;
  }
}

export function computeFlowSnapshot(
  state: LaunchState,
  nowMs: number,
  windowMs: number,
  minBlocksAfterLaunch = 0,
): FlowSnapshot {
  const cutoff = nowMs - windowMs;
  const trades = state.trades.filter(
    (trade) =>
      trade.occurredAtMs >= cutoff &&
      safeBlockDistance(state.launchBlockNumber, trade.blockNumber) >= minBlocksAfterLaunch,
  );
  const creator = state.creator.toLowerCase();
  const externalBuys = trades.filter(
    (trade) => trade.kind === 'BUY' && trade.account.toLowerCase() !== creator,
  );
  const sells = trades.filter((trade) => trade.kind === 'SELL');
  const buyQuote = sum(externalBuys.map((trade) => trade.quoteAmount));
  const sellQuote = sum(sells.map((trade) => trade.quoteAmount));
  const buyerTotals = new Map<string, number>();
  for (const trade of externalBuys) {
    const account = trade.account.toLowerCase();
    buyerTotals.set(account, (buyerTotals.get(account) ?? 0) + trade.quoteAmount);
  }
  const largestBuyerQuote = Math.max(0, ...buyerTotals.values());
  const buyPrices = externalBuys
    .map((trade) => trade.priceQuotePerToken)
    .filter((price) => Number.isFinite(price) && price > 0);
  const firstPrice = buyPrices[0] ?? null;
  const lastPrice = buyPrices.at(-1) ?? lastValidPrice(trades);
  const lastBlock = trades.at(-1)?.blockNumber ?? state.launchBlockNumber;

  return {
    ageSec: Math.max(0, (nowMs - state.launchedAtMs) / 1000),
    blocksSinceLaunch: safeBlockDistance(state.launchBlockNumber, lastBlock),
    buys: externalBuys.length,
    sells: sells.length,
    uniqueBuyers: buyerTotals.size,
    buyQuote,
    sellQuote,
    buySellRatio: sellQuote > 0 ? buyQuote / sellQuote : buyQuote > 0 ? Number.POSITIVE_INFINITY : 0,
    largestBuyerShare: buyQuote > 0 ? largestBuyerQuote / buyQuote : 1,
    priceMomentum: firstPrice && lastPrice ? lastPrice / firstPrice : null,
    lastPriceQuotePerToken: lastPrice,
    creatorSold: state.creatorSold,
  };
}

export function evaluateEntryTrigger(
  state: LaunchState,
  nowMs: number,
  config: EntryTriggerConfig,
): EntryDecision {
  const snapshot = computeFlowSnapshot(
    state,
    nowMs,
    config.windowMs,
    config.minBlocksAfterLaunch,
  );
  const reasons: string[] = [];

  if (snapshot.creatorSold) reasons.push('creator_sold');
  if (snapshot.ageSec < config.minAgeSec) reasons.push('too_early');
  if (snapshot.blocksSinceLaunch < config.minBlocksAfterLaunch) reasons.push('dynamic_fee_window');
  if (snapshot.ageSec > config.maxAgeSec) reasons.push('entry_window_expired');
  if (snapshot.buys < config.minBuys) reasons.push('insufficient_buys');
  if (snapshot.uniqueBuyers < config.minUniqueBuyers) reasons.push('insufficient_unique_buyers');
  if (snapshot.buyQuote < config.minBuyQuote) reasons.push('insufficient_buy_quote');
  if (snapshot.buySellRatio < config.minBuySellRatio) reasons.push('weak_buy_sell_ratio');
  if (snapshot.largestBuyerShare > config.maxLargestBuyerShare) reasons.push('buyer_concentration');
  if (snapshot.priceMomentum == null || snapshot.priceMomentum < config.minPriceMomentum) {
    reasons.push('no_positive_price_confirmation');
  }
  if (snapshot.lastPriceQuotePerToken == null) reasons.push('price_unavailable');

  const terminal = snapshot.creatorSold || snapshot.ageSec > config.maxAgeSec;
  return { triggered: reasons.length === 0, terminal, reasons, snapshot };
}

export function recentBuySellRatio(state: LaunchState, nowMs: number, windowMs: number): number {
  const cutoff = nowMs - windowMs;
  let buys = 0;
  let sells = 0;
  for (const trade of state.trades) {
    if (trade.occurredAtMs < cutoff) continue;
    if (trade.kind === 'BUY') buys += trade.quoteAmount;
    else sells += trade.quoteAmount;
  }
  if (sells === 0) return buys > 0 ? Number.POSITIVE_INFINITY : 1;
  return buys / sells;
}

function lastValidPrice(trades: LaunchTradeEvent[]): number | null {
  for (let index = trades.length - 1; index >= 0; index -= 1) {
    const price = trades[index].priceQuotePerToken;
    if (Number.isFinite(price) && price > 0) return price;
  }
  return null;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function safeBlockDistance(launchBlock: string, currentBlock: string): number {
  try {
    const distance = BigInt(currentBlock) - BigInt(launchBlock);
    return distance > 0n ? Number(distance) : 0;
  } catch {
    return 0;
  }
}
