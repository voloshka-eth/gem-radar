export const SNIPER_STRATEGY_VERSION = 'four-meme-flow-v1';

export type SniperAddress = `0x${string}`;

export interface LaunchCreatedEvent {
  kind: 'LAUNCH_CREATED';
  id: string;
  blockNumber: string;
  occurredAtMs: number;
  token: SniperAddress;
  creator: SniperAddress;
  name: string;
  symbol: string;
  totalSupply: number;
}

export interface LaunchTradeEvent {
  kind: 'BUY' | 'SELL';
  id: string;
  blockNumber: string;
  occurredAtMs: number;
  token: SniperAddress;
  account: SniperAddress;
  tokenAmount: number;
  quoteAmount: number;
  priceQuotePerToken: number;
}

export interface LaunchStoppedEvent {
  kind: 'TRADE_STOPPED';
  id: string;
  blockNumber: string;
  occurredAtMs: number;
  token: SniperAddress;
}

export type FourMemeEvent = LaunchCreatedEvent | LaunchTradeEvent | LaunchStoppedEvent;

export interface LaunchState {
  token: SniperAddress;
  creator: SniperAddress;
  name: string;
  symbol: string;
  launchedAtMs: number;
  launchBlockNumber: string;
  firstSeenAtMs: number;
  status: 'WATCHING' | 'OPEN' | 'CLOSED' | 'EXPIRED' | 'REJECTED';
  trades: LaunchTradeEvent[];
  creatorSold: boolean;
  entryAttempted: boolean;
  weakWindowCount: number;
}

export interface FlowSnapshot {
  ageSec: number;
  blocksSinceLaunch: number;
  buys: number;
  sells: number;
  uniqueBuyers: number;
  buyQuote: number;
  sellQuote: number;
  buySellRatio: number;
  largestBuyerShare: number;
  priceMomentum: number | null;
  lastPriceQuotePerToken: number | null;
  creatorSold: boolean;
}

export interface EntryTriggerConfig {
  windowMs: number;
  minAgeSec: number;
  minBlocksAfterLaunch: number;
  maxAgeSec: number;
  minBuys: number;
  minUniqueBuyers: number;
  minBuyQuote: number;
  minBuySellRatio: number;
  maxLargestBuyerShare: number;
  minPriceMomentum: number;
}

export interface EntryDecision {
  triggered: boolean;
  terminal: boolean;
  reasons: string[];
  snapshot: FlowSnapshot;
}

export interface FourMemeSafetyState {
  ok: boolean;
  retryable: boolean;
  reasons: string[];
  initialized: boolean | null;
  tradeEnabled: boolean | null;
  liquidityAdded: boolean | null;
  tradingHalt: boolean | null;
  codePresent: boolean | null;
}

export interface PaperSniperConfig {
  positionSizeQuote: number;
  protocolFeePct: number;
  entrySlippagePct: number;
  exitSlippagePct: number;
  stopMultiple: number;
  timeExitMs: number;
  momentumWindowMs: number;
  momentumExitRatio: number;
  momentumConfirmations: number;
  ladder: Array<{ multiple: number; sellFraction: number }>;
}

export interface SniperPaperPosition {
  token: SniperAddress;
  creator: SniperAddress;
  symbol: string;
  openedAtMs: number;
  entryMarketPrice: number;
  entryEffectivePrice: number;
  positionSizeQuote: number;
  tokensBought: number;
  remainingFraction: number;
  realizedQuote: number;
  executedRungs: number[];
  maxNetMultiple: number;
  weakWindowCount: number;
  lastMomentumBucket: number | null;
  status: 'OPEN' | 'CLOSED';
  closeReason: string | null;
}

export interface PaperAction {
  type: 'ENTER' | 'LADDER_EXIT' | 'STOP_EXIT' | 'MOMENTUM_EXIT' | 'TIME_EXIT' | 'TRADE_STOP_EXIT';
  occurredAtMs: number;
  token: SniperAddress;
  symbol: string;
  priceQuotePerToken: number;
  netMultiple: number;
  fraction: number;
  quoteValue: number;
  remainingFraction: number;
  realizedMultiple: number;
  note: string;
}

export interface SniperJournalRecord extends Record<string, unknown> {
  ts: string;
  strategyVersion: string;
  type: string;
  chain: 'bsc';
  launchpad: 'four_meme';
  token?: string;
  symbol?: string;
}
