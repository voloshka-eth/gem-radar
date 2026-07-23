import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';
import { SOLANA_MULTI_LAUNCH_STRATEGY } from '../src/solana/solana-flow-v2';
import { pairedArmDifference, SolanaArmOutcome, summarizeSolanaArms } from '../src/solana/solana-v2-metrics';

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const strategyVersion = process.env.SOLANA_BENCHMARK_STRATEGY ?? SOLANA_MULTI_LAUNCH_STRATEGY;
    const signals: any[] = await (prisma as any).solanaExperimentSignal.findMany({
      where: { status: 'RESOLVED', strategyVersion },
      include: { watch: true, arms: true },
      orderBy: { t0: 'asc' },
    });
    const outcomes: SolanaArmOutcome[] = signals.flatMap((signal) => signal.arms.map((arm: any) => ({
      signalId: signal.id,
      venue: signal.watch.venue,
      cohort: signal.riskCohort,
      armCode: arm.armCode,
      committedUsd: Number(arm.committedUsd),
      realizedUsd: Number(arm.realizedValueUsd),
      maxMultiple: Number(arm.maxMultipleObserved ?? 0),
      capitalHours: Number(arm.committedUsd) * Math.max(
        0,
        ((arm.closedAt ?? signal.resolvedAt ?? new Date()).getTime() - (arm.openedAt ?? signal.t0).getTime()) / 3_600_000,
      ),
      resolvedAtMs: (arm.closedAt ?? signal.resolvedAt ?? signal.updatedAt).getTime(),
    })));
    const summaries = summarizeSolanaArms(outcomes);
    const lines = [
      'SOLANA MULTI-LAUNCH FLOW BENCHMARK',
      `generated_at=${new Date().toISOString()}`,
      `strategy_version=${strategyVersion}`,
      `unique_resolved_signals=${new Set(outcomes.map((row) => row.signalId)).size}`,
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

void main();
