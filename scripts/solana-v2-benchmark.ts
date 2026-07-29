import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';
import { SOLANA_MULTI_LAUNCH_STRATEGY } from '../src/solana/solana-flow-v2';
import {
  pairedArmDifference,
  reconcileSolanaArm,
  SolanaArmOutcome,
  summarizeSolanaArms,
  validateSolanaBenchmarkArm,
} from '../src/solana/solana-v2-metrics';

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const strategyVersion = process.env.SOLANA_BENCHMARK_STRATEGY ?? SOLANA_MULTI_LAUNCH_STRATEGY;
    const includeIneligible = process.env.SOLANA_BENCHMARK_INCLUDE_INELIGIBLE === 'true';
    const signals: any[] = await (prisma as any).solanaExperimentSignal.findMany({
      where: {
        status: 'RESOLVED', strategyVersion,
        ...(includeIneligible ? {} : { benchmarkEligible: true, riskCohort: 'PRIMARY' }),
      },
      include: { watch: true, arms: { include: { legs: true } } },
      orderBy: { t0: 'asc' },
    });
    const reconciliations: {
      signalId: string;
      armCode: string;
      differenceUsd: number;
      reasons: string[];
    }[] = [];
    const excludedSignals = new Map<string, Set<string>>();
    const outcomesBySignal = new Map<string, SolanaArmOutcome[]>();
    for (const signal of signals) {
      if (signal.arms.length !== 3) {
        excludedSignals.set(signal.id, new Set(['incomplete_paired_arms']));
        continue;
      }
      const signalOutcomes: SolanaArmOutcome[] = [];
      for (const arm of signal.arms) {
        const committedUsd = Number(arm.committedUsd);
        const ledger = reconcileSolanaArm(
          { committedUsd, realizedValueUsd: Number(arm.realizedValueUsd) },
          arm.legs.map((leg: any) => ({
            status: leg.status,
            legType: leg.legType,
            inputUsd: decimal(leg.inputUsd),
            outputUsd: decimal(leg.outputUsd),
            gasUsd: decimal(leg.gasUsd),
          })),
        );
        const reasons = validateSolanaBenchmarkArm({
          status: arm.status,
          committedUsd,
          remainingTokensRaw: arm.remainingTokensRaw,
        }, ledger);
        reconciliations.push({
          signalId: signal.id,
          armCode: arm.armCode,
          differenceUsd: ledger.differenceUsd,
          reasons,
        });
        if (reasons.length) {
          const signalReasons = excludedSignals.get(signal.id) ?? new Set<string>();
          reasons.forEach((reason) => signalReasons.add(reason));
          excludedSignals.set(signal.id, signalReasons);
        }
        signalOutcomes.push({
          signalId: signal.id,
          venue: signal.watch.venue,
          cohort: signal.riskCohort,
          armCode: arm.armCode,
          committedUsd: ledger.entryAndAddCostUsd + ledger.failedGasUsd,
          realizedUsd: ledger.exitProceedsUsd + ledger.remainingMarkedValueUsd,
          maxMultiple: Number(arm.maxMultipleObserved ?? 0),
          capitalHours: committedUsd * Math.max(
            0,
            ((arm.closedAt ?? signal.resolvedAt ?? new Date()).getTime() -
              (arm.openedAt ?? signal.t0).getTime()) / 3_600_000,
          ),
          resolvedAtMs: (arm.closedAt ?? signal.resolvedAt ?? signal.updatedAt).getTime(),
        });
      }
      outcomesBySignal.set(signal.id, signalOutcomes);
    }
    const outcomes = [...outcomesBySignal.entries()]
      .filter(([signalId]) => !excludedSignals.has(signalId))
      .flatMap(([, rows]) => rows);
    const summaries = summarizeSolanaArms(outcomes);
    const lines = [
      'SOLANA MULTI-LAUNCH FLOW BENCHMARK',
      `generated_at=${new Date().toISOString()}`,
      `strategy_version=${strategyVersion}`,
      `benchmark_eligible_only=${String(!includeIneligible)}`,
      `resolved_signals_loaded=${signals.length}`,
      `unique_resolved_signals=${new Set(outcomes.map((row) => row.signalId)).size}`,
      `signals_excluded_fail_closed=${excludedSignals.size}`,
      `ledger_reconciliation_mismatches=${reconciliations.filter((row) => row.reasons.includes('execution_ledger_mismatch')).length}`,
      `unmarked_residual_arms=${reconciliations.filter((row) => row.reasons.includes('unmarked_token_residual')).length}`,
      `csv_accounting=not_used_db_execution_legs_are_canonical`,
      `exclusion_reasons=${formatReasonCounts(excludedSignals)}`,
      '',
      ...summaries.map((row) => [
        `${row.venue} | ${row.cohort} | ${row.armCode}`,
        `signals=${row.signals} traded=${row.traded} raw_ev=$${row.rawEvPerSignal.toFixed(4)} capped_ev=$${row.cappedEvPerSignal.toFixed(4)}`,
        `pnl=$${row.totalNetPnl.toFixed(2)} ex_top1=$${row.pnlExcludingTop1.toFixed(2)} ex_top3=$${row.pnlExcludingTop3.toFixed(2)}`,
        `profit_factor=${format(row.profitFactor)} max_dd=$${row.maxDrawdown.toFixed(2)} executable_2x=${(row.executable2xRate * 100).toFixed(1)}%`,
        `winner_p50=${format(row.medianWinner)} p75=${format(row.p75Winner)} p90=${format(row.p90Winner)} ev/capital_hour=${format(row.evPerCapitalHour)}`,
        '',
      ].join('\n')),
      'PAIRED DIFFERENCES',
      paired('B_PROBE_4_ADD_16', 'A_IMMEDIATE_20'),
      paired('B_PROBE_4_ADD_16', 'C_CONFIRM_20'),
      paired('C_CONFIRM_20', 'A_IMMEDIATE_20'),
      '',
      'Thresholds remain frozen until 300 resolved launches with at least 75 per venue.',
    ];
    const report = lines.join('\n');
    const output = path.resolve(process.env.LOG_DIR ?? './logs', 'reports', 'solana_v2_benchmark.txt');
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, report + '\n', 'utf8');
    process.stdout.write(report + '\n');

    function paired(left: string, right: string): string {
      const result = pairedArmDifference(outcomes, left, right);
      return `${left} - ${right}: n=${result.samples} mean=$${result.meanDifferenceUsd.toFixed(4)}`;
    }
  } finally {
    await prisma.$disconnect();
  }
}

function format(value: number | null): string {
  if (value == null) return 'n/a';
  if (!Number.isFinite(value)) return 'infinity';
  return value.toFixed(4);
}

function decimal(value: unknown): number | null {
  return value == null ? null : Number(value);
}

function formatReasonCounts(excluded: ReadonlyMap<string, ReadonlySet<string>>): string {
  const counts = new Map<string, number>();
  for (const reasons of excluded.values()) {
    for (const reason of reasons) counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([reason, count]) => `${reason}:${count}`)
    .join(',') || 'none';
}

void main();
