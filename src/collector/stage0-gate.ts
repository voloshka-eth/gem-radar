// Pure, side-effect-free Stage 0 functions.
// No NestJS, no I/O — safe to import and test in isolation.

import { CollectorResult, Stage0RejectReason } from './collector.types';

export interface Stage0Config {
  maxPoolAgeMs: number;
  minLiquidityUsd: number;
  minFdvUsd: number;
  maxFdvUsd: number;
  moonshotEnabled?: boolean;
  moonshotMinLiquidityUsd?: number;
  moonshotMinFdvUsd?: number;
  moonshotMinVol1hUsd?: number;
  moonshotMinTx1h?: number;
  moonshotMinBuys1h?: number;
  blockedTokenSymbols?: string[];
}

export interface Stage0Result {
  pass: boolean;
  reason?: Stage0RejectReason;
  lane?: 'standard' | 'moonshot_probe';
}

/**
 * Cheap deterministic gate using only reported API data.
 *
 * What this checks: quote asset membership, pool age, reported liquidity floor,
 * reported FDV bounds.
 *
 * What this does NOT check: on-chain reserves, honeypot status, wash trading,
 * fake liquidity, contract risk.  All of those belong in M2+.
 */
export function applyStage0Gate(candidate: CollectorResult, cfg: Stage0Config): Stage0Result {
  const { pool, token } = candidate;

  const blockedSymbols = new Set((cfg.blockedTokenSymbols ?? []).map(normalizeSymbol).filter(Boolean));
  if (blockedSymbols.size > 0) {
    const symbol = normalizeSymbol(token.symbol);
    if (symbol && blockedSymbols.has(symbol)) {
      return { pass: false, reason: 'ticker_blocklisted' };
    }
  }

  if (!pool.quoteAsset) {
    return { pass: false, reason: 'quote_asset_not_accepted' };
  }

  if (pool.poolCreatedAt !== undefined) {
    const ageMs = Date.now() - pool.poolCreatedAt.getTime();
    if (ageMs > cfg.maxPoolAgeMs) {
      return { pass: false, reason: 'pool_too_old' };
    }
  }

  // Missing liquidity/FDV data → don't false-reject (pass silently; later stages will handle)
  if (isMoonshotProbeCandidate(candidate, cfg)) {
    return { pass: true, lane: 'moonshot_probe' };
  }

  if (pool.liquidityUsd !== undefined && pool.liquidityUsd < cfg.minLiquidityUsd) {
    return { pass: false, reason: 'liquidity_too_low' };
  }

  if (pool.fdvUsd !== undefined) {
    if (pool.fdvUsd < cfg.minFdvUsd) return { pass: false, reason: 'fdv_too_low' };
    if (pool.fdvUsd > cfg.maxFdvUsd) return { pass: false, reason: 'fdv_too_high' };
  }

  return { pass: true };
}

function normalizeSymbol(symbol: string | null | undefined): string {
  return (symbol ?? '').trim().replace(/^\$/, '').toLowerCase();
}

function isMoonshotProbeCandidate(candidate: CollectorResult, cfg: Stage0Config): boolean {
  if (cfg.moonshotEnabled !== true) return false;

  const { pool } = candidate;
  const liq = pool.liquidityUsd;
  const fdv = pool.fdvUsd;
  if (liq === undefined || fdv === undefined) return false;
  if (fdv > cfg.maxFdvUsd) return false;

  const minLiq = cfg.moonshotMinLiquidityUsd ?? cfg.minLiquidityUsd;
  const minFdv = cfg.moonshotMinFdvUsd ?? 0;
  if (liq < minLiq || fdv < minFdv) return false;

  const vol1h = pool.vol1h ?? 0;
  const tx1h = pool.txCount1h ?? 0;
  const buys1h = pool.buys1h ?? 0;

  return (
    vol1h >= (cfg.moonshotMinVol1hUsd ?? Number.POSITIVE_INFINITY) ||
    tx1h >= (cfg.moonshotMinTx1h ?? Number.POSITIVE_INFINITY) ||
    buys1h >= (cfg.moonshotMinBuys1h ?? Number.POSITIVE_INFINITY)
  );
}

/**
 * Filters out candidates whose (chain, poolAddress) key already exists in `seen`.
 * Mutates `seen` — pass the same Set across multiple calls within one cycle to
 * deduplicate across GeckoTerminal and DexScreener sources.
 */
export function filterDuplicates(candidates: CollectorResult[], seen: Set<string>): CollectorResult[] {
  return candidates.filter((r) => {
    const key = `${r.pool.chain}:${r.pool.poolAddress}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
