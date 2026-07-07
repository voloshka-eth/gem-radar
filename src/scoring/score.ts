/**
 * M4 — Pure scoring core.
 *
 * ════════════════════════════════════════════════════════════════════════════
 *  WHAT THIS IS / IS NOT
 *  ---------------------
 *  scoreSnapshot() organizes already-verified survivors into ranked BANDS so that
 *  M5 (paper-trade / backtest) can later test whether higher bands actually
 *  outperform. A score is NOT proof of edge, NOT backtested, NOT a buy signal.
 *  The weights, curves and band thresholds below are HYPOTHESES, not truths.
 *
 *  PURITY CONTRACT (mandatory — M5 replays historical snapshots through this exact
 *  function): scoreSnapshot is a pure deterministic function of its inputs. It does
 *  NO I/O — no DB, no network, no Date.now(), no randomness. Same input → same
 *  output, forever. The only "config" it reads is the `params` argument, which
 *  defaults to DEFAULT_SCORING_PARAMS (a constant). The NestJS ScoringService
 *  passes config-derived params; tests pass fixed params.
 *
 *  MISSING DATA: a component is computed ONLY if the metrics it needs are present.
 *  A missing component is OMITTED and the remaining weights are renormalized.
 *  We NEVER substitute a fake neutral 50. `scoreConfidence` exposes how much data
 *  backed the score.
 * ════════════════════════════════════════════════════════════════════════════
 */

// ─── Inputs / outputs ─────────────────────────────────────────────────────────

/** Only CONTRACT_SAFE + liquidity_verified=true snapshots are ever passed here. */
export interface ScoreSnapshot {
  liquidityModel: string;          // 'V2' | 'V3' (only these reach scoring)
  onchainTvlUsd: number | null;
  executableDepthUsd: number | null;
  slip50: number | null;
  slip100: number | null;
  slip500: number | null;
  slip1000: number | null;
  reportedVsOnchainPct: number | null;
  fdvUsd: number | null;
  ageDays: number | null;
  vol5m: number | null;
  vol1h: number | null;
  vol6h: number | null;
  vol24h: number | null;
  buys1h: number | null;
  sells1h: number | null;
  deployerDeploymentsCount?: number | null;
  deployerRugLikeCount?: number | null;
  deployerRiskScore?: number | null; // 0-100, higher = worse deployer history
  deployerBlocklisted?: boolean | null;
}

export type Band = 'reject_band' | 'watchlist' | 'candidate' | 'high_band';

/**
 * Components M4 ACTUALLY computes — the only ones with a data source + a weight.
 */
export const IMPLEMENTED_COMPONENT_KEYS = [
  'liquidity', 'depth', 'age', 'traction', 'divergence', 'deployer_reputation',
] as const;
export type ImplementedComponentKey = typeof IMPLEMENTED_COMPONENT_KEYS[number];

/**
 * Intended-but-NOT-YET-WIRED components. These are the biggest rug vectors and are
 * declared here on purpose: they are ALWAYS missing today, so they permanently drag
 * scoreConfidence below 1.0 and appear in componentsMissing. This is what stops the
 * model from falsely reading "fully confident" while it is blind to holder
 * concentration, wash trading, smart money and unique buyers.
 * (Adding the data sources is a future milestone — NOT done here.)
 */
export const UNIMPLEMENTED_COMPONENT_KEYS = [
  'holder_concentration', 'wash_trade', 'smart_wallet', 'unique_buyers',
] as const;
export type UnimplementedComponentKey = typeof UNIMPLEMENTED_COMPONENT_KEYS[number];

/** The FULL intended risk model — confidence is measured against THIS set, not the 5 we built. */
export const INTENDED_COMPONENT_KEYS = [
  ...IMPLEMENTED_COMPONENT_KEYS,
  ...UNIMPLEMENTED_COMPONENT_KEYS,
] as const;
export type ComponentKey = typeof INTENDED_COMPONENT_KEYS[number];

export interface ScoreResult {
  finalScore: number;                    // 0–100, weighted over PRESENT components only
  liquidityScore: number | null;
  depthScore: number | null;
  ageScore: number | null;
  tractionScore: number | null;
  divergenceScore: number | null;        // 0–100, higher = healthier (V3 → null, structural/neutral)
  deployerReputationScore: number | null; // 0–100, higher = healthier deployer history
  componentsPresent: ImplementedComponentKey[];
  componentsMissing: ComponentKey[];     // implemented-but-no-data THIS run + all unimplemented
  scoreConfidence: number;               // computed / FULL intended set (0–1); ~0.5 today, never 1.0
  band: Band;
}

export interface ScoringParams {
  weights: Record<ImplementedComponentKey, number>; // weights exist only for built components
  bands: { watchlistMin: number; candidateMin: number; highMin: number };
}

// HYPOTHESIS weights — relative importance of each component. Renormalized over the
// components that actually have data. Tuned by judgement, NOT validated by outcomes.
export const DEFAULT_SCORING_PARAMS: ScoringParams = {
  weights: {
    liquidity: 0.30,
    depth: 0.25,
    age: 0.15,
    traction: 0.20,
    divergence: 0.10,
    deployer_reputation: 0.15,
  },
  bands:   { watchlistMin: 50, candidateMin: 70, highMin: 85 },
};

