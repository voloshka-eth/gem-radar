/**
 * Strip EXPERIMENT_INVALIDATED noise from the operator paper_exits CSV.
 * Those rows were research-terminal events incorrectly written as P&L fills.
 * DB rows are untouched.
 */
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'logs', 'decisions', 'paper_exits.csv');
const raw = fs.readFileSync(file, 'utf8');
const lines = raw.split(/\r?\n/);
const header = lines[0];
const kept = [header];
let removed = 0;
for (let i = 1; i < lines.length; i++) {
  const line = lines[i];
  if (!line) continue;
  if (line.includes('EXPERIMENT_INVALIDATED') || line.includes(',INVALIDATED,')) {
    // Keep real outcome_class rows that are not the experiment-invalidated event.
    if (line.includes('EXPERIMENT_INVALIDATED')) {
      removed += 1;
      continue;
    }
  }
  kept.push(line);
}
const backup = file.replace(/\.csv$/, `.pre-invalidated-strip-${Date.now()}.csv`);
fs.copyFileSync(file, backup);
fs.writeFileSync(file, kept.join('\n') + (kept[kept.length - 1] === '' ? '' : '\n'));
console.log(`stripped=${removed} kept=${kept.length - 1} backup=${backup}`);
