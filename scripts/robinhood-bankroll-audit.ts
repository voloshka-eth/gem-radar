import { PrismaClient } from '@prisma/client';

type DbRow = {
  id: string;
  openedAt: Date;
  closedAt: Date | null;
  sizeUsd: unknown;
  realizedValueUsd: unknown;
  modeledSlippagePct: unknown;
  executedRungs: string;
};

type Sample = {
  id: string;
  openedAtMs: number;
  closedAtMs: number;
  pnlUsd: number;
  reached2x: boolean;
};

const prisma = new PrismaClient();
const CUTOFF = new Date('2026-07-23T12:00:00.000Z');
const STRATEGY = 'robinhood_stages_v2_shadow';
const STARTING_BANKROLL_USD = 1_000;
const POSITION_USD = 20;
const MONTE_CARLO_PATHS = 10_000;
const MONTE_CARLO_SIGNALS = 300;
const BLOCK_LENGTH = 10;

function numeric(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toSample(row: DbRow): Sample | null {
  const sizeUsd = numeric(row.sizeUsd);
  const proceedsUsd = numeric(row.realizedValueUsd);
  const friction = numeric(row.modeledSlippagePct);
  if (
    sizeUsd == null ||
    sizeUsd <= 0 ||
    proceedsUsd == null ||
    friction == null ||
    friction > 0.01
  ) {
    return null;
  }
  const reached2x = row.executedRungs
    .split(',')
    .map(Number)
    .some((multiple) => Number.isFinite(multiple) && multiple >= 2);
  return {
    id: row.id,
    openedAtMs: row.openedAt.getTime(),
    closedAtMs: row.closedAt?.getTime() ?? row.openedAt.getTime(),
    // Winners are replaced with a full exit at exactly 2x. Losers retain their
    // observed executable proceeds, so runners cannot manufacture robustness.
    pnlUsd: reached2x ? sizeUsd : proceedsUsd - sizeUsd,
    reached2x,
  };
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function quantile(values: readonly number[], probability: number): number {
  if (!values.length) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  const index = Math.min(ordered.length - 1, Math.max(0, Math.floor(probability * ordered.length)));
  return ordered[index];
}

function maxDrawdown(pnl: readonly number[], startingBankroll = STARTING_BANKROLL_USD): number {
  let equity = startingBankroll;
  let peak = startingBankroll;
  let drawdown = 0;
  for (const value of pnl) {
    equity += value;
    peak = Math.max(peak, equity);
    drawdown = Math.max(drawdown, peak - equity);
  }
  return drawdown;
}

function longestLosingStreak(pnl: readonly number[]): number {
  let current = 0;
  let longest = 0;
  for (const value of pnl) {
    current = value < 0 ? current + 1 : 0;
    longest = Math.max(longest, current);
  }
  return longest;
}

function rollingEv(pnl: readonly number[], window: number): number[] {
  if (pnl.length < window) return [];
  return Array.from({ length: pnl.length - window + 1 }, (_, start) =>
    sum(pnl.slice(start, start + window)) / window,
  );
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4_294_967_296;
  };
}

function blockBootstrap(samples: readonly Sample[]): {
  endingPnlP05: number;
  endingPnlMedian: number;
  endingPnlP95: number;
  probabilityNegative: number;
  probabilityDrawdownOver200: number;
  probabilityRuin: number;
} {
  if (!samples.length) {
    return {
      endingPnlP05: 0,
      endingPnlMedian: 0,
      endingPnlP95: 0,
      probabilityNegative: 1,
      probabilityDrawdownOver200: 1,
      probabilityRuin: 1,
    };
  }
  const random = mulberry32(0x524f4249);
  const orderedPnl = samples.map((sample) => sample.pnlUsd);
  const endingPnl: number[] = [];
  let negative = 0;
  let drawdownOver200 = 0;
  let ruin = 0;
  for (let path = 0; path < MONTE_CARLO_PATHS; path++) {
    const pnl: number[] = [];
    while (pnl.length < MONTE_CARLO_SIGNALS) {
      const start = Math.floor(random() * orderedPnl.length);
      for (let offset = 0; offset < BLOCK_LENGTH && pnl.length < MONTE_CARLO_SIGNALS; offset++) {
        pnl.push(orderedPnl[(start + offset) % orderedPnl.length]);
      }
    }
    const total = sum(pnl);
    const drawdown = maxDrawdown(pnl);
    endingPnl.push(total);
    if (total < 0) negative++;
    if (drawdown > 200) drawdownOver200++;
    if (drawdown >= STARTING_BANKROLL_USD) ruin++;
  }
  return {
    endingPnlP05: quantile(endingPnl, 0.05),
    endingPnlMedian: quantile(endingPnl, 0.50),
    endingPnlP95: quantile(endingPnl, 0.95),
    probabilityNegative: negative / MONTE_CARLO_PATHS,
    probabilityDrawdownOver200: drawdownOver200 / MONTE_CARLO_PATHS,
    probabilityRuin: ruin / MONTE_CARLO_PATHS,
  };
}

function money(value: number): string {
  return `${value < 0 ? '-' : ''}$${Math.abs(value).toFixed(2)}`;
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

async function main(): Promise<void> {
  const rows = await prisma.paperPosition.findMany({
    where: {
      chain: 'robinhood',
      strategyVersion: STRATEGY,
      status: 'CLOSED',
      openedAt: { gte: CUTOFF },
    },
    orderBy: { openedAt: 'asc' },
    select: {
      id: true,
      openedAt: true,
      closedAt: true,
      sizeUsd: true,
      realizedValueUsd: true,
      modeledSlippagePct: true,
      executedRungs: true,
    },
  }) as unknown as DbRow[];
  const samples = rows.flatMap((row) => {
    const sample = toSample(row);
    return sample == null ? [] : [sample];
  });
  const pnl = samples.map((sample) => sample.pnlUsd);
  const winners = samples.filter((sample) => sample.reached2x);
  const losers = samples.filter((sample) => !sample.reached2x);
  const rolling20 = rollingEv(pnl, 20);
  const byDay = new Map<string, number[]>();
  for (const sample of samples) {
    const day = new Date(sample.openedAtMs).toISOString().slice(0, 10);
    const values = byDay.get(day) ?? [];
    values.push(sample.pnlUsd);
    byDay.set(day, values);
  }
  const bootstrap = blockBootstrap(samples);
  const totalPnl = sum(pnl);
  const averageWinner = winners.length ? sum(winners.map((sample) => sample.pnlUsd)) / winners.length : 0;
  const averageLoss = losers.length ? -sum(losers.map((sample) => sample.pnlUsd)) / losers.length : 0;
  const breakEvenRate = averageWinner + averageLoss > 0
    ? averageLoss / (averageWinner + averageLoss)
    : 1;
  const lines = [
    `ROBINHOOD BANKROLL AUDIT ${new Date().toISOString()}`,
    `cutoff=${CUTOFF.toISOString()} strategy=${STRATEGY}`,
    `frozenScheme=friction<=1%, notional=$${POSITION_USD}, full executable 2x, observed loser exits`,
    'Historical hypothesis audit only. No live execution and no outcome-fitted threshold search.',
    '',
    `signals=${samples.length} winners=${winners.length} hitRate=${pct(winners.length / Math.max(1, samples.length))}`,
    `totalPnl=${money(totalPnl)} EV/signal=${money(totalPnl / Math.max(1, samples.length))}`,
    `averageWinner=${money(averageWinner)} averageLoss=${money(averageLoss)} breakEvenHitRate=${pct(breakEvenRate)}`,
    `maxDrawdown=${money(maxDrawdown(pnl))} longestLosingStreak=${longestLosingStreak(pnl)}`,
    `rolling20EV_min=${money(quantile(rolling20, 0))} median=${money(quantile(rolling20, 0.5))} ` +
      `positiveWindows=${pct(rolling20.filter((value) => value > 0).length / Math.max(1, rolling20.length))}`,
    '',
    'DAILY COHORTS',
    ...[...byDay.entries()].map(([day, values]) =>
      `${day}: n=${values.length} pnl=${money(sum(values))} EV=${money(sum(values) / values.length)}`,
    ),
    '',
    `BLOCK BOOTSTRAP ${MONTE_CARLO_PATHS} paths x ${MONTE_CARLO_SIGNALS} signals, block=${BLOCK_LENGTH}`,
    `endingPnl P05=${money(bootstrap.endingPnlP05)} median=${money(bootstrap.endingPnlMedian)} ` +
      `P95=${money(bootstrap.endingPnlP95)}`,
    `P(ending<0)=${pct(bootstrap.probabilityNegative)} ` +
      `P(maxDD>$200)=${pct(bootstrap.probabilityDrawdownOver200)} ` +
      `P(ruin $1000)=${pct(bootstrap.probabilityRuin)}`,
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
