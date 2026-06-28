/**
 * M5 — Post-mortem over CLOSED paper positions.  `npm run postmortem`
 * Compares t0 features of RUGGED/LOSS vs SURVIVED/WIN. Findings are HYPOTHESES;
 * a LOUD overfitting warning fires when a group has too few samples.
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { PostmortemService } from '../src/postmortem/postmortem.service';

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const report = await app.get(PostmortemService).run();
  console.log('\n' + report);
  process.exit(0);
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