// ─── Documented curve constants (HYPOTHESES) ──────────────────────────────────
// liquidity: log curve — $5k gate floor scores 0, $250k+ saturates at 100.
const LIQ_FLOOR_USD = 5_000;
const LIQ_CEIL_USD  = 250_000;
// depth: slip_1000 of 0 → 100, ≥10% → 0 (10% is our executable-depth cutoff).
const SLIP1000_ZERO_AT = 0.10;
// traction: vol_1h == TVL within an hour (turnover = 1.0) is treated as "very active" → 100.
const TARGET_TURNOVER_1H = 1.0;
// divergence (V2 only): reported 200% above onchain → 0; ≤0 (not inflated) → 100.
const V2_DIVERGENCE_ZERO_AT = 2.0;

// ─── helpers ──────────────────────────────────────────────────────────────────
const clamp = (x: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, x));
const round2 = (x: number): number => Math.round(x * 100) / 100;
const round3 = (x: number): number => Math.round(x * 1000) / 1000;
const avg = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

// ─── Component scorers (each returns 0–100, or null when its data is absent) ───

/** Higher real on-chain TVL → higher, with diminishing (log) returns. */
export function liquidityScore(onchainTvlUsd: number | null): number | null {
  if (onchainTvlUsd == null) return null;
  if (onchainTvlUsd <= LIQ_FLOOR_USD) return 0;
  const t = (Math.log10(onchainTvlUsd) - Math.log10(LIQ_FLOOR_USD)) /
            (Math.log10(LIQ_CEIL_USD) - Math.log10(LIQ_FLOOR_USD));
  return round2(clamp(t * 100, 0, 100));
}

/**
 * Deeper executable depth + lower $1000 slippage → higher.
 * Averages whichever of the two sub-signals are present.
 */
export function depthScore(
  executableDepthUsd: number | null,
  slip1000: number | null,
): number | null {
  const parts: number[] = [];
  if (executableDepthUsd != null) {
    // executable depth ladder: 0,50,100,500,1000 → 0..100 (linear on USD, capped at $1000)
    parts.push(clamp((executableDepthUsd / 1000) * 100, 0, 100));
  }
  if (slip1000 != null) {
    parts.push(clamp((1 - slip1000 / SLIP1000_ZERO_AT) * 100, 0, 100));
  }
  return parts.length ? round2(avg(parts)) : null;
}

/**
 * Age sweet-spot HYPOTHESIS: tokens that survived the first ~24h but are still
 * <3 days old are the conjectured sweet spot — old enough to clear instant rugs,
 * young enough to still be early. Rises 0→1d, plateaus 1–3d, declines 3–7d.
 * (Whether this actually predicts outcomes is exactly what M5 will test.)
 */
export function ageScore(ageDays: number | null): number | null {
  if (ageDays == null) return null;
  let s: number;
  if (ageDays <= 0)      s = 40;
  else if (ageDays < 1)  s = 40 + 60 * ageDays;             // 40 → 100 over day 0→1
  else if (ageDays <= 3) s = 100;                            // sweet-spot plateau
  else if (ageDays <= 7) s = 100 - 60 * ((ageDays - 3) / 4); // 100 → 40 over day 3→7
  else                   s = 40;
  return round2(clamp(s, 0, 100));
}

/**
 * Traction from volume turnover (vol_1h / TVL) and buy pressure (buys/(buys+sells)).
 * Guards divide-by-zero (TVL>0, buys+sells>0) and clamps absurd ratios to 100.
 * Averages whichever sub-signals have data.
 *
 * NO FALLBACK: there is deliberately no `?? 50` / default-midpoint here. If neither
 * sub-signal has inputs the function returns null and traction is OMITTED (and added
 * to componentsMissing, lowering confidence). A returned 50 is therefore always a
 * REAL computed value (e.g. perfectly balanced buys=sells, or sub-signals averaging
 * to 50) — never a stand-in for absent data.
 */
export function tractionScore(
  vol1h: number | null,
  onchainTvlUsd: number | null,
  buys1h: number | null,
  sells1h: number | null,
): number | null {
  const parts: number[] = [];
  if (vol1h != null && onchainTvlUsd != null && onchainTvlUsd > 0) {
    const turnover = vol1h / onchainTvlUsd;
    parts.push(clamp((turnover / TARGET_TURNOVER_1H) * 100, 0, 100));
  }
  if (buys1h != null && sells1h != null && buys1h + sells1h > 0) {
    const buyRatio = buys1h / (buys1h + sells1h); // 0..1, 0.5 = balanced
    parts.push(clamp(buyRatio * 100, 0, 100));
  }
  return parts.length ? round2(avg(parts)) : null;
}

