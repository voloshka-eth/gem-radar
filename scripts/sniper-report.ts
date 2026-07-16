import * as fs from 'fs';
import * as path from 'path';

interface RecordRow {
  type?: string;
  token?: string;
  symbol?: string;
  realizedMultiple?: number;
  closeReason?: string;
  note?: string;
}

const logDir = process.env.LOG_DIR ?? './logs';
const journalPath = path.join(logDir, 'sniper', 'paper_journal.ndjson');
if (!fs.existsSync(journalPath)) {
  throw new Error(`No launch-sniper journal found at ${journalPath}`);
}

const rows = fs.readFileSync(journalPath, 'utf8')
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => JSON.parse(line) as RecordRow);
const entries = rows.filter((row) => row.type === 'ENTER');
const closes = rows.filter((row) => row.type === 'POSITION_CLOSED');
const hit2x = new Set(
  rows
    .filter((row) => row.type === 'LADDER_EXIT' && row.note === 'ladder 2x')
    .map((row) => row.token),
);
const closeMultiples = closes
  .map((row) => Number(row.realizedMultiple))
  .filter(Number.isFinite);
const reasonCounts = new Map<string, number>();
for (const row of closes) {
  const reason = row.closeReason ?? 'unknown';
  reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
}
const average = closeMultiples.length > 0
  ? closeMultiples.reduce((sum, value) => sum + value, 0) / closeMultiples.length
  : null;
const report = [
  'FOUR.MEME LAUNCH SNIPER - PAPER REPORT',
  `generated_at=${new Date().toISOString()}`,
  `entries=${entries.length}`,
  `closed=${closes.length}`,
  `open=${Math.max(0, entries.length - closes.length)}`,
  `hit_2x=${hit2x.size}`,
  `precision_2x=${entries.length > 0 ? (hit2x.size / entries.length).toFixed(4) : 'n/a'}`,
  `avg_realized_multiple=${average == null ? 'n/a' : average.toFixed(4)}`,
  `expectancy=${average == null ? 'n/a' : (average - 1).toFixed(4)}`,
  '',
  'close_reasons:',
  ...[...reasonCounts.entries()].sort((a, b) => b[1] - a[1]).map(([reason, count]) => `  ${reason}=${count}`),
].join('\n');
const reportDir = path.join(logDir, 'reports');
fs.mkdirSync(reportDir, { recursive: true });
const filename = `sniper_${new Date().toISOString().slice(0, 10)}.txt`;
fs.writeFileSync(path.join(reportDir, filename), `${report}\n`, 'utf8');
process.stdout.write(`${report}\n`);

