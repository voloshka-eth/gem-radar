export interface SolanaArmOutcome {
  signalId: string;
  venue: string;
  cohort: string;
  armCode: string;
  committedUsd: number;
  realizedUsd: number;
  maxMultiple: number;
  capitalHours: number;
  resolvedAtMs: number;
}

export interface SolanaExecutionLegLedgerRow {
  status: string;
  legType: string;
  inputUsd: number | null;
  outputUsd: number | null;
  gasUsd: number | null;
}

export interface SolanaLegReconciliation {
  entryAndAddCostUsd: number;
  exitProceedsUsd: number;
  failedGasUsd: number;
  remainingMarkedValueUsd: number;
  netPnlUsd: number;
  recordedNetPnlUsd: number;
  differenceUsd: number;
}

export interface SolanaBenchmarkArmState {
  status: string;
  committedUsd: number;
  remainingTokensRaw: string;
}

/** Canonical accounting comes from immutable execution legs, never labels. */
export function reconcileSolanaArm(
  arm: { committedUsd: number; realizedValueUsd: number; remainingMarkedValueUsd?: number | null },
  legs: readonly SolanaExecutionLegLedgerRow[],
): SolanaLegReconciliation {
  const filled = legs.filter((leg) => leg.status === 'FILLED');
  const entryAndAddCostUsd = sum(filled.map((leg) => Number(leg.inputUsd ?? 0) + (leg.inputUsd != null ? Number(leg.gasUsd ?? 0) : 0)));
  // Filled exits persist a net quote in outputUsd, so their gas must not be
  // subtracted a second time. Failed legs are the only standalone gas loss.
  const exitProceedsUsd = sum(filled.map((leg) => Number(leg.outputUsd ?? 0)));
  const failedGasUsd = sum(legs.filter((leg) => leg.status === 'FAILED').map((leg) => Number(leg.gasUsd ?? 0)));
  const remainingMarkedValueUsd = Number(arm.remainingMarkedValueUsd ?? 0);
  const netPnlUsd = exitProceedsUsd + remainingMarkedValueUsd - entryAndAddCostUsd - failedGasUsd;
  const recordedNetPnlUsd = Number(arm.realizedValueUsd) + remainingMarkedValueUsd - Number(arm.committedUsd);
  return { entryAndAddCostUsd, exitProceedsUsd, failedGasUsd, remainingMarkedValueUsd, netPnlUsd, recordedNetPnlUsd,
    differenceUsd: netPnlUsd - recordedNetPnlUsd };
}

export function validateSolanaBenchmarkArm(
  arm: SolanaBenchmarkArmState,
  ledger: SolanaLegReconciliation,
  toleranceUsd = 0.0001,
): string[] {
  const reasons: string[] = [];
  if (!['CLOSED', 'FAILED', 'REORG_INVALIDATED'].includes(arm.status)) reasons.push('arm_not_terminal');
  if (BigInt(arm.remainingTokensRaw || '0') !== 0n) reasons.push('unmarked_token_residual');
  if (Math.abs(ledger.differenceUsd) > toleranceUsd) reasons.push('execution_ledger_mismatch');
  if (arm.committedUsd > 0 && ledger.entryAndAddCostUsd <= 0) reasons.push('missing_entry_leg');
  return reasons;
}

export interface SolanaArmSummary {
  venue: string;
  cohort: string;
  armCode: string;
  signals: number;
  traded: number;
  rawEvPerSignal: number;
  cappedEvPerSignal: number;
  totalNetPnl: number;
  pnlExcludingTop1: number;
  pnlExcludingTop3: number;
  profitFactor: number | null;
  medianWinner: number | null;
  p75Winner: number | null;
  p90Winner: number | null;
  maxDrawdown: number;
  executable2xRate: number;
  capitalUtilizationUsdHours: number;
  evPerCapitalHour: number | null;
}

export function summarizeSolanaArms(outcomes: readonly SolanaArmOutcome[]): SolanaArmSummary[] {
  const groups = new Map<string, SolanaArmOutcome[]>();
  for (const outcome of outcomes) {
    const key = `${outcome.venue}|${outcome.cohort}|${outcome.armCode}`;
    groups.set(key, [...(groups.get(key) ?? []), outcome]);
  }
  return [...groups.entries()].map(([key, rows]) => {
    const [venue, cohort, armCode] = key.split('|');
    const pnl = rows.map((row) => row.realizedUsd - row.committedUsd);
    const cappedPnl = rows.map((row) => row.committedUsd > 0
      ? Math.min(row.realizedUsd, row.committedUsd * 10) - row.committedUsd
      : 0);
    const sortedProfits = [...pnl].sort((a, b) => b - a);
    const winners = pnl.filter((value) => value > 0).sort((a, b) => a - b);
    const grossProfit = sum(pnl.filter((value) => value > 0));
    const grossLoss = Math.abs(sum(pnl.filter((value) => value < 0)));
    const capitalHours = sum(rows.map((row) => row.capitalHours));
    const chronological = [...rows].sort((a, b) => a.resolvedAtMs - b.resolvedAtMs);
    return {
      venue, cohort, armCode, signals: rows.length,
      traded: rows.filter((row) => row.committedUsd > 0).length,
      rawEvPerSignal: average(pnl),
      cappedEvPerSignal: average(cappedPnl),
      totalNetPnl: sum(pnl),
      pnlExcludingTop1: sum(sortedProfits.slice(1)),
      pnlExcludingTop3: sum(sortedProfits.slice(3)),
      profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : null,
      medianWinner: percentile(winners, 0.5),
      p75Winner: percentile(winners, 0.75),
      p90Winner: percentile(winners, 0.90),
      maxDrawdown: maxDrawdown(chronological.map((row) => row.realizedUsd - row.committedUsd)),
      executable2xRate: safeRatio(rows.filter((row) => row.maxMultiple >= 2).length, rows.length),
      capitalUtilizationUsdHours: capitalHours,
      evPerCapitalHour: capitalHours > 0 ? sum(pnl) / capitalHours : null,
    };
  }).sort((a, b) => a.venue.localeCompare(b.venue) || a.armCode.localeCompare(b.armCode));
}

export function pairedArmDifference(
  outcomes: readonly SolanaArmOutcome[],
  leftArm: string,
  rightArm: string,
): { samples: number; meanDifferenceUsd: number } {
  const bySignal = new Map<string, Map<string, number>>();
  for (const outcome of outcomes) {
    const arms = bySignal.get(outcome.signalId) ?? new Map<string, number>();
    arms.set(outcome.armCode, outcome.realizedUsd - outcome.committedUsd);
    bySignal.set(outcome.signalId, arms);
  }
  const differences = [...bySignal.values()]
    .filter((arms) => arms.has(leftArm) && arms.has(rightArm))
    .map((arms) => arms.get(leftArm)! - arms.get(rightArm)!);
  return { samples: differences.length, meanDifferenceUsd: average(differences) };
}

function maxDrawdown(pnl: readonly number[]): number {
  let equity = 0;
  let peak = 0;
  let drawdown = 0;
  for (const value of pnl) {
    equity += value;
    peak = Math.max(peak, equity);
    drawdown = Math.max(drawdown, peak - equity);
  }
  return drawdown;
}

function percentile(sorted: readonly number[], quantile: number): number | null {
  if (!sorted.length) return null;
  const index = (sorted.length - 1) * quantile;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function average(values: readonly number[]): number {
  return values.length ? sum(values) / values.length : 0;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function safeRatio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}