/**
 * Divergence SCORE — 0–100 where HIGHER = HEALTHIER (low reported↔onchain gap).
 * It contributes positively to finalScore, so a tight V2 gap HELPS the score and a
 * wide V2 gap HURTS it. Branches on model:
 *   - V2: flat reserves, so reported >> onchain means fake/inflated liquidity →
 *     penalized: score falls from 100 (reported ≤ onchain) toward 0 as the gap grows.
 *   - V3: a reported >> onchain gap is STRUCTURAL (concentrated liquidity — displayed
 *     TVL spans ticks while executable depth is local). It carries NO signal, so we
 *     return null → the component is OMITTED and is neutral to the score (it neither
 *     helps nor hurts V3), rather than fabricating a flattering 100.
 */
export function divergenceScore(
  liquidityModel: string,
  reportedVsOnchainPct: number | null,
): number | null {
  if (liquidityModel === 'V3') return null;       // structural → neutral (omitted, not 100)
  if (reportedVsOnchainPct == null) return null;  // no data → omitted
  if (reportedVsOnchainPct <= 0) return 100;      // V2 reported ≤ onchain → healthy
  return round2(clamp((1 - reportedVsOnchainPct / V2_DIVERGENCE_ZERO_AT) * 100, 0, 100));
}

/**
 * Deployer reputation SCORE — 0–100 where HIGHER = HEALTHIER.
 * Missing deployer data is omitted; a known blocklisted deployer is 0.
 */
export function deployerReputationScore(
  deploymentsCount: number | null | undefined,
  rugLikeCount: number | null | undefined,
  riskScore: number | null | undefined,
  blocklisted: boolean | null | undefined,
): number | null {
  if (blocklisted === true) return 0;
  if (deploymentsCount == null && rugLikeCount == null && riskScore == null) return null;

  const deployments = Math.max(0, deploymentsCount ?? 0);
  const rugs = Math.max(0, rugLikeCount ?? 0);
  const rugRatePct = deployments > 0 ? (rugs / deployments) * 100 : 0;
  const riskPct = riskScore != null && Number.isFinite(riskScore) ? riskScore : rugRatePct;
  const penalty = Math.max(rugRatePct, riskPct);
  return round2(clamp(100 - penalty, 0, 100));
}

// ─── Band classifier ──────────────────────────────────────────────────────────
export function bandFor(finalScore: number, bands: ScoringParams['bands']): Band {
  if (finalScore >= bands.highMin)      return 'high_band';
  if (finalScore >= bands.candidateMin) return 'candidate';
  if (finalScore >= bands.watchlistMin) return 'watchlist';
  return 'reject_band';
}

// ─── Main pure entry point ────────────────────────────────────────────────────
export function scoreSnapshot(
  snapshot: ScoreSnapshot,
  params: ScoringParams = DEFAULT_SCORING_PARAMS,
): ScoreResult {
  const scores: Record<ImplementedComponentKey, number | null> = {
    liquidity:  liquidityScore(snapshot.onchainTvlUsd),
    depth:      depthScore(snapshot.executableDepthUsd, snapshot.slip1000),
    age:        ageScore(snapshot.ageDays),
    traction:   tractionScore(snapshot.vol1h, snapshot.onchainTvlUsd, snapshot.buys1h, snapshot.sells1h),
    divergence: divergenceScore(snapshot.liquidityModel, snapshot.reportedVsOnchainPct),
    deployer_reputation: deployerReputationScore(
      snapshot.deployerDeploymentsCount,
      snapshot.deployerRugLikeCount,
      snapshot.deployerRiskScore,
      snapshot.deployerBlocklisted,
    ),
  };

  // Present = implemented components with data this run. Missing = implemented-without-data
  // PLUS every unimplemented intended component (always absent — the real blind spots).
  const componentsPresent: ImplementedComponentKey[] = [];
  const implementedMissing: ImplementedComponentKey[] = [];
  for (const k of IMPLEMENTED_COMPONENT_KEYS) {
    (scores[k] == null ? implementedMissing : componentsPresent).push(k);
  }
  const componentsMissing: ComponentKey[] = [...implementedMissing, ...UNIMPLEMENTED_COMPONENT_KEYS];

  // Weighted average over PRESENT components only — renormalize the weights.
  let weightSum = 0;
  let weighted = 0;
  for (const k of componentsPresent) {
    weightSum += params.weights[k];
    weighted  += params.weights[k] * (scores[k] as number);
  }
  const finalScore = weightSum > 0 ? round2(weighted / weightSum) : 0;

  // Confidence is measured against the FULL intended model, so it can never read 1.0
  // while the unimplemented rug-vector components remain unwired.
  const scoreConfidence = round3(componentsPresent.length / INTENDED_COMPONENT_KEYS.length);

  return {
    finalScore,
    liquidityScore:  scores.liquidity,
    depthScore:      scores.depth,
    ageScore:        scores.age,
    tractionScore:   scores.traction,
    divergenceScore: scores.divergence,
    deployerReputationScore: scores.deployer_reputation,
    componentsPresent,
    componentsMissing,
    scoreConfidence,
    band: bandFor(finalScore, params.bands),
  };
}
