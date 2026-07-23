import type { CollectorResult, SupportedChain } from '../collector/collector.types';

export type FlowWatchType = 'FRESH' | 'MATURE';
export type FlowTradeKind = 'BUY' | 'SELL';

export interface FlowTrade {
  chain: SupportedChain;
  poolAddress: string;
  tokenAddress: string;
  blockNumber: string;
  blockHash: string | null;
  txHash: string;
  logIndex: number;
  occurredAtMs: number;
  trader: string;
  kind: FlowTradeKind;
  quoteAmountUsd: number;
  tokenAmount: number | null;
  priceUsd: number | null;
}

export interface FlowSnapshot {
  windowMs: number;
  ageSec: number;
  buys: number;
  sells: number;
  uniqueBuyers: number;
  uniqueSellers: number;
  buyQuoteUsd: number;
  sellQuoteUsd: number;
  netBuyQuoteUsd: number;
  buySellRatio: number;
  largestBuyerShare: number;
  buyerSellerOverlap: number;
  creatorSellQuoteUsd: number;
  priceMomentum: number | null;
  firstPriceUsd: number | null;
  lastPriceUsd: number | null;
  distinctBlocks: number;
  creatorSold: boolean;
  creatorAddress: string | null;
  latestSwapAtMs: number | null;
}

export interface FlowStrategyDefinition {
  version: string;
  chains: readonly SupportedChain[];
  watchType: FlowWatchType;
  windowMs: number;
  minUniqueBuyers: number;
  minBuyQuoteUsd: number;
  minBuySellRatio: number;
  maxLargestBuyerShare: number;
  minPriceMomentum: number;
  maxPriceMomentum?: number;
  minDistinctBlocks: number;
  minNetBuyQuoteUsd?: number;
  maxBuyerSellerOverlap?: number;
  rejectCreatorSell?: boolean;
  minOnchainTvlUsd?: number;
  maxOnchainTvlUsd?: number;
  maxEntrySlipPct?: number;
  minRoundTripMultiple?: number;
}

export interface FlowStrategyDecision {
  triggered: boolean;
  reasons: string[];
  snapshot: FlowSnapshot;
}

export interface PersistedCandidate {
  candidate: Omit<CollectorResult, 'pool'> & {
    pool: Omit<CollectorResult['pool'], 'poolCreatedAt' | 'v4Metadata'> & {
      poolCreatedAt?: string;
      v4Metadata?: Omit<NonNullable<CollectorResult['pool']['v4Metadata']>, 'sqrtPriceX96'> & {
        sqrtPriceX96: string;
      };
    };
  };
}
