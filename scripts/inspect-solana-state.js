/* Read-only inspection of Solana v2.2 pipeline state. No writes. */
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

function j(value) {
  return JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2);
}

async function main() {
  const now = Date.now();

  const cursors = await prisma.solanaProgramCursor.findMany({ orderBy: { venue: 'asc' } });
  console.log('--- PROGRAM CURSORS ---');
  for (const c of cursors) {
    const ageMin = ((now - new Date(c.updatedAt).getTime()) / 60000).toFixed(1);
    console.log(
      `${c.venue.padEnd(20)} connected=${c.streamConnected} gap=${c.unresolvedGap} ` +
      `lastSeenSlot=${c.lastSeenSlot} updatedAgoMin=${ageMin}`,
    );
  }

  const signalsByCohort = await prisma.solanaExperimentSignal.groupBy({
    by: ['riskCohort', 'status'],
    _count: { _all: true },
  });
  console.log('\n--- SIGNALS BY COHORT/STATUS ---');
  console.log(j(signalsByCohort));

  const signals = await prisma.solanaExperimentSignal.findMany({
    select: { id: true, status: true, riskCohort: true, confirmationDueAt: true, flowSnapshot: true, benchmarkEligible: true, healthSnapshot: true },
    orderBy: { createdAt: 'asc' },
  });
  const emptyFlow = signals.filter((s) => !s.flowSnapshot || Object.keys(s.flowSnapshot).length === 0);
  console.log(`\nsignals total=${signals.length} emptyFlowSnapshot=${emptyFlow.length}`);
  const overdue = signals.filter((s) => s.status === 'ACTIVE' && s.confirmationDueAt && new Date(s.confirmationDueAt).getTime() < now);
  console.log(`overdueActiveConfirmations=${overdue.length}`);
  for (const s of overdue) console.log(`  overdue signal=${s.id} due=${s.confirmationDueAt.toISOString()}`);

  const arms = await prisma.solanaPaperArm.groupBy({ by: ['armCode', 'status'], _count: { _all: true } });
  console.log('\n--- ARMS BY CODE/STATUS ---');
  console.log(j(arms));

  const stuckC = await prisma.solanaPaperArm.findMany({
    where: { armCode: 'C_CONFIRM_20', status: 'PENDING', signal: { confirmationDueAt: { lt: new Date() }, status: { in: ['ACTIVE', 'EXPIRED'] } } },
    select: { id: true, status: true, signal: { select: { id: true, status: true, confirmationDueAt: true } } },
  });
  console.log(`\nstuck C_CONFIRM_20 (PENDING past due)=${stuckC.length}`);
  console.log(j(stuckC));

  const obsCount = await prisma.solanaSwapObservation.count();
  const obsRecent = await prisma.solanaSwapObservation.count({ where: { ts: { gte: new Date(now - 24 * 3600 * 1000) } } });
  console.log(`\nswapObservations total=${obsCount} last24h=${obsRecent}`);

  const watches = await prisma.solanaLaunchWatch.groupBy({ by: ['status'], _count: { _all: true } });
  console.log('\n--- WATCHES BY STATUS ---');
  console.log(j(watches));

  const legs = await prisma.solanaExecutionLeg.count();
  console.log(`\nexecutionLegs total=${legs}`);
}

main()
  .catch((err) => {
    console.error('inspection failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
