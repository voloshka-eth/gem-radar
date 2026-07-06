const fs = require('fs');
const path = require('path');

const date = process.argv[2] || new Date().toISOString().slice(0, 10);
const rebuildDate = process.argv.includes('--rebuild-date');
const logDir = path.join(process.cwd(), 'logs');
const researchPath = path.join(logDir, 'decisions', 'research_candidates.csv');
const paperPath = path.join(logDir, 'decisions', 'research_paper_entries.csv');
const outPath = path.join(logDir, 'decisions', 'speculative_candidates.csv');

const caveat =
  '# Speculative candidates = CONTRACT_UNKNOWN clean trade-side signals + liquidity_verified=true. ' +
  'NOT CONTRACT_SAFE, not a verified survivor, high risk.';

const headers = [
  'ts',
  'run_id',
  'schema_version',
  'cohort',
  'chain',
  'token_address',
  'symbol',
  'name',
  'pool_address',
  'dex',
  'source',
  'risk_decision',
  'risk_status',
  'research_reason',
  'liquidity_model',
  'liquidity_verified',
  'onchain_tvl_usd',
  'slip_100',
  'slip_1000',
  'fdv_usd',
  'age_days',
  'final_score',
  'band',
  'score_confidence',
  'honeypot',
  'buy_tax',
  'sell_tax',
];

function parseCsvLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      fields.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

function escapeCsv(value) {
  const s = String(value ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function readRows(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && !line.startsWith('ts,'))
    .map(parseCsvLine);
}

const researchByKey = new Map();
for (const r of readRows(researchPath)) {
  if (!r[0]?.startsWith(date)) continue;
  researchByKey.set(`${r[3]}:${r[4]}:${r[7]}`, r);
}

const existing = new Set();
const preservedRows = [];
for (const r of readRows(outPath)) {
  if (rebuildDate && r[0]?.startsWith(date)) continue;
  preservedRows.push(r);
  existing.add(`${r[4]}:${r[5]}:${r[8]}`);
}

const outRows = [];
for (const p of readRows(paperPath)) {
  if (!p[0]?.startsWith(date)) continue;
  if (p[9] !== 'true' || p[24] !== 'true' || p[27] === 'reject_band') continue;

  const key = `${p[4]}:${p[5]}:${p[7]}`;
  const dedupeKey = `${p[4]}:${p[5]}:${p[7]}`;
  if (existing.has(dedupeKey)) continue;
  existing.add(dedupeKey);
  const r = researchByKey.get(key);

  outRows.push([
    p[0],
    p[1],
    p[2],
    'CONTRACT_UNKNOWN_LIQUIDITY_VERIFIED',
    p[4],
    p[5],
    p[6],
    r?.[6] ?? '',
    p[7],
    r?.[8] ?? '',
    r?.[9] ?? '',
    'CONTRACT_UNKNOWN',
    p[10],
    p[11],
    p[8],
    p[9],
    p[23],
    '',
    '',
    r?.[17] ?? '',
    '',
    p[26],
    p[27],
    p[28],
    r?.[13] ?? '',
    r?.[14] ?? p[21],
    r?.[15] ?? '',
  ]);
}

if (rebuildDate) {
  let output = `${caveat}\n${headers.join(',')}\n`;
  const rows = [...preservedRows, ...outRows];
  if (rows.length > 0) {
    output += rows.map((row) => row.map(escapeCsv).join(',')).join('\n') + '\n';
  }
  fs.writeFileSync(outPath, output, 'utf8');
} else if (outRows.length > 0) {
  const isNew = !fs.existsSync(outPath);
  let output = '';
  if (isNew) {
    output += `${caveat}\n`;
    output += `${headers.join(',')}\n`;
  }
  output += outRows.map((row) => row.map(escapeCsv).join(',')).join('\n') + '\n';
  fs.appendFileSync(outPath, output, 'utf8');
}

console.log(`Backfilled ${outRows.length} speculative candidate row(s) for ${date}`);
