/**
 * Shadow gem-tracker — GEM-SCREEN.  `npm run gem:screen`
 * Tags verified survivors that pass the LP-locked/burned + FDV-headroom hard gates
 * as gem_candidates. OBSERVATION ONLY — never wired into entry/exit.
 */
import 'reflect-metadata';
process.env.COLLECTOR_AUTOSTART = 'false';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { GemScreenService } from '../src/gem/gem-screen.service';

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn', 'log'] });
  const r = await app.get(GemScreenService).screen();

  console.log('\n══ GEM-SCREEN ══════════════════════════════════════════════');
  console.log(`  survivors screened: ${r.screened}`);
  console.log(`  passed (gem_candidates): ${r.passed}`);
  console.log('  rejections:');
  for (const [reason, n] of Object.entries(r.rejections).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${reason.padEnd(34)} ${n}`);
  }
  if (r.passedCandidates.length) {
    console.log('  passed candidates:');
    for (const c of r.passedCandidates) {
      console.log(`    ${c.chain}:${c.tokenAddress} (${c.symbol})  FDV=$${c.entryFdvUsd?.toFixed(0) ?? '?'}  lp=${c.lpSource}`);
    }
  }
  console.log('════════════════════════════════════════════════════════════');
  process.exit(0);
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
