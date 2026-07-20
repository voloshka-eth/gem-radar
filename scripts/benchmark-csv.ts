/**
 * Offline benchmark over the append-only collector logs.
 * It intentionally reports observed outcomes, not a backtest claim: paper_exits
 * only contains states that the evaluator actually observed.
 */
import fs from 'fs';
import path from 'path';

type Row = Record<string, string>;

const root = path.resolve(__dirname, '..');
const decisions = path.join(root, 'logs', 'decisions');
const reports = path.join(root, 'logs', 'reports');

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let value = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (quoted && line[i + 1] === '"') { value += '"'; i++; }
      else quoted = !quoted;
    } else if (char === ',' && !quoted) {
      out.push(value); value = '';
    } else value += char;
  }
  out.push(value);
  return out;
}

function readCsv(fileName: string): Row[] {
  const file = path.join(decisions, fileName);
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
  const headerLine = lines.find((line) => !line.startsWith('#'));
  if (!headerLine) return [];
  const headers = parseCsvLine(headerLine);
  const start = lines.indexOf(headerLine) + 1;
  return lines.slice(start).map((line) => {
    const values = parseCsvLine(line);
    return Object.fromEntries(headers.map((header, i) => [header, values[i] ?? '']));
  });
}

function groupCount<T>(rows: T[], key: (row: T) => string): Map<string, number> {
  const result = new Map<string, number>();
  for (const row of rows) result.set(key(row), (result.get(key(row)) ?? 0) + 1);
  return result;
}

function sortedCounts(counts: Map<string, number>): string {
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([key, count]) => `${key}=${count}`).join(', ');
}

