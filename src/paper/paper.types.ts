import type { CandidatePool, CandidateToken } from '../collector/collector.types';
import type { LiquidityCheckResult } from '../onchain/onchain.types';
import type { ScoreResult } from '../scoring/score';

/** Everything PaperService.recordEntry needs, gathered by the collector at candidate time. */
export interface CandidateResult {
  pool: CandidatePool;
  token: CandidateToken;
  liq: LiquidityCheckResult;
  score: ScoreResult;
  ageDays: number | null;
  tokenId: string;
  poolId: string;
  runId: string;
  buyTax: number | null | undefined; // from the entry-time risk check (fraction or percent)
  // New Robinhood static-safe admissions use CONTRACT_SAFE and retain their
  // provider limitation in experimentalSafety. The explicit Robinhood value is
  // kept only so historical isolated rows remain readable.
  riskCohort?: 'CONTRACT_SAFE' | 'ROBINHOOD_EXPERIMENTAL_NO_PROVIDER' | 'CONTRACT_MINTABLE_RESEARCH' | 'CONTRACT_UNKNOWN_RESEARCH';
  experimentalSafety?: {
    passed: boolean;
    reasons: string[];
    ownerAddress: string | null;
    proxyDetected: boolean;
    dangerousSelectors: string[];
  };
}

/** One row for the intuitive eval view (facts only — never a recommendation). */
export interface ResearchCandidatePaperResult {
  pool: CandidatePool;
  token: CandidateToken;
  liq: LiquidityCheckResult;
  score: ScoreResult;
  ageDays: number | null;
  runId: string;
  buyTax: number | null | undefined;
  riskStatus: string;
  researchReason: string;
}

export interface EvalViewRow {
  symbol: string;
  chain: string;
  tokenAddress: string;
  foundAt: string;
  entryEffective: number | null;
  priceNow: number | null;
  multiple: number | null;
  status: string;        // alive | liquidity_pulled | unsellable | rug | closed:<outcome> | not_entered
  score: number | null;
  confidence: number | null;
  // Post-t0 rug signals (observation only — not an exit rule).
  sellersToBuyersRatio: number | null;
  sellSimOk: boolean | null;
}
