import { addTrade, evaluateEntryTrigger } from './launch-strategy';
import { EntryTriggerConfig, LaunchState, LaunchTradeEvent, SniperAddress } from './sniper.types';

const TOKEN = '0x1111111111111111111111111111111111111111' as SniperAddress;
const CREATOR = '0x2222222222222222222222222222222222222222' as SniperAddress;
const config: EntryTriggerConfig = {
  windowMs: 300_000,
  minAgeSec: 2,
  minBlocksAfterLaunch: 6,
  maxAgeSec: 300,
  minBuys: 3,
  minUniqueBuyers: 3,
  minBuyQuote: 0.1,
  minBuySellRatio: 2,
  maxLargestBuyerShare: 0.65,
  minPriceMomentum: 1.02,
};

describe('launch sniper entry trigger', () => {
  it('triggers on early independent demand with positive price confirmation', () => {
    const state = launchState();
    addTrade(state, trade('BUY', address(3), 3_000, 0.04, 1), config.windowMs);
    addTrade(state, trade('BUY', address(4), 4_000, 0.04, 1.02), config.windowMs);
    addTrade(state, trade('BUY', address(5), 5_000, 0.04, 1.05), config.windowMs);

    const decision = evaluateEntryTrigger(state, 5_000, config);

    expect(decision.triggered).toBe(true);
    expect(decision.snapshot.uniqueBuyers).toBe(3);
    expect(decision.snapshot.buyQuote).toBeCloseTo(0.12);
    expect(decision.snapshot.priceMomentum).toBeCloseTo(1.05);
  });

  it('does not count creator buys as independent demand', () => {
    const state = launchState();
    addTrade(state, trade('BUY', CREATOR, 3_000, 1, 1), config.windowMs);
    addTrade(state, trade('BUY', address(3), 4_000, 0.06, 1.02), config.windowMs);
    addTrade(state, trade('BUY', address(4), 5_000, 0.06, 1.04), config.windowMs);

    const decision = evaluateEntryTrigger(state, 5_000, config);

    expect(decision.triggered).toBe(false);
    expect(decision.reasons).toContain('insufficient_buys');
    expect(decision.reasons).toContain('insufficient_unique_buyers');
  });

  it('does not count buys from the launchpad dynamic-fee blocks', () => {
    const state = launchState();
    addTrade(state, { ...trade('BUY', address(3), 3_000, 0.04, 1), blockNumber: '2' }, config.windowMs);
    addTrade(state, { ...trade('BUY', address(4), 4_000, 0.04, 1.02), blockNumber: '3' }, config.windowMs);
    addTrade(state, { ...trade('BUY', address(5), 5_000, 0.04, 1.05), blockNumber: '4' }, config.windowMs);

    const decision = evaluateEntryTrigger(state, 5_000, config);

    expect(decision.triggered).toBe(false);
    expect(decision.reasons).toContain('dynamic_fee_window');
    expect(decision.snapshot.buys).toBe(0);
  });

  it('terminally rejects a creator sell before entry', () => {
    const state = launchState();
    addTrade(state, trade('SELL', CREATOR, 3_000, 0.01, 1), config.windowMs);

    const decision = evaluateEntryTrigger(state, 3_000, config);

    expect(decision.terminal).toBe(true);
    expect(decision.reasons).toContain('creator_sold');
  });

  it('rejects demand dominated by one wallet', () => {
    const state = launchState();
    addTrade(state, trade('BUY', address(3), 3_000, 0.20, 1), config.windowMs);
    addTrade(state, trade('BUY', address(4), 4_000, 0.01, 1.03), config.windowMs);
    addTrade(state, trade('BUY', address(5), 5_000, 0.01, 1.05), config.windowMs);

    const decision = evaluateEntryTrigger(state, 5_000, config);

    expect(decision.triggered).toBe(false);
    expect(decision.reasons).toContain('buyer_concentration');
  });
});

function launchState(): LaunchState {
  return {
    token: TOKEN,
    creator: CREATOR,
    name: 'Test',
    symbol: 'TEST',
    launchedAtMs: 0,
    launchBlockNumber: '1',
    firstSeenAtMs: 0,
    status: 'WATCHING',
    trades: [],
    creatorSold: false,
    entryAttempted: false,
    weakWindowCount: 0,
  };
}

function trade(
  kind: 'BUY' | 'SELL',
  account: SniperAddress,
  occurredAtMs: number,
  quoteAmount: number,
  price: number,
): LaunchTradeEvent {
  return {
    kind,
    id: `${kind}:${occurredAtMs}:${account}`,
    blockNumber: String(occurredAtMs),
    occurredAtMs,
    token: TOKEN,
    account,
    tokenAmount: quoteAmount / price,
    quoteAmount,
    priceQuotePerToken: price,
  };
}

function address(value: number): SniperAddress {
  return `0x${value.toString(16).padStart(40, '0')}` as SniperAddress;
}
