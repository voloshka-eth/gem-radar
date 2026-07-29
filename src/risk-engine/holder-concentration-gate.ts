/**
 * Free holder-concentration gate (Blockscout / explorer).
 * Approximates the Bubblemaps cluster rules using top wallets when linked
 * clusters are unavailable without a paid API.
 *
 * Shares are fractions in [0, 1].
 */
export const HOLDER_CONCENTRATION_GATE_VERSION = 'holder_concentration_gate_v1' as const;

export const HOLDER_CONCENTRATION_GATE_CONFIG = Object.freeze({
  version: HOLDER_CONCENTRATION_GATE_VERSION,
  /** Top wallet ≥60% supply excluding LP/burn → hard block. */
  maxWalletShareExLp: 0.60,
  /** Top wallet ≥45% supply including LP → hard block. */
  maxWalletShareInclLp: 0.45,
  /** Top wallet (ex-LP) + LP ≥70% → hard block. */
  maxTopWalletExLpPlusLp: 0.70,
});

export interface HolderShareRow {
  address: string;
  share: number;
  isLp: boolean;
  isBurn: boolean;
}

export interface HolderConcentrationGateInput {
  holders: readonly HolderShareRow[];
  /** Explicit LP/pair share if known separately. */
  lpShare?: number | null;
}

export interface HolderConcentrationGateResult {
  version: typeof HOLDER_CONCENTRATION_GATE_VERSION;
  blocked: boolean;
  reasons: string[];
  warnings: string[];
  topWalletShareInclLp: number | null;
  topWalletShareExLp: number | null;
  lpShare: number;
  topWalletExLpPlusLp: number | null;
  holderCount: number;
}

const BURN_ADDRESSES = new Set([
  '0x0000000000000000000000000000000000000000',
  '0x000000000000000000000000000000000000dead',
  '0x0000000000000000000000000000000000000001',
]);

export function isBurnAddress(address: string): boolean {
  return BURN_ADDRESSES.has(address.toLowerCase());
}

export function evaluateHolderConcentrationGate(
  input: HolderConcentrationGateInput,
): HolderConcentrationGateResult {
  const cfg = HOLDER_CONCENTRATION_GATE_CONFIG;
  let lpShare = Number.isFinite(input.lpShare as number) && (input.lpShare as number) > 0
    ? Number(input.lpShare)
    : 0;
  let topIncl: number | null = null;
  let topExLp: number | null = null;

  for (const holder of input.holders) {
    if (!Number.isFinite(holder.share) || holder.share <= 0) continue;
    if (holder.isBurn || isBurnAddress(holder.address)) continue;
    if (holder.isLp) {
      lpShare = Math.max(lpShare, holder.share);
      topIncl = topIncl == null ? holder.share : Math.max(topIncl, holder.share);
      continue;
    }
    topIncl = topIncl == null ? holder.share : Math.max(topIncl, holder.share);
    topExLp = topExLp == null ? holder.share : Math.max(topExLp, holder.share);
  }

  const topWalletExLpPlusLp = topExLp == null ? null : topExLp + lpShare;
  const reasons: string[] = [];
  const warnings: string[] = [];

  if (topExLp != null && topExLp >= cfg.maxWalletShareExLp) {
    reasons.push('wallet_ex_lp_ge_60pct');
  }
  if (topIncl != null && topIncl >= cfg.maxWalletShareInclLp) {
    reasons.push('wallet_incl_lp_ge_45pct');
  }
  if (topWalletExLpPlusLp != null && topWalletExLpPlusLp >= cfg.maxTopWalletExLpPlusLp) {
    reasons.push('top_wallet_plus_lp_ge_70pct');
  }
  if (topIncl != null && topIncl >= 0.40 && topIncl < cfg.maxWalletShareInclLp) {
    warnings.push('wallet_incl_lp_ge_40pct_warning');
  }

  return {
    version: HOLDER_CONCENTRATION_GATE_VERSION,
    blocked: reasons.length > 0,
    reasons,
    warnings,
    topWalletShareInclLp: topIncl,
    topWalletShareExLp: topExLp,
    lpShare,
    topWalletExLpPlusLp,
    holderCount: input.holders.length,
  };
}
