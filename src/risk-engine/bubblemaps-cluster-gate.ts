/**
 * Hard Bubblemaps cluster concentration gates.
 * Shares are fractions in [0, 1] (0.60 = 60% of supply).
 */
export const BUBBLEMAPS_CLUSTER_GATE_VERSION = 'bubblemaps_cluster_gate_v1' as const;

export const BUBBLEMAPS_CLUSTER_GATE_CONFIG = Object.freeze({
  version: BUBBLEMAPS_CLUSTER_GATE_VERSION,
  /** One cluster ≥60% of supply excluding LP/DEX → hard block. */
  maxClusterShareExLp: 0.60,
  /** One cluster ≥45% of supply including LP/DEX → hard block. */
  maxClusterShareInclLp: 0.45,
  /** Top-1 cluster (ex-LP) + total LP/DEX supply ≥70% → hard block. */
  maxTopClusterExLpPlusLp: 0.70,
});

export interface BubblemapsClusterInput {
  share: number;
  holders: readonly string[];
}

export interface BubblemapsHolderInput {
  address: string;
  share: number;
  isDex: boolean;
}

export interface BubblemapsClusterGateInput {
  clusters: readonly BubblemapsClusterInput[];
  holders: readonly BubblemapsHolderInput[];
  /** metrics.supply_stats.dexs when available; fraction [0,1]. */
  dexSupplyShare?: number | null;
}

export interface BubblemapsClusterGateResult {
  version: typeof BUBBLEMAPS_CLUSTER_GATE_VERSION;
  blocked: boolean;
  reasons: string[];
  warnings: string[];
  topClusterShareInclLp: number | null;
  topClusterShareExLp: number | null;
  dexSupplyShare: number;
  topClusterExLpPlusLp: number | null;
  clusterCount: number;
}

export function evaluateBubblemapsClusterGate(
  input: BubblemapsClusterGateInput,
): BubblemapsClusterGateResult {
  const cfg = BUBBLEMAPS_CLUSTER_GATE_CONFIG;
  const holderByAddress = new Map<string, BubblemapsHolderInput>();
  for (const holder of input.holders) {
    holderByAddress.set(holder.address.toLowerCase(), {
      ...holder,
      address: holder.address.toLowerCase(),
    });
  }

  let dexFromHolders = 0;
  for (const holder of holderByAddress.values()) {
    if (holder.isDex && Number.isFinite(holder.share) && holder.share > 0) {
      dexFromHolders += holder.share;
    }
  }
  const dexSupplyShare = Number.isFinite(input.dexSupplyShare as number) && (input.dexSupplyShare as number) >= 0
    ? Math.max(input.dexSupplyShare as number, dexFromHolders)
    : dexFromHolders;

  let topIncl: number | null = null;
  let topExLp: number | null = null;

  for (const cluster of input.clusters) {
    if (!Number.isFinite(cluster.share) || cluster.share < 0) continue;
    const incl = cluster.share;
    let known = 0;
    let knownDex = 0;
    for (const raw of cluster.holders) {
      const holder = holderByAddress.get(raw.toLowerCase());
      if (!holder || !(holder.share > 0)) continue;
      known += holder.share;
      if (holder.isDex) knownDex += holder.share;
    }
    // Prefer API cluster.share; subtract known DEX inside the cluster for ex-LP.
    // If holder coverage is incomplete, floor ex-LP at max(0, share - dexTotal)
    // so missing LP labels cannot understate concentration.
    const exLp = known > 0
      ? Math.max(0, incl - knownDex)
      : Math.max(0, incl - dexSupplyShare);

    topIncl = topIncl == null ? incl : Math.max(topIncl, incl);
    topExLp = topExLp == null ? exLp : Math.max(topExLp, exLp);
  }

  const topClusterExLpPlusLp = topExLp == null ? null : topExLp + dexSupplyShare;
  const reasons: string[] = [];
  const warnings: string[] = [];

  if (topExLp != null && topExLp >= cfg.maxClusterShareExLp) {
    reasons.push('cluster_ex_lp_ge_60pct');
  }
  if (topIncl != null && topIncl >= cfg.maxClusterShareInclLp) {
    reasons.push('cluster_incl_lp_ge_45pct');
  }
  if (topClusterExLpPlusLp != null && topClusterExLpPlusLp >= cfg.maxTopClusterExLpPlusLp) {
    reasons.push('top_cluster_plus_lp_ge_70pct');
  }
  if (topIncl != null && topIncl >= 0.40 && topIncl < cfg.maxClusterShareInclLp) {
    warnings.push('cluster_incl_lp_ge_40pct_warning');
  }

  return {
    version: BUBBLEMAPS_CLUSTER_GATE_VERSION,
    blocked: reasons.length > 0,
    reasons,
    warnings,
    topClusterShareInclLp: topIncl,
    topClusterShareExLp: topExLp,
    dexSupplyShare,
    topClusterExLpPlusLp,
    clusterCount: input.clusters.length,
  };
}
