export type LiquidityModel =
  | 'V2'
  | 'V3'
  | 'V4'
  | 'UNSUPPORTED_V4'
  | 'UNSUPPORTED_AERODROME_STABLE'
  | 'UNSUPPORTED_UNKNOWN';

export interface LiquidityCheckResult {
  liquidityModel: LiquidityModel;
  liquidityVerified: boolean;
  onchainTvlUsd: number | null;
  reportedVsOnchainPct: number | null; // (reported − onchain) / onchain; positive = inflated
  executableDepthUsd: number | null;   // largest probe size (USD) with slippage < 10%
  slip20?:  number | null;             // exact paper position-size probe
  entrySlip20?: number | null;         // exact quote -> gem buy probe
  exitSlip20?: number | null;          // exact gem -> quote sell probe
  slip50:   number | null;             // slippage fraction for $50 sell
  slip100:  number | null;
  slip500:  number | null;
  slip1000: number | null;
  spotPriceUsd: number | null;
  error?: string;                      // reason why liquidityVerified = false
}


export type ExecutionQuoteDirection = 'BUY' | 'SELL';

export interface ExecutionQuoteResult {
  liquidityModel: LiquidityModel;
  direction: ExecutionQuoteDirection;
  sizeUsd: number;
  spotPriceUsd: number | null;
  slippagePct: number | null;
  executable: boolean;
  observedAt: Date;
  error?: string;
}
