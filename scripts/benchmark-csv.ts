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

function groupCount(rows: Row[], key: (row: Row) => string): Map<string, number> {
  const result = new Map<string, number>();
  for (const row of rows) result.set(key(row), (result.get(key(row)) ?? 0) + 1);
  return result;
}

function sortedCounts(counts: Map<string, number>): string {
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([key, count]) => `${key}=${count}`).join(', ');
}

function num(value: string | undefined): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function main(): void {
  const rejected = readCsv('rejected_tokens.csv');
  const contractRejected = readCsv('contract_rejected_tokens.csv');
  const entries = readCsv('paper_entries.csv').filter((row) => row.entered === 'true');
  const exits = readCsv('paper_exits.csv');

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

  const output = lines.join('\n');
  fs.mkdirSync(reports, { recursive: true });
  const file = path.join(reports, `benchmark_csv_${new Date().toISOString().slice(0, 10)}.txt`);
  fs.writeFileSync(file, output + '\n');
  console.log(output);
  console.log(`Report written: ${file}`);
}

main();
