import type { EvalViewRow } from './paper.types';

/**
 * PURE renderer for the on-demand eval view. Facts only — NEVER a recommendation.
 * The header caveat must always travel with the table.
 */
export const EVAL_VIEW_CAVEAT =
  'Status/price are FACTS from on-chain reads, NOT recommendations. ' +
  'Passing filters ≠ safe to buy. Paper only — no real trade was placed.';

const fmtMult = (m: number | null): string => (m == null ? '?' : `${m.toFixed(2)}x`);
const fmtPx   = (p: number | null): string => (p == null ? '?' : p.toExponential(3));
const fmtNum  = (n: number | null, d = 0): string => (n == null ? '?' : n.toFixed(d));
const fmtBool = (b: boolean | null): string => (b == null ? '?' : b ? 'yes' : 'NO');

export function renderEvalTable(rows: EvalViewRow[]): string {
  const lines: string[] = [];
  lines.push('═'.repeat(108));
  lines.push('  PAPER POSITIONS — on-demand evaluation');
  lines.push(`  ${EVAL_VIEW_CAVEAT}`);
  lines.push('═'.repeat(108));
  if (rows.length === 0) {
    lines.push('  (no open paper positions to evaluate)');
    lines.push('═'.repeat(108));
    return lines.join('\n');
  }
  lines.push(
    '  ' +
    'symbol'.padEnd(10) + 'chain'.padEnd(9) + 'address'.padEnd(14) +
    'found'.padEnd(11) + 'entry_eff'.padStart(12) + 'price_now'.padStart(12) +
    'mult'.padStart(8) + '  ' + 'status'.padEnd(18) + 'score'.padStart(6) + 'conf'.padStart(6) +
    'sell/buy'.padStart(10) + 'sellOk'.padStart(8),
  );
  lines.push('  ' + '─'.repeat(122));
  for (const r of rows) {
    lines.push(
      '  ' +
      (r.symbol || '?').slice(0, 9).padEnd(10) +
      r.chain.padEnd(9) +
      (r.tokenAddress.slice(0, 12) + '…').padEnd(14) +
      r.foundAt.slice(5, 10).padEnd(11) +
      fmtPx(r.entryEffective).padStart(12) +
      fmtPx(r.priceNow).padStart(12) +
      fmtMult(r.multiple).padStart(8) + '  ' +
      r.status.padEnd(18) +
      fmtNum(r.score, 1).padStart(6) +
      fmtNum(r.confidence, 2).padStart(6) +
      fmtNum(r.sellersToBuyersRatio, 2).padStart(10) +
      fmtBool(r.sellSimOk).padStart(8),
    );
  }
  lines.push('  (sell/buy = unique sellers ÷ buyers; sellOk = sell sim passed now — OBSERVATION ONLY, not an exit rule)');
  lines.push('═'.repeat(108));
  return lines.join('\n');
}

/** Minimal standalone HTML version of the same table (facts only, same caveat). */
export function renderEvalHtml(rows: EvalViewRow[]): string {
  const esc = (s: string): string => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string));
  const cells = rows.map((r) => `
    <tr>
      <td>${esc(r.symbol || '?')}</td><td>${esc(r.chain)}</td>
      <td class="mono">${esc(r.tokenAddress)}</td><td>${esc(r.foundAt.slice(0, 16))}</td>
      <td>${fmtPx(r.entryEffective)}</td><td>${fmtPx(r.priceNow)}</td>
      <td>${fmtMult(r.multiple)}</td><td>${esc(r.status)}</td>
      <td>${fmtNum(r.score, 1)}</td><td>${fmtNum(r.confidence, 2)}</td>
      <td>${fmtNum(r.sellersToBuyersRatio, 2)}</td><td class="${r.sellSimOk === false ? 'bad' : ''}">${fmtBool(r.sellSimOk)}</td>
    </tr>`).join('');
  return `<!doctype html><meta charset="utf-8"><title>Paper positions</title>
<style>body{font:14px system-ui;margin:24px}.warn{background:#fff3cd;border:1px solid #e0c068;padding:10px;border-radius:6px}
table{border-collapse:collapse;margin-top:14px;width:100%}th,td{border:1px solid #ddd;padding:6px 8px;text-align:left}
th{background:#f5f5f5}.mono{font-family:ui-monospace,monospace;font-size:12px}.bad{background:#f8d7da;font-weight:bold}</style>
<h2>Paper positions — on-demand evaluation</h2>
<div class="warn"><b>${esc(EVAL_VIEW_CAVEAT)}</b></div>
<p style="color:#666">sell/buy = unique sellers ÷ unique buyers; sell_ok = sell simulation passed now.
These post-t0 rug signals are OBSERVATION ONLY — not yet wired into any exit rule.</p>
<table><thead><tr><th>symbol</th><th>chain</th><th>address</th><th>found</th><th>entry_eff</th>
<th>price_now</th><th>mult</th><th>status</th><th>score</th><th>conf</th><th>sell/buy</th><th>sell_ok</th></tr></thead>
<tbody>${cells || '<tr><td colspan="12">(no open positions)</td></tr>'}</tbody></table>`;
}
