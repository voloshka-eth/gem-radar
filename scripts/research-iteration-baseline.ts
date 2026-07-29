import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { PrismaClient } from '@prisma/client';

// 14:00 Europe/Warsaw on 23 July 2026 is 12:00 UTC. This script is
// intentionally append-safe: it snapshots provenance and never updates fills.
const ITERATION = 'gem-radar-research-v3';
const CUTOFF = new Date('2026-07-23T12:00:00.000Z');

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const gitCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const [solanaVersions, robinhoodConfigs, solanaSignals, robinhoodExperiments] = await Promise.all([
      (prisma as any).solanaExperimentSignal.groupBy({
        by: ['strategyVersion', 'configHash'], _count: { _all: true },
      }),
      (prisma as any).robinhoodEntryExperiment.groupBy({
        by: ['configVersion', 'configHash'], _count: { _all: true },
      }),
      (prisma as any).solanaExperimentSignal.count({ where: { t0: { gte: CUTOFF } } }),
      (prisma as any).robinhoodEntryExperiment.count({ where: { t0At: { gte: CUTOFF } } }),
    ]);
    const strategyVersions = { solana: solanaVersions, robinhood: robinhoodConfigs };
    const configHashes = {
      solana: solanaVersions.map((row: any) => row.configHash),
      robinhood: robinhoodConfigs.map((row: any) => row.configHash),
    };
    const benchmarkSummary = { cutoffAt: CUTOFF.toISOString(), solanaSignals, robinhoodExperiments };
    await (prisma as any).researchIterationSnapshot.upsert({
      where: { iteration: ITERATION },
      create: { iteration: ITERATION, gitCommit, cutoffAt: CUTOFF, strategyVersions, configHashes, benchmarkSummary },
      // A snapshot is immutable by design. A re-run only verifies it exists.
      update: {},
    });
    const report = [
      'GEM RADAR RESEARCH ITERATION V3 BASELINE',
      `iteration=${ITERATION}`,
      `git_commit=${gitCommit}`,
      `cutoff_utc=${CUTOFF.toISOString()}`,
      `solana_signals_since_cutoff=${solanaSignals}`,
      `robinhood_experiments_since_cutoff=${robinhoodExperiments}`,
      `solana_versions=${JSON.stringify(solanaVersions)}`,
      `robinhood_configs=${JSON.stringify(robinhoodConfigs)}`,
      'historical_records_recomputed=false',
      'live_execution_enabled=false',
    ].join('\n');
    const output = path.resolve(process.env.LOG_DIR ?? './logs', 'reports', 'research_iteration_v3_baseline.txt');
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, report + '\n', 'utf8');
    process.stdout.write(report + '\n');
  } finally {
    await prisma.$disconnect();
  }
}

void main();
