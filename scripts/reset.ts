/**
 * Hard reset — clears all collected data so you can start fresh after a logic fix.
 * Truncates every public-schema table (discovered dynamically), wipes log files,
 * flushes Redis caches.
 *
 * Usage:
 *   npm run reset           — shows what will be deleted, asks for confirmation
 *   npm run reset -- --yes  — skips confirmation (CI / scripted restarts)
 *
 * Does NOT touch the schema, Docker volumes, or .env.
 */
import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import * as dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';

dotenv.config();

const YES = process.argv.includes('--yes');

// ─── helpers ──────────────────────────────────────────────────────────────────

function ask(q: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(q, (a) => { rl.close(); res(a.trim().toLowerCase() === 'y'); }));
}

function rmDir(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  const files = fs.readdirSync(dir);
  for (const f of files) {
    const full = path.join(dir, f);
    if (fs.statSync(full).isFile()) fs.unlinkSync(full);
  }
  return files.length;
}

// ─── DB target (parsed from DATABASE_URL, no credentials printed) ─────────────

function parseDbTarget(): string {
  const url = process.env.DATABASE_URL ?? '';
  try {
    // postgresql://user:pass@host:port/dbname?params
    const u = new URL(url);
    return `${u.hostname}:${u.port || 5432}/${u.pathname.replace(/^\//, '')}`;
  } catch {
    return '(could not parse DATABASE_URL)';
  }
}

// ─── inventory ────────────────────────────────────────────────────────────────

const LOG_DIR = process.env.LOG_DIR ?? './logs';

const LOG_DIRS = [
  path.resolve(LOG_DIR, 'decisions'),
  path.resolve(LOG_DIR, 'raw'),
  path.resolve(LOG_DIR, 'reports'),
];

function countLogFiles(): number {
  return LOG_DIRS.reduce(
    (n, d) =>
      n + (fs.existsSync(d)
        ? fs.readdirSync(d).filter((f) => !fs.statSync(path.join(d, f)).isDirectory()).length
        : 0),
    0,
  );
}

// ─── DB: discover tables + truncate ───────────────────────────────────────────

const EXCLUDE_TABLES = new Set(['_prisma_migrations']);

async function getPublicTables(prisma: PrismaClient): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename
    FROM   pg_tables
    WHERE  schemaname = 'public'
    ORDER  BY tablename
  `;
  return rows.map((r) => r.tablename).filter((t) => !EXCLUDE_TABLES.has(t));
}

async function truncateDb(prisma: PrismaClient): Promise<string[]> {
  const tables = await getPublicTables(prisma);
  if (tables.length === 0) return [];
  // Quote identifiers; single statement — RESTART IDENTITY resets sequences,
  // CASCADE handles FK ordering automatically.
  const list = tables.map((t) => `"${t}"`).join(', ');
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`,
  );
  return tables;
}

// ─── Redis flush ─────────────────────────────────────────────────────────────

async function flushRedis(): Promise<{ flushed: boolean; keys: number }> {
  const host     = process.env.REDIS_HOST     ?? 'localhost';
  const port     = parseInt(process.env.REDIS_PORT ?? '6379', 10);
  const password = process.env.REDIS_PASSWORD || undefined;

  const r = new Redis({ host, port, password, lazyConnect: true, enableOfflineQueue: false });
  try {
    await r.connect();
    // Delete only gem-radar keys — don't nuke unrelated data on a shared Redis
    const ageKeys  = await r.keys('age:v1:*');
    const riskKeys = await r.keys('risk:*');
    const all = [...ageKeys, ...riskKeys];
    if (all.length > 0) await r.del(...all);
    return { flushed: true, keys: all.length };
  } catch {
    return { flushed: false, keys: 0 };
  } finally {
    r.disconnect();
  }
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const logFiles = countLogFiles();
  const dbTarget = parseDbTarget();

  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║               GEM RADAR — HARD RESET            ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log(`\n  Target DB : ${dbTarget}`);
  console.log('  ⚠  Stop the collector before resetting (open file handles / active writes).');
  console.log('\nWill delete:');

  // Discover tables now so the operator sees exactly what will be truncated.
  const prisma = new PrismaClient();
  let tables: string[] = [];
  try {
    tables = await getPublicTables(prisma);
    console.log(`  · ${tables.length} DB table(s): ${tables.join(', ')}`);
  } catch (e) {
    console.log(`  · DB tables  (could not connect to list them: ${(e as Error).message})`);
  }

  console.log(`  · ${logFiles} log/CSV file(s) in ${LOG_DIR}/{decisions,raw,reports}`);
  console.log('  · Redis keys matching age:v1:* and risk:*');
  console.log('\nWill NOT touch: DB schema, Docker volumes, .env\n');

  if (!YES) {
    const ok = await ask('Proceed? [y/N] ');
    if (!ok) {
      await prisma.$disconnect();
      console.log('Aborted.');
      process.exit(0);
    }
  }

  // 1. DB
  process.stdout.write('  Truncating database … ');
  try {
    const truncated = await truncateDb(prisma);
    console.log(`${truncated.length} table(s) ✓`);
  } catch (e) {
    console.log(`FAILED\n  → ${(e as Error).message}`);
    console.log('  Hint: is PostgreSQL running? (npm run infra:up)');
  } finally {
    await prisma.$disconnect();
  }

  // 2. Log files
  process.stdout.write('  Clearing log files    … ');
  let cleared = 0;
  for (const d of LOG_DIRS) cleared += rmDir(d);
  console.log(`${cleared} file(s) removed ✓`);

  // 3. Redis
  process.stdout.write('  Flushing Redis cache  … ');
  const { flushed, keys } = await flushRedis();
  if (flushed) console.log(`${keys} key(s) deleted ✓`);
  else         console.log('Redis not reachable — skipped (OK if it was already empty)');

  console.log('\nReset complete. Start fresh with: npm run start:dev\n');
}

main().catch((e) => { console.error('\nFatal:', e); process.exit(1); });