function num(value: string | undefined): number | null {
  if (value == null || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

type ObservedPosition = {
  entry: Row;
  maxObservedMultiple: number | null;
  realizedMultiple: number | null;
  terminalCondition: string;
  closed: boolean;
};

function positionKey(row: Row): string {
  return `${row.chain}:${row.token_address}`;
}

function maxObservedMultiple(rows: Row[]): number | null {
  const values = rows.map((row) => num(row.multiple_vs_entry ?? row.multiple)).filter((v): v is number => v != null);
  return values.length ? Math.max(...values) : null;
}

function observedPositions(entries: Row[], exits: Row[], ticks: Row[]): ObservedPosition[] {
  const exitsByKey = new Map<string, Row[]>();
  const ticksByKey = new Map<string, Row[]>();
  for (const row of exits) {
    const group = exitsByKey.get(positionKey(row)) ?? [];
    group.push(row); exitsByKey.set(positionKey(row), group);
  }
  for (const row of ticks) {
    const group = ticksByKey.get(positionKey(row)) ?? [];
    group.push(row); ticksByKey.set(positionKey(row), group);
  }
  return entries.map((entry) => {
    const key = positionKey(entry);
    const events = (exitsByKey.get(key) ?? []).sort((a, b) => a.ts.localeCompare(b.ts));
    const terminal = [...events].reverse().find((row) => row.event_type !== 'LADDER_SELL');
    const observations = [...(ticksByKey.get(key) ?? []), ...events];
    return {
      entry,
      maxObservedMultiple: maxObservedMultiple(observations),
      realizedMultiple: terminal ? num(terminal.realized_multiple_total) : null,
      terminalCondition: terminal?.status ?? 'OPEN_OR_UNOBSERVED',
      closed: Boolean(terminal),
    };
  });
}

function bucket(value: number | null, edges: readonly number[], labels: readonly string[]): string {
  if (value == null) return 'missing';
  for (let i = 0; i < edges.length; i++) if (value < edges[i]) return labels[i];
  return labels[labels.length - 1];
}

function featureGroups(position: ObservedPosition): Record<string, string> {
  const e = position.entry;
  return {
    chain: e.chain || 'unknown',
    model: e.liquidity_model || 'unknown',
    source: e.discovery_source || 'legacy_unknown',
    risk_cohort: e.risk_cohort || 'legacy_unknown',
    entry_liquidity: bucket(num(e.onchain_liq_entry_usd), [10_000, 50_000, 250_000], ['<$10k', '$10k-$50k', '$50k-$250k', '>=$250k']),
    entry_slippage: bucket(num(e.slippage_pct), [0.01, 0.03, 0.10], ['<1%', '1%-3%', '3%-10%', '>=10%']),
    score_band: e.band || 'missing',
  };
}

function renderWalkForward(positions: ObservedPosition[]): string[] {
  const observed = positions
    .filter((p) => p.maxObservedMultiple != null)
    .sort((a, b) => a.entry.opened_at.localeCompare(b.entry.opened_at));
  if (observed.length < 20) return ['WALK-FORWARD: insufficient observed positions (need >=20).'];
  const cut = Math.floor(observed.length * 0.70);
  const train = observed.slice(0, cut);
  const test = observed.slice(cut);
  const keys = ['chain', 'model', 'source', 'risk_cohort', 'entry_liquidity', 'entry_slippage', 'score_band'];
  const lines = [
    '',
    'WALK-FORWARD FEATURE CHECK (descriptive only; no thresholds are changed)',
    `train=${train.length} earliest observations; test=${test.length} later observations; target=observed max multiple >=2x.`,
    'Only groups with train n>=10 are shown. A train-only pattern is not a deployable signal.',
  ];
  for (const key of keys) {
    const summarize = (rows: ObservedPosition[]) => {
      const groups = new Map<string, { n: number; x2: number; pnlN: number; pnlWins: number }>();
      for (const row of rows) {
        const group = featureGroups(row)[key];
        const s = groups.get(group) ?? { n: 0, x2: 0, pnlN: 0, pnlWins: 0 };
        s.n++;
        if ((row.maxObservedMultiple ?? 0) >= 2) s.x2++;
        if (row.realizedMultiple != null) { s.pnlN++; if (row.realizedMultiple >= 1) s.pnlWins++; }
        groups.set(group, s);
      }
      return groups;
    };
    const trainGroups = summarize(train);
    const testGroups = summarize(test);
    const comparable = [...trainGroups.entries()]
      .filter(([, s]) => s.n >= 10)
      .sort(([, a], [, b]) => (b.x2 / b.n) - (a.x2 / a.n));
    if (!comparable.length) continue;
    lines.push(`${key}:`);
    for (const [group, t] of comparable) {
      const v = testGroups.get(group);
      const testText = v ? `${v.x2}/${v.n} x2 (${(100 * v.x2 / v.n).toFixed(1)}%)` : 'no later observations';
      const pnlText = v && v.pnlN ? `; realized>=1=${v.pnlWins}/${v.pnlN}` : '';
      lines.push(`  ${group}: train x2=${t.x2}/${t.n} (${(100 * t.x2 / t.n).toFixed(1)}%) | test x2=${testText}${pnlText}`);
    }
  }
  return lines;
}

function main(): void {
  const rejected = readCsv('rejected_tokens.csv');
  const contractRejected = readCsv('contract_rejected_tokens.csv');
  const entries = readCsv('paper_entries.csv').filter((row) => row.entered === 'true');
  const exits = readCsv('paper_exits.csv');
  const ticks = readCsv('position_ticks.csv');
  const observed = observedPositions(entries, exits, ticks);

  const exitGroups = new Map<string, Row[]>();
  for (const row of exits) {
    const key = `${row.chain}:${row.token_address}`;
    const group = exitGroups.get(key) ?? [];
    group.push(row);
    exitGroups.set(key, group);
  }

  const chains = [...new Set([
    ...rejected.map((row) => row.chain),
    ...entries.map((row) => row.chain),
  ])].filter(Boolean).sort();
  const lines: string[] = [
    `GEM RADAR CSV BENCHMARK ${new Date().toISOString()}`,
    'Observed logs only. No unobserved high-water mark or hypothetical fill is counted.',
    '',
  ];

  for (const chain of chains) {
    const chainRejected = rejected.filter((row) => row.chain === chain);
    const chainContract = contractRejected.filter((row) => row.chain === chain);
    const chainEntries = entries.filter((row) => row.chain === chain);
    const chainKeys = new Set(chainEntries.map((row) => `${row.chain}:${row.token_address}`));
    const chainFinal: Row[] = [];
    let x2Observed = 0;
    let x2Multiple: number[] = [];
    const cohortStats = new Map<string, { entries: number; x2: number }>();
    for (const entry of chainEntries) {
      const cohort = entry.risk_cohort || 'legacy_unknown';
      const stats = cohortStats.get(cohort) ?? { entries: 0, x2: 0 };
      stats.entries++;
      cohortStats.set(cohort, stats);
    }
    for (const key of chainKeys) {
      const group = (exitGroups.get(key) ?? []).sort((a, b) => a.ts.localeCompare(b.ts));
      if (!group.length) continue;
      chainFinal.push(group[group.length - 1]);
      const max = Math.max(...group.map((row) => num(row.multiple) ?? 0));
      if (max >= 2) { x2Observed++; x2Multiple.push(max); }
      const entry = chainEntries.find((row) => `${row.chain}:${row.token_address}` === key);
      const cohort = entry?.risk_cohort || 'legacy_unknown';
      const stats = cohortStats.get(cohort);
      if (stats && max >= 2) stats.x2++;
    }
    const finalStatuses = groupCount(chainFinal, (row) => row.status || 'unknown');
    lines.push(`[${chain}]`);
    lines.push(`rejections=${chainRejected.length}; contract_rejections=${chainContract.length}; paper_entries=${chainEntries.length}; positions_with_exit=${chainFinal.length}`);
    lines.push(`rejection_reasons=${sortedCounts(groupCount(chainRejected, (row) => row.reason || 'unknown')) || 'none'}`);
    const contractReasons = new Map<string, number>();
    for (const row of chainContract) {
      for (const reason of (row.reject_reasons || 'unknown').split(/[|,;]/).map((v) => v.trim()).filter(Boolean)) {
        contractReasons.set(reason, (contractReasons.get(reason) ?? 0) + 1);
      }
    }
    lines.push(`contract_reasons=${sortedCounts(contractReasons) || 'none'}`);
    lines.push(`final_status=${sortedCounts(finalStatuses) || 'none'}; observed_x2=${x2Observed}/${chainEntries.length}`);
    lines.push(`entry_cohorts=${sortedCounts(groupCount(chainEntries, (row) => row.risk_cohort || 'legacy_unknown'))}`);
    lines.push(`cohort_observed_x2=${[...cohortStats.entries()].map(([cohort, stats]) => `${cohort}=${stats.x2}/${stats.entries}`).join(', ')}`);
    if (x2Multiple.length) lines.push(`observed_x2_high_watermarks=${x2Multiple.map((value) => value.toFixed(3)).join(',')}`);
    lines.push('');
  }

  const closed = observed.filter((position) => position.closed);
  const realizedProfit = closed.filter((position) => (position.realizedMultiple ?? 0) >= 1);
  const terminalCounts = groupCount(closed, (position) => position.terminalCondition);
  lines.push('REALIZED PNL VS TERMINAL CONDITION');
  lines.push(`closed=${closed.length}; realized_profit_or_breakeven=${realizedProfit.length}/${closed.length}; terminal_conditions=${sortedCounts(terminalCounts) || 'none'}`);
  lines.push('A later rug/liquidity pull does not erase PnL already captured by a ladder sell.');
  lines.push(...renderWalkForward(observed));

  const output = lines.join('\n');
  fs.mkdirSync(reports, { recursive: true });
  const file = path.join(reports, `benchmark_csv_${new Date().toISOString().slice(0, 10)}.txt`);
  fs.writeFileSync(file, output + '\n');
  console.log(output);
  console.log(`Report written: ${file}`);
}

main();
