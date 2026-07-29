import { PrismaClient } from '@prisma/client';

const tables = [
  'evm_swap_observations',
  'solana_swap_observations',
  'raw_collector_payloads',
  'evm_pool_watches',
  'solana_launch_watches',
];

async function main(): Promise<void> {
  if (!process.argv.includes('--force')) {
    throw new Error('Stop Gem Radar first, then rerun: npm run maintenance:compact');
  }
  const prisma = new PrismaClient();
  try {
    for (const table of tables) {
      process.stdout.write(`Compacting ${table}...\n`);
      await prisma.$executeRawUnsafe(`VACUUM (FULL, ANALYZE) ${table}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

void main();
