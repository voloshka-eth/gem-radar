/**
 * M5 — ON-DEMAND paper-position evaluator.  `npm run eval`
 *
 * Re-reads CURRENT on-chain price + liquidity for every OPEN paper position, updates
 * multiples/drawdown, applies the pessimistic exit ladder + invalidation exits, and
 * prints the intuitive (facts-only) table. NOT a daemon — it runs once and exits.
 */
import 'reflect-metadata';
process.env.COLLECTOR_AUTOSTART = 'false';
import * as fs from 'fs';
import * as path from 'path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { EvalService } from '../src/paper/eval.service';
import { renderEvalTable, renderEvalHtml } from '../src/paper/view';

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn', 'log'] });
  const evalService = app.get(EvalService);

  const { rows, evaluated, openTotal, deferred, closed, deployersRefreshed, rugLikeTokens } =
    await evalService.evaluateOpenPositions();

  console.log('\n' + renderEvalTable(rows));

  const outDir = path.join(process.env.LOG_DIR ?? './logs', 'reports');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'paper_positions.html'), renderEvalHtml(rows), 'utf8');

  console.log(`\nEvaluated ${evaluated}/${openTotal} open position(s); ${closed} closed this run.`);
  if (deferred > 0) {
    console.log(`${deferred} open position(s) deferred by PAPER_EVAL_MAX_OPEN_POSITIONS.`);
  }
  console.log(`Deployer reputation refreshed: ${deployersRefreshed} deployer(s), ${rugLikeTokens} rug-like token(s).`);
  console.log('sellers/buyers + sell-sim now captured; not yet an exit rule — collecting samples.');
  console.log('Intuitive view → logs/reports/paper_positions.html');
  process.exit(0);
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
